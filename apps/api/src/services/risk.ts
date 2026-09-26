import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  bottleRiskDraws,
  decideRisk,
  firstDaytime,
  type StormWindowDto,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { plannedArrivalAt, progressAt } from '../domain/routing.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';
import { activePlan, appendEvent } from './journey.js';
import { enqueueNotification } from './notifications.js';
import { commitLossIn } from './outcomes.js';
import { ensureRolls, visibleStorms, zoneHistory } from './weather.js';

// Automatic journey outcomes (spec §9.3, risk policy v4). Weather belongs to the account's map:
// services/weather.ts persists one eligibility roll per night (never two within 24 hours), and a
// storm, when rolled, is one window inside that night on the account's map clock. This worker
// takes the storm's risk at its midpoint, once, in a single transaction: every eligible bottle
// the account has at sea gets its own independent decision, a loss is committed through the
// same transactional service as the development control, and the roll is marked decided in the
// same commit — so a retry, a restart or a long outage replays nothing and duplicates nothing.
// If the map turned to day before the midpoint, the storm is cancelled instead: no decision,
// and the roll stays consumed.
//
// Only journeys released under a policy version take part: bottles with a null version
// (released before automatic outcomes) are never put at risk. Journeys stamped v1–v3 keep their
// stamp and every decision already recorded; from v4's activation they are decided by the
// account's storms like any other journey, and their earlier eligible decisions count toward
// the five-decision limit. Decisions of the per-bottle v3 schedule that had not been taken when
// v4 took over are never taken: that schedule no longer exists anywhere on the map.

const iso = (ms: number) => new Date(ms).toISOString();

type BottleRow = typeof t.bottles.$inferSelect;
type RollRow = typeof t.weatherRolls.$inferSelect;

// The account storm's visible windows around `now`, for a bottle that is at sea. Presentation
// reads this; the worker decides on the same persisted rolls.
export function stormWindowsFor(
  ctx: AppContext,
  bottle: Pick<BottleRow, 'id' | 'state' | 'senderId' | 'releasedAt'>,
  now: number,
): StormWindowDto[] {
  if (bottle.state !== 'at_sea') return [];
  const dayMs = 24 * 60 * 60 * 1000;
  return visibleStorms(ctx, bottle.senderId, now - dayMs, now + dayMs).map((s) => ({
    startsAt: iso(s.startsAt),
    endsAt: iso(s.endsAt),
  }));
}

export interface RiskTickResult {
  decided: number;
  lost: number;
}

// Rolls every account that has a journey at risk up to `now`, then takes every due midpoint.
// Deterministic catch-up: safe to run repeatedly, after downtime, or beside the arrival worker.
export function processRiskDecisions(ctx: AppContext, now: number): RiskTickResult {
  const senders = ctx.db
    .selectDistinct({ userId: t.bottles.senderId })
    .from(t.bottles)
    .innerJoin(t.routePlans, eq(t.routePlans.bottleId, t.bottles.id))
    .where(
      and(
        eq(t.bottles.state, 'at_sea'),
        eq(t.routePlans.active, true),
        lte(t.routePlans.startsAt, now),
        sql`${t.bottles.riskPolicyVersion} is not null`,
      ),
    )
    .all();
  for (const { userId } of senders) ensureRolls(ctx, userId, now);
  return decideDueStorms(ctx, ctx.db, null, now);
}

// Takes every storm midpoint that is due (for one account, or all), in order, each storm in its
// own transaction (a savepoint when `db` is already one). Called by the worker and, before a
// time-zone change takes effect, for the account changing zone — so a midpoint that has already
// passed on server time is decided under the clock it happened in.
export function decideDueStorms(
  ctx: AppContext,
  db: DbOrTx,
  userId: string | null,
  now: number,
): RiskTickResult {
  const result: RiskTickResult = { decided: 0, lost: 0 };
  const due = db
    .select()
    .from(t.weatherRolls)
    .where(
      and(
        eq(t.weatherRolls.outcome, 'storm'),
        isNull(t.weatherRolls.decidedAt),
        isNull(t.weatherRolls.cancelledAt),
        lte(t.weatherRolls.decisionAt, now),
        userId === null ? undefined : eq(t.weatherRolls.userId, userId),
      ),
    )
    .orderBy(t.weatherRolls.decisionAt)
    .all();
  for (const roll of due) {
    const r = db.transaction((tx) => {
      // Re-read under the writer: a concurrent run may have decided or cancelled it.
      const fresh = tx.select().from(t.weatherRolls).where(eq(t.weatherRolls.id, roll.id)).get();
      if (!fresh || fresh.decidedAt !== null || fresh.cancelledAt !== null)
        return { decided: 0, lost: 0 };
      return decideStorm(ctx, tx, fresh, now);
    });
    result.decided += r.decided;
    result.lost += r.lost;
  }
  return result;
}

function decideStorm(ctx: AppContext, tx: DbOrTx, roll: RollRow, now: number): RiskTickResult {
  const result: RiskTickResult = { decided: 0, lost: 0 };
  const decisionAt = roll.decisionAt!;
  // The storm needed a night on the account's map from the roll to its midpoint. A zone change
  // that turned the map to day in between cancels the decision; the roll stays consumed.
  const day = firstDaytime(zoneHistory(tx, roll.userId), roll.rolledAt, decisionAt);
  if (day !== null) {
    tx.update(t.weatherRolls)
      .set({ cancelledAt: day, cancelReason: 'daytime' })
      .where(and(eq(t.weatherRolls.id, roll.id), isNull(t.weatherRolls.cancelledAt)))
      .run();
    return result;
  }
  // Every versioned journey of the account that had set out by the midpoint and is still at
  // sea. Arrival wins: a bottle whose arrival was already committed is not here.
  const bottles = tx
    .select({ bottle: t.bottles })
    .from(t.bottles)
    .innerJoin(t.routePlans, eq(t.routePlans.bottleId, t.bottles.id))
    .where(
      and(
        eq(t.bottles.senderId, roll.userId),
        eq(t.bottles.state, 'at_sea'),
        eq(t.routePlans.active, true),
        lte(t.routePlans.startsAt, decisionAt),
        sql`${t.bottles.riskPolicyVersion} is not null`,
      ),
    )
    .orderBy(t.bottles.id)
    .all();
  for (const { bottle } of bottles) {
    const already = tx
      .select({ id: t.riskDecisions.id })
      .from(t.riskDecisions)
      .where(and(eq(t.riskDecisions.bottleId, bottle.id), eq(t.riskDecisions.nightKey, roll.id)))
      .get();
    if (already) continue;
    const plan = activePlan(tx, bottle.id);
    if (!plan) continue;
    // Arrival wins: a bottle due ashore by the midpoint takes no part in the storm, exactly as
    // if the arrival worker had already committed it — so a worker catching up after downtime
    // writes the same rows as one that never stopped.
    if (plannedArrivalAt(plan) <= decisionAt) continue;
    const prior = tx
      .select({ n: sql<number>`count(*)` })
      .from(t.riskDecisions)
      .where(and(eq(t.riskDecisions.bottleId, bottle.id), eq(t.riskDecisions.eligible, true)))
      .get();
    const decision = decideRisk({
      storm: { decisionAt, ...bottleRiskDraws(bottle.id, roll.rolledAt) },
      progressAtDecision: progressAt(plan, decisionAt),
      arrivalAt: plannedArrivalAt(plan),
      priorEligibleDecisions: prior?.n ?? 0,
    });
    // The loss is applied in this same transaction, dated at the midpoint so its position is
    // where the bottle was in that storm — even when the worker is catching up.
    let lostNow = false;
    if (decision.lost && decision.reason)
      lostNow = commitLossIn(ctx, tx, bottle.id, decision.reason, decisionAt).committed;
    tx.insert(t.riskDecisions)
      .values({
        id: newId('rsk'),
        bottleId: bottle.id,
        nightKey: roll.id,
        policyVersion: RISK_POLICY_VERSION,
        stormStartsAt: roll.stormStartsAt,
        stormEndsAt: roll.stormEndsAt,
        decisionAt,
        eligible: decision.eligible,
        lost: lostNow,
        reason: decision.reason,
        createdAt: now,
      })
      .run();
    result.decided++;
    if (lostNow) result.lost++;
  }
  tx.update(t.weatherRolls).set({ decidedAt: now }).where(eq(t.weatherRolls.id, roll.id)).run();
  return result;
}

// ---------- public listing deadline ----------

// Removes unopened adrift bottles from the public map once their 72 hours have passed. The
// deadline itself is enforced by the list and open endpoints even when this has not run yet;
// this is what records the removal once and tells the sender.
export function expirePublicListings(ctx: AppContext, now: number): number {
  const due = ctx.db
    .select({ id: t.bottles.id })
    .from(t.bottles)
    .leftJoin(t.publicOpenings, eq(t.publicOpenings.bottleId, t.bottles.id))
    .where(
      and(
        eq(t.bottles.state, 'lost'),
        eq(t.bottles.lossReason, 'adrift'),
        isNull(t.publicOpenings.bottleId),
        isNull(t.bottles.publicExpiredAt),
        lte(t.bottles.publicDeadlineAt, now),
      ),
    )
    .all();
  let expired = 0;
  for (const { id } of due) if (expirePublicListing(ctx, id)) expired++;
  return expired;
}

export function expirePublicListing(ctx: AppContext, bottleId: string): boolean {
  return ctx.db.transaction((tx) => {
    const bottle = tx.select().from(t.bottles).where(eq(t.bottles.id, bottleId)).get();
    if (
      !bottle ||
      bottle.state !== 'lost' ||
      bottle.lossReason !== 'adrift' ||
      bottle.publicExpiredAt !== null ||
      bottle.publicDeadlineAt === null
    ) {
      return false;
    }
    // Opening and expiry are decided under the same writer: an opening that got in first wins.
    const opened = tx
      .select({ id: t.publicOpenings.bottleId })
      .from(t.publicOpenings)
      .where(eq(t.publicOpenings.bottleId, bottleId))
      .get();
    if (opened) return false;
    const at = bottle.publicDeadlineAt;
    const res = tx
      .update(t.bottles)
      .set({ publicExpiredAt: at })
      .where(and(eq(t.bottles.id, bottleId), isNull(t.bottles.publicExpiredAt)))
      .run();
    if (res.changes !== 1) return false;
    appendEventFn(tx, bottleId, at);
    enqueueFn(tx, bottle, at);
    return true;
  });
}

function appendEventFn(tx: DbOrTx, bottleId: string, at: number) {
  appendEvent(tx, bottleId, 'public_expired', at, { listingMs: RISK_POLICY.publicListingMs });
}

function enqueueFn(tx: DbOrTx, bottle: BottleRow, at: number) {
  const recipient = bottle.recipientNameSnapshot.trim() || 'your friend';
  enqueueNotification(tx, {
    userId: bottle.senderId,
    type: 'journey_event',
    kind: 'sent_expired',
    bottleId: bottle.id,
    dedupeKey: `public_expired:${bottle.id}`,
    message: `72 hours passed and the bottle you sent to ${recipient} was not opened. It was removed from the public map.`,
    now: at,
  });
}

// ---------- activation of the listing deadline for legacy adrift bottles ----------

// Bottles that were already adrift and unopened when the 72-hour rule arrived get a full 72
// hours from activation instead of vanishing at the first tick. Runs at boot; only rows with
// no deadline are touched, so it is idempotent and never shortens an existing deadline.
export function activatePublicListings(ctx: AppContext): number {
  const now = ctx.clock.now();
  const res = ctx.db
    .update(t.bottles)
    .set({ publicDeadlineAt: now + RISK_POLICY.publicListingMs })
    .where(
      and(
        eq(t.bottles.state, 'lost'),
        eq(t.bottles.lossReason, 'adrift'),
        isNull(t.bottles.publicDeadlineAt),
        isNull(t.bottles.publicExpiredAt),
      ),
    )
    .run();
  return res.changes;
}
