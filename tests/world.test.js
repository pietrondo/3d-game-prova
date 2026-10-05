/**
 * tests/world.test.js — terrain terrace + village placement regression.
 *
 * This pins the bug that shipped: the village was assembled around the world
 * origin instead of on the terrain terrace, so the buildings were invisible and
 * the player walked into an invisible village. Two halves, both tested here:
 * the terrace the village stands on, and the world-space placement of every
 * collider, anchor and mesh vertex the village builds.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTerrain } from '../src/world/terrain.js';
import { createVillage, boxColliders } from '../src/world/village.js';
import tiles from '../src/data/tiles.json';

const WATER_ID = Object.keys(tiles).find((id) => tiles[id].water === true);

describe('boxColliders', () => {
  it('returns at least one circle, every one of them solid', () => {
    const circles = boxColliders(5, 7, 2, 2);
    expect(circles.length).toBeGreaterThanOrEqual(1);
    for (const c of circles) expect(c.r).toBeGreaterThan(0);
  });

  it('covers a square footprint with exactly one circle on its centre', () => {
    const circles = boxColliders(3, -4, 2.5, 2.5);
    expect(circles).toHaveLength(1);
    expect(circles[0].x).toBeCloseTo(3, 9);
    expect(circles[0].z).toBeCloseTo(-4, 9);
    expect(circles[0].r).toBeCloseTo(1.25, 9);
  });

  it('spreads a long footprint along x and still spans its width', () => {
    const x = 0, z = -2, w = 10, d = 2;
    const circles = boxColliders(x, z, w, d);
    expect(circles.length).toBeGreaterThan(1);
    for (const c of circles) {
      expect(c.z).toBeCloseTo(z, 9); // long axis is x: z must not move
      expect(c.r).toBeCloseTo(d / 2, 9);
    }
    const xs = circles.map((c) => c.x);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    expect(hi).toBeGreaterThan(lo);
    // outermost centres + their radius must cover the whole footprint
    expect(hi - lo + 2 * circles[0].r).toBeGreaterThanOrEqual(w - 1e-9);
  });

  it('mirrors the long case onto z for a tall footprint', () => {
    const x = 4, z = 1, w = 2, d = 10;
    const circles = boxColliders(x, z, w, d);
    expect(circles.length).toBeGreaterThan(1);
    for (const c of circles) {
      expect(c.x).toBeCloseTo(x, 9); // long axis is z: x must not move
      expect(c.r).toBeCloseTo(w / 2, 9);
    }
    const zs = circles.map((c) => c.z);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    expect(hi).toBeGreaterThan(lo);
    expect(hi - lo + 2 * circles[0].r).toBeGreaterThanOrEqual(d - 1e-9);
  });
});

describe('createTerrain({ shelf })', () => {
  const shelfRequest = { angle: Math.PI / 2, at: 0.6, r: 4, feather: 1.6 };
  const terrain = createTerrain({
    width: 24, depth: 24, seed: 1337, heightScale: 3.2, tiles, shelf: shelfRequest,
  });

  it('resolves the requested shelf to a concrete terrace', () => {
    const s = terrain.shelf;
    expect(s).toBeTruthy();
    for (const k of ['x', 'z', 'y', 'r', 'inner']) {
      expect(typeof s[k]).toBe('number');
      expect(Number.isFinite(s[k])).toBe(true);
    }
    expect(s.r).toBe(4);
    expect(s.inner).toBeGreaterThan(0);
    expect(s.inner).toBeLessThanOrEqual(s.r);
  });

  it('carves a flat terrace', () => {
    const s = terrain.shelf;
    const centre = terrain.heightAt(s.x, s.z);
    // Heights are quantised to the heightmap step, so neighbouring samples
    // agree within a step or two rather than exactly.
    for (const [dx, dz] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) {
      expect(Math.abs(terrain.heightAt(s.x + dx, s.z + dz) - centre)).toBeLessThan(0.02);
    }
  });

  it('makes the terrace walkable land, not water', () => {
    const s = terrain.shelf;
    expect(WATER_ID).toBeTruthy();
    expect(terrain.tileAt(s.x, s.z)).not.toBe(WATER_ID);
    expect(terrain.isWalkable(s.x, s.z)).toBe(true);
    const d = 0.6 * s.inner;
    expect(terrain.isWalkable(s.x + d, s.z)).toBe(true);
    expect(terrain.isWalkable(s.x, s.z + d)).toBe(true);
  });

  it('reports its bounds and leaves the map corner as open sea', () => {
    expect(terrain.bounds).toEqual({ minX: 0, maxX: 24, minZ: 0, maxZ: 24 });
    expect(terrain.tileAt(0, 0)).toBe(WATER_ID);
    expect(terrain.isWalkable(0, 0)).toBe(false);
  });
});

describe('createVillage', () => {
  const shelf = { x: 12, z: 18, y: 0.5, r: 4, inner: 2.4 };
  const terrain = {
    shelf,
    heightAt: (x, z) => 0.5 + (x - shelf.x) * 0.01, // deliberately sloping
    isWalkable: () => true,
  };

  // Same field names the builders read; deliberately not src/data/village.json.
  const definitions = {
    name: 'testham',
    palette: {},
    layout: [
      { type: 'house', x: -2, z: 0, w: 3, d: 2, h: 1.8, door: [1, 0.35] },
      { type: 'well', x: 2, z: -1, r: 0.55, h: 0.9 },
      { type: 'fence', x: 0, z: 2, len: 5, axis: 'x' },
    ],
    anchors: [{ id: 'elder', x: 1, z: 1, facing: 'up', speaker: 'elder' }],
  };

  const build = (defs = definitions) => createVillage({ terrain, definitions: defs });

  it('builds colliders around the terrace, nowhere near the origin', () => {
    const v = build();
    expect(v.layoutColliders).toBe(v.colliders.length);
    expect(v.layoutColliders).toBeGreaterThan(0);
    for (const c of v.colliders) {
      expect(Math.hypot(c.x - shelf.x, c.z - shelf.z)).toBeLessThan(shelf.r + 6);
    }
  });

  it('centres the merged mesh on the shelf, not on the world origin', () => {
    const v = build();
    const mesh = v.group.getObjectByName('village_mesh');
    expect(mesh).toBeTruthy();
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cz = (bb.min.z + bb.max.z) / 2;
    expect(Math.abs(cx - shelf.x)).toBeLessThan(2);
    expect(Math.abs(cz - shelf.z)).toBeLessThan(2);
    expect(Math.hypot(cx - shelf.x, cz - shelf.z)).toBeLessThan(2.5);
    // the regression would put this at (0, 0), ~21 units away
    expect(Math.hypot(cx, cz)).toBeGreaterThan(10);
    expect(bb.max.y).toBeGreaterThan(bb.min.y);
  });

  it('spawns the party clear of every collider it built', () => {
    const v = build();
    expect(v.spawn).toBeTruthy();
    expect(Number.isFinite(v.spawn.x)).toBe(true);
    expect(Number.isFinite(v.spawn.z)).toBe(true);
    for (const c of v.colliders) {
      expect(Math.hypot(v.spawn.x - c.x, v.spawn.z - c.z)).toBeGreaterThanOrEqual(c.r);
    }
    expect(Math.hypot(v.spawn.x - shelf.x, v.spawn.z - shelf.z)).toBeLessThan(shelf.r);
  });

  it('has no anchors for definitions that declare none', () => {
    const v = build({ name: 'testham', layout: definitions.layout });
    expect(v.anchors).toEqual([]);
    expect(v.colliders.length).toBeGreaterThan(0);
  });

  it('places anchors in world space near the shelf', () => {
    const v = build();
    expect(v.anchors).toHaveLength(1);
    const a = v.anchors[0];
    expect(a.id).toBe('elder');
    expect(a.x).toBeCloseTo(shelf.x + 1, 2);
    expect(a.z).toBeCloseTo(shelf.z + 1, 2);
    expect(Math.hypot(a.x - shelf.x, a.z - shelf.z)).toBeLessThan(shelf.r + 2);
    expect(Math.hypot(a.x, a.z)).toBeGreaterThan(10); // world space, not a local offset
  });

  it('dispose() empties colliders and anchors', () => {
    const v = build();
    expect(v.colliders.length).toBeGreaterThan(0);
    expect(v.anchors.length).toBeGreaterThan(0);
    v.dispose();
    expect(v.colliders).toHaveLength(0);
    expect(v.anchors).toHaveLength(0);
  });

  it('returns an empty village when the terrain has no shelf', () => {
    let v;
    expect(() => {
      v = createVillage({
        terrain: { shelf: null, heightAt: () => 0, isWalkable: () => false },
        definitions,
      });
    }).not.toThrow();
    expect(v.radius).toBe(0);
    expect(v.centre).toBeNull();
    expect(v.spawn).toBeNull();
    expect(v.colliders).toHaveLength(0);
    expect(v.anchors).toHaveLength(0);
  });
});

/**
 * The integration the unit block above cannot reach.
 *
 * Everything before this point feeds `createVillage` a STUB terrain, so it can
 * only ever prove that the village is consistent with the stub. It cannot prove
 * the property the village and the terrain actually share: that each piece is
 * placed at the ground height the terrain reports for it.
 *
 * That is the project's stated height contract (terrain.js: the visible mesh top
 * surface IS heightAt), and it is exactly the property a regression would break
 * silently — translate a piece by (wx, 0, wz) instead of (wx, wy, wz) and the
 * mesh is still centred correctly, still the right size, still the right colour,
 * and floating above or sunk into the ground.
 *
 * It also covers the second half of the shipped bug: the terrace must be flat
 * ACROSS EACH PIECE'S FOOTPRINT, not merely at the piece's centre. A fence is
 * translated by one height; if the ground under its far end differs by half a
 * metre, that end is buried. `tests/_layoutcheck.mjs` is the measurement; this is
 * the guard.
 *
 * A small map keeps it fast — this is pure maths, no browser.
 */
describe('createVillage on a REAL createTerrain', () => {
  const SITE = { angle: Math.PI / 2, at: 0.62, r: 7.5, feather: 2.0 };
  const terrain = createTerrain({
    width: 64, depth: 64, seed: 1337, heightScale: 3.2, tiles, shelf: SITE,
  });

  // VILLAGE is imported so the test follows the real layout; a layout that is
  // changed without checking it still fits the terrace should fail here.
  const VILLAGE = JSON.parse(
    readFileSync(new URL('../src/data/village.json', import.meta.url), 'utf-8'),
  );

  // Mirrors village.js's own footprint maths. Deliberately duplicated rather than
  // exported: the point is to check the builder against an independent reading of
  // the data, and an export would let both drift together.
  const halfExtent = (it) => {
    switch (it.type) {
      case 'house': return [it.w / 2 + 0.15, it.d / 2 + 0.15];
      case 'well': return [it.r ?? 0.55, it.r ?? 0.55];
      case 'sign': return [0.45, 0.2];
      case 'lantern': return [0.15, 0.15];
      case 'fence': return it.axis === 'z' ? [0.1, (it.len ?? 5) / 2] : [(it.len ?? 5) / 2, 0.1];
      default: return [0.2, 0.2];
    }
  };

  it('resolves a terrace big enough to hold the real village layout', () => {
    expect(terrain.shelf).toBeTruthy();
    // The layout reaches ~5.5 from the centre once house corners are counted, and
    // a piece placed at its centre's height needs the ground under it to be flat.
    expect(terrain.shelf.inner).toBeGreaterThanOrEqual(5);
  });

  it('places every piece at the height the terrain reports for it', () => {
    const v = createVillage({ terrain, definitions: VILLAGE });
    const mesh = v.group.getObjectByName('village_mesh');
    expect(mesh).toBeTruthy();
    // The merged mesh's lowest vertex must be at or above the terrace floor and
    // within a piece's height of it: a mesh built at y=0 would be ~0.37 below.
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    expect(bb.min.y).toBeGreaterThan(terrain.shelf.y - 0.15);
    expect(bb.min.y).toBeLessThan(terrain.shelf.y + 0.3);
  });

  it('sits each piece on level ground: the spread under its footprint is small', () => {
    // The measured threshold is 0.25 world units: on a 1.8-unit building that is
    // a visible gap, and it is what separates a placed village from a buried one.
    const s = terrain.shelf;
    const worst = [];
    for (const it of VILLAGE.layout) {
      const wx = s.x + it.x, wz = s.z + it.z;
      const [hx, hz] = halfExtent(it);
      let min = Infinity, max = -Infinity;
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) {
        const h = terrain.heightAt(wx + ox * hx, wz + oz * hz);
        if (h < min) min = h;
        if (h > max) max = h;
      }
      worst.push({ id: it.id, spread: max - min });
      expect(terrain.isWalkable(wx, wz), `${it.id} stands on unwalkable ground`).toBe(true);
      expect(max - min, `${it.id} spans ${(max - min).toFixed(3)} of ground height`)
        .toBeLessThanOrEqual(0.25);
    }
    // And at least one piece must be measured, or the loop above proves nothing.
    expect(worst.length).toBe(VILLAGE.layout.length);
    expect(worst.length).toBeGreaterThan(0);
  });

  it('spawns clear of the real colliders, so no follower is trapped', () => {
    const v = createVillage({ terrain, definitions: VILLAGE });
    for (const c of v.colliders) {
      expect(Math.hypot(v.spawn.x - c.x, v.spawn.z - c.z), `spawn too close to a collider`)
        .toBeGreaterThan(c.r);
    }
    expect(terrain.isWalkable(v.spawn.x, v.spawn.z)).toBe(true);
  });

  it('resolves every marker against a real village anchor', () => {
    // The shipped bug: markers.json asked for anchor 'vell' while village.json
    // defined 'elder', and markerSpot fell through to the village centre in
    // silence, so the level's central NPC stood on the well.
    //
    // Note the invariant is NOT "every level marker is an anchor" — the cache and
    // the two fights are placed by dx/dz offsets, not by an NPC. It is: a marker
    // that NAMES an anchor must name one that exists, and every marker must have
    // a way to be placed at all.
    const v = createVillage({ terrain, definitions: VILLAGE });
    const anchorIds = new Set(v.anchors.map((a) => a.id));
    const markers = JSON.parse(
      readFileSync(new URL('../src/data/markers.json', import.meta.url), 'utf-8'),
    );
    expect(markers.length).toBeGreaterThan(0);

    for (const m of markers) {
      const placable = m.anchor != null || (m.dx != null && m.dz != null);
      expect(placable, `marker "${m.id}" has neither an anchor nor a dx/dz`).toBe(true);
      if (m.anchor != null) {
        expect(anchorIds.has(m.anchor),
          `marker "${m.id}" names anchor "${m.anchor}", which village.json does not define`)
          .toBe(true);
      }
    }
  });

  it('resolves every marker the level waits on to a real marker id', () => {
    // level1.json's `marker` field is compared against a marker's `id` (see
    // useMarker in game.js). A stage pointing at an id nobody defines is a stage
    // that can never be spent, and the area becomes unfinishable in silence.
    const markers = JSON.parse(
      readFileSync(new URL('../src/data/markers.json', import.meta.url), 'utf-8'),
    );
    const level = JSON.parse(
      readFileSync(new URL('../src/data/level1.json', import.meta.url), 'utf-8'),
    );
    const ids = new Set(markers.map((m) => m.id));
    const wanted = level.stages.map((st) => st.marker).filter(Boolean);
    expect(wanted.length).toBeGreaterThan(0);
    for (const id of wanted) {
      expect(ids.has(id), `level1.json waits on marker "${id}", which markers.json does not define`)
        .toBe(true);
    }
  });
});
