import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import {
  RISK_POLICY,
  type OpenedLetterDto,
  type OutcomeVisibilityDto,
  type PublicBottleDto,
} from '@mib/shared';
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
import { deriveAgingProfile } from '../domain/aging.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { openedLetter } from './bottles.js';
import { loadGraphVersion } from './chart.js';
import type { AppContext, AuthUser } from './context.js';
import { isBlockedEitherWay } from './friends.js';
import {
  activePlan,
  appendEvent,
  recipientName,
  releaseCapacityOnce,
  transitionBottle,
} from './journey.js';
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
  adrift: (r) => `The bottle you sent to ${r} was lost at sea and drifted into the public ocean.`,
  sunk: (r) => `The bottle you sent to ${r} sank at sea.`,
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
  return ctx.db.transaction((tx) => commitLossIn(ctx, tx, bottleId, reason, at));
}

// The loss itself, inside a transaction the caller owns: the risk worker records its decision
// and the loss it causes in one transaction, so the two can never disagree (audit ARCH-007).
export function commitLossIn(
  ctx: AppContext,
  tx: DbOrTx,
  bottleId: string,
  reason: LossOutcome,
  at: number,
): CommitLossResult {
  {
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
      // An adrift bottle is listed publicly for exactly 72 hours from this moment.
      publicDeadlineAt: reason === 'adrift' ? at + RISK_POLICY.publicListingMs : null,
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
      kind: reason === 'sunk' ? 'sent_sunk' : 'sent_adrift',
      bottleId,
      dedupeKey: `lost:${bottleId}`,
      message: OUTCOME_MESSAGES[reason](recipientName(bottle)),
      now: at,
    });
    return { committed: true, reason: 'committed' };
  }
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

// The single opening of a bottle found adrift, if anyone has opened it.
export function publicOpeningOf(db: DbOrTx, bottleId: string) {
  return (
    db.select().from(t.publicOpenings).where(eq(t.publicOpenings.bottleId, bottleId)).get() ?? null
  );
}

// Bottles adrift in the public ocean, for any signed-in user. The projection is the strict
// PublicBottleSchema: no letter, sender, recipient, destination or route ever leaves the server
// through here. Bottles between blocked accounts are hidden in both directions, moderation
// applies as everywhere else, and a bottle someone has opened is gone from the map for everyone.
export function listPublicOcean(ctx: AppContext, viewer: AuthUser): PublicBottleDto[] {
  const now = ctx.clock.now();
  const rows = ctx.db
    .select()
    .from(t.bottles)
    .leftJoin(t.publicOpenings, eq(t.publicOpenings.bottleId, t.bottles.id))
    .where(
      and(
        eq(t.bottles.state, 'lost'),
        eq(t.bottles.lossReason, 'adrift'),
        eq(t.bottles.moderationStatus, 'clear'),
        isNull(t.publicOpenings.bottleId),
        isNull(t.bottles.publicExpiredAt),
        // The deadline is enforced here even before the worker has recorded the expiry.
        gt(t.bottles.publicDeadlineAt, now),
      ),
    )
    .orderBy(desc(t.bottles.outcomeAt))
    .all()
    .map((r) => r.bottles);
  const out: PublicBottleDto[] = [];
  for (const b of rows) {
    if (b.outcomeLng === null || b.outcomeLat === null || b.outcomeAt === null) continue;
    if (b.publicDeadlineAt === null) continue;
    if (b.senderId !== viewer.id && isBlockedEitherWay(ctx.db, viewer.id, b.senderId)) continue;
    out.push({
      id: b.id,
      reason: 'adrift',
      lostAt: new Date(b.outcomeAt).toISOString(),
      position: { geo: { lng: b.outcomeLng, lat: b.outcomeLat } },
      mine: b.senderId === viewer.id,
      expiresAt: new Date(b.publicDeadlineAt).toISOString(),
    });
  }
  return out;
}

// Opening a bottle found adrift. One server-owned action, one transaction: the opening row is
// inserted (its primary key is the bottle id, so the insert itself picks the single winner of a
// race), the aging profile is frozen, the reading is recorded in the journey history and the
// sender is told once. From that moment the bottle is off the public map for everyone and the
// finder can read the letter; the journey outcome is untouched, so the sender keeps their
// letter, passport and Lost entry, and the intended recipient is never delivered to — the
// bottle is still `lost`, which no arrival path will touch.
//
// One reading, once (product decision 12, amended 2026-09-26): the letter is served in this
// response and never again — not on a second open, a refresh or a new session. A second open by
// the finder is a 409 `reading_closed`; for anybody else it is a 409 with no content whatsoever. This change deliberately adds nothing beyond reading: no rescue, no
// re-release, no further travel, no transfer of ownership.
export function openPublicBottle(
  ctx: AppContext,
  user: AuthUser,
  bottleId: string,
): OpenedLetterDto {
  const now = ctx.clock.now();
  const opened = ctx.db.transaction((tx) => {
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
    // Anything that is not an openable adrift bottle is simply "not found": the public map must
    // not become a way to probe for bottles.
    if (
      !bottle ||
      bottle.state !== 'lost' ||
      bottle.lossReason !== 'adrift' ||
      bottle.moderationStatus !== 'clear'
    ) {
      throw notFound('bottle');
    }
    if (isBlockedEitherWay(tx, user.id, bottle.senderId)) throw notFound('bottle');
    // The sender reads their own letter with their own action, which never claims the bottle.
    if (bottle.senderId === user.id) {
      throw badRequest('own_bottle', 'This is your own bottle, so reading it changes nothing.');
    }

    const existing = publicOpeningOf(tx, bottleId);
    if (existing) {
      if (existing.openedById !== user.id) {
        throw conflict('already_opened', 'Another traveller opened this bottle first.');
      }
      // The finder's one reading was served when they opened it; it is never served again.
      throw conflict('reading_closed', 'You have already read this letter.');
    }
    // Opening and expiry resolve under the same writer: at the deadline the bottle is gone.
    if (
      bottle.publicExpiredAt !== null ||
      bottle.publicDeadlineAt === null ||
      bottle.publicDeadlineAt <= now
    ) {
      throw conflict('listing_expired', 'This bottle is no longer on the public map.');
    }
    tx.insert(t.publicOpenings)
      .values({
        bottleId,
        openedById: user.id,
        openedAt: now,
        // No resumable window: the letter is served once, in this response.
        sessionExpiresAt: null,
        closedAt: null,
      })
      .onConflictDoNothing()
      .run();
    const winner = publicOpeningOf(tx, bottleId)!;
    if (winner.openedById !== user.id) {
      throw conflict('already_opened', 'Another traveller opened this bottle first.');
    }
    // Freeze the paper's appearance at the moment it was opened, exactly as arrival does.
    const plan = activePlan(tx, bottleId);
    if (!bottle.agingProfile) {
      tx.update(t.bottles)
        .set({
          agingProfile: deriveAgingProfile({
            bottleId,
            releasedAt: bottle.releasedAt,
            deliveredAt: bottle.outcomeAt ?? now,
            plannedDurationMs: plan?.plannedDurationMs ?? 0,
          }),
        })
        .where(eq(t.bottles.id, bottleId))
        .run();
    }
    appendEvent(tx, bottleId, 'opened', now, { scope: 'public' });
    // The sender learns their letter was read, never by whom (spec D03 is open on attribution).
    enqueueNotification(tx, {
      userId: bottle.senderId,
      type: 'journey_event',
      kind: 'sent_found',
      bottleId,
      dedupeKey: `public_opened:${bottleId}`,
      message: 'Someone found your drifting bottle and read your letter.',
      now,
    });
    return {
      bottle: tx.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get()!,
      openedAt: now,
    };
  });
  return openedLetter(ctx, opened.bottle, 'public', opened.openedAt);
}

// Finishing the reading. The letter is never served again anyway; this records that the reading
// ended, after which the finder can no longer block the writer from it. Idempotent; the opening
// row (who, when) is kept for the journey's integrity.
export function closeReading(ctx: AppContext, user: AuthUser, bottleId: string): void {
  ctx.db
    .update(t.publicOpenings)
    .set({ closedAt: ctx.clock.now() })
    .where(
      and(
        eq(t.publicOpenings.bottleId, bottleId),
        eq(t.publicOpenings.openedById, user.id),
        isNull(t.publicOpenings.closedAt),
      ),
    )
    .run();
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
