// The project's support identity, in one place. The public support page, the legal documents
// and the App all read it from here, so the address a person is told to write to is the same
// everywhere it appears.
//
// The address is a public contact point, not a secret: nothing here holds or asks for a
// password, an app password, an OAuth token, SMTP credentials or a verification code. Support
// is a `mailto:` link and nothing more — there is no form, no inbox integration and no ticket
// store in the App.

export const SUPPORT_NAME = 'Sea You Support';
export const SUPPORT_EMAIL = 'seayou.support@gmail.com';

// Where the public support page lives. Same origin as the legal pages.
export const SUPPORT_PATH = '/support';

export interface SupportCategory {
  id: string;
  label: string;
  // The subject line the mail client opens with, so an arriving message is already sorted.
  subject: string;
  // One line on the page saying what belongs under this heading.
  hint: string;
}

export const SUPPORT_CATEGORIES: readonly SupportCategory[] = [
  {
    id: 'account',
    label: 'Account help',
    subject: `${SUPPORT_NAME} — Account help`,
    hint: 'Signing in, your email address, or anything about the account itself.',
  },
  {
    id: 'privacy',
    label: 'Privacy request',
    subject: `${SUPPORT_NAME} — Privacy request`,
    hint: 'Ask what information is held about you, or ask for it to be corrected or deleted.',
  },
  {
    id: 'safety',
    label: 'Safety or abusive content',
    subject: `${SUPPORT_NAME} — Safety report`,
    hint: 'Harassment, threats, or content that endangers someone. Reporting a letter inside the App is faster.',
  },
  {
    id: 'technical',
    label: 'Technical problem',
    subject: `${SUPPORT_NAME} — Technical problem`,
    hint: 'Something is broken, will not load, or behaves unexpectedly.',
  },
  {
    id: 'other',
    label: 'Other',
    subject: `${SUPPORT_NAME} — Other`,
    hint: 'Anything that does not fit the headings above.',
  },
];

// A `mailto:` link with the subject percent-encoded, so an em dash or a space survives every
// mail client. Nothing else is prefilled: what a person writes is their own.
export function supportMailto(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

// What a support message must never contain. Said plainly on the page, because a person asked
// for help is exactly the person a stranger will try to phish.
export const SUPPORT_NEVER_SEND = [
  'your password, or any password',
  'a verification or two-factor code',
  'Gmail or other account credentials',
  'payment card or bank details',
  'identity documents, or photographs of them',
];
