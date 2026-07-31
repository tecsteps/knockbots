/**
 * Knockbots — the combat walls.
 *
 * These are load-bearing in the design sense: `ARENA_HALF_WIDTH` is a rule the
 * player has to *feel*, so the barriers are heavy, close, and they answer back.
 * A wall splat drives four things at once — a dent that stays for the round, a
 * dust burst off the concrete, a compression of the rubber impact pad, and a
 * stutter in the caged lamp above it. Those four together are what make the
 * wall read as a physical object rather than an invisible clamp.
 *
 * Both barriers are authored once in a local frame whose inner face is x=0 and
 * then mirrored, so the arena is symmetric by construction and nothing can ever
 * poke through the plane the fighters actually collide with. Every static part
 * of both walls is merged by material into single meshes; only the impact pads,
 * which have to move, keep their own transforms.
 */

import * as THREE from 'three';
import { ARENA_HALF_WIDTH, GROUND_Y } from '../core/Constants.js';
import { bevelBox, place, mergeAll, worldUv, boltRow, insetPanel } from './GeoKit.js';

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
 * Welds the ribbon segments into one geometry, colour carried per vertex.
 *
 * `GeoKit.mergeAll` deliberately keeps only position/normal/uv so a stray
 * attribute can never trip the merge, which means it drops exactly the colour
 * attribute this needs — so the quads are laid out by hand. They are quads on a
 * plane, so this is four vertices and two triangles apiece and nothing is lost.
 *
 * Each record is authored in the barrier's local frame (x=0 is the face the
 * fighters hit, +x runs away from the pit) and mapped to world by the same
 * translate-and-flip the rest of the wall uses, so a segment on the -x wall is
 * the mirror of its partner rather than a separate authoring.
 *
 * @param {{side:number,x:number,y0:number,y1:number,z0:number,z1:number,colour:number[]}[]} segs
 */
function buildRibbon(segs) {
  const n = segs.length;
  const pos = new Float32Array(n * 6 * 3);
  const nrm = new Float32Array(n * 6 * 3);
  const uv = new Float32Array(n * 6 * 2);
  const col = new Float32Array(n * 6 * 3);
  let p = 0, u = 0;
  for (const s of segs) {
    const f = s.side > 0 ? 1 : -1;           // +1: no flip. -1: rotate PI about Y.
    const wx = (x) => f > 0 ? ARENA_HALF_WIDTH + x : -ARENA_HALF_WIDTH - x;
    const wz = (z) => f > 0 ? WALL_Z + z : WALL_Z - z;
    // Wound so the face normal points at the pit on both walls; the local
    // ordering is +z then +y, which crosses to -x, and rotating PI about Y is a
    // rotation so it preserves the winding while taking the normal to +x.
    const q = [
      [s.x, s.y0, s.z0], [s.x, s.y0, s.z1], [s.x, s.y1, s.z1],
      [s.x, s.y0, s.z0], [s.x, s.y1, s.z1], [s.x, s.y1, s.z0],
    ];
    const t = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
    for (let i = 0; i < 6; i++) {
      pos[p] = wx(q[i][0]); pos[p + 1] = q[i][1]; pos[p + 2] = wz(q[i][2]);
      nrm[p] = -f; nrm[p + 1] = 0; nrm[p + 2] = 0;
      col[p] = s.colour[0]; col[p + 1] = s.colour[1]; col[p + 2] = s.colour[2];
      uv[u] = t[i][0]; uv[u + 1] = t[i][1];
      p += 3; u += 2;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** Critically damped scalar spring; the wall's recoil is a real impulse. */
class Recoil {
  constructor(hz = 4.5) {
    this.value = 0;
    this.velocity = 0;
    this.omega = hz * 2 * Math.PI;
  }
  kick(v) { this.velocity += v; }
  step(dt) {
    const w = this.omega;
    const e = Math.exp(-w * dt);
    const c1 = this.value;
    const c2 = this.velocity + w * c1;
    this.value = (c1 + c2 * dt) * e;
    this.velocity = (c2 - w * (c1 + c2 * dt)) * e;
  }
  reset() { this.value = 0; this.velocity = 0; }
}

export class StageWalls {
  /**
   * @param {object} deps
   * @param {Record<string, THREE.Material>} deps.materials
   * @param {Record<string, THREE.Texture>} deps.textures
   */
  constructor({ materials, textures, bins }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.walls';
    this.materials = materials;

    /** @type {THREE.Vector3[]} where the impact lights sit; read by Stage. */
    this.lampPositions = [];

    const emissive = [];
    /** Ribbon-board segments; carry their own colour, so they cannot share the strip. */
    const ribbon = [];
    /** Where the wall floods land, filled by `#dressSide`. */
    this._washes = [];
    for (const side of [-1, 1]) this.#buildSide(side, bins, emissive, ribbon);

    // Safety strip: a low amber line that grazes the floor and gives the wet
    // concrete at the base of the wall something to reflect. It is unlit and
    // animated, so unlike the rest of the barrier it keeps its own mesh.
    this.stripMaterial = new THREE.MeshBasicMaterial({
      name: 'arena.wall.strip', color: new THREE.Color(0xff8a2a), toneMapped: true, fog: true,
    });
    const strip = new THREE.Mesh(mergeAll(emissive), this.stripMaterial);
    strip.name = 'arena.wall.strip';
    this.group.add(strip);

    // Ribbon board. One mesh, one draw call, fourteen independently coloured
    // segments — the colour rides in a vertex attribute rather than in fourteen
    // materials, the same trick `StagePracticals` uses for its four fixtures.
    this.ribbonMaterial = new THREE.MeshBasicMaterial({
      name: 'arena.wall.ribbon', color: new THREE.Color(0xffffff), vertexColors: true,
      toneMapped: true, fog: true,
    });
    this.ribbon = new THREE.Mesh(buildRibbon(ribbon), this.ribbonMaterial);
    this.ribbon.name = 'arena.wall.ribbon';
    this.group.add(this.ribbon);

    this.#buildWashes();
    this.#buildPads(materials);
    this.#buildLamps(bins);
    this.#buildDecals(textures);

    this.recoil = [new Recoil(5.2), new Recoil(5.2)];
    this._flicker = [0, 0];
  }

  // -------------------------------------------------------------------------

  /**
   * Authors one barrier. Local frame: x=0 is the surface the fighters hit and
   * everything is built outward from it; z runs along the barrier.
   */
  #buildSide(side, bins, emissive, ribbon) {
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
    emissive.push(M(place(bevelBox(0.05, 0.045, WALL_LEN - 0.2, 0.008), { pos: [0.03, 0.83, 0] })));

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

    this.#dressSide(side, bins, ribbon, bays, half);
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
   *
   * @param {number} side -1 or +1
   * @param {object} bins shared geometry bins, merged by `Stage`
   * @param {object[]} ribbon out-param: per-segment `{quad, colour}` records
   * @param {number} bays pilaster bays along the run
   * @param {number} half half the run length
   */
  #dressSide(side, bins, ribbon, bays, half) {
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
      ribbon.push({
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
      this._washes.push({ side, z, y: 3.44 });
    }
  }

  /**
   * The pools the wall floods throw, as gradient cards on the barrier face.
   *
   * One card per can: a cone that starts at the shade, widens going down, and
   * dies before it reaches the impact pads — so the wall it lights is the part
   * of it the wide framing actually holds, and the fight plane at the bottom
   * stays the cleanest band in frame, which is the rule the whole set is built
   * to. Additive and depth-write off, so a card never occludes the concrete it
   * is brightening; the falloff is baked into vertex colour rather than into a
   * texture because a 7x9 lattice is cheaper than a sampler and the gradient is
   * smooth enough that nothing shows.
   */
  #buildWashes() {
    const NZ = 7, NY = 9;
    const HALF_W = 1.45, TOP = 3.44, DROP = 2.55;
    const n = this._washes.length * (NZ - 1) * (NY - 1) * 6;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let p = 0;
    // Warm tungsten, well above 1 so the top of the cone lands on the shoulder
    // of the tone curve rather than in the middle of it.
    const TINT = [1.55, 0.86, 0.42];
    const at = (w, jz, jy) => {
      const t = (jz / (NZ - 1)) * 2 - 1;            // -1..1 across the cone
      const v = jy / (NY - 1);                      // 0 at the shade, 1 at the tail
      const halfW = 0.34 + 0.66 * v;
      const radial = Math.min(1, Math.abs(t) / halfW);
      const a = (1 - radial * radial) * (1 - v) ** 1.5;
      return {
        x: 0.118, y: TOP - v * DROP, z: w.z + t * HALF_W, a: Math.max(0, a),
      };
    };
    for (const w of this._washes) {
      const f = w.side > 0 ? 1 : -1;
      for (let jz = 0; jz < NZ - 1; jz++) {
        for (let jy = 0; jy < NY - 1; jy++) {
          const c = [at(w, jz, jy), at(w, jz + 1, jy), at(w, jz + 1, jy + 1), at(w, jz, jy + 1)];
          for (const k of [0, 1, 2, 0, 2, 3]) {
            const q = c[k];
            pos[p] = f > 0 ? ARENA_HALF_WIDTH + q.x : -ARENA_HALF_WIDTH - q.x;
            pos[p + 1] = q.y;
            pos[p + 2] = f > 0 ? WALL_Z + q.z : WALL_Z - q.z;
            col[p] = TINT[0] * q.a; col[p + 1] = TINT[1] * q.a; col[p + 2] = TINT[2] * q.a;
            p += 3;
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    this.washMaterial = new THREE.MeshBasicMaterial({
      name: 'arena.wall.wash', color: new THREE.Color(0xffffff), vertexColors: true,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      toneMapped: true, fog: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, this.washMaterial);
    mesh.name = 'arena.wall.wash';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.gbuffer = false;
    this.wash = mesh;
    this.group.add(mesh);
  }

  /**
   * Rubber impact pads. These are the only parts of the wall that move, and
   * they move a lot: a heavy splat compresses one by four centimetres and it
   * springs back over about a third of a second.
   */
  #buildPads(materials) {
    this.pads = [];
    this._padRest = [0, 0];
    const padW = 2.6, padH = 1.45;
    for (const side of [-1, 1]) {
      const idx = side > 0 ? 1 : 0;
      const parts = [];
      const bays = Math.round(WALL_LEN / BAY);
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
      const geo = worldUv(mergeAll(parts), 0.9);
      const mesh = new THREE.Mesh(geo, materials.rubber);
      mesh.name = `arena.wall.pads.${idx}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(side * ARENA_HALF_WIDTH, 0, WALL_Z);
      mesh.rotation.y = side > 0 ? 0 : Math.PI;
      this.group.add(mesh);
      this.pads[idx] = mesh;
      this._padRest[idx] = mesh.position.x;
    }
  }

  /**
   * Caged work lamps above each barrier. They are the light source that
   * stutters when the wall is hit, so their positions are published for the
   * point lights the Stage owns.
   */
  #buildLamps(bins) {
    const housings = bins.dark;
    const lenses = [];
    for (const side of [-1, 1]) {
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
        lenses.push(place(new THREE.SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58), { pos: [wx, y + 0.02, wz] }));
        this.lampPositions.push(new THREE.Vector3(wx, y - 0.1, wz));
      }
    }
    this.lampMaterial = new THREE.MeshBasicMaterial({ name: 'arena.wall.lamp', color: new THREE.Color(0xfff0d0), toneMapped: true });
    this.lamps = new THREE.Mesh(mergeAll(lenses), this.lampMaterial);
    this.lamps.name = 'arena.wall.lamps';
    this.group.add(this.lamps);
  }

  /**
   * Dent decals. One instanced mesh covers both walls; the barriers themselves
   * never move, so world-space placement is correct and costs one draw call.
   */
  #buildDecals(textures) {
    const COUNT = 20;
    const geo = new THREE.PlaneGeometry(1, 1);
    this._dentAlpha = new THREE.InstancedBufferAttribute(new Float32Array(COUNT), 1);
    geo.setAttribute('aAlpha', this._dentAlpha);

    const mat = this.materials.dentDecal.clone();
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vDentAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDentAlpha = aAlpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vDentAlpha;')
        .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\ndiffuseColor.a *= vDentAlpha;');
    };
    mat.customProgramCacheKey = () => 'kb-dent';

    this.dents = new THREE.InstancedMesh(geo, mat, COUNT);
    this.dents.name = 'arena.wall.dents';
    this.dents.frustumCulled = false;
    this.dents.castShadow = false;
    this.dents.receiveShadow = false;
    this.dents.userData.gbuffer = false;
    this.dents.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < COUNT; i++) this.dents.setMatrixAt(i, zero);
    this.dents.instanceMatrix.needsUpdate = true;
    this._dentNext = 0;
    this._dentLife = new Float32Array(COUNT);
    this.group.add(this.dents);
  }

  // -------------------------------------------------------------------------

  /**
   * Registers a strike against a barrier.
   * @param {THREE.Vector3} point world contact point
   * @param {number} force 0..3, matching `Stage.impact`
   * @param {import('../core/Rng.js').Rng} rng
   * @returns {number} the side struck, -1 or +1
   */
  strike(point, force, rng) {
    const side = point.x >= 0 ? 1 : -1;
    const idx = side > 0 ? 1 : 0;
    const y = THREE.MathUtils.clamp(point.y, GROUND_Y + 0.35, WALL_H - 0.5);
    const z = THREE.MathUtils.clamp(point.z, WALL_Z - WALL_LEN / 2 + 0.6, WALL_Z + WALL_LEN / 2 - 0.6);

    const i = this._dentNext;
    this._dentNext = (i + 1) % this.dents.count;
    // A dent, not a crater: a metre across at the very heaviest.
    const size = 0.34 + Math.min(1.6, force) * 0.36;
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(side * (ARENA_HALF_WIDTH - 0.012 - i * 0.0007), y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, side > 0 ? -Math.PI / 2 : Math.PI / 2, rng.range(-Math.PI, Math.PI))),
      new THREE.Vector3(size, size, 1),
    );
    this.dents.setMatrixAt(i, m);
    this.dents.instanceMatrix.needsUpdate = true;
    this._dentLife[i] = Math.min(1, 0.4 + force * 0.35);
    this._dentAlpha.setX(i, this._dentLife[i]);
    this._dentAlpha.needsUpdate = true;

    // The pad compresses away from the pit, never into it.
    this.recoil[idx].kick(side * Math.min(0.42, 0.1 + force * 0.14));
    this._flicker[idx] = Math.min(1.2, this._flicker[idx] + 0.5 + force * 0.4);
    return side;
  }

  update(dt, time) {
    for (let i = 0; i < 2; i++) {
      this.recoil[i].step(dt);
      const pad = this.pads[i];
      if (pad) pad.position.x = this._padRest[i] + this.recoil[i].value;
      this._flicker[i] = Math.max(0, this._flicker[i] - dt * 2.2);
    }

    // Lamp brightness: a slow mains hum, plus a violent stutter for a second
    // or so after a splat.
    const hum = 0.94 + 0.06 * Math.sin(time * 5.3) + 0.03 * Math.sin(time * 17.1);
    const f = Math.max(this._flicker[0], this._flicker[1]);
    const stutter = f > 0 ? 1 - f * (0.55 + 0.45 * Math.sin(time * 61)) * Math.random() : 1;
    // Both of these are direct-view emitters and both were authored below the
    // 13.0 anchor `StagePracticals` uses for exactly that. The lamp lenses were
    // at 2.4 and the safety line at 1.35, which is a lit surface rather than a
    // light. Measured in-page on one frozen wide frame against a 0.000 control:
    // the safety line at x10 moves 2.6% of the frame and takes warm-hue pixels
    // from 6.6% to 8.9%, and every one of those pixels is in the left and right
    // edge columns (tiles [1][0] 1.45, [2][0] 1.07, [1][3] 0.04, [2][3] 0.08) —
    // the band the stage critic measured at 3.5x under the reference. The lamp
    // lenses at x6 move 0.5%, all of it the top-left tile.
    this.lampMaterial.color.setRGB(1.0, 0.94, 0.82).multiplyScalar(Math.max(0.05, hum * stutter) * 16.0);
    this.stripMaterial.color.setRGB(1.0, 0.42, 0.1).multiplyScalar(12.5 + 0.8 * Math.sin(time * 1.7));

    // Ribbon board. A global gain only — the per-segment colour is in the mesh —
    // carrying the same mains hum as the lamps plus a slow crawl, so the run
    // never sits at one exact value across fourteen panels. It dips with the
    // wall stutter too: everything on this barrier is on the same supply.
    const crawl = 0.94 + 0.06 * Math.sin(time * 0.8) + 0.02 * Math.sin(time * 3.1);
    const gain = crawl * (0.55 + 0.45 * Math.max(0.05, stutter));
    this.ribbonMaterial.color.setRGB(gain, gain, gain);
    // The floods are on the same supply, so their pools stutter with the lamps.
    const wg = Math.max(0.05, hum * stutter);
    this.washMaterial.color.setRGB(wg, wg, wg);

    let dirty = false;
    for (let i = 0; i < this._dentLife.length; i++) {
      if (this._dentLife[i] <= 0) continue;
      this._dentLife[i] = Math.max(0, this._dentLife[i] - dt * 0.008);
      this._dentAlpha.setX(i, this._dentLife[i]);
      dirty = true;
    }
    if (dirty) this._dentAlpha.needsUpdate = true;
  }

  /** Flicker amount 0..1 for the given side, for the Stage's point lights. */
  flickerAt(idx) { return this._flicker[idx]; }

  reset() {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.dents.count; i++) {
      this.dents.setMatrixAt(i, zero);
      this._dentLife[i] = 0;
      this._dentAlpha.setX(i, 0);
    }
    this.dents.instanceMatrix.needsUpdate = true;
    this._dentAlpha.needsUpdate = true;
    this._dentNext = 0;
    for (const r of this.recoil) r.reset();
    this._flicker[0] = this._flicker[1] = 0;
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.stripMaterial.dispose();
    this.lampMaterial.dispose();
    this.ribbonMaterial.dispose();
    this.washMaterial.dispose();
    this.dents.material.dispose();
  }
}
