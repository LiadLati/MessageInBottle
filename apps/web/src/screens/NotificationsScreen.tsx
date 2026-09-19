import type { NotificationDto, NotificationKind } from '@mib/shared';
import { BackButton, DeckScreen, ErrorNote, Skeleton } from '../components/ui.js';
import { Icon, type IconName } from '../design/Icon.js';
import { formatDate } from '../lib/format.js';

interface Props {
  notifications: NotificationDto[] | null;
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
  sent_cancelled: { icon: 'lost', tone: 'muted', label: 'Delivery unavailable' },
  other: { icon: 'info', tone: 'muted', label: 'Notice' },
};

// S · Notifications inbox. Rows are information only: nothing here opens a bottle, moves to
// another screen, or touches a map marker — reading about a sunk bottle is not seeing it.
export function NotificationsScreen({ notifications, loading, error, onBack }: Props) {
  const list = notifications ?? [];
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
      </div>
    </DeckScreen>
  );
}
