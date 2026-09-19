import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  decideRisk,
  nightsOverlapping,
  stormForNight,
  type NightWindow,
  type StormWindowDto,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { plannedArrivalAt, progressAt } from '../domain/routing.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';
import { activePlan, appendEvent } from './journey.js';
import { enqueueNotification } from './notifications.js';
import { commitLoss } from './outcomes.js';

// Automatic journey outcomes (spec §9.3). The worker walks every night a bottle has been at
// sea and takes the night's decision exactly once, in a transaction keyed on (bottle, night).
// The storm, the decision moment and its draws are pure functions of the policy version, the
// bottle id and the night, so a retry, a restart, a long outage or a clock change replays the
// identical decisions — nothing is ever rolled twice. A loss goes through the same
// transactional service as the development control, so arrival and loss can never both commit
// and the sender is told exactly once.
//
// Only journeys released under a policy version take part: bottles with a null version
// (released before activation) are never put at risk.
//
// The night is the sender's night (policy v3): 19:00–07:00 in the account's persisted zone,
// the same phase the account's Ocean map is drawn in, whatever water the bottle is on. One
// phase per account drives the palette, every storm glyph, every risk decision and the sea
// view's lighting, so a daytime map can never hold a bottle in a risk-bearing storm. Nights
// are walked only from the instant the account's zone took effect: a zone change moves the
// nights ahead, never the ones behind, and an account no device has spoken for yet has no
// nights at all — no storms and no risk until it does. Journeys stamped with policy v1 or v2
// keep their stamp and their past decisions; from here on they walk these nights too.

const iso = (ms: number) => new Date(ms).toISOString();

type BottleRow = typeof t.bottles.$inferSelect;
type PlanRow = typeof t.routePlans.$inferSelect;

// The zone the sender's nights are counted in and the journey-clock instant it took effect.
export function accountNightZone(
  ctx: AppContext,
  userId: string,
): { zone: string; since: number } | null {
  const row = ctx.db
    .select({ zone: t.users.timeZone, since: t.users.timeZoneSince })
    .from(t.users)
    .where(eq(t.users.id, userId))
    .get();
  return row?.zone && row.since !== null ? { zone: row.zone, since: row.since } : null;
}

// The nights of one journey between two instants: the sender's account nights that began
// after both the release and the zone's start. This is the only place a night is chosen, for
// the worker and the map alike.
export function journeyNights(
  ctx: AppContext,
  bottle: Pick<BottleRow, 'senderId' | 'releasedAt'>,
  fromMs: number,
  toMs: number,
): NightWindow[] {
  const account = accountNightZone(ctx, bottle.senderId);
  if (!account) return [];
  const floor = Math.max(fromMs, bottle.releasedAt, account.since);
  return nightsOverlapping(floor, toMs, account.zone).filter((n) => n.startsAt >= floor);
}

// Storm windows for the map: the nights around `now` for one bottle. Presentation reads this;
// the risk worker walks the same nights with the same function, so what is drawn is exactly
// what can (or, past the limits, cannot) matter. A bottle released before automatic outcomes
// carries no policy of its own and is shown the current rule's storms — scenery, since no
// decision is ever taken for it.
export function stormWindowsFor(
  ctx: AppContext,
  bottle: Pick<BottleRow, 'id' | 'state' | 'senderId' | 'releasedAt'>,
  now: number,
): StormWindowDto[] {
  if (bottle.state !== 'at_sea') return [];
  const dayMs = 24 * 60 * 60 * 1000;
  return journeyNights(ctx, bottle, now - dayMs, now + dayMs)
    .map((night) => stormForNight(bottle.id, night, RISK_POLICY_VERSION))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => ({ startsAt: iso(s.startsAt), endsAt: iso(s.endsAt) }));
}

export interface RiskTickResult {
  decided: number;
  lost: number;
}

// Takes every due decision for every at-sea journey under a policy. Deterministic catch-up:
// safe to run repeatedly, after downtime, or concurrently with the arrival worker.
export function processRiskDecisions(ctx: AppContext, now: number): RiskTickResult {
  const result: RiskTickResult = { decided: 0, lost: 0 };
  const candidates = ctx.db
    .select({ bottle: t.bottles, plan: t.routePlans })
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
  for (const { bottle, plan } of candidates) {
    const r = processBottle(ctx, bottle, plan, now);
    result.decided += r.decided;
    result.lost += r.lost;
  }
  return result;
}

function processBottle(
  ctx: AppContext,
  bottle: BottleRow,
  plan: PlanRow,
  now: number,
): RiskTickResult {
  const result: RiskTickResult = { decided: 0, lost: 0 };
  // Every versioned journey walks the current rule's nights; the stamp records the version it
  // was released under and each decision row records the version it was taken under.
  const version = RISK_POLICY_VERSION;
  const nights = journeyNights(ctx, bottle, bottle.releasedAt, now);
  for (const night of nights) {
    const storm = stormForNight(bottle.id, night, version);
    // A decision in the future waits for its moment.
    if (!storm || storm.decisionAt > now) continue;
    const taken = ctx.db.transaction((tx) => {
      const already = tx
        .select({ id: t.riskDecisions.id })
        .from(t.riskDecisions)
        .where(
          and(eq(t.riskDecisions.bottleId, bottle.id), eq(t.riskDecisions.nightKey, night.key)),
        )
        .get();
      if (already) return null;
      const fresh = tx.select().from(t.bottles).where(eq(t.bottles.id, bottle.id)).get();
      if (!fresh || fresh.state !== 'at_sea') return null;
      const current = activePlan(tx, bottle.id) ?? plan;
      const prior = tx
        .select({ n: sql<number>`count(*)` })
        .from(t.riskDecisions)
        .where(and(eq(t.riskDecisions.bottleId, bottle.id), eq(t.riskDecisions.eligible, true)))
        .get();
      const decision = decideRisk({
        storm,
        progressAtDecision: progressAt(current, storm.decisionAt),
        arrivalAt: plannedArrivalAt(current),
        priorEligibleDecisions: prior?.n ?? 0,
      });
      tx.insert(t.riskDecisions)
        .values({
          id: newId('rsk'),
          bottleId: bottle.id,
          nightKey: night.key,
          policyVersion: version,
          stormStartsAt: storm.startsAt,
          stormEndsAt: storm.endsAt,
          decisionAt: storm.decisionAt,
          eligible: decision.eligible,
          lost: decision.lost,
          reason: decision.reason,
          createdAt: now,
        })
        .run();
      return decision;
    });
    if (!taken) continue;
    result.decided++;
    if (taken.lost && taken.reason) {
      // The outcome is dated at the decision moment, so its position is where the bottle was
      // in that storm — even when the worker is catching up hours later.
      const committed = commitLoss(ctx, bottle.id, taken.reason, storm.decisionAt);
      if (committed.committed) result.lost++;
      // Whether or not the loss committed (arrival may have won), nothing later can apply.
      break;
    }
  }
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
