import { and, eq, isNull } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDb, runMigrations, type Db } from './client.js';
import * as t from './schema.js';
import {
  SEED_EDGES,
  SEED_FRIENDSHIPS,
  SEED_NODES,
  SEED_SHORES,
  SEED_USERS,
  edgeLength,
} from './seed-data.js';
import { newId } from '../lib/ids.js';
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

export function seedChart(db: Db, capacity: number, now: number): void {
  const existing = db
    .select()
    .from(t.routeGraphVersions)
    .where(eq(t.routeGraphVersions.active, true))
    .get();
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

export function seedUsers(db: Db, now: number): void {
  db.transaction((tx) => {
    const ids = new Map<string, string>();
    for (const u of SEED_USERS) {
      const found = tx.select().from(t.users).where(eq(t.users.username, u.username)).get();
      if (found) {
        ids.set(u.username, found.id);
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
  seedUsers(db, now);
  console.log(`Seeded chart and users into ${config.databasePath}`);
}
