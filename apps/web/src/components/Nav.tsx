import { Icon, type IconName } from '../design/Icon.js';

export type Tab = 'ocean' | 'write' | 'shore' | 'letters' | 'friends';

const ITEMS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'ocean', label: 'Ocean', icon: 'ocean' },
  { id: 'write', label: 'Write', icon: 'write' },
  { id: 'shore', label: 'My Shore', icon: 'shore' },
  { id: 'letters', label: 'Letters', icon: 'letters' },
  { id: 'friends', label: 'Friends', icon: 'friends' },
];

interface Props {
  active: Tab;
  on3d?: boolean;
  unread?: number;
  // Pending incoming friend requests (server-authoritative count).
  pendingFriends?: number;
  onSelect: (tab: Tab) => void;
}

// Bottom bar on phones, left rail from 900px up. Every destination is drawn the same way and
// sits inside the bar's own height; the only difference between them is which one is current,
// so exactly one is ever highlighted — the screen you are on.
export function Nav({ active, on3d = false, unread = 0, pendingFriends = 0, onSelect }: Props) {
  return (
    <nav className={`nav${on3d ? ' on-3d' : ''}`} aria-label="Main">
      {ITEMS.map((item) => {
        const current = item.id === active;
        const count = item.id === 'shore' ? unread : item.id === 'friends' ? pendingFriends : 0;
        const countLabel =
          item.id === 'shore'
            ? `${count} unread`
            : `${count} pending friend ${count === 1 ? 'request' : 'requests'}`;
        return (
          <button
            key={item.id}
            type="button"
            className="nav-item"
            aria-current={current ? 'page' : undefined}
            onClick={() => onSelect(item.id)}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {count > 0 ? (
              <span className="nav-badge" aria-label={countLabel}>
                {count > 9 ? '9+' : count}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
