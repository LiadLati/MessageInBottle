import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  AgingProfileSchema,
  type JourneyEventDto,
  type LetterFont,
  type OpenedLetterDto,
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
import { geoOf, loadActiveGraph, toShoreDto } from './chart.js';
import type { AppContext, AuthUser } from './context.js';
import { activePlan, appendEvent, releaseCapacityOnce, transitionBottle } from './journey.js';

type BottleRow = typeof t.bottles.$inferSelect;
type PlanRow = typeof t.routePlans.$inferSelect;

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

function graphForPlan(ctx: AppContext, plan: PlanRow) {
  const graph = loadActiveGraph(ctx.db);
  if (graph.version !== plan.graphVersion) {
    // Historic graph versions are kept in the DB; loading them lazily is a stage-4 concern.
    const nodes = ctx.db
      .select()
      .from(t.routeNodes)
      .where(eq(t.routeNodes.graphVersion, plan.graphVersion))
      .all();
    for (const n of nodes) {
      graph.nodes.set(n.id, {
        id: n.id,
        kind: n.kind,
        shoreId: n.shoreId,
        position: { x: n.chartX, y: n.chartY },
        geo: geoOf(n),
      });
    }
  }
  return graph;
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
  const progress = bottle.state === 'at_sea' ? progressAt(plan, now) : 1;
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
    position: {
      point: pointAlongPath(points, progress),
      geo: geoPoints ? geoPointAlongPath(geoPoints, progress) : null,
      progress,
      asOf: iso(now),
    },
    serverTime: iso(now),
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

// The recipient's shore lists only bottles whose arrival the server has committed. Bottles that
// are still at sea are filtered by the query itself, not by a client-side flag (spec §7).
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
        inArray(t.bottles.state, ['delivered', 'opened']),
        eq(t.bottles.moderationStatus, 'clear'),
      ),
    )
    .orderBy(desc(t.bottles.deliveredAt))
    .all();
  return { shore: shore ? toShoreDto(shore) : null, bottles: rows.map(shoreBottle) };
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
