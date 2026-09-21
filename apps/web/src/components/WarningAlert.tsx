import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ViolationNoticeDto } from '@mib/shared';
import { api } from '../api/client.js';
import { REPORT_REASON_LABELS } from './ReportSheet.js';
import { formatDate } from '../lib/format.js';
import { focusableIn } from '../lib/focusTrap.js';

interface Props {
  warning: ViolationNoticeDto;
  onAcknowledged: () => void;
  onAppeal: () => void;
}

// The one-time warning after a first accepted violation (spec §16): shown on the next entry
// into the app, and again on every entry until it is acknowledged — then never again.
export function WarningAlert({ warning, onAcknowledged, onAppeal }: Props) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const siblings = [...document.body.children].filter((el) => el !== ref.current?.parentElement);
    for (const el of siblings) el.setAttribute('inert', '');
    (focusableIn(ref.current!)[0] ?? ref.current)?.focus();
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
    };
  }, []);
  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.acknowledgeWarning(warning.id);
    } catch {
      /* the next entry shows it again */
    }
    onAcknowledged();
  };
  return createPortal(
    <div className="confirm-layer">
      <div className="confirm-backdrop" aria-hidden />
      <div
        ref={ref}
        className="glass-panel confirm-dialog stack"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="t-display-sm">
          A warning about a letter you sent
        </h2>
        <p className="secondary">
          Your letter to {warning.bottle.recipientDisplayName}, released{' '}
          {formatDate(warning.bottle.releasedAt)}, was reported for{' '}
          <strong>{REPORT_REASON_LABELS[warning.category].toLowerCase()}</strong> and, after review,
          removed for breaking the community rules.
        </p>
        <p className="secondary">
          This is a warning. A second accepted violation suspends your account for seven days; a
          third bans it permanently. If you think this decision is wrong, you can appeal it once.
        </p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn-ghost" onClick={onAppeal} disabled={busy}>
            Appeal
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void acknowledge()}
            disabled={busy}
          >
            {busy ? '…' : 'I understand'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
