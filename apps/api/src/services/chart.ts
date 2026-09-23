import { and, eq } from 'drizzle-orm';
import type { ChartResponse, GeoPoint, ShoreDto } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { CHART_BOUNDS } from '../db/seed-data.js';
import { buildGraph, shoreNodeId, type RouteGraph } from '../domain/routing.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { AppContext } from './context.js';

// Graphs are immutable once written, so each (database, version) pair is built once. The active
// version is still read per call: it is one row and it changes when a new graph is seeded.
//
// The key is the underlying SQLite connection, not the Drizzle object: every transaction is a
// new Drizzle object over the same connection, and keying on it rebuilt the 173,000-element
// sea graph inside every release's write transaction — ~0.3–0.8 s per release, serialising
// every writer (audit QA-006).
const graphCache = new WeakMap<object, Map<number, RouteGraph>>();

function connectionOf(db: DbOrTx): object {
  return (db as unknown as { session?: { client?: object } }).session?.client ?? db;
}

function cacheFor(db: DbOrTx): Map<number, RouteGraph> {
  const key = connectionOf(db);
  let map = graphCache.get(key);
  if (!map) graphCache.set(key, (map = new Map<number, RouteGraph>()));
  return map;
}

export function loadGraphVersion(db: DbOrTx, version: number): RouteGraph {
  const cache = cacheFor(db);
  const hit = cache.get(version);
  if (hit) return hit;
  const nodes = db.select().from(t.routeNodes).where(eq(t.routeNodes.graphVersion, version)).all();
  const edges = db.select().from(t.routeEdges).where(eq(t.routeEdges.graphVersion, version)).all();
  const graph = buildGraph(
    version,
    nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      shoreId: n.shoreId,
      position: { x: n.chartX, y: n.chartY },
      geo: geoOf(n),
    })),
    edges.map((e) => ({ from: e.fromNodeId, to: e.toNodeId, length: e.length })),
  );
  cache.set(version, graph);
  return graph;
}

export function loadActiveGraph(db: DbOrTx): RouteGraph {
  const version = db
    .select()
    .from(t.routeGraphVersions)
    .where(eq(t.routeGraphVersions.active, true))
    .get();
  if (!version) throw new Error('no active route graph');
  return loadGraphVersion(db, version.version);
}

// Tests that edit graph rows directly call this to drop the memoised graph.
export function invalidateGraphCache(db: DbOrTx): void {
  graphCache.delete(connectionOf(db));
}

export function geoOf(row: { lng: number | null; lat: number | null }): GeoPoint | null {
  return row.lng === null || row.lat === null ? null : { lng: row.lng, lat: row.lat };
}

export function toShoreDto(row: typeof t.shores.$inferSelect): ShoreDto {
  return {
    id: row.id,
    name: row.name,
    position: { x: row.chartX, y: row.chartY },
    geo: geoOf(row),
    capacity: row.capacity,
    sea: row.sea,
  };
}

// The chart lists selectable shores only. The planning graph (tens of thousands of water
// nodes) stays server-side; clients receive the planned polyline of each bottle instead.
export function getChart(ctx: AppContext): ChartResponse {
  const graph = loadActiveGraph(ctx.db);
  const shores = ctx.db.select().from(t.shores).where(eq(t.shores.active, true)).all();
  return {
    graphVersion: graph.version,
    bounds: { ...CHART_BOUNDS },
    shores: shores.map(toShoreDto),
  };
}

export function getShore(db: DbOrTx, shoreId: string) {
  return db
    .select()
    .from(t.shores)
    .where(and(eq(t.shores.id, shoreId), eq(t.shores.active, true)))
    .get();
}

// Manual shore selection only; the app never stores coordinates (spec §6.1).
export function setUserShore(ctx: AppContext, userId: string, shoreId: string): void {
  const shore = getShore(ctx.db, shoreId);
  if (!shore) throw notFound('shore');
  const graph = loadActiveGraph(ctx.db);
  if (shoreNodeId(graph, shoreId) === null)
    throw badRequest('shore_unsupported', 'this shore is not connected to the sea routes');
  ctx.db.update(t.users).set({ shoreId }).where(eq(t.users.id, userId)).run();
}
