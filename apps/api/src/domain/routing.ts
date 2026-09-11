import type { ChartPoint, GeoPoint } from '@mib/shared';

export type NodeKind = 'shore' | 'waypoint' | 'island';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  shoreId: string | null;
  position: ChartPoint;
  geo: GeoPoint | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  length: number;
}

export interface RouteGraph {
  version: number;
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, Array<{ to: string; length: number }>>;
}

export interface PlannedPath {
  nodeIds: string[];
  totalLength: number;
}

export function buildGraph(version: number, nodes: GraphNode[], edges: GraphEdge[]): RouteGraph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, Array<{ to: string; length: number }>>();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    if (!nodeMap.has(e.from) || !nodeMap.has(e.to)) {
      throw new Error(`edge references unknown node: ${e.from} -> ${e.to}`);
    }
    // Sea passages are navigable in both directions.
    adjacency.get(e.from)!.push({ to: e.to, length: e.length });
    adjacency.get(e.to)!.push({ to: e.from, length: e.length });
  }
  return { version, nodes: nodeMap, adjacency };
}

export function shoreNodeId(graph: RouteGraph, shoreId: string): string | null {
  for (const n of graph.nodes.values())
    if (n.kind === 'shore' && n.shoreId === shoreId) return n.id;
  return null;
}

// Islands are stranding points, never through-passages; only the connected water graph is
// used for planning. Returns null when no connected sea path exists (spec §6.3).
function dijkstra(graph: RouteGraph, from: string, to: string): PlannedPath | null {
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  while (true) {
    let current: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null) return null;
    if (current === to) break;
    visited.add(current);
    for (const edge of graph.adjacency.get(current) ?? []) {
      const nextNode = graph.nodes.get(edge.to)!;
      if (nextNode.kind === 'island' && edge.to !== to) continue;
      const candidate = best + edge.length;
      if (candidate < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, candidate);
        prev.set(edge.to, current);
      }
    }
  }
  const nodeIds: string[] = [];
  for (let cursor: string | undefined = to; cursor !== undefined; cursor = prev.get(cursor)) {
    nodeIds.unshift(cursor);
    if (cursor === from) break;
  }
  return { nodeIds, totalLength: dist.get(to)! };
}

// Same-shore sends use the shortest local sea loop out to a neighbouring waypoint and back so
// arrival is never instantaneous (spec §6.3). Returns null if the shore has no water neighbour.
function localLoop(graph: RouteGraph, shoreNode: string): PlannedPath | null {
  let best: PlannedPath | null = null;
  for (const edge of graph.adjacency.get(shoreNode) ?? []) {
    const neighbour = graph.nodes.get(edge.to)!;
    if (neighbour.kind !== 'waypoint') continue;
    const loop = { nodeIds: [shoreNode, edge.to, shoreNode], totalLength: edge.length * 2 };
    if (!best || loop.totalLength < best.totalLength) best = loop;
  }
  return best;
}

export function planRoute(
  graph: RouteGraph,
  originShoreId: string,
  destinationShoreId: string,
): PlannedPath | null {
  const from = shoreNodeId(graph, originShoreId);
  const to = shoreNodeId(graph, destinationShoreId);
  if (!from || !to) return null;
  if (from === to) return localLoop(graph, from);
  return dijkstra(graph, from, to);
}

export function pathPoints(graph: RouteGraph, nodeIds: string[]): ChartPoint[] {
  return nodeIds.map((id) => {
    const node = graph.nodes.get(id);
    if (!node) throw new Error(`route references unknown node ${id}`);
    return node.position;
  });
}

// Geographic polyline of a planned path; null when any node lacks an anchor (legacy graphs).
export function pathGeoPoints(graph: RouteGraph, nodeIds: string[]): GeoPoint[] | null {
  const out: GeoPoint[] = [];
  for (const id of nodeIds) {
    const node = graph.nodes.get(id);
    if (!node?.geo) return null;
    out.push(node.geo);
  }
  return out;
}

// Same interpolation as pointAlongPath, in lng/lat degree space (adequate at ocean scale).
export function geoPointAlongPath(points: GeoPoint[], progress: number): GeoPoint {
  const p = pointAlongPath(
    points.map((g) => ({ x: g.lng, y: g.lat })),
    progress,
  );
  return { lng: p.x, lat: p.y };
}

function segmentLength(a: ChartPoint, b: ChartPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Interpolates a point at `progress` (0..1) of the polyline's geometric length.
export function pointAlongPath(points: ChartPoint[], progress: number): ChartPoint {
  const first = points[0];
  if (!first) throw new Error('empty path');
  if (points.length === 1) return first;
  const p = Math.min(1, Math.max(0, progress));
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const len = segmentLength(points[i - 1]!, points[i]!);
    lengths.push(len);
    total += len;
  }
  if (total === 0) return first;
  let target = p * total;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (target <= len || i === lengths.length - 1) {
      const t = len === 0 ? 0 : Math.min(1, target / len);
      const a = points[i]!;
      const b = points[i + 1]!;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    target -= len;
  }
  return points[points.length - 1]!;
}

export interface PlanTiming {
  startsAt: number;
  startProgress: number; // 0..1 fraction of the plan already covered when it started
  plannedDurationMs: number; // time to cover the remaining (1 - startProgress) fraction
}

// Progress is a pure function of server time and the persisted plan (spec §7, §11 inv. 7).
export function progressAt(plan: PlanTiming, now: number): number {
  if (plan.plannedDurationMs <= 0) return 1;
  const elapsed = Math.max(0, now - plan.startsAt);
  const fraction = Math.min(1, elapsed / plan.plannedDurationMs);
  return Math.min(1, plan.startProgress + (1 - plan.startProgress) * fraction);
}

export function plannedArrivalAt(plan: PlanTiming): number {
  return plan.startsAt + plan.plannedDurationMs;
}

export function journeyDurationMs(
  totalLength: number,
  msPerChartUnit: number,
  minJourneyMs: number,
): number {
  return Math.max(minJourneyMs, Math.round(totalLength * msPerChartUnit));
}
