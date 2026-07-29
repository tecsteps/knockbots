/**
 * Knockbots — procedural texture kitchen for the arena.
 *
 * The arena needs roughly a dozen PBR map sets and the build ships as a single
 * HTML file, so every one of them is arithmetic over typed arrays. Two
 * decisions make that affordable at 2048px:
 *
 *   1. **Octaves are synthesised at their own natural resolution.** A noise
 *      layer with 6 lattice cells across the tile carries no information above
 *      ~24px, so it is evaluated into a 24px buffer and bilinearly upsampled
 *      into the accumulator. Only the top octave ever runs at full size, which
 *      turns an O(size^2 * octaves) gradient evaluation into O(size^2) taps.
 *   2. **Every map in a set is derived from the same height/mask fields.** A
 *      crack is a groove in the height field, therefore it darkens albedo, it
 *      shows in the normal map, it collects grime so roughness rises, and it
 *      occludes so AO drops. The channels cannot drift apart because they are
 *      the same numbers.
 *
 * Noise is a periodic gradient lattice, so everything tiles seamlessly and the
 * same routine serves both tiling detail maps and one-shot macro maps.
 *
 * Colour space discipline per the charter: albedo/emissive are composed in
 * linear light and encoded to sRGB bytes on the way out; normal, roughness,
 * metalness and AO are raw data with NoColorSpace.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const saturate = clamp01;

export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** Signed distance to the nearest of two parallel edges, normalised to [0,1]. */
export function band(x, centre, halfWidth, feather) {
  return 1 - smoothstep(halfWidth - feather, halfWidth, Math.abs(x - centre));
}

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear -> sRGB byte through a 16k LUT; forty times faster than Math.pow. */
const LINEAR_TO_SRGB = new Uint8Array(16384);
for (let i = 0; i < 16384; i++) {
  const v = i / 16383;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.round(clamp01(s) * 255);
}

export const encodeSrgb = (v) => LINEAR_TO_SRGB[(clamp01(v) * 16383) | 0];

/** Unpacks 0xRRGGBB into a linear-light triple. */
export function hexToLinear(hex, out = [0, 0, 0]) {
  const h = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex | 0;
  out[0] = SRGB_TO_LINEAR[(h >> 16) & 255];
  out[1] = SRGB_TO_LINEAR[(h >> 8) & 255];
  out[2] = SRGB_TO_LINEAR[h & 255];
  return out;
}

// ---------------------------------------------------------------------------
// Periodic gradient noise
// ---------------------------------------------------------------------------

/**
 * Integer hash. Two rounds of multiply-xor-shift; the third round costs more
 * than the visible improvement on a 2048px field.
 */
function hash2(x, y, seed) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Unit gradient from a hash, drawn from a 16-direction set. */
const GRAD_X = new Float32Array(16);
const GRAD_Y = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const a = (i / 16) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/**
 * One octave of periodic gradient noise rendered at its natural resolution.
 * @param {number} res output edge length in texels
 * @param {number} cells lattice cells across the tile (the period)
 * @param {number} seed
 * @returns {Float32Array} res*res values in roughly [-1, 1]
 */
export function perlinLayer(res, cells, seed) {
  const out = new Float32Array(res * res);
  const scale = cells / res;
  for (let j = 0; j < res; j++) {
    const fy = j * scale;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const vy = ty * ty * (3 - 2 * ty);
    const j0 = ((y0 % cells) + cells) % cells;
    const j1 = (j0 + 1) % cells;
    const row = j * res;
    for (let i = 0; i < res; i++) {
      const fx = i * scale;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const vx = tx * tx * (3 - 2 * tx);
      const i0 = ((x0 % cells) + cells) % cells;
      const i1 = (i0 + 1) % cells;

      const g00 = hash2(i0, j0, seed) & 15;
      const g10 = hash2(i1, j0, seed) & 15;
      const g01 = hash2(i0, j1, seed) & 15;
      const g11 = hash2(i1, j1, seed) & 15;

      const n00 = GRAD_X[g00] * tx + GRAD_Y[g00] * ty;
      const n10 = GRAD_X[g10] * (tx - 1) + GRAD_Y[g10] * ty;
      const n01 = GRAD_X[g01] * tx + GRAD_Y[g01] * (ty - 1);
      const n11 = GRAD_X[g11] * (tx - 1) + GRAD_Y[g11] * (ty - 1);

      const a = n00 + vx * (n10 - n00);
      const b = n01 + vx * (n11 - n01);
      out[row + i] = (a + vy * (b - a)) * 1.4;
    }
  }
  return out;
}

/** Bilinear tap into a square field with wrapping. u,v in texel units. */
export function sampleWrap(field, size, u, v) {
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const tx = u - x0;
  const ty = v - y0;
  const i0 = ((x0 % size) + size) % size;
  const j0 = ((y0 % size) + size) % size;
  const i1 = (i0 + 1) % size;
  const j1 = (j0 + 1) % size;
  const r0 = j0 * size;
  const r1 = j1 * size;
  const a = field[r0 + i0] + tx * (field[r0 + i1] - field[r0 + i0]);
  const b = field[r1 + i0] + tx * (field[r1 + i1] - field[r1 + i0]);
  return a + ty * (b - a);
}

/** Accumulates a low-resolution layer into a full-resolution buffer. */
function upsampleAdd(dst, dstSize, src, srcRes, amp) {
  if (srcRes === dstSize) {
    for (let i = 0; i < dst.length; i++) dst[i] += src[i] * amp;
    return;
  }
  const s = srcRes / dstSize;
  for (let j = 0; j < dstSize; j++) {
    const v = j * s;
    const row = j * dstSize;
    for (let i = 0; i < dstSize; i++) dst[row + i] += sampleWrap(src, srcRes, i * s, v) * amp;
  }
}

/**
 * Fractal periodic noise.
 * @param {number} size output edge length
 * @param {number} cells lattice cells across the tile at the base octave
 * @param {object} [opts]
 * @param {number} [opts.octaves=5]
 * @param {number} [opts.gain=0.5]
 * @param {number} [opts.lacunarity=2]
 * @param {number} [opts.seed=1]
 * @param {boolean} [opts.ridged=false] fold to |n| and invert — gives creases
 * @param {boolean} [opts.signed=false] leave in [-1,1] instead of [0,1]
 * @returns {Float32Array}
 */
export function fbm(size, cells, opts = {}) {
  const octaves = opts.octaves ?? 5;
  const gain = opts.gain ?? 0.5;
  const lac = opts.lacunarity ?? 2;
  const seed = opts.seed ?? 1;
  const out = new Float32Array(size * size);

  let freq = cells;
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const c = Math.max(2, Math.round(freq));
    if (c > size) break;
    const res = Math.min(size, Math.max(8, 1 << Math.ceil(Math.log2(c * 4))));
    let layer = perlinLayer(res, c, seed + o * 7919);
    if (opts.ridged) {
      for (let i = 0; i < layer.length; i++) layer[i] = 1 - Math.abs(layer[i]) * 2;
    }
    upsampleAdd(out, size, layer, res, amp);
    total += amp;
    amp *= gain;
    freq *= lac;
  }

  const inv = 1 / (total || 1);
  if (opts.signed) {
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  } else {
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] * inv * 0.5 + 0.5);
  }
  return out;
}

/**
 * Periodic Worley/cellular noise. Returns F1 distance normalised so cell
 * centres are 0 and cell borders approach 1, plus a per-cell random id field
 * which is what gives puddles and concrete aggregate their patchiness.
 * @returns {{ f1: Float32Array, id: Float32Array }}
 */
export function worley(size, cells, seed = 1, jitter = 0.85) {
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const pid = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const h = hash2(i, j, seed);
      const k = j * cells + i;
      px[k] = i + 0.5 + (((h & 0xffff) / 65535) - 0.5) * jitter;
      py[k] = j + 0.5 + ((((h >>> 16) & 0xffff) / 65535) - 0.5) * jitter;
      pid[k] = (hash2(i, j, seed ^ 0x5bf03635) & 0xffff) / 65535;
    }
  }

  const f1 = new Float32Array(size * size);
  const id = new Float32Array(size * size);
  const s = cells / size;
  const maxD = 1.0;
  for (let j = 0; j < size; j++) {
    const y = j * s;
    const cj = Math.floor(y);
    const row = j * size;
    for (let i = 0; i < size; i++) {
      const x = i * s;
      const ci = Math.floor(x);
      let best = 1e9;
      let bestId = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const nj = ((cj + dj) % cells + cells) % cells;
        const wrapY = (cj + dj) - nj;
        for (let di = -1; di <= 1; di++) {
          const ni = ((ci + di) % cells + cells) % cells;
          const wrapX = (ci + di) - ni;
          const k = nj * cells + ni;
          const dx = px[k] + wrapX - x;
          const dy = py[k] + wrapY - y;
          const d = dx * dx + dy * dy;
          if (d < best) { best = d; bestId = pid[k]; }
        }
      }
      f1[row + i] = clamp01(Math.sqrt(best) / maxD);
      id[row + i] = bestId;
    }
  }
  return { f1, id };
}

/** Nearest-neighbour-free resample of a square field. */
export function resample(src, srcSize, dstSize) {
  if (srcSize === dstSize) return src;
  const out = new Float32Array(dstSize * dstSize);
  const s = srcSize / dstSize;
  for (let j = 0; j < dstSize; j++) {
    const v = j * s;
    const row = j * dstSize;
    for (let i = 0; i < dstSize; i++) out[row + i] = sampleWrap(src, srcSize, i * s, v);
  }
  return out;
}

/**
 * Separable box blur; `passes` iterations approximate a Gaussian. Returns a new
 * buffer and never mutates the input.
 */
export function blur(field, size, radius, passes = 2, wrap = true) {
  const r = Math.round(radius);
  if (r < 1) return Float32Array.from(field);
  const norm = 1 / (r * 2 + 1);
  const src = Float32Array.from(field);
  const tmp = new Float32Array(size * size);
  const clampIdx = (v) => (v < 0 ? 0 : v >= size ? size - 1 : v);
  const wrapIdx = (v) => ((v % size) + size) % size;
  const fix = wrap ? wrapIdx : clampIdx;

  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < size; j++) {
      const row = j * size;
      for (let i = 0; i < size; i++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + fix(i + k)];
        tmp[row + i] = sum * norm;
      }
    }
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[fix(j + k) * size + i];
        src[j * size + i] = sum * norm;
      }
    }
  }
  return src;
}

// ---------------------------------------------------------------------------
// Stencil lettering
//
// Painted floor callouts and warning plates are what stop a stage reading as
// untextured geometry, and they need real letterforms. A 5x7 bitmap font costs
// 300 bytes and rasterises into any mask field.
// ---------------------------------------------------------------------------

const FONT5x7 = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ':': [0x00, 0x0c, 0x0c, 0x00, 0x0c, 0x0c, 0x00],
  '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04],
  '+': [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
};

/** Width in texels of a string rendered at the given cell size. */
export function textWidth(text, cell) {
  return text.length * 6 * cell - cell;
}

/**
 * Rasterises stencil text into a mask field with a soft edge. Coordinates are
 * texels; `x`,`y` are the top-left of the first glyph.
 * @param {Float32Array} field destination mask, values are max-combined
 * @param {number} size field edge length
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} cell texel size of one font pixel
 * @param {number} [feather=1] edge softness in texels
 * @param {boolean} [flipY=true] draw glyph rows bottom-up. Row 0 of a texture
 *   lands at v=0, which is the *bottom* of a quad, so text stamped top-down
 *   renders upside down. Defaults on because that is almost always what the
 *   caller wants.
 */
export function stampText(field, size, text, x, y, cell, feather = 1, flipY = true) {
  const s = text.toUpperCase();
  for (let c = 0; c < s.length; c++) {
    const glyph = FONT5x7[s[c]];
    if (!glyph) continue;
    const gx = x + c * 6 * cell;
    for (let r = 0; r < 7; r++) {
      const bits = glyph[r];
      if (!bits) continue;
      for (let b = 0; b < 5; b++) {
        if (!(bits & (1 << (4 - b)))) continue;
        const px0 = gx + b * cell;
        const py0 = y + (flipY ? 6 - r : r) * cell;
        const i0 = Math.max(0, Math.floor(px0 - feather));
        const i1 = Math.min(size - 1, Math.ceil(px0 + cell + feather));
        const j0 = Math.max(0, Math.floor(py0 - feather));
        const j1 = Math.min(size - 1, Math.ceil(py0 + cell + feather));
        for (let j = j0; j <= j1; j++) {
          const dy = j < py0 ? py0 - j : j > py0 + cell ? j - (py0 + cell) : 0;
          for (let i = i0; i <= i1; i++) {
            const dx = i < px0 ? px0 - i : i > px0 + cell ? i - (px0 + cell) : 0;
            const d = Math.sqrt(dx * dx + dy * dy);
            const v = 1 - smoothstep(0, feather, d);
            const k = j * size + i;
            if (v > field[k]) field[k] = v;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Field -> texture
// ---------------------------------------------------------------------------

/**
 * Sobel-derives a tangent-space normal map from a height field.
 * @param {Float32Array} height
 * @param {number} size
 * @param {number} strength height in texel units; 2–8 for surface detail
 * @param {object} [opts]
 * @param {boolean} [opts.wrap=true]
 * @param {Float32Array} [opts.alpha] optional extra mask written to the A channel
 * @returns {Uint8Array} RGBA
 */
export function heightToNormal(height, size, strength, opts = {}) {
  const wrap = opts.wrap !== false;
  const out = new Uint8Array(size * size * 4);
  const alpha = opts.alpha;
  const last = size - 1;
  // Row offsets and the neighbour indices are hoisted: at 2048px this loop runs
  // thirty-four million taps and a closure per tap is the whole cost.
  for (let j = 0; j < size; j++) {
    const jm = wrap ? (j === 0 ? last : j - 1) : (j === 0 ? 0 : j - 1);
    const jp = wrap ? (j === last ? 0 : j + 1) : (j === last ? last : j + 1);
    const rowM = jm * size;
    const row = j * size;
    const rowP = jp * size;
    for (let i = 0; i < size; i++) {
      const im = wrap ? (i === 0 ? last : i - 1) : (i === 0 ? 0 : i - 1);
      const ip = wrap ? (i === last ? 0 : i + 1) : (i === last ? last : i + 1);
      const tl = height[rowM + im], t = height[rowM + i], tr = height[rowM + ip];
      const l = height[row + im], r = height[row + ip];
      const bl = height[rowP + im], b = height[rowP + i], br = height[rowP + ip];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      const nx = -dx * strength;
      const ny = -dy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const k = (row + i) * 4;
      out[k] = ((nx * inv * 0.5 + 0.5) * 255) | 0;
      out[k + 1] = ((ny * inv * 0.5 + 0.5) * 255) | 0;
      out[k + 2] = ((inv * 0.5 + 0.5) * 255) | 0;
      out[k + 3] = alpha ? (clamp01(alpha[row + i]) * 255) | 0 : 255;
    }
  }
  return out;
}

/**
 * Screen-space ambient occlusion for a height field: how much of the local
 * neighbourhood rises above this texel. Cheap, and it is what makes panel gaps
 * and cracks read as depth rather than as painted lines.
 */
export function heightToAo(height, size, radius = 6, strength = 1.4) {
  const out = new Float32Array(size * size);
  const taps = [];
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    taps.push([Math.cos(ang) * radius, Math.sin(ang) * radius]);
    taps.push([Math.cos(ang) * radius * 0.45, Math.sin(ang) * radius * 0.45]);
  }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const h = height[j * size + i];
      let occ = 0;
      for (let t = 0; t < taps.length; t++) {
        const s = sampleWrap(height, size, i + taps[t][0], j + taps[t][1]);
        if (s > h) occ += s - h;
      }
      out[j * size + i] = clamp01(1 - (occ / taps.length) * strength * 12);
    }
  }
  return out;
}

const _tmpLin = [0, 0, 0];

/**
 * Builds an sRGB albedo texture from a per-texel callback that writes linear
 * RGB into `out`. Kept as a callback rather than a field triple because the
 * arena's albedos are all cheap recombinations of masks the caller already has.
 * @param {number} size
 * @param {(i:number, j:number, k:number, out:number[]) => void} fn
 * @returns {THREE.DataTexture}
 */
export function bakeAlbedo(size, fn) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      _tmpLin[0] = 0; _tmpLin[1] = 0; _tmpLin[2] = 0;
      fn(i, j, k, _tmpLin);
      const o = k * 4;
      data[o] = encodeSrgb(_tmpLin[0]);
      data[o + 1] = encodeSrgb(_tmpLin[1]);
      data[o + 2] = encodeSrgb(_tmpLin[2]);
      data[o + 3] = 255;
    }
  }
  return makeTexture(data, size, { srgb: true });
}

/**
 * Packs three data fields into one RGBA texture on the glTF convention
 * (R = occlusion, G = roughness, B = metalness). One texture can then be bound
 * to `aoMap`, `roughnessMap` and `metalnessMap` at once — three reads a
 * different channel from each — which saves two texture units per material.
 */
export function packOrm(ao, rough, metal, size, extra = null) {
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const o = k * 4;
    data[o] = Math.round(clamp01(ao ? ao[k] : 1) * 255);
    data[o + 1] = Math.round(clamp01(rough ? rough[k] : 0.5) * 255);
    data[o + 2] = Math.round(clamp01(metal ? metal[k] : 0) * 255);
    data[o + 3] = Math.round(clamp01(extra ? extra[k] : 1) * 255);
  }
  return makeTexture(data, size, { srgb: false });
}

/**
 * @param {Uint8Array} data RGBA bytes
 * @param {number} size edge length
 * @param {object} [opts]
 * @param {boolean} [opts.srgb=false]
 * @param {number} [opts.repeat=1]
 * @param {boolean} [opts.clamp=false] clamp instead of repeat (macro maps)
 * @param {number} [opts.anisotropy=16]
 * @returns {THREE.DataTexture}
 */
export function makeTexture(data, size, opts = {}) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const w = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapS = w;
  tex.wrapT = w;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = opts.anisotropy ?? 16;
  if (opts.repeat) tex.repeat.set(opts.repeat, opts.repeat);
  tex.needsUpdate = true;
  return tex;
}

/**
 * A cutout mask texture, for chain-link, grating and decals.
 *
 * The mask is written to every channel, not just alpha: three's `alphaMap`
 * reads the **green** channel, while sprite shaders here read alpha. Filling
 * all four means one texture serves both without a silent full-opacity bug.
 */
export function makeAlpha(mask, size, opts = {}) {
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const v = Math.round(clamp01(mask[k]) * 255);
    const o = k * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = v;
  }
  return makeTexture(data, size, opts);
}

/**
 * A soft radial sprite. Used for dust motes, sparks and steam so no external
 * image is ever needed.
 * @param {number} size
 * @param {number} power falloff exponent; 2 is a soft blob, 6 is a tight core
 */
export function radialSprite(size = 64, power = 2.2, core = 0.0) {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) * 0.5;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = (i - c) / c;
      const dy = (j - c) / c;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const a = Math.pow(1 - d, power) + core * (1 - smoothstep(0, 0.18, d));
      const o = (j * size + i) * 4;
      data[o] = 255; data[o + 1] = 255; data[o + 2] = 255;
      data[o + 3] = Math.round(clamp01(a) * 255);
    }
  }
  const t = makeTexture(data, size, { clamp: true, anisotropy: 1 });
  return t;
}

/**
 * Tiling 3-octave grey noise, sampled by the volumetric and steam shaders. Kept
 * separate from `fbm` because the GPU wants a texture, not a field.
 */
export function noiseTexture(size = 128, cells = 4, seed = 7) {
  const a = fbm(size, cells, { octaves: 4, seed });
  const b = fbm(size, cells * 2, { octaves: 3, seed: seed + 31 });
  const c = fbm(size, cells * 4, { octaves: 2, seed: seed + 97 });
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const o = k * 4;
    data[o] = Math.round(a[k] * 255);
    data[o + 1] = Math.round(b[k] * 255);
    data[o + 2] = Math.round(c[k] * 255);
    data[o + 3] = 255;
  }
  const t = makeTexture(data, size, { anisotropy: 1 });
  return t;
}
