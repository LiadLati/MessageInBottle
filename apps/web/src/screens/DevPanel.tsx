import { useState } from 'react';
import { api } from '../api/client.js';
import { ErrorNote } from '../components/ui.js';
import { formatDate } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useTopSlot } from '../lib/useTopSlot.js';
import { useWeather, type WeatherOverride } from '../state/weather.js';

// Development-only time-travel controls. They exist only in development builds
// (`import.meta.env.DEV`) and only while the API reports dev mode; production bundles never
// render them. The bar sits in the top stack so it pushes content down instead of covering it.
const DEV_CONTROLS_ENABLED: boolean = import.meta.env.DEV;

export function DevPanel(props: { onChanged: () => void; refreshKey: number }) {
  if (!DEV_CONTROLS_ENABLED) return null;
  return <DevPanelInner {...props} />;
}

function DevPanelInner({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const status = useAsync(() => api.devStatus(), [], 30_000);
  const sent = useAsync(() => api.sentBottles(), [refreshKey]);
  const outbox = useAsync(() => api.devOutbox(), [refreshKey], 15_000);
  const [error, setError] = useState<Error | null>(null);
  const [open, setOpen] = useState(false);
  const slot = useTopSlot('dev');
  if (status.error || !status.data?.devMode) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([status.reload(), sent.reload()]);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  const atSea = (sent.data?.bottles ?? []).filter((b) => b.state === 'at_sea');
  return (
    <aside ref={slot} className="dev-strip" data-open={open} aria-label="Development clock">
      <button
        type="button"
        className="toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        Dev clock · {formatDate(status.data.serverTime)}
      </button>
      {open ? (
        <>
          <div className="row">
            <button
              type="button"
              className="chip"
              onClick={() => void run(() => api.devAdvance(60 * 60 * 1000))}
            >
              +1 hour
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => void run(() => api.devAdvance(6 * 60 * 60 * 1000))}
            >
              +6 hours
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => void run(() => api.devAdvance(24 * 60 * 60 * 1000))}
            >
              +1 day
            </button>
          </div>
          {atSea.length > 0 ? (
            <div className="row">
              {atSea.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className="chip"
                  onClick={() => void run(() => api.devArrive(b.id))}
                >
                  Land bottle to {b.recipient.displayName} now
                </button>
              ))}
            </div>
          ) : null}
          <WeatherPreview />
          {outbox.data && outbox.data.provider !== 'smtp' ? (
            <div className="row outbox">
              <span className="t-meta">
                Dev outbox · mail is captured here, never delivered
                {outbox.data.messages.length === 0 ? ' · nothing captured yet' : ''}
              </span>
              {outbox.data.messages
                .slice(-3)
                .reverse()
                .map((m) => {
                  const link = /https?:\/\/\S+/.exec(m.text)?.[0];
                  return link ? (
                    <a key={m.id} className="chip" href={link}>
                      Open reset link → {m.to}
                    </a>
                  ) : (
                    <span key={m.id} className="chip">
                      {m.subject} → {m.to}
                    </span>
                  );
                })}
            </div>
          ) : null}
          <ErrorNote error={error} />
        </>
      ) : null}
    </aside>
  );
}

// Development-only weather preview. These are pure presentation switches: they change what the
// map and the shore draw and nothing else — no request is made, no bottle is touched, and no
// journey outcome, arrival time or route can change from here.
function WeatherPreview() {
  const {
    phase,
    phaseOverride,
    oceanStormOverride,
    shoreStormOverride,
    setPhaseOverride,
    setOceanStormOverride,
    setShoreStormOverride,
    timeZone,
  } = useWeather();
  const cycle = (v: WeatherOverride): WeatherOverride =>
    v === 'auto' ? 'on' : v === 'on' ? 'off' : 'auto';
  const label = (v: WeatherOverride) => (v === 'auto' ? 'auto' : v === 'on' ? 'forced on' : 'off');
  return (
    <div className="row">
      <span className="t-meta">
        Weather preview · {timeZone} · now {phase}
      </span>
      <button
        type="button"
        className="chip"
        aria-pressed={phaseOverride !== 'auto'}
        onClick={() =>
          setPhaseOverride(
            phaseOverride === 'auto' ? 'day' : phaseOverride === 'day' ? 'night' : 'auto',
          )
        }
      >
        Sky: {phaseOverride === 'auto' ? 'auto' : phaseOverride}
      </button>
      <button
        type="button"
        className="chip"
        aria-pressed={oceanStormOverride !== 'auto'}
        onClick={() => setOceanStormOverride(cycle(oceanStormOverride))}
      >
        Ocean storm: {label(oceanStormOverride)}
      </button>
      <button
        type="button"
        className="chip"
        aria-pressed={shoreStormOverride !== 'auto'}
        onClick={() => setShoreStormOverride(cycle(shoreStormOverride))}
      >
        Shore storm: {label(shoreStormOverride)}
      </button>
    </div>
  );
}
