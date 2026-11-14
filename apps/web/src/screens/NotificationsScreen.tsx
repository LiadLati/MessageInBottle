import { useState } from 'react';
import type { NotificationDto, NotificationKind } from '@mib/shared';
import { api } from '../api/client.js';
import { BackButton, DeckScreen, ErrorNote, Skeleton } from '../components/ui.js';
import { Icon, type IconName } from '../design/Icon.js';
import { formatDate } from '../lib/format.js';

interface Props {
  notifications: NotificationDto[] | null;
  // Cursor for the page after `notifications`; null when that page is the whole history.
  nextCursor: string | null;
  loading: boolean;
  error: Error | null;
  onBack: () => void;
}

// One icon per event, with a colour that matches the same event on the map: the golden pennant
// of a drifting bottle, the red X of a sunk one, an anchor with a check for a delivery, a bottle
// coming in for an arrival at your own shore.
const KIND_ICON: Record<NotificationKind, { icon: IconName; tone: string; label: string }> = {
  sent_adrift: { icon: 'pennant', tone: 'gold', label: 'Adrift in the public ocean' },
  sent_sunk: { icon: 'sunkX', tone: 'red', label: 'Sank at sea' },
  sent_arrived: { icon: 'anchorCheck', tone: 'green', label: 'Reached its destination' },
  received_arrived: { icon: 'bottleIn', tone: 'foam', label: 'A bottle arrived at your shore' },
  sent_found: { icon: 'letters', tone: 'gold', label: 'Read by a finder' },
  sent_expired: { icon: 'clock', tone: 'muted', label: 'Removed from the public map' },
  sent_cancelled: { icon: 'lost', tone: 'muted', label: 'Delivery unavailable' },
  shore_full: { icon: 'info', tone: 'gold', label: 'Your shore is full' },
  moderation_violation: {
    icon: 'report',
    tone: 'gold',
    label: 'A letter was removed after a report',
  },
  moderation_suspended: { icon: 'report', tone: 'red', label: 'Account suspended' },
  moderation_banned: { icon: 'report', tone: 'red', label: 'Account banned' },
  moderation_appeal_accepted: { icon: 'check', tone: 'green', label: 'Appeal accepted' },
  moderation_appeal_rejected: { icon: 'close', tone: 'muted', label: 'Appeal rejected' },
  other: { icon: 'info', tone: 'muted', label: 'Notice' },
};

// S · Notifications inbox. Rows are information only: nothing here opens a bottle, moves to
// another screen, or touches a map marker — reading about a sunk bottle is not seeing it.
// The history is kept for the life of the account (product decision 6) and read in pages:
// the first comes with the badge poll, older ones on request.
export function NotificationsScreen({ notifications, nextCursor, loading, error, onBack }: Props) {
  const [older, setOlder] = useState<NotificationDto[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<Error | null>(null);
  // Entries that slid off the polled first page after an older page was loaded (audit
  // FE-R-009). New notices push the oldest entries of the first page out of it, and they sit
  // between the new first page and the older pages already loaded, so without this they would
  // vanish from the list until it was reopened.
  const [kept, setKept] = useState<NotificationDto[]>([]);
  const [shownFirst, setShownFirst] = useState<NotificationDto[] | null>(notifications);
  // Adjusted while rendering, React's pattern for state derived from a changing prop.
  if (notifications !== shownFirst) {
    if (older.length > 0 && shownFirst) {
      const now = new Set((notifications ?? []).map((n) => n.id));
      const slid = shownFirst.filter((n) => !now.has(n.id));
      if (slid.length) setKept((prev) => mergeById(slid, prev));
    }
    setShownFirst(notifications);
  }
  // Until an older page is loaded, paging continues from the polled first page.
  const cursor = older.length === 0 ? nextCursor : olderCursor;
  const list = mergeById(notifications ?? [], mergeById(kept, older));
  const loadOlder = () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    api
      .notifications(cursor)
      .then((page) => {
        setOlder((prev) => [...prev, ...page.notifications]);
        setOlderCursor(page.nextCursor);
      })
      .catch((e: unknown) => setOlderError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setLoadingOlder(false));
  };
  return (
    <DeckScreen
      title="Notifications"
      subtitle="What the sea has done with your bottles"
      actions={<BackButton onClick={onBack} />}
    >
      <div className="stack" aria-live="polite">
        {loading ? (
          <Skeleton />
        ) : error && list.length === 0 ? (
          <ErrorNote error={error} />
        ) : list.length === 0 ? (
          <div className="glass-panel stack">
            <h2 className="t-display-sm">Nothing yet</h2>
            <p className="secondary">
              When a bottle you sent reaches its shore, is lost, or one arrives for you, it is noted
              here.
            </p>
          </div>
        ) : (
          <ol className="list inbox-list" aria-label="Notifications, newest first">
            {list.map((n) => {
              const k = KIND_ICON[n.kind] ?? KIND_ICON.other;
              return (
                <li
                  key={n.id}
                  className={`row-item inbox-row${n.readAt === null ? ' unread' : ''}`}
                >
                  <span className={`inbox-icon tone-${k.tone}`} role="img" aria-label={k.label}>
                    <Icon name={k.icon} size={18} />
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    {/* The unread dot is visual only; say it too (FE-R-009). */}
                    {n.readAt === null ? <span className="sr-only">Unread. </span> : null}
                    <span className="inbox-text">{n.message}</span>
                    <time className="t-meta" dateTime={n.createdAt} style={{ display: 'block' }}>
                      {formatDate(n.createdAt)}
                    </time>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {error && list.length > 0 ? <ErrorNote error={error} /> : null}
        {!loading && cursor ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={loadOlder}
            disabled={loadingOlder}
            aria-busy={loadingOlder}
          >
            {loadingOlder ? 'Loading…' : 'Load older notifications'}
          </button>
        ) : null}
        {olderError ? <ErrorNote error={olderError} /> : null}
      </div>
    </DeckScreen>
  );
}

// The first list's entries in its order, then the second's that are not already shown.
function mergeById(first: NotificationDto[], rest: NotificationDto[]): NotificationDto[] {
  const seen = new Set(first.map((n) => n.id));
  return [...first, ...rest.filter((n) => !seen.has(n.id))];
}
