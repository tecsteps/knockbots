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
 *      and memoised at module scope. The whole roster pays for them once.
 *   2. **Colour is not baked.** Every map is hue-neutral and the character's
 *      palette arrives through `material.color`, so one bake serves every
 *      fighter and a consumer may clone a material and re-tint it — which
 *      `RobotBuilder` does, to drive the primary, secondary and accent parts of
 *      a robot from a single plate texture. Building a character therefore
 *      costs a few materials and no texture memory whatsoever.
 *   3. Every channel is derived from the same few fields, so the maps agree
 *      with each other by construction: a scratch is a dent in the height
 *      field, therefore it appears in the normal map, it removes paint so
 *      metalness rises and clearcoat drops, and it polishes the steel beneath
 *      so roughness falls. There is no way for them to drift apart.
 *   4. Everything above is projected through the model's UVs, which on a robot
 *      of rigid plates are per-plate and therefore near-identical from one
 *      plate to the next. The character's *history* — fade, runs, oxidation,
 *      heat staining, sprayed markings — is therefore a separate layer sampled
 *      triplanar in object space by a shader patch, so where a plate sits on
 *      the body decides how it has aged. See "Surface story" below.
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
 * Periodic Worley/cellular noise. Returns the F1 distance normalised into
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
          if (d < d1) { d1 = d; best = id[i]; }
        }
      }
      const i = row + x;
      f1[i] = clamp01(Math.sqrt(d1));
      cid[i] = best;
    }
  }
  return { f1, id: cid };
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
 *
 * `origins` seeds the run from real features — the lower lip of a louvre, the
 * bottom edge of a plate — instead of from noise. A streak that starts nowhere
 * reads as dirt; a streak that starts under a vent reads as history.
 */
function drawDrips(dst, size, rng, opts) {
  const { count, maxLen, width, strength, origins = null } = opts;
  for (let i = 0; i < count; i++) {
    const src = origins ? origins[i % origins.length] : null;
    let x = src ? src[0] + (rng.next() - 0.5) * (src[2] ?? 0) : rng.next() * size;
    let y = src ? src[1] : rng.next() * size;
    const len = Math.max(8, 16 + rng.next() * maxLen);
    const w = width * (0.4 + rng.next() * 1.3);
    const amp = strength * (0.3 + rng.next() * 0.7);
    let drift = 0;
    // A slight swelling where the fluid gathered before it broke away, then a
    // long thinning tail. Keep the head close to the tail width: a round blob
    // on a thin line reads as a pin, not as a run.
    stamp(dst, size, x, y, w * 1.25, amp * 0.8);
    for (let s = 0; s < len; s++) {
      drift += (rng.next() - 0.5) * 0.22;
      drift *= 0.93;
      x += drift * 0.45;
      y -= 1;
      const t = s / len;
      stamp(dst, size, x, y, w * (1.15 - 0.75 * t), amp * Math.pow(1 - t, 1.1));
    }
  }
}

// ---------------------------------------------------------------------------
// Stencil markings
//
// A machine that has been through a factory carries writing: a unit number, a
// hazard chevron by a moving part, an arrow at a lifting point. It is the one
// kind of surface incident that is unmistakably *asymmetric*, which is why a
// plate without it reads as a rendered box no matter how good the wear is.
//
// The glyph set is a 5x7 stroke bitmap rather than a font file, and every mark
// is rasterised through a pen whose rotation is a whole quarter turn, so the
// strokes stay axis-aligned and crisp at any orientation.
// ---------------------------------------------------------------------------

/** 5x7 stencil face, one number per row, bit 4 leftmost. */
const GLYPHS = {
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  '3': [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x11, 0x01, 0x02, 0x04, 0x04, 0x04],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
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
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '/': [0x01, 0x01, 0x02, 0x04, 0x08, 0x10, 0x10],
};

const STENCIL_WORDS = [
  'KB', 'MK IV', 'CAUTION', 'NO STEP', 'LIFT', 'HV', 'COOLANT', 'PURGE',
  'SERVO', 'ARM', 'A-07', 'RB-21', 'X9', 'TORQUE', 'GRND', 'VENT',
];

/**
 * Pen writing axis-aligned marks into a field, with the origin and a quarter
 * turn baked in. `put` clamps nothing and wraps everything, so a mark may run
 * off the tile edge and reappear — which is correct, the field tiles.
 */
function stencilPen(dst, size, ox, oy, rot) {
  const c = rot === 1 ? 0 : rot === 2 ? -1 : rot === 3 ? 0 : 1;
  const s = rot === 1 ? 1 : rot === 2 ? 0 : rot === 3 ? -1 : 0;
  const put = (x, y, v) => {
    const tx = Math.round(ox + x * c - y * s);
    const ty = Math.round(oy + x * s + y * c);
    dst[(((ty % size) + size) % size) * size + (((tx % size) + size) % size)] = v;
  };
  const rect = (x, y, w, h, v) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, v);
  };
  return {
    rect,
    /** Filled ring, used for roundels and inspection stamps. */
    ring(cx, cy, r, thick, v) {
      const inner = (r - thick) * (r - thick);
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const d = i * i + j * j;
          if (d <= r * r && d >= inner) put(cx + i, cy + j, v);
        }
      }
    },
    /** Right-pointing chevron stack: the universal "moving part" marking. */
    chevron(x, y, w, h, thick, n, gap, v) {
      for (let k = 0; k < n; k++) {
        const x0 = x + k * (w + gap);
        for (let j = 0; j < h; j++) {
          const t = 1 - Math.abs(j - (h - 1) / 2) / ((h - 1) / 2 || 1);
          const px = x0 + Math.round(t * (w - thick));
          rect(px, y + j, thick, 1, v);
        }
      }
    },
    /** Diagonal hazard bar. */
    stripes(x, y, w, h, pitch, v) {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          if ((((i + j) % pitch) + pitch) % pitch < pitch * 0.5) put(x + i, y + j, v);
        }
      }
    },
    /** Hollow warning triangle with a bang inside it. */
    warning(x, y, sz, thick, v) {
      for (let j = 0; j < sz; j++) {
        const t = j / (sz - 1);
        const half = Math.round((t * sz) / 2);
        rect(x - half, y + j, thick, 1, v);
        rect(x + half - thick + 1, y + j, thick, 1, v);
      }
      rect(x - Math.round(sz / 2), y + sz - thick, sz, thick, v);
      const bh = Math.round(sz * 0.4);
      rect(x - ((thick / 2) | 0), y + sz - thick - bh - thick * 2, thick, bh, v);
      rect(x - ((thick / 2) | 0), y + sz - thick * 3, thick, thick, v);
    },
    /** Solid arrow along +X. */
    arrow(x, y, len, h, v) {
      const shaft = Math.round(h * 0.34);
      rect(x, y - ((shaft / 2) | 0), len, shaft, v);
      for (let j = -((h / 2) | 0); j <= (h / 2) | 0; j++) {
        const w = Math.round((1 - Math.abs(j) / ((h / 2) | 1)) * h * 0.7);
        rect(x + len, y + j, Math.max(1, w), 1, v);
      }
    },
    /** Variable-pitch bar code, the cheapest "this was inventoried" cue. */
    barcode(x, y, w, h, seed, v) {
      let i = 0;
      let k = 0;
      while (i < w) {
        const bw = 1 + (ihash(k, seed, 8191) % 3);
        if (k % 2 === 0) rect(x + i, y, bw, h, v);
        i += bw;
        k++;
      }
    },
    /** Stencil text. Returns the width consumed. */
    text(str, x, y, px, v) {
      let cx = x;
      for (const ch of str.toUpperCase()) {
        if (ch === ' ') { cx += px * 3; continue; }
        const g = GLYPHS[ch];
        if (!g) { cx += px * 3; continue; }
        for (let row = 0; row < 7; row++) {
          const bits = g[row];
          for (let col = 0; col < 5; col++) {
            // Row 0 is the top of the glyph, and V increases upward in a
            // DataTexture, so the rows are written bottom-up.
            if (bits & (1 << (4 - col))) rect(cx + col * px, y + (6 - row) * px, px, px, v);
          }
        }
        cx += px * 6;
      }
      return cx - x;
    },
  };
}

/**
 * Scatters stencil markings across a field whose neutral value is 0.5. Marks
 * above the neutral are sprayed in a light paint, marks below it in a dark one,
 * which is how the shader gets two ink colours out of one channel.
 */
function drawStencils(dst, size, rng, count) {
  const K = size / 1024;
  const px = Math.max(1, Math.round(3 * K));
  for (let i = 0; i < count; i++) {
    const pen = stencilPen(dst, size, rng.next() * size, rng.next() * size, (rng.next() * 4) | 0);
    const light = rng.next() < 0.62;
    const ink = light ? 0.5 + 0.42 * (0.7 + rng.next() * 0.3) : 0.5 - 0.42 * (0.7 + rng.next() * 0.3);
    switch ((rng.next() * 7) | 0) {
      case 0: {
        const w = STENCIL_WORDS[(rng.next() * STENCIL_WORDS.length) | 0];
        pen.text(w, 0, 0, px + ((rng.next() * 2) | 0), ink);
        break;
      }
      case 1:
        pen.chevron(0, 0, Math.round(28 * K), Math.round(46 * K), Math.round(8 * K), 3, Math.round(7 * K), ink);
        break;
      case 2:
        pen.stripes(0, 0, Math.round(150 * K), Math.round(30 * K), Math.round(17 * K), ink);
        break;
      case 3:
        pen.arrow(0, 0, Math.round(58 * K), Math.round(34 * K), ink);
        break;
      case 4:
        pen.warning(0, 0, Math.round(52 * K), Math.round(6 * K), ink);
        break;
      case 5:
        pen.barcode(0, 0, Math.round(92 * K), Math.round(26 * K), (rng.next() * 4096) | 0, ink);
        pen.text(String(1000 + ((rng.next() * 8999) | 0)), 0, -Math.round(24 * K), px, ink);
        break;
      default:
        pen.ring(0, 0, Math.round(26 * K), Math.round(5 * K), ink);
        pen.text(String(10 + ((rng.next() * 89) | 0)), -Math.round(11 * K), -Math.round(12 * K), px, ink);
        break;
    }
  }
}

/**
 * The object-space surface-story field.
 *
 * Everything else in this file is projected through the model's authored UVs,
 * which on a hard-surface robot are per-plate and therefore identical from one
 * plate to the next. This map is instead projected triplanar in *object space*
 * by the shader, so where a plate sits on the body decides how it has aged. It
 * is the octave the plate bake structurally cannot supply: 2-10cm incident that
 * varies across the character rather than across the tile.
 *
 *   R  paint fade — broad value break, sun and solvent
 *   G  gravity streaks — coolant and oil running down under their own weight
 *   B  oxidation blotch — where the bloom out of a panel gap is allowed to be
 *   A  stencil markings — 0.5 neutral, above it light ink, below it dark
 */
function buildGrungeDetail(size) {
  const rng = new Rng(0x5eed07);
  const n = size * size;

  // The band this map exists to supply is 2-10cm, which at this tiling is 15 to
  // 80 texels. The low octaves only set which region of the body is generally
  // tired; the weight sits deliberately on the middle of the spectrum.
  const fadeA = fbm(size, { octaves: 4, freq: 5, gain: 0.66, seed: 601 });
  const fadeB = fbm(size, { octaves: 3, freq: 16, gain: 0.62, seed: 607 });
  const patch = worley(size, Math.max(5, size >> 7), 613);

  const streak = new Float32Array(n);
  drawDrips(streak, size, rng, {
    count: Math.round(size * 0.16), maxLen: size * 0.5,
    width: Math.max(2, size / 200), strength: 1.0,
  });
  const streakN = fbm(size, { octaves: 4, freq: 22, gain: 0.55, seed: 619, aspect: 9 });

  const oxide = fbm(size, { octaves: 4, freq: 9, gain: 0.55, seed: 631, ridged: true });
  const oxCells = worley(size, Math.max(7, size >> 6), 641);

  const mark = new Float32Array(n).fill(0.5);
  drawStencils(mark, size, rng, 14);
  // One texel of softening: the strokes are rasterised hard, and a hard edge in
  // a map that is then magnified across a 30cm plate crawls under the camera.
  const markSoft = boxBlurWrap(mark, size, Math.max(1, Math.round(size / 700)));

  const px = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const blotch = smoothstep(0.34, 0.0, patch.f1[i]);
    const fade = clamp01(0.5 + fadeA[i] * 1.0 + fadeB[i] * 0.8 - blotch * 0.3);
    const run = clamp01(streak[i] * 1.0 + clamp01(streakN[i] * 1.9 + 0.08) * 0.75);
    const ox = clamp01(clamp01(oxide[i] * 1.7 - 0.16) * (0.3 + smoothstep(0.5, 0.05, oxCells.f1[i]) * 1.25));
    px[o] = fade * 255;
    px[o + 1] = run * 255;
    px[o + 2] = ox * 255;
    px[o + 3] = clamp01(markSoft[i]) * 255;
  }
  return { size, px };
}

// ---------------------------------------------------------------------------
// Hard-surface panel layout
// ---------------------------------------------------------------------------

/** Paint assignment for a plate. Encoded into one channel as (paint + variation) / 3. */
const PAINT_PRIMARY = 0;
const PAINT_SECONDARY = 1;
const PAINT_ACCENT = 2;

/**
 * Base roughness per paint role. The three roles are three different products,
 * not three colours of one: a structural plate is primed and sprayed once and
 * stays matte, the body colour is satin, and an accent panel is finished and
 * holds a tight highlight. Handing all three the same lobe width is a large part
 * of why every plate on this roster measured as the same surface.
 */
const ROLE_ROUGH = [0.40, 0.57, 0.29];

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
      // A light strip lives in the groove around its plate, and the groove on
      // the unit-square border is shared with the tiled neighbour. Letting a
      // border plate glow would light only one side of that seam.
      glow: small && variation < 0.14 && x0 > 0 && y0 > 0 && x1 < 1 && y1 < 1,
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

/**
 * Tiling of the clearcoat peel normal, in repeats per UV unit.
 *
 * 3 puts its two octaves at roughly 9 and 30 screen pixels at closeup range —
 * the same band the panel lines, rivets and wear blotches already occupy — so
 * it looks like the obvious place to buy the missing fine scale documented in
 * `resolveSizes`. Retiling it to 9, which lands the upper octave at about 3
 * screen pixels, **does not measurably change the image**: on the closeup rig
 * with the post chain off, 1px band energy went 3.993 -> 4.042 and the
 * 1px:4px ratio 0.395 -> 0.399, both inside run-to-run noise.
 *
 * A clearcoat normal cannot carry this. The coat is a 4% reflector over a dark
 * base and its lobe is broad (`clearcoatRoughness` around 0.28 on the armour),
 * so perturbing it spreads the highlight instead of breaking it up. Fine scale
 * on these plates has to come from the base roughness, not from the coat.
 */
const PEEL_REPEAT = 3;

/**
 * Near-Nyquist surface grain, in units of one standard deviation.
 *
 * The measured deficit on the character is not detail, it is *scale*: the plate
 * bake's finest authored octaves are `tooth` (16 texels) and `machining` (5.7
 * texels along its short axis), which at the closest framing the game uses —
 * about 1.1 texels per screen pixel on `kb.armor` at 1.35 m on a 24-degree lens
 * — land at 14 and 5 screen pixels. Nothing in the set was at one to three
 * pixels, which is where a cast, blasted or rolled surface puts most of its
 * energy and where the eye reads "material" rather than "pattern".
 *
 * A hashed field tented once in each axis has its energy at two to four texels
 * with the pure-Nyquist component — the part that only ever aliases — removed.
 * It costs one extra full-resolution field at bake time and nothing at runtime.
 *
 * `aspect` stretches the lattice along V so the field reads as a directional
 * lay rather than as isotropic pebbling. That is not decoration: measured at
 * matched 1px energy, an isotropic field at this scale reads as hammered
 * leather and a lay at aspect 5 reads as wood grain, and 3 is the value that
 * reads as a rolled-and-painted plate from either direction.
 */
function microGrain(size, seed, aspect = 1) {
  const n = size * size;
  const sh = Math.max(1, Math.round(size / aspect));
  const raw = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const ly = Math.floor((y * sh) / size);
    const row = y * size;
    for (let x = 0; x < size; x++) raw[row + x] = (ihash(x, ly, seed) & 0xffff) / 65535 - 0.5;
  }
  const tmp = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      tmp[row + x] = (raw[row + ((x + size - 1) % size)] + 2 * raw[row + x] + raw[row + ((x + 1) % size)]) * 0.25;
    }
  }
  const out = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    const a = ((y + size - 1) % size) * size;
    const b = y * size;
    const c = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) out[b + x] = (tmp[a + x] + 2 * tmp[b + x] + tmp[c + x]) * 0.25;
  }
  // High-pass at five texels. Without it the field still carries a long low tail,
  // and on the normal map that tail lands squarely in the 4-8 texel band that is
  // already the loudest thing on the character. Band-limiting to 2-5 texels is
  // what buys 1px energy without paying for it at 4px.
  const low = boxBlurWrap(out, size, 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { out[i] -= low[i]; sum += out[i] * out[i]; }
  const inv = 1 / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] *= inv;
  return out;
}

/**
 * Grain amplitudes, in standard deviations of {@link microGrain}.
 *
 * `rough` is in absolute roughness units; `height` feeds the plate height field,
 * which `encodeNormal` differentiates at scale 5.4 over a two-texel span, so
 * 0.013 is about a four-degree mean tilt.
 *
 * Both numbers are the measured answer to round 12's brief, and one half of that
 * brief did not survive the measurement. On the deterministic head closeup with
 * the post chain off, band energy on the 420px head crop moved as follows
 * (baseline 1px 3.607, 4px 9.028, ratio 0.400; run-to-run sigma on the ratio is
 * 0.0015, so everything below is far outside noise):
 *
 *     grain on base ROUGHNESS only, 0.10   1px +4.1%   ratio 0.399 -> 0.403
 *     grain on the NORMAL only, 0.020      1px +44%    ratio 0.399 -> 0.489
 *     grain on the NORMAL only, 0.035      1px +55%    ratio 0.399 -> 0.538
 *
 * Roughness break-up was the recommended lever and it is worth almost nothing:
 * an absolute roughness swing of +-0.10 at this scale changes lobe width where
 * the lobe is already broad, and the plates are lit by an environment that
 * varies slowly. The normal is worth ten times as much, because it changes which
 * direction each texel points and therefore which part of the environment it
 * sees. The roughness term is kept because it is free and physically correct,
 * not because it moves the number.
 *
 * The amplitude is not set by the metric. 0.035 reaches the 0.55 ratio the brief
 * asked for and turns every plate into hammered leather; 0.020 still pebbles the
 * darker plates. 0.013 is the largest amplitude that still reads as a cast tooth
 * on a painted plate, and it lands the ratio at 0.448 on the head crop and 0.398
 * on the torso. **The ratio target above 0.45 is not reachable through the normal
 * map without visibly damaging the surface** — see the note in `resolveSizes`.
 */
const GRAIN = { rough: 0.075, height: 0.013, aspect: 3 };

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

  // Oil-canning. A stamped or rolled plate is never flat: it crowns between its
  // fasteners and pulls in at them, by a few degrees over the span of a panel.
  // Nothing in the rest of this bake carries that, and its absence is exactly
  // why a big painted face reflects the key as one clean unbroken sheet — the
  // reflection has nothing to travel over. It is kept in its own field because
  // it is a *shape*, not a cavity: the occlusion, edge and chip masks are all
  // derived from the detail height and must not see it, or every crowned panel
  // would come out ringed with a shadow it has no reason to cast.
  const dish = new Float32Array(n);

  const rects = buildPanelLayout(rng);
  // Where a run of fluid is allowed to start: the lower lip of a louvre, the
  // bottom groove of a plate. Each entry is [x, y, jitter] in texels.
  const dripOrigins = [];

  let rectIndex = 0;
  for (const r of rects) {
    // Decorrelated from every other per-plate decision, and drawn from the
    // rect's ordinal rather than the shared Rng so that adding it here does not
    // reshuffle the panel layout every character in the roster is wearing.
    const dishAmp = ((ihash(rectIndex++, 91, 4177) & 0xffff) / 65535 - 0.5) * 2;
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

    // Louvres weep; so does the seam under a plate that stands proud of its
    // neighbour. Everything else stays dry, which is what keeps the streaks
    // reading as drainage rather than as dirt sprayed at random.
    if (r.vent || r.glow) {
      const w = px1 - px0;
      for (let k = 0; k < 3; k++) dripOrigins.push([px0 + (w * (k + 0.5)) / 3, py0 + gw, w * 0.16]);
    } else if (r.z > 0.62 && r.area > 0.01) {
      dripOrigins.push([lerp(px0, px1, 0.2 + r.variation * 0.6), py0 + gw, (px1 - px0) * 0.22]);
    }

    const spanX = Math.max(1, px1 - px0);
    const spanY = Math.max(1, py1 - py0);
    for (let y = iy0; y < iy1; y++) {
      const fy = y + 0.5;
      const dy = Math.min(fy - py0, py1 - fy);
      const row = y * size;
      const domeY = Math.sin(Math.PI * ((fy - py0) / spanY));
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
        // Gated on the bevel mask, because a plate is held flat where it is
        // fastened and only bulges between: letting the dome run all the way
        // into the groove rings every panel with a shadow it has not earned and
        // the face stops reading as metal and starts reading as quilting.
        dish[i] = Math.sin(Math.PI * ((fx - px0) / spanX)) * domeY * dishAmp * b;
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
  // Rolling marks left in the plate stock: a few millimetres across, strongly
  // directional. Far too fine to see as texture, but it breaks the specular
  // into a grain, which is the difference between "steel plate" and "surface".
  const machining = fbm(size, { octaves: 2, freq: 180, gain: 0.5, seed: 17, aspect: 14 });
  const casting = fbm(size, { octaves: 4, freq: 12, gain: 0.5, seed: 23 });
  const macro = fbm(size, { octaves: 3, freq: 4, gain: 0.5, seed: 37 });
  // Hand-sized weathering patches, ~8cm. Lacquer does not tire evenly across a
  // panel: it goes in patches, and what separates a tired patch from a fresh one
  // is *gloss*, not colour — at this scale the eye reads the width of the
  // highlight long before it reads a change in albedo. Deliberately its own
  // field rather than a reuse of `casting`, so the gloss break is not welded to
  // the albedo mottle; two independent breaks read as two things happening to
  // the paint, one break used twice reads as a stain.
  const patch = fbm(size, { octaves: 3, freq: 13, gain: 0.55, seed: 89 });
  // Cast grain / blast tooth at two to four texels. See {@link microGrain}.
  const grain = microGrain(size, 0x9e1f37, GRAIN.aspect);
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
    count: Math.max(8, dripOrigins.length), maxLen: size * 0.34,
    width: Math.max(1.8, size / 300), strength: 0.85,
    origins: dripOrigins.length ? dripOrigins : null,
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
      tooth[i] * 0.012 +
      machining[i] * 0.009 -
      microScratch[i] * 0.05 -
      heroScratch[i] * 0.1;
  }

  const ao = aoFromHeight(height, size, [2, 7, 24], [0.28, 0.4, 0.32], 3.4);
  const up = upFacingFromHeight(height, size, 26);

  // The shape the light actually reflects off: detail plus the panel crowns.
  // A dome of this amplitude across a 20cm panel tilts the normal by about five
  // degrees at its steepest, which is what a stamped plate really does and is
  // enough to make a hard key stretch and break as it crosses the face instead
  // of laying a single flat sheet over it.
  //
  // The grain rides here and not in `height`, for the same reason `dish` does:
  // it is a shape the light travels over, not a cavity. Feeding it to `height`
  // would put it through `aoFromHeight` and the convexity mask below, and every
  // texel of the plate would come out reading as a chipped micro-edge.
  const shape = new Float32Array(n);
  for (let i = 0; i < n; i++) shape[i] = height[i] + dish[i] * 0.42 + macro[i] * 0.16 + grain[i] * GRAIN.height;
  const normalPx = encodeNormal(shape, size, 5.4);

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
    // NOTE, round 13. The pale elliptical "wear blotches" that read as decals
    // scattered across the plates are THIS mask, reaching the frame through
    // `metalnessMap` and not through albedo: `metal` below is chip * 0.95, so a
    // flake turns a patch of paint into a mirror and what lands on screen is a
    // soft-edged oval of pale environment. Traced by ablation on the closeup rig
    // — nulling `metalnessMap` alone removes every one of them, and nothing else
    // does: albedo, clearcoat, and all eleven surface-story terms leave them
    // untouched. Breaking the outline with a finer modulator was tried here and
    // measured as nothing (band energy identical to four decimal places, absolute
    // frame difference under 2/255 outside the panel lines) because
    // `smoothstep(0.4, 0.82, jag)` saturates over the body of a flake; reverted.
    // The lever is the `gate`/`metal` coupling, not the outline.
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
    grime[i] = clamp01(cavity * 0.68 + groove[i] * 0.5 + drips[i] * 0.95 + blot * 0.24 * (0.4 + cavity));
    dust[i] = clamp01(up[i] * 1.9 * (0.5 + casting[i] * 0.5) * ao[i]);
  }

  // --- panel-edge proximity, heat halo -----------------------------------
  // Two broad fields the shader needs but cannot derive: how close a texel is
  // to a panel gap (oxidation blooms out of gaps, never out of open field) and
  // how close it is to something hot (temper colours ring a vent). Both are
  // blurs of a mask already computed above, so they cost one pass each.
  const grooveWide = boxBlurWrap(groove, size, Math.max(3, Math.round(size * 0.02)));
  const glowNear = boxBlurWrap(glow, size, Math.max(2, Math.round(size * 0.012)));
  const glowFar = boxBlurWrap(glow, size, Math.max(5, Math.round(size * 0.045)));
  // Quantised, because the only consumer writes it straight into a byte channel
  // and this array is retained for the life of the process.
  const edgeProx = new Uint8Array(n);
  const heat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    edgeProx[i] = clamp01(grooveWide[i] * 3.2) * (1 - groove[i] * 0.55) * 255;
    heat[i] = clamp01(glowNear[i] * 2.6 + glowFar[i] * 2.2) * (1 - glow[i] * 0.8);
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
  //
  // Roughness is the channel this bake was weakest in, and it was measurable.
  // The previous formulation put +-0.09 of gloss variation across the whole map
  // and left **80% of the painted plate inside a 0.2-wide roughness window
  // around 0.45**, so every plate on every character answered the key light with
  // the same lobe width. Measured against the reference the effect is stark:
  // three different armour plates in a closeup capture returned band-contrast
  // spectra identical to each other to within 20%, where three different Tekken
  // 8 surfaces in one frame differ by an order of magnitude at the same scale.
  // "One uniform metalness" in docs/CRITIC.md is exactly this, expressed through
  // gloss rather than through metalness.
  //
  // So the mm-to-decimetre band now carries real gloss structure, and the three
  // paint roles are treated as three different products rather than three
  // colours of one. Everything below is authored in the 5mm-8cm band, which is
  // 6-100px at the closest framing the game ever uses and mips honestly to its
  // mean at fighting range.
  const ormPainted = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = chip[i];
    const s = scratch[i];
    const g = grime[i];
    const d = dust[i];
    const cav = clamp01((1 - ao[i]) * 1.4);

    // Plate role, unpacked from the same (paint + variation) / 3 the albedo
    // reads. A structural plate is primed and sprayed once and stays matte; an
    // accent panel is finished and holds a tight highlight. The fractional part
    // is the per-plate batch jitter, so no two adjacent plates of the same role
    // came out of the booth identical either.
    const t3 = panelId[i] * 3;
    const role = t3 < 1 ? 0 : t3 < 2 ? 1 : 2;
    const jitter = t3 - role - 0.5;

    let rough =
      ROLE_ROUGH[role] + jitter * 0.10 +
      patch[i] * 0.17 +      // 8cm weathering patches: the hand-sized gloss break
      casting[i] * 0.13 +    // 8cm cast and roll mottle
      tooth[i] * 0.11 +      // 1.6cm surface tooth
      machining[i] * 0.12 +  // 5mm rolling marks in the plate stock
      grain[i] * GRAIN.rough +  // cast tooth, 2-4 texels: the octave the set had none of
      cav * 0.14;            // nothing ever wipes the bottom of a trough
    // A fastener head is rubbed bright by every hand and spanner that has been
    // near it; a weld bead is the one thing on a plate that was never finished.
    rough -= clamp01(rivet[i]) * 0.16;
    if (bead[i] > 0) rough += Math.sqrt(bead[i]) * 0.16;

    rough = lerp(rough, 0.52, c * 0.55);   // primer and bare cast steel
    rough = lerp(rough, 0.14, s * 0.85);
    rough = lerp(rough, 0.86, g * 0.8);
    rough = lerp(rough, 0.93, d * 0.5);
    let metal = clamp01(c * 0.95 + s * 0.85);
    metal *= 1 - g * 0.4;
    const o = i * 4;
    ormPainted[o] = clamp01(ao[i] * (1 - g * 0.25)) * 255;
    ormPainted[o + 1] = clamp01(rough) * 255;
    ormPainted[o + 2] = clamp01(metal) * 255;
    // Paint has no sheen, so the channel three would read as sheen roughness is
    // free and carries the heat halo for the story shader instead.
    ormPainted[o + 3] = heat[i] * 255;
  }

  // --- ORM, bare/worn ---------------------------------------------------
  // Same treatment, biased toward bare alloy: a stripped plate is honed where it
  // has been rubbed and dull where it has pitted, and that difference is the
  // whole read on an unpainted surface.
  const ormWorn = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = scratch[i];
    const g = grime[i];
    const cav = clamp01((1 - ao[i]) * 1.4);
    let rough =
      0.26 + patch[i] * 0.13 + casting[i] * 0.12 + tooth[i] * 0.07 + machining[i] * 0.06 +
      grain[i] * GRAIN.rough +
      cav * 0.16 + (1 - chip[i]) * 0.05;
    rough -= clamp01(rivet[i]) * 0.14;
    if (bead[i] > 0) rough += Math.sqrt(bead[i]) * 0.15;
    rough = lerp(rough, 0.11, s * 0.88);
    rough = lerp(rough, 0.88, g * 0.82);
    const o = i * 4;
    ormWorn[o] = ao[i] * 255;
    ormWorn[o + 1] = clamp01(rough) * 255;
    ormWorn[o + 2] = clamp01(1 - g * 0.75) * 255;
    ormWorn[o + 3] = heat[i] * 255;
  }

  // --- clearcoat: lacquer survives only where the paint does -------------
  //
  // And it is a *satin* lacquer. The previous bake put **63.7% of this map below
  // 0.10 clearcoat roughness** — a show-car finish on a machine that lives in a
  // scrapyard — over a clearcoat normal whose mean tilt is 2.3 degrees. The
  // result is one uniform near-mirror sheet laid over every plate, and it
  // compresses everything underneath it: measured on a pinned-camera closeup,
  // taking the coat satin raised the low-frequency luminance range of the
  // brightest plate by 45% and lifted every spatial band by 20-50%.
  //
  // `film` is how well the coat has held up in this patch, and it drives the
  // strength and the roughness in opposite directions, because a coat that is
  // thinning is both weaker and rougher.
  const ccPx = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const film = clamp01(0.5 + macro[i] * 0.5 + casting[i] * 0.4 + patch[i] * 0.55);
    const strength = clamp01(
      (0.50 + film * 0.55) * (1 - chip[i]) * (1 - scratch[i] * 0.9) * (1 - grime[i] * 0.9),
    );
    const ccRough = clamp01(
      0.15 + (1 - film) * 0.17 + patch[i] * 0.10 +
      grime[i] * 0.45 + scratch[i] * 0.25 + dust[i] * 0.3,
    );
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

  return { size, maskA, maskB, edgeProx, normalPx, ormPainted, ormWorn, ccPx, emPx };
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
    pit[i] = clamp01(smoothstep(0.19, 0.03, pits.f1[i]) * smoothstep(0.68, 0.86, pits.id[i]));
  }

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    height[i] =
      macro[i] * 0.05 +
      brush[i] * 0.115 +
      grain[i] * 0.038 +
      tooth[i] * 0.006 -
      pit[i] * 0.06 -
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

    // Anisotropy. The vector three wants is the *rough* axis, not the groove
    // axis: micro-grooves only let the normal tilt across themselves, so a
    // brush running along V is rough along U and throws a highlight streaked
    // horizontally — which is why brushed steel with vertical grain shows
    // horizontal banding. Hence a direction near (1,0). A slight per-region
    // rotation keeps it from looking printed on, and the strength collapses
    // wherever pitting or soot has destroyed the microstructure.
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
 *
 * The encode scale is a measured number, not a taste one. At 0.55 this map came
 * out at a **mean tilt of 2.3 degrees and a maximum of 7.9** — that is not a
 * sprayed film, it is a sheet of glass, and it is why the clearcoat lobe on
 * every armour plate was one unbroken sheet no matter what the plate normal
 * underneath it did. Real peel on a panel this size tilts the film several
 * degrees over a few centimetres. `clearcoatNormalScale` on the materials then
 * takes it back down for the finishes that really are close to glass.
 */
function buildOrangePeel(size) {
  const a = fbm(size, { octaves: 3, freq: 8, gain: 0.5, seed: 419 });
  const b = fbm(size, { octaves: 2, freq: 26, gain: 0.5, seed: 421 });
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = a[i] * 0.7 + b[i] * 0.3;
  return { size, normalPx: encodeNormal(h, size, 1.7) };
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
// Plate albedo composition
// ---------------------------------------------------------------------------

/**
 * Reflectance values for the plate albedo, expressed as a multiplier on the
 * material's paint colour rather than as absolute colours.
 *
 * The map is deliberately hue-neutral and the palette hue is carried by
 * `material.color`. That is the only formulation that survives a consumer
 * cloning a material and assigning its own colour — which `RobotBuilder` does,
 * so that one plate bake can serve the primary, secondary and accent parts of
 * a robot — and it means the whole roster shares a single plate albedo instead
 * of paying for one per character.
 *
 * The cost is that a paint chip is tinted by the paint colour instead of
 * showing neutral steel. That matters far less than it sounds: bare metal reads
 * as bare metal because the ORM map drives metalness to 1 and roughness down
 * while the clearcoat map cuts the lacquer away, so a chip catches the rim
 * light and the environment. Albedo is the weakest of the four cues.
 */
const V_PAINT = [0.85, 0.46, 0.64];  // by plate role: primary, secondary, accent
// The secondary step is deliberately not darker than this: on an already very
// dark palette a lower value collapses those plates to black and the panel
// layout stops reading at all.
const V_STRUCTURE = 0.05;            // unpainted frame seen down a panel gap
const V_BARE = 1.0;                  // cast steel where the paint has failed
const V_CUT = 1.0;                   // freshly cut metal in a scratch
const V_GRIME = 0.09;                // oil and carbon soot
const V_DUST = 0.86;                 // settled pale grit

/**
 * Composes the plate albedo from the cached detail masks, in linear light.
 *
 * Plate role sets the base value so the panel layout still reads as designed
 * under a single hue; the panel gap falls to unpainted structure; chips step
 * through a thin primer ring to bare steel; scratches cut bright metal; grime
 * multiplies down into the cavities and dust lifts the upward-facing lips.
 *
 * @param {number} wear      multiplier on the chip mask, >1 strips more paint
 * @param {number} wearFloor baseline wear applied everywhere, for battle-stripped plate
 */
function composePlateAlbedo(detail, wear, wearFloor = 0) {
  const { size, maskA, maskB, edgeProx } = detail;
  const n = size * size;
  const px = new Uint8Array(n * 4);

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

    // Per-plate role, unpacked from (paint + variation) / 3, plus a small value
    // break so no two adjacent plates read as the same sprayed batch.
    //
    // Widening that break was tried and reverted. Band-contrast spectra over
    // single armour plates peak at 16px and roll off above it, where every
    // single-material region of the Tekken 8 reference keeps rising through 32px
    // — which reads as "the plates are short of value range across a part". They
    // are, but this is not the lever: taking the batch jitter from +-14% to
    // +-25% moved the low-frequency term of three separate patches DOWN by
    // 0.8-2.3% on a probe repeatable to 0.3%. The jitter is per *atlas* panel and
    // a robot plate samples one small patch of the atlas, so it varies between
    // plates and barely at all across one. Whatever supplies that band, it is not
    // here.
    const t3 = pid * 3;
    const role = t3 < 1 ? 0 : t3 < 2 ? 1 : 2;
    let v = V_PAINT[role] * (0.87 + (t3 - role) * 0.28) * (0.82 + mottle * 0.36);

    // Panel lines and louvre depth. Shallow gaps are darkened paint rather than
    // black lines, but the floor of a gap is unpainted structure: converging on
    // a constant there is both physically right and what makes a groove read
    // the same from either of the two plates that share it.
    v = lerp(v * (1 - cav * 0.42), V_STRUCTURE, smoothstep(0.5, 1.0, cav));

    // Layered edge wear: paint -> thin primer ring -> bare steel.
    const w = clamp01(chip * wear + wearFloor * (0.55 + grm * 0.45));
    const primer = smoothstep(0.08, 0.55, w) * (1 - smoothstep(0.58, 0.94, w));
    v = lerp(v, V_BARE, w);
    // The dark primer ring is what makes a chip read as a chip and not as a
    // highlight: bare steel is only legible when something separates it from
    // the paint it broke out of.
    v = lerp(v, v * 0.42, primer * 0.9);

    v = lerp(v, V_CUT, clamp01(scr * (0.34 + wear * 0.34)));
    v = lerp(v, v * 0.25 + V_GRIME, clamp01(grm * 0.9));
    v = lerp(v, V_DUST, dst * 0.6);

    // A touch of the baked cavity term in the diffuse keeps plates reading as
    // separate objects even under flat fill light.
    const b = encodeSrgb(v * (0.55 + ao * 0.45) + dither(i));
    px[o] = b;
    px[o + 1] = b;
    px[o + 2] = b;
    // Alpha is not opacity here — these materials never blend. It carries panel
    // edge proximity for the story shader, which is the only spare channel on
    // the albedo and the cheapest possible way to get the mask to the GPU.
    px[o + 3] = edgeProx[i];
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
  const grunge = cachedDetail(`grunge:${sizes.grunge}`, () => buildGrungeDetail(sizes.grunge));

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
    plateAlbedo: t(composePlateAlbedo(plate, 1.35, 0.06), plate.size, 1, { srgb: true }),
    plateAlbedoTrim: t(composePlateAlbedo(plate, 1.0), plate.size, 2, { srgb: true }),
    plateAlbedoWorn: t(composePlateAlbedo(plate, 2.4, 0.45), plate.size, 2, { srgb: true }),
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
    peelNormal: t(peel.normalPx, peel.size, 1, { repeat: PEEL_REPEAT }),
    glassNormal: t(glass.normalPx, glass.size, 1),
    glassOrm: t(glass.orm, glass.size, 1),
    // Sampled triplanar in object space, never through the model UVs, so it must
    // keep its full resolution: it is magnified over ~1.3m of body, not tiled.
    grunge: t(grunge.px, grunge.size, 1, { maxAniso: 4 }),
  };
  SHARED_CACHE.set(key, s);
  return s;
}

// ---------------------------------------------------------------------------
// Surface story
//
// The plate bake is projected through the model's authored UVs. On a robot
// assembled from rigid plates those UVs are per-plate and origin-centred, so
// every plate samples very nearly the same patch of the same texture: forty
// panels wearing one identical surface. No amount of detail in that bake can
// fix it, because the problem is the projection, not the content.
//
// So the octave that carries the character's history — paint fade, coolant
// runs, oxidation creeping out of the panel gaps, heat staining round the
// vents, sprayed unit markings — is sampled triplanar in *object space*
// instead. Where a plate sits on the body then decides how it has aged, the
// story crosses panel boundaries the way real weathering does, and the tile is
// magnified over a metre of body so its 2-10cm features land exactly in the
// band a closeup reads.
//
// It rides on the stock physical shader through three small injections, and it
// costs three texture fetches; every mask it needs from the plate bake is
// already in a channel that was being uploaded as a constant 255.
// ---------------------------------------------------------------------------

const STORY_PARS_VERTEX = /* glsl */`
attribute vec4 plateFrame;
attribute vec4 plateSeed;
attribute vec4 plateLayout;
varying vec3 vKbObjPos;
varying vec3 vKbObjNrm;
varying vec4 vKbFrame;
varying vec4 vKbSeed;
varying vec4 vKbLayout;
`;

const STORY_PARS_FRAGMENT = /* glsl */`
uniform sampler2D kbGrungeMap;
uniform float kbGrungeScale;
uniform vec4 kbStory;      // grime, oxide, fade, marking
uniform vec4 kbStoryB;     // bare-metal neutralisation, heat, dust, plate masks
uniform vec4 kbSurface;    // form curvature scale, micro curvature scale, hollow, seam
uniform vec4 kbSurfaceB;   // burnish, direct occlusion, occlusion sharpness, polish
uniform vec4 kbLattice;    // panel lattice: strength, gap half-width, occlusion reach, panel span
uniform vec3 kbSootColor;
uniform vec3 kbOxideColor;
uniform vec3 kbHeatColor;
uniform vec3 kbSteelColor;
uniform vec3 kbInkLight;
uniform vec3 kbInkDark;
varying vec3 vKbObjPos;
varying vec3 vKbObjNrm;
varying vec4 vKbFrame;
varying vec4 vKbSeed;
varying vec4 vKbLayout;

// The three projections are flipped to face outward, or every stencil on the
// far half of the body would come out mirrored — the one artefact that gives a
// triplanar projection away instantly. V stays object +Y on the side planes so
// the streak channel still runs downhill.
vec4 kbTriplanar( sampler2D t, vec3 p, vec3 n, vec3 w, float s ) {
	vec3 f = vec3( n.x < 0.0 ? 1.0 : -1.0, n.y < 0.0 ? 1.0 : -1.0, n.z < 0.0 ? -1.0 : 1.0 );
	return texture2D( t, vec2( p.z * f.x, p.y ) * s ) * w.x
		+ texture2D( t, vec2( p.x, p.z * f.y ) * s ) * w.y
		+ texture2D( t, vec2( p.x * f.z, p.y ) * s ) * w.z;
}
`;

const STORY_BODY_FRAGMENT = /* glsl */`
vec3 kbN = normalize( vKbObjNrm );
vec3 kbA = abs( kbN );
vec3 kbW = kbA * kbA * kbA;
kbW /= max( kbW.x + kbW.y + kbW.z, 1e-4 );
vec4 kbG = kbTriplanar( kbGrungeMap, vKbObjPos, kbN, kbW, kbGrungeScale );

// Masks the plate bake already carries in channels three would otherwise
// ignore: albedo alpha is panel-edge proximity, ORM alpha is the heat halo.
float kbEdge = 0.4;
float kbHeatM = 0.0;
float kbCavity = 0.0;
#ifdef USE_MAP
	kbEdge = mix( kbEdge, sampledDiffuseColor.a, kbStoryB.w );
#endif
#ifdef USE_ROUGHNESSMAP
	kbCavity = clamp( ( 1.0 - texelRoughness.r ) * 1.6, 0.0, 1.0 );
	kbHeatM = texelRoughness.a * kbStoryB.w;
#endif
diffuseColor.a = 1.0;

float kbUp = clamp( kbN.y, 0.0, 1.0 );
float kbDown = clamp( - kbN.y, 0.0, 1.0 );
float kbSide = 1.0 - kbA.y;

// Where the ORM says the paint has failed, the diffuse is still the paint
// colour, because the bake is hue-neutral and tinted per character. Steel is
// not orange: pull the exposed metal back to a neutral alloy so an edge chip
// reads as an edge chip instead of as a bright spot of the same paint.
float kbBare = clamp( metalnessFactor * kbStoryB.x, 0.0, 1.0 );
float kbLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
diffuseColor.rgb = mix( diffuseColor.rgb, kbSteelColor * ( 0.3 + 1.5 * kbLum ), kbBare );

// Paint fade. The broad value break that stops forty plates reading as one
// sprayed batch. The gloss break matters more than the value break: under a hot
// key light a change in roughness is far more legible than a change in albedo,
// and a weathered lacquer varies in gloss long before it varies in colour.
//
// The comment above used to say that and the code did the opposite — a 0.44 to
// 1.22 multiplier on albedo, a 2.8x swing, against +-0.33 of roughness — at the
// grunge tile's 10-30cm wavelength. On a closeup that reads as spilled liquid
// smeared over the machine rather than as tired paint, and it buys nothing:
// measured on a pinned-camera probe, running the fade term alone against no
// story at all moved the 16px and 32px band contrast of an armour plate by less
// than the 2-3% session noise floor. The mid-scale structure the plate actually
// needs comes from grime, oxidation and the markings, not from this. So the
// value swing is tightened to something a fading topcoat really does and the
// gloss swing, which is the half that was doing the work, is opened up.
diffuseColor.rgb *= mix( 1.0, 0.74 + 0.44 * kbG.r, kbStory.z );
roughnessFactor = clamp( roughnessFactor + ( 0.52 - kbG.r ) * 0.86 * kbStory.z, 0.04, 1.0 );

// Oxidation, gated on proximity to a panel gap: rust starts at an edge where
// water sits, never in the middle of an unbroken plate.
float kbOx = smoothstep( 0.26, 0.78, kbG.b * ( 0.35 + 1.3 * kbEdge ) ) * kbStory.y;
diffuseColor.rgb = mix( diffuseColor.rgb, kbOxideColor * ( 0.5 + 0.9 * kbG.r ), kbOx );
roughnessFactor = mix( roughnessFactor, 0.94, kbOx * 0.85 );
metalnessFactor = mix( metalnessFactor, 0.08, kbOx * 0.8 );

// Grime: pooled in the cavities, run down the vertical faces under gravity,
// settled thickest where a seam has been leaking, sooty on the undersides.
float kbRun = kbG.g * kbSide * ( 0.45 + 1.1 * kbEdge );
float kbGrime = clamp( kbCavity * 1.1 + kbRun + kbDown * kbG.r * 0.6, 0.0, 1.0 ) * kbStory.x;
diffuseColor.rgb = mix( diffuseColor.rgb, kbSootColor * ( 0.45 + 0.8 * kbG.r ), kbGrime * 0.9 );
roughnessFactor = mix( roughnessFactor, 0.92, kbGrime * 0.78 );
metalnessFactor *= 1.0 - kbGrime * 0.5;

// Heat staining ringing every vent and light strip.
float kbHeat = clamp( kbHeatM * ( 0.5 + 0.75 * kbG.r ) * kbStoryB.y, 0.0, 1.0 );
diffuseColor.rgb = mix( diffuseColor.rgb, kbHeatColor, kbHeat * 0.85 );
roughnessFactor = mix( roughnessFactor, 0.44, kbHeat * 0.5 );

// Pale grit on the up-facing lips, which is what separates a top surface from
// a side surface when the key light is doing nothing to help.
float kbDust = kbUp * smoothstep( 0.42, 0.95, kbG.r ) * kbStoryB.z;
diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.20, 0.19, 0.17 ), kbDust * 0.55 );
roughnessFactor = mix( roughnessFactor, 0.96, kbDust * 0.6 );

// Sprayed markings, worn back by everything that landed on top of them.
float kbInkL = smoothstep( 0.56, 0.78, kbG.a );
float kbInkD = smoothstep( 0.44, 0.22, kbG.a );
float kbMark = clamp( ( kbInkL + kbInkD ) * kbStory.w * ( 1.0 - kbGrime * 0.55 ) * ( 1.0 - kbOx * 0.85 ) * ( 1.0 - kbBare * 0.8 ), 0.0, 1.0 );
diffuseColor.rgb = mix( diffuseColor.rgb, kbInkL > kbInkD ? kbInkLight : kbInkDark, kbMark );
roughnessFactor = mix( roughnessFactor, 0.6, kbMark );
metalnessFactor *= 1.0 - kbMark * 0.9;
`;

/**
 * Form response.
 *
 * Everything in the story layer varies with *where* a texel is. None of it
 * varies with what the surface is doing there, and that is the difference the
 * reference keeps showing: on a real machined part the gloss tracks the form.
 * Paint is thinner on a convex edge and gets rubbed by everything that brushes
 * past, so a lip burnishes. A recess is never touched and collects whatever
 * settles in it, so it dulls. Shading a plate at one roughness from edge to
 * edge is most of what makes it read as a rendered quad with a texture on it,
 * and no amount of extra incident in the texture fixes it, because the eye is
 * reading the specular, not the albedo.
 *
 * Curvature here is the derivative of the shading normal with respect to
 * distance, in 1/metre. Both derivatives are taken in view space, so the screen
 * footprint divides out: a 12mm chamfer measures the same curvature at any
 * distance, any field of view and any output resolution, and the micro term
 * falls away on its own as the normal map mips down — which is the correct
 * behaviour, not a compromise.
 *
 *   kbRoll    unsigned, from the geometric normal only, so it sees the rolled
 *             chamfers and nothing the normal map put there. This is the term
 *             that gives a chamfer a highlight which travels along the arc.
 *   kbCrown   signed positive, from the shading normal: lips, rivet crowns,
 *             weld beads, the proud side of a plate step.
 *   kbHollow  signed negative: panel gaps, louvre slats, scratch troughs.
 */
const STORY_FORM_FRAGMENT = /* glsl */`
vec3 kbVx = dFdx( vViewPosition );
vec3 kbVy = dFdy( vViewPosition );
float kbInvFoot = 1.0 / max( dot( kbVx, kbVx ) + dot( kbVy, kbVy ), 1e-9 );
vec3 kbGx = dFdx( nonPerturbedNormal );
vec3 kbGy = dFdy( nonPerturbedNormal );
vec3 kbSx = dFdx( normal );
vec3 kbSy = dFdy( normal );
float kbForm = sqrt( ( dot( kbGx, kbGx ) + dot( kbGy, kbGy ) ) * kbInvFoot );
// vViewPosition is the negated view-space position, hence the sign.
float kbMean = - ( dot( kbSx, kbVx ) + dot( kbSy, kbVy ) ) * kbInvFoot;
float kbRoll = 1.0 - exp( - kbForm * kbSurface.x );
float kbCrown = 1.0 - exp( - max( kbMean, 0.0 ) * kbSurface.y );
float kbHollow = 1.0 - exp( - max( - kbMean, 0.0 ) * kbSurface.y );

// A rolled edge is polished by everything that brushes past it and its paint
// is thin over the arc, so the lacquer tightens, the roughness drops and bare
// alloy starts to show at the crown. This is what turns a chamfer from a
// shading artefact into a machined edge.
float kbPolish = kbRoll * ( 0.35 + 0.65 * kbCrown ) * kbSurfaceB.w;
// The floor is deliberately not tight. A chamfer is a one-pixel feature at
// fighting range and driving it to mirror roughness there buys a sparkle that
// aliases rather than a highlight that travels.
roughnessFactor = clamp( roughnessFactor * ( 1.0 - 0.42 * kbPolish ), 0.06, 1.0 );
float kbBurn = clamp( kbPolish * kbSurfaceB.x * ( 1.0 - kbGrime * 0.7 ), 0.0, 1.0 );
diffuseColor.rgb = mix( diffuseColor.rgb, kbSteelColor * ( 0.35 + 1.3 * dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), kbBurn * 0.7 );
metalnessFactor = mix( metalnessFactor, 1.0, kbBurn * 0.6 );

// Hollows do the opposite. A groove whose two walls differ only in normal reads
// as a line drawn on a flat plate; a groove whose walls also lose gloss and
// value reads as a groove with a floor somewhere below them.
float kbHol = kbHollow * kbSurface.z;
roughnessFactor = clamp( roughnessFactor + 0.34 * kbHol, 0.06, 1.0 );
diffuseColor.rgb *= 1.0 - 0.32 * kbHol;

// Metres per pixel at this fragment, from the same view-space footprint the
// curvature terms measure with. Every gap below is authored in millimetres, and
// a 4mm feature is sub-pixel at fighting range: without this it would shimmer
// its way across the plate instead of fading into the surface tone.
float kbPx = sqrt( 1.0 / kbInvFoot );

// Plate perimeter. The plateFrame attribute carries the vertex's coordinate on
// its own face and that face's half-extents, both in metres, so this seam lands
// on the plate's real boundary instead of wherever the shared atlas happened to
// draw one. The ramp is clamped to a fifth of the smallest half-extent: a 4cm
// greeble outlined on all four sides by shading meant to bed a 40cm chest plate
// into its frame stops reading as metal and starts reading as quilting.
//
// The halo is the half that makes it a gap rather than a stripe. A line of
// uniform darkness on an otherwise flat plate is a line painted on the plate;
// what says "there is a recess here" is the gradient beside it, where the plate
// is still lit but progressively less of the room can reach it.
float kbSeam = 0.0;
float kbSeamH = 0.0;
if ( vKbFrame.z > 0.0 && vKbFrame.w > 0.0 ) {
	vec2 kbToEdge = vKbFrame.zw - abs( vKbFrame.xy );
	float kbSeamW = min( 0.011, min( vKbFrame.z, vKbFrame.w ) * 0.2 );
	float kbEdgeD = min( kbToEdge.x, kbToEdge.y );
	kbSeam = 1.0 - smoothstep( 0.0, max( kbSeamW, kbPx ), kbEdgeD );
	kbSeamH = ( 1.0 - smoothstep( kbSeamW, kbSeamW * 3.0, kbEdgeD ) ) * ( 1.0 - kbSeam );
}
kbSeam *= kbSurface.w;
kbSeamH *= kbSurface.w;

// The plate's own panel plan, written per-vertex by RobotBuilder.
//
//   .x  panel pitch in centimetres; 0 means this part is not made of panels
//   .y  panel gap in tenths of a millimetre
//   .z  fraction of the perimeter that is a free ground edge, not a butted joint
//   .w  flags; bit 0 asks for a fastener row
//
// This is the half of the surfacing problem the shader cannot solve on its own.
// plateFrame tells it where the plate ends; only the builder knows what the
// plate IS. A hydraulic rod, a rubber boot and a structural frame member are
// turned, moulded and welded respectively and none of them has a panel gap on
// it — and until this attribute was read, all three were divided at the same
// roster-wide pitch as a chest deck, which is precisely the "patterned sheet
// metal, not designed machinery" the critic named. A part with no plan reads
// the generic attribute, which is zero pitch: no panels, which is the right
// answer for anything the builder never described.
float kbPitch = vKbLayout.x * 0.01;
float kbGapW = max( vKbLayout.y * 0.0001, 0.0008 );
float kbRim = vKbLayout.z * ( 1.0 / 255.0 );

// Perimeter, split by what is on the other side of it.
//
// A butted joint holds shadow: two plates approach, nothing gets in between,
// and the line is the darkest thing on the part. A free ground edge does the
// opposite — it is bare rolled alloy that every passing surface polishes, and
// it is the brightest line on the part. Shading both the same way is what makes
// a stack of pauldron lames read as one quilted lump instead of as five
// pressings laid over each other, and the geometry cannot tell them apart: the
// shader can see where a plate ends, not whether something is sitting there.
// A part narrower than a couple of pixels cannot show a rim: the perimeter ramp
// widens to one pixel as the plate shrinks, so at that size the *whole* plate
// would be rim and a bracket would turn into a chip of bare alloy. Fading the
// bright half out as the plate approaches pixel scale leaves the surface tone,
// which is what a part that small should contribute. The dark half needs no such
// guard — a plate fading toward its own shadow is the correct limit.
float kbLipFade = smoothstep( 1.2, 3.0, min( vKbFrame.z, vKbFrame.w ) / max( kbPx, 1e-5 ) );
float kbLip = kbSeam * kbRim * kbLipFade;
float kbJoint = kbSeam * ( 1.0 - kbRim * kbLipFade );
float kbHaloJ = kbSeamH * ( 1.0 - kbRim );
diffuseColor.rgb *= 1.0 - 0.34 * kbJoint - 0.13 * kbHaloJ;
float kbLipLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
diffuseColor.rgb = mix( diffuseColor.rgb, kbSteelColor * ( 0.34 + 1.25 * kbLipLum ), kbLip * 0.62 * ( 1.0 - kbGrime * 0.6 ) );
roughnessFactor = clamp( roughnessFactor + 0.18 * kbJoint + 0.06 * kbHaloJ - 0.28 * kbLip, 0.06, 1.0 );
metalnessFactor = mix( metalnessFactor, 1.0, kbLip * 0.55 );

// Panel lattice.
//
// The plate bake is one atlas shared by the whole roster, so a groove in it has
// no relation to the part it lands on: a chest plate and a wrist bracket wear
// the same cell at the same pitch, and forty of them read as patterned sheet
// rather than as parts somebody laid out. This divides the plate's OWN face —
// the bounds RobotBuilder measured and handed down in plateFrame — into a
// handful of panels at the pitch the builder chose FOR THIS PART, so a groove
// falls where a panel edge would really be on it and scales with it.
//
// An axis is only divided if it is long enough to carry a panel, and the count
// is capped: a 1.4m back plate cut at a fixed pitch is a brick wall again. The
// phase comes off the plate hash so the division is not symmetric about the
// centre, which is the giveaway of a generated grid.
float kbLat = 0.0;
float kbLatH = 0.0;
float kbLatL = 0.0;
float kbBolt = 0.0;
if ( kbLattice.x > 0.0 && kbPitch > 0.0 && vKbFrame.z > 0.0 && vKbFrame.w > 0.0 ) {
	vec2 kbSpan = vKbFrame.zw * 2.0;
	vec2 kbCells = min( floor( kbSpan / ( kbPitch * kbLattice.w ) ), vec2( 4.0 ) );
	vec2 kbT = vKbFrame.xy / vKbFrame.zw * 0.5 + 0.5;
	vec2 kbF = fract( kbT * kbCells + vKbSeed.xy * 0.5 );
	vec2 kbD = ( 0.5 - abs( kbF - 0.5 ) ) * kbSpan / max( kbCells, vec2( 1.0 ) );
	// An axis with no room for a panel is pushed out of range rather than
	// clamped to one division, or every narrow lame gets a line down its middle.
	kbD = mix( vec2( 1e3 ), kbD, step( 1.0, kbCells ) );
	float kbDm = min( kbD.x, kbD.y );
	float kbGw = kbGapW;
	float kbFe = max( kbGw * 0.6, kbPx * 0.8 );
	kbLat = 1.0 - smoothstep( kbGw - kbFe, kbGw + kbFe, kbDm );
	kbLatH = ( 1.0 - smoothstep( kbGw, kbGw * ( kbLattice.z / max( kbLattice.y, 1e-4 ) ), kbDm ) ) * ( 1.0 - kbLat );
	// The rolled lip either side of the gap. A panel edge is broken by the press
	// and then rubbed by everything that passes it, so it holds a tighter
	// highlight than the field does — and it is that pair of bright lines either
	// side of a dark one, not the dark one alone, that reads as two plates.
	kbLatL = smoothstep( kbGw * 1.3, kbGw * 2.1, kbDm ) * ( 1.0 - smoothstep( kbGw * 2.1, kbGw * 3.4, kbDm ) );
	kbLat *= kbLattice.x;
	kbLatH *= kbLattice.x;
	kbLatL *= kbLattice.x * ( 1.0 - kbGrime * 0.6 );
	diffuseColor.rgb *= 1.0 - 0.58 * kbLat - 0.17 * kbLatH;
	roughnessFactor = clamp( roughnessFactor + 0.30 * kbLat + 0.09 * kbLatH - 0.13 * kbLatL, 0.06, 1.0 );
	metalnessFactor *= 1.0 - 0.35 * kbLat;

	// Fastener row, when the builder asked for one. Real panels are held at
	// their edges, so the studs march around the plate's own perimeter at the
	// panel pitch rather than down the middle of the field. They are shading and
	// not geometry on purpose: at fighting range a bolt head is under a pixel,
	// and modelling one costs a dozen triangles apiece across forty plates for
	// something the normal never resolves. A butted edge gets none — you cannot
	// reach a fastener that another plate is sitting on.
	if ( mod( vKbLayout.w, 2.0 ) >= 1.0 ) {
		vec2 kbEdge = vKbFrame.zw - abs( vKbFrame.xy );
		float kbAlong = kbEdge.x < kbEdge.y ? vKbFrame.y : vKbFrame.x;
		float kbInset = min( kbEdge.x, kbEdge.y );
		float kbStep = max( kbPitch * 0.5, 0.03 );
		float kbS = ( fract( kbAlong / kbStep + 0.5 ) - 0.5 ) * kbStep;
		float kbR = max( kbGw * 1.7, kbPx * 0.7 );
		float kbDist = length( vec2( kbS, kbInset - kbR * 2.1 ) );
		kbBolt = ( 1.0 - smoothstep( kbR * 0.65, kbR, kbDist ) ) * kbLattice.x * ( 1.0 - kbRim * 0.85 );
		// Crown polished, base ringed with the shadow the head casts into the plate.
		float kbBoltRing = ( 1.0 - smoothstep( kbR, kbR * 1.5, kbDist ) ) * ( 1.0 - kbBolt );
		roughnessFactor = clamp( roughnessFactor - 0.22 * kbBolt + 0.10 * kbBoltRing, 0.06, 1.0 );
		metalnessFactor = mix( metalnessFactor, 1.0, kbBolt * 0.7 );
		diffuseColor.rgb = mix( diffuseColor.rgb, kbSteelColor * 0.75, kbBolt * 0.55 );
		diffuseColor.rgb *= 1.0 - 0.20 * kbBoltRing;
	}
}
`;

/**
 * Recess occlusion, applied where it can reach the direct response.
 *
 * three multiplies the occlusion map into indirect light only. That is right
 * for a sky term and wrong for a 3mm panel gap: under a hard key light the gap
 * is precisely the place the key cannot reach, and leaving it fully lit is what
 * turns a recess into a dark line painted onto a flat plate. This is the
 * standard microshadow — the same baked occlusion, sharpened, applied to the
 * direct response — plus the plate's own perimeter, where two plates approach
 * each other and nothing gets in between them.
 */
const STORY_OCCLUSION_FRAGMENT = /* glsl */`
// Only the butted half of the perimeter occludes. A free ground edge has open
// air on the other side of it and shadowing it is what made a stack of lames
// read as one lump — the recess term was being applied to plates that are not
// in a recess.
float kbSeamOcc = clamp( 1.0 - kbJoint * 0.52 - kbHaloJ * 0.19 - kbLat * 0.70 - kbLatH * 0.30, 0.0, 1.0 );
float kbOcc = kbSeamOcc;
#ifdef USE_AOMAP
	kbOcc *= mix( 1.0, pow( clamp( ambientOcclusion, 0.0, 1.0 ), kbSurfaceB.z ), kbSurfaceB.y );
#endif
reflectedLight.directDiffuse *= kbOcc;
reflectedLight.directSpecular *= mix( 1.0, kbOcc, 0.75 );
reflectedLight.indirectDiffuse *= kbSeamOcc;
reflectedLight.indirectSpecular *= mix( 1.0, kbSeamOcc, 0.8 );
`;

const STORY_CLEARCOAT_FRAGMENT = /* glsl */`
#ifdef USE_CLEARCOAT
	// A lacquer that has been through what this plate has been through does not
	// survive evenly, and the patchiness of the coat is most of what reads: a
	// dulled patch next to a glossy one says "weathered" louder than any amount
	// of albedo variation can, because the specular carries far more energy.
	material.clearcoat = saturate( material.clearcoat * ( 0.34 + 0.78 * kbG.r ) * ( 1.0 - kbGrime * 0.82 ) * ( 1.0 - kbOx * 0.95 ) * ( 1.0 - kbMark * 0.55 ) );
	material.clearcoatRoughness = clamp( material.clearcoatRoughness + ( 0.55 - kbG.r ) * 0.45 + kbGrime * 0.35 + kbOx * 0.45 + kbDust * 0.3, 0.0525, 1.0 );
	// The coat follows the form for the same reason the paint under it does: a
	// rolled edge gets polished and a panel gap never gets waxed. Keeping the two
	// lobes in agreement is what stops the chamfer highlight reading as two
	// unrelated specular events stacked on one another.
	material.clearcoatRoughness = clamp( material.clearcoatRoughness * ( 1.0 - 0.55 * kbPolish - 0.3 * kbLatL - 0.35 * kbLip ) + 0.3 * kbHol + 0.24 * kbJoint + 0.3 * kbLat + 0.1 * kbLatH, 0.0525, 1.0 );
	// Paint does not survive a ground edge or a fastener head: both are bare
	// metal by the time the machine has been used, so the lacquer stops there.
	material.clearcoat = saturate( material.clearcoat * ( 1.0 - 0.55 * kbSeam - 0.8 * kbLat - 0.6 * kbBolt ) );
#endif
`;

/** Colours the story layer paints with, in sRGB; every one is a real substance. */
const STORY_INK = {
  soot: 0x151210,   // carbon and oil
  oxide: 0x6b3418,  // iron oxide
  heat: 0x4b382c,   // scorched steel round a vent
  steel: 0xc2c6cb,  // bare cast alloy under failed paint
  light: 0xd8dbdd,  // stencil paint
  dark: 0x14161a,
};

const STORY_DEFAULTS = {
  scale: 0.8,     // grunge tiles per metre of object space
  grime: 1,
  oxide: 1,
  fade: 1,
  marking: 1,
  bare: 0.75,
  heat: 1,
  dust: 0.6,
  plateMasks: true,
  // Form response. `form` and `micro` are the curvature radii, in metres, at
  // which the geometric and the normal-mapped terms reach roughly 63% — 22mm
  // catches a rolled chamfer without touching the barrel of a pauldron, 5mm
  // catches a panel gap wall and a hero scratch without picking up the casting
  // mottle. The rest are strengths.
  form: 0.022,
  micro: 0.005,
  hollow: 1,
  seam: 1,
  burnish: 0.55,
  occlusion: 0.75,
  occlusionPower: 1.7,
  polish: 1,
  // Panel lattice. The pitch and the gap are no longer set here — they come off
  // `plateLayout`, per plate, from RobotBuilder, because a pauldron lame and a
  // chest deck are not made the same way and one number for the whole roster is
  // what made forty plates read as one patterned sheet. What is left global is:
  //
  //   lattice           master strength, 0 disables the whole term
  //   latticeGap        the reference gap the occlusion reach is quoted against
  //   latticeOcclusion  how far the shading out of a gap reaches, at that gap
  //   latticePanel      pitch multiplier over the whole roster, for A/B only
  //
  // 4.5mm is what a panel gap on a machine this size is, and the occlusion out
  // of it reaches about six times that; the shader keeps the ratio and scales it
  // by whatever gap the plate itself asked for.
  lattice: 1,
  latticeGap: 0.0045,
  latticeOcclusion: 0.026,
  latticePanel: 1.0,
};

/**
 * `MeshPhysicalMaterial` with the surface-story layer welded on.
 *
 * It exists as a subclass rather than a bare `onBeforeCompile` assignment
 * because `RobotBuilder` clones these materials to re-tint them, and
 * `Material.copy` does not carry an own-property compile hook across. On the
 * prototype it survives any number of clones, and `copy` brings the per-material
 * story settings with it.
 */
class StoryPhysicalMaterial extends THREE.MeshPhysicalMaterial {
  /**
   * @param {Object} [params] standard MeshPhysicalMaterial parameters, plus
   *   `story`: a partial override of {@link STORY_DEFAULTS} whose `grunge` field
   *   carries the shared object-space grunge texture. Without it the material
   *   compiles as a stock physical material.
   */
  constructor(params = {}) {
    const { story, ...rest } = params;
    super(rest);
    this.kbStory = { ...STORY_DEFAULTS, grunge: null, ...(story || {}) };
  }

  copy(source) {
    super.copy(source);
    if (source.kbStory) this.kbStory = { ...source.kbStory };
    return this;
  }

  /**
   * A material whose grunge map never arrived leaves the shader untouched, so
   * it must not be allowed to share a program with one that patched it — that
   * would bind a story shader to a material carrying none of its uniforms.
   */
  customProgramCacheKey() {
    return this.kbStory?.grunge ? 'kb-story' : 'kb-story-off';
  }

  onBeforeCompile(shader) {
    const s = this.kbStory;
    if (!s || !s.grunge) return;
    const u = shader.uniforms;
    u.kbGrungeMap = { value: s.grunge };
    u.kbGrungeScale = { value: s.scale };
    u.kbStory = { value: new THREE.Vector4(s.grime, s.oxide, s.fade, s.marking) };
    u.kbStoryB = { value: new THREE.Vector4(s.bare, s.heat, s.dust, s.plateMasks ? 1 : 0) };
    u.kbSurface = { value: new THREE.Vector4(s.form, s.micro, s.hollow, s.seam) };
    u.kbSurfaceB = { value: new THREE.Vector4(s.burnish, s.occlusion, s.occlusionPower, s.polish) };
    u.kbLattice = { value: new THREE.Vector4(s.lattice, s.latticeGap, s.latticeOcclusion, s.latticePanel) };
    u.kbSootColor = { value: new THREE.Color(STORY_INK.soot) };
    u.kbOxideColor = { value: new THREE.Color(STORY_INK.oxide) };
    u.kbHeatColor = { value: new THREE.Color(STORY_INK.heat) };
    u.kbSteelColor = { value: new THREE.Color(STORY_INK.steel) };
    u.kbInkLight = { value: new THREE.Color(STORY_INK.light) };
    u.kbInkDark = { value: new THREE.Color(STORY_INK.dark) };

    // Kept so a capture harness can A/B one term at a time without a rebuild.
    this.userData.kbUniforms = u;

    // Object space, captured before skinning, so the weathering is welded to
    // the model the way a baked texture would be and never swims under motion.
    // The three plate attributes are passed straight through: a geometry that
    // carries none of them reads the generic attribute, which is (0,0,0,1), so
    // the frame's zero Z reads as "this part has no face to bound" and the
    // layout's zero X as "this part is not made of panels". Every term then
    // skips it, which is the right answer for a part RobotBuilder never
    // described — the floor, a projectile, anything sharing this material.
    shader.vertexShader = STORY_PARS_VERTEX + shader.vertexShader
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n\tvKbObjNrm = objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvKbObjPos = position;\n\tvKbFrame = plateFrame;\n\tvKbSeed = plateSeed;\n\tvKbLayout = plateLayout;');

    // The whole layer moves down to `normal_fragment_maps`, because the form
    // response needs both normals: the geometric one for the chamfers and the
    // perturbed one for everything the maps put on top of them. Every value it
    // touches — diffuseColor, roughnessFactor, metalnessFactor and the two
    // texel samples — is declared at function scope further up and is still
    // live there.
    shader.fragmentShader = STORY_PARS_FRAGMENT + shader.fragmentShader
      .replace('#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${STORY_BODY_FRAGMENT}\n${STORY_FORM_FRAGMENT}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${STORY_CLEARCOAT_FRAGMENT}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>\n${STORY_OCCLUSION_FRAGMENT}`);
  }
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

/**
 * Authoring resolution per bake.
 *
 * Texel density was measured at a head closeup (1.33 m, 32 deg fov, 1080p =
 * 1415 screen px per metre) as sqrt(uvArea/worldArea) * texSize * repeat:
 *
 *     material     texels/metre   texels per screen pixel
 *     kb.rubber        3120              2.20
 *     kb.armor         2118              1.50
 *     kb.worn          1512              1.07
 *     kb.darkMetal      580              0.41
 *     kb.piston         365              0.26
 *
 * The metal bake looks badly under-sampled there, and raising it to 1024 with
 * `metalOrm`/`metalMod` un-halved does take kb.darkMetal to 1.64 texels/px and
 * kb.piston to 1.03 — a real 4x. **It changes the rendered image by nothing.**
 * Measured on the closeup rig against the pre-change capture, 1px band energy
 * went 3.490 -> 3.418 on the head crop, 2.192 -> 2.176 on the plate crop and
 * 3.034 -> 3.000 on Kestrel: flat to slightly negative, for +14MB of VRAM and
 * 4x the metal bake at load. Reverted.
 *
 * The reason is that darkMetal's 41.6% share of the robot's *surface area* is
 * almost all interior frame hidden under the armour; what fills a closeup is
 * kb.armor, whose maps are already un-halved at 1024. Do not size a bake off its
 * surface-area share — size it off what it covers on screen.
 *
 * --- What the closeup gap actually is -------------------------------------
 *
 * Measured as mean absolute Laplacian-pyramid band energy on the character
 * crop, 1px / 2px / 4px bands, post chain off so the filtering is not in the
 * way. The ratio 1px:4px is the useful number because it survives differences
 * in exposure, albedo and subject brightness:
 *
 *     crop                                  1px    4px   1px:4px
 *     Tekken 8 satin sleeve, in focus       7.32  11.08    0.66
 *     Knockbots STAGE wall, in focus        2.95   4.69    0.63
 *     Knockbots CHARACTER head, in focus    3.99  10.11    0.40
 *     Tekken 8 rock, defocused background   1.89   7.38    0.26
 *
 * The stage and the character are the same frame, the same renderer, the same
 * grade. The stage lands on the reference's in-focus figure; the character does
 * not. So this is not the tone curve, the light rig, the post chain or the
 * capture — all four were tested and none of them moves it:
 *
 *   - Doubling all twelve analytic lights moved the character's p95 by 8%.
 *   - Doubling `envMapIntensity` on every plate material moved it by under 1%.
 *   - Turning the whole post chain off raised 1px energy 18% and left the
 *     1px:4px ratio at 0.40, unchanged.
 *   - Kestrel already reaches p95 234 against the reference's 235, so there is
 *     no tonal ceiling; Vulkan is dark because Vulkan's palette is dark.
 *
 * What the ratio says is that the character's detail is nearly all one size.
 * Its 4px band is 10.11 — *higher* than the reference head's 9.70 — while its
 * 1px band is 69% of it. Panel lines, rivet rows, bevels and the wear blotches
 * all land in that one octave and there is very little underneath them. A
 * single dominant spatial frequency reads as pattern rather than as material,
 * which is the likeliest explanation for two rounds of critics calling the
 * surfaces "empty" while also calling the shapes fine.
 *
 * The work that would move this axis is therefore NOT more surface detail. It
 * is (a) a sub-2px octave on the base roughness of `armor`/`worn` — cast grain,
 * brush lay, dust — and (b) taking energy *out* of the 4-8px band, starting
 * with the wear blotches, which are the loudest thing in a closeup and are
 * placed without reference to the form. Target: 1px:4px >= 0.55 on the
 * character crop with the 4px band no higher than it is now.
 *
 * --- Round 13: half of that held, half of it did not ----------------------
 *
 * First, the harness. Pausing the closeup on a wall-clock delay let the idle
 * pose drift between runs and that is where the quoted 6-9% capture spread came
 * from. Waiting on an exact 60Hz tick count instead (`KB.tick >= t0 + 150`, then
 * freeze) makes the pose bit-identical run to run: sigma on the 1px:4px ratio is
 * **0.0015 over three reboots**, and on 1px energy 0.006. Every A/B below is a
 * single rep and still two orders of magnitude outside noise. Do this before
 * measuring anything on a character again.
 *
 * (a) is wrong about which channel. Grain on the base roughness at +-0.10
 *     absolute — a huge swing — moves 1px energy 4.1% and the ratio 0.399 ->
 *     0.403. The same grain on the *normal* at a four-degree mean tilt moves 1px
 *     energy 39% and the ratio to 0.49. Roughness at this scale only widens a
 *     lobe that is already wide; the normal changes which part of the
 *     environment each texel sees. See {@link GRAIN}, which ships both, and says
 *     so.
 *
 * (b) is wrong about the mechanism and about the magnitude. Ablating every term
 *     that could paint a wear blotch, one at a time, on the frozen closeup:
 *
 *       whole surface-story layer off   1px +4.2%   4px -0.7%   ratio 0.406->0.426
 *       marking / grime / oxide / fade  each within +-5% of 1px, +-4% of 4px
 *       bare-metal, dust, heat, lattice, seam, polish, hollow   likewise
 *       albedo map off                  1px +3.8%   4px +3.4%
 *       clearcoat off                   1px +2.3%   4px -2.2%
 *       metalness map off               1px +12.6%  4px +9.2%
 *       roughness map off               1px -12.7%  4px -10.9%
 *       normal map off                  1px -29.2%  4px -13.3%
 *
 *     Nothing in the weathering owns the 4-8px band. Removing the *entire*
 *     story layer — eleven terms, the most elaborate code in this file — costs
 *     0.7% of the 4px band while visibly changing the image a great deal. The
 *     4px band on a character crop is geometry and lighting: plate silhouettes,
 *     chamfer highlights, the rim against the key. It is not texture, and it
 *     cannot be taken out by editing a bake.
 *
 *     The blotches themselves were traced: they are the `chip` mask arriving
 *     through `metalnessMap` (see the note at the chip loop). They are also not
 *     loud — deleting them *raises* both bands, because a pale mirror patch is
 *     smoother than the paint it replaced.
 *
 * The 0.55 target is not reachable this way. The ratio is monotone in normal-
 * grain amplitude — 0.399 at 0, 0.449 at 0.013, 0.489 at 0.020, 0.538 at 0.035,
 * 0.556 at 0.055 — and the surface reads as pebbled leather from 0.020 up and as
 * hammered hide at 0.035. **The metric and the eye disagree above about 0.45**,
 * and where they disagree the eye is the axis being scored. Shipped at 0.013:
 * ratio 0.449 on the head crop and 0.398 on the torso, from 0.400 and 0.336.
 *
 * What is left, for whoever takes the next swing: `kb.armor` runs at 2118
 * texels/metre, which is 1.13 texels per screen pixel at the closeup framing, so
 * the finest thing the plate bake can express is about two screen pixels and
 * everything above that is out of reach from this atlas by construction. Real
 * 1px content needs a second, independently tiled detail normal sampled in
 * object space — the story shader already does exactly this for the grunge map
 * and could carry one more fetch. That is the untested hypothesis with the most
 * headroom left in it.
 */
function resolveSizes(scale) {
  const q = (n) => Math.max(128, Math.round((n * scale) / 128) * 128);
  return { plate: q(1024), metal: q(512), soft: q(512), carbon: q(512), peel: q(256), grunge: q(1024) };
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

  const primary = hexToLinear(p.primary);
  const secondary = hexToLinear(p.secondary);
  const accent = hexToLinear(p.accent);
  const emissiveColor = new THREE.Color(p.emissive);

  // Every map in the library is character-independent greyscale detail; the
  // whole of a character's identity is these colours. A seventh character costs
  // a handful of materials and no texture memory at all.
  const armorAlbedo = shared.plateAlbedo;
  const trimAlbedo = shared.plateAlbedoTrim;
  const wornAlbedo = shared.plateAlbedoWorn;

  const paintPrimary = linearColor(primary);
  const paintAccent = linearColor(accent);

  // Alloy F0 values. Real metals sit high and near-neutral; the palette only
  // gets to tilt the hue, otherwise a dark character produces black "metal".
  const gunmetal = linearColor(alloy([0.115, 0.122, 0.135], secondary, 0.5));
  const honedSteel = linearColor([0.55, 0.555, 0.565]);
  const chromeAlloy = linearColor(alloy([0.76, 0.765, 0.78], accent, 0.13));
  const wornSteel = linearColor(alloy([0.30, 0.305, 0.315], secondary, 0.28));
  const rubberBase = linearColor(alloy([0.021, 0.022, 0.024], secondary, 0.35));
  const cableBase = linearColor(alloy([0.017, 0.017, 0.019], accent, 0.3));

  // --- materials ---------------------------------------------------------
  // How hard the object-space story runs on each surface is characterisation,
  // not decoration: painted armour carries the most history, a hydraulic rod
  // that slides through a wiper on every step carries almost none.
  const story = (over) => ({ grunge: shared.grunge, ...over });

  const armor = new StoryPhysicalMaterial({
    name: 'kb.armor',
    story: story({}),
    color: paintPrimary,
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

  const trimMat = new StoryPhysicalMaterial({
    name: 'kb.trim',
    story: story({ marking: 0.55, oxide: 0.8, fade: 1.1 }),
    color: paintAccent,
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

  const worn = new StoryPhysicalMaterial({
    name: 'kb.worn',
    story: story({ grime: 1.25, oxide: 1.4, bare: 0.3, marking: 0.4, dust: 0.8, burnish: 0.9 }),
    color: wornSteel,
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
    anisotropy: 0.28,
    anisotropyRotation: 0,
    envMapIntensity: 1.1,
  });

  const darkMetal = new StoryPhysicalMaterial({
    name: 'kb.darkMetal',
    // The frame is unpainted, so there is no paint to fade and no stencil to
    // spray: it only collects what runs down onto it out of the armour above.
    // The frame is a machined billet, not a plate bedded into anything, so the
    // perimeter seam is held back and the burnish is pushed up: bare alloy is
    // exactly what polishes on an edge.
    story: story({
      plateMasks: false, fade: 0.35, marking: 0, oxide: 0.7, bare: 0, grime: 1.15, heat: 0, dust: 0.5,
      seam: 0.45, burnish: 0.8, lattice: 0.45,
    }),
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

  // A rod and a mirror boss carry almost no history — the rod is wiped by its
  // own seal on every stroke — but they do have chamfers, and a chamfer that
  // does not answer the light is the one thing that still reads as a rendered
  // cylinder. They take the form response and nothing else.
  const bareSteel = { plateMasks: false, fade: 0, marking: 0, oxide: 0, bare: 0, heat: 0, lattice: 0 };

  const piston = new StoryPhysicalMaterial({
    name: 'kb.piston',
    story: story({ ...bareSteel, grime: 0.35, dust: 0.15, seam: 0, burnish: 0.5, hollow: 0.6 }),
    color: honedSteel,
    map: shared.metalMod,
    normalMap: shared.metalNormal,
    normalScale: new THREE.Vector2(0.55, 0.55),
    aoMap: shared.metalOrm,
    roughnessMap: shared.metalOrm,
    metalnessMap: shared.metalOrm,
    roughness: 0.5,
    metalness: 1,
    // A drawn and polished rod carries its tool marks along its length, exactly
    // like the frame stock, so the anisotropy axis matches the brush in the
    // shared normal map rather than fighting it. Only the strength differs: a
    // polished rod holds a much tighter, more mirror-like streak.
    anisotropy: 0.85,
    anisotropyRotation: 0,
    anisotropyMap: shared.metalAniso,
    envMapIntensity: 1.25,
  });

  const chrome = new StoryPhysicalMaterial({
    name: 'kb.chrome',
    story: story({ ...bareSteel, grime: 0.25, dust: 0.1, seam: 0.3, burnish: 0.3, hollow: 0.5, lattice: 0.3 }),
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

  const carbon = new StoryPhysicalMaterial({
    name: 'kb.carbon',
    // Lacquered weave sheds almost everything; what it keeps is dust and a
    // little soot in the cavities, which is exactly what sells the lacquer.
    story: story({
      plateMasks: false, fade: 0.25, marking: 0, oxide: 0, bare: 0, grime: 0.5, heat: 0, dust: 0.35,
      seam: 0.5, burnish: 0.12, hollow: 0.7, lattice: 0.5,
    }),
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

  // `ownsTextures` is empty by design: a library owns only its materials, and
  // every map it points at belongs to the shared bundle. It stays in the record
  // so that adding a per-character map later is a one-line change here rather
  // than a leak nobody notices.
  LIB_META.set(lib, { key, refs: 1, ownsTextures: [], materials: Object.values(lib) });
  LIB_CACHE.set(key, lib);
  return lib;
}

/**
 * Releases one reference to a library. The materials are destroyed when the
 * last reference goes; the shared greyscale detail maps survive for the next
 * character and are only freed by `disposeSharedTextures()`.
 *
 * @param {MaterialLibrary} lib
 */
export function disposeMaterialLibrary(lib) {
  const meta = lib && LIB_META.get(lib);
  if (!meta) return;
  if (--meta.refs > 0) return;
  for (const tex of meta.ownsTextures) tex.dispose();
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
  MARKING_CACHE.clear();
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
 * Cell index -> marking, for {@link makeMarkingAtlas}. The order is fixed and
 * matches `RobotBuilder`'s decal enum, so a quad UV'd into cell `n` gets the
 * marking named here. Cells run left to right, top to bottom, 4x4.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const MARKINGS = Object.freeze({
  HAZARD: 0, SERIAL: 1, TRIANGLE: 2, ARROW: 3,
  BARCODE: 4, ROUNDEL: 5, CHEVRON: 6, GAUGE: 7,
  GRID: 8, NAMEPLATE: 9, RIVETS: 10, CAUTION: 11,
  UNIT: 12, NOSTEP: 13, LIFT: 14, ARROWS: 15,
});

/** Draws one atlas cell into the greyscale ink field. Cell space is 0..1 square. */
function drawMarkingCell(ink, size, cell, rng) {
  const C = size >> 2;
  const ox = (cell % 4) * C;
  // Cell 0 is the top-left of the atlas, and V runs up the texture.
  const oy = size - (Math.floor(cell / 4) + 1) * C;
  const pen = stencilPen(ink, size, ox, oy, 0);
  const k = C / 256;
  const R = (v) => Math.round(v * k);
  const px = Math.max(1, R(6));
  switch (cell) {
    case MARKINGS.HAZARD:
      pen.stripes(R(10), R(88), R(236), R(80), R(46), 1);
      break;
    case MARKINGS.SERIAL:
      pen.text('KB', R(18), R(150), px, 1);
      pen.text(`${100 + (rng.int(899) || 0)}-${10 + (rng.int(89) || 0)}`, R(18), R(66), px, 1);
      break;
    case MARKINGS.TRIANGLE:
      pen.warning(R(128), R(40), R(170), R(16), 1);
      break;
    case MARKINGS.ARROW:
      pen.arrow(R(30), R(128), R(150), R(96), 1);
      break;
    case MARKINGS.BARCODE:
      pen.barcode(R(20), R(120), R(216), R(90), 17, 1);
      pen.text(String(100000 + rng.int(899999)), R(20), R(60), px, 1);
      break;
    case MARKINGS.ROUNDEL:
      pen.ring(R(128), R(128), R(104), R(16), 1);
      pen.ring(R(128), R(128), R(58), R(46), 1);
      break;
    case MARKINGS.GAUGE:
      pen.ring(R(128), R(128), R(110), R(12), 1);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        pen.rect(R(128) + Math.round(Math.cos(a) * R(86)) - R(6), R(128) + Math.round(Math.sin(a) * R(86)) - R(6), R(12), R(12), 1);
      }
      break;
    case MARKINGS.GRID:
      for (let i = 0; i <= 4; i++) {
        pen.rect(R(16), R(16) + i * R(56), R(224), R(6), 1);
        pen.rect(R(16) + i * R(56), R(16), R(6), R(224), 1);
      }
      break;
    case MARKINGS.NAMEPLATE:
      pen.rect(R(12), R(96), R(232), R(6), 1);
      pen.rect(R(12), R(158), R(232), R(6), 1);
      pen.text('KNOCKBOTS', R(20), R(112), Math.max(1, R(4)), 1);
      break;
    case MARKINGS.RIVETS:
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) pen.ring(R(40) + i * R(58), R(40) + j * R(58), R(14), R(5), 1);
      break;
    case MARKINGS.CAUTION:
      pen.text('CAUTION', R(14), R(140), Math.max(1, R(5)), 1);
      pen.stripes(R(14), R(80), R(228), R(40), R(30), 1);
      break;
    case MARKINGS.UNIT:
      pen.text(String(10 + rng.int(89)), R(60), R(96), Math.max(1, R(18)), 1);
      break;
    case MARKINGS.NOSTEP:
      pen.text('NO', R(70), R(148), px, 1);
      pen.text('STEP', R(34), R(72), px, 1);
      break;
    case MARKINGS.LIFT:
      pen.text('LIFT', R(48), R(150), px, 1);
      pen.arrow(R(48), R(80), R(110), R(70), 1);
      break;
    default:
      pen.chevron(R(24), R(80), R(56), R(96), R(18), 3, R(14), 1);
      break;
  }
}

const MARKING_CACHE = new Map();

/**
 * A 4x4 atlas of stencil markings — unit numbers, hazard chevrons, arrows,
 * warning triangles, roundels — for `RobotBuilder` to place as decal quads.
 * Index the cells through {@link MARKINGS}; cell `n` occupies
 * `u = [n%4, n%4+1] / 4`, `v = [3 - floor(n/4), 4 - floor(n/4)] / 4`, and a
 * consumer should inset a texel or two so bilinear filtering cannot bleed
 * between neighbours.
 *
 * The atlas is RGBA with a real alpha channel, so it belongs on a transparent,
 * depth-write-off decal quad laid a millimetre proud of its plate. RGB is the
 * ink colour and is palette-driven; alpha is coverage.
 *
 * @param {THREE.WebGLRenderer|null} renderer used only for the anisotropy cap
 * @param {{accent?:number|string, trim?:number|string}} [palette]
 * @param {{resolution?:number}} [opts] scales the atlas, 1 = 1024 (256 per cell)
 * @returns {THREE.DataTexture} cached and shared; do not dispose it directly
 */
export function makeMarkingAtlas(renderer, palette = DEFAULT_PALETTE, opts = {}) {
  const p = { ...DEFAULT_PALETTE, ...(palette || {}) };
  const size = Math.max(256, Math.round((1024 * (opts.resolution ?? 1)) / 256) * 256);
  const key = `${size}_${(p.accent >>> 0).toString(16)}_${(p.trim >>> 0).toString(16)}`;
  const hit = MARKING_CACHE.get(key);
  if (hit) return hit;

  let maxAniso = 8;
  try {
    const cap = renderer?.capabilities?.getMaxAnisotropy?.();
    if (Number.isFinite(cap) && cap > 0) maxAniso = Math.min(16, cap);
  } catch { /* headless: default */ }

  const n = size * size;
  const ink = new Float32Array(n);
  const rng = new Rng(0x5eed09);
  for (let cell = 0; cell < 16; cell++) drawMarkingCell(ink, size, cell, rng);
  // One texel of softening: a decal is magnified far harder than a tiling map,
  // and a raw rasterised edge crawls badly under a moving camera.
  const soft = boxBlurWrap(ink, size, Math.max(1, Math.round(size / 900)));

  // Hazard and caution are painted in the character's accent; everything else
  // is stencil paint, so the markings still read as one applied system.
  const accent = hexToLinear(p.accent);
  const trim = hexToLinear(p.trim);
  const grit = fbm(size, { octaves: 3, freq: 40, gain: 0.5, seed: 733 });
  const px = new Uint8Array(n * 4);
  const cellsInAccent = new Set([MARKINGS.HAZARD, MARKINGS.CAUTION, MARKINGS.TRIANGLE]);
  const C = size >> 2;
  for (let y = 0; y < size; y++) {
    const cy = 3 - ((y / C) | 0);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const cell = cy * 4 + ((x / C) | 0);
      const c = cellsInAccent.has(cell) ? accent : trim;
      // The spray is thin where the grit says so, which is what stops a decal
      // reading as a sticker.
      const a = clamp01(soft[i] * (0.72 + grit[i] * 0.85));
      const o = i * 4;
      px[o] = encodeSrgb(c[0]);
      px[o + 1] = encodeSrgb(c[1]);
      px[o + 2] = encodeSrgb(c[2]);
      px[o + 3] = a * 255;
    }
  }

  const tex = markShared(makeTexture(px, size, { srgb: true, maxAniso }));
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  MARKING_CACHE.set(key, tex);
  return tex;
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
