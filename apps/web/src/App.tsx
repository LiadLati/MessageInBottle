import { useEffect, useState } from 'react';
import type { SentBottleDto } from '@mib/shared';
import { api } from './api/client.js';
import { useAsync } from './lib/useAsync.js';
import { DevPanel } from './screens/DevPanel.js';
import { FriendsScreen } from './screens/FriendsScreen.js';
import { LettersScreen } from './screens/LettersScreen.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { MyShoreScreen } from './screens/MyShoreScreen.js';
import { OceanScreen } from './screens/OceanScreen.js';
import { ShoreSetupScreen } from './screens/ShoreSetupScreen.js';
import { WriteScreen } from './screens/WriteScreen.js';
import { SessionProvider, useSession } from './state/session.js';

type Tab = 'ocean' | 'write' | 'shore' | 'letters' | 'friends';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'ocean', label: 'Ocean' },
  { id: 'write', label: 'Write' },
  { id: 'shore', label: 'My Shore' },
  { id: 'letters', label: 'Letters' },
  { id: 'friends', label: 'Friends' },
];

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { user, loading, logout } = useSession();
  const [tab, setTab] = useState<Tab>('ocean');
  const [passportId, setPassportId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const notifications = useAsync(
    () => (user ? api.notifications() : Promise.resolve({ notifications: [] })),
    [user?.id, epoch],
    20_000,
  );
  const unread = (notifications.data?.notifications ?? []).filter((n) => n.readAt === null);

  useEffect(() => {
    if (tab === 'shore' && unread.length > 0)
      void api.markNotificationsRead().then(() => notifications.reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, unread.length]);

  if (loading) return <main className="app-shell">Loading…</main>;
  if (!user) return <LoginScreen />;
  if (!user.shoreId) {
    return (
      <main className="app-shell">
        <ShoreSetupScreen />
        <SessionBar onLogout={logout} />
      </main>
    );
  }

  const onReleased = (bottle: SentBottleDto) => {
    setFocusId(bottle.id);
    setEpoch((e) => e + 1);
    setTab('ocean');
  };

  return (
    <main className="app-shell">
      {unread.length > 0 && tab !== 'shore' ? (
        <button className="banner" onClick={() => setTab('shore')}>
          {unread[0]!.message} {unread.length > 1 ? `(+${unread.length - 1} more)` : ''}
        </button>
      ) : null}
      <div className="screen-host" key={epoch}>
        {tab === 'ocean' ? (
          <OceanScreen
            focusId={focusId}
            onOpenPassport={(id) => {
              setPassportId(id);
              setTab('letters');
            }}
          />
        ) : null}
        {tab === 'write' ? <WriteScreen onReleased={onReleased} /> : null}
        {tab === 'shore' ? <MyShoreScreen /> : null}
        {tab === 'letters' ? (
          <LettersScreen
            passportId={passportId}
            onSelect={setPassportId}
            onBack={() => setPassportId(null)}
          />
        ) : null}
        {tab === 'friends' ? <FriendsScreen /> : null}
      </div>
      <DevPanel refreshKey={epoch} onChanged={() => setEpoch((e) => e + 1)} />
      <SessionBar onLogout={logout} />
      <nav className="bottom-nav" aria-label="Main">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => {
              if (t.id === 'letters') setPassportId(null);
              setTab(t.id);
            }}
          >
            {t.label}
            {t.id === 'shore' && unread.length > 0 ? (
              <span className="badge" aria-label={`${unread.length} unread`}>
                {unread.length}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
    </main>
  );
}

function SessionBar({ onLogout }: { onLogout: () => Promise<void> }) {
  const { user } = useSession();
  return (
    <div className="session-bar muted small">
      Signed in as <strong>{user?.displayName}</strong> (@{user?.username})
      <button className="link" onClick={() => void onLogout()}>
        Sign out
      </button>
    </div>
  );
}
