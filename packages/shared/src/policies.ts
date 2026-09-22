import { z } from 'zod';
import { PRODUCT_NAME } from './brand.js';
import { SUPPORT_EMAIL, SUPPORT_NAME, SUPPORT_PATH, SUPPORT_WARNING } from './support.js';

// The legal documents of SeaYou, in one place. The API serves them from here, validates
// acceptances against the versions here, renders the public web pages from here, and the app
// renders the in-app views from here — so the text a person was shown, the version recorded
// against their account and the text on the public URL can never drift apart.
//
// Three documents carry consent: the Terms of Use and the Community Rules are accepted (they
// bind), and the Privacy Policy is acknowledged (it informs). A fourth, the Child Safety
// Standards, is published for reference and store review; it is not something a person agrees
// to, so it is not part of the acceptance set.
//
// Everything here is English and left-to-right, deliberately free of any operator name,
// address, registration number or jurisdiction. Where the text needs to name a legal actor it
// says "the operator of SeaYou" rather than treating the software itself as one.
//
// Nothing here may describe behaviour the code does not have. Every statement about journeys,
// appeals, retention, enforcement, browser storage and deletion below is implemented and
// covered by tests; the tests in policies.test.ts and the API's legal tests exist to keep it
// that way.

export const POLICY_IDS = ['terms', 'guidelines', 'privacy'] as const;
export type PolicyId = (typeof POLICY_IDS)[number];
export const PolicyIdSchema = z.enum(POLICY_IDS);

// Documents that have a public page but no acceptance.
export const REFERENCE_IDS = ['child-safety'] as const;
export type ReferenceId = (typeof REFERENCE_IDS)[number];
export type DocumentId = PolicyId | ReferenceId;

// What the person does with each consent document at registration.
export const POLICY_ACTION: Record<PolicyId, 'accepted' | 'acknowledged'> = {
  terms: 'accepted',
  guidelines: 'accepted',
  privacy: 'acknowledged',
};

export type PolicyStatus = 'draft' | 'released';

// The published version of the whole set. A material change means a new version here, which
// asks every account to accept again before ordinary use.
export const POLICY_VERSION = '1.0';
// These texts take effect when the build carrying them is published; there is no separate date
// to keep in step with a release, so the documents say exactly that.
export const POLICY_EFFECTIVE = `Effective when published in ${PRODUCT_NAME}`;

// Content is structured, never raw HTML, so it renders through real headings, lists and tables
// in the app and on the public pages alike, and a screen reader can navigate it.
export type PolicyBlock =
  | { type: 'h2'; text: string }
  | { type: 'h3'; text: string }
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

export interface PolicyDocument {
  id: DocumentId;
  title: string;
  // The path segment of the public page: /legal/<slug>.
  slug: string;
  lang: 'en';
  dir: 'ltr';
  version: string;
  status: PolicyStatus;
  effective: string;
  // One sentence for the public page's description meta tag and for link previews.
  summary: string;
  blocks: PolicyBlock[];
}

// ---------- validation ----------

// Text that would mean the document is not finished. A published document containing any of
// these is a bug, so the set is checked in tests and by the API at boot rather than trusted.
const UNFINISHED = [
  /\[\[/, // an unresolved field marker
  /\bTBD\b/i,
  /\bTODO\b/i,
  /\bplaceholder\b/i,
  /\bdraft\b/i,
  /\blorem ipsum\b/i,
  // The Hebrew block, written as escapes so this file stays ASCII: these documents are
  // English only, and an earlier draft of them was not.
  new RegExp('[\\u0590-\\u05FF]'),
];

export function textOf(doc: PolicyDocument): string {
  return doc.blocks
    .map((b) => (b.type === 'ul' || b.type === 'ol' ? b.items.join('\n') : b.text))
    .join('\n');
}

// Returns the problems with a set of documents; an empty array means it may be published.
export function validatePolicySet(docs: readonly PolicyDocument[]): string[] {
  const problems: string[] = [];
  for (const id of POLICY_IDS)
    if (!docs.some((d) => d.id === id)) problems.push(`missing document: ${id}`);
  for (const d of docs) {
    if (!/^\d+\.\d+(\.\d+)?$/.test(d.version))
      problems.push(`${d.id}: version "${d.version}" is not N.N[.N]`);
    if (d.status !== 'released') problems.push(`${d.id}: is not released`);
    if (!d.effective.trim()) problems.push(`${d.id}: has no effective statement`);
    if (d.lang !== 'en' || d.dir !== 'ltr')
      problems.push(`${d.id}: must be English, left-to-right`);
    const body = `${d.title}\n${d.summary}\n${textOf(d)}`;
    for (const pattern of UNFINISHED)
      if (pattern.test(body))
        problems.push(`${d.id}: contains unfinished text matching ${pattern}`);
  }
  return problems;
}

// ---------- acceptance ----------

export const PolicyVersionsSchema = z.object({
  terms: z.string().min(1).max(32),
  guidelines: z.string().min(1).max(32),
  privacy: z.string().min(1).max(32),
});
export type PolicyVersions = z.infer<typeof PolicyVersionsSchema>;

// Sent with registration and by an existing account accepting a new version. Each flag must be
// literally true — a missing or false flag is a schema failure, never a default — and the
// versions must be the ones the person was shown. The server checks them against the current
// versions, so a client cannot assert consent to something it never displayed.
export const PolicyAcceptanceRequestSchema = z.object({
  acceptTerms: z.literal(true),
  acceptGuidelines: z.literal(true),
  acknowledgePrivacy: z.literal(true),
  versions: PolicyVersionsSchema,
});
export type PolicyAcceptanceRequest = z.infer<typeof PolicyAcceptanceRequestSchema>;

export const PolicyDocumentStatusSchema = z.object({
  id: PolicyIdSchema,
  title: z.string(),
  currentVersion: z.string(),
  action: z.enum(['accepted', 'acknowledged']),
  acceptedVersion: z.string().nullable(),
  acceptedAt: z.string().nullable(),
});
export const AccountPoliciesSchema = z.object({
  status: z.enum(['draft', 'released']),
  required: z.boolean(),
  documents: z.array(PolicyDocumentStatusSchema),
});
export type AccountPoliciesDto = z.infer<typeof AccountPoliciesSchema>;

export const PolicySetResponseSchema = z.object({
  status: z.enum(['draft', 'released']),
  documents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      slug: z.string(),
      version: z.string(),
      effective: z.string(),
    }),
  ),
});

// ---------- account deletion ----------

// Deleting an account needs the password again and an explicit confirmation, so that a stolen
// session alone cannot do it and a stray tap cannot either.
export const DeleteAccountRequestSchema = z.object({
  password: z.string().min(1).max(256),
  confirm: z.literal(true),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

export const AccountDeletedResponseSchema = z.object({
  deletedAt: z.string(),
  alreadyDeleted: z.boolean(),
});

// ---------- the documents ----------

const common = {
  lang: 'en',
  dir: 'ltr',
  version: POLICY_VERSION,
  status: 'released',
  effective: POLICY_EFFECTIVE,
} as const;

export const TERMS_OF_USE: PolicyDocument = {
  ...common,
  id: 'terms',
  title: 'Terms of Use',
  slug: 'terms',
  summary: `The agreement between you and ${PRODUCT_NAME}: accounts, letters, journeys, moderation and limits.`,
  blocks: [
    { type: 'h2', text: '1. Accepting these Terms' },
    {
      type: 'p',
      text: `By creating an account or using ${PRODUCT_NAME}, you agree to these Terms and to the Community Rules, which form part of them. If you do not agree, do not create an account or use ${PRODUCT_NAME}.`,
    },
    {
      type: 'p',
      text: `These Terms are between you and the operator of ${PRODUCT_NAME}. Where they describe what is allowed, what is kept and what may be removed, the operator of ${PRODUCT_NAME} is the party responsible for those decisions.`,
    },
    { type: 'h2', text: `2. What ${PRODUCT_NAME} does` },
    {
      type: 'p',
      text: `${PRODUCT_NAME} lets you write letters, place them in virtual bottles, send them to people you are connected with, and follow simulated sea journeys between virtual harbours. Journeys, routes, weather, day and night, storms, loss at sea, sinking, arrival times and public-ocean appearances are simulated features. No physical item is transported, and ${PRODUCT_NAME} does not claim to reproduce real ocean conditions.`,
    },
    { type: 'h2', text: '3. Your account' },
    {
      type: 'p',
      text: 'You are responsible for what is written and sent from your account, and for keeping your password to yourself. Tell support at once if you believe someone else has your account.',
    },
    {
      type: 'p',
      text: `${PRODUCT_NAME} is not marketed as a children's app and is not directed at children. There is no age-verification step, and ${PRODUCT_NAME} does not claim that its users have been age-verified.`,
    },
    { type: 'h2', text: '4. How a journey works' },
    {
      type: 'p',
      text: 'A journey takes as long as the simulated route between the two virtual harbours takes: the duration is derived from that route and its distance, and it is counted in elapsed time measured by the server.',
    },
    {
      type: 'ul',
      items: [
        'Changing your device clock or time zone does not make a journey arrive sooner or later. The schedule is held by the server.',
        'A letter sent to the harbour you are already at arrives immediately.',
        'A bottle may arrive at its destination, be lost and go adrift in the public ocean, or sink.',
        'A bottle adrift in the public ocean stays listed there until one eligible finder opens it, or until 72 hours after it was lost, whichever happens first.',
        'The finder who opens an adrift bottle gets one reading session, which can be resumed for up to 15 minutes if it is interrupted. They do not keep a copy, and it does not appear in their archive afterwards.',
        'You can still read your own letter under the ordinary rules that apply to you as its sender.',
        'A bottle that sinks is not shown in the public ocean.',
      ],
    },
    {
      type: 'p',
      text: 'Processing and notification can be delayed — a worker may run a little late, or your device may be offline — but the planned timing of a journey remains the server’s, and a delay in telling you does not change when something happened.',
    },
    { type: 'h2', text: '5. Your letters' },
    {
      type: 'p',
      text: `You keep ownership of what you write. You grant the operator of ${PRODUCT_NAME} a limited, non-exclusive licence to store, transmit and display your letters for the purpose of running the service: delivering them to the person you sent them to, showing them to an eligible finder where a bottle goes adrift, and keeping the copies described in the Privacy Policy for moderation.`,
    },
    {
      type: 'p',
      text: 'This licence exists only so that the service can work. It is not a licence to publish, sell or advertise with what you write.',
    },
    { type: 'h2', text: '6. Rules of use' },
    {
      type: 'p',
      text: `The Community Rules say what may and may not be sent. They are part of these Terms, and using ${PRODUCT_NAME} means agreeing to them.`,
    },
    { type: 'h2', text: '7. Blocking' },
    {
      type: 'ul',
      items: [
        'Blocking stops correspondence in both directions: neither account can write to the other.',
        `Blocking also keeps the two accounts from encountering each other through public-ocean interactions in ${PRODUCT_NAME}.`,
        `Blocking cannot reach anything already read, copied, photographed or saved outside ${PRODUCT_NAME}. It changes what happens next, not what has already left.`,
      ],
    },
    { type: 'h2', text: '8. Reporting and moderation' },
    {
      type: 'p',
      text: 'A letter that is available to you to read can be reported. Reporting it opens a moderation case, and a copy of the letter is kept as evidence so that a human reviewer can judge what was actually sent.',
    },
    {
      type: 'ul',
      items: [
        'Several reports about one letter make a single case, and a single case can produce at most one violation.',
        'Every case is decided by a person. Automated review, where it is used, produces a recommendation for a reviewer and never a decision.',
        'The identity of whoever reported a letter is not disclosed to its sender through ' +
          `${PRODUCT_NAME}, except where disclosure is required by law.`,
        'Reports that are rejected, and reports nobody has decided yet, count for nothing.',
      ],
    },
    { type: 'h2', text: '9. Violations, appeals and enforcement' },
    {
      type: 'p',
      text: 'When a report is upheld, the decision is shown to you, and that is when you can appeal it. You are offered two choices: appeal the decision, or continue without appealing. Choosing to continue asks you to confirm, because confirming means permanently giving up the appeal for that decision.',
    },
    {
      type: 'ul',
      items: [
        'Closing, refreshing or leaving ' +
          `${PRODUCT_NAME} without choosing does not give up anything. The decision is shown to you again the next time you can act on it.`,
        'Each violation can be appealed once.',
        `An appeal that is rejected is final inside ${PRODUCT_NAME}.`,
        'An appeal that is accepted withdraws the violation, and your account standing is recalculated immediately.',
      ],
    },
    {
      type: 'p',
      text: 'Upheld violations remain counted unless they are reversed on appeal. They do not expire and are not removed by the passing of time.',
    },
    {
      type: 'ul',
      items: [
        'A first upheld violation is a warning.',
        'A second is a seven-day suspension.',
        'A third is a permanent ban.',
        'Serving a suspension does not remove that violation from the count: when the suspension ends you can use your account again, but the violation still stands.',
        'A confirmed critical child-safety violation results in an immediate permanent ban, without the steps above. It can still be appealed once, like any other decision.',
      ],
    },
    {
      type: 'p',
      text: `While an account is suspended or banned it can still sign in to read the decision, appeal it, get support, delete the account and sign out. ${PRODUCT_NAME} does not lock a person away from the decision made about them.`,
    },
    { type: 'h2', text: '10. Deleting your account' },
    {
      type: 'p',
      text: 'You can delete your account from Settings, and from the public account-deletion page, which is reachable without signing in. Deleting asks for your password again and for an explicit confirmation, and it signs out every session at once.',
    },
    {
      type: 'p',
      text: 'Your account data is then deleted or anonymised as described in the Privacy Policy. Limited records may remain where they are needed for an active moderation case, for documented security and abuse prevention, or to meet a legal obligation.',
    },
    { type: 'h2', text: '11. Availability' },
    {
      type: 'p',
      text: `${PRODUCT_NAME} is provided as it is. Features may change, and the service may be interrupted for maintenance or for reasons outside the operator’s control. Simulated outcomes — including a bottle being lost or sinking — are part of the design and are not faults.`,
    },
    { type: 'h2', text: '12. Changes to these Terms' },
    {
      type: 'p',
      text: `A material change means a new version of these documents, and you are asked to accept it before continuing to use ${PRODUCT_NAME}. Accounts that accepted an earlier version are asked again; nobody is treated as having agreed to something they were never shown.`,
    },
    { type: 'h2', text: '13. Support' },
    {
      type: 'p',
      text: `${SUPPORT_NAME} can be reached at ${SUPPORT_EMAIL}, and the support page at ${SUPPORT_PATH} opens a message with the subject already filled in. ${SUPPORT_WARNING}`,
    },
  ],
};

export const COMMUNITY_RULES: PolicyDocument = {
  ...common,
  id: 'guidelines',
  title: 'Community Rules',
  slug: 'community-rules',
  summary: `What may and may not be sent in ${PRODUCT_NAME}, and what happens when a letter is reported.`,
  blocks: [
    { type: 'h2', text: '1. The idea' },
    {
      type: 'p',
      text: `${PRODUCT_NAME} is for letters. A letter can be slow, personal and unguarded — that is the point of it. You may write about sad, personal, critical or fictional subjects. You may not use ${PRODUCT_NAME} to harm, expose or exploit others.`,
    },
    { type: 'h2', text: '2. What is not allowed' },
    {
      type: 'ul',
      items: [
        'Harassment, bullying, stalking, or repeated unwanted contact.',
        'Threats of violence, or encouraging anyone to harm another person.',
        'Hate directed at people for who they are.',
        'Sexual content involving a minor, in any form, and any attempt to groom, solicit or sexualise a child.',
        'Sharing another person’s private information, or intimate images of anyone, without their consent.',
        'Content that is illegal to possess or distribute.',
        'Fraud, scams, phishing, or asking others for passwords, verification codes or payment details.',
        'Spam, bulk or automated sending.',
        'Impersonating another person in order to deceive.',
      ],
    },
    { type: 'h2', text: '3. Distress, self-harm and asking for help' },
    {
      type: 'p',
      text: 'Writing about despair, self-harm or suicide is not a violation. Saying that you are struggling, asking for help, or supporting someone who is struggling is not a violation either, and difficult language alone is not a reason to remove a letter.',
    },
    {
      type: 'p',
      text: 'What is not allowed is encouraging, instructing or pressuring another person to hurt themselves. If you are in danger now, contact your local emergency service: this is a letter-writing service and cannot reach anyone on your behalf.',
    },
    { type: 'h2', text: '4. Child safety' },
    {
      type: 'p',
      text: 'Material that sexualises or exploits a child, and any attempt to groom or solicit a child, are prohibited absolutely and are treated as critical.',
    },
    {
      type: 'p',
      text: 'Describing abuse is not the same as committing it. A good-faith disclosure by a victim, a request for help, and a serious discussion of abuse are not violations, and will not be treated as such merely because of what they describe. What they may never do is contain, request, facilitate or link to abusive material.',
    },
    {
      type: 'p',
      text: 'Where child-safety material is confirmed, it is reported to the appropriate authorities where applicable law requires that, and after a person has reviewed it. Reports are not forwarded to an authority automatically.',
    },
    { type: 'h2', text: '5. Reporting and blocking' },
    {
      type: 'p',
      text: 'Report and Block are separate actions and do different things.',
    },
    {
      type: 'ul',
      items: [
        'Reporting a letter opens a moderation case for a human reviewer, and hides the letter from your own reading straight away.',
        'Blocking stops correspondence in both directions and keeps the two accounts from encountering each other through public-ocean interactions. It does not, by itself, report anything.',
      ],
    },
    {
      type: 'p',
      text: 'A letter can be reported by the person it was sent to, and by an eligible finder who has opened it after it went adrift in the public ocean — the people who can actually read it. Several reports about one letter make a single case, and that case can produce at most one violation.',
    },
    {
      type: 'p',
      text: `Whoever reported a letter is not identified to its sender through ${PRODUCT_NAME}, except where disclosure is required by law.`,
    },
    { type: 'h2', text: '6. False and abusive reports' },
    {
      type: 'p',
      text: 'Reporting in good faith is always welcome, and being wrong is not an offence. Knowingly false reports, and reporting used as a way to harass someone, are not allowed. The number of reports one account may make is limited, and reporting records are kept so that a pattern of abuse can be seen and acted on.',
    },
    { type: 'h2', text: '7. When a report is upheld' },
    {
      type: 'p',
      text: 'Every case is decided by a person. Automated review, where it is used, only produces a recommendation for that person to consider.',
    },
    {
      type: 'p',
      text: 'When a report against you is upheld, the decision is put in front of you and that is when you can appeal it. You can appeal the decision, or continue without appealing — and continuing asks you to confirm, because it permanently gives up the appeal for that decision. Closing or reloading without choosing gives up nothing; the decision comes back the next time you can act on it. Each violation may be appealed once. A rejected appeal is final here; an accepted appeal withdraws the violation and your standing is recalculated at once.',
    },
    {
      type: 'p',
      text: 'Upheld violations remain counted unless they are reversed on appeal: one is a warning, two a seven-day suspension, three a permanent ban. Serving a suspension does not reduce the count. A confirmed critical child-safety violation bans immediately, and can still be appealed once.',
    },
  ],
};

export const PRIVACY_POLICY: PolicyDocument = {
  ...common,
  id: 'privacy',
  title: 'Privacy Policy',
  slug: 'privacy',
  summary: `What ${PRODUCT_NAME} stores, why, how long it is kept and how to have it deleted.`,
  blocks: [
    { type: 'h2', text: '1. Scope' },
    {
      type: 'p',
      text: `This policy describes what ${PRODUCT_NAME} stores about you, why, and for how long. It covers the app and the public pages at ${SUPPORT_PATH} and /legal.`,
    },
    { type: 'h2', text: '2. What is stored' },
    {
      type: 'ul',
      items: [
        'Account details: your username, display name, the email address you registered with, a hashed password (never the password itself), and the time zone your device reports, which is used to decide when your night falls.',
        'Letters you write, their recipient, and the journey and outcome of each bottle.',
        'Your connections, and the accounts you have blocked.',
        'Notifications generated for you.',
        'The versions of these documents you accepted, and when.',
        'Moderation records: reports you make, cases about letters you sent, decisions, appeals and violations.',
      ],
    },
    { type: 'h2', text: '3. Moderation evidence and how long it is kept' },
    {
      type: 'p',
      text: 'When a letter is reported, a copy of it is kept as evidence so that a reviewer can judge what was sent, and so that an appeal is decided on the same text. That copy is kept only as long as it can still be needed.',
    },
    {
      type: 'ul',
      items: [
        'Content evidence — the copied letter and the explanations reporters wrote — is redacted seven days after the case becomes final.',
        'A case becomes final when the report is rejected, when an upheld sender explicitly gives up the appeal, or when an appeal they submitted has been decided.',
        'While a report is undecided, while the sender has not yet seen and resolved the decision, or while an appeal is pending, the case is not final and the evidence is kept.',
        'Records of the decision itself are kept after that: the case identity, the decision and its reason, which administrator made it, the timestamps, the violation and its enforcement count, the relationship to the report for abuse prevention, and your account standing history. These are kept because upheld violations do not expire.',
        'Evidence is kept longer than seven days only under a documented legal or immediate child-safety hold, which records why it was placed and by whom. Releasing the hold returns the case to the ordinary calculation.',
      ],
    },
    {
      type: 'p',
      text: `Whoever reported a letter is not identified to its sender through ${PRODUCT_NAME}, except where disclosure is required by law.`,
    },
    { type: 'h2', text: '4. Automated review' },
    {
      type: 'p',
      text: 'Reported letters may be examined by an automated review that runs on infrastructure the operator controls, in order to produce a recommendation — with its reasoning, a translation where the letter is not in the reviewer’s language, and a statement of its uncertainty — for a human reviewer. It never decides a case, and an uncertain result never decides anything at all.',
    },
    {
      type: 'p',
      text: 'If an external provider is ever used for this, this policy and the store Data Safety declaration will be updated before any report content is sent to it.',
    },
    { type: 'h2', text: '5. What is on your device' },
    {
      type: 'p',
      text: 'Nothing is stored in your browser except these three things:',
    },
    {
      type: 'ul',
      items: [
        'Your session token, in sessionStorage. It is removed when you sign out, when the server rejects it, and by the browser when the tab is closed.',
        'The letter you are still writing and have not sent, in sessionStorage, so that a reload does not lose it. It is removed as soon as the letter is sent, and by the browser when the tab is closed.',
        'The time zone your device last reported, in localStorage, so the app can tell when it changes and tell the server. It is removed when you sign out.',
      ],
    },
    {
      type: 'p',
      text: `${PRODUCT_NAME} sets no cookies, and uses no IndexedDB. It contains no advertising trackers, no analytics SDKs and no advertising pixels. Like any modern application it is built with third-party software libraries; what it does not contain is anything that follows you.`,
    },
    {
      type: 'p',
      text: 'If analytics, crash reporting or any other tracking is added later, this policy and the store Data Safety declaration will be reviewed and updated before it is switched on.',
    },
    { type: 'h2', text: '6. Network and hosting data' },
    {
      type: 'p',
      text: `Network addresses may be processed for security and rate limiting. ${PRODUCT_NAME} does not intentionally store them in its application database, although hosting and security providers may retain limited technical logs under their own retention controls.`,
    },
    { type: 'h2', text: '7. Support messages' },
    {
      type: 'p',
      text: `The support page opens a message to ${SUPPORT_EMAIL} in your own mail application. Messages therefore reach the project mailbox and its email provider, and are held there under that provider’s terms. Support messages are not stored in the ${PRODUCT_NAME} application database, unless information from one has to be recorded as part of a security, privacy or moderation action.`,
    },
    {
      type: 'p',
      text: SUPPORT_WARNING,
    },
    { type: 'h2', text: '8. Deleting your account' },
    {
      type: 'p',
      text: 'You can delete your account from Settings, or from the public account-deletion page without signing in first. It asks for your password and an explicit confirmation, and it is carried out as one operation. This is what happens:',
    },
    {
      type: 'ul',
      items: [
        'Profile identifiers — your username, display name and email address — are removed or replaced with anonymous values, and your password is cleared so the account cannot be signed in to again.',
        'Every session is revoked immediately.',
        'Friend and block relationships are removed.',
        'Bottles still travelling are cancelled, and their reserved space is released.',
        'Letters you wrote are removed from future reading in the app, and their text is cleared — except where a copy is still held as evidence for a moderation case that is not finished, or under a documented hold. Those copies follow the retention rules in section 3.',
        'Letters other people wrote to you are not deleted: they belong to their authors, who can still see what became of what they sent.',
        'Your notifications are removed.',
        'The account row itself is kept in an anonymised form, so that records which legitimately refer to it — a letter someone else wrote, a moderation case still open — do not lose their references. It holds no personal details.',
        'Minimal anonymised journey and audit metadata remains, because moderation records and account standing history must survive the account they describe.',
      ],
    },
    { type: 'h2', text: '9. Your requests' },
    {
      type: 'p',
      text: `Write to ${SUPPORT_NAME} at ${SUPPORT_EMAIL} to ask what is held about you, to have it corrected, or to have it deleted.`,
    },
    {
      type: 'p',
      text: 'A request is verified before it is acted on, because acting on an unverified request would itself be a breach. Verification may be an authenticated session in the app, your password, demonstrated control of the account’s email address, or a one-time verification link. A government identity document is not required and will not be requested for this service.',
    },
    { type: 'h2', text: '10. Security' },
    {
      type: 'p',
      text: 'Passwords are stored only as salted hashes. Sessions expire and can be revoked. Moderation evidence is readable only by administrators, and every moderation action that changes what a person may do is recorded in an audit trail. A production deployment is configured to require HTTPS, so traffic between your device and the server is encrypted in transit.',
    },
    {
      type: 'p',
      text: 'No service can promise that nothing will ever go wrong. What is described here is what the system does, not a guarantee of the outcome.',
    },
    { type: 'h2', text: '11. Changes' },
    {
      type: 'p',
      text: 'A material change means a new version, and you are asked to acknowledge it before continuing. Accounts that acknowledged an earlier version are asked again.',
    },
  ],
};

export const CHILD_SAFETY_STANDARDS: PolicyDocument = {
  ...common,
  id: 'child-safety',
  title: 'Child Safety Standards',
  slug: 'child-safety',
  summary: `How ${PRODUCT_NAME} prohibits child sexual abuse and exploitation, how to report it, and how reports are handled.`,
  blocks: [
    { type: 'h2', text: '1. Our standard' },
    {
      type: 'p',
      text: `${PRODUCT_NAME} prohibits child sexual abuse and exploitation absolutely. Material that sexualises or exploits a child, and any attempt to groom, solicit or sexually approach a child, are forbidden for every user without exception, and are treated as critical.`,
    },
    {
      type: 'p',
      text: `${PRODUCT_NAME} is not marketed as a children's app and is not directed at children.`,
    },
    { type: 'h2', text: '2. Good-faith disclosure is protected' },
    {
      type: 'p',
      text: 'Describing abuse is not the same as committing it. A victim disclosing what happened to them, a person asking for help, and a serious discussion of abuse are not violations, and are not treated as such merely because of what they describe.',
    },
    {
      type: 'p',
      text: 'What such a letter may never do is contain, request, facilitate or link to abusive material.',
    },
    { type: 'h2', text: '3. Reporting inside the app' },
    {
      type: 'p',
      text: `Reporting from inside ${PRODUCT_NAME} is the fastest route and the one to use where it is available. Every report opens a moderation case for a human reviewer, and the reported letter is hidden from your own reading immediately.`,
    },
    {
      type: 'ul',
      items: [
        'The person a letter was sent to can report it.',
        'An eligible finder who has opened a bottle adrift in the public ocean can report it.',
        'In other words, the people who can read a letter can report it. A sender cannot report their own letter through this flow.',
      ],
    },
    {
      type: 'p',
      text: 'Report and Block are separate actions. Reporting opens a case; blocking stops correspondence in both directions and also prevents the two accounts encountering each other through public-ocean interactions. Blocking on its own does not report anything.',
    },
    { type: 'h2', text: '4. Reporting by email' },
    {
      type: 'p',
      text: `${SUPPORT_NAME} is the child-safety point of contact and can be reached at ${SUPPORT_EMAIL}. The support page at ${SUPPORT_PATH} opens a message with the subject already set, and needs no account.`,
    },
    {
      type: 'p',
      text: `Email is for concerns that cannot be reported from inside ${PRODUCT_NAME} — because you no longer have access to the letter, because you are not the person it was sent to, or because it concerns something outside a single letter. An email is read by a person; it does not automatically create the same moderation case that in-app reporting does.`,
    },
    {
      type: 'p',
      text: 'If a child may be in immediate danger, contact your local emergency service first. This service cannot reach anyone on your behalf.',
    },
    { type: 'h2', text: '5. How a confirmed case is enforced' },
    {
      type: 'p',
      text: 'Every case is decided by a person; automated review only produces a recommendation. When a child-safety case is confirmed, an administrator may classify it as a critical child-safety violation, which is a permanent ban applied immediately, rather than the ordinary sequence of a warning, then a suspension, then a ban.',
    },
    {
      type: 'ul',
      items: [
        'The classification requires an administrator, a recorded reason and an explicit confirmation.',
        'The administrator, the timestamp, the classification and the action are recorded in an audit trail.',
        'Automated review can never apply it.',
        'The letter is withdrawn from any further reading in the app.',
        'The single appeal opportunity still applies: the person is shown the decision and may appeal it once.',
      ],
    },
    { type: 'h2', text: '6. Evidence and external reporting' },
    {
      type: 'p',
      text: 'A copy of the reported letter is kept as evidence so the case and any appeal are judged on what was actually sent. Content evidence is redacted seven days after the case becomes final, and is kept longer only under a documented legal or immediate child-safety hold, which records why it was placed and by whom. Releasing the hold returns the case to the ordinary calculation. Records of the decision itself are kept.',
    },
    {
      type: 'p',
      text: 'Confirmed material is reported to the appropriate authorities where applicable law requires it, and following review by a person. Reports are not forwarded to an authority automatically.',
    },
  ],
};

export const POLICY_DOCUMENTS: readonly PolicyDocument[] = [
  TERMS_OF_USE,
  COMMUNITY_RULES,
  PRIVACY_POLICY,
];

// Everything with a public page, in the order they are listed on those pages.
export const PUBLISHED_DOCUMENTS: readonly PolicyDocument[] = [
  ...POLICY_DOCUMENTS,
  CHILD_SAFETY_STANDARDS,
];

export function policyDocument(id: PolicyId): PolicyDocument {
  return POLICY_DOCUMENTS.find((d) => d.id === id)!;
}

export function publishedDocumentBySlug(slug: string): PolicyDocument | undefined {
  return PUBLISHED_DOCUMENTS.find((d) => d.slug === slug);
}

export function currentPolicyVersions(
  docs: readonly PolicyDocument[] = POLICY_DOCUMENTS,
): PolicyVersions {
  const at = (id: PolicyId) => docs.find((d) => d.id === id)!.version;
  return { terms: at('terms'), guidelines: at('guidelines'), privacy: at('privacy') };
}

export function policySetStatus(docs: readonly PolicyDocument[] = POLICY_DOCUMENTS): PolicyStatus {
  return docs.every((d) => d.status === 'released') ? 'released' : 'draft';
}
