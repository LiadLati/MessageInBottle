import { useEffect, useRef } from 'react';
import { PUBLISHED_DOCUMENTS, type DocumentId } from '@mib/shared';
import { useSession } from '../state/session.js';
import { Avatar } from './ui.js';
import { Icon } from '../design/Icon.js';

interface Props {
  shoreName: string | null;
  onChangeShore: () => void;
  onOpenPolicy: (doc: DocumentId) => void;
  onDeleteAccount: () => void;
  onStanding: () => void;
  onClose: () => void;
}

// One line saying what this account accepted and when — or that it never has, which is the
// truthful state of every account that predates the documents.
function acceptanceLine(p: {
  status: 'draft' | 'released';
  documents: Array<{
    acceptedVersion: string | null;
    acceptedAt: string | null;
    currentVersion: string;
  }>;
}): string {
  const latest = p.documents
    .map((d) => d.acceptedAt)
    .filter((a): a is string => a !== null)
    .sort()
    .at(-1);
  if (!latest) return 'You have not accepted a version of these documents yet.';
  const current = p.documents.every((d) => d.acceptedVersion === d.currentVersion);
  const when = new Date(latest).toLocaleDateString();
  const version = p.documents[0]?.acceptedVersion ?? '';
  return current
    ? `Accepted version ${version} on ${when}.${p.status === 'draft' ? ' The documents are still a working draft.' : ''}`
    : `You accepted version ${version} on ${when}; a newer version is waiting for you.`;
}

// The header avatar opens this instead of a permanent "signed in as" row (IA note on S1).
export function ProfileSheet({
  shoreName,
  onChangeShore,
  onOpenPolicy,
  onStanding,
  onDeleteAccount,
  onClose,
}: Props) {
  const { user, logout } = useSession();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!user) return null;
  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 35, background: 'rgba(3,12,20,.45)' }}
    >
      <div
        role="dialog"
        aria-label="Your account"
        className="glass-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 'calc(var(--header-pad-top) + 60px)',
          right: 16,
          width: 280,
        }}
      >
        <div className="row">
          <Avatar name={user.displayName} />
          <div className="grow">
            <div className="t-card-title">{user.displayName}</div>
            <div className="t-meta">
              @{user.username}
              {shoreName ? ` · ${shoreName}` : ' · no shore yet'}
            </div>
          </div>
          <button
            ref={first}
            type="button"
            className="glass-control"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="stack" style={{ marginTop: 14 }}>
          <button type="button" className="btn-secondary" onClick={onChangeShore}>
            <Icon name="shore" size={16} />
            {shoreName ? 'Change shore' : 'Choose a shore'}
          </button>
          <button type="button" className="btn-text" onClick={onStanding}>
            Account standing
          </button>
          <button type="button" className="btn-text" onClick={() => void logout()}>
            Sign out
          </button>
          <button type="button" className="btn-text danger" onClick={onDeleteAccount}>
            Delete account
          </button>
          <p className="t-meta">
            A shore is only an anchor in the app. It says nothing about where you live.
          </p>
          <section aria-labelledby="profile-legal" className="stack" style={{ gap: 6 }}>
            <h2 id="profile-legal" className="t-label">
              Terms and privacy
            </h2>
            <div className="policy-links" style={{ justifyContent: 'flex-start' }}>
              {PUBLISHED_DOCUMENTS.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="btn-text"
                  onClick={() => onOpenPolicy(d.id)}
                >
                  {d.title}
                </button>
              ))}
            </div>
            <p className="t-meta">{acceptanceLine(user.policies)}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
