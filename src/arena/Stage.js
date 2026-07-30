/**
 * Knockbots — the arena.
 *
 * **SUBLEVEL 09 — MECH TEST CELL.** A derelict mech-proving hangar at night.
 * The fight happens in a recessed test pit eighteen metres across, bounded by
 * steel-and-concrete barriers with rubber impact pads. Above and behind it the
 * hangar keeps going: catwalks at six metres, roof trusses at twelve, a bank of
 * hydraulic machinery across the back, a crowd pressed against the fence, and
 * three blown-out panels in the shell wall through which a rain-lit city sits
 * ninety metres away.
 *
 * The composition rules the whole set is built to:
 *
 *   1. **The fight plane is the brightest, cleanest band in frame.** Everything
 *      beyond three metres is held below 0.18 linear albedo and pushed into
 *      fog, so a lit armour plate always separates. Contrast in the environment
 *      comes from emitters and specular, never from paint.
 *   2. **The floor carries the fighters.** It is wet, and it reflects them for
 *      real through a mirrored render pass, blended by roughness so it reads as
 *      wet concrete rather than a mirror.
 *   3. **Nothing distracting sits near the fight plane.** All the moving
 *      elements — the extract fan, the drones, the crowd sway, the steam, the
 *      arcing cable — are behind, above, or well outside the play bounds.
 *
 * Structure of this file: it owns nothing but composition. The floor, walls,
 * hangar, volumetrics and emitters are each their own module; `Stage` builds
 * them, wires the renderer-dependent bits, and routes `impact()`.
 *
 * @see docs/CHARTER.md for the API this class must satisfy.
 */

import * as THREE from 'three';
import { ARENA_HALF_WIDTH, ARENA_HALF_DEPTH, GROUND_Y } from '../core/Constants.js';
import { Rng } from '../core/Rng.js';
import { makeArenaMaterials } from './StageMaterials.js';
import { PlanarReflector } from './PlanarReflector.js';
import { StageFloor } from './StageFloor.js';
import { StageWalls } from './StageWalls.js';
import { StageStructure } from './StageStructure.js';
import { StageVolumetrics } from './StageVolumetrics.js';
import { StagePracticals } from './StagePracticals.js';
import { PointBurst } from './StageParticles.js';
import { triCount, mergeAll, worldUv } from './GeoKit.js';

/** Reflection buffer as a fraction of the drawing buffer, per quality tier. */
const REFLECT_SCALE = { ultra: 0.6, high: 0.5, medium: 0.36, low: 0 };

const _pt = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class Stage {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../engine/Environment.js').Environment} environment
   */
  constructor(scene, environment) {
    this.scene = scene;
    this.environment = environment;
    this.quality = environment?.quality ?? 'high';

    /** @type {{halfWidth:number, halfDepth:number}} combat reads this. */
    this.bounds = { halfWidth: ARENA_HALF_WIDTH, halfDepth: ARENA_HALF_DEPTH };
    /** @type {number} */
    this.floorY = GROUND_Y;

    this.root = new THREE.Group();
    this.root.name = 'arena';

    /** Seeded so `impact()` — which the deterministic sim calls — never uses Math.random. */
    this.rng = new Rng(0x53544147);
    this._time = 0;
    this._frame = 0;
    this._reflectSize = { w: 0, h: 0 };
    this._pixelScaleTargets = [];

    this.ready = false;
  }

  /**
   * Bakes every texture, builds every mesh and installs the arena in the scene.
   * Yields between the expensive bakes so a loading screen can still paint.
   * @returns {Promise<void>}
   */
  async init() {
    const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

    const lib = makeArenaMaterials({ quality: this.quality });
    this.materialLibrary = lib;
    this.materials = lib.materials;
    this.textures = lib.textures;
    await yieldToPaint();

    this.reflector = new PlanarReflector(this.scene, {
      planeY: this.floorY,
      width: 1024,
      height: 512,
      clipBias: 0.005,
    });
    this.reflector.enabled = REFLECT_SCALE[this.quality] > 0;

    /**
     * Every static surface in the arena, sorted by material. The floor's drain
     * trenches, the barriers, the hangar and the light fittings all deposit
     * geometry here and it is merged exactly once, at the end of `init`, into
     * one mesh per material. That is what keeps a set of six hundred primitives
     * inside a fighting game's draw-call budget.
     */
    const bins = { dark: [], steel: [], concrete: [], hazard: [], grate: [], chain: [], container: [], plate: [], banner: [] };

    this.floor = new StageFloor({
      reflector: this.reflector,
      materials: this.materials,
      textures: this.textures,
      bins,
      quality: this.quality,
    });
    this.root.add(this.floor.group);
    await yieldToPaint();

    this.walls = new StageWalls({ materials: this.materials, textures: this.textures, bins });
    this.root.add(this.walls.group);
    await yieldToPaint();

    this.structure = new StageStructure({
      materials: this.materials,
      textures: this.textures,
      bins,
      quality: this.quality,
    });
    this.root.add(this.structure.group);
    await yieldToPaint();

    this.volumetrics = new StageVolumetrics({ textures: this.textures, quality: this.quality });
    this.root.add(this.volumetrics.group);

    this.practicals = new StagePracticals({
      environment: this.environment,
      materials: this.materials,
      textures: this.textures,
      bins,
      sparkPoint: this.structure.sparkPoint,
    });
    this.root.add(this.practicals.group);

    this.#commitBins(bins);
    await yieldToPaint();

    /**
     * Where the visible emitters are, so lighting can be matched to the set.
     * @type {{position: THREE.Vector3, color: THREE.Color, power: number, size: THREE.Vector2}[]}
     */
    this.practicalPositions = this.practicals.practicalPositions;

    this.#buildImpactFx();
    this.#wireReflection();

    // Volumetrics and decals must not appear in the mirror; a light shaft is
    // already integrated along the view ray and a decal is painted on the very
    // surface doing the reflecting.
    //
    // Everything after those is there for cost rather than correctness. The
    // mirror is a second scene render and was the single largest block of draw
    // calls in the frame — 47 of 171 at the hero framing. Each module names the
    // meshes whose reflection is not worth a draw call, and the merged sets do
    // the same through the spec in `#commitBins`. Measured at 1080p: 47 draw
    // calls down to 33, with 01-hero-idle and 06-stage-wide captured either side
    // and no difference visible in the floor at either framing.
    this.reflector.exclude([
      this.volumetrics.group,
      this.floor.decals,
      this.dust.points,
      this.walls.dents,
      ...this.mergedNoReflect,
      ...this.structure.noReflect,
      ...this.practicals.noReflect,
    ]);

    this.scene.add(this.root);
    this.ready = true;
  }

  /**
   * Merges the shared geometry bins into one mesh per material.
   *
   * `metresPerTile` is null for the sets whose UVs were authored deliberately —
   * grating and chain-link carry a wire-scale layout that a world-space
   * reprojection would destroy, and the warning plates are stencilled signs
   * rather than a tiling surface.
   */
  #commitBins(bins) {
    // key, material, metresPerTile, casts shadows, appears in the mirror.
    //
    // The mirror column is the cheaper half of the draw-call budget: every set
    // that stays in it is drawn a second time. What earns a place there is
    // whether it is what makes the floor read as wet — and measured against
    // captures, that is the pit itself. Dropping `steel`, `dark` and `concrete`
    // from the mirror flattens the floor visibly: the vertical smear the
    // barrier band throws down the right of the wide shot disappears and the
    // deck goes matte. Dropping the other five changes nothing that can be seen
    // at either framing, because they are signage and containers standing
    // outside the pit, behind the only surface doing the reflecting.
    const spec = [
      ['concrete', this.materials.concrete, 3.4, true, true],
      ['hazard', this.materials.hazard, 1.6, true, false],
      ['steel', this.materials.steel, 1.5, true, true],
      ['dark', this.materials.darkMetal, 1.9, true, true],
      ['container', this.materials.container, 2.2, true, false],
      ['grate', this.materials.grating, null, true, false],
      ['chain', this.materials.chainLink, null, false, false],
      ['plate', this.materials.warningPlate, null, false, false],
      ['banner', this.materials.barrierBanner, null, false, false],
    ];
    this.merged = [];
    /** Merged sets the mirror pass skips. @type {THREE.Mesh[]} */
    this.mergedNoReflect = [];
    for (const [key, mat, uv, shadows, reflects] of spec) {
      const list = bins[key];
      if (!list || !list.length) continue;
      const geo = mergeAll(list);
      if (uv) worldUv(geo, uv);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `arena.set.${key}`;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.root.add(mesh);
      this.merged.push(mesh);
      if (!reflects) this.mergedNoReflect.push(mesh);
      bins[key] = null;
    }
  }

  /** Dust and grit thrown off a wall or the deck, plus the wall flash lights. */
  #buildImpactFx() {
    this.dust = new PointBurst(this.textures.dust, {
      count: 320,
      color: 0x8d8b86,
      gravity: -5.2,
      drag: 2.6,
      additive: false,
      floorY: this.floorY,
      bounce: 0.1,
    });
    this.dust.points.name = 'arena.impactDust';
    this.root.add(this.dust.points);

    this.grit = new PointBurst(this.textures.spark, {
      count: 180,
      color: 0xffb060,
      gravity: -17,
      drag: 0.9,
      additive: true,
      floorY: this.floorY,
      bounce: 0.34,
    });
    this.grit.points.name = 'arena.impactGrit';
    this.root.add(this.grit.points);

    // One flash light per barrier. Created here, before RenderPipeline.warmup,
    // so the light count never changes and no material ever recompiles.
    this.wallLights = [];
    for (const side of [-1, 1]) {
      const l = new THREE.PointLight(0xffe0b0, 0, 11, 2);
      l.position.set(side * (ARENA_HALF_WIDTH - 0.4), 2.0, 2.0);
      l.castShadow = false;
      this.wallLights.push(l);
      this.root.add(l);
    }
  }

  /**
   * The mirror pass runs from the floor's `onBeforeRender`, which is the only
   * place the Stage ever sees the renderer. Renderer-dependent bookkeeping —
   * the reflection buffer's size and the point-sprite pixel scale — rides
   * along with it.
   */
  #wireReflection() {
    this._pixelScaleTargets = [
      this.dust.material, this.grit.material,
      this.volumetrics.motes.material, this.volumetrics.steam.material,
      this.practicals.sparks.material,
    ];

    const inner = this.floor.mesh.onBeforeRender;
    const size = new THREE.Vector2();
    this.floor.mesh.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
      renderer.getDrawingBufferSize(size);
      const scale = REFLECT_SCALE[this.quality] ?? 0.5;
      if (scale > 0) {
        const w = Math.round(size.x * scale);
        const h = Math.round(size.y * scale);
        if (w !== this._reflectSize.w || h !== this._reflectSize.h) {
          this.reflector.setSize(w, h);
          this._reflectSize.w = w;
          this._reflectSize.h = h;
        }
      }
      // gl_PointSize is in drawing-buffer pixels, so a sprite's metric size
      // only survives a resolution change if this is recomputed from the lens.
      if (camera.isPerspectiveCamera) {
        const px = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
        for (const m of this._pixelScaleTargets) m.uniforms.uPixelScale.value = px;
      }
      inner(renderer, scene, camera, geometry, material, group);
    };
  }

  // -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds since the last rendered frame
   * @param {number} tick current simulation tick, per the charter. The stage is
   *   presentation only and animates off wall-clock time, so it is accepted and
   *   ignored; nothing here may influence the deterministic sim.
   */
  update(dt, tick) { // eslint-disable-line no-unused-vars
    if (!this.ready) return;
    this._time += dt;
    const t = this._time;
    const env = this.environment;
    const params = env?.params;

    // Arm the mirror for exactly one scene render this frame; the pipeline
    // draws the scene more than once and only the main pass should pay for it.
    this.reflector.arm(++this._frame);

    this.floor.update(dt, t, params);
    this.walls.update(dt, t);
    this.structure.update(t, params);
    this.volumetrics.update(t, env?.shaftIntensity ?? 0.5, params);
    this.practicals.update(dt, t, params);
    this.dust.update(dt);
    this.grit.update(dt);

    // Wall flash: decays with the barrier's own flicker envelope.
    for (let i = 0; i < 2; i++) {
      const f = this.walls.flickerAt(i);
      this.wallLights[i].intensity = f > 0 ? f * f * 26 * (0.55 + Math.random() * 0.45) : 0;
    }
  }

  /**
   * Something hit the set. Called from the deterministic simulation, so every
   * random draw here goes through the seeded generator.
   * @param {THREE.Vector3} point world-space contact point
   * @param {number} force roughly 0.4 (a scuff) to 2.2 (a knockout)
   */
  impact(point, force) {
    if (!this.ready) return;
    const f = Math.max(0, force);

    const nearWall = Math.abs(point.x) > ARENA_HALF_WIDTH - 1.1;
    const nearFloor = point.y < this.floorY + 0.6;

    if (nearWall) {
      const side = this.walls.strike(point, f, this.rng);
      _pt.set(side * (ARENA_HALF_WIDTH - 0.08), THREE.MathUtils.clamp(point.y, this.floorY + 0.2, 4.2), point.z);
      _dir.set(-side, 0.45, 0).normalize();
      this.dust.emit(_pt, _dir, 10 + Math.min(26, (f * 14) | 0), {
        rng: this.rng, speed: 2.2 + f * 1.7, spread: 0.85, life: 1.5 + f * 0.5, size: 0.24 + f * 0.1,
      });
      if (f > 0.8) {
        this.grit.emit(_pt, _dir, 8 + Math.min(20, (f * 9) | 0), {
          rng: this.rng, speed: 5 + f * 3, spread: 0.7, life: 0.7, size: 0.05,
        });
      }
      // A heavy splat is bright enough to lift the whole room for a moment.
      if (f > 1.2) this.environment?.pulse?.(0xffd9b0, Math.min(0.5, f * 0.18), 0.35);
      return;
    }

    if (nearFloor) {
      this.floor.scuff(point, 0.9 + f * 1.5, Math.min(0.9, 0.25 + f * 0.32), this.rng.range(0, Math.PI * 2));
      _pt.set(point.x, this.floorY + 0.05, point.z);
      _dir.set(this.rng.range(-0.3, 0.3), 1, this.rng.range(-0.3, 0.3)).normalize();
      this.dust.emit(_pt, _dir, 8 + Math.min(22, (f * 12) | 0), {
        rng: this.rng, speed: 1.4 + f * 1.3, spread: 0.95, life: 1.7 + f * 0.6, size: 0.28 + f * 0.14,
      });
      return;
    }

    // Mid-air: a small puff of the grit hanging in the room, nothing more.
    if (f > 0.9) {
      _dir.set(this.rng.range(-1, 1), this.rng.range(-0.4, 0.6), this.rng.range(-1, 1)).normalize();
      this.dust.emit(point, _dir, 6, {
        rng: this.rng, speed: 1.6, spread: 1.0, life: 1.1, size: 0.16,
      });
    }
  }

  /** Clears everything a round left behind. */
  reset() {
    if (!this.ready) return;
    this.rng.reseed(0x53544147);
    this.floor.reset();
    this.walls.reset();
    this.practicals.reset();
    this.dust.reset();
    this.grit.reset();
    for (const l of this.wallLights) l.intensity = 0;
  }

  /**
   * Drops or restores the expensive parts. Mirrors the tier names the rest of
   * the engine uses.
   * @param {'ultra'|'high'|'medium'|'low'} q
   */
  setQuality(q) {
    if (!REFLECT_SCALE[q] && REFLECT_SCALE[q] !== 0) return;
    this.quality = q;
    if (!this.ready) return;
    const scale = REFLECT_SCALE[q];
    this.reflector.enabled = scale > 0;
    this.floor.reflectionScale = scale > 0 ? 1 : 0;
    this._reflectSize.w = 0;
    const shafts = q === 'low' ? 2 : q === 'medium' ? 3 : this.volumetrics.shafts.length;
    this.volumetrics.shafts.forEach((s, i) => { s.visible = i < shafts; });
    this.volumetrics.haze.visible = q !== 'low';
  }

  /**
   * Triangle and draw-call accounting, for the QA harness and the budget in
   * the charter.
   * @returns {{triangles:number, drawables:number}}
   */
  budget() {
    let triangles = 0;
    let drawables = 0;
    this.root.traverse((o) => {
      if (!o.geometry) return;
      drawables++;
      const n = triCount(o.geometry);
      triangles += o.isInstancedMesh ? n * o.count : n;
    });
    return { triangles: Math.round(triangles), drawables };
  }

  dispose() {
    if (!this.ready) return;
    this.scene.remove(this.root);
    this.floor.dispose();
    this.walls.dispose();
    this.structure.dispose();
    this.volumetrics.dispose();
    this.practicals.dispose();
    this.dust.dispose();
    this.grit.dispose();
    for (const m of this.merged ?? []) m.geometry.dispose();
    this.reflector.dispose();
    this.materialLibrary.dispose();
    this.ready = false;
  }
}
