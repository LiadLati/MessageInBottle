import { useState } from 'react';
import { currentPolicyVersions, type DocumentId } from '@mib/shared';
import { ApiError, api } from '../api/client.js';
import { EMPTY_CONSENT, PolicyConsent, consentProblems } from '../components/PolicyConsent.js';
import { SupportLink } from '../components/SupportLink.js';
import { useSession } from '../state/session.js';

// Shown instead of the app when a released version of the documents is one this account has
// not accepted — every account that existed before the documents did, and every account after
// a change. Nothing was carried over silently: the person reads and decides here, or signs out.
export function PolicyUpdateScreen({ onOpen }: { onOpen: (doc: DocumentId) => void }) {
  const { user, logout, setUser } = useSession();
  const [consent, setConsent] = useState(EMPTY_CONSENT);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!user) return null;
  const changed = user.policies.documents.filter((d) => d.acceptedVersion !== d.currentVersion);
  const firstTime = user.policies.documents.every((d) => d.acceptedVersion === null);
  const problems = consentProblems(consent);

  const submit = async () => {
    setSubmitted(true);
    if (problems.terms || problems.privacy) return;
    setBusy(true);
    setFailure(null);
    try {
      const policies = await api.acceptPolicies({
        acceptTerms: true,
        acceptGuidelines: true,
        acknowledgePrivacy: true,
        versions: currentPolicyVersions(),
      });
      setUser({ ...user, policies });
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.code === 'policy_version_stale'
          ? 'The documents changed while this page was open. Reload and read them again.'
          : 'Could not record your acceptance. Check your connection and try again.',
      );
      setBusy(false);
    }
  };

  return (
    <main className="login-screen">
      <div className="scrim" />
      <div className="login-card">
        <span className="t-eyebrow">Before you continue</span>
        <h1 className="t-display">
          {firstTime ? 'Before you continue' : 'The terms have changed'}
        </h1>
        <p className="secondary">
          {firstTime
            ? 'The App has published Terms of Use, Community Rules and a Privacy Policy. Please read them; using the App needs your acceptance.'
            : 'A document you accepted earlier has a new version. Please read it; continuing needs your acceptance of the current version.'}
        </p>
        <ul className="list policy-changes" aria-label="Documents to review">
          {user.policies.documents.map((d) => (
            <li key={d.id} className="row between">
              <span>
                {d.title} <span className="t-meta">v{d.currentVersion}</span>
              </span>
              <span className="t-meta">
                {d.acceptedVersion === null
                  ? 'not yet accepted'
                  : d.acceptedVersion === d.currentVersion
                    ? 'accepted'
                    : `you accepted v${d.acceptedVersion}`}
              </span>
            </li>
          ))}
        </ul>
        <div className="stack">
          <PolicyConsent
            value={consent}
            onChange={setConsent}
            onOpen={onOpen}
            showProblems={submitted}
            disabled={busy}
            legend="Your decision"
          />
          {failure ? (
            <p className="note error" role="alert">
              {failure}
            </p>
          ) : null}
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : changed.length ? 'Accept and continue' : 'Continue'}
          </button>
          <button type="button" className="btn-text" disabled={busy} onClick={() => void logout()}>
            Sign out instead
          </button>
          <SupportLink />
        </div>
      </div>
    </main>
  );
}
