import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NodeKind } from '../../domain/routing.js';
import { CHART_BOUNDS } from '../seed-data.js';

// Bundled sea-route graph produced by src/tools/geo/build-world.ts. Parsed once per process.
export interface SeaGraphNode {
  id: string;
  kind: NodeKind;
  shoreId: string | null;
  lng: number;
  lat: number;
  x: number;
  y: number;
}
export interface SeaGraphEdge {
  from: string;
  to: string;
  length: number;
}
export interface SeaGraph {
  version: number;
  nodes: SeaGraphNode[];
  edges: SeaGraphEdge[];
}

interface SeaGraphFile {
  version: number;
  nodes: Array<[string, NodeKind, string | null, number, number]>;
  edges: Array<[number, number, number]>;
}

export const SEA_GRAPH_FILE = fileURLToPath(new URL('./data/sea-graph.v2.json', import.meta.url));

// Chart coordinates are a plain equirectangular projection of the anchor onto the 1000 x 600
// canvas; routing lengths come from the generator (great-circle km), not from these.
export function chartXY(lng: number, lat: number): { x: number; y: number } {
  return {
    x: Math.round(((lng + 180) / 360) * CHART_BOUNDS.width),
    y: Math.round(((90 - lat) / 180) * CHART_BOUNDS.height),
  };
}

let cached: SeaGraph | null = null;

export function loadSeaGraph(): SeaGraph {
  if (cached) return cached;
  const file = JSON.parse(fs.readFileSync(SEA_GRAPH_FILE, 'utf8')) as SeaGraphFile;
  const nodes: SeaGraphNode[] = file.nodes.map(([id, kind, shoreId, lng, lat]) => ({
    id,
    kind,
    shoreId,
    lng,
    lat,
    ...chartXY(lng, lat),
  }));
  const edges: SeaGraphEdge[] = file.edges.map(([a, b, length]) => {
    const from = nodes[a];
    const to = nodes[b];
    if (!from || !to) throw new Error(`sea graph edge references missing node ${a}-${b}`);
    return { from: from.id, to: to.id, length };
  });
  cached = { version: file.version, nodes, edges };
  return cached;
}
