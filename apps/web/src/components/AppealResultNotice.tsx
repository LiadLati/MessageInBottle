import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NotificationDto } from '@mib/shared';
import { api } from '../api/client.js';
import { SupportLink } from './SupportLink.js';
import { formatDate } from '../lib/format.js';
import { focusableIn } from '../lib/focusTrap.js';
import { useModalKeys } from '../lib/modal.js';

interface Props {
  result: NotificationDto;
  // The popup was dismissed and the server told: reload what depends on it.
  onDismissed: () => Promise<void> | void;
}

// The result of an appeal, shown once when it first reaches its author (manual review round 1):
// on this visit or on the next sign-in, and also while the account is suspended or banned.
// It is the notification itself: dismissing it marks that one entry read, which is exactly what
// opening the inbox would do, and the entry stays in the history either way. If the dismissal
// does not reach the server, the popup is simply shown again next time.
export function AppealResultNotice({ result, onDismissed }: Props) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const accepted = result.kind === 'moderation_appeal_accepted';

  const dismiss = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.appealResultSeen(result.id);
    } catch {
      /* shown again on the next visit */
    }
    await onDismissed();
  };
  useModalKeys(ref, () => void dismiss());

  useEffect(() => {
    const siblings = [...document.body.children].filter((el) => el !== ref.current?.parentElement);
    for (const el of siblings) el.setAttribute('inert', '');
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
    };
  }, []);
  useEffect(() => {
    (focusableIn(ref.current!).at(-1) ?? ref.current)?.focus();
  }, [result.id]);

  return createPortal(
    <div className="confirm-layer">
      <div className="confirm-backdrop" aria-hidden />
      <div
        ref={ref}
        className="glass-panel confirm-dialog stack appeal-result"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
      >
        <h2 id={titleId} className="t-display-sm">
          {accepted ? 'Your appeal was accepted' : 'Your appeal was rejected'}
        </h2>
        <div id={bodyId} className="stack">
          <p className="secondary">{result.message}</p>
          <p className="t-meta">
            Decided <time dateTime={result.createdAt}>{formatDate(result.createdAt)}</time>. This
            stays in your notifications.
          </p>
        </div>
        <div className="row between" style={{ gap: 8, flexWrap: 'wrap' }}>
          <SupportLink className="btn-ghost" />
          <button
            type="button"
            className="btn-primary"
            onClick={() => void dismiss()}
            disabled={busy}
          >
            {busy ? '…' : 'OK'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
