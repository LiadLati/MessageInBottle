import { useCallback, useEffect, useState } from 'react';
import type { SentBottleDto } from '@mib/shared';
import { api } from './api/client.js';
import { Nav, type Tab } from './components/Nav.js';
import { ProfileSheet } from './components/ProfileSheet.js';
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

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { user, loading } = useSession();
  const [tab, setTab] = useState<Tab>('ocean');
  const [passportId, setPassportId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [choosingShore, setChoosingShore] = useState(false);
  const chart = useAsync(() => (user ? api.chart() : Promise.resolve(null)), [user?.id]);
  const notifications = useAsync(
    () => (user ? api.notifications() : Promise.resolve({ notifications: [] })),
    [user?.id, epoch],
    20_000,
  );
  const unread = (notifications.data?.notifications ?? []).filter((n) => n.readAt === null);
  const reloadNotifications = notifications.reload;

  useEffect(() => {
    if (tab === 'shore' && unread.length > 0) {
      void api.markNotificationsRead().then(() => reloadNotifications());
    }
  }, [tab, unread.length, reloadNotifications]);

  const openProfile = useCallback(() => setProfileOpen(true), []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const chooseShore = useCallback(() => {
    setProfileOpen(false);
    setChoosingShore(true);
  }, []);

  if (loading) return <main className="deck-screen" aria-busy />;
  if (!user) return <LoginScreen />;

  const shoreName = chart.data?.shores.find((s) => s.id === user.shoreId)?.name ?? null;

  if (!user.shoreId || choosingShore) {
    return (
      <main className="app-viewport">
        <ShoreSetupScreen
          onDone={() => {
            setChoosingShore(false);
            setEpoch((e) => e + 1);
          }}
          onCancel={user.shoreId ? () => setChoosingShore(false) : undefined}
        />
      </main>
    );
  }

  const onReleased = (bottle: SentBottleDto) => {
    setFocusId(bottle.id);
    setEpoch((e) => e + 1);
    setTab('ocean');
  };

  const on3d = tab === 'shore';
  return (
    <main className="app-viewport">
      {unread.length > 0 && tab !== 'shore' ? (
        <button type="button" className="banner" onClick={() => setTab('shore')}>
          <span className="grow">{unread[0]!.message}</span>
          {unread.length > 1 ? <span className="t-meta">+{unread.length - 1}</span> : null}
        </button>
      ) : null}
      <div key={epoch}>
        {tab === 'ocean' ? (
          <OceanScreen
            focusId={focusId}
            onWrite={() => setTab('write')}
            onOpenProfile={openProfile}
            onOpenPassport={(id) => {
              setPassportId(id);
              setTab('letters');
            }}
          />
        ) : null}
        {tab === 'write' ? (
          <WriteScreen onReleased={onReleased} onChooseShore={chooseShore} />
        ) : null}
        {tab === 'shore' ? (
          <MyShoreScreen onOpenProfile={openProfile} onChooseShore={chooseShore} />
        ) : null}
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
      {profileOpen ? (
        <ProfileSheet shoreName={shoreName} onChangeShore={chooseShore} onClose={closeProfile} />
      ) : null}
      <Nav
        active={tab}
        on3d={on3d}
        unread={unread.length}
        onSelect={(t) => {
          if (t === 'letters') setPassportId(null);
          setTab(t);
        }}
      />
    </main>
  );
}
