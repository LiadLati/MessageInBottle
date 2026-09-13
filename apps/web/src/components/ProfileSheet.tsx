import { useEffect, useRef } from 'react';
import { useSession } from '../state/session.js';
import { Avatar } from './ui.js';
import { Icon } from '../design/Icon.js';

interface Props {
  shoreName: string | null;
  onChangeShore: () => void;
  onClose: () => void;
}

// The header avatar opens this instead of a permanent "signed in as" row (IA note on S1).
export function ProfileSheet({ shoreName, onChangeShore, onClose }: Props) {
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
          <button type="button" className="btn-text" onClick={() => void logout()}>
            Sign out
          </button>
          <p className="t-meta">
            A shore is only an anchor in the app. It says nothing about where you live.
          </p>
        </div>
      </div>
    </div>
  );
}
