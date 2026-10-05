// AGENT-WORLD. createProps() signature is exactly contracts.md section 8.
// `update(dt)` exists because the contract asks for it; props are static geometry
// so it is a documented no-op. One merged Mesh per definition id, so the whole
// world is a handful of draw calls.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const OCC = 0.5;          // occupancy grid cell, world units
const TRIES = 4;          // rejection samples per candidate before giving up
const MIN_NORMAL_Y = 0.62; // don't plant props on cliff faces
const EMBED = 0.06;       // sink the base slightly so nothing hovers

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** geometry key -> blocky primitive. Local origin at the base, top at ~height. */
function buildGeometry(def, rand) {
  const r = Math.max(0.05, def.radius ?? 0.4);
  const h = Math.max(0.1, def.height ?? 1);
  const parts = [];
  switch (def.geometry) {
    case 'cone': {                                   // pine: trunk + 5-sided crown
      const trunk = new THREE.BoxGeometry(r * 0.45, h * 0.3, r * 0.45);
      trunk.translate(0, h * 0.15, 0);
      const crown = new THREE.ConeGeometry(r, h * 0.72, 5);
      crown.translate(0, h * 0.64, 0);
      parts.push(trunk, crown);
      break;
    }
    case 'rock': {                                   // boulder: squashed dodeca
      const g = new THREE.DodecahedronGeometry(r, 0);
      const k = Math.max(0.5, h / (r * 2));
      g.scale(1, k, 1);
      g.translate(0, h * 0.45, 0);
      parts.push(g);
      break;
    }
    case 'box': {                                    // ruin block
      const g = new THREE.BoxGeometry(r * 2, h, r * 2);
      g.translate(0, h / 2, 0);
      parts.push(g);
      break;
    }
    case 'tuft': {                                   // 3 crossed blades
      const t = Math.max(0.04, r * 0.5);
      for (let i = 0; i < 3; i++) {
        const b = new THREE.BoxGeometry(t, h, t);
        b.rotateZ((rand() - 0.5) * 0.5);
        b.rotateY((i / 3) * Math.PI);
        b.translate(0, h / 2, 0);
        parts.push(b);
      }
      break;
    }
    case 'crystal': {                               // elongated icosa shard
      const g = new THREE.IcosahedronGeometry(r, 0);
      g.scale(0.8, h / (r * 2), 0.8);
      g.translate(0, h * 0.5, 0);
      parts.push(g);
      break;
    }
    case 'pillar':                                   // broken 5-sided column
    default: {
      const g = new THREE.CylinderGeometry(r, r * 1.15, h, 5);
      g.translate(0, h / 2, 0);
      parts.push(g);
      break;
    }
  }
  return parts;
}

/**
 * One instance, ready for mergeGeometries: non-indexed, position/normal/uv/color,
 * baked yaw + scale + world placement. Two-tone by height and face orientation.
 */
function instance(def, x, y, z, rand) {
  const h = Math.max(0.1, def.height ?? 1);
  // mergeGeometries needs every input non-indexed with the same attribute set.
  const parts = buildGeometry(def, rand).map((p) => (p.index ? p.toNonIndexed() : p));
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) return null;

  const base = new THREE.Color(def.color ?? '#888888');
  const alt = new THREE.Color(def.color2 ?? def.color ?? '#666666');
  const tint = 0.9 + rand() * 0.2;
  const pos = merged.attributes.position;
  const nrm = merged.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const k = clamp01(0.34 * clamp01(pos.getY(i) / h) + 0.66 * Math.max(0, nrm.getY(i)));
    c.copy(alt).lerp(base, k).multiplyScalar(tint);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const s = 0.85 + rand() * 0.3;
  merged.rotateY(rand() * Math.PI * 2);
  merged.scale(s, s, s);
  merged.translate(x, y, z);
  return merged;
}

/**
 * `keepOut` is an OPTIONAL array of `{ x, z, r }`. A SOLID prop that lands inside
 * one is dropped. It exists because a pine between the camera and the party is a
 * rendering defect, not a difficulty setting: it hides a follower at the exact
 * moment the player is reading the party, and it eats the slot the follow chain
 * is walking to. Decorative props ignore it — grass you can wade through is fine.
 */
export function createProps({ terrain, definitions = {}, seed = 7, density = 0.08, maxCount = 700, keepOut = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'props';
  const colliders = [];
  const rand = mulberry32(seed);
  const b = terrain.bounds;
  const tile = 1 / (terrain.worldToTile(1) || 1);

  // Coarse occupancy grid so the spacing test is O(1) instead of O(n^2).
  const gw = Math.max(1, Math.ceil((b.maxX - b.minX) / OCC));
  const gh = Math.max(1, Math.ceil((b.maxZ - b.minZ) / OCC));
  const occ = new Uint8Array(gw * gh);
  const free = (x, z, rad) => {
    const gx0 = Math.max(0, Math.floor((x - rad - b.minX) / OCC));
    const gx1 = Math.min(gw - 1, Math.floor((x + rad - b.minX) / OCC));
    const gz0 = Math.max(0, Math.floor((z - rad - b.minZ) / OCC));
    const gz1 = Math.min(gh - 1, Math.floor((z + rad - b.minZ) / OCC));
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
      if (occ[gz * gw + gx]) return false;
    }
    return true;
  };
  const claim = (x, z, rad) => {
    const gx0 = Math.max(0, Math.floor((x - rad - b.minX) / OCC));
    const gx1 = Math.min(gw - 1, Math.floor((x + rad - b.minX) / OCC));
    const gz0 = Math.max(0, Math.floor((z - rad - b.minZ) / OCC));
    const gz1 = Math.min(gh - 1, Math.floor((z + rad - b.minZ) / OCC));
    for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) occ[gz * gw + gx] = 1;
  };

  const buckets = new Map();   // definition id -> BufferGeometry[]
  let count = 0;

  for (const [id, def] of Object.entries(definitions)) {
    if (!def || count >= maxCount) continue;
    const r = Math.max(0.05, def.radius ?? 0.4);
    // `radius` is the GEOMETRY radius and props.js:buildGeometry draws from it,
    // so it can only be as small as the thing looks: a pine's 0.55 is its
    // CANOPY. The collider is a separate, smaller number from the JSON, because
    // what blocks a walker is the trunk, not the branches. Missing `collider`
    // keeps the old radius * 1.1 so a new prop type is solid by default.
    const cr = def.collider ?? r * 1.1;
    const list = Array.isArray(def.tiles) && def.tiles.length ? new Set(def.tiles) : null;

    const depthCount = Math.round((b.maxZ - b.minZ) / tile);
    const widthCount = Math.round((b.maxX - b.minX) / tile);
    for (let tz = 0; tz < depthCount; tz++) {
      for (let tx = 0; tx < widthCount; tx++) {
        if (count >= maxCount) break;
        const cxw = (tx + 0.5) * tile, czw = (tz + 0.5) * tile;
        if (!terrain.isWalkable(cxw, czw)) continue;
        if (list && !list.has(terrain.tileAt(cxw, czw))) continue;
        if (rand() > density) continue;

        for (let t = 0; t < TRIES; t++) {
          const x = cxw + (rand() - 0.5) * 0.7 * tile;
          const z = czw + (rand() - 0.5) * 0.7 * tile;
          if (!terrain.isWalkable(x, z)) continue;
          if (terrain.normalYAt(x, z) < MIN_NORMAL_Y) continue;
          if (def.solid && keepOut.some((k) => Math.hypot(k.x - x, k.z - z) < k.r)) continue;
          if (!free(x, z, r * 1.1)) continue;
          const h = Math.max(0.1, def.height ?? 1);
          const g = instance(def, x, terrain.heightAt(x, z) - h * EMBED, z, rand);
          if (!g) break;
          if (!buckets.has(id)) buckets.set(id, []);
          buckets.get(id).push(g);
          claim(x, z, r * 1.1);
          if (def.solid) colliders.push({ x, z, r: cr });
          count++;
          break;
        }
      }
    }
  }

  const materials = [];
  for (const [id, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0,
    });
    materials.push(mat);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `prop_${id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  /** No-op: props are static merged geometry. */
  function update(_dt) {}

  function dispose() {
    group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    materials.forEach((m) => m.dispose());
    group.clear();
    colliders.length = 0;
  }

  return { group, count, colliders, update, dispose };
}
