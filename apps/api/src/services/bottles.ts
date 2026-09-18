import { and, asc, desc, eq } from 'drizzle-orm';
import {
  AgingProfileSchema,
  type JourneyEventDto,
  type LetterFont,
  type OpenedLetterDto,
  type OutcomeDto,
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
import { conflict, notFound } from '../lib/errors.js';
import { loadGraphVersion, toShoreDto } from './chart.js';
import type { AppContext, AuthUser } from './context.js';
import { activePlan, appendEvent, releaseCapacityOnce, transitionBottle } from './journey.js';
import { outcomeVisibility } from './outcomes.js';

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

// Everything the user has opened, newest first. The rows are the same bottles: nothing is
// deleted or rewritten when a bottle leaves the shore.
export function listReceivedLetters(ctx: AppContext, user: AuthUser): ShoreBottleDto[] {
  return ctx.db
    .select()
    .from(t.bottles)
    .where(
      and(
        eq(t.bottles.recipientId, user.id),
        eq(t.bottles.state, 'opened'),
        eq(t.bottles.moderationStatus, 'clear'),
      ),
    )
    .orderBy(desc(t.bottles.openedAt))
    .all()
    .map(shoreBottle);
}

function deliveredBottleForRecipient(ctx: AppContext, user: AuthUser, bottleId: string): BottleRow {
  const bottle = ctx.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
  if (
    !bottle ||
    bottle.recipientId !== user.id ||
    (bottle.state !== 'delivered' && bottle.state !== 'opened') ||
    bottle.moderationStatus !== 'clear'
  ) {
    throw notFound('bottle');
  }
  return bottle;
}

function openedLetter(ctx: AppContext, bottle: BottleRow): OpenedLetterDto {
  const letter = ctx.db.select().from(t.letters).where(eq(t.letters.id, bottle.letterId)).get()!;
  const aging = AgingProfileSchema.parse(bottle.agingProfile);
  return {
    bottle: shoreBottle(bottle),
    letter: {
      text: letter.text,
      font: letter.originalFont as LetterFont,
      characters: letter.characters,
    },
    aging,
  };
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

export function readOpenedLetter(
  ctx: AppContext,
  user: AuthUser,
  bottleId: string,
): OpenedLetterDto {
  const bottle = deliveredBottleForRecipient(ctx, user, bottleId);
  if (bottle.state !== 'opened') throw notFound('letter');
  return openedLetter(ctx, bottle);
}
