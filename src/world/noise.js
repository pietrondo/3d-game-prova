// Seeded value noise + fBm. Pure: no Three.js, no Math.random, no Date.
// Same seed => same numbers on every reload (vitest depends on it).

function hash01(ix, iy, seed) {
  let h = (seed ^ Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Quintic fade: C2 continuous, so fBm does not show grid creases. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function makeNoise(seed = 0) {
  const s = seed | 0;

  /** Smooth value noise in -1..1. */
  function value2(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = fade(x - x0), ty = fade(y - y0);
    const a = hash01(x0, y0, s);
    const b = hash01(x0 + 1, y0, s);
    const c = hash01(x0, y0 + 1, s);
    const d = hash01(x0 + 1, y0 + 1, s);
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return (top + (bot - top) * ty) * 2 - 1;
  }

  /** Fractal sum, normalised so the result stays in -1..1. */
  function fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0, norm = 0, amp = 1, freq = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * value2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  return { value2, fbm2 };
}
