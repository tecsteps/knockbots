/**
 * Knockbots — the pit floor.
 *
 * This is the surface the whole stage is judged on, because it is the one that
 * holds the reflection of the fighters. It is built as four cooperating pieces:
 *
 *   1. **A single macro map set** covering the whole 32x28m slab at ~15mm per
 *      texel. Painted markings are evaluated analytically per texel — a circle
 *      is a circle, not a rasterised blob — while the noise fields behind them
 *      are generated at a quarter resolution and bilinearly sampled, which is
 *      what makes a 2048px albedo affordable.
 *   2. **A tiling detail normal** blended in the shader at ~40cm per tile, so
 *      the concrete still has grain when the camera is 2m off the deck and the
 *      macro map is 8x magnified.
 *   3. **A real planar reflection**, mirrored through y=0 and projected back
 *      with the reflection camera's own matrix. It is gathered with a five-tap
 *      cross whose radius grows with roughness, so a puddle mirrors and the
 *      surrounding damp concrete smears — the difference between "wet floor"
 *      and "chrome". It is the *only* reflection on this floor: the screen-space
 *      pass that used to sit in the post chain and add a second one on top of
 *      it is gone, and the roughness fade here was widened to cover the range
 *      that pass had been covering.
 *   4. **Animated ripples**, scrolled in two directions and masked to the
 *      wetness channel. Amplitude is deliberately tiny: enough that the
 *      practicals crawl on the water, not enough to read as an ocean.
 *
 * The wetness mask lives in the alpha channel of the macro normal map. It
 * drives albedo darkening, roughness, ripple amplitude and reflection strength
 * from one field, so those four can never disagree.
 */

import * as THREE from 'three';
import { GROUND_Y, ARENA_HALF_WIDTH, LAYER } from '../core/Constants.js';
import {
  fbm, worley, blur, resample, clamp01, lerp, smoothstep, hexToLinear, encodeSrgb,
  heightToNormal, heightToAo, sampleWrap, stampText, makeTexture,
} from './ProcTex.js';
import { bevelBox, place } from './GeoKit.js';

/** Extent of the fully textured slab, in metres. */
export const FLOOR = { w: 32, d: 28, cx: 0, cz: 2 };

const FIELD = 512; // resolution of the noise fields behind the macro map

// ---------------------------------------------------------------------------
// Macro map generation
// ---------------------------------------------------------------------------

/**
 * Bakes the floor's albedo / normal+wetness / ORM triple.
 * @param {number} size output edge length
 * @returns {{albedo: THREE.DataTexture, normal: THREE.DataTexture, orm: THREE.DataTexture}}
 */
function bakeFloorMaps(size) {
  const n = size * size;
  const s2f = FIELD / size; // texel -> field coordinate

  // --- low-resolution fields ----------------------------------------------
  const fines = fbm(FIELD, 150, { octaves: 3, seed: 71 });
  const macro = fbm(FIELD, 6, { octaves: 5, seed: 73 });
  const stain = fbm(FIELD, 13, { octaves: 4, seed: 79 });
  const wearF = fbm(FIELD, 21, { octaves: 4, seed: 83 });
  const crackF = fbm(FIELD, 19, { octaves: 4, seed: 89, ridged: true });
  const aggregate = worley(FIELD, 72, 97, 1).f1;
  const puddleCells = worley(FIELD, 11, 101, 0.95);
  const oil = fbm(FIELD, 9, { octaves: 4, seed: 107 });
  // Two very low-frequency fields, three or four blobs across the whole 32m
  // slab. They are what stop one material tiling across the deck: the first
  // decides which end of the pit drains and which end holds water, the second
  // breaks that up again so the wet and dry regions do not share an edge.
  const region = fbm(FIELD, 3, { octaves: 3, seed: 131 });
  const drying = fbm(FIELD, 6, { octaves: 3, seed: 137 });

  // --- painted markings, rasterised at full resolution ---------------------
  // 0 = line paint (bone white), 1 = hazard yellow, 2 = hazard black.
  const mark = new Float32Array(n);
  const markKind = new Uint8Array(n);
  const text = new Float32Array(n);
  // World-space features that have to be exact rather than noisy, kept as byte
  // masks because at 2048px a Float32 field is another sixteen megabytes each.
  const scuff = new Uint8Array(n);      // rubber transfer from drag and skid
  const patchTone = new Uint8Array(n);  // re-poured slab, 128 = original pour
  const patchJoint = new Uint8Array(n); // the cold joint round each patch

  const px = size / FLOOR.w; // texels per metre in x
  const pz = size / FLOOR.d;
  const cell = Math.max(2, Math.round(size / 210));
  // Stencilled callouts sit behind and beside the fight plane so the centre of
  // frame stays clean; they exist to give the eye scale, not to be read.
  const worldToTexel = (wx, wz) => [
    (wx - FLOOR.cx) * px + size / 2,
    (FLOOR.cz - wz) * pz + size / 2,
  ];
  const lines = [
    { s: 'sublevel 09', x: -13.2, z: -7.4, c: cell },
    { s: 'mech test cell', x: -13.2, z: -8.6, c: cell },
    { s: 'no personnel beyond this line', x: -7.6, z: 11.4, c: Math.max(2, Math.round(cell * 0.62)) },
    { s: 'load rating 240t', x: 7.2, z: -8.6, c: Math.max(2, Math.round(cell * 0.7)) },
  ];
  for (const l of lines) {
    const [tx, ty] = worldToTexel(l.x, l.z);
    stampText(text, size, l.s, tx, ty, l.c, l.c * 0.55);
  }

  /**
   * Re-poured sections. A test cell floor gets cut open for services and the
   * new concrete never matches the old — a patch reads as a different pour, at
   * a different age, ringed by a cold joint. Four of them across a 32m slab is
   * the single cheapest way to stop the macro map looking like one material.
   */
  const patches = [
    { x: -5.6, z: 5.4, w: 6.6, d: 4.2, rot: 0.05, tone: 0.5 },
    { x: 7.1, z: -3.2, w: 4.8, d: 5.8, rot: -0.08, tone: -0.34 },
    { x: 1.4, z: 9.0, w: 8.4, d: 3.2, rot: 0.02, tone: 0.28 },
    { x: -9.8, z: -4.4, w: 4.2, d: 3.4, rot: 0.13, tone: -0.2 },
  ];
  /**
   * Drag and skid marks. Two ruts a metre and a bit apart is a tracked machine
   * being winched across the deck; a single wide smear is something heavy being
   * dragged. Both are arcs, because nothing is ever pulled in a straight line.
   */
  const drags = [
    { x: -3.4, z: 2.0, r: 8.6, a0: -1.05, a1: 0.42, w: 0.2, ruts: 1.15, gain: 0.9 },
    { x: 5.0, z: 1.2, r: 11.5, a0: 2.28, a1: 3.28, w: 0.17, ruts: 1.3, gain: 0.7 },
    { x: 0.4, z: -6.0, r: 6.2, a0: 0.62, a1: 1.62, w: 0.44, ruts: 0, gain: 0.75 },
    { x: -8.0, z: 7.5, r: 5.4, a0: -0.55, a1: 0.55, w: 0.34, ruts: 0, gain: 0.55 },
    { x: -6.2, z: -5.4, r: 7.8, a0: 0.12, a1: 1.02, w: 0.15, ruts: 1.05, gain: 0.62 },
    { x: 9.6, z: 4.2, r: 6.6, a0: 2.55, a1: 3.5, w: 0.28, ruts: 0, gain: 0.5 },
    // Short heel skids through the combat zone itself. Everything above sweeps
    // round the outside of the pit, which left the six metres the camera spends
    // the whole match looking at as the cleanest concrete in the room.
    { x: -1.2, z: 5.6, r: 4.4, a0: 1.15, a1: 1.95, w: 0.22, ruts: 0, gain: 0.78 },
    { x: 3.6, z: 5.2, r: 3.9, a0: 1.35, a1: 2.15, w: 0.19, ruts: 0.7, gain: 0.62 },
    { x: -4.6, z: -3.4, r: 4.2, a0: -0.35, a1: 0.5, w: 0.3, ruts: 0, gain: 0.66 },
    { x: 6.4, z: -2.2, r: 4.6, a0: 2.3, a1: 3.05, w: 0.24, ruts: 0, gain: 0.58 },
  ];
  /**
   * Oil. The noise field alone spreads a thin film everywhere something might
   * once have leaked, which averages out to no stain at all; a floor reads as
   * used because of a specific dark patch under a specific machine. These are
   * those patches — a soft halo with a darker core, feathered so the edge is a
   * spread rather than an outline.
   */
  const stains = [
    { x: -7.6, z: -5.2, r: 1.9, gain: 0.95 },
    { x: 8.9, z: -4.1, r: 1.5, gain: 0.8 },
    { x: -2.1, z: 8.6, r: 2.3, gain: 0.7 },
    { x: 4.4, z: 9.4, r: 1.3, gain: 0.85 },
    { x: 11.2, z: 3.0, r: 1.7, gain: 0.6 },
    { x: -11.4, z: 4.6, r: 1.4, gain: 0.72 },
    { x: 1.8, z: -1.4, r: 1.1, gain: 0.45 },
  ];
  const oilMask = new Uint8Array(n);

  for (const p of patches) { p.c = Math.cos(p.rot); p.s = Math.sin(p.rot); }

  for (let j = 0; j < size; j++) {
    const wz = FLOOR.cz + (0.5 - j / size) * FLOOR.d;
    for (let i = 0; i < size; i++) {
      const wx = FLOOR.cx + (i / size - 0.5) * FLOOR.w;
      const k = j * size + i;

      let tone = 0;
      let seam = 0;
      for (const p of patches) {
        const dx = Math.abs(p.c * (wx - p.x) + p.s * (wz - p.z)) - p.w / 2;
        const dz = Math.abs(-p.s * (wx - p.x) + p.c * (wz - p.z)) - p.d / 2;
        const sd = Math.max(dx, dz);
        if (sd > 0.06) continue;
        tone += p.tone * (1 - smoothstep(-0.06, 0.02, sd));
        seam = Math.max(seam, 1 - smoothstep(0.006, 0.05, Math.abs(sd)));
      }
      patchTone[k] = Math.round(clamp01(tone * 0.5 + 0.5) * 255);
      patchJoint[k] = Math.round(clamp01(seam) * 255);

      let sc = 0;
      for (const d of drags) {
        const rad = Math.hypot(wx - d.x, wz - d.z);
        const span = d.a1 - d.a0;
        const off = d.ruts ? Math.abs(Math.abs(rad - d.r) - d.ruts * 0.5) : Math.abs(rad - d.r);
        if (off > d.w) continue;
        let a = Math.atan2(wz - d.z, wx - d.x) - d.a0;
        if (a < -Math.PI) a += Math.PI * 2;
        if (a < -0.35 || a > span + 0.35) continue;
        // Fade at both ends of the sweep so a mark starts and stops the way a
        // dragged edge does, rather than being cut off square.
        const ends = smoothstep(-0.35, 0.12, a) * (1 - smoothstep(span - 0.12, span + 0.35, a));
        sc = Math.max(sc, d.gain * ends * (1 - smoothstep(d.w * 0.35, d.w, off)));
      }
      scuff[k] = Math.round(clamp01(sc) * 255);

      let ol = 0;
      for (const s of stains) {
        const d = Math.hypot((wx - s.x) * (1 + s.r * 0.06), wz - s.z) / s.r;
        if (d > 1.35) continue;
        // Core plus halo: the core is where it soaked in, the halo where it ran.
        ol = Math.max(ol, s.gain * (0.45 * (1 - smoothstep(0.15, 1.3, d)) + 0.55 * (1 - smoothstep(0.0, 0.65, d))));
      }
      oilMask[k] = Math.round(clamp01(ol) * 255);

      let cov = 0;
      let kind = 0;

      // Test-ring: a broken outer circle plus a thin inner companion.
      const r = Math.hypot(wx, wz);
      const ang = Math.atan2(wz, wx);
      const gap = Math.abs(Math.sin(ang * 2)) > 0.985 ? 0 : 1;
      cov = Math.max(cov, gap * (1 - smoothstep(0.055, 0.085, Math.abs(r - 6.2))));
      cov = Math.max(cov, gap * (1 - smoothstep(0.02, 0.035, Math.abs(r - 6.52))));
      // Centre mark: a short cross on the fight axis, low contrast.
      if (Math.abs(wz) < 0.9) cov = Math.max(cov, 0.7 * (1 - smoothstep(0.02, 0.04, Math.abs(wx))));
      if (Math.abs(wx) < 0.9) cov = Math.max(cov, 0.7 * (1 - smoothstep(0.02, 0.04, Math.abs(wz))));

      // Run-off hazard bands against each combat wall.
      const ax = Math.abs(wx);
      const inBand = ax > ARENA_HALF_WIDTH - 1.15 && ax < ARENA_HALF_WIDTH + 0.35 && wz > -8.6 && wz < 13;
      if (inBand) {
        const t = ((wz * 0.72 + (ax - (ARENA_HALF_WIDTH - 1.15)) * 0.72) / 0.62) % 1;
        const tt = t < 0 ? t + 1 : t;
        cov = 1;
        kind = tt < 0.5 ? 1 : 2;
        // Crisp edge lines top and bottom of the band.
        const edge = Math.min(
          Math.abs(ax - (ARENA_HALF_WIDTH - 1.15)),
          Math.abs(ax - (ARENA_HALF_WIDTH + 0.35)),
        );
        if (edge < 0.05) kind = 2;
      }

      if (text[k] > 0.02) { cov = Math.max(cov, text[k]); kind = 0; }
      mark[k] = cov;
      markKind[k] = kind;
    }
  }

  // --- height, wetness and the composite ----------------------------------
  const height = new Float32Array(n);
  const wet = new Float32Array(n);
  const albedoData = new Uint8Array(n * 4);

  const conc = hexToLinear(0x2f3033);
  const concPale = hexToLinear(0x44454a);
  const concDark = hexToLinear(0x171719);
  const paintWhite = hexToLinear(0xa9a49a);
  const paintYellow = hexToLinear(0xbf9218);
  const paintBlack = hexToLinear(0x141416);
  const oilCol = hexToLinear(0x0a0a0c);
  const rubber = hexToLinear(0x131315);
  const concWarm = hexToLinear(0x3b352e);  // an older, greyer-brown pour
  const concFresh = hexToLinear(0x4a4c52); // a newer, colder one
  const oilBase = new Float32Array(n);     // reused by the ORM pass

  for (let j = 0; j < size; j++) {
    const fy = j * s2f;
    const wz = FLOOR.cz + (0.5 - j / size) * FLOOR.d;
    for (let i = 0; i < size; i++) {
      const fx = i * s2f;
      const wx = FLOOR.cx + (i / size - 0.5) * FLOOR.w;
      const k = j * size + i;

      const fine = sampleWrap(fines, FIELD, fx, fy);
      const mac = sampleWrap(macro, FIELD, fx, fy);
      const stn = sampleWrap(stain, FIELD, fx, fy);
      const wr = sampleWrap(wearF, FIELD, fx, fy);
      // Aggregate is sampled eight times denser than the other fields: at
      // 32m across the slab, one Worley cell has to be a 5cm stone, not a 40cm
      // blotch.
      const agg = sampleWrap(aggregate, FIELD, fx * 8, fy * 8);
      const crk = sampleWrap(crackF, FIELD, fx, fy);
      const pud = sampleWrap(puddleCells.f1, FIELD, fx, fy);
      const pid = sampleWrap(puddleCells.id, FIELD, fx, fy);
      const oi = sampleWrap(oil, FIELD, fx, fy);
      const reg = sampleWrap(region, FIELD, fx, fy);
      const dry = sampleWrap(drying, FIELD, fx, fy);
      const sc = scuff[k] / 255;
      const tone = patchTone[k] / 127.5 - 1;
      const seam = patchJoint[k] / 255;

      // Slab: expansion joints on a 4m grid, aggregate popping through, a
      // long-wavelength dish so water has somewhere to collect.
      //
      // A 2m half-grid is interleaved under the 4m one at a third of the
      // strength — a real slab this size is poured in bays and sawn into panels
      // inside them, and the sawn cut is shallower and dirtier than the formed
      // joint. This is here for a measured reason: the deck carries 55% of the
      // wide frame's 8x8 tiles, and at the wide framing a 4m grid puts a joint
      // through roughly one tile in five. Halving the pitch is the cheapest way
      // to put a hard edge in a tile that had none, and it costs no texture, no
      // triangle and no draw call.
      const jx = Math.abs(((wx / 4 + 100.5) % 1) - 0.5) * 4;
      const jz = Math.abs(((wz / 4 + 100.5) % 1) - 0.5) * 4;
      const sx = Math.abs(((wx / 2 + 100.5) % 1) - 0.5) * 2;
      const sz = Math.abs(((wz / 2 + 100.5) % 1) - 0.5) * 2;
      const joint = Math.max(
        1 - smoothstep(0.012, 0.03, jx),
        1 - smoothstep(0.012, 0.03, jz),
        (1 - smoothstep(0.008, 0.026, sx)) * 0.34,
        (1 - smoothstep(0.008, 0.026, sz)) * 0.34,
        seam * 0.85,
      );
      const crack = smoothstep(0.9, 0.995, crk) * (1 - joint);
      // The region field is a genuine fall across the slab, ten metres of
      // wavelength on top of the macro dish. It is what decides which end of
      // the pit drains, so puddles cluster instead of speckling evenly.
      const dish = (mac - 0.5) * 0.5 + (reg - 0.5) * 0.9;

      let h = fine * 0.22 + smoothstep(0.14, 0, agg) * 0.11 + dish;
      h -= joint * 0.9 + crack * 0.5;
      h += tone * 0.06;
      height[k] = h;

      // Oil finds the edges of a working floor: plant stands round the rim, and
      // nothing gets parked in the middle of a test cell.
      const rim = smoothstep(4.5, 10.5, Math.max(Math.abs(wx) * 0.92, Math.abs(wz - 1)));
      const oily = clamp01(smoothstep(0.6, 0.9, oi) * (0.22 + rim * 1.15) + (oilMask[k] / 255) * 0.85);

      // Wetness: everything is faintly damp, cells whose id passes the
      // threshold hold standing water, and water pools where the slab dips.
      // Three things then take water away again — a dry region, a rubber smear
      // and an oil film all shed it — which is what breaks up the uniform sheen.
      //
      // The pool gate is deliberately generous on the dish and tight on the
      // cell: fewer, wider pools sitting in the low spots read as a floor that
      // drains somewhere, where many small ones read as speckle.
      const puddleCell = smoothstep(0.38, 0.56, pid);
      const pool = puddleCell * (1 - smoothstep(0.34, 0.74, pud)) * (1 - smoothstep(0.02, 0.4, h + 0.32));
      // The damp base follows the fall of the slab rather than sitting flat, so
      // one end of the pit is visibly wetter than the other instead of the
      // whole deck carrying the same sheen.
      const damp = clamp01(0.13 + stn * 0.4 + smoothstep(0.34, 0.78, reg) * 0.5 - Math.abs(wz - 1) * 0.01);
      const puddle = clamp01(pool * 2.05 + joint * 0.35 * puddleCell);
      const shed = clamp01(smoothstep(0.54, 0.88, dry) * 0.6 + sc * 0.55 + oily * 0.5 + clamp01(tone) * 0.28);
      wet[k] = clamp01((damp * 0.55 + puddle) * (1 - shed * 0.62));

      // Water surface is flat: flatten the height that feeds the normal map.
      height[k] = lerp(h, dish * 0.35, clamp01(puddle * 1.2 * (1 - shed)));
      oilBase[k] = oily;

      // --- albedo -----------------------------------------------------------
      const cov = mark[k] * clamp01(1 - wr * 0.95) * (1 - crack * 0.8) * (1 - sc * 0.7);
      const kind = markKind[k];
      const paint = kind === 1 ? paintYellow : kind === 2 ? paintBlack : paintWhite;

      for (let ch = 0; ch < 3; ch++) {
        let v = lerp(conc[ch], concPale[ch], fine * 0.5 + smoothstep(0.16, 0, agg) * 0.28);
        // A patch is a different pour, so it shifts hue as well as value —
        // matching the tone and missing the colour is what makes a repaired
        // slab look like a decal instead of concrete.
        if (tone > 0) v = lerp(v, concFresh[ch], tone * 0.55);
        else if (tone < 0) v = lerp(v, concWarm[ch], -tone * 0.5);
        // Region drift: ten metres of wavelength straight into albedo, on top
        // of what it already does through the wetness. Without it the only
        // large-scale variation on the deck is the sheen, and a floor whose
        // tone is constant across thirty metres reads as one tiled material
        // however much fine detail sits on top.
        v = lerp(v, concDark[ch], mac * 0.42 + stn * 0.3 + (1 - reg) * 0.22);
        v = lerp(v, oilCol[ch], clamp01(oily) * 0.72);
        v *= 1 - crack * 0.55 - joint * 0.45;
        v = lerp(v, paint[ch] * (0.72 + fine * 0.55), cov);
        v = lerp(v, rubber[ch] * (0.8 + fine * 0.5), sc * 0.82);
        // Wet concrete is darker concrete. This is the single most convincing
        // cue that a floor is wet, ahead of the reflection itself.
        v *= lerp(1, 0.32, clamp01(wet[k] * 1.35));
        const o = k * 4 + ch;
        albedoData[o] = encodeSrgb(v);
      }
      albedoData[k * 4 + 3] = 255;
    }
  }

  // --- derived channels ----------------------------------------------------
  const aoSmall = heightToAo(resample(height, size, FIELD), FIELD, 5, 1.0);
  const normalData = heightToNormal(height, size, 2.1, { wrap: false, alpha: wet });

  const ormData = new Uint8Array(n * 4);
  for (let j = 0; j < size; j++) {
    const fy = j * s2f;
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const ao = sampleWrap(aoSmall, FIELD, i * s2f, fy);
      const w = wet[k];
      const fine = sampleWrap(fines, FIELD, i * s2f, fy);
      // Dry concrete 0.74 -> damp 0.26 -> standing water 0.06. The damp value
      // is the important one: it is most of the floor, and it is what decides
      // whether a fighter has a reflection to stand on.
      let rough = lerp(0.78, 0.33, clamp01(w * 1.7));
      rough = lerp(rough, 0.06, clamp01((w - 0.55) * 2.6));
      rough = clamp01(rough + fine * 0.05 - mark[k] * 0.06);
      // Rubber transfer is smoother than the concrete under it and oil is
      // smoother still, so both catch a highlight the surrounding deck does
      // not — two more ways for the floor to stop being one surface.
      rough = lerp(rough, 0.34, (scuff[k] / 255) * 0.75);
      rough = lerp(rough, 0.14, clamp01(oilBase[k]) * 0.8);
      // A fresh pour is a rougher pour; an old one is polished by traffic.
      rough = clamp01(rough + (patchTone[k] / 127.5 - 1) * 0.09);
      const o = k * 4;
      ormData[o] = Math.round(clamp01(ao) * 255);
      ormData[o + 1] = Math.round(rough * 255);
      ormData[o + 2] = Math.round(clamp01(mark[k] * 0.08) * 255);
      ormData[o + 3] = 255;
    }
  }

  return {
    albedo: makeTexture(albedoData, size, { srgb: true, clamp: true }),
    normal: makeTexture(normalData, size, { clamp: true }),
    orm: makeTexture(ormData, size, { clamp: true }),
  };
}

/** Tiling water-ripple normal map, scrolled in two directions by the shader. */
function rippleNormal(size = 256) {
  const a = fbm(size, 7, { octaves: 4, seed: 311 });
  const b = fbm(size, 17, { octaves: 3, seed: 313 });
  const h = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) h[k] = a[k] * 0.7 + b[k] * 0.3;
  const smooth = blur(h, size, 2, 2);
  return makeTexture(heightToNormal(smooth, size, 3.2, { wrap: true }), size);
}

// ---------------------------------------------------------------------------
// Shader injection
// ---------------------------------------------------------------------------

const VERT_HOOK = /* glsl */ `
  #include <project_vertex>
  vec4 kbWorld = modelMatrix * vec4( transformed, 1.0 );
  vKbReflCoord = uTextureMatrix * kbWorld;
  vKbWorld = kbWorld.xyz;
`;

const FRAG_NORMAL_HOOK = /* glsl */ `
  #include <normal_fragment_maps>
  {
    // View -> world for an orthonormal view matrix is a transpose, which in
    // GLSL is just the reversed multiply.
    vec3 kbWorldN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
    kbWetness = texture2D( uWetMap, vNormalMapUv ).a;

    vec3 det = texture2D( uDetailNormal, vKbWorld.xz * uDetailScale ).xyz * 2.0 - 1.0;
    vec2 perturb = det.xy * uDetailAmp * ( 1.0 - kbWetness * 0.75 );

    vec2 r1 = vKbWorld.xz * uRippleScale + vec2( uTime * 0.021, uTime * 0.013 );
    vec2 r2 = vKbWorld.xz * uRippleScale * 1.73 - vec2( uTime * 0.016, - uTime * 0.024 );
    vec3 rip = ( texture2D( uRippleMap, r1 ).xyz + texture2D( uRippleMap, r2 ).xyz ) - 2.0;
    perturb += rip.xy * uRippleAmp * kbWetness * kbWetness;

    kbWorldN.xz += perturb;
    kbWorldN = normalize( kbWorldN );
    normal = normalize( ( viewMatrix * vec4( kbWorldN, 0.0 ) ).xyz );
  }
`;

const FRAG_REFLECT_HOOK = /* glsl */ `
  #include <opaque_fragment>
  {
    float wet = kbWetness;
    if ( uReflStrength > 0.001 && wet > 0.02 ) {
      // Distort the projection by the same normal that shades the surface, so
      // the reflection swims with the ripples instead of sliding under them.
      vec3 viewN = normalize( normal );
      vec3 viewDir = normalize( vViewPosition );
      float fres = pow( 1.0 - saturate( dot( viewDir, viewN ) ), 4.0 );
      fres = mix( 0.03, 1.0, fres );

      vec4 coord = vKbReflCoord;
      vec3 wn = normalize( ( vec4( viewN, 0.0 ) * viewMatrix ).xyz );
      coord.xy += wn.xz * uReflDistort * coord.w;

      // Roughness-proportional gather: a puddle mirrors, damp concrete smears.
      float blurR = clamp( material.roughness * uReflBlur, 0.0, 0.030 ) * coord.w;
      vec3 refl = texture2DProj( uReflection, coord ).rgb * 0.36;
      refl += texture2DProj( uReflection, coord + vec4(  blurR, 0.0, 0.0, 0.0 ) ).rgb * 0.16;
      refl += texture2DProj( uReflection, coord + vec4( -blurR, 0.0, 0.0, 0.0 ) ).rgb * 0.16;
      refl += texture2DProj( uReflection, coord + vec4( 0.0,  blurR * 0.6, 0.0, 0.0 ) ).rgb * 0.16;
      refl += texture2DProj( uReflection, coord + vec4( 0.0, -blurR * 0.6, 0.0, 0.0 ) ).rgb * 0.16;

      // Roughness fade. This is the term that decides how much of the deck is
      // allowed to mirror at all, and it used to close at 0.78 — which on this
      // floor is most of it, because damp concrete bakes out around 0.5. The
      // gap that left was being filled by a screen-space pass in the post
      // chain, additively and on the same pixels; with that pass gone the fade
      // has to run out to where the concrete actually stops being reflective,
      // and the blur above has to grow far enough that the rough end smears
      // rather than mirrors. A rough surface reflects less sharply, not less.
      float k = uReflStrength * fres * smoothstep( 0.02, 0.34, wet )
              * ( 1.0 - smoothstep( uReflRough.x, uReflRough.y, material.roughness ) );
      // Energy-conserving: the reflection replaces diffuse rather than adding
      // to it, which is what keeps a wet floor from turning milky.
      gl_FragColor.rgb = mix( gl_FragColor.rgb, gl_FragColor.rgb * ( 1.0 - k * 0.55 ) + refl, saturate( k ) );
    }
  }
`;

/**
 * Attaches the reflection, detail-normal and ripple hooks to a standard
 * material. Kept as an `onBeforeCompile` graft rather than a bespoke
 * ShaderMaterial so the floor keeps three's shadows, IBL, fog and tone mapping.
 */
function graftFloorShader(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uTextureMatrix;\nvarying vec4 vKbReflCoord;\nvarying vec3 vKbWorld;')
      .replace('#include <project_vertex>', VERT_HOOK);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uReflection;
uniform sampler2D uDetailNormal;
uniform sampler2D uRippleMap;
uniform sampler2D uWetMap;
uniform float uReflStrength;
uniform float uReflDistort;
uniform float uReflBlur;
uniform vec2 uReflRough;
uniform float uDetailScale;
uniform float uDetailAmp;
uniform float uRippleScale;
uniform float uRippleAmp;
uniform float uTime;
varying vec4 vKbReflCoord;
varying vec3 vKbWorld;
float kbWetness = 0.0;`,
      )
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL_HOOK)
      .replace('#include <opaque_fragment>', FRAG_REFLECT_HOOK);
    material.userData.shader = shader;
  };
  // Force a unique program so the graft is not shared with an ungrafted clone.
  material.customProgramCacheKey = () => 'kb-floor';
}

// ---------------------------------------------------------------------------

export class StageFloor {
  /**
   * @param {object} deps
   * @param {import('./PlanarReflector.js').PlanarReflector} deps.reflector
   * @param {Record<string, THREE.Material>} deps.materials arena material library
   * @param {Record<string, THREE.Texture>} deps.textures arena texture library
   * @param {'ultra'|'high'|'medium'|'low'} [deps.quality]
   */
  constructor({ reflector, materials, textures, bins, quality = 'high' }) {
    this.reflector = reflector;
    this.group = new THREE.Group();
    this.group.name = 'arena.floor';
    this.floorY = GROUND_Y;

    const res = quality === 'low' ? 512 : quality === 'medium' ? 1024 : 2048;
    const maps = bakeFloorMaps(res);
    this.maps = maps;
    this.ripple = rippleNormal(quality === 'low' ? 128 : 256);

    this.uniforms = {
      uReflection: { value: reflector.texture },
      uTextureMatrix: { value: reflector.textureMatrix },
      uDetailNormal: { value: textures.concreteNormal },
      uRippleMap: { value: this.ripple },
      uWetMap: { value: maps.normal },
      uReflStrength: { value: 0.62 },
      uReflDistort: { value: 0.028 },
      uReflBlur: { value: 0.075 },
      // Roughness at which the reflection starts and finishes fading out.
      uReflRough: { value: new THREE.Vector2(0.30, 0.98) },
      uDetailScale: { value: 2.4 },
      uDetailAmp: { value: 0.55 },
      uRippleScale: { value: 0.35 },
      uRippleAmp: { value: 0.09 },
      uTime: { value: 0 },
    };

    /** Scaled to zero when the quality tier turns the mirror pass off. */
    this.reflectionScale = 1;

    this.material = new THREE.MeshPhysicalMaterial({
      name: 'arena.floorWet',
      map: maps.albedo,
      normalMap: maps.normal,
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      aoMap: maps.orm,
      roughness: 1,
      metalness: 1,
      // Water and concrete are both dielectrics; the specular response comes
      // from ior, not from a metalness slider.
      ior: 1.42,
      specularIntensity: 1,
      normalScale: new THREE.Vector2(1.0, 1.0),
      envMapIntensity: 0.42,
      dithering: true,
    });
    graftFloorShader(this.material, this.uniforms);

    const geo = new THREE.PlaneGeometry(FLOOR.w, FLOOR.d, 24, 20);
    geo.rotateX(-Math.PI / 2);
    geo.translate(FLOOR.cx, this.floorY, FLOOR.cz);
    // aoMap reads uv1; the macro map has one layout so they are the same.
    geo.setAttribute('uv1', geo.attributes.uv.clone());
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'arena.floor.slab';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    // Drives the mirror pass. Runs during the main scene render, when the
    // camera transform for the frame is final.
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      reflector.render(renderer, camera, this.mesh);
    };
    this.group.add(this.mesh);

    this.#buildApron();
    this.#buildDrains(bins);
    this.#buildDecals(textures);
  }

  /**
   * The slab has to end somewhere. An unlit apron running out to the fog
   * distance keeps the horizon from showing void behind the set, and it is the
   * cheapest possible geometry: two triangles.
   *
   * It is on `LAYER.NO_REFLECT` because it sits two centimetres *below* the
   * mirror plane, which puts it between the reflection camera and that plane —
   * so the oblique near plane clips every fragment of it. Drawing it into the
   * mirror was a draw call a frame for an image that could not survive the
   * clip.
   */
  #buildApron() {
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({
        name: 'arena.apron',
        color: 0x0a0b0d,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.25,
        dithering: true,
      }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(0, this.floorY - 0.02, 0);
    apron.receiveShadow = false;
    apron.matrixAutoUpdate = false;
    apron.updateMatrix();
    apron.name = 'arena.floor.apron';
    apron.layers.set(LAYER.NO_REFLECT);
    this.apron = apron;
    this.group.add(apron);
  }

  /**
   * Recessed drainage channels with real bar grating over them. They sit
   * outside the play bounds so nothing can trip on them, and they break the
   * slab up exactly where the eye would otherwise notice it tiling.
   */
  #buildDrains(bins) {
    const runs = [
      { pos: [0, 0, -7.6], size: [22, 0.9], rot: 0 },
      { pos: [-11.1, 0, 2.5], size: [17, 0.8], rot: Math.PI / 2 },
      { pos: [11.1, 0, 2.5], size: [17, 0.8], rot: Math.PI / 2 },
    ];
    for (const r of runs) {
      const [w, d] = r.size;
      // The pit under the grating: a dark box, so the grating reads as holes.
      bins.dark.push(place(bevelBox(w, 0.34, d, 0.02), { pos: [r.pos[0], -0.19, r.pos[2]], rot: [0, r.rot, 0] }));
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.rotateY(r.rot);
      g.translate(r.pos[0], this.floorY - 0.025, r.pos[2]);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 0.9), uv.getY(i) * (d / 0.9));
      bins.grate.push(g);
    }
  }

  /**
   * Scuff and scorch decals dropped by heavy impacts. Multiply blending means
   * they darken whatever is already there without needing to be lit, and one
   * instanced mesh covers the whole round.
   */
  #buildDecals(textures) {
    const COUNT = 28;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    // An InstancedBufferAttribute on an ordinary geometry is all an
    // InstancedMesh needs for per-instance data; no InstancedBufferGeometry.
    this._decalAlpha = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    geo.setAttribute('aAlpha', this._decalAlpha);

    const mat = new THREE.ShaderMaterial({
      name: 'arena.floorDecal',
      uniforms: { map: { value: textures.scorch }, uTint: { value: new THREE.Color(0x1a1c22) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vUv = uv;
          vAlpha = aAlpha;
          vec4 world = instanceMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * modelViewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uTint;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          float a = texture2D( map, vUv ).a * vAlpha;
          if ( a < 0.004 ) discard;
          gl_FragColor = vec4( mix( vec3( 1.0 ), uTint, a ), 1.0 );
        }
      `,
      // dst * src: a scuff darkens what is under it and needs no lighting of
      // its own. Spelled out rather than using MultiplyBlending, which in r185
      // additionally demands premultiplied alpha.
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendEquation: THREE.AddEquation,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    });

    this.decals = new THREE.InstancedMesh(geo, mat, COUNT);
    this.decals.name = 'arena.floor.decals';
    this.decals.frustumCulled = false;
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.userData.gbuffer = false;
    // Decals are painted on the floor; reflecting them would double them up.
    this.decals.layers.set(LAYER.NO_REFLECT);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < COUNT; i++) this.decals.setMatrixAt(i, zero);
    this.decals.instanceMatrix.needsUpdate = true;
    this._decalNext = 0;
    this._decalLife = new Float32Array(COUNT);
    this.group.add(this.decals);
  }

  /**
   * Stamps a scuff at a world point.
   * @param {THREE.Vector3} point
   * @param {number} size metres across
   * @param {number} strength 0..1
   * @param {number} rotation radians
   */
  scuff(point, size, strength, rotation) {
    const i = this._decalNext;
    this._decalNext = (i + 1) % this.decals.count;
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(point.x, this.floorY + 0.004 + i * 0.0006, point.z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotation, 0)),
      new THREE.Vector3(size, 1, size),
    );
    this.decals.setMatrixAt(i, m);
    this.decals.instanceMatrix.needsUpdate = true;
    this._decalLife[i] = clamp01(strength);
    this._decalAlpha.setX(i, this._decalLife[i]);
    this._decalAlpha.needsUpdate = true;
  }

  /** @param {number} dt @param {object} envParams live Environment mood params */
  update(dt, time, envParams) {
    this.uniforms.uTime.value = time;
    // The mood decides how wet the room is; the floor decides how that reads.
    // The curve is steeper than it was because this is now the only reflection
    // the floor gets: the screen-space pass that used to sit on top of it in
    // the post chain carried about a third of the visible wet, and that third
    // has to come from the mirror instead of from nowhere.
    const refl = envParams?.floorRefl ?? 0.32;
    this.uniforms.uReflStrength.value = (0.34 + refl * 1.45) * this.reflectionScale;
    // Scuffs dry out over the round rather than vanishing on a timer.
    let dirty = false;
    for (let i = 0; i < this._decalLife.length; i++) {
      if (this._decalLife[i] <= 0) continue;
      this._decalLife[i] = Math.max(0, this._decalLife[i] - dt * 0.012);
      this._decalAlpha.setX(i, this._decalLife[i]);
      dirty = true;
    }
    if (dirty) this._decalAlpha.needsUpdate = true;
  }

  reset() {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.decals.count; i++) {
      this.decals.setMatrixAt(i, zero);
      this._decalLife[i] = 0;
      this._decalAlpha.setX(i, 0);
    }
    this.decals.instanceMatrix.needsUpdate = true;
    this._decalAlpha.needsUpdate = true;
    this._decalNext = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.maps.albedo.dispose();
    this.maps.normal.dispose();
    this.maps.orm.dispose();
    this.ripple.dispose();
    this.decals.geometry.dispose();
    this.decals.material.dispose();
    this.apron.geometry.dispose();
    this.apron.material.dispose();
  }
}
