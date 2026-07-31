/**
 * Knockbots — the hangar itself: mid-ground, background and the things in it
 * that move.
 *
 * The fight happens in a recessed test pit. Everything in this file exists to
 * put that pit somewhere, and it is organised by how far away it is, because
 * depth is the entire job:
 *
 *   - **0–3m beyond the barriers**: the back kerb, its mesh fence, and a crowd
 *     of onlookers pressed against it. Read as pure silhouette.
 *   - **3–12m**: the machinery bank, the columns, stacked containers, pipe
 *     runs, catwalks at 5.7m and roof trusses at 12m. This band is where the
 *     practicals live, so it is the band that gets the specular detail.
 *   - **20–90m**: the shell wall with its blown-out panels, and through them
 *     three parallaxed layers of city. Those layers are unlit and fade through
 *     their own exponential haze rather than the scene fog, because a fog that
 *     is correct for a 12m room swallows a 60m skyline whole.
 *
 * Six hundred-odd primitives collapse into about a dozen draw calls: every
 * static part is merged by material, the containers and the crowd are
 * instanced, and each city layer is one instanced box.
 */

import * as THREE from 'three';
import { LAYER } from '../core/Constants.js';
import { Rng } from '../core/Rng.js';
import {
  bevelBox, place, mergeAll, worldUv, truss, railing, pipeRun, tube,
  hydraulicRam, crowdFigure, CROWD_ARCHETYPES, insetPanel, boltRow, catenary, spanX,
  portalCrane, chimney, cableTray,
} from './GeoKit.js';
import { BANNER_ROWS } from './StageMaterials.js';

const PIT_BACK = -8.6;      // z of the pit's rear kerb
const PIT_FRONT = 13.6;     // z of the front service edge
const CATWALK_Y = 5.7;
const ROOF_Y = 12.0;
const SHELL_Z = -19.0;      // the hangar's rear shell wall

// Spectator terrace: four treads climbing away from the fence. The crowd
// placement reads the same numbers, so a rank always lands on a step.
const TERRACE_RANKS = 4;
const TERRACE_Z0 = PIT_BACK - 0.6;   // z of the lowest tread's front edge
const TERRACE_BACK = PIT_BACK - 4.6; // z the terrace runs back to
const TERRACE_RUN = 0.9;             // tread depth
const TERRACE_RISE = 0.42;
const TERRACE_Y0 = 1.15;             // top of the lowest tread
const TERRACE_TOP = TERRACE_Y0 + (TERRACE_RANKS - 1) * TERRACE_RISE;

const MACHINE_Z = -13.9;    // front face of the machinery bank

/**
 * Crowd clothing. Working coats, denim, waxed cotton and two hi-vis pieces —
 * the palette of people who walked in off an industrial estate, kept dark
 * enough that nobody out-reads the fighters but hued enough that overlapping
 * silhouettes still separate.
 */
const CROWD_PALETTE = [
  0x1c222c, 0x121824, 0x25303e, 0x18262f, 0x2e2620, 0x38231a,
  0x1e2a22, 0x3c372e, 0x4a2422, 0x3b3f45, 0x4d483f, 0x0e1015,
  0x2a2029, 0x22333c, 0x2c333a, 0x6a3410,
];

/**
 * The light garments, dealt to roughly one figure in six on top of
 * {@link CROWD_PALETTE}.
 *
 * This palette exists because the crowd was measurably flat in a way the five
 * albedo bands could not fix. Every entry in the three garment palettes above
 * lands between linear luminance 0.005 and 0.066 — the brightest coat in the
 * set is darker than a photographic grey card — so the bands, the hues and the
 * per-instance jitter were all modulating *within* the bottom fourteenth of the
 * range, and the eye resolves that as one value however many hues are in it.
 *
 * Measured against `ref/tekken8/tekken8_08.jpg`, the closest-framed reference
 * (a cage arena, crowd behind a chain fence, same shot category), mean 8x8 luma
 * standard deviation over the background band:
 *
 *     Knockbots  0.0275        Tekken 8  0.0699
 *     background mean luma      0.244              0.202
 *
 * The reference crowd is *darker on average and two and a half times as
 * contrasty*, which is the combination a uniformly-dark palette cannot produce.
 * It gets there by being long-tailed rather than wide: most of the stand is
 * darker than ours, and one person in six is wearing a pale work shirt, a cream
 * jacket or hi-vis. Those few are what the eye uses to read the mass as people.
 *
 * So this is a tail, not a widening — held to a sixth so the stand's mean stays
 * where the previous pass put it, and deliberately warm-biased, since 90% of
 * the frame's saturated pixels are cyan.
 *
 * Measured five captures on against five off, at the wide framing, same shot
 * list both sides (the list matters: capturing `06-stage-wide` without
 * `01-hero-idle` ahead of it leaves the camera in a different state and shifts
 * every number in this block):
 *
 *                        off                 on
 *     detail, band       0.0269 +- 0.0013    0.0287 +- 0.0006     +6.7%
 *     detail, top fifth  0.0219              0.0247              +12.7%
 *     mean luma, band    0.2453              0.2450                flat
 *
 * So: a real but modest +6.7% over the band and +12.7% over the top fifth,
 * which is where the deficit is worst, bought at no cost in the background's
 * mean luminance — and no triangles, no draw call and no light. It closes a few
 * per cent of a 2.6x gap. It is not on its own a point, and the honest read of
 * the remaining gap is in {@link CROWD_HIGHLIGHT_RATE} and in the note on the
 * frame edges below.
 *
 * One caution for whoever measures here next: a single capture cannot see an
 * effect this size. Run-to-run spread on this metric is about 6% at the wide
 * framing and about 9% at the fight framing, and the fight framing occasionally
 * returns a black frame outright. The first pass at this change was read off one
 * capture each way and appeared to *lower* the background mean by 5%; five
 * captures each way showed that was noise and the mean is simply flat.
 */
const CROWD_HIGHLIGHT = [
  0x8e9298, 0x7f8a94, 0x9a6a3c, 0x6f7d88, 0xa8a49c, 0xc06a2a,
  0xb0b8bd, 0x8a7f6a, 0x6e7a86, 0xa2906f,
];

/**
 * Fraction of the stand dealt a {@link CROWD_HIGHLIGHT} coat.
 *
 * A sixth, and a sixth is where it saturates. Doubling this to 0.34 and adding
 * a matching light tail to the trousers and the shoes/hats was measured at the
 * wide framing and bought nothing: background local contrast went 0.0295 to
 * 0.0290 — inside run-to-run noise — while the background's mean luminance rose
 * 0.232 to 0.261, which is the one number this palette is not allowed to spend.
 * The stand is about a quarter of the band, so past a sixth of it the tail is
 * repainting pixels that are already carrying contrast and lifting the mass
 * everywhere else. Reverted to the measurement.
 */
const CROWD_HIGHLIGHT_RATE = 0.17;

/**
 * Where the rest of the stage-detail gap actually is, measured, for whoever
 * picks this up next.
 *
 * The frame was divided into a 6x5 grid and each cell scored on mean 8x8 luma
 * standard deviation, against `ref/tekken8/tekken8_08.jpg` — a cage arena with
 * a crowd behind a chain fence, which is the closest-framed reference in the
 * set. Top row of the grid, left to right:
 *
 *     Knockbots  0.015  0.017  0.027  0.024  0.025  0.016
 *     Tekken 8   0.052  0.066  0.104  0.108  0.076  0.062
 *
 * Two things fall out of that, and neither is the one the crowd fixes.
 *
 * **The floor is already there.** Bottom two rows measure 0.021-0.033 against
 * the reference's 0.021-0.029. The deck, its reflection and its wear are at
 * parity and do not want more work; every remaining point on this axis is above
 * the barrier line.
 *
 * **The deficit is worst at the left and right edges, and it is a set problem
 * rather than a shading one.** The two edge cells are 3.5x below reference,
 * further below than anything in the middle. The reason is visible the moment
 * the two frames are put side by side: in the reference the crowd wraps the full
 * width of the shot, so the frame edges are full of people, banners and cage
 * posts. Here the terrace spans x -11.9..11.9 and the big riveted wall occludes
 * everything outboard of it, so the left quarter of the frame is one flat plane
 * with two recessed panels on it and the right is mostly dark truss. Both are
 * competently made and both are empty. Whatever is put there wants to be
 * instanced and traded against existing triangles — the set is at 919k against
 * a 900k budget — and a fixture or a sign carries hue as well as contrast, which
 * is the other measured gap: this frame holds 2 major hue bins against the
 * reference's 4, with 90% of its saturated pixels cyan.
 *
 * Two things that look like the gap and are not. The highlight population is
 * fixed: the wide framing now sits at a 99.9th percentile of 0.944 against a
 * reference band of 0.90-0.999, so `LAMP_ANCHOR` in `StagePracticals` did its
 * job and there is nothing left there. And the frame holds no pixel above 0.95
 * at all, which looks alarming and is not actionable from this file — it is the
 * AgX shoulder in `RenderPipeline` compressing asymptotically, and the same
 * pipeline clips to white fine on `04-impact` and `07-super`.
 */

/**
 * Trousers. Not the coat colour dropped toward a common dark — that was the
 * previous scheme and it is why a populated terrace still read as a row of
 * shapes: every figure came out as one hue at two brightnesses, which the eye
 * resolves as one value at twelve metres. Legs are their own palette, mostly
 * denim and dark workwear, and crucially they are dealt *independently* of the
 * coat, so a rust jacket over blue jeans and a blue jacket over black trousers
 * are two different people rather than two exposures of one.
 */
const CROWD_LEGS = [
  0x1a2130, 0x243044, 0x101318, 0x2b3038, 0x232019, 0x2f3542,
  0x0d0f13, 0x1b1d21, 0x33301f, 0x16233a, 0x262a2e, 0x1c1712,
  0x2a2d33, 0x141b2a, 0x372f26, 0x11141a,
];

/**
 * Shoes, hats and bags. The two ends of a person are reliably the darkest thing
 * they have on, and holding them out of both garment tints is what stops a pale
 * coat running straight into a pale hat and swallowing the head.
 */
const CROWD_KIT = [
  0x0a0a0c, 0x131316, 0x1b1206, 0x0e1418, 0x2a2118, 0x101820, 0x1f1c19, 0x080a0d,
];

/**
 * Skin, held out of the clothing tint by the figure's own vertex mask.
 *
 * Deliberately dim and low in chroma. An earlier pass ran these two stops
 * brighter and the result was forty orange ovals floating in a dark band — the
 * faces became the highest-contrast feature anywhere in the frame, which is
 * both wrong for a crowd standing twelve metres back behind a fence in an
 * unlit stand, and the exact reason the crowd read as mannequins. A face wants
 * to be *findable*, about a stop over the coat it sits on, not the brightest
 * thing on screen.
 */
const CROWD_SKIN = [0x7a6250, 0x66493a, 0x4b3326, 0x33221a, 0x8b7260, 0x573e2e];

/**
 * Hair. Three quarters of it is within a hair's breadth of black, because that
 * is what hair is under a cyan practical; the light browns and the one grey are
 * there so that a rank of heads is not a rank of identical dark caps.
 */
const CROWD_HAIR = [
  0x0b0908, 0x100c0a, 0x0e0b0c, 0x1a1210, 0x241a13, 0x2e2119,
  0x3a2c1e, 0x141414, 0x4a4640, 0x18100c, 0x0d0c10, 0x2a1c14,
];

/** Stand-in until each city layer's own shader is built a few lines later. */
const PLACEHOLDER = new THREE.MeshBasicMaterial();

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _one = new THREE.Vector3(1, 1, 1);

export class StageStructure {
  /**
   * @param {object} deps
   * @param {Record<string, THREE.Material>} deps.materials
   * @param {object} deps.bins shared geometry bins, merged by the Stage
   * @param {'ultra'|'high'|'medium'|'low'} [deps.quality]
   */
  constructor({ materials, bins, quality = 'high' }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.structure';
    this.materials = materials;
    this.quality = quality;
    this.rng = new Rng(0x4b4e4f43);

    /** Shared clock for every shader-side animation in the set. */
    this.timeUniform = { value: 0 };
    /** Linear radiance the mid and far layers fade toward; follows the mood. */
    this.midgroundHaze = { value: new THREE.Color(0x131b26) };

    // Static geometry goes into the arena-wide bins; the Stage merges every
    // producer's contributions into one mesh per material at the end of init.
    this.bins = bins;

    this.#backEdge();
    this.#frontEdge();
    this.#columnsAndRoof();
    this.#catwalks();
    this.#machineryBank();
    this.#backServices();
    this.#pipework();
    this.#shellWall();
    this.#outerShell();
    this.#fanShroud();
    this.#hangingCable();

    this.#midground();
    this.#backdrop();
    this.#foreground();

    this.#containers();
    this.#crowd(quality);
    this.#city(quality);
    this.#fan();
    this.#drones();
    this.bins = null;

    /**
     * Meshes the floor's mirror pass skips. Everything here stands either
     * behind the terrace or above the roof line, so the only part of the deck
     * that could carry its reflection is the strip already occluded by the
     * barrier it sits behind. The crowd, the skyline and the backdrop are on
     * `LAYER.NO_REFLECT` and do not need to be listed.
     * @type {THREE.Object3D[]}
     */
    this.noReflect = [this.midground, this.foreground, this.containers, this.fan, this.drones, this.droneLights];
  }

  // -------------------------------------------------------------------------
  // Near field
  // -------------------------------------------------------------------------

  /**
   * The pit's rear kerb, its fence, and the terrace the crowd stands on.
   *
   * The kerb runs the whole width of frame directly behind the fighters, which
   * makes it the surface the eye spends the most time on after the floor and
   * the fighters themselves. Left as the bare box it started as, it was
   * twenty-four metres of unbroken grey — the mid-ground reading as a smooth
   * extrusion, which is the plainest version of the complaint against this
   * stage. So it is fabricated rather than modelled: a bolted base angle, six
   * dressed panels with cover strips over the movement joints between them, a
   * conduit run on saddle clamps feeding two junction boxes, and a base plate
   * with gussets and bolts under every fence post. None of it is decoration —
   * it is the list of things that would actually be on a barrier like this, and
   * it costs nothing because every piece lands in a bin that was already being
   * merged.
   */
  #backEdge() {
    const W = 24;
    const b = this.bins;
    const face = PIT_BACK;  // camera-side face of the kerb
    b.concrete.push(place(bevelBox(W, 1.15, 0.6, 0.03), { pos: [0, 0.575, PIT_BACK - 0.3] }));
    b.steel.push(place(bevelBox(W, 0.1, 0.72, 0.02), { pos: [0, 1.2, PIT_BACK - 0.3] }));

    this.#barrierPanels(W, face);
    this.#barrierFabrication(W, face);
    this.#barrierCapping(W, face);

    // Spectator terrace. Four steps rather than one shelf, because a crowd on
    // a single level is a row: every figure sits at one height, occludes its
    // neighbours edge-on and gives the eye nothing to sort front from back
    // with. Stepping them puts each rank's heads clear of the rank in front,
    // which is both what a real stand does and the only way overlapping
    // silhouettes read as depth instead of clutter.
    for (let i = 0; i < TERRACE_RANKS; i++) {
      const front = TERRACE_Z0 - i * TERRACE_RUN;
      const h = TERRACE_Y0 + i * TERRACE_RISE;
      // Each tread is a whole box running back to the rear wall, so the flanks
      // would otherwise be four coincident faces fighting for the same depth.
      // Two centimetres of stagger costs nothing and settles it.
      b.concrete.push(place(bevelBox(W - i * 0.04, h, front - TERRACE_BACK, 0.03), {
        pos: [0, h / 2, (front + TERRACE_BACK) / 2],
      }));
      // Nosing on the step edge: the one line that catches the practicals and
      // separates one tread from the next at twelve metres.
      b.steel.push(place(bevelBox(W, 0.05, 0.1, 0.015), {
        pos: [0, TERRACE_Y0 + i * TERRACE_RISE - 0.02, front + 0.05],
      }));
    }

    const fenceH = 2.3;
    const fence = new THREE.PlaneGeometry(W, fenceH);
    const uv = fence.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (W / 2.4), uv.getY(i) * (fenceH / 2.4));
    b.chain.push(place(fence, { pos: [0, 1.25 + fenceH / 2, PIT_BACK - 0.66] }));
    for (let i = -6; i <= 6; i++) {
      b.steel.push(place(new THREE.CylinderGeometry(0.05, 0.05, fenceH + 0.2, 8), {
        pos: [i * 2, 1.25 + fenceH / 2, PIT_BACK - 0.66],
      }));
    }
    b.steel.push(place(new THREE.CylinderGeometry(0.055, 0.055, W, 8), {
      pos: [0, 1.25 + fenceH, PIT_BACK - 0.66], rot: [0, 0, Math.PI / 2],
    }));
  }

  /**
   * The event dressing on the barrier: six printed panels, seams covered.
   *
   * The panels are the reason the barrier reads as a built thing rather than an
   * extrusion. Six of them across twenty-four metres puts a vertical break every
   * four metres — close enough that the eye never travels more than a fighter's
   * width along an unbroken edge — and each one carries a different band of the
   * banner atlas, so the run does not repeat across frame. They are cut at 8:1
   * because that is the aspect each band of the atlas is authored at; anything
   * else stretches the type.
   *
   * The v remap is the whole trick: one texture, four legends, and a panel picks
   * its band by squeezing its own v into that band's slice.
   *
   * There are six bays and four legends, and an earlier pass resolved that by
   * repeating two of them — which put `knockbots industrial league` on screen
   * twice in the same frame. Repetition the viewer can *read* is the worst kind
   * there is: the eye forgives a tiling concrete texture and never forgives the
   * same sentence twice. So two bays stop being signs and start being
   * infrastructure instead: a personnel gate and an equipment bay. Four bays,
   * four legends, each exactly once — and the two that gave up their banner are
   * now the only places on twenty-four metres of barrier that say anything about
   * how the venue is actually operated.
   */
  #barrierPanels(W, face) {
    const b = this.bins;
    const COUNT = 6;
    const pitch = W / COUNT;          // 4m bay
    const gap = 0.16;                 // movement joint between panels
    const pw = pitch - gap;
    const ph = pw / 8;                // the aspect the atlas bands are drawn at
    const y = 0.66;                   // clear of the base angle, under the cap
    // Bay contents. The coloured legends land mid-frame where they are actually
    // read from; the dark ones take the outer ends so the edge of frame does not
    // out-contrast the fighters. `null` is a bay that carries hardware instead.
    const bays = [2, null, 0, 1, null, 3];

    for (let i = 0; i < COUNT; i++) {
      const x = -W / 2 + pitch * (i + 0.5);
      const r = bays[i];
      if (r === null) {
        // Bay 1 is the way in and out; bay 4 is where the power and the fire kit
        // live. Both are dressed at the same height the banners occupy, so the
        // run still reads as one band rather than a fence with holes in it.
        if (i < COUNT / 2) this.#barrierGate(x, y, ph, pw, face);
        else this.#barrierEquipment(x, y, ph, pw, face);
        continue;
      }
      const geo = new THREE.PlaneGeometry(pw, ph);
      const uv = geo.attributes.uv;
      for (let k = 0; k < uv.count; k++) {
        // Inset a hair inside the band so a mip never bleeds the neighbour's
        // ground colour across the seam.
        uv.setXY(k, uv.getX(k), (r + 0.02 + uv.getY(k) * 0.96) / BANNER_ROWS);
      }
      b.banner.push(place(geo, { pos: [x, y, face + 0.012] }));
    }

    // Cover strips over every joint, and returns at both ends. A movement joint
    // on a real barrier is never left open — it is capped, and the cap is the
    // line that makes the panel read as a panel rather than a printed stripe.
    for (let i = 0; i <= COUNT; i++) {
      const x = -W / 2 + pitch * i;
      b.steel.push(place(bevelBox(gap + 0.06, ph + 0.1, 0.05, 0.012), {
        pos: [x, y, face + 0.02],
      }));
      b.steel.push(place(boltRow(ph - 0.08, 3, 0.018, 0.012), {
        pos: [x, y, face + 0.045], rot: [0, 0, Math.PI / 2],
      }));
    }
  }

  /**
   * The personnel gate: how anyone actually gets into the pit.
   *
   * A barrier with no way through it is a wall, and a wall around a venue people
   * walk into is a set-dressing mistake the eye catches without being able to say
   * why. The parts are the ones that would be there — a leaf hung in a frame on
   * two hinges, a drop bolt into a floor socket, a kick plate, and a diagonal
   * brace so the leaf does not rack — and between them they put a *vertical* run
   * of detail into a band that is otherwise entirely horizontal, which is worth
   * as much compositionally as it is narratively.
   */
  #barrierGate(x, y, ph, pw, face) {
    const b = this.bins;
    const gw = pw * 0.62;             // the leaf; the rest of the bay stays panel
    const z = face + 0.05;
    const lx = x - pw / 2 + gw / 2 + 0.1;

    // Frame: two jambs and a head, standing proud of the panel line.
    for (const s of [-1, 1]) {
      b.steel.push(place(bevelBox(0.09, ph + 0.14, 0.11, 0.015), { pos: [lx + s * gw / 2, y, z] }));
    }
    b.steel.push(place(bevelBox(gw + 0.18, 0.08, 0.11, 0.015), { pos: [lx, y + ph / 2 + 0.07, z] }));

    // The leaf, set back in its frame, with a rail top and bottom.
    b.dark.push(place(bevelBox(gw - 0.06, ph - 0.04, 0.05, 0.012), { pos: [lx, y, z - 0.035] }));
    for (const dy of [-1, 1]) {
      b.steel.push(place(bevelBox(gw - 0.06, 0.06, 0.06, 0.012), { pos: [lx, y + dy * (ph / 2 - 0.05), z - 0.01] }));
    }
    // Diagonal brace, hinge corner to latch corner — the direction a real leaf
    // is braced, rising away from the hinge it hangs on.
    const br = spanX([lx - gw / 2 + 0.08, y - ph / 2 + 0.06, z], [lx + gw / 2 - 0.08, y + ph / 2 - 0.06, z]);
    b.steel.push(place(bevelBox(br.length, 0.05, 0.045, 0.01), { pos: br.pos, rot: br.rot }));

    // Two hinges on the left jamb, a lever handle and a drop bolt on the right.
    for (const dy of [-0.3, 0.3]) {
      b.steel.push(place(new THREE.CylinderGeometry(0.032, 0.032, 0.14, 8), { pos: [lx - gw / 2, y + dy * ph, z + 0.02] }));
      b.steel.push(place(bevelBox(0.11, 0.05, 0.03, 0.008), { pos: [lx - gw / 2 + 0.05, y + dy * ph, z + 0.02] }));
    }
    b.steel.push(place(bevelBox(0.05, 0.16, 0.04, 0.01), { pos: [lx + gw / 2 - 0.11, y + 0.02, z + 0.03] }));
    b.steel.push(place(new THREE.CylinderGeometry(0.02, 0.02, 0.13, 7), {
      pos: [lx + gw / 2 - 0.155, y + 0.02, z + 0.055], rot: [0, 0, Math.PI / 2],
    }));
    // Drop bolt into its floor socket, thrown home.
    b.steel.push(place(new THREE.CylinderGeometry(0.019, 0.019, ph * 0.62, 7), { pos: [lx + gw / 2 - 0.14, y - ph * 0.42, z + 0.03] }));
    b.steel.push(place(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 9), { pos: [lx + gw / 2 - 0.14, 0.03, face + 0.13] }));

    // Kick plate and the leading edge of the leaf, both hazard-striped.
    //
    // This is the part that makes the bay work rather than merely exist. Built in
    // steel and dark metal the whole gate came out the same value as the
    // shadowed concrete around it, so the bay read as a hole punched in the
    // banner run — two dead zones traded for one repeated legend, which is no
    // trade at all. Stripes are what an actual gate in an actual barrier carries,
    // and they are the only thing at this distance with enough value contrast to
    // say *gate* instead of *gap*.
    b.hazard.push(place(bevelBox(gw - 0.14, 0.13, 0.025, 0.006), { pos: [lx, y - ph / 2 + 0.09, z - 0.005] }));
    b.hazard.push(place(bevelBox(0.1, ph - 0.06, 0.055, 0.01), { pos: [lx + gw / 2 - 0.06, y, z - 0.005] }));
    this.#barrierPlacard(lx + gw / 2 + 0.16, y + 0.06, face);
  }

  /**
   * The equipment bay: the power disconnect, the fire point and the cable inlet.
   *
   * Everything in the pit is fed from somewhere and nothing in the set said
   * where. This is that answer, and it earns its bay by being the one place on
   * the barrier with real depth — a cabinet standing 200mm off the face throws a
   * shadow the flat panels cannot, which is what stops this band reading as a
   * printed stripe when the key light rakes along it.
   */
  #barrierEquipment(x, y, ph, pw, face) {
    const b = this.bins;
    const z = face + 0.02;

    // Fire point: a cabinet with a proud door, hinge line and drop catch.
    const fx = x - pw * 0.28;
    b.dark.push(place(bevelBox(0.52, ph * 0.92, 0.2, 0.02), { pos: [fx, y, z + 0.1] }));
    b.steel.push(place(bevelBox(0.46, ph * 0.86, 0.03, 0.01), { pos: [fx + 0.02, y, z + 0.21] }));
    b.steel.push(place(new THREE.CylinderGeometry(0.022, 0.022, ph * 0.86, 7), { pos: [fx - 0.22, y, z + 0.21] }));
    b.steel.push(place(bevelBox(0.05, 0.09, 0.035, 0.008), { pos: [fx + 0.22, y - 0.03, z + 0.23] }));
    b.steel.push(place(boltRow(0.42, 4, 0.017, 0.011), { pos: [fx + 0.02, y - ph * 0.4, z + 0.215] }));

    // Rotary disconnect: enclosure, handle boss, and the lever thrown to off.
    // The enclosure is striped because a live isolator is, and because it is the
    // one mark in this bay bright enough to carry it at twelve metres.
    const dx = x + pw * 0.06;
    b.hazard.push(place(bevelBox(0.34, 0.42, 0.17, 0.018), { pos: [dx, y + 0.04, z + 0.085] }));
    b.steel.push(place(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 10), { pos: [dx, y + 0.04, z + 0.19], rot: [Math.PI / 2, 0, 0] }));
    b.steel.push(place(bevelBox(0.14, 0.035, 0.03, 0.008), { pos: [dx + 0.05, y - 0.01, z + 0.215], rot: [0, 0, -0.7] }));
    b.steel.push(place(boltRow(0.26, 2, 0.016, 0.01), { pos: [dx, y - 0.17, z + 0.175] }));

    // Cable inlet: a gland plate and two armoured tails dressed down the face
    // into the base of the barrier, which is where they would actually go.
    const cx = x + pw * 0.34;
    b.steel.push(place(bevelBox(0.24, 0.14, 0.04, 0.01), { pos: [cx, y + ph * 0.3, z + 0.03] }));
    for (const dxx of [-0.06, 0.06]) {
      b.steel.push(place(new THREE.CylinderGeometry(0.026, 0.026, 0.05, 8), { pos: [cx + dxx, y + ph * 0.3, z + 0.07], rot: [Math.PI / 2, 0, 0] }));
      b.dark.push(tube(catenary(
        [cx + dxx, y + ph * 0.28, z + 0.07], [cx + dxx * 2.4, 0.12, face + 0.14], 0.1, 8,
      ), 0.022, 6));
    }
    this.#barrierPlacard(x - pw * 0.46, y + 0.05, face);
  }

  /**
   * A small stencilled sign on the barrier face.
   *
   * The plate texture carries three legends stacked in v; a placard takes one of
   * them by squeezing its own v into that third. Small enough that only its
   * shape and its yellow ink resolve at twelve metres, which is all a safety
   * placard ever does in a photograph of a real venue — the point is that the
   * barrier has them, not that they can be read.
   */
  #barrierPlacard(x, y, face) {
    const geo = new THREE.PlaneGeometry(0.22, 0.28);
    const uv = geo.attributes.uv;
    const r = this.rng.int(3);
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, uv.getX(k), (r + 0.06 + uv.getY(k) * 0.88) / 3);
    }
    this.bins.plate.push(place(geo, { pos: [x, y, face + 0.014] }));
  }

  /**
   * The ironwork the barrier is actually made of: base angle, conduit run, and
   * a proper footing under every fence post.
   *
   * None of this is decoration. It is the list of parts that would be on a
   * barrier like this, and each one earns its place by breaking a silhouette
   * the eye would otherwise read as a single extruded edge: the base angle puts
   * a shadow line along the floor join, the conduit puts a horizontal above the
   * panels that is *not* parallel to the cap, and the post footings turn
   * thirteen cylinders that appear to grow out of the concrete into thirteen
   * things bolted onto it.
   */
  #barrierFabrication(W, face) {
    const b = this.bins;

    // Bolted base angle along the floor join: a vertical leg on the face and a
    // horizontal leg out onto the pit floor, bolted every 1.5m.
    b.steel.push(place(bevelBox(W, 0.16, 0.03, 0.01), { pos: [0, 0.09, face + 0.028] }));
    b.steel.push(place(bevelBox(W, 0.03, 0.14, 0.01), { pos: [0, 0.017, face + 0.085] }));
    b.steel.push(place(boltRow(W - 0.6, 17, 0.026, 0.016), { pos: [0, 0.1, face + 0.045] }));

    // Conduit on saddle clamps, feeding two junction boxes. It sits above the
    // panels and below the steel cap, which is the one horizontal band left
    // undressed, and it is deliberately off-centre in that band so it does not
    // read as a second cap line.
    const cz = face + 0.075;
    const cy = 1.01;
    b.steel.push(place(new THREE.CylinderGeometry(0.035, 0.035, W - 0.4, 8), {
      pos: [0, cy, cz], rot: [0, 0, Math.PI / 2],
    }));
    for (let x = -W / 2 + 0.9; x <= W / 2 - 0.9; x += 1.5) {
      // Saddle clamp: a strap over the conduit into a small pad on the panel.
      b.steel.push(place(bevelBox(0.09, 0.13, 0.02, 0.008), { pos: [x, cy + 0.01, cz - 0.045] }));
      b.steel.push(place(new THREE.TorusGeometry(0.045, 0.011, 5, 10), { pos: [x, cy, cz] }));
    }
    for (const jx of [-5.2, 6.4]) {
      b.steel.push(place(bevelBox(0.3, 0.4, 0.16, 0.015), { pos: [jx, cy - 0.06, cz - 0.02] }));
      b.steel.push(place(boltRow(0.2, 2, 0.02, 0.012), { pos: [jx, cy - 0.06, cz + 0.062] }));
      // Drop from the box down behind the panel line.
      b.steel.push(place(new THREE.CylinderGeometry(0.022, 0.022, 0.34, 6), {
        pos: [jx + 0.11, cy - 0.42, cz - 0.03],
      }));
    }

    // Footings under the fence posts. Same x pitch the posts are built on, so a
    // plate always lands under a post rather than near one.
    const capTop = 1.25;
    const pz = PIT_BACK - 0.66;
    for (let i = -6; i <= 6; i++) {
      const x = i * 2;
      b.steel.push(place(bevelBox(0.26, 0.025, 0.26, 0.008), { pos: [x, capTop + 0.013, pz] }));
      b.steel.push(place(boltRow(0.18, 2, 0.022, 0.014), {
        pos: [x, capTop + 0.026, pz], rot: [-Math.PI / 2, 0, 0],
      }));
      // Two gussets, on the axis the fence is loaded along — a crowd leans on
      // it, so they stiffen front-to-back, not side-to-side.
      for (const dz of [-0.09, 0.09]) {
        b.steel.push(place(bevelBox(0.016, 0.17, 0.1, 0.005), {
          pos: [x, capTop + 0.11, pz + dz],
        }));
      }
    }
  }

  /**
   * The capping on top of the barrier, and the recesses under it.
   *
   * The steel cap is a 24m strip drawn as one bevelled box, and it runs across
   * the frame at exactly the height a standing fighter's chest is. That makes it
   * the longest single edge in the composition and, until now, the flattest: one
   * chamfer, one value, no interruption anywhere along it. Real capping is
   * folded in lengths and spliced, and every splice is a raised plate on four
   * bolts — which is a shadow every four metres along a line the eye tracks the
   * whole width of the shot.
   *
   * The recesses do the same job on the other axis. Below the banner run the
   * kerb is 250mm of unbroken concrete for twenty-four metres; a shallow inset
   * in each bay puts a horizontal shadow into it that follows the key light
   * round as the camera dollies, which a painted line cannot.
   */
  #barrierCapping(W, face) {
    const b = this.bins;
    const capY = 1.25;                 // top of the cap
    const nose = face + 0.055;         // the cap overhangs the panel line
    const bays = 6;
    const pitch = W / bays;

    // A fastener every 250mm along the nose. Individually invisible; together
    // they are the only thing that gives the cap's edge a length.
    b.steel.push(place(boltRow(W - 0.5, 95, 0.019, 0.013), { pos: [0, capY - 0.055, nose] }));

    for (let i = 0; i <= bays; i++) {
      const x = -W / 2 + pitch * i;
      // Splice plate over the joint between two lengths of capping, lapped on
      // top rather than butted, which is how it is actually done.
      b.steel.push(place(bevelBox(0.34, 0.022, 0.78, 0.008), { pos: [x, capY + 0.011, face - 0.29] }));
      for (const dz of [-0.26, 0.26]) {
        b.steel.push(place(boltRow(0.22, 2, 0.021, 0.014), {
          pos: [x, capY + 0.022, face - 0.29 + dz], rot: [-Math.PI / 2, 0, 0],
        }));
      }
      // Return down the front face of the cap, so the splice reads from the
      // fight camera as well as from above.
      b.steel.push(place(bevelBox(0.3, 0.1, 0.03, 0.008), { pos: [x, capY - 0.05, nose + 0.012] }));
    }

    // Recessed kerb panels under the banner run, one per bay.
    for (let i = 0; i < bays; i++) {
      const x = -W / 2 + pitch * (i + 0.5);
      b.concrete.push(place(insetPanel(pitch - 0.52, 0.24, 0.05, 0.055), { pos: [x, 0.28, face - 0.019] }));
    }
  }

  /** Camera-side service edge: a low step, a rail, and a cable tray. */
  #frontEdge() {
    const b = this.bins;
    const W = 26;
    b.concrete.push(place(bevelBox(W, 0.9, 3.2, 0.03), { pos: [0, 0.45, PIT_FRONT + 1.4] }));
    b.steel.push(place(railing(W, { height: 1.05, spacing: 2.0 }), { pos: [0, 0.9, PIT_FRONT + 0.2] }));
    const deck = new THREE.PlaneGeometry(W, 3.2);
    deck.rotateX(-Math.PI / 2);
    const uv = deck.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (W / 0.9), uv.getY(i) * (3.2 / 0.9));
    b.grate.push(place(deck, { pos: [0, 0.905, PIT_FRONT + 1.4] }));
  }

  // -------------------------------------------------------------------------
  // Mid field
  // -------------------------------------------------------------------------

  /** Six lattice columns and the roof trusses they carry. */
  #columnsAndRoof() {
    const b = this.bins;
    for (const x of [-14.2, 14.2]) {
      for (const z of [-10.5, 2.4, 14.0]) {
        // Built-up column: four angles, lacing, a base plate and a cap.
        for (const [dx, dz] of [[-0.28, -0.28], [0.28, -0.28], [-0.28, 0.28], [0.28, 0.28]]) {
          b.dark.push(place(bevelBox(0.16, ROOF_Y, 0.16, 0.02), { pos: [x + dx, ROOF_Y / 2, z + dz] }));
        }
        for (let i = 0; i < 9; i++) {
          const y = 0.8 + i * ((ROOF_Y - 1.4) / 8);
          b.dark.push(place(bevelBox(0.66, 0.08, 0.06, 0.015), { pos: [x, y, z - 0.28], rot: [0, 0, i % 2 ? 0.5 : -0.5] }));
          b.dark.push(place(bevelBox(0.66, 0.08, 0.06, 0.015), { pos: [x, y, z + 0.28], rot: [0, 0, i % 2 ? -0.5 : 0.5] }));
        }
        b.dark.push(place(bevelBox(1.05, 0.16, 1.05, 0.02), { pos: [x, 0.08, z] }));
        b.dark.push(place(boltRow(0.8, 4, 0.04, 0.03), { pos: [x, 0.17, z], rot: [-Math.PI / 2, 0, 0] }));
        b.dark.push(place(bevelBox(0.95, 0.12, 0.95, 0.02), { pos: [x, ROOF_Y - 0.06, z] }));
      }
    }

    // Roof trusses spanning the hall, plus purlins running the other way.
    for (const z of [-10.5, 2.4, 14.0]) {
      b.dark.push(place(truss(29, 1.35, { thickness: 0.07, width: 0.09, bays: 12 }), { pos: [0, ROOF_Y, z] }));
    }
    for (const x of [-11, -5.5, 0, 5.5, 11]) {
      b.dark.push(place(bevelBox(0.1, 0.24, 27, 0.02), { pos: [x, ROOF_Y + 1.5, 2] }));
    }
    // Roof deck, dark and mostly implied — it stops the sky from showing.
    // It deliberately stops short of z = -14: past that are the shell wall's
    // blown-out panels, and the light raking in through them has to get past
    // the roof line to be seen at all.
    b.dark.push(place(bevelBox(48, 0.12, 38, 0.02), { pos: [0, ROOF_Y + 1.75, 5] }));
  }

  /** Catwalks along both long sides, with grating decks and handrails. */
  #catwalks() {
    const b = this.bins;
    for (const side of [-1, 1]) {
      const x = side * 12.4;
      const len = 25;
      b.steel.push(place(truss(len, 0.55, { thickness: 0.05, width: 0.06, bays: 14 }), {
        pos: [x, CATWALK_Y - 0.62, 2], rot: [0, Math.PI / 2, 0],
      }));
      const deck = new THREE.PlaneGeometry(len, 1.5);
      deck.rotateX(-Math.PI / 2);
      const uv = deck.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (len / 0.9), uv.getY(i) * (1.5 / 0.9));
      b.grate.push(place(deck, { pos: [x, CATWALK_Y, 2], rot: [0, Math.PI / 2, 0] }));
      b.steel.push(place(railing(len, { height: 1.05, spacing: 1.9 }), {
        pos: [x - side * 0.72, CATWALK_Y, 2], rot: [0, Math.PI / 2, 0],
      }));
      b.steel.push(place(railing(len, { height: 1.05, spacing: 1.9, toeBoard: false }), {
        pos: [x + side * 0.72, CATWALK_Y, 2], rot: [0, Math.PI / 2, 0],
      }));
      // Access stair down to the deck, at the far end only.
      for (let s = 0; s < 9; s++) {
        b.steel.push(place(bevelBox(1.1, 0.05, 0.3, 0.01), {
          pos: [x + side * 1.4, CATWALK_Y - 0.35 - s * 0.42, -10.2 + s * 0.44], rot: [0, Math.PI / 2, 0],
        }));
      }
    }

    // A cross-gantry over the back of the pit, carrying the overhead light bank
    // rig the Environment's practicals sit in.
    b.steel.push(place(truss(26, 0.7, { thickness: 0.055, width: 0.07, bays: 13 }), { pos: [0, 7.4, -6.2] }));
    for (const x of [-6.6, 6.6]) {
      for (const dz of [-0.5, 0.5]) {
        b.steel.push(place(new THREE.CylinderGeometry(0.026, 0.026, 1.85, 6), { pos: [x, 6.45, -6.2 + dz] }));
      }
    }
  }

  /**
   * The machinery bank across the back of the hall: cabinets, tanks, rams and
   * a conveyor. It is the busiest silhouette in the set and it sits directly
   * behind the fighters, so it is deliberately kept dark and low-contrast.
   */
  #machineryBank() {
    const b = this.bins;
    const rng = this.rng;
    // Set back far enough to clear the top terrace tread and the road cases
    // stacked on it; the crowd owns everything in front of this line.
    const z0 = MACHINE_Z;

    for (let i = 0; i < 11; i++) {
      const x = -13 + i * 2.6;
      const h = 2.2 + rng.next() * 2.4;
      const d = 1.2 + rng.next() * 0.8;
      b.dark.push(place(bevelBox(2.3, h, d, 0.03), { pos: [x, h / 2, z0 - d / 2] }));
      b.steel.push(place(insetPanel(1.7, h * 0.42, 0.07, 0.09), { pos: [x, h * 0.62, z0 - d - 0.02] }));
      b.dark.push(place(bevelBox(2.45, 0.14, d + 0.14, 0.02), { pos: [x, h + 0.07, z0 - d / 2] }));
      if (i % 2 === 0) {
        b.dark.push(place(new THREE.CylinderGeometry(0.34, 0.34, 1.5, 14), { pos: [x - 0.6, h + 0.8, z0 - d / 2] }));
        b.dark.push(place(new THREE.SphereGeometry(0.34, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), { pos: [x - 0.6, h + 1.55, z0 - d / 2] }));
      }
      if (i % 3 === 1) {
        b.steel.push(place(hydraulicRam(1.5, 1.1, 0.17), { pos: [x + 0.7, h, z0 - d / 2], rot: [rng.range(-0.1, 0.1), 0, 0] }));
      }
    }

    // Horizontal pressure vessels laid on saddles, stage right.
    for (let i = 0; i < 3; i++) {
      const y = 1.3 + i * 0.05;
      const z = z0 - 1.9 - i * 1.3;
      b.dark.push(place(new THREE.CylinderGeometry(1.05, 1.05, 7.5, 20, 1), { pos: [8.5 - i * 0.4, y + 1.0, z], rot: [0, 0, Math.PI / 2] }));
      for (const dx of [-2.6, 0, 2.6]) {
        b.steel.push(place(bevelBox(0.5, 1.4, 1.9, 0.02), { pos: [8.5 - i * 0.4 + dx, 0.7, z] }));
      }
    }

    // Conveyor running out of the dark, stage left.
    b.steel.push(place(truss(11, 0.7, { thickness: 0.05, width: 0.06, bays: 8 }), { pos: [-12.5, 3.4, z0 - 3.4], rot: [0, 0.34, -0.13] }));
    b.dark.push(place(bevelBox(11, 0.22, 1.3, 0.02), { pos: [-12.5, 4.2, z0 - 3.4], rot: [0, 0.34, -0.13] }));
  }

  /**
   * The cable tray running the width of the hall behind the crowd, and the
   * drops off it into the machinery bank.
   *
   * Everything the fight camera can see between the fence rail and the roof
   * trusses is either a *mass* — machinery, containers, the crane girder — or a
   * *line* running the long way across frame, and every one of those lines is
   * currently smooth: pipe, girder, catwalk, conduit. A cable tray is the one
   * piece of building services that is periodic, and periodicity is what makes a
   * run legible as receding: the rungs foreshorten, so the eye reads twenty-four
   * metres of depth off a member six centimetres deep. It is also almost all
   * holes, so the whole run costs about what one girder does.
   *
   * Its height was measured, not chosen. Projecting candidate points through the
   * live camera at both shipping framings shows the visible slice of the back of
   * the hall is far shallower than it looks from a plan: at the wide framing the
   * HUD cuts in at about screen y=140 and the crowd's heads reach y=165, which
   * leaves a band roughly one metre deep around **y = 4.3 at z = -13.4**. A first
   * pass put this run at 5.6m, where it projected to screen y=58 at the wide and
   * y=-45 at the hero — entirely behind the HUD in one and off the top of the
   * frame in the other. A run nobody can see is not detail, it is triangles, so
   * the measurement moved it rather than the intuition.
   */
  #backServices() {
    const b = this.bins;
    const y = 4.35;
    const z = -13.35;
    const W = 25.2;

    b.steel.push(place(cableTray(W, 0.5, { rungPitch: 0.32, depth: 0.11, cables: 4 }), { pos: [0, y, z] }));

    // Cantilever brackets back to the machinery bank, on the pitch a real tray
    // is supported at. Each is an arm and a diagonal, and the diagonals are what
    // stop the run reading as a floating stripe.
    for (let x = -12; x <= 12; x += 1.6) {
      b.steel.push(place(bevelBox(0.05, 0.09, 0.7, 0.012), { pos: [x, y - 0.02, z - 0.32] }));
      const st = spanX([x, y - 0.05, z + 0.24], [x, y - 0.52, z - 0.62]);
      b.steel.push(place(bevelBox(st.length, 0.045, 0.045, 0.012), { pos: st.pos, rot: st.rot }));
    }

    // Drops off the tray into the bank below: a gland box, a bundle of conduit
    // and the flexible tails at the bottom of each. They are what stop the run
    // reading as a stripe painted across the machinery — a service main that
    // never feeds anything is a decal.
    for (const x of [-9.4, -2.2, 4.6, 10.8]) {
      b.steel.push(place(bevelBox(0.4, 0.46, 0.26, 0.02), { pos: [x, y - 0.4, z - 0.16] }));
      b.steel.push(place(boltRow(0.28, 3, 0.019, 0.013), { pos: [x, y - 0.58, z - 0.02] }));
      for (const dx of [-0.11, 0, 0.11]) {
        b.steel.push(place(new THREE.CylinderGeometry(0.032, 0.032, 1.2, 7), { pos: [x + dx, y - 1.22, z - 0.16] }));
      }
      b.dark.push(tube(catenary(
        [x - 0.11, y - 1.82, z - 0.16], [x + 0.4, y - 2.5, z - 0.5], 0.16, 6,
      ), 0.028, 6));
    }
  }

  /** Pipe runs: the connective tissue that makes a set look built. */
  #pipework() {
    const b = this.bins;
    const rng = this.rng;

    for (const side of [-1, 1]) {
      const x = side * 15.4;
      for (let i = 0; i < 4; i++) {
        const y = 6.6 + i * 0.46;
        const r = 0.09 + rng.next() * 0.08;
        b.steel.push(pipeRun([
          [x, y, 15], [x, y, 6], [x, y, -4], [x, y, -13], [x - side * 1.2, y, -17.5],
        ], r, { flangeEvery: 1 }));
      }
      // Vertical drops into the machinery bank.
      for (const z of [-11.5, -3.2, 7.4]) {
        const r = 0.075 + rng.next() * 0.05;
        b.steel.push(pipeRun([[x, 6.4, z], [x, 3.4, z], [x - side * 0.7, 2.2, z], [x - side * 0.9, 0.4, z]], r, { flangeEvery: 2 }));
      }
    }

    // A bundle crossing the ceiling above the pit, well clear of the action.
    for (let i = 0; i < 5; i++) {
      const z = -9.4 - i * 0.34;
      b.steel.push(pipeRun([
        [-16, 10.6 + i * 0.12, z], [-6, 10.4 + i * 0.12, z], [6, 10.4 + i * 0.12, z], [16, 10.6 + i * 0.12, z],
      ], 0.08 + i * 0.012, { flangeEvery: 1 }));
    }

    // Slack cable bundles hanging off the catwalks.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const z = -6 + i * 6.5;
        const pts = catenary([side * 12.1, CATWALK_Y - 0.35, z], [side * 12.1, CATWALK_Y - 0.35, z + 4.4], 0.22, 12);
        b.dark.push(tube(pts, 0.045, 6));
        b.dark.push(tube(pts.map((p) => new THREE.Vector3(p.x + side * 0.11, p.y - 0.05, p.z)), 0.035, 6));
      }
    }
  }

  /**
   * The hangar's rear shell: a corrugated wall with three blown-out panels.
   * Everything the city is seen through is one of those holes.
   */
  #shellWall() {
    const b = this.bins;
    const W = 46, H = 26;
    // The openings sit low on purpose. Cut at roof height they framed nothing
    // the fight camera could reach: it solves for the fighters, so at the shell
    // wall the top of frame is barely nine metres up. Dropping the sills to
    // just above the machinery bank is what turns them from decoration into the
    // only aperture the yard beyond is seen through.
    const holes = [
      { x: -10.0, y: 7.0, w: 9.0, h: 7.0 },
      { x: 2.5, y: 9.5, w: 10.0, h: 8.0 },
      { x: 13.5, y: 6.5, w: 7.0, h: 6.0 },
    ];
    // Clear runs of wall at a given height, with the openings taken out. The
    // plating, the girts and the access hatches all cut against it, so a hole
    // stays a hole in every layer instead of only in the skin.
    const spansAt = (yc) => {
      const spans = [[-W / 2, W / 2]];
      for (const h of holes) {
        if (yc < h.y - h.h / 2 || yc > h.y + h.h / 2) continue;
        const cut = [h.x - h.w / 2, h.x + h.w / 2];
        for (let s = spans.length - 1; s >= 0; s--) {
          const [a, c] = spans[s];
          if (cut[1] <= a || cut[0] >= c) continue;
          spans.splice(s, 1);
          if (cut[0] > a) spans.push([a, cut[0]]);
          if (cut[1] < c) spans.push([cut[1], c]);
        }
      }
      return spans;
    };

    // The wall is built as horizontal bands that skip where a hole is, which is
    // cheaper and more controllable than any boolean.
    const bands = 22;
    for (let i = 0; i < bands; i++) {
      const y0 = (i * H) / bands;
      const y1 = ((i + 1) * H) / bands;
      const yc = (y0 + y1) / 2;
      for (const [a, c] of spansAt(yc)) {
        const w = c - a;
        if (w < 0.05) continue;
        b.container.push(place(bevelBox(w, y1 - y0 - 0.02, 0.34, 0.015), { pos: [(a + c) / 2, yc, SHELL_Z] }));
      }
    }

    // Girts: the rails the plating is actually fixed to, standing 300mm proud
    // of the skin. Without them the shell is forty-six metres of one plane and
    // it turns as a single value under the key — the corrugation in the map
    // gives it a grain but no depth, and a grain with no depth is what makes a
    // wall read as a painted flat. These are also the only members on the wall
    // that can throw a shadow *along* it, which is the cue that sells its size.
    for (const y of [1.55, 4.35, 11.75, 14.55, 17.35, 20.15, 22.95]) {
      for (const [a, c] of spansAt(y)) {
        const w = c - a;
        if (w < 0.6) continue;
        b.dark.push(place(bevelBox(w - 0.1, 0.2, 0.3, 0.02), { pos: [(a + c) / 2, y, SHELL_Z + 0.22] }));
        b.dark.push(place(boltRow(w - 0.9, Math.max(2, Math.round(w / 1.5)), 0.03, 0.02), {
          pos: [(a + c) / 2, y, SHELL_Z + 0.38],
        }));
      }
    }

    // Access hatches and louvre panels, in the bays the openings left standing.
    // `insetPanel` is a frame plus a recessed face, so each one is a real
    // shadow-catching pocket rather than a rectangle drawn on the map.
    for (const [x, y, w, h] of [
      [-19.4, 4.6, 2.6, 2.0], [-2.4, 4.2, 2.2, 2.6], [8.9, 4.4, 2.0, 2.4],
      [20.0, 5.2, 2.8, 2.2], [-19.4, 10.6, 2.6, 1.6], [20.0, 11.2, 2.8, 1.8],
    ]) {
      b.dark.push(place(insetPanel(w, h, 0.14, 0.12), { pos: [x, y, SHELL_Z + 0.24] }));
      b.dark.push(place(boltRow(w - 0.24, 5, 0.026, 0.018), { pos: [x, y - h / 2 + 0.06, SHELL_Z + 0.32] }));
      b.dark.push(place(boltRow(w - 0.24, 5, 0.026, 0.018), { pos: [x, y + h / 2 - 0.06, SHELL_Z + 0.32] }));
    }
    // Torn edges: ragged plate fragments around each opening.
    const rng = this.rng;
    for (const h of holes) {
      for (let i = 0; i < 14; i++) {
        const t = rng.next();
        const onX = rng.next() < 0.55;
        const px = onX ? h.x - h.w / 2 + t * h.w : h.x + (rng.next() < 0.5 ? -1 : 1) * h.w / 2;
        const py = onX ? h.y + (rng.next() < 0.5 ? -1 : 1) * h.h / 2 : h.y - h.h / 2 + t * h.h;
        b.container.push(place(bevelBox(rng.range(0.3, 0.9), rng.range(0.2, 0.7), 0.28, 0.01), {
          pos: [px, py, SHELL_Z + rng.range(-0.1, 0.1)],
          rot: [rng.range(-0.5, 0.5), rng.range(-0.4, 0.4), rng.range(-0.7, 0.7)],
        }));
      }
      // Structural frame around the opening.
      b.dark.push(place(bevelBox(h.w + 0.5, 0.22, 0.5, 0.02), { pos: [h.x, h.y - h.h / 2 - 0.15, SHELL_Z - 0.1] }));
      b.dark.push(place(bevelBox(h.w + 0.5, 0.22, 0.5, 0.02), { pos: [h.x, h.y + h.h / 2 + 0.15, SHELL_Z - 0.1] }));
    }
    // Columns of the shell, in front of the plating, with a splice bolt group
    // where a stanchion of this height would actually be jointed.
    for (let i = -5; i <= 5; i++) {
      b.dark.push(place(bevelBox(0.3, H, 0.42, 0.02), { pos: [i * 4.2, H / 2, SHELL_Z + 0.3] }));
      for (const y of [3.9, 15.2]) {
        b.dark.push(place(bevelBox(0.46, 0.62, 0.05, 0.012), { pos: [i * 4.2, y, SHELL_Z + 0.52] }));
        for (const dy of [-0.19, 0.19]) {
          b.dark.push(place(boltRow(0.26, 2, 0.028, 0.019), { pos: [i * 4.2, y + dy, SHELL_Z + 0.55] }));
        }
      }
    }
  }

  /**
   * The other three walls of the hangar.
   *
   * They exist for exactly one reason: the fight camera is allowed to swing
   * behind the pit on a knockout, and from there an open +Z end would show the
   * bare environment cube. A room has to be a room from every angle the camera
   * can legally reach.
   */
  #outerShell() {
    const b = this.bins;
    const H = 24;
    const FRONT_Z = 23;
    const SIDE_X = 24;

    // Camera-side wall, with a shuttered vehicle door on the axis.
    const doorW = 11, doorH = 8.4;
    for (let i = 0; i < 16; i++) {
      const y0 = (i * H) / 16;
      const y1 = ((i + 1) * H) / 16;
      const yc = (y0 + y1) / 2;
      if (yc < doorH) {
        for (const sx of [-1, 1]) {
          const w = SIDE_X - doorW / 2;
          b.container.push(place(bevelBox(w, y1 - y0 - 0.02, 0.34, 0.015), {
            pos: [sx * (doorW / 2 + w / 2), yc, FRONT_Z],
          }));
        }
      } else {
        b.container.push(place(bevelBox(SIDE_X * 2, y1 - y0 - 0.02, 0.34, 0.015), { pos: [0, yc, FRONT_Z] }));
      }
    }
    // The shutter itself: horizontal slats, and a hazard-striped frame.
    for (let i = 0; i < 21; i++) {
      b.dark.push(place(bevelBox(doorW, doorH / 21 - 0.02, 0.22, 0.012), {
        pos: [0, (i + 0.5) * (doorH / 21), FRONT_Z - 0.06],
      }));
    }
    for (const sx of [-1, 1]) {
      b.hazard.push(place(bevelBox(0.5, doorH + 0.6, 0.5, 0.02), { pos: [sx * (doorW / 2 + 0.25), (doorH + 0.6) / 2, FRONT_Z - 0.3] }));
    }
    b.dark.push(place(bevelBox(doorW + 1.4, 0.55, 0.6, 0.02), { pos: [0, doorH + 0.3, FRONT_Z - 0.3] }));
    for (let i = -5; i <= 5; i++) {
      b.dark.push(place(bevelBox(0.3, H, 0.42, 0.02), { pos: [i * 4.4, H / 2, FRONT_Z - 0.3] }));
    }

    // Flanks. Plain plating; they are only ever seen at the edge of frame.
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 14; i++) {
        const y0 = (i * H) / 14;
        b.container.push(place(bevelBox(0.34, H / 14 - 0.02, 44, 0.015), { pos: [sx * SIDE_X, y0 + H / 28, 2] }));
      }
      for (let i = -4; i <= 4; i++) {
        b.dark.push(place(bevelBox(0.42, H, 0.3, 0.02), { pos: [sx * (SIDE_X - 0.3), H / 2, 2 + i * 4.6] }));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Depth layers
  // -------------------------------------------------------------------------

  /**
   * Three silhouette layers stacked between the machinery bank and the shell
   * wall, plus a fourth seen only through the blown-out panels.
   *
   * The band from 13 to 19 metres was previously one undifferentiated dark mass
   * and the eye had nothing to measure depth against. What fixes that is not
   * more detail, it is *recognisable* shapes at known sizes: an overhead
   * travelling crane, a duct run, a cyclone, a stair tower. The brain knows how
   * big a crane is, so a small crane is a distant crane, and the layers separate
   * on their own. A metre and a half of z between layers plus the scene fog does
   * the rest.
   *
   * Everything sits between y = 3 and y = 6.5, which is the only window the
   * fight camera can actually see through: it solves for the fighters on a
   * narrow lens, so at eighteen metres the top of frame is barely six metres off
   * the deck and anything built at roof height is composed straight out of shot.
   *
   * One merged mesh, and nothing here casts: every one of these is behind the
   * back barrier and cannot throw into the fight plane, so it has no business in
   * the shadow pass.
   */
  #midground() {
    const parts = [];
    const rng = this.rng;

    // --- layer 0: back of house, on the top terrace tread ------------------
    // Directly behind the standing crowd and squarely inside the only band the
    // combat camera can see. Road cases, drum stacks and lighting stands: all
    // objects with a known size, so the crowd in front of them gets a scale.
    const L0 = -12.95;
    const L0Y = TERRACE_TOP;
    for (const [x, w, h, d] of [
      [-10.4, 1.3, 1.9, 0.9], [-9.0, 1.1, 1.3, 0.85], [-7.4, 1.5, 2.4, 1.0],
      [4.9, 1.2, 1.7, 0.9], [6.2, 1.4, 2.5, 1.0], [11.2, 1.25, 2.1, 0.9],
    ]) {
      const yaw = rng.range(-0.14, 0.14);
      parts.push(place(bevelBox(w, h, d, 0.04), { pos: [x, L0Y + h / 2, L0], rot: [0, yaw, 0] }));
      parts.push(place(bevelBox(w + 0.09, 0.1, d + 0.09, 0.02), { pos: [x, L0Y + h, L0], rot: [0, yaw, 0] }));
      for (const s of [-1, 1]) {
        parts.push(place(bevelBox(0.09, h - 0.2, 0.09, 0.02), { pos: [x + s * (w / 2 - 0.06), L0Y + h / 2, L0 - d / 2], rot: [0, yaw, 0] }));
      }
    }
    for (const [x, n] of [[-3.4, 4], [2.1, 3], [8.6, 5]]) {
      for (let i = 0; i < n; i++) {
        parts.push(place(new THREE.CylinderGeometry(0.29, 0.29, 0.86, 12, 1), {
          pos: [x + (i % 3) * 0.62, L0Y + 0.43 + Math.floor(i / 3) * 0.88, L0 - 0.1 + (i % 2) * 0.5],
        }));
      }
    }
    // A-frame lighting stands: thin verticals against all that stacked mass.
    for (const x of [-5.8, 0.4, 9.9]) {
      parts.push(place(new THREE.CylinderGeometry(0.045, 0.06, 2.6, 9, 1), { pos: [x, L0Y + 1.3, L0 - 0.2] }));
      parts.push(place(bevelBox(1.3, 0.07, 0.07, 0.015), { pos: [x, L0Y + 2.52, L0 - 0.2] }));
      for (const s of [-1, 1]) {
        const leg = spanX([x, L0Y + 0.12, L0 - 0.2], [x + s * 0.55, L0Y, L0 - 0.2 + s * 0.35]);
        parts.push(place(bevelBox(leg.length, 0.05, 0.05, 0.012), { pos: leg.pos, rot: leg.rot }));
        parts.push(place(new THREE.CylinderGeometry(0.13, 0.11, 0.3, 10, 1), { pos: [x + s * 0.52, L0Y + 2.36, L0 - 0.2], rot: [-0.5, 0, 0] }));
      }
    }

    // --- layer 1: overhead travelling crane, z = -15.4 ---------------------
    const CZ = -15.4;
    for (const x of [-13.4, 13.4]) {
      parts.push(place(bevelBox(0.5, 0.44, 5.6, 0.03), { pos: [x, 4.62, CZ] }));
      parts.push(place(bevelBox(0.26, 0.13, 5.8, 0.02), { pos: [x, 4.9, CZ] }));
    }
    // Box girder bridge: two webs, a top flange, and end trucks on the rails.
    for (const dz of [-0.62, 0.62]) {
      parts.push(place(bevelBox(26.4, 1.05, 0.13, 0.03), { pos: [0, 5.62, CZ + dz] }));
    }
    parts.push(place(bevelBox(26.4, 0.16, 1.5, 0.03), { pos: [0, 6.17, CZ] }));
    parts.push(place(bevelBox(26.4, 0.14, 1.1, 0.03), { pos: [0, 5.11, CZ] }));
    for (const s of [-1, 1]) {
      parts.push(place(bevelBox(1.5, 0.7, 1.9, 0.03), { pos: [s * 13.4, 5.37, CZ] }));
      for (const dz of [-0.7, 0.7]) {
        parts.push(place(new THREE.CylinderGeometry(0.3, 0.3, 0.24, 12), { pos: [s * 13.4, 4.98, CZ + dz], rot: [0, 0, Math.PI / 2] }));
      }
    }
    // Trolley, hoist drum and a hook block on two falls of rope.
    const TX = -4.2;
    parts.push(place(bevelBox(2.4, 0.9, 1.7, 0.03), { pos: [TX, 6.77, CZ] }));
    parts.push(place(new THREE.CylinderGeometry(0.42, 0.42, 1.5, 14), { pos: [TX + 0.3, 6.82, CZ], rot: [Math.PI / 2, 0, 0] }));
    parts.push(place(bevelBox(1.0, 0.5, 0.9, 0.02), { pos: [TX + 0.15, 3.5, CZ] }));
    parts.push(place(new THREE.TorusGeometry(0.34, 0.07, 5, 12), { pos: [TX + 0.15, 3.1, CZ], rot: [Math.PI / 2, 0, 0] }));
    for (const dx of [-0.34, 0.34]) {
      parts.push(place(new THREE.CylinderGeometry(0.035, 0.035, 2.9, 5), { pos: [TX + 0.15 + dx, 5.2, CZ] }));
    }

    // --- layer 2: plant services, z = -17.0 --------------------------------
    const DZ = -17.0;
    // A main duct running the width, dropping through an elbow into a plenum.
    parts.push(place(new THREE.CylinderGeometry(0.78, 0.78, 19, 16, 1), { pos: [-5.5, 4.4, DZ], rot: [0, 0, Math.PI / 2] }));
    for (let i = 0; i < 7; i++) {
      parts.push(place(new THREE.CylinderGeometry(0.86, 0.86, 0.16, 16, 1), { pos: [-14.5 + i * 3.0, 4.4, DZ], rot: [0, 0, Math.PI / 2] }));
    }
    parts.push(place(new THREE.TorusGeometry(0.9, 0.78, 8, 14, Math.PI / 2), { pos: [4.0, 5.3, DZ], rot: [Math.PI / 2, 0, Math.PI] }));
    parts.push(place(new THREE.CylinderGeometry(0.78, 0.78, 3.2, 16, 1), { pos: [4.9, 6.9, DZ] }));
    parts.push(place(bevelBox(3.4, 2.6, 2.2, 0.04), { pos: [8.2, 5.6, DZ] }));
    parts.push(place(bevelBox(3.6, 0.22, 2.4, 0.03), { pos: [8.2, 6.98, DZ] }));
    // Cyclone separator: the one shape in the room that is unmistakably plant.
    parts.push(place(new THREE.CylinderGeometry(1.15, 1.15, 2.8, 16, 1), { pos: [-11.5, 5.5, DZ] }));
    parts.push(place(new THREE.CylinderGeometry(1.15, 0.22, 2.6, 16, 1), { pos: [-11.5, 2.8, DZ] }));
    parts.push(place(new THREE.CylinderGeometry(0.34, 0.34, 1.6, 12, 1), { pos: [-11.5, 7.5, DZ] }));
    for (const a of [0.7, 2.4, 4.2]) {
      parts.push(place(bevelBox(0.13, 3.0, 0.13, 0.02), {
        pos: [-11.5 + Math.cos(a) * 1.45, 1.5, DZ + Math.sin(a) * 1.45],
      }));
    }

    // --- layer 3: hard against the shell wall, z = -18.4 -------------------
    const SZ = -18.4;
    // Stair tower: a caged run climbing to the catwalk level.
    for (let i = 0; i < 20; i++) {
      const y = 0.4 + i * 0.42;
      const x = -12.6 + (i % 10) * 0.28 * (Math.floor(i / 10) % 2 ? -1 : 1);
      parts.push(place(bevelBox(1.15, 0.06, 0.34, 0.01), { pos: [x, y, SZ + 0.4] }));
    }
    for (const dx of [-0.62, 0.62]) {
      parts.push(place(bevelBox(0.1, 8.8, 0.1, 0.02), { pos: [-12.6 + dx, 4.4, SZ + 0.9] }));
    }
    parts.push(place(bevelBox(2.6, 0.16, 1.5, 0.02), { pos: [-12.2, 8.7, SZ + 0.5] }));
    // A row of narrow silos: vertical rhythm against all those horizontals.
    for (let i = 0; i < 4; i++) {
      const x = 7.4 + i * 2.35;
      const h = 3.6 + rng.next() * 1.8;
      parts.push(place(new THREE.CylinderGeometry(0.95, 0.95, h, 14, 1), { pos: [x, h / 2 + 1.6, SZ] }));
      parts.push(place(new THREE.CylinderGeometry(0.18, 0.95, 1.5, 14, 1), { pos: [x, 1.35, SZ] }));
      parts.push(place(new THREE.CylinderGeometry(1.02, 0.34, 1.1, 14, 1), { pos: [x, h + 2.1, SZ] }));
      for (const a of [0.9, 3.1, 5.2]) {
        parts.push(place(bevelBox(0.11, 2.4, 0.11, 0.02), { pos: [x + Math.cos(a) * 1.05, 1.2, SZ + Math.sin(a) * 1.05] }));
      }
    }
    // Jib crane on a pillar, arm swung across the wall.
    parts.push(place(new THREE.CylinderGeometry(0.32, 0.4, 6.2, 12, 1), { pos: [2.2, 3.1, SZ + 0.6] }));
    const jib = spanX([2.2, 6.1, SZ + 0.6], [-2.9, 5.4, SZ + 1.4]);
    parts.push(place(truss(jib.length, 0.5, { thickness: 0.075, width: 0.09, bays: 5 }), { pos: jib.pos, rot: jib.rot }));
    parts.push(place(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 5), { pos: [-2.7, 4.2, SZ + 1.4] }));

    // Depth haze on top of the scene fog. The scene fog is solved for a room
    // twelve metres across; over the six metres that separate the back of the
    // crowd from the shell wall it moves the value by almost nothing, so four
    // layers of plant that are genuinely at four different depths arrive as one
    // flat card. This second falloff is steep and starts where the crowd ends,
    // which is the only band the fight camera can see any of it in.
    const mat = this.materials.darkMetal.clone();
    mat.name = 'arena.midgroundHaze';
    const uHaze = this.midgroundHaze;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uHaze = uHaze;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vViewDepth;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvViewDepth = -mvPosition.z;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uHaze;\nvarying float vViewDepth;')
        .replace('#include <opaque_fragment>', /* glsl */ `
          #include <opaque_fragment>
          gl_FragColor.rgb = mix( gl_FragColor.rgb, uHaze, 1.0 - exp( -max( 0.0, vViewDepth - 17.0 ) * 0.055 ) );
        `);
    };
    mat.customProgramCacheKey = () => 'kb-midground';
    this.midgroundMaterial = mat;

    const mesh = new THREE.Mesh(worldUv(mergeAll(parts), 2.2), mat);
    mesh.name = 'arena.structure.midground';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.midground = mesh;
    this.group.add(mesh);
  }

  /**
   * The yard outside, seen through the shell wall's blown-out panels: three
   * bands of pure silhouette at roughly 25, 50 and 85 metres.
   *
   * Everything inside the hangar shares one lighting rig and one fog, so from
   * twelve metres to nineteen it is all the same value and the eye reads it as
   * one flat card. Distance is not a matter of putting things further away, it
   * is a matter of *contrast falling off* with distance — so this set is unlit
   * and each fragment fades toward the mood's haze on its own view depth. A
   * crane at fifty metres then sits visibly behind a container stack at
   * twenty-five, and the chimney bank behind both is barely a stain.
   *
   * The shapes are chosen for the same reason the crane inside is: they have
   * sizes everybody already knows, so their apparent size *is* the distance
   * cue. And the whole set — three depth bands plus the beacons blinking on top
   * of the stacks — is one merged mesh and one draw call, because there is
   * nothing here that needs to be addressed separately.
   */
  #backdrop() {
    const parts = [];
    const lamps = [];
    const rng = this.rng;

    // --- band 0: the yard, z = -25 -----------------------------------------
    const YZ = -25;
    for (const [bx, bz, cols, rows] of [[-11, 0, 3, 3], [3.5, -2.5, 2, 4], [15.5, 1.5, 3, 2]]) {
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          // Ragged stacks: the top course is never full, which is what stops a
          // container block reading as one extruded rectangle.
          if (r === rows - 1 && rng.next() < 0.45) continue;
          parts.push(place(bevelBox(6.06, 2.59, 2.44, 0.05), {
            pos: [bx + c * 2.6 + rng.range(-0.2, 0.2), 1.3 + r * 2.62, YZ + bz - c * 2.55],
            rot: [0, rng.range(-0.05, 0.05), 0],
          }));
        }
      }
    }
    // Lift and stair tower, the tall vertical that gives the stacks a ceiling.
    parts.push(place(bevelBox(4.4, 15.0, 4.4, 0.08), { pos: [-19.5, 7.5, YZ - 3] }));
    parts.push(place(bevelBox(5.2, 0.7, 5.2, 0.06), { pos: [-19.5, 15.3, YZ - 3] }));
    for (let i = 0; i < 6; i++) {
      parts.push(place(bevelBox(4.6, 0.16, 0.7, 0.03), { pos: [-19.5, 2.4 + i * 2.3, YZ - 0.8] }));
    }
    // Two flat-roofed sheds and a run of mast lighting.
    for (const [sx, sw, sh] of [[9, 13, 6.5], [-3, 9, 5.0]]) {
      parts.push(place(bevelBox(sw, sh, 7, 0.08), { pos: [sx, sh / 2, YZ - 8] }));
      parts.push(place(bevelBox(sw + 0.6, 0.5, 7.6, 0.05), { pos: [sx, sh + 0.2, YZ - 8] }));
    }
    for (const mx of [-14.5, 1.5, 18]) {
      parts.push(place(new THREE.CylinderGeometry(0.22, 0.4, 17, 8, 1), { pos: [mx, 8.5, YZ - 6] }));
      parts.push(place(bevelBox(3.2, 0.9, 1.2, 0.06), { pos: [mx, 17.4, YZ - 6] }));
      lamps.push(place(new THREE.SphereGeometry(0.34, 6, 5), { pos: [mx, 18.1, YZ - 6] }));
    }

    // --- band 1: the dock, z = -50 -----------------------------------------
    const DZ = -50;
    for (const [cx, cz, span, h, boom] of [[-16, 0, 30, 19, 11], [14, -7, 24, 15, 8]]) {
      parts.push(place(portalCrane(span, h, { boom }), { pos: [cx, 0, DZ + cz] }));
      lamps.push(place(new THREE.SphereGeometry(0.5, 6, 5), { pos: [cx - span / 2, h + 1.2, DZ + cz] }));
    }
    for (let i = 0; i < 5; i++) {
      const h = 20 + rng.next() * 6;
      parts.push(place(new THREE.CylinderGeometry(3.2, 3.2, h, 14, 1), { pos: [30 + i * 7.2, h / 2, DZ - 10] }));
      parts.push(place(new THREE.CylinderGeometry(3.4, 1.1, 3.4, 14, 1), { pos: [30 + i * 7.2, h + 1.6, DZ - 10] }));
    }
    parts.push(place(bevelBox(34, 13, 18, 0.1), { pos: [-2, 6.5, DZ - 14] }));
    parts.push(place(bevelBox(35, 0.8, 19, 0.06), { pos: [-2, 13.3, DZ - 14] }));
    for (let i = 0; i < 4; i++) {
      parts.push(place(new THREE.CylinderGeometry(0.8, 0.8, 5.5, 10, 1), { pos: [-14 + i * 8, 15.8, DZ - 14] }));
    }

    // --- band 2: the power station, z = -88 --------------------------------
    const PZ = -88;
    for (const [px, ph, pr] of [[-34, 46, 3.0], [-22, 55, 3.6], [10, 38, 2.6], [27, 50, 3.2]]) {
      parts.push(place(chimney(ph, pr, 5), { pos: [px, 0, PZ + rng.range(-8, 8)] }));
      lamps.push(place(new THREE.SphereGeometry(1.0, 6, 5), { pos: [px, ph + 0.6, PZ] }));
    }
    // Cooling tower: the one profile in the set that cannot be mistaken.
    for (const [tx, tz] of [[-56, 6], [46, -10]]) {
      parts.push(place(new THREE.CylinderGeometry(15, 21, 38, 20, 1), { pos: [tx, 19, PZ + tz] }));
      parts.push(place(new THREE.CylinderGeometry(16.5, 15, 2.4, 20, 1), { pos: [tx, 39, PZ + tz] }));
    }
    // Boiler house block, so the stacks are standing on something.
    parts.push(place(bevelBox(46, 22, 24, 0.12), { pos: [-6, 11, PZ - 16] }));

    const solid = mergeAll(parts);
    const beacons = mergeAll(lamps);
    const geo = mergeAll([solid, beacons]);
    const lamp = new Float32Array(geo.attributes.position.count);
    lamp.fill(1, solid.attributes.position.count);
    geo.setAttribute('aLamp', new THREE.Float32BufferAttribute(lamp, 1));

    this.backdropMaterial = new THREE.ShaderMaterial({
      name: 'arena.backdrop',
      uniforms: {
        uTime: this.timeUniform,
        uBase: { value: new THREE.Color(0x0d1219) },
        uTop: { value: new THREE.Color(0x1e2a38) },
        uHaze: { value: new THREE.Color(0x1b2634) },
        uLamp: { value: new THREE.Color(0xff4028) },
      },
      vertexShader: /* glsl */ `
        attribute float aLamp;
        varying vec3 vNrm;
        varying vec3 vWorld;
        varying float vLamp;
        varying float vDepth;
        void main() {
          vNrm = normalize( mat3( modelMatrix ) * normal );
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz;
          vLamp = aLamp;
          vec4 mv = viewMatrix * w;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase;
        uniform vec3 uTop;
        uniform vec3 uHaze;
        uniform vec3 uLamp;
        uniform float uTime;
        varying vec3 vNrm;
        varying vec3 vWorld;
        varying float vLamp;
        varying float vDepth;

        void main() {
          // Two-tone shade off the normal. Enough to keep a roof from merging
          // into the wall under it, not enough to imply a light source out
          // there that the rig does not have.
          float up = clamp( vNrm.y * 0.5 + 0.5, 0.0, 1.0 );
          float side = 0.5 + 0.5 * vNrm.x;
          vec3 col = mix( uBase, uTop, up * up * 0.8 + side * 0.2 );

          // Depth haze, thickened toward the ground: real air is dirtiest where
          // the yard is, which is why a distant crane's legs vanish before its
          // girder does.
          float haze = 1.0 - exp( -max( 0.0, vDepth - 14.0 ) * 0.0165 );
          haze *= mix( 1.15, 0.74, clamp( vWorld.y / 44.0, 0.0, 1.0 ) );
          col = mix( col, uHaze, clamp( haze, 0.0, 0.94 ) );

          // Obstruction beacons. They blink out of phase and they are the only
          // thing out here allowed to survive the haze.
          if ( vLamp > 0.5 ) {
            float ph = fract( sin( dot( vWorld.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
            float on = step( 0.55, fract( uTime * 0.34 + ph ) );
            col = mix( col, uLamp * ( 0.35 + 2.4 * on ), 0.9 );
          }
          gl_FragColor = vec4( col, 1.0 );
        }
      `,
      fog: false,
    });

    const mesh = new THREE.Mesh(geo, this.backdropMaterial);
    mesh.name = 'arena.structure.backdrop';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    // Twenty-five metres beyond a wall: nothing out here has a line to the pit
    // floor, so it has no business in the mirror pass either.
    mesh.layers.set(LAYER.NO_REFLECT);
    this.backdrop = mesh;
    this.group.add(mesh);
  }

  /**
   * The camera-side layer — the only thing in the set nearer than the fighters.
   *
   * Where it can go is dictated entirely by the lens. The fight camera solves
   * for a composition box, and at normal separation that puts it about four and
   * a half metres out on a 34 degree lens: the frustum is barely two metres wide
   * anywhere in front of it, and all of that is inside the combat volume. So
   * there is no foreground at combat framing, and there cannot be one — the same
   * reason Tekken's own play view has none.
   *
   * What every wider framing does have is the front apron, the strip of deck
   * from z = 6 to 8.5 that sits outside the combat depth bound. That wedge is
   * exactly the near field of the wide, KO and replay cameras, so that is where
   * the occluders live: two rigging masts holding the left and right edges, a
   * chain hoist dropped from the roof, a stanchion run and a rope line across
   * the bottom, and enough deck clutter to sell the apron as a working area.
   * When the fighters separate and the camera dollies back through the line,
   * they become genuine foreground for the fight view as well.
   *
   * Nothing here casts. A mast two metres off the lens would throw a black bar
   * across the middle of the pit, and none of it is load-bearing in the shadow
   * pass.
   */
  #foreground() {
    const parts = [];
    const rng = this.rng;

    // --- rigging masts, the left and right edge occluders -------------------
    // Chunky members and only five bays of lacing: at two metres off the lens a
    // fine lattice is a shimmering mess, and the mast is wanted as a silhouette
    // anyway. Everything about it is sized to read at that distance.
    for (const [x, z, h, arm] of [[-3.6, 6.7, 4.35, -1.45], [4.45, 7.0, 3.55, 1.2]]) {
      parts.push(place(bevelBox(0.72, 0.15, 0.72, 0.025), { pos: [x, 0.075, z] }));
      for (const [dx, dz] of [[-0.13, -0.13], [0.13, -0.13], [-0.13, 0.13], [0.13, 0.13]]) {
        parts.push(place(bevelBox(0.075, h, 0.075, 0.016), { pos: [x + dx, h / 2, z + dz] }));
      }
      for (let i = 0; i < 5; i++) {
        const y = 0.45 + i * ((h - 0.9) / 4);
        for (const dz of [-0.13, 0.13]) {
          parts.push(place(bevelBox(0.42, 0.05, 0.05, 0.012), { pos: [x, y, z + dz], rot: [0, 0, i % 2 ? 0.62 : -0.62] }));
        }
        parts.push(place(bevelBox(0.3, 0.05, 0.05, 0.012), { pos: [x, y, z], rot: [Math.PI / 2, 0, 0] }));
      }
      // Cross-arm carrying two lamps, each a proper can: yoke, barrel, flared
      // shade and barn doors, aimed down into the pit.
      parts.push(place(bevelBox(Math.abs(arm) * 2, 0.09, 0.09, 0.018), { pos: [x + arm * 0.5, h - 0.18, z] }));
      for (const t of [0.44, 0.94]) {
        const lx = x + arm * t;
        parts.push(place(bevelBox(0.05, 0.2, 0.34, 0.012), { pos: [lx, h - 0.3, z] }));
        parts.push(place(new THREE.CylinderGeometry(0.15, 0.13, 0.4, 12, 1), { pos: [lx, h - 0.56, z - 0.06], rot: [0.42, 0, 0] }));
        parts.push(place(new THREE.CylinderGeometry(0.24, 0.16, 0.22, 12, 1), { pos: [lx, h - 0.82, z - 0.17], rot: [0.42, 0, 0] }));
        for (const s of [-1, 1]) {
          parts.push(place(bevelBox(0.02, 0.3, 0.34, 0.006), { pos: [lx + s * 0.23, h - 0.86, z - 0.19], rot: [0.42, 0, s * 0.4] }));
        }
      }
      // Supply cable, dressed down the arm and lashed to the mast.
      parts.push(tube(catenary([x + arm * 0.94, h - 0.42, z + 0.04], [x + 0.12, h * 0.62, z + 0.16], 0.22, 10), 0.022, 5));
      const brace = spanX([x, h * 0.62, z], [x - Math.sign(arm) * 1.15, 0.07, z + 0.55]);
      parts.push(place(bevelBox(brace.length, 0.07, 0.07, 0.016), { pos: brace.pos, rot: brace.rot }));
    }

    // --- chain hoist dropped off the roof ----------------------------------
    {
      const x = 2.55, z = 6.25, bottom = 2.35;
      parts.push(place(new THREE.CylinderGeometry(0.028, 0.028, ROOF_Y - bottom, 6), { pos: [x, (ROOF_Y + bottom) / 2, z] }));
      parts.push(place(new THREE.CylinderGeometry(0.02, 0.02, ROOF_Y - bottom - 0.5, 5), { pos: [x + 0.075, (ROOF_Y + bottom) / 2 + 0.25, z + 0.03] }));
      parts.push(place(bevelBox(0.2, 0.34, 0.16, 0.02), { pos: [x, bottom + 0.17, z] }));
      parts.push(place(new THREE.TorusGeometry(0.1, 0.026, 6, 14, Math.PI * 1.5), { pos: [x, bottom - 0.08, z], rot: [0, Math.PI / 2, 0.6] }));
    }

    // --- stanchion run on the front apron, outside the combat bound ---------
    const posts = [];
    for (const s of [-1, 1]) {
      for (const ax of [1.5, 3.2, 5.0, 7.1, 9.5]) {
        // The run bows away from the pit at the edges so it reads as a rope
        // line laid round the deck rather than a fence bolted across it.
        posts.push([s * ax, 6.15 + (ax / 9.5) ** 2 * 1.9]);
      }
    }
    for (const [x, z] of posts) {
      parts.push(place(new THREE.CylinderGeometry(0.19, 0.22, 0.05, 14, 1), { pos: [x, 0.025, z] }));
      parts.push(place(new THREE.CylinderGeometry(0.042, 0.05, 0.88, 10, 1), { pos: [x, 0.46, z] }));
      parts.push(place(new THREE.CylinderGeometry(0.062, 0.062, 0.1, 10, 1), { pos: [x, 0.93, z] }));
    }
    posts.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < posts.length - 1; i++) {
      const a = posts[i], b = posts[i + 1];
      if (Math.abs(b[0] - a[0]) > 3.4) continue; // don't rope across the entrance
      parts.push(tube(catenary([a[0], 0.86, a[1]], [b[0], 0.86, b[1]], 0.06, 8), 0.02, 5));
    }

    // --- deck clutter on the apron -----------------------------------------
    for (const [cx, cz] of [[-5.4, 7.6], [6.6, 8.4]]) {
      // Cable drum on its side, half unspooled across the deck.
      for (const dx of [-0.4, 0.4]) {
        parts.push(place(new THREE.CylinderGeometry(0.82, 0.82, 0.09, 18, 1), { pos: [cx + dx, 0.82, cz], rot: [0, 0, Math.PI / 2] }));
      }
      parts.push(place(new THREE.CylinderGeometry(0.5, 0.5, 0.75, 16, 1), { pos: [cx, 0.82, cz], rot: [0, 0, Math.PI / 2] }));
      parts.push(tube(catenary([cx, 0.34, cz + 0.5], [cx + 1.9, 0.04, cz + 1.4], 0.5, 10), 0.045, 5));
      // Pallet stack and a rack of gas bottles.
      const px = cx + 1.9;
      for (let i = 0; i < 3; i++) {
        parts.push(place(bevelBox(1.2, 0.11, 0.9, 0.015), { pos: [px, 0.06 + i * 0.15, cz + 1.6], rot: [0, rng.range(-0.12, 0.12), 0] }));
      }
      for (let i = 0; i < 3; i++) {
        parts.push(place(new THREE.CylinderGeometry(0.17, 0.17, 1.25, 12, 1), { pos: [cx - 1.5 + (i - 1) * 0.42, 0.62, cz + 1.1] }));
        parts.push(place(new THREE.SphereGeometry(0.17, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), { pos: [cx - 1.5 + (i - 1) * 0.42, 1.25, cz + 1.1] }));
      }
      parts.push(place(bevelBox(1.6, 1.5, 0.06, 0.01), { pos: [cx - 1.5, 0.75, cz + 1.45] }));
    }

    // A fine texture scale on purpose. The dark-metal set carries a dense pit
    // pattern, and on members this close to the lens a two-metre tile magnifies
    // each pit into a visible white dot; at 60cm the same map reads as grain.
    const mesh = new THREE.Mesh(worldUv(mergeAll(parts), 0.6), this.materials.darkMetal);
    mesh.name = 'arena.structure.foreground';
    // This is the one stage layer whose shadow lands where anyone can see it.
    //
    // Nine layers used to be `castShadow = false` together, which is why the
    // deck read as a plane with objects floating over it. The nine were not
    // equally guilty: swept one at a time against the 06-stage-wide framing,
    // with the floor band y 700-1050 as the region and "darkened by more than
    // 6/255" as the count, `containers`, `ceilingRunHousings`, `wall.lamps` and
    // `midground` together move **0.06%** of that band -- they stand behind the
    // barrier or above the truss line, and nothing in the rig throws them into
    // the pit. This layer alone moves **4.8%** against a 0.32% run-to-run noise
    // floor, because the stanchion run, the rope line and the near scaffold
    // stand between the key and the reflective deck at the closest point in the
    // frame. That is the whole measured value of the sweep, so this is the only
    // flag that flips. See the round-16 note in StageFloor's contact shadows for
    // the other half of the same repair.
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.foreground = mesh;
    this.group.add(mesh);
  }

  // -------------------------------------------------------------------------
  // Instanced populations
  // -------------------------------------------------------------------------

  /** Stacked shipping containers, dressing the corners of the hall. */
  #containers() {
    const rng = this.rng;
    const geo = worldUv(bevelBox(6.06, 2.59, 2.44, 0.04), 2.4);
    const slots = [];
    for (let i = 0; i < 4; i++) slots.push([-17.5 + rng.range(-0.4, 0.4), 1.3 + (i % 2) * 2.62, -14.5 + (i >> 1) * 2.7, rng.range(-0.06, 0.06)]);
    for (let i = 0; i < 3; i++) slots.push([17.8 + rng.range(-0.5, 0.5), 1.3 + i * 2.62, -8 + rng.range(-1, 1), Math.PI / 2 + rng.range(-0.05, 0.05)]);
    for (let i = 0; i < 3; i++) slots.push([-19.5, 1.3 + i * 2.62, 4 + i * 0.4, rng.range(-0.05, 0.05)]);
    for (let i = 0; i < 2; i++) slots.push([16.5 + i * 0.6, 1.3 + i * 2.62, 12.5, rng.range(-0.08, 0.08)]);

    const mesh = new THREE.InstancedMesh(geo, this.materials.container, slots.length);
    mesh.name = 'arena.structure.containers';
    slots.forEach(([x, y, z, ry], i) => {
      _e.set(0, ry, 0);
      _q.setFromEuler(_e);
      _m.compose(_p.set(x, y, z), _q, _one);
      mesh.setMatrixAt(i, _m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // Stacked eighteen metres out and behind the back barrier: there is no
    // light in the rig that could throw one of these into the fight plane, so
    // they stay out of the shadow pass.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    this.containers = mesh;
    this.group.add(mesh);
  }

  /**
   * Onlookers on the terrace, the catwalks and the containers.
   *
   * Five things kill a crowd, and they have to be fixed together or the
   * remaining ones still read as wallpaper:
   *
   *   1. **One silhouette.** So the figure comes in six postures, each built at
   *      two proportion seeds — twelve outlines, dealt across the roster and
   *      then stretched, turned and leant per instance.
   *   2. **One value.** Every figure carries five albedo bands cut into the
   *      geometry — jacket, trousers, shoes/headwear, skin, hair — and all five
   *      are dealt per instance from their own palettes, with the trousers
   *      forced a minimum distance in value from the coat above them. One tint
   *      per figure is the failure mode this replaces: a body in a single value
   *      is a shape, and a rank of shapes is a fence. This is also why the tints
   *      are custom attributes rather than `instanceColor`: three only folds
   *      `instanceColor` into the fragment when `vertexColors` is on, and one
   *      colour per instance could not carry five bands anyway.
   *   3. **One depth.** They stand on four terrace treads and the back of the
   *      stand fades on view depth, so the ranks recede and overlap instead of
   *      lining up on one shelf at one brightness.
   *   4. **Too few of them.** Gaps between figures show the empty tread behind,
   *      and an audience you can see through is a queue. The terrace is packed
   *      to the point where the back ranks are mostly occluded heads.
   *   5. **No lights in it.** Every modern crowd is lit from inside by the
   *      phones held up in it, and those few dozen bright points are the single
   *      most legible cue that the mass is people. They are unlit instanced
   *      quads — the one way to put light in a crowd that costs nothing, which
   *      matters because this renderer is light-shader-bound and a real lamp
   *      here would cost more than the whole crowd does.
   *
   * Thirteen draw calls, no shadow pass, and no matching pair anywhere in it.
   */
  #crowd(quality) {
    const count = quality === 'low' ? 36 : quality === 'medium' ? 84 : 168;
    const seeds = quality === 'low' ? 1 : 2;
    const mat = this.materials.crowd.clone();
    mat.name = 'arena.crowdSway';
    // The shared crowd material is near-black so that a plain instance reads as
    // a silhouette. Here the per-instance tint is the albedo, so the base has to
    // be white or the palette multiplies into the same black it started from.
    mat.color.setRGB(1, 1, 1);
    // Behind a chain-link fence at twelve metres the crowd should be the last
    // thing the eye lands on, so it takes barely any of the environment.
    mat.envMapIntensity = 0.2;
    const uTime = this.timeUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          attribute float aPhase;
          attribute float aTone;
          attribute float aLean;
          attribute vec3 aTint;
          attribute vec3 aFlesh;
          attribute vec3 aMane;
          attribute vec3 aTrews;
          attribute vec3 aKit;
          uniform float uTime;
          varying vec3 vTint;
          varying float vSink;
        `)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          {
            float ph = aPhase * 6.2831853;
            // A standing lean the figure holds, plus a slow shift of weight on
            // top of it. The static part is what makes two instances of one
            // posture read as two people; the moving part is what stops the
            // whole terrace looking frozen.
            float sway = aLean + sin( uTime * 0.85 + ph ) * 0.05 + sin( uTime * 0.31 + ph * 2.7 ) * 0.03;
            float bob = sin( uTime * 1.6 + ph * 1.9 ) * 0.014;
            float c = cos( sway ), s = sin( sway );
            transformed.xz = mat2( c, -s, s, c ) * transformed.xz;
            transformed.x += sway * transformed.y * 0.42;
            transformed.y += bob;
          }
          // aTone is 0 jacket, 1 skin, 2 hair, 3 trousers, 4 shoes/hat/bag.
          // Integer bands, so one clamped triangle window per band picks it out
          // with no branch and no height threshold — the previous scheme cut the
          // waist at a fixed local y, which slid off the hips the moment an
          // instance was scaled.
          float wSkin  = clamp( 1.0 - abs( aTone - 1.0 ), 0.0, 1.0 );
          float wHair  = clamp( 1.0 - abs( aTone - 2.0 ), 0.0, 1.0 );
          float wTrews = clamp( 1.0 - abs( aTone - 3.0 ), 0.0, 1.0 );
          float wKit   = clamp( 1.0 - abs( aTone - 4.0 ), 0.0, 1.0 );
          vec3 worn = mix( mix( aTint, aTrews, wTrews ), aKit, wKit );
          vTint = mix( mix( worn, aFlesh, wSkin ), aMane, wHair );
        `)
        .replace('#include <project_vertex>', /* glsl */ `
          #include <project_vertex>
          // Contrast falloff across the stand itself. The scene fog is solved
          // for a twelve-metre room and moves the value almost nothing over the
          // four metres from the fence to the back tread, so without this the
          // rear rank is exactly as bright as the front one and four ranks
          // arrive as one card.
          vSink = 1.0 - exp( -max( 0.0, -mvPosition.z - 12.0 ) * 0.1 );
        `);
      shader.uniforms.uSink = this.midgroundHaze;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTint;\nvarying float vSink;\nuniform vec3 uSink;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTint;')
        .replace('#include <opaque_fragment>', /* glsl */ `
          #include <opaque_fragment>
          gl_FragColor.rgb = mix( gl_FragColor.rgb, uSink, vSink * 0.62 );
        `);
    };
    mat.customProgramCacheKey = () => 'kb-crowd';

    const rng = this.rng;
    // Deal the placements first, then split them by figure, so the mix is
    // spread evenly across the terrace rather than clumping by body type.
    const variants = CROWD_ARCHETYPES * seeds;
    const pick = (leaner) => (leaner && rng.next() < 0.5 ? 2 : rng.int(CROWD_ARCHETYPES)) + rng.int(seeds) * CROWD_ARCHETYPES;
    const slots = [];
    for (let i = 0; i < count; i++) {
      const r = rng.next();
      if (r < 0.84) {
        // On the terrace. The back ranks are fuller than the front because the
        // people who get to the barrier early are the ones already there, and
        // the rearmost rank stands off the back of the top tread rather than on
        // it, which puts a fifth band of heads behind the four.
        const rank = Math.min(TERRACE_RANKS, rng.int(TERRACE_RANKS + 1) + (rng.next() < 0.34 ? 1 : 0));
        const tread = Math.min(TERRACE_RANKS - 1, rank);
        slots.push({
          x: rng.range(-11.9, 11.9),
          y: TERRACE_Y0 + tread * TERRACE_RISE,
          // Jitter deep enough that neighbours in a rank sit at visibly
          // different depths: a rank pegged to one z line is a chorus row.
          z: TERRACE_Z0 - rank * TERRACE_RUN - rng.range(0.25, 0.8),
          // One in five is turned well off the pit — talking to the person beside
          // them rather than watching the fight. A terrace where every head
          // points the same way is an audience of cameras, and this is the one
          // orientation change that varies the silhouette without thinning the
          // mass, which is the trap the rest of this method fell into.
          ry: Math.PI + (rng.next() < 0.2 ? rng.range(-1.1, 1.1) : rng.range(-0.5, 0.5)),
          k: pick(rank === 0),
          phone: rank <= 2 && rng.next() < 0.22,
        });
      } else if (r < 0.95) {
        // On the side catwalks, leaning over the rail.
        const side = rng.next() < 0.5 ? -1 : 1;
        slots.push({
          x: side * 12.4 + rng.range(-0.3, 0.3),
          y: CATWALK_Y + 0.02,
          z: rng.range(-9, 13),
          ry: (side > 0 ? -Math.PI / 2 : Math.PI / 2) + rng.range(-0.3, 0.3),
          k: pick(true),
          phone: rng.next() < 0.3,
        });
      } else {
        // A few up on the containers.
        slots.push({
          x: rng.next() < 0.5 ? -17.5 + rng.range(-2, 2) : 17.8 + rng.range(-1.5, 1.5),
          y: 5.2,
          z: rng.range(-14, -6),
          ry: Math.PI + rng.range(-0.6, 0.6),
          k: pick(false),
          phone: false,
        });
      }
    }

    this.crowdMeshes = [];
    const scale = new THREE.Vector3();
    for (let k = 0; k < variants; k++) {
      const mine = slots.filter((s) => s.k === k);
      if (!mine.length) continue;
      const geo = crowdFigure(11 + k * 7, k % CROWD_ARCHETYPES);
      const mesh = new THREE.InstancedMesh(geo, mat, mine.length);
      mesh.name = `arena.structure.crowd${k}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // The terrace stands behind a metre of kerb and four metres of barrier:
      // no part of it can reach the floor's reflection, and at twelve meshes it
      // is the most expensive thing in the set to render a second time.
      mesh.layers.set(LAYER.NO_REFLECT);
      const phases = new Float32Array(mine.length);
      const leans = new Float32Array(mine.length);
      const tints = new Float32Array(mine.length * 3);
      const flesh = new Float32Array(mine.length * 3);
      const manes = new Float32Array(mine.length * 3);
      const legs = new Float32Array(mine.length * 3);
      const kits = new Float32Array(mine.length * 3);
      mine.forEach((s, i) => {
        _e.set(0, s.ry, 0);
        _q.setFromEuler(_e);
        // Height and bulk vary independently: a crowd where everyone is the
        // same shape at different sizes still reads as one figure scaled.
        scale.set(rng.range(0.9, 1.14), rng.range(0.93, 1.11), rng.range(0.9, 1.14));
        _m.compose(_p.set(s.x, s.y, s.z), _q, scale);
        mesh.setMatrixAt(i, _m);
        s.top = s.y + 1.62 * scale.y;
        // Garment colours, not a grey ramp. They are dark — this is a night
        // hangar — but they hold hue, so the cyan practicals behind the fence
        // separate a blue coat from a rust one instead of flattening both.
        // One figure in six wears the light tail. See CROWD_HIGHLIGHT: the
        // stand's problem was never hue or banding, it was that every band sat
        // inside the bottom fourteenth of the range.
        const lit = rng.next() < CROWD_HIGHLIGHT_RATE;
        const coat = lit
          ? CROWD_HIGHLIGHT[rng.int(CROWD_HIGHLIGHT.length)]
          : CROWD_PALETTE[rng.int(CROWD_PALETTE.length)];
        _c.setHex(coat, THREE.SRGBColorSpace)
          .multiplyScalar(lit ? rng.range(0.62, 1.06) : rng.range(0.72, 1.28));
        _c.toArray(tints, i * 3);
        const coatY = (_c.r + _c.g + _c.b) / 3;
        // Trousers, dealt independently and then *forced apart* in value from
        // the coat. Two garment palettes are not enough on their own: deal both
        // at random and roughly a third of the figures come out with a coat and
        // a pair of legs within a couple of per cent of each other, and those
        // are exactly the ones that read as a single shape. A hard minimum
        // separation is what turns the split from a statistic into something the
        // eye can find on every figure in the rank.
        _c.setHex(CROWD_LEGS[rng.int(CROWD_LEGS.length)], THREE.SRGBColorSpace)
          .multiplyScalar(rng.range(0.7, 1.3));
        const legY = (_c.r + _c.g + _c.b) / 3;
        if (Math.abs(legY - coatY) < 0.011) _c.multiplyScalar(legY > coatY ? 1.7 : 0.52);
        _c.toArray(legs, i * 3);
        _c.setHex(CROWD_KIT[rng.int(CROWD_KIT.length)], THREE.SRGBColorSpace)
          .multiplyScalar(rng.range(0.7, 1.35));
        _c.toArray(kits, i * 3);
        _c.setHex(CROWD_SKIN[rng.int(CROWD_SKIN.length)], THREE.SRGBColorSpace)
          .multiplyScalar(rng.range(0.7, 1.14));
        _c.toArray(flesh, i * 3);
        _c.setHex(CROWD_HAIR[rng.int(CROWD_HAIR.length)], THREE.SRGBColorSpace)
          .multiplyScalar(rng.range(0.8, 1.25));
        _c.toArray(manes, i * 3);
        phases[i] = rng.next();
        leans[i] = rng.range(-0.11, 0.11);
      });
      mesh.instanceMatrix.needsUpdate = true;
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
      geo.setAttribute('aLean', new THREE.InstancedBufferAttribute(leans, 1));
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
      geo.setAttribute('aFlesh', new THREE.InstancedBufferAttribute(flesh, 3));
      geo.setAttribute('aMane', new THREE.InstancedBufferAttribute(manes, 3));
      geo.setAttribute('aTrews', new THREE.InstancedBufferAttribute(legs, 3));
      geo.setAttribute('aKit', new THREE.InstancedBufferAttribute(kits, 3));
      this.crowdMeshes.push(mesh);
      this.group.add(mesh);
    }
    this.crowdMaterial = mat;
    this.#crowdPhones(slots.filter((s) => s.phone));
  }

  /**
   * The phones held up in the crowd: one instanced quad each, unlit.
   *
   * This is the cheapest high-value thing in the whole set. A dark mass of
   * bodies is ambiguous — it could be a crowd, it could be a stack of crates in
   * shadow. Three dozen small cold rectangles inside it are not ambiguous, and
   * they carry the same information a hundred modelled faces would at a
   * thousandth of the cost. They also do the job a light would do here without
   * being one: `MeshBasicMaterial` never enters the lighting loop, so the whole
   * bank is one draw call and no material in the scene recompiles.
   *
   * The screens drift in brightness rather than blinking. A blink reads as a
   * fault light; a slow wander reads as a screen with something moving on it.
   *
   * @param {Array<{x:number,y:number,z:number,ry:number,top:number}>} holders
   */
  #crowdPhones(holders) {
    if (!holders.length) return;
    const rng = this.rng;
    const mat = new THREE.MeshBasicMaterial({ name: 'arena.crowdPhone' });
    const uTime = this.timeUniform;
    // Same reason the crowd carries its tint by hand: `instanceColor` only
    // reaches the fragment when `vertexColors` is on, and turning that on
    // demands a `color` attribute this quad has no use for.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */ `
          #include <common>
          attribute float aPhase;
          attribute vec3 aScreen;
          uniform float uTime;
          varying vec3 vScreen;
        `)
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          float ph = aPhase * 6.2831853;
          vScreen = aScreen * ( 0.6 + 0.4 * sin( uTime * 0.7 + ph ) * sin( uTime * 0.23 + ph * 1.7 ) );
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vScreen;')
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.rgb *= vScreen;');
    };
    mat.customProgramCacheKey = () => 'kb-crowd-phone';

    const geo = new THREE.PlaneGeometry(0.075, 0.145);
    const mesh = new THREE.InstancedMesh(geo, mat, holders.length);
    mesh.name = 'arena.structure.crowdPhones';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.layers.set(LAYER.NO_REFLECT);
    const phases = new Float32Array(holders.length);
    const screens = new Float32Array(holders.length * 3);
    const scale = new THREE.Vector3();
    holders.forEach((s, i) => {
      // Held out toward the pit and either up over the heads in front or down
      // at chest height, because in any real crowd both are happening.
      const raised = rng.next() < 0.55;
      _e.set(rng.range(-0.5, -0.15), s.ry + Math.PI, rng.range(-0.35, 0.35));
      _q.setFromEuler(_e);
      scale.set(rng.range(0.85, 1.2), rng.range(0.85, 1.2), 1);
      _m.compose(_p.set(
        s.x + rng.range(-0.16, 0.16),
        raised ? s.top + rng.range(0.02, 0.26) : s.y + rng.range(1.15, 1.4),
        s.z + rng.range(0.3, 0.5),
      ), _q, scale);
      mesh.setMatrixAt(i, _m);
      // Screens are not white. A phone at night is a cold blue-white and a few
      // of them are warmer, and that spread is what stops three dozen identical
      // dots reading as a string of fairy lights. They are authored well over
      // 1.0 in linear so the bloom threshold catches them: a screen that does
      // not halo at all is a painted rectangle.
      _c.setHSL(rng.range(0.52, 0.63), rng.range(0.1, 0.42), rng.range(0.55, 0.8))
        .multiplyScalar(rng.range(1.5, 3.0));
      _c.toArray(screens, i * 3);
      phases[i] = rng.next();
    });
    mesh.instanceMatrix.needsUpdate = true;
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    geo.setAttribute('aScreen', new THREE.InstancedBufferAttribute(screens, 3));
    this.crowdPhones = mesh;
    this.crowdPhoneMaterial = mat;
    this.group.add(mesh);
  }

  /**
   * Three parallaxed layers of city seen through the blown-out panels.
   *
   * They are unlit boxes with a window grid evaluated in the fragment shader,
   * and they fade through their own exponential haze toward the mood's fog
   * colour. Doing the haze here rather than with `scene.fog` is what lets a
   * 90m skyline sit behind a 12m room without either one looking wrong.
   *
   * All three layers are one `InstancedMesh`. They were three, one per depth
   * band, because each band wants its own tint, haze gain and lit-window
   * density — but those are three numbers, and a number that varies per tower
   * is an instanced attribute, not a material. Carrying them as attributes
   * makes the skyline one draw call instead of three and leaves every layer
   * free to keep the values it had.
   */
  #city(quality) {
    const layers = quality === 'low' ? 2 : 3;
    const spec = [
      { z: -42, count: 26, w: [3, 7], h: [8, 26], spread: 78, tint: 0x1a222d, haze: 1.5, win: 0.8 },
      { z: -64, count: 24, w: [4, 9], h: [12, 34], spread: 105, tint: 0x151b24, haze: 2.1, win: 0.55 },
      { z: -92, count: 20, w: [5, 12], h: [16, 44], spread: 140, tint: 0x11161d, haze: 2.9, win: 0.34 },
    ];
    const rng = this.rng;
    const total = spec.slice(0, layers).reduce((n, s) => n + s.count, 0);

    const geo = new THREE.BoxGeometry(1, 1, 1);
    const sizes = new Float32Array(total * 3);
    const hashes = new Float32Array(total);
    const tints = new Float32Array(total * 3);
    const bands = new Float32Array(total * 2);
    const mesh = new THREE.InstancedMesh(geo, PLACEHOLDER, total);
    const size = new THREE.Vector3();
    _q.identity();

    let n = 0;
    for (let l = 0; l < layers; l++) {
      const s = spec[l];
      // Tints are authored as sRGB hex, and the shader writes straight into a
      // linear-working buffer, so the conversion has to happen here.
      _c.setHex(s.tint, THREE.SRGBColorSpace);
      for (let i = 0; i < s.count; i++, n++) {
        const w = rng.range(s.w[0], s.w[1]);
        const d = rng.range(s.w[0], s.w[1]);
        const h = rng.range(s.h[0], s.h[1]);
        size.set(w, h, d);
        sizes[n * 3] = w; sizes[n * 3 + 1] = h; sizes[n * 3 + 2] = d;
        hashes[n] = rng.next();
        _c.toArray(tints, n * 3);
        bands[n * 2] = s.haze;
        bands[n * 2 + 1] = s.win;
        _p.set((i / (s.count - 1) - 0.5) * s.spread + rng.range(-3, 3), h / 2 - 2, s.z + rng.range(-9, 9));
        _m.compose(_p, _q, size);
        mesh.setMatrixAt(n, _m);
      }
    }
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
    geo.setAttribute('aHash', new THREE.InstancedBufferAttribute(hashes, 1));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
    geo.setAttribute('aBand', new THREE.InstancedBufferAttribute(bands, 2));
    mesh.instanceMatrix.needsUpdate = true;

    mesh.material = new THREE.ShaderMaterial({
      name: 'arena.city',
      uniforms: {
        uTime: this.timeUniform,
        uHaze: { value: new THREE.Color(0x1b2634) },
        uWindow: { value: new THREE.Color(0xffc98a) },
        uWindowGain: { value: 1.0 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aSize;
        attribute float aHash;
        attribute vec3 aTint;
        attribute vec2 aBand;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying vec3 vNrm;
        varying float vHash;
        varying float vDepth;
        varying vec3 vTint;
        varying vec2 vBand;
        void main() {
          vLocal = position;
          vSize = aSize;
          vNrm = normal;
          vHash = aHash;
          vTint = aTint;
          vBand = aBand;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uHaze;
        uniform vec3 uWindow;
        uniform float uWindowGain;
        uniform float uTime;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying vec3 vNrm;
        varying float vHash;
        varying float vDepth;
        varying vec3 vTint;
        varying vec2 vBand;

        float hash21( vec2 p ) {
          p = fract( p * vec2( 231.34, 451.77 ) );
          p += dot( p, p + 34.21 );
          return fract( p.x * p.y );
        }

        void main() {
          vec3 col = vTint;
          if ( abs( vNrm.y ) < 0.5 ) {
            // Window grid at a fixed world pitch, so towers of different
            // sizes share one storey height.
            float across = mix( vSize.x, vSize.z, abs( vNrm.x ) );
            vec2 uvw = vec2( ( abs( vNrm.x ) > 0.5 ? vLocal.z : vLocal.x ) * across,
                             vLocal.y * vSize.y );
            vec2 pitch = vec2( 0.95, 1.9 );
            vec2 cellId = floor( uvw / pitch );
            vec2 f = fract( uvw / pitch );
            float pane = step( 0.24, f.x ) * step( f.x, 0.76 ) * step( 0.3, f.y ) * step( f.y, 0.74 );
            float r = hash21( cellId + vHash * 97.0 );
            float on = step( 1.0 - vBand.y * 0.3, r );
            // A handful blink; most are simply on or off for the night.
            float blink = r > 0.99 ? step( 0.5, fract( uTime * 0.31 + r * 10.0 ) ) : 1.0;
            // Offices run cold, flats run warm: mixing the two is what stops a
            // skyline reading as one orange stencil.
            vec3 lamp = mix( uWindow, vec3( 0.55, 0.74, 1.0 ), step( 0.55, fract( r * 7.3 ) ) );
            float lit = pane * on * blink * ( 0.25 + r * 0.55 );
            col = mix( col, lamp * uWindowGain, lit );
          }
          float haze = 1.0 - exp( -max( 0.0, vDepth - 22.0 ) * 0.0125 * vBand.x );
          col = mix( col, uHaze, haze );
          gl_FragColor = vec4( col, 1.0 );
        }
      `,
      fog: false,
    });
    mesh.name = 'arena.structure.city';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER.NO_REFLECT);
    this.city = mesh;
    this.cityMaterials = [mesh.material];
    this.group.add(mesh);
  }

  /** Housing and guard for the extract fan. Static, so it merges with the set. */
  #fanShroud() {
    const b = this.bins;
    b.dark.push(place(new THREE.CylinderGeometry(2.5, 2.5, 0.9, 24, 1, true), { pos: [-6.2, 6.3, -13.7], rot: [Math.PI / 2, 0, 0] }));
    b.steel.push(place(new THREE.TorusGeometry(2.5, 0.09, 6, 26), { pos: [-6.2, 6.3, -13.25] }));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI;
      b.steel.push(place(bevelBox(5.0, 0.05, 0.05, 0.01), { pos: [-6.2, 6.3, -13.2], rot: [0, 0, a] }));
    }
  }

  /** A big extract fan in the machinery bank; the set's slowest moving part. */
  #fan() {
    const parts = [];
    parts.push(place(new THREE.CylinderGeometry(0.28, 0.28, 0.5, 14), { pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] }));
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      parts.push(place(bevelBox(2.0, 0.5, 0.09, 0.015), {
        pos: [Math.cos(a) * 1.15, Math.sin(a) * 1.15, 0],
        rot: [0, 0.42, a],
      }));
    }
    const blades = new THREE.Mesh(worldUv(mergeAll(parts), 1.1), this.materials.darkMetal);
    blades.name = 'arena.structure.fan';
    blades.position.set(-6.2, 6.3, -13.4);
    blades.castShadow = false;
    this.fan = blades;
    this.group.add(blades);
  }

  /**
   * Broadcast drones. Six of them, drifting on lazy elliptical paths well above
   * and behind the fight plane, each with a blinking tally light.
   */
  #drones() {
    const parts = [];
    parts.push(place(bevelBox(0.42, 0.2, 0.3, 0.03), { pos: [0, 0, 0] }));
    parts.push(place(new THREE.CylinderGeometry(0.1, 0.13, 0.16, 12), { pos: [0, 0, 0.2], rot: [Math.PI / 2, 0, 0] }));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      parts.push(place(bevelBox(0.28, 0.035, 0.05, 0.008), { pos: [sx * 0.32, 0.06, sz * 0.16], rot: [0, sz * sx * 0.5, 0] }));
      parts.push(place(new THREE.TorusGeometry(0.16, 0.014, 4, 12), { pos: [sx * 0.45, 0.09, sz * 0.24], rot: [Math.PI / 2, 0, 0] }));
      parts.push(place(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 8), { pos: [sx * 0.45, 0.09, sz * 0.24] }));
    }
    const geo = worldUv(mergeAll(parts), 0.5);

    const COUNT = 6;
    this.drones = new THREE.InstancedMesh(geo, this.materials.darkMetal, COUNT);
    this.drones.name = 'arena.structure.drones';
    this.drones.castShadow = false;
    this.drones.frustumCulled = false;
    this.drones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const lensGeo = new THREE.SphereGeometry(0.055, 8, 6);
    this.droneLightMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2222), toneMapped: true });
    this.droneLights = new THREE.InstancedMesh(lensGeo, this.droneLightMaterial, COUNT);
    this.droneLights.name = 'arena.structure.droneLights';
    this.droneLights.frustumCulled = false;
    this.droneLights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.droneLights.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
    this.droneLights.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this._droneParams = [];
    for (let i = 0; i < COUNT; i++) {
      this._droneParams.push({
        rx: this.rng.range(7, 13),
        rz: this.rng.range(4, 8),
        cy: this.rng.range(6.4, 9.6),
        cz: this.rng.range(-5, 6),
        speed: this.rng.range(0.045, 0.1) * (this.rng.next() < 0.5 ? -1 : 1),
        phase: this.rng.range(0, Math.PI * 2),
        bob: this.rng.range(0.2, 0.6),
        blink: this.rng.range(0.7, 1.6),
      });
    }
    this.group.add(this.drones, this.droneLights);
  }

  /**
   * A severed power cable hanging off the roof structure. The sparks that come
   * off it are the Practicals' business; the cable is here.
   */
  #hangingCable() {
    const a = [4.2, ROOF_Y - 0.4, -11.2];
    const b = [9.6, 8.4, -13.4];
    const pts = catenary(a, b, 0.4, 18);
    // Frayed end: the last segment droops free and is where the arc happens.
    const tail = [
      pts[pts.length - 1].clone(),
      new THREE.Vector3(10.1, 7.1, -13.2),
      new THREE.Vector3(10.35, 6.1, -13.0),
    ];
    this.bins.dark.push(tube(pts, 0.055, 6), tube(tail, 0.045, 6));
    /** Where the arc lives; the Practicals hang the spark emitter here. */
    this.sparkPoint = new THREE.Vector3(10.35, 6.05, -13.0);
  }

  // -------------------------------------------------------------------------

  /**
   * @param {number} time seconds since the stage was built
   * @param {object} envParams live Environment mood parameters
   */
  update(time, envParams) {
    this.timeUniform.value = time;
    this.fan.rotation.z = time * 0.62;

    for (let i = 0; i < this._droneParams.length; i++) {
      const d = this._droneParams[i];
      const a = time * d.speed + d.phase;
      _p.set(Math.cos(a) * d.rx, d.cy + Math.sin(a * 2.3 + d.phase) * d.bob, d.cz + Math.sin(a) * d.rz);
      // Drones point their lens at the middle of the pit.
      _e.set(-0.32, Math.atan2(-_p.x, -_p.z), 0);
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _one);
      this.drones.setMatrixAt(i, _m);
      _p.y += 0.13;
      _m.compose(_p, _q, _one);
      this.droneLights.setMatrixAt(i, _m);
      const on = Math.sin(time * d.blink * 3.1 + d.phase) > 0.55 ? 1 : 0.06;
      _c.setRGB(2.6 * on, 0.16 * on, 0.14 * on);
      this.droneLights.setColorAt(i, _c);
    }
    this.drones.instanceMatrix.needsUpdate = true;
    this.droneLights.instanceMatrix.needsUpdate = true;
    this.droneLights.instanceColor.needsUpdate = true;

    // The city takes its haze colour from whatever mood is running, which is
    // what keeps a magenta night and a golden dusk from sharing a grey skyline.
    if (envParams?.fog?.color && this.cityMaterials) {
      for (const mat of this.cityMaterials) {
        mat.uniforms.uHaze.value.copy(envParams.fog.color).multiplyScalar(2.4);
        mat.uniforms.uWindow.value.copy(envParams.rimB?.color ?? mat.uniforms.uWindow.value).lerp(new THREE.Color(0xffc98a), 0.6);
      }
      // The yard sits in the same air as the skyline but nearer, so it takes
      // the mood's fog at a lower gain: enough to separate its bands, not so
      // much that a container stack at twenty-five metres joins the sky.
      const u = this.backdropMaterial.uniforms;
      u.uHaze.value.copy(envParams.fog.color).multiplyScalar(1.7);
      u.uTop.value.copy(envParams.fog.color).multiplyScalar(1.1);
      this.midgroundHaze.value.copy(envParams.fog.color).multiplyScalar(0.85);
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.cityMaterials ?? []) m.dispose();
    this.backdropMaterial?.dispose();
    this.midgroundMaterial?.dispose();
    this.crowdMaterial?.dispose();
    this.crowdPhoneMaterial?.dispose();
    this.droneLightMaterial?.dispose();
  }
}
