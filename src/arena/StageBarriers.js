/**
 * Knockbots — the combat barriers, one preset per arena.
 *
 * `ARENA_HALF_WIDTH` is a rule the player has to *feel*, so every arena needs
 * two surfaces at x = ±9 that are heavy, close, and answer back. What that
 * surface IS, though, is a set decision and not a mechanism one: a test cell has
 * a bolted concrete barrier, a working rooftop has scaffold hoarding you can see
 * the sky through, and a flooded vault has the tank's own division wall. Those
 * three want completely different geometry and completely different emitters,
 * and none of them wants a different dent system.
 *
 * So this file holds the geometry and `StageWalls.js` holds the machinery. A
 * preset is handed a side and the shared bins and fills four out-lists:
 *
 *   `emissive`   geometry for the unlit safety-line mesh (one draw, both sides)
 *   `ribbon`     per-segment records for the coloured board, or none
 *   `washes`     where a flood lands, so `StageWalls` can build its pool cards
 *   `lamps`      lens geometry plus a world position for the impact flash light
 *   `pads`       the rubber impact pads, which are the only part that moves
 *
 * Everything else it builds goes straight into the shared bins and costs no
 * draw call at all.
 *
 * **`PIT_BARRIER` is the previous contents of `StageWalls.js`, moved and not
 * rewritten.** Every number in it is the literal that was there before, and the
 * refactor is verified by fingerprinting every vertex buffer in the built arena
 * before and after — see `scratchpad/stagehash.mjs`. The pit is the project's
 * highest-scoring axis and it does not move for a piece of plumbing.
 */

import * as THREE from 'three';
import { ARENA_HALF_WIDTH } from '../core/Constants.js';
import { bevelBox, place, boltRow, insetPanel } from './GeoKit.js';

// ---------------------------------------------------------------------------
// SUBLEVEL 09 — the bolted concrete barrier.
// ---------------------------------------------------------------------------

const WALL_H = 4.4;        // barrier height
const WALL_T = 1.0;        // thickness, outward from the play surface
const WALL_Z = 2.4;        // centre of the run along z
const WALL_LEN = 22;       // length of the run
const RELIEF = 0.13;       // frame proud of the recessed panel face
const BAY = 3.15;          // pilaster spacing

/**
 * The ribbon board's colour cycle, and why it is warm.
 *
 * Two separate measured gaps meet on this run of geometry.
 *
 * **Detail.** The wide frame was scored on mean 8x8 luma standard deviation over
 * named screen regions, three captures, spread under 0.0009:
 *
 *     back barrier band (dressed)   0.0506
 *     right truss / containers      0.0279
 *     crowd terrace                 0.0243
 *     side barrier wall (bare)      0.0195
 *
 * The back barrier and the side barriers are the *same concrete*, at comparable
 * distance, differing only in that one carries event dressing and the other
 * carries two recessed panels across eleven metres. 2.6x, inside one frame, with
 * the material held constant — which is as close to a controlled experiment as
 * this set offers, and it says the deficit is dressing rather than shading.
 *
 * **Hue.** The same frame holds two major hue bins with 88% of its saturated
 * pixels in cyan and azure, against a reference spread of two to five. Every
 * emitter in the room is a cool tube. So the ribbon is deliberately the warm
 * band: amber, signal red and a tungsten white, none of which exists anywhere
 * else in the mid-ground, and each segment is a whole bay wide so it survives to
 * a handful of pixels at twenty metres instead of averaging away to grey.
 *
 * Values are linear-ish radiance, not sRGB — this feeds a `MeshBasicMaterial`
 * through the same tone map as everything else, so a "white" segment at 1.0
 * lands mid-grey. They are pushed above 1 to sit on the AgX shoulder.
 *
 * **Round 18: these were authored as paint, and the board is a lamp.** The
 * previous table peaked at 2.10, which the display transform lands on 0.953
 * display in red and 0.48 in blue — a coloured surface, not a source.
 * `StagePracticals` had already worked this out for its fixtures and anchored
 * them at 13.0; the ribbon was six times under that anchor for no reason
 * anybody wrote down. Measured in-page on one frozen wide frame, noise floor of
 * the instrument exactly 0.000 (control run twice):
 *
 *     ribbon x1 (shipped)   warm 6.6%   cyan 90.2%   major hue bins 2
 *     ribbon x6             warm 12.5%  cyan 83.0%   bins 3   12.4% of frame moved
 *     ribbon x8             warm 15.1%  cyan 79.6%   bins 3   11.9% of frame moved
 *     ribbon x16            warm 16.4%  cyan 78.2%   bins 3   12.9% of frame moved
 *
 * against a reference set that runs 1 to 5 major bins with a median of 3. The
 * pixels land where the stage critic said the frame was empty: of the 11.9%
 * that moved at x8, 5.9 points are the top-left tile, 2.7 the left-middle, 1.8
 * the top-right and 1.7 the two bottom corners — the board and its reflection
 * in the wet deck occupy the frame's four corners and almost nothing else. It
 * returns above x8, so this table is x6 with the roll-off taken into account.
 *
 * **It costs local contrast in the tile it lights, and that is a real trade.**
 * Mean 16x16 luma standard deviation over a 4x4 grid, ribbon table swept alone
 * with everything else this round already in place: the top-left tile falls
 * 0.0764 -> 0.0636 as the table goes from the old values to these, because a
 * bloomed emitter is smooth and smooth is what that metric counts. Over the
 * same sweep the bottom-left tile — the board's reflection in the wet deck —
 * rises 0.0929 -> 0.1094, so the left column as a whole is flat. Against the
 * full control (this round's three files reverted in-page) the left column is
 * +4%, the right column +7% and the whole frame +6%, all of that from the tube;
 * the top row is -6%, all of that from here. Reported both ways on purpose: the
 * hue defect the critic named came with a number and this clears it, the top-row
 * contrast defect came with a number and this does not.
 *
 * **The tungsten segments were driven to 58 to make them clip, and that did not
 * work — recorded because it is the useful half of the result.** Linear
 * luminance over 0.99 needs a near-*neutral* source, since luminance is a
 * weighted mean and a saturated amber drags its own luma down through the blue
 * channel however bright it gets; the two white panels per side are the only
 * near-neutral emitters this frame holds, so they were the candidate. They
 * still do not clip, and the reason is the vignette. `GradePass` darkens by
 * `1 - 0.3 * (2 r^2)^1.35`, and the ribbon lands almost entirely in the frame's
 * four *corners* — measured, 5.9 of the 11.9 points of frame it moves are the
 * top-left tile alone. At the centre of that tile the vignette is 0.86, so a
 * pixel that reaches 0.997 before it arrives leaves at 0.857. Nothing in a
 * corner can clip in this frame, at any radiance. The frame's top end is
 * carried by the barrier tube in `StagePracticals` instead, which is near the
 * centre where the vignette is 1.0.
 *
 * So the white panels are set to read as white panels rather than chased to a
 * threshold they cannot reach: 58 and 24 differ by 0.87% of frame and by
 * nothing at all on hue, warm share or the clipped fraction.
 */
const RIBBON_COLOURS = [
  [12.6, 3.96, 0.60],  // amber
  [9.30, 0.60, 0.30],  // signal red
  [24.0, 21.0, 17.5],  // tungsten white
  [12.6, 3.96, 0.60],  // amber
  [7.80, 0.96, 0.36],  // signal red, darker
  [24.0, 21.0, 17.5],  // tungsten white
  [12.6, 3.96, 0.60],  // amber
];

/**
 * Authors one pit barrier. Local frame: x=0 is the surface the fighters hit and
 * everything is built outward from it; z runs along the barrier.
 */
function pitSide(side, bins, out) {
  const M = (geo) => place(geo, { pos: [side * ARENA_HALF_WIDTH, 0, WALL_Z], rot: [0, side > 0 ? 0 : Math.PI, 0] });
  const half = WALL_LEN / 2;

  // Mass of the barrier. Its face sits back by RELIEF so the frame members
  // added below are proud of it without anything crossing x=0.
  bins.concrete.push(M(place(bevelBox(WALL_T - RELIEF, WALL_H, WALL_LEN, 0.03), {
    pos: [RELIEF + (WALL_T - RELIEF) / 2, WALL_H / 2, 0],
  })));

  // Pilasters and horizontal frame bands, flush with x=0.
  const bays = Math.round(WALL_LEN / BAY);
  for (let i = 0; i <= bays; i++) {
    const z = -half + (i * WALL_LEN) / bays;
    bins.concrete.push(M(place(bevelBox(RELIEF, WALL_H, 0.52, 0.02), { pos: [RELIEF / 2, WALL_H / 2, z] })));
  }
  for (const b of [{ y: 2.22, h: 0.3 }, { y: WALL_H - 0.2, h: 0.4 }]) {
    bins.concrete.push(M(place(bevelBox(RELIEF, b.h, WALL_LEN, 0.02), { pos: [RELIEF / 2, b.y, 0] })));
  }

  // Hazard-striped kerb at the base — the part a sliding fighter meets first.
  bins.hazard.push(M(place(bevelBox(RELIEF, 0.78, WALL_LEN, 0.02), { pos: [RELIEF / 2, 0.39, 0] })));

  // Steel coping and its bolt rows, overhanging outward only.
  bins.steel.push(M(place(bevelBox(WALL_T + 0.16, 0.16, WALL_LEN, 0.02), { pos: [(WALL_T + 0.16) / 2 - 0.08, WALL_H + 0.08, 0] })));
  bins.steel.push(M(place(boltRow(WALL_LEN - 0.6, Math.round(WALL_LEN / 0.9), 0.026, 0.02), {
    pos: [0.02, WALL_H - 0.2, 0], rot: [0, -Math.PI / 2, 0],
  })));

  // Recessed sign panels and stencilled plates in alternate bays.
  for (let i = 0; i < bays; i++) {
    const z = -half + (i + 0.5) * (WALL_LEN / bays);
    if (i % 3 === 1) {
      bins.plate.push(M(place(new THREE.PlaneGeometry(1.5, 0.85), { pos: [RELIEF - 0.012, 3.15, z], rot: [0, -Math.PI / 2, 0] })));
      bins.steel.push(M(place(insetPanel(1.72, 1.05, 0.05, 0.07), { pos: [RELIEF - 0.005, 3.15, z], rot: [0, -Math.PI / 2, 0] })));
    } else if (i % 3 === 2) {
      bins.steel.push(M(place(insetPanel(1.9, 1.2, 0.06, 0.09), { pos: [RELIEF - 0.005, 3.2, z], rot: [0, -Math.PI / 2, 0] })));
    }
  }

  // Amber safety line skimming the floor.
  out.emissive.push(M(place(bevelBox(0.05, 0.045, WALL_LEN - 0.2, 0.008), { pos: [0.03, 0.83, 0] })));

  // Mesh fence above the coping, well outside anything a fighter can reach.
  const fenceH = 1.9;
  const fence = new THREE.PlaneGeometry(WALL_LEN, fenceH);
  const uv = fence.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (WALL_LEN / 2.4), uv.getY(i) * (fenceH / 2.4));
  bins.chain.push(M(place(fence, { pos: [WALL_T * 0.5, WALL_H + 0.16 + fenceH / 2, 0], rot: [0, Math.PI / 2, 0] })));
  for (let i = 0; i <= bays; i++) {
    const z = -half + (i * WALL_LEN) / bays;
    bins.steel.push(M(place(new THREE.CylinderGeometry(0.045, 0.045, fenceH + 0.18, 8), {
      pos: [WALL_T * 0.5, WALL_H + 0.16 + fenceH / 2, z],
    })));
  }
  bins.steel.push(M(place(new THREE.CylinderGeometry(0.05, 0.05, WALL_LEN, 8), {
    pos: [WALL_T * 0.5, WALL_H + 0.16 + fenceH, 0], rot: [Math.PI / 2, 0, 0],
  })));

  pitDress(side, bins, out, bays, half);
  pitPads(side, out, bays);
}

/**
 * Event dressing on the side barriers — the ribbon board, its supply, and the
 * work lights over it.
 *
 * These two walls are eleven metres of concrete each and they own the left and
 * right quarters of every wide, KO and replay framing. Bare they carried a
 * pilaster every three metres and two recessed panels, and measured at 0.0195
 * mean 8x8 luma std against the *back* barrier's 0.0506 — same material, same
 * distance, 2.6x apart, the difference being that the back barrier is dressed
 * and these were not. See {@link RIBBON_COLOURS} for the full table.
 *
 * What goes on them is deliberately not more banners. The back barrier already
 * spends the four legends in the atlas and a legend the viewer can read twice
 * in one frame is worse than no legend at all, so the sides are dressed as
 * *infrastructure*: a lit ribbon board on the coping, the conduit that feeds
 * it, and three caged floods per side. Infrastructure repeats without reading
 * as repetition, which is exactly what eleven metres of wall wants.
 *
 * Everything except the ribbon segments themselves lands in the shared bins
 * and so costs no draw call. The ribbon is one merged mesh for both walls.
 */
function pitDress(side, bins, out, bays, half) {
  const M = (geo) => place(geo, { pos: [side * ARENA_HALF_WIDTH, 0, WALL_Z], rot: [0, side > 0 ? 0 : Math.PI, 0] });
  const bayW = WALL_LEN / bays;
  const gap = 0.14;
  const segW = bayW - gap;

  // Ribbon board, mounted on the fascia of the steel coping. The coping
  // already overhangs the play plane by 8cm at y=4.4, which is above anything
  // a fighter's capsule reaches, so the board hangs off its inner edge rather
  // than intruding anywhere new.
  const RIB_X = -0.086;
  const RIB_Y0 = 4.28;
  const RIB_Y1 = 4.54;

  // Dark shroud the segments sit in. One box for the whole run plus a divider
  // at every joint: the dividers are what turn a continuous glowing line into
  // a board with panels in it, and they are the high-frequency edge the metric
  // is actually counting.
  bins.dark.push(M(place(bevelBox(0.10, RIB_Y1 - RIB_Y0 + 0.10, WALL_LEN, 0.012), {
    pos: [RIB_X + 0.056, (RIB_Y0 + RIB_Y1) / 2, 0],
  })));
  for (let i = 0; i <= bays; i++) {
    const z = -half + (i * WALL_LEN) / bays;
    bins.dark.push(M(place(bevelBox(0.13, RIB_Y1 - RIB_Y0 + 0.16, gap + 0.05, 0.012), {
      pos: [RIB_X + 0.04, (RIB_Y0 + RIB_Y1) / 2, z],
    })));
  }

  for (let i = 0; i < bays; i++) {
    const z = -half + (i + 0.5) * bayW;
    out.ribbon.push({
      side, x: RIB_X, y0: RIB_Y0, y1: RIB_Y1, z0: z - segW / 2, z1: z + segW / 2,
      colour: RIBBON_COLOURS[i % RIBBON_COLOURS.length],
    });
  }

  // Supply: a conduit along the wall at chest-of-the-terrace height, a
  // junction box per bay, and a drop from each box up to the board. The drops
  // are the part that makes the board read as wired rather than painted on.
  const CONDUIT_Y = 2.62;
  bins.steel.push(M(place(new THREE.CylinderGeometry(0.045, 0.045, WALL_LEN - 0.3, 6), {
    pos: [0.06, CONDUIT_Y, 0], rot: [Math.PI / 2, 0, 0],
  })));
  for (let i = 0; i < bays; i++) {
    const z = -half + (i + 0.5) * bayW;
    bins.dark.push(M(place(bevelBox(0.17, 0.23, 0.21, 0.014), { pos: [0.085, CONDUIT_Y, z] })));
    bins.steel.push(M(place(new THREE.CylinderGeometry(0.032, 0.032, RIB_Y0 - CONDUIT_Y - 0.1, 5), {
      pos: [0.05, (RIB_Y0 + CONDUIT_Y) / 2, z + 0.16],
    })));
  }

  // A second bolt row on the mid frame band. The top band already has one;
  // this is the line that keeps the eye from travelling three metres along an
  // unbroken edge in the middle of the wall.
  bins.steel.push(M(place(boltRow(WALL_LEN - 1.2, 14, 0.024, 0.018), {
    pos: [0.02, 2.22, 0], rot: [0, -Math.PI / 2, 0],
  })));

  // Caged floods on stub brackets, raked down the wall face, each with the
  // pool it throws. No analytic light is attached — a shadowless point light
  // costs a flat 1.5ms in this scene and there are six of these — so the pool
  // is a gradient card, the same fake `StagePracticals` uses on the deck.
  //
  // The card is the whole point and the can is the excuse for it, which is the
  // opposite of how this was first built. Measured, three captures a side: the
  // cans, the conduit, the junction boxes and a second bolt row — about 1500
  // triangles of honest hardware on a wall the metric says is empty — moved
  // that wall from 0.0195 to 0.0199 mean 8x8 luma std, which is inside the
  // run-to-run spread. The lit ribbon over them, one two-triangle quad per
  // bay, moved its own band from 0.0310 to 0.0672. At twenty metres through
  // FogExp2 at 0.028 there is not enough light landing on this wall for
  // geometry to cast a shadow the frame can resolve; **only emitters register
  // here**, which is the same result the fence-wire experiment got from the
  // other direction.
  for (let i = 1; i < bays; i += 2) {
    const z = -half + i * bayW;
    bins.dark.push(M(place(bevelBox(0.26, 0.05, 0.05, 0.012), { pos: [0.14, 3.72, z] })));
    bins.dark.push(M(place(new THREE.CylinderGeometry(0.105, 0.09, 0.24, 8, 1), {
      pos: [0.24, 3.58, z], rot: [0, 0, -0.16],
    })));
    bins.dark.push(M(place(new THREE.CylinderGeometry(0.155, 0.105, 0.13, 8, 1), {
      pos: [0.27, 3.42, z], rot: [0, 0, -0.16],
    })));
    out.washes.push({ side, z, y: 3.44 });
  }
}

/**
 * Rubber impact pads. These are the only parts of the wall that move, and they
 * move a lot: a heavy splat compresses one by four centimetres and it springs
 * back over about a third of a second.
 */
function pitPads(side, out, bays) {
  const padW = 2.6, padH = 1.45;
  const parts = [];
  for (let i = 0; i < bays; i++) {
    if (i % 3 !== 0) continue;
    const z = -WALL_LEN / 2 + (i + 0.5) * (WALL_LEN / bays);
    // Five horizontal ribs sit flush with the collision plane and the body
    // sits behind them, so nothing ever crosses x=0 into the play area.
    parts.push(place(bevelBox(0.11, padH, padW, 0.02), { pos: [0.105, 1.5, z] }));
    for (let r = 0; r < 5; r++) {
      const y = 1.5 - padH / 2 + (r + 0.5) * (padH / 5);
      parts.push(place(bevelBox(0.05, padH / 8, padW - 0.12, 0.012), { pos: [0.025, y, z] }));
    }
  }
  out.pads.push({ side, parts, uv: 0.9 });
}

/**
 * Caged work lamps above each barrier. They are the light source that stutters
 * when the wall is hit, so their positions are published for the point light
 * the Stage owns.
 */
function pitLamps(side, bins, out) {
  const housings = bins.dark;
  for (const z of [-6.4, 1.2, 8.6]) {
    const wx = side * (ARENA_HALF_WIDTH + 0.42);
    const wz = WALL_Z + side * z;
    const y = WALL_H + 0.62;
    housings.push(place(new THREE.CylinderGeometry(0.2, 0.26, 0.16, 12, 1, true), { pos: [wx, y + 0.09, wz] }));
    housings.push(place(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), { pos: [wx, y + 0.4, wz] }));
    for (let r = 0; r < 6; r++) {
      const a = (r / 6) * Math.PI * 2;
      housings.push(place(new THREE.TorusGeometry(0.19, 0.008, 4, 10, Math.PI), {
        pos: [wx, y + 0.02, wz], rot: [0, a, Math.PI / 2],
      }));
    }
    out.lamps.push({
      lens: place(new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58), { pos: [wx, y + 0.02, wz] }),
      position: new THREE.Vector3(wx, y - 0.1, wz),
    });
  }
}

/** @type {BarrierPreset} */
export const PIT_BARRIER = {
  id: 'pit',
  height: WALL_H,
  z: WALL_Z,
  length: WALL_LEN,
  build: pitSide,
  lamps: pitLamps,
  /** Amber safety line skimming the floor. See `StageWalls.update`. */
  strip: { rgb: [1.0, 0.42, 0.1], gain: 12.5, swing: 0.8, hz: 1.7 },
  lamp: { rgb: [1.0, 0.94, 0.82], gain: 16.0 },
  /** Warm tungsten, well above 1 so the top of the cone lands on the shoulder
   *  of the tone curve rather than in the middle of it. */
  wash: { tint: [1.55, 0.86, 0.42], halfW: 1.45, top: 3.44, drop: 2.55, faceX: 0.118 },
};

// ---------------------------------------------------------------------------
// SKYDECK — scaffold hoarding on a working roof.
// ---------------------------------------------------------------------------

const ROOF_H = 3.05;       // hoarding height: chest-high plus a debris screen
const ROOF_Z = 1.0;        // centre of the run, biased back off the camera
const ROOF_LEN = 21;
const ROOF_BAY = 2.1;      // scaffold bay — a real 2.1m standard spacing

/**
 * The rooftop barrier, and the one thing it must not be is a wall.
 *
 * The arena exists to have an open sky and a low key throwing long shadows
 * across the deck. A 4.4m concrete barrier at x = ±9 would take both away: it
 * would close the frame's left and right thirds and, worse, it would stand
 * directly between a sun at eleven degrees and the deck the shadows are meant to
 * land on. So the run is **short, perforated and slatted**:
 *
 *   - 1.35m of solid ply hoarding at the bottom, which is what a fighter
 *     actually hits and the only part that has to be a surface;
 *   - a slatted debris screen above it to 3.05m, on 45mm boards at 60% cover.
 *     That is what makes it a rooftop barrier rather than a fence: a low sun
 *     THROUGH a slatted screen puts a set of hard bright bars across the deck,
 *     which is a second, free, entirely different raking shadow from the one the
 *     roof furniture throws, and it is the cheapest good thing in this arena;
 *   - standards and ledgers in tube, so the sky is visible between them.
 *
 * The debris screen is alpha-tested rather than modelled per slat — it goes into
 * the `chain` bin, whose material is exactly a two-sided alpha-tested wire, and
 * a per-slat model would be 1400 triangles a side for a silhouette the shadow
 * map resolves the same way.
 *
 * There is no ribbon board. The pit's exists because that frame measured two hue
 * bins and needed a warm emitter; this frame's warm is a sun, and a lit sign
 * strip along both edges would compete with the one thing the arena is for.
 */
function roofSide(side, bins, out) {
  const M = (geo) => place(geo, { pos: [side * ARENA_HALF_WIDTH, 0, ROOF_Z], rot: [0, side > 0 ? 0 : Math.PI, 0] });
  const half = ROOF_LEN / 2;
  const bays = Math.round(ROOF_LEN / ROOF_BAY);
  const HOARD_H = 1.35;

  // Solid ply hoarding: the collision surface. Its face is the play plane, so
  // the sheet is built entirely outward from x=0.
  bins.container.push(M(place(bevelBox(0.09, HOARD_H, ROOF_LEN, 0.015), { pos: [0.045, HOARD_H / 2, 0] })));
  // Ledger rails behind it, top and bottom, which is what a hoarding is fixed to.
  for (const y of [0.28, HOARD_H - 0.16]) {
    bins.steel.push(M(place(new THREE.CylinderGeometry(0.024, 0.024, ROOF_LEN - 0.2, 6), {
      pos: [0.13, y, 0], rot: [Math.PI / 2, 0, 0],
    })));
  }
  // Kicker board at the foot, hazard-striped: the part a sliding fighter meets.
  bins.hazard.push(M(place(bevelBox(0.11, 0.24, ROOF_LEN, 0.012), { pos: [0.055, 0.12, 0] })));

  // Standards, and their base plates on the roof deck. Spaced on the bay but
  // with the plate rotated a few degrees per bay off the run: scaffold is set
  // out by hand and a perfectly square base plate every 2.1m is exactly the
  // constant-pitch tell this project has been marked down for.
  for (let i = 0; i <= bays; i++) {
    const z = -half + (i * ROOF_LEN) / bays;
    bins.steel.push(M(place(new THREE.CylinderGeometry(0.026, 0.026, ROOF_H + 0.34, 8), {
      pos: [0.13, (ROOF_H + 0.34) / 2, z],
    })));
    bins.steel.push(M(place(bevelBox(0.17, 0.02, 0.17, 0.004), { pos: [0.13, 0.01, z], rot: [0, (i % 5) * 0.11 - 0.22, 0] })));
    // A second standard outboard on alternate bays, braced back — the run has
    // to stand up on its own on a roof, with nothing to bolt to but ballast.
    if (i % 2 === 0) {
      bins.steel.push(M(place(new THREE.CylinderGeometry(0.026, 0.026, ROOF_H, 8), { pos: [0.62, ROOF_H / 2, z] })));
      bins.steel.push(M(place(new THREE.CylinderGeometry(0.02, 0.02, 1.4, 6), {
        pos: [0.375, ROOF_H * 0.62, z], rot: [0, 0, -0.38],
      })));
      // Ballast: a kentledge block on the outrigger foot.
      bins.concrete.push(M(place(bevelBox(0.42, 0.24, 0.62, 0.02), { pos: [0.62, 0.12, z] })));
    }
  }

  // Debris screen: one alpha-tested sheet per side, UV'd so the wire scale of
  // the shared material lands at a slat rather than a mesh.
  const screenH = ROOF_H - HOARD_H;
  const screen = new THREE.PlaneGeometry(ROOF_LEN, screenH);
  const uv = screen.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (ROOF_LEN / 1.4), uv.getY(i) * (screenH / 1.4));
  bins.chain.push(M(place(screen, { pos: [0.12, HOARD_H + screenH / 2, 0], rot: [0, Math.PI / 2, 0] })));

  // Handrail over the top, and a toe board: the two horizontals that read as
  // "this is scaffold" from any distance.
  bins.steel.push(M(place(new THREE.CylinderGeometry(0.028, 0.028, ROOF_LEN, 8), {
    pos: [0.13, ROOF_H + 0.3, 0], rot: [Math.PI / 2, 0, 0],
  })));

  // Site notices, two per side, on the bays the pit would have put plates on.
  for (let i = 2; i < bays; i += 5) {
    const z = -half + (i + 0.5) * (ROOF_LEN / bays);
    bins.plate.push(M(place(new THREE.PlaneGeometry(1.1, 0.62), { pos: [0.096, 0.92, z], rot: [0, -Math.PI / 2, 0] })));
  }

  // Amber safety line, at the head of the hoarding rather than at knee height:
  // on a roof the line that matters is the one you can see from a doorway.
  out.emissive.push(M(place(bevelBox(0.045, 0.035, ROOF_LEN - 0.3, 0.006), { pos: [0.028, HOARD_H - 0.05, 0] })));

  roofPads(side, out, bays);
}

/**
 * Two festoon lamps a side, slung on the top rail. They are the impact-flash
 * sources and they are the only fittings on this run, and the flood pools they
 * throw are two a side rather than the pit's three and much lower: festoons at
 * 3.2m throwing down a 1.35m board, not caged floods at 3.4m throwing down a
 * 4.4m wall.
 *
 * Split from `roofSide` for a mechanical reason rather than a tidiness one. The
 * Stage merges each bin into ONE mesh in push order, so where the housings land
 * in `bins.dark` is part of the merged buffer; keeping lamps in their own pass
 * after both sides are built is what makes the pit's merge byte-identical to
 * the version of this code that lived in `StageWalls.js`.
 */
function roofLamps(side, bins, out) {
  for (const z of [-5.6, 4.2]) {
    const wx = side * (ARENA_HALF_WIDTH + 0.16);
    const wz = ROOF_Z + side * z;
    const y = ROOF_H + 0.16;
    bins.dark.push(place(new THREE.CylinderGeometry(0.055, 0.075, 0.11, 8, 1, true), { pos: [wx, y + 0.06, wz] }));
    out.lamps.push({
      lens: place(new THREE.SphereGeometry(0.075, 10, 8), { pos: [wx, y, wz] }),
      position: new THREE.Vector3(wx, y - 0.1, wz),
    });
    out.washes.push({ side, z, y: ROOF_H + 0.1 });
  }
}

/**
 * The rooftop's pads. A hoarding is 1.35m high, so the pit's 1.45m pad centred
 * at 1.5m would stand a full metre above it. These sit low and wide — a stack of
 * old tyre matting lashed to the ply, which is what a working roof would
 * actually have to hand.
 */
function roofPads(side, out, bays) {
  const padW = 2.2, padH = 0.92;
  const parts = [];
  for (let i = 1; i < bays; i += 4) {
    const z = -ROOF_LEN / 2 + (i + 0.5) * (ROOF_LEN / bays);
    parts.push(place(bevelBox(0.10, padH, padW, 0.02), { pos: [0.095, 0.56, z] }));
    for (let r = 0; r < 4; r++) {
      const y = 0.56 - padH / 2 + (r + 0.5) * (padH / 4);
      parts.push(place(bevelBox(0.045, padH / 7, padW - 0.1, 0.01), { pos: [0.022, y, z] }));
    }
  }
  out.pads.push({ side, parts, uv: 0.8 });
}

/** @type {BarrierPreset} */
export const ROOF_BARRIER = {
  id: 'roof',
  height: ROOF_H,
  z: ROOF_Z,
  length: ROOF_LEN,
  build: roofSide,
  lamps: roofLamps,
  // Cooler and dimmer than the pit's. The frame already has a 620-unit sun in
  // it; a 12.5-unit orange line along both edges would be the second brightest
  // thing on screen at dusk and would read as neon rather than as a safety mark.
  strip: { rgb: [1.0, 0.55, 0.16], gain: 5.4, swing: 0.4, hz: 1.1 },
  // Festoon tungsten, warm and weak — they are lit but the sun is still up.
  lamp: { rgb: [1.0, 0.88, 0.68], gain: 7.0 },
  wash: { tint: [1.15, 0.72, 0.40], halfW: 1.1, top: 3.15, drop: 2.1, faceX: 0.10 },
};

// ---------------------------------------------------------------------------
// THE CISTERN — the tank's own division wall.
// ---------------------------------------------------------------------------

const VAULT_H = 4.9;
const VAULT_Z = 0.0;
const VAULT_LEN = 23;
const VAULT_BAY = 3.83;   // deliberately not the pit's 3.15 and not a round number

/**
 * The vault's barrier: a mass concrete division wall with the tank's own
 * pilaster rhythm and a steel-lined lower section.
 *
 * The design problem here is the inverse of the rooftop's. The arena's whole
 * argument is steep falloff — a strip hot at two metres and gone at four — and a
 * flat 23m wall either side of the play area is the surface that either proves
 * that or ruins it. It proves it by being **plain in its lower half and detailed
 * in its upper**: the band from 0 to 2.4m is a steel liner plate with almost
 * nothing on it, which is where the strips' gradient lands and where the eye
 * reads the falloff, and everything that would break that gradient up — the
 * corbel, the relieving arches, the cable trays — sits above 2.6m where the
 * light has already fallen off.
 *
 * There is no ribbon and there are no floods. `StageVault` owns every emitter in
 * this arena and it owns them as a slot system, so a second, independent set of
 * lit segments on the barriers would be four more colours nobody could tune
 * together. The barrier carries exactly one emitter: a green-white escape line
 * at the waterline, which is also the arena's third hue bin.
 */
function vaultSide(side, bins, out) {
  const M = (geo) => place(geo, { pos: [side * ARENA_HALF_WIDTH, 0, VAULT_Z], rot: [0, side > 0 ? 0 : Math.PI, 0] });
  const half = VAULT_LEN / 2;
  const bays = Math.round(VAULT_LEN / VAULT_BAY);
  const LINER_H = 2.4;

  // The mass of the wall, set back behind the liner so nothing crosses x=0.
  bins.concrete.push(M(place(bevelBox(1.1, VAULT_H, VAULT_LEN, 0.03), { pos: [0.61, VAULT_H / 2, 0] })));

  // Steel liner: the plain lower band, and the collision surface. One sheet,
  // with a single horizontal weld seam and a bolt row at its head — that is the
  // entire dressing on it, on purpose.
  bins.steel.push(M(place(bevelBox(0.06, LINER_H, VAULT_LEN, 0.012), { pos: [0.03, LINER_H / 2, 0] })));
  bins.steel.push(M(place(bevelBox(0.075, 0.05, VAULT_LEN, 0.008), { pos: [0.037, 1.18, 0] })));
  bins.steel.push(M(place(boltRow(VAULT_LEN - 0.8, 22, 0.022, 0.016), {
    pos: [0.06, LINER_H - 0.09, 0], rot: [0, -Math.PI / 2, 0],
  })));

  // Base fillet: a 45-degree splay where the wall meets the slab. Water tanks
  // have them so silt cannot sit in the corner, and it is the one horizontal
  // that the strips graze hard enough to draw a bright line along.
  bins.concrete.push(M(place(new THREE.CylinderGeometry(0.26, 0.26, VAULT_LEN, 3, 1), {
    pos: [0.30, 0.13, 0], rot: [Math.PI / 2, 0, Math.PI / 4],
  })));

  // Pilasters, ABOVE the liner only. Below it the wall stays plain.
  for (let i = 0; i <= bays; i++) {
    const z = -half + (i * VAULT_LEN) / bays;
    bins.concrete.push(M(place(bevelBox(0.22, VAULT_H - LINER_H, 0.66, 0.02), {
      pos: [0.11, (VAULT_H + LINER_H) / 2, z],
    })));
  }
  // Corbel course under the springing, and the haunch above it.
  bins.concrete.push(M(place(bevelBox(0.30, 0.22, VAULT_LEN, 0.02), { pos: [0.15, 3.46, 0] })));
  bins.concrete.push(M(place(bevelBox(0.16, 0.34, VAULT_LEN, 0.02), { pos: [0.08, VAULT_H - 0.17, 0] })));

  // Relieving arch heads recessed into alternate bays, as segments of a wide
  // shallow circle rather than semicircles — there is only 1.5m of wall above
  // the springing and a semicircular head 3.4m wide would come out of the top.
  for (let i = 0; i < bays; i += 2) {
    const z = -half + (i + 0.5) * (VAULT_LEN / bays);
    bins.concrete.push(M(place(insetPanel(2.9, 0.78, 0.07, 0.11), { pos: [0.195, 2.98, z], rot: [0, -Math.PI / 2, 0] })));
  }

  // Cable tray and its saddles, high, where the light has already gone.
  bins.dark.push(M(place(bevelBox(0.22, 0.11, VAULT_LEN - 0.4, 0.012), { pos: [0.34, 4.12, 0] })));
  for (let i = 0; i <= bays; i++) {
    const z = -half + (i * VAULT_LEN) / bays;
    bins.steel.push(M(place(bevelBox(0.30, 0.035, 0.05, 0.008), { pos: [0.30, 4.19, z] })));
  }

  // Escape line at the waterline: the one emitter on this barrier, and the hue
  // bin the vault's mercury and sodium cannot supply. It sits at 1.32m to agree
  // with `StageVault`'s weir crest, so the line reads as the level the water
  // once stood at rather than as a random stripe.
  out.emissive.push(M(place(bevelBox(0.04, 0.032, VAULT_LEN - 0.4, 0.006), { pos: [0.028, 1.32, 0] })));

  vaultPads(side, out, bays);
}

/**
 * Bulkhead fittings recessed into the wall face, two a side. Small, deep-set and
 * pointed along the wall, so what they light is 6m of liner plate rather than
 * the play area — which is the falloff this arena is built on. Separate pass for
 * the bin-order reason given on `roofLamps`.
 */
function vaultLamps(side, bins, out) {
  for (const z of [-7.4, 5.2]) {
    const wx = side * (ARENA_HALF_WIDTH + 0.10);
    const wz = VAULT_Z + side * z;
    const y = 2.86;
    bins.dark.push(place(new THREE.BoxGeometry(0.16, 0.30, 0.22), { pos: [wx, y, wz] }));
    bins.steel.push(place(new THREE.TorusGeometry(0.13, 0.018, 4, 10), { pos: [wx - side * 0.06, y, wz], rot: [0, Math.PI / 2, 0] }));
    out.lamps.push({
      lens: place(new THREE.CircleGeometry(0.115, 12), { pos: [wx - side * 0.075, y, wz], rot: [0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0] }),
      position: new THREE.Vector3(wx - side * 0.2, y, wz),
    });
    out.washes.push({ side, z, y });
  }
}

/**
 * Cast-iron fender bars on the liner. A tank has them to stop plant damaging
 * the lining, and they are the right height and the right hardness for a splat.
 */
function vaultPads(side, out, bays) {
  const padW = 2.9, padH = 1.6;
  const parts = [];
  for (let i = 0; i < bays; i += 2) {
    const z = -VAULT_LEN / 2 + (i + 0.5) * (VAULT_LEN / bays);
    parts.push(place(bevelBox(0.10, padH, padW, 0.02), { pos: [0.09, 1.22, z] }));
    for (let r = 0; r < 3; r++) {
      const y = 1.22 - padH / 2 + (r + 0.5) * (padH / 3);
      parts.push(place(new THREE.CylinderGeometry(0.055, 0.055, padW - 0.14, 6), {
        pos: [0.02, y, z], rot: [Math.PI / 2, 0, 0],
      }));
    }
  }
  out.pads.push({ side, parts, uv: 1.0 });
}

/** @type {BarrierPreset} */
export const VAULT_BARRIER = {
  id: 'vault',
  height: VAULT_H,
  z: VAULT_Z,
  length: VAULT_LEN,
  build: vaultSide,
  lamps: vaultLamps,
  // Green-white, and it is the arena's third hue bin. Driven near the pit's
  // gain because in a room with no ambient this is genuinely one of the brighter
  // things in frame, which is exactly what an escape line is meant to be.
  strip: { rgb: [0.30, 1.0, 0.52], gain: 11.0, swing: 0.35, hz: 0.9 },
  // Sodium, matching `StageVault`'s SLOT.SODIUM so the barrier fittings and the
  // set's fittings are the same lamp type rather than two unrelated warms.
  lamp: { rgb: [1.0, 0.60, 0.22], gain: 13.0 },
  wash: { tint: [1.30, 0.78, 0.34], halfW: 1.9, top: 2.86, drop: 2.5, faceX: 0.09 },
};

/**
 * @typedef {object} BarrierPreset
 * @property {string} id
 * @property {number} height  top of the barrier; clamps dent placement
 * @property {number} z       centre of the run along z
 * @property {number} length  length of the run
 * @property {(side:number, bins:object, out:object) => void} build
 * @property {(side:number, bins:object, out:object) => void} [lamps] second
 *   pass, run for both sides after `build` has run for both — see `roofLamps`
 * @property {{rgb:number[], gain:number, swing:number, hz:number}} strip
 * @property {{rgb:number[], gain:number}} lamp
 * @property {{tint:number[], halfW:number, top:number, drop:number, faceX:number}} wash
 */
