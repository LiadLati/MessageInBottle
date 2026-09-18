import { describe, expect, it } from 'vitest';
import {
  DAYLIGHT_DEFAULTS,
  OCEAN_SCHEDULE,
  SHORE_SCHEDULE,
  activeStormAt,
  hourInWindow,
  localHourIn,
  phaseAt,
  stormInWindow,
} from './weather.js';

const at = (iso: string) => Date.parse(iso);

describe('day/night phase', () => {
  it('uses the browser timezone, not UTC and never a coordinate', () => {
    // One instant, three zones, three local hours.
    const instant = at('2026-09-16T12:00:00.000Z');
    expect(localHourIn(instant, 'UTC')).toBe(12);
    expect(localHourIn(instant, 'Asia/Jerusalem')).toBe(15);
    expect(localHourIn(instant, 'America/Los_Angeles')).toBe(5);
    expect(phaseAt(instant, 'UTC')).toBe('day');
    expect(phaseAt(instant, 'Asia/Jerusalem')).toBe('day');
    expect(phaseAt(instant, 'America/Los_Angeles')).toBe('night'); // 05:00 local is before 07:00
  });

  it('treats the boundaries as [dayStart, dayEnd): 07:00 is day, 19:00 is night', () => {
    expect(phaseAt(at('2026-09-16T06:59:59.000Z'), 'UTC')).toBe('night');
    expect(phaseAt(at('2026-09-16T07:00:00.000Z'), 'UTC')).toBe('day');
    expect(phaseAt(at('2026-09-16T18:59:59.000Z'), 'UTC')).toBe('day');
    expect(phaseAt(at('2026-09-16T19:00:00.000Z'), 'UTC')).toBe('night');
    expect(phaseAt(at('2026-09-17T00:00:00.000Z'), 'UTC')).toBe('night');
  });

  it('supports a configured window that wraps midnight', () => {
    const night = { dayStartHour: 22, dayEndHour: 5 };
    expect(hourInWindow(23, 22, 5)).toBe(true);
    expect(hourInWindow(2, 22, 5)).toBe(true);
    expect(hourInWindow(5, 22, 5)).toBe(false);
    expect(hourInWindow(12, 22, 5)).toBe(false);
    expect(phaseAt(at('2026-09-16T23:30:00.000Z'), 'UTC', night)).toBe('day');
    expect(phaseAt(at('2026-09-16T12:00:00.000Z'), 'UTC', night)).toBe('night');
    // An empty window is never "day".
    expect(hourInWindow(7, 7, 7)).toBe(false);
  });

  it('honours a non-default daylight window', () => {
    const early = { dayStartHour: 5, dayEndHour: 17 };
    expect(phaseAt(at('2026-09-16T06:00:00.000Z'), 'UTC', early)).toBe('day');
    expect(phaseAt(at('2026-09-16T06:00:00.000Z'), 'UTC', DAYLIGHT_DEFAULTS)).toBe('night');
    expect(phaseAt(at('2026-09-16T18:00:00.000Z'), 'UTC', early)).toBe('night');
  });
});

describe('storm scheduling is deterministic and versioned', () => {
  const day = at('2026-09-16T00:00:00.000Z');

  it('returns the identical storm for the same inputs, however often it is asked', () => {
    const runs = Array.from({ length: 5 }, () =>
      stormInWindow('btl_abc', day + 5 * 60 * 60 * 1000, OCEAN_SCHEDULE),
    );
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it('keeps a storm stable across the whole window it belongs to', () => {
    // Every instant inside one window resolves to the same schedule entry.
    let found = null;
    for (let i = 0; i < 40 && !found; i++) {
      found = stormInWindow('btl_stable', day + i * OCEAN_SCHEDULE.windowMs, OCEAN_SCHEDULE);
      if (found) {
        const start = found.windowIndex * OCEAN_SCHEDULE.windowMs;
        for (const probe of [start, start + 1000, start + OCEAN_SCHEDULE.windowMs - 1]) {
          expect(stormInWindow('btl_stable', probe, OCEAN_SCHEDULE)).toEqual(found);
        }
      }
    }
    expect(found).not.toBeNull();
  });

  it('gives different bottles independent weather and bumps with the schedule version', () => {
    const a = stormInWindow('btl_a', day, OCEAN_SCHEDULE);
    const b = stormInWindow('btl_b', day, OCEAN_SCHEDULE);
    expect(a?.id ?? null).not.toEqual(b?.id ?? 'x');
    const v1 = stormInWindow('btl_a', day, OCEAN_SCHEDULE, 1);
    const v2 = stormInWindow('btl_a', day, OCEAN_SCHEDULE, 2);
    expect(v1?.id ?? null).not.toEqual(v2?.id ?? 'x');
  });

  it('stays inside its window and respects the configured duration bounds', () => {
    let seen = 0;
    for (let i = 0; i < 400; i++) {
      const storm = stormInWindow(`btl_${i}`, day + i * OCEAN_SCHEDULE.windowMs, OCEAN_SCHEDULE);
      if (!storm) continue;
      seen++;
      const start = storm.windowIndex * OCEAN_SCHEDULE.windowMs;
      const duration = storm.endsAt - storm.startsAt;
      expect(duration).toBeGreaterThanOrEqual(OCEAN_SCHEDULE.minDurationMs);
      expect(duration).toBeLessThanOrEqual(OCEAN_SCHEDULE.maxDurationMs);
      expect(storm.startsAt).toBeGreaterThanOrEqual(start);
      expect(storm.endsAt).toBeLessThanOrEqual(start + OCEAN_SCHEDULE.windowMs);
    }
    // Roughly the configured frequency — bounded, never "always" or "never".
    expect(seen).toBeGreaterThan(400 * 0.25);
    expect(seen).toBeLessThan(400 * 0.65);
  });

  it('activeStormAt only reports a storm while it is running', () => {
    let storm = null;
    for (let i = 0; i < 40 && !storm; i++) {
      storm = stormInWindow(`btl_active_${i}`, day, OCEAN_SCHEDULE);
      if (storm) {
        const subject = `btl_active_${i}`;
        expect(activeStormAt(subject, storm.startsAt, OCEAN_SCHEDULE)?.id).toBe(storm.id);
        expect(activeStormAt(subject, storm.endsAt - 1, OCEAN_SCHEDULE)?.id).toBe(storm.id);
        expect(activeStormAt(subject, storm.endsAt, OCEAN_SCHEDULE)?.id ?? null).not.toBe(storm.id);
        if (storm.startsAt > 0) {
          expect(activeStormAt(subject, storm.startsAt - 1, OCEAN_SCHEDULE)?.id ?? null).not.toBe(
            storm.id,
          );
        }
      }
    }
    expect(storm).not.toBeNull();
  });

  it('finds a storm that started in the previous window and is still running', () => {
    // A short window makes overruns common. Look for one whose *next* window is empty, so the
    // carry-over is the only possible answer.
    const cfg = { ...OCEAN_SCHEDULE, windowMs: 60 * 60 * 1000 };
    let crossing: { id: string; storm: NonNullable<ReturnType<typeof stormInWindow>> } | null =
      null;
    for (let i = 0; i < 800 && !crossing; i++) {
      const id = `btl_x_${i}`;
      const storm = stormInWindow(id, day, cfg);
      if (!storm) continue;
      const nextStart = (storm.windowIndex + 1) * cfg.windowMs;
      if (storm.endsAt > nextStart && !stormInWindow(id, nextStart, cfg)) {
        crossing = { id, storm };
      }
    }
    expect(crossing).not.toBeNull();
    const after = (crossing!.storm.windowIndex + 1) * cfg.windowMs + 1000;
    expect(activeStormAt(crossing!.id, after, cfg)?.id).toBe(crossing!.storm.id);
  });

  it('schedules the shore independently of any bottle', () => {
    // The same identifier under the two configs must not produce the same storm windows.
    const ocean = Array.from({ length: 24 }, (_, i) =>
      Boolean(stormInWindow('same_id', day + i * 3600_000, OCEAN_SCHEDULE)),
    );
    const shore = Array.from({ length: 24 }, (_, i) =>
      Boolean(stormInWindow('same_id', day + i * 3600_000, SHORE_SCHEDULE)),
    );
    expect(ocean).not.toEqual(shore);
  });
});
