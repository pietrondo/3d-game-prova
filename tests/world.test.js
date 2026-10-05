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
