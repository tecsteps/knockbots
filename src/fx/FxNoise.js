/**
 * Knockbots — CPU noise used to bake FX textures.
 *
 * Every particle texture in the game is generated here at boot rather than
 * loaded, because the shipping build is a single self-contained HTML file. The
 * bakers in `FxTextures.js` need noise that is *cheap on the CPU and tileable*,
 * which rules out the GLSL simplex most engines reuse: a smoke puff that does
 * not tile shows its seam the moment two puffs overlap.
 *
 * So this file provides:
 *   - `valueNoise3` / `fbm3` — periodic 3D value noise on an integer lattice,
 *     wrapping at a user-chosen period so the result tiles exactly.
 *   - `worley2` — tiling cellular noise, used for the cracked-scorch decal and
 *     the fractured look on the metal shard sparkle mask.
 *   - `ridged3` — |1 - 2n| folded fbm, which is what makes smoke read as
 *     billowing rather than fuzzy.
 *
 * All of it is seeded from an integer hash, so a given seed always bakes the
 * same texture and screenshots are reproducible.
 */

/** Integer hash → [0,1). Wang-style avalanche; no floating point drift. */
function hash3(x, y, z, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647 + (seed | 0) * 1013904223;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Quintic smoothstep — C2 continuous, so fbm gradients stay smooth. */
function quintic(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function wrap(i, period) {
  const m = i % period;
  return m < 0 ? m + period : m;
}

/**
 * Periodic 3D value noise.
 * @param {number} x @param {number} y @param {number} z
 * @param {number} period lattice period; the field tiles over this many units
 * @param {number} seed
 * @returns {number} in [0,1]
 */
export function valueNoise3(x, y, z, period, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = quintic(x - xi), yf = quintic(y - yi), zf = quintic(z - zi);

  const x0 = wrap(xi, period), x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period), y1 = wrap(yi + 1, period);
  const z0 = wrap(zi, period), z1 = wrap(zi + 1, period);

  const c000 = hash3(x0, y0, z0, seed), c100 = hash3(x1, y0, z0, seed);
  const c010 = hash3(x0, y1, z0, seed), c110 = hash3(x1, y1, z0, seed);
  const c001 = hash3(x0, y0, z1, seed), c101 = hash3(x1, y0, z1, seed);
  const c011 = hash3(x0, y1, z1, seed), c111 = hash3(x1, y1, z1, seed);

  const a = c000 + (c100 - c000) * xf;
  const b = c010 + (c110 - c010) * xf;
  const c = c001 + (c101 - c001) * xf;
  const d = c011 + (c111 - c011) * xf;
  const e = a + (b - a) * yf;
  const f = c + (d - c) * yf;
  return e + (f - e) * zf;
}

/**
 * Fractal sum of periodic value noise. The period doubles with the frequency so
 * every octave tiles on the same boundary.
 * @returns {number} in [0,1]
 */
export function fbm3(x, y, z, { octaves = 5, period = 8, seed = 0, lacunarity = 2, gain = 0.5 } = {}) {
  let sum = 0, amp = 1, norm = 0, freq = 1, per = period;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, per, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
    per = Math.max(1, Math.round(per * lacunarity));
  }
  return sum / norm;
}

/**
 * Ridged multifractal. Folding the noise about its midpoint creates sharp
 * creases where smoke sheets fold over themselves.
 * @returns {number} in [0,1]
 */
export function ridged3(x, y, z, { octaves = 5, period = 8, seed = 0, gain = 0.55 } = {}) {
  let sum = 0, amp = 1, norm = 0, freq = 1, per = period;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise3(x * freq, y * freq, z * freq, per, seed + i * 977);
    const r = 1 - Math.abs(n * 2 - 1);
    sum += amp * r * r;
    norm += amp;
    amp *= gain;
    freq *= 2;
    per = Math.max(1, per * 2);
  }
  return sum / norm;
}

/**
 * Tiling cellular (Worley) noise, F1 distance normalised to [0,1].
 * @param {number} x @param {number} y  in cell units
 * @param {number} period cells per tile
 * @param {number} seed
 */
export function worley2(x, y, period, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx, cy = yi + dy;
      const wx = wrap(cx, period), wy = wrap(cy, period);
      const px = cx + hash3(wx, wy, 7, seed);
      const py = cy + hash3(wx, wy, 19, seed);
      const ddx = px - x, ddy = py - y;
      const d = ddx * ddx + ddy * ddy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

/** Smoothstep, matching the GLSL semantics. */
export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Linear interpolation. */
export function mix(a, b, t) { return a + (b - a) * t; }

/** Clamp helper used all over the bakers. */
export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
