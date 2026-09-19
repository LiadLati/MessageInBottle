import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  SOLAR_MS_PER_DEGREE,
  decideRisk,
  localParts,
  nightRuleOf,
  nightsOverlapping,
  seaNightsOverlapping,
  solarOffsetMs,
  utcDayKey,
  stormForNight,
  type GeoPoint,
  type NightKey,
  type NightWindow,
  type StormWindowDto,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import {
  geoPointAlongPath,
  pathGeoPoints,
  plannedArrivalAt,
  progressAt,
  type RouteGraph,
} from '../domain/routing.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';
import { loadGraphVersion } from './chart.js';
import { activePlan, appendEvent } from './journey.js';
import { enqueueNotification } from './notifications.js';
import { commitLoss } from './outcomes.js';

// Automatic journey outcomes (spec §9.3, policy v1). The worker walks every night a bottle has
// been at sea and takes the night's decision exactly once, in a transaction keyed on
// (bottle, night). The storm, the decision moment and its draws are pure functions of the
// policy version, the bottle id and the night, so a retry, a restart, a long outage or a
// clock change replays the identical decisions — nothing is ever rolled twice. A loss goes
// through the same transactional service as the development control, so arrival and loss
// can never both commit and the sender is told exactly once.
//
// Only journeys released under a policy version take part: bottles with a null version
// (released before activation) are never put at risk.
//
// The night is the bottle's own: 19:00–07:00 mean solar time at the meridian it is sailing on
// (policy v2). It is the single authority — the same function answers "when may this bottle be
// at risk?" and "when does the map draw a storm on it?", so no viewer's clock, zone or daylight
// saving can hide a storm that carries a decision. Journeys stamped with policy v1 keep the
// zone-based nights they were released under; their windows are published the same way, so they
// are just as visible.

const iso = (ms: number) => new Date(ms).toISOString();

type BottleRow = typeof t.bottles.$inferSelect;
type PlanRow = typeof t.routePlans.$inferSelect;

// A route's longitudes followed continuously: each point is taken on the same side of the world
// as the one before it, so a path over the antimeridian reads 179°, 181°, 183° instead of
// jumping to -179°. Without this a bottle crossing the date line would move its own clock by a
// whole day in one step.
export function unwrapLongitudes(geo: GeoPoint[]): GeoPoint[] {
  const out = geo.slice(0, 1);
  for (let i = 1; i < geo.length; i++) {
    let lng = geo[i]!.lng;
    const previous = out[i - 1]!.lng;
    while (lng - previous > 180) lng -= 360;
    while (lng - previous < -180) lng += 360;
    out.push({ lng, lat: geo[i]!.lat });
  }
  return out;
}

function unwrappedGeo(graph: RouteGraph, nodeIds: string[]): GeoPoint[] | null {
  const geo = pathGeoPoints(graph, nodeIds);
  return geo ? unwrapLongitudes(geo) : null;
}

// The meridian the bottle's nights are measured at, taken from its persisted route plan: the
// longitude it is on at `atMs`. A graph without geographic anchors falls back to Greenwich.
function meridianAt(geo: GeoPoint[] | null, plan: PlanRow, atMs: number): number {
  if (!geo) return 0;
  return Math.round(geoPointAlongPath(geo, progressAt(plan, atMs)).lng * SOLAR_MS_PER_DEGREE);
}

function planGeo(ctx: AppContext, plan: PlanRow): GeoPoint[] | null {
  return unwrappedGeo(loadGraphVersion(ctx.db, plan.graphVersion), plan.nodeIds);
}

// Each sea night is anchored at midday UTC of its own date, so a night's window is a pure
// function of the plan and the date — never of when the worker happens to run. The route is
// read once per walk, not once per night.
function nightMeridian(ctx: AppContext, plan: PlanRow): (key: NightKey) => number {
  const geo = planGeo(ctx, plan);
  return (key) => {
    const [y, m, d] = key.split('-').map(Number) as [number, number, number];
    return meridianAt(geo, plan, Date.UTC(y, m - 1, d, 12));
  };
}

// The nights of one journey between two instants, under the policy it sails with. This is the
// only place the night rule is chosen, for the worker and the map alike.
export function journeyNights(
  ctx: AppContext,
  plan: PlanRow,
  policyVersion: number,
  fromMs: number,
  toMs: number,
): NightWindow[] {
  return nightRuleOf(policyVersion) === 'sea'
    ? seaNightsOverlapping(fromMs, toMs, nightMeridian(ctx, plan))
    : nightsOverlapping(fromMs, toMs, ctx.config.timeZone);
}

// The clock this bottle's nights are kept by, as minutes from UTC: its own meridian under the
// sea rule, the server's zone for a journey still sailing under policy v1. The sea view reads
// it for the sky, so the sky out there always agrees with the storm windows above — a bottle in
// a storm is a bottle in its own night, whatever the hour is where it is being watched.
export function nightOffsetMinutesFor(
  ctx: AppContext,
  bottle: Pick<BottleRow, 'riskPolicyVersion'>,
  plan: PlanRow,
  now: number,
): number {
  const version = bottle.riskPolicyVersion ?? RISK_POLICY_VERSION;
  if (nightRuleOf(version) === 'zone') {
    const p = localParts(now, ctx.config.timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asIfUtc - Math.floor(now / 1000) * 1000) / 60000);
  }
  // The meridian tonight's nights were scheduled at, so the sky turns exactly with them.
  const meridian = nightMeridian(ctx, plan);
  const key = seaNightsOverlapping(now, now, meridian)[0]?.key ?? utcDayKey(now);
  return Math.round(solarOffsetMs(meridian(key) / SOLAR_MS_PER_DEGREE) / 60000);
}

// Storm windows for the map: the nights around `now` for one bottle. Presentation reads this;
// the risk worker walks the same nights with the same function, so what is drawn is exactly
// what can (or, past the limits, cannot) matter. A bottle released before automatic outcomes
// carries no policy of its own and is shown the current rule's storms — scenery, since no
// decision is ever taken for it.
export function stormWindowsFor(
  ctx: AppContext,
  bottle: Pick<BottleRow, 'id' | 'state' | 'releasedAt' | 'riskPolicyVersion'>,
  plan: PlanRow,
  now: number,
): StormWindowDto[] {
  if (bottle.state !== 'at_sea') return [];
  const version = bottle.riskPolicyVersion ?? RISK_POLICY_VERSION;
  const dayMs = 24 * 60 * 60 * 1000;
  return journeyNights(ctx, plan, version, now - dayMs, now + dayMs)
    .map((night) => stormForNight(bottle.id, night, version))
    .filter((s): s is NonNullable<typeof s> => s !== null && s.endsAt > bottle.releasedAt)
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
  const version = bottle.riskPolicyVersion!;
  const nights = journeyNights(ctx, plan, version, bottle.releasedAt, now);
  for (const night of nights) {
    const storm = stormForNight(bottle.id, night, version);
    // A storm the bottle was not at sea for cannot touch it; a decision in the future waits.
    if (!storm || storm.startsAt < bottle.releasedAt || storm.decisionAt > now) continue;
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
