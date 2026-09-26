import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  RISK_POLICY,
  RISK_POLICY_VERSION,
  firstDaytime,
  harbourTimeZone,
  nextRollSlot,
  phaseAt,
  rollAccountStorm,
  type AccountWeatherDto,
  type ZoneChange,
} from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { AppContext } from './context.js';

// The account's map clock and weather (risk policy v4, spec §9.3).
//
// One authoritative IANA zone per account sets the map's day and night *and* storm eligibility.
// It is the latest valid device zone the server accepted; before any, the chosen harbour's
// nautical zone; else UTC. Every accepted change is kept in `account_zone_changes` with the
// journey-clock instant it took effect, so the zone in force at any past instant is a fact,
// and a worker catching up after downtime walks exactly the nights the map showed.
//
// Rolls are persisted, one row each, in `weather_rolls`. A roll happens only when the map
// enters a night (dusk, a zone change that turns a daytime map to night, or the clock starting
// at night), never sooner than 24 hours after the previous roll — an entry inside those 24 hours
// gets no roll — so a zone change, a local date boundary, reopening SeaYou or restarting the
// worker can never add one. Rolls are computed only up to "now" and only from
// history already recorded, so computing them early, late or twice gives the same rows.

type ZoneSource = 'device' | 'harbour' | 'utc';
type RollRow = typeof t.weatherRolls.$inferSelect;

const iso = (ms: number) => new Date(ms).toISOString();

// When v4 took over, recorded once (at boot in production; on first use otherwise). Accounts
// never roll before it, so no night that was already past gets a v4 storm after the fact.
export function policyActivatedAt(ctx: AppContext, db: DbOrTx = ctx.db): number {
  db.insert(t.riskPolicyActivations)
    .values({ version: RISK_POLICY_VERSION, activatedAt: ctx.clock.now() })
    .onConflictDoNothing()
    .run();
  return db
    .select({ at: t.riskPolicyActivations.activatedAt })
    .from(t.riskPolicyActivations)
    .where(eq(t.riskPolicyActivations.version, RISK_POLICY_VERSION))
    .get()!.at;
}

// The fallback before any device has reported: the harbour's nautical zone, or UTC.
export function fallbackZone(db: DbOrTx, userId: string): { zone: string; source: ZoneSource } {
  const row = db
    .select({ lng: t.shores.lng })
    .from(t.users)
    .leftJoin(t.shores, eq(t.shores.id, t.users.shoreId))
    .where(eq(t.users.id, userId))
    .get();
  const zone = harbourTimeZone(row?.lng ?? null);
  return zone ? { zone, source: 'harbour' } : { zone: 'UTC', source: 'utc' };
}

export function zoneHistory(db: DbOrTx, userId: string): ZoneChange[] {
  return db
    .select({ zone: t.accountZoneChanges.zone, effectiveAt: t.accountZoneChanges.effectiveAt })
    .from(t.accountZoneChanges)
    .where(eq(t.accountZoneChanges.userId, userId))
    .orderBy(asc(t.accountZoneChanges.effectiveAt), asc(sql`rowid`))
    .all();
}

function latestZoneRow(db: DbOrTx, userId: string) {
  return db
    .select()
    .from(t.accountZoneChanges)
    .where(eq(t.accountZoneChanges.userId, userId))
    .orderBy(desc(t.accountZoneChanges.effectiveAt), desc(sql`rowid`))
    .get();
}

function recordZone(db: DbOrTx, userId: string, zone: string, source: ZoneSource, at: number) {
  db.insert(t.accountZoneChanges)
    .values({ id: newId('azc'), userId, zone, source, effectiveAt: at, createdAt: at })
    .run();
}

// Rows recorded in the same millisecond keep the order they were written in (rowid), so the
// zone in force is never ambiguous.

// Makes sure the account has a map clock at all: an account no device has reported for yet
// gets its fallback, effective from now. Called on release, on reading the weather and by the
// worker, so every account with a journey has one from the moment it sails.
export function ensureMapClock(ctx: AppContext, userId: string, db: DbOrTx = ctx.db): void {
  if (latestZoneRow(db, userId)) return;
  const fallback = fallbackZone(db, userId);
  recordZone(db, userId, fallback.zone, fallback.source, ctx.clock.now());
}

// The zone the account's map is drawn in right now, and where it came from.
export function authoritativeZone(
  ctx: AppContext,
  userId: string,
  db: DbOrTx = ctx.db,
): { zone: string; source: ZoneSource } {
  const row = latestZoneRow(db, userId);
  if (row) return { zone: row.zone, source: row.source };
  return fallbackZone(db, userId);
}

// A device reported a valid zone and the server accepted it (the caller validated it and
// charged the change budget). Everything due before this instant is settled first under the
// old clock; then the new zone takes effect now. If that turns the map to day while a storm's
// midpoint is still ahead, the storm stops and its pending decision is cancelled — the roll
// stays consumed. Nothing already decided is touched.
export function acceptDeviceZone(
  ctx: AppContext,
  userId: string,
  zone: string,
  settleDue: (tx: DbOrTx, now: number) => void,
): boolean {
  const now = ctx.clock.now();
  return ctx.db.transaction((tx) => {
    const latest = latestZoneRow(tx, userId);
    if (latest?.source === 'device' && latest.zone === zone) return false;
    ensureRollsIn(ctx, tx, userId, now);
    settleDue(tx, now);
    recordZone(tx, userId, zone, 'device', now);
    tx.update(t.users)
      .set({ timeZone: zone, timeZoneSince: now })
      .where(eq(t.users.id, userId))
      .run();
    if (phaseAt(now, zone) === 'day') cancelPendingStorms(tx, userId, now);
    return true;
  });
}

// The chosen harbour changed. Before any device report the harbour sets the map clock, so the
// fallback follows it from now on; once a device has reported, the harbour no longer matters.
export function harbourChanged(ctx: AppContext, userId: string): void {
  const latest = latestZoneRow(ctx.db, userId);
  if (latest?.source === 'device') return;
  const fallback = fallbackZone(ctx.db, userId);
  if (latest && latest.zone === fallback.zone) return;
  const now = ctx.clock.now();
  ctx.db.transaction((tx) => {
    ensureRollsIn(ctx, tx, userId, now);
    recordZone(tx, userId, fallback.zone, fallback.source, now);
    if (phaseAt(now, fallback.zone) === 'day') cancelPendingStorms(tx, userId, now);
  });
}

function cancelPendingStorms(tx: DbOrTx, userId: string, now: number) {
  tx.update(t.weatherRolls)
    .set({ cancelledAt: now, cancelReason: 'daytime' })
    .where(
      and(
        eq(t.weatherRolls.userId, userId),
        eq(t.weatherRolls.outcome, 'storm'),
        isNull(t.weatherRolls.decidedAt),
        isNull(t.weatherRolls.cancelledAt),
      ),
    )
    .run();
}

export function lastRoll(db: DbOrTx, userId: string): RollRow | undefined {
  return db
    .select()
    .from(t.weatherRolls)
    .where(eq(t.weatherRolls.userId, userId))
    .orderBy(desc(t.weatherRolls.rolledAt))
    .get();
}

// Persists every roll the account is due up to `now`, in one transaction. Idempotent.
export function ensureRolls(ctx: AppContext, userId: string, now: number): number {
  return ctx.db.transaction((tx) => ensureRollsIn(ctx, tx, userId, now));
}

// The same, inside a transaction the caller already holds (a zone change, a harbour change, or
// a restriction settling what is due before it takes effect).
export function ensureRollsIn(ctx: AppContext, tx: DbOrTx, userId: string, now: number): number {
  ensureMapClock(ctx, userId, tx);
  const history = zoneHistory(tx, userId);
  const activated = policyActivatedAt(ctx, tx);
  const previous = lastRoll(tx, userId);
  // The account's map clock starts at v4's activation or its first recorded zone, whichever is
  // later; a clock that starts at night counts as entering that night.
  const clockStart = Math.max(activated, history[0]!.effectiveAt);
  let notBefore = previous ? previous.rolledAt + RISK_POLICY.rollSpacingMs : clockStart;
  let made = 0;
  for (let guard = 0; guard < 10_000 && notBefore <= now; guard++) {
    const slot = nextRollSlot(history, notBefore, now, clockStart);
    if (!slot) break;
    const roll = rollAccountStorm(userId, slot);
    tx.insert(t.weatherRolls)
      .values({
        id: newId('wrl'),
        userId,
        policyVersion: RISK_POLICY_VERSION,
        rolledAt: slot.rolledAt,
        zone: slot.zone,
        nightStartsAt: slot.night.startsAt,
        nightEndsAt: slot.night.endsAt,
        outcome: roll.storm ? 'storm' : 'calm',
        stormStartsAt: roll.storm?.startsAt ?? null,
        stormEndsAt: roll.storm?.endsAt ?? null,
        decisionAt: roll.storm?.decisionAt ?? null,
        createdAt: now,
      })
      .onConflictDoNothing()
      .run();
    made++;
    notBefore = slot.rolledAt + RISK_POLICY.rollSpacingMs;
  }
  return made;
}

// When a stored storm stops being shown: its end, or the first daytime moment before that on
// the account's map as recorded so far. Null when it is never shown (cancelled before it began).
export function stormVisibleUntil(roll: RollRow, history: ZoneChange[]): number | null {
  if (roll.outcome !== 'storm' || roll.stormStartsAt === null || roll.stormEndsAt === null)
    return null;
  const day = firstDaytime(history, roll.rolledAt, roll.stormEndsAt);
  const until = Math.min(roll.stormEndsAt, day ?? Infinity, roll.cancelledAt ?? Infinity);
  return until > roll.stormStartsAt ? until : null;
}

// Visible storm windows of an account overlapping [from, to]: what the map and every bottle
// card of the account show. Reads persisted rolls only.
export function visibleStorms(
  ctx: AppContext,
  userId: string,
  from: number,
  to: number,
): Array<{ id: string; startsAt: number; endsAt: number }> {
  const history = zoneHistory(ctx.db, userId);
  return ctx.db
    .select()
    .from(t.weatherRolls)
    .where(
      and(
        eq(t.weatherRolls.userId, userId),
        eq(t.weatherRolls.outcome, 'storm'),
        lte(t.weatherRolls.stormStartsAt, to),
      ),
    )
    .orderBy(desc(t.weatherRolls.rolledAt))
    .limit(4)
    .all()
    .flatMap((r) => {
      const until = stormVisibleUntil(r, history);
      return until !== null && until > from
        ? [{ id: r.id, startsAt: r.stormStartsAt!, endsAt: until }]
        : [];
    });
}

// The account's map state as every device must draw it.
export function accountWeather(ctx: AppContext, userId: string): AccountWeatherDto {
  const now = ctx.clock.now();
  ensureRolls(ctx, userId, now);
  const { zone, source } = authoritativeZone(ctx, userId);
  const phase = phaseAt(now, zone);
  const storm =
    phase === 'night'
      ? (visibleStorms(ctx, userId, now, now + RISK_POLICY.stormMaxMs + 24 * 3600_000).find(
          (s) => s.endsAt > now,
        ) ?? null)
      : null;
  const last = lastRoll(ctx.db, userId);
  return {
    timeZone: zone,
    timeZoneSource: source,
    phase,
    storm: storm
      ? { id: storm.id, startsAt: iso(storm.startsAt), endsAt: iso(storm.endsAt) }
      : null,
    lastRoll: last
      ? {
          rolledAt: iso(last.rolledAt),
          outcome: last.outcome,
          cancelledAt: last.cancelledAt === null ? null : iso(last.cancelledAt),
        }
      : null,
    nextRollNotBefore: last ? iso(last.rolledAt + RISK_POLICY.rollSpacingMs) : null,
    serverTime: iso(now),
  };
}
