import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, RETIRED_PRODUCT_PHRASES } from './brand.js';
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
      expect(d.effective).toBe('Effective when published in SeaYou');
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
      /\byou must be at least\b/i,
      /\bwe verify (the )?age\b/i,
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
    // Saying plainly that there is no age verification is the point, and is not a claim that
    // anyone has been verified.
    expect(textOf(TERMS_OF_USE)).toMatch(/does not claim that its users have been age-verified/i);
    expect(textOf(TERMS_OF_USE)).toMatch(/not marketed as a children's app/i);
    expect(textOf(CHILD_SAFETY_STANDARDS)).toMatch(/not marketed as a children's app/i);
  });

  it('name no operator, address, company, registration number or jurisdiction', () => {
    for (const pattern of [
      /\bregistration number\b/i,
      /\bgoverning law\b/i,
      /\bjurisdiction\b/i,
      /\bcourts? of\b/i,
      /\bcompany number\b/i,
    ]) {
      expect(everything, String(pattern)).not.toMatch(pattern);
    }
    // The only address anywhere is the project's support contact — never a personal one, and
    // never escaped: a rendered backslash before the @ would make it uncopyable.
    const addresses = new Set(everything.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []);
    expect([...addresses]).toEqual([SUPPORT_EMAIL]);
    expect(everything).not.toContain('\\@');
    // Where the text needs a legal actor it says "the operator of SeaYou", never treating the
    // software itself as one and never naming a person or a company.
    expect(textOf(TERMS_OF_USE)).toContain(`the operator of ${PRODUCT_NAME}`);
  });

  it('call the product SeaYou, everywhere, and never by a retired name', () => {
    expect(PRODUCT_NAME).toBe('SeaYou');
    expect(everything).toContain('SeaYou');
    for (const phrase of RETIRED_PRODUCT_PHRASES) expect(everything, phrase).not.toContain(phrase);
    for (const d of PUBLISHED_DOCUMENTS)
      expect(`${d.title}\n${d.summary}`, d.slug).not.toMatch(/\bthe App\b/i);
    expect(SUPPORT_NAME).toBe('SeaYou Support');
  });

  it('describe the moderation system SeaYou actually implements', () => {
    const terms = textOf(TERMS_OF_USE);
    const rules = textOf(COMMUNITY_RULES);

    // Automated review recommends; a person decides. Nothing here may imply otherwise.
    for (const body of [terms, rules]) {
      expect(body).toMatch(/recommendation/i);
      expect(body).toMatch(/decided by a person/i);
    }
    expect(terms).toMatch(/not disclosed to its sender/i);
    expect(terms).toMatch(/required by law/i);

    // The ladder, and the fact that it never resets.
    expect(terms).toMatch(/A first upheld violation is a warning/);
    expect(terms).toMatch(/seven-day suspension/);
    expect(terms).toMatch(/permanent ban/);
    expect(terms).toMatch(/remain counted unless they are reversed on appeal/i);
    expect(terms).toMatch(/does not remove that violation from the count/i);
    expect(rules).toMatch(/stay counted unless an appeal reverses them|remain counted unless/i);

    // Nothing may suggest a violation ages out. Denying it is required; claiming it is a bug.
    for (const body of [terms, rules])
      for (const pattern of [
        /violations? (will )?expire/i,
        /age out/i,
        /removed after \d+ (months|years)/i,
        /expire after/i,
      ])
        expect(body, String(pattern)).not.toMatch(pattern);
    expect(terms).toMatch(/They do not expire/i);

    // The immediate appeal and the explicit waiver.
    expect(terms).toMatch(/appeal the decision, or continue without appealing/i);
    expect(terms).toMatch(/permanently giving up the appeal/i);
    expect(terms).toMatch(/without choosing does not give up anything/i);
    expect(terms).toMatch(/can be appealed once/i);
    expect(terms).toMatch(/rejected is final/i);
    expect(terms).toMatch(/accepted withdraws the violation/i);
    expect(terms).toMatch(/recalculated immediately/i);
    expect(rules).toMatch(/closing or reloading without choosing gives up nothing/i);

    // One case, one violation.
    expect(rules).toMatch(/single case/i);
    expect(rules).toMatch(/at most one violation/i);

    // Critical child-safety enforcement, which the admin console can actually apply.
    expect(terms).toMatch(/critical child-safety violation results in an immediate permanent ban/i);
    expect(terms).toMatch(/can still be appealed once/i);

    for (const prohibited of [
      /groom/i,
      /sexual content involving a minor/i,
      /threats/i,
      /harassment/i,
      /hate/i,
      /phishing/i,
      /spam/i,
      /illegal/i,
    ]) {
      expect(rules, String(prohibited)).toMatch(prohibited);
    }

    // Distress and good-faith disclosure are protected, in both documents that judge conduct.
    expect(rules).toMatch(/self-harm or suicide is not a violation/i);
    expect(rules).toMatch(/difficult language alone/i);
    expect(rules).toMatch(/good-faith disclosure/i);
    for (const body of [rules, textOf(CHILD_SAFETY_STANDARDS)]) {
      expect(body).toMatch(/Describing abuse is not the same as committing it/i);
      expect(body).toMatch(/contain, request, facilitate or link to abusive material/i);
    }
    // External reporting is conditional, never automatic.
    for (const body of [rules, textOf(CHILD_SAFETY_STANDARDS)]) {
      expect(body).toMatch(/where (applicable )?law requires/i);
      expect(body).toMatch(/not (automatically )?forwarded to an authority automatically/i);
    }
  });

  it('describe journeys the way the server actually runs them', () => {
    const terms = textOf(TERMS_OF_USE);
    expect(terms).toMatch(/derived from that route and its distance/i);
    expect(terms).toMatch(/elapsed time measured by the server/i);
    expect(terms).toMatch(/device clock or time zone does not make a journey arrive/i);
    expect(terms).toMatch(/harbour you are already at arrives immediately/i);
    expect(terms).toMatch(/adrift in the public ocean/i);
    expect(terms).toMatch(/72 hours/);
    expect(terms).toMatch(/one reading session/i);
    expect(terms).toMatch(/15 minutes/);
    expect(terms).toMatch(/do not keep a copy/i);
    expect(terms).toMatch(/sinks is not shown in the public ocean/i);
    expect(terms).toMatch(/can be delayed/i);
  });

  it('describe blocking as both directions and the public ocean', () => {
    for (const body of [textOf(TERMS_OF_USE), textOf(COMMUNITY_RULES)]) {
      expect(body).toMatch(/both directions/i);
      expect(body).toMatch(/public-ocean/i);
    }
    expect(textOf(TERMS_OF_USE)).toMatch(/cannot reach anything already read, copied/i);
  });

  it('describe evidence retention exactly as it is implemented', () => {
    const privacy = textOf(PRIVACY_POLICY);
    expect(privacy).toMatch(/redacted seven days after the case becomes final/i);
    expect(privacy).toMatch(/report is rejected/i);
    expect(privacy).toMatch(/explicitly gives up the appeal/i);
    expect(privacy).toMatch(/appeal they submitted has been decided/i);
    expect(privacy).toMatch(/while an appeal is pending, the case is not final/i);
    expect(privacy).toMatch(/upheld violations do not expire/i);
    expect(privacy).toMatch(/documented legal or immediate child-safety hold/i);
    expect(privacy).toMatch(/Releasing the hold returns the case to the ordinary calculation/i);
  });

  it('describe browser storage exactly, and claim no more', () => {
    const privacy = textOf(PRIVACY_POLICY);
    // Every mechanism the implementation uses, named, with when it is cleared.
    expect(privacy).toMatch(/session token, in sessionStorage/i);
    expect(privacy).toMatch(/in sessionStorage, so that a reload does not lose it/i);
    expect(privacy).toMatch(/time zone your device last reported, in localStorage/i);
    expect(privacy).toMatch(/removed when you sign out/i);
    // And the ones it does not.
    expect(privacy).toMatch(/sets no cookies, and uses no IndexedDB/i);
    // No absolute "no third-party code" claim; the honest narrower one instead.
    expect(privacy).not.toMatch(/no third-party code/i);
    expect(privacy).toMatch(
      /no advertising trackers, no analytics SDKs and no advertising pixels/i,
    );
    expect(privacy).toMatch(/third-party software libraries/i);
    expect(privacy).toMatch(/Data Safety declaration will be reviewed and updated/i);
  });

  it('describe network and support data without absolute claims', () => {
    const privacy = textOf(PRIVACY_POLICY);
    expect(privacy).toMatch(/Network addresses may be processed for security and rate limiting/i);
    expect(privacy).toMatch(/does not intentionally store them in its application database/i);
    expect(privacy).toMatch(/hosting and security providers may retain limited technical logs/i);
    expect(privacy).not.toMatch(/never stores? (your )?IP/i);
    expect(privacy).toMatch(/not stored in the SeaYou application database/i);
    expect(privacy).toMatch(/security, privacy or moderation action/i);
  });

  it('require verification for a privacy request, but never an identity document', () => {
    const privacy = textOf(PRIVACY_POLICY);
    expect(privacy).toMatch(/authenticated session/i);
    expect(privacy).toMatch(/one-time verification link/i);
    expect(privacy).toMatch(
      /government identity document is not required and will not be requested/i,
    );
  });

  it('publish child safety standards that match the enforcement that exists', () => {
    const cs = textOf(CHILD_SAFETY_STANDARDS);
    expect(cs).toMatch(/prohibits child sexual abuse and exploitation absolutely/i);
    expect(cs).toMatch(/forbidden for every user without exception/i);
    expect(cs).toMatch(/groom/i);
    expect(cs).toContain(PRODUCT_NAME);
    // Who can report, stated so it cannot be read as "anyone who can read it" when the sender
    // has no such flow.
    expect(cs).toMatch(/The person a letter was sent to can report it/i);
    expect(cs).toMatch(/eligible finder/i);
    expect(cs).toMatch(/sender cannot report their own letter through this flow/i);
    expect(cs).not.toMatch(/anyone who can read/i);
    // Report and Block are distinct, and blocking covers the public ocean.
    expect(cs).toMatch(/Report and Block are separate actions/i);
    expect(cs).toMatch(/public-ocean interactions/i);
    // In-app reporting opens a case; email is for what cannot be reported in app, and makes no
    // claim to create the same case.
    expect(cs).toMatch(/opens a moderation case/i);
    expect(cs).toMatch(/cannot be reported from inside/i);
    expect(cs).toMatch(/does not automatically create the same moderation case/i);
    // The enforcement it describes is the one the admin console can actually apply.
    expect(cs).toMatch(/critical child-safety violation/i);
    expect(cs).toMatch(/permanent ban applied immediately/i);
    expect(cs).toMatch(
      /requires an administrator, a recorded reason and an explicit confirmation/i,
    );
    expect(cs).toMatch(/Automated review can never apply it/i);
    expect(cs).toMatch(/single appeal opportunity still applies/i);
    // Retention and the hold.
    expect(cs).toMatch(/seven days after the case becomes final/i);
    expect(cs).toMatch(/documented legal or immediate child-safety hold/i);
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

  it('tell people support never asks for credentials, in the agreed words', () => {
    for (const body of [textOf(PRIVACY_POLICY), textOf(TERMS_OF_USE)]) {
      expect(body).toContain(
        'Do not send passwords, verification codes, payment details or identity documents ' +
          'through ordinary support requests. SeaYou Support will not request your password ' +
          'or verification codes.',
      );
    }
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
