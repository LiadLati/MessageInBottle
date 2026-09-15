import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb, runMigrations } from '../client.js';
import * as t from '../schema.js';
import { SEED_EDGES, SEED_NODES, SEED_SHORES } from '../seed-data.js';
import { seedChart, seedLegacyChart, seedUsers } from '../seed.js';
import { loadSeaGraph } from './sea-graph.js';
import { GLOBAL_SHORES } from './shores.js';
import coverage from './data/coverage.json' with { type: 'json' };
import { pathGeoPoints, planRoute } from '../../domain/routing.js';
import {
  CoastIndex,
  LandMask,
  haversineKm,
  legInlandKm,
  loadWorld,
} from '../../tools/geo/world.js';
import { OutboxMailer } from '../../lib/mail.js';
import { getSentBottle, openBottle } from '../../services/bottles.js';
import { invalidateGraphCache, loadActiveGraph, setUserShore } from '../../services/chart.js';
import { runJourneyTick } from '../../services/journey.js';
import { releaseBottle } from '../../services/release.js';
import { ManualClock, T0, createTestWorld, releaseInput, testConfig } from '../../test/harness.js';

const world = loadWorld();
const mask = new LandMask(world.landPolygons);
const coast = new CoastIndex(world.coastMesh);
const CONNECTOR_LAND_KM = 40;

describe('additive chart upgrade', () => {
  it('leaves every version-1 shore, node and edge untouched when the world graph is added', () => {
    const { db } = createDb(':memory:');
    runMigrations(db);
    seedLegacyChart(db, 5, T0);
    const shoresBefore = db.select().from(t.shores).all();
    const nodesBefore = db.select().from(t.routeNodes).all();
    const edgesBefore = db.select().from(t.routeEdges).all();
    expect(shoresBefore.map((s) => s.id).sort()).toEqual(SEED_SHORES.map((s) => s.id).sort());
    expect(nodesBefore).toHaveLength(SEED_NODES.length);
    expect(edgesBefore).toHaveLength(SEED_EDGES.length);

    seedChart(db, 5, T0 + 1);
    seedChart(db, 5, T0 + 2); // idempotent: a second boot adds nothing

    const legacyIds = new Set(SEED_SHORES.map((s) => s.id));
    const shoresAfter = db.select().from(t.shores).all();
    expect(shoresAfter.filter((s) => legacyIds.has(s.id))).toEqual(shoresBefore);
    expect(shoresAfter).toHaveLength(SEED_SHORES.length + GLOBAL_SHORES.length);
    const byId = <T extends { id?: string; fromNodeId?: string; toNodeId?: string }>(rows: T[]) =>
      [...rows].sort((a, b) =>
        `${a.id ?? ''}${a.fromNodeId ?? ''}${a.toNodeId ?? ''}`.localeCompare(
          `${b.id ?? ''}${b.fromNodeId ?? ''}${b.toNodeId ?? ''}`,
        ),
      );
    expect(
      byId(db.select().from(t.routeNodes).where(eq(t.routeNodes.graphVersion, 1)).all()),
    ).toEqual(byId(nodesBefore));
    expect(
      byId(db.select().from(t.routeEdges).where(eq(t.routeEdges.graphVersion, 1)).all()),
    ).toEqual(byId(edgesBefore));
    const versions = db.select().from(t.routeGraphVersions).all();
    expect(versions.map((v) => [v.version, v.active])).toEqual([
      [1, false],
      [2, true],
    ]);
    const sea = loadSeaGraph();
    expect(
      db.select().from(t.routeNodes).where(eq(t.routeNodes.graphVersion, 2)).all(),
    ).toHaveLength(sea.nodes.length);
  });

  it('keeps an at-sea journey planned on graph 1 on its path and schedule after the upgrade', () => {
    const { db } = createDb(':memory:');
    runMigrations(db);
    seedLegacyChart(db, 5, T0);
    seedUsers(db, T0);
    const clock = new ManualClock(T0);
    const ctx = { db, clock, config: testConfig(), mailer: new OutboxMailer() };
    const user = (username: string) => {
      const row = db.select().from(t.users).where(eq(t.users.username, username)).get()!;
      return {
        id: row.id,
        username,
        displayName: row.displayName,
        shoreId: row.shoreId,
        email: null,
      };
    };
    const ada = user('ada');
    const bo = user('bo');
    const { bottleId } = releaseBottle(ctx, ada, releaseInput(bo.id, 'upgrade-key-000001'));
    const planBefore = db
      .select()
      .from(t.routePlans)
      .where(eq(t.routePlans.bottleId, bottleId))
      .get()!;
    expect(planBefore.graphVersion).toBe(1);
    clock.advance(Math.floor(planBefore.plannedDurationMs / 2));
    const before = getSentBottle(ctx, ada, bottleId);

    seedChart(db, 5, clock.now());
    invalidateGraphCache(db);
    expect(loadActiveGraph(db).version).toBe(2);

    const planAfter = db
      .select()
      .from(t.routePlans)
      .where(eq(t.routePlans.bottleId, bottleId))
      .get()!;
    expect(planAfter).toEqual(planBefore);
    const after = getSentBottle(ctx, ada, bottleId);
    expect(after.route).toEqual(before.route);
    expect(after.position).toEqual(before.position);
    expect(after.plannedArrivalAt).toBe(before.plannedArrivalAt);
    expect(after.state).toBe('at_sea');

    // It still arrives exactly when it was going to, and can be opened.
    clock.advance(Math.ceil(planBefore.plannedDurationMs / 2) - 1);
    expect(runJourneyTick(ctx).delivered).toBe(0);
    clock.advance(1);
    expect(runJourneyTick(ctx).delivered).toBe(1);
    expect(openBottle(ctx, bo, bottleId).letter.text).toBe(releaseInput(bo.id).text);

    // New journeys plan on the world graph; a user can now anchor at a real harbour.
    setUserShore(ctx, bo.id, 'shore_jp_tokyo');
    const next = releaseBottle(ctx, ada, releaseInput(bo.id, 'upgrade-key-000002'));
    const nextPlan = db
      .select()
      .from(t.routePlans)
      .where(eq(t.routePlans.bottleId, next.bottleId))
      .get()!;
    expect(nextPlan.graphVersion).toBe(2);
    expect(nextPlan.nodeIds[0]).toBe('n_shore_lantern_cove');
    expect(nextPlan.nodeIds[nextPlan.nodeIds.length - 1]).toBe('n_shore_jp_tokyo');
  });
});

describe('shore catalogue', () => {
  it('gives every supported coastal country at least one connected shore', () => {
    const graph = loadActiveGraph(createTestWorld().db);
    const catalogueIds = new Set(GLOBAL_SHORES.map((s) => s.id));
    expect(coverage.included.length + coverage.excluded.length).toBe(coverage.totals.coastal);
    expect(coverage.included.length).toBeGreaterThan(180);
    for (const c of coverage.included) {
      expect(c.shores.length, c.name).toBeGreaterThan(0);
      for (const id of c.shores) {
        expect(catalogueIds.has(id), id).toBe(true);
        const node = [...graph.nodes.values()].find((n) => n.shoreId === id);
        expect(node, id).toBeDefined();
        expect(graph.adjacency.get(node!.id)!.length, id).toBeGreaterThan(0);
      }
    }
    for (const e of coverage.excluded) expect(e.reason, e.name).toBeTruthy();
    // Large or multi-sea countries get several harbours.
    for (const name of ['Russia', 'United States of America', 'Australia', 'Indonesia', 'Japan'])
      expect(coverage.included.find((c) => c.name === name)!.shores.length).toBeGreaterThanOrEqual(
        5,
      );
  });

  it('places every catalogue shore on the coast, never inland', () => {
    const ids = new Set<string>();
    for (const s of GLOBAL_SHORES) {
      expect(ids.has(s.id), s.id).toBe(false);
      ids.add(s.id);
      expect(coast.nearestKm(s.lng, s.lat), `${s.id} is not coastal`).toBeLessThanOrEqual(30);
      expect(Math.abs(s.lat)).toBeLessThan(90);
      expect(Math.abs(s.lng)).toBeLessThanOrEqual(180);
    }
    // The original fictional shores keep their exact anchors.
    expect(SEED_SHORES.find((s) => s.id === 'shore_lantern_cove')).toMatchObject({
      x: 120,
      y: 140,
      lng: -52.3,
      lat: 47.4,
    });
  });
});

// A planned polyline must stay on water. Connectors (first/last leg) may touch land only within
// the harbour's own inlet; canal legs are the only legs allowed to cross land outright.
function assertWaterOnly(graph: ReturnType<typeof loadActiveGraph>, nodeIds: string[]) {
  const points = pathGeoPoints(graph, nodeIds)!;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const idA = nodeIds[i - 1]!;
    const idB = nodeIds[i]!;
    if (idA.startsWith('c_suez') && idB.startsWith('c_suez')) continue;
    if (idA.startsWith('c_panama') && idB.startsWith('c_panama')) continue;
    const probe = mask.landAlong(a.lng, a.lat, b.lng, b.lat);
    if (probe.land === 0) continue;
    const km = haversineKm(a.lng, a.lat, b.lng, b.lat);
    const leg = `${idA} -> ${idB}`;
    if (i === 1) expect(probe.lastLandKm, leg).toBeLessThanOrEqual(CONNECTOR_LAND_KM);
    else if (i === points.length - 1)
      expect(km - probe.firstLandKm, leg).toBeLessThanOrEqual(CONNECTOR_LAND_KM);
    else if (idA.startsWith('c_') || idB.startsWith('c_'))
      // Straits narrower than the land mask read as land along their coasts; a leg may only
      // touch land that hugs a coastline, never the interior of a landmass.
      expect(legInlandKm(mask, coast, a.lng, a.lat, b.lng, b.lat), leg).toBeLessThanOrEqual(8);
    else expect.fail(`${leg} crosses land`);
  }
}

describe('world sea routes', () => {
  const w = createTestWorld();
  const graph = loadActiveGraph(w.db);
  const plan = (from: string, to: string) => {
    const path = planRoute(graph, from, to);
    expect(path, `${from} -> ${to}`).not.toBeNull();
    return path!;
  };

  it.each([
    ['shore_pt_lisbon', 'shore_in_mumbai', 'c_suez'], // Europe -> Asia through Suez
    ['shore_us_new_york', 'shore_jp_tokyo', 'c_panama'], // Americas -> Asia through Panama
    ['shore_za_cape_town', 'shore_br_rio_de_janeiro', null], // South Atlantic crossing
    ['shore_tr_istanbul', 'shore_ua_odesa', 'c_turkish_straits'], // inside the Black Sea
    ['shore_de_cuxhaven', 'shore_se_stockholm', null], // North Sea -> Baltic
    ['shore_sg_singapore', 'shore_cn_shanghai', null], // South China Sea
    ['shore_au_sydney', 'shore_cl_valparaiso', null], // Pacific, across the antimeridian
    ['shore_ru_murmansk', 'shore_is_reykjavik', null], // Arctic waters
    ['shore_ke_mombasa', 'shore_au_fremantle', null], // Indian Ocean
    ['shore_lantern_cove', 'shore_ar_ushuaia', null], // legacy shore into the world graph
  ])('%s -> %s stays on the water', (from, to, via) => {
    const path = plan(from, to);
    assertWaterOnly(graph, path.nodeIds);
    if (via) expect(path.nodeIds.some((id) => id.startsWith(via))).toBe(true);
    expect(path.totalLength).toBeGreaterThan(10);
  });

  it('crosses the antimeridian on Pacific routes instead of going the long way round', () => {
    const path = plan('shore_nz_auckland', 'shore_pf_papeete');
    const points = pathGeoPoints(graph, path.nodeIds)!;
    const wraps = points.filter((p, i) => i > 0 && Math.abs(p.lng - points[i - 1]!.lng) > 180);
    expect(wraps.length).toBe(1);
    const km = haversineKm(174.77, -36.84, -149.57, -17.53);
    expect(path.totalLength * 50).toBeLessThan(km * 1.6);
  });

  it('never reaches a Caspian or lake node', () => {
    for (const n of graph.nodes.values()) {
      if (n.kind !== 'waypoint' || !n.geo) continue;
      const caspian = n.geo.lng > 46 && n.geo.lng < 55 && n.geo.lat > 36 && n.geo.lat < 48;
      expect(caspian, n.id).toBe(false);
    }
  });
});
