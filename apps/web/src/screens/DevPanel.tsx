import { useState } from 'react';
import { api } from '../api/client.js';
import { DEV_CLOCK_RESET_PROMPT } from '@mib/shared';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ErrorNote } from '../components/ui.js';
import { formatDate } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useTopSlot } from '../lib/useTopSlot.js';
import { useSession } from '../state/session.js';
import { useWeather, type WeatherOverride } from '../state/weather.js';

// Development-only simulation controls, behind three independent gates:
//
//   • the bundle: they exist only in development builds (`import.meta.env.DEV`);
//   • the account: only the `developer` role sees them. An administrator does not — deciding
//     real reports and fabricating test events are different jobs, and the roles are disjoint;
//   • the server: every endpoint behind this panel requires the developer role *and* dev mode,
//     so this check is a courtesy to the UI and not the control. In production the API answers
//     403 even to a developer-role account.
//
// The bar sits in the top stack so it pushes content down instead of covering it.
const DEV_CONTROLS_ENABLED: boolean = import.meta.env.DEV;

export function DevPanel(props: { onChanged: () => void; refreshKey: number }) {
  const { user } = useSession();
  if (!DEV_CONTROLS_ENABLED || user?.role !== 'developer') return null;
  return <DevPanelInner {...props} />;
}

function DevPanelInner({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const status = useAsync(() => api.devStatus(), [], 30_000);
  const sent = useAsync(() => api.sentBottles(), [refreshKey]);
  const outbox = useAsync(() => api.devOutbox(), [refreshKey], 15_000);
  const [error, setError] = useState<Error | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const { resync } = useWeather();
  const slot = useTopSlot('dev');
  if (status.error || !status.data?.devMode) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      // This device learns the new time at once; every other open client on its next poll.
      await Promise.all([status.reload(), sent.reload(), resync()]);
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
            {/* Back to the server's real time, for every account: it is one shared clock. */}
            <button
              type="button"
              className="chip"
              disabled={status.data.clockOffsetMs === 0}
              onClick={() => setConfirmingReset(true)}
            >
              Return to real time
            </button>
          </div>
          {confirmingReset ? (
            <ConfirmDialog
              title="Return to real time"
              body={DEV_CLOCK_RESET_PROMPT}
              confirmLabel="Return to real time"
              busy={resetting}
              onCancel={() => setConfirmingReset(false)}
              onConfirm={() => {
                setResetting(true);
                void run(() => api.devResetClock()).finally(() => {
                  setResetting(false);
                  setConfirmingReset(false);
                });
              }}
            />
          ) : null}
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
          {atSea.length > 0 ? (
            // Journey outcomes (spec §9): the risk policy is not approved, so nothing happens on
            // its own. These end a journey through the same server-owned path a hazard engine
            // would use — persisted once, never rerolled.
            <div className="row">
              <span className="t-meta">Outcome preview · server-owned, never automatic</span>
              {atSea.map((b) => (
                <span key={b.id} className="row" style={{ gap: 4 }}>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => void run(() => api.devLose(b.id, 'adrift'))}
                  >
                    Adrift: {b.recipient.displayName}
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => void run(() => api.devLose(b.id, 'sunk'))}
                  >
                    Sink: {b.recipient.displayName}
                  </button>
                </span>
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
