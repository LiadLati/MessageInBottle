import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { focusableIn } from '../lib/focusTrap.js';
import { restoreFocus, useModalKeys } from '../lib/modal.js';

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  // A short "why" recorded with the decision. Shown as a field when a label is given.
  reasonLabel?: string;
  // The reason is mandatory: the confirm button stays disabled until something is typed. Used
  // where the server also requires one, so the UI cannot offer an action the API will refuse.
  requireReason?: boolean;
  // An extra sentence the person must tick before confirming. For actions whose consequence is
  // immediate and permanent, where a single button is not enough of a pause.
  acknowledge?: string;
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
  requireReason = false,
  acknowledge,
  destructive = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: Props) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = (requireReason && reason.trim().length === 0) || (!!acknowledge && !acknowledged);
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
      restoreFocus(previous);
    };
  }, []);

  useModalKeys(dialogRef, busy ? null : onCancel);

  return createPortal(
    <div className="confirm-layer">
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
        {acknowledge ? (
          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              disabled={busy}
            />
            <span className="secondary">{acknowledge}</span>
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
            disabled={busy || blocked}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
