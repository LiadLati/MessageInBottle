import { and, desc, eq, isNull } from 'drizzle-orm';
import type { OutcomeVisibilityDto, PublicBottleDto } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import {
  geoPointAlongPath,
  pathGeoPoints,
  pathPoints,
  plannedArrivalAt,
  pointAlongPath,
  progressAt,
} from '../domain/routing.js';
import { badRequest, notFound } from '../lib/errors.js';
import { loadGraphVersion } from './chart.js';
import type { AppContext, AuthUser } from './context.js';
import { isBlockedEitherWay } from './friends.js';
import { activePlan, appendEvent, releaseCapacityOnce, transitionBottle } from './journey.js';
import { enqueueNotification } from './notifications.js';

// Real journey outcomes (spec §9, §11). Everything here is server-owned and persisted once:
// the position is computed from the persisted plan at the outcome instant and written to the
// bottle row, so refreshing, viewing, opening the sea viewer or retrying a job can never move
// it or roll it again. Nothing here is driven by the cosmetic weather schedule.
//
// What *triggers* a loss is deliberately not decided in code: spec D08 (storm frequency,
// exposure rules, loss probabilities, the adrift/sunk split and when storms resolve) is open.
// Until it is approved, the only caller is the development control, and no worker ever loses
// a bottle on its own. See docs/ARCHITECTURE.md → "Journey outcomes".

export type LossOutcome = 'adrift' | 'sunk';

export interface CommitLossResult {
  committed: boolean;
  // Why nothing changed: the bottle had already left the water (arrived, lost, ...).
  reason: 'committed' | 'already_resolved' | 'arrival_due' | 'not_at_sea';
}

const OUTCOME_MESSAGES: Record<LossOutcome, (recipient: string) => string> = {
  adrift: (r) => `Your bottle to ${r} was swept off course in a storm. It is adrift now.`,
  sunk: (r) => `Your bottle to ${r} went down in a storm. It is lost at sea.`,
};

// Commits At sea → Lost for one bottle at `at`. Idempotent and race-safe: the optimistic
// transition (state + version) means that if arrival committed first this returns
// `already_resolved`, and a second call for a lost bottle changes nothing — no second event,
// notification or slot release. Arrival and loss can therefore never both commit.
export function commitLoss(
  ctx: AppContext,
  bottleId: string,
  reason: LossOutcome,
  at: number,
): CommitLossResult {
  return ctx.db.transaction((tx) => {
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
    if (!bottle) throw notFound('bottle');
    if (bottle.state === 'lost') return { committed: false, reason: 'already_resolved' };
    if (bottle.state !== 'at_sea') return { committed: false, reason: 'not_at_sea' };
    const plan = activePlan(tx, bottleId);
    if (!plan) return { committed: false, reason: 'not_at_sea' };
    // A bottle whose arrival is due belongs to the shore, not to the sea: the worker's next tick
    // delivers it, and the loss is refused rather than racing that.
    if (plannedArrivalAt(plan) <= at) return { committed: false, reason: 'arrival_due' };

    const graph = loadGraphVersion(tx, plan.graphVersion);
    const points = pathPoints(graph, plan.nodeIds);
    const geoPoints = pathGeoPoints(graph, plan.nodeIds);
    const progress = progressAt(plan, at);
    const point = pointAlongPath(points, progress);
    const geo = geoPoints ? geoPointAlongPath(geoPoints, progress) : null;

    const moved = transitionBottle(tx, bottle, 'lost', {
      completedAt: at,
      lossReason: reason,
      outcomeAt: at,
      outcomeProgress: progress,
      outcomeChartX: Math.round(point.x),
      outcomeChartY: Math.round(point.y),
      outcomeLng: geo?.lng ?? null,
      outcomeLat: geo?.lat ?? null,
    });
    if (!moved) return { committed: false, reason: 'already_resolved' };
    // The destination slot is freed exactly once; the route plan row is kept as the journey's
    // snapshot (the passport still shows the planned passages), only the state ends it.
    releaseCapacityOnce(tx, bottleId, at);
    appendEvent(tx, bottleId, 'lost', at, {
      reason,
      progress,
      position: { point: { x: Math.round(point.x), y: Math.round(point.y) }, geo },
      routeVersion: plan.planVersion,
    });
    // Only the sender learns of it. The recipient never knew a bottle was coming (spec §14), and
    // with the journey over no arrival notification can follow: arrival needs state = at_sea.
    enqueueNotification(tx, {
      userId: bottle.senderId,
      type: 'journey_event',
      bottleId,
      dedupeKey: `lost:${bottleId}`,
      message: OUTCOME_MESSAGES[reason](bottle.recipientNameSnapshot),
      now: at,
    });
    return { committed: true, reason: 'committed' };
  });
}

// Development-only entry point: the caller must own the bottle.
export function devLoseBottle(
  ctx: AppContext,
  user: AuthUser,
  bottleId: string,
  reason: LossOutcome,
): CommitLossResult {
  const bottle = ctx.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
  if (!bottle || bottle.senderId !== user.id) throw notFound('bottle');
  const result = commitLoss(ctx, bottleId, reason, ctx.clock.now());
  if (result.reason === 'arrival_due')
    throw badRequest('arrival_due', 'this bottle has already reached its shore');
  return result;
}

// ---------- public ocean ----------

// Bottles adrift in the public ocean, for any signed-in user. The projection is the strict
// PublicBottleSchema: no letter, sender, recipient, destination or route ever leaves the server
// through here. Bottles between blocked accounts are hidden in both directions, and moderation
// applies as everywhere else.
export function listPublicOcean(ctx: AppContext, viewer: AuthUser): PublicBottleDto[] {
  const rows = ctx.db
    .select()
    .from(t.bottles)
    .where(
      and(
        eq(t.bottles.state, 'lost'),
        eq(t.bottles.lossReason, 'adrift'),
        eq(t.bottles.moderationStatus, 'clear'),
      ),
    )
    .orderBy(desc(t.bottles.outcomeAt))
    .all();
  const out: PublicBottleDto[] = [];
  for (const b of rows) {
    if (b.outcomeLng === null || b.outcomeLat === null || b.outcomeAt === null) continue;
    if (b.senderId !== viewer.id && isBlockedEitherWay(ctx.db, viewer.id, b.senderId)) continue;
    out.push({
      id: b.id,
      reason: 'adrift',
      lostAt: new Date(b.outcomeAt).toISOString(),
      position: { geo: { lng: b.outcomeLng, lat: b.outcomeLat } },
      mine: b.senderId === viewer.id,
    });
  }
  return out;
}

// ---------- private marker visibility ----------

export function outcomeVisibility(
  db: DbOrTx,
  userId: string,
  bottleId: string,
): OutcomeVisibilityDto {
  const row = db
    .select()
    .from(t.bottleOutcomeViews)
    .where(
      and(eq(t.bottleOutcomeViews.userId, userId), eq(t.bottleOutcomeViews.bottleId, bottleId)),
    )
    .get();
  if (!row) return { seenAt: null, acknowledgedAt: null };
  return {
    seenAt: row.seenAt === null ? null : new Date(row.seenAt).toISOString(),
    acknowledgedAt: row.acknowledgedAt === null ? null : new Date(row.acknowledgedAt).toISOString(),
  };
}

function ownLostBottle(ctx: AppContext, user: AuthUser, bottleId: string) {
  const bottle = ctx.db.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
  if (!bottle || bottle.senderId !== user.id) throw notFound('bottle');
  if (bottle.state !== 'lost') throw badRequest('not_lost', 'this bottle has no outcome marker');
  return bottle;
}

// The marker was actually displayed inside the sender's visible viewport. First sighting wins;
// later calls are no-ops, so the timestamp is the true first time it was seen.
export function markOutcomeSeen(ctx: AppContext, user: AuthUser, bottleId: string) {
  ownLostBottle(ctx, user, bottleId);
  const now = ctx.clock.now();
  ctx.db
    .insert(t.bottleOutcomeViews)
    .values({ userId: user.id, bottleId, seenAt: now, acknowledgedAt: null })
    .onConflictDoUpdate({
      target: [t.bottleOutcomeViews.userId, t.bottleOutcomeViews.bottleId],
      set: { seenAt: now },
      setWhere: isNull(t.bottleOutcomeViews.seenAt),
    })
    .run();
  return outcomeVisibility(ctx.db, user.id, bottleId);
}

// The sender left the private map after seeing the marker. Only a seen marker can be
// acknowledged: an off-screen marker that was merely fetched stays unseen and keeps showing.
export function acknowledgeOutcome(ctx: AppContext, user: AuthUser, bottleId: string) {
  ownLostBottle(ctx, user, bottleId);
  const now = ctx.clock.now();
  ctx.db
    .update(t.bottleOutcomeViews)
    .set({ acknowledgedAt: now })
    .where(
      and(
        eq(t.bottleOutcomeViews.userId, user.id),
        eq(t.bottleOutcomeViews.bottleId, bottleId),
        isNull(t.bottleOutcomeViews.acknowledgedAt),
      ),
    )
    .run();
  return outcomeVisibility(ctx.db, user.id, bottleId);
}
