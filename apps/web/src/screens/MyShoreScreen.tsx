import { useState } from 'react';
import type { OpenedLetterDto, ShoreBottleDto } from '@mib/shared';
import { api } from '../api/client.js';
import { ShoreScene } from '../components/lazy.js';
import { LetterModal } from '../components/LetterModal.js';
import { Avatar, ErrorNote, Skeleton } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { formatDayTime, formatDuration } from '../lib/format.js';
import { featuredBottle, sealedOnly, waitingBottles } from '../lib/shoreQueue.js';
import { shoreWeatherAt } from '../lib/shoreWeather.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';
import { useWeather } from '../state/weather.js';

const POLL_MS = 15_000;

interface Props {
  onOpenProfile: () => void;
  onChooseShore: () => void;
}

// S2 · My Shore — real-time 3D coast. Only bottles the server has landed and that are still
// sealed are shown; opening one moves it to Letters → Received and features the next sealed
// bottle. Tapping a waiting bottle only swaps it into the featured card; the letter is opened
// solely by "Pick it up".
export function MyShoreScreen({ onOpenProfile, onChooseShore }: Props) {
  const { user } = useSession();
  const { nowMs, shoreStormOverride } = useWeather();
  const shore = useAsync(() => api.myShore(), [], POLL_MS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opened, setOpened] = useState<OpenedLetterDto | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  // Further arrivals stay folded so the sheet never grows over the featured bottle (C2 framing).
  const [showMore, setShowMore] = useState(false);

  // My Shore keeps its own weather, on its own schedule, keyed on the user — so it never
  // mirrors an ocean storm. It is cosmetic: it changes sky, light, rain, waves, foam and
  // wetness, and nothing else. It never blocks a release, adds delay, alters a route or
  // increases any risk.
  const weather = shoreWeatherAt(user?.id ?? null, nowMs, shoreStormOverride);
  const sealed = sealedOnly(shore.data?.bottles ?? []);
  const featured = featuredBottle(sealed, selectedId);
  const waiting = waitingBottles(sealed, featured);

  const pickUp = async (b: ShoreBottleDto) => {
    setError(null);
    setBusy(true);
    try {
      const letter = await api.openBottle(b.id);
      setOpened(letter);
      // The bottle has left the shore; the next sealed one (if any) becomes featured.
      setSelectedId(null);
      await shore.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  if (!user?.shoreId) {
    return (
      <div className="world-screen">
        <div className="world-layer">
          <ShoreScene mode="shore" showBottle={false} weather={weather} />
        </div>
        <div className="scrim scrim-3d" />
        <header className="world-header on-3d">
          <div>
            <h1 className="t-title">My Shore</h1>
            <p className="t-meta">No anchor yet</p>
          </div>
        </header>
        <section className="sheet on-3d stack">
          <h2 className="t-display-sm">Choose a shore to anchor to</h2>
          <button type="button" className="btn-primary on-3d" onClick={onChooseShore}>
            Choose a shore
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="world-screen two-pane">
      <div className="world-layer">
        <ShoreScene mode="shore" showBottle={Boolean(featured)} weather={weather} />
      </div>
      <div className="scrim scrim-3d" />
      <header className="world-header on-3d">
        <div>
          <h1 className="t-title">My Shore</h1>
          <p className="t-meta">
            {shore.data?.shore?.name ?? '…'} · {weather === 'storm' ? 'storm · high water' : 'dusk'}
            {sealed.length > 0 ? ` · ${sealed.length} sealed` : ''}
          </p>
        </div>
        <button
          type="button"
          className="avatar glass"
          aria-label="Your account"
          onClick={onOpenProfile}
        >
          {user.displayName.charAt(0).toUpperCase()}
        </button>
      </header>
      {weather === 'storm' ? (
        <aside className="weather-advisory shore" aria-label="Weather">
          <span className="pulse" aria-hidden />
          {/* Cosmetic weather, stated honestly. The prototype's "anything at sea will take
              longer to arrive" is deliberately not used: it would be untrue. */}
          <span className="body">
            Rough water on your shore. The weather here is scenery — it never delays a bottle or
            changes where one is going.
          </span>
        </aside>
      ) : null}
      <section className="sheet on-3d" aria-label="Arrivals">
        {shore.loading && !shore.data ? (
          <Skeleton />
        ) : !featured ? (
          <div className="stack">
            <h2 className="t-display-sm">The tide has brought nothing yet</h2>
            <p className="t-meta" style={{ fontSize: 12.5 }}>
              Bottles appear here only once they have truly landed. Nothing on the way is ever
              shown. Letters you have opened wait under Letters → Received.
            </p>
          </div>
        ) : (
          <div>
            <div className="row" data-testid="featured-bottle" data-bottle-id={featured.id}>
              <Avatar name={featured.sender.displayName} size="md" />
              <div className="grow">
                <div className="t-card-title" style={{ color: 'var(--foam-white-3d)' }}>
                  A bottle from {featured.sender.displayName}
                </div>
                <div className="t-meta" style={{ color: 'rgba(247,250,249,.7)' }}>
                  Landed {formatDayTime(featured.deliveredAt)} · sealed{' '}
                  {formatDuration(featured.journeyDurationMs)}
                </div>
              </div>
            </div>
            <button
              type="button"
              className="btn-primary on-3d"
              style={{ marginTop: 14 }}
              disabled={busy}
              onClick={() => void pickUp(featured)}
            >
              <Icon name="bottle" size={18} />
              Pick it up
            </button>
            <p
              className="t-meta"
              style={{ textAlign: 'center', marginTop: 10, color: 'rgba(247,250,249,.62)' }}
            >
              Opening ends its journey
            </p>
            {waiting.length > 0 ? (
              <button
                type="button"
                className="btn-text"
                style={{ marginTop: 12, width: '100%' }}
                aria-expanded={showMore}
                onClick={() => setShowMore((v) => !v)}
              >
                {waiting.length} more on your shore
                <Icon name="back" size={14} className={showMore ? 'rotate-up' : 'rotate-down'} />
              </button>
            ) : null}
            {waiting.length > 0 && showMore ? (
              <ul className="list" style={{ marginTop: 10 }} aria-label="More on your shore">
                {waiting.map((b) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      className="row-item selectable"
                      disabled={busy}
                      aria-label={`Feature the bottle from ${b.sender.displayName}`}
                      onClick={() => setSelectedId(b.id)}
                    >
                      <Avatar name={b.sender.displayName} />
                      <span className="grow">
                        <span className="t-label" style={{ display: 'block' }}>
                          Sealed bottle from {b.sender.displayName}
                        </span>
                        <span className="t-meta">Landed {formatDayTime(b.deliveredAt)}</span>
                      </span>
                      <span className="t-meta">Feature</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <ErrorNote error={error ?? shore.error} />
      </section>
      {opened ? (
        <LetterModal
          letter={opened}
          justOpened
          reportable
          onHidden={() => void shore.reload()}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}
