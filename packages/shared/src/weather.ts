// Day/night phase and simulated-weather scheduling.
//
// Everything here is pure and deterministic: the same inputs always produce the same weather, so
// a refresh, a different selection, a second client or a server restart all agree without any
// stored state. The schedule is versioned; bumping SCHEDULE_VERSION reshuffles every future
// window deliberately. It lives in the shared package so it can move behind an API endpoint
// later without changing a single value.
//
// Weather is cosmetic. Nothing in this module influences a route, a duration or an arrival.

export type DayPhase = 'day' | 'night';

export interface DaylightConfig {
  // Local hour (0–23) at which day begins and ends. A window that wraps midnight is supported.
  dayStartHour: number;
  dayEndHour: number;
}

export const DAYLIGHT_DEFAULTS: DaylightConfig = { dayStartHour: 7, dayEndHour: 19 };

// The local hour of an instant in an IANA zone. The zone comes from the browser
// (Intl.DateTimeFormat().resolvedOptions().timeZone) — never from coordinates or a device sensor.
export function localHourIn(instantMs: number, timeZone?: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
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

// ---------- journey risk policy (approved 2026-09-19) ----------
//
// The first *consequential* weather. Everything is a pure function of the policy version, the
// bottle id and the night, so the server can decide the same thing after a restart, a retry or
// a long outage, and no client can influence it. Values are the approved ones; changing any of
// them means a new POLICY version, never an edit in place.
//
//   • Nights are the nights on the sender's own Ocean map: 19:00–07:00 (DAYLIGHT_DEFAULTS) in
//     the account's persisted IANA time zone, whatever water a bottle is on. One phase per
//     account drives the map's palette, every storm on it, every risk decision and the sea
//     view's lighting — so a daytime map can never hold a bottle in a risk-bearing storm. A
//     night is keyed by the local date it starts on.
//   • Each at-sea bottle has a 25% chance of a storm on each night, independently of every
//     other bottle. A storm is one window of 40–100 minutes inside the night.
//   • A storm night carries at most one risk decision, at the storm's midpoint — after the
//     storm has become visible, while the bottle is still at sea.
//   • An eligible decision loses the bottle with 1% probability; only the first five eligible
//     decisions of a journey carry risk (max journey loss 1 − 0.99⁵ ≈ 4.9%); nothing is
//     decided at or after 80% progress. Lost bottles go adrift 75% / sink 25% of the time.

// v1 counted nights in a zone configured on the server; v2 at the bottle's own meridian. Both
// are superseded: from v3 every versioned journey walks the nights of its sender's account
// zone, and a journey's stamp only records the version it was released under.
export const RISK_POLICY_VERSION = 3;

export const RISK_POLICY = {
  version: RISK_POLICY_VERSION,
  stormNightChance: 0.25,
  stormMinMs: 40 * 60 * 1000,
  stormMaxMs: 100 * 60 * 1000,
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
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const get = (type: string) =>
    Number(fmt.formatToParts(new Date(instantMs)).find((p) => p.type === type)?.value ?? '0');
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

export interface StormNight {
  key: NightKey;
  startsAt: number;
  endsAt: number;
  // The one stable moment of the night at which a risk decision may be taken.
  decisionAt: number;
  lossDraw: number;
  reasonDraw: number;
}

// The storm of one night for one bottle, or null on a calm night. Same inputs, same storm —
// forever. The draws for the decision come from the same seed so nothing is rolled later.
export function stormForNight(
  bottleId: string,
  night: NightWindow,
  policyVersion = RISK_POLICY_VERSION,
): StormNight | null {
  const seed = hashSeed(policyVersion, 'risk', bottleId, night.key);
  if (draw(seed, 0) >= RISK_POLICY.stormNightChance) return null;
  const duration =
    RISK_POLICY.stormMinMs + draw(seed, 1) * (RISK_POLICY.stormMaxMs - RISK_POLICY.stormMinMs);
  const startsAt =
    night.startsAt + draw(seed, 2) * Math.max(0, night.endsAt - night.startsAt - duration);
  const endsAt = startsAt + duration;
  return {
    key: night.key,
    startsAt: Math.round(startsAt),
    endsAt: Math.round(endsAt),
    decisionAt: Math.round(startsAt + duration / 2),
    lossDraw: draw(seed, 3),
    reasonDraw: draw(seed, 4),
  };
}

// The pure decision rule, so it can be tested apart from the database. A decision is eligible
// only while the bottle is still at sea before its arrival, under the progress cutoff, and
// within the first five eligible decisions of the journey.
export function decideRisk(input: {
  storm: StormNight;
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
