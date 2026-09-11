import { useMemo, useRef, useState } from 'react';
import type { SentBottleSummaryDto } from '@mib/shared';
import { api } from '../api/client.js';
import { OceanMap } from '../components/lazy.js';
import type { MapAnchor, MapRoute, OceanMapHandle } from '../components/OceanMap.js';
import { Avatar, ErrorNote, Skeleton, StatusChip } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { formatDuration, formatTime } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { useSession } from '../state/session.js';

const POLL_MS = 15_000;

interface Props {
  focusId?: string | null | undefined;
  onOpenPassport: (id: string) => void;
  onWrite: () => void;
  onOpenProfile: () => void;
}

function toRoute(b: SentBottleSummaryDto): MapRoute | null {
  if (!b.route.geoPoints || b.route.geoPoints.length < 2) return null;
  return {
    id: b.id,
    points: b.route.geoPoints,
    progress: b.position.progress,
    progressAsOf: Date.parse(b.position.asOf),
    plannedDurationMs: b.route.plannedDurationMs,
    live: b.state === 'at_sea',
    state: b.state,
  };
}

// S1 · Ocean — private journeys over the real world map.
export function OceanScreen({ focusId = null, onOpenPassport, onWrite, onOpenProfile }: Props) {
  const { user } = useSession();
  const bottles = useAsync(() => api.sentBottles(), [], POLL_MS);
  const chart = useAsync(() => api.chart(), []);
  const [selected, setSelected] = useState<string | null>(focusId);
  const [fitKey, setFitKey] = useState(focusId ?? 'initial');
  const mapHandle = useRef<OceanMapHandle>(null);

  const list = useMemo(() => bottles.data?.bottles ?? [], [bottles.data]);
  const current = list.find((b) => b.id === selected) ?? list[0] ?? null;

  const routes = useMemo(() => list.map(toRoute).filter((r): r is MapRoute => r !== null), [list]);
  const anchors = useMemo<MapAnchor[]>(() => {
    if (!current || !chart.data) return [];
    const byId = new Map(chart.data.shores.map((s) => [s.id, s]));
    const o = byId.get(current.originShore.id);
    const d = byId.get(current.destinationShore.id);
    const out: MapAnchor[] = [];
    if (o?.geo) out.push({ id: o.id, name: o.name, geo: o.geo, role: 'origin' });
    if (d?.geo) out.push({ id: d.id, name: d.name, geo: d.geo, role: 'destination' });
    return out;
  }, [current, chart.data]);

  const select = (id: string) => {
    setSelected(id);
    setFitKey(`${id}:${Date.now()}`);
  };

  const synced = list[0]?.serverTime ?? null;
  const atSeaCount = list.filter((b) => b.state === 'at_sea').length;
  const subline = synced
    ? `Position synced ${formatTime(synced)} · simulated`
    : bottles.loading
      ? 'Charting…'
      : 'Nothing at sea';

  return (
    <div className="world-screen two-pane">
      <div className="world-layer">
        <OceanMap
          handle={mapHandle}
          routes={routes}
          anchors={anchors}
          selectedRouteId={current?.id ?? null}
          onSelectRoute={select}
          fitKey={fitKey}
        />
      </div>
      <div className="scrim scrim-map" />
      <div className="scrim-map-header" />
      <header className="world-header">
        <div>
          <h1 className="t-title">{atSeaCount > 0 ? 'At sea' : 'Ocean'}</h1>
          <p className="t-meta">{subline}</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="glass-control"
            aria-label="Write a letter"
            onClick={onWrite}
          >
            <Icon name="plus" size={18} />
          </button>
          <button
            type="button"
            className="avatar"
            aria-label="Your account"
            onClick={onOpenProfile}
          >
            {user?.displayName.charAt(0).toUpperCase()}
          </button>
        </div>
      </header>
      <div className="mode-switch" role="group" aria-label="Map mode">
        <span className="active">Private</span>
        <button
          type="button"
          className="inactive"
          disabled
          title="Public discovery arrives in the next stage"
        >
          Lost bottles
        </button>
      </div>
      <div className="zoom-cluster">
        <button
          type="button"
          className="glass-control map-control"
          aria-label="Zoom in"
          onClick={() => mapHandle.current?.zoomIn()}
        >
          <Icon name="plus" size={16} />
        </button>
        <button
          type="button"
          className="glass-control map-control"
          aria-label="Zoom out"
          onClick={() => mapHandle.current?.zoomOut()}
        >
          <Icon name="minus" size={16} />
        </button>
        <button
          type="button"
          className="glass-control map-control"
          aria-label="Recenter on route"
          onClick={() => mapHandle.current?.recenter()}
        >
          <Icon name="recenter" size={16} />
        </button>
      </div>

      <section className="sheet" aria-label="Journey">
        {bottles.loading && !bottles.data ? (
          <Skeleton />
        ) : !current ? (
          <div className="stack">
            <h2 className="t-display-sm">No bottles at sea</h2>
            <p className="t-meta" style={{ fontSize: 13.5 }}>
              The water is calm and patient. Write to a friend and let the current carry it.
            </p>
            <button type="button" className="btn-primary" onClick={onWrite}>
              Write a letter
            </button>
          </div>
        ) : (
          <JourneyCard
            bottle={current}
            others={list.filter((b) => b.id !== current.id)}
            onPick={select}
            onPassport={() => onOpenPassport(current.id)}
          />
        )}
        <ErrorNote error={bottles.error ?? chart.error} />
      </section>
    </div>
  );
}

function JourneyCard({
  bottle,
  others,
  onPick,
  onPassport,
}: {
  bottle: SentBottleSummaryDto;
  others: SentBottleSummaryDto[];
  onPick: (id: string) => void;
  onPassport: () => void;
}) {
  const passages = Math.max(1, bottle.route.nodeIds.length - 1);
  const pct = Math.round(bottle.position.progress * 100);
  const live = bottle.state === 'at_sea';
  return (
    <div>
      <div className="row">
        <Avatar name={bottle.recipient.displayName} tone="foam" />
        <div className="grow">
          <div className="t-card-title">To {bottle.recipient.displayName}</div>
          <div className="t-meta">
            {bottle.originShore.name} → {bottle.destinationShore.name} · {passages}{' '}
            {passages === 1 ? 'passage' : 'passages'}
          </div>
        </div>
        <StatusChip state={bottle.state} />
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <div
          className="progress-rail"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Journey progress"
        >
          <span style={{ transform: `scaleX(${bottle.position.progress})` }} />
        </div>
        <span className="t-numeric" style={{ color: 'var(--foam)' }}>
          {pct}%
        </span>
      </div>
      <div className="stat-row" style={{ marginTop: 14 }}>
        <div className="stat">
          <div className="t-eyebrow">{live ? 'At sea for' : 'Journey took'}</div>
          <div className="t-stat">{formatDuration(bottle.elapsedMs)}</div>
        </div>
        <div className="stat">
          <div className="t-eyebrow">Water</div>
          <div className="t-stat">{live ? 'Calm' : '—'}</div>
        </div>
        <button
          type="button"
          className="btn-ghost"
          style={{ marginLeft: 'auto' }}
          onClick={onPassport}
        >
          <Icon name="passport" size={14} />
          Passport
        </button>
      </div>
      {others.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div className="t-eyebrow" style={{ marginBottom: 8 }}>
            Other bottles
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {others.map((b) => (
              <button key={b.id} type="button" className="chip" onClick={() => onPick(b.id)}>
                To {b.recipient.displayName} · {formatDuration(b.elapsedMs)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
