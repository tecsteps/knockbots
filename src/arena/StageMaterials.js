/**
 * Knockbots — the arena's tiling PBR material library.
 *
 * Every surface in the hangar that is not the floor is drawn with one of these
 * eight sets, and every set is generated from the same handful of noise fields
 * so the whole place looks like it was built by one contractor out of one
 * batch of steel.
 *
 * Two rules the arena is surfaced by:
 *
 *   - **Value range is reserved for the fighters.** The set sits between about
 *     0.02 and 0.18 in linear albedo. Nothing in the mid-ground is allowed to
 *     approach the brightness of a lit armour plate, because the moment it does
 *     the silhouette stops reading. Contrast in the environment comes from the
 *     practicals and from specular, never from albedo.
 *   - **Wear runs downhill.** Grime accumulates below horizontals, rust weeps
 *     from fastener rows, and paint chips at edges. All three are driven by the
 *     same vertical streak field, so a wall, a girder and a container all look
 *     like they have been standing in the same damp room for thirty years.
 *
 * Maps are packed on the glTF convention (R=AO, G=roughness, B=metalness) so a
 * single texture serves `aoMap`, `roughnessMap` and `metalnessMap`.
 */

import * as THREE from 'three';
import {
  fbm, worley, blur, clamp01, lerp, smoothstep, hexToLinear,
  heightToNormal, heightToAo, packOrm, bakeAlbedo, makeTexture, makeAlpha,
  noiseTexture, radialSprite, stampText, sampleWrap, encodeSrgb,
} from './ProcTex.js';

/** Vertical streak field: the shared basis for every kind of weathering. */
function streakField(size, seed, stretch = 7) {
  const f = new Float32Array(size * size);
  const base = fbm(size, 26, { octaves: 4, seed });
  const fine = fbm(size, 90, { octaves: 3, seed: seed + 11 });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Sampling the same noise with a squashed vertical coordinate is what
      // turns blobs into runs without a separate directional blur pass.
      const a = sampleWrap(base, size, i, j / stretch);
      const b = sampleWrap(fine, size, i, j / (stretch * 2.2));
      f[j * size + i] = clamp01(a * 0.7 + b * 0.4 - 0.12);
    }
  }
  return f;
}

/** Straight grooves on a grid, written into a height field. */
function scribeGrid(height, size, cellsX, cellsY, depth, width) {
  const w = width * size;
  for (let j = 0; j < size; j++) {
    const gy = ((j / size) * cellsY) % 1;
    const dy = Math.min(gy, 1 - gy) * (size / cellsY);
    const fy = 1 - smoothstep(0, w, dy);
    for (let i = 0; i < size; i++) {
      const gx = ((i / size) * cellsX) % 1;
      const dx = Math.min(gx, 1 - gx) * (size / cellsX);
      const fx = 1 - smoothstep(0, w, dx);
      height[j * size + i] -= depth * Math.max(fx, fy);
    }
  }
}

/** Hemispherical fastener heads on a grid, written into a height field. */
function studGrid(height, size, cols, rows, radius, amount, offset = 0) {
  const r = radius * size;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const px = ((cx + 0.5 + (cy % 2) * offset) / cols) * size;
      const py = ((cy + 0.5) / rows) * size;
      const i0 = Math.floor(px - r - 1), i1 = Math.ceil(px + r + 1);
      const j0 = Math.floor(py - r - 1), j1 = Math.ceil(py + r + 1);
      for (let j = j0; j <= j1; j++) {
        const jj = ((j % size) + size) % size;
        for (let i = i0; i <= i1; i++) {
          const ii = ((i % size) + size) % size;
          const d = Math.hypot(i - px, j - py) / r;
          if (d >= 1) continue;
          height[jj * size + ii] += amount * Math.sqrt(1 - d * d) * (1 - smoothstep(0.82, 1, d));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Painted structural steel — gantries, railings, machinery housings
// ---------------------------------------------------------------------------

function paintedSteelSet(size, seed) {
  const grain = fbm(size, 200, { octaves: 3, seed });
  const macro = fbm(size, 7, { octaves: 4, seed: seed + 3 });
  const streaks = streakField(size, seed + 5);
  const { f1: cellF1 } = worley(size, 12, seed + 9, 0.9);
  const scratch = fbm(size, 340, { octaves: 2, seed: seed + 13, ridged: true });

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) height[k] = grain[k] * 0.16 + macro[k] * 0.1;
  scribeGrid(height, size, 2, 2, 0.55, 0.006);
  studGrid(height, size, 8, 8, 0.006, 0.3, 0.5);

  // Paint survives on flats and fails at edges, at fasteners and where water
  // has been running. `chip` is that failure, and it drives every channel.
  const chipRaw = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const edge = smoothstep(0.62, 0.95, 1 - cellF1[k]);
    chipRaw[k] = clamp01(
      smoothstep(0.55, 0.9, macro[k] * 0.55 + streaks[k] * 0.75) * 0.9 +
      edge * 0.5 + smoothstep(0.72, 0.98, scratch[k]) * 0.55,
    );
  }
  const chip = blur(chipRaw, size, 1, 1);

  const ao = heightToAo(height, size, 5, 1.1);
  const normal = heightToNormal(height, size, 2.6, { wrap: true });

  const paint = hexToLinear(0x3a4149);
  const paintDark = hexToLinear(0x232830);
  const steel = hexToLinear(0x6e6f6c);
  const grime = hexToLinear(0x181513);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const c = chip[k];
    const dirt = clamp01(streaks[k] * 0.85 + macro[k] * 0.3 - 0.15);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(paint[ch], paintDark[ch], macro[k] * 0.7 + grain[k] * 0.3);
      v = lerp(v, steel[ch] * (0.65 + grain[k] * 0.5), c);
      v = lerp(v, grime[ch], dirt * 0.42);
      out[ch] = v * (0.86 + ao[k] * 0.14);
    }
  });

  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const dirt = clamp01(streaks[k] * 0.8 - 0.1);
    rough[k] = clamp01(lerp(0.52, 0.31, chip[k]) + dirt * 0.22 + grain[k] * 0.06);
    metal[k] = clamp01(lerp(0.35, 0.95, chip[k]) * (1 - dirt * 0.4));
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, metal, size) };
}

// ---------------------------------------------------------------------------
// Dark machined steel — trusses, frames, the machinery wall
// ---------------------------------------------------------------------------

function darkMetalSet(size, seed) {
  const brush = new Float32Array(size * size);
  const src = fbm(size, 260, { octaves: 3, seed });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) brush[j * size + i] = sampleWrap(src, size, i / 12, j);
  }
  const pit = worley(size, 46, seed + 4, 1.0).f1;
  const macro = fbm(size, 5, { octaves: 4, seed: seed + 7 });
  const streaks = streakField(size, seed + 8, 9);

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    height[k] = brush[k] * 0.09 + macro[k] * 0.08 - smoothstep(0.34, 0, pit[k]) * 0.5;
  }
  scribeGrid(height, size, 1, 1, 0.65, 0.008);
  studGrid(height, size, 4, 4, 0.009, 0.36, 0.5);

  const ao = heightToAo(height, size, 5, 1.25);
  const normal = heightToNormal(height, size, 2.2, { wrap: true });

  const steel = hexToLinear(0x24272c);
  const dark = hexToLinear(0x13151a);
  const oil = hexToLinear(0x0d0c0b);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const b = brush[k];
    const dirt = clamp01(streaks[k] * 0.9 - 0.1);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(dark[ch], steel[ch], b * 0.75 + macro[k] * 0.35);
      v = lerp(v, oil[ch], dirt * 0.5);
      out[ch] = v * (0.82 + ao[k] * 0.18);
    }
  });

  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const dirt = clamp01(streaks[k] * 0.9 - 0.1);
    // Brushed steel: roughness varies along the grain, which is what produces
    // the stretched highlight the eye reads as machined metal.
    rough[k] = clamp01(0.29 + brush[k] * 0.2 + dirt * 0.3 + smoothstep(0.3, 0, pit[k]) * 0.25);
    metal[k] = clamp01(0.96 - dirt * 0.45 - smoothstep(0.28, 0, pit[k]) * 0.3);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, metal, size) };
}

// ---------------------------------------------------------------------------
// Corrugated container steel — faded paint over deep rust
// ---------------------------------------------------------------------------

function containerSet(size, seed) {
  const grain = fbm(size, 170, { octaves: 3, seed });
  const rustBlob = fbm(size, 9, { octaves: 5, seed: seed + 2 });
  const streaks = streakField(size, seed + 6, 5);
  const flake = worley(size, 34, seed + 11, 1).f1;

  const height = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    // Trapezoidal corrugation running vertically, 8 ribs per tile.
    const rowBase = j * size;
    for (let i = 0; i < size; i++) {
      const t = ((i / size) * 8) % 1;
      const rib = t < 0.5 ? smoothstep(0.06, 0.2, t) * (1 - smoothstep(0.3, 0.44, t)) : 0;
      height[rowBase + i] = rib * 1.0 + grain[rowBase + i] * 0.12;
    }
  }
  scribeGrid(height, size, 1, 3, 0.4, 0.007);
  const rustMask = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rustMask[k] = clamp01(
      smoothstep(0.5, 0.82, rustBlob[k]) * 0.9 +
      smoothstep(0.45, 0.85, streaks[k]) * 0.7 +
      smoothstep(0.78, 1, 1 - flake[k]) * 0.4,
    );
  }
  for (let k = 0; k < size * size; k++) height[k] -= rustMask[k] * 0.16 * grain[k];

  const ao = heightToAo(height, size, 6, 1.0);
  const normal = heightToNormal(height, size, 2.0, { wrap: true });

  const paint = hexToLinear(0x2d4a4e);
  const paintPale = hexToLinear(0x486a6a);
  const rust = hexToLinear(0x6b3418);
  const rustDark = hexToLinear(0x30170c);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const r = rustMask[k];
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(paint[ch], paintPale[ch], grain[k] * 0.6 + rustBlob[k] * 0.3);
      v = lerp(v, lerp(rustDark[ch], rust[ch], grain[k] * 0.8 + 0.2), r);
      out[ch] = v * (0.8 + ao[k] * 0.2);
    }
  });

  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(lerp(0.48, 0.88, rustMask[k]) + grain[k] * 0.08);
    metal[k] = clamp01(lerp(0.4, 0.05, rustMask[k]));
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, metal, size) };
}

// ---------------------------------------------------------------------------
// Poured concrete — the barrier walls and the pit surround
// ---------------------------------------------------------------------------

function concreteSet(size, seed) {
  const aggregate = worley(size, 58, seed, 1).f1;
  const fines = fbm(size, 220, { octaves: 3, seed: seed + 1 });
  const macro = fbm(size, 6, { octaves: 5, seed: seed + 4 });
  const streaks = streakField(size, seed + 7, 6);
  const crackField = fbm(size, 16, { octaves: 4, seed: seed + 21, ridged: true });

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const pop = smoothstep(0.16, 0, aggregate[k]) * 0.35;
    height[k] = fines[k] * 0.18 + macro[k] * 0.12 + pop;
  }
  // Form-board seams: horizontal lines every 1/3 tile plus tie-rod holes.
  scribeGrid(height, size, 1, 3, 0.5, 0.005);
  studGrid(height, size, 3, 3, 0.008, -0.5, 0.5);

  const cracks = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) cracks[k] = smoothstep(0.9, 0.99, crackField[k]);
  for (let k = 0; k < size * size; k++) height[k] -= cracks[k] * 0.6;

  const ao = heightToAo(height, size, 6, 1.15);
  const normal = heightToNormal(height, size, 2.4, { wrap: true });

  const pale = hexToLinear(0x585a5c);
  const mid = hexToLinear(0x3d3f43);
  const dark = hexToLinear(0x24262a);
  const stain = hexToLinear(0x191a1c);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const dirt = clamp01(streaks[k] * 0.95 - 0.08);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(mid[ch], pale[ch], fines[k] * 0.7 + smoothstep(0.2, 0, aggregate[k]) * 0.5);
      v = lerp(v, dark[ch], macro[k] * 0.5);
      v = lerp(v, stain[ch], dirt * 0.55 + cracks[k] * 0.6);
      out[ch] = v * (0.78 + ao[k] * 0.22);
    }
  });

  const rough = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(0.82 + fines[k] * 0.12 - streaks[k] * 0.14);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, null, size) };
}

// ---------------------------------------------------------------------------
// Hazard striping — the kerbs, bumpers and door frames
// ---------------------------------------------------------------------------

function hazardSet(size, seed) {
  const grain = fbm(size, 190, { octaves: 3, seed });
  const wear = fbm(size, 11, { octaves: 4, seed: seed + 5 });
  const streaks = streakField(size, seed + 9, 5);
  const scuff = fbm(size, 300, { octaves: 2, seed: seed + 17, ridged: true });

  const stripe = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // 45 degree chevrons, 6 per tile, phase continuous across the seam.
      const t = (((i + j) / size) * 6) % 1;
      stripe[j * size + i] = t < 0.5 ? 1 : 0;
    }
  }
  const stripeSoft = blur(stripe, size, 1, 1);

  // Paint wears off the raised concrete underneath in traffic patterns.
  const worn = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    worn[k] = clamp01(smoothstep(0.46, 0.86, wear[k]) * 0.9 + smoothstep(0.7, 1, scuff[k]) * 0.6);
  }

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    height[k] = grain[k] * 0.2 + (1 - worn[k]) * 0.08;
  }
  scribeGrid(height, size, 1, 4, 0.3, 0.004);

  const ao = heightToAo(height, size, 4, 0.9);
  const normal = heightToNormal(height, size, 1.8, { wrap: true });

  const yellow = hexToLinear(0xc99a17);
  const yellowDim = hexToLinear(0x7d6115);
  const black = hexToLinear(0x141416);
  const substrate = hexToLinear(0x3c3d40);
  const grime = hexToLinear(0x17161a);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const s = stripeSoft[k];
    const dirt = clamp01(streaks[k] * 0.9 - 0.05);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(black[ch], lerp(yellowDim[ch], yellow[ch], grain[k] * 0.6 + 0.35), s);
      v = lerp(v, substrate[ch] * (0.8 + grain[k] * 0.4), worn[k]);
      v = lerp(v, grime[ch], dirt * 0.45);
      out[ch] = v * (0.82 + ao[k] * 0.18);
    }
  });

  const rough = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(lerp(0.42, 0.86, worn[k]) + streaks[k] * 0.14 + grain[k] * 0.05);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, null, size) };
}

// ---------------------------------------------------------------------------
// Cutout sets
// ---------------------------------------------------------------------------

/** Bar grating: a real grid with bearing bars and cross rods. */
function gratingSet(size, seed) {
  const alpha = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const bars = 10;
  const rods = 5;
  for (let j = 0; j < size; j++) {
    const v = ((j / size) * rods) % 1;
    const rod = 1 - smoothstep(0.1, 0.16, Math.abs(v - 0.5));
    for (let i = 0; i < size; i++) {
      const u = ((i / size) * bars) % 1;
      const bar = 1 - smoothstep(0.16, 0.24, Math.abs(u - 0.5));
      const a = Math.max(bar, rod);
      alpha[j * size + i] = a;
      height[j * size + i] = bar * 0.7 + rod * 0.35;
    }
  }
  const grain = fbm(size, 160, { octaves: 3, seed });
  for (let k = 0; k < size * size; k++) height[k] += grain[k] * 0.1 * alpha[k];
  const ao = heightToAo(height, size, 4, 1.4);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(0.44 + grain[k] * 0.22);
    metal[k] = 0.9;
  }
  return {
    alpha: makeAlpha(alpha, size),
    normal: makeTexture(heightToNormal(height, size, 3.4, { wrap: true }), size),
    orm: packOrm(ao, rough, metal, size),
  };
}

/**
 * Chain-link: two families of parallel wires at plus and minus 45 degrees.
 * Alpha only — the wire itself is shaded by the material's metalness.
 */
function chainLinkAlpha(size) {
  const alpha = new Float32Array(size * size);
  const cells = 7;
  const half = 0.05; // half wire width, in cell units
  const frac = (x) => x - Math.floor(x);
  for (let j = 0; j < size; j++) {
    const v = (j / size) * cells;
    for (let i = 0; i < size; i++) {
      const u = (i / size) * cells;
      const f1 = frac(u + v);
      const f2 = frac(u - v);
      const d1 = Math.min(f1, 1 - f1);
      const d2 = Math.min(f2, 1 - f2);
      alpha[j * size + i] = Math.max(
        1 - smoothstep(half * 0.6, half, d1),
        1 - smoothstep(half * 0.6, half, d2),
      );
    }
  }
  return makeAlpha(alpha, size);
}

/**
 * Impact decal: a compression crater with radial fractures and a bright rim
 * where the paint has been driven off the metal. Used on the arena walls.
 */
function dentDecal(size, seed) {
  const c = (size - 1) * 0.5;
  const height = new Float32Array(size * size);
  const alpha = new Float32Array(size * size);
  const warp = fbm(size, 5, { octaves: 4, seed, signed: true });
  const rays = fbm(size, 4, { octaves: 3, seed: seed + 3 });

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const dx = (i - c) / c;
      const dy = (j - c) / c;
      let d = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      // Star-shaped fracture pattern: the crater rim is not a circle.
      const lobes = 0.82 + 0.18 * Math.sin(ang * 5 + rays[k] * 6) + warp[k] * 0.22;
      d /= Math.max(0.35, lobes);
      const crater = 1 - smoothstep(0.0, 0.72, d);
      const lip = smoothstep(0.55, 0.74, d) * (1 - smoothstep(0.74, 0.94, d));
      const crack = smoothstep(0.55, 0.95, rays[k]) * (1 - smoothstep(0.3, 1.0, d));
      height[k] = -crater * 1.0 + lip * 0.34 - crack * 0.3;
      alpha[k] = clamp01((crater * 1.35 + lip * 1.1 + crack * 0.8) * (1 - smoothstep(0.75, 1.0, d)));
    }
  }

  const grain = fbm(size, 120, { octaves: 3, seed: seed + 8 });
  for (let k = 0; k < size * size; k++) height[k] += grain[k] * 0.09 * alpha[k];

  const data = new Uint8Array(size * size * 4);
  const bare = hexToLinear(0x8b8c88);
  const shadow = hexToLinear(0x0c0d0f);
  const scorch = hexToLinear(0x1a1512);
  const lin = [0, 0, 0];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const dx = (i - c) / c, dy = (j - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const exposed = clamp01(smoothstep(0.42, 0.75, d) * 1.2 + grain[k] * 0.3);
      for (let ch = 0; ch < 3; ch++) {
        lin[ch] = lerp(shadow[ch], lerp(scorch[ch], bare[ch] * (0.6 + grain[k] * 0.8), exposed), 0.55 + exposed * 0.45);
      }
      const o = k * 4;
      data[o] = Math.round(clamp01(lin[0]) * 255);
      data[o + 1] = Math.round(clamp01(lin[1]) * 255);
      data[o + 2] = Math.round(clamp01(lin[2]) * 255);
      data[o + 3] = Math.round(clamp01(alpha[k]) * 255);
    }
  }
  const albedoTex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  albedoTex.colorSpace = THREE.SRGBColorSpace;
  albedoTex.wrapS = albedoTex.wrapT = THREE.ClampToEdgeWrapping;
  albedoTex.minFilter = THREE.LinearMipmapLinearFilter;
  albedoTex.generateMipmaps = true;
  albedoTex.anisotropy = 8;
  albedoTex.needsUpdate = true;

  const normalTex = makeTexture(heightToNormal(height, size, 3.0, { wrap: false }), size, { clamp: true });
  return { albedo: albedoTex, normal: normalTex };
}

/** Soft scorch/scuff decal for the floor. */
function scorchDecal(size, seed) {
  const c = (size - 1) * 0.5;
  const n = fbm(size, 5, { octaves: 5, seed });
  const fine = fbm(size, 22, { octaves: 3, seed: seed + 4 });
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const dx = (i - c) / c, dy = (j - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy) * (0.75 + n[k] * 0.6);
      const a = clamp01((1 - smoothstep(0.15, 0.95, d)) * (0.45 + fine[k] * 0.9));
      const o = k * 4;
      const v = Math.round(clamp01(0.05 + fine[k] * 0.06) * 255);
      data[o] = v; data[o + 1] = v; data[o + 2] = Math.round(v * 1.05);
      data[o + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** A stencilled warning plate, used on machinery and door frames. */
function warningPlate(size, seed, lines) {
  const grain = fbm(size, 120, { octaves: 3, seed });
  const wear = fbm(size, 8, { octaves: 4, seed: seed + 3 });
  const text = new Float32Array(size * size);
  const cell = Math.max(2, Math.round(size / 46));
  let y = Math.round(size * 0.2);
  for (const line of lines) {
    const w = line.length * 6 * cell - cell;
    stampText(text, size, line, Math.round((size - w) / 2), y, cell, cell * 0.5);
    y += cell * 11;
  }
  const soft = blur(text, size, 1, 1);

  const plate = hexToLinear(0x30343a);
  const ink = hexToLinear(0xd8bb3a);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const worn = smoothstep(0.5, 0.9, wear[k]);
    const ink01 = clamp01(soft[k] * (1 - worn * 0.7));
    const o = k * 4;
    for (let ch = 0; ch < 3; ch++) {
      data[o + ch] = encodeSrgb(lerp(plate[ch] * (0.8 + grain[k] * 0.5), ink[ch], ink01));
    }
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------

/**
 * Builds every non-floor material the arena uses.
 *
 * @param {object} [opts]
 * @param {'ultra'|'high'|'medium'|'low'} [opts.quality='high']
 * @returns {{ materials: Record<string, THREE.Material>, textures: Record<string, THREE.Texture>, dispose(): void }}
 */
export function makeArenaMaterials(opts = {}) {
  const q = opts.quality ?? 'high';
  const big = q === 'low' ? 256 : q === 'medium' ? 512 : 1024;
  const small = q === 'low' ? 128 : q === 'medium' ? 256 : 512;

  const steelSet = paintedSteelSet(small, 101);
  const darkSet = darkMetalSet(small, 211);
  const boxSet = containerSet(small, 307);
  const concSet = concreteSet(big, 401);
  const hazSet = hazardSet(small, 503);
  const grateSet = gratingSet(Math.min(512, small), 601);

  const textures = {
    steelAlbedo: steelSet.albedo, steelNormal: steelSet.normal, steelOrm: steelSet.orm,
    darkAlbedo: darkSet.albedo, darkNormal: darkSet.normal, darkOrm: darkSet.orm,
    boxAlbedo: boxSet.albedo, boxNormal: boxSet.normal, boxOrm: boxSet.orm,
    concreteAlbedo: concSet.albedo, concreteNormal: concSet.normal, concreteOrm: concSet.orm,
    hazardAlbedo: hazSet.albedo, hazardNormal: hazSet.normal, hazardOrm: hazSet.orm,
    grateAlpha: grateSet.alpha, grateNormal: grateSet.normal, grateOrm: grateSet.orm,
    chainAlpha: chainLinkAlpha(Math.min(512, small)),
    noise: noiseTexture(128, 4, 17),
    dust: radialSprite(64, 2.6, 0.25),
    spark: radialSprite(48, 3.6, 0.9),
    steam: radialSprite(96, 1.6, 0.0),
    scorch: scorchDecal(256, 907),
    warning: warningPlate(256, 1301, ['danger', 'test cell 09', 'no entry']),
  };
  const dent = dentDecal(256, 811);
  textures.dentAlbedo = dent.albedo;
  textures.dentNormal = dent.normal;

  /** Repeat is set per-mesh by world-scale UVs, so textures tile at 1:1 here. */
  const std = (t, cfg) => new THREE.MeshStandardMaterial({
    map: t.albedo, normalMap: t.normal, roughnessMap: t.orm, metalnessMap: t.orm, aoMap: t.orm,
    roughness: 1, metalness: 1, dithering: true, ...cfg,
  });

  const materials = {
    steel: std(steelSet, { name: 'arena.steel', normalScale: new THREE.Vector2(1, 1), envMapIntensity: 0.7 }),
    darkMetal: std(darkSet, { name: 'arena.darkMetal', normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 0.85 }),
    container: std(boxSet, { name: 'arena.container', normalScale: new THREE.Vector2(1.1, 1.1), envMapIntensity: 0.55 }),
    concrete: std(concSet, { name: 'arena.concrete', metalness: 0, normalScale: new THREE.Vector2(1.05, 1.05), envMapIntensity: 0.45 }),
    hazard: std(hazSet, { name: 'arena.hazard', metalness: 0, normalScale: new THREE.Vector2(0.85, 0.85), envMapIntensity: 0.5 }),

    grating: new THREE.MeshStandardMaterial({
      name: 'arena.grating',
      color: 0x555559,
      normalMap: grateSet.normal, roughnessMap: grateSet.orm, metalnessMap: grateSet.orm, aoMap: grateSet.orm,
      alphaMap: grateSet.alpha, transparent: false, alphaTest: 0.5, side: THREE.DoubleSide,
      roughness: 1, metalness: 1, envMapIntensity: 0.8, dithering: true,
    }),

    chainLink: new THREE.MeshStandardMaterial({
      name: 'arena.chainLink',
      color: 0x2a2d31, alphaMap: textures.chainAlpha, alphaTest: 0.45,
      roughness: 0.55, metalness: 0.85, side: THREE.DoubleSide, envMapIntensity: 0.9, dithering: true,
    }),

    // Onlookers are pure silhouette: nearly black, matte, and deliberately not
    // shadow casters so a crowd of forty costs nothing in the shadow pass.
    crowd: new THREE.MeshStandardMaterial({
      name: 'arena.crowd', color: 0x0b0c10, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35, dithering: true,
    }),

    rubber: new THREE.MeshStandardMaterial({
      name: 'arena.rubber', color: 0x131418, roughness: 0.78, metalness: 0.0, envMapIntensity: 0.4, dithering: true,
    }),

    glass: new THREE.MeshPhysicalMaterial({
      name: 'arena.glass', color: 0x0a1016, roughness: 0.14, metalness: 0.0,
      transmission: 0, transparent: true, opacity: 0.34, side: THREE.DoubleSide,
      envMapIntensity: 1.6, dithering: true,
    }),

    warningPlate: new THREE.MeshStandardMaterial({
      name: 'arena.warningPlate', map: textures.warning, roughness: 0.62, metalness: 0.25,
      envMapIntensity: 0.6, dithering: true,
    }),

    dentDecal: new THREE.MeshStandardMaterial({
      name: 'arena.dent', map: textures.dentAlbedo, normalMap: textures.dentNormal,
      transparent: true, opacity: 1, depthWrite: false, roughness: 0.52, metalness: 0.75,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      normalScale: new THREE.Vector2(1.6, 1.6), envMapIntensity: 0.9, dithering: true,
    }),

    scorchDecal: new THREE.MeshBasicMaterial({
      name: 'arena.scorch', map: textures.scorch, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.NormalBlending,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    }),
  };

  for (const m of Object.values(materials)) m.shadowSide = THREE.FrontSide;

  return {
    materials,
    textures,
    dispose() {
      for (const t of Object.values(textures)) t.dispose?.();
      for (const m of Object.values(materials)) m.dispose?.();
    },
  };
}
