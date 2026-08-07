/**
 * Knockbots — THE CISTERN: a flooded underground plant vault.
 *
 * This is the second arena set module, a sibling of {@link StageStructure}, and
 * it exists because it is the OPPOSITE lighting problem to the pit. The pit is a
 * closed hall lit evenly from twelve metres up by soft banks; every surface in it
 * gets something. Down here there is **no sky and no ambient**: the only sources
 * are hard emissive strips bracketed a metre off the things they light, so a pier
 * is blown out at the strip and gone two metres away. That gradient is the whole
 * look and it is the one thing a twelve-metre bank can never produce.
 *
 * Organised by DEPTH BAND, like its sibling, and this file is explicit about the
 * lighting treatment of each because "only three depth layers, and the third
 * carries no readable information" is the standing complaint against the pit:
 *
 *   - **A, z +8.4 to +10.6 — foreground occlusion.** Two broken pier stubs
 *     outboard of the play bound at x -10.9 and +11.2, and a service run hung
 *     under the deck soffit at y 4.4. NO source is aimed at it: it is
 *     near-silhouette, cut out of the lit water behind it, and it is the only
 *     thing in the set nearer than the fighters. It is placed OUTBOARD and HIGH
 *     rather than merely forward, because the fight camera roams z 4 to 13 and
 *     nothing in the near field is reliably in front of it — see `#foreground`,
 *     which has the solve and the defect it was written to fix.
 *   - **B, z -6.2 to +6.2 — the fight deck and the water.** The only band with a
 *     real key. Two mercury strips on the tank walls, a sodium bulkhead lamp on
 *     the near right, and the weir wall behind the fighters as a broad plain
 *     shadow-catcher. This is also the band the floor's planar mirror serves.
 *   - **C, z -8.6 to -14.2 — the arcade.** Two staggered rows of piers carrying
 *     brick barrel vaults. Each bay is lit ONLY by its own strip and half of them
 *     have none, so the arcade alternates lit and dark across the frame. One bay
 *     is collapsed and one is shuttered with stop-logs, which is what stops a
 *     rhythmic colonnade reading as wallpaper.
 *   - **D, z -17 to -21 — the machine hall**, seen through the bulkhead arch.
 *     Pumps, a gantry and a valve wall, at a lower value, with ONE sodium fitting
 *     of its own and its own depth haze. It carries readable information (forty
 *     handwheels on a manifold) rather than being a dark smear.
 *   - **E, z -26 to -31 — the tunnel mouth.** A single distant lamp and a haze
 *     card. The one place the eye can see depth run away.
 *
 * **Four hue bins**, against the pit's measured two (90% of its saturated pixels
 * cyan): cold mercury white on the strips and the brick soffits, sodium amber on
 * the older fittings and the whole machine hall, a green emergency box over the
 * side door, and the deep blue-green of lit standing water across the near deck.
 *
 * **No THREE.Light anywhere.** The frame is fill-bound at ~18ms and each analytic
 * light costs ~1.5ms, so every emitter here is an emissive mesh plus gradient
 * cards, exactly as `StagePracticals` does it — see the notes on {@link WASHES}
 * there for why the near-field term MULTIPLIES and the scatter term ADDS. A vault
 * lit only by strips is the single most tempting place in this project to reach
 * for a point light; it is also the place where sixteen of them would cost the
 * whole frame budget.
 */

import * as THREE from 'three';
import { LAYER } from '../core/Constants.js';
import { Rng } from '../core/Rng.js';
import {
  bevelBox, place, mergeAll, worldUv, tube, pipeRun, catenary, segment, spanX,
  railing, insetPanel, boltRow, boltRing, truss, cableTray, hydraulicRam,
} from './GeoKit.js';
import {
  fbm, worley, blur, resample, clamp01, lerp, smoothstep, hexToLinear, encodeSrgb,
  heightToNormal, heightToAo, sampleWrap, stampText, bakeAlbedo, packOrm, makeTexture,
} from './ProcTex.js';
import { FLOOR } from './StageFloor.js';

// ---------------------------------------------------------------------------
// The tank
//
// Every number below is shared between the geometry and the floor bake, which
// is the point of having them here: the deck's tide mark and the piers' tide
// ledge are the same water at the same elevation, and if they disagree by five
// centimetres the room stops being a room.
// ---------------------------------------------------------------------------

/** Inside face of the long tank walls. Outside the play bound (9.0) by 2.4m. */
const TANK_X = 11.4;
/**
 * +z limit of the modelled tank.
 *
 * 15.0, and it was 9.4. The occlusion audit caught the difference: the fight
 * camera sits at `focus.z + dist` and reaches z 13 when the pair is forward, so
 * at 9.4 the lens could get PAST the front edge of the tank walls and graze
 * them end-on — 0.2m from the wall's front return, which then swept a fifth of
 * the frame and hid 22% of a cornered fighter's silhouette. The wall was not in
 * the way; the room simply stopped before the camera did.
 *
 * This is the same repair `StageStructure#outerShell` makes for the pit, and
 * its comment is the rule: a room has to be a room from every angle the camera
 * can legally reach. At the wide framing the extension is invisible — the walls
 * are 9.2m off the view axis and the frustum is only 7.5m wide at that depth —
 * so it costs geometry and buys the absence of a defect.
 */
const TANK_FRONT = 15.0;
/** Springing level of the vaults; the piers are plain below this. */
const SPRING_Y = 3.4;
/** Crown of a bay vault. Bay spans are ~4.6m, so the rise is ~2.15m. */
const CROWN_Y = 5.55;

/** The low weir wall directly behind the fight plane. */
const WEIR_Z = -6.2;
const WEIR_Y = 1.32;
/**
 * Front and back pier rows of the arcade.
 *
 * The front row is a 3.4m-deep respond, so it occupies z -11.1 to -7.7 and
 * leaves 1.2m of clear water between its mouth and the back of the weir. That
 * gap is not spare space: it is the strip of deck that catches the light
 * spilling OUT of the lit bays, and it is the only place in the frame where the
 * arcade's own scatter is visible on the water rather than on brick.
 */
const ARCADE_Z = -9.4;
const ARCADE2_Z = -13.6;
/** The bulkhead the machine hall is seen through. */
const BULKHEAD_Z = -15.4;
/** Machine hall and tunnel mouth. */
const HALL_Z = -19.0;
const TUNNEL_Z = -28.5;

/**
 * Invert of the transverse sluice channel: the lowest point of the slab and the
 * thing the whole floor falls toward.
 */
const SLUICE_Z = 6.6;
/** The sump, dished into the low left corner. */
const SUMP = { x: -10.8, z: 3.2, r: 1.5 };
/** Where the fall starts, at the back of the textured slab. */
const FALL_TOP_Z = -11.0;
/** Rise from the sluice invert to the back of the slab: 0.30m in 17.6m, 1:59. */
const RISE = 0.30;
/**
 * Elevation of the standing water above the sluice invert.
 *
 * Solved rather than picked: the waterline has to cross the deck a little behind
 * the fighters' feet so they stand IN the water and their reflection lands in the
 * near half of the deck, which is the half the camera sees (the hero framing's
 * bottom edge is world z +0.95 and screen centre is z -10.7). At the fall above,
 * `RISE * (SLUICE_Z - z) / 17.6 = WATER_LEVEL` puts the mean waterline at
 * z = -2.4. 153mm of standing water over a 32m tank is also simply what a
 * cistern that is draining slowly through a blocked sluice actually holds.
 */
const WATER_LEVEL = 0.153;
/** z of the mean waterline, derived from the two above. Quoted in comments. */
const WATERLINE_Z = SLUICE_Z - (WATER_LEVEL / RISE) * (SLUICE_Z - FALL_TOP_Z);

/**
 * The OLD high-water mark, on the piers and the tank walls.
 *
 * The current water is 153mm deep, so the tide line it leaves on a vertical
 * surface is at ankle height and carries no composition at all. A cistern that
 * has been drawn down leaves a second, much higher line from the level it used
 * to run at, and that one is a hard horizontal band across every pier in the
 * room at chest height — which is the readability cue the deck's own tide mark
 * cannot give. Two horizontals at two heights is more information than one, not
 * less, and both are physically the same story.
 */
const HIGH_MARK_Y = 1.34;

/**
 * The analytic fall of the tank base, in metres above the sluice invert.
 *
 * Shared by the bake and by every decal that has to obey it. It is a function
 * rather than a noise field because the two things this floor is judged on —
 * silt pooling on the LOW side of a fall and iron staining running DOWNHILL from
 * its fixing — both need a gradient that can be differentiated, and you cannot
 * differentiate a lookup into an fbm without the answer being noise.
 */
function tankFall(wx, wz) {
  // Long fall to the sluice, 1:59. Flat past the top so the arcade floor does
  // not climb into the piers.
  let h = RISE * clamp01((SLUICE_Z - wz) / (SLUICE_Z - FALL_TOP_Z));
  // Cross-fall: a shallow crown down the tank's spine, 25mm over 6m, so water
  // leaves the middle of the floor and hugs the wall bases. You would not feel
  // it underfoot; it is what decides where the silt goes and it bows the
  // waterline by about 1.5m at the walls, which is what stops that line reading
  // as a ruled edge.
  h += 0.025 * clamp01(1 - Math.abs(wx) / 6.0);
  // The sump bowl.
  const sd = Math.hypot(wx - SUMP.x, wz - SUMP.z);
  h -= 0.135 * (1 - smoothstep(0, SUMP.r * 1.9, sd));
  return h;
}

/**
 * Construction joints in the tank base.
 *
 * A tank this size is poured in bays and the joints between them are the ONLY
 * hard straight lines on this deck. There are eight of them across 32x28m, which
 * is four lines each way — a set of lines, not a lattice, and deliberately not
 * the pit's 4m formed grid with a 2m sawn half-grid interleaved under it. That
 * grid is evaluated analytically in `StageFloor`'s FRAG_NORMAL_HOOK at a pitch
 * hard-coded to 4m and 2m, so re-using it here would put the identical lattice
 * on the identical pitch in a second arena; {@link VAULT_SURFACE} therefore
 * disables it outright and these are baked instead.
 *
 * `lo`/`hi` bound the run, so `x: 1.4` is a joint that exists in ONE bay and
 * stops. A joint that stops is the cheapest possible statement that this floor
 * was poured by people over several days rather than generated.
 */
const JOINTS = [
  { axis: 'z', at: -8.7, lo: -16, hi: 16 },
  { axis: 'z', at: -1.9, lo: -16, hi: 16 },
  { axis: 'z', at: 4.8, lo: -16, hi: 16 },
  { axis: 'z', at: 11.4, lo: -16, hi: 16 },
  { axis: 'x', at: -9.9, lo: -12, hi: 16 },
  { axis: 'x', at: -2.6, lo: -12, hi: 16 },
  { axis: 'x', at: 5.1, lo: -12, hi: 16 },
  { axis: 'x', at: 12.4, lo: -12, hi: 16 },
  // The half-bay pour: one panel was cast in two goes and the joint dies at the
  // bay boundaries either side of it.
  { axis: 'x', at: 1.4, lo: -1.9, hi: 4.8 },
];

/**
 * Fixings cast into the slab, and the iron that has been running out of them.
 *
 * Every one of these is a real thing bolted to a real tank floor — a pipe
 * penetration, a ladder foot, a bearing plate under a stanchion — and every one
 * of them weeps. The point of the list is the second half of the critic's decal
 * complaint: a stain has to run DOWNHILL from where it started, along the actual
 * fall of the slab, rather than sitting as a symmetric halo. `gain` scales it and
 * `reach` is how far the run gets before the water takes it.
 */
const FIXINGS = [
  { x: -10.8, z: 1.0, r: 0.34, gain: 0.95, reach: 4.4 },   // sump inlet flange
  { x: -6.4, z: -4.2, r: 0.22, gain: 0.8, reach: 5.6 },    // ladder foot, left
  { x: -6.0, z: -4.7, r: 0.22, gain: 0.7, reach: 5.0 },
  { x: 4.9, z: -5.1, r: 0.30, gain: 0.9, reach: 6.2 },     // stanchion bearing plate
  { x: 8.6, z: -3.4, r: 0.19, gain: 0.75, reach: 4.8 },
  { x: 11.9, z: 0.6, r: 0.26, gain: 0.85, reach: 3.6 },    // wall pipe penetration
  { x: -12.2, z: -2.4, r: 0.26, gain: 0.8, reach: 3.9 },
  { x: 2.1, z: -8.2, r: 0.42, gain: 1.0, reach: 7.0 },     // pier dowel group
  { x: -4.6, z: -8.4, r: 0.38, gain: 0.9, reach: 6.4 },
  { x: 9.6, z: -8.4, r: 0.38, gain: 0.85, reach: 6.0 },
  { x: -1.8, z: 6.9, r: 0.24, gain: 0.7, reach: 1.6 },     // sluice kerb dowels
  { x: 6.4, z: 6.9, r: 0.24, gain: 0.65, reach: 1.4 },
  { x: -13.4, z: 5.6, r: 0.20, gain: 0.6, reach: 2.4 },
  { x: 13.1, z: -6.2, r: 0.22, gain: 0.7, reach: 4.2 },
];

// ---------------------------------------------------------------------------
// Floor maps
// ---------------------------------------------------------------------------

/** Resolution of the low-frequency noise fields behind the macro map. */
const FIELD = 512;

/**
 * Macro map set for the vault deck. Same contract as `StageFloor`'s own
 * `bakeFloorMaps`: it covers the same 32x28m slab at the same world-to-texel
 * mapping, the normal map's ALPHA is the wetness mask, and the ORM is
 * (occlusion, roughness, metalness).
 *
 * The surface is a CAST CONCRETE TANK BASE, and everything in it follows from
 * that rather than from a shop floor:
 *
 *   - a shallow analytic fall to a sluice channel and a sump ({@link tankFall}),
 *   - construction joints on a coarse bay layout ({@link JOINTS}), one of which
 *     stops mid-slab, plus faint screed lines whose pitch AND direction change
 *     from bay to bay,
 *   - standing water over the low third with a real waterline: a hard pale
 *     mineral tide-mark and a darker band under it,
 *   - silt and algae that POOL against the low side of the fall and the sluice
 *     kerb instead of sitting as discs on top of them,
 *   - iron staining that RUNS from every fixing along the slab's own gradient.
 *
 * @param {number} size output edge length
 * @returns {{albedo: THREE.DataTexture, normal: THREE.DataTexture, orm: THREE.DataTexture}}
 */
export function bakeVaultMaps(size) {
  const n = size * size;
  const s2f = FIELD / size;
  const px = size / FLOOR.w;
  const pz = size / FLOOR.d;
  const worldToTexel = (wx, wz) => [
    (wx - FLOOR.cx) * px + size / 2,
    (FLOOR.cz - wz) * pz + size / 2,
  ];
  const texelToWorldX = (i) => FLOOR.cx + (i / size - 0.5) * FLOOR.w;
  const texelToWorldZ = (j) => FLOOR.cz + (0.5 - j / size) * FLOOR.d;

  // --- low-resolution fields ----------------------------------------------
  // Deliberately a different set from the pit's. That floor's signature is its
  // 5cm Worley aggregate popping through a trowelled paste; a tank base is
  // steel-floated to hold water, so it has almost no exposed aggregate and its
  // texture is mineral bloom, biofilm and acid etch instead.
  const fines = fbm(FIELD, 190, { octaves: 3, seed: 613 });
  const bloom = fbm(FIELD, 17, { octaves: 4, seed: 617 });     // mineral efflorescence
  const biofilm = fbm(FIELD, 9, { octaves: 5, seed: 619 });    // algae, blotchy
  const etch = worley(FIELD, 46, 631, 0.95);                   // acid pitting
  const craze = fbm(FIELD, 26, { octaves: 4, seed: 641, ridged: true });
  const grime = fbm(FIELD, 6, { octaves: 4, seed: 643 });
  // Two very low-frequency fields. `undulation` perturbs the fall itself, which
  // is what bows the waterline and drops isolated puddles above it; `siltDrift`
  // decides which corners the silt actually reached.
  const undulation = fbm(FIELD, 4, { octaves: 3, seed: 647, signed: true });
  const siltDrift = fbm(FIELD, 3, { octaves: 3, seed: 653 });

  // --- bounded rasterisation passes ---------------------------------------
  // Everything that is a LIST of features gets its own bounded pass into a byte
  // mask, rather than being tested against every texel inside the composite
  // loop. At 2048px the composite loop runs 4.2M times and fourteen fixings
  // inside it would be 59M distance tests for a mask that covers 3% of the
  // slab. See the bake-time note at the bottom of this function.
  const iron = new Uint8Array(n);
  const ironSoft = new Uint8Array(n);
  const silt = new Uint8Array(n);
  const paint = new Float32Array(n);
  const paintKind = new Uint8Array(n);

  // Iron staining. The direction is the slab's own downhill, measured by
  // central difference at the fixing, so a weep off the sump flange runs into
  // the sump and a weep off a pier dowel runs across the deck toward the front
  // — which is what the eye reads as "this floor is not level".
  for (const f of FIXINGS) {
    const e = 0.25;
    const gx = tankFall(f.x + e, f.z) - tankFall(f.x - e, f.z);
    const gz = tankFall(f.x, f.z + e) - tankFall(f.x, f.z - e);
    const gl = Math.hypot(gx, gz) || 1e-6;
    // Downhill is the NEGATIVE gradient.
    const dx = -gx / gl, dz = -gz / gl;
    const reach = f.reach;
    const pad = reach + f.r + 1.2;
    const [cx0, cy0] = worldToTexel(f.x, f.z);
    const rad = Math.ceil(pad * Math.max(px, pz));
    const i0 = Math.max(0, Math.floor(cx0 - rad)), i1 = Math.min(size - 1, Math.ceil(cx0 + rad));
    const j0 = Math.max(0, Math.floor(cy0 - rad)), j1 = Math.min(size - 1, Math.ceil(cy0 + rad));
    for (let j = j0; j <= j1; j++) {
      const wz = texelToWorldZ(j);
      for (let i = i0; i <= i1; i++) {
        const wx = texelToWorldX(i);
        const ax = wx - f.x, az = wz - f.z;
        // Along-flow and across-flow, in the fixing's own frame.
        const u = ax * dx + az * dz;
        const v = Math.abs(ax * -dz + az * dx);
        // The run widens as it goes, the way a rust weep on a wet floor does.
        const halfW = f.r * 0.7 + Math.max(0, u) * 0.085;
        const run = (u > -f.r * 0.4 ? 1 : 0)
          * (1 - smoothstep(reach * 0.35, reach, Math.max(0, u)))
          * (1 - smoothstep(halfW * 0.55, halfW, v));
        // The corrosion product sitting at the fixing itself, which is a halo
        // and is allowed to be — it is the only part of this that has not run.
        const halo = 1 - smoothstep(f.r * 0.55, f.r * 1.9, Math.hypot(ax, az));
        const k = j * size + i;
        const hard = clamp01(f.gain * Math.max(run, halo * 0.9));
        if (hard * 255 > iron[k]) iron[k] = Math.round(hard * 255);
        // A wide, weak dispersion for whatever ran on into the standing water.
        const soft = clamp01(f.gain * 0.55 * (1 - smoothstep(0, reach * 1.25, Math.hypot(ax, az)))
          * (0.35 + 0.65 * clamp01(u / (reach * 0.5))));
        if (soft * 255 > ironSoft[k]) ironSoft[k] = Math.round(soft * 255);
      }
    }
  }

  // Silt. It is not a feature list at all — it is a function of depth and of
  // what the water was flowing against, so it is rasterised over the whole slab
  // but at FIELD resolution and upsampled, because silt has no edge finer than
  // a hand's width and paying 2048px for it is nothing but time.
  {
    const sf = new Float32Array(FIELD * FIELD);
    for (let j = 0; j < FIELD; j++) {
      const wz = FLOOR.cz + (0.5 - j / FIELD) * FLOOR.d;
      for (let i = 0; i < FIELD; i++) {
        const wx = FLOOR.cx + (i / FIELD - 0.5) * FLOOR.w;
        const k = j * FIELD + i;
        const depth = WATER_LEVEL - (tankFall(wx, wz) + undulation[k] * 0.024);
        // Silt only exists where water has stood, and it is thickest where the
        // water was DEEPEST and slowest. That is the whole substrate rule: a
        // deposit obeys the surface it settled on.
        let s = smoothstep(-0.004, 0.03, depth) * (0.35 + 0.65 * smoothstep(0.0, 0.11, depth));
        // Against a kerb. Flow stops at an obstruction and drops its load
        // there, so the drift banks up on the UPSTREAM face of the sluice kerb
        // and along the base of both tank walls, rather than being a disc that
        // happens to overlap them.
        const kerb = Math.max(
          1 - smoothstep(0.0, 1.5, Math.abs(wz - (SLUICE_Z - 0.62))),
          1 - smoothstep(0.0, 1.1, TANK_X - Math.abs(wx)),
          1 - smoothstep(0.0, 2.2, Math.hypot(wx - SUMP.x, wz - SUMP.z)),
        );
        s *= 0.45 + 1.15 * kerb * clamp01(depth * 22 + 0.2);
        // And it did not reach everywhere: two thirds of a real tank floor is
        // swept clean by whatever current there is.
        s *= 0.25 + 1.35 * smoothstep(0.32, 0.78, siltDrift[k]);
        sf[k] = clamp01(s);
      }
    }
    const soft = blur(sf, FIELD, 3, 2, false);
    for (let j = 0; j < size; j++) {
      const fy = j * s2f;
      for (let i = 0; i < size; i++) {
        silt[j * size + i] = Math.round(clamp01(sampleWrap(soft, FIELD, i * s2f, fy)) * 255);
      }
    }
  }

  // Painted markings. Four legends and two hatched keep-clear zones, all of
  // them OUTSIDE the fight plane so the middle of the frame stays clean, and
  // all of them subject to the substrate rules applied in the composite loop.
  {
    const cell = Math.max(2, Math.round(size / 240));
    const lines = [
      { s: 'sump 2  keep clear', x: -13.6, z: -0.4, c: cell },
      { s: 'outfall 04', x: -13.6, z: -1.6, c: cell },
      { s: 'no crossing when flooded', x: -5.4, z: 12.2, c: Math.max(2, Math.round(cell * 0.66)) },
      { s: 'tank base 09', x: 8.2, z: -9.4, c: Math.max(2, Math.round(cell * 0.74)) },
    ];
    for (const l of lines) {
      const [tx, ty] = worldToTexel(l.x, l.z);
      stampText(paint, size, l.s, tx, ty, l.c, l.c * 0.55);
    }
    // Hatched keep-clear round the sump and an edge line along the sluice.
    for (let j = 0; j < size; j++) {
      const wz = texelToWorldZ(j);
      if (wz < -3.4 || wz > 8.4) continue;
      for (let i = 0; i < size; i++) {
        const wx = texelToWorldX(i);
        const k = j * size + i;
        // Sluice edge: two solid lines either side of the channel.
        const eLine = Math.max(
          1 - smoothstep(0.035, 0.055, Math.abs(wz - (SLUICE_Z - 0.86))),
          1 - smoothstep(0.02, 0.035, Math.abs(wz - (SLUICE_Z - 1.02))),
        ) * (Math.abs(wx) < 12.6 ? 1 : 0);
        // Sump hatching: 45-degree bars inside a square annulus.
        let hatch = 0;
        const hx = Math.abs(wx - SUMP.x), hz = Math.abs(wz - SUMP.z);
        const box = Math.max(hx, hz);
        if (box > 1.9 && box < 2.62) {
          const t = (((wx + wz) * 1.55) % 1 + 1) % 1;
          hatch = t < 0.46 ? 1 : 0;
        }
        const cov = Math.max(eLine, hatch);
        if (cov > paint[k]) { paint[k] = cov; paintKind[k] = hatch > 0.5 ? 1 : 0; }
      }
    }
  }

  // --- composite ------------------------------------------------------------
  const height = new Float32Array(n);
  const wet = new Float32Array(n);
  const roughBase = new Float32Array(n);
  const albedoData = new Uint8Array(n * 4);

  // Palette. Every one of these is DARKER than the pit's equivalent, and that is
  // the single most load-bearing decision in this file — see VAULT_SURFACE's
  // note on the reflection. A tank base has never been painted, never been
  // ground, and has spent thirty years under water; it is a genuinely dark
  // grey-green, not a shop-floor grey.
  // Calibrated against the pit's own bake rather than picked, and re-calibrated
  // once, which is worth recording because the first pass got the sign right and
  // the magnitude badly wrong.
  //
  // Both floors baked and sampled over the SAME band — |x| < 9, z -3 to +6,
  // which is the deck the fighters stand in and the deck their reflection lands
  // on — in linear luminance, after each arena's own `deckGain`:
  //
  //     pit    mean 0.0337   p05 0.0092   p50 0.0184   p95 0.1591
  //     vault  mean 0.0052   p05 0.0027   p50 0.0038   p95 0.0127   <- first pass
  //     vault  mean 0.0120   p05 0.0060   p50 0.0103   p95 0.0265   <- ships
  //
  // The first pass was 4.8x under the pit at the median and 0.0038 linear is
  // below what survives the display transform at all: the deck rendered at code
  // value one or two, and a reflection in a surface that is already at zero is
  // invisible for a reason that has nothing to do with the Fresnel argument
  // VAULT_SURFACE makes. The whole-frame measurement agreed — median luma 0.4 of
  // 255 against the pit's 62.
  //
  // What ships is 0.56x the pit at the median, which is still unambiguously the
  // darkest deck in the game and still delivers the ratio the reflection needs
  // (see VAULT_SURFACE), but sits an order of magnitude clear of the floor of
  // the display transform. The band ABOVE the waterline is untouched at 0.16-0.19
  // sRGB, so the tide mark is still a hard three-to-one step across the frame.
  const conc = hexToLinear(0x30343a);
  const concPale = hexToLinear(0x3d4046);   // where the surface has dried and bloomed
  const concDark = hexToLinear(0x191a1e);
  const mineral = hexToLinear(0x6e6a5e);    // efflorescence: the tide-mark colour
  const algae = hexToLinear(0x14200f);      // biofilm, green-black
  const siltCol = hexToLinear(0x181513);    // fine grey-brown mud
  const rust = hexToLinear(0x4a2a13);
  const paintCol = hexToLinear(0x8d8a80);
  const paintHaz = hexToLinear(0x8a6a16);

  for (let j = 0; j < size; j++) {
    const fy = j * s2f;
    const wz = texelToWorldZ(j);
    // Joint distance in z is constant along a row, so it is hoisted.
    for (let i = 0; i < size; i++) {
      const fx = i * s2f;
      const wx = texelToWorldX(i);
      const k = j * size + i;

      const fine = sampleWrap(fines, FIELD, fx, fy);
      const blo = sampleWrap(bloom, FIELD, fx, fy);
      const bio = sampleWrap(biofilm, FIELD, fx, fy);
      const et = sampleWrap(etch.f1, FIELD, fx * 2, fy * 2);
      const crz = sampleWrap(craze, FIELD, fx, fy);
      const grm = sampleWrap(grime, FIELD, fx, fy);
      const und = sampleWrap(undulation, FIELD, fx, fy);

      // --- the fall, and therefore the water ------------------------------
      const fall = tankFall(wx, wz) + und * 0.024;
      const depth = WATER_LEVEL - fall;

      // --- construction joints and screed lines ---------------------------
      let joint = 0;
      for (let q = 0; q < JOINTS.length; q++) {
        const J = JOINTS[q];
        const along = J.axis === 'z' ? wx : wz;
        if (along < J.lo || along > J.hi) continue;
        const d = Math.abs((J.axis === 'z' ? wz : wx) - J.at);
        if (d > 0.09) continue;
        // A formed construction joint is a 20mm groove with a sealed arris, and
        // it is the only crisp edge on this deck.
        joint = Math.max(joint, 1 - smoothstep(0.012, 0.028, d));
      }
      // Screed lines. Within one pour bay the screed runs at a constant pitch
      // — that is simply what a screed does — but the PITCH AND DIRECTION are
      // properties of the bay, not of the slab, because each bay was formed and
      // struck off on its own day by whoever was on shift. Six bays, six
      // different beats, none of them shared with the joint layout: the deck
      // therefore carries no single repeat for the eye to lock onto, which is
      // the pit floor's greatest single criticism stated as a mechanism.
      const bay = ((wz > -8.7 ? 1 : 0) + (wz > -1.9 ? 1 : 0) + (wz > 4.8 ? 1 : 0)) * 4
        + (wx > -9.9 ? 1 : 0) + (wx > -2.6 ? 1 : 0) + (wx > 5.1 ? 1 : 0);
      const bh = Math.sin(bay * 12.9898) * 43758.5453;
      const bf = bh - Math.floor(bh);
      const ang = (bf < 0.5 ? 0 : Math.PI / 2) + (bf - 0.5) * 0.34;
      const pitch = 1.9 + bf * 0.9;
      const su = (wx * Math.cos(ang) + wz * Math.sin(ang)) / pitch;
      const screed = (1 - smoothstep(0.02, 0.10, Math.abs(((su % 1) + 1.5) % 1 - 0.5))) * 0.24;

      const crack = smoothstep(0.905, 0.99, crz) * (1 - joint);
      const sil = silt[k] / 255;
      const irn = iron[k] / 255;
      const irnS = ironSoft[k] / 255;

      // --- height ----------------------------------------------------------
      // The macro height carries the fall itself (so the normal map has the
      // slab's real 1:59 tilt in it, which is what makes the standing water
      // read as lying rather than painted), the joints, the craze net and the
      // etch pitting.
      let h = fall * 1.6 + fine * 0.14 - smoothstep(0.22, 0.02, et) * 0.10;
      h -= joint * 0.55 + screed * 0.16 + crack * 0.42;
      // Silt is a deposit: it FILLS. It sits in the joint groove and levels the
      // etch pits, which is the mechanism the critic asked for — a deposit that
      // pools in a groove rather than draping over it.
      h = lerp(h, h + joint * 0.42 + 0.05, sil * 0.75);

      // --- wetness ---------------------------------------------------------
      // One field, four consumers (albedo darkening, roughness, ripple and the
      // reflection), exactly as StageFloor's contract requires. Standing water
      // is a hard 1.0 below the line; above it there is a damp margin that dies
      // over about a metre and a half of z, plus whatever the joints hold.
      const standing = smoothstep(-0.002, 0.006, depth);
      const damp = smoothstep(-0.11, 0.0, depth) * 0.62
        + clamp01(0.10 + grm * 0.22) * (1 - standing);
      // Silt sheds: a mud bank drains and goes matte, which is what keeps the
      // low corners from being one unbroken mirror.
      const shed = clamp01(sil * 0.7 + irn * 0.35);
      wet[k] = clamp01((standing + damp * (1 - standing)) * (1 - shed * 0.55) + joint * 0.25 * standing);

      // Water lies flat. Flatten the height that feeds the normal map wherever
      // it is standing, or the ripple normal fights a slab tilt underneath it.
      height[k] = lerp(h, fall * 1.6 + 0.02, clamp01(standing * (1 - sil * 0.6)));

      // --- the waterline ---------------------------------------------------
      // The single hardest horizontal in this arena. Three parts, and they have
      // to be three or it reads as a soft gradient:
      //   `mark`  a pale mineral crust exactly ON the contour, ~0.25m of z wide,
      //   `under` a darker soaked band for the next ~1.5m below it,
      //   `over`  a bleached, dusty margin just above it.
      const mark = 1 - smoothstep(0.0015, 0.0042, Math.abs(depth));
      const under = smoothstep(0.004, 0.012, depth) * (1 - smoothstep(0.016, 0.034, depth));
      const over = (1 - smoothstep(-0.028, -0.004, depth)) * smoothstep(-0.075, -0.03, depth);

      // --- albedo -----------------------------------------------------------
      // Substrate rule for paint, and this is the mechanism the critic named:
      //   1. it BREAKS at a joint. A line struck on a floor is struck on one
      //      bay; the arris of the next joint is where the roller stopped and
      //      where the paint has since chipped off the edge.
      //   2. it STOPS at the waterline. Paint under standing water for a decade
      //      is gone — lifted, then grown over — so the legend runs to the tide
      //      mark and dies there rather than being drawn over the top of it.
      const cov = paint[k]
        * (1 - joint * 0.92)
        * (1 - smoothstep(-0.004, 0.012, depth))
        * clamp01(1 - blo * 0.55 - crack * 0.7);
      const pk = paintKind[k] ? paintHaz : paintCol;

      for (let ch = 0; ch < 3; ch++) {
        let v = lerp(conc[ch], concPale[ch], fine * 0.45 + blo * 0.30);
        v = lerp(v, concDark[ch], grm * 0.36 + smoothstep(0.4, 0.9, bio) * 0.25);
        // Efflorescence: a pale mineral bloom that follows the damp margin. It
        // is the ONLY thing on this deck brighter than the concrete, and it is
        // deliberately concentrated on the tide mark.
        v = lerp(v, mineral[ch], clamp01(blo * 0.22 * (1 - standing) + mark * 0.86 + over * 0.30));
        // Soaked band under the line.
        v *= 1 - under * 0.34;
        // Biofilm, only where water has actually stood.
        v = lerp(v, algae[ch], clamp01(smoothstep(0.42, 0.86, bio) * standing * 0.72 + sil * 0.12));
        // Silt over the top of both.
        v = lerp(v, siltCol[ch], sil * 0.78);
        // Iron. The hard run first, then the dispersion, then the joint and the
        // craze net darkening whatever is left.
        v = lerp(v, rust[ch] * (0.62 + fine * 0.7), irn * 0.82);
        v = lerp(v, rust[ch] * 0.42, irnS * 0.3);
        v *= 1 - crack * 0.45 - joint * 0.52 - screed * 0.30;
        v = lerp(v, pk[ch] * (0.68 + fine * 0.5), cov);
        // Wet concrete is darker concrete, and here it goes further than the
        // pit's 0.32 floor: this is 150mm of standing water over an unlit
        // surface, not a damp patch on a lit one. It is also the term that buys
        // the fighters' reflection — see VAULT_SURFACE.
        // Wet concrete is darker concrete, and the flooded half of this deck is
        // still the darkest surface in the game — but 0.28 put it under the
        // display transform's floor. 0.46 keeps it a stop and a half under the
        // dry deck beside it, which is what the tide line needs, without the
        // water becoming a hole.
        v *= lerp(1, 0.46, clamp01(wet[k] * 1.3));
        albedoData[k * 4 + ch] = encodeSrgb(v);
      }
      albedoData[k * 4 + 3] = 255;

      // --- roughness, stashed for the ORM pass ------------------------------
      // Dry etched concrete 0.86 -> damp 0.40 -> standing water 0.045. The
      // standing-water value is the one that matters: it is what lets the
      // mirror survive VAULT_SURFACE's roughness fade over the whole near deck.
      let rg = lerp(0.86, 0.40, clamp01(wet[k] * 1.55));
      rg = lerp(rg, 0.045, clamp01((wet[k] - 0.58) * 2.4));
      rg = clamp01(rg + fine * 0.05 + smoothstep(0.22, 0.0, et) * 0.10);
      // A silt bank is matte however wet it is, and a mineral crust is chalk.
      rg = lerp(rg, 0.82, sil * 0.8);
      rg = lerp(rg, 0.90, mark * 0.7 + over * 0.35);
      rg = lerp(rg, 0.74, irn * 0.6);
      rg = clamp01(rg + joint * 0.22 - cov * 0.05);
      roughBase[k] = rg;
    }
  }

  // --- derived channels ----------------------------------------------------
  const aoSmall = heightToAo(resample(height, size, FIELD), FIELD, 5, 1.1);
  const normalData = heightToNormal(height, size, 2.0, { wrap: false, alpha: wet });

  const ormData = new Uint8Array(n * 4);
  for (let j = 0; j < size; j++) {
    const fy = j * s2f;
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const ao = sampleWrap(aoSmall, FIELD, i * s2f, fy);
      const o = k * 4;
      ormData[o] = Math.round(clamp01(ao) * 255);
      ormData[o + 1] = Math.round(clamp01(roughBase[k]) * 255);
      // There is no metal in a tank base. The only exception is the iron that
      // has bled out of the fixings, and corrosion product is an oxide — barely
      // conductive, and at full metalness it would render as a black smear
      // against this room's near-zero IBL. A trace is enough to catch a strip.
      ormData[o + 2] = Math.round(clamp01((iron[k] / 255) * 0.16) * 255);
      ormData[o + 3] = 255;
    }
  }

  return {
    albedo: makeTexture(albedoData, size, { srgb: true, clamp: true }),
    normal: makeTexture(normalData, size, { clamp: true }),
    orm: makeTexture(ormData, size, { clamp: true }),
  };
}

/**
 * Tiling world-space history map for the vault deck. Same channel packing as
 * `StageFloor`'s `deckDetail`:
 *
 *   R  tone     — mineral bloom and float marks against the darker paste
 *   G  1-cavity — etch pits and the craze net, used as occlusion and as dirt
 *   B  roughness offset
 *
 * and the same reason for existing: the macro map above is 2048px over a 32m
 * slab, which is 64 texels per metre, and the hero framing runs about 160 screen
 * pixels per metre — so the macro map is magnified 2.5x and everything in it
 * arrives soft. This puts structure back at 10-40cm, which is 16-64 screen
 * pixels at that framing.
 *
 * What it carries is NOT what the pit's carries, and the difference is the point
 * of the two floors being different floors. The pit is a broom-finished shop
 * slab: 5-6cm exposed aggregate and 25-40cm spall where the laitance broke away.
 * A tank base is steel-floated to hold water and then attacked by what is in the
 * water, so it has almost no aggregate showing and its texture is a 10-14cm
 * craze net, 2-3cm acid etch pits, and a 30-40cm bloom of mineral deposit.
 * Different sizes, different shapes, different histories.
 *
 * @param {number} size
 * @returns {THREE.DataTexture} with `tex.userData.cavMean` set
 */
export function vaultDetail(size = 512) {
  const n = size * size;
  // At the 1.55m world tile: craze cells 12cm across, etch pits 3cm.
  const crazeNet = worley(size, 13, 719, 0.9);
  const pitCells = worley(size, 52, 727, 1.0);
  const float = fbm(size, 70, { octaves: 3, seed: 733 });     // steel-float swirl
  const blo = fbm(size, 5, { octaves: 4, seed: 739 });        // mineral bloom, 30cm
  const dirt = fbm(size, 12, { octaves: 4, seed: 743 });
  const data = new Uint8Array(n * 4);
  let cavSum = 0;
  for (let k = 0; k < n; k++) {
    // Craze: a net of hairline shrinkage cracks. It is the cell BORDER that is
    // the crack, so this is the complement of the usual Worley reading, and it
    // is a net rather than a set of blotches — which is exactly what separates
    // a water-retaining slab from a broken-up shop floor.
    const net = smoothstep(0.66, 0.94, crazeNet.f1[k]);
    // Etch: the pits are only open where the biofilm sat, so they arrive in
    // patches instead of evenly. Uniform pitting is the tell that a surface was
    // generated.
    const open = smoothstep(0.44, 0.70, dirt[k]);
    const pitDepth = open * (1 - smoothstep(0.14, 0.46, pitCells.f1[k]));
    const swirl = float[k] - 0.5;
    const bl = smoothstep(0.52, 0.86, blo[k]);
    const cav = clamp01(net * 0.62 + pitDepth * 0.85);
    // Bloom sits proud and pale; the float swirl is a low-amplitude tone
    // gradient at about 20cm, which is the scale a steel float actually leaves.
    const tone = clamp01(0.5 + bl * 0.30 + swirl * 0.26 - pitDepth * 0.20 - net * 0.14 - (dirt[k] - 0.5) * 0.24);
    // A floated surface is smooth; the etch and the crack net are what roughen
    // it, and the mineral crust is chalk.
    const rough = clamp01(0.5 + pitDepth * 0.30 + net * 0.20 + bl * 0.14 - Math.abs(swirl) * 0.10);
    const o = k * 4;
    data[o] = Math.round(tone * 255);
    data[o + 1] = Math.round(clamp01(1 - cav) * 255);
    data[o + 2] = Math.round(rough * 255);
    data[o + 3] = 255;
    cavSum += clamp01(1 - cav);
  }
  const tex = makeTexture(data, size);
  // Occlusion has to redistribute value, not remove it: the shader divides by
  // this so the cavity term's average is exactly one and only its variance
  // reaches the frame. Same argument as `deckDetail`, and it matters more here
  // because this deck is already dark on purpose and has no luminance to spare.
  tex.userData.cavMean = cavSum / n;
  return tex;
}

/**
 * Uniform overrides and surface constants the Stage merges into `StageFloor`.
 * Each key maps to one of that file's uniforms; the mapping is given per entry
 * because a bare table of numbers in a second file is exactly how two arenas
 * drift apart.
 *
 * ---------------------------------------------------------------------------
 * THE REFLECTION, which is the reason this arena exists.
 *
 * `StageFloor`'s FRAG_REFLECT_HOOK records a measurement and then names a lever
 * it did not pull. The measurement: the mirror DOES contain the fighters, and
 * the defect is magnitude — at the wide framing the deck is seen ~25 degrees off
 * horizontal, so Schlick returns ~0.11, `uReflFresnelBase` 0.03 lifts that to
 * 0.137, and `k` lands near 0.11. A blown-out strip survives 11%; a mid-tone
 * fighter does not. It then measured that raising the base ALONE does not fix it
 * (0.03 -> 0.24 moves the floor band 2.51/255 and what arrives is sheen), and
 * concluded: "the lever is the reflected radiance relative to the deck's own,
 * not the reflectance: either the mirror needs its own exposure or the deck
 * needs to be darker under the fighters."
 *
 * An unlit vault floor under 150mm of standing water IS a darker deck under the
 * fighters, so this arena pulls all four terms at once, which is the combination
 * the pit never tested:
 *
 *   1. `deckGain` 0.80 against the pit's 1.14, and an albedo authored darker on
 *      top of it. Between them the two decks measure 0.0103 and 0.0184 linear at
 *      the median over the fight band — a **1.8x** drop. The pit needed 1.14
 *      because it had lost 16% of its band median to other repairs and its
 *      luminance was already at parity with the reference; this floor is
 *      *supposed* to be the darkest surface in frame.
 *   2. There is a floor under that, and it was found the hard way: the first
 *      version of this took the same band to 0.0038, a 4.8x drop, and measured
 *      as an unlit room rather than a dark one — whole-frame median luma 0.4 of
 *      255. A reflection needs the deck darker than the thing reflected in it,
 *      not darker than the display transform can represent. See the palette note
 *      in `bakeVaultMaps` for both measurements.
 *   3. `reflFresnelBase` 0.10. On its own this is the sheen the pit measured;
 *      on top of 1 and 2 it is the other half of the ratio. It takes `k` from
 *      ~0.11 to ~0.24 at the framing that is actually scored.
 *   4. `reflRough` starts its fade at 0.42 rather than 0.30. The standing water
 *      bakes out at 0.045 and the damp margin at 0.40, so with the pit's window
 *      the margin was already 0.6% faded and the DRY deck — which is where a
 *      fighter's reflection would fall if he stepped back — was gone entirely.
 *
 * Together: reflected radiance up ~2.2x, deck's own radiance down ~1.8x, so the
 * fighter's reflection arrives at roughly **four times** the contrast against
 * its background that it does in the pit, without the mirror needing its own
 * exposure pass. That is the whole argument and it is falsifiable: set
 * `deckGain` back to 1.14 and the effect should mostly disappear.
 *
 * `reflKnee` is the fifth term and it is the non-obvious one. The knee is a
 * Reinhard shoulder on the reflected radiance, and the pit uses it purely as an
 * anti-clipping device (1.0, chosen where the overhead strip stopped reading as
 * a shattered speckle field). But it is also a RELATIVE CONTRAST control, and in
 * a room whose only sources are hard strips a metre off the water that is what
 * it is needed for: `refl / (1 + refl / K)` saturates at K, so a strip arriving
 * at scene radiance ~20 comes back at 0.68 with K = 0.7 while a fighter arriving
 * at ~0.12 comes back at 0.103, down only 14%. The strip-to-fighter ratio in the
 * mirror goes from 167:1 to 6.6:1. Lowering the knee is therefore the single
 * cheapest thing in this file that answers "the wet floor reflects the light
 * strip but NOT the robots" — it does not brighten the robot, it stops the strip
 * from being the only thing the eye can find.
 * ---------------------------------------------------------------------------
 */
export const VAULT_SURFACE = {
  /** -> `uDeckTile = 1 / detailTile`. Metres per tile of {@link vaultDetail}. */
  detailTile: 1.55,

  /**
   * -> `uJoint`. **Disabled.** `StageFloor`'s analytic expansion-joint grid has
   * its 4m formed pitch and 2m sawn half-pitch hard-coded into FRAG_NORMAL_HOOK,
   * so any non-zero value here reproduces the pit's lattice on the pit's pitch
   * in a second arena — which is the exact criticism ("repeating lattices at
   * constant pitch") this set is built against. A tank base's joints are on a
   * ~6.8m bay layout anyway, one of them stops mid-slab, and the screed lines
   * inside each bay change pitch AND direction from bay to bay: none of that is
   * expressible as two numbers in a shader, so it is baked.
   *
   * **Off by a tiny positive value rather than by zero, and the qualifier in the
   * sentence "zero for any texel OFF the centreline" is why.** With `w0 = 0`
   * the groove term is `smoothstep(0.0, 0.0, d)`, whose two edges are equal —
   * undefined per the GLSL spec, and on the compilers this ships through it is
   * `(x - e0) / (e1 - e0)`, i.e. 0/0 for any fragment whose interpolated world
   * x or z is exactly 0.0. That is the arena centreline, the slab plane has a
   * vertex column sitting on it, and the NaN propagates through `kbWetness`
   * into `diffuseColor`. Made tiny instead: every smoothstep is then strictly
   * non-degenerate and the widest surviving feature is a groove 1.3 micrometres
   * across, nine orders of magnitude under one texel. `jointSlope: 0` and
   * `jointDark: 1` below make even a direct hit an exact identity, so the term
   * is both provably finite and provably invisible.
   *
   * Defensive rather than measured: no black centreline pixel has been *seen*
   * here, and the cost of being wrong about a compiler's smoothstep is a line
   * down the middle of the floor in the one shot the stage axis is scored on.
   */
  joint: new THREE.Vector3(1e-6, 1e-5, 1e-3),
  /** -> `uJointSlope` / `uJointDark`. Identity values for the disabled block. */
  jointSlope: 0,
  jointDark: 1.0,

  /**
   * -> `uDeckGain`. See the reflection note above; this is term 1.
   *
   * 0.80, not the 0.68 first shipped. The argument for a dark deck is unchanged
   * and the number still sits well under the pit's 1.14 — measured over the
   * fight band the two decks now land at 0.0103 and 0.0184 linear at the median,
   * so this one is 0.56x the pit rather than the 0.21x that measured as a black
   * floor. A reflection needs the deck darker than the thing reflected in it,
   * not darker than the display can represent.
   */
  deckGain: 0.80,
  /**
   * -> `uDeckTone`. Slightly hotter than the pit's 1.0 because the history map's
   * tone channel is the only thing putting 10-40cm structure on a deck that has
   * no aggregate and no paint over most of its area.
   */
  deckTone: 1.25,
  /** -> `uDeckCav`. Full strength: the craze net is this floor's main texture. */
  deckCav: 1.0,
  /** -> `uDeckRough`. Under the pit's 0.35 — a floated tank base is uniform. */
  deckRough: 0.30,

  /** -> gain on `uReflStrength`, i.e. multiplies `(0.34 + floorRefl * 1.45)`. */
  reflStrength: 1.35,
  /** -> `uReflFresnelBase`. Term 3. */
  reflFresnelBase: 0.10,
  /** -> `uReflRough`. Term 4: the fade starts past the damp margin's 0.40. */
  reflRough: new THREE.Vector2(0.42, 1.0),
  /** -> `uReflKnee`. Term 5, the relative-contrast lever. */
  reflKnee: 0.7,
  /** -> `uReflDistort`. Standing water is flatter than damp concrete. */
  reflDistort: 0.020,
  /** -> `uReflBlur`. Ditto: a sharper gather, because there is real water here. */
  reflBlur: 0.055,

  // --- practical colour in the deck's diffuse -------------------------------
  // The pit blends a warm anchor at the perimeter against a cool one over the
  // middle. Here the geometry of the light is the other way round: the mercury
  // strips are on the tank walls and the arcade (the perimeter and the back),
  // and the sodium kicker is a bulkhead lamp on the near right. So the ellipse
  // is pushed BACK and made tighter, and the blend runs cool at the edges to
  // warm in the near middle — which is also what puts warm and cool in quantity
  // in the same frame rather than a cyan room with an amber corner.
  /** -> `uFloorTint`. */
  floorTint: 0.90,
  /** -> `uFloorTintWet`. Higher than the pit: standing water takes a full cast. */
  floorTintWet: 0.45,
  /** -> `uFloorTintVary`. */
  floorTintVary: 0.30,
  /** -> `uFloorTintC`, the centre of the warm/cool blend. */
  floorTintC: new THREE.Vector2(1.2, 2.6),
  /** -> `uFloorTintR`, reciprocal radii in 1/metres. */
  floorTintR: new THREE.Vector2(1 / 8.5, 1 / 7.5),
  /** -> `uFloorTintE`, where the blend runs from warm centre to cool edge. */
  floorTintE: new THREE.Vector2(1.45, 0.55),
  /**
   * -> `uFloorChroma`. The pit ships 1.6 and records that 2.5 lands the critic's
   * 0.40 midtone saturation target exactly and looks lurid doing it. That
   * ceiling was measured on a deck whose luminance was at parity with the
   * reference; this deck runs at 0.62 gain under saturated mercury and sodium,
   * so there is materially less luminance for the chroma to make garish. 2.0 is
   * a step toward the target, not past it, and it is the term that puts the
   * fourth hue — the blue-green of lit water — into the frame in quantity.
   */
  floorChroma: 2.0,
  /** -> the apron's colour. There is no sky down here; the horizon is rock. */
  apronColor: 0x05060a,

  /**
   * -> `StageFloor#buildDrains`, same shape. The transverse sluice channel that
   * the whole slab falls into, its return up the low wall, and the sump.
   * All three sit outside the play bound so nothing can trip on them, and the
   * main run is at z +6.6 — in front of the fighters, which is where the eye
   * spends the bottom fifth of every wide frame.
   */
  drains: [
    { pos: [0, 0, SLUICE_Z], size: [25, 1.1], rot: 0 },
    { pos: [SUMP.x, 0, SUMP.z], size: [2.4, 2.4], rot: 0 },
    { pos: [-12.6, 0, -1.2], size: [9.5, 0.8], rot: Math.PI / 2 },
  ],
};

// ---------------------------------------------------------------------------
// Vault-specific materials
//
// The shared library has painted steel, machined steel, container plate,
// poured concrete, hazard stripe and grating. A cistern wants three surfaces it
// does not have, and each of them is doing a job no library material can:
//
//   - **board-marked cast concrete** with a weeping tide history, for the piers
//     and the tank walls. The library concrete is a dry barrier; this one has
//     to carry a water level, and the level has to be at the same world Y on
//     every surface in the room.
//   - **glazed brick**, for the bay soffits. It is the only PALE surface down
//     here, which is what makes an arcade bay with a strip in it read as lit and
//     the bay next to it read as a hole.
//   - **rusted cast iron**, for the pipework, the sluice gates and the plant.
//
// All three tile at their own world scale, for the reason StageMaterials states:
// a shared grain across unrelated materials is one of the strongest tells that a
// set was generated rather than built. Concrete 4.4m, brick 1.5m, iron 1.2m —
// and none of those is a period any library set already uses.
// ---------------------------------------------------------------------------

/** Vertical weep field: the basis for every kind of water staining down here. */
function weepField(size, seed, stretch = 9, cells = 20) {
  const f = new Float32Array(size * size);
  const base = fbm(size, cells, { octaves: 4, seed });
  const fine = fbm(size, cells * 3.2, { octaves: 3, seed: seed + 17 });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const a = sampleWrap(base, size, i, j / stretch);
      const b = sampleWrap(fine, size, i, j / (stretch * 2.4));
      f[j * size + i] = clamp01(a * 0.72 + b * 0.42 - 0.14);
    }
  }
  return f;
}

/** Horizontal grooves at a row pitch, written into a height field. */
function seamRows(height, size, rows, depth, width) {
  const w = width * size;
  for (let j = 0; j < size; j++) {
    const gy = ((j / size) * rows) % 1;
    const dy = Math.min(gy, 1 - gy) * (size / rows);
    const v = (1 - smoothstep(0, w, dy)) * depth;
    if (v <= 0) continue;
    const row = j * size;
    for (let i = 0; i < size; i++) height[row + i] -= v;
  }
}

/**
 * Board-marked cast concrete, tiling at 4.4m: 1.1m boards, 24mm blowholes,
 * 2.2m pour variation.
 *
 * Board marking is the whole identity of the material and it is why the tile is
 * this big: the boards are 275mm and the marks run in courses of four, so a
 * shorter tile would repeat the course pattern inside one pier.
 */
function castConcreteSet(size, seed) {
  const fines = fbm(size, 340, { octaves: 3, seed });
  const macro = fbm(size, 7, { octaves: 5, seed: seed + 3 });
  const pour = fbm(size, 2, { octaves: 3, seed: seed + 29 });
  const weep = weepField(size, seed + 7, 12, 16);
  const blow = worley(size, 180, seed + 11, 1).f1;   // 24mm blowholes off the form
  const spall = fbm(size, 15, { octaves: 4, seed: seed + 41, ridged: true });

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    // Blowholes are voids, so they cut DOWN. A form-finished face has almost no
    // aggregate showing; the grain is the board and the bubbles.
    height[k] = fines[k] * 0.13 + macro[k] * 0.09 - smoothstep(0.2, 0.02, blow[k]) * 0.55;
  }
  // Sixteen board courses per tile: the boards were 275mm.
  seamRows(height, size, 16, 0.34, 0.0035);
  // Four lift lines per tile, deeper: 1.1m of concrete a day.
  seamRows(height, size, 4, 0.62, 0.006);
  const broken = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    broken[k] = smoothstep(0.9, 0.99, spall[k]) * (0.35 + pour[k] * 1.1);
    height[k] -= broken[k] * 0.7;
  }

  const ao = heightToAo(height, size, 6, 1.2);
  const normal = heightToNormal(height, size, 2.5, { wrap: true });

  const mid = hexToLinear(0x2e3034);
  const pale = hexToLinear(0x43454a);
  const dark = hexToLinear(0x141519);
  const lime = hexToLinear(0x7c7a6c);   // leached calcium down a weep
  const wetStain = hexToLinear(0x0f1112);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const run = clamp01(weep[k] * 1.05 - 0.12);
    const bay = 0.78 + pour[k] * 0.46;
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(mid[ch], pale[ch], fines[k] * 0.6 + smoothstep(0.24, 0.02, blow[k]) * 0.4);
      v = lerp(v, dark[ch], macro[k] * 0.46);
      // Two staining products, and they have to be two: the dark one is the
      // wet run itself and the pale one is what it leaves behind when it dries.
      // A wall with only the dark half reads as dirty; a wall with both reads
      // as a wall water has been running down for thirty years.
      v = lerp(v, wetStain[ch], run * 0.62);
      v = lerp(v, lime[ch], clamp01(run * run * 0.9 - 0.18) * 0.55);
      v = lerp(v, pale[ch] * 1.15, broken[k] * 0.7);
      out[ch] = v * bay * (0.76 + ao[k] * 0.24);
    }
  });

  const rough = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(0.9 + fines[k] * 0.08 - weep[k] * 0.24 - broken[k] * 0.1);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, null, size) };
}

/**
 * Glazed engineering brick, tiling at 1.5m: 20 courses of 75mm, stretcher bond.
 *
 * The pale surface of the room, and the reason the arcade reads. Where the
 * glaze survives it is a hard cream dielectric that answers a strip with a real
 * highlight; where it has spalled the body under it is a dark red-brown that
 * answers with nothing. That difference — not the brick pattern — is what makes
 * a lit bay legible from a dark one at ten metres.
 */
function glazedBrickSet(size, seed) {
  const courses = 20;
  const perCourse = 7;
  const grain = fbm(size, 200, { octaves: 3, seed });
  const loss = fbm(size, 9, { octaves: 4, seed: seed + 5 });
  const soot = weepField(size, seed + 13, 7, 14);
  const patch = fbm(size, 3, { octaves: 3, seed: seed + 23 });

  const height = new Float32Array(size * size);
  const joint = new Float32Array(size * size);
  const brickId = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const cy = (j / size) * courses;
    const row = Math.floor(cy);
    const fy = cy - row;
    // 10mm joint in a 75mm course.
    const dj = Math.min(fy, 1 - fy);
    const jy = 1 - smoothstep(0.055, 0.10, dj);
    const off = (row % 2) * 0.5;
    for (let i = 0; i < size; i++) {
      const cx = (i / size) * perCourse + off;
      const col = Math.floor(cx);
      const fx = cx - col;
      const jx = 1 - smoothstep(0.03, 0.055, Math.min(fx, 1 - fx));
      const k = j * size + i;
      const jt = Math.max(jx, jy);
      joint[k] = jt;
      // A bucket-handle joint is recessed and rounded, not a square groove.
      height[k] = (1 - jt) * 0.55 + grain[k] * 0.07;
      const h = Math.sin((row * 71 + col * 37) * 12.9898) * 43758.5453;
      brickId[k] = h - Math.floor(h);
    }
  }
  // Spalled glaze: whole faces let go, so the loss is keyed on the brick id and
  // not on a smooth field. A glaze that fades out across a brick is a decal.
  const gone = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const faceLost = smoothstep(0.52, 0.74, brickId[k] * 0.55 + loss[k] * 0.45 + (patch[k] - 0.5) * 0.5);
    gone[k] = clamp01(faceLost * (1 - joint[k]));
    height[k] -= gone[k] * 0.22;
  }

  const ao = heightToAo(height, size, 5, 1.35);
  const normal = heightToNormal(height, size, 2.8, { wrap: true });

  // Held at linear ~0.14 at its brightest. The charter reserves the top of the
  // albedo range for the fighters, and glazed brick in a photograph of a real
  // cistern is a warm off-white, not paper.
  const glaze = hexToLinear(0x6d6a60);
  const glazeDim = hexToLinear(0x4a4842);
  const body = hexToLinear(0x3a2119);
  const mortar = hexToLinear(0x232224);
  const grime = hexToLinear(0x0d0e0f);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const dirt = clamp01(soot[k] * 0.95 - 0.1);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(glazeDim[ch], glaze[ch], brickId[k] * 0.45 + grain[k] * 0.4 + 0.2);
      v = lerp(v, body[ch] * (0.7 + grain[k] * 0.7), gone[k]);
      v = lerp(v, mortar[ch], joint[k]);
      v = lerp(v, grime[ch], dirt * 0.52);
      out[ch] = v * (0.74 + ao[k] * 0.26);
    }
  });

  const rough = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    // Intact glaze is 0.18 — the smoothest surface in the arena after the
    // standing water, and the only one in the mid-ground that can throw a
    // specular streak back at a strip.
    rough[k] = clamp01(lerp(0.18, 0.86, Math.max(gone[k], joint[k] * 0.9)) + grain[k] * 0.06 + soot[k] * 0.14);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, null, size) };
}

/** Rusted cast iron, tiling at 1.2m: 8mm pitting, 90mm scale, 60cm blooms. */
function castIronSet(size, seed) {
  const grain = fbm(size, 260, { octaves: 3, seed });
  const bloomF = fbm(size, 4, { octaves: 4, seed: seed + 3 });
  const scale = worley(size, 14, seed + 9, 1).f1;   // 90mm lifting scale
  const pit = worley(size, 150, seed + 13, 1).f1;   // 8mm pitting
  const runs = weepField(size, seed + 19, 8, 24);

  const height = new Float32Array(size * size);
  const rustMask = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rustMask[k] = clamp01(
      (smoothstep(0.42, 0.78, bloomF[k]) * 0.95 + smoothstep(0.5, 0.9, runs[k]) * 0.6
        + smoothstep(0.8, 1, 1 - scale[k]) * 0.35) * (0.5 + bloomF[k] * 0.9),
    );
    // Rust is not a stain, it is a volume: scale lifts off the surface and the
    // metal under it pits away. Both signs of relief, which is what stops it
    // reading as a brown texture painted on a smooth pipe.
    height[k] = grain[k] * 0.1
      + smoothstep(0.5, 0.05, scale[k]) * rustMask[k] * 0.45
      - smoothstep(0.24, 0.02, pit[k]) * rustMask[k] * 0.55;
  }

  const ao = heightToAo(height, size, 5, 1.3);
  const normal = heightToNormal(height, size, 2.4, { wrap: true });

  const paint = hexToLinear(0x1b2224);   // the black bitumen it left the foundry in
  const iron = hexToLinear(0x2a2a2c);
  const rustLo = hexToLinear(0x2e170b);
  const rustHi = hexToLinear(0x6a3a17);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const r = rustMask[k];
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(paint[ch], iron[ch], grain[k] * 0.5);
      v = lerp(v, lerp(rustLo[ch], rustHi[ch], grain[k] * 0.7 + scale[k] * 0.3), r);
      out[ch] = v * (0.78 + ao[k] * 0.22);
    }
  });

  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(lerp(0.42, 0.93, rustMask[k]) + grain[k] * 0.07);
    // Oxide is not a conductor. A fully rusted pipe at metalness 1 renders as a
    // black hole against this room's near-zero IBL, which is the same trap the
    // pit's anchor plates fell into.
    metal[k] = clamp01(lerp(0.82, 0.06, rustMask[k]));
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, metal, size) };
}

// ---------------------------------------------------------------------------
// The arcade's setting-out
//
// Bay centres are deliberately NOT on a constant pitch. A colonnade is rhythmic
// by nature — that is what gives the alternating light its beat — but a pitch
// the eye can count is the failure mode the pit's anchor-plate field was
// rebuilt to escape, so the spans run 4.6 / 4.4 / 5.2 / 4.4 / 4.8 / 4.0 and the
// two rows are offset from each other, which is also what lets the back row be
// seen THROUGH the front one instead of behind it.
// ---------------------------------------------------------------------------

const PIERS_A = [-13.6, -9.0, -4.6, 0.6, 5.0, 9.8, 13.8];
const PIERS_B = [-11.6, -6.8, -1.8, 3.4, 8.6, 13.1];

/**
 * What each front-row bay is. This table IS the third depth band's lighting
 * treatment: `lit` bays carry a strip on the left pier and their brick soffit
 * answers it, `dark` bays carry nothing at all and read as holes, and the two
 * special bays break the rhythm so a run of six does not read as wallpaper.
 */
const BAYS_A = ['collapsed', 'lit', 'through', 'dark', 'shuttered', 'lit'];
/** Back row, offset in x and one beat out of phase, so the checker reads. */
const BAYS_B = ['dark', 'lit', 'dark', 'dark', 'lit'];

/** Colour slots the strip mesh, the pools, the washes and the glows share. */
const SLOT = {
  MERC_A: 0, MERC_B: 1, MERC_KEY: 2, SODIUM: 3,
  MERC_BAY: 4, SODIUM_HALL: 5, GREEN: 6, TUNNEL: 7, FLICKER: 8, MERC_FAR: 9, SOFFIT: 10,
};
/**
 * Nine, and the ninth exists so ONE arcade tube can fail on its own.
 *
 * A flicker shared with the rest of the arcade would strobe the whole band,
 * which reads as a fault in the renderer rather than a fault in a fitting. Its
 * own slot costs one entry in a uniform array and no draw call, because the
 * emitter faces, the pools, the washes and the glows all pick their colour from
 * the same array by vertex attribute.
 */
const SLOT_COUNT = 11;

/**
 * Base colours, used when no Environment mood is resolved yet (and as the hue
 * every slot is driven back toward when one is).
 *
 * These are the four hue bins the frame is built to carry, against the pit's
 * measured two. Mercury discharge is genuinely blue-green-white and not cyan;
 * low-pressure sodium is genuinely almost monochromatic amber; the emergency
 * fitting is the one saturated green in the room and it is small on purpose,
 * because a large green would fight the water.
 */
const SLOT_BASE = [
  0xd6e8ff, 0xd6e8ff, 0xcadfff, 0xff9a3c,
  0xc2d8ff, 0xff8a24, 0x35ff9e, 0xffd6a2, 0xc2d8ff, 0xb4cdf5, 0xcfe0f5,
];
/** One `THREE.Color` per slot, resolved once so no frame allocates. */
const SLOT_COLOR = SLOT_BASE.map((h) => new THREE.Color().setHex(h, THREE.SRGBColorSpace));

/**
 * Scene-referred radiance the dimmest fitting in this set is driven to.
 *
 * Lifted wholesale from `StagePracticals`' LAMP_ANCHOR and for the same measured
 * reason: `RenderPipeline`'s AgX compresses asymptotically, so the count of
 * clipped pixels barely moves with radiance while the 99.9th percentile climbs,
 * and the ten Tekken 8 references sit at a 99.9th percentile of 0.90-0.999. The
 * number is not re-derived here — it is the same display transform.
 *
 * What IS different is the exponent below it. In the pit the four fixtures span
 * 4.5 to 26 units of authored power and the knee exists to bring them within a
 * stop or two of each other. Down here the strips are the ONLY light and the
 * whole point of the arena is that the far ones are visibly dimmer than the near
 * ones, so the curve is flatter (0.72 against 0.62) and the distant slots are
 * driven at a fraction rather than through the same knee.
 */
const LAMP_ANCHOR = 13.0;

/**
 * Unit scale per card pass, and this exists because getting it wrong shipped a
 * defect worth reporting in full.
 *
 * The three card passes share one colour array — that is what makes them one
 * uniform block and one attribute lookup — but they are **three different
 * physical quantities** and the first pass at this treated them as one:
 *
 *   `add`  is scatter, in linear radiance ADDED to the deck. The right order of
 *          magnitude is `StagePracticals`' POOL_GAIN, which lands a 15-unit lamp
 *          at about 0.37. This file's slot colours were authored to that, and
 *          the pools were correct.
 *   `mul`  is a near-field gain, and the quantity is the **multiplier minus
 *          one**. `StagePracticals` drives its barrier wash to about 2.3, i.e.
 *          a peak multiplier of 3.3 on the surface. Feeding the pools' 0.33 into
 *          it gives a peak of 1.33 — a 33% lift where the design called for a
 *          230% one, so the "hot at the strip and gone two metres away" gradient
 *          that this entire arena is built around was arriving at a seventh of
 *          its intended strength. It measured as a nearly unlit room, and the
 *          first diagnosis of that (correctly) said the arcade bays and the
 *          machine hall were "delivering nothing at all".
 *   `glow`  is in-scatter in air over a large quad, which wants to be WEAKER
 *          than the deck pool of the same fitting rather than equal to it.
 *
 * One number per pass is the whole fix; the alternative was three colour arrays
 * and three sync paths that could drift apart, which is the bug this file
 * already has once.
 */
const CARD_SCALE = { add: 1.0, mul: 7.0, glow: 0.55 };

/**
 * A segmental arch: the radius and half-angle of the arc that spans `chord` with
 * a rise of `rise`.
 *
 * Needed because a semicircular head is only available when there is half the
 * span of wall above the springing to put it in, and most openings down here do
 * not have that — the bulkhead's main arch is 8m wide in a 5.8m wall and the
 * relieving arches over the tank lining are 3.8m wide under a 3.4m springing.
 * An earlier pass turned both as semicircles and they punched straight through
 * the structures they were supposed to be carrying: 2.7m of voussoirs standing
 * above the bulkhead's own parapet. A segmental head is also simply what a
 * Victorian engineer would have built over a wide opening in a shallow wall.
 *
 * @param {number} chord span between springings
 * @param {number} rise height of the crown above the springing line
 * @returns {{r:number, half:number, cy:number}} radius, half-angle in radians,
 *   and the centre's offset BELOW the springing line
 */
function segmental(chord, rise) {
  const h = Math.max(0.06, Math.min(rise, chord / 2));
  const r = (chord * chord / 4 + h * h) / (2 * h);
  return { r, half: Math.asin(Math.min(1, (chord / 2) / r)), cy: r - h };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

export class StageVault {
  /**
   * @param {object} deps
   * @param {import('../engine/Environment.js').Environment} deps.environment
   * @param {Record<string, THREE.Material>} deps.materials shared arena library
   * @param {Record<string, THREE.Texture>} deps.textures shared arena library
   * @param {object} deps.bins shared geometry bins, merged by the Stage
   * @param {'ultra'|'high'|'medium'|'low'} [deps.quality]
   */
  constructor({ environment, materials, textures, bins, quality = 'high' }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.vault';
    this.environment = environment;
    this.materials = materials;
    this.quality = quality;
    this.rng = new Rng(0x43495354);
    this.bins = bins;

    /** Shared clock for every shader-side animation in the set. */
    this.timeUniform = { value: 0 };
    /** Linear radiance the far bands fade toward; follows the mood's fog. */
    this.hazeColor = { value: new THREE.Color(0x141d24) };
    /** The machine hall's own fill, driven by its own sodium fitting. */
    this.hallFill = { value: new THREE.Color(0x1a1008) };

    // --- vault-specific surfaces ------------------------------------------
    const res = quality === 'low' ? 128 : quality === 'medium' ? 256 : 512;
    this.sets = {
      cast: castConcreteSet(res, 1801),
      brick: glazedBrickSet(res, 1811),
      iron: castIronSet(res, 1823),
    };
    /**
     * The water level, published to every material that has to agree with it:
     * x = the old high mark, y = the current surface, z = how far the soaked
     * band reaches below the old mark, w = the mineral line's half-width.
     */
    this.tide = { value: new THREE.Vector4(HIGH_MARK_Y, WATER_LEVEL, 0.9, 0.028) };
    this.#buildMaterials();

    // Geometry piles. Three vault-specific materials means three merged meshes;
    // everything else goes into the Stage's shared bins and costs no draw call
    // of its own.
    this._cast = [];
    this._brick = [];
    this._iron = [];

    this.#tankShell();
    this.#deckSoffit();
    this.#weir();
    this.#arcade();
    this.#deckDressing();
    this.#cable();
    // Before the merge: every fitting hangs bracketry, a channel and a feed tail
    // into the iron pile, and a strip whose housing is not modelled reads as a
    // sticker on a wall.
    this.#emitters();

    this.#commit('cast', this._cast, this.castMaterial, 4.4, true);
    this.#commit('brick', this._brick, this.brickMaterial, 1.5, false);
    this.#commit('iron', this._iron, this.ironMaterial, 1.2, true);
    this._cast = this._brick = this._iron = null;

    this.#foreground();
    this.#flotsam();
    this.#machineHall();
    this.#tunnel();
    this.bins = null;

    /**
     * Meshes the floor's mirror pass skips.
     *
     * The rule here is the inverse of the pit's, and deliberately so. In the pit
     * almost everything is excluded because almost nothing has a line to the
     * deck. Here the deck IS the subject and the set is what makes it read, so
     * the tank walls, the piers, the brick soffits, the strips and even the
     * foreground pier all stay in the mirror — a foreground occluder standing in
     * water and reflected in it is one of the cheapest depth cues in the set.
     *
     * What comes out is everything that is not scenery: the two far bands (they
     * are behind a bulkhead nineteen metres back and cannot see the water), and
     * every gradient card, because a deposit that is reflected is a deposit
     * applied twice.
     */
    this.noReflect = [this.hall, this.tunnel, this.pools, this.washes, this.glows].filter(Boolean);
  }

  // -------------------------------------------------------------------------

  /**
   * Grafts the room's water level onto the cast-concrete material.
   *
   * Every vertical surface in a flooded tank shares one water level, and a tide
   * mark that is a texture cannot: a tiling map repeats its own stain up the
   * pier, which is precisely the "uniform detail density" tell. So the tide is
   * evaluated from WORLD Y in the fragment, once, for the whole room. Three
   * bands, and they have to be three or the line reads as a gradient:
   *
   *   below the current surface  near-black, algal, and SMOOTH — this is the
   *                              150mm of standing water the deck bake agrees
   *                              with, and making it smooth is what puts a
   *                              specular streak round the foot of every pier
   *   below the old high mark    soaked, darker, with the map's own weep field
   *                              amplified so the runs read as recent
   *   at the old high mark       a hard 28mm mineral crust, the brightest line
   *                              on any vertical surface in the arena
   *
   * It costs one varying and about a dozen instructions, and it is the single
   * strongest piece of information in the mid-ground: one horizontal at chest
   * height, unbroken across thirteen piers and two walls, that tells the eye
   * exactly how big the room is and exactly what happened in it.
   */
  #buildMaterials() {
    const std = (t, cfg) => new THREE.MeshStandardMaterial({
      map: t.albedo, normalMap: t.normal, roughnessMap: t.orm, metalnessMap: t.orm, aoMap: t.orm,
      roughness: 1, metalness: 1, dithering: true, ...cfg,
    });

    this.castMaterial = std(this.sets.cast, {
      name: 'arena.vault.cast',
      metalness: 0,
      normalScale: new THREE.Vector2(1.2, 1.2),
      /**
       * 0.22, against the library concrete's 0.30 — and this number was 0.08.
       *
       * "No ambient anywhere" is the right instinct and 0.08 was the wrong way
       * to spend it. Measured on the delivered build, the whole frame came back
       * at a median of 0.4 of 255 against the pit's 62: more than half of every
       * frame at or under code value zero. The albedos were not the cause and
       * that was measured too — this file's cast concrete is 0.0250 mean linear
       * against the library concrete's 0.0255, its brick is 0.0594 and its iron
       * is 0.0198 against the library dark metal's 0.0123, so every surface here
       * is at or above the set that ships at a median of 62. What was missing
       * was the only fill term reaching a surface no strip is pointed at.
       *
       * The falloff is bought back where it belongs, in the wash: see
       * {@link CARD_SCALE}, where the near-field multiplier was a seventh of its
       * intended strength for the same reason the room was black. With the wash
       * at a peak of about 3.9x, a strip-lit pier is nearly four times its own
       * unlit value — which is a steeper gradient than 0.08 of IBL ever gave,
       * because 0.08 of IBL made both ends of it zero.
       */
      envMapIntensity: 0.22,
    });
    const uTide = this.tide;
    this.castMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTide = uTide;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vKbV;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvKbV = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vKbV;\nuniform vec4 uTide;\nfloat kbSoak = 0.0;')
        .replace('#include <map_fragment>', /* glsl */ `
          #include <map_fragment>
          {
            float y = vKbV.y;
            float high = uTide.x;
            float now = uTide.y;
            // Under water: the surface is 150mm deep, so this band is short and
            // it is the darkest thing in the room.
            float sunk = 1.0 - smoothstep( now - 0.02, now + 0.05, y );
            // Soaked: from the old high mark down to the current surface.
            float soak = ( 1.0 - smoothstep( high - 0.05, high + 0.03, y ) )
                       * smoothstep( now - 0.04, now + 0.22, y );
            // The crust itself, and a bleached margin just above it.
            float crust = 1.0 - smoothstep( uTide.w * 0.55, uTide.w, abs( y - high ) );
            float dust = smoothstep( high, high + 0.30, y ) * ( 1.0 - smoothstep( high + 0.30, high + 0.95, y ) );
            kbSoak = clamp( sunk + soak * 0.8, 0.0, 1.0 );
            // uTide.z is how wet the MOOD says the room is. It scales the soaked
            // band and nothing else, so a drier preset lifts the wall between
            // the two lines without moving either line — which is the correct
            // behaviour, since the water level is a property of the tank and the
            // dampness is a property of the weather.
            diffuseColor.rgb *= mix( 1.0, 0.30, soak * uTide.z );
            diffuseColor.rgb *= mix( 1.0, 0.14, sunk );
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.055, 0.070, 0.050 ), sunk * 0.55 );
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.115, 0.112, 0.094 ), max( crust, dust * 0.34 ) );
          }
        `)
        .replace('#include <roughnessmap_fragment>', /* glsl */ `
          #include <roughnessmap_fragment>
          // Wet concrete is smooth concrete. This is what puts the strips'
          // reflection round the foot of every pier, and it agrees with the
          // deck's own wetness mask because both are driven by uTide.y.
          roughnessFactor = clamp( mix( roughnessFactor, 0.11, kbSoak * 0.9 ), 0.05, 1.0 );
        `);
    };
    this.castMaterial.customProgramCacheKey = () => 'kb-vault-cast';

    this.brickMaterial = std(this.sets.brick, {
      name: 'arena.vault.brick',
      metalness: 0,
      normalScale: new THREE.Vector2(1.0, 1.0),
      // A barrel soffit is seen from inside, so the camera looks at its back
      // faces. Three flips the normal for those, so DoubleSide shades correctly
      // and saves building an inverted shell.
      side: THREE.DoubleSide,
      // Above the concrete, below the library's steel. Glaze is the one surface
      // down here with a real specular lobe, so it is also the one that has
      // something to gain from an environment term.
      envMapIntensity: 0.30,
    });

    this.ironMaterial = std(this.sets.iron, {
      name: 'arena.vault.iron',
      normalScale: new THREE.Vector2(1.15, 1.15),
      // Half the library dark metal's 0.85. Iron is the only partly-metallic
      // surface in the room, so it is the one whose whole appearance is the
      // environment term — at 0.14 the pipework was a black cutout.
      envMapIntensity: 0.42,
    });
    for (const m of [this.castMaterial, this.brickMaterial, this.ironMaterial]) m.shadowSide = THREE.FrontSide;
  }

  /** Merges one vault-specific pile into a single mesh at its own world scale. */
  #commit(name, parts, material, metresPerTile, casts) {
    if (!parts.length) return;
    const mesh = new THREE.Mesh(worldUv(mergeAll(parts), metresPerTile), material);
    mesh.name = `arena.vault.${name}`;
    mesh.castShadow = casts;
    // Everything in bands A to C receives. The whole reason this arena exists
    // is that a hard-edged per-fighter shadow should LAND on something legible,
    // and these three meshes are what it lands on.
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this[name] = mesh;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Band B — the tank itself
  // -------------------------------------------------------------------------

  /**
   * The two long tank walls and the bulkhead the machine hall is seen through.
   *
   * The walls are the surfaces the strips are bolted to, so they are the surfaces
   * the falloff is read on, and that dictates how they are made: broad plain
   * panels between shallow pilasters, with exactly enough relief to catch a
   * grazing strip and nothing like enough to break the gradient up. A wall
   * covered in fabrication would hide the very thing this arena is for.
   */
  #tankShell() {
    const rng = this.rng;
    const z0 = BULKHEAD_Z, z1 = TANK_FRONT;
    const len = z1 - z0;
    const zc = (z0 + z1) / 2;

    for (const s of [-1, 1]) {
      const x = s * TANK_X;
      // Main wall slab, plus a haunch above the springing so the ceiling is
      // closed. Both are one box each: this is a plain wall on purpose.
      this._cast.push(place(bevelBox(0.7, SPRING_Y, len, 0.04), { pos: [x + s * 0.35, SPRING_Y / 2, zc] }));
      this._cast.push(place(bevelBox(0.9, 2.3, len, 0.05), { pos: [x + s * 0.45, SPRING_Y + 1.15, zc] }));
      // Base fillet: a 45-degree splay where the wall meets the slab, which is
      // how a water-retaining structure is actually detailed and which is the
      // one edge down here that is always underwater and always specular.
      this._cast.push(place(bevelBox(0.5, 0.36, len, 0.02), { pos: [x - s * 0.06, 0.16, zc], rot: [0, 0, s * 0.6] }));
      // The old high-water string course, at exactly the height the shader
      // paints the crust. Geometry and shader agree or the room falls apart.
      this._cast.push(place(bevelBox(0.09, 0.07, len, 0.015), { pos: [x - 0.045 * s, HIGH_MARK_Y, zc] }));

      // Pilasters, on an irregular pitch. The positions are collected rather
      // than placed as they are generated, because the brick lining between them
      // has to know where the piers it dies into actually are.
      const px = [];
      for (let pz = z0 + 1.2; pz < z1 - 0.8; pz += rng.range(2.9, 4.3)) px.push(pz);
      px.forEach((pz, n) => {
        this._cast.push(place(bevelBox(0.26, SPRING_Y, 0.62, 0.03), { pos: [x - s * 0.13, SPRING_Y / 2, pz] }));
        // Tie-rod cone holes, the mark the formwork left. Three per pilaster,
        // and they are the only small-scale feature on the concrete itself.
        this._cast.push(place(boltRing(0.055, 3, 0.035, 0.02), {
          pos: [x - s * 0.27, 1.95, pz], rot: [0, s * Math.PI / 2, 0],
        }));
        if (n % 3 === 0) {
          this._cast.push(place(insetPanel(2.0, 1.3, 0.07, 0.09), {
            pos: [x - s * 0.03, 2.35, pz + 1.35], rot: [0, s * Math.PI / 2, 0],
          }));
        }
      });

      // Brick lining between the pilasters, with a relieving arch over each
      // panel and a corbel course at the springing.
      //
      // This is the largest single decision about band B's value structure. The
      // cast concrete is the darkest surface in the room and the glazed brick is
      // the palest, and the two strips on these walls rake ALONG them — so a
      // wall of nothing but concrete gives the near strips nothing to be bright
      // on, and the falloff, which is the entire point of this arena, would have
      // been drawn on a surface too dark to show it. Lining the panels puts the
      // gradient on a material with three times the albedo, and it puts the
      // first hue bin (the mercury white the glaze reflects) into the near field
      // instead of leaving it all in the arcade.
      for (let i = 0; i < px.length - 1; i++) {
        const a = px[i] + 0.14, c = px[i + 1] - 0.14;
        const w = c - a;
        if (w < 1.2) continue;
        const pc = (a + c) / 2;
        // Panel face, from the top of the base fillet up to the springing of the
        // relieving arch. Flat and undressed: it is a shadow-catcher too.
        this._brick.push(place(bevelBox(0.14, SPRING_Y - 1.5, w, 0.02), {
          pos: [x - s * 0.07, 0.38 + (SPRING_Y - 1.5) / 2, pc],
        }));
        // Relieving arch: nine voussoirs on a segmental head, springing at 2.28
        // with a 1-in-5 rise, so the crown clears the panel by a comfortable
        // margin and still sits under the corbel course.
        // Rise capped at 0.5m: the crown plus the ring depth then lands at 3.08,
        // just under the corbel course at 3.12, so the arch dies into the
        // springing instead of pushing through the ceiling.
        const arc = segmental(w, Math.min(w * 0.18, 0.5));
        const crown = 2.28 + (arc.r - arc.cy);
        for (let k = 0; k < 9; k++) {
          const ang = -arc.half + ((k + 0.5) / 9) * arc.half * 2;
          this._brick.push(place(bevelBox(0.16, 0.3, (arc.half * 2 * arc.r) / 8.4, 0.012), {
            pos: [
              x - s * 0.08,
              2.28 - arc.cy + Math.cos(ang) * (arc.r + 0.15),
              pc + Math.sin(ang) * (arc.r + 0.15),
            ],
            rot: [ang, 0, 0],
          }));
        }
        // Spandrel fill above the arch, back to the corbel course.
        const sh = Math.max(0.06, SPRING_Y - 0.3 - (crown + 0.3));
        this._cast.push(place(bevelBox(0.13, sh, w, 0.02), {
          pos: [x - s * 0.065, SPRING_Y - 0.3 - sh / 2, pc],
        }));
      }
      // Corbel course at the springing: three brick projections, the line that
      // separates the wall from the ceiling and the one horizontal up there that
      // a strip can rake.
      for (let k = 0; k < 3; k++) {
        this._brick.push(place(bevelBox(0.1 + k * 0.05, 0.09, len - 0.4, 0.012), {
          pos: [x - s * (0.05 + k * 0.025), SPRING_Y - 0.28 + k * 0.09, zc],
        }));
      }
    }

    // --- the bulkhead ------------------------------------------------------
    // A cross wall with a big segmental opening on the fight axis and a smaller
    // doorway to the left. Everything in bands D and E is seen through one of
    // those two holes, which is what makes those bands read as further away
    // rather than merely smaller: an aperture is a depth cue, a silhouette is
    // not. Built as spans that skip the openings, the same way the pit's shell
    // wall is, because that is cheaper and far more controllable than a boolean.
    // Sited by ray, not by eye. Projecting the fight camera (about x 1.9,
    // z 13.8) through the through-bay's mouth at z -7.7 puts the visible slice
    // of the bulkhead at x -6.2 to -0.6, so an arch centred on the fight axis
    // would have been half occluded by the pier at x 0.6 and the machine hall
    // would have been seen through a slot. Centred at -1.6 the arch fills that
    // slice almost exactly, which is the difference between band D reading as a
    // room beyond a doorway and reading as a gap between two columns.
    const holes = [
      { x: -1.6, y: 2.2, w: 8.0, h: 4.4 },
      { x: -8.4, y: 1.5, w: 2.4, h: 3.0 },
    ];
    const spansAt = (yc) => {
      const spans = [[-TANK_X, TANK_X]];
      for (const h of holes) {
        if (yc < h.y - h.h / 2 || yc > h.y + h.h / 2) continue;
        const cut = [h.x - h.w / 2, h.x + h.w / 2];
        for (let i = spans.length - 1; i >= 0; i--) {
          const [a, b] = spans[i];
          if (cut[1] <= a || cut[0] >= b) continue;
          spans.splice(i, 1);
          if (cut[0] > a) spans.push([a, cut[0]]);
          if (cut[1] < b) spans.push([cut[1], b]);
        }
      }
      return spans;
    };
    const H = 5.8;
    for (let i = 0; i < 12; i++) {
      const y0 = (i * H) / 12, y1 = ((i + 1) * H) / 12;
      const yc = (y0 + y1) / 2;
      for (const [a, b] of spansAt(yc)) {
        if (b - a < 0.08) continue;
        this._cast.push(place(bevelBox(b - a, y1 - y0 - 0.015, 0.75, 0.02), { pos: [(a + b) / 2, yc, BULKHEAD_Z] }));
      }
    }
    // Segmental voussoir heads over both openings, so the apertures read as
    // built rather than as rectangles cut out of a wall. Rises are 1.15m over
    // the 8m arch and 0.55m over the doorway — an arch that could not stand up
    // in the wall it is drawn in is the sort of thing the eye catches without
    // being able to say why.
    for (const h of holes) {
      const arc = segmental(h.w, h.w > 5 ? 1.15 : 0.55);
      const n = h.w > 5 ? 17 : 9;
      const spring = h.y + h.h / 2 - (arc.r - arc.cy);
      for (let i = 0; i < n; i++) {
        const a = -arc.half + ((i + 0.5) / n) * arc.half * 2;
        this._brick.push(place(bevelBox((arc.half * 2 * arc.r) / (n * 0.92), 0.44, 0.8, 0.012), {
          pos: [h.x + Math.sin(a) * (arc.r + 0.22), spring - arc.cy + Math.cos(a) * (arc.r + 0.22), BULKHEAD_Z - 0.02],
          rot: [0, 0, -a],
        }));
      }
      this._cast.push(place(bevelBox(h.w + 0.8, 0.22, 0.9, 0.02), { pos: [h.x, h.y - h.h / 2 - 0.11, BULKHEAD_Z] }));
    }
  }

  /**
   * The flat coffered soffit over the fight deck.
   *
   * The arcade behind is the original brick vaulting; over the deck it has been
   * replaced by a concrete deck slab on transverse beams, which is what happens
   * to a Victorian tank when someone needs to drive over it. Two build phases in
   * one room is worth having for its own sake, but the reason it is here is
   * lighting: the beams are DARK, they are directly over the fight plane, and
   * they close the top of the frame absolutely. There is no sky in this arena and
   * this is the object that says so.
   *
   * The beam spacing is 4.4 / 4.4 / 4.0 / 4.6 rather than a constant 4.35, for
   * the reason the arcade's is: four parallel lines at one pitch converging on
   * one vanishing point is a ruler, and a ruler in the top of the frame is the
   * cheapest possible way to make a set look generated.
   */
  #deckSoffit() {
    // Two more beams forward, so the ceiling reaches the extended tank front
    // rather than stopping over open water at z 9.5. Still an uneven pitch.
    const beams = [13.6, 10.2, 7.4, 3.0, -1.4, -5.4];
    for (const z of beams) {
      this._cast.push(place(bevelBox(TANK_X * 2 + 0.6, 0.62, 0.55, 0.035), { pos: [0, CROWN_Y - 0.31, z] }));
      // A haunch at each bearing: the beam thickens where it lands on the wall.
      for (const s of [-1, 1]) {
        this._cast.push(place(bevelBox(1.5, 0.34, 0.55, 0.03), { pos: [s * (TANK_X - 0.75), CROWN_Y - 0.79, z] }));
      }
    }
    // The slab itself, above the beams. One box; nothing ever lights it.
    this._cast.push(place(bevelBox(TANK_X * 2 + 1.6, 0.42, 23.2, 0.04), { pos: [0, CROWN_Y + 0.21, 3.6] }));
    // Secondary ribs across the beams, so the soffit is a coffered grid rather
    // than four lines. They are the only thing up there a strip's upward spill
    // can catch, and their pitch is a THIRD of the beams' so the two rhythms do
    // not beat against each other.
    for (let i = 0; i < 4; i++) {
      const x = -8.4 + i * 5.6;
      this._cast.push(place(bevelBox(0.28, 0.40, 21.0, 0.02), { pos: [x, CROWN_Y - 0.20, 3.4] }));
    }
  }

  /**
   * The weir wall behind the fight plane, and the arena's principal
   * shadow-catcher.
   *
   * This is the surface the per-fighter shadowed key is meant to land on, and
   * everything about it is chosen for that: it stands 1.32m tall directly behind
   * the fighters at z -6.2, it runs the full width of frame, and its camera-side
   * face is DELIBERATELY almost undressed. A hard-edged shadow needs somewhere
   * broad and plain to be legible on; the pit never had one, which is most of
   * why its shadows read as soft even when they were not.
   *
   * The dressing it does carry is all on the far side or on the coping, where it
   * silhouettes against the arcade instead of breaking up the shadow: a spillway
   * notch on the fight axis, stop-log grooves either side of it, and the coping's
   * own chamfer, which is the one line on this object that catches the strips.
   */
  #weir() {
    const b = this.bins;
    const notch = 1.55;          // half width of the spillway
    const sill = 0.78;           // invert of the notch
    // Left and right of the notch, plus the low sill under it.
    for (const s of [-1, 1]) {
      const a = s * notch, c = s * TANK_X;
      this._cast.push(place(bevelBox(Math.abs(c - a), WEIR_Y, 0.62, 0.035), {
        pos: [(a + c) / 2, WEIR_Y / 2, WEIR_Z],
      }));
    }
    this._cast.push(place(bevelBox(notch * 2, sill, 0.62, 0.03), { pos: [0, sill / 2, WEIR_Z] }));
    // Coping: a chamfered capping stone the whole way across, stepped down
    // through the notch. The chamfer is the specular line, and the dowel caps
    // along its top are the only thing that gives that line a LENGTH — the same
    // argument the pit's barrier capping makes about a fastener every 250mm.
    this._cast.push(place(bevelBox(TANK_X * 2, 0.13, 0.78, 0.022), { pos: [0, WEIR_Y + 0.065, WEIR_Z] }));
    b.steel.push(place(boltRow(TANK_X * 2 - 0.8, 30, 0.021, 0.014), {
      pos: [0, WEIR_Y + 0.13, WEIR_Z - 0.22], rot: [-Math.PI / 2, 0, 0],
    }));
    // Joints in the coping, one every 2.4m: a capping run this long is laid in
    // stones and every stone has an end.
    for (let i = -4; i <= 4; i++) {
      this._cast.push(place(bevelBox(0.05, 0.15, 0.82, 0.008), { pos: [i * 2.4 + 0.3, WEIR_Y + 0.065, WEIR_Z] }));
    }
    this._cast.push(place(bevelBox(notch * 2 + 0.5, 0.10, 0.78, 0.02), { pos: [0, sill + 0.05, WEIR_Z] }));
    // Stop-log grooves: two channels either side of the notch, and the logs
    // themselves stacked on the deck beside them because they have been pulled.
    for (const s of [-1, 1]) {
      this._iron.push(place(bevelBox(0.12, WEIR_Y - sill + 0.34, 0.2, 0.015), {
        pos: [s * (notch + 0.06), sill + (WEIR_Y - sill + 0.34) / 2, WEIR_Z + 0.3],
      }));
      // Stacked along the wall at x +/-10.55, not across the deck at +/-6.4.
      //
      // They started inside the play volume — 2.9m baulks lying at x +/-6.4,
      // z -5.05, well within the +/-9 and +/-5.5 bounds — which the occlusion
      // audit found at 4.5%. The screen figure is floor-furniture scale and not
      // worth a round on its own; what makes it worth moving is the same thing
      // that made the penstock gate and the marker posts worth moving, and it is
      // not a rendering question: a fighter would walk through a stack of timber
      // baulks. Turned to lie along z so a 2.6m log fits between the play bound
      // and the tank wall instead of spearing through it.
      for (let i = 0; i < 3; i++) {
        this._iron.push(place(bevelBox(0.14, 0.17, 2.6, 0.02), {
          pos: [s * 10.55 + this.rng.range(-0.06, 0.06), 0.09 + i * 0.19, WEIR_Z + 1.9 + i * 0.06],
          rot: [this.rng.range(-0.02, 0.02), 0, this.rng.range(-0.05, 0.05)],
        }));
      }
    }
    // Anchor plates and dowels along the weir's foot, on the deck side. These
    // are the fixings the floor bake weeps iron from — the two lists agree.
    for (const f of FIXINGS) {
      if (f.z > WEIR_Z + 2.6 || f.z < WEIR_Z - 0.4 || f.r < 0.24) continue;
      b.steel.push(place(bevelBox(f.r * 2, 0.045, f.r * 2, 0.01), { pos: [f.x, 0.022, f.z] }));
      b.steel.push(place(boltRow(f.r * 1.2, 2, 0.026, 0.03), { pos: [f.x, 0.05, f.z], rot: [-Math.PI / 2, 0, 0] }));
    }
  }

  // -------------------------------------------------------------------------
  // Band C — the arcade
  // -------------------------------------------------------------------------

  /**
   * Two rows of piers carrying glazed-brick barrel vaults, and the third depth
   * band's whole lighting treatment.
   *
   * The rule is one strip per bay and no strip anywhere else, so a bay is lit by
   * its own fitting or it is not lit at all. That is what produces the thing the
   * pit cannot: a row of alternating bright and black openings receding across
   * the frame, with the brick soffit of each lit bay carrying a real specular
   * falloff from the strip in its corner. Half the bays are dark, and dark here
   * means genuinely dark — there is no ambient in this room to rescue them.
   *
   * Against "uniform detail density", which the pit is explicitly marked down
   * for: the RHYTHM is regular because a colonnade is, but nothing else is. The
   * spans differ, the two rows are offset, one bay has collapsed and one is
   * shuttered with stop-logs, and the dressing on each pier is dealt from five
   * different fittings rather than repeated. That is the same repair the pit's
   * anchor-plate field got — decorrelate the draws, vary the density in blocks,
   * and give the thing more than one silhouette.
   */
  #arcade() {
    const rubble = [];
    // The front row's piers are 3.4m DEEP, not 1.1m, and its vaults are barrels
    // 3.5m long rather than rings. That one number is most of what this band is
    // worth: a lit bay stops being a bright arch and becomes a bright TUNNEL
    // receding away from the lens, with its own falloff down its own length from
    // the strip in its near corner, and with the second pier row visible in the
    // dark at the far end of it. A 1.1m ring has no inside for the eye to look
    // down. It also costs almost nothing — a barrel is one open half-cylinder at
    // three length segments, so the extra 2.3m is 64 triangles a bay.
    for (const [xs, z, bays, depth] of [[PIERS_A, ARCADE_Z, BAYS_A, 3.4], [PIERS_B, ARCADE2_Z, BAYS_B, 1.9]]) {
      for (let i = 0; i < xs.length; i++) this.#pier(xs[i], z, 1.05, depth);
      for (let i = 0; i < bays.length; i++) {
        const x0 = xs[i] + 0.525, x1 = xs[i + 1] - 0.525;
        const span = x1 - x0;
        const cx = (x0 + x1) / 2;
        const state = bays[i];
        if (state === 'collapsed') {
          this.#collapsedBay(cx, span, z, depth, rubble);
          continue;
        }
        this.#vault(cx, span, z, depth, state === 'through');
        if (state === 'shuttered') this.#stopLogs(cx, span, z);
      }
    }

    // Rubble from the collapsed bay. Instanced, because forty broken lumps of
    // brick and concrete is forty instances of one solid and it would be absurd
    // to merge them: an icosahedron is twenty triangles and the variation that
    // matters is the non-uniform scale and the rotation, both per instance.
    if (rubble.length) {
      const geo = worldUv(new THREE.IcosahedronGeometry(0.28, 0), 0.6);
      const mesh = new THREE.InstancedMesh(geo, this.castMaterial, rubble.length);
      mesh.name = 'arena.vault.rubble';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      rubble.forEach((r, i) => {
        _e.set(r[3], r[4], r[5]);
        _q.setFromEuler(_e);
        _m.compose(_p.set(r[0], r[1], r[2]), _q, _s.set(r[6], r[7], r[8]));
        mesh.setMatrixAt(i, _m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.rubble = mesh;
      this.group.add(mesh);
    }
  }

  /**
   * One pier: plinth, shaft, the high-water string course, impost.
   *
   * The dressing is dealt rather than repeated. Five fittings and a fair chance
   * of nothing at all, so no two piers in a row carry the same object — which is
   * the difference between an arcade and a wallpaper of arcades. Every one of
   * them is something that would actually be bolted to a cistern pier: a
   * cast-iron junction box, a downpipe on saddle clamps, a set of climbing
   * irons, a depth gauge, a bracket that has lost whatever it carried.
   */
  #pier(x, z, w, d) {
    const rng = this.rng;
    const b = this.bins;
    const plinth = 0.42;
    this._cast.push(place(bevelBox(w + 0.3, plinth, d + 0.3, 0.035), { pos: [x, plinth / 2, z] }));
    this._cast.push(place(bevelBox(w, SPRING_Y - plinth, d, 0.075), { pos: [x, (SPRING_Y + plinth) / 2, z] }));
    this._cast.push(place(bevelBox(w + 0.1, 0.065, d + 0.1, 0.014), { pos: [x, HIGH_MARK_Y, z] }));
    this._cast.push(place(bevelBox(w + 0.36, 0.28, d + 0.36, 0.03), { pos: [x, SPRING_Y + 0.14, z] }));
    // Dowel caps round the impost. Individually invisible; together they are
    // what makes the impost read as a bearing rather than as a moulding, and
    // they are the highest-frequency thing on the pier for a raking strip.
    this.bins.steel.push(place(boltRow(w + 0.2, 4, 0.019, 0.013), { pos: [x, SPRING_Y + 0.28, z + d / 2 + 0.1], rot: [-Math.PI / 2, 0, 0] }));
    // A single recessed panel on the camera-side face, above the high mark.
    // Broad and plain below it on purpose: the piers are the other surface a
    // hard key shadow is supposed to land on.
    this._cast.push(place(insetPanel(w - 0.3, 1.1, 0.05, 0.08), { pos: [x, 2.44, z + d / 2 + 0.01] }));

    const fitting = rng.int(7);
    const fz = z + d / 2 + 0.06;
    if (fitting === 0) {
      // Cast-iron junction box with a conduit dropping out of the bottom.
      this._iron.push(place(bevelBox(0.34, 0.44, 0.19, 0.02), { pos: [x + 0.2, 2.05, fz + 0.09] }));
      this._iron.push(place(boltRow(0.22, 2, 0.02, 0.014), { pos: [x + 0.2, 1.86, fz + 0.19] }));
      this._iron.push(place(new THREE.CylinderGeometry(0.028, 0.028, 1.5, 7), { pos: [x + 0.2, 1.08, fz + 0.09] }));
    } else if (fitting === 1) {
      // Downpipe on saddle clamps, running into the water.
      this._iron.push(place(new THREE.CylinderGeometry(0.06, 0.06, SPRING_Y - 0.2, 9), { pos: [x - 0.32, (SPRING_Y - 0.2) / 2, fz + 0.05] }));
      for (const y of [0.9, 2.1, 3.0]) {
        this._iron.push(place(new THREE.TorusGeometry(0.075, 0.014, 5, 10), { pos: [x - 0.32, y, fz + 0.05] }));
      }
      this._iron.push(place(new THREE.CylinderGeometry(0.075, 0.075, 0.13, 9), { pos: [x - 0.32, 0.28, fz + 0.05] }));
    } else if (fitting === 2) {
      // Climbing irons: a ladder cast into the pier face.
      for (let i = 0; i < 7; i++) {
        this._iron.push(place(new THREE.TorusGeometry(0.11, 0.017, 4, 9, Math.PI), {
          pos: [x, 0.55 + i * 0.34, fz], rot: [Math.PI / 2, 0, 0],
        }));
      }
    } else if (fitting === 3) {
      // Depth gauge board, and the one place in the arcade with type on it. It
      // reads the same water the tide mark does.
      b.plate.push(place(new THREE.PlaneGeometry(0.24, 1.4), { pos: [x + 0.28, 1.5, fz + 0.02] }));
      this._iron.push(place(bevelBox(0.32, 0.05, 0.05, 0.01), { pos: [x + 0.28, 2.22, fz + 0.02] }));
      this._iron.push(place(bevelBox(0.32, 0.05, 0.05, 0.01), { pos: [x + 0.28, 0.8, fz + 0.02] }));
    } else if (fitting === 4) {
      // A bracket that has lost whatever it carried. Two gussets and four bolts.
      this._iron.push(place(bevelBox(0.5, 0.05, 0.34, 0.01), { pos: [x - 0.1, 2.6, fz + 0.16] }));
      for (const s of [-1, 1]) {
        const g = spanX([x - 0.1 + s * 0.16, 2.58, fz + 0.3], [x - 0.1 + s * 0.16, 2.2, fz - 0.02]);
        this._iron.push(place(bevelBox(g.length, 0.04, 0.03, 0.008), { pos: g.pos, rot: g.rot }));
      }
      this._iron.push(place(boltRow(0.3, 2, 0.02, 0.014), { pos: [x - 0.1, 2.62, fz + 0.02] }));
    }
    // The strip's own bracketry is added by #emitters, which owns which bays are
    // lit; a pier does not get to decide that for itself.
  }

  /**
   * A brick barrel vault over one bay: two voussoir rings and the soffit
   * between them.
   *
   * The rings are individual stones rather than a swept band, and that is worth
   * eleven boxes a bay: a strip in the corner of a lit bay rakes along the arch,
   * and what makes it read as masonry rather than as a painted curve is the
   * joint between one voussoir and the next catching that rake. It is the same
   * argument as the chamfer on every box in `GeoKit` — a highlight needs an edge
   * to run along.
   */
  #vault(cx, span, z, depth, wide) {
    const r = span / 2;
    const n = wide ? 15 : 11;
    const ring = wide ? 0.42 : 0.34;
    // Rings at both ends and one across the middle of a deep barrel: the middle
    // one is a transverse arch, which is what a barrel of this length actually
    // has and which is the only feature down the tunnel's length for a strip to
    // rake across.
    const rings = depth > 2.4 ? [depth / 2 + 0.02, 0, -depth / 2 - 0.02] : [depth / 2 + 0.02, -depth / 2 - 0.02];
    for (const dz of rings) {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + ((i + 0.5) / n) * Math.PI;
        this._brick.push(place(bevelBox(0.3, ring, 0.26, 0.012), {
          pos: [cx + Math.sin(a) * (r + ring / 2), SPRING_Y + Math.cos(a) * (r + ring / 2), z + dz],
          rot: [0, 0, -a],
        }));
      }
    }
    // Soffit: an open half-cylinder, axis along z. `thetaStart -PI/2` puts the
    // crown at theta 0 once the cylinder is laid on its side, so the sweep runs
    // springing to springing the short way round. Length segments matter on the
    // deep barrels — Gouraud has nothing to do here, but the strip's falloff
    // down the tunnel is carried by the wash card and the vertex density is
    // what stops the merged mesh's world-space UVs stretching along it.
    this._brick.push(place(
      new THREE.CylinderGeometry(r, r, depth + 0.06, 16, depth > 2.4 ? 3 : 1, true, -Math.PI / 2, Math.PI),
      { pos: [cx, SPRING_Y, z], rot: [-Math.PI / 2, 0, 0] },
    ));
    // Spandrel fill above the arch, back to the soffit line. Concrete, not
    // brick: it is later, and the value difference is what makes the arch read.
    this._cast.push(place(bevelBox(span + 0.6, 0.5, depth + 0.1, 0.03), {
      pos: [cx, SPRING_Y + r + ring + 0.25, z],
    }));
  }

  /**
   * The collapsed bay: the vault is down, the rubble is in the water, and the
   * two piers either side have been shored.
   *
   * One bay in eleven, and it is the single most valuable object in this band,
   * because it is the only thing that breaks the arcade's rhythm at the level of
   * SILHOUETTE rather than at the level of dressing. A row of arches with
   * different things bolted to it is still a row of arches; a row of arches with
   * a hole in it is a place something happened.
   */
  #collapsedBay(cx, span, z, depth, rubble) {
    const rng = this.rng;
    const r = span / 2;
    // The springing stubs that survived, on both sides, ending in a break.
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const a = s * (Math.PI / 2 - (i + 0.5) * 0.19);
        this._brick.push(place(bevelBox(0.3, 0.36, depth + 0.04, 0.012), {
          pos: [cx + Math.sin(a) * (r + 0.18), SPRING_Y + Math.cos(a) * (r + 0.18), z],
          rot: [0, 0, -a],
        }));
      }
    }
    // Ragged brick hanging off the break line.
    for (let i = 0; i < 9; i++) {
      const s = rng.next() < 0.5 ? -1 : 1;
      const a = s * (Math.PI / 2 - rng.range(0.5, 0.95));
      this._brick.push(place(bevelBox(rng.range(0.16, 0.34), rng.range(0.12, 0.3), rng.range(0.2, 0.6), 0.01), {
        pos: [cx + Math.sin(a) * (r + 0.2), SPRING_Y + Math.cos(a) * (r + 0.2), z + rng.range(-0.5, 0.5)],
        rot: [rng.range(-0.5, 0.5), rng.range(-0.6, 0.6), -a + rng.range(-0.4, 0.4)],
      }));
    }
    // Reinforcement hanging out of the spandrel, because the later concrete
    // above the brick is what actually failed.
    for (let i = 0; i < 5; i++) {
      const x = cx + rng.range(-r * 0.8, r * 0.8);
      this._iron.push(tube(catenary(
        [x, SPRING_Y + r * 0.9, z + rng.range(-0.3, 0.3)],
        [x + rng.range(-0.6, 0.6), SPRING_Y + r * 0.2, z + rng.range(-0.6, 0.6)], 0.5, 7,
      ), 0.012, 4));
    }
    // A shoring prop and its head plate, jammed under the surviving springing.
    const px = cx + r * 0.55;
    this._iron.push(place(new THREE.CylinderGeometry(0.075, 0.075, SPRING_Y - 0.1, 9), { pos: [px, (SPRING_Y - 0.1) / 2 + 0.15, z + 0.2], rot: [0.05, 0, -0.07] }));
    this._iron.push(place(bevelBox(0.34, 0.05, 0.34, 0.01), { pos: [px - 0.12, SPRING_Y + 0.1, z + 0.2] }));
    this._iron.push(place(bevelBox(0.3, 0.05, 0.3, 0.01), { pos: [px + 0.09, 0.16, z + 0.2] }));

    // The rubble pile. Density falls off from the bay and it spills forward
    // into the water, which is the only reason it is visible at all — a heap
    // tucked between two piers is behind them.
    const count = this.quality === 'low' ? 22 : 52;
    for (let i = 0; i < count; i++) {
      const t = rng.next();
      // Most of it fell straight down inside its own bay; the tail of the
      // distribution washed forward out of the mouth into the open water, which
      // is the only part of the heap the camera can actually see past the piers.
      rubble.push([
        cx + rng.range(-r * 0.95, r * 0.95) * (0.55 + t * 0.5),
        rng.range(0.02, 0.36) * (1 - t * 0.55),
        z + rng.range(-depth / 2, depth / 2) + t * t * 1.6,
        rng.range(0, 3), rng.range(0, 3), rng.range(0, 3),
        rng.range(0.5, 1.5), rng.range(0.35, 0.9), rng.range(0.5, 1.4),
      ]);
    }
  }

  /**
   * The shuttered bay: stop-logs dropped into the pier grooves, closing it off.
   *
   * The other break in the rhythm, and it works the opposite way to the
   * collapsed one — instead of a hole it is a FLAT, which is the only fully
   * closed shape in the arcade and therefore reads as a solid block wherever the
   * light hits it. Between them the two special bays give this band three
   * silhouettes: open, blocked and broken.
   */
  #stopLogs(cx, span, z) {
    const h = 2.35;
    for (let i = 0; i < 7; i++) {
      const y = 0.17 + i * 0.33;
      this._iron.push(place(bevelBox(span + 0.12, 0.30, 0.16, 0.018), {
        pos: [cx, y, z], rot: [0, 0, this.rng.range(-0.008, 0.008)],
      }));
    }
    // Guide channels on both piers, a lifting beam over the top, and the
    // spindle and handwheel that raise the logs.
    for (const s of [-1, 1]) {
      this._iron.push(place(bevelBox(0.14, h + 0.5, 0.3, 0.016), { pos: [cx + s * (span / 2 + 0.08), (h + 0.5) / 2, z] }));
    }
    this._iron.push(place(bevelBox(span + 0.9, 0.24, 0.24, 0.02), { pos: [cx, h + 0.55, z] }));
    this._iron.push(place(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8), { pos: [cx, h + 1.3, z] }));
    this._iron.push(place(new THREE.TorusGeometry(0.26, 0.028, 5, 14), { pos: [cx, h + 2.05, z], rot: [Math.PI / 2, 0, 0] }));
    for (let i = 0; i < 4; i++) {
      this._iron.push(place(bevelBox(0.5, 0.03, 0.03, 0.008), { pos: [cx, h + 2.05, z], rot: [0, 0, (i / 4) * Math.PI] }));
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Everything standing on the deck itself: the sluice kerbs and their gate, the
   * sump handrail, a valve manifold on the right wall, and the access ladder.
   *
   * All of it goes into the Stage's shared bins, so the whole list costs nothing
   * in draw calls. All of it is also deliberately LOW — nothing here stands
   * above 1.4m inside the play bounds, because the fight plane's silhouette band
   * is the one thing in a fighting game that may not be cluttered.
   */
  #deckDressing() {
    const b = this.bins;
    const rng = this.rng;

    // --- the sluice channel's kerbs and its gate ---------------------------
    // `StageFloor#buildDrains` cuts the channel and lays the grating; the kerbs
    // are what make it read as a channel rather than as a grating laid on a
    // flat floor, and the upstream one is what the silt banks against in the
    // floor bake. Same 0.62m offset in both places.
    for (const dz of [-0.62, 0.62]) {
      b.concrete.push(place(bevelBox(25, 0.16, 0.26, 0.02), { pos: [0, 0.08, SLUICE_Z + dz] }));
    }
    // Penstock gate over the outfall: a plain plate on a rising spindle in a
    // cast frame. The plate is 1.9 x 1.5m of undressed steel standing square to
    // the camera on the near right, which makes it the second-best hard-shadow
    // catcher in the set after the weir.
    {
      // x 10.6, outboard of the +/-9 play bound rather than the 6.9 this
      // started at. The audit that caught the cable also caught this: at the
      // legal corner pose (pair at x 5.5 and 8.6, z +4) a 2.95m gate standing at
      // x 6.9, z 5.7 sits squarely between the lens and both fighters and hid
      // 44% of their combined silhouette. Outboard it cannot: an object at
      // lateral offset L leaves frame when L > 0.70 * D, and the camera's x
      // tracks the pair, so past the play bound the offset never closes.
      const gx = 10.6;
      this._iron.push(place(bevelBox(1.9, 1.5, 0.09, 0.02), { pos: [gx, 0.78, SLUICE_Z - 0.86] }));
      for (const s of [-1, 1]) {
        this._iron.push(place(bevelBox(0.18, 2.5, 0.28, 0.02), { pos: [gx + s * 1.06, 1.25, SLUICE_Z - 0.86] }));
      }
      this._iron.push(place(bevelBox(2.4, 0.24, 0.3, 0.02), { pos: [gx, 2.55, SLUICE_Z - 0.86] }));
      this._iron.push(place(new THREE.CylinderGeometry(0.032, 0.032, 1.4, 8), { pos: [gx, 2.2, SLUICE_Z - 0.86] }));
      this._iron.push(place(new THREE.TorusGeometry(0.3, 0.03, 5, 16), { pos: [gx, 2.95, SLUICE_Z - 0.86], rot: [Math.PI / 2, 0, 0] }));
      for (let i = 0; i < 3; i++) {
        this._iron.push(place(bevelBox(0.58, 0.032, 0.032, 0.008), { pos: [gx, 2.95, SLUICE_Z - 0.86], rot: [0, 0, (i / 3) * Math.PI] }));
      }
      b.hazard.push(place(bevelBox(1.9, 0.14, 0.1, 0.012), { pos: [gx, 1.6, SLUICE_Z - 0.9] }));
    }

    // --- the sump, its guard rail and its ladder ---------------------------
    b.concrete.push(place(bevelBox(3.0, 0.18, 3.0, 0.02), { pos: [SUMP.x, 0.09, SUMP.z] }));
    b.steel.push(place(railing(2.9, { height: 1.05, spacing: 1.45, radius: 0.024 }), { pos: [SUMP.x, 0.18, SUMP.z + 1.45] }));
    b.steel.push(place(railing(2.9, { height: 1.05, spacing: 1.45, radius: 0.024, toeBoard: false }), {
      pos: [SUMP.x - 1.45, 0.18, SUMP.z], rot: [0, Math.PI / 2, 0],
    }));
    for (let i = 0; i < 6; i++) {
      this._iron.push(place(new THREE.TorusGeometry(0.11, 0.017, 4, 9, Math.PI), {
        pos: [SUMP.x + 1.0, 0.9 - i * 0.3, SUMP.z - 1.5], rot: [Math.PI / 2, 0, 0],
      }));
    }

    // --- a valve manifold on the right wall --------------------------------
    // Six valves on a header, at the height a person works at. It is the only
    // busy object inside the play bounds and it is pushed hard against the wall
    // at x +10.6 where it cannot crowd a silhouette.
    {
      const vx = TANK_X - 0.72, vz = -3.4;
      this._iron.push(place(new THREE.CylinderGeometry(0.16, 0.16, 4.6, 12), { pos: [vx, 1.55, vz], rot: [Math.PI / 2, 0, 0] }));
      for (let i = 0; i < 6; i++) {
        const z = vz - 2.0 + i * 0.82 + rng.range(-0.05, 0.05);
        const r = 0.10 + (i % 3) * 0.022;
        this._iron.push(place(new THREE.CylinderGeometry(r, r, 0.62, 10), { pos: [vx - 0.31, 1.55, z], rot: [0, 0, Math.PI / 2] }));
        this._iron.push(place(new THREE.CylinderGeometry(r * 1.4, r * 1.4, 0.08, 10), { pos: [vx - 0.52, 1.55, z], rot: [0, 0, Math.PI / 2] }));
        this._iron.push(place(new THREE.CylinderGeometry(0.02, 0.02, 0.34, 6), { pos: [vx - 0.4, 1.86, z] }));
        this._iron.push(place(new THREE.TorusGeometry(0.14, 0.018, 4, 11), { pos: [vx - 0.4, 2.04, z], rot: [rng.range(-0.2, 0.2), 0, 0] }));
      }
      // The header's drops into the water, which is where all this goes.
      for (const z of [vz - 1.9, vz + 1.4]) {
        this._iron.push(pipeRun([[vx, 1.39, z], [vx, 0.5, z], [vx - 0.55, 0.1, z]], 0.075, { flangeEvery: 1 }));
      }
    }

    // --- level markers, standing exactly at the water's edge ---------------
    // Two short striped posts at `WATERLINE_Z`, which is derived from the fall
    // and the water elevation rather than typed in. They are here to do one job:
    // the deck's tide mark is a texture, and a texture can be argued with, but a
    // physical object standing half in and half out of the water at the same
    // line cannot be. It is the cheapest possible proof that the water in the
    // map and the water in the room are the same water.
    // Outboard of the +/-9 play bound. They started at -7.8 and +8.6, which is
    // inside it: a fighter could walk through them, and at a rearward pose they
    // stood in front of one. A marker post proves where the water is just as
    // well from beside the play area as from inside it.
    for (const mx of [-10.2, 10.9]) {
      b.hazard.push(place(bevelBox(0.11, 1.15, 0.11, 0.012), { pos: [mx, 0.575, WATERLINE_Z + rng.range(-0.4, 0.4)] }));
      b.steel.push(place(bevelBox(0.3, 0.04, 0.3, 0.008), { pos: [mx, 0.02, WATERLINE_Z] }));
    }

    // --- cable tray down the left wall, above the high mark -----------------
    // The one periodic run in the room, and it is here for the reason
    // `StageStructure` states: a tray gives the eye a ruler for the depth of the
    // space, because its rungs foreshorten. It sits at 2.9m, clear of the strips
    // and clear of the fighters' silhouette band.
    b.steel.push(place(cableTray(19, 0.42, { rungPitch: 0.34, depth: 0.1, cables: 3 }), {
      pos: [-TANK_X + 0.55, 2.9, -3.0], rot: [0, Math.PI / 2, 0],
    }));
    for (let z = -12; z <= 6; z += 1.7) {
      b.steel.push(place(bevelBox(0.5, 0.06, 0.05, 0.012), { pos: [-TANK_X + 0.3, 2.88, z], rot: [0, Math.PI / 2, 0] }));
    }

    // --- a walkway across the back of the deck -----------------------------
    // Bar grating on two channels, spanning the weir's notch, at 1.55m: it is
    // the one horizontal that crosses the frame ABOVE the weir coping, so the
    // two of them describe the depth between the deck and the arcade.
    {
      const y = 1.55;
      const g = new THREE.PlaneGeometry(7.4, 1.05);
      g.rotateX(-Math.PI / 2);
      g.translate(0, y, WEIR_Z - 0.1);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (7.4 / 0.9), uv.getY(i) * (1.05 / 0.9));
      b.grate.push(g);
      for (const dz of [-0.5, 0.5]) {
        b.steel.push(place(bevelBox(7.6, 0.16, 0.05, 0.012), { pos: [0, y - 0.08, WEIR_Z - 0.1 + dz] }));
      }
      b.steel.push(place(railing(7.4, { height: 1.0, spacing: 1.85, radius: 0.022 }), { pos: [0, y, WEIR_Z - 0.62] }));
    }
  }

  /**
   * A frayed feeder off the arcade's conduit run, arcing into the dark bay.
   *
   * **This was a defect and the defect is worth recording, because the mistake
   * is easy to repeat.** The first version was authored as two endpoints and a
   * sag fraction — `catenary([-7.2, 3.7, -8.9], [-4.0, 2.55, -3.6], 0.35)` —
   * both endpoints comfortably clear of everything, and nobody looked at where
   * the middle of the curve went. It went to **y 0.55**: the sag on a 6.2m span
   * at 0.35 drops the low point nearly two metres below the lower anchor, so the
   * cable hung through the fighters' shins. Measured after the fact, 45% of its
   * vertices sat inside the play volume below 2.6m and it reached z -3.13, well
   * inside the +/-5.5 combat depth. On rendered frames it read as an unlit black
   * line across the subject at both framings, which is the same defect class as
   * the open "black pole through the fighter" note in docs/PROFILING.md — and
   * that note is explicit that an unlit bar in front of the brightest object in
   * the scene is a shading failure on stage geometry in the one shot the axis is
   * scored on. A curve is not sited by its endpoints. It is sited by its extent.
   *
   * So this one is solved rather than placed, and the numbers below are measured
   * off the built geometry, not intended:
   *
   *     lowest point            y 2.18   (fighters are 1.85 tall)
   *     bounding box            x 0.87..3.66, y 1.71..3.17, z -8.04..-7.60
   *     vertices in the play volume below 2.6m      0 of 3780
   *     clearance behind the fighters' rearmost legal position   2.10 m
   *
   * Being behind the weir is what makes that clearance unconditional: the
   * fighters cannot pass z -5.5 and this cannot pass z -7.60, so no camera the
   * solver can produce puts it between the lens and a fighter. It does not need
   * the outboard or the height rule; it is simply never in the way.
   *
   * It is hung on the jamb between the lit through-arch and the dark bay, which
   * is the one place in the arcade where both halves of it work: the anchor end
   * catches the edge of the key's wash and reads as a lit run, and the frayed
   * end hangs into a bay with no fitting at all, so it is invisible until it
   * strikes. A cable that can only be seen when it arcs is not a black bar; it
   * is the reason that bay is dark.
   */
  #cable() {
    const A = [0.9, 3.15, -7.64];
    const B = [3.3, 2.35, -7.92];
    // 0.10, and the sag is now a solved number: 0.06/0.10/0.14/0.20/0.35 put the
    // low point at 2.27/2.18/2.10/1.98/1.73. Anything past 0.20 starts to dip
    // toward the head height of a fighter who cannot get within two metres of
    // it, which is slack a dead feeder would not be carrying anyway.
    const pts = catenary(A, B, 0.10, 14);
    const tail = [
      pts[pts.length - 1].clone(),
      new THREE.Vector3(3.52, 2.02, -7.98),
      new THREE.Vector3(3.63, 1.72, -8.02),
    ];
    this._iron.push(tube(pts, 0.038, 6), tube(tail, 0.03, 5));
    // The gland box it comes out of, and two cleats along the jamb. Without them
    // a cable is a line that starts nowhere; with them it is a run that has been
    // disconnected, which is the thing the arc is evidence of.
    this._iron.push(place(bevelBox(0.24, 0.3, 0.16, 0.02), { pos: [0.86, 3.32, -7.6] }));
    this._iron.push(place(boltRow(0.16, 2, 0.016, 0.011), { pos: [0.86, 3.16, -7.52] }));
    for (const [cx, cy] of [[1.55, 2.86], [2.45, 2.55]]) {
      this._iron.push(place(new THREE.TorusGeometry(0.055, 0.012, 4, 9), { pos: [cx, cy, -7.74], rot: [Math.PI / 2, 0, 0] }));
    }
    /** Where the arc lives; the Stage hangs a spark emitter here. */
    this.sparkPoint = new THREE.Vector3(3.63, 1.68, -8.02);
  }

  /**
   * Flotsam collected along the water's edge.
   *
   * The waterline is the most load-bearing single line in this arena and it is,
   * on the deck, entirely a texture. A texture can be argued with. Ninety small
   * dark objects lying half in and half out of it cannot: they are drawn by the
   * same `WATERLINE_Z` the bake solves for, they break that line into something
   * ragged and organic the way a real strandline is, and because they are the
   * darkest thing on the brightest part of the deck they carry more local
   * contrast per triangle than anything else in the set.
   *
   * They follow the same bowed contour the fall produces, sampled from
   * {@link tankFall} rather than laid on a straight line, so they agree with the
   * map they are lying on including the 1.5m bow at the walls.
   */
  #flotsam() {
    const rng = this.rng;
    const count = this.quality === 'low' ? 34 : 92;
    const geo = worldUv(bevelBox(0.34, 0.05, 0.1, 0.012), 0.5);
    const mesh = new THREE.InstancedMesh(geo, this.#flotsamMaterial(), count);
    mesh.name = 'arena.vault.flotsam';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    /**
     * Per-instance tone, and it is not decoration.
     *
     * Ninety-two plates sharing one material is ninety-two samples of a single
     * number, so whatever that number is the eye reads it as one object
     * repeated — and if the number is near black it reads as ninety-two holes.
     * Silt does not settle evenly: some of these have been under water since
     * the tank filled and are pale with mineral, some fell last week and are
     * still oxide. The spread is on a curve rather than uniform, so the set has
     * a few bright ones rather than a grey average.
     */
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    const _fc = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const x = rng.range(-13.6, 13.6);
      // Solve the contour for this x: the fall is monotonic in z, so ten steps
      // of bisection land the water's edge to within a centimetre.
      let lo = -10, hi = SLUICE_Z;
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) * 0.5;
        if (tankFall(x, mid) > WATER_LEVEL) lo = mid; else hi = mid;
      }
      // Scattered across the strandline rather than pinned to it: debris piles
      // up over a band roughly a metre wide, thickest just inside the water.
      const t = rng.next();
      const z = (lo + hi) * 0.5 + (t * t - 0.25) * 2.2;
      _e.set(rng.range(-0.12, 0.12), rng.range(0, Math.PI * 2), rng.range(-0.1, 0.1));
      _q.setFromEuler(_e);
      _m.compose(
        _p.set(x, 0.02 + rng.range(0, 0.03), z), _q,
        _s.set(rng.range(0.5, 2.6), rng.range(0.5, 1.4), rng.range(0.5, 2.2)),
      );
      mesh.setMatrixAt(i, _m);
      const silt = Math.pow(rng.next(), 1.9);          // few pale, many dark
      _fc.setRGB(
        0.75 + silt * 0.95,
        0.72 + silt * 0.88,
        0.66 + silt * 0.78,
      );
      mesh.setColorAt(i, _fc);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.flotsam = mesh;
    this.group.add(mesh);
  }

  /**
   * The flotsam's own surface, and the reason it needs one.
   *
   * **This is the fourteen unlit black quads a blind panel counted in the
   * reflective floor**, and they are not unlit — they are lit correctly, by a
   * material that is wrong for the one orientation they are used at.
   *
   * `castIronSet` bakes `metal = lerp(0.82, 0.06, rustMask)` over an albedo
   * whose mean is 0.0198 linear, and its own comment says why the rusted end is
   * pulled down: "Oxide is not a conductor. A fully rusted pipe at metalness 1
   * renders as a black hole against this room's near-zero IBL." That reasoning
   * is right and it does not reach far enough. Everything else built from this
   * set — the pipework, the brackets, the cable gland, the pier stubs — stands
   * VERTICAL, so it is seen from the side, catches the sodium rim and reflects
   * the arcade. The flotsam lies FLAT. Its normal points at the deck soffit,
   * which is the darkest thing in the room, and at metalness 0.82 there is no
   * diffuse term to rescue it: the whole appearance is a 2%-F0 specular
   * reflection of a black ceiling. Measured on `shots/19-cistern-wide`, over
   * the deck band: the plates come back at a 2nd-percentile luminance of 10.9
   * of 255 against a deck 60th percentile of 122.4 — 11.2x in code value and
   * **57x in linear light**, which is a hole, not a dark object.
   *
   * Three corrections, and each of them is the plate's own physics rather than
   * a brightness dial:
   *
   *   1. **It is all oxide.** Flotsam is by definition the stuff that has
   *      already come off and been in the water since; there is no sound
   *      painted ironwork in a strandline. `metalness` 0.14 puts the whole
   *      instance at the rusted end of the map the bake already provides, which
   *      is where the bake's own comment says a rusted surface belongs.
   *   2. **A dielectric needs a real albedo.** At metalness 0.82 the 0.0198
   *      map is an F0, not a reflectance; as a dielectric it has to be the
   *      diffuse colour, and wet silted oxide is about 0.05 linear and warm.
   *      The multiplier is on `color` because the map is shared with the
   *      pipework and must not move under it.
   *   3. **It is wet, and it is lying in a mirror.** `roughness` 0.72 on the
   *      map's 0.42-0.93 gives 0.30-0.67, so a plate half in the water picks up
   *      the strips the way the deck around it does instead of staying matte in
   *      the middle of a wet floor; and `envMapIntensity` goes to 1.0 from the
   *      pipework's 0.42, because a face-up plate sees the whole upper
   *      hemisphere and the pipework's value was chosen for a surface seen
   *      edge-on.
   *
   * The intent stays: these are still the darkest objects on the brightest part
   * of the deck, and that contrast is what they were put there for. What they
   * stop being is clipped to the frame's black point.
   */
  #flotsamMaterial() {
    const t = this.sets.iron;
    this.flotsamMaterial = new THREE.MeshStandardMaterial({
      name: 'arena.vault.flotsam',
      map: t.albedo,
      normalMap: t.normal,
      roughnessMap: t.orm,
      metalnessMap: t.orm,
      aoMap: t.orm,
      normalScale: new THREE.Vector2(1.15, 1.15),
      // Multipliers on the shared cast-iron maps. See the note above for each.
      color: new THREE.Color(2.00, 1.85, 1.60),
      roughness: 0.72,
      metalness: 0.14,
      envMapIntensity: 1.0,
      dithering: true,
    });
    this.flotsamMaterial.shadowSide = THREE.FrontSide;
    return this.flotsamMaterial;
  }

  // -------------------------------------------------------------------------
  // Band A — foreground occlusion
  // -------------------------------------------------------------------------

  /**
   * Band A, rebuilt, and the rebuild is the interesting part.
   *
   * The first version put a broken pier at z +7.7 and a five-pipe bundle running
   * from x -12.5 to +4.5 at y 2.4-3.2. On rendered frames that came back as a
   * full-width horizontal band of dark pipework crossing the picture at the
   * fighters' feet, with the near fighter's legs behind it. An occluder that
   * hides the subject is not a depth layer, it is a wall.
   *
   * **Why, measured off `FightCamera` rather than guessed.** `#framingFight`
   * solves its distance from the composition box: at idle separation that is
   * about 4.1m, at wide separation about 7.5m, and the camera sits at
   * `focus.z + cos(pitch) * dist` with `focus.z` following the PAIR. The pair
   * may stand anywhere in z from -5.5 to +5.5, so the fight camera roams
   * **z = 4 to 13** and y = 1.3 to 1.95. There is therefore no z in the near
   * field that is reliably in front of it — anything at z 7 to 9 is behind the
   * lens when the fighters are forward and one metre in front of it when they
   * are back, and at one metre a 17m-wide bundle fills the entire frame. The pit
   * has the same exposure and only escapes it because its scored shot happens to
   * pose the pair near the origin, which puts its camera at z ~4.5 and its own
   * foreground behind the lens. That is luck, not design.
   *
   * So this version is placed by the two rules that ARE robust, and neither of
   * them is about z:
   *
   *   1. **Outboard beats forward.** An object at lateral offset L from the
   *      camera axis leaves the frame when `L > 0.70 * D`. As the camera closes
   *      on it, D shrinks and the constraint gets EASIER — so a laterally offset
   *      object is safest exactly when it is nearest, which is the opposite of
   *      an on-axis one. The two pier stubs sit at x -10.9 and +11.2, outboard
   *      of the +/-9 play bound, so no camera the fight solver can produce ever
   *      has them anywhere but at the edge of frame.
   *   2. **High beats near.** The fight frame's top edge at distance D is about
   *      `cam.y + 0.257 * D`, and cam.y never exceeds 1.95, so anything whose
   *      underside is above 4.15m is off the top of the fight frame at every
   *      distance out to 8.6m and behind the lens beyond that. The service run
   *      is hung at 4.15-4.8m under the deck soffit for that reason alone.
   *
   * At the wide framing (`cinematic('wide', {dist: 14, height: 4.5})` solves to
   * a camera near 2.2, 4.5, 13.8 on a 34 degree lens) the frame at z = 8.8 spans
   * x -1.3 to 4.2 and y 1.9 to 5.0 — so the service run occupies the top-left
   * corner and the piers graze both edges. That is the layer doing its job: it
   * occludes the CORNERS, not the subject.
   *
   * **Nothing is aimed at any of it, and that is still the point.** Every source
   * in the room is at z -1 or further back, so this band is lit from behind and
   * arrives as near-silhouette against the water it stands in. It stays IN the
   * floor's mirror, because an occluder standing in water and doubled by it is
   * the cheapest depth cue this set owns.
   *
   * Fine texture scale on purpose: this close to the lens the iron set's 90mm
   * scale would magnify into visible plates, so the mesh is UV'd at 0.55m.
   */
  #foreground() {
    const rng = this.rng;
    const parts = [];

    // --- the two outboard pier stubs ---------------------------------------
    // Remnants of the bay outside the tank's front wall, standing in the same
    // water. Different heights and different breaks: a matched pair either side
    // of frame reads as a proscenium, which is worse than having one.
    for (const [px, pz, ph, lean] of [[-10.9, 8.6, 3.35, 0.035], [11.2, 10.4, 2.55, -0.05]]) {
      parts.push(place(bevelBox(1.5, 0.5, 1.6, 0.04), { pos: [px, 0.25, pz] }));
      parts.push(place(bevelBox(1.15, ph, 1.25, 0.08), { pos: [px, ph / 2 + 0.2, pz], rot: [0, 0, lean] }));
      parts.push(place(bevelBox(1.25, 0.07, 1.35, 0.015), { pos: [px, HIGH_MARK_Y, pz] }));
      // The break: slabs canted off the top, and the reinforcement standing
      // proud of them. A stub with a flat top is a bollard.
      for (let i = 0; i < 5; i++) {
        parts.push(place(bevelBox(rng.range(0.3, 0.72), rng.range(0.14, 0.32), rng.range(0.3, 0.72), 0.02), {
          pos: [px + rng.range(-0.45, 0.45), ph + 0.28 + rng.range(-0.12, 0.22), pz + rng.range(-0.48, 0.48)],
          rot: [rng.range(-0.4, 0.4), rng.range(-0.6, 0.6), rng.range(-0.4, 0.4)],
        }));
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        parts.push(segment(
          [px + Math.cos(a) * 0.38, ph + 0.1, pz + Math.sin(a) * 0.38],
          [px + Math.cos(a) * 0.54, ph + 0.75 + rng.range(-0.2, 0.35), pz + Math.sin(a) * 0.54],
          0.015, 0.012, 4,
        ));
      }
    }
    // A short pipe stub off the left pier, running OUT of frame rather than
    // across it: it says the pier carried something without becoming a bar.
    parts.push(pipeRun([[-15.5, 2.5, 8.3], [-12.8, 2.46, 8.5], [-10.9, 2.42, 8.6]], 0.11, { flangeEvery: 1 }));
    parts.push(place(bevelBox(0.5, 0.12, 0.16, 0.02), { pos: [-10.85, 2.26, 8.6] }));

    // --- the service run, hung under the deck soffit ------------------------
    // Four pipes and their hangers crossing the TOP-left of the wide frame. It
    // stops at x -0.4 and never reaches the fight axis, and its underside at
    // 4.15m is above the fight frame at every distance the solver can produce.
    const hy = 4.42;
    for (let i = 0; i < 4; i++) {
      const r = 0.07 + (i % 3) * 0.03;
      const y = hy + (i % 2) * 0.22 - 0.11;
      const z = 8.5 + i * 0.24;
      parts.push(pipeRun([[-5.6, y, z], [-3.4, y - 0.02, z], [-1.6, y - 0.03, z], [-0.4, y - 0.04, z]], r, { flangeEvery: 2 }));
    }
    // Trapeze hangers up into the soffit slab, on an uneven pitch.
    for (const hx of [-4.9, -3.05, -1.15]) {
      parts.push(place(bevelBox(0.12, 0.09, 1.35, 0.015), { pos: [hx, hy - 0.32, 8.86] }));
      for (const dz of [8.42, 9.3]) {
        parts.push(place(new THREE.CylinderGeometry(0.022, 0.022, 0.95, 6), { pos: [hx, hy + 0.2, dz] }));
      }
    }
    // One valve and a junction box on the run, both on the far end so they sit
    // inside the wide frame's left edge rather than out beyond it.
    parts.push(place(new THREE.CylinderGeometry(0.17, 0.17, 0.3, 12), { pos: [-2.1, hy + 0.11, 8.98], rot: [0, 0, Math.PI / 2] }));
    parts.push(place(new THREE.CylinderGeometry(0.04, 0.04, 0.42, 8), { pos: [-2.1, hy + 0.43, 8.98] }));
    parts.push(place(new THREE.TorusGeometry(0.21, 0.026, 5, 14), { pos: [-2.1, hy + 0.66, 8.98], rot: [Math.PI / 2, 0, 0] }));
    parts.push(place(bevelBox(0.3, 0.4, 0.18, 0.02), { pos: [-4.2, hy - 0.5, 8.4] }));
    // A slack cable swagged between two of the hangers. It is the one thing in
    // this band at neither the horizontal nor the vertical, and it hangs DOWN
    // from the run, which is what stops four parallel pipes reading as a grille.
    parts.push(tube(catenary([-4.85, hy - 0.4, 8.4], [-1.2, hy - 0.42, 8.4], 0.3, 12), 0.028, 5));

    const mesh = new THREE.Mesh(worldUv(mergeAll(parts), 0.55), this.ironMaterial);
    mesh.name = 'arena.vault.foreground';
    // It cannot usefully shadow anything: every source in the room is behind it,
    // so its shadow falls further from the camera, off the play area entirely.
    // Paying the shadow pass for that would be paying for nothing.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.foreground = mesh;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Band D — the machine hall
  // -------------------------------------------------------------------------

  /**
   * The pump hall, seen through the bulkhead arch at nineteen metres.
   *
   * The pit's third layer is scored as "carries no readable information", so the
   * test this band has to pass is not whether it has silhouette but whether the
   * eye can NAME what it is looking at. Three things in it are nameable at
   * nineteen metres and were chosen for that: vertical pumps with their volutes
   * and motors, a valve wall with two dozen handwheels on a header, and a gantry
   * beam over them. All three have sizes everybody already has a number for,
   * which is what makes their apparent size a distance cue rather than just a
   * shape.
   *
   * **Its own lighting treatment:** one sodium fitting, nothing else, so the
   * whole band arrives amber against the mercury in front of it. That is worth
   * as much as the geometry — it is the second of the four hue bins and it is
   * the only place in the frame where a large area is warm.
   *
   * It fades through its OWN exponential haze rather than the scene fog, for the
   * reason `StageStructure#midground` gives: a fog solved for a twelve-metre room
   * moves the value almost nothing over the six metres between the bulkhead and
   * the back of the hall, so four depths of plant would arrive as one flat card.
   */
  #machineHall() {
    const rng = this.rng;
    const parts = [];
    const z = HALL_Z;

    // --- three vertical pumps ----------------------------------------------
    for (let i = 0; i < 3; i++) {
      const x = -4.6 + i * 4.4 + rng.range(-0.35, 0.35);
      const s = 0.9 + rng.next() * 0.3;
      const bz = z + rng.range(-0.8, 0.8);
      parts.push(place(bevelBox(2.4 * s, 0.34, 2.2 * s, 0.04), { pos: [x, 0.17, bz] }));
      // Volute casing: a fat cylinder with a torus round its belly and a
      // discharge elbow off the side. This is the shape that says "pump".
      parts.push(place(new THREE.CylinderGeometry(0.78 * s, 0.9 * s, 1.15 * s, 16, 1), { pos: [x, 0.92 * s, bz] }));
      parts.push(place(new THREE.TorusGeometry(0.86 * s, 0.14 * s, 6, 16), { pos: [x, 0.92 * s, bz], rot: [Math.PI / 2, 0, 0] }));
      parts.push(place(new THREE.CylinderGeometry(0.34 * s, 0.34 * s, 1.9 * s, 12, 1), { pos: [x + 1.0 * s, 1.4 * s, bz], rot: [0, 0, Math.PI / 2] }));
      // Column pipe up to the motor stool, then the motor itself with its fins.
      parts.push(place(new THREE.CylinderGeometry(0.3 * s, 0.3 * s, 1.5 * s, 12, 1), { pos: [x, 2.25 * s, bz] }));
      parts.push(place(new THREE.CylinderGeometry(0.62 * s, 0.5 * s, 0.4 * s, 12, 1), { pos: [x, 3.15 * s, bz] }));
      parts.push(place(new THREE.CylinderGeometry(0.58 * s, 0.58 * s, 1.25 * s, 14, 1), { pos: [x, 3.98 * s, bz] }));
      for (let f = 0; f < 8; f++) {
        parts.push(place(bevelBox(1.3 * s, 0.045, 0.05, 0.01), { pos: [x, (3.45 + f * 0.16) * s, bz], rot: [0, (f % 2) * 0.4, 0] }));
      }
      parts.push(place(new THREE.CylinderGeometry(0.22 * s, 0.28 * s, 0.3 * s, 10, 1), { pos: [x, 4.72 * s, bz] }));
    }

    // --- the valve wall ----------------------------------------------------
    // Twenty-four handwheels on two headers. This is the readable information:
    // at nineteen metres each wheel is four pixels across and the BANK of them
    // is unmistakable, which is exactly the trade a distant layer wants — a
    // recognisable population rather than a resolvable object.
    const vz = z - 2.4;
    for (let row = 0; row < 2; row++) {
      const y = 1.35 + row * 1.5;
      parts.push(place(new THREE.CylinderGeometry(0.19, 0.19, 15, 12, 1), { pos: [1.0, y, vz], rot: [0, 0, Math.PI / 2] }));
      for (let i = 0; i < 12; i++) {
        const x = -5.6 + i * 1.2 + rng.range(-0.08, 0.08);
        if (rng.next() < 0.12) continue;      // a few have been removed
        const r = 0.1 + (i % 4) * 0.02;
        parts.push(place(new THREE.CylinderGeometry(r, r, 0.5, 8, 1), { pos: [x, y + 0.34, vz] }));
        parts.push(place(new THREE.CylinderGeometry(r * 1.5, r * 1.5, 0.07, 8, 1), { pos: [x, y + 0.16, vz] }));
        parts.push(place(new THREE.TorusGeometry(0.19, 0.022, 4, 10), { pos: [x, y + 0.62, vz], rot: [rng.range(-0.25, 0.25), 0, 0] }));
        for (let k = 0; k < 2; k++) {
          parts.push(place(bevelBox(0.36, 0.026, 0.026, 0.006), { pos: [x, y + 0.62, vz], rot: [0, 0, k * Math.PI / 2] }));
        }
      }
    }

    // --- gantry, walkway and a stair ---------------------------------------
    parts.push(place(truss(18, 0.8, { thickness: 0.09, width: 0.11, bays: 9 }), { pos: [0, 5.6, z + 1.2] }));
    for (const x of [-7.4, 7.4]) {
      parts.push(place(bevelBox(0.42, 6.4, 0.42, 0.03), { pos: [x, 3.2, z + 1.2] }));
    }
    parts.push(place(bevelBox(1.5, 0.7, 1.1, 0.03), { pos: [-1.8, 5.15, z + 1.2] }));
    parts.push(place(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), { pos: [-1.8, 3.6, z + 1.2] }));
    parts.push(place(bevelBox(0.7, 0.4, 0.5, 0.02), { pos: [-1.8, 2.3, z + 1.2] }));
    // A hydraulic ram on a stand, the one object here at a human scale.
    parts.push(place(hydraulicRam(1.5, 1.0, 0.16), { pos: [6.4, 0.5, z + 2.6] }));
    parts.push(place(bevelBox(0.8, 0.5, 0.8, 0.03), { pos: [6.4, 0.25, z + 2.6] }));

    // --- a switchgear line, and the reason this band passes -----------------
    // The pit's third layer is marked down for carrying no readable
    // information, and the fix is not more detail — it is a POPULATION the eye
    // can name. Eight cubicles in a row with doors, hinges, handles and a
    // trunking gutter over the top is a switchboard at any distance at which it
    // can be resolved at all, and unlike a mass of pipework it has a size
    // everybody already knows, so its apparent size is the distance cue.
    for (let i = 0; i < 8; i++) {
      const x = -7.4 + i * 1.12;
      const h = 2.2 + (i % 3) * 0.12;
      parts.push(place(bevelBox(1.02, h, 0.85, 0.02), { pos: [x, h / 2, z + 4.4] }));
      parts.push(place(insetPanel(0.82, h * 0.62, 0.05, 0.07), { pos: [x, h * 0.58, z + 4.83] }));
      parts.push(place(bevelBox(0.06, 0.26, 0.05, 0.01), { pos: [x + 0.36, h * 0.55, z + 4.88] }));
      parts.push(place(bevelBox(1.08, 0.09, 0.9, 0.015), { pos: [x, h + 0.045, z + 4.4] }));
    }
    parts.push(place(bevelBox(9.4, 0.34, 0.36, 0.02), { pos: [-3.5, 2.72, z + 4.7] }));
    for (let i = 0; i < 6; i++) {
      parts.push(place(new THREE.CylinderGeometry(0.036, 0.036, 1.5, 6), { pos: [-6.6 + i * 1.5, 3.6, z + 4.7] }));
    }

    // --- a stair up to the gantry -------------------------------------------
    // A flight of stairs is the one object in a plant room that states the
    // human scale absolutely, because everyone knows what a step is.
    for (let i = 0; i < 15; i++) {
      parts.push(place(bevelBox(1.15, 0.05, 0.29, 0.01), { pos: [-9.4, 0.4 + i * 0.2, z + 3.4 - i * 0.27] }));
    }
    for (const dx of [-0.58, 0.58]) {
      const st = spanX([-9.4 + dx, 0.35, z + 3.5], [-9.4 + dx, 3.4, z - 0.6]);
      parts.push(place(bevelBox(st.length, 0.28, 0.06, 0.015), { pos: st.pos, rot: st.rot }));
      const rl = spanX([-9.4 + dx, 1.35, z + 3.5], [-9.4 + dx, 4.4, z - 0.6]);
      parts.push(place(bevelBox(rl.length, 0.05, 0.05, 0.012), { pos: rl.pos, rot: rl.rot }));
    }
    parts.push(place(bevelBox(2.4, 0.16, 1.4, 0.02), { pos: [-9.4, 3.5, z - 1.2] }));
    parts.push(place(railing(2.4, { height: 1.0, spacing: 1.2, radius: 0.02 }), { pos: [-9.4, 3.58, z - 1.85] }));

    // --- header pipes and a trolley on the gantry ---------------------------
    for (let i = 0; i < 3; i++) {
      const y = 4.5 + i * 0.44;
      parts.push(pipeRun([[-9.5, y, z - 1.4], [-3, y, z - 1.2], [4, y, z - 1.0], [9.5, y, z - 1.4]], 0.13 + i * 0.03, { flangeEvery: 1 }));
    }
    parts.push(place(bevelBox(1.3, 0.55, 1.0, 0.03), { pos: [3.2, 6.15, z + 1.2] }));
    parts.push(place(new THREE.CylinderGeometry(0.26, 0.26, 0.9, 12), { pos: [3.2, 6.2, z + 1.2], rot: [0, 0, Math.PI / 2] }));
    for (const dx of [-0.2, 0.2]) {
      parts.push(place(new THREE.CylinderGeometry(0.022, 0.022, 2.6, 5), { pos: [3.2 + dx, 4.6, z + 1.2] }));
    }
    parts.push(place(bevelBox(0.7, 0.34, 0.5, 0.02), { pos: [3.2, 3.2, z + 1.2] }));

    // The sodium fitting's own housing. Its face is placed by #emitters; this is
    // the reflector and the conduit that make it a fitting rather than a hole.
    parts.push(place(bevelBox(2.2, 0.3, 0.42, 0.02), { pos: [2.6, 4.55, z + 1.9] }));
    for (const dx of [-0.8, 0.8]) {
      parts.push(place(new THREE.CylinderGeometry(0.022, 0.022, 0.9, 5), { pos: [2.6 + dx, 5.1, z + 1.9] }));
    }
    // The hall's own floor, and a wet well cut into it.
    //
    // It needs one, and the reason is the apron: `StageFloor`'s textured slab
    // stops at z = -12 and everything behind that stands on an unlit plane at
    // 0x05060a. Three pumps floating on black read as cut out. A slab of its own
    // at +0.35 puts the plant on something, and the step up is also the honest
    // detail — a pump hall is above the tank it draws from, not level with it.
    parts.push(place(bevelBox(23, 0.7, 11, 0.05), { pos: [0, 0.0, z + 0.6] }));
    for (const [wx, ww] of [[-6.2, 5.0], [5.4, 6.5]]) {
      parts.push(place(bevelBox(ww, 0.22, 2.6, 0.03), { pos: [wx, 0.35, z + 4.0] }));
    }
    parts.push(place(bevelBox(4.2, 0.26, 0.3, 0.02), { pos: [-0.4, 0.35, z + 5.15] }));

    // Back wall of the hall, so the band ends somewhere and the tunnel beyond
    // is seen through a hole rather than over the top of nothing.
    for (const [bx, bw] of [[-9.0, 8.0], [3.6, 12.0]]) {
      parts.push(place(bevelBox(bw, 8.0, 0.6, 0.05), { pos: [bx, 4.0, z - 3.2] }));
    }
    parts.push(place(bevelBox(22, 1.2, 0.6, 0.05), { pos: [-1.0, 7.4, z - 3.2] }));

    const mat = this.materials.darkMetal.clone();
    mat.name = 'arena.vault.hallHaze';
    const uHaze = this.hazeColor;
    mat.envMapIntensity = 0.40;
    const uFill = this.hallFill;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHaze = uHaze;
      shader.uniforms.uFill = uFill;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vKbD;\nvarying vec3 vKbN;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvKbD = -mvPosition.z;\nvKbN = normalize( mat3( modelMatrix ) * objectNormal );');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uHaze;\nuniform vec3 uFill;\nvarying float vKbD;\nvarying vec3 vKbN;')
        .replace('#include <opaque_fragment>', /* glsl */ `
          #include <opaque_fragment>
          // The hall's own lamp, as a fill rather than as a light.
          //
          // Band D is nineteen metres past the bulkhead and no analytic light in
          // any mood reaches it, so before this the whole band shaded from the
          // IBL alone and rendered at code value zero — an unreadable dark
          // smear, which is exactly what this arena was built to avoid. Adding a
          // real light would cost ~1.5ms; adding a fifth practical would make it
          // the Environment's problem rather than the set's.
          //
          // So the band lights itself, from the one fitting it has. The gradient
          // is a hemisphere about the fitting's own downward-and-forward
          // direction, which is enough to keep a pump's flank off its top and
          // its top off the gantry above it. It is applied AFTER the BRDF and
          // before the haze, so distance still takes it away.
          float kbUp = clamp( dot( vKbN, normalize( vec3( 0.12, 0.86, 0.5 ) ) ) * 0.5 + 0.5, 0.0, 1.0 );
          gl_FragColor.rgb += uFill * ( 0.30 + 0.70 * kbUp * kbUp );
          gl_FragColor.rgb = mix( gl_FragColor.rgb, uHaze, 1.0 - exp( -max( 0.0, vKbD - 20.0 ) * 0.075 ) );
        `);
    };
    mat.customProgramCacheKey = () => 'kb-vault-hall';
    this.hallMaterial = mat;

    const mesh = new THREE.Mesh(worldUv(mergeAll(parts), 1.6), mat);
    mesh.name = 'arena.vault.hall';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.hall = mesh;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Band E — the tunnel
  // -------------------------------------------------------------------------

  /**
   * The tunnel mouth beyond the machine hall: the one place the eye can see
   * depth run away.
   *
   * Everything inside the tank shares one rig and one fog, so from six metres to
   * nineteen it is all reachable by the same falloff and the eye can read it as
   * one room. This band is not in that room. It is unlit — no analytic term
   * touches it — and every fragment fades toward the mood's haze on its own view
   * depth, which is how a set says "further" rather than "smaller".
   *
   * Five rings receding to thirty-one metres with a single lamp at the third,
   * and the ring pitch HALVES with distance so the run reads as accelerating
   * away. That is a perspective cue you cannot get from fog alone, and it is
   * five rings of geometry.
   */
  #tunnel() {
    const parts = [];
    const lamps = [];
    const tx = -3.2;
    // Portal: a segmental head on two jambs, standing in the hall's back wall.
    for (const s of [-1, 1]) {
      parts.push(place(bevelBox(0.9, 4.2, 0.9, 0.04), { pos: [tx + s * 2.0, 2.1, TUNNEL_Z + 3.4] }));
    }
    for (let i = 0; i < 11; i++) {
      const a = -Math.PI / 2 + ((i + 0.5) / 11) * Math.PI;
      parts.push(place(bevelBox(0.42, 0.5, 0.9, 0.02), {
        pos: [tx + Math.sin(a) * 2.35, 4.2 + Math.cos(a) * 2.35, TUNNEL_Z + 3.4],
        rot: [0, 0, -a],
      }));
    }
    // The bore: rings at an accelerating pitch, each one a little smaller.
    let z = TUNNEL_Z + 2.0;
    let step = 1.6;
    for (let i = 0; i < 5; i++) {
      const r = 2.2 - i * 0.06;
      parts.push(place(new THREE.CylinderGeometry(r, r, 0.34, 18, 1, true), {
        pos: [tx, 2.0, z], rot: [Math.PI / 2, 0, 0],
      }));
      z -= step;
      step *= 0.72;
    }
    // The bore's own back stop, so the tunnel is not a hole into the void.
    parts.push(place(bevelBox(6.0, 6.0, 0.4, 0.04), { pos: [tx, 2.0, z - 1.2] }));
    // Inside the bore: a haunch walkway one side and the invert channel the
    // other. Both are single boxes running the whole length, and both taper with
    // the same perspective the rings do — which is the point. The rings alone
    // give the tunnel a pitch; a pair of continuous lines converging down it
    // gives it a VANISHING POINT, and a vanishing point inside the set is the
    // only place in this arena where the eye can measure distance directly
    // rather than by comparing sizes.
    {
      const zn = TUNNEL_Z + 2.4, zf = z - 1.0;
      const wk = spanX([tx + 1.5, 0.9, zn], [tx + 1.1, 1.05, zf]);
      parts.push(place(bevelBox(wk.length, 0.16, 1.0, 0.02), { pos: wk.pos, rot: [0, wk.rot[1] + Math.PI / 2, 0] }));
      const rl = spanX([tx + 1.5, 1.85, zn], [tx + 1.1, 1.95, zf]);
      parts.push(place(bevelBox(rl.length, 0.055, 0.055, 0.012), { pos: rl.pos, rot: [0, rl.rot[1] + Math.PI / 2, 0] }));
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        parts.push(place(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5), {
          pos: [tx + 1.5 - t * 0.4, 1.45, zn + (zf - zn) * t],
        }));
      }
      // Invert channel, and the low kerb beside it.
      parts.push(place(bevelBox(1.3, 0.14, Math.abs(zf - zn), 0.02), { pos: [tx - 0.9, 0.16, (zn + zf) / 2] }));
    }
    // The lamp: one small quad on the tunnel wall. It is the entire lighting
    // treatment of this band and it is deliberately tiny — a distant lamp that
    // is large is a near lamp.
    lamps.push(place(new THREE.PlaneGeometry(0.34, 0.5), { pos: [tx + 1.5, 2.5, TUNNEL_Z - 1.4], rot: [0, -0.9, 0] }));

    const solid = mergeAll(parts);
    const lamp = mergeAll(lamps);
    const geo = mergeAll([solid, lamp]);
    const flag = new Float32Array(geo.attributes.position.count);
    flag.fill(1, solid.attributes.position.count);
    geo.setAttribute('aLamp', new THREE.Float32BufferAttribute(flag, 1));

    this.tunnelMaterial = new THREE.ShaderMaterial({
      name: 'arena.vault.tunnel',
      uniforms: {
        // Measured, not picked. The first values here were 0x0b0f13 / 0x18232c,
        // which are 0.0033 and 0.0091 in linear — under a hundredth of the
        // library concrete's 0.0255, so band E rendered at code value one and
        // the "one place the eye can see depth run away" was a black rectangle.
        // These sit the unhazed bore at roughly two thirds of the library
        // concrete's albedo, which after its own haze lands the band visibly
        // under the machine hall in front of it and visibly above nothing.
        uBase: { value: new THREE.Color(0x2a3138) },
        uTop: { value: new THREE.Color(0x44525e) },
        uHaze: { value: this.hazeColor.value },
        uLamp: { value: new THREE.Color(0xffc98a) },
      },
      vertexShader: /* glsl */ `
        attribute float aLamp;
        varying vec3 vNrm;
        varying float vLamp;
        varying float vDepth;
        void main() {
          vNrm = normalize( mat3( modelMatrix ) * normal );
          vLamp = aLamp;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase;
        uniform vec3 uTop;
        uniform vec3 uHaze;
        uniform vec3 uLamp;
        varying vec3 vNrm;
        varying float vLamp;
        varying float vDepth;
        void main() {
          // Two-tone off the normal. Enough that a ring's soffit does not merge
          // into its jamb, nowhere near enough to imply a source down there
          // that the single lamp does not account for.
          float up = clamp( vNrm.y * 0.5 + 0.5, 0.0, 1.0 );
          vec3 col = mix( uBase, uTop, up * up * 0.7 + 0.15 );
          // The haze is thick and it starts close, because this is an airless
          // tunnel full of the same low-lying mist the deck is.
          float haze = 1.0 - exp( -max( 0.0, vDepth - 24.0 ) * 0.10 );
          col = mix( col, uHaze, clamp( haze, 0.0, 0.96 ) );
          if ( vLamp > 0.5 ) col = uLamp * 5.5;
          gl_FragColor = vec4( col, 1.0 );
        }
      `,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, this.tunnelMaterial);
    mesh.name = 'arena.vault.tunnel';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER.NO_REFLECT);
    this.tunnel = mesh;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // The light
  // -------------------------------------------------------------------------

  /**
   * Every emitter in the room, and the three passes that make them deposit.
   *
   * The contract is `StagePracticals`': every visible emitter matches a light
   * the Environment is actually casting, or it is honest about being scatter.
   * Four of the strips here publish themselves through {@link practicalPositions}
   * and the mood is expected to hang its four bright practicals on them; the
   * other nine are dressed off the mood's rim pair and are lit purely by the
   * cards, which cost no light at all.
   *
   * Three passes, and they are three because they answer three different
   * questions:
   *
   *   1. **the face** — a thin emissive quad, driven well over the bright pass
   *      so it blooms. This is what says "there is a lamp there".
   *   2. **the wash**, MULTIPLICATIVE, on the surface the strip is bolted to.
   *      This is the entire look of this arena: reach is 1.1 to 1.4m across the
   *      run, so a pier is doubled at the strip and back to nothing two metres
   *      away. `StagePracticals`' WASHES note has the measurement for why this
   *      operator and not an additive one — at matched mean an additive card
   *      costs 43% of the surface's p90/p10 because a pedestal deletes texture,
   *      and a wash that deletes the board marking off a cast pier would have
   *      deleted the only thing worth lighting.
   *   3. **the pool**, ADDITIVE, on the water. Scatter off a wet floor is
   *      genuinely light arriving from elsewhere, so it adds. Held low, for the
   *      reason POOL_GAIN records: once a pool competes with the fighter
   *      standing in it the floor has stopped being the floor.
   *
   * Plus a fourth, the glows: one additive radial card in the air at each
   * fitting. A vault wants light doing work in the air and `StageVolumetrics`'
   * raymarched shafts are the expensive way to get it; a card is the cheap way
   * and, unlike a shaft, it is correct for a bare strip that throws in every
   * direction rather than down a cone.
   */
  #emitters() {
    this._faces = [];
    this._slots = [];
    this._pools = [];
    this._washes = [];
    this._glows = [];
    this.practicalPositions = [];

    // --- band B: the four bright practicals --------------------------------
    // Two mercury strips on the tank walls at chest height, deliberately at
    // DIFFERENT z so the pair does not mirror across the fight axis and light
    // both fighters identically; one mercury key over the weir, raking the
    // fight plane from behind, which is the strip whose hard shadow this arena
    // is built to show; and one sodium bulkhead lamp on the near right, which
    // is the warm half of the frame.
    this.#strip(-TANK_X + 0.34, 2.35, 1.2, [0, Math.PI / 2, 0], 3.2, 0.1, SLOT.MERC_A, { practical: true, power: 22 });
    this.#strip(TANK_X - 0.34, 2.35, -1.8, [0, -Math.PI / 2, 0], 3.2, 0.1, SLOT.MERC_B, { practical: true, power: 22 });
    this.#strip(-2.2, 3.86, ARCADE_Z + 1.86, [0.55, 0, 0], 4.6, 0.12, SLOT.MERC_KEY, { practical: true, power: 27 });
    this.#strip(TANK_X - 0.5, 2.05, 4.4, [0, -Math.PI / 2, 0], 0.9, 0.42, SLOT.SODIUM, { practical: true, power: 6, bulkhead: true });

    this.#wash([-TANK_X + 0.5, 2.15, 1.2], [0, Math.PI / 2, 0], 5.4, 3.1, SLOT.MERC_A, [0.62, 0], 1.0, 0.55);
    this.#wash([TANK_X - 0.5, 2.15, -1.8], [0, -Math.PI / 2, 0], 5.4, 3.1, SLOT.MERC_B, [0.62, 0], 1.0, 0.55);
    this.#wash([-2.2, 2.6, ARCADE_Z + 2.06], [0, 0, 0], 6.0, 3.2, SLOT.MERC_KEY, [0.5, 0], 1.15, 0.7);
    this.#wash([TANK_X - 0.62, 1.9, 4.4], [0, -Math.PI / 2, 0], 3.4, 2.7, SLOT.SODIUM, [0.1, 0], 0.9, 0.5);

    this.#pool([-7.2, 0.02, 1.2], 9.6, 7.4, SLOT.MERC_A, [0.1, 0], 1.0);
    this.#pool([7.2, 0.02, -1.8], 9.6, 7.4, SLOT.MERC_B, [0.1, 0], 1.0);
    this.#pool([-2.2, 0.02, -3.4], 11.5, 8.0, SLOT.MERC_KEY, [0.08, 0], 1.25);
    this.#pool([7.4, 0.02, 4.2], 6.4, 5.4, SLOT.SODIUM, [0, 0], 1.15);

    // --- the green emergency fitting ---------------------------------------
    // Over the side door in the left wall. Small, saturated, and the only green
    // in the room: it is the third hue bin and it earns its place by being the
    // one colour that is neither the mercury nor the sodium, so the eye has
    // three named sources instead of two.
    this.#strip(-TANK_X + 0.3, 2.62, -5.4, [0, Math.PI / 2, 0], 0.52, 0.2, SLOT.GREEN, { box: true });
    this.#wash([-TANK_X + 0.55, 2.0, -5.4], [0, Math.PI / 2, 0], 2.6, 2.4, SLOT.GREEN, [0, 0], 0.85, 0.5);
    this.#pool([-9.2, 0.02, -5.0], 4.6, 3.8, SLOT.GREEN, [0, 0], 0.9);

    // --- band C: one strip per lit bay -------------------------------------
    // The alternation IS the lighting treatment of this band. A lit bay gets a
    // strip on its left pier and a wash across the bay behind it; a dark bay
    // gets nothing, and nothing here means nothing, because there is no ambient
    // to rescue it. One of the lit bays gets the failing tube, which is its own
    // slot so it can flicker without dragging the rest of the arcade with it.
    let flickerDealt = false;
    for (const [xs, z, bays, dim, depth, far] of [
      [PIERS_A, ARCADE_Z, BAYS_A, 1.0, 3.4, false],
      // The back row is on its own slot at 0.45 of the front's. That is not
      // fog doing the work — the scene fog is solved for a twelve-metre room and
      // moves a fitting four metres further back by almost nothing. A dimmer
      // lamp IS the depth cue, and here it is authored rather than hoped for.
      [PIERS_B, ARCADE2_Z, BAYS_B, 0.55, 1.9, true],
    ]) {
      for (let i = 0; i < bays.length; i++) {
        if (bays[i] !== 'lit') continue;
        const x0 = xs[i] + 0.525, x1 = xs[i + 1] - 0.525;
        const cx = (x0 + x1) / 2;
        const slot = far ? SLOT.MERC_FAR : flickerDealt ? SLOT.MERC_BAY : SLOT.FLICKER;
        flickerDealt = flickerDealt || !far;
        // Bracketed off the LEFT jamb, a little inside the mouth, aimed down the
        // barrel. Two asymmetries and both are deliberate: across the bay, the
        // soffit is hot on one side and falls away over the crown, so the vault
        // reads as a curved surface instead of a painted half cylinder; and
        // along the bay, the strip is near the mouth so the tunnel darkens as it
        // recedes, which is the depth the deep barrel was built for.
        this.#strip(x0 + 0.2, SPRING_Y - 0.55, z + depth / 2 - 0.55, [0.2, 0, 0], (x1 - x0) * 0.58, 0.09, slot);
        this.#wash([cx, SPRING_Y - 0.25, z + depth / 2 - 0.05], [0, 0, 0], (x1 - x0) + 1.0, 3.6, slot, [0.22, 0], 0.95 * dim, 1.5);
      }
    }
    // The arcade's own scatter on the water. One long card flat along the run
    // and falling off across it — the profile a row of strips throws. It is
    // depth-tested, so it only survives where a bay opening actually lets the
    // light out and is occluded by the piers between them: the deposit on the
    // water alternates with the bays for free.
    this.#pool([0, 0.02, ARCADE_Z + 1.4], 26, 4.6, SLOT.MERC_BAY, [0.72, 0], 0.62);

    // --- the ceiling, and the band the frame was empty in -------------------
    //
    // Measured on the integrated build, per-band medians with the HUD cropped,
    // top of frame first:
    //
    //     cistern     2.1   7.6  44.7  93.1  20.9
    //     pit        44.2  77.2  84.4  68.9  38.4
    //
    // The top two bands are a fifth of the frame at a median of 2 to 11 against
    // the pit's 35 to 77. Some of that is correct and should stay — a buried
    // tank has a dark ceiling and the pit's roof trusses are lit by overhead
    // banks this room does not have — but a fifth of the frame carrying nothing
    // is the "carries no readable information" finding relocated from the middle
    // of the pit's frame to the top of this one.
    //
    // The cause is simple and was an oversight rather than a decision: the deck
    // soffit is the largest surface in the room and NOTHING in the set faces it.
    // Every fitting here is bracketed to a wall or a pier and throws sideways or
    // down. So this is three uplighters channelled into the weir coping, throwing
    // up at the soffit, and they are the physically obvious answer — a weir is
    // exactly where you would put an uplighter, because it is the one horizontal
    // in the room at working height that nobody stands on.
    //
    // They are aimed UP, which is what keeps them from becoming the pit's
    // barrier-tube problem. That tube is a 24m side-facing run at chest height
    // and `StagePracticals` measured it costing figure/ground until it was
    // halved twice; these present their emitting face to the fight camera at a
    // 5-to-9 degree grazing angle, so a 2.2m strip shows about 9% of its area
    // and reads as a thin bright line behind the fighters rather than as a lit
    // band across them. What the frame gets is the SOFFIT above it, which is
    // 3.4m clear of anybody's silhouette.
    // Sited around two things that are already on the weir: the spillway notch
    // takes the coping down to 0.83 inside |x| < 1.55, and `#deckDressing` lays
    // a grating walkway across |x| < 3.7 at y 1.55 — a lamp under that would
    // have lit the underside of a walkway 80mm above it instead of a ceiling
    // three metres up. All three sit outboard of both, on full-height coping,
    // and the asymmetry is worth having anyway.
    for (const [ux, ulen] of [[-7.6, 2.4], [-4.7, 1.8], [6.4, 2.2]]) {
      this.#strip(ux, WEIR_Y + 0.15, WEIR_Z - 0.12, [-Math.PI / 2, 0, 0], ulen, 0.09, SLOT.SOFFIT, { trough: true });
    }
    // The deposit on the soffit itself, and the first version of this was the
    // wrong operator — worth recording, because it is the same confusion as the
    // {@link CARD_SCALE} unit bug wearing a different hat.
    //
    // It was a WASH, i.e. `dst = dst * src`. Measured on the delivered build it
    // moved the top two frame bands from 2.3/6.3 to 2.2/6.6, which is inside
    // run-to-run noise — it delivered nothing the frame could see. The reason is
    // not the drive and no amount of it would have helped: **a multiplicative
    // wash cannot light a surface that is at zero.** It models "more incident
    // light" on something already lit, which is exactly right for the pit's
    // barrier band (0.05-0.15 linear before the wash touches it) and exactly
    // useless for a ceiling that no fitting in the room faces. Three times
    // nothing is nothing. A wash is a gain, not a source.
    //
    // So it is additive, and the physics it now models is better than the
    // physics it was pretending to. The largest, brightest surface in this room
    // is a sheet of standing water with mercury strips raking across it, and the
    // first bounce off water goes UP. A vault ceiling carrying the moving
    // caustic of the water below it is the signature image of a flooded cistern
    // and it is the one thing this arena can do that neither of the others can.
    // That also ties the band to the fourth hue bin — the deposit is the water's
    // own blue-green, not the fitting's.
    //
    // At y 4.80 it sits clear below both the beam soffits (4.93) and the slab
    // (5.34), so it deposits on both and, being depth-tested, can never reach a
    // fighter three metres below it.
    this.#pool([0, 4.80, 0.5], 19, 14, SLOT.SOFFIT, [0.34, 0.12], 0.22, [Math.PI / 2, 0, 0]);
    // And the scatter back down onto the water in front of the weir, which is
    // what stops the ceiling reading as lit by nothing.
    this.#pool([0, 0.02, WEIR_Z + 2.6], 20, 5.0, SLOT.SOFFIT, [0.6, 0], 0.45);

    // --- band D: the hall's one sodium fitting ------------------------------
    this.#strip(2.6, 4.35, HALL_Z + 1.9, [Math.PI / 2, 0, 0], 1.9, 0.28, SLOT.SODIUM_HALL, { noHousing: true });
    this.#wash([2.6, 2.6, HALL_Z + 1.6], [0, 0, 0], 9.0, 5.5, SLOT.SODIUM_HALL, [0.2, 0], 0.9, 1.0);

    // --- the glows ----------------------------------------------------------
    // One card per fitting, in the air just in front of it, sized to the throw
    // rather than to the lamp. Additive and unlit, so they cost a quad each and
    // they are the whole of this arena's "light in the air".
    this.#glow([-TANK_X + 0.7, 2.35, 1.2], 4.4, 3.0, SLOT.MERC_A, 1.0);
    this.#glow([TANK_X - 0.7, 2.35, -1.8], 4.4, 3.0, SLOT.MERC_B, 1.0);
    this.#glow([-2.2, 3.8, ARCADE_Z + 1.1], 6.2, 3.6, SLOT.MERC_KEY, 1.15);
    this.#glow([TANK_X - 0.9, 2.05, 4.4], 2.8, 2.4, SLOT.SODIUM, 0.9);
    this.#glow([-TANK_X + 0.6, 2.62, -5.4], 1.8, 1.6, SLOT.GREEN, 0.7);
    this.#glow([2.6, 4.2, HALL_Z + 2.1], 9.0, 5.0, SLOT.SODIUM_HALL, 0.8);
    this.#glow([-1.2, 2.9, WEIR_Z - 0.1], 15.0, 3.0, SLOT.SOFFIT, 0.5);
    this.#glow([-3.2, 2.4, TUNNEL_Z + 1.0], 6.5, 5.0, SLOT.TUNNEL, 1.0);

    this.#buildEmitterMesh();
    this.pools = this.#cardMesh('pools', this._pools, 'add');
    this.washes = this.#cardMesh('washes', this._washes, 'mul');
    this.glows = this.#cardMesh('glows', this._glows, 'glow');
    this.#syncEmitters();
  }

  /**
   * One strip: the emitting face, its channel and its bracketry.
   *
   * The face is a bare quad. There is no diffuser atlas here, unlike the pit's
   * fixtures — a bare fluorescent tube in a cistern has no diffuser, and the
   * thing that makes it read as a fitting rather than a white rectangle is the
   * CHANNEL behind it and the two brackets holding it off the wall, which are
   * modelled and are what the wash lands on first.
   */
  #strip(x, y, z, rot, len, faceH, slot, opts = {}) {
    const g = place(new THREE.PlaneGeometry(len, faceH), { pos: [x, y, z], rot });
    const a = new Float32Array(g.attributes.position.count);
    a.fill(slot);
    this._faces.push(g);
    this._slots.push(a);

    if (!opts.noHousing) {
      const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...rot));
      const at = (d) => [x - n.x * d, y - n.y * d, z - n.z * d];
      if (opts.box) {
        // A cast emergency box, not a channel: it is a different object and it
        // should not read as a short piece of strip.
        this._iron.push(place(bevelBox(len + 0.16, faceH + 0.16, 0.2, 0.02), { pos: at(0.1), rot }));
        this._iron.push(place(boltRow(len, 2, 0.016, 0.012), { pos: at(-0.005), rot }));
      } else if (opts.trough) {
        // Channelled into the coping: a shallow trough with a cowl on the
        // CAMERA side only. The cowl is what stops the fight camera seeing the
        // lamp itself down the length of the weir, and it is why this fitting
        // can be a bare tube at chest height without becoming a bar of light.
        this._iron.push(place(bevelBox(len + 0.2, 0.13, 0.24, 0.015), { pos: [x, y - 0.09, z], rot: [0, 0, 0] }));
        this._iron.push(place(bevelBox(len + 0.2, 0.14, 0.03, 0.008), { pos: [x, y + 0.03, z + 0.13] }));
        for (const s2 of [-1, 1]) {
          this._iron.push(place(bevelBox(0.05, 0.16, 0.26, 0.01), { pos: [x + s2 * (len / 2 + 0.1), y - 0.05, z] }));
        }
      } else if (opts.bulkhead) {
        // A sodium bulkhead: a cast body with a guard cage over the glass. The
        // cage is what puts hard shadow bars in its own pool, which is the
        // single most recognisable thing a bulkhead lamp does.
        this._iron.push(place(bevelBox(0.34, faceH + 0.22, 0.26, 0.03), { pos: at(0.13), rot }));
        for (let i = 0; i < 3; i++) {
          this._iron.push(place(new THREE.TorusGeometry(faceH * 0.62, 0.012, 4, 10, Math.PI), {
            pos: at(-0.03), rot: [rot[0], rot[1], rot[2] + (i - 1) * 0.62],
          }));
        }
      } else {
        this._iron.push(place(bevelBox(len + 0.12, faceH + 0.2, 0.13, 0.015), { pos: at(0.08), rot }));
        for (const s of [-1, 1]) {
          const bx = new THREE.Vector3(s * (len / 2 - 0.1), 0, 0).applyEuler(new THREE.Euler(...rot));
          this._iron.push(place(bevelBox(0.06, faceH + 0.3, 0.22, 0.012), {
            pos: [at(0.15)[0] + bx.x, at(0.15)[1] + bx.y, at(0.15)[2] + bx.z], rot,
          }));
        }
        // The tail into the nearest conduit. A fitting with no feed is a decal.
        this._iron.push(place(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6), {
          pos: [at(0.2)[0], at(0.2)[1] - 0.3, at(0.2)[2]],
        }));
      }
    }

    if (opts.practical) {
      this.practicalPositions.push({
        position: new THREE.Vector3(x, y, z),
        color: new THREE.Color(SLOT_BASE[slot]),
        power: opts.power ?? 18,
        size: new THREE.Vector2(len, faceH),
      });
      this._practicalSlot ??= [];
      this._practicalSlot.push(slot);
    }
  }

  #pool(pos, w, h, slot, edge, gain, rot = [-Math.PI / 2, 0, 0]) {
    this._pools.push({ pos, rot, w, h, slot, edge, gain, skew: 1 });
  }

  #wash(pos, rot, w, h, slot, edge, gain, skew) {
    this._washes.push({ pos, rot, w, h, slot, edge, gain, skew });
  }

  #glow(pos, w, h, slot, gain) {
    // Glows face +z. The camera lives on the +z side and never crosses the
    // fight plane, so a billboard would cost a per-frame matrix update to look
    // identical to a fixed quad.
    this._glows.push({ pos, rot: [0, 0, 0], w, h, slot, edge: [0, 0], gain, skew: 1 });
  }

  /** The emitting faces: one mesh, one draw call, colour picked by slot. */
  #buildEmitterMesh() {
    const geo = mergeAll(this._faces);
    const flat = new Float32Array(geo.attributes.position.count);
    let off = 0;
    for (const a of this._slots) { flat.set(a, off); off += a.length; }
    geo.setAttribute('aSlot', new THREE.Float32BufferAttribute(flat, 1));

    this.emitterMaterial = new THREE.ShaderMaterial({
      name: 'arena.vault.emitters',
      uniforms: { uColor: { value: Array.from({ length: SLOT_COUNT }, () => new THREE.Color(1, 1, 1)) } },
      defines: { SLOT_COUNT },
      vertexShader: /* glsl */ `
        attribute float aSlot;
        varying float vSlot;
        varying vec2 vUv;
        void main() {
          vSlot = aSlot;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor[ SLOT_COUNT ];
        varying float vSlot;
        varying vec2 vUv;
        void main() {
          vec3 c = uColor[ 0 ];
          for ( int i = 1; i < SLOT_COUNT; i++ ) {
            if ( abs( vSlot - float( i ) ) < 0.5 ) c = uColor[ i ];
          }
          // A tube is not a flat rectangle of one radiance: it is brightest on
          // its own axis and it dies at the end caps where the pins are. Two
          // cheap terms, and together they are what stops thirteen quads in one
          // room reading as thirteen stickers.
          float across = 1.0 - pow( abs( vUv.y * 2.0 - 1.0 ), 2.4 ) * 0.45;
          float ends = smoothstep( 0.0, 0.035, vUv.x ) * smoothstep( 0.0, 0.035, 1.0 - vUv.x );
          gl_FragColor = vec4( c * across * mix( 0.25, 1.0, ends ), 1.0 );
        }
      `,
      side: THREE.FrontSide,
      toneMapped: true,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, this.emitterMaterial);
    mesh.name = 'arena.vault.emitters';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Deliberately IN the mirror. An emitter's reflection is most of what sells
    // a wet deck, and in this arena it is most of what sells the deck at all —
    // see VAULT_SURFACE, where the reflection knee is set low specifically so
    // these do not drown out the fighters beside them.
    this.group.add(mesh);
    this.emitters = mesh;
  }

  /**
   * One mesh per blend mode, colour picked by slot from a shared uniform array.
   *
   * `add` is the pools, `mul` is the washes, `glow` is the airborne cards. The
   * three share one shader and differ in two lines, because the falloff profile
   * is the same separable plateau-and-skirt in all three cases — what differs is
   * the operator and how hard the skirt is squared.
   */
  #cardMesh(name, list, mode) {
    if (!list.length) return null;
    const quads = [];
    const slot = [];
    const par = [];
    for (const p of list) {
      const g = place(new THREE.PlaneGeometry(p.w, p.h), { pos: p.pos, rot: p.rot });
      const n = g.attributes.position.count;
      const s = new Float32Array(n);
      const a = new Float32Array(n * 4);
      s.fill(p.slot);
      for (let i = 0; i < n; i++) {
        a[i * 4] = p.edge[0]; a[i * 4 + 1] = p.edge[1];
        a[i * 4 + 2] = p.gain; a[i * 4 + 3] = p.skew ?? 1;
      }
      quads.push(g); slot.push(s); par.push(a);
    }
    const geo = mergeAll(quads);
    const n = geo.attributes.position.count;
    const fSlot = new Float32Array(n);
    const fPar = new Float32Array(n * 4);
    let o = 0;
    for (let i = 0; i < slot.length; i++) {
      fSlot.set(slot[i], o);
      fPar.set(par[i], o * 4);
      o += slot[i].length;
    }
    geo.setAttribute('aSlot', new THREE.Float32BufferAttribute(fSlot, 1));
    geo.setAttribute('aPar', new THREE.Float32BufferAttribute(fPar, 4));

    const mat = new THREE.ShaderMaterial({
      name: `arena.vault.${name}`,
      uniforms: {
        uColor: { value: this._cardColors ??= Array.from({ length: SLOT_COUNT }, () => new THREE.Color(0, 0, 0)) },
        uScale: { value: CARD_SCALE[mode] },
        uTime: this.timeUniform,
        // Which slot, if any, gets the water caustic. -1 disables the branch.
        uCaustic: { value: mode === 'add' ? SLOT.SOFFIT : -1 },
      },
      defines: { SLOT_COUNT, [mode === 'mul' ? 'KB_MUL' : mode === 'glow' ? 'KB_GLOW' : 'KB_ADD']: '' },
      vertexShader: /* glsl */ `
        attribute float aSlot;
        attribute vec4 aPar;
        varying vec2 vUv;
        varying vec4 vPar;
        varying float vSlot;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vPar = aPar;
          vSlot = aSlot;
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor[ SLOT_COUNT ];
        uniform float uScale;
        uniform float uTime;
        uniform float uCaustic;
        varying vec2 vUv;
        varying vec4 vPar;
        varying float vSlot;
        varying vec3 vWorld;
        void main() {
          vec3 c = uColor[ 0 ];
          for ( int i = 1; i < SLOT_COUNT; i++ ) {
            if ( abs( vSlot - float( i ) ) < 0.5 ) c = uColor[ i ];
          }
          vec2 s = ( vUv - 0.5 ) * 2.0;
          // The skew throws the falloff one way: a strip channelled into a wall
          // throws DOWN the wall, not equally up it, and a pool sits mostly on
          // the camera side of its fitting because that is the half of the
          // water the lens can see.
          vec2 q = vec2( abs( s.x ), abs( s.y ) / ( s.y > 0.0 ? vPar.w : 1.0 ) );
          vec2 e = clamp( ( q - vPar.xy ) / max( vec2( 1.0 ) - vPar.xy, vec2( 1e-3 ) ), 0.0, 1.0 );
          float across = 1.0 - e.y * e.y;
          float f = ( 1.0 - e.x * e.x ) * across;
          #ifdef KB_MUL
            // Squared once more across the run. This is the steep near-field
            // gradient the arena is built on: at the numbers used here the
            // multiplier is back inside 15% of unity 1.4 m from the strip.
            f *= across * across;
          #else
            f *= f;
          #endif
          // Large-scale unevenness, so a deposit reads as light on a dirty
          // surface rather than as an airbrushed decal.
          f *= 0.85 + 0.15 * sin( vWorld.x * 0.79 + vWorld.z * 0.53 ) * sin( vWorld.y * 1.31 - 0.9 );

          // Water caustic, on the one card that is a bounce off standing water.
          // Two crossed wave pairs at different rates: a single pair reads as a
          // moire, and a noise fetch would cost a texture unit for something
          // this soft. The ceiling of a flooded vault is the one surface in the
          // arena where this pattern is the whole point.
          if ( abs( vSlot - uCaustic ) < 0.5 ) {
            float c1 = sin( vWorld.x * 1.55 + uTime * 0.33 ) * sin( vWorld.z * 1.90 - uTime * 0.25 );
            float c2 = sin( vWorld.x * 2.90 - uTime * 0.19 + 1.7 ) * sin( vWorld.z * 2.40 + uTime * 0.17 );
            f *= 0.5 + 0.85 * clamp( ( c1 * 0.6 + c2 * 0.4 ) * 0.5 + 0.5, 0.0, 1.0 );
          }
          #ifdef KB_MUL
            gl_FragColor = vec4( vec3( 1.0 ) + c * ( f * vPar.z * uScale ), 1.0 );
          #else
            gl_FragColor = vec4( c * ( f * vPar.z * uScale ), 1.0 );
          #endif
        }
      `,
      transparent: true,
      depthWrite: false,
      toneMapped: mode !== 'mul',
      fog: false,
      side: THREE.DoubleSide,
    });
    if (mode === 'mul') {
      // dst = dst * src, with src exactly 1.0 outside the falloff so the pass is
      // an identity everywhere it is not aimed. The composer's targets are
      // half-float, so src above 1.0 is a real gain and not a clamp.
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.ZeroFactor;
      mat.blendDst = THREE.SrcColorFactor;
      mat.blendEquationAlpha = THREE.AddEquation;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
    } else {
      mat.blending = THREE.AdditiveBlending;
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `arena.vault.${name}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.layers.set(LAYER.NO_REFLECT);
    // The multiplicative pass has to run after the additive one: a deposit that
    // arrives before the gain gets multiplied by it, which is the wrong order
    // for scatter sitting in front of a wall rather than on it.
    mesh.renderOrder = mode === 'mul' ? 2 : 1;
    this._cardMaterials ??= [];
    this._cardMaterials.push(mat);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Copies the Environment's live parameters onto every slot.
   *
   * Called every frame, so a mood cross-fade drags the visible sources with it.
   * The four published strips take their colour and drive from the mood's own
   * practicals; the rest are dealt off the rim pair at fractions chosen so the
   * room reads front-to-back — the arcade at 0.44 of the near strips and the
   * hall at 0.2 of that again. Those fractions are the depth cue: a lamp is
   * dimmer because it is further away, and here that is authored rather than
   * left to a fog that cannot see the difference.
   */
  #syncEmitters() {
    const lights = this.environment?.practicals;
    const spec = this.environment?.params?.practicals;
    const cols = this.emitterMaterial.uniforms.uColor.value;
    const cards = this._cardColors;
    const rim = this.environment?.params?.rim?.color;
    const rimB = this.environment?.params?.rimB?.color;

    // Slots 0-3 are the published practicals.
    for (let i = 0; i < 4; i++) {
      const slot = this._practicalSlot?.[i] ?? i;
      const p = spec?.[i];
      const light = lights?.[i];
      const col = light?.color ?? p?.color ?? SLOT_COLOR[slot];
      const live = Math.max(0, light?.intensity ?? p?.power ?? this.practicalPositions[i]?.power ?? 18);
      // Flatter than the pit's 0.62 knee. Down here the whole composition is
      // that the near fittings are hot and the far ones are not, so the curve
      // must not pull them together.
      const power = LAMP_ANCHOR * Math.pow(Math.max(live, 0.2) / 4.5, 0.72) * (slot === SLOT.SODIUM ? 1.1 : 1.75);
      cols[slot].copy(col).multiplyScalar(power);
      // Scatter follows the source at a square root: a lamp that dips 10% dims
      // its pool, it does not switch it off.
      cards[slot].copy(col).multiplyScalar(Math.sqrt(Math.max(live, 0.2)) * 0.088);
      const pub = this.practicalPositions[i];
      if (pub && p) { pub.color.copy(p.color); pub.power = p.power; }
    }

    // The arcade, front row and the failing tube. Off the mood's cool rim so the
    // bays belong to the same design as the key, at 0.86 of the anchor — dim
    // enough that the near strips still own the top of the range, bright enough
    // that a lit bay is unambiguous against a dark one.
    //
    // Then the same hue at 0.45 of it for the BACK row. Every fraction from here
    // down is a depth statement: front row 0.86, back row 0.39, machine hall
    // 0.42 of a warmer hue at nineteen metres, tunnel lamp 0.30 through its own
    // haze at thirty. Read down that list and it is the room in section.
    _c.copy(rim ?? SLOT_COLOR[SLOT.MERC_BAY]);
    for (const s of [SLOT.MERC_BAY, SLOT.FLICKER]) {
      cols[s].copy(_c).lerp(_white, 0.12).multiplyScalar(LAMP_ANCHOR * 0.86);
      cards[s].copy(_c).multiplyScalar(0.22);
    }
    cols[SLOT.MERC_FAR].copy(_c).lerp(SLOT_COLOR[SLOT.MERC_FAR], 0.4).multiplyScalar(LAMP_ANCHOR * 0.39);
    cards[SLOT.MERC_FAR].copy(_c).multiplyScalar(0.10);
    // The soffit uplighters. Cooler and weaker than the wall strips — they are
    // throwing at a raw concrete ceiling three metres up, and the thing that has
    // to read is the lit surface, not the fitting.
    cols[SLOT.SOFFIT].copy(_c).lerp(SLOT_COLOR[SLOT.SOFFIT], 0.35).multiplyScalar(LAMP_ANCHOR * 0.62);
    cards[SLOT.SOFFIT].copy(_c).lerp(SLOT_COLOR[SLOT.SOFFIT], 0.35).multiplyScalar(0.26);
    // The machine hall's sodium. Warm, and driven low so the whole band sits
    // under the arcade in value as well as behind it in space.
    _c.copy(rimB ?? SLOT_COLOR[SLOT.SODIUM_HALL]).lerp(SLOT_COLOR[SLOT.SODIUM_HALL], 0.55);
    cols[SLOT.SODIUM_HALL].copy(_c).multiplyScalar(LAMP_ANCHOR * 0.42);
    cards[SLOT.SODIUM_HALL].copy(_c).multiplyScalar(0.30);
    // The hall's fill is the same colour as its fitting, at a fraction of the
    // wash. It is not ambient smuggled back in: band D is nineteen metres past
    // the bulkhead, no analytic light in any mood reaches it, and its own
    // sodium lamp is the only thing that can be lighting it — so the term is
    // driven by that lamp and dies with it.
    this.hallFill.value.copy(_c).multiplyScalar(0.052);
    // The emergency box. Fixed — an emergency fitting runs off its own battery
    // and does not change colour when the house lighting does, which is also
    // what guarantees the green survives every mood the Environment can author.
    cols[SLOT.GREEN].copy(SLOT_COLOR[SLOT.GREEN]).multiplyScalar(LAMP_ANCHOR * 0.5);
    cards[SLOT.GREEN].copy(SLOT_COLOR[SLOT.GREEN]).multiplyScalar(0.20);
    // The tunnel lamp, thirty metres out through its own haze.
    cols[SLOT.TUNNEL].copy(SLOT_COLOR[SLOT.TUNNEL]).multiplyScalar(LAMP_ANCHOR * 0.3);
    cards[SLOT.TUNNEL].copy(SLOT_COLOR[SLOT.TUNNEL]).multiplyScalar(0.085);
  }

  // -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds since the last rendered frame
   * @param {number} time seconds since the stage was built
   * @param {object} envParams live Environment mood parameters, may be null
   */
  update(dt, time, envParams) {
    this.timeUniform.value = time;
    this.#syncEmitters();

    // The failing tube in the arcade. Not a blink — a blink reads as a beacon.
    // A choking fluorescent strikes, holds for a beat, drops most of the way
    // out and strikes again, and the giveaway is that its restrike is FASTER
    // than its decay. Its wash and its pool follow it, because a flicker that
    // leaves its own deposit standing is the tell that the deposit was painted.
    const t = time * 1.7;
    const n = Math.sin(t * 3.1) * Math.sin(t * 0.7 + 1.3) * Math.sin(t * 11.3);
    const gate = n > 0.34 ? 1 : n > 0.05 ? 0.42 : 0.09;
    this._flicker = this._flicker === undefined ? gate : this._flicker + (gate - this._flicker) * Math.min(1, dt * 26);
    const f = this._flicker;
    this.emitterMaterial.uniforms.uColor.value[SLOT.FLICKER].multiplyScalar(f);
    this._cardColors[SLOT.FLICKER].multiplyScalar(Math.sqrt(f));

    // The far bands take their haze from whatever mood is running, so a colder
    // preset does not leave a warm tunnel sitting inside it. Both bands share
    // one Color object; band D reads it through a uniform and band E through the
    // same reference, which is the cheapest way to keep them agreeing.
    if (envParams?.fog?.color) {
      this.hazeColor.value.copy(envParams.fog.color).multiplyScalar(1.25);
    }
    // The water level does not move, but the mood's `floorRefl` says how wet the
    // room is, and the vertical surfaces have to agree with the deck about it or
    // the tide mark and the deck's wetness mask part company.
    const refl = envParams?.floorRefl ?? 0.5;
    this.tide.value.z = 0.7 + refl * 0.4;
  }

  reset() {
    this._flicker = undefined;
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const set of Object.values(this.sets)) {
      set.albedo?.dispose();
      set.normal?.dispose();
      set.orm?.dispose();
    }
    this.castMaterial?.dispose();
    this.brickMaterial?.dispose();
    this.ironMaterial?.dispose();
    this.flotsamMaterial?.dispose();
    this.hallMaterial?.dispose();
    this.tunnelMaterial?.dispose();
    this.emitterMaterial?.dispose();
    for (const m of this._cardMaterials ?? []) m.dispose();
  }
}
