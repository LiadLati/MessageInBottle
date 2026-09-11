import { useCallback, useEffect, useState } from 'react';
import type { SentBottleDto } from '@mib/shared';
import { api } from './api/client.js';
import { Nav, type Tab } from './components/Nav.js';
import { ProfileSheet } from './components/ProfileSheet.js';
import { useAsync } from './lib/useAsync.js';
import { useTopSlot } from './lib/useTopSlot.js';
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
  // Immersive screens (preview & release, the release sequence, an opened letter) take the whole
  // viewport: no navigation, no system strips.
  const [immersive, setImmersive] = useState(false);
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
    <main className={`app-viewport${immersive ? ' immersive' : ''}`}>
      {unread.length > 0 && tab !== 'shore' && !immersive ? (
        <ArrivalBanner
          message={unread[0]!.message}
          more={unread.length - 1}
          onClick={() => setTab('shore')}
        />
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
          <WriteScreen
            onReleased={onReleased}
            onChooseShore={chooseShore}
            onImmersive={setImmersive}
          />
        ) : null}
        {tab === 'shore' ? (
          <MyShoreScreen
            onOpenProfile={openProfile}
            onChooseShore={chooseShore}
            onImmersive={setImmersive}
          />
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
      {immersive ? null : <DevPanel refreshKey={epoch} onChanged={() => setEpoch((e) => e + 1)} />}
      {profileOpen ? (
        <ProfileSheet shoreName={shoreName} onChangeShore={chooseShore} onClose={closeProfile} />
      ) : null}
      {immersive ? null : (
        <Nav
          active={tab}
          on3d={on3d}
          unread={unread.length}
          onSelect={(t) => {
            if (t === 'letters') setPassportId(null);
            setTab(t);
          }}
        />
      )}
    </main>
  );
}

// Arrival notice: a strip in the top stack, never a cover over the header beneath it.
function ArrivalBanner({
  message,
  more,
  onClick,
}: {
  message: string;
  more: number;
  onClick: () => void;
}) {
  const slot = useTopSlot('banner', 8);
  return (
    <button ref={slot} type="button" className="banner" onClick={onClick}>
      <span className="grow">{message}</span>
      {more > 0 ? <span className="t-meta">+{more}</span> : null}
    </button>
  );
}
