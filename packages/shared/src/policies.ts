import { z } from 'zod';
import { SUPPORT_EMAIL, SUPPORT_NAME, SUPPORT_PATH } from './support.js';

// The legal documents of the App, in one place. The API serves them from here, validates
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
// address, registration number or jurisdiction, and refers to the product only as "the App".

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
export const POLICY_EFFECTIVE = 'Effective when published in the App';

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
  summary: 'The agreement between you and the App: accounts, letters, moderation and limits.',
  blocks: [
    { type: 'h2', text: '1. Accepting these Terms' },
    {
      type: 'p',
      text: 'By creating an account or using the App, you agree to these Terms and to the Community Rules, which form part of them. If you do not agree, do not create an account or use the App.',
    },
    { type: 'h2', text: '2. What the App does' },
    {
      type: 'p',
      text: 'The App lets you write letters, place them in virtual bottles, send them to other users, and follow simulated sea journeys between virtual harbours. Journeys, routes, weather, day and night, storms, loss at sea, sinking, arrival times and public-ocean appearances are simulated features. No physical item is transported, and the App does not claim to reproduce real ocean conditions.',
    },
    {
      type: 'p',
      text: 'A bottle may arrive, be lost and appear in the public ocean, or sink. A lost public bottle may be opened by one eligible user and later disappears from the public map. Delivery, opening, continued availability and exact arrival times are not guaranteed.',
    },
    { type: 'h2', text: '3. Accounts' },
    {
      type: 'p',
      text: `You must provide accurate account information, protect your password, and write to ${SUPPORT_NAME} promptly, through the support page at ${SUPPORT_PATH}, if you believe your account has been accessed without permission. You may not impersonate another person, create an account for someone without their permission, evade a restriction, or use multiple accounts to harass others.`,
    },
    {
      type: 'p',
      text: 'You may delete your account and its associated data from the account settings in the App. The same can be done from the account-deletion page on the public support site, without reinstalling the App.',
    },
    { type: 'h2', text: '4. Your letters and content' },
    {
      type: 'p',
      text: 'You remain responsible for the letters and other content you submit, and you keep any rights you have in that content.',
    },
    {
      type: 'p',
      text: 'You give the App a limited, non-exclusive licence to store, transmit, display, back up and review your content only as needed to operate, secure and moderate the service. This licence does not permit using your private letters for advertising or selling them to third parties.',
    },
    {
      type: 'p',
      text: 'Send only content you have the right to send. Do not include sensitive personal information about yourself or anyone else unless you are prepared for an authorised recipient or finder to read it. A recipient may copy or capture a letter; removing it from the App cannot erase copies made outside the App.',
    },
    { type: 'h2', text: '5. Community Rules' },
    {
      type: 'p',
      text: 'The Community Rules set out what you may and may not do in the App. They are part of these Terms, and they are published as a separate document so that they are easy to find and read on their own.',
    },
    { type: 'h2', text: '6. Reports, blocking and moderation' },
    {
      type: 'p',
      text: 'Eligible readers can report a letter and hide it from their own account, and users can block other users. Reports about the same letter are combined into a single case, so several reports never produce several violations.',
    },
    {
      type: 'p',
      text: 'A reported letter may be reviewed by an automated tool that returns a recommendation and its reasoning. The tool does not decide anything. An authorised human administrator reviews the report and decides whether to accept or reject it, and that decision is recorded with who made it, when and why. The identity of the person who reported a letter is not disclosed to its sender.',
    },
    {
      type: 'p',
      text: 'If a report is accepted, the letter is withdrawn from further reading in the App. The sender is notified and may submit one appeal against that decision. An accepted appeal reverses the violation and recalculates the standing of the account immediately. A rejected appeal is final within the App.',
    },
    { type: 'p', text: 'The standard enforcement sequence is:' },
    {
      type: 'ul',
      items: [
        'First upheld violation: a warning.',
        'Second active violation: a seven-day suspension, with a warning that another violation may result in a permanent ban.',
        'Third active violation: a permanent ban.',
      ],
    },
    {
      type: 'p',
      text: 'Only upheld violations that are still active are counted; a rejected report, an undecided report and a violation reversed on appeal are not. A suspended or banned account can still sign in, see its status, appeal, delete the account and sign out. We may take a different proportionate action where needed to address an immediate safety risk, protect the service, or comply with applicable law.',
    },
    { type: 'h2', text: '7. Availability and changes' },
    {
      type: 'p',
      text: 'The App may change, be interrupted, or stop offering a feature. We do not promise uninterrupted availability, permanent storage, successful delivery, or the preservation of any particular experience.',
    },
    {
      type: 'p',
      text: 'The App is free and offers no subscriptions, purchases or paid features. If paid features are introduced, the price, billing, renewal, cancellation, refund and consumer information will be shown before any purchase.',
    },
    {
      type: 'p',
      text: 'These Terms may be updated. Each version carries a version number, and a material change is presented in the App and requires acceptance of the new version before continued ordinary use.',
    },
    { type: 'h2', text: '8. Responsibility and legal limits' },
    {
      type: 'p',
      text: 'The App is provided for personal, recreational correspondence. It is not professional, medical or legal advice, and it is not an emergency service. If someone may be in immediate danger, contact your local emergency service rather than relying on a report in the App.',
    },
    {
      type: 'p',
      text: 'Nothing in these Terms excludes rights or responsibilities that cannot lawfully be excluded. To the fullest extent permitted by applicable law, the App is not responsible for indirect losses, for loss of content outside its reasonable control, or for user conduct it could not reasonably have prevented.',
    },
    { type: 'h2', text: '9. Contact' },
    {
      type: 'p',
      text: `Questions, safety concerns, privacy requests and account-deletion requests reach ${SUPPORT_NAME} through the support page at ${SUPPORT_PATH}, which is also linked from Help & Support in the App. Support will never ask you for a password, a verification code, payment details or an identity document.`,
    },
  ],
};

export const COMMUNITY_RULES: PolicyDocument = {
  ...common,
  id: 'guidelines',
  title: 'Community Rules',
  slug: 'community-rules',
  summary: 'What you may and may not write in the App, and what happens when a letter is reported.',
  blocks: [
    {
      type: 'p',
      text: 'A letter may reach someone who does not know the person who wrote it. You may write sadly, personally, critically or fictionally. You may not use the App to hurt people, expose them, or exploit them.',
    },
    { type: 'h2', text: 'What you may do' },
    {
      type: 'ul',
      items: [
        'Share personal writing, opinions, stories, humour, poetry and criticism that do not break these rules. Context matters: an unpleasant opinion, a fictional passage, irony, slang, or supportive words to someone in distress are not violations in themselves.',
        'Report a letter in good faith and hide it from your own account, even if the review later rejects the report.',
        'Block another user. A block stops correspondence in both directions.',
        'Appeal once against a decision that upheld a violation, and give the context that may change it.',
      ],
    },
    { type: 'h2', text: 'What you may not do' },
    {
      type: 'ol',
      items: [
        'Make credible threats, extort someone, encourage violence, or instruct others how to harm a person.',
        'Target someone with harassment, repeated humiliation or abusive conduct, or attack a protected group with hatred.',
        'Send unwanted sexual content or pressure, facilitate sexual exploitation, or create, request or distribute any sexual content involving minors. Grooming a minor, or any child sexual abuse or exploitation material, is prohibited absolutely and is reported and acted upon.',
        "Reveal, or threaten to reveal, another person's address, phone number, credentials, private communications or other identifying or sensitive information without permission.",
        'Impersonate others, commit fraud, request passwords or payment credentials, distribute phishing links, send spam, or advertise without permission.',
        'Evade a block, suspension, ban, safety control, rate limit or other restriction.',
        'Submit knowingly false or abusive reports in order to harm another user.',
        "Infringe another person's intellectual-property, privacy or other legal rights, or use the App for unlawful conduct.",
      ],
    },
    { type: 'h2', text: 'What happens after a report' },
    {
      type: 'p',
      text: 'A report opens a single case for that letter and hides the letter from the reader who reported it. An automated tool may add a recommendation with its reasoning and with whatever it was unsure about; it never decides. An authorised administrator reads the letter and decides. If the report is accepted, the letter is withdrawn from further reading in the App, the sender is notified without learning who reported it, and one appeal is available. Section 6 of the Terms of Use sets out the warning, suspension and ban sequence.',
    },
    {
      type: 'p',
      text: 'The App is not an emergency service. If someone may be in immediate danger, contact your local emergency service.',
    },
  ],
};

export const PRIVACY_POLICY: PolicyDocument = {
  ...common,
  id: 'privacy',
  title: 'Privacy Policy',
  slug: 'privacy',
  summary:
    'What information the App processes, who can see it, how long it is kept, and how to delete it.',
  blocks: [
    { type: 'h2', text: '1. Scope' },
    {
      type: 'p',
      text: 'This Privacy Policy explains what information the App processes, why it is used, when others may see it, and how you can request access, correction or deletion.',
    },
    { type: 'h2', text: '2. Information the App processes' },
    {
      type: 'ul',
      items: [
        'Account information: username, display name, email address, password hash, account identifier, account status, and password-recovery records.',
        'Policy records: which version of the Terms of Use, Community Rules and Privacy Policy the account accepted, and when.',
        'Profile and preferences: the selected virtual harbour, the time zone reported by your device, and settings you choose in the App.',
        'Letters and journeys: letter text, sender and authorised recipient identifiers, virtual harbours, simulated routes, timestamps, delivery and opening events, and loss or sinking outcomes.',
        'Friends and safety relationships: friend requests, friendships, blocks and their state.',
        'Moderation information: reports and their reasons, the reported letter, automated recommendations, administrator decisions, violations, warnings, suspensions, bans and appeals.',
        'Security and technical information: authentication records and rate-limit counters needed to secure the service. Network addresses are used in memory for rate limiting and are not written to the database.',
        'Support information: messages you send through support, privacy, safety or deletion requests.',
      ],
    },
    {
      type: 'p',
      text: 'The App does not request precise device location, contacts, camera, microphone or payment information. It contains no advertising trackers or analytics services, and it does not sell personal information.',
    },
    { type: 'h2', text: '3. How information is used' },
    {
      type: 'ul',
      items: [
        'To create and secure accounts and to recover passwords.',
        'To operate virtual harbours, letters, bottle journeys, arrivals and notifications.',
        'To show content to authorised recipients and to an eligible public-ocean finder.',
        'To maintain friend and block relationships.',
        'To prevent spam, abuse, fraud and unauthorised access.',
        'To investigate reports, decide appeals and enforce the Community Rules.',
        'To answer support, privacy, safety and deletion requests.',
        'To maintain, troubleshoot and improve the reliability of the App.',
        'To comply with applicable legal obligations and to protect users, the service and others.',
      ],
    },
    { type: 'h2', text: '4. Who may see information' },
    {
      type: 'p',
      text: 'A letter can be seen by its sender, by its authorised recipient, and, when a bottle is lost and shown in the public ocean, by the single eligible finder who opens it. A marker on the public map shows only a simulated position and the time the bottle was lost; it does not disclose the sender, the recipient, the harbours or the text.',
    },
    {
      type: 'p',
      text: 'Authorised administrators can access what they need in order to investigate reports, appeals, security issues and support requests. A reported letter and the reasons given for reporting it may be sent to an automated review tool for a recommendation; that tool has no access to the database and no authority to decide, and an authorised human administrator makes the decision.',
    },
    {
      type: 'p',
      text: 'Service providers may process limited information only as needed to host, secure or operate the App or to deliver account email on its behalf. Information may also be disclosed where required by applicable law or reasonably necessary to protect users, the service or legal rights. The App does not sell letters or personal information and does not use private letters for advertising.',
    },
    { type: 'h2', text: '5. The public ocean and one-time reading' },
    {
      type: 'p',
      text: 'A lost bottle may appear in the public ocean for up to 72 hours, or until an eligible user opens it, whichever comes first. The finder receives a single reading session, which can be resumed for up to 15 minutes if the connection drops; it creates no lasting archive of the letter for that finder. Removal from the public map, or the end of a reading session, does not by itself delete the sender’s letter or journey history.',
    },
    { type: 'h2', text: '6. Retention' },
    {
      type: 'p',
      text: 'Account, letter and journey information is kept while the account is active and as needed to provide the service. When an account deletion is completed, the account is de-identified and its personal information is removed, except for the limited information that must reasonably be kept to resolve an open report or appeal, to enforce an active safety restriction, to prevent fraud or abuse, to maintain security, or to comply with applicable law.',
    },
    {
      type: 'p',
      text: 'Moderation evidence is kept while it is needed for an open case, a possible or pending appeal, or a violation that is still in force, and is then removed or de-identified under the retention rules of the App. Expired authentication and password-recovery records, operational logs and support records are kept only for a period appropriate to their purpose.',
    },
    {
      type: 'p',
      text: 'Backups may retain deleted information for a limited recovery period before being overwritten. Copies made independently by a recipient outside the App cannot be controlled or deleted by the App.',
    },
    { type: 'h2', text: '7. Account deletion and privacy requests' },
    {
      type: 'p',
      text: 'You can delete your account from the account settings in the App, or from the account-deletion page on the public support site without reinstalling the App. Deletion asks for your password and an explicit final confirmation. When it completes, every session is revoked immediately, your profile and identifiers are removed or replaced with an anonymous label, and your account disappears from search, friends and the rest of the App.',
    },
    {
      type: 'p',
      text: 'You may also use the Privacy Request option to ask for access to, or correction of, your account information. Reasonable identity verification may be required first. Some information may be kept where necessary for an open safety matter, the rights of another person, security, fraud prevention or a legal obligation.',
    },
    { type: 'h2', text: '8. Device storage and permissions' },
    {
      type: 'p',
      text: 'The App stores your sign-in token and any unsent letter in the storage of the browser tab, which is cleared when you sign out, and remembers the time zone reported by your device so that a change is noticed on the next start. It uses no cookies, no third-party code, no analytics and no advertising pixels, and it requests no device permissions for its current features.',
    },
    { type: 'h2', text: '9. Security' },
    {
      type: 'p',
      text: `Passwords are stored only as salted hashes and cannot be recovered. Sign-in and password-reset tokens are stored as hashes; a reset token can be used once and expires after 30 minutes. Administrative functions are restricted by a role that is granted only on the server and checked on every request. Production deployments serve the App over encrypted network transport. No system can guarantee absolute security; suspected security issues can be reported to ${SUPPORT_NAME} at ${SUPPORT_EMAIL}, through the support page at ${SUPPORT_PATH}.`,
    },
    { type: 'h2', text: '10. Changes to this Policy' },
    {
      type: 'p',
      text: 'This Policy may be updated when the App or its data practices change. Each version carries a version number, and a material change is shown in the App and requires a renewed acknowledgement before continued ordinary use.',
    },
    { type: 'h2', text: '11. Contact' },
    {
      type: 'p',
      text: `Privacy questions, requests and complaints reach ${SUPPORT_NAME}, the support contact for the App, at ${SUPPORT_EMAIL}. The support page at ${SUPPORT_PATH} opens a message with the subject already set, and is linked from Help & Support in the App and from the store listing. Support will never ask you for a password, a verification code, payment details or an identity document.`,
    },
  ],
};

export const CHILD_SAFETY_STANDARDS: PolicyDocument = {
  ...common,
  id: 'child-safety',
  title: 'Child Safety Standards',
  slug: 'child-safety',
  summary:
    'How the App prohibits child sexual abuse and exploitation, and how reports of it are handled.',
  blocks: [
    { type: 'h2', text: 'Our standard' },
    {
      type: 'p',
      text: 'Child sexual abuse and exploitation have no place in the App. Creating, requesting, sharing, or linking to child sexual abuse material, sexualising a minor in any way, and grooming or attempting to make sexual contact with a minor are prohibited absolutely. There is no context, no fiction and no private exchange in which they are permitted.',
    },
    {
      type: 'p',
      text: 'This standard applies to every user, to every letter, and to every part of the App, including letters sent directly to a recipient and letters found in the public ocean.',
    },
    { type: 'h2', text: 'Reporting inside the App' },
    {
      type: 'p',
      text: 'Anyone who can read a letter can report it from the reader itself: the recipient of a letter that arrived at their harbour, and a finder during their one-time reading of a lost bottle. Reporting takes a reason and an optional explanation, and hides the letter from the person who reported it straight away. Users can also block other users, which stops correspondence in both directions.',
    },
    { type: 'h2', text: 'How we respond' },
    {
      type: 'p',
      text: 'A report opens a case that an authorised administrator reviews. An automated tool may add a recommendation, but it never decides. Where a report of child sexual abuse or exploitation is upheld, the content is withdrawn from further reading in the App and the account is sanctioned, up to and including a permanent ban, and the evidence is preserved for the investigation. Material of this kind is treated as an immediate safety risk, so we may act at once rather than following the ordinary warning sequence.',
    },
    { type: 'h2', text: 'Legal requests and cooperation' },
    {
      type: 'p',
      text: 'Valid legal requests from competent authorities relating to child safety are reviewed and handled appropriately, and information is disclosed where required by applicable law or reasonably necessary to protect a child from harm. Evidence relevant to such a matter is retained for as long as it is needed for that purpose.',
    },
    { type: 'h2', text: 'Contact' },
    {
      type: 'p',
      text: `Child-safety concerns reach ${SUPPORT_NAME}, the support contact for the App, at ${SUPPORT_EMAIL}; the support page at ${SUPPORT_PATH} opens a message with the subject already set, and is linked from Help & Support in the App and from the store listing. Reporting a letter inside the App reaches the same review process and is the fastest way to have content examined. If a child may be in immediate danger, contact your local emergency service first.`,
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
