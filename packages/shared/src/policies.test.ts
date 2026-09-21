import { describe, expect, it } from 'vitest';
import { SUPPORT_EMAIL, SUPPORT_NAME, SUPPORT_PATH, supportMailto } from './support.js';
import {
  CHILD_SAFETY_STANDARDS,
  COMMUNITY_RULES,
  POLICY_DOCUMENTS,
  POLICY_EFFECTIVE,
  POLICY_IDS,
  POLICY_VERSION,
  PRIVACY_POLICY,
  PUBLISHED_DOCUMENTS,
  PolicyAcceptanceRequestSchema,
  TERMS_OF_USE,
  currentPolicyVersions,
  policySetStatus,
  publishedDocumentBySlug,
  textOf,
  validatePolicySet,
} from './policies.js';

const everything = PUBLISHED_DOCUMENTS.map((d) => `${d.title}\n${d.summary}\n${textOf(d)}`).join(
  '\n',
);

describe('the published documents', () => {
  it('are released English v1.0 documents with an effective statement', () => {
    expect(POLICY_DOCUMENTS.map((d) => d.id)).toEqual([...POLICY_IDS]);
    expect(validatePolicySet(PUBLISHED_DOCUMENTS)).toEqual([]);
    expect(policySetStatus()).toBe('released');
    for (const d of PUBLISHED_DOCUMENTS) {
      expect(d.status).toBe('released');
      expect(d.version).toBe(POLICY_VERSION);
      expect(POLICY_VERSION).toBe('1.0');
      expect(d.effective).toBe(POLICY_EFFECTIVE);
      expect(d.effective).toBe('Effective when published in the App');
      expect(d.lang).toBe('en');
      expect(d.dir).toBe('ltr');
      expect(d.blocks.length).toBeGreaterThan(3);
      expect(d.slug).toMatch(/^[a-z-]+$/);
    }
    expect(currentPolicyVersions()).toEqual({
      terms: '1.0',
      guidelines: '1.0',
      privacy: '1.0',
    });
    expect(publishedDocumentBySlug('child-safety')).toBe(CHILD_SAFETY_STANDARDS);
    expect(publishedDocumentBySlug('nope')).toBeUndefined();
  });

  it('carry no Hebrew, no draft notice, no placeholder and no unresolved field', () => {
    expect(everything).not.toMatch(/[֐-׿]/);
    for (const word of [/\[\[/, /\bdraft\b/i, /\bTBD\b/i, /\bTODO\b/i, /placeholder/i]) {
      expect(everything).not.toMatch(word);
    }
    // The guard is real: a document that acquired unfinished text would fail validation.
    expect(
      validatePolicySet([
        { ...TERMS_OF_USE, summary: 'A draft for review' },
        COMMUNITY_RULES,
        PRIVACY_POLICY,
      ]),
    ).toContainEqual(expect.stringMatching(/unfinished text/));
    expect(
      validatePolicySet([{ ...TERMS_OF_USE, status: 'draft' }, COMMUNITY_RULES, PRIVACY_POLICY]),
    ).toContain('terms: is not released');
    expect(
      validatePolicySet([{ ...TERMS_OF_USE, lang: 'he' as 'en' }, COMMUNITY_RULES, PRIVACY_POLICY]),
    ).toContain('terms: must be English, left-to-right');
  });

  it('state no age requirement and make no claim that users are adults or age-verified', () => {
    for (const pattern of [
      /\b18\b/,
      /\bage[- ]?verif/i,
      /\bdate of birth\b/i,
      /\bbirth ?date\b/i,
      /\badults only\b/i,
      /\baged? \d+ or older\b/i,
      /\bover the age of\b/i,
      /\bminimum age\b/i,
      /\bconfirm that you are at least\b/i,
    ]) {
      expect(everything, String(pattern)).not.toMatch(pattern);
    }
  });

  it('name no operator, address, company, registration number or jurisdiction', () => {
    for (const pattern of [
      /\bregistration number\b/i,
      /\bgoverning law\b/i,
      /\bjurisdiction\b/i,
      /\bcourts? of\b/i,
      /\bcompany number\b/i,
      /Message in a Bottle/,
    ]) {
      expect(everything, String(pattern)).not.toMatch(pattern);
    }
    // The only address anywhere is the project's support contact — never a personal one.
    const addresses = new Set(everything.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []);
    expect([...addresses]).toEqual([SUPPORT_EMAIL]);
    // The product is referred to only as "the App".
    expect(everything).toMatch(/\bthe App\b/);
  });

  it('describe the moderation system the App actually implements', () => {
    const terms = textOf(TERMS_OF_USE);
    expect(terms).toMatch(/recommendation/i);
    expect(terms).toMatch(/does not decide anything/i);
    expect(terms).toMatch(/human administrator/i);
    expect(terms).toMatch(/not disclosed to its sender/i);
    expect(terms).toMatch(/First upheld violation: a warning/);
    expect(terms).toMatch(/seven-day suspension/);
    expect(terms).toMatch(/permanent ban/);
    expect(terms).toMatch(/one appeal/i);
    expect(terms).toMatch(/accepted appeal reverses the violation/i);
    const rules = textOf(COMMUNITY_RULES);
    for (const prohibited of [
      /grooming/i,
      /child sexual abuse/i,
      /threats/i,
      /harassment/i,
      /hatred/i,
      /phishing/i,
      /spam/i,
      /unlawful/i,
    ]) {
      expect(rules, String(prohibited)).toMatch(prohibited);
    }
    // The public-ocean finder gets one reading and no archive.
    expect(textOf(PRIVACY_POLICY)).toMatch(/single reading session/i);
    expect(textOf(PRIVACY_POLICY)).toMatch(/no lasting archive/i);
    expect(textOf(PRIVACY_POLICY)).toMatch(/72 hours/);
    expect(textOf(PRIVACY_POLICY)).toMatch(/15 minutes/);
  });

  it('promise account deletion only in the terms the App implements', () => {
    const privacy = textOf(PRIVACY_POLICY);
    expect(privacy).toMatch(/delete your account from the account settings/i);
    expect(privacy).toMatch(/account-deletion page on the public support site/i);
    expect(privacy).toMatch(/asks for your password and an explicit final confirmation/i);
    expect(privacy).toMatch(/every session is revoked immediately/i);
    expect(textOf(TERMS_OF_USE)).toMatch(/delete your account/i);
  });

  it('publish child safety standards covering prohibition, reporting, removal and legal requests', () => {
    const cs = textOf(CHILD_SAFETY_STANDARDS);
    expect(cs).toMatch(/child sexual abuse material/i);
    expect(cs).toMatch(/grooming/i);
    expect(cs).toMatch(/prohibited absolutely/i);
    expect(cs).toMatch(/report it from the reader/i);
    expect(cs).toMatch(/withdrawn from further reading/i);
    expect(cs).toMatch(/permanent ban/i);
    expect(cs).toMatch(/valid legal requests/i);
    expect(cs).toMatch(/support page/i);
    // It is published but never part of what a person accepts.
    expect(POLICY_IDS).not.toContain('child-safety' as never);
  });

  it('send people to the project support contact, and name it where it matters', () => {
    const terms = textOf(TERMS_OF_USE);
    const privacy = textOf(PRIVACY_POLICY);
    const child = textOf(CHILD_SAFETY_STANDARDS);
    // Every document that used to say "the public support page" now gives the real path.
    for (const [name, body] of [
      ['terms', terms],
      ['privacy', privacy],
      ['child safety', child],
    ] as const) {
      expect(body, name).toContain(SUPPORT_PATH);
    }
    // Privacy and Child Safety identify the address itself.
    expect(privacy).toContain(SUPPORT_EMAIL);
    expect(child).toContain(SUPPORT_EMAIL);
    expect(privacy).toContain(SUPPORT_NAME);
    expect(child).toContain(SUPPORT_NAME);
    // Nothing vague survives.
    expect(everything).not.toMatch(/public support page linked from the store listing/);
    expect(everything).not.toMatch(/Support and Privacy Request options/);
    // No promise about how quickly anyone answers, and no jurisdiction.
    expect(everything).not.toMatch(/within \d+ (hours|days|business)/i);
    expect(everything).not.toMatch(/response time/i);
  });

  it('tell people support never asks for credentials', () => {
    expect(textOf(PRIVACY_POLICY)).toMatch(/never ask you for a password/i);
    expect(textOf(TERMS_OF_USE)).toMatch(/never ask you for a password/i);
  });

  it('builds a support mailto with an encoded subject', () => {
    const link = supportMailto(SUPPORT_EMAIL, 'Sea You Support — Account help');
    expect(link.startsWith(`mailto:${SUPPORT_EMAIL}?subject=`)).toBe(true);
    expect(link).not.toContain(' ');
    expect(link).toContain(encodeURIComponent('Sea You Support — Account help'));
  });

  it('accepts only explicit, literal acceptances carrying the versions shown', () => {
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
