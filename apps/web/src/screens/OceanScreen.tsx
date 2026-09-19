import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  solarPhaseAt,
  type OpenedLetterDto,
  type PublicBottleDto,
  type SentBottleSummaryDto,
} from '@mib/shared';
import { ApiError, api } from '../api/client.js';
import { LetterModal } from '../components/LetterModal.js';
import { OceanMap, SeaViewer } from '../components/lazy.js';
import type { HarborLabel, MapAnchor, MapRoute, OceanMapHandle } from '../components/OceanMap.js';
import { Avatar, ErrorNote, OutcomeChip, Skeleton, StatusChip } from '../components/ui.js';
import { Icon } from '../design/Icon.js';
import { formatDate, formatDuration, formatTime } from '../lib/format.js';
import { useAsync } from '../lib/useAsync.js';
import { oceanWeatherMap, type BottleWeather } from '../lib/oceanWeather.js';
import { useSession } from '../state/session.js';
import { useWeather } from '../state/weather.js';

const POLL_MS = 15_000;

export type OceanMode = 'private' | 'public';

interface Props {
  focusId?: string | null | undefined;
  // Open straight onto the public ocean with this bottle selected (Letters → Lost → Show on
  // public map).
  focusPublicId?: string | null | undefined;
  // The shell calls this before navigating to another application screen, so the private map
  // can acknowledge the terminal markers the sender has actually seen on this visit.
  leaveRef?: RefObject<(() => void) | null>;
  // Unread notifications, shown on the envelope beside the + control.
  unread?: number;
  onOpenInbox?: () => void;
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
  if (b.outcome) {
    // An ended journey (a sunk bottle on the private map): a fixed marker at the persisted
    // outcome position, no route.
    if (!b.outcome.position.geo) return null;
    return {
      id: b.id,
      points: [],
      progress: b.outcome.progress,
      progressAsOf: Date.parse(b.position.asOf),
      plannedDurationMs: b.route.plannedDurationMs,
      live: false,
      state: b.state,
      label: b.recipient.displayName,
      fixed: b.outcome.position.geo,
      mark: b.outcome.reason === 'sunk' ? 'sunk' : 'adrift',
      mine: true,
    };
  }
  if (!b.route.geoPoints || b.route.geoPoints.length < 2) return null;
  return {
    id: b.id,
    points: b.route.geoPoints,
    progress: b.position.progress,
    progressAsOf: Date.parse(b.position.asOf),
    plannedDurationMs: b.route.plannedDurationMs,
    live: b.state === 'at_sea',
    state: b.state,
    label: b.recipient.displayName,
  };
}

function publicRoute(b: PublicBottleDto): MapRoute {
  return {
    id: b.id,
    points: [],
    progress: 0,
    progressAsOf: Date.parse(b.lostAt),
    plannedDurationMs: 0,
    live: false,
    state: 'lost',
    fixed: b.position.geo,
    mark: 'adrift',
    mine: b.mine,
  };
}

const overrideToForce = (v: 'auto' | 'on' | 'off') => (v === 'auto' ? null : v);

// Bottles share a route when they follow the same sequence of passages.
const routeKeyOf = (b: SentBottleSummaryDto) => b.route.nodeIds.join('>');

// A bottle belongs on the sender's private map until the recipient opens it, or the sea ends
// the journey: an adrift bottle moves to the public ocean at once, a sunk one stays at its
// sinking position until the sender has seen it and left the map (see the visibility rules).
function onPrivateMap(b: SentBottleSummaryDto): boolean {
  if (b.state === 'opened') return false;
  if (b.state !== 'lost') return true;
  if (b.outcome?.reason !== 'sunk') return false;
  return b.visibility?.acknowledgedAt == null;
}

// S1 · Ocean — private journeys over the real world map, and the public ocean beside it.
export function OceanScreen({
  focusId = null,
  focusPublicId = null,
  leaveRef,
  unread = 0,
  onOpenInbox,
  onOpenPassport,
  onWrite,
  onOpenProfile,
}: Props) {
  const { user } = useSession();
  const { phase, phaseOverride, nowMs, oceanStormOverride } = useWeather();
  const [mode, setMode] = useState<OceanMode>(focusPublicId ? 'public' : 'private');
  const bottles = useAsync(() => api.sentBottles(), [], POLL_MS);
  const chart = useAsync(() => api.chart(), []);
  const publicOcean = useAsync(
    () => (mode === 'public' ? api.publicOcean() : Promise.resolve(null)),
    [mode],
    POLL_MS,
  );
  const [view, setView] = useState<View>(() => {
    const id = focusPublicId ?? focusId;
    return id ? { kind: 'bottle', id, fromRoute: null } : { kind: 'clean' };
  });
  const [fitKey, setFitKey] = useState(focusPublicId ?? focusId ?? 'initial');
  const mapHandle = useRef<OceanMapHandle>(null);

  const list = useMemo(() => (bottles.data?.bottles ?? []).filter(onPrivateMap), [bottles.data]);
  const groups = useMemo(() => {
    const map = new Map<string, SentBottleSummaryDto[]>();
    for (const b of list) {
      if (b.outcome) continue; // an ended journey has no route to share
      const key = routeKeyOf(b);
      map.set(key, [...(map.get(key) ?? []), b]);
    }
    return map;
  }, [list]);

  const isPublic = mode === 'public';
  const publicList = useMemo(() => publicOcean.data?.bottles ?? [], [publicOcean.data]);
  const current = view.kind === 'bottle' ? (list.find((b) => b.id === view.id) ?? null) : null;
  const currentPublic =
    view.kind === 'bottle' ? (publicList.find((b) => b.id === view.id) ?? null) : null;
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

  const privateRoutes = useMemo(
    () => list.map(toRoute).filter((r): r is MapRoute => r !== null),
    [list],
  );
  const publicRoutes = useMemo(() => publicList.map(publicRoute), [publicList]);
  const routes = isPublic ? publicRoutes : privateRoutes;

  // Per-bottle simulated weather: the server's own storm windows, for this sender's at-sea
  // bottles — so two bottles on one route can differ, nothing rerolls on refresh, selection or
  // opening the sea viewer, and a storm is shown whenever it is night where that bottle is,
  // whatever the hour is here.
  // Keep the weather map referentially stable while its values are unchanged, so the periodic
  // clock tick does not make the map re-run its marker effect for nothing: the map is rebuilt
  // only when its serialised form changes.
  const weatherKey = Object.entries(
    oceanWeatherMap(list, nowMs, { force: overrideToForce(oceanStormOverride) }),
  )
    .map(([id, w]) => `${id}=${w}`)
    .join(',');
  const weather = useMemo<Record<string, BottleWeather>>(
    () =>
      Object.fromEntries(
        weatherKey
          .split(',')
          .filter(Boolean)
          .map((pair) => pair.split('=') as [string, BottleWeather]),
      ),
    [weatherKey],
  );
  const weatherOf = (id: string) => weather[id] ?? 'calm';
  // Reading a letter from the public ocean: the sender re-reading their own (a pure read), or a
  // finder reading the bottle they have just opened. Both use the ordinary letter reader.
  const [reading, setReading] = useState<{
    letter: OpenedLetterDto;
    justOpened: boolean;
    // Only the sender's own read needs a line of its own; a found letter carries no attribution
    // and the reader states that itself.
    provenance?: string;
  } | null>(null);
  // Set when this bottle turned out to be gone — someone else opened it first, its 72 hours
  // ran out, or the finder's own one reading is over.
  const [claimedIds, setClaimedIds] = useState<string[]>([]);
  const [unavailableWhy, setUnavailableWhy] = useState<Record<string, string>>({});
  const [publicBusy, setPublicBusy] = useState(false);
  const [publicError, setPublicError] = useState<Error | null>(null);
  // The dedicated sea viewer: opened only from the card's "View at sea", never from a marker.
  const [viewing, setViewing] = useState<string | null>(null);
  const viewingBottle = viewing ? (list.find((b) => b.id === viewing) ?? null) : null;
  const focusBottle = current ?? routeBottles[0] ?? null;
  const shoreById = useMemo(
    () => new Map((chart.data?.shores ?? []).map((s) => [s.id, s])),
    [chart.data],
  );
  const anchors = useMemo<MapAnchor[]>(() => {
    if (!focusBottle || focusBottle.outcome) return [];
    const o = shoreById.get(focusBottle.originShore.id);
    const d = shoreById.get(focusBottle.destinationShore.id);
    const out: MapAnchor[] = [];
    if (o?.geo) out.push({ id: o.id, name: o.name, geo: o.geo, role: 'origin' });
    if (d?.geo) out.push({ id: d.id, name: d.name, geo: d.geo, role: 'destination' });
    return out;
  }, [focusBottle, shoreById]);

  // Harbour labels: the signed-in user's own harbour always; the selected bottle's destination
  // while it is selected on the private map. The same shore for both is one label. The public
  // ocean never names a destination.
  const ownShoreId = user?.shoreId ?? null;
  const harbors = useMemo<HarborLabel[]>(() => {
    const own = ownShoreId ? shoreById.get(ownShoreId) : null;
    const dest =
      !isPublic && focusBottle && !focusBottle.outcome
        ? shoreById.get(focusBottle.destinationShore.id)
        : null;
    const out: HarborLabel[] = [];
    if (own?.geo && dest?.geo && own.id === dest.id) {
      out.push({ id: own.id, name: own.name, geo: own.geo, kind: 'both' });
      return out;
    }
    if (own?.geo) out.push({ id: own.id, name: own.name, geo: own.geo, kind: 'own' });
    if (dest?.geo) out.push({ id: dest.id, name: dest.name, geo: dest.geo, kind: 'destination' });
    return out;
  }, [ownShoreId, shoreById, focusBottle, isPublic]);

  // ---- terminal-marker visibility (sunk bottles on the private map) ----
  // "Seen" is reported by the map when the marker is actually inside the visible viewport;
  // "acknowledged" when the sender leaves the private map afterwards. Both are persisted per
  // account on the server, so a refresh never erases an unseen marker.
  const sunkIds = useMemo(
    () => list.filter((b) => b.outcome?.reason === 'sunk').map((b) => b.id),
    [list],
  );
  const seenNow = useRef(new Set<string>());
  const reloadBottles = bottles.reload;
  const onSeen = useCallback((id: string) => {
    if (seenNow.current.has(id)) return;
    seenNow.current.add(id);
    void api.markOutcomeSeen(id).catch(() => seenNow.current.delete(id));
  }, []);
  const listRef = useRef(list);
  useEffect(() => {
    listRef.current = list;
  });
  const acknowledgeSeen = useCallback(() => {
    for (const b of listRef.current) {
      if (b.outcome?.reason !== 'sunk' || b.visibility?.acknowledgedAt) continue;
      if (b.visibility?.seenAt || seenNow.current.has(b.id)) {
        void api.acknowledgeOutcome(b.id).catch(() => {});
      }
    }
  }, []);
  useEffect(() => {
    if (!leaveRef) return;
    leaveRef.current = acknowledgeSeen;
    return () => {
      leaveRef.current = null;
    };
  }, [leaveRef, acknowledgeSeen]);

  const reloadPublic = publicOcean.reload;
  // A finder's one-time reading survives a refresh or a dropped connection for a short,
  // server-bounded while: if this account has one open, bring it straight back.
  useEffect(() => {
    let alive = true;
    void api
      .activeReading()
      .then((r) => {
        if (alive && r.reading) setReading({ letter: r.reading, justOpened: true });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  // Closing the reader ends the finder's access at once (the sender's own read is a plain read).
  const closeReader = () => {
    const r = reading;
    setReading(null);
    if (r && r.letter.bottle.source === 'public') {
      void api.closeReading(r.letter.bottle.id).catch(() => {});
    }
  };
  // The sender's own read: never claims the bottle, never takes it off the map.
  const readOwn = async (id: string) => {
    setPublicError(null);
    setPublicBusy(true);
    try {
      const letter = await api.ownLetter(id);
      setReading({
        letter,
        justOpened: false,
        provenance: `Your letter · ${formatDuration(letter.bottle.journeyDurationMs)} at sea`,
      });
    } catch (err) {
      setPublicError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setPublicBusy(false);
    }
  };
  // One server-owned action: it grants this account the letter and removes the bottle from the
  // public map for everyone. If somebody else was first, the card says so and shows nothing.
  const openFound = async (id: string) => {
    setPublicError(null);
    setPublicBusy(true);
    try {
      const letter = await api.openPublicBottle(id);
      setReading({ letter, justOpened: true });
      await reloadPublic();
    } catch (err) {
      if (
        err instanceof ApiError &&
        (err.code === 'already_opened' ||
          err.code === 'listing_expired' ||
          err.code === 'reading_closed')
      ) {
        setClaimedIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
        setUnavailableWhy((m) => ({ ...m, [id]: err.code }));
        await reloadPublic();
      } else {
        setPublicError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      setPublicBusy(false);
    }
  };

  const refit = (key: string) => setFitKey(`${key}:${Date.now()}`);
  const switchMode = (next: OceanMode) => {
    if (next === mode) return;
    // Leaving the private map for the public ocean counts as leaving it.
    if (mode === 'private') {
      acknowledgeSeen();
      seenNow.current.clear();
    } else {
      void reloadBottles();
    }
    setMode(next);
    setView({ kind: 'clean' });
    setViewing(null);
    setPublicError(null);
    refit(`mode:${next}`);
  };
  // A tap on a bottle marker or route line: one bottle opens directly, a shared route lists them.
  const selectFromMap = (bottleId: string) => {
    if (isPublic) {
      if (publicList.some((b) => b.id === bottleId)) {
        setView({ kind: 'bottle', id: bottleId, fromRoute: null });
        refit(bottleId);
      }
      return;
    }
    const b = list.find((x) => x.id === bottleId);
    if (!b) return;
    const key = routeKeyOf(b);
    const group = b.outcome ? [b] : (groups.get(key) ?? [b]);
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
  const subline = isPublic
    ? publicOcean.loading && !publicOcean.data
      ? 'Charting…'
      : publicList.length === 0
        ? 'Nothing adrift right now'
        : `${publicList.length} ${publicList.length === 1 ? 'bottle' : 'bottles'} adrift · tap one`
    : bottles.loading && !bottles.data
      ? 'Charting…'
      : list.length === 0
        ? 'Nothing at sea'
        : `${synced ? `Synced ${formatTime(synced)} · ` : ''}${list.length === 1 ? 'tap the bottle' : 'tap a bottle or route'}`;

  const loadError = isPublic ? publicOcean.error : (bottles.error ?? chart.error);

  return (
    <div className="world-screen two-pane" data-mode={mode}>
      <div className="world-layer">
        <OceanMap
          handle={mapHandle}
          routes={routes}
          anchors={isPublic ? [] : anchors}
          harbors={harbors}
          watchIds={isPublic ? [] : sunkIds}
          onSeen={onSeen}
          ariaLabel={isPublic ? 'Public ocean chart' : 'Private ocean chart'}
          selectedRouteIds={selectedRouteIds}
          onSelectRoute={selectFromMap}
          phase={phase}
          weather={weather}
          paused={viewing !== null}
          fitKey={fitKey}
        />
      </div>
      <div className="scrim scrim-map" />
      <div className="scrim-map-header" />
      <header className="world-header">
        <div>
          <h1 className="t-title">
            {isPublic ? 'Public ocean' : atSeaCount > 0 ? 'At sea' : 'Ocean'}
          </h1>
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
          {onOpenInbox ? (
            <button
              type="button"
              className="glass-control inbox-control"
              aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
              onClick={onOpenInbox}
            >
              <Icon name="inbox" size={18} />
              {unread > 0 ? (
                <span className="inbox-count" aria-hidden>
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </button>
          ) : null}
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
      {/* Private / Public: the same map component over two data modes. Navigation stays put. */}
      <div className="mode-switch" role="group" aria-label="Map mode">
        <button
          type="button"
          className={mode === 'private' ? 'mode-option active' : 'mode-option'}
          aria-pressed={mode === 'private'}
          onClick={() => switchMode('private')}
        >
          Private
        </button>
        <button
          type="button"
          className={mode === 'public' ? 'mode-option active' : 'mode-option'}
          aria-pressed={mode === 'public'}
          onClick={() => switchMode('public')}
        >
          Public
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

      {view.kind === 'clean' && (isPublic ? publicList.length : list.length) > 0 && !viewing ? (
        <p className="hint-pill" aria-hidden>
          {isPublic ? 'Tap a bottle adrift' : 'Tap a bottle to follow its journey'}
        </p>
      ) : null}
      {isPublic ? (
        publicOcean.loading && !publicOcean.data ? (
          <section className="sheet" aria-label="Public ocean">
            <Skeleton />
          </section>
        ) : publicOcean.error ? (
          <section className="sheet" aria-label="Public ocean">
            <ErrorNote error={publicOcean.error} />
          </section>
        ) : view.kind === 'bottle' && (currentPublic || claimedIds.includes(view.id)) ? (
          <section className="sheet" aria-label="Adrift bottle">
            {currentPublic ? (
              <PublicCard
                bottle={currentPublic}
                busy={publicBusy}
                error={publicError}
                onClose={close}
                onPassport={currentPublic.mine ? () => onOpenPassport(currentPublic.id) : null}
                onRead={currentPublic.mine ? () => void readOwn(currentPublic.id) : null}
                onOpen={currentPublic.mine ? null : () => void openFound(currentPublic.id)}
              />
            ) : (
              <UnavailableCard why={unavailableWhy[view.id] ?? 'already_opened'} onClose={close} />
            )}
          </section>
        ) : publicList.length === 0 ? (
          // After the unavailable card: someone who just lost a race, or whose bottle expired
          // under them, is told why before the map is called empty.
          <section className="sheet" aria-label="Public ocean">
            <div className="stack">
              <h2 className="t-display-sm">Nothing adrift</h2>
              <p className="t-meta" style={{ fontSize: 13.5 }}>
                Bottles swept off course in a storm drift here, for anyone to see.
              </p>
            </div>
          </section>
        ) : null
      ) : bottles.loading && !bottles.data ? (
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
            <ErrorNote error={loadError} />
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
                  {weatherOf(b.id) === 'storm' ? <StormChip /> : <StatusChip state={b.state} />}
                </button>
              </li>
            ))}
          </ul>
          <ErrorNote error={loadError} />
        </section>
      ) : view.kind === 'bottle' && current ? (
        <section className="sheet" aria-label="Journey">
          <JourneyCard
            bottle={current}
            weather={weatherOf(current.id)}
            onViewAtSea={current.state === 'at_sea' ? () => setViewing(current.id) : null}
            onBack={
              view.fromRoute ? () => setView({ kind: 'route', routeKey: view.fromRoute! }) : null
            }
            onClose={close}
            onPassport={() => onOpenPassport(current.id)}
          />
          <ErrorNote error={loadError} />
        </section>
      ) : loadError ? (
        <section className="sheet" aria-label="Journey">
          <ErrorNote error={loadError} />
        </section>
      ) : null}
      {reading ? (
        <LetterModal
          letter={reading.letter}
          justOpened={reading.justOpened}
          provenance={reading.provenance}
          oneTime={reading.letter.bottle.source === 'public'}
          onClose={closeReader}
        />
      ) : null}
      {viewing ? (
        <SeaViewer
          bottle={viewingBottle}
          weather={viewingBottle ? weatherOf(viewingBottle.id) : 'calm'}
          // The sky out there, not the sky here: the bottle's own solar time decides it.
          // The development sky switch still previews both lightings.
          phase={
            viewingBottle && phaseOverride === 'auto'
              ? solarPhaseAt(nowMs, viewingBottle.nightOffsetMinutes * 60_000)
              : phase
          }
          onBack={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}

// "In a storm" states the weather in words, so nothing depends on colour or an icon alone.
function StormChip() {
  return (
    <span
      className="status-chip storm-chip"
      title="Simulated weather in this bottle's own night at sea"
    >
      <span aria-hidden>▲</span>
      In a storm
    </span>
  );
}

function JourneyCard({
  bottle,
  weather,
  onBack,
  onClose,
  onPassport,
  onViewAtSea,
}: {
  bottle: SentBottleSummaryDto;
  weather: 'calm' | 'storm';
  onBack: (() => void) | null;
  onClose: () => void;
  onPassport: () => void;
  onViewAtSea: (() => void) | null;
}) {
  const storm = weather === 'storm';
  const passages = Math.max(1, bottle.route.nodeIds.length - 1);
  const pct = Math.round(bottle.position.progress * 100);
  const live = bottle.state === 'at_sea';
  const outcome = bottle.outcome;
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
        {outcome ? (
          <OutcomeChip reason={outcome.reason} />
        ) : storm ? (
          <StormChip />
        ) : (
          <StatusChip state={bottle.state} />
        )}
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
        {outcome ? (
          <div className="stat">
            <div className="t-eyebrow">{outcome.reason === 'sunk' ? 'Sank' : 'Lost'}</div>
            <div className="t-stat t-stat-date">{formatDate(outcome.at)}</div>
          </div>
        ) : (
          <div className="stat">
            <div className="t-eyebrow">Water</div>
            <div className="t-stat" style={storm ? { color: '#f0ddae' } : undefined}>
              {live ? (storm ? 'Rough' : 'Calm') : '—'}
            </div>
          </div>
        )}
      </div>
      {outcome?.reason === 'sunk' ? (
        <p className="card-note">
          It went down here, in a storm. The letter stays in your passport.
        </p>
      ) : storm ? (
        <p className="card-note">This bottle is in weather. Your other bottles are unaffected.</p>
      ) : null}
      {/* The action row (handoff v2.0): the sea viewer is reached only from here, never from a
          marker tap, and only while the bottle is still at sea. */}
      <div className="action-row" style={{ marginTop: 14 }}>
        {onViewAtSea ? (
          <button
            type="button"
            className="btn-primary"
            aria-label="View this bottle at sea"
            onClick={onViewAtSea}
          >
            <Icon name="viewAtSea" size={18} />
            View at sea
          </button>
        ) : null}
        <button type="button" className="btn-ghost" onClick={onPassport}>
          <Icon name="passport" size={14} />
          Passport
        </button>
      </div>
    </div>
  );
}

// The public ocean card: the strict public projection only. A sender recognises their own
// bottle by the pennant and the "Your bottle" title; nobody is told whose the others are.
function PublicCard({
  bottle,
  busy,
  error,
  onClose,
  onPassport,
  onRead,
  onOpen,
}: {
  bottle: PublicBottleDto;
  busy: boolean;
  error: Error | null;
  onClose: () => void;
  onPassport: (() => void) | null;
  onRead: (() => void) | null;
  onOpen: (() => void) | null;
}) {
  return (
    <div>
      <div className="row">
        <span className={`avatar glass${bottle.mine ? ' pennant-avatar' : ''}`} aria-hidden>
          {bottle.mine ? '⚑' : '◦'}
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="t-card-title">{bottle.mine ? 'Your bottle' : 'A lost bottle'}</div>
          <div className="t-meta">
            Adrift since {formatDate(bottle.lostAt)} · on the map until{' '}
            {formatDate(bottle.expiresAt)}
          </div>
        </div>
        <button type="button" className="glass-control" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <OutcomeChip reason="adrift" />
      </div>
      <p className="card-note">
        {bottle.mine
          ? 'Swept off course in a storm. Its delivery is over; it drifts here for anyone to see.'
          : 'Swept off course in a storm. It drifts here, sealed.'}
      </p>
      {onOpen ? (
        // Said plainly before the action, because it cannot be undone and it is the one thing
        // that changes for everybody else looking at this map.
        <p className="card-note warn">
          Opening this bottle will remove it from the public map. You can read the letter once;
          after you close it, it cannot be opened again.
        </p>
      ) : null}
      <div className="action-row" style={{ marginTop: 14 }}>
        {onOpen ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={onOpen}>
            <Icon name="letters" size={16} />
            {busy ? 'Opening…' : 'Open bottle'}
          </button>
        ) : null}
        {onRead ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={onRead}>
            <Icon name="letters" size={16} />
            {busy ? 'Opening…' : 'Read your letter'}
          </button>
        ) : null}
        {onPassport ? (
          <button type="button" className="btn-ghost" onClick={onPassport}>
            <Icon name="passport" size={14} />
            Passport
          </button>
        ) : null}
      </div>
      {onRead ? (
        <p className="t-meta" style={{ marginTop: 10 }}>
          Reading your own letter changes nothing: the bottle stays adrift on the map.
        </p>
      ) : null}
      <ErrorNote error={error} />
    </div>
  );
}

// Somebody else opened this bottle first. It is gone from the map, and nothing about it —
// least of all a word of the letter — is shown here.
function UnavailableCard({ why, onClose }: { why: string; onClose: () => void }) {
  const line =
    why === 'listing_expired'
      ? 'Its 72 hours on the public map are over'
      : why === 'reading_closed'
        ? 'You have already read this letter'
        : 'Another traveller opened this bottle first';
  return (
    <div>
      <div className="row">
        <span className="avatar glass" aria-hidden>
          ◦
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="t-card-title">No longer adrift</div>
          <div className="t-meta">{line}</div>
        </div>
        <button type="button" className="glass-control" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <p className="card-note">
        {why === 'listing_expired'
          ? 'Nobody opened it in time. It has left the public map for good.'
          : why === 'reading_closed'
            ? 'A found letter can be read once. It stays with the person who sent it.'
            : 'Its letter belongs to whoever found it. The public ocean has other bottles.'}
      </p>
    </div>
  );
}
