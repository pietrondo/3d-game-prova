/**
 * spriteFactory.js — owner: AGENT-ACTORS
 * Procedural pixel-art sheets. Zero binary assets, no Three.js, no gradients.
 *
 * Everything is authored on a fixed 24x24 DESIGN grid and snapped to integers at
 * raster time, so `cell: 24` (party) and `cell: 32` (enemies) are both crisp
 * hard-edged pixel art.
 *
 * Drawing model: every logical part is one `stamp` — a union of rects that gets a
 * 1px hard outline around its own perimeter, then a 3-tone horizontal band fill
 * (light / base / dark, light from above). Parts are stamped in z-order, so each
 * one lays a dark seam over the parts behind it; that separation is what makes a
 * 24px figure readable instead of one fused blob. Parts are kept 1px apart so
 * the seam is a single pixel, never a thick bar.
 *
 * Sheet layout — columns = FACINGS, rows = FRAMES.
 */

export const FACINGS = ['down', 'up', 'left', 'right'];
export const FRAMES = ['idle0', 'idle1', 'walk0', 'walk1', 'walk2', 'walk3'];

export const KINDS = ['hero', 'scholar', 'thief', 'knight', 'slime', 'bat', 'sentinel'];

/** Same nine keys in every palette. Extra tones are derived with `tint()`. */
export const PALETTES = {
  warrior: {
    outline: '#1b1526', skin: '#f4c79a', skinDark: '#c78a58', hair: '#a8642e',
    primary: '#c4442e', primaryDark: '#8a2216', primaryLight: '#e87a58',
    secondary: '#39567f', accent: '#e8c86a',
  },
  scholar: {
    outline: '#171129', skin: '#f6d2ab', skinDark: '#c99a70', hair: '#b9a377',
    primary: '#6a53b8', primaryDark: '#3a2a70', primaryLight: '#9a8ada',
    secondary: '#2c2a4a', accent: '#ffd24a',
  },
  rogue: {
    outline: '#0f151b', skin: '#eab68a', skinDark: '#b87a56', hair: '#24242c',
    primary: '#3d8a72', primaryDark: '#1d4a3e', primaryLight: '#6dbda2',
    secondary: '#4a4458', accent: '#cdd6e0',
  },
  knight: {
    outline: '#13131b', skin: '#ecc296', skinDark: '#b8865c', hair: '#6d6d7c',
    primary: '#b9bdc9', primaryDark: '#797d8b', primaryLight: '#e6eaf2',
    secondary: '#c4442e', accent: '#ffd24a',
  },
  slime: {
    outline: '#13210f', skin: '#7fd45a', skinDark: '#3f8a2c', hair: '#2b5a1c',
    primary: '#5cc242', primaryDark: '#2f7a26', primaryLight: '#a8f07a',
    secondary: '#c9f2a4', accent: '#ffffff',
  },
  bat: {
    outline: '#140f1f', skin: '#7b5b8c', skinDark: '#402b4c', hair: '#241831',
    primary: '#8a67ae', primaryDark: '#4b3368', primaryLight: '#bb9bd8',
    secondary: '#3b2b4c', accent: '#ff5f4a',
  },
  sentinel: {
    outline: '#12161d', skin: '#7c8492', skinDark: '#4b515d', hair: '#2b3138',
    primary: '#78838f', primaryDark: '#40474f', primaryLight: '#a7b1bd',
    secondary: '#2b3138', accent: '#4ce0f0',
  },
  wood: {
    outline: '#181410', skin: '#a4794c', skinDark: '#6d4d2c', hair: '#3f7a3a',
    primary: '#8a5f34', primaryDark: '#5a3d1f', primaryLight: '#b08a52',
    secondary: '#4a7a3c', accent: '#e8d06a',
  },
  stone: {
    outline: '#14151a', skin: '#8d8f97', skinDark: '#5b5d66', hair: '#43454d',
    primary: '#7c7f88', primaryDark: '#4e515a', primaryLight: '#b0b3bb',
    secondary: '#5a6a4a', accent: '#d8d2c0',
  },
};

export function getPalette(name) {
  return PALETTES[name] || PALETTES.warrior;
}

/* ------------------------------------------------------------------ colour */

const _hexCache = new Map();
function rgb(hex) {
  let v = _hexCache.get(hex);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    _hexCache.set(hex, v);
  }
  return v;
}

/** f > 1 lightens toward white, f < 1 darkens toward black. Hue is preserved. */
function tint(hex, f) {
  const c = rgb(hex);
  const m = f >= 1
    ? (v) => Math.round(v + (255 - v) * (f - 1))
    : (v) => Math.round(v * f);
  return [m(c[0]), m(c[1]), m(c[2])];
}

/**
 * 3-tone ramp from one base colour: [light, base, dark].
 * Deltas are deliberately gentle — a big delta on a large shape reads as stripes,
 * not as volume.
 */
function ramp(base, lightF = 1.16, darkF = 0.68) {
  return [tint(base, lightF), rgb(base), tint(base, darkF)];
}
const metal = (base) => ramp(base, 1.24, 0.6);

/* ------------------------------------------------------------------ raster */

const UNIT = 24;    // design grid is 24x24
const GROUND = 24;  // exclusive bottom of the design grid

function makeRaster(cell) {
  const u = cell / UNIT;
  const data = new Uint8ClampedArray(cell * cell * 4);
  const scratch = new Uint8Array(cell * cell);

  const put = (i, c) => {
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
  };

  const r = {
    cell, u, data, ink: rgb('#000000'), _s: scratch,

    /** plain fill, no outline — eyes, visor slits, trim */
    rect(x, y, w, h, c) {
      const X = Math.round(x * u), Y = Math.round(y * u);
      const W = Math.max(1, Math.round((x + w) * u) - X), H = Math.max(1, Math.round((y + h) * u) - Y);
      for (let j = Y; j < Y + H; j++) {
        for (let i = X; i < X + W; i++) {
          if (i >= 0 && j >= 0 && i < cell && j < cell) put(j * cell + i, c);
        }
      }
      return r;
    },
    dot(x, y, c) { return r.rect(x, y, 1, 1, c); },
    strip(x, y, w, c) { return r.rect(x, y, w, 1, c); },

    /**
     * One logical part: `rows` of [x, y, w, h] design rects forming a union.
     * Rows are snapped to whole DESIGN units first and only then scaled, so
     * tapered profiles stay properly nested at any cell size.
     * `outlined:false` for fills that must merge with the part underneath
     * (hair on a face, trim on cloth).
     */
    stamp(rows, light, base, dark, outlined = true) {
      const cells = rows.map(([x, y, w, h]) => {
        const X = Math.round(Math.round(x) * u);
        const Y = Math.round(Math.round(y) * u);
        return [X, Y,
          Math.max(1, Math.round(Math.round(x + w) * u) - X),
          Math.max(1, Math.round(Math.round(y + h) * u) - Y)];
      });
      let top = Infinity, bot = -Infinity;
      scratch.fill(0);
      for (const [X, Y, W, H] of cells) {
        if (Y < top) top = Y;
        if (Y + H - 1 > bot) bot = Y + H - 1;
        for (let j = Y; j < Y + H; j++) {
          for (let i = X; i < X + W; i++) {
            if (i >= 0 && j >= 0 && i < cell && j < cell) scratch[j * cell + i] = 1;
          }
        }
      }
      if (outlined) {
        const ink = r.ink;
        for (let j = 0; j < cell; j++) {
          for (let i = 0; i < cell; i++) {
            const k = j * cell + i;
            if (scratch[k]) continue;
            const near = (i > 0 && scratch[k - 1]) || (i < cell - 1 && scratch[k + 1]) ||
                         (j > 0 && scratch[k - cell]) || (j < cell - 1 && scratch[k + cell]);
            if (near) put(k, ink);
          }
        }
      }
      const h = bot - top + 1;
      const t = Math.max(1, Math.round(h / 3));
      for (const [X, Y, W, H] of cells) {
        for (let j = Y; j < Y + H; j++) {
          const d = j - top;
          const c = d < t ? light : (d >= h - t ? dark : base);
          for (let i = X; i < X + W; i++) {
            if (i >= 0 && i < cell) put(j * cell + i, c);
          }
        }
      }
      return r;
    },

    flipX() {
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < (cell >> 1); x++) {
          const a = (y * cell + x) * 4, b = (y * cell + (cell - 1 - x)) * 4;
          for (let k = 0; k < 4; k++) { const t = data[a + k]; data[a + k] = data[b + k]; data[b + k] = t; }
        }
      }
      return r;
    },
  };
  return r;
}

function blit(g, ctx, col, row) {
  ctx.putImageData(new ImageData(g.data, g.cell, g.cell), col * g.cell, row * g.cell);
}

/* ------------------------------------------------------------------- poses */

const POSE = {
  idle0: { bob: 0, legL: 0, legR: 0, armL: 0, armR: 0 },
  idle1: { bob: -1, legL: 0, legR: 0, armL: 0, armR: 0 },
  walk0: { bob: 0, legL: -1, legR: 0, armL: 0, armR: 0 },
  walk1: { bob: -1, legL: 0, legR: 0, armL: 0, armR: 0 },
  walk2: { bob: 0, legL: 0, legR: -1, armL: 0, armR: 0 },
  walk3: { bob: -1, legL: 0, legR: 0, armL: 0, armR: 0 },
};

function poseFor(name, side) {
  const p = POSE[name] || POSE.idle0;
  // profile: arms swing opposite the legs
  return side ? { ...p, armL: name === 'walk2' ? -1 : 0, armR: name === 'walk0' ? -1 : 0 } : p;
}

/* --------------------------------------------------------------------- rig */
// parts are 1px apart so their outlines form single-pixel seams, never bars
const HEAD  = { x: 8, y: 6, w: 7, h: 6 };    // y 6..11
const TORSO = { x: 8, y: 13, w: 8, h: 6 };   // y 13..18
const ARM   = { y: 14, h: 5, lx: 5, rx: 17 };
const LEG   = { y: 19, h: 5, lx: 8, rx: 14 };

function legs(g, p, ps, o = {}) {
  const b = ps.bob;
  const c = o.legs || ramp(p.secondary, 1.2, 0.62);
  g.stamp([[LEG.lx, LEG.y + b + ps.legL, 2, 5], [LEG.rx, LEG.y + b + ps.legR, 2, 5]],
    c[0], c[1], c[2]);
}

function torso(g, p, ps, o = {}) {
  const b = ps.bob;
  const c = o.cloth || ramp(p.primary);
  g.stamp([[TORSO.x, TORSO.y + b, 8, 6]], c[0], c[1], c[2]);
  if (o.skirt) {
    const s = ramp(o.skirt, 1.14, 0.66);
    g.stamp([[7, 19 + b, 10, 2], [6, 21 + b, 12, 3]], s[0], s[1], s[2]);
  }
}

function arms(g, p, ps, o = {}) {
  const b = ps.bob;
  const c = o.cloth || ramp(p.primary);
  const a = [c[0], c[1], tint(c[2], 0.85)];
  g.stamp([[ARM.lx, ARM.y + b + ps.armL, 2, 5], [ARM.rx, ARM.y + b + ps.armR, 2, 5]],
    a[0], a[1], a[2]);
}

function head(g, p, v, ps, o = {}) {
  const b = ps.bob;
  const hx = v === 'right' ? 9 : HEAD.x;
  const hw = v === 'right' ? 6 : HEAD.w;
  const hy = o.top != null ? o.top : HEAD.y;
  const skin = [p.skin, tint(p.skin, 0.93), p.skinDark];

  g.stamp([[hx, hy + b, hw, 6]], skin[0], skin[1], skin[2]);

  // hair merges with the skull: no outline of its own
  const h = ramp(p.hair, 1.3, 0.66);
  if (v === 'up') g.stamp([[hx, hy + b, hw, 5]], h[0], h[1], h[2], false);
  else if (v === 'right') g.stamp([[hx, hy + b, 3, 6], [hx, hy + b, hw, 3]], h[0], h[1], h[2], false);
  else g.stamp([[hx, hy + b, hw, 3], [hx, hy + 3 + b, 1, 2], [hx + hw - 1, hy + 3 + b, 1, 2]],
    h[0], h[1], h[2], false);

  if (o.eyes === false) return;
  const eye = o.eye ? rgb(o.eye) : rgb(p.outline);
  if (v === 'down') {
    g.rect(hx + 1, hy + 3 + b, 1, 2, eye);
    g.rect(hx + hw - 2, hy + 3 + b, 1, 2, eye);
  } else if (v === 'right') {
    g.rect(hx + hw - 2, hy + 3 + b, 1, 2, eye);
  }
}

/* ------------------------------------------------------------------ figures */

const FIGURES = {
  /**
   * Adventurer — hero. A blue cape flaring to the ankles is the silhouette;
   * a crimson tunic, gold collar and a sword hilt over the shoulder are the read.
   */
  hero(g, p, v, ps) {
    const b = ps.bob;
    const cape = ramp(p.secondary, 1.3, 0.55);
    g.stamp(v === 'right'
      ? [[8, 12 + b, 8, 4], [7, 16 + b, 7, 4], [6, 20 + b, 6, 4]]
      : [[6, 12 + b, 12, 4], [5, 16 + b, 14, 4], [5, 20 + b, 14, 4]],
    cape[0], cape[1], cape[2]);
    g.strip(9, 16 + b, 6, tint(p.secondary, 1.55));      // cape lining glint

    g.stamp([[16, 5 + b, 1, 6]], ...metal(p.accent));   // sword
    g.stamp([[15, 5 + b, 3, 1]], ...ramp(p.accent));

    legs(g, p, ps);
    torso(g, p, ps);
    arms(g, p, ps);
    head(g, p, v, ps);
    g.strip(9, 13 + b, 6, p.accent);                    // collar
    g.rect(11, 19 + b, 2, 6, ramp(p.primaryDark, 1.1, 0.7)[1]);  // belt seam
  },

  /**
   * Scholar — pointed hat, robe, staff. Reads instantly: the cone is the
   * whole point, so the brim overhangs the head and the staff clears the body.
   */
  scholar(g, p, v, ps) {
    const b = ps.bob;
    torso(g, p, ps, { skirt: p.primaryDark });
    arms(g, p, ps, { cloth: ramp(p.primaryDark, 1.25, 0.7) });
    head(g, p, v, ps);

    g.stamp([[19, 9 + b, 1, 13]], ...ramp(p.hair, 1.05, 0.55));       // staff shaft
    g.stamp([[17, 10 + b, 5, 1]], ...ramp(p.hair, 1.05, 0.55));      // crossguard
    const gem = ramp(p.accent, 1.15, 0.65);
    g.stamp([[18, 5 + b, 3, 4]], gem[0], gem[1], gem[2]);             // gem

    const hat = ramp(p.primary, 1.26, 0.6);
    g.stamp([[11, 0 + b, 2, 1], [10, 1 + b, 4, 1], [10, 2 + b, 4, 1],
             [9, 3 + b, 6, 1], [8, 4 + b, 8, 1], [7, 5 + b, 10, 1]],
    hat[0], hat[1], hat[2]);
    g.rect(11, 0 + b, 1, 4, hat[0]);                                  // cone highlight
    g.strip(8, 6 + b, 7, rgb(p.outline));                             // brim shadow on the face
  },

  /**
   * Thief — pointed hood, eye slit, short cloak, dagger. The hood peak and the
   * pale mask band are the read; everything else stays in the dark teal range.
   */
  thief(g, p, v, ps) {
    const b = ps.bob;
    const cloak = ramp(p.primary, 1.16, 0.6);
    const hood = ramp(p.primaryDark, 1.45, 0.62);

    // The cloak must stay narrow. At 12px wide in a 24px cell its 1px outline
    // already reached x=18, so a dagger stamped at x=18 landed *inside* the
    // silhouette and vanished — and since 'left' is 'right' mirrored, a figure
    // with no visible asymmetric mark is byte-identical to its own mirror and
    // cannot show which way it faces. Narrowing the cloak to 10px frees x=18..22
    // for the weapon, which is what makes the side profiles readable.
    g.stamp([[7, 12 + b, 10, 4], [8, 16 + b, 8, 4]], cloak[0], cloak[1], cloak[2]);

    legs(g, p, ps, { legs: ramp(p.primaryDark, 1.2, 0.6) });
    torso(g, p, ps, { cloth: cloak });
    arms(g, p, ps, { cloth: hood });
    head(g, p, v, ps, { eyes: false });

    // dagger: the one asymmetric mark on this figure, drawn last so the body
    // stamps cannot bury it, and long enough to clear the cloak outline
    g.stamp([[19, 12 + b, 1, 7]], ...metal(p.accent));     // blade
    g.stamp([[17, 15 + b, 4, 1]], ...ramp(p.accent, 1.3, 0.5));  // guard
    g.stamp([[20, 19 + b, 1, 2]], ...ramp(p.accent, 1.3, 0.5));  // grip

    // hood: a real peak above the head, flaring to the shoulders
    g.stamp([[11, 1 + b, 2, 1], [10, 2 + b, 4, 1], [9, 3 + b, 6, 1],
             [8, 4 + b, 8, 2], [7, 6 + b, 10, 6]], hood[0], hood[1], hood[2]);
    if (v === 'up') return;
    // dark hood opening, pale mask band inside it, eyes below the brow line
    g.rect(8, 6 + b, 8, 5, tint(p.primaryDark, 0.4));
    g.rect(9, 7 + b, 6, 3, tint(p.skin, 0.92));
    g.strip(9, 7 + b, 6, rgb(p.outline));                 // brow shadow
    g.rect(9, 8 + b, 2, 2, rgb(p.outline));                // eyes at the mask edges
    g.rect(13, 8 + b, 2, 2, rgb(p.outline));
  },

  /**
   * Knight — great helm, crimson plume and cape, steel kite shield. Value plan:
   * dark plume, light helm, mid body, dark shield, so nothing merges.
   */
  knight(g, p, v, ps) {
    const b = ps.bob;
    const steelC = metal(p.primary);
    const steelL = ramp(p.primaryLight, 1.02, 0.82);
    const red = ramp(p.secondary, 1.25, 0.58);

    g.stamp([[6, 12 + b, 12, 4], [5, 16 + b, 14, 8]], red[0], red[1], red[2]);

    legs(g, p, ps, { legs: ramp(p.primaryDark, 1.2, 0.62) });
    torso(g, p, ps, { cloth: steelC });
    g.stamp([[5, 13 + b, 3, 2], [16, 13 + b, 3, 2]], steelL[0], steelL[1], steelL[2]); // pauldrons
    g.stamp([[19, 9 + b, 1, 8]], steelL[0], steelL[1], steelL[2]);                    // sword
    g.stamp([[17, 10 + b, 3, 1]], red[0], red[1], red[2]);                            // sword guard
    g.stamp([[1, 15 + b, 4, 5], [2, 20 + b, 2, 1]], red[1], red[2], tint(p.secondary, 0.5)); // kite shield

    head(g, p, v, ps, { eyes: false });
    // great helm: dome + visor slit + breathing holes
    g.stamp([[10, 4 + b, 4, 1], [9, 5 + b, 6, 1], [8, 6 + b, 7, 5], [9, 11 + b, 5, 1]],
      steelL[0], steelC[0], steelC[2]);
    g.strip(9, 7 + b, 5, steelC[1]);                      // dome ridge
    g.strip(9, 8 + b, 5, rgb(p.outline));          // visor slit
    g.rect(10, 8 + b, 1, 1, p.accent);
    g.rect(13, 8 + b, 1, 1, p.accent);
    g.strip(11, 10 + b, 2, rgb(p.outline));        // breath holes
    g.stamp([[11, 0 + b, 2, 2], [10, 2 + b, 4, 2]], red[1], red[2], tint(p.secondary, 0.5)); // plume
  },

  /**
   * Bog slime — domed blob, one wet highlight, squash on the walk instead of
   * legs. Rows are a hand-built profile so the dome never inverts when scaled.
   */
  slime(g, p, v, ps) {
    const tall = ps.bob < 0 || ps.legL < 0 || ps.legR < 0;
    const x = tall ? 2 : 3;
    const top = tall ? 10 : 11;
    const c = ramp(p.primary, 1.2, 0.7);
    g.stamp([
      [x + 8, top, 8, 1], [x + 6, top + 1, 12, 1], [x + 4, top + 2, 16, 1],
      [x + 3, top + 3, 18, 1], [x + 2, top + 4, 20, 1], [x + 2, top + 5, 20, 1],
      [x + 1, top + 6, 22, 3], [x + 2, top + 9, 20, 1], [x + 3, top + 10, 18, 1],
      [x + 5, top + 11, 14, 1],
    ], c[0], c[1], c[2]);
    g.rect(x + 4, top + 3, 4, 1, tint(p.primaryLight, 1.35));   // wet glint
    g.rect(x + 4, top + 4, 3, 1, p.primaryLight);
    g.rect(x + 6, top + 7, 2, 2, rgb(p.outline));              // eyes
    g.rect(x + 15, top + 7, 2, 2, rgb(p.outline));
    g.rect(x + 9, top + 10, 4, 1, tint(p.primaryDark, 0.7));    // mouth
    void v;
  },

  /**
   * Cave bat — three membrane fingers per side with 1px gaps, so the wing
   * scallops read. Body and ears are a stub; the wings are the character.
   */
  bat(g, p, v, ps) {
    const lift = (ps.bob < 0 || ps.legL < 0 || ps.legR < 0) ? -2 : 0;
    const web = ramp(p.primary, 1.22, 0.64);
    const fur = ramp(p.secondary, 1.35, 0.55);
    // Membrane per side with notches cut out of the trailing edge. The 1px ring
    // that falls into a notch is the wing strut — without notches a wing is just
    // a rectangle, which reads as a plank, not a bat.
    const wing = [
      [0, 10, 8, 2],
      [0, 12, 4, 1], [5, 12, 3, 1],
      [0, 13, 3, 1], [5, 13, 3, 1],
      [0, 14, 2, 1], [5, 14, 3, 1],
      [1, 15, 1, 1], [5, 15, 3, 1],
      [1, 16, 2, 1], [6, 16, 2, 1],
      [2, 17, 2, 1], [6, 17, 2, 1],
      [3, 18, 2, 1], [6, 18, 2, 1],
      [4, 19, 1, 1], [6, 19, 2, 1],
    ].map(([x, y, w, h]) => [x, y + lift, w, h]);
    g.stamp([...wing, ...wing.map(([x, y, w, h]) => [UNIT - x - w, y, w, h])],
      web[0], web[1], web[2]);

    // big ears + a head that clears the wing line: that bump is the read
    g.stamp([[8, 4, 3, 7], [13, 4, 3, 7]], fur[1], fur[2], tint(p.secondary, 0.5));
    g.stamp([[9, 9, 6, 6], [10, 14, 4, 8]], fur[0], fur[1], fur[2]);
    g.rect(10, 11, 2, 2, p.accent);                        // glowing eyes
    g.rect(13, 11, 2, 2, p.accent);
    g.rect(11, 15, 1, 2, rgb(p.outline));                 // fangs
    g.rect(12, 15, 1, 2, rgb(p.outline));
    void v;
  },

  /**
   * Sentinel — a tall stone spike with a deliberate 4px slot and a gem core
   * floating inside it. No face: it is architecture, not a creature, and a
   * visor slit here made it read as a helmet.
   */
  sentinel(g, p, v, ps) {
    const stone = ramp(p.primary, 1.2, 0.66);
    const coreY = 9 + (ps.bob < 0 ? -1 : 0);
    g.stamp([[11, 0, 2, 2], [10, 2, 4, 6],
             [9, 12, 6, 8], [8, 20, 8, 2], [7, 22, 10, 2]],
    stone[0], stone[1], stone[2]);
    g.strip(10, 5, 4, stone[2]);                                 // engraved band
    g.strip(9, 16, 6, stone[2]);
    // floating gem core, diamond profile so it never reads as a box
    const core = ramp(p.accent, 1.15, 0.6);
    g.stamp([[11, coreY, 2, 1], [10, coreY + 1, 4, 1], [11, coreY + 2, 2, 1]],
      core[0], core[1], core[2]);
    g.rect(11, coreY + 1, 1, 1, tint(p.accent, 1.6));
    void v;
  },
};

/* --------------------------------------------------------------- public API */

function renderFigure(kind, p, facing, frame, cell) {
  const g = makeRaster(cell);
  g.ink = rgb(p.outline);
  const fig = FIGURES[kind] || FIGURES.hero;
  const side = facing === 'left' || facing === 'right';
  // 'left' is the 'right' profile mirrored, so the two can never drift apart
  fig(g, p, facing === 'left' ? 'right' : facing, poseFor(frame, side));
  if (facing === 'left') g.flipX();
  return g;
}

function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function buildActorSheet({ kind, palette, seed = 1, cell = 24, frames = FRAMES }) {
  const p = getPalette(palette);
  void seed;                        // the art is deterministic by design
  const canvas = newCanvas(cell * FACINGS.length, cell * frames.length);
  // willReadFrequently: actor.js's figureFill() calls getImageData() on this
  // sheet to measure the drawn figure, and Chrome warns once per canvas without
  // it. It has to be set HERE — getContext() on a canvas that already has a
  // context returns the existing one and ignores the new attributes.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  FACINGS.forEach((facing, col) => {
    frames.forEach((frame, row) => {
      blit(renderFigure(kind, p, facing, frame, cell), ctx, col, row);
    });
  });
  return canvas;
}

export function buildEnemySheet({ kind, palette, seed = 1, cell = 32 }) {
  const p = getPalette(palette);
  void seed;
  const canvas = newCanvas(cell, cell * FRAMES.length);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });   // see buildActorSheet
  ctx.imageSmoothingEnabled = false;
  FRAMES.forEach((frame, row) => blit(renderFigure(kind, p, 'down', frame, cell), ctx, 0, row));
  return canvas;
}

export function buildPropTexture({ kind, size = 32, palette }) {
  const p = getPalette(palette || 'stone');
  const canvas = newCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (FIGURES[kind]) {
    blit(renderFigure(kind, p, 'down', 'idle0', size), ctx, 0, 0);
    return canvas;
  }
  // battle backdrop: banded void floor with an ordered dither, no gradients
  const bands = [tint(p.primaryDark, 0.55), p.primaryDark, tint(p.primaryDark, 1.2), p.primary];
  for (let y = 0; y < size; y++) {
    const c = bands[Math.min(bands.length - 1, (y * bands.length / size) | 0)];
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(0, y, size, 1);
  }
  for (let y = 0; y < size; y += 2) {
    ctx.fillStyle = `rgb(${bands[0][0]},${bands[0][1]},${bands[0][2]})`;
    for (let x = (y >> 1) & 1; x < size; x += 2) ctx.fillRect(x, y, 1, 1);
  }
  return canvas;
}
