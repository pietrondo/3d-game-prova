/**
 * _layoutcheck.mjs — does every village piece sit on ground it can actually rest on?
 *
 * The terrace's flat core is small (inner = 3.1) and its feather ring slopes back
 * to the natural terrain. A piece is translated by ONE ground height at its
 * centre, so what matters per piece is the height SPREAD across its own extent:
 * a long fence on a slope is buried at one end, whatever its centre height is.
 *
 * Reports, per piece: distance from the village centre, ground height at the
 * centre vs the terrace level, and the worst height delta across the piece's
 * footprint. Deleted once the layout fits.
 */

import { createTerrain } from '../src/world/terrain.js';
import TILES from '../src/data/tiles.json' with { type: 'json' };
import VILLAGE from '../src/data/village.json' with { type: 'json' };

const SHELVES = [
  { at: 0.60, r: 5.5, feather: 2.4 },   // shipped
  { at: 0.62, r: 7.5, feather: 2.0 },
  { at: 0.62, r: 7.0, feather: 1.4 },
  { at: 0.60, r: 6.5, feather: 1.2 },
];

// The footprint half-extents each builder actually draws, mirroring village.js.
function extent(it) {
  switch (it.type) {
    case 'house': return [it.w / 2 + 0.15, it.d / 2 + 0.15];
    case 'well': return [it.r ?? 0.55, it.r ?? 0.55];
    case 'sign': return [0.45, 0.2];
    case 'lantern': return [0.15, 0.15];
    case 'fence': {
      const len = (it.len ?? 5) / 2;
      return it.axis === 'z' ? [0.1, len] : [len, 0.1];
    }
    default: return [0.2, 0.2];
  }
}

for (const cfg of SHELVES) {
  const t = createTerrain({
    width: 64, depth: 64, seed: 1337, heightScale: 3.2, tiles: TILES,
    shelf: { angle: Math.PI / 2, ...cfg },
  });
  const s = t.shelf;
  let bad = 0;
  let worstSpread = 0;
  let worstName = '';
  for (const it of VILLAGE.layout) {
    const wx = s.x + it.x, wz = s.z + it.z;
    const centreH = t.heightAt(wx, wz);
    const [hx, hz] = extent(it);
    let min = centreH, max = centreH;
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const h = t.heightAt(wx + ox * hx, wz + oz * hz);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    const spread = max - min;
    if (spread > worstSpread) { worstSpread = spread; worstName = it.id; }
    if (spread > 0.25 || !t.isWalkable(wx, wz)) bad++;
  }
  console.log(
    `at=${cfg.at} r=${cfg.r} feather=${cfg.feather} -> inner=${s.inner.toFixed(1)} `
    + `y=${s.y.toFixed(3)} bad=${bad}/${VILLAGE.layout.length} `
    + `worst=${worstSpread.toFixed(3)} (${worstName})`,
  );
}

