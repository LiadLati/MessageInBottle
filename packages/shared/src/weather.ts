// Day/night phase, the account storm policy, and legacy cosmetic weather schedules.
//
// Everything here is pure and deterministic: the same inputs always produce the same weather, so
// a refresh, a second client or a server restart all agree. The account storm policy (v4, below)
// is the only weather with consequences; the server persists each roll it makes, so a result is
// never recomputed differently. Nothing in this module influences a route, a duration or an
// arrival.

export type DayPhase = 'day' | 'night';

export interface DaylightConfig {
  // Local hour (0–23) at which day begins and ends. A window that wraps midnight is supported.
  dayStartHour: number;
  dayEndHour: number;
}

export const DAYLIGHT_DEFAULTS: DaylightConfig = { dayStartHour: 7, dayEndHour: 19 };

// The local hour of an instant in an IANA zone. The zone comes from the browser
// (Intl.DateTimeFormat().resolvedOptions().timeZone) — never from coordinates or a device sensor.
// Building an Intl.DateTimeFormat is far more expensive than using one, and the risk worker and
// the map ask about the same few zones constantly (audit ARCH-011): one formatter per zone.
const hourFormats = new Map<string, Intl.DateTimeFormat>();
const partsFormats = new Map<string, Intl.DateTimeFormat>();

export function localHourIn(instantMs: number, timeZone?: string): number {
  const key = timeZone ?? '';
  let fmt = hourFormats.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    });
    hourFormats.set(key, fmt);
  }
  // 'en-GB' with hour12:false renders 00–23; midnight can come back as '24' in some engines.
  return Number(fmt.format(new Date(instantMs))) % 24;
}

// Is `hour` inside [start, end)? Handles windows that wrap midnight (start > end).
export function hourInWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function phaseAt(
  instantMs: number,
  timeZone?: string,
  config: DaylightConfig = DAYLIGHT_DEFAULTS,
): DayPhase {
  const hour = localHourIn(instantMs, timeZone);
  return hourInWindow(hour, config.dayStartHour, config.dayEndHour) ? 'day' : 'night';
}

// ---------- deterministic hashing ----------

// FNV-1a over the parts, so a schedule slot depends only on its own identity.
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = typeof part === 'number' ? `#${part}` : part;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A stable [0,1) draw `index` for a seed: mixing means draws from one seed are independent.
export function draw(seed: number, index: number): number {
  let x = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// ---------- storm scheduling ----------

export const SCHEDULE_VERSION = 1;

export interface WeatherScheduleConfig {
  windowMs: number;
  chance: number;
  minDurationMs: number;
  maxDurationMs: number;
}

// Ocean: one storm at most per bottle per 3h window, 40–100 minutes long, 45% of windows.
export const OCEAN_SCHEDULE: WeatherScheduleConfig = {
  windowMs: 3 * 60 * 60 * 1000,
  chance: 0.45,
  minDurationMs: 40 * 60 * 1000,
  maxDurationMs: 100 * 60 * 1000,
};

// My Shore: an independent 4h window keyed on the user, so it never mirrors an ocean storm.
export const SHORE_SCHEDULE: WeatherScheduleConfig = {
  windowMs: 4 * 60 * 60 * 1000,
  chance: 0.35,
  minDurationMs: 50 * 60 * 1000,
  maxDurationMs: 150 * 60 * 1000,
};

export interface ScheduledStorm {
  // Stable identity: the same storm keeps its id across refreshes and clients.
  id: string;
  subjectId: string;
  windowIndex: number;
  startsAt: number;
  endsAt: number;
  // Draws reserved for presentation (position along a route, size, bearing, cell layout).
  seed: number;
}

// The storm scheduled in the window containing `atMs`, or null when that window has none.
// `subjectId` is a bottle id for the ocean and a user id for the shore, so the two never align.
export function stormInWindow(
  subjectId: string,
  atMs: number,
  config: WeatherScheduleConfig,
  scheduleVersion = SCHEDULE_VERSION,
): ScheduledStorm | null {
  const windowIndex = Math.floor(atMs / config.windowMs);
  const seed = hashSeed(scheduleVersion, subjectId, windowIndex);
  if (draw(seed, 0) >= config.chance) return null;
  const windowStart = windowIndex * config.windowMs;
  const duration =
    config.minDurationMs + draw(seed, 1) * (config.maxDurationMs - config.minDurationMs);
  const startsAt = windowStart + draw(seed, 2) * Math.max(0, config.windowMs - duration);
  return {
    id: `storm_${scheduleVersion}_${windowIndex}_${seed.toString(36)}`,
    subjectId,
    windowIndex,
    startsAt: Math.round(startsAt),
    endsAt: Math.round(startsAt + duration),
    seed,
  };
}

// The storm covering `atMs`, if any. Looks at the current window and the one before it, because a
// storm that began late in a window can still be running after the boundary.
export function activeStormAt(
  subjectId: string,
  atMs: number,
  config: WeatherScheduleConfig,
  scheduleVersion = SCHEDULE_VERSION,
): ScheduledStorm | null {
  const current = Math.floor(atMs / config.windowMs);
  for (const index of [current, current - 1]) {
    const storm = stormInWindow(subjectId, index * config.windowMs, config, scheduleVersion);
    if (storm && atMs >= storm.startsAt && atMs < storm.endsAt) return storm;
  }
  return null;
}

// ---------- journey risk policy: account storms on the map clock (policy v4) ----------
//
// The first *consequential* weather. Everything is a pure function of the policy version, the
// account, the account's recorded time-zone history and the bottle ids, so the server takes the
// same decisions after a restart, a retry or a long outage, and no client can influence them.
// Values are the approved ones; changing any of them means a new version, never an edit in place.
//
//   • One clock. The account's authoritative IANA zone (the latest valid device zone the server
//     accepted; before any, the harbour's zone; else UTC) sets the map's day and night:
//     19:00–07:00 local (DAYLIGHT_DEFAULTS). Storms follow that map: a daytime map has none.
//   • At most one roll per night, and never more than one per rolling 24 hours. When the map
//     enters a night — at dusk, or when an accepted zone change turns a daytime map to night —
//     the account rolls once: a deterministic 25% chance that the night holds a storm. The roll
//     is persisted and consumed whatever the result. An entry less than 24 hours after the
//     previous roll gets no roll (that night is calm), so a time-zone change, a date boundary,
//     reopening SeaYou or restarting a worker never adds one. An entry with less than the
//     longest storm left before morning gets no roll either.
//   • One storm, on the account's map. It lasts 40–100 minutes and starts and ends inside the
//     night it was rolled in. Its midpoint is the one moment of risk.
//   • At the midpoint every eligible travelling bottle of the account gets its own independent
//     decision: an eligible decision loses the bottle with 1% probability; only the first five
//     eligible decisions of a journey carry risk (max journey loss 1 − 0.99⁵ ≈ 4.9%); nothing is
//     decided at or after 80% progress or after arrival. Lost bottles go adrift 75% / sink 25%.
//   • If a time-zone change turns the map to day before the midpoint, the storm stops, its
//     pending decision is cancelled and the roll stays consumed. A decision already taken is
//     never revisited.
//
// v1 counted nights in a server zone, v2 at a bottle's meridian, v3 gave every bottle its own
// storm on each of its sender's nights. Decisions recorded under those versions are kept as
// they are; from v4's activation every versioned journey still at sea follows v4.

export const RISK_POLICY_VERSION = 4;

export const RISK_POLICY = {
  version: RISK_POLICY_VERSION,
  stormNightChance: 0.25,
  stormMinMs: 40 * 60 * 1000,
  stormMaxMs: 100 * 60 * 1000,
  // No second eligibility roll for an account within this span of the previous one.
  rollSpacingMs: 24 * 60 * 60 * 1000,
  lossChance: 0.01,
  maxRiskDecisions: 5,
  // Internal protection: never shown in user-facing copy.
  progressCutoff: 0.8,
  adriftShare: 0.75,
  // Public listing of an adrift bottle, from its persisted loss time.
  publicListingMs: 72 * 60 * 60 * 1000,
} as const;

export interface LocalParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(instantMs: number, timeZone: string): LocalParts {
  let fmt = partsFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormats.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

// The instant of a local wall-clock time in a zone (two refinement passes cover DST edges).
export function instantOfLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): number {
  let guess = Date.UTC(year, month - 1, day, hour);
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, timeZone);
    const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess -= asIfUtc - Date.UTC(year, month - 1, day, hour);
  }
  return guess;
}

// A night key is the local date (YYYY-MM-DD) of the evening the night starts on.
export type NightKey = string;

export function nightKeyFor(year: number, month: number, day: number): NightKey {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDay(year: number, month: number, day: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export interface NightWindow {
  key: NightKey;
  startsAt: number;
  endsAt: number;
}

export function nightWindow(
  key: NightKey,
  timeZone: string,
  config: DaylightConfig = DAYLIGHT_DEFAULTS,
): NightWindow {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const startsAt = instantOfLocal(y, m, d, config.dayEndHour, timeZone);
  const next = shiftDay(y, m, d, 1);
  const endsAt = instantOfLocal(next.year, next.month, next.day, config.dayStartHour, timeZone);
  return { key, startsAt, endsAt };
}

// Every night whose window overlaps [fromMs, toMs], in order.
export function nightsOverlapping(
  fromMs: number,
  toMs: number,
  timeZone: string,
  config: DaylightConfig = DAYLIGHT_DEFAULTS,
): NightWindow[] {
  const out: NightWindow[] = [];
  const first = localParts(fromMs, timeZone);
  let cursor = shiftDay(first.year, first.month, first.day, -1);
  for (let guard = 0; guard < 4000; guard++) {
    const w = nightWindow(nightKeyFor(cursor.year, cursor.month, cursor.day), timeZone, config);
    if (w.startsAt > toMs) break;
    if (w.endsAt > fromMs) out.push(w);
    cursor = shiftDay(cursor.year, cursor.month, cursor.day, 1);
  }
  return out;
}

// ---------- the account's zone over time ----------

// One accepted change of the account's authoritative zone, effective from `effectiveAt`.
export interface ZoneChange {
  zone: string;
  effectiveAt: number;
}

export interface ZoneSegment {
  zone: string;
  from: number;
  to: number; // exclusive
}

// The zones in force over [from, to), in order. `changes` must be sorted by effectiveAt; the
// first change's zone also covers anything before it.
export function zoneSegments(
  changes: readonly ZoneChange[],
  from: number,
  to: number,
): ZoneSegment[] {
  if (changes.length === 0 || to <= from) return [];
  const out: ZoneSegment[] = [];
  for (let i = 0; i < changes.length; i++) {
    const segFrom = i === 0 ? -Infinity : changes[i]!.effectiveAt;
    const segTo = i + 1 < changes.length ? changes[i + 1]!.effectiveAt : Infinity;
    const a = Math.max(segFrom, from);
    const b = Math.min(segTo, to);
    if (a < b) out.push({ zone: changes[i]!.zone, from: a, to: b });
  }
  return out;
}

export function zoneAt(changes: readonly ZoneChange[], at: number): string | null {
  let zone: string | null = changes[0]?.zone ?? null;
  for (const c of changes) if (c.effectiveAt <= at) zone = c.zone;
  return zone;
}

// The night of `zone` containing `at`, or null when `at` is daytime there.
export function nightContaining(
  at: number,
  zone: string,
  config: DaylightConfig = DAYLIGHT_DEFAULTS,
): NightWindow | null {
  return (
    nightsOverlapping(at, at, zone, config).find((n) => n.startsAt <= at && at < n.endsAt) ?? null
  );
}

// The first instant in [from, to] at which the account's map shows day, or null if it is night
// throughout. Only zone changes and the natural morning can end a night.
export function firstDaytime(
  changes: readonly ZoneChange[],
  from: number,
  to: number,
  config: DaylightConfig = DAYLIGHT_DEFAULTS,
): number | null {
  for (const seg of zoneSegments(changes, from, to + 1)) {
    const night = nightContaining(seg.from, seg.zone, config);
    if (!night) return seg.from;
    if (night.endsAt < seg.to) return night.endsAt;
  }
  return null;
}

// ---------- account rolls and storms ----------

export interface RollSlot {
  rolledAt: number;
  zone: string;
  night: NightWindow;
}

// The next moment in [notBefore, notAfter] at which the account rolls. A roll happens only when
// the map *enters* a night: at dusk, when an accepted zone change turns a daytime map to night,
// or when the account's map clock starts at night. An entry sooner than `notBefore` (24 hours
// after the previous roll) gets no roll at all — that night stays calm — and so does an entry
// with less than the longest storm left before morning. Nothing ever rolls part-way through a
// night it did not just enter, so one late event never drags later rolls away from dusk.
export function nextRollSlot(
  changes: readonly ZoneChange[],
  notBefore: number,
  notAfter: number,
  clockStart: number,
  config: DaylightConfig = DAYLIGHT_DEFAULTS,
): RollSlot | null {
  const changeAt = new Set(changes.map((c) => c.effectiveAt));
  const segments = zoneSegments(changes, Math.max(notBefore, clockStart), notAfter + 1);
  for (const [k, seg] of segments.entries()) {
    const entries: number[] = [];
    // The segment's own start is an entry when the clock starts there at night, or when a zone
    // change there turned the map from day to night.
    const opensAtNight = phaseAt(seg.from, seg.zone, config) === 'night';
    if (opensAtNight) {
      if (seg.from === clockStart) entries.push(seg.from);
      else if (k > 0 || changeAt.has(seg.from)) {
        const before = zoneAt(changes, seg.from - 1);
        if (before && phaseAt(seg.from - 1, before, config) === 'day') entries.push(seg.from);
      }
    }
    for (const at of entries) {
      const night = nightContaining(at, seg.zone, config);
      if (night && night.endsAt - at >= RISK_POLICY.stormMaxMs)
        return { rolledAt: at, zone: seg.zone, night };
    }
    // Dusks inside the segment, night by night: a long catch-up costs one pass.
    const first = localParts(seg.from, seg.zone);
    let cursor = shiftDay(first.year, first.month, first.day, -1);
    for (let guard = 0; guard < 4000; guard++) {
      const key = nightKeyFor(cursor.year, cursor.month, cursor.day);
      const night = nightWindow(key, seg.zone, config);
      if (night.startsAt >= seg.to) break;
      cursor = shiftDay(cursor.year, cursor.month, cursor.day, 1);
      if (night.startsAt < seg.from) continue;
      if (night.endsAt - night.startsAt >= RISK_POLICY.stormMaxMs)
        return { rolledAt: night.startsAt, zone: seg.zone, night };
    }
  }
  return null;
}

export interface AccountStorm {
  startsAt: number;
  endsAt: number;
  // The one moment of risk: the storm's midpoint.
  decisionAt: number;
}

export interface AccountRoll extends RollSlot {
  storm: AccountStorm | null;
}

// The roll itself. Same account, same moment, same night: same result, forever.
export function rollAccountStorm(
  userId: string,
  slot: RollSlot,
  policyVersion = RISK_POLICY_VERSION,
): AccountRoll {
  const seed = hashSeed(policyVersion, 'account-storm', userId, slot.rolledAt);
  if (draw(seed, 0) >= RISK_POLICY.stormNightChance) return { ...slot, storm: null };
  const duration =
    RISK_POLICY.stormMinMs + draw(seed, 1) * (RISK_POLICY.stormMaxMs - RISK_POLICY.stormMinMs);
  const room = Math.max(0, slot.night.endsAt - slot.rolledAt - duration);
  const startsAt = Math.round(slot.rolledAt + draw(seed, 2) * room);
  const endsAt = Math.min(slot.night.endsAt, Math.round(startsAt + duration));
  return {
    ...slot,
    storm: { startsAt, endsAt, decisionAt: Math.round((startsAt + endsAt) / 2) },
  };
}

// A bottle's own draws for one storm: independent of every other bottle in the same storm.
export function bottleRiskDraws(
  bottleId: string,
  rolledAt: number,
  policyVersion = RISK_POLICY_VERSION,
): { lossDraw: number; reasonDraw: number } {
  const seed = hashSeed(policyVersion, 'risk', bottleId, rolledAt);
  return { lossDraw: draw(seed, 0), reasonDraw: draw(seed, 1) };
}

// The pure decision rule, so it can be tested apart from the database. A decision is eligible
// only while the bottle is still at sea before its arrival, under the progress cutoff, and
// within the first five eligible decisions of the journey.
export function decideRisk(input: {
  storm: { decisionAt: number; lossDraw: number; reasonDraw: number };
  progressAtDecision: number;
  arrivalAt: number;
  priorEligibleDecisions: number;
}): { eligible: boolean; lost: boolean; reason: 'adrift' | 'sunk' | null } {
  const { storm } = input;
  const eligible =
    storm.decisionAt < input.arrivalAt &&
    input.progressAtDecision < RISK_POLICY.progressCutoff &&
    input.priorEligibleDecisions < RISK_POLICY.maxRiskDecisions;
  if (!eligible) return { eligible: false, lost: false, reason: null };
  const lost = storm.lossDraw < RISK_POLICY.lossChance;
  if (!lost) return { eligible: true, lost: false, reason: null };
  return {
    eligible: true,
    lost: true,
    reason: storm.reasonDraw < RISK_POLICY.adriftShare ? 'adrift' : 'sunk',
  };
}
