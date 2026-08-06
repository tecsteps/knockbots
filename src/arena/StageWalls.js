/**
 * Knockbots — the combat walls.
 *
 * These are load-bearing in the design sense: `ARENA_HALF_WIDTH` is a rule the
 * player has to *feel*, so the barriers are heavy, close, and they answer back.
 * A wall splat drives four things at once — a dent that stays for the round, a
 * dust burst off the surface, a compression of the impact pad, and a stutter in
 * the lamp above it. Those four together are what make the wall read as a
 * physical object rather than an invisible clamp.
 *
 * **This file is now the mechanism and `StageBarriers.js` is the set.** All four
 * of those behaviours are the same in a test cell, on a rooftop and in a flooded
 * vault; what differs is what the fighter is hitting. So a preset supplies the
 * geometry, the run's dimensions and the emitters' colours, and everything here
 * — the dent ring, the recoil springs, the flood cards, the flicker, the merge
 * into the shared bins — is arena-independent. `PIT_BARRIER` is the default and
 * is the geometry this file used to hold, moved unaltered.
 *
 * Both barriers are authored once in a local frame whose inner face is x=0 and
 * then mirrored, so the arena is symmetric by construction and nothing can ever
 * poke through the plane the fighters actually collide with. Every static part
 * of both walls is merged by material into single meshes; only the impact pads,
 * which have to move, keep their own transforms.
 */

import * as THREE from 'three';
import { ARENA_HALF_WIDTH, GROUND_Y } from '../core/Constants.js';
import { PIT_BARRIER } from './StageBarriers.js';
import { mergeAll, worldUv } from './GeoKit.js';

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
 * @param {number} runZ centre of the barrier run along z
 */
function buildRibbon(segs, runZ) {
  const n = segs.length;
  const pos = new Float32Array(n * 6 * 3);
  const nrm = new Float32Array(n * 6 * 3);
  const uv = new Float32Array(n * 6 * 2);
  const col = new Float32Array(n * 6 * 3);
  let p = 0, u = 0;
  for (const s of segs) {
    const f = s.side > 0 ? 1 : -1;           // +1: no flip. -1: rotate PI about Y.
    const wx = (x) => f > 0 ? ARENA_HALF_WIDTH + x : -ARENA_HALF_WIDTH - x;
    const wz = (z) => f > 0 ? runZ + z : runZ - z;
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
   * @param {object} deps.bins shared geometry bins, merged by the Stage
   * @param {import('./StageBarriers.js').BarrierPreset} [deps.barrier]
   */
  constructor({ materials, textures, bins, barrier = PIT_BARRIER }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.walls';
    this.materials = materials;
    this.barrier = barrier;

    /** @type {THREE.Vector3[]} where the impact lights sit; read by Stage. */
    this.lampPositions = [];

    /**
     * What a preset fills. Named lists rather than out-parameters in a fixed
     * order, because a rooftop has no ribbon board and a vault has no flood
     * cans, and a preset should be able to leave a list empty rather than
     * having to pass an empty array in the right slot.
     */
    const out = { emissive: [], ribbon: [], washes: [], lamps: [], pads: [] };
    for (const side of [-1, 1]) barrier.build(side, bins, out);
    // Second pass, both sides, after both barriers exist. The Stage merges each
    // bin into one mesh in push order, so a preset that wants its fittings to
    // land at the end of `bins.dark` has to say so — see `StageBarriers`.
    for (const side of [-1, 1]) barrier.lamps?.(side, bins, out);
    this._washes = out.washes;

    // Safety strip: a low line that grazes the floor and gives the wet surface
    // at the base of the wall something to reflect. It is unlit and animated,
    // so unlike the rest of the barrier it keeps its own mesh.
    this.stripMaterial = new THREE.MeshBasicMaterial({
      name: 'arena.wall.strip', color: new THREE.Color(0xff8a2a), toneMapped: true, fog: true,
    });
    const strip = new THREE.Mesh(mergeAll(out.emissive), this.stripMaterial);
    strip.name = 'arena.wall.strip';
    this.group.add(strip);

    // Ribbon board. One mesh, one draw call, fourteen independently coloured
    // segments — the colour rides in a vertex attribute rather than in fourteen
    // materials, the same trick `StagePracticals` uses for its four fixtures.
    // A preset with no board leaves the list empty and pays nothing.
    if (out.ribbon.length) {
      this.ribbonMaterial = new THREE.MeshBasicMaterial({
        name: 'arena.wall.ribbon', color: new THREE.Color(0xffffff), vertexColors: true,
        toneMapped: true, fog: true,
      });
      this.ribbon = new THREE.Mesh(buildRibbon(out.ribbon, barrier.z), this.ribbonMaterial);
      this.ribbon.name = 'arena.wall.ribbon';
      this.group.add(this.ribbon);
    }

    this.#buildWashes();
    this.#buildPads(materials, out.pads);
    this.#buildLamps(out.lamps);
    this.#buildDecals(textures);

    this.recoil = [new Recoil(5.2), new Recoil(5.2)];
    this._flicker = [0, 0];
  }

  // -------------------------------------------------------------------------

  /**
   * The pools the wall floods throw, as gradient cards on the barrier face.
   *
   * One card per can: a cone that starts at the shade, widens going down, and
   * dies before it reaches the impact pads — so the wall it lights is the part
   * of it the wide framing actually holds, and the fight plane at the bottom
   * stays the cleanest band in frame, which is the rule the whole set is built
   * to. Additive and depth-write off, so a card never occludes the surface it
   * is brightening; the falloff is baked into vertex colour rather than into a
   * texture because a 7x9 lattice is cheaper than a sampler and the gradient is
   * smooth enough that nothing shows.
   */
  #buildWashes() {
    const NZ = 7, NY = 9;
    const W = this.barrier.wash;
    const HALF_W = W.halfW, TOP = W.top, DROP = W.drop;
    const runZ = this.barrier.z;
    const n = this._washes.length * (NZ - 1) * (NY - 1) * 6;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let p = 0;
    const TINT = W.tint;
    const at = (w, jz, jy) => {
      const t = (jz / (NZ - 1)) * 2 - 1;            // -1..1 across the cone
      const v = jy / (NY - 1);                      // 0 at the shade, 1 at the tail
      const halfW = 0.34 + 0.66 * v;
      const radial = Math.min(1, Math.abs(t) / halfW);
      const a = (1 - radial * radial) * (1 - v) ** 1.5;
      return {
        x: W.faceX, y: TOP - v * DROP, z: w.z + t * HALF_W, a: Math.max(0, a),
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
            pos[p + 2] = f > 0 ? runZ + q.z : runZ - q.z;
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
   * Impact pads. These are the only parts of the wall that move, and they move
   * a lot: a heavy splat compresses one by four centimetres and it springs back
   * over about a third of a second.
   *
   * The geometry is the preset's — rubber ribs in the pit, tyre matting on the
   * roof, cast-iron fender bars in the vault — and the recoil is not.
   */
  #buildPads(materials, specs) {
    this.pads = [];
    this._padRest = [0, 0];
    for (const spec of specs) {
      const idx = spec.side > 0 ? 1 : 0;
      const geo = worldUv(mergeAll(spec.parts), spec.uv ?? 0.9);
      const mesh = new THREE.Mesh(geo, materials.rubber);
      mesh.name = `arena.wall.pads.${idx}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(spec.side * ARENA_HALF_WIDTH, 0, this.barrier.z);
      mesh.rotation.y = spec.side > 0 ? 0 : Math.PI;
      this.group.add(mesh);
      this.pads[idx] = mesh;
      this._padRest[idx] = mesh.position.x;
    }
  }

  /**
   * The lamps above each barrier. They are the light source that stutters when
   * the wall is hit, so their positions are published for the point light the
   * Stage owns. Housings went into the bins inside the preset; only the lenses
   * arrive here, because they are the part that has to change colour.
   */
  #buildLamps(lamps) {
    const lenses = [];
    for (const l of lamps) {
      lenses.push(l.lens);
      this.lampPositions.push(l.position);
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
    const B = this.barrier;
    const side = point.x >= 0 ? 1 : -1;
    const idx = side > 0 ? 1 : 0;
    const y = THREE.MathUtils.clamp(point.y, GROUND_Y + 0.35, B.height - 0.5);
    const z = THREE.MathUtils.clamp(point.z, B.z - B.length / 2 + 0.6, B.z + B.length / 2 - 0.6);

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
    //
    // The two tables are the preset's, because what is right for a caged work
    // lamp over a concrete barrier is not right for a festoon bulb on a roof at
    // dusk with a 620-unit sun already in frame.
    const L = this.barrier.lamp;
    const S = this.barrier.strip;
    this.lampMaterial.color.setRGB(L.rgb[0], L.rgb[1], L.rgb[2]).multiplyScalar(Math.max(0.05, hum * stutter) * L.gain);
    this.stripMaterial.color.setRGB(S.rgb[0], S.rgb[1], S.rgb[2]).multiplyScalar(S.gain + S.swing * Math.sin(time * S.hz));

    // Ribbon board. A global gain only — the per-segment colour is in the mesh —
    // carrying the same mains hum as the lamps plus a slow crawl, so the run
    // never sits at one exact value across fourteen panels. It dips with the
    // wall stutter too: everything on this barrier is on the same supply.
    if (this.ribbonMaterial) {
      const crawl = 0.94 + 0.06 * Math.sin(time * 0.8) + 0.02 * Math.sin(time * 3.1);
      const gain = crawl * (0.55 + 0.45 * Math.max(0.05, stutter));
      this.ribbonMaterial.color.setRGB(gain, gain, gain);
    }
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
    this.ribbonMaterial?.dispose();
    this.washMaterial.dispose();
    this.dents.material.dispose();
  }
}
