import type { AgingProfile } from '@mib/shared';
import { sha256 } from '../lib/ids.js';

// Reproducible presentation parameters (spec §10.2): derived once from the journey and
// frozen at arrival, never re-rolled on open. Storm/stranding inputs are added in stage 4.
export function deriveAgingProfile(input: {
  bottleId: string;
  releasedAt: number;
  deliveredAt: number;
  plannedDurationMs: number;
}): AgingProfile {
  const travelMs = Math.max(0, input.deliveredAt - input.releasedAt);
  const relative = input.plannedDurationMs > 0 ? travelMs / input.plannedDurationMs : 1;
  const days = travelMs / (24 * 60 * 60 * 1000);
  const yellowing = clamp(0.25 + 0.15 * Math.min(relative, 1) + 0.08 * Math.min(days, 5), 0, 0.85);
  const wear = clamp(0.2 + 0.1 * Math.min(days, 6), 0, 0.8);

  const hex = sha256(`aging:${input.bottleId}`);
  const rnd = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
  const edges = ['top', 'right', 'bottom', 'left'] as const;
  const tearCount = 1 + Math.round(rnd(0) * 2);
  const tears = Array.from({ length: tearCount }, (_, i) => ({
    edge: edges[Math.floor(rnd(1 + i) * edges.length) % edges.length]!,
    at: round2(rnd(5 + i)),
  }));
  const stainCount = Math.round(rnd(9) * 2);
  const stains = Array.from({ length: stainCount }, (_, i) => ({
    x: round2(rnd(10 + i * 3)),
    y: round2(rnd(11 + i * 3)),
    size: round2(0.05 + rnd(12 + i * 3) * 0.1),
  }));
  return { yellowing: round2(yellowing), wear: round2(wear), tears, stains };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
