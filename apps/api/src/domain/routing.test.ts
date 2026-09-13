import { describe, expect, it } from 'vitest';
import { SEED_EDGES, SEED_NODES, edgeLength } from '../db/seed-data.js';
import { buildGraph, planRoute, pointAlongPath, progressAt, type GraphNode } from './routing.js';

function seedGraph() {
  const byId = new Map(SEED_NODES.map((n) => [n.id, n]));
  const nodes: GraphNode[] = SEED_NODES.map((n) => ({
    id: n.id,
    kind: n.kind,
    shoreId: n.shoreId ?? null,
    position: { x: n.x, y: n.y },
    geo: { lng: n.lng, lat: n.lat },
  }));
  const edges = SEED_EDGES.map(([from, to]) => ({
    from,
    to,
    length: edgeLength(byId.get(from)!, byId.get(to)!),
  }));
  return { graph: buildGraph(1, nodes, edges), edges };
}

describe('connected maritime routing (spec §6.3, §18 #5)', () => {
  it('every planned hop is an existing sea passage; islands are never through-passages', () => {
    const { graph, edges } = seedGraph();
    const passages = new Set(edges.flatMap((e) => [`${e.from}|${e.to}`, `${e.to}|${e.from}`]));
    const shores = SEED_NODES.filter((n) => n.kind === 'shore');
    for (const a of shores) {
      for (const b of shores) {
        if (a === b) continue;
        const path = planRoute(graph, a.shoreId!, b.shoreId!);
        expect(path, `${a.id}->${b.id}`).not.toBeNull();
        for (let i = 1; i < path!.nodeIds.length; i++) {
          expect(passages.has(`${path!.nodeIds[i - 1]}|${path!.nodeIds[i]}`)).toBe(true);
          expect(graph.nodes.get(path!.nodeIds[i]!)!.kind).not.toBe('island');
        }
      }
    }
  });

  it('same-shore sends use a local sea loop with non-zero length', () => {
    const { graph } = seedGraph();
    const loop = planRoute(graph, 'shore_gull_hollow', 'shore_gull_hollow')!;
    expect(loop.nodeIds[0]).toBe(loop.nodeIds[loop.nodeIds.length - 1]);
    expect(loop.nodeIds.length).toBe(3);
    expect(loop.totalLength).toBeGreaterThan(0);
  });

  it('returns null instead of fabricating a route to a disconnected shore', () => {
    const { graph } = seedGraph();
    graph.nodes.set('n_lonely', {
      id: 'n_lonely',
      kind: 'shore',
      shoreId: 'shore_lonely',
      position: { x: 1, y: 1 },
      geo: null,
    });
    graph.adjacency.set('n_lonely', []);
    expect(planRoute(graph, 'shore_lantern_cove', 'shore_lonely')).toBeNull();
  });
});

describe('simulated position', () => {
  it('interpolates along the polyline by geometric length', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(pointAlongPath(pts, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAlongPath(pts, 0.5)).toEqual({ x: 10, y: 0 });
    expect(pointAlongPath(pts, 0.75)).toEqual({ x: 10, y: 5 });
    expect(pointAlongPath(pts, 1)).toEqual({ x: 10, y: 10 });
    expect(pointAlongPath(pts, 7)).toEqual({ x: 10, y: 10 });
  });

  it('progress is clamped and honours a resumed plan start', () => {
    const plan = { startsAt: 1000, startProgress: 0.4, plannedDurationMs: 600 };
    expect(progressAt(plan, 500)).toBe(0.4);
    expect(progressAt(plan, 1300)).toBeCloseTo(0.7);
    expect(progressAt(plan, 5000)).toBe(1);
  });
});
