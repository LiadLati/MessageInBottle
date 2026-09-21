import { useId } from 'react';
import type { PolicyId } from '@mib/shared';

// The two registration controls, both unchecked to begin with and each its own decision:
// accepting the Terms of Use and the Community Guidelines (they bind), and acknowledging the
// Privacy Policy (it informs). Each names the documents it covers as links, so the person can
// read before deciding without losing what they typed. Used by registration and by the screen
// an existing account sees when a released version changes.
export interface ConsentState {
  terms: boolean;
  privacy: boolean;
}
export const EMPTY_CONSENT: ConsentState = { terms: false, privacy: false };

export function consentProblems(c: ConsentState): { terms: string | null; privacy: string | null } {
  return {
    terms: c.terms
      ? null
      : 'To create an account, accept the Terms of Use and Community Guidelines.',
    privacy: c.privacy ? null : 'Please confirm that you have read the Privacy Policy.',
  };
}

export function PolicyConsent({
  value,
  onChange,
  onOpen,
  showProblems,
  disabled,
  legend = 'Before you continue',
}: {
  value: ConsentState;
  onChange: (next: ConsentState) => void;
  onOpen: (doc: PolicyId) => void;
  showProblems: boolean;
  disabled: boolean;
  legend?: string;
}) {
  const ids = { terms: useId(), privacy: useId() };
  const problems = consentProblems(value);
  const link = (doc: PolicyId, label: string) => (
    <button
      type="button"
      className="link-inline"
      disabled={disabled}
      onClick={(e) => {
        // The row is a label: a click on the link must open the document, not toggle the box.
        e.preventDefault();
        e.stopPropagation();
        onOpen(doc);
      }}
    >
      {label}
    </button>
  );
  return (
    <fieldset className="consent" disabled={disabled}>
      <legend className="t-label">{legend}</legend>
      <div className="field">
        <label className="checkbox-row" htmlFor={ids.terms}>
          <input
            id={ids.terms}
            type="checkbox"
            checked={value.terms}
            aria-invalid={showProblems && Boolean(problems.terms)}
            aria-describedby={showProblems && problems.terms ? `${ids.terms}-err` : undefined}
            onChange={(e) => onChange({ ...value, terms: e.target.checked })}
          />
          <span>
            I have read and accept the {link('terms', 'Terms of Use')} and the{' '}
            {link('guidelines', 'Community Guidelines')}.
          </span>
        </label>
        {showProblems && problems.terms ? (
          <p id={`${ids.terms}-err`} className="field-error" role="alert">
            {problems.terms}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label className="checkbox-row" htmlFor={ids.privacy}>
          <input
            id={ids.privacy}
            type="checkbox"
            checked={value.privacy}
            aria-invalid={showProblems && Boolean(problems.privacy)}
            aria-describedby={showProblems && problems.privacy ? `${ids.privacy}-err` : undefined}
            onChange={(e) => onChange({ ...value, privacy: e.target.checked })}
          />
          <span>I have read the {link('privacy', 'Privacy Policy')}.</span>
        </label>
        {showProblems && problems.privacy ? (
          <p id={`${ids.privacy}-err`} className="field-error" role="alert">
            {problems.privacy}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}
