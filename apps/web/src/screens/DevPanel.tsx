import { useState } from 'react';
import { api } from '../api/client.js';
import { ErrorNote } from '../components/ui.js';
import { formatDate } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useTopSlot } from '../lib/useTopSlot.js';

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
          <ErrorNote error={error} />
        </>
      ) : null}
    </aside>
  );
}
