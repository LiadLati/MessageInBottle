import { useState } from 'react';
import { api } from '../api/client.js';
import { SeaChart } from '../components/SeaChart.js';
import { Empty, ErrorNote, Loading, Screen, StatusPill } from '../components/ui.js';
import { formatDate, formatDuration } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';

const POLL_MS = 15_000;

export function OceanScreen({
  onOpenPassport,
  focusId,
}: {
  onOpenPassport: (id: string) => void;
  focusId?: string | null;
}) {
  const { user } = useSession();
  const chart = useAsync(() => api.chart(), []);
  const bottles = useAsync(() => api.sentBottles(), [], POLL_MS);
  const [selected, setSelected] = useState<string | null>(focusId ?? null);
  const list = bottles.data?.bottles ?? [];
  const selectedBottle = list.find((b) => b.id === selected) ?? null;

  return (
    <Screen title="Ocean · Private journeys">
      <p className="muted small">
        Positions are simulated by the server. Last synced{' '}
        {bottles.data ? formatDate(list[0]?.serverTime ?? new Date().toISOString()) : '—'}. Lost
        Bottles (public map) arrives in the next stage.
      </p>
      {chart.loading || bottles.loading || !chart.data ? (
        <Loading />
      ) : (
        <>
          <SeaChart
            chart={chart.data}
            bottles={list}
            selectedId={selected}
            onSelect={setSelected}
            originShoreId={user?.shoreId}
          />
          {list.length === 0 ? (
            <Empty>No bottles at sea. Write one to a friend.</Empty>
          ) : (
            <ul className="list" aria-label="Your bottles">
              {list.map((b) => (
                <li key={b.id}>
                  <button
                    className={`list-item as-button${b.id === selected ? ' selected' : ''}`}
                    onClick={() => setSelected(b.id)}
                  >
                    <span>
                      <strong>To {b.recipient.displayName}</strong>
                      <span className="muted small block">
                        {b.originShore.name} → {b.destinationShore.name}
                      </span>
                    </span>
                    <span className="right">
                      <StatusPill state={b.state} />
                      <span className="muted small block">
                        {b.elapsedIsLive ? 'at sea for' : 'journey took'}{' '}
                        {formatDuration(b.elapsedMs)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selectedBottle ? (
            <div className="card">
              <div className="row space-between">
                <strong>To {selectedBottle.recipient.displayName}</strong>
                <StatusPill state={selectedBottle.state} />
              </div>
              <dl className="passport">
                <dt>Released</dt>
                <dd>{formatDate(selectedBottle.releasedAt)}</dd>
                <dt>Progress</dt>
                <dd>{Math.round(selectedBottle.position.progress * 100)}% of the planned route</dd>
                <dt>Elapsed</dt>
                <dd>
                  {formatDuration(selectedBottle.elapsedMs)}
                  {selectedBottle.elapsedIsLive ? ' (live)' : ' (completed)'}
                </dd>
              </dl>
              <button className="btn" onClick={() => onOpenPassport(selectedBottle.id)}>
                Bottle passport
              </button>
            </div>
          ) : null}
        </>
      )}
      <ErrorNote error={chart.error ?? bottles.error} />
    </Screen>
  );
}
