import type Database from 'better-sqlite3';
import { and, eq, isNull } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDb, runMigrations, type Db } from './client.js';
import * as t from './schema.js';
import {
  SEED_EDGES,
  DEV_SEED_PASSWORD,
  SEED_FRIENDSHIPS,
  SEED_NODES,
  SEED_SHORES,
  SEED_USERS,
  edgeLength,
} from './seed-data.js';
import { GLOBAL_SHORES } from './geo/shores.js';
import { chartXY, loadSeaGraph } from './geo/sea-graph.js';
import { newId } from '../lib/ids.js';
import { hashPassword } from '../lib/password.js';
import { canonicalPair } from '../services/friends.js';

// Databases created before geographic anchors existed get them filled in without a new graph
// version: the anchors only add a second coordinate space to the same nodes.
function backfillGeoAnchors(db: Db): void {
  db.transaction((tx) => {
    for (const s of SEED_SHORES) {
      tx.update(t.shores)
        .set({ lng: s.lng, lat: s.lat })
        .where(and(eq(t.shores.id, s.id), isNull(t.shores.lng)))
        .run();
    }
    for (const n of SEED_NODES) {
      tx.update(t.routeNodes)
        .set({ lng: n.lng, lat: n.lat })
        .where(and(eq(t.routeNodes.id, n.id), isNull(t.routeNodes.lng)))
        .run();
    }
  });
}

// Chart seeding is additive and idempotent. The original fictional chart (graph version 1 and
// its six shores) is written once and never modified afterwards; the global catalogue and the
// world sea graph (version 2) are added beside it and become the active planning graph. Route
// plans keep their own graph version, so bottles released on version 1 keep their snapshot.
export function seedChart(db: Db, capacity: number, now: number): void {
  seedLegacyChart(db, capacity, now);
  seedGlobalChart(db, capacity, now);
}

export function seedLegacyChart(db: Db, capacity: number, now: number): void {
  const existing = db.select().from(t.routeGraphVersions).get();
  if (existing) {
    backfillGeoAnchors(db);
    return;
  }
  db.transaction((tx) => {
    for (const s of SEED_SHORES) {
      tx.insert(t.shores)
        .values({
          id: s.id,
          name: s.name,
          chartX: s.x,
          chartY: s.y,
          lng: s.lng,
          lat: s.lat,
          capacity,
          active: true,
        })
        .onConflictDoNothing()
        .run();
    }
    tx.insert(t.routeGraphVersions).values({ version: 1, active: true, createdAt: now }).run();
    const byId = new Map(SEED_NODES.map((n) => [n.id, n]));
    for (const n of SEED_NODES) {
      tx.insert(t.routeNodes)
        .values({
          id: n.id,
          graphVersion: 1,
          kind: n.kind,
          shoreId: n.shoreId ?? null,
          chartX: n.x,
          chartY: n.y,
          lng: n.lng,
          lat: n.lat,
        })
        .run();
    }
    for (const [from, to] of SEED_EDGES) {
      const a = byId.get(from);
      const b = byId.get(to);
      if (!a || !b) throw new Error(`seed edge references unknown node ${from}-${to}`);
      tx.insert(t.routeEdges)
        .values({ graphVersion: 1, fromNodeId: from, toNodeId: to, length: edgeLength(a, b) })
        .run();
    }
  });
}

function seedGlobalChart(db: Db, capacity: number, now: number): void {
  const graph = loadSeaGraph();
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  const present = db
    .select()
    .from(t.routeGraphVersions)
    .where(eq(t.routeGraphVersions.version, graph.version))
    .get();
  db.transaction((tx) => {
    for (const s of GLOBAL_SHORES) {
      const { x, y } = chartXY(s.lng, s.lat);
      tx.insert(t.shores)
        .values({
          id: s.id,
          name: s.name,
          chartX: x,
          chartY: y,
          lng: s.lng,
          lat: s.lat,
          capacity,
          active: true,
          countryId: s.country,
          countryName: s.countryName,
          sea: s.sea,
        })
        .onConflictDoNothing()
        .run();
      // Attribution columns are new; fill them on catalogue rows written before they existed.
      tx.update(t.shores)
        .set({ countryId: s.country, countryName: s.countryName, sea: s.sea })
        .where(and(eq(t.shores.id, s.id), isNull(t.shores.countryName)))
        .run();
    }
    if (!present) {
      tx.insert(t.routeGraphVersions)
        .values({ version: graph.version, active: false, createdAt: now })
        .run();
      // Tens of thousands of rows: prepared statements on the driver keep this under a second.
      const insertNode = sqlite.prepare(
        'INSERT INTO route_nodes (id, graph_version, kind, shore_id, chart_x, chart_y, lng, lat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const n of graph.nodes)
        insertNode.run(n.id, graph.version, n.kind, n.shoreId, n.x, n.y, n.lng, n.lat);
      const insertEdge = sqlite.prepare(
        'INSERT INTO route_edges (graph_version, from_node_id, to_node_id, length) VALUES (?, ?, ?, ?)',
      );
      for (const e of graph.edges) insertEdge.run(graph.version, e.from, e.to, e.length);
    }
    // The newest graph plans new journeys; older versions stay for their existing plans.
    tx.update(t.routeGraphVersions).set({ active: false }).run();
    tx.update(t.routeGraphVersions)
      .set({ active: true })
      .where(eq(t.routeGraphVersions.version, graph.version))
      .run();
  });
}

// Development-only accounts. Callers must guard with devMode (server.ts, reset.ts, the seed
// script and the test harness do); the function itself never runs in production paths.
export function seedUsers(db: Db, now: number): void {
  const devHash = hashPassword(DEV_SEED_PASSWORD);
  db.transaction((tx) => {
    const ids = new Map<string, string>();
    for (const u of SEED_USERS) {
      const found = tx.select().from(t.users).where(eq(t.users.username, u.username)).get();
      if (found) {
        ids.set(u.username, found.id);
        // Accounts seeded before passwords existed get the development password once.
        if (found.passwordHash === null) {
          tx.update(t.users)
            .set({ passwordHash: devHash, passwordUpdatedAt: now })
            .where(eq(t.users.id, found.id))
            .run();
        }
        continue;
      }
      const id = newId('usr');
      tx.insert(t.users)
        .values({
          id,
          username: u.username,
          displayName: u.displayName,
          shoreId: u.shoreId,
          createdAt: now,
          passwordHash: devHash,
          passwordUpdatedAt: now,
        })
        .run();
      ids.set(u.username, id);
    }
    for (const f of SEED_FRIENDSHIPS) {
      const a = ids.get(f.a)!;
      const b = ids.get(f.b)!;
      const [low, high] = canonicalPair(a, b);
      tx.insert(t.friendships)
        .values({
          id: newId('frd'),
          userLowId: low,
          userHighId: high,
          requestedById: a,
          status: f.status,
          createdAt: now,
          acceptedAt: f.status === 'accepted' ? now : null,
        })
        .onConflictDoNothing()
        .run();
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { db } = createDb(config.databasePath);
  runMigrations(db);
  const now = Date.now();
  seedChart(db, config.defaultShoreCapacity, now);
  if (config.devMode) {
    seedUsers(db, now);
    console.log(`Seeded chart and development users into ${config.databasePath}`);
  } else {
    console.log(`Seeded chart into ${config.databasePath} (no users outside dev mode)`);
  }
}
