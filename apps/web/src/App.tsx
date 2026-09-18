import { useCallback, useEffect, useRef, useState } from 'react';
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
import { WeatherProvider, useWeather } from './state/weather.js';

export function App() {
  return (
    <SessionProvider>
      <WeatherProvider>
        <Shell />
      </WeatherProvider>
    </SessionProvider>
  );
}

// A password-reset link opens the app with ?reset=<token>; the token lives only in the URL and
// is removed from it as soon as the screen has taken it.
function readResetToken(): string | null {
  try {
    const token = new URLSearchParams(window.location.search).get('reset');
    if (!token) return null;
    window.history.replaceState({}, '', window.location.pathname);
    return token;
  } catch {
    return null;
  }
}

function Shell() {
  const { user, loading } = useSession();
  const { phase } = useWeather();
  const [resetToken, setResetToken] = useState<string | null>(readResetToken);
  const [tab, setTab] = useState<Tab>('ocean');
  const [passportId, setPassportId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // Letters → Lost → "Show on public map": open Ocean in public mode on this bottle.
  const [focusPublicId, setFocusPublicId] = useState<string | null>(null);
  // Set by the Ocean screen: acknowledges the terminal markers seen on this private-map visit.
  // Called only on a real navigation to another application screen.
  const oceanLeave = useRef<(() => void) | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [profileOpen, setProfileOpen] = useState(false);
  const [choosingShore, setChoosingShore] = useState(false);
  // Immersive screens (preview & release, the release sequence) take the whole viewport: no
  // navigation, no system strips. An opened letter is a modal over the shore instead.
  const [immersive, setImmersive] = useState(false);
  const chart = useAsync(() => (user ? api.chart() : Promise.resolve(null)), [user?.id]);
  const notifications = useAsync(
    () => (user ? api.notifications() : Promise.resolve({ notifications: [] })),
    [user?.id, epoch],
    20_000,
  );
  const unread = (notifications.data?.notifications ?? []).filter((n) => n.readAt === null);
  const reloadNotifications = notifications.reload;
  // Friend-request badge: the server's count of pending requests addressed to this user.
  const friends = useAsync(
    () => (user ? api.friends() : Promise.resolve(null)),
    [user?.id, epoch],
    20_000,
  );
  const pendingFriends = friends.data?.pendingIncomingCount ?? 0;
  const reloadFriends = friends.reload;

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

  if (resetToken) {
    return <LoginScreen resetToken={resetToken} onResetDone={() => setResetToken(null)} />;
  }
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

  // Leaving the Ocean screen for another application screen: let the private map acknowledge
  // what was seen, then switch. Opening a card, the sea viewer or a refresh never comes here.
  const leaveOceanTo = (t: Tab) => {
    if (tab === 'ocean') {
      oceanLeave.current?.();
      setFocusPublicId(null);
      setFocusId(null);
    }
    setTab(t);
  };

  const onReleased = (bottle: SentBottleDto) => {
    setFocusId(bottle.id);
    setEpoch((e) => e + 1);
    setTab('ocean');
  };

  const on3d = tab === 'shore';
  // The daylight palette belongs to the Ocean surface; every other screen keeps the night
  // chrome it was designed with.
  const daylight = tab === 'ocean' ? phase : 'night';
  return (
    <main className={`app-viewport${immersive ? ' immersive' : ''}`} data-daylight={daylight}>
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
            focusPublicId={focusPublicId}
            leaveRef={oceanLeave}
            onWrite={() => leaveOceanTo('write')}
            onOpenProfile={openProfile}
            onOpenPassport={(id) => {
              setPassportId(id);
              leaveOceanTo('letters');
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
          <MyShoreScreen onOpenProfile={openProfile} onChooseShore={chooseShore} />
        ) : null}
        {tab === 'letters' ? (
          <LettersScreen
            passportId={passportId}
            onSelect={setPassportId}
            onBack={() => setPassportId(null)}
            onShowPublic={(id) => {
              setFocusPublicId(id);
              setFocusId(null);
              setTab('ocean');
            }}
          />
        ) : null}
        {tab === 'friends' ? <FriendsScreen onChanged={reloadFriends} /> : null}
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
          pendingFriends={pendingFriends}
          onSelect={(t) => {
            if (t === 'letters') setPassportId(null);
            if (t !== 'ocean') leaveOceanTo(t);
            else setTab(t);
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
