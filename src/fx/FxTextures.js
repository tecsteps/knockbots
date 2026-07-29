/**
 * Knockbots — procedural FX texture bakery.
 *
 * No FX texture is loaded; all of them are computed into `DataTexture`s at boot.
 * Two decisions worth knowing about:
 *
 * 1. **Everything is baked as linear data, not sRGB.** These maps are consumed
 *    by hand-written shaders that do their own radiometry and hand the result to
 *    a linear HDR composer, so tagging them `SRGBColorSpace` would double-apply
 *    the transfer function and wash every spark out to pink.
 *
 * 2. **The smoke puff carries a normal, not just an alpha.** A lit smoke sheet
 *    is the difference between "AAA volumetric dust" and "grey blob"; the baker
 *    derives a hemispherical normal from the density gradient and packs it into
 *    RG, thickness into B and coverage into A. `SmokeSystem` rotates that normal
 *    into view space and shades it against the stage key light with a wrapped
 *    diffuse plus a forward-scatter term.
 *
 * Every baker is pure and seeded, so the same build always produces the same
 * pixels and the QA screenshots are comparable frame to frame.
 */

import * as THREE from 'three';
import { fbm3, ridged3, worley2, smoothstep, clamp01, mix } from './FxNoise.js';

/**
 * Wraps a byte array in a texture configured the way every FX map wants it.
 * @param {Uint8Array} data RGBA8
 * @param {number} w @param {number} h
 * @param {{ wrap?: number, aniso?: number, mips?: boolean }} [opts]
 * @returns {THREE.DataTexture}
 */
function finish(data, w, h, opts = {}) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = opts.wrap ?? THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = opts.mips !== false;
  tex.minFilter = tex.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  if (opts.aniso) tex.anisotropy = opts.aniso;
  tex.needsUpdate = true;
  return tex;
}

const b = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * A single spark: a soft-ended capsule that the vertex shader stretches along
 * the velocity vector. Radially the profile is a tight gaussian so the streak
 * still has a hot filament core after being stretched twenty times its width.
 * @param {number} [size]
 */
export function bakeSparkTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    // Along the streak: a hot head that trails off, not a symmetric blob.
    const head = smoothstep(0.0, 0.22, v);
    const tail = 1 - smoothstep(0.28, 1.0, v);
    const along = Math.pow(head * tail, 0.75);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const r = Math.abs(u - 0.5) * 2;
      const across = Math.exp(-r * r * 7.5);
      const core = Math.exp(-r * r * 42) * along;
      const a = clamp01(across * along);
      const i = (y * size + x) * 4;
      // RGB is a temperature weight: the filament core stays white far longer.
      data[i] = b(clamp01(a + core * 1.6));
      data[i + 1] = b(clamp01(a * 0.85 + core * 1.2));
      data[i + 2] = b(clamp01(a * 0.5 + core));
      data[i + 3] = b(a);
    }
  }
  return finish(data, size, size);
}

/**
 * Soft lit smoke puff. RG = hemispherical normal xy, B = optical thickness,
 * A = coverage. Density is ridged fbm masked by a radial falloff, which gives
 * billowing edges instead of a circular vignette.
 * @param {number} [size]
 * @param {number} [seed]
 */
export function bakeSmokePuff(size = 192, seed = 4211) {
  const density = new Float32Array(size * size);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) * inv - 0.5;
      const v = (y + 0.5) * inv - 0.5;
      const r = Math.sqrt(u * u + v * v) * 2;
      // Warp the sample point so the billows swirl rather than sit in a grid.
      const w = fbm3(u * 3.1 + 11, v * 3.1 + 5, 0.5, { octaves: 3, period: 8, seed: seed + 7 });
      const n = ridged3(u * 4.6 + w * 0.55, v * 4.6 + w * 0.55, 1.7, { octaves: 5, period: 12, seed });
      const lobes = 1 - smoothstep(0.42, 1.02, r - (n - 0.5) * 0.42);
      density[y * size + x] = clamp01(lobes * (0.45 + n * 0.75));
    }
  }

  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const xm = density[y * size + Math.max(0, x - 1)];
      const xp = density[y * size + Math.min(size - 1, x + 1)];
      const ym = density[Math.max(0, y - 1) * size + x];
      const yp = density[Math.min(size - 1, y + 1) * size + x];
      // Density gradient gives surface tilt; add a dome bias so the puff centre
      // faces the camera and the silhouette faces outward.
      const u = (x + 0.5) * inv - 0.5;
      const v = (y + 0.5) * inv - 0.5;
      let nx = (xm - xp) * 2.6 + u * 1.7;
      let ny = (ym - yp) * 2.6 + v * 1.7;
      const len = Math.sqrt(nx * nx + ny * ny);
      if (len > 1) { nx /= len; ny /= len; }
      const d = density[i];
      const o = i * 4;
      data[o] = b(nx * 0.5 + 0.5);
      data[o + 1] = b(ny * 0.5 + 0.5);
      data[o + 2] = b(clamp01(Math.pow(d, 0.7)));
      data[o + 3] = b(clamp01(smoothstep(0.03, 0.55, d)));
    }
  }
  return finish(data, size, size);
}

/**
 * Radial glow kernel used for flashes, thruster cores and muzzle bloom. Two
 * stacked exponentials: a tight core plus a wide halo, which is what a real
 * lens does and what a single gaussian never gets right.
 */
export function bakeGlowTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const r = Math.min(1, Math.sqrt(u * u + v * v) * 2);
      const core = Math.exp(-r * r * 26);
      const halo = Math.exp(-r * 3.4) * 0.34;
      const a = clamp01((core + halo) * (1 - smoothstep(0.85, 1.0, r)));
      const i = (y * size + x) * 4;
      data[i] = b(clamp01(a + core * 0.8));
      data[i + 1] = b(a);
      data[i + 2] = b(clamp01(a * 0.92));
      data[i + 3] = b(a);
    }
  }
  return finish(data, size, size);
}

/**
 * Oil / coolant droplet. Alpha is a slightly teardrop blob; RGB carries a
 * sharp offset specular hotspot and a rim, so the fluid reads wet under the
 * additive-free normal blend the fluid system uses.
 */
export function bakeDropletTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const stretch = v > 0 ? 1 : 0.78;             // teardrop: fatter at the head
      const r = Math.min(1.2, Math.sqrt(u * u + (v / stretch) * (v / stretch)) * 2);
      const a = 1 - smoothstep(0.72, 1.0, r);
      const nx = u * 2, ny = v * 2;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      // Fixed upper-left key so every droplet shares one light direction.
      const spec = Math.pow(clamp01(nx * -0.45 + ny * -0.55 + nz * 0.7), 22);
      const rim = Math.pow(1 - clamp01(nz), 3.2) * 0.55;
      const i = (y * size + x) * 4;
      data[i] = b(clamp01(spec * 1.0 + rim * 0.35));
      data[i + 1] = b(clamp01(spec * 1.05 + rim * 0.42));
      data[i + 2] = b(clamp01(spec * 1.15 + rim * 0.5));
      data[i + 3] = b(a);
    }
  }
  return finish(data, size, size);
}

/**
 * Shockwave ring profile, one row of which is the radial cross-section: a
 * razor-thin leading edge, a bright shoulder and a long soft wake. Sampled by
 * the ring shader on U = normalised radius so the whole thing is one texture
 * fetch instead of a stack of smoothsteps.
 */
export function bakeRingProfile(w = 512) {
  const h = 4;
  const data = new Uint8Array(w * h * 4);
  for (let x = 0; x < w; x++) {
    const t = (x + 0.5) / w;
    const edge = Math.exp(-Math.pow((t - 0.86) * 15.5, 2));      // leading shock
    const shoulder = Math.exp(-Math.pow((t - 0.7) * 6.2, 2)) * 0.55;
    const wake = Math.pow(clamp01((t - 0.12) / 0.6), 2.4) * 0.3 * (1 - smoothstep(0.72, 0.95, t));
    const intensity = clamp01(edge + shoulder + wake);
    const refract = (Math.exp(-Math.pow((t - 0.82) * 9.0, 2)) - Math.exp(-Math.pow((t - 0.62) * 7.0, 2)) * 0.75);
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      data[i] = b(intensity);
      data[i + 1] = b(clamp01(edge));                 // hot core mask
      data[i + 2] = b(refract * 0.5 + 0.5);           // signed distortion, biased
      data[i + 3] = b(intensity);
    }
  }
  return finish(data, w, h, { mips: false });
}

/**
 * Energy stripe for super beams: vertical striations that scroll, with a hot
 * centre column. Tiles vertically.
 */
export function bakeBeamTexture(w = 64, h = 256, seed = 90210) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const across = Math.exp(-Math.pow((u - 0.5) * 4.4, 2));
      const core = Math.exp(-Math.pow((u - 0.5) * 15.0, 2));
      const striate = fbm3(u * 2.0, v * 9.0, 0.0, { octaves: 4, period: 9, seed });
      const flick = 0.62 + striate * 0.7;
      const a = clamp01(across * flick);
      const i = (y * w + x) * 4;
      data[i] = b(clamp01(a * 0.7 + core));
      data[i + 1] = b(clamp01(a * 0.85 + core * 0.9));
      data[i + 2] = b(clamp01(a + core * 0.8));
      data[i + 3] = b(a);
    }
  }
  return finish(data, w, h, { wrap: THREE.RepeatWrapping });
}

/**
 * Tiling curl-noise source. RG hold the gradient of a scalar potential; the
 * smoke shader reads it and takes the perpendicular, which is a divergence-free
 * 2D flow field — the reason the puffs curl and shear instead of drifting.
 * B holds a second, lower-frequency potential gradient magnitude for turbulence
 * strength, A a decorrelated scalar for per-particle jitter.
 */
export function bakeCurlField(size = 128, seed = 33137) {
  const pot = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      pot[y * size + x] = fbm3(x / size * 6, y / size * 6, 3.0, { octaves: 4, period: 6, seed });
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => pot[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 0.5;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 0.5;
      const coarse = fbm3(x / size * 2.0, y / size * 2.0, 11.0, { octaves: 2, period: 2, seed: seed + 51 });
      const jitter = fbm3(x / size * 11.0, y / size * 11.0, 21.0, { octaves: 2, period: 11, seed: seed + 909 });
      const i = (y * size + x) * 4;
      data[i] = b(clamp01(gx * 6 + 0.5));
      data[i + 1] = b(clamp01(gy * 6 + 0.5));
      data[i + 2] = b(clamp01(coarse));
      data[i + 3] = b(clamp01(jitter));
    }
  }
  return finish(data, size, size, { wrap: THREE.RepeatWrapping });
}

/**
 * Ground decal atlas, 2x2 cells at `size/2` each:
 *
 *   (0,0) scorch    — burnt carbon bloom with a hot cracked centre
 *   (1,0) oil       — coolant splat with satellite droplets and a wet rim
 *   (0,1) fracture  — impact star: radial cracks over a crushed-dust ring
 *   (1,1) scuff     — soft dust smear left by slides, landings and knockdowns
 *
 * RGB is the decal albedo/tint mask and A the coverage. `DecalSystem` multiplies
 * RGB by a per-instance colour, so one atlas serves scorch, coolant of any
 * character hue, and plain dust.
 *
 * @param {number} [size] atlas edge; each cell is half of it
 * @param {number} [aniso] max anisotropy from the renderer
 */
export function bakeDecalAtlas(size = 1024, aniso = 8) {
  const half = size >> 1;
  const data = new Uint8Array(size * size * 4);

  const put = (cx, cy, x, y, r, g, bl, a) => {
    const i = ((cy * half + y) * size + (cx * half + x)) * 4;
    data[i] = b(r); data[i + 1] = b(g); data[i + 2] = b(bl); data[i + 3] = b(a);
  };

  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const u = (x + 0.5) / half - 0.5;
      const v = (y + 0.5) / half - 0.5;
      const r = Math.sqrt(u * u + v * v) * 2;
      const ang = Math.atan2(v, u);

      // --- scorch -------------------------------------------------------
      {
        const wob = fbm3(u * 5.2, v * 5.2, 2.0, { octaves: 5, period: 10, seed: 8181 });
        const edge = 1 - smoothstep(0.34, 0.96, r + (wob - 0.5) * 0.55);
        const soot = Math.pow(edge, 1.5) * (0.55 + wob * 0.7);
        const cracks = 1 - smoothstep(0.0, 0.12, worley2(u * 7 + 3, v * 7 + 3, 7, 4242));
        const hot = clamp01(cracks * (1 - smoothstep(0.05, 0.5, r)) * edge);
        const a = clamp01(soot * 0.95);
        put(0, 0, x, y, clamp01(0.05 + hot * 0.9), clamp01(0.035 + hot * 0.35), 0.03 + hot * 0.08, a);
      }

      // --- oil / coolant splat -------------------------------------------
      {
        const lobe = fbm3(Math.cos(ang) * 1.9 + 5, Math.sin(ang) * 1.9 + 5, 1.0, { octaves: 3, period: 4, seed: 616 });
        const body = 1 - smoothstep(0.24 + lobe * 0.42, 0.4 + lobe * 0.52, r);
        // Satellite droplets flung out along the splash direction.
        let sat = 0;
        for (let k = 0; k < 14; k++) {
          const a0 = (k / 14) * Math.PI * 2 + fbm3(k * 3.1, 0.5, 0.5, { octaves: 2, period: 4, seed: 77 }) * 2.2;
          const d0 = 0.34 + fbm3(k * 1.7, 2.5, 1.5, { octaves: 2, period: 4, seed: 99 }) * 0.6;
          const rad = 0.02 + fbm3(k * 5.3, 4.5, 2.5, { octaves: 2, period: 4, seed: 123 }) * 0.05;
          const dx = u - Math.cos(a0) * d0 * 0.5;
          const dy = v - Math.sin(a0) * d0 * 0.5;
          sat = Math.max(sat, 1 - smoothstep(rad * 0.6, rad, Math.sqrt(dx * dx + dy * dy)));
        }
        const a = clamp01(Math.max(body, sat) * (1 - smoothstep(0.92, 1.0, r)));
        const rim = Math.pow(a, 6) * 0.4 + Math.pow(clamp01(1 - Math.abs(a - 0.6) * 4), 3) * 0.5;
        put(1, 0, x, y, clamp01(0.06 + rim), clamp01(0.08 + rim * 1.1), clamp01(0.1 + rim * 1.25), a);
      }

      // --- fracture star --------------------------------------------------
      {
        const spokes = Math.abs(Math.sin(ang * 5.5 + fbm3(Math.cos(ang) * 3, Math.sin(ang) * 3, 0.5, { octaves: 3, period: 6, seed: 31 }) * 6));
        const crack = 1 - smoothstep(0.0, 0.16 + r * 0.22, spokes);
        const reach = 1 - smoothstep(0.25, 0.98, r);
        const dust = Math.pow(1 - smoothstep(0.1, 0.75, r), 1.6) * 0.42;
        const detail = fbm3(u * 9, v * 9, 4.0, { octaves: 4, period: 9, seed: 5150 });
        const a = clamp01(crack * reach * (0.6 + detail * 0.8) + dust * detail);
        put(0, 1, x, y, clamp01(0.1 + crack * reach * 0.35), clamp01(0.1 + crack * reach * 0.32), clamp01(0.11 + crack * reach * 0.3), a);
      }

      // --- dust scuff -----------------------------------------------------
      {
        const smear = fbm3(u * 3.0, v * 8.0, 6.0, { octaves: 4, period: 8, seed: 2718 });
        const shape = 1 - smoothstep(0.2, 1.0, r * (0.7 + Math.abs(v) * 1.4));
        const a = clamp01(shape * (0.25 + smear * 0.85) * 0.7);
        const tone = 0.55 + smear * 0.4;
        put(1, 1, x, y, tone, tone * 0.97, tone * 0.92, a);
      }
    }
  }

  const tex = finish(data, size, size, { aniso });
  tex.userData.cells = { scorch: [0, 0], oil: [1, 0], fracture: [0, 1], scuff: [1, 1] };
  return tex;
}

/**
 * Metal-shard sparkle mask: a small tileable roughness/anisotropy break-up used
 * on the debris material so a hundred identical shards do not flash identically.
 */
export function bakeShardDetail(size = 128, seed = 5309) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cells = worley2(x / size * 9, y / size * 9, 9, seed);
      const grain = fbm3(x / size * 22, y / size * 6, 1.0, { octaves: 3, period: 11, seed: seed + 13 });
      const rough = clamp01(mix(0.18, 0.62, cells) + (grain - 0.5) * 0.22);
      const i = (y * size + x) * 4;
      data[i] = b(rough);
      data[i + 1] = b(clamp01(0.75 + (grain - 0.5) * 0.5));
      data[i + 2] = b(clamp01(1 - cells * 0.4));
      data[i + 3] = 255;
    }
  }
  return finish(data, size, size, { wrap: THREE.RepeatWrapping });
}

/**
 * Builds the whole FX texture set once. Sizes scale with the quality tier so a
 * low-end machine does not spend 300ms in the bakery at boot.
 * @param {'ultra'|'high'|'medium'|'low'} quality
 * @param {number} maxAnisotropy
 */
export function bakeFxTextures(quality = 'ultra', maxAnisotropy = 8) {
  const big = quality === 'ultra' ? 1 : quality === 'high' ? 0.75 : 0.5;
  const px = (n) => Math.max(32, Math.round(n * big / 2) * 2);
  return {
    spark: bakeSparkTexture(px(64)),
    smoke: bakeSmokePuff(px(192)),
    glow: bakeGlowTexture(px(128)),
    droplet: bakeDropletTexture(px(64)),
    ring: bakeRingProfile(512),
    beam: bakeBeamTexture(64, 256),
    curl: bakeCurlField(px(128)),
    decals: bakeDecalAtlas(quality === 'low' ? 512 : 1024, maxAnisotropy),
    shard: bakeShardDetail(px(128)),
  };
}
