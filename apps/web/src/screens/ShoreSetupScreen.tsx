import { useMemo, useState } from 'react';
import type { ChartResponse } from '@mib/shared';
import { api } from '../api/client.js';
import { OceanMap } from '../components/lazy.js';
import type { MapAnchor } from '../components/OceanMap.js';
import { ErrorNote, Skeleton } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';

interface Props {
  onDone?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
}

function passagesPerShore(chart: ChartResponse): Record<string, number> {
  const nodeShore = new Map(chart.nodes.map((n) => [n.id, n.shoreId]));
  const out: Record<string, number> = {};
  for (const e of chart.edges) {
    for (const end of [e.from, e.to]) {
      const shoreId = nodeShore.get(end);
      if (shoreId) out[shoreId] = (out[shoreId] ?? 0) + 1;
    }
  }
  return out;
}

// Shore selection over the real map (IA S9c). Manual only: no GPS, no coordinates collected.
// On phones the map is the whole screen: pins (clustered when dense) are the list; picking one
// raises a compact card with the shore's details and "Anchor here". Desktop keeps the side pane.
export function ShoreSetupScreen({ onDone, onCancel }: Props) {
  const { user, refresh } = useSession();
  const chart = useAsync(() => api.chart(), []);
  const [choice, setChoice] = useState<string | null>(user?.shoreId ?? null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const anchors: MapAnchor[] = useMemo(
    () =>
      (chart.data?.shores ?? [])
        .filter((s) => s.geo)
        .map((s) => ({ id: s.id, name: s.name, geo: s.geo!, role: 'shore' as const })),
    [chart.data],
  );
  const passages = useMemo(() => (chart.data ? passagesPerShore(chart.data) : {}), [chart.data]);
  const chosen = chart.data?.shores.find((s) => s.id === choice) ?? null;

  const save = async () => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api.setMyShore(choice);
      await refresh();
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  };

  const changing = Boolean(user?.shoreId);
  const details = (id: string, capacity: number) =>
    `Connected to ${passages[id] ?? 0} ${passages[id] === 1 ? 'passage' : 'passages'} · ${capacity} places`;
  const anchorButton = (
    <button
      type="button"
      className="btn-primary"
      disabled={!choice || busy || choice === user?.shoreId}
      onClick={save}
    >
      {busy ? 'Anchoring…' : choice === user?.shoreId ? 'Anchored here' : 'Anchor here'}
    </button>
  );

  return (
    <div className="world-screen two-pane shore-setup">
      <div className="world-layer">
        <OceanMap
          routes={[]}
          anchors={anchors}
          showAnchorLabels
          selectedAnchorId={choice}
          onSelectAnchor={(id) => setChoice((c) => (c === id ? null : id))}
          bottomPadding={200}
          fitKey="shores"
        />
      </div>
      <div className="scrim scrim-map" />
      <div className="scrim-map-header" />
      <header className="world-header">
        <div>
          <h1 className="t-title">{changing ? 'Change your shore' : 'Choose your shore'}</h1>
          <p className="t-meta">Tap a coast · nothing about you is located</p>
        </div>
        {onCancel ? (
          <button type="button" className="glass-control" aria-label="Cancel" onClick={onCancel}>
            <Icon name="close" size={18} />
          </button>
        ) : null}
      </header>

      {/* Phone: a compact card only once a pin is chosen; closing it restores the clean map. */}
      {chosen ? (
        <section className="sheet shore-card phone-only" aria-label="Selected shore">
          <div className="row">
            <div className="grow">
              <h2 className="t-card-title">{chosen.name}</h2>
              <p className="t-meta">{details(chosen.id, chosen.capacity)}</p>
            </div>
            <button
              type="button"
              className="glass-control"
              aria-label="Deselect shore"
              onClick={() => setChoice(null)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div style={{ marginTop: 12 }}>{anchorButton}</div>
          <p className="t-meta" style={{ marginTop: 8 }}>
            A shore is only an anchor in the app. Changing it affects future bottles only.
          </p>
          <ErrorNote error={error} />
        </section>
      ) : null}
      {chart.error ? (
        <section className="sheet phone-only">
          <ErrorNote error={chart.error} />
        </section>
      ) : null}

      {/* Desktop: the side pane lists every shore next to the map. */}
      <section className="sheet desktop-only" aria-label="Shores">
        {chart.loading || !chart.data ? (
          <Skeleton />
        ) : (
          <div className="stack">
            <ul className="list" role="radiogroup" aria-label="Available shores">
              {chart.data.shores.map((s) => {
                const selected = choice === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`row-item selectable${selected ? ' selected' : ''}`}
                      onClick={() => setChoice(s.id)}
                    >
                      <span className="grow">
                        <span className="t-card-title" style={{ display: 'block' }}>
                          {s.name}
                        </span>
                        <span className="t-meta">{details(s.id, s.capacity)}</span>
                      </span>
                      {selected ? (
                        <span className="check-circle" aria-hidden>
                          <Icon name="check" size={14} />
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {anchorButton}
            <p className="t-meta">
              A shore is only an anchor in the app. It says nothing about where you live, and
              changing it affects future bottles only.
            </p>
            <ErrorNote error={error ?? chart.error} />
          </div>
        )}
      </section>
    </div>
  );
}
