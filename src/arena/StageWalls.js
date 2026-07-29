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
    for (const side of [-1, 1]) this.#buildSide(side, bins, emissive);

    // Safety strip: a low amber line that grazes the floor and gives the wet
    // concrete at the base of the wall something to reflect. It is unlit and
    // animated, so unlike the rest of the barrier it keeps its own mesh.
    this.stripMaterial = new THREE.MeshBasicMaterial({
      name: 'arena.wall.strip', color: new THREE.Color(0xff8a2a), toneMapped: true, fog: true,
    });
    const strip = new THREE.Mesh(mergeAll(emissive), this.stripMaterial);
    strip.name = 'arena.wall.strip';
    this.group.add(strip);

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
  #buildSide(side, bins, emissive) {
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
    const size = 0.55 + Math.min(1.6, force) * 0.85;
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
    this.lampMaterial.color.setRGB(1.0, 0.94, 0.82).multiplyScalar(Math.max(0.05, hum * stutter) * 2.4);
    this.stripMaterial.color.setRGB(1.0, 0.42, 0.1).multiplyScalar(1.35 + 0.08 * Math.sin(time * 1.7));

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
    this.dents.material.dispose();
  }
}
