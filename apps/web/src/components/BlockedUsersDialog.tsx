import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BlockedUsersResponse } from '@mib/shared';
import { api } from '../api/client.js';
import { focusableIn } from '../lib/focusTrap.js';
import { restoreFocus, useModalKeys } from '../lib/modal.js';
import { formatDate } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { Avatar, ErrorNote, Skeleton } from './ui.js';

type Blocked = BlockedUsersResponse['blocked'][number];

// Settings → Blocked users (product decision 10). Only the people this account blocked are
// listed, never who blocked it. Unblocking asks first, in the same dialog, and says exactly
// what it restores (a friendship the block only hid) and what it does not (any letter).
export function BlockedUsersDialog({ onClose }: { onClose: () => void }) {
  const list = useAsync(() => api.blockedUsers(), []);
  const [confirming, setConfirming] = useState<Blocked | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const layer = dialogRef.current?.parentElement;
    const siblings = [...document.body.children].filter((el) => el !== layer);
    for (const el of siblings) el.setAttribute('inert', '');
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
      restoreFocus(previous);
    };
  }, []);
  useEffect(() => {
    (focusableIn(dialogRef.current!)[0] ?? dialogRef.current)?.focus();
  }, [confirming]);
  // Escape steps back from the confirmation first, then closes.
  useModalKeys(dialogRef, busy ? null : confirming ? () => setConfirming(null) : onClose);

  const unblock = async (who: Blocked) => {
    setBusy(true);
    setError(null);
    try {
      await (who.username
        ? api.unblockUser(who.username)
        : api.unblockFoundWriter(who.foundBottleId!));
      setConfirming(null);
      setDone(`${who.displayName} unblocked`);
      await list.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const blocked = list.data?.blocked ?? [];
  return createPortal(
    <div className="confirm-layer">
      <div className="confirm-backdrop" onClick={busy ? undefined : onClose} aria-hidden />
      <div
        ref={dialogRef}
        className="glass-panel confirm-dialog stack"
        role={confirming ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={confirming ? bodyId : undefined}
        tabIndex={-1}
      >
        {confirming ? (
          <>
            <h2 id={titleId} className="t-display-sm">
              Unblock {confirming.displayName}?
            </h2>
            <div id={bodyId} className="stack">
              <p className="secondary">
                You and {confirming.displayName} will be able to interact again, including finding
                each other’s bottles in the public ocean.
              </p>
              <p className="secondary">
                If you were friends before the block, you are friends again and can write to each
                other. Unblocking does not bring any letter back: letters that were removed,
                cancelled or hidden stay that way. Nothing that happened while the block was in
                place is shown.
              </p>
            </div>
            <ErrorNote error={error} />
            <div className="confirm-actions">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => void unblock(confirming)}
              >
                {busy ? '…' : 'Unblock'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="row between">
              <h2 id={titleId} className="t-display-sm">
                Blocked users
              </h2>
              <button type="button" className="btn-ghost" onClick={onClose}>
                Close
              </button>
            </div>
            {done ? (
              <p className="note" role="status">
                {done}
              </p>
            ) : null}
            {list.loading && !list.data ? (
              <Skeleton />
            ) : blocked.length === 0 ? (
              <p className="secondary">You have not blocked anyone.</p>
            ) : (
              <ul className="list" aria-label="Blocked users">
                {blocked.map((b) => (
                  <li key={b.username ?? `found:${b.foundBottleId}`} className="row-item">
                    <Avatar name={b.displayName} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="t-card-title" style={{ display: 'block' }}>
                        {b.displayName}
                      </span>
                      <span className="t-meta">
                        {b.username ? `@${b.username} · ` : ''}blocked {formatDate(b.blockedAt)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn-secondary"
                      aria-label={`Unblock ${b.displayName}`}
                      onClick={() => {
                        setDone(null);
                        setError(null);
                        setConfirming(b);
                      }}
                    >
                      Unblock
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <ErrorNote error={list.error} />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
