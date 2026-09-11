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
  return (
    <div className="world-screen two-pane">
      <div className="world-layer">
        <OceanMap
          routes={[]}
          anchors={anchors}
          showAnchorLabels
          selectedAnchorId={choice}
          onSelectAnchor={setChoice}
          bottomPadding={360}
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
      <section className="sheet" aria-label="Shores">
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
                        <span className="t-meta">
                          Connected to {passages[s.id] ?? 0}{' '}
                          {passages[s.id] === 1 ? 'passage' : 'passages'} · {s.capacity} places
                        </span>
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
            <button
              type="button"
              className="btn-primary"
              disabled={!choice || busy || choice === user?.shoreId}
              onClick={save}
            >
              {busy ? 'Anchoring…' : 'Anchor here'}
            </button>
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
