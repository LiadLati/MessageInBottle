import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { devClock } from '../db/schema.js';

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

// Development-only clock. The offset is persisted so a restart cannot silently rewind
// time and re-run journeys; production always uses SystemClock.
export class DevClock implements Clock {
  private offsetMs: number;

  constructor(private readonly db: Db) {
    const row = db.select().from(devClock).where(eq(devClock.id, 1)).get();
    if (row) {
      this.offsetMs = row.offsetMs;
    } else {
      db.insert(devClock).values({ id: 1, offsetMs: 0 }).run();
      this.offsetMs = 0;
    }
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  offset(): number {
    return this.offsetMs;
  }

  advance(ms: number): number {
    if (ms <= 0) throw new Error('clock can only move forward');
    this.offsetMs += ms;
    this.db.update(devClock).set({ offsetMs: this.offsetMs }).where(eq(devClock.id, 1)).run();
    return this.now();
  }

  advanceTo(targetMs: number): number {
    const delta = targetMs - this.now();
    if (delta > 0) this.advance(delta);
    return this.now();
  }
}
