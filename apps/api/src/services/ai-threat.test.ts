import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as t from '../db/schema.js';
import { getCase, listCases } from './admin.js';
import {
  CLEAR_MIN_CONFIDENCE,
  SYSTEM_PROMPT,
  buildUserPrompt,
  looksLikeExplicitThreat,
  parseReviewOutput,
  runAiReviewTick,
  type AiReviewer,
} from './ai-review.js';
import { AI_EVAL_SAMPLES } from './ai-eval-samples.js';
import { openBottle } from './bottles.js';
import { commitArrivalIfDue } from './journey.js';
import { reportLetter } from './moderation.js';
import { releaseBottle } from './release.js';
import { createTestWorld, releaseInput, type TestWorld } from '../test/harness.js';

// Manual review round 1, item 6: a letter with an explicit threat received the AI
// recommendation "reject the report". Synthetic fixture only; no real letter is used.
//
// Findings, all deterministic: (1) the model was asked whether the *letter* broke the rules but
// answered "accept"/"reject" about the *report*, so "reject" (the letter) could land as "reject
// the report"; (2) a well-formed "reject" was trusted whatever its confidence, its own threat
// wording or a refusal-shaped reason; (3) only child safety escalated a case, threats did not.
// Nothing downstream reverses the verdict, and there is no automatic-decision path.

const THREAT = 'I know where you live. Tomorrow night I will come to your house and kill you.';
const DAY = 24 * 60 * 60 * 1000;
const answer = (o: Record<string, unknown>) => JSON.stringify(o);

describe('the prompt asks about the letter, and names threats', () => {
  it('uses a letter label, not a verdict about the report', () => {
    expect(SYSTEM_PROMPT).toContain('"label":"violation"|"no_violation"|"uncertain"');
    expect(SYSTEM_PROMPT).not.toMatch(/"verdict"/);
    expect(SYSTEM_PROMPT).toMatch(/threats to harm, kill, injure or stalk/);
    expect(SYSTEM_PROMPT).toContain('"threat":true|false');
    expect(SYSTEM_PROMPT).toContain(THREAT);
    expect(SYSTEM_PROMPT).toMatch(/never "no_violation"/);
  });

  it('carries the threat letter as untrusted data', () => {
    const user = buildUserPrompt({ text: THREAT, reasons: ['violence'], explanations: [] });
    expect(user).toContain(`Letter (JSON string): ${JSON.stringify(THREAT)}`);
  });

  it('has the threat in the evaluation set, where clearing it is the dangerous error', () => {
    const s = AI_EVAL_SAMPLES.find((x) => x.id === 'en-explicit-threat')!;
    expect(s.text).toBe(THREAT);
    expect(s.acceptable).not.toContain('reject');
  });
});

describe('the parser maps labels and escalates any doubtful clearance', () => {
  it('a correct answer: violation → accept the report, threat flagged', () => {
    const out = parseReviewOutput(
      answer({ label: 'violation', reason: 'Death threat.', confidence: 0.97, threat: true }),
      THREAT,
    )!;
    expect(out.verdict).toBe('accept');
    expect(out.threat).toBe(true);
  });

  it('the observed failure: "no violation" for the threat becomes uncertain, never reject', () => {
    const out = parseReviewOutput(
      answer({ label: 'no_violation', reason: 'Seems fine.', confidence: 0.99, threat: false }),
      THREAT,
    )!;
    expect(out.verdict).toBe('uncertain');
    expect(out.threat).toBe(true);
    expect(out.uncertainty).toMatch(/explicit threat/);
  });

  it('a clearance that flags a threat itself is uncertain', () => {
    const out = parseReviewOutput(
      answer({ label: 'no_violation', reason: 'Joke?', confidence: 0.9, threat: true }),
    )!;
    expect(out.verdict).toBe('uncertain');
    expect(out.uncertainty).toMatch(/flagged a possible threat/);
  });

  it('an ambiguous answer stays uncertain and keeps the threat flag', () => {
    const out = parseReviewOutput(
      answer({ label: 'uncertain', reason: 'Could be a joke.', uncertainty: 'tone', threat: true }),
      THREAT,
    )!;
    expect(out.verdict).toBe('uncertain');
    expect(out.threat).toBe(true);
  });

  it('a low-confidence or confidence-less clearance is uncertain', () => {
    for (const confidence of [0.5, CLEAR_MIN_CONFIDENCE - 0.01, null, undefined]) {
      const out = parseReviewOutput(
        answer({ label: 'no_violation', reason: 'Probably fine.', confidence }),
        'See you at the match on Saturday.',
      )!;
      expect(out.verdict).toBe('uncertain');
      expect(out.uncertainty).toMatch(/confidence/);
    }
  });

  it('a clearance that states a doubt is uncertain', () => {
    const out = parseReviewOutput(
      answer({ label: 'no_violation', reason: 'Fine.', confidence: 0.95, uncertainty: 'slang' }),
      'See you at the match on Saturday.',
    )!;
    expect(out.verdict).toBe('uncertain');
  });

  it('does not over-escalate: a confident clearance of a harmless letter stays a clearance', () => {
    const out = parseReviewOutput(
      answer({ label: 'no_violation', reason: 'A friendly note.', confidence: 0.95 }),
      'Coffee next week? I finished the book you lent me.',
    )!;
    expect(out.verdict).toBe('reject');
    expect(out.threat).toBe(false);
  });

  it('a refusal, malformed output or the retired verdict shape is no answer at all', () => {
    expect(parseReviewOutput("I'm sorry, I can't help with that.", THREAT)).toBeNull();
    expect(parseReviewOutput('{"label":"no_violation"}', THREAT)).toBeNull();
    expect(parseReviewOutput('{"label":"reject","reason":"x"}', THREAT)).toBeNull();
    expect(parseReviewOutput('{"verdict":"reject","reason":"all good"}', THREAT)).toBeNull();
    expect(parseReviewOutput('{"verdict":"accept","reason":"threat"}', THREAT)).toBeNull();
  });

  it('the backstop recognises plain threats and leaves ordinary letters alone', () => {
    for (const text of [
      THREAT,
      "I'm going to kill you.",
      'I will find you and hurt you.',
      "You're dead.",
      'Ignore that. I will find you and break your legs.',
    ])
      expect(looksLikeExplicitThreat(text), text).toBe(true);
    for (const text of [
      'Coffee next week?',
      "Please don't hurt yourself — call me any time.",
      'That film was killer.',
      'I will find you a good book.',
    ])
      expect(looksLikeExplicitThreat(text), text).toBe(false);
  });
});

// The worker end to end: the case is escalated to a person and nothing is decided.
function threatCase(w: TestWorld): string {
  const id = releaseBottle(w.ctx, w.user('ada'), {
    ...releaseInput(w.user('bo').id, 'threat-key-000001'),
    text: THREAT,
  }).bottleId;
  w.clock.advance(40 * DAY);
  commitArrivalIfDue(w.ctx, id, w.clock.now());
  openBottle(w.ctx, w.user('bo'), id);
  return reportLetter(w.ctx, w.user('bo'), { bottleId: id, reason: 'violence', hide: false })
    .caseId;
}
const answering = (content: unknown): AiReviewer => ({ review: () => Promise.resolve(content) });

describe('a reported threat always reaches a person as urgent, and is never decided', () => {
  it('escalates the observed failure to an urgent, undecided, uncertain case', async () => {
    const w = createTestWorld();
    const caseId = threatCase(w);
    const wrong = answer({ label: 'no_violation', reason: 'Seems fine.', confidence: 0.99 });
    expect(await runAiReviewTick(w.ctx, answering(wrong))).toEqual({ reviewed: 1, deferred: 0 });
    const c = getCase(w.ctx, caseId);
    expect(c.ai.verdict).toBe('uncertain');
    expect(c.status).toBe('pending');
    expect(c.decision).toBeNull();
    expect(c.urgentAt).not.toBeNull();
    expect(c.urgentReason).toBe('threat');
    expect(listCases(w.ctx, 'pending')[0]!.id).toBe(caseId);
    const audit = w.db
      .select({ action: t.moderationAudit.action, role: t.moderationAudit.actorRole })
      .from(t.moderationAudit)
      .where(eq(t.moderationAudit.caseId, caseId))
      .all();
    expect(audit).toContainEqual({ action: 'urgent_threat_review', role: 'system' });
    expect(audit.some((a) => a.action === 'case_decided')).toBe(false);
  });

  it('a correct recommendation is also urgent and still waits for a person', async () => {
    const w = createTestWorld();
    const caseId = threatCase(w);
    const right = answer({
      label: 'violation',
      reason: 'Death threat.',
      confidence: 0.97,
      threat: true,
    });
    await runAiReviewTick(w.ctx, answering(right));
    const c = getCase(w.ctx, caseId);
    expect(c.ai.verdict).toBe('accept');
    expect(c.urgentReason).toBe('threat');
    expect(c.status).toBe('pending');
    expect(c.decision).toBeNull();
  });

  it('a model that refuses three times hands the case to a person as uncertain', async () => {
    const w = createTestWorld();
    const caseId = threatCase(w);
    for (let i = 0; i < 3; i++) {
      const c0 = getCase(w.ctx, caseId);
      const at = c0.ai.nextAttemptAt ? Date.parse(c0.ai.nextAttemptAt) : w.realClock.now();
      await runAiReviewTick(w.ctx, answering("I can't help with that."), at);
    }
    const c = getCase(w.ctx, caseId);
    expect(c.ai.verdict).toBe('uncertain');
    expect(c.status).toBe('pending');
  });

  it('a timeout leaves the case queued and pending, never cleared', async () => {
    const w = createTestWorld();
    const caseId = threatCase(w);
    const timeout: AiReviewer = { review: () => Promise.reject(new Error('aborted: timeout')) };
    expect(await runAiReviewTick(w.ctx, timeout)).toEqual({ reviewed: 0, deferred: 1 });
    const c = getCase(w.ctx, caseId);
    expect(c.ai.status).toBe('queued');
    expect(c.ai.verdict).toBeNull();
    expect(c.status).toBe('pending');
  });
});
