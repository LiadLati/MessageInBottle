import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from '../api/client.js';
import { focusableIn } from '../lib/focusTrap.js';
import { restoreFocus, useModalKeys } from '../lib/modal.js';
import { SupportLink } from './SupportLink.js';

// Settings → Delete account. Deletion is permanent, so it asks for the password again (a
// borrowed session is not enough) and for an explicit confirmation, and it says plainly what
// goes and what may remain. The server does the work in one transaction; this dialog only
// collects the two things it will not act without.
export function DeleteAccountDialog({
  onCancel,
  onDeleted,
}: {
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const ids = { p: useId() };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The portal root is the layer that holds this dialog, not the dialog itself; marking it
    // inert would make the dialog unreachable to both pointer and keyboard.
    const layer = dialogRef.current?.parentElement;
    const siblings = [...document.body.children].filter((el) => el !== layer);
    for (const el of siblings) el.setAttribute('inert', '');
    (focusableIn(dialogRef.current!)[0] ?? dialogRef.current)?.focus();
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
      restoreFocus(previous);
    };
  }, []);

  const submit = async () => {
    if (!password || !confirmed || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.deleteAccount(password);
      onDeleted();
    } catch (err) {
      setFailure(
        err instanceof ApiError && err.code === 'invalid_password'
          ? 'That password is not correct.'
          : err instanceof ApiError && err.code === 'rate_limited'
            ? 'Too many attempts. Wait a few minutes and try again.'
            : 'Could not delete the account. Check your connection and try again.',
      );
      setBusy(false);
    }
  };

  useModalKeys(dialogRef, busy ? null : onCancel);

  return createPortal(
    <div className="confirm-layer">
      <div className="confirm-backdrop" onClick={busy ? undefined : onCancel} aria-hidden />
      <div
        ref={dialogRef}
        className="glass-panel confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="t-card-title">
          Delete your account
        </h2>
        <p className="secondary">
          This is permanent and cannot be undone. Every session ends at once. Your profile, email,
          password, preferences, notifications, friendships, blocks and drafts are removed, the
          letters you received are removed, and the text of every letter you wrote is erased —
          letters still at sea are cancelled.
        </p>
        <p className="t-meta">
          Letters other people wrote to you stay in their own Sent history, addressed to “Deleted
          user”. Only a minimal record that the account existed is kept, plus report evidence for
          the rest of its 30-day retention period or while a legal or child-safety hold requires it.
        </p>
        <div className="field">
          <label className="t-label" htmlFor={ids.p}>
            Confirm your password
          </label>
          <input
            id={ids.p}
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>I understand that deleting my account is permanent and cannot be undone.</span>
        </label>
        {failure ? (
          <p className="note error" role="alert">
            {failure}
          </p>
        ) : null}
        <p className="t-meta">
          Not sure? <SupportLink label="Ask Help & Support first" className="link-inline" />
        </p>
        <div className="confirm-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
            Keep my account
          </button>
          <button
            type="button"
            className="btn-destructive"
            disabled={busy || !password || !confirmed}
            onClick={() => void submit()}
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
