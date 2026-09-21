import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_GUIDELINES,
  POLICY_DOCUMENTS,
  POLICY_IDS,
  PRIVACY_POLICY,
  PolicyAcceptanceRequestSchema,
  TERMS_OF_USE,
  currentPolicyVersions,
  openItemsOf,
  policySetStatus,
  segmentsOf,
  validatePolicySet,
  type PolicyDocument,
} from './policies.js';

describe('policy documents', () => {
  it('ships all three as a consistent draft set', () => {
    expect(POLICY_DOCUMENTS.map((d) => d.id)).toEqual([...POLICY_IDS]);
    expect(validatePolicySet(POLICY_DOCUMENTS)).toEqual([]);
    expect(policySetStatus()).toBe('draft');
    for (const d of POLICY_DOCUMENTS) {
      expect(d.status).toBe('draft');
      expect(d.version).toMatch(/-draft$/);
      expect(d.effectiveAt).toBeNull();
      expect(d.lang).toBe('he');
      expect(d.dir).toBe('rtl');
      expect(d.blocks.length).toBeGreaterThan(3);
    }
    expect(currentPolicyVersions()).toEqual({
      terms: TERMS_OF_USE.version,
      guidelines: COMMUNITY_GUIDELINES.version,
      privacy: PRIVACY_POLICY.version,
    });
  });

  it('keeps every undecided fact as a visible open item rather than a guess', () => {
    const open = {
      terms: openItemsOf(TERMS_OF_USE),
      guidelines: openItemsOf(COMMUNITY_GUIDELINES),
      privacy: openItemsOf(PRIVACY_POLICY),
    };
    // The decisions the operator still owes: identity and contact, the minimum age, the appeal
    // deadline, the legal basis, providers and hosting, retention periods, security in
    // deployment. None of them may be filled in by this code.
    expect(open.terms.join(' ')).toMatch(/מפעיל השירות|שם משפטי/);
    expect(open.terms.join(' ')).toMatch(/גיל מינימלי/);
    expect(open.terms.join(' ')).toMatch(/ערעור/);
    expect(open.terms.join(' ')).toMatch(/הדין החל|ערכאה/);
    expect(open.privacy.join(' ')).toMatch(/בסיס המשפטי/);
    expect(open.privacy.join(' ')).toMatch(/ספקי אירוח|ספק האירוח/);
    expect(open.privacy.join(' ')).toMatch(/משך שמירה|תקופת שמירה|תקופות שמירה/);
    expect(open.privacy.join(' ')).toMatch(/TLS/);
    expect(open.privacy.join(' ')).toMatch(/הגיל/);
    // Nothing that the draft flagged as "verify" was left hedged once verified: the product
    // has no payments and no marketing, so the documents say so without a marker.
    expect(open.terms.join(' ')).not.toMatch(/תשלום/);
    expect(open.privacy.join(' ')).not.toMatch(/שיווק/);
    // Guidelines are conduct rules and carry no operator-specific fact at all.
    expect(open.guidelines).toEqual([]);
  });

  it('never describes a self-service deletion, an age gate or a marketing consent', () => {
    const all = POLICY_DOCUMENTS.flatMap((d) =>
      d.blocks.flatMap((b) =>
        b.type === 'table'
          ? b.rows.flat()
          : b.type === 'ul' || b.type === 'ol'
            ? b.items
            : [b.text],
      ),
    ).join('\n');
    expect(all).toMatch(/אין בשירות מחיקת חשבון עצמית/);
    expect(all).toMatch(/אין בשירות מנויים, רכישות או אמצעי תשלום/);
    expect(all).toMatch(/אינו שולח מסרים שיווקיים/);
    expect(all).toMatch(/אינו משתמש בעוגיות/);
    // The minimum age appears only inside an open marker, never as a plain statement.
    for (const d of POLICY_DOCUMENTS)
      for (const b of d.blocks)
        if (b.type === 'p') {
          const plain = b.text.replace(/\[\[[^\]]+\]\]/g, '');
          expect(plain).not.toMatch(/18 ומעלה/);
        }
  });

  it('refuses to call a document released while it still has open items', () => {
    const half: PolicyDocument = {
      ...TERMS_OF_USE,
      status: 'released',
      version: '1.0',
      effectiveAt: '2026-10-01',
    };
    const problems = validatePolicySet([half, COMMUNITY_GUIDELINES, PRIVACY_POLICY]);
    expect(problems.some((p) => /unresolved field/.test(p))).toBe(true);
    // A draft may not pretend to be a release and vice versa.
    expect(
      validatePolicySet([
        { ...TERMS_OF_USE, version: '1.0' },
        COMMUNITY_GUIDELINES,
        PRIVACY_POLICY,
      ]),
    ).toContain("terms: a draft's version must end in -draft");
    expect(
      validatePolicySet([
        { ...COMMUNITY_GUIDELINES, status: 'released', version: '1.0', effectiveAt: null },
        TERMS_OF_USE,
        PRIVACY_POLICY,
      ]),
    ).toContain('guidelines: a released document needs effectiveAt');
  });

  it('splits inline open markers for rendering', () => {
    expect(segmentsOf('לפני [[א]] ואחרי')).toEqual([
      { kind: 'text', text: 'לפני ' },
      { kind: 'open', text: 'א' },
      { kind: 'text', text: ' ואחרי' },
    ]);
    expect(segmentsOf('ללא סימון')).toEqual([{ kind: 'text', text: 'ללא סימון' }]);
  });

  it('accepts only explicit, literal acceptances with versions', () => {
    const versions = currentPolicyVersions();
    const ok = { acceptTerms: true, acceptGuidelines: true, acknowledgePrivacy: true, versions };
    expect(PolicyAcceptanceRequestSchema.safeParse(ok).success).toBe(true);
    for (const flag of ['acceptTerms', 'acceptGuidelines', 'acknowledgePrivacy'] as const) {
      expect(PolicyAcceptanceRequestSchema.safeParse({ ...ok, [flag]: false }).success).toBe(false);
      expect(PolicyAcceptanceRequestSchema.safeParse({ ...ok, [flag]: 'true' }).success).toBe(
        false,
      );
      const rest: Record<string, unknown> = { ...ok };
      delete rest[flag];
      expect(PolicyAcceptanceRequestSchema.safeParse(rest).success).toBe(false);
    }
    expect(PolicyAcceptanceRequestSchema.safeParse({ ...ok, versions: {} }).success).toBe(false);
  });
});
