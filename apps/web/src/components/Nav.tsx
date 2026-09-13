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
  onSelect: (tab: Tab) => void;
}

// Bottom nav on phones (Write is the raised pill), left rail from 900px up.
export function Nav({ active, on3d = false, unread = 0, onSelect }: Props) {
  return (
    <nav className={`nav${on3d ? ' on-3d' : ''}`} aria-label="Main">
      {ITEMS.map((item) => {
        const current = item.id === active;
        if (item.id === 'write') {
          return (
            <button
              key={item.id}
              type="button"
              className="nav-item write"
              aria-current={current ? 'page' : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span className="write-pill">
                <Icon name="write" size={20} />
              </span>
              <span>{item.label}</span>
            </button>
          );
        }
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
            {item.id === 'shore' && unread > 0 ? (
              <span className="nav-badge" aria-label={`${unread} unread`}>
                {unread}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
