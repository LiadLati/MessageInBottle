import { and, eq } from 'drizzle-orm';
import type { ChartResponse, GeoPoint, ShoreDto } from '@mib/shared';
import type { DbOrTx } from '../db/client.js';
import * as t from '../db/schema.js';
import { CHART_BOUNDS } from '../db/seed-data.js';
import { buildGraph, type RouteGraph } from '../domain/routing.js';
import { badRequest, notFound } from '../lib/errors.js';
import type { AppContext } from './context.js';

export function loadActiveGraph(db: DbOrTx): RouteGraph {
  const version = db
    .select()
    .from(t.routeGraphVersions)
    .where(eq(t.routeGraphVersions.active, true))
    .get();
  if (!version) throw new Error('no active route graph');
  const nodes = db
    .select()
    .from(t.routeNodes)
    .where(eq(t.routeNodes.graphVersion, version.version))
    .all();
  const edges = db
    .select()
    .from(t.routeEdges)
    .where(eq(t.routeEdges.graphVersion, version.version))
    .all();
  return buildGraph(
    version.version,
    nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      shoreId: n.shoreId,
      position: { x: n.chartX, y: n.chartY },
      geo: geoOf(n),
    })),
    edges.map((e) => ({ from: e.fromNodeId, to: e.toNodeId, length: e.length })),
  );
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
  };
}

export function getChart(ctx: AppContext): ChartResponse {
  const graph = loadActiveGraph(ctx.db);
  const shores = ctx.db.select().from(t.shores).where(eq(t.shores.active, true)).all();
  const edges: ChartResponse['edges'] = [];
  const seen = new Set<string>();
  for (const [from, list] of graph.adjacency) {
    for (const { to } of list) {
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }
  return {
    graphVersion: graph.version,
    bounds: { ...CHART_BOUNDS },
    nodes: [...graph.nodes.values()].map((n) => ({
      id: n.id,
      kind: n.kind,
      position: n.position,
      geo: n.geo,
      shoreId: n.shoreId,
    })),
    edges,
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
  const connected = [...graph.nodes.values()].some(
    (n) => n.kind === 'shore' && n.shoreId === shoreId,
  );
  if (!connected)
    throw badRequest('shore_unsupported', 'this shore is not connected to the sea routes');
  ctx.db.update(t.users).set({ shoreId }).where(eq(t.users.id, userId)).run();
}
