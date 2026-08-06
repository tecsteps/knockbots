/**
 * Knockbots — the arena.
 *
 * **Three of them, one at a time.** `Stage` is the composition and
 * `src/arena/Arenas.js` is the table of what each one is made of: a floor
 * surface, a combat-barrier preset, a set module, an atmosphere, a lighting
 * mood, and its own signage. Nothing below branches on which arena is running —
 * it reads the definition and builds it — and `setArena` tears one down and
 * puts the next up in place, so the triangle budget is the largest arena rather
 * than their sum.
 *
 * The rules in the next paragraphs are `sublevel09`'s, and they are stated at
 * length because they are the ones the other two were designed against.
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
import { StageFloor, CONTACT_COUNT } from './StageFloor.js';
import { StageWalls } from './StageWalls.js';
import { StageVolumetrics } from './StageVolumetrics.js';
import { StagePracticals } from './StagePracticals.js';
import { arenaDef, ARENA_IDS, DEFAULT_ARENA } from './Arenas.js';
import { PointBurst } from './StageParticles.js';
import { triCount, mergeAll, worldUv } from './GeoKit.js';

/** Reflection buffer as a fraction of the drawing buffer, per quality tier. */
const REFLECT_SCALE = { ultra: 0.6, high: 0.5, medium: 0.36, low: 0 };

const _pt = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _foot = new THREE.Vector3();
const _root = new THREE.Vector3();
const _lightDir = new THREE.Vector3();

/**
 * How the fighters' contact shadows are shaped. Radii are metres at rest and
 * open with height off the deck, the way a real penumbra does; `fade` is the
 * height at which the mark is gone.
 */
const CONTACT = {
  /** Semi-axis along the key light's ground azimuth, and across it. */
  bodyLong: 1.94,
  bodyShort: 1.68,
  /** How far down-light the body pool sits from the fighter's own centre. */
  bodyPush: 0.44,
  bodyStrength: 0.72,
  bodyHardness: 0.30,
  footLong: 0.62,
  footShort: 0.54,
  footPush: 0.12,
  footStrength: 1.0,
  footHardness: 0.42,
  /** Metres of lift that doubles a lobe's radius. */
  spread: 1.15,
  /** Height at which a lobe has faded out entirely. */
  fade: 1.5,
};

export class Stage {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../engine/Environment.js').Environment} environment
   * @param {{arena?: string}} [opts] which arena to build. Unknown ids resolve
   *   to the default rather than throwing — see `Arenas.arenaDef`.
   */
  constructor(scene, environment, opts = {}) {
    this.scene = scene;
    this.environment = environment;
    this.quality = environment?.quality ?? 'high';

    /**
     * The arena definition this Stage is currently built to.
     * @type {import('./Arenas.js').ArenaDef}
     */
    this.arena = arenaDef(opts.arena ?? Stage.initialArena());

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
    const A = this.arena;

    // The mood is part of the arena, not a separate setting. Told before
    // anything is built, with a zero-second fade, so the first frame the floor
    // and the set ever see is the right one — `StageFloor` resolves its warm and
    // cool anchors from the live mood and `StageRooftop` reads the key's own
    // direction for its shadow lines.
    if (this.environment?.mood !== A.mood) this.environment?.setMood?.(A.mood, 0);

    const lib = makeArenaMaterials({ quality: this.quality, signage: A.signage ?? undefined });
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
      surface: A.surface,
    });
    this.root.add(this.floor.group);
    await yieldToPaint();

    this.walls = new StageWalls({ materials: this.materials, textures: this.textures, bins, barrier: A.barrier });
    this.root.add(this.walls.group);
    await yieldToPaint();

    /**
     * The set: everything beyond the barriers. `StageStructure` for the pit,
     * `StageRooftop` and `StageVault` for the other two. All three satisfy the
     * same small contract — a group, a `noReflect` list, an optional
     * `sparkPoint`, and `update(dt, time, envParams)` — so nothing downstream
     * knows which one it has.
     */
    this.structure = new A.Set({
      environment: this.environment,
      materials: this.materials,
      textures: this.textures,
      bins,
      quality: this.quality,
    });
    this.root.add(this.structure.group);
    await yieldToPaint();

    this.volumetrics = new StageVolumetrics({ textures: this.textures, quality: this.quality, air: A.air });
    this.root.add(this.volumetrics.group);

    /**
     * The pit's emitters are their own module because that set was built before
     * arenas existed and its fittings, pools, washes, screens and arc are half
     * the frame. The two newer sets own theirs, so they run without this one
     * rather than inheriting a shop floor's light fittings — hence the flag in
     * the registry rather than a `sparkPoint` check.
     */
    this.practicals = A.practicals
      ? new StagePracticals({
        environment: this.environment,
        materials: this.materials,
        textures: this.textures,
        bins,
        sparkPoint: this.structure.sparkPoint,
      })
      : null;
    if (this.practicals) this.root.add(this.practicals.group);

    this.#commitBins(bins);
    await yieldToPaint();

    /**
     * Where the visible emitters are, so lighting can be matched to the set.
     * Whichever module owns the emitters publishes it.
     * @type {{position: THREE.Vector3, color: THREE.Color, power: number, size: THREE.Vector2}[]}
     */
    this.practicalPositions = (this.practicals ?? this.structure).practicalPositions ?? [];

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
      this.floor.contacts,
      this.dust.points,
      this.walls.dents,
      ...this.mergedNoReflect,
      ...(this.structure.noReflect ?? []),
      ...(this.practicals?.noReflect ?? []),
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

    // ONE flash light for both barriers, repositioned on strike.
    //
    // Created here, before RenderPipeline.warmup, so the light count never
    // changes and no material ever recompiles — that is the same hazard that
    // cost 437-831ms per stall in the effects director.
    //
    // It is one light rather than two because a fighter can only be driven into
    // one barrier at a time, and an analytic light is evaluated per pixel over
    // the whole frame whether or not its intensity is zero.
    //
    // Measured, paired A/B with the sim paused, 1080p, render scale pinned,
    // six alternations per point, hero framing. A shadowless PointLight in this
    // scene costs a flat **~1.5ms**, and the cost is linear in the count:
    //
    //     1 light  1.55ms  IQR [1.3, 1.7]   (reproduced in a second session: 1.53)
    //     2 lights 2.92ms  IQR [2.9, 3.0]
    //     3 lights 4.37ms  IQR [4.2, 4.5]
    //
    // So collapsing two wall lights into one buys ~1.5ms. An earlier figure of
    // mine — "~9.7ms for the arena's three" — was wrong by 2.2x; it came from
    // three unpaired reps on a loaded machine whose own spread was 6.1-13.9ms.
    // The paired numbers above are internally consistent (3 x 1.46 = 4.37) and
    // consistent with mechanism: a RectAreaLight runs the full LTC path and
    // costs roughly 4.6ms on a looser measurement, about 3x a point light,
    // where the inflated figure implied only 1.4x — implausible for a
    // normalize, an attenuation and a dot product against two texture lookups
    // and matrix work. A light that is dark 99% of the match is not free; it is
    // only invisible. It is just not worth 9.7ms, and claiming that it was
    // would have made this change look like a regression when re-measured.
    this.wallLight = new THREE.PointLight(0xffe0b0, 0, 11, 2);
    this.wallLight.position.set(ARENA_HALF_WIDTH - 0.4, 2.0, 2.0);
    this.wallLight.castShadow = false;
    this.root.add(this.wallLight);
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
      ...(this.practicals ? [this.practicals.sparks.material] : []),
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

    // The Environment's own animation clock — practical flicker, the rim hue
    // drift, the mood cross-fade and the per-fighter rim rigs following their
    // fighters. `StagePracticals` winds it when it exists, because it has to
    // sync to the result in the same call; when it does not, the Stage winds it
    // directly. Exactly one of these two runs per frame, and if neither did the
    // cross-fade would never advance and a mood change would never land.
    if (!this.practicals) env?.frame?.(dt);

    this.floor.update(dt, t, params);
    this.walls.update(dt, t);
    // `StageStructure.update(time, params)` and the two newer sets'
    // `update(dt, time, params)` are the same call with a leading dt; the sets
    // that do not want it ignore it, so one signature covers all three.
    this.structure.update(dt, t, params);
    this.volumetrics.update(t, env?.shaftIntensity ?? 0.5, params);
    this.practicals?.update(dt, t, params);
    this.dust.update(dt);
    this.grit.update(dt);
    this.#updateContacts();

    // Wall flash: decays with the barrier's own flicker envelope. Whichever
    // barrier is flickering harder owns the single light; ties cannot happen in
    // practice because only one wall is ever struck.
    const fL = this.walls.flickerAt(0);
    const fR = this.walls.flickerAt(1);
    const side = fR > fL ? 1 : 0;
    const f = side === 1 ? fR : fL;
    if (f > 0) {
      this.wallLight.position.x = (side === 1 ? 1 : -1) * (ARENA_HALF_WIDTH - 0.4);
      this.wallLight.intensity = f * f * 26 * (0.55 + Math.random() * 0.45);
    } else {
      this.wallLight.intensity = 0;
    }
  }

  /**
   * Drives the floor's contact shadows off whatever fighters are in the scene.
   *
   * The stage is handed a scene and an environment and nothing else — that is
   * the charter's constructor — so the anchors are resolved by name out of the
   * scene graph rather than by taking a dependency on `Fighter`. `RenderPipeline`
   * already treats `fighter*` as a naming contract for its split beauty pass, so
   * this adds no new one. The lookup is cached and re-resolved only when a root
   * disappears, which is what a character swap does.
   *
   * Presentation only: it runs off wall-clock `update`, writes nothing the sim
   * reads, and is a no-op the frame a robot is still loading.
   */
  #updateContacts() {
    const floor = this.floor;
    if (!floor?.contacts) return;

    if (!this._contactRoots || this._contactRoots.some((r) => !r.root.parent)) {
      this._contactRoots = [];
      for (const child of this.scene.children) {
        if (!child.name?.startsWith('fighter')) continue;
        // `foot_*` is the Skeleton.js bone name. If the rig ever renames them
        // the body pool still lands, which is the difference between a weaker
        // cue and a fighter floating.
        this._contactRoots.push({
          root: child,
          feet: [child.getObjectByName('foot_L'), child.getObjectByName('foot_R')].filter(Boolean),
        });
      }
    }

    // Ground azimuth the key light throws a shadow along. `RenderPipeline`
    // re-fits and moves this light every frame but never re-aims it, so reading
    // it live costs two matrix reads and always agrees with the shadow map.
    const key = this.environment?.keyLight;
    let dx = -0.85, dz = -0.53;
    if (key?.target) {
      key.updateWorldMatrix(true, false);
      key.target.updateWorldMatrix(true, false);
      _lightDir.setFromMatrixPosition(key.target.matrixWorld)
        .sub(_pt.setFromMatrixPosition(key.matrixWorld));
      const len = Math.hypot(_lightDir.x, _lightDir.z);
      if (len > 1e-4) { dx = _lightDir.x / len; dz = _lightDir.z / len; }
    }
    // A quad's local +X maps to ( cos yaw, -sin yaw ) after a yaw about +Y.
    const yaw = Math.atan2(-dz, dx);

    const y0 = this.floorY;
    let slot = 0;
    for (const entry of this._contactRoots) {
      if (slot + 3 > CONTACT_COUNT) break;
      entry.root.getWorldPosition(_root);
      const rootLift = Math.max(0, _root.y - y0);
      const bodyFade = 1 - Math.min(1, rootLift / (CONTACT.fade * 1.6));
      const bodyGrow = Math.min(2.1, 1 + rootLift / CONTACT.spread);
      // Pushed down-light so the pool sits between the boots and the head of
      // the cast shadow rather than concentric with the fighter.
      const push = CONTACT.bodyPush * bodyGrow;
      floor.setContact(
        slot++, _root.x + dx * push, _root.z + dz * push,
        CONTACT.bodyLong * bodyGrow, CONTACT.bodyShort * bodyGrow, yaw,
        CONTACT.bodyStrength * bodyFade * bodyFade,
        CONTACT.bodyHardness,
      );

      for (let k = 0; k < 2; k++) {
        const bone = entry.feet[k];
        if (!bone) { floor.setContact(slot++, 0, 0, 0, 0, 0, 0, 0); continue; }
        bone.getWorldPosition(_foot);
        const lift = Math.max(0, _foot.y - y0 - 0.08);
        const fade = 1 - Math.min(1, lift / CONTACT.fade);
        const grow = Math.min(2.4, 1 + lift / CONTACT.spread);
        floor.setContact(
          slot++, _foot.x + dx * CONTACT.footPush, _foot.z + dz * CONTACT.footPush,
          CONTACT.footLong * grow, CONTACT.footShort * grow, yaw,
          CONTACT.footStrength * fade * fade,
          CONTACT.footHardness / grow,
        );
      }
    }
    for (let i = slot; i < CONTACT_COUNT; i++) floor.setContact(i, 0, 0, 0, 0, 0, 0, 0);
    floor.commitContacts();
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
    this.practicals?.reset();
    this.structure.reset?.();
    this.dust.reset();
    this.grit.reset();
    this.wallLight.intensity = 0;
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
    this.practicals?.dispose();
    this.dust.dispose();
    this.grit.dispose();
    for (const m of this.merged ?? []) m.geometry.dispose();
    this.reflector.dispose();
    this.materialLibrary.dispose();
    this.ready = false;
  }

  // -------------------------------------------------------------------------
  // Arena selection
  // -------------------------------------------------------------------------

  /** Every arena, in menu order. @returns {import('./Arenas.js').ArenaDef[]} */
  static list() {
    return ARENA_IDS.map((id) => arenaDef(id));
  }

  /**
   * The arena a fresh `Stage` builds when nobody says otherwise.
   *
   * It reads `?arena=` off the location so a capture run, a bug report or a
   * bookmark can name a stage without going through the menu, and falls back to
   * the default for anything it does not recognise. This is the only place the
   * arena system touches the outside world, and it is read-only.
   */
  static initialArena() {
    try {
      const q = new URLSearchParams(globalThis.location?.search ?? '').get('arena');
      if (q && ARENA_IDS.includes(q)) return q;
    } catch { /* no location, or a hostile one; the default is always safe */ }
    return DEFAULT_ARENA;
  }

  /**
   * Tear this arena down and build another one in place.
   *
   * A full rebuild rather than a set of hidden groups, and that is the whole
   * reason the budget works: only one arena's geometry, textures and materials
   * exist at a time, so three arenas cost what the largest one costs. The pit
   * alone is 273k triangles against a 900k whole-frame ceiling that already has
   * two robots in it — three of them resident would not fit.
   *
   * It is `async` because it is: the floor's macro map is a 2048px CPU bake and
   * the material library is another dozen, which is a second and a half of main
   * thread. Callers should be showing something while it runs. `ready` is false
   * throughout, and every per-frame method already returns early on that, so a
   * render landing mid-swap draws the fighters over an empty scene rather than
   * touching a half-built stage.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async setArena(id) {
    const next = arenaDef(id);
    if (next === this.arena && this.ready) return;
    if (this.ready) this.dispose();
    this.arena = next;
    // A fresh root: the old one was removed from the scene and every mesh under
    // it disposed, and reusing it would keep dead children alive in the graph.
    this.root = new THREE.Group();
    this.root.name = 'arena';
    this.rng.reseed(0x53544147);
    this._time = 0;
    this._frame = 0;
    this._reflectSize = { w: 0, h: 0 };
    this._contactRoots = null;
    await this.init();
  }
}
