import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, createDb, runMigrations } from './client.js';
import * as t from './schema.js';
import { DEV_SEED_PASSWORD } from './seed-data.js';
import { seedChart, seedUsers } from './seed.js';
import { createApp } from '../http/app.js';
import { OutboxMailer } from '../lib/mail.js';
import { releaseBottle } from '../services/release.js';
import { runJourneyTick } from '../services/journey.js';
import { getMyShore, getSentBottle, openBottle } from '../services/bottles.js';
import { ManualClock, T0, createTestWorld, releaseInput, testConfig } from '../test/harness.js';

type Row = Record<string, unknown>;
const NEWEST = '0005_bottle_outcomes';

function tableNames(sqlite: Database.Database): string[] {
  return sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    )
    .all()
    .map((r) => (r as { name: string }).name);
}
function columnsOf(sqlite: Database.Database, table: string): string[] {
  return sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => (c as { name: string }).name);
}
function dump(sqlite: Database.Database): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const name of tableNames(sqlite))
    out[name] = sqlite.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Row[];
  return out;
}

// Builds a migrations folder that stops before the newest migration, as an older deployment
// would have applied it.
function legacyMigrationsFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mib-legacy-'));
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const entries = journal.entries.filter((e) => e.tag !== NEWEST);
  expect(entries).toHaveLength(journal.entries.length - 1);
  fs.mkdirSync(path.join(dir, 'meta'));
  fs.writeFileSync(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const e of entries)
    fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

describe('migrating a populated database', () => {
  it('keeps every row of an active journey intact and the journey still arrives', () => {
    // 1. Populate a database with the current code (users, friendships, an at-sea bottle that is
    //    half-way, its events, reservation, idempotency record) …
    const source = createTestWorld();
    const ada = source.user('ada');
    const bo = source.user('bo');
    const bottleId = releaseBottle(
      source.ctx,
      ada,
      releaseInput(bo.id, 'migrate-key-0001'),
    ).bottleId;
    const plan = source.db
      .select()
      .from(t.routePlans)
      .where(eq(t.routePlans.bottleId, bottleId))
      .get()!;
    source.clock.advance(Math.floor(plan.plannedDurationMs / 2));
    const midway = getSentBottle(source.ctx, ada, bottleId);
    expect(midway.state).toBe('at_sea');
    expect(midway.position.progress).toBeCloseTo(0.5, 3);
    const sourceSqlite = (source.db as unknown as { $client: Database.Database }).$client;

    // 2. … and replay those rows into a database at the previous schema (no outcome columns,
    //    no bottle_outcome_views table), exactly what an older installation holds on disk.
    const legacyDir = legacyMigrationsFolder();
    const { db, sqlite } = createDb(':memory:');
    runMigrations(db, legacyDir);
    expect(columnsOf(sqlite, 'bottles')).not.toContain('outcome_at');
    expect(tableNames(sqlite)).not.toContain('bottle_outcome_views');
    sqlite.pragma('foreign_keys = OFF');
    for (const [table, rows] of Object.entries(dump(sourceSqlite))) {
      if (!tableNames(sqlite).includes(table)) continue;
      const cols = columnsOf(sqlite, table);
      const insert = sqlite.prepare(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      );
      for (const row of rows) insert.run(cols.map((c) => row[c] ?? null));
    }
    sqlite.pragma('foreign_keys = ON');
    const before = dump(sqlite);
    expect(before.bottles).toHaveLength(1);
    expect(before.journey_events!.length).toBeGreaterThan(0);
    expect(before.route_plans).toHaveLength(1);
    expect(before.capacity_reservations).toHaveLength(1);

    // 3. Upgrade in place, then run the additive seed the server runs at boot.
    runMigrations(db);
    expect(columnsOf(sqlite, 'bottles')).toContain('outcome_at');
    expect(tableNames(sqlite)).toContain('bottle_outcome_views');
    seedChart(db, testConfig().defaultShoreCapacity, T0);

    // 4. Every pre-existing table is row-for-row identical: ids, states, versions, timestamps,
    //    node lists, progress, events, reservations. The seed only filled the new columns.
    const after = dump(sqlite);
    for (const [table, rows] of Object.entries(before)) {
      const kept = after[table]!.map((r) =>
        Object.fromEntries(Object.entries(r).filter(([k]) => k in (rows[0] ?? r))),
      );
      expect(kept, table).toEqual(rows);
    }
    expect(after.shores!.find((s) => s.id === 'shore_pt_lisbon')).toMatchObject({
      country_name: 'Portugal',
      sea: 'North Atlantic',
    });
    expect(after.shores!.find((s) => s.id === 'shore_lantern_cove')!.country_name).toBeNull();

    // 5. The upgraded database serves the current API and the journey completes on schedule.
    const clock = new ManualClock(source.clock.now());
    const config = testConfig();
    const ctx = { db, clock, realClock: clock, config, mailer: new OutboxMailer() };
    const app = createApp(ctx);
    const mid = getSentBottle(ctx, ada, bottleId);
    expect(mid.position.progress).toBeCloseTo(0.5, 3);
    expect(mid.route.nodeIds).toEqual(plan.nodeIds);
    expect(getMyShore(ctx, bo).bottles).toEqual([]);
    clock.advance(Math.ceil(plan.plannedDurationMs / 2) - 1);
    expect(runJourneyTick(ctx).delivered).toBe(0);
    clock.advance(1);
    expect(runJourneyTick(ctx).delivered).toBe(1);
    const landed = getMyShore(ctx, bo).bottles;
    expect(landed.map((b) => b.id)).toEqual([bottleId]);
    expect(landed[0]!.state).toBe('delivered');
    const opened = openBottle(ctx, bo, bottleId);
    expect(opened.letter.text).toBe(releaseInput(bo.id).text);
    // Old accounts keep signing in with their existing password; new ones register with e-mail.
    seedUsers(db, T0);
    expect(
      ctx.db.select().from(t.users).where(eq(t.users.username, 'ada')).get()!.email,
    ).toBeNull();
    fs.rmSync(legacyDir, { recursive: true, force: true });
    void app;
    void DEV_SEED_PASSWORD;
    // Two full migrations plus the seeded sea graph land just either side of vitest's 5 s default
    // on a slow machine, so this test's budget is explicit rather than left to flake on timing.
  }, 60_000);
});
