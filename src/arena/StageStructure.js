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
import { Rng } from '../core/Rng.js';
import {
  bevelBox, place, mergeAll, worldUv, truss, railing, pipeRun, tube,
  hydraulicRam, crowdFigure, CROWD_ARCHETYPES, insetPanel, boltRow, catenary, spanX,
} from './GeoKit.js';

const PIT_BACK = -8.6;      // z of the pit's rear kerb
const PIT_FRONT = 13.6;     // z of the front service edge
const CATWALK_Y = 5.7;
const ROOF_Y = 12.0;
const SHELL_Z = -19.0;      // the hangar's rear shell wall

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

    // Static geometry goes into the arena-wide bins; the Stage merges every
    // producer's contributions into one mesh per material at the end of init.
    this.bins = bins;

    this.#backEdge();
    this.#frontEdge();
    this.#columnsAndRoof();
    this.#catwalks();
    this.#machineryBank();
    this.#pipework();
    this.#shellWall();
    this.#outerShell();
    this.#fanShroud();
    this.#hangingCable();

    this.#midground();
    this.#foreground();

    this.#containers();
    this.#crowd(quality);
    this.#city(quality);
    this.#fan();
    this.#drones();
    this.bins = null;
  }

  // -------------------------------------------------------------------------
  // Near field
  // -------------------------------------------------------------------------

  /** The pit's rear kerb, its fence, and the platform the crowd stands on. */
  #backEdge() {
    const W = 24;
    const b = this.bins;
    b.concrete.push(place(bevelBox(W, 1.15, 0.6, 0.03), { pos: [0, 0.575, PIT_BACK - 0.3] }));
    b.steel.push(place(bevelBox(W, 0.1, 0.72, 0.02), { pos: [0, 1.2, PIT_BACK - 0.3] }));

    // Spectator deck, one step up and set back so the crowd overlaps the fence.
    b.concrete.push(place(bevelBox(W, 1.0, 5.2, 0.03), { pos: [0, 0.5, PIT_BACK - 3.2] }));
    b.concrete.push(place(bevelBox(W, 0.5, 5.2, 0.03), { pos: [0, 1.25, PIT_BACK - 4.6] }));

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
    const z0 = -12.6;

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
      const z = z0 - 3.4 - i * 1.9;
      b.dark.push(place(new THREE.CylinderGeometry(1.05, 1.05, 7.5, 20, 1), { pos: [8.5 - i * 0.4, y + 1.0, z], rot: [0, 0, Math.PI / 2] }));
      for (const dx of [-2.6, 0, 2.6]) {
        b.steel.push(place(bevelBox(0.5, 1.4, 1.9, 0.02), { pos: [8.5 - i * 0.4 + dx, 0.7, z] }));
      }
    }

    // Conveyor running out of the dark, stage left.
    b.steel.push(place(truss(11, 0.7, { thickness: 0.05, width: 0.06, bays: 8 }), { pos: [-12.5, 3.4, z0 - 5.5], rot: [0, 0.34, -0.13] }));
    b.dark.push(place(bevelBox(11, 0.22, 1.3, 0.02), { pos: [-12.5, 4.2, z0 - 5.5], rot: [0, 0.34, -0.13] }));
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
    const holes = [
      { x: -9.5, y: 9.5, w: 7.5, h: 6.0 },
      { x: 2.0, y: 11.5, w: 9.5, h: 7.5 },
      { x: 13.0, y: 8.0, w: 6.0, h: 5.0 },
    ];
    // The wall is built as horizontal bands that skip where a hole is, which is
    // cheaper and more controllable than any boolean.
    const bands = 22;
    for (let i = 0; i < bands; i++) {
      const y0 = (i * H) / bands;
      const y1 = ((i + 1) * H) / bands;
      const yc = (y0 + y1) / 2;
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
      for (const [a, c] of spans) {
        const w = c - a;
        if (w < 0.05) continue;
        b.container.push(place(bevelBox(w, y1 - y0 - 0.02, 0.34, 0.015), { pos: [(a + c) / 2, yc, SHELL_Z] }));
      }
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
    // Columns of the shell, in front of the plating.
    for (let i = -5; i <= 5; i++) {
      b.dark.push(place(bevelBox(0.3, H, 0.42, 0.02), { pos: [i * 4.2, H / 2, SHELL_Z + 0.3] }));
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

    // --- layer 0: back of house, z = -12.2 ---------------------------------
    // Directly behind the standing crowd and squarely inside the only band the
    // combat camera can see. Road cases, drum stacks and lighting stands: all
    // objects with a known size, so the crowd in front of them gets a scale.
    for (const [x, w, h, d] of [
      [-10.4, 1.3, 1.9, 0.9], [-9.0, 1.1, 1.3, 0.85], [-7.4, 1.5, 2.4, 1.0],
      [4.9, 1.2, 1.7, 0.9], [6.2, 1.4, 2.5, 1.0], [11.2, 1.25, 2.1, 0.9],
    ]) {
      const yaw = rng.range(-0.14, 0.14);
      parts.push(place(bevelBox(w, h, d, 0.04), { pos: [x, 1.5 + h / 2, -12.2], rot: [0, yaw, 0] }));
      parts.push(place(bevelBox(w + 0.09, 0.1, d + 0.09, 0.02), { pos: [x, 1.5 + h, -12.2], rot: [0, yaw, 0] }));
      for (const s of [-1, 1]) {
        parts.push(place(bevelBox(0.09, h - 0.2, 0.09, 0.02), { pos: [x + s * (w / 2 - 0.06), 1.5 + h / 2, -12.2 - d / 2], rot: [0, yaw, 0] }));
      }
    }
    for (const [x, n] of [[-3.4, 4], [2.1, 3], [8.6, 5]]) {
      for (let i = 0; i < n; i++) {
        parts.push(place(new THREE.CylinderGeometry(0.29, 0.29, 0.86, 12, 1), {
          pos: [x + (i % 3) * 0.62, 1.93 + Math.floor(i / 3) * 0.88, -12.3 + (i % 2) * 0.5],
        }));
      }
    }
    // A-frame lighting stands: thin verticals against all that stacked mass.
    for (const x of [-5.8, 0.4, 9.9]) {
      parts.push(place(new THREE.CylinderGeometry(0.045, 0.06, 2.6, 9, 1), { pos: [x, 2.8, -12.4] }));
      parts.push(place(bevelBox(1.3, 0.07, 0.07, 0.015), { pos: [x, 4.02, -12.4] }));
      for (const s of [-1, 1]) {
        const leg = spanX([x, 1.62, -12.4], [x + s * 0.55, 1.5, -12.4 + s * 0.35]);
        parts.push(place(bevelBox(leg.length, 0.05, 0.05, 0.012), { pos: leg.pos, rot: leg.rot }));
        parts.push(place(new THREE.CylinderGeometry(0.13, 0.11, 0.3, 10, 1), { pos: [x + s * 0.52, 3.86, -12.4], rot: [-0.5, 0, 0] }));
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

    // --- layer 4: through the blown-out panels, z = -31 --------------------
    // Read only as flat shapes against the city glow, which is exactly what a
    // silhouette 30 metres out through a hole in a wall should be.
    const FZ = -31;
    for (const [x, h] of [[-11.5, 21], [-2.5, 17.5], [14.5, 19]]) {
      parts.push(place(new THREE.CylinderGeometry(1.0, 1.5, h, 12, 1), { pos: [x, h / 2, FZ + rng.range(-3, 3)] }));
      parts.push(place(new THREE.CylinderGeometry(1.25, 1.25, 0.6, 12, 1), { pos: [x, h - 0.3, FZ] }));
    }
    // Two distant gantry cranes, legs and all.
    for (const [gx, gz, gs] of [[3.5, -29, 1], [-16, -36, 0.8]]) {
      const top = 15 * gs;
      for (const dx of [-4.5 * gs, 4.5 * gs]) {
        parts.push(place(bevelBox(0.5 * gs, top, 0.5 * gs, 0.04), { pos: [gx + dx, top / 2, gz] }));
      }
      parts.push(place(bevelBox(22 * gs, 0.9 * gs, 0.8 * gs, 0.04), { pos: [gx, top, gz] }));
      parts.push(place(bevelBox(1.6 * gs, 2.2 * gs, 1.2 * gs, 0.04), { pos: [gx - 6 * gs, top + 1.5 * gs, gz] }));
    }

    const mesh = new THREE.Mesh(worldUv(mergeAll(parts), 2.2), this.materials.darkMetal);
    mesh.name = 'arena.structure.midground';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    this.midground = mesh;
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
    mesh.castShadow = false;
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
    this.group.add(mesh);
  }

  /**
   * Onlookers behind the fence and on the catwalks.
   *
   * One instanced mesh would be one silhouette repeated forty times, and a
   * repeated silhouette is the loudest "unfinished" signal a stage can send. So
   * the crowd is six instanced meshes, one per body archetype, and the roster
   * of placements is dealt across them: six outlines, each stretched by a
   * per-instance height and bulk, turned to its own heading, tinted off a
   * per-instance colour and swayed off its own phase. Six draw calls buys a
   * crowd that never shows a matching pair.
   */
  #crowd(quality) {
    const count = quality === 'low' ? 18 : quality === 'medium' ? 30 : 52;
    const mat = this.materials.crowd.clone();
    mat.name = 'arena.crowdSway';
    const uTime = this.timeUniform;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPhase;\nuniform float uTime;')
        .replace('#include <begin_vertex>', /* glsl */ `
          #include <begin_vertex>
          {
            float ph = aPhase * 6.2831853;
            float sway = sin( uTime * 0.85 + ph ) * 0.05 + sin( uTime * 0.31 + ph * 2.7 ) * 0.03;
            float bob = sin( uTime * 1.6 + ph * 1.9 ) * 0.014;
            float c = cos( sway ), s = sin( sway );
            transformed.xz = mat2( c, -s, s, c ) * transformed.xz;
            transformed.x += sway * transformed.y * 0.42;
            transformed.y += bob;
          }
        `);
    };
    mat.customProgramCacheKey = () => 'kb-crowd';

    const rng = this.rng;
    // Deal the placements first, then split them by archetype, so the mix is
    // spread evenly across the fence rather than clumping by body type.
    const slots = [];
    for (let i = 0; i < count; i++) {
      const r = rng.next();
      if (r < 0.6) {
        // Pressed against the rear fence, two ranks deep. The front rank leans
        // on the barrier, so it is weighted toward the leaning archetypes.
        const rank = rng.next() < 0.62 ? 0 : 1;
        slots.push({
          x: rng.range(-11.5, 11.5),
          y: 1.5 + rank * 0.5,
          z: PIT_BACK - 1.5 - rank * 1.4 + rng.range(-0.25, 0.25),
          ry: Math.PI + rng.range(-0.35, 0.35),
          k: rank === 0 ? (rng.next() < 0.55 ? 2 : rng.int(CROWD_ARCHETYPES)) : rng.int(CROWD_ARCHETYPES),
        });
      } else if (r < 0.87) {
        // On the side catwalks, leaning over the rail.
        const side = rng.next() < 0.5 ? -1 : 1;
        slots.push({
          x: side * 12.4 + rng.range(-0.3, 0.3),
          y: CATWALK_Y + 0.02,
          z: rng.range(-9, 13),
          ry: (side > 0 ? -Math.PI / 2 : Math.PI / 2) + rng.range(-0.3, 0.3),
          k: rng.next() < 0.5 ? 2 : rng.int(CROWD_ARCHETYPES),
        });
      } else {
        // A few up on the containers.
        slots.push({
          x: rng.next() < 0.5 ? -17.5 + rng.range(-2, 2) : 17.8 + rng.range(-1.5, 1.5),
          y: 5.2,
          z: rng.range(-14, -6),
          ry: Math.PI + rng.range(-0.6, 0.6),
          k: rng.int(CROWD_ARCHETYPES),
        });
      }
    }

    this.crowdMeshes = [];
    const scale = new THREE.Vector3();
    for (let k = 0; k < CROWD_ARCHETYPES; k++) {
      const mine = slots.filter((s) => s.k === k);
      if (!mine.length) continue;
      const geo = crowdFigure(11 + k * 7, k);
      const mesh = new THREE.InstancedMesh(geo, mat, mine.length);
      mesh.name = `arena.structure.crowd${k}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(mine.length * 3), 3);
      const phases = new Float32Array(mine.length);
      mine.forEach((s, i) => {
        _e.set(0, s.ry, 0);
        _q.setFromEuler(_e);
        // Height and bulk vary independently: a crowd where everyone is the
        // same shape at different sizes still reads as one figure scaled.
        scale.set(rng.range(0.9, 1.14), rng.range(0.93, 1.11), rng.range(0.9, 1.14));
        _m.compose(_p.set(s.x, s.y, s.z), _q, scale);
        mesh.setMatrixAt(i, _m);
        // Clothing is not one colour, and a silhouette that is one flat value
        // flattens into a cardboard cut-out the moment two of them overlap.
        const v = rng.range(0.55, 1.5);
        _c.setRGB(v * rng.range(0.9, 1.1), v, v * rng.range(0.92, 1.18));
        mesh.setColorAt(i, _c);
        phases[i] = rng.next();
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
      this.crowdMeshes.push(mesh);
      this.group.add(mesh);
    }
    this.crowdMaterial = mat;
  }

  /**
   * Three parallaxed layers of city seen through the blown-out panels.
   *
   * They are unlit boxes with a window grid evaluated in the fragment shader,
   * and they fade through their own exponential haze toward the mood's fog
   * colour. Doing the haze here rather than with `scene.fog` is what lets a
   * 90m skyline sit behind a 12m room without either one looking wrong.
   */
  #city(quality) {
    const layers = quality === 'low' ? 2 : 3;
    const spec = [
      { z: -42, count: 26, w: [3, 7], h: [8, 26], spread: 78, tint: 0x1a222d, haze: 1.5, win: 0.8 },
      { z: -64, count: 24, w: [4, 9], h: [12, 34], spread: 105, tint: 0x151b24, haze: 2.1, win: 0.55 },
      { z: -92, count: 20, w: [5, 12], h: [16, 44], spread: 140, tint: 0x11161d, haze: 2.9, win: 0.34 },
    ];
    this.cityMaterials = [];
    const rng = this.rng;

    for (let l = 0; l < layers; l++) {
      const s = spec[l];
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const sizes = new Float32Array(s.count * 3);
      const hashes = new Float32Array(s.count);
      const mesh = new THREE.InstancedMesh(geo, PLACEHOLDER, s.count);
      const size = new THREE.Vector3();
      _q.identity();
      for (let i = 0; i < s.count; i++) {
        const w = rng.range(s.w[0], s.w[1]);
        const d = rng.range(s.w[0], s.w[1]);
        const h = rng.range(s.h[0], s.h[1]);
        size.set(w, h, d);
        sizes[i * 3] = w; sizes[i * 3 + 1] = h; sizes[i * 3 + 2] = d;
        hashes[i] = rng.next();
        _p.set((i / (s.count - 1) - 0.5) * s.spread + rng.range(-3, 3), h / 2 - 2, s.z + rng.range(-9, 9));
        _m.compose(_p, _q, size);
        mesh.setMatrixAt(i, _m);
      }
      geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizes, 3));
      geo.setAttribute('aHash', new THREE.InstancedBufferAttribute(hashes, 1));
      mesh.instanceMatrix.needsUpdate = true;

      mesh.material = new THREE.ShaderMaterial({
        name: `arena.city${l}`,
        uniforms: {
          uTime: this.timeUniform,
          uTint: { value: new THREE.Color(s.tint) },
          uHaze: { value: new THREE.Color(0x1b2634) },
          uHazeAmount: { value: s.haze },
          uWindow: { value: new THREE.Color(0xffc98a) },
          uWindowDensity: { value: s.win },
          uWindowGain: { value: 1.0 },
        },
        vertexShader: /* glsl */ `
          attribute vec3 aSize;
          attribute float aHash;
          varying vec3 vLocal;
          varying vec3 vSize;
          varying vec3 vNrm;
          varying float vHash;
          varying float vDepth;
          void main() {
            vLocal = position;
            vSize = aSize;
            vNrm = normal;
            vHash = aHash;
            vec4 mv = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
            vDepth = -mv.z;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTint;
          uniform vec3 uHaze;
          uniform vec3 uWindow;
          uniform float uHazeAmount;
          uniform float uWindowDensity;
          uniform float uWindowGain;
          uniform float uTime;
          varying vec3 vLocal;
          varying vec3 vSize;
          varying vec3 vNrm;
          varying float vHash;
          varying float vDepth;

          float hash21( vec2 p ) {
            p = fract( p * vec2( 231.34, 451.77 ) );
            p += dot( p, p + 34.21 );
            return fract( p.x * p.y );
          }

          void main() {
            vec3 col = uTint;
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
              float on = step( 1.0 - uWindowDensity * 0.3, r );
              // A handful blink; most are simply on or off for the night.
              float blink = r > 0.99 ? step( 0.5, fract( uTime * 0.31 + r * 10.0 ) ) : 1.0;
              // Offices run cold, flats run warm: mixing the two is what stops a
              // skyline reading as one orange stencil.
              vec3 lamp = mix( uWindow, vec3( 0.55, 0.74, 1.0 ), step( 0.55, fract( r * 7.3 ) ) );
              float lit = pane * on * blink * ( 0.25 + r * 0.55 );
              col = mix( col, lamp * uWindowGain, lit );
            }
            float haze = 1.0 - exp( -max( 0.0, vDepth - 22.0 ) * 0.0125 * uHazeAmount );
            col = mix( col, uHaze, haze );
            gl_FragColor = vec4( col, 1.0 );
          }
        `,
        fog: false,
      });
      const mat = mesh.material;
      mesh.name = `arena.structure.city${l}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      this.cityMaterials.push(mat);
      this.group.add(mesh);
    }
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
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.cityMaterials ?? []) m.dispose();
    this.crowdMaterial?.dispose();
    this.droneLightMaterial?.dispose();
  }
}
