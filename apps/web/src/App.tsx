import { useCallback, useEffect, useRef, useState } from 'react';
import { PUBLISHED_DOCUMENTS, type DocumentId, type SentBottleDto } from '@mib/shared';
import { api } from './api/client.js';
import { Nav, type Tab } from './components/Nav.js';
import { DeleteAccountDialog } from './components/DeleteAccountDialog.js';
import { PolicyDialog } from './components/PolicyDialog.js';
import { ProfileSheet } from './components/ProfileSheet.js';
import { useAsync } from './lib/useAsync.js';
import { useTopSlot } from './lib/useTopSlot.js';
import { WarningAlert } from './components/WarningAlert.js';
import { AdminScreen, type AdminSection } from './screens/AdminScreen.js';
import { StandingScreen } from './screens/StandingScreen.js';
import { DevPanel } from './screens/DevPanel.js';
import { FriendsScreen } from './screens/FriendsScreen.js';
import { LettersScreen } from './screens/LettersScreen.js';
import { LoginScreen } from './screens/LoginScreen.js';
import { MyShoreScreen } from './screens/MyShoreScreen.js';
import { NotificationsScreen } from './screens/NotificationsScreen.js';
import { OceanScreen } from './screens/OceanScreen.js';
import { PolicyUpdateScreen } from './screens/PolicyUpdateScreen.js';
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

// A link such as /#privacy opens that document on load, signed in or not, so support replies
// and the documents themselves can point at one another.
function readPolicyHash(): DocumentId | null {
  try {
    const h = window.location.hash.replace(/^#/, '');
    return PUBLISHED_DOCUMENTS.some((d) => d.id === h) ? (h as DocumentId) : null;
  } catch {
    return null;
  }
}

function Shell() {
  const { user, loading, logout } = useSession();
  // The document dialog is owned here so it can open over the sign-in screen, over the app,
  // and over the "updated terms" screen alike.
  const [policyDoc, setPolicyDoc] = useState<DocumentId | null>(readPolicyHash);
  const openPolicy = useCallback((doc: DocumentId) => setPolicyDoc(doc), []);
  const closePolicy = useCallback(() => {
    setPolicyDoc(null);
    if (readPolicyHash()) window.history.replaceState({}, '', window.location.pathname);
  }, []);
  // A hash typed or followed while the app is already open opens the document too.
  useEffect(() => {
    const onHash = () => {
      const doc = readPolicyHash();
      if (doc) setPolicyDoc(doc);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const policyDialog = policyDoc ? (
    <PolicyDialog initial={policyDoc} onClose={closePolicy} />
  ) : null;
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
  const [deletingAccount, setDeletingAccount] = useState(false);
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
  // The My Shore badge means one thing: a bottle is waiting there for this user to open. It is
  // the shore's own sealed count, so a notification about a bottle this user *sent* (lost, sunk,
  // arrived elsewhere) can never light it, and nothing has to be visited to clear it.
  const shore = useAsync(
    () => (user ? api.myShore() : Promise.resolve(null)),
    [user?.id, epoch],
    20_000,
  );
  const sealedAtShore = (shore.data?.bottles ?? []).filter((b) => b.state === 'delivered').length;
  const reloadShore = shore.reload;
  const [inboxOpen, setInboxOpen] = useState(false);
  // Friend-request badge: the server's count of pending requests addressed to this user.
  const friends = useAsync(
    () => (user ? api.friends() : Promise.resolve(null)),
    [user?.id, epoch],
    20_000,
  );
  const pendingFriends = friends.data?.pendingIncomingCount ?? 0;
  const reloadFriends = friends.reload;
  // Account standing (spec §16): polled like the inbox, so a suspension or ban decided while
  // the app is open takes hold within a poll; a first violation's warning is shown on entry.
  const standing = useAsync(
    () => (user ? api.standing() : Promise.resolve(null)),
    [user?.id, epoch],
    20_000,
  );
  const reloadStanding = standing.reload;
  const [standingOpen, setStandingOpen] = useState(false);
  const [warningDismissed, setWarningDismissed] = useState<string | null>(null);
  const [admin, setAdmin] = useState<AdminSection | null>(null);

  // Visiting My Shore refreshes its count (a bottle opened there clears the badge); it no
  // longer marks notifications read — that is the inbox's job.
  useEffect(() => {
    if (tab === 'shore') void reloadShore();
  }, [tab, reloadShore]);
  // Opening the inbox is what marks its notifications read; the count follows.
  const openInbox = useCallback(() => {
    setInboxOpen(true);
    if (unread.length > 0) void api.markNotificationsRead().then(() => reloadNotifications());
  }, [unread.length, reloadNotifications]);
  const closeInbox = useCallback(() => setInboxOpen(false), []);

  const openProfile = useCallback(() => setProfileOpen(true), []);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  const chooseShore = useCallback(() => {
    setProfileOpen(false);
    setChoosingShore(true);
  }, []);

  if (resetToken) {
    return (
      <>
        <LoginScreen
          resetToken={resetToken}
          onResetDone={() => setResetToken(null)}
          onOpenPolicy={openPolicy}
        />
        {policyDialog}
      </>
    );
  }
  if (loading) return <main className="deck-screen" aria-busy />;
  if (!user)
    return (
      <>
        <LoginScreen onOpenPolicy={openPolicy} />
        {policyDialog}
      </>
    );
  // A released version this account has not accepted: nothing else until it has, or signs out.
  if (user.policies.required)
    return (
      <>
        <PolicyUpdateScreen onOpen={openPolicy} />
        {policyDialog}
      </>
    );

  const restricted =
    standing.data?.standing === 'suspended' || standing.data?.standing === 'banned';
  // A suspended or banned account sees its standing, can appeal and can sign out — nothing else.
  if (restricted && standing.data) {
    return (
      <main className="app-viewport" data-daylight="night">
        <StandingScreen standing={standing.data} onChanged={reloadStanding} />
      </main>
    );
  }

  const shoreName = chart.data?.shores.find((s) => s.id === user.shoreId)?.name ?? null;
  const pendingWarning =
    standing.data?.pendingWarning && standing.data.pendingWarning.id !== warningDismissed
      ? standing.data.pendingWarning
      : null;

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

  // The top strip stays an *arrival* banner: only an unread "a bottle arrived for you" event,
  // which is the one notification that leads somewhere (My Shore, where the bottle is).
  const arrivals = unread.filter((n) => n.kind === 'received_arrived');
  const on3d = tab === 'shore' && !inboxOpen;
  // The daylight palette belongs to the Ocean surface; every other screen keeps the night
  // chrome it was designed with.
  const daylight = tab === 'ocean' ? phase : 'night';
  return (
    <main className={`app-viewport${immersive ? ' immersive' : ''}`} data-daylight={daylight}>
      {arrivals.length > 0 && tab !== 'shore' && !immersive && !inboxOpen ? (
        <ArrivalBanner
          message={arrivals[0]!.message}
          more={arrivals.length - 1}
          onClick={() => leaveOceanTo('shore')}
        />
      ) : null}
      <div key={epoch}>
        {admin && user.role === 'admin' ? (
          <AdminScreen section={admin} onSection={setAdmin} onBack={() => setAdmin(null)} />
        ) : standingOpen && standing.data ? (
          <StandingScreen
            standing={standing.data}
            onChanged={reloadStanding}
            onBack={() => setStandingOpen(false)}
          />
        ) : null}
        {inboxOpen && !admin && !standingOpen ? (
          <NotificationsScreen
            notifications={notifications.data?.notifications ?? null}
            loading={notifications.loading && !notifications.data}
            error={notifications.error}
            onBack={closeInbox}
          />
        ) : null}
        {tab === 'ocean' && !inboxOpen && !admin && !standingOpen ? (
          <OceanScreen
            focusId={focusId}
            focusPublicId={focusPublicId}
            leaveRef={oceanLeave}
            unread={unread.length}
            onOpenInbox={openInbox}
            onOpenAdmin={user.role === 'admin' ? (section) => setAdmin(section) : undefined}
            onWrite={() => leaveOceanTo('write')}
            onOpenProfile={openProfile}
            onOpenPassport={(id) => {
              setPassportId(id);
              leaveOceanTo('letters');
            }}
          />
        ) : null}
        {tab === 'write' && !inboxOpen && !admin && !standingOpen ? (
          <WriteScreen
            onReleased={onReleased}
            onChooseShore={chooseShore}
            onImmersive={setImmersive}
          />
        ) : null}
        {tab === 'shore' && !inboxOpen && !admin && !standingOpen ? (
          <MyShoreScreen onOpenProfile={openProfile} onChooseShore={chooseShore} />
        ) : null}
        {tab === 'letters' && !inboxOpen && !admin && !standingOpen ? (
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
        {tab === 'friends' && !inboxOpen && !admin && !standingOpen ? (
          <FriendsScreen onChanged={reloadFriends} />
        ) : null}
      </div>
      {immersive ? null : <DevPanel refreshKey={epoch} onChanged={() => setEpoch((e) => e + 1)} />}
      {profileOpen ? (
        <ProfileSheet
          shoreName={shoreName}
          onChangeShore={chooseShore}
          onOpenPolicy={openPolicy}
          onDeleteAccount={() => {
            setProfileOpen(false);
            setDeletingAccount(true);
          }}
          onStanding={() => {
            setProfileOpen(false);
            setStandingOpen(true);
          }}
          onClose={closeProfile}
        />
      ) : null}
      {pendingWarning && !immersive ? (
        <WarningAlert
          warning={pendingWarning}
          onAcknowledged={() => {
            setWarningDismissed(pendingWarning.id);
            void reloadStanding();
          }}
          onAppeal={() => {
            setWarningDismissed(pendingWarning.id);
            void api.acknowledgeWarning(pendingWarning.id).catch(() => {});
            setStandingOpen(true);
            void reloadStanding();
          }}
        />
      ) : null}
      {deletingAccount ? (
        <DeleteAccountDialog
          onCancel={() => setDeletingAccount(false)}
          onDeleted={() => {
            setDeletingAccount(false);
            // The account is gone and its session with it: drop the token and show sign-in.
            void logout();
          }}
        />
      ) : null}
      {policyDialog}
      {immersive ? null : (
        <Nav
          active={tab}
          on3d={on3d}
          unread={sealedAtShore}
          pendingFriends={pendingFriends}
          onSelect={(t) => {
            setInboxOpen(false);
            setAdmin(null);
            setStandingOpen(false);
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
