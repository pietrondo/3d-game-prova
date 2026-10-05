// AGENT-WORLD. Optional additions to the frozen createTerrain() signature:
//   none — all six params are exactly as in contracts.md section 6.
//
// The heightmap is a fBm radial falloff terraced into a quantised grid, so the
// island is a slab with cliff edges (a diorama), not a floating plane.
// Contract that matters: the *mesh top surface* is the bilinear surface produced
// by heightAt(). Every quad corner is sampled through heightAt(), so an actor
// can never float or sink — there is no second source of truth for Y.

import * as THREE from 'three';
import { makeNoise } from './noise.js';

const FALLBACK_TILE = { colors: ['#7b7b86', '#5a5a64', '#a0a0aa'], height: 0, walkable: true };
const WATER_LEVEL = 0;          // the one shared water plane sits here
const CLIFF_FLOOR = 1.5;        // contracts.md: tile.height > 1.5 => cliff wall
const SHORE = 0.70;             // island radius as a fraction of the half-map
const MESA = 0.80;              // ramp value where the plateau starts
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function hash01(ix, iz) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** 32x32 pixel-art water tile. Null outside the browser (Node smoke tests). */
function makeWaterTexture() {
  if (typeof document === 'undefined') return null;
  const N = 32;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#3f79b4';
  g.fillRect(0, 0, N, N);
  for (let y = 0; y < N; y += 8) {
    const stagger = (y & 8) ? 4 : 0;
    for (let x = stagger; x < N; x += 8) g.fillRect(x, y + 3, 5, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createTerrain({
  width = 40, depth = 40, tileSize = 1, seed = 1337, heightScale = 3.2, tiles = {}, chunkSize = 8,
} = {}) {
  const TILES = tiles || {};
  const td = (id) => TILES[id] || FALLBACK_TILE;
  const keys = Object.keys(TILES);
  const has = (id) => Object.prototype.hasOwnProperty.call(TILES, id);
  const GRASS = has('grass') ? 'grass' : (keys[0] || 'grass');
  const WATER = (keys.find((k) => TILES[k].water) || 'water');
  const band = (id, alt) => (has(id) ? id : alt);

  const N = width * depth;
  const height = new Float32Array(N);   // quantised cell top, world units
  const ids = new Array(N);             // tile id per cell
  const cellIndex = (tx, tz) => tz * width + tx;

  // ---------------------------------------------------------------- heightmap
  // One radial ramp (1 at the centre -> 0 at the shoreline) plus fBm jitter, so
  // the silhouette is a beach/meadow/rock flank climbing to a flat mesa whose
  // rim drops 1 world unit into a cliff. That cliff is the diorama silhouette.
  const noise = makeNoise(seed);
  const step = Math.max(0.05, heightScale / 26);
  const cx = (width - 1) / 2, cz = (depth - 1) / 2;
  const R = Math.max(0.5, Math.min(cx, cz) * SHORE);
  const baseY = -Math.max(1.2, heightScale * 0.55);
  const ramp = new Float32Array(N);
  const inBounds = (tx, tz) => tx >= 0 && tz >= 0 && tx < width && tz < depth;

  // pass 1 — height, quantised to `step` so greedy meshing can merge cells
  for (let tz = 0; tz < depth; tz++) {
    for (let tx = 0; tx < width; tx++) {
      const i = cellIndex(tx, tz);
      const radial = 1 - Math.hypot(tx - cx, tz - cz) / (R * 0.97);
      const e = clamp01(noise.fbm2(tx * 0.085 + 31.7, tz * 0.085 - 12.3, 5) * 0.5 + 0.5);
      const t = clamp01(0.06 + 1.15 * radial + (e - 0.5) * 0.16);
      ramp[i] = t;
      const h = t >= MESA
        ? heightScale * (0.55 + 0.2 * clamp01(noise.fbm2(tx * 0.19 - 7.1, tz * 0.19 + 4.4, 3) * 0.5 + 0.5))
        : (t - 0.1) * heightScale * 0.34;
      height[i] = Math.round(h / step) * step;
    }
  }

  // pass 2 — tile type, read off the quantised grid so the cliff ring is real
  for (let tz = 0; tz < depth; tz++) {
    for (let tx = 0; tx < width; tx++) {
      const i = cellIndex(tx, tz);
      const t = ramp[i], me = height[i];
      let id;
      if (me < WATER_LEVEL) id = WATER;                              // open sea
      else if (t >= MESA) {
        // only the rim of the mesa is a cliff; the flat top stays walkable stone
        let steep = false;
        for (let d = 0; d < 4 && !steep; d++) {
          const ax = tx + DIRS[d][0], az = tz + DIRS[d][1];
          if (inBounds(ax, az) && me - height[cellIndex(ax, az)] > step * 2) steep = true;
        }
        id = steep ? band('cliff', band('stone', GRASS)) : band('stone', GRASS);
      } else if (t < 0.2) id = band('sand', GRASS);
      else if (t < 0.4) id = GRASS;
      else if (t < 0.58) id = band('moss', GRASS);
      else id = band('stone', GRASS);
      ids[i] = id;
    }
  }

  // ------------------------------------------------------------- height field
  const cellH = (tx, tz) => (inBounds(tx, tz) ? height[cellIndex(tx, tz)] : height[cellIndex(clamp(tx, 0, width - 1), clamp(tz, 0, depth - 1))]);

  /** Height of grid corner (ix,iz): the mean of the four cells meeting there. */
  const cornerH = (ix, iz) => (
    cellH(ix - 1, iz - 1) + cellH(ix, iz - 1) + cellH(ix - 1, iz) + cellH(ix, iz)
  ) * 0.25;

  /**
   * The plane of the exact mesh triangle under (x,z) — the same two triangles
   * emitTop() writes, split along the cell's (0,1)-(1,0) diagonal. C0
   * continuous across cells, never NaN, and it CANNOT disagree with the mesh:
   * greedy merging is restricted to cells whose four corners are all equal
   * (see `flat`), so a merged rectangle is a plane this function also returns.
   */
  function heightAt(x, z) {
    const fx = x / tileSize, fz = z / tileSize;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const u = fx - ix, v = fz - iz;
    const hA = cornerH(ix, iz);            // (ix,   iz)
    const hB = cornerH(ix + 1, iz);        // (ix+1, iz)
    const hC = cornerH(ix + 1, iz + 1);    // (ix+1, iz+1)
    const hD = cornerH(ix, iz + 1);        // (ix,   iz+1)
    return u + v >= 1
      ? hC + (hD - hC) * (1 - u) + (hB - hC) * (1 - v)   // triangle D-C-B
      : hA + (hB - hA) * u + (hD - hA) * v;              // triangle D-B-A
  }

  function normalYAt(x, z) {
    const e = 0.5;
    const nx = heightAt(x - e, z) - heightAt(x + e, z);
    const nz = heightAt(x, z - e) - heightAt(x, z + e);
    const ny = 2 * e;
    return ny / Math.hypot(nx, ny, nz);
  }

  // ----------------------------------------------------------------- palette
  // A cell is `flat` when its four grid corners are all at its own height, so a
  // rectangle of flat cells sharing a height is one exact plane: safe to merge.
  const flat = new Uint8Array(N);
  const bucket = new Int32Array(N);
  for (let tz = 0; tz < depth; tz++) {
    for (let tx = 0; tx < width; tx++) {
      const i = cellIndex(tx, tz), h = height[i];
      bucket[i] = Math.round(h / step);
      flat[i] = (Math.abs(cornerH(tx, tz) - h) < 1e-6
        && Math.abs(cornerH(tx + 1, tz) - h) < 1e-6
        && Math.abs(cornerH(tx, tz + 1) - h) < 1e-6
        && Math.abs(cornerH(tx + 1, tz + 1) - h) < 1e-6) ? 1 : 0;
    }
  }

  const pal = new Map();
  const paletteOf = (id) => {
    let p = pal.get(id);
    if (!p) {
      const c = td(id).colors || FALLBACK_TILE.colors;
      p = { base: new THREE.Color(c[0]), dark: new THREE.Color(c[1]), light: new THREE.Color(c[2]) };
      pal.set(id, p);
    }
    return p;
  };

  const scratch = new THREE.Color();
  /** Slope shading at a grid corner. Corner-indexed so neighbours never crack. */
  function cornerColour(ix, iz, out) {
    let p = null, best = -Infinity;
    for (let dz = -1; dz <= 0; dz++) {
      for (let dx = -1; dx <= 0; dx++) {
        const tx = ix + dx, tz = iz + dz;
        if (!inBounds(tx, tz)) continue;
        const h = height[cellIndex(tx, tz)];
        if (h > best) { best = h; p = paletteOf(ids[cellIndex(tx, tz)]); }
      }
    }
    if (!p) p = paletteOf(ids[cellIndex(clamp(ix - 1, 0, width - 1), clamp(iz - 1, 0, depth - 1))]);

    const ny = normalYAt((ix - 0.5) * tileSize, (iz - 0.5) * tileSize);
    out.copy(p.base)
      .lerp(p.light, clamp01((ny - 0.5) / 0.5) * 0.8)
      .lerp(p.dark, clamp01((1 - ny) * 1.3 - 0.15) * 0.9);
    return out.multiplyScalar(1 + (hash01(ix, iz) - 0.5) * 0.1);
  }

  // -------------------------------------------------------------------- mesh
  const group = new THREE.Group();
  group.name = 'terrain';
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1, metalness: 0,
  });

  const pos = [], col = [];
  const c0 = new THREE.Color(), c1 = new THREE.Color(), c2 = new THREE.Color(), c3 = new THREE.Color();

  /** 4 corners in CCW order (seen from the front) -> 2 triangles. */
  function quad(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, ca, cb, cc, cd) {
    const tri = (p0, p1, p2, c0c, c1c, c2c) => {
      pos.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
      col.push(c0c.r, c0c.g, c0c.b, c1c.r, c1c.g, c1c.b, c2c.r, c2c.g, c2c.b);
    };
    tri([ax, ay, az], [bx, by, bz], [cx2, cy2, cz2], ca, cb, cc);
    tri([ax, ay, az], [cx2, cy2, cz2], [dx, dy, dz], ca, cc, cd);
  }

  /** Greedy-merged top surface for one chunk. Corner Y comes from cornerH(). */
  function emitTop(ox, oz, cw, ch) {
    const X0 = ox * tileSize, X1 = (ox + cw) * tileSize;
    const Z0 = oz * tileSize, Z1 = (oz + ch) * tileSize;
    const y00 = cornerH(ox, oz), y10 = cornerH(ox + cw, oz);
    const y11 = cornerH(ox + cw, oz + ch), y01 = cornerH(ox, oz + ch);
    cornerColour(ox, oz, c0);
    cornerColour(ox + cw, oz, c1);
    cornerColour(ox + cw, oz + ch, c2);
    cornerColour(ox, oz + ch, c3);
    // p00=(x0,z1) p10=(x1,z1) p11=(x1,z0) p01=(x0,z0) -> +Y winding
    quad(X0, y01, Z1, X1, y11, Z1, X1, y10, Z0, X0, y00, Z0, c0, c2, c1, c3);
  }

  /**
   * Vertical skirt on one cell edge. 0 = +X, 1 = +Z, 2 = -X, 3 = -Z.
   * The top edge reuses cornerH() so the wall meets the top surface exactly.
   */
  function emitWall(tx, tz, dir, hOut) {
    const x0 = tx * tileSize, x1 = (tx + 1) * tileSize;
    const z0 = tz * tileSize, z1 = (tz + 1) * tileSize;
    const p = paletteOf(ids[cellIndex(tx, tz)]);
    const top = scratch.copy(p.dark).multiplyScalar(1.05);
    const cTop = top.clone();
    const cBot = top.clone().multiplyScalar(0.45);
    const t00 = cornerH(tx, tz), t10 = cornerH(tx + 1, tz);
    const t01 = cornerH(tx, tz + 1), t11 = cornerH(tx + 1, tz + 1);
    // bottom edge hangs below BOTH the neighbour height and the shared edge, so
    // the wall can never invert and poke through the surface above it
    const yb = Math.min(hOut, t00, t10, t01, t11) - 0.02;
    if (dir === 0) quad(x1, t10, z0, x1, t11, z1, x1, yb, z1, x1, yb, z0, cTop, cTop, cBot, cBot);
    else if (dir === 1) quad(x1, t11, z1, x0, t01, z1, x0, yb, z1, x1, yb, z1, cTop, cTop, cBot, cBot);
    else if (dir === 2) quad(x0, t01, z1, x0, t00, z0, x0, yb, z0, x0, yb, z1, cTop, cTop, cBot, cBot);
    else quad(x0, t00, z0, x1, t10, z0, x1, yb, z0, x0, yb, z0, cTop, cTop, cBot, cBot);
  }

  const cs = Math.max(1, chunkSize | 0);
  const chunksX = Math.ceil(width / cs), chunksZ = Math.ceil(depth / cs);

  for (let gz = 0; gz < chunksZ; gz++) {
    for (let gx = 0; gx < chunksX; gx++) {
      const ox = gx * cs, oz = gz * cs;
      const cw = Math.min(cs, width - ox), ch = Math.min(cs, depth - oz);
      pos.length = 0; col.length = 0;

      // Greedy meshing. A rectangle may only span cells that are all `flat` and
      // share a height bucket: then every corner of the rectangle equals that
      // height, so the merged quad is a plane heightAt() also returns. Unstable
      // cells get a unique key and stay 1x1, keeping their own two triangles.
      const used = new Uint8Array(cw * ch);
      const key = (lx, lz) => {
        const i = cellIndex(ox + lx, oz + lz);
        return flat[i] ? bucket[i] * 2 : -i - 1;
      };
      for (let lz = 0; lz < ch; lz++) {
        for (let lx = 0; lx < cw; lx++) {
          if (used[lz * cw + lx]) continue;
          const k = key(lx, lz);
          let w = 1;
          while (lx + w < cw && !used[lz * cw + lx + w] && key(lx + w, lz) === k) w++;
          let h = 1;
          grow: while (lz + h < ch) {
            for (let i = 0; i < w; i++) {
              if (used[(lz + h) * cw + lx + i] || key(lx + i, lz + h) !== k) break grow;
            }
            h++;
          }
          for (let dz = 0; dz < h; dz++) for (let dx = 0; dx < w; dx++) used[(lz + dz) * cw + lx + dx] = 1;
          emitTop(ox + lx, oz + lz, w, h);
        }
      }

      // skirt: the map rim always, plus any real drop or any tile flagged cliff
      for (let lz = 0; lz < ch; lz++) {
        for (let lx = 0; lx < cw; lx++) {
          const tx = ox + lx, tz = oz + lz;
          const ci = cellIndex(tx, tz);
          const me = height[ci];
          const isCliff = td(ids[ci]).height > CLIFF_FLOOR;
          for (let d = 0; d < 4; d++) {
            const ax2 = tx + DIRS[d][0], az2 = tz + DIRS[d][1];
            const outside = !inBounds(ax2, az2);
            const hOut = outside ? baseY : height[cellIndex(ax2, az2)];
            if (me > hOut && (me - hOut > step * 2 || isCliff)) emitWall(tx, tz, d, hOut);
          }
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `chunk_${gx}_${gz}`;
      group.add(mesh);
    }
  }

  // ------------------------------------------------------------------- water
  // ONE mesh for the whole map, at level 0, one scrolling NearestFilter texture.
  const waterCells = [];
  for (let tz = 0; tz < depth; tz++) {
    for (let tx = 0; tx < width; tx++) {
      if (td(ids[cellIndex(tx, tz)]).water) waterCells.push(cellIndex(tx, tz));
    }
  }
  let waterTex = null, waterMesh = null;
  if (waterCells.length) {
    const wp = [], wuv = [];
    for (const ci of waterCells) {
      const tx = ci % width, tz = (ci / width) | 0;
      const x0 = tx * tileSize, x1 = x0 + tileSize, z0 = tz * tileSize, z1 = z0 + tileSize;
      const uv = [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
      const T = [0, 1, 2, 0, 2, 3];
      for (const i of T) {
        wp.push(uv[i][0], WATER_LEVEL, uv[i][1]);
        wuv.push(uv[i][0] / 8, uv[i][1] / 8);
      }
    }
    waterTex = makeWaterTexture();
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    wg.setAttribute('uv', new THREE.Float32BufferAttribute(wuv, 2));
    wg.computeVertexNormals();
    const wm = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: waterTex, roughness: 0.15, metalness: 0.1,
      transparent: true, opacity: 0.85, depthWrite: true,
    });
    waterMesh = new THREE.Mesh(wg, wm);
    waterMesh.name = 'water';
    waterMesh.renderOrder = 1;
    group.add(waterMesh);
  }

  // ------------------------------------------------------------------ public
  const bounds = { minX: 0, maxX: width * tileSize, minZ: 0, maxZ: depth * tileSize };

  function tileAt(x, z) {
    const tx = Math.floor(x / tileSize), tz = Math.floor(z / tileSize);
    return inBounds(tx, tz) ? ids[cellIndex(tx, tz)] : null;
  }

  function isWalkable(x, z) {
    const id = tileAt(x, z);
    return id !== null && td(id).walkable !== false;
  }

  function update(dt) {
    if (!waterTex) return;
    waterTex.offset.x = (waterTex.offset.x + dt * 0.014) % 1;
    waterTex.offset.y = (waterTex.offset.y + dt * 0.022) % 1;
  }

  function dispose() {
    group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    material.dispose();
    if (waterMesh) waterMesh.material.dispose();
    if (waterTex) waterTex.dispose();
    group.clear();
  }

  return { group, heightAt, normalYAt, tileAt, isWalkable, bounds, worldToTile: (v) => v / tileSize, update, dispose };
}
