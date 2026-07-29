/**
 * Knockbots — procedural PBR material library.
 *
 * Everything a robot is made of is authored here, in code, at load time. No
 * image files ever enter the build, so the whole surfacing budget has to come
 * from arithmetic over typed arrays.
 *
 * The architecture that makes that affordable:
 *
 *   1. **Detail sets** are greyscale, character-agnostic and expensive. A
 *      "plate" set (panel lines, rivets, vents, chips, scratches, grime) and a
 *      "metal" set (anisotropic brush, pitting) and so on are generated ONCE
 *      and memoised at module scope. Six characters pay for them once.
 *   2. **Albedo** is the only thing that differs per character, and it is a
 *      cheap per-pixel recombination of the cached masks — no noise is
 *      re-evaluated. Composing it in *linear* light and re-encoding to sRGB is
 *      what stops recoloured paint from going muddy.
 *   3. Every channel is derived from the same few fields, so the maps agree
 *      with each other by construction: a scratch is a dent in the height
 *      field, therefore it appears in the normal map, it removes paint so
 *      metalness rises and clearcoat drops, and it polishes the steel beneath
 *      so roughness falls. There is no way for them to drift apart.
 *
 * Noise is a periodic Perlin lattice so every map tiles seamlessly, and the
 * octaves are synthesised at their own natural resolution and smooth-upsampled
 * rather than evaluated per-pixel — that alone is roughly an 8x saving on the
 * fractal fields and is why the whole library builds in a few hundred
 * milliseconds instead of several seconds.
 *
 * Channel packing (kept glTF-compatible so three's stock shader reads it):
 *   ORM  : R = ambient occlusion, G = roughness, B = metalness, A = sheen roughness
 *   CC   : R = clearcoat strength, G = clearcoat roughness
 *   ANISO: RG = tangent-space direction (biased), B = strength
 *
 * Colour spaces follow the charter: albedo and emissive are SRGBColorSpace,
 * every data map is NoColorSpace.
 */

import * as THREE from 'three';
import { Rng } from '../core/Rng.js';

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/** sRGB byte -> linear float. */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Linear float -> sRGB byte, through a 16k LUT. Direct Math.pow would cost
 * three million calls per albedo map; the LUT plus the hash dither below is
 * visually identical and about forty times faster.
 */
const LINEAR_TO_SRGB = new Uint8Array(16384);
for (let i = 0; i < 16384; i++) {
  const v = i / 16383;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.round(clamp01(s) * 255);
}

const encodeSrgb = (v) => LINEAR_TO_SRGB[(clamp01(v) * 16383) | 0];

/** Unpacks a 0xRRGGBB into a linear-light triple. */
function hexToLinear(hex, out = [0, 0, 0]) {
  const h = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex | 0;
  out[0] = SRGB_TO_LINEAR[(h >> 16) & 255];
  out[1] = SRGB_TO_LINEAR[(h >> 8) & 255];
  out[2] = SRGB_TO_LINEAR[h & 255];
  return out;
}

/** Luma of a linear triple, Rec.709. */
const lumaOf = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;

// ---------------------------------------------------------------------------
// Periodic gradient noise
// ---------------------------------------------------------------------------

const FADE = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function ihash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function gradDot(h, x, y) {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return x - y;
    case 2: return -x + y;
    case 3: return -x - y;
    case 4: return x * 1.4142136;
    case 5: return -x * 1.4142136;
    case 6: return y * 1.4142136;
    default: return -y * 1.4142136;
  }
}

/**
 * Perlin gradient noise whose lattice wraps at `px` by `py` cells, which is
 * what makes every texture in this file tile without a seam.
 */
function pnoise(x, y, px, py, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = FADE(xf);
  const v = FADE(yf);
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const n00 = gradDot(ihash(x0, y0, seed), xf, yf);
  const n10 = gradDot(ihash(x1, y0, seed), xf - 1, yf);
  const n01 = gradDot(ihash(x0, y1, seed), xf, yf - 1);
  const n11 = gradDot(ihash(x1, y1, seed), xf - 1, yf - 1);
  const a = n00 + u * (n10 - n00);
  const b = n01 + u * (n11 - n01);
  return a + v * (b - a);
}

const nextPow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

/**
 * Accumulates a low-resolution octave into a full-resolution field with a
 * smoothstep-weighted bilinear filter. Sampling the lattice at four samples per
 * cell and interpolating is indistinguishable from evaluating the noise at full
 * resolution, and costs a fraction of it.
 */
function addOctave(dst, size, src, sw, sh, amp) {
  const xi0 = new Int32Array(size);
  const xi1 = new Int32Array(size);
  const xw = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const fx = (x + 0.5) * (sw / size) - 0.5;
    const i = Math.floor(fx);
    const t = fx - i;
    xw[x] = t * t * (3 - 2 * t);
    xi0[x] = ((i % sw) + sw) % sw;
    xi1[x] = (xi0[x] + 1) % sw;
  }
  for (let y = 0; y < size; y++) {
    const fy = (y + 0.5) * (sh / size) - 0.5;
    const j = Math.floor(fy);
    const tv = fy - j;
    const wy = tv * tv * (3 - 2 * tv);
    const rowA = (((j % sh) + sh) % sh) * sw;
    const rowB = ((((j + 1) % sh) + sh) % sh) * sw;
    const o = y * size;
    for (let x = 0; x < size; x++) {
      const i0 = xi0[x];
      const i1 = xi1[x];
      const w = xw[x];
      const a = src[rowA + i0];
      const top = a + w * (src[rowA + i1] - a);
      const c = src[rowB + i0];
      const bot = c + w * (src[rowB + i1] - c);
      dst[o + x] += (top + wy * (bot - top)) * amp;
    }
  }
}

/**
 * Fractal Brownian motion over the periodic lattice.
 * @param {number} size output edge length
 * @param {{octaves?:number, freq?:number, gain?:number, seed?:number, ridged?:boolean, aspect?:number}} opts
 *   `aspect` stretches the lattice along Y (aspect > 1 = streaks running vertically).
 * @returns {Float32Array} roughly -1..1, or 0..1 when ridged
 */
function fbm(size, opts = {}) {
  const { octaves = 6, freq = 4, gain = 0.5, seed = 1, ridged = false, aspect = 1 } = opts;
  const out = new Float32Array(size * size);
  let fx = freq;
  let fy = Math.max(1, Math.round(freq / aspect));
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    // Below roughly four texels per lattice cell an octave costs a full
    // resolution noise evaluation and returns nothing but aliasing, since the
    // first mip level averages it away. Detail finer than this comes from the
    // rasterised scratch and rivet strokes instead, where it belongs.
    if (o > 0 && fx * 4 > size) break;
    const sw = Math.min(size, nextPow2(fx * 4));
    const sh = Math.min(size, nextPow2(fy * 4));
    const lat = new Float32Array(sw * sh);
    const s = seed + o * 7919;
    for (let y = 0; y < sh; y++) {
      const py = (y * fy) / sh;
      const row = y * sw;
      for (let x = 0; x < sw; x++) lat[row + x] = pnoise((x * fx) / sw, py, fx, fy, s);
    }
    if (ridged) {
      for (let i = 0; i < lat.length; i++) {
        const t = 1 - Math.abs(lat[i]) * 1.55;
        lat[i] = t > 0 ? t * t : 0;
      }
    }
    addOctave(out, size, lat, sw, sh, amp);
    norm += amp;
    amp *= gain;
    fx *= 2;
    fy *= 2;
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

/**
 * Periodic Worley/cellular noise. Returns F1 and F2 distances normalised into
 * roughly 0..1 plus a per-cell random id, which is what drives blotchy
 * oxidation, paint chips and cast-metal pitting.
 */
function worley(size, cells, seed) {
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const id = new Float32Array(cells * cells);
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = cy * cells + cx;
      const h = ihash(cx, cy, seed);
      px[i] = cx + ((h & 0xffff) / 65535) * 0.86 + 0.07;
      py[i] = cy + (((h >>> 16) & 0xffff) / 65535) * 0.86 + 0.07;
      id[i] = (ihash(cx, cy, seed + 977) & 0xffff) / 65535;
    }
  }
  const f1 = new Float32Array(size * size);
  const f2 = new Float32Array(size * size);
  const cid = new Float32Array(size * size);
  const scale = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = (y + 0.5) * scale;
    const cy = Math.floor(fy);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) * scale;
      const cx = Math.floor(fx);
      let d1 = 1e9;
      let d2 = 1e9;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        const wy = ((cy + oy) % cells + cells) % cells;
        const shiftY = cy + oy - wy;
        for (let ox = -1; ox <= 1; ox++) {
          const wx = ((cx + ox) % cells + cells) % cells;
          const shiftX = cx + ox - wx;
          const i = wy * cells + wx;
          const dx = px[i] + shiftX - fx;
          const dy = py[i] + shiftY - fy;
          const d = dx * dx + dy * dy;
          if (d < d1) { d2 = d1; d1 = d; best = id[i]; }
          else if (d < d2) d2 = d;
        }
      }
      const i = row + x;
      f1[i] = clamp01(Math.sqrt(d1));
      f2[i] = clamp01(Math.sqrt(d2));
      cid[i] = best;
    }
  }
  return { f1, f2, id: cid };
}

/**
 * Brushed-metal microstructure: very high frequency across U, coherent along V.
 * Generated at quarter height and stretched, because the field is by definition
 * smooth in that axis and nothing is lost.
 */
function brushField(size, seed, strands = 3) {
  const out = new Float32Array(size * size);
  const sh = Math.max(8, size >> 2);
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < strands; o++) {
    const fx = size >> o;
    const fy = Math.max(2, 6 >> o);
    const lat = new Float32Array(fx * sh);
    for (let y = 0; y < sh; y++) {
      const py = (y * fy) / sh;
      const row = y * fx;
      for (let x = 0; x < fx; x++) lat[row + x] = pnoise(x, py, fx, fy, seed + o * 613);
    }
    addOctave(out, size, lat, fx, sh, amp);
    norm += amp;
    amp *= 0.55;
  }
  const inv = 1 / norm;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  return out;
}

// ---------------------------------------------------------------------------
// Field operators
// ---------------------------------------------------------------------------

/** Separable box blur with wrap-around, running-sum. */
function boxBlurWrap(src, size, radius) {
  const w = radius * 2 + 1;
  const inv = 1 / w;
  const tmp = new Float32Array(size * size);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += src[row + (((k % size) + size) % size)];
    for (let x = 0; x < size; x++) {
      tmp[row + x] = sum * inv;
      sum += src[row + (((x + radius + 1) % size) + size) % size] - src[row + (((x - radius) % size) + size) % size];
    }
  }
  for (let x = 0; x < size; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[(((k % size) + size) % size) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = sum * inv;
      sum += tmp[((((y + radius + 1) % size) + size) % size) * size + x] - tmp[((((y - radius) % size) + size) % size) * size + x];
    }
  }
  return out;
}

/**
 * Cavity ambient occlusion from a height field: a pixel that sits below its own
 * neighbourhood average is occluded, evaluated at three radii so both panel
 * grooves and broad dishing read.
 */
function aoFromHeight(height, size, radii = [2, 7, 22], weights = [0.3, 0.4, 0.3], strength = 3.2) {
  const ao = new Float32Array(size * size).fill(1);
  for (let k = 0; k < radii.length; k++) {
    const r = Math.max(1, Math.min(radii[k], (size >> 1) - 1));
    const blur = boxBlurWrap(height, size, r);
    const w = weights[k] * strength;
    for (let i = 0; i < ao.length; i++) {
      const d = blur[i] - height[i];
      if (d > 0) ao[i] -= d * w;
    }
  }
  for (let i = 0; i < ao.length; i++) ao[i] = clamp01(ao[i]);
  return ao;
}

/** Sobel-free central-difference normal encode; wraps, so tiling stays seamless. */
function encodeNormal(height, size, scale) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const yp = ((y + 1) % size) * size;
    const yn = ((y - 1 + size) % size) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const xp = (x + 1) % size;
      const xn = (x - 1 + size) % size;
      const dx = (height[row + xp] - height[row + xn]) * scale;
      const dy = (height[yp + x] - height[yn + x]) * scale;
      // Tangent space, OpenGL convention: G points along +V.
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const o = (row + x) * 4;
      px[o] = (nx * 0.5 + 0.5) * 255;
      px[o + 1] = (ny * 0.5 + 0.5) * 255;
      px[o + 2] = (nz * 0.5 + 0.5) * 255;
      px[o + 3] = 255;
    }
  }
  return px;
}

/**
 * "Which way is up" in tangent space, from the height gradient along V. Dust
 * settles on the faces this returns high values for, exactly as it does in a
 * baked production texture.
 */
function upFacingFromHeight(height, size, scale) {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const yp = ((y + 1) % size) * size;
    const yn = ((y - 1 + size) % size) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const dy = (height[yp + x] - height[yn + x]) * scale;
      out[row + x] = smoothstep(-0.15, 0.9, -dy);
    }
  }
  return out;
}

/**
 * Box-filtered RGBA downsample by an integer factor. Detail is authored at the
 * set's native resolution so every channel agrees texel-for-texel, then each
 * map is stored at the resolution its content actually needs — an occlusion or
 * clearcoat mask carries no high frequencies worth four megabytes.
 */
function downsampleRGBA(px, size, div) {
  if (div <= 1) return { px, size };
  const t = (size / div) | 0;
  const out = new Uint8Array(t * t * 4);
  const inv = 1 / (div * div);
  for (let y = 0; y < t; y++) {
    for (let x = 0; x < t; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < div; j++) {
        const row = (y * div + j) * size * 4;
        for (let i = 0; i < div; i++) {
          const o = row + (x * div + i) * 4;
          r += px[o]; g += px[o + 1]; b += px[o + 2]; a += px[o + 3];
        }
      }
      const o = (y * t + x) * 4;
      out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = b * inv; out[o + 3] = a * inv;
    }
  }
  return { px: out, size: t };
}

/** Additive radial stamp with max-blending and wrap; the primitive behind scratches, rivets and drips. */
function stamp(dst, size, cx, cy, r, v) {
  if (r <= 0 || v <= 0) return;
  const r2 = r * r;
  const x0 = Math.floor(cx - r);
  const x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r);
  const y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const yy = ((y % size) + size) % size;
    const row = yy * size;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const f = 1 - d2 / r2;
      const i = row + ((x % size) + size) % size;
      const val = v * f * f;
      if (val > dst[i]) dst[i] = val;
    }
  }
}

/**
 * Wandering scratch lines. Real rasterised strokes rather than thresholded
 * noise — noise scratches always read as clouds, strokes read as damage.
 */
function drawScratches(dst, size, rng, opts) {
  const { count, minLen, maxLen, width, strength, curl = 0.16, taper = true } = opts;
  for (let i = 0; i < count; i++) {
    let x = rng.next() * size;
    let y = rng.next() * size;
    let a = rng.next() * Math.PI * 2;
    const len = Math.max(3, minLen + rng.next() * (maxLen - minLen));
    const w = width * (0.55 + rng.next() * 0.9);
    const amp = strength * (0.35 + rng.next() * 0.65);
    const steps = Math.ceil(len);
    for (let s = 0; s < steps; s++) {
      a += (rng.next() - 0.5) * curl;
      x += Math.cos(a);
      y += Math.sin(a);
      const t = s / steps;
      const fade = taper ? Math.sin(Math.PI * t) * 0.65 + 0.35 : 1;
      stamp(dst, size, x, y, w, amp * fade);
    }
  }
}

/**
 * Oil and coolant streaks running with gravity. V is treated as "up" on the
 * model, so streaks travel toward decreasing V and thin out as they go.
 */
function drawDrips(dst, size, rng, opts) {
  const { count, maxLen, width, strength } = opts;
  for (let i = 0; i < count; i++) {
    let x = rng.next() * size;
    let y = rng.next() * size;
    const len = Math.max(8, 16 + rng.next() * maxLen);
    const w = width * (0.4 + rng.next() * 1.3);
    const amp = strength * (0.3 + rng.next() * 0.7);
    let drift = 0;
    // A fat pooled head where the fluid started, then a thinning tail.
    stamp(dst, size, x, y, w * 2.1, amp);
    for (let s = 0; s < len; s++) {
      drift += (rng.next() - 0.5) * 0.14;
      drift *= 0.94;
      x += drift * 0.3;
      y -= 1;
      const t = s / len;
      stamp(dst, size, x, y, w * (1 - 0.55 * t), amp * Math.pow(1 - t, 1.35));
    }
  }
}

// ---------------------------------------------------------------------------
// Hard-surface panel layout
// ---------------------------------------------------------------------------

/** Paint assignment for a plate. Encoded into one channel as (paint + variation) / 3. */
const PAINT_PRIMARY = 0;
const PAINT_SECONDARY = 1;
const PAINT_ACCENT = 2;

/**
 * Binary-splits the unit square into armour plates and gives each one a role.
 *
 * The outer border is always a groove, which is what lets the resulting map
 * tile: a plate edge meets a plate edge across the seam.
 *
 * Roles are driven by plate *area*, not by a bare random number, because that
 * is how hard-surface design actually works — accent paint and louvred vents
 * live on small inset panels, while the big structural plates carry the body
 * colour. Rolling for them uniformly produces a chequerboard of enormous
 * orange panels, which reads as a test texture rather than a designed machine.
 */
function buildPanelLayout(rng, { minCell = 0.055, depth = 7, stopChance = 0.09 } = {}) {
  const rects = [];

  const emit = (x0, y0, x1, y1) => {
    const area = (x1 - x0) * (y1 - y0);
    const h = rng.next();
    const variation = rng.next();
    const z = rng.next();
    const small = area < 0.016;
    const tiny = area < 0.0075;
    rects.push({
      x0, y0, x1, y1, area,
      paint: small && h > 0.86 ? PAINT_ACCENT : h < 0.3 ? PAINT_SECONDARY : PAINT_PRIMARY,
      variation,
      z,
      vent: small && !tiny && variation > 0.72,
      rivets: z < 0.5 && !tiny,
      bead: z > 0.88,
      glow: small && variation < 0.14,
    });
  };

  const split = (x0, y0, x1, y1, d) => {
    const w = x1 - x0;
    const h = y1 - y0;
    if (d <= 0 || (w < minCell * 2 && h < minCell * 2) || rng.next() < stopChance) { emit(x0, y0, x1, y1); return; }
    const vertical = w > h * 1.15 ? true : h > w * 1.15 ? false : rng.next() < 0.5;
    const t = 0.3 + rng.next() * 0.4;
    if (vertical) {
      const xm = x0 + w * t;
      if (xm - x0 < minCell || x1 - xm < minCell) { emit(x0, y0, x1, y1); return; }
      split(x0, y0, xm, y1, d - 1);
      split(xm, y0, x1, y1, d - 1);
    } else {
      const ym = y0 + h * t;
      if (ym - y0 < minCell || y1 - ym < minCell) { emit(x0, y0, x1, y1); return; }
      split(x0, y0, x1, ym, d - 1);
      split(x0, ym, x1, y1, d - 1);
    }
  };
  split(0, 0, 1, 1, depth);
  return rects;
}

// ---------------------------------------------------------------------------
// Detail sets
// ---------------------------------------------------------------------------

/**
 * Brushed metal has no macro layout to give away a repeat, so it is authored at
 * half the plate resolution and tiled twice. Every map in the metal set shares
 * this factor, which is what keeps the scratch in the normal map lined up with
 * the same scratch in roughness.
 */
const METAL_REPEAT = 2;

const DETAIL_CACHE = new Map();
const SHARED_TEXTURES = new Set();

function cachedDetail(key, build) {
  let d = DETAIL_CACHE.get(key);
  if (!d) { d = build(); DETAIL_CACHE.set(key, d); }
  return d;
}

/**
 * The painted armour plate set. Everything a Tekken-grade robot plate needs:
 * panelling, rivets, vents, weld beads, layered edge wear, hero and micro
 * scratches, cavity grime, gravity streaks and settled dust.
 *
 * Retains its albedo inputs quantised to two RGBA byte arrays rather than a
 * dozen Float32Arrays, which keeps the permanent cache at ~8MB instead of ~40.
 */
function buildPlateDetail(size) {
  const rng = new Rng(0x5eed01);
  const n = size * size;
  const gw = Math.max(2, size * 0.0036); // groove half-width in texels

  const panelId = new Float32Array(n);
  const groove = new Float32Array(n);
  const bevel = new Float32Array(n);
  const plateStep = new Float32Array(n);
  // 1 = ordinary plate face, falling to 0 in the depth of a louvre. Defaulting
  // to 1 matters: this drives the cavity darkening in the albedo, and a default
  // of 0 quietly dims every plate in the library.
  const vent = new Float32Array(n).fill(1);
  const glow = new Float32Array(n);
  const rivet = new Float32Array(n);
  const bead = new Float32Array(n);

  const rects = buildPanelLayout(rng);

  for (const r of rects) {
    const px0 = r.x0 * size;
    const px1 = r.x1 * size;
    const py0 = r.y0 * size;
    const py1 = r.y1 * size;
    const ix0 = Math.max(0, Math.floor(px0));
    const ix1 = Math.min(size, Math.ceil(px1));
    const iy0 = Math.max(0, Math.floor(py0));
    const iy1 = Math.min(size, Math.ceil(py1));
    const step = (r.z - 0.5) * 0.2;
    const id = (r.paint + r.variation * 0.92) / 3;
    const slat = Math.max(4, size * 0.013);

    for (let y = iy0; y < iy1; y++) {
      const fy = y + 0.5;
      const dy = Math.min(fy - py0, py1 - fy);
      const row = y * size;
      for (let x = ix0; x < ix1; x++) {
        const fx = x + 0.5;
        const dx = Math.min(fx - px0, px1 - fx);
        const d = Math.min(dx, dy);
        const i = row + x;
        panelId[i] = id;
        const g = 1 - smoothstep(gw * 0.55, gw * 1.5, d);
        groove[i] = g;
        const b = smoothstep(gw * 0.7, gw * 3.6, d);
        bevel[i] = b;
        plateStep[i] = step * b - g * 0.85;
        if (r.vent && d > gw * 2.6) {
          // Louvred vent: horizontal slats, each with a shadowed leading lip.
          const t = (fy % slat) / slat;
          const open = smoothstep(0.1, 0.34, t) * (1 - smoothstep(0.7, 0.92, t));
          vent[i] = open;
          plateStep[i] -= (1 - open) * 0.4;
          glow[i] = Math.max(glow[i], (1 - open) * 0.75);
        } else if (r.glow) {
          // Inset light strip: the groove around the plate carries the emission.
          glow[i] = Math.max(glow[i], g);
        }
      }
    }

    // Rivets march along the border of roughly half the plates.
    if (r.rivets && !r.vent) {
      const inset = gw * 2.6;
      const rr = Math.max(1.6, size * 0.0042);
      const spacing = Math.max(rr * 5.5, size * 0.035);
      const bx0 = px0 + inset;
      const bx1 = px1 - inset;
      const by0 = py0 + inset;
      const by1 = py1 - inset;
      if (bx1 > bx0 && by1 > by0) {
        const nx = Math.max(1, Math.round((bx1 - bx0) / spacing));
        const ny = Math.max(1, Math.round((by1 - by0) / spacing));
        for (let k = 0; k <= nx; k++) {
          const x = bx0 + ((bx1 - bx0) * k) / nx;
          stamp(rivet, size, x, by0, rr, 1);
          stamp(rivet, size, x, by1, rr, 1);
        }
        for (let k = 1; k < ny; k++) {
          const y = by0 + ((by1 - by0) * k) / ny;
          stamp(rivet, size, bx0, y, rr, 1);
          stamp(rivet, size, bx1, y, rr, 1);
        }
      }
    }

    // A wandering weld bead down one edge of the occasional plate.
    if (r.bead) {
      const horiz = r.variation < 0.5;
      const bw = Math.max(1.4, size * 0.0035);
      const steps = Math.ceil((horiz ? px1 - px0 : py1 - py0) - gw * 4);
      let x = horiz ? px0 + gw * 2 : lerp(px0, px1, 0.5);
      let y = horiz ? lerp(py0, py1, 0.5) : py0 + gw * 2;
      for (let s = 0; s < steps; s++) {
        if (horiz) { x += 1; y += (rng.next() - 0.5) * 0.5; } else { y += 1; x += (rng.next() - 0.5) * 0.5; }
        stamp(bead, size, x, y, bw * (0.85 + 0.35 * Math.sin(s * 0.9)), 1);
      }
    }
  }

  // --- surface tooth, casting texture, macro dishing --------------------
  const tooth = fbm(size, { octaves: 3, freq: 64, gain: 0.55, seed: 11 });
  const casting = fbm(size, { octaves: 4, freq: 12, gain: 0.5, seed: 23 });
  const macro = fbm(size, { octaves: 3, freq: 4, gain: 0.5, seed: 37 });
  const blotch = worley(size, Math.max(8, size >> 5), 53);
  const rust = fbm(size, { octaves: 3, freq: 20, gain: 0.55, seed: 71, ridged: true });

  // --- damage strokes ---------------------------------------------------
  const microScratch = new Float32Array(n);
  drawScratches(microScratch, size, rng, {
    count: Math.round(size * 2.6), minLen: size * 0.008, maxLen: size * 0.06,
    width: Math.max(0.75, size / 1100), strength: 0.42, curl: 0.42,
  });
  const heroScratch = new Float32Array(n);
  drawScratches(heroScratch, size, rng, {
    count: 9, minLen: size * 0.14, maxLen: size * 0.45,
    width: Math.max(1.1, size / 620), strength: 0.8, curl: 0.09,
  });

  const drips = new Float32Array(n);
  drawDrips(drips, size, rng, {
    count: Math.round(size * 0.045), maxLen: size * 0.34,
    width: Math.max(1.8, size / 300), strength: 0.85,
  });

  // --- height ------------------------------------------------------------
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rv = rivet[i];
    const rivetH = rv > 0 ? Math.sqrt(rv) * 0.55 : 0;
    const beadH = bead[i] > 0 ? Math.sqrt(bead[i]) * 0.32 : 0;
    height[i] =
      plateStep[i] +
      rivetH +
      beadH +
      macro[i] * 0.05 +
      casting[i] * 0.022 +
      tooth[i] * 0.008 -
      microScratch[i] * 0.035 -
      heroScratch[i] * 0.085;
  }

  const ao = aoFromHeight(height, size, [2, 7, 24], [0.28, 0.4, 0.32], 3.4);
  const up = upFacingFromHeight(height, size, 26);
  const normalPx = encodeNormal(height, size, 5.4);

  // --- edge / curvature mask --------------------------------------------
  // Convexity: the pixel stands proud of its neighbourhood. Paint is thin on
  // convex edges and rivet crowns, so that is where it fails first.
  const soft = boxBlurWrap(height, size, Math.max(2, size >> 8));
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const convex = (height[i] - soft[i]) * 9;
    edge[i] = clamp01(clamp01(convex) * 0.8 + clamp01(rivet[i]) * 0.55 + smoothstep(0.16, 0.01, bevel[i]) * 0.85);
  }

  // --- chipped paint -----------------------------------------------------
  // Two multiplied terms, which is what stops this reading as airbrushed dirt.
  // The Worley cells decide the jagged *outline* of each flake; the curvature
  // mask decides whether a flake is allowed to exist there at all. Paint only
  // fails where it is thin — proud corners, rivet crowns, plate lips — so the
  // damage tracks the form instead of floating on top of it. A hairline rim of
  // bare metal right on the outermost lip is added on top, because that thin
  // bright edge is most of what sells worn paint at gameplay distance.
  const chip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const flake = 1 - smoothstep(0.04, 0.26, blotch.f1[i]);
    const jag = flake * (0.82 + casting[i] * 0.3 + tooth[i] * 0.16);
    const gate = smoothstep(0.34, 0.86, edge[i] + (blotch.id[i] - 0.6) * 0.22);
    // The hairline of bare metal sits on the plate *lip* — just outside the
    // groove, not inside it, where it would be buried in shadow and invisible.
    const rim = smoothstep(0.05, 0.26, bevel[i]) * (1 - smoothstep(0.36, 0.66, bevel[i]));
    chip[i] = clamp01(Math.max(smoothstep(0.4, 0.82, jag) * gate, rim * (0.72 + casting[i] * 0.45)));
  }

  const scratch = new Float32Array(n);
  for (let i = 0; i < n; i++) scratch[i] = clamp01(microScratch[i] * 0.85 + heroScratch[i]);

  // --- grime, dust -------------------------------------------------------
  const grime = new Float32Array(n);
  const dust = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cavity = clamp01((1 - ao[i]) * 1.5);
    const blot = clamp01(rust[i] * 1.2 - 0.15);
    grime[i] = clamp01(cavity * 0.6 + groove[i] * 0.42 + drips[i] * 0.9 + blot * 0.2 * (0.4 + cavity));
    dust[i] = clamp01(up[i] * 1.9 * (0.5 + casting[i] * 0.5) * ao[i]);
  }

  // --- packed byte masks retained for per-character albedo ---------------
  const maskA = new Uint8Array(n * 4); // chip, scratch, grime, dust
  const maskB = new Uint8Array(n * 4); // panelId, cavity, ao, mottle
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    maskA[o] = chip[i] * 255;
    maskA[o + 1] = scratch[i] * 255;
    maskA[o + 2] = grime[i] * 255;
    maskA[o + 3] = dust[i] * 255;
    maskB[o] = panelId[i] * 255;
    // Groove and louvre depth only ever act together as one cavity term, so
    // they are combined here and the freed channel carries the casting mottle
    // that stops each plate reading as a flat field of paint.
    maskB[o + 1] = clamp01(groove[i] * 0.85 + (1 - vent[i]) * 0.75) * 255;
    maskB[o + 2] = ao[i] * 255;
    maskB[o + 3] = clamp01(0.5 + casting[i] * 0.42 + macro[i] * 0.3) * 255;
  }

  // --- ORM, painted -----------------------------------------------------
  // Paint: dielectric, satin. Chip: bare cast steel, metal, slightly rougher.
  // Scratch: freshly cut steel, metal, polished. Grime: kills both.
  const ormPainted = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = chip[i];
    const s = scratch[i];
    const g = grime[i];
    const d = dust[i];
    let rough = lerp(0.38 + casting[i] * 0.05 + tooth[i] * 0.03, 0.46, c);
    rough = lerp(rough, 0.16, s * 0.8);
    rough = lerp(rough, 0.82, g * 0.75);
    rough = lerp(rough, 0.9, d * 0.45);
    let metal = clamp01(c * 0.95 + s * 0.85);
    metal *= 1 - g * 0.4;
    const o = i * 4;
    ormPainted[o] = clamp01(ao[i] * (1 - g * 0.25)) * 255;
    ormPainted[o + 1] = clamp01(rough) * 255;
    ormPainted[o + 2] = clamp01(metal) * 255;
    ormPainted[o + 3] = 255; // sheen roughness, unused by paint
  }

  // --- ORM, bare/worn ---------------------------------------------------
  const ormWorn = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = scratch[i];
    const g = grime[i];
    let rough = 0.33 + casting[i] * 0.09 + tooth[i] * 0.05 + (1 - chip[i]) * 0.06;
    rough = lerp(rough, 0.13, s * 0.85);
    rough = lerp(rough, 0.86, g * 0.8);
    const o = i * 4;
    ormWorn[o] = ao[i] * 255;
    ormWorn[o + 1] = clamp01(rough) * 255;
    ormWorn[o + 2] = clamp01(1 - g * 0.75) * 255;
    ormWorn[o + 3] = 255;
  }

  // --- clearcoat: lacquer survives only where the paint does -------------
  const ccPx = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const strength = clamp01((1 - chip[i]) * (1 - scratch[i] * 0.9) * (1 - grime[i] * 0.85));
    const ccRough = clamp01(0.05 + grime[i] * 0.5 + scratch[i] * 0.3 + dust[i] * 0.25 + casting[i] * 0.03);
    const o = i * 4;
    ccPx[o] = strength * 255;
    ccPx[o + 1] = ccRough * 255;
    ccPx[o + 2] = 0;
    ccPx[o + 3] = 255;
  }

  // --- emissive: light strips in selected grooves and every vent slat ----
  const emPx = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = clamp01(glow[i] * (1 - grime[i] * 0.7) * (1 - chip[i] * 0.5));
    const o = i * 4;
    emPx[o] = emPx[o + 1] = emPx[o + 2] = encodeSrgb(v * v);
    emPx[o + 3] = 255;
  }

  return { size, maskA, maskB, normalPx, ormPainted, ormWorn, ccPx, emPx };
}

/**
 * Machined / brushed metal. Used by the dark structural frame, the hydraulic
 * pistons and the polished accent chrome, each at a different tiling and
 * roughness bias, which is how a real production shares one detail bake.
 */
function buildMetalDetail(size) {
  const rng = new Rng(0x5eed02);
  const n = size * size;

  const brush = brushField(size, 191, 3);
  const grain = fbm(size, { octaves: 4, freq: 24, gain: 0.55, seed: 83, aspect: 6 });
  const pits = worley(size, Math.max(8, size >> 4), 137);
  const tooth = fbm(size, { octaves: 2, freq: 96, gain: 0.5, seed: 97 });
  const macro = fbm(size, { octaves: 3, freq: 6, gain: 0.5, seed: 113 });

  const scratch = new Float32Array(n);
  drawScratches(scratch, size, rng, {
    count: Math.round(size * 0.35), minLen: size * 0.04, maxLen: size * 0.3,
    width: Math.max(0.7, size / 1200), strength: 0.7, curl: 0.05,
  });

  const grimeF = new Float32Array(n);
  drawDrips(grimeF, size, rng, {
    count: Math.round(size * 0.035), maxLen: size * 0.35,
    width: Math.max(1.0, size / 700), strength: 1.0,
  });

  const pit = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pit[i] = clamp01(smoothstep(0.34, 0.06, pits.f1[i]) * smoothstep(0.42, 0.6, pits.id[i]));
  }

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] =
      macro[i] * 0.06 +
      brush[i] * 0.05 +
      grain[i] * 0.02 +
      tooth[i] * 0.006 -
      pit[i] * 0.09 -
      scratch[i] * 0.05;
  }

  const ao = aoFromHeight(height, size, [2, 6, 18], [0.3, 0.4, 0.3], 3.0);
  const normalPx = encodeNormal(height, size, 6.2);

  for (let i = 0; i < n; i++) {
    const cavity = clamp01((1 - ao[i]) * 1.4);
    grimeF[i] = clamp01(grimeF[i] * 0.85 + cavity * 0.5 + pit[i] * 0.4);
  }

  const orm = new Uint8Array(n * 4);
  const anPx = new Uint8Array(n * 4);
  // Albedo here is a pure reflectance *modulation*, not a colour: for a metal
  // the albedo is F0, so the alloy lives in `material.color` and this map only
  // says how the brush, the cut scratches and the soot vary it. One map then
  // serves gunmetal, honed steel and chrome for every character in the roster.
  const modPx = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const b = brush[i] * 0.5 + 0.5;
    const g = grimeF[i];
    let rough = 0.22 + b * 0.16 + grain[i] * 0.05 + tooth[i] * 0.03;
    rough = lerp(rough, 0.1, scratch[i] * 0.8);
    rough = lerp(rough, 0.55, pit[i]);
    rough = lerp(rough, 0.78, g * 0.75);
    const o = i * 4;
    orm[o] = ao[i] * 255;
    orm[o + 1] = clamp01(rough) * 255;
    orm[o + 2] = clamp01(1 - g * 0.55 - pit[i] * 0.2) * 255;
    orm[o + 3] = 255;

    let v = 0.82 + (b - 0.5) * 0.3;
    v = lerp(v, 1.0, scratch[i] * 0.7);
    v = lerp(v, 0.1, clamp01(g * 0.85 + pit[i] * 0.6));
    v *= 0.55 + ao[i] * 0.45;
    const d = dither(i + 3301);
    modPx[o] = modPx[o + 1] = modPx[o + 2] = encodeSrgb(v + d);
    modPx[o + 3] = 255;

    // Anisotropy: the brush runs along U, so the tangent direction is close to
    // (1,0); a slight per-region rotation keeps the highlight from looking
    // printed on, and the strength collapses wherever pitting or soot has
    // destroyed the microstructure.
    const ang = grain[i] * 0.22;
    anPx[o] = (Math.cos(ang) * 0.5 + 0.5) * 255;
    anPx[o + 1] = (Math.sin(ang) * 0.5 + 0.5) * 255;
    anPx[o + 2] = clamp01(0.85 - g * 0.7 - pit[i] * 0.5) * 255;
    anPx[o + 3] = 255;
  }

  return { size, normalPx, orm, anPx, modPx };
}

/**
 * Rubber, cable sheathing and hydraulic boots: pebbled elastomer with moulding
 * ribs, a matte dielectric response and a fabric-like sheen that catches the
 * rim light. Sheen roughness rides in the ORM alpha, which is the channel
 * three's `sheenRoughnessMap` samples.
 */
function buildSoftDetail(size) {
  const rng = new Rng(0x5eed03);
  const n = size * size;

  const pebble = worley(size, Math.max(16, size >> 3), 211);
  const fine = fbm(size, { octaves: 3, freq: 64, gain: 0.5, seed: 227 });
  const macro = fbm(size, { octaves: 3, freq: 7, gain: 0.55, seed: 233 });
  const ribFreq = Math.max(8, size >> 5);

  const scuff = new Float32Array(n);
  drawScratches(scuff, size, rng, {
    count: Math.round(size * 0.25), minLen: size * 0.03, maxLen: size * 0.18,
    width: Math.max(1.0, size / 500), strength: 0.6, curl: 0.3,
  });

  const height = new Float32Array(n);
  const rib = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const t = (y / size) * ribFreq;
    const r = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const i = row + x;
      rib[i] = r;
      const bump = smoothstep(0.0, 0.5, pebble.f1[i]);
      height[i] = r * 0.09 + bump * 0.06 + fine[i] * 0.012 + macro[i] * 0.03 - scuff[i] * 0.02;
    }
  }

  const ao = aoFromHeight(height, size, [2, 6, 16], [0.3, 0.4, 0.3], 2.6);
  const normalPx = encodeNormal(height, size, 5.0);

  const orm = new Uint8Array(n * 4);
  const modPx = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const rough = clamp01(0.78 + fine[i] * 0.07 - scuff[i] * 0.16 - rib[i] * 0.05);
    const o = i * 4;
    orm[o] = ao[i] * 255;
    orm[o + 1] = rough * 255;
    orm[o + 2] = 0;
    // Sheen roughness rides in alpha, the channel three's sheenRoughnessMap reads.
    orm[o + 3] = clamp01(0.42 + fine[i] * 0.16 + (1 - ao[i]) * 0.2) * 255;

    const pebbleV = smoothstep(0.05, 0.55, pebble.f1[i]);
    const v = clamp01((0.72 + pebbleV * 0.28) * (0.55 + ao[i] * 0.45) + rib[i] * 0.08 + scuff[i] * 0.5);
    modPx[o] = modPx[o + 1] = modPx[o + 2] = encodeSrgb(v + dither(i + 104729));
    modPx[o + 3] = 255;
  }

  return { size, normalPx, orm, modPx };
}

/**
 * 2x2 twill carbon fibre. The tows alternate over/under on a four-cell cycle,
 * each tow carries fibre striations along its own axis, and the anisotropy map
 * rotates ninety degrees between warp and weft — which is precisely the effect
 * that makes real carbon shimmer as the camera moves.
 */
function buildCarbonDetail(size) {
  const n = size * size;
  const tows = Math.max(8, size >> 5);
  const fine = fbm(size, { octaves: 3, freq: 64, gain: 0.5, seed: 307 });
  const macro = fbm(size, { octaves: 3, freq: 5, gain: 0.5, seed: 311 });
  // Striation wavelength must divide the texture exactly or the weave shows a
  // seam where the map tiles; pick the nearest whole number of cycles.
  const striCycles = Math.round(size / 3.3);
  const striK = (Math.PI * 2 * striCycles) / size;

  const height = new Float32Array(n);
  const warpTop = new Uint8Array(n);
  const fibre = new Float32Array(n);
  const cell = new Float32Array(n);

  for (let y = 0; y < size; y++) {
    const fy = ((y + 0.5) * tows) / size;
    const j = Math.floor(fy);
    const ty = fy - j;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const fx = ((x + 0.5) * tows) / size;
      const i = Math.floor(fx);
      const tx = fx - i;
      const over = (((i - j) % 4) + 4) % 4 < 2;
      const idx = row + x;
      warpTop[idx] = over ? 1 : 0;
      // Rounded tow cross-section; the top tow sits proud of the one beneath.
      const acrossTop = Math.sin(Math.PI * (over ? tx : ty));
      const acrossBot = Math.sin(Math.PI * (over ? ty : tx));
      const h = acrossTop * 0.09 + acrossBot * 0.018;
      // Fibre striations run along the tow, phase-hashed per tow so adjacent
      // tows do not line up into a false grid.
      const along = over ? y : x;
      const seedRow = over ? i : j;
      const phase = (ihash(seedRow, over ? 1 : 2, 401) & 1023) * (Math.PI / 512);
      const stri = Math.sin(along * striK + phase) * 0.5 + 0.5;
      fibre[idx] = stri;
      cell[idx] = acrossTop;
      height[idx] = h + stri * 0.006 + fine[idx] * 0.004 + macro[idx] * 0.02;
    }
  }

  const ao = aoFromHeight(height, size, [2, 5, 14], [0.3, 0.4, 0.3], 3.0);
  const normalPx = encodeNormal(height, size, 5.6);

  const albedoPx = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const anPx = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const base = 0.014 + cell[i] * 0.02 + fibre[i] * 0.012;
    const v = base * (0.35 + ao[i] * 0.65);
    const o = i * 4;
    // A faint blue-black, as woven carbon reads under a lacquer coat.
    albedoPx[o] = encodeSrgb(v * 0.92);
    albedoPx[o + 1] = encodeSrgb(v * 0.97);
    albedoPx[o + 2] = encodeSrgb(v * 1.12);
    albedoPx[o + 3] = 255;
    orm[o] = ao[i] * 255;
    orm[o + 1] = clamp01(0.26 + (1 - cell[i]) * 0.16 + fine[i] * 0.04) * 255;
    orm[o + 2] = clamp01(0.12 + fibre[i] * 0.12) * 255;
    orm[o + 3] = 255;
    const ang = warpTop[i] ? Math.PI * 0.5 : 0;
    anPx[o] = (Math.cos(ang) * 0.5 + 0.5) * 255;
    anPx[o + 1] = (Math.sin(ang) * 0.5 + 0.5) * 255;
    anPx[o + 2] = clamp01(0.7 + cell[i] * 0.3) * 255;
    anPx[o + 3] = 255;
  }

  return { size, albedoPx, normalPx, orm, anPx };
}

/**
 * Orange peel: the shallow, long-wavelength ripple every sprayed lacquer has.
 * It is the single cheapest thing that stops a clearcoat reading as glass.
 */
function buildOrangePeel(size) {
  const a = fbm(size, { octaves: 3, freq: 8, gain: 0.5, seed: 419 });
  const b = fbm(size, { octaves: 2, freq: 26, gain: 0.5, seed: 421 });
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.7 + b[i] * 0.3;
  return { size, normalPx: encodeNormal(h, size, 0.55) };
}

/** Smudges and micro-dust on a glass visor: subtle, but it kills the CG look. */
function buildGlassDetail(size) {
  const rng = new Rng(0x5eed05);
  const n = size * size;
  const smudge = fbm(size, { octaves: 4, freq: 14, gain: 0.55, seed: 509 });
  const specks = worley(size, Math.max(24, size >> 3), 521);
  const wipe = new Float32Array(n);
  drawScratches(wipe, size, rng, {
    count: Math.round(size * 0.2), minLen: size * 0.05, maxLen: size * 0.4,
    width: Math.max(0.7, size / 900), strength: 0.5, curl: 0.03,
  });

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] = smudge[i] * 0.006 - wipe[i] * 0.01 - smoothstep(0.22, 0.02, specks.f1[i]) * 0.012;
  }
  const normalPx = encodeNormal(height, size, 3.0);

  const orm = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const speck = smoothstep(0.22, 0.03, specks.f1[i]);
    const rough = clamp01(0.03 + clamp01(smudge[i] * 0.6 + 0.15) * 0.14 + wipe[i] * 0.2 + speck * 0.35);
    const o = i * 4;
    orm[o] = 255;
    orm[o + 1] = rough * 255;
    orm[o + 2] = 0;
    orm[o + 3] = 255;
  }
  return { size, normalPx, orm };
}

// ---------------------------------------------------------------------------
// Texture construction
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} px
 * @param {number} size
 * @param {{srgb?:boolean, maxAniso?:number, repeat?:number}} opts
 * @returns {THREE.DataTexture}
 */
function makeTexture(px, size, opts = {}) {
  const { srgb = false, maxAniso = 8, repeat = 1 } = opts;
  const tex = new THREE.DataTexture(px, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAniso;
  if (repeat !== 1) tex.repeat.set(repeat, repeat);
  tex.needsUpdate = true;
  return tex;
}

function markShared(tex) {
  tex.userData.shared = true;
  SHARED_TEXTURES.add(tex);
  return tex;
}

/** Deterministic +-0.5/255 dither, kills banding in the dark end of the albedo. */
function dither(i) {
  return ((ihash(i & 1023, i >>> 10, 7727) & 255) / 255 - 0.5) * 0.0016;
}

// ---------------------------------------------------------------------------
// Per-character albedo composition
// ---------------------------------------------------------------------------

const BARE_STEEL = [0.145, 0.150, 0.160];   // cast/forged steel under the paint
const CUT_STEEL = [0.36, 0.365, 0.375];     // freshly exposed metal in a scratch
const GRIME = [0.016, 0.013, 0.010];        // oil and carbon soot
const DUST = [0.20, 0.19, 0.175];           // settled pale grit

/**
 * Recolours the cached plate detail for one character. Works entirely in linear
 * light: the paint is picked per plate from the palette, the panel line darkens
 * it, chips replace it with bare steel, scratches cut bright metal, grime
 * multiplies down into the cavities and dust lifts the upward faces.
 */
function composePlateAlbedo(detail, colors, wear, wearFloor = 0) {
  const { size, maskA, maskB } = detail;
  const n = size * size;
  const px = new Uint8Array(n * 4);
  const [a, b, c] = colors;
  const tmp = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const chip = maskA[o] / 255;
    const scr = maskA[o + 1] / 255;
    const grm = maskA[o + 2] / 255;
    const dst = maskA[o + 3] / 255;
    const pid = maskB[o] / 255;
    const cav = maskB[o + 1] / 255;
    const ao = maskB[o + 2] / 255;
    const mottle = maskB[o + 3] / 255;

    // Per-plate paint role, unpacked from (paint + variation) / 3, plus a small
    // value break so no two adjacent plates read as the same sprayed batch.
    const t3 = pid * 3;
    const role = t3 < 1 ? 0 : t3 < 2 ? 1 : 2;
    const src = role === 0 ? a : role === 1 ? b : c;
    const tone = (0.87 + (t3 - role) * 0.28) * (0.82 + mottle * 0.36);
    tmp[0] = src[0] * tone;
    tmp[1] = src[1] * tone;
    tmp[2] = src[2] * tone;

    // Panel lines and louvre depth: darkened paint, not black lines.
    tmp[0] *= 1 - cav * 0.5;
    tmp[1] *= 1 - cav * 0.5;
    tmp[2] *= 1 - cav * 0.5;

    // Layered edge wear: paint -> primer-thin -> bare steel.
    const w = clamp01(chip * wear + wearFloor * (0.55 + grm * 0.45));
    const primer = smoothstep(0.15, 0.6, w) * (1 - smoothstep(0.6, 0.95, w));
    tmp[0] = lerp(tmp[0], BARE_STEEL[0], w);
    tmp[1] = lerp(tmp[1], BARE_STEEL[1], w);
    tmp[2] = lerp(tmp[2], BARE_STEEL[2], w);
    // A thin ring of dulled undercoat where the paint feathers out.
    tmp[0] = lerp(tmp[0], tmp[0] * 0.55 + 0.02, primer * 0.7);
    tmp[1] = lerp(tmp[1], tmp[1] * 0.55 + 0.018, primer * 0.7);
    tmp[2] = lerp(tmp[2], tmp[2] * 0.55 + 0.016, primer * 0.7);

    const s = clamp01(scr * (0.34 + wear * 0.34));
    tmp[0] = lerp(tmp[0], CUT_STEEL[0], s);
    tmp[1] = lerp(tmp[1], CUT_STEEL[1], s);
    tmp[2] = lerp(tmp[2], CUT_STEEL[2], s);

    const g = clamp01(grm * 0.9);
    tmp[0] = lerp(tmp[0], tmp[0] * 0.25 + GRIME[0], g);
    tmp[1] = lerp(tmp[1], tmp[1] * 0.25 + GRIME[1], g);
    tmp[2] = lerp(tmp[2], tmp[2] * 0.25 + GRIME[2], g);

    const d = dst * 0.6;
    tmp[0] = lerp(tmp[0], DUST[0], d);
    tmp[1] = lerp(tmp[1], DUST[1], d);
    tmp[2] = lerp(tmp[2], DUST[2], d);

    // A touch of the baked cavity term in the diffuse keeps plates reading as
    // separate objects even under flat fill light.
    const k = 0.55 + ao * 0.45;
    const dth = dither(i);
    px[o] = encodeSrgb(tmp[0] * k + dth);
    px[o + 1] = encodeSrgb(tmp[1] * k + dth);
    px[o + 2] = encodeSrgb(tmp[2] * k + dth);
    px[o + 3] = 255;
  }
  return px;
}

/**
 * Re-tints a linear colour to a target reflectance while keeping its hue, then
 * blends it toward a neutral alloy. Character palettes are chosen for paint, so
 * using them raw as a metal F0 gives implausibly dark or saturated metal; this
 * borrows only the hue.
 */
function alloy(neutral, tint, amount) {
  const l = lumaOf(tint);
  if (l < 1e-5) return neutral.slice();
  const k = lumaOf(neutral) / l;
  return [
    lerp(neutral[0], tint[0] * k, amount),
    lerp(neutral[1], tint[1] * k, amount),
    lerp(neutral[2], tint[2] * k, amount),
  ];
}

/** Builds a THREE.Color from a linear triple, respecting the working colour space. */
function linearColor(c) {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
}

// ---------------------------------------------------------------------------
// Shared detail texture bundle
// ---------------------------------------------------------------------------

const SHARED_CACHE = new Map();

/**
 * Builds — once per resolution tier — every greyscale texture that does not
 * depend on the character palette. Everything in here is permanently cached and
 * is never disposed by `disposeMaterialLibrary`.
 */
function getShared(sizes, maxAniso) {
  const key = `${sizes.plate}/${sizes.metal}/${sizes.soft}/${sizes.carbon}/${maxAniso}`;
  let s = SHARED_CACHE.get(key);
  if (s) return s;

  const plate = cachedDetail(`plate:${sizes.plate}`, () => buildPlateDetail(sizes.plate));
  const metal = cachedDetail(`metal:${sizes.metal}`, () => buildMetalDetail(sizes.metal));
  const soft = cachedDetail(`soft:${sizes.soft}`, () => buildSoftDetail(sizes.soft));
  const carbon = cachedDetail(`carbon:${sizes.carbon}`, () => buildCarbonDetail(sizes.carbon));
  const peel = cachedDetail(`peel:${sizes.peel}`, () => buildOrangePeel(sizes.peel));
  const glass = cachedDetail(`glass:${sizes.soft}`, () => buildGlassDetail(sizes.soft));

  /**
   * Each role is stored at the resolution its content needs, not at the
   * resolution it was authored at. Normals and the painted plate ORM carry real
   * high frequency; occlusion, clearcoat and anisotropy masks do not, and
   * halving them is invisible while it saves tens of megabytes of VRAM.
   */
  const t = (px, size, div = 1, opts = {}) => {
    const d = downsampleRGBA(px, size, div);
    return markShared(makeTexture(d.px, d.size, { maxAniso, ...opts }));
  };

  s = {
    detail: { plate, metal, soft, carbon },
    plateNormal: t(plate.normalPx, plate.size, 1),
    plateOrmPainted: t(plate.ormPainted, plate.size, 1),
    plateOrmWorn: t(plate.ormWorn, plate.size, 2),
    plateCc: t(plate.ccPx, plate.size, 2),
    plateEmissive: t(plate.emPx, plate.size, 2, { srgb: true }),
    metalNormal: t(metal.normalPx, metal.size, 1, { repeat: METAL_REPEAT }),
    metalOrm: t(metal.orm, metal.size, 2, { repeat: METAL_REPEAT }),
    metalAniso: t(metal.anPx, metal.size, 4, { repeat: METAL_REPEAT }),
    metalMod: t(metal.modPx, metal.size, 2, { srgb: true, repeat: METAL_REPEAT }),
    softNormal: t(soft.normalPx, soft.size, 1),
    softOrm: t(soft.orm, soft.size, 1),
    softMod: t(soft.modPx, soft.size, 1, { srgb: true }),
    carbonAlbedo: t(carbon.albedoPx, carbon.size, 1, { srgb: true }),
    carbonNormal: t(carbon.normalPx, carbon.size, 1),
    carbonOrm: t(carbon.orm, carbon.size, 1),
    carbonAniso: t(carbon.anPx, carbon.size, 2),
    peelNormal: t(peel.normalPx, peel.size, 1, { repeat: 3 }),
    glassNormal: t(glass.normalPx, glass.size, 1),
    glassOrm: t(glass.orm, glass.size, 1),
  };
  SHARED_CACHE.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MaterialLibrary
 * @property {THREE.MeshPhysicalMaterial} armor      painted primary armour plate, clearcoated
 * @property {THREE.MeshPhysicalMaterial} trim       painted accent plate, same detail, hotter colour
 * @property {THREE.MeshPhysicalMaterial} worn       battle-stripped plate, mostly bare steel
 * @property {THREE.MeshPhysicalMaterial} darkMetal  structural frame, anisotropic gunmetal
 * @property {THREE.MeshPhysicalMaterial} piston     polished hydraulic rod
 * @property {THREE.MeshPhysicalMaterial} chrome     mirror accent metal
 * @property {THREE.MeshPhysicalMaterial} carbon     2x2 twill carbon fibre under lacquer
 * @property {THREE.MeshPhysicalMaterial} rubber     matte elastomer boot / grip
 * @property {THREE.MeshPhysicalMaterial} cable      ribbed sheathing with sheen
 * @property {THREE.MeshPhysicalMaterial} glass      transmissive visor glass
 * @property {THREE.MeshPhysicalMaterial} visor      opaque iridescent lens, cheap alternative to `glass`
 * @property {THREE.MeshPhysicalMaterial} emissive   vent / eye / core glow
 */

/** Bookkeeping for each library, kept off the returned object so callers can iterate it freely. */
const LIB_META = new WeakMap();
const LIB_CACHE = new Map();

const DEFAULT_PALETTE = {
  primary: 0x3d4a58,
  secondary: 0x232a33,
  accent: 0xc4472a,
  emissive: 0x36d6ff,
  trim: 0x8f9aa6,
};

function paletteKey(p, sizes) {
  return [p.primary, p.secondary, p.accent, p.emissive, p.trim, sizes.plate, sizes.metal, sizes.soft, sizes.carbon]
    .map((v) => (typeof v === 'string' ? v : (v >>> 0).toString(16)))
    .join('_');
}

function resolveSizes(scale) {
  const q = (n) => Math.max(128, Math.round((n * scale) / 128) * 128);
  return { plate: q(1024), metal: q(512), soft: q(512), carbon: q(512), peel: q(256) };
}

/**
 * Builds the full material set for one character.
 *
 * Libraries are cached and reference-counted by palette, so calling this twice
 * for the same character (both fighters picking the same robot, or a character
 * select preview alongside the fighter) shares one set of GPU textures.
 *
 * @param {THREE.WebGLRenderer|null} renderer used only for the anisotropy cap
 * @param {{primary:number|string, secondary:number|string, accent:number|string, emissive:number|string, trim:number|string}} palette
 * @param {{resolution?:number}} [options] `resolution` scales every map, 1 = full (1024/512)
 * @returns {MaterialLibrary}
 */
export function makeMaterialLibrary(renderer, palette = DEFAULT_PALETTE, options = {}) {
  const p = { ...DEFAULT_PALETTE, ...(palette || {}) };
  const sizes = resolveSizes(options.resolution ?? 1);
  const key = paletteKey(p, sizes);

  const hit = LIB_CACHE.get(key);
  if (hit) { LIB_META.get(hit).refs++; return hit; }

  let maxAniso = 8;
  try {
    const cap = renderer?.capabilities?.getMaxAnisotropy?.();
    if (Number.isFinite(cap) && cap > 0) maxAniso = Math.min(16, cap);
  } catch { /* headless or stubbed renderer: keep the default */ }

  const shared = getShared(sizes, maxAniso);
  const { plate } = shared.detail;

  const primary = hexToLinear(p.primary);
  const secondary = hexToLinear(p.secondary);
  const accent = hexToLinear(p.accent);
  const trim = hexToLinear(p.trim);
  const emissiveColor = new THREE.Color(p.emissive);

  const owned = [];
  const own = (tex) => { owned.push(tex); return tex; };

  // --- per-character albedo ---------------------------------------------
  // The only maps that are not shared. Everything else in the library is
  // greyscale detail plus a `color`, which is why a sixth character costs a few
  // milliseconds and six megabytes rather than a whole second bake.
  const armorAlbedo = own(makeTexture(
    composePlateAlbedo(plate, [primary, secondary, accent], 1.0), plate.size, { srgb: true, maxAniso },
  ));
  const trimSrc = downsampleRGBA(composePlateAlbedo(plate, [accent, trim, primary], 0.8), plate.size, 2);
  const trimAlbedo = own(makeTexture(trimSrc.px, trimSrc.size, { srgb: true, maxAniso }));
  const wornSrc = downsampleRGBA(
    composePlateAlbedo(plate, [secondary, primerTone(secondary), primary], 2.4, 0.45), plate.size, 2,
  );
  const wornAlbedo = own(makeTexture(wornSrc.px, wornSrc.size, { srgb: true, maxAniso }));

  // Alloy F0 values. Real metals sit high and near-neutral; the palette only
  // gets to tilt the hue, otherwise a dark character produces black "metal".
  const gunmetal = linearColor(alloy([0.115, 0.122, 0.135], secondary, 0.5));
  const honedSteel = linearColor([0.55, 0.555, 0.565]);
  const chromeAlloy = linearColor(alloy([0.76, 0.765, 0.78], accent, 0.13));
  const rubberBase = linearColor(alloy([0.021, 0.022, 0.024], secondary, 0.35));
  const cableBase = linearColor(alloy([0.017, 0.017, 0.019], accent, 0.3));

  // --- materials ---------------------------------------------------------
  const armor = new THREE.MeshPhysicalMaterial({
    name: 'kb.armor',
    map: armorAlbedo,
    normalMap: shared.plateNormal,
    normalScale: new THREE.Vector2(1.0, 1.0),
    aoMap: shared.plateOrmPainted,
    roughnessMap: shared.plateOrmPainted,
    metalnessMap: shared.plateOrmPainted,
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 1,
    clearcoat: 1,
    clearcoatRoughness: 1,
    clearcoatMap: shared.plateCc,
    clearcoatRoughnessMap: shared.plateCc,
    clearcoatNormalMap: shared.peelNormal,
    clearcoatNormalScale: new THREE.Vector2(0.35, 0.35),
    emissive: emissiveColor,
    emissiveMap: shared.plateEmissive,
    emissiveIntensity: 2.2,
    specularIntensity: 1,
    ior: 1.48,
    envMapIntensity: 1,
  });

  const trimMat = new THREE.MeshPhysicalMaterial({
    name: 'kb.trim',
    map: trimAlbedo,
    normalMap: shared.plateNormal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    aoMap: shared.plateOrmPainted,
    roughnessMap: shared.plateOrmPainted,
    metalnessMap: shared.plateOrmPainted,
    roughness: 0.92,
    metalness: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.8,
    clearcoatMap: shared.plateCc,
    clearcoatRoughnessMap: shared.plateCc,
    clearcoatNormalMap: shared.peelNormal,
    clearcoatNormalScale: new THREE.Vector2(0.3, 0.3),
    emissive: emissiveColor,
    emissiveMap: shared.plateEmissive,
    emissiveIntensity: 2.6,
    ior: 1.5,
    envMapIntensity: 1.05,
  });

  const worn = new THREE.MeshPhysicalMaterial({
    name: 'kb.worn',
    map: wornAlbedo,
    normalMap: shared.plateNormal,
    normalScale: new THREE.Vector2(1.15, 1.15),
    aoMap: shared.plateOrmWorn,
    roughnessMap: shared.plateOrmWorn,
    metalnessMap: shared.plateOrmWorn,
    roughness: 1,
    metalness: 1,
    clearcoat: 0.12,
    clearcoatRoughness: 0.55,
    anisotropy: 0.35,
    anisotropyRotation: 0,
    anisotropyMap: shared.metalAniso,
    envMapIntensity: 1.1,
  });

  const darkMetal = new THREE.MeshPhysicalMaterial({
    name: 'kb.darkMetal',
    color: gunmetal,
    map: shared.metalMod,
    normalMap: shared.metalNormal,
    normalScale: new THREE.Vector2(1.0, 1.0),
    aoMap: shared.metalOrm,
    roughnessMap: shared.metalOrm,
    metalnessMap: shared.metalOrm,
    roughness: 1,
    metalness: 1,
    anisotropy: 0.62,
    anisotropyRotation: 0,
    anisotropyMap: shared.metalAniso,
    envMapIntensity: 1.05,
  });

  const piston = new THREE.MeshPhysicalMaterial({
    name: 'kb.piston',
    color: honedSteel,
    map: shared.metalMod,
    normalMap: shared.metalNormal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    aoMap: shared.metalOrm,
    roughnessMap: shared.metalOrm,
    metalnessMap: shared.metalOrm,
    roughness: 0.5,
    metalness: 1,
    // A honed hydraulic rod is brushed around its axis, i.e. across U on a
    // cylinder, so the highlight is rotated a quarter turn from the frame.
    anisotropy: 0.85,
    anisotropyRotation: Math.PI * 0.5,
    anisotropyMap: shared.metalAniso,
    envMapIntensity: 1.25,
  });

  const chrome = new THREE.MeshPhysicalMaterial({
    name: 'kb.chrome',
    color: chromeAlloy,
    map: shared.metalMod,
    normalMap: shared.metalNormal,
    normalScale: new THREE.Vector2(0.3, 0.3),
    aoMap: shared.metalOrm,
    roughnessMap: shared.metalOrm,
    metalnessMap: shared.metalOrm,
    roughness: 0.28,
    metalness: 1,
    anisotropy: 0.3,
    anisotropyMap: shared.metalAniso,
    envMapIntensity: 1.4,
  });

  const carbon = new THREE.MeshPhysicalMaterial({
    name: 'kb.carbon',
    map: shared.carbonAlbedo,
    normalMap: shared.carbonNormal,
    normalScale: new THREE.Vector2(1.0, 1.0),
    aoMap: shared.carbonOrm,
    roughnessMap: shared.carbonOrm,
    metalnessMap: shared.carbonOrm,
    roughness: 1,
    metalness: 1,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    clearcoatNormalMap: shared.peelNormal,
    clearcoatNormalScale: new THREE.Vector2(0.18, 0.18),
    anisotropy: 0.75,
    anisotropyMap: shared.carbonAniso,
    sheen: 0.25,
    sheenColor: new THREE.Color(p.accent),
    sheenRoughness: 0.5,
    ior: 1.52,
    envMapIntensity: 1.15,
  });

  const rubber = new THREE.MeshPhysicalMaterial({
    name: 'kb.rubber',
    color: rubberBase,
    map: shared.softMod,
    normalMap: shared.softNormal,
    normalScale: new THREE.Vector2(1.1, 1.1),
    aoMap: shared.softOrm,
    roughnessMap: shared.softOrm,
    metalnessMap: shared.softOrm,
    roughness: 1,
    metalness: 1,
    // Sheen is what gives an elastomer its soft, dusty rim response instead of
    // reading as a black plastic blob under the rim light.
    sheen: 0.85,
    sheenColor: new THREE.Color(0x6f7a86),
    sheenRoughness: 1,
    sheenRoughnessMap: shared.softOrm,
    specularIntensity: 0.4,
    ior: 1.45,
    envMapIntensity: 0.75,
  });

  const cable = new THREE.MeshPhysicalMaterial({
    name: 'kb.cable',
    color: cableBase,
    map: shared.softMod,
    normalMap: shared.softNormal,
    normalScale: new THREE.Vector2(1.5, 1.5),
    aoMap: shared.softOrm,
    roughnessMap: shared.softOrm,
    metalnessMap: shared.softOrm,
    roughness: 1,
    metalness: 1,
    sheen: 1,
    sheenColor: new THREE.Color(p.trim),
    sheenRoughness: 1,
    sheenRoughnessMap: shared.softOrm,
    specularIntensity: 0.35,
    envMapIntensity: 0.7,
  });

  const glass = new THREE.MeshPhysicalMaterial({
    name: 'kb.glass',
    color: new THREE.Color(0x9fb4c4),
    normalMap: shared.glassNormal,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughnessMap: shared.glassOrm,
    roughness: 1,
    metalness: 0,
    transmission: 0.92,
    thickness: 0.035,
    ior: 1.52,
    attenuationColor: new THREE.Color(p.emissive),
    attenuationDistance: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    iridescence: 0.45,
    iridescenceIOR: 1.32,
    iridescenceThicknessRange: [120, 520],
    envMapIntensity: 1.5,
    transparent: false,
  });

  // Opaque stand-in for the visor when transmission is too expensive for the
  // current quality tier, and the natural choice for eye lenses.
  const visor = new THREE.MeshPhysicalMaterial({
    name: 'kb.visor',
    color: new THREE.Color(0x0a0e12),
    normalMap: shared.glassNormal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    roughnessMap: shared.glassOrm,
    roughness: 1,
    metalness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    iridescence: 0.85,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [180, 640],
    emissive: emissiveColor,
    emissiveIntensity: 0.9,
    ior: 1.6,
    envMapIntensity: 1.6,
  });

  const emissive = new THREE.MeshPhysicalMaterial({
    name: 'kb.emissive',
    color: new THREE.Color(0x05070a),
    emissive: emissiveColor,
    emissiveIntensity: 6.5,
    roughness: 0.35,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    toneMapped: true,
    envMapIntensity: 0.6,
  });

  /** @type {MaterialLibrary} */
  const lib = {
    armor, trim: trimMat, worn, darkMetal, piston, chrome,
    carbon, rubber, cable, glass, visor, emissive,
  };

  LIB_META.set(lib, { key, refs: 1, textures: owned, materials: Object.values(lib) });
  LIB_CACHE.set(key, lib);
  return lib;
}

/** Desaturated, darkened variant of a palette colour — the "primer" under the paint. */
function primerTone(c) {
  const l = lumaOf(c);
  return [lerp(c[0], l, 0.75) * 0.6, lerp(c[1], l, 0.75) * 0.6, lerp(c[2], l, 0.75) * 0.62];
}

/**
 * Releases one reference to a library. The per-character albedo textures and
 * the materials are destroyed when the last reference goes; the shared
 * greyscale detail maps survive for the next character and are only freed by
 * `disposeSharedTextures()`.
 *
 * @param {MaterialLibrary} lib
 */
export function disposeMaterialLibrary(lib) {
  const meta = lib && LIB_META.get(lib);
  if (!meta) return;
  if (--meta.refs > 0) return;
  for (const tex of meta.textures) tex.dispose();
  for (const mat of meta.materials) mat.dispose();
  LIB_CACHE.delete(meta.key);
  LIB_META.delete(lib);
}

/**
 * Tears down the module-level shared caches. Only call this when the whole
 * renderer is going away — every live library references these textures.
 */
export function disposeSharedTextures() {
  for (const tex of SHARED_TEXTURES) tex.dispose();
  SHARED_TEXTURES.clear();
  SHARED_CACHE.clear();
  DETAIL_CACHE.clear();
}

/**
 * Unlit emitter for effects geometry: sparks, trails, shockwaves, muzzle
 * flashes. Deliberately `MeshBasicMaterial` with tone mapping off, because a
 * bloom emitter has to be able to push past 1.0 in linear space; a lit material
 * would be clamped by exposure before the bloom threshold ever saw it.
 *
 * @param {number|string|THREE.Color} color
 * @param {number} [intensity=1] linear multiplier, >1 to force bloom
 * @param {{transparent?:boolean, blending?:number, depthWrite?:boolean}} [opts]
 * @returns {THREE.MeshBasicMaterial}
 */
export function makeEmissiveMaterial(color, intensity = 1, opts = {}) {
  const c = new THREE.Color(color);
  c.multiplyScalar(Math.max(0, intensity));
  const mat = new THREE.MeshBasicMaterial({
    color: c,
    toneMapped: false,
    transparent: opts.transparent ?? true,
    blending: opts.blending ?? THREE.AdditiveBlending,
    depthWrite: opts.depthWrite ?? false,
    side: THREE.DoubleSide,
  });
  mat.name = 'kb.fxEmissive';
  return mat;
}

/**
 * Arena floor: a wet, polished industrial deck. Reuses the shared brushed-metal
 * detail at a high repeat for the microstructure but overrides the response to
 * a dark dielectric so the fighters reflect in it, which is the single strongest
 * "expensive stage" cue in this genre.
 *
 * @param {THREE.WebGLRenderer|null} renderer
 * @param {{repeat?:number, color?:number|string, roughness?:number, resolution?:number}} [opts]
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function makeFloorMaterial(renderer, opts = {}) {
  const sizes = resolveSizes(opts.resolution ?? 1);
  let maxAniso = 8;
  try {
    const cap = renderer?.capabilities?.getMaxAnisotropy?.();
    if (Number.isFinite(cap) && cap > 0) maxAniso = Math.min(16, cap);
  } catch { /* headless: default */ }

  const shared = getShared(sizes, maxAniso);
  const repeat = opts.repeat ?? 14;

  // Clone so the floor can tile independently of the robots without touching
  // the shared textures' repeat.
  const normal = shared.metalNormal.clone();
  const orm = shared.metalOrm.clone();
  for (const t of [normal, orm]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.needsUpdate = true;
  }

  const mat = new THREE.MeshPhysicalMaterial({
    name: 'kb.floor',
    color: new THREE.Color(opts.color ?? 0x14181d),
    normalMap: normal,
    normalScale: new THREE.Vector2(0.45, 0.45),
    aoMap: orm,
    roughnessMap: orm,
    roughness: opts.roughness ?? 0.36,
    metalness: 0.15,
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    clearcoatNormalMap: shared.peelNormal,
    clearcoatNormalScale: new THREE.Vector2(0.12, 0.12),
    envMapIntensity: 1.2,
  });
  mat.userData.ownedTextures = [normal, orm];
  return mat;
}

/**
 * Convenience for the character-select preview and the FX director: the shared
 * greyscale maps, already uploaded, without building a whole library.
 * @param {THREE.WebGLRenderer|null} renderer
 * @param {{resolution?:number}} [opts]
 */
export function getSharedDetailTextures(renderer, opts = {}) {
  let maxAniso = 8;
  try {
    const cap = renderer?.capabilities?.getMaxAnisotropy?.();
    if (Number.isFinite(cap) && cap > 0) maxAniso = Math.min(16, cap);
  } catch { /* headless: default */ }
  return getShared(resolveSizes(opts.resolution ?? 1), maxAniso);
}
