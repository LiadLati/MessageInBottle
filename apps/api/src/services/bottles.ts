import { and, asc, desc, eq } from 'drizzle-orm';
import {
  AgingProfileSchema,
  type AgingProfile,
  type JourneyEventDto,
  type LetterFont,
  type OpenedLetterDto,
  type OutcomeDto,
  type ReceivedLetterDto,
  type SentBottleDto,
  type SentBottleSummaryDto,
  type ShoreBottleDto,
  type ShoreResponse,
} from '@mib/shared';
import * as t from '../db/schema.js';
import {
  geoPointAlongPath,
  pathGeoPoints,
  pathPoints,
  pointAlongPath,
  plannedArrivalAt,
  progressAt,
} from '../domain/routing.js';
import { deriveAgingProfile } from '../domain/aging.js';
import { conflict, notFound } from '../lib/errors.js';
import { loadGraphVersion, toShoreDto } from './chart.js';
import type { AppContext, AuthUser } from './context.js';
import { activePlan, appendEvent, releaseCapacityOnce, transitionBottle } from './journey.js';
import { outcomeVisibility, publicOpeningOf } from './outcomes.js';

type BottleRow = typeof t.bottles.$inferSelect;
type PlanRow = typeof t.routePlans.$inferSelect;

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

// A plan is rendered with the graph version it was planned on, so a newer active graph never
// moves a released bottle (spec §7, §11 inv. 7).
function graphForPlan(ctx: AppContext, plan: PlanRow) {
  return loadGraphVersion(ctx.db, plan.graphVersion);
}

function sentSummary(
  ctx: AppContext,
  bottle: BottleRow,
  plan: PlanRow,
  now: number,
): SentBottleSummaryDto {
  const graph = graphForPlan(ctx, plan);
  const points = pathPoints(graph, plan.nodeIds);
  const geoPoints = pathGeoPoints(graph, plan.nodeIds);
  // A lost bottle stays exactly where the sea ended its journey (the persisted outcome);
  // everything else is either still moving or has reached the end of its route.
  const outcome = outcomeOf(bottle);
  const progress = bottle.state === 'at_sea' ? progressAt(plan, now) : (outcome?.progress ?? 1);
  // Elapsed time freezes when the journey completes at opening (spec §7, §10.3).
  const completedAt = bottle.completedAt ?? bottle.openedAt;
  const elapsedEnd = completedAt ?? now;
  return {
    id: bottle.id,
    state: bottle.state as SentBottleSummaryDto['state'],
    version: bottle.version,
    recipient: { id: bottle.recipientId, displayName: bottle.recipientNameSnapshot },
    originShore: { id: bottle.originShoreId, name: bottle.originShoreName },
    destinationShore: { id: bottle.destinationShoreId, name: bottle.destinationShoreName },
    releasedAt: iso(bottle.releasedAt),
    deliveredAt: isoOrNull(bottle.deliveredAt),
    openedAt: isoOrNull(bottle.openedAt),
    elapsedMs: Math.max(0, elapsedEnd - bottle.releasedAt),
    elapsedIsLive: completedAt === null,
    plannedArrivalAt: iso(plannedArrivalAt(plan)),
    route: {
      version: plan.planVersion,
      nodeIds: plan.nodeIds,
      points,
      geoPoints,
      totalLength: plan.totalLength,
      plannedDurationMs: plan.plannedDurationMs,
    },
    position: outcome
      ? { ...outcome.position, progress, asOf: iso(now) }
      : {
          point: pointAlongPath(points, progress),
          geo: geoPoints ? geoPointAlongPath(geoPoints, progress) : null,
          progress,
          asOf: iso(now),
        },
    outcome,
    visibility: outcome ? outcomeVisibility(ctx.db, bottle.senderId, bottle.id) : null,
    serverTime: iso(now),
  };
}

function outcomeOf(bottle: BottleRow): OutcomeDto | null {
  if (
    bottle.state !== 'lost' ||
    bottle.outcomeAt === null ||
    bottle.outcomeProgress === null ||
    bottle.outcomeChartX === null ||
    bottle.outcomeChartY === null
  ) {
    return null;
  }
  return {
    reason: bottle.lossReason as OutcomeDto['reason'],
    at: iso(bottle.outcomeAt),
    position: {
      point: { x: bottle.outcomeChartX, y: bottle.outcomeChartY },
      geo:
        bottle.outcomeLng !== null && bottle.outcomeLat !== null
          ? { lng: bottle.outcomeLng, lat: bottle.outcomeLat }
          : null,
    },
    progress: bottle.outcomeProgress,
  };
}

function eventsFor(ctx: AppContext, bottleId: string): JourneyEventDto[] {
  return ctx.db
    .select()
    .from(t.journeyEvents)
    .where(eq(t.journeyEvents.bottleId, bottleId))
    .orderBy(asc(t.journeyEvents.seq))
    .all()
    .map((e) => ({
      seq: e.seq,
      type: e.type as JourneyEventDto['type'],
      occurredAt: iso(e.occurredAt),
      payload: e.payload,
    }));
}

export function listSentBottles(ctx: AppContext, user: AuthUser): SentBottleSummaryDto[] {
  const now = ctx.clock.now();
  const rows = ctx.db
    .select()
    .from(t.bottles)
    .where(eq(t.bottles.senderId, user.id))
    .orderBy(desc(t.bottles.releasedAt))
    .all();
  return rows.flatMap((bottle) => {
    const plan = activePlan(ctx.db, bottle.id);
    return plan ? [sentSummary(ctx, bottle, plan, now)] : [];
  });
}

// Private sender passport. Only the sender can read it; anyone else gets 404 (not 403) so the
// bottle's existence is not disclosed (spec §7: "knowing a bottle ID is not authorization").
export function getSentBottle(ctx: AppContext, user: AuthUser, bottleId: string): SentBottleDto {
  const bottle = ctx.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
  if (!bottle || bottle.senderId !== user.id) throw notFound('bottle');
  const plan = activePlan(ctx.db, bottle.id);
  if (!plan) throw notFound('bottle');
  const letter = ctx.db.select().from(t.letters).where(eq(t.letters.id, bottle.letterId)).get()!;
  return {
    ...sentSummary(ctx, bottle, plan, ctx.clock.now()),
    letter: {
      text: letter.text,
      font: letter.originalFont as LetterFont,
      characters: letter.characters,
    },
    events: eventsFor(ctx, bottle.id),
  };
}

// The reader's own view of a letter they hold. A bottle **found adrift** carries no sender and
// no origin shore: the public ocean never attributes a letter, and opening one must not reveal
// more than the map did (sender attribution in public discovery is spec D03, still open).
function receivedLetter(
  bottle: BottleRow,
  source: 'shore' | 'public',
  foundAt: number | null = null,
): ReceivedLetterDto {
  if (source === 'public') {
    const endedAt = bottle.outcomeAt ?? bottle.releasedAt;
    return {
      id: bottle.id,
      source,
      state: bottle.state as ReceivedLetterDto['state'],
      sender: null,
      originShore: null,
      releasedAt: iso(bottle.releasedAt),
      deliveredAt: null,
      openedAt: isoOrNull(foundAt),
      journeyDurationMs: Math.max(0, endedAt - bottle.releasedAt),
    };
  }
  return { ...shoreBottle(bottle), source };
}

function shoreBottle(bottle: BottleRow): ShoreBottleDto {
  const deliveredAt = bottle.deliveredAt!;
  return {
    id: bottle.id,
    state: bottle.state as 'delivered' | 'opened',
    sender: { id: bottle.senderId, displayName: bottle.senderNameSnapshot },
    originShore: { id: bottle.originShoreId, name: bottle.originShoreName },
    releasedAt: iso(bottle.releasedAt),
    deliveredAt: iso(deliveredAt),
    openedAt: isoOrNull(bottle.openedAt),
    journeyDurationMs: deliveredAt - bottle.releasedAt,
  };
}

// The recipient's shore lists only bottles whose arrival the server has committed and that are
// still sealed: opening moves a bottle to the received archive (listReceivedLetters). Bottles
// still at sea are filtered by the query itself, not by a client-side flag (spec §7).
export function getMyShore(ctx: AppContext, user: AuthUser): ShoreResponse {
  const shore = user.shoreId
    ? ctx.db.select().from(t.shores).where(eq(t.shores.id, user.shoreId)).get()
    : null;
  const rows = ctx.db
    .select()
    .from(t.bottles)
    .where(
      and(
        eq(t.bottles.recipientId, user.id),
        eq(t.bottles.state, 'delivered'),
        eq(t.bottles.moderationStatus, 'clear'),
      ),
    )
    .orderBy(desc(t.bottles.deliveredAt))
    .all();
  return { shore: shore ? toShoreDto(shore) : null, bottles: rows.map(shoreBottle) };
}

// Everything the user holds, newest first: letters that arrived on their shore and were opened,
// and bottles they found adrift and opened in the public ocean. The rows are the same bottles —
// nothing is deleted or rewritten when a bottle leaves the shore or the public map.
export function listReceivedLetters(ctx: AppContext, user: AuthUser): ReceivedLetterDto[] {
  const fromShore = ctx.db
    .select()
    .from(t.bottles)
    .where(
      and(
        eq(t.bottles.recipientId, user.id),
        eq(t.bottles.state, 'opened'),
        eq(t.bottles.moderationStatus, 'clear'),
      ),
    )
    .all()
    .map((b) => ({ at: b.openedAt ?? b.releasedAt, dto: receivedLetter(b, 'shore') }));
  const found = ctx.db
    .select({ bottle: t.bottles, openedAt: t.publicOpenings.openedAt })
    .from(t.publicOpenings)
    .innerJoin(t.bottles, eq(t.bottles.id, t.publicOpenings.bottleId))
    .where(and(eq(t.publicOpenings.openedById, user.id), eq(t.bottles.moderationStatus, 'clear')))
    .all()
    .map((r) => ({ at: r.openedAt, dto: receivedLetter(r.bottle, 'public', r.openedAt) }));
  return [...fromShore, ...found].sort((a, b) => b.at - a.at).map((r) => r.dto);
}

export function openedLetter(
  ctx: AppContext,
  bottle: BottleRow,
  source: 'shore' | 'public' = 'shore',
  foundAt: number | null = null,
): OpenedLetterDto {
  const letter = ctx.db.select().from(t.letters).where(eq(t.letters.id, bottle.letterId)).get()!;
  return {
    bottle: receivedLetter(bottle, source, foundAt),
    letter: {
      text: letter.text,
      font: letter.originalFont as LetterFont,
      characters: letter.characters,
    },
    aging: agingFor(ctx, bottle),
  };
}

// The frozen aging profile if the journey stored one (arrival, or a public opening). A bottle
// that ended at sea and has not been opened by anyone has none yet: derive the same reproducible
// parameters from the journey, without writing anything — reading never changes a bottle.
function agingFor(ctx: AppContext, bottle: BottleRow): AgingProfile {
  if (bottle.agingProfile) return AgingProfileSchema.parse(bottle.agingProfile);
  const plan = activePlan(ctx.db, bottle.id);
  return deriveAgingProfile({
    bottleId: bottle.id,
    releasedAt: bottle.releasedAt,
    deliveredAt: bottle.outcomeAt ?? bottle.completedAt ?? ctx.clock.now(),
    plannedDurationMs: plan?.plannedDurationMs ?? 0,
  });
}

// Opening commits Delivered -> Opened, releases the destination slot exactly once and completes
// the journey (spec §5.2: no keep/re-release choice). Re-opening an opened letter is a plain read.
export function openBottle(ctx: AppContext, user: AuthUser, bottleId: string): OpenedLetterDto {
  const now = ctx.clock.now();
  const result = ctx.db.transaction((tx) => {
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
    if (!bottle || bottle.recipientId !== user.id || bottle.moderationStatus !== 'clear')
      throw notFound('bottle');
    if (bottle.state === 'opened') return bottle;
    if (bottle.state !== 'delivered') throw notFound('bottle');
    const moved = transitionBottle(tx, bottle, 'opened', { openedAt: now, completedAt: now });
    if (!moved) throw conflict('stale_state', 'bottle changed, please refresh');
    releaseCapacityOnce(tx, bottleId, now);
    appendEvent(tx, bottleId, 'opened', now, {});
    return tx.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get()!;
  });
  return openedLetter(ctx, result);
}

// Re-reading a letter the caller already holds. Two ways to hold one: it arrived on their shore
// and they opened it, or they found it adrift and opened it. Anyone else gets 404 — knowing an
// id is not authorization (spec §7).
export function readOpenedLetter(
  ctx: AppContext,
  user: AuthUser,
  bottleId: string,
): OpenedLetterDto {
  const bottle = ctx.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
  if (!bottle || bottle.moderationStatus !== 'clear') throw notFound('letter');
  const opening = publicOpeningOf(ctx.db, bottleId);
  if (opening && opening.openedById === user.id) {
    return openedLetter(ctx, bottle, 'public', opening.openedAt);
  }
  if (bottle.recipientId !== user.id || bottle.state !== 'opened') throw notFound('letter');
  return openedLetter(ctx, bottle);
}

// The sender reading their own letter. Pure read: it never claims the bottle, never takes it off
// the public map and never touches the outcome, so a sender may do it as often as they like.
export function readOwnLetter(ctx: AppContext, user: AuthUser, bottleId: string): OpenedLetterDto {
  const bottle = ctx.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
  if (!bottle || bottle.senderId !== user.id) throw notFound('bottle');
  return openedLetter(ctx, bottle, 'shore');
}
