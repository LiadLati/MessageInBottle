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

// What the sheet shows. The default is the clean map; a route or a bottle is opened only by a
// tap on the map (or by the release flow handing over the bottle it just created).
type View =
  | { kind: 'clean' }
  | { kind: 'route'; routeKey: string }
  | { kind: 'bottle'; id: string; fromRoute: string | null };

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

// Bottles share a route when they follow the same sequence of passages.
const routeKeyOf = (b: SentBottleSummaryDto) => b.route.nodeIds.join('>');

// S1 · Ocean — private journeys over the real world map.
export function OceanScreen({ focusId = null, onOpenPassport, onWrite, onOpenProfile }: Props) {
  const { user } = useSession();
  const bottles = useAsync(() => api.sentBottles(), [], POLL_MS);
  const chart = useAsync(() => api.chart(), []);
  const [view, setView] = useState<View>(() =>
    focusId ? { kind: 'bottle', id: focusId, fromRoute: null } : { kind: 'clean' },
  );
  const [fitKey, setFitKey] = useState(focusId ?? 'initial');
  const mapHandle = useRef<OceanMapHandle>(null);

  // The active map: a journey stays until the recipient opens the letter, then it belongs to
  // history (Letters → Sent / Received, the passport) and leaves the map.
  const list = useMemo(
    () => (bottles.data?.bottles ?? []).filter((b) => b.state !== 'opened'),
    [bottles.data],
  );
  const groups = useMemo(() => {
    const map = new Map<string, SentBottleSummaryDto[]>();
    for (const b of list) {
      const key = routeKeyOf(b);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return map;
  }, [list]);

  const current = view.kind === 'bottle' ? (list.find((b) => b.id === view.id) ?? null) : null;
  const routeBottles = useMemo(
    () => (view.kind === 'route' ? (groups.get(view.routeKey) ?? []) : []),
    [view, groups],
  );
  const selectedRouteIds = useMemo(
    () =>
      view.kind === 'bottle'
        ? [view.id]
        : view.kind === 'route'
          ? routeBottles.map((b) => b.id)
          : [],
    [view, routeBottles],
  );

  const routes = useMemo(() => list.map(toRoute).filter((r): r is MapRoute => r !== null), [list]);
  const focusBottle = current ?? routeBottles[0] ?? null;
  const anchors = useMemo<MapAnchor[]>(() => {
    if (!focusBottle || !chart.data) return [];
    const byId = new Map(chart.data.shores.map((s) => [s.id, s]));
    const o = byId.get(focusBottle.originShore.id);
    const d = byId.get(focusBottle.destinationShore.id);
    const out: MapAnchor[] = [];
    if (o?.geo) out.push({ id: o.id, name: o.name, geo: o.geo, role: 'origin' });
    if (d?.geo) out.push({ id: d.id, name: d.name, geo: d.geo, role: 'destination' });
    return out;
  }, [focusBottle, chart.data]);

  const refit = (key: string) => setFitKey(`${key}:${Date.now()}`);
  // A tap on a bottle marker or route line: one bottle opens directly, a shared route lists them.
  const selectFromMap = (bottleId: string) => {
    const b = list.find((x) => x.id === bottleId);
    if (!b) return;
    const key = routeKeyOf(b);
    const group = groups.get(key) ?? [b];
    if (group.length === 1) setView({ kind: 'bottle', id: b.id, fromRoute: null });
    else setView({ kind: 'route', routeKey: key });
    refit(key);
  };
  const close = () => {
    setView({ kind: 'clean' });
    refit('all');
  };

  const synced = list[0]?.serverTime ?? null;
  const atSeaCount = list.filter((b) => b.state === 'at_sea').length;
  const subline =
    bottles.loading && !bottles.data
      ? 'Charting…'
      : list.length === 0
        ? 'Nothing at sea'
        : `${synced ? `Synced ${formatTime(synced)} · ` : ''}${list.length === 1 ? 'tap the bottle' : 'tap a bottle or route'}`;

  return (
    <div className="world-screen two-pane">
      <div className="world-layer">
        <OceanMap
          handle={mapHandle}
          routes={routes}
          anchors={anchors}
          selectedRouteIds={selectedRouteIds}
          onSelectRoute={selectFromMap}
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
          aria-label="Recenter"
          onClick={() => mapHandle.current?.recenter()}
        >
          <Icon name="recenter" size={16} />
        </button>
      </div>

      {bottles.loading && !bottles.data ? (
        <section className="sheet" aria-label="Journey">
          <Skeleton />
        </section>
      ) : list.length === 0 ? (
        <section className="sheet" aria-label="Journey">
          <div className="stack">
            <h2 className="t-display-sm">No bottles at sea</h2>
            <p className="t-meta" style={{ fontSize: 13.5 }}>
              The water is calm and patient. Write to a friend and let the current carry it.
            </p>
            <button type="button" className="btn-primary" onClick={onWrite}>
              Write a letter
            </button>
            <ErrorNote error={bottles.error ?? chart.error} />
          </div>
        </section>
      ) : view.kind === 'route' ? (
        <section className="sheet" aria-label="Bottles on this route">
          <div className="row">
            <div className="grow">
              <h2 className="t-card-title">{routeBottles.length} bottles on this route</h2>
              <p className="t-meta">
                {routeBottles[0]?.originShore.name} → {routeBottles[0]?.destinationShore.name}
              </p>
            </div>
            <button type="button" className="glass-control" aria-label="Close" onClick={close}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <ul className="list" style={{ marginTop: 12 }}>
            {routeBottles.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  className="row-item selectable"
                  onClick={() => setView({ kind: 'bottle', id: b.id, fromRoute: view.routeKey })}
                >
                  <Avatar name={b.recipient.displayName} tone="foam" />
                  <span className="grow">
                    <span className="t-card-title" style={{ display: 'block' }}>
                      To {b.recipient.displayName}
                    </span>
                    <span className="t-meta">
                      {b.state === 'at_sea' ? 'At sea for' : 'Journey took'}{' '}
                      {formatDuration(b.elapsedMs)}
                    </span>
                  </span>
                  <StatusChip state={b.state} />
                </button>
              </li>
            ))}
          </ul>
          <ErrorNote error={bottles.error ?? chart.error} />
        </section>
      ) : view.kind === 'bottle' && current ? (
        <section className="sheet" aria-label="Journey">
          <JourneyCard
            bottle={current}
            onBack={
              view.fromRoute ? () => setView({ kind: 'route', routeKey: view.fromRoute! }) : null
            }
            onClose={close}
            onPassport={() => onOpenPassport(current.id)}
          />
          <ErrorNote error={bottles.error ?? chart.error} />
        </section>
      ) : bottles.error || chart.error ? (
        <section className="sheet" aria-label="Journey">
          <ErrorNote error={bottles.error ?? chart.error} />
        </section>
      ) : null}
    </div>
  );
}

function JourneyCard({
  bottle,
  onBack,
  onClose,
  onPassport,
}: {
  bottle: SentBottleSummaryDto;
  onBack: (() => void) | null;
  onClose: () => void;
  onPassport: () => void;
}) {
  const passages = Math.max(1, bottle.route.nodeIds.length - 1);
  const pct = Math.round(bottle.position.progress * 100);
  const live = bottle.state === 'at_sea';
  return (
    <div>
      <div className="row">
        {onBack ? (
          <button
            type="button"
            className="glass-control"
            aria-label="Back to route"
            onClick={onBack}
          >
            <Icon name="back" size={16} />
          </button>
        ) : (
          <Avatar name={bottle.recipient.displayName} tone="foam" />
        )}
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="t-card-title">To {bottle.recipient.displayName}</div>
          <div className="t-meta">
            {bottle.originShore.name} → {bottle.destinationShore.name} · {passages}{' '}
            {passages === 1 ? 'passage' : 'passages'}
          </div>
        </div>
        <button type="button" className="glass-control" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <StatusChip state={bottle.state} />
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
    </div>
  );
}
