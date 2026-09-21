import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { focusableIn, nextTabTarget } from '../lib/focusTrap.js';

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  // A short "why" recorded with the decision. Shown as a field when a label is given.
  reasonLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: Error | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

// An explicit confirmation before anything irreversible: a real dialog (focus trapped, Escape
// cancels, the page behind is inert), never a browser confirm(). Used for every admin decision.
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  reasonLabel,
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: Props) {
  const [reason, setReason] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = [...document.body.children].filter(
      (el) => el !== dialogRef.current?.parentElement,
    );
    for (const el of siblings) el.setAttribute('inert', '');
    const focusables = focusableIn(dialogRef.current!);
    (focusables[0] ?? dialogRef.current)?.focus();
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
      previous?.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onCancel();
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

  return createPortal(
    <div className="confirm-layer" onKeyDown={onKeyDown}>
      <div className="confirm-backdrop" onClick={busy ? undefined : onCancel} aria-hidden />
      <div
        ref={dialogRef}
        className="glass-panel confirm-dialog stack"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="t-display-sm">
          {title}
        </h2>
        <p id={bodyId} className="secondary">
          {body}
        </p>
        {reasonLabel ? (
          <label className="field">
            <span className="t-label">{reasonLabel}</span>
            <textarea
              className="input"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </label>
        ) : null}
        {error ? (
          <p className="note error" role="alert">
            {error.message}
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? 'btn-destructive' : 'btn-primary'}
            onClick={() => onConfirm(reason.trim())}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
