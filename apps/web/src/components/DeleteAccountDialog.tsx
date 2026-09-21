import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api } from '../api/client.js';
import { focusableIn, nextTabTarget } from '../lib/focusTrap.js';

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
      previous?.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const target = nextTabTarget(
      focusableIn(dialogRef.current),
      document.activeElement,
      e.shiftKey,
    );
    if (target) {
      e.preventDefault();
      target.focus();
    }
  };

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
          : 'Could not delete the account. Check your connection and try again.',
      );
      setBusy(false);
    }
  };

  return createPortal(
    <div className="confirm-layer" onKeyDown={onKeyDown}>
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
          This is permanent and cannot be undone. Every session ends at once, your profile,
          friendships and blocks are removed, and letters of yours still at sea are cancelled.
        </p>
        <p className="t-meta">
          Letters that already reached the person you sent them to stay with them, showing “Deleted
          account” as the sender. Evidence for an open report or an active restriction is kept for
          as long as that matter needs it.
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
