/**
 * src/world/village.js — the starting village, built on a terrain terrace.
 *
 * ## Why the village is not just more props
 *
 * `props.js` scatters single primitives at random. A village is the opposite of
 * that: it is a PLACE, with a fixed layout, a name, a centre the player spawns
 * in, a boundary where the wilderness starts, and solid buildings that are
 * obstacles. None of those are properties of a scatter, so this is its own
 * module — but it deliberately reuses props.js's two load-bearing tricks, one
 * mesh per material and vertex colours, because a village built from 40 separate
 * meshes would be 40 draw calls for scenery.
 *
 * ## The ground comes first
 *
 * The island is a radial cone and the only naturally flat ground is the mesa top
 * (measured: exactly one radius-6 disc has relief under 0.6). A village needs
 * flat ground, so the GROUND IS PREPARED — `createTerrain({ shelf })` carves a
 * terrace and this module builds on the resolved `terrain.shelf`. That ordering
 * matters: the terrace must exist before props are scattered, or the scatter
 * would keep the flat ground bare only by luck. game.js passes `keepOut` for the
 * village, exactly as it does for the spawn and the markers.
 *
 * ## Layout is data
 *
 * `src/data/village.json` holds the buildings as offsets from the village centre
 * and their sizes. A new house is a JSON edit. The module owns geometry,
 * colliders and the anchor list; it owns no coordinates.
 *
 * Exports: createVillage
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Cover a rectangle with circles, because actor.js only collides circle-to-
 * circle. One circle per building would either leave the long sides walkable or
 * block the pavement around them; two to four small ones trace the footprint.
 */
export function boxColliders(x, z, w, d) {
  const long = Math.max(w, d), short = Math.min(w, d);
  const r = short / 2;
  const n = Math.max(1, Math.ceil((long - short) / (r * 1.5)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * (long - short);
    out.push(w > d ? { x: x + t, z, r } : { x, z: z + t, r });
  }
  return out;
}

export function createVillage({ terrain, definitions = {}, keepOut = [], scene = null } = {}) {
  const group = new THREE.Group();
  group.name = 'village';
  const colliders = [];
  const anchors = [];

  const shelf = terrain.shelf;
  // No terrace, no village. Throwing would take the whole boot down for a
  // scenery feature, so the caller gets an empty village and the game is still
  // playable — the party just starts in the fallback spot.
  if (!shelf) {
    if (scene) scene.add(group);
    return {
      group, colliders, anchors, name: definitions.name || '', radius: 0,
      centre: null, spawn: null, layout: [], update() {}, dispose() { group.clear(); },
    };
  }

  const pal = definitions.palette || {};
  const rand = (() => {
    let a = 0x9e3779b9;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  const parts = [];
  const V = new THREE.Vector3();

  /** Bake a flat colour into a geometry as a vertex attribute, then keep it. */
  function tinted(geo, hex, jitter = 0.09) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const c = new THREE.Color(hex);
    const k = 1 - jitter + rand() * jitter * 2;
    for (let i = 0; i < n; i++) {
      col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
    return g;
  }

  /** A box in piece-local space — the assembly loop shifts it onto the world. */
  function box(x, y, z, w, h, d, hex) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y + h / 2, z);
    return tinted(g, hex);
  }

  // ------------------------------------------------------------- pieces ---

  function house(it, wx, wz, wy) {
    const wall = it.wall || '#c9b79a';
    const roof = it.roof || '#8a4b3a';
    const h = it.h ?? 1.8;
    box(0, 0, 0, it.w, h, it.d, wall);
    // A 4-gon cone rotated 45 deg is an axis-aligned hip roof of base w x d.
    const rh = Math.min(it.w, it.d) * 0.55;
    const cone = new THREE.ConeGeometry(Math.SQRT1_2, rh, 4);
    cone.rotateY(Math.PI / 4);
    cone.scale(it.w * 1.12, 1, it.d * 1.12);
    cone.translate(0, h + rh / 2, 0);
    tinted(cone, roof, 0.06);
    // Door: a recessed slab on the face named by `door`, so the buildings have a
    // front the player can read a way in by.
    const [side, inset] = it.door || [1, 0.35];
    const dw = 0.55, dh = Math.min(1.15, h * 0.62);
    const dx = side * (it.w / 2 + 0.03);
    const dz = inset * it.d;
    const door = new THREE.BoxGeometry(0.06, dh, dw);
    door.translate(dx, dh / 2, dz);
    tinted(door, pal.door || '#4a3325', 0.04);
    // Window
    const win = new THREE.BoxGeometry(0.05, 0.45, 0.42);
    win.translate(dx, h * 0.62, dz - it.d * 0.28);
    tinted(win, '#f0d38a', 0.02);
    for (const c of boxColliders(0, 0, it.w, it.d)) {
      colliders.push({ x: wx + c.x, z: wz + c.z, r: c.r });
    }
  }

  function well(it, wx, wz) {
    const r = it.r ?? 0.55, h = it.h ?? 0.9;
    const ring = new THREE.CylinderGeometry(r, r * 1.12, h, 8);
    ring.translate(0, h / 2, 0);
    tinted(ring, pal.stone || '#8f8a80', 0.07);
    const water = new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.06, 8);
    water.translate(0, h - 0.16, 0);
    tinted(water, '#2f5d86', 0.02);
    // Two posts and a crossbar: a well reads as a well only with the windlass.
    for (const s of [-1, 1]) {
      box(s * r * 0.92, h, 0, 0.11, 1.15, 0.11, pal.trim || '#3b2d20');
    }
    box(0, h + 1.15, 0, r * 2.0, 0.1, 0.12, pal.trim || '#3b2d20');
    colliders.push({ x: wx, z: wz, r: r * 1.05 });
  }

  function sign(it, wx, wz) {
    box(0, 0, 0, 0.1, it.h ?? 1.3, 0.1, pal.trim || '#3b2d20');
    const b = new THREE.BoxGeometry(0.9, 0.4, 0.07);
    b.translate(0, (it.h ?? 1.3) - 0.06, 0);
    tinted(b, '#b08a52', 0.05);
    colliders.push({ x: wx, z: wz, r: 0.2 });
  }

  function lantern(it, wx, wz) {
    const h = it.h ?? 2.0;
    box(0, 0, 0, 0.1, h, 0.1, pal.trim || '#3b2d20');
    // The glass is the brightest thing in the village on purpose: it is the one
    // warm pixel the bloom pass has to catch, which is what makes a lit window
    // read as lit at 1/2 resolution.
    const lamp = new THREE.BoxGeometry(0.26, 0.32, 0.26);
    lamp.translate(0, h + 0.16, 0);
    tinted(lamp, '#ffe9a8', 0.02);
    colliders.push({ x: wx, z: wz, r: 0.18 });
  }

  function fence(it, wx, wz) {
    const len = it.len ?? 5;
    const axis = it.axis === 'z' ? 'z' : 'x';
    const post = 0.09, height = 0.85;
    const posts = Math.max(2, Math.round(len / 1.3));
    for (let i = 0; i <= posts; i++) {
      const t = (i / posts - 0.5) * len;
      const px = axis === 'z' ? 0 : t;
      const pz = axis === 'z' ? t : 0;
      box(px, 0, pz, post, height, post, pal.trim || '#3b2d20');
    }
    for (const y of [height * 0.55, height * 0.9]) {
      box(0, y, 0, axis === 'z' ? 0.06 : len, 0.07, axis === 'z' ? len : 0.06, pal.trim || '#3b2d20');
    }
    // A fence is something you walk around, not through, but a collider per post
    // would be 8 circles for one rail. Two along the run is enough to read solid.
    const half = len / 2;
    for (const s of [-1, 0, 1]) {
      const d = (s * half) / 1.6;
      colliders.push({
        x: wx + (axis === 'z' ? 0 : d),
        z: wz + (axis === 'z' ? d : 0),
        r: 0.14,
      });
    }
  }

  // ------------------------------------------------------------- assembly ---

  const layout = Array.isArray(definitions.layout) ? definitions.layout : [];
  const builders = { house, well, sign, lantern, fence };

  for (const it of layout) {
    const build = builders[it.type];
    if (!build) continue;
    // `keepOut` is in WORLD space and the layout offsets are not, so the offset
    // is applied here rather than asking the caller to pre-shift.
    const wx = shelf.x + it.x, wz = shelf.z + it.z;
    if (keepOut.some((k) => Math.hypot(k.x - wx, k.z - wz) < k.r)) continue;
    // The terrace is flat only inside `shelf.inner`; past that it feathers back
    // to the natural terrain, so every piece asks the terrain for its own y.
    const wy = terrain.heightAt(wx, wz);
    const start = parts.length;
    build(it, wx, wz, wy);
    for (let i = start; i < parts.length; i++) parts[i].translate(wx, wy, wz);
  }

  if (parts.length) {
    const merged = mergeGeometries(parts, false);
    parts.forEach((g) => g.dispose());
    if (merged) {
      merged.computeBoundingSphere();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0,
      });
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = 'village_mesh';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      group.userData.material = mat;
    }
  }

  // Anchors: where an NPC (or a talking marker) stands in the village, in WORLD
  // space. The game layer places markers from these, so the village owns its own
  // geography and game.js does not keep a second copy of the coordinates.
  for (const a of definitions.anchors || []) {
    V.set(shelf.x + a.x, 0, shelf.z + a.z);
    anchors.push({
      id: a.id, x: +V.x.toFixed(2), z: +V.z.toFixed(2),
      facing: a.facing || 'down', speaker: a.speaker || '',
    });
  }

  /**
   * The party does not spawn as a POINT, it spawns as a WEDGE: a leader plus two
   * flankers and a tail, reaching ~2.4 units behind and ~1.15 to each side.
   * `clearSpot` in game.js only ever clears the leader, so a spawn that is
   * perfectly walkable can still drop a follower's SLOT inside a fence post or
   * the signpost — and actor.js collides by sliding, so that follower presses
   * into the post forever, the formation never closes, and the tail sits
   * permanently on top of the leader.
   *
   * Measured exactly that: the old `centre + (0, r*0.55)` put the leader at
   * (31.5, 47.76) and the signpost collider at (31.5, 47.93), so the tail's slot
   * at (31.5, 48.78) was behind an obstacle it could not pass.
   *
   * The village is the only thing that knows its own obstacles, so the village
   * picks the spot: the first point on the terrace whose DISC is clear of every
   * collider it built, searched outward from the centre and starting to the south
   * (the road out, the way the party faces). `needed` covers the wedge footprint
   * plus an actor's radius; falling back to the centre keeps a village with a
   * pathological layout playable instead of spawning the party inside a wall.
   */
  function clearSpawn(needed = 3.0) {
    const clearance = (x, z) => {
      let min = Infinity;
      for (const c of colliders) min = Math.min(min, Math.hypot(c.x - x, c.z - z) - c.r);
      return min;
    };
    const SOUTH = Math.PI / 2;
    for (let d = 0; d <= shelf.inner; d += 0.4) {
      for (let i = 0; i < 8; i++) {
        // Sweep outward starting due south, then alternating east and west, so
        // the party starts facing the island with the village at its back.
        const a = SOUTH + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI / 8);
        const x = shelf.x + Math.cos(a) * d;
        const z = shelf.z + Math.sin(a) * d;
        if (clearance(x, z) >= needed) return { x: +x.toFixed(2), z: +z.toFixed(2) };
      }
    }
    return { x: shelf.x, z: shelf.z };
  }

  if (scene) scene.add(group);

  return {
    group,
    name: definitions.name || '',
    colliders,
    anchors,
    layout,
    layoutColliders: colliders.length,
    centre: { x: shelf.x, z: shelf.z },
    radius: shelf.r,
    // Inside this radius the wilderness does not roll encounters. A village that
    // ambushes you at the well is not a village.
    safeRadius: shelf.inner,
    shelf,
    spawn: clearSpawn(),
    update() {},
    dispose() {
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      if (group.userData.material) group.userData.material.dispose();
      group.clear();
      colliders.length = 0;
      anchors.length = 0;
    },
  };
}
