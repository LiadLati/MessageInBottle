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
