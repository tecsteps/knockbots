/**
 * Knockbots — the effects director.
 *
 * One subscriber to the event bus, one owner of every particle system, one
 * per-frame entry point. Nothing else in the game knows that FX exist: the
 * simulation emits `hit` and this file decides that a heavy counter-hit on the
 * head means a thousand white-hot sparks down the line the fist was travelling,
 * a screen-facing shock with real refraction, five armour shards, a coolant
 * spray that will splat on the floor two hundred milliseconds from now, a point
 * light that flashes the robot's chrome, and three frames of radial speed lines.
 *
 * Two properties decide whether that reads as an impact or as confetti, and
 * neither is a particle-system problem:
 *
 *  - **Direction.** Every element orients off `hit.velocity`, the striking
 *    bone's measured world displacement over the tick that landed — not off the
 *    capsule separation normal, which describes where two boxes happened to be
 *    rather than where the blow was going. See `#blowDir`.
 *  - **Time.** A hit does not fire everything on one tick. The move carries a
 *    beat table (`MoveSchema.resolveFx`) and this file schedules the flare,
 *    lance, burst, front, shards and dust across two to eight ticks of the FX
 *    clock. Hitstop stretches that clock, so the opening beats land inside the
 *    freeze and the tail arrives as the reaction starts to move.
 *
 * The architecture is deliberately narrow:
 *
 *  - **Fixed pools, ring allocation, zero steady-state garbage.** Every system
 *    is sized at boot from the quality tier's particle budget. Nothing in
 *    `update()` allocates; the scratch vectors and colours at the top of this
 *    file are the entire working set.
 *  - **GPU-parameterised simulation.** Sparks, fluid, smoke, rings and decals
 *    are integrated from their spawn state inside the vertex shader, so a
 *    thousand live particles cost one attribute upload on the frame they were
 *    born and nothing at all afterwards. Only the debris shards run on the CPU,
 *    because their whole value is that they behave like rigid bodies.
 *  - **Screen space is a separate layer.** Impact frames, speed lines,
 *    shockwave refraction and the overdrive takeover live in `OverlayPass`,
 *    appended to the render pipeline's composer after the output pass and gated
 *    so it costs one texture fetch when nothing is happening.
 *
 * Trails deserve a note. They are driven primarily by measured bone speed
 * rather than by move metadata, because that works for every attack, every
 * character and every animation without a table to maintain — a limb moving at
 * eight metres a second gets a ribbon, and a move that names a `trail` bone
 * forces one on regardless of speed. The bones are found by name in the scene
 * graph, so this module needs no reference to the `Fighter` instances to draw
 * them.
 */

import * as THREE from 'three';
import { bus } from '../core/Bus.js';
import { WEIGHT, GROUND_Y, ARENA_HALF_WIDTH, ARENA_HALF_DEPTH, TICK_DT } from '../core/Constants.js';
import { FX_SHAPE, FX_PART } from '../combat/MoveSchema.js';
import { bakeFxTextures } from './FxTextures.js';
import { SparkSystem } from './SparkSystem.js';
import { FlashSystem } from './FlashSystem.js';
import { DebrisSystem } from './DebrisSystem.js';
import { SmokeSystem } from './SmokeSystem.js';
import { FluidSystem } from './FluidSystem.js';
import { ShockwaveSystem, MAX_DISTORT_RINGS } from './ShockwaveSystem.js';
import { DecalSystem, DECAL } from './DecalSystem.js';
import { TrailSystem } from './TrailSystem.js';
import { OverlayPass } from './OverlayPass.js';

// --- scratch ---------------------------------------------------------------
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _roll = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _c3 = new THREE.Color();
const _size = new THREE.Vector2();
const _lightDir = new THREE.Vector3(0.4, -0.8, 0.35);

/**
 * Per-weight impact recipe. Every number here is a readability decision.
 *
 * The persistence hierarchy is deliberate: `flashLife` is two to four frames,
 * `sparkLife` is ten to eighteen, and `coreLife` is the only element still
 * visible half a second later. A hit is an instantaneous event and the sparks
 * are the loudest part of it, so they have to be gone before the eye has
 * finished reading the reaction pose.
 *
 * The sparks used to burn for one to two seconds. Over that long the ballistic
 * integrator does exactly what it should — drag bleeds the horizontal speed off,
 * gravity brings everything down, and the whole population settles into a
 * glowing carpet on the floor between the fighters' feet. That carpet is not an
 * impact; it is a campfire, and it sits there under a reaction animation that
 * has moved on. Short lives put the mass back on the strike line where the blow
 * happened, which is the only place it means anything.
 *
 * The spark counts stay large. `SparkSystem` splits every burst into three size
 * tiers, and a tier that only gets a dozen particles does not read as a
 * population — it reads as a handful of stray dots. A launcher throwing eight
 * hundred sparks is one buffer upload and one draw call. `ember` is the
 * exception: it is a small garnish of slower motes at the contact, not a second
 * burst, so it is counted in tens.
 *
 * The contact ring is small, and that is the correction it needed most. A
 * screen-facing front with a metre and a half of radius covers a third of the
 * frame; drawn additively through a soft profile it is not a shockwave but a
 * low-contrast wash sitting over the fighters, the crowd and the floor at once —
 * a smudge on the lens. A pressure front is legible because it is *tight*: half
 * a metre across, bright enough to clip while it lives, and gone inside four
 * frames. Anything that survives long enough to be seen expanding has already
 * stopped being an impact.
 */
const HIT_FX = {
  [WEIGHT.LIGHT]: {
    sparks: 190, jet: 64, speed: 7.4, size: 0.028, heat: 2.6, sparkLife: 0.16,
    ring: 0.28, ringLife: 0.13, thick: 0.16, ringHeat: 2.2,
    flash: 0.26, flashHeat: 3.2, flashLife: 0.075,
    core: 0.10, coreHeat: 2.6, coreLife: 0.42, ember: 10,
    debris: 0, fluid: 0, light: 3.0, impact: 0, dust: 0,
  },
  [WEIGHT.MEDIUM]: {
    sparks: 340, jet: 105, speed: 8.6, size: 0.032, heat: 3.0, sparkLife: 0.19,
    ring: 0.40, ringLife: 0.15, thick: 0.17, ringHeat: 2.8,
    flash: 0.36, flashHeat: 3.8, flashLife: 0.09,
    core: 0.13, coreHeat: 3.4, coreLife: 0.55, ember: 16,
    debris: 0, fluid: 5, light: 5.0, impact: 0, dust: 2,
  },
  [WEIGHT.HEAVY]: {
    sparks: 680, jet: 200, speed: 10.4, size: 0.038, heat: 3.4, sparkLife: 0.24,
    ring: 0.62, ringLife: 0.19, thick: 0.18, ringHeat: 3.4,
    flash: 0.56, flashHeat: 4.6, flashLife: 0.11,
    core: 0.19, coreHeat: 4.4, coreLife: 0.72, ember: 26,
    debris: 8, fluid: 12, light: 12.0, impact: 0.55, dust: 6,
  },
  [WEIGHT.LAUNCHER]: {
    sparks: 780, jet: 225, speed: 11.4, size: 0.04, heat: 3.5, sparkLife: 0.26,
    ring: 0.72, ringLife: 0.21, thick: 0.19, ringHeat: 3.6,
    flash: 0.62, flashHeat: 5.0, flashLife: 0.12,
    core: 0.21, coreHeat: 4.8, coreLife: 0.8, ember: 30,
    debris: 10, fluid: 14, light: 14.0, impact: 0.62, dust: 8,
  },
  [WEIGHT.ULTRA]: {
    sparks: 1150, jet: 330, speed: 14.5, size: 0.048, heat: 4.0, sparkLife: 0.30,
    ring: 1.20, ringLife: 0.28, thick: 0.22, ringHeat: 4.2,
    flash: 0.7, flashHeat: 6.0, flashLife: 0.16,
    core: 0.28, coreHeat: 5.6, coreLife: 0.9, ember: 42,
    debris: 18, fluid: 26, light: 26.0, impact: 1.0, dust: 14,
  },
};

/**
 * How each impact shape throws its material.
 *
 * `HIT_FX` decides *how much* a hit produces, from its weight. This table
 * decides *where it goes*, from the geometry of the blow, and the two are
 * orthogonal on purpose: a heavy hook and a heavy piston should throw the same
 * mass of sparks in visibly different directions. Before this existed the only
 * input to an impact's appearance was its weight class, so every heavy hit in
 * the game looked the same however it had been thrown.
 *
 *   fanSpread  cone half-angle of the wide burst, 0 = pencil, 1 = hemisphere
 *   jetSpread  the same for the tight lance down the line of travel
 *   jetSpeed   how much faster the lance runs than the burst
 *   lift       how far the fan is tilted off the strike line toward vertical
 *   carry      share of the blow's speed inherited by the whole population
 *   ringAspect elongation of the pressure front along the blow
 *   ringScale  the front's size relative to the weight's nominal radius
 *   debris     shard and dust multipliers, because a blunt blow shatters more
 */
const SHAPE_FX = {
  [FX_SHAPE.THRUST]: {
    fanSpread: 0.44, jetSpread: 0.10, jetSpeed: 1.70, lift: 0.18, carry: 0.46,
    ringAspect: 2.3, ringScale: 0.60, debris: 0.9, dust: 0.8,
  },
  [FX_SHAPE.SLASH]: {
    fanSpread: 0.66, jetSpread: 0.20, jetSpeed: 1.40, lift: 0.10, carry: 0.54,
    ringAspect: 3.1, ringScale: 0.72, debris: 1.2, dust: 1.0,
  },
  [FX_SHAPE.RISING]: {
    fanSpread: 0.50, jetSpread: 0.13, jetSpeed: 1.60, lift: 0.52, carry: 0.42,
    ringAspect: 2.6, ringScale: 0.66, debris: 1.0, dust: 0.7,
  },
  [FX_SHAPE.CRUSH]: {
    fanSpread: 0.80, jetSpread: 0.30, jetSpeed: 1.15, lift: 0.06, carry: 0.34,
    ringAspect: 1.25, ringScale: 0.92, debris: 1.5, dust: 1.9,
  },
  [FX_SHAPE.DRILL]: {
    fanSpread: 0.30, jetSpread: 0.06, jetSpeed: 2.10, lift: 0.14, carry: 0.60,
    ringAspect: 2.9, ringScale: 0.50, debris: 0.8, dust: 0.6,
  },
};

/** Beats for a payload that arrives with no move metadata at all. */
const DEFAULT_TIMELINE = [
  { at: 0, parts: [FX_PART.FLASH, FX_PART.LIGHT, FX_PART.JET, FX_PART.PUNCH] },
  { at: 1, parts: [FX_PART.FAN, FX_PART.CORE] },
  { at: 2, parts: [FX_PART.RING, FX_PART.DEBRIS] },
  { at: 4, parts: [FX_PART.EMBER, FX_PART.FLUID] },
  { at: 6, parts: [FX_PART.DUST] },
];

/** Live hit contexts, and the beats scheduled against them. Fixed, never grown. */
const MAX_HIT_CONTEXTS = 8;
const MAX_BEATS = 128;

/**
 * Impact dust, once and for all. It is pulverised paint, concrete and oxide —
 * a warm neutral grey that the arena light colours, never the palette of
 * whichever robot happened to get hit.
 */
const DUST = new THREE.Color(0.46, 0.42, 0.37);

/** Bones that can carry a trail, with the joint that forms the ribbon's inner edge. */
const TRAIL_BONES = [
  ['hand_R', 'elbow_R', 1.0],
  ['hand_L', 'elbow_L', 1.0],
  ['foot_R', 'knee_R', 0.75],
  ['foot_L', 'knee_L', 0.75],
];

const TRAIL_START_SPEED = 7.2;   // m/s at the bone before a ribbon appears
const TRAIL_STOP_SPEED = 4.0;

/** Fallback identity colours when a fighter's palette is not known yet. */
const DEFAULT_ACCENT = [new THREE.Color('#FF7A2A'), new THREE.Color('#39D6FF')];

export class EffectsDirector {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../engine/RenderPipeline.js').RenderPipeline} renderPipeline
   */
  constructor(scene, renderPipeline) {
    this.scene = scene;
    this.pipeline = renderPipeline;
    this.camera = renderPipeline?.camera || null;

    this.time = 0;
    this.floorY = GROUND_Y;
    this.quality = renderPipeline?.quality || 'ultra';
    this.budget = renderPipeline?.particleBudget ?? 1;
    this.enabled = true;

    /** Fighter instances, discovered from bus payloads. */
    this.fighters = [null, null];
    /** Cached scene-graph handles for the two fighter rigs. */
    this.rigs = [null, null];

    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.group.matrixAutoUpdate = false;

    /** Screen-space punctuation state, decayed every frame. */
    this.impact = { level: 0, decay: 9, lines: 0, linesDecay: 11, invert: 0, invertDecay: 22 };
    this.flash = { amount: 0, decay: 8 };
    this.overdrive = {
      on: false, t: 0, hold: 0, level: 0, desat: 0, flash: 0,
      fighter: null, color: new THREE.Color(0.4, 0.75, 1),
    };
    this.overlayCenter = new THREE.Vector2();
    this._speedSeed = 0;
    this._lightScan = 60;

    this._ringData = new Float32Array(MAX_DISTORT_RINGS * 4);

    // Presentation timeline. A hit fills one context and posts a handful of
    // beats against it; `update()` drains whatever has come due. Both rings are
    // built here so nothing on the hit path ever allocates.
    this._hits = [];
    for (let i = 0; i < MAX_HIT_CONTEXTS; i++) {
      this._hits.push({
        point: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0),
        fan: new THREE.Vector3(), ember: new THREE.Vector3(), inherit: new THREE.Vector3(),
        hot: new THREE.Color(), ring: new THREE.Color(),
        shard: new THREE.Color(), coolant: new THREE.Color(),
        recipe: null, shape: null, roll: 0, scale: 1, counter: false, ultra: false,
      });
    }
    this._hitCursor = 0;
    this._beats = [];
    for (let i = 0; i < MAX_BEATS; i++) this._beats.push({ due: -1, part: '', hit: null });
    this._beatCursor = 0;
    /** Bound once; `update()` must not build a closure every frame. */
    this._onSplat = (x, y, z, size, r, g, b) => {
      this.decals.add(DECAL.OIL, x, z, size, {
        life: 22, strength: 0.85, tint: _c.setRGB(r, g, b),
      });
    };
    this._unsub = [];
    this._installedComposer = null;
    this._pass = null;
    this._ready = false;
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------

  /** Bakes every texture, builds every pool, and wires the bus. */
  async init() {
    const renderer = this.pipeline?.renderer;
    const aniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 8;
    this.textures = bakeFxTextures(this.quality, Math.min(aniso, 8));

    const b = this.budget;
    const n = (x) => Math.max(24, Math.round(x * b));

    // Sized against the worst realistic case rather than the theoretical one: a
    // three-hit juggle of launchers is a little under four thousand live sparks,
    // so this is a shade over two times headroom before the ring starts eating
    // the oldest burst.
    this.sparks = new SparkSystem(this.textures.spark, n(8192), this.floorY);
    this.fluid = new FluidSystem(this.textures.droplet, n(768), this.floorY);
    this.smoke = new SmokeSystem(this.textures.smoke, this.textures.curl, n(720));
    this.debris = new DebrisSystem(n(176), this.textures.shard, this.floorY);
    this.shock = new ShockwaveSystem(this.textures.ring, 48);
    this.flashes = new FlashSystem(64);
    this.decals = new DecalSystem(this.textures.decals, 160, this.floorY);
    // Eighteen samples is a third of a second of arc at 60Hz. Half a second of
    // history is long enough that the ribbon is still on screen after the limb
    // has changed direction twice, which reads as a smear rather than a swing.
    this.trails = new TrailSystem(10, 18);

    this.group.add(
      this.decals.mesh, this.smoke.mesh, this.fluid.mesh,
      this.debris.mesh, this.sparks.mesh, this.shock.mesh, this.trails.mesh,
      this.flashes.mesh,
    );

    // Impact lights. Allocated once and never added or removed, because a
    // changing light count recompiles every material in the scene.
    this.impactLights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffd9a8, 0, 9, 2);
      l.castShadow = false;
      l.visible = false;
      l.userData.decay = 0;
      this.group.add(l);
      this.impactLights.push(l);
    }
    this._lightCursor = 0;

    this.scene.add(this.group);

    this.#findStageLight();
    this.#applyQuality(this.quality);
    this.#subscribe();
    this._ready = true;
  }

  /**
   * Locates the arena key light so dust and smoke are lit by the same rig, and
   * calibrates the impact lights against it.
   *
   * Lights are in physical units here, and the two kinds are not interchangeable:
   * a directional light's intensity is irradiance, a point light's is candela,
   * and a point light delivers `I / d^2`. So a flash that reads as "one key light
   * at arm's length" is `keyIntensity * d^2` candela, roughly `2.25 x` at 1.5m —
   * a couple of dozen, not a couple of hundred. Getting this wrong by the factor
   * a naive guess produces blows the entire frame to white through the bloom.
   */
  #findStageLight() {
    let best = null;
    let bestPower = -1;
    this.scene.traverse((o) => {
      if (!o.isDirectionalLight && !o.isSpotLight) return;
      const p = o.intensity * (o.isDirectionalLight ? 6 : 1);
      if (p > bestPower) { bestPower = p; best = o; }
    });
    this.keyLight = best;
    const key = best?.isDirectionalLight ? best.intensity : 3.0;
    this.lightScale = THREE.MathUtils.clamp(key / 3.0, 0.35, 3.0);
  }

  // -------------------------------------------------------------------------
  // bus wiring
  // -------------------------------------------------------------------------

  #subscribe() {
    const on = (evt, fn) => this._unsub.push(bus.on(evt, fn));

    // Fighters are never handed to this module, so they are learned from the
    // payloads that carry them. Trails do not depend on this; palettes do.
    this._unsub.push(bus.onAny((p) => {
      if (!p || typeof p !== 'object') return;
      this.#learn(p.fighter); this.#learn(p.attacker); this.#learn(p.defender);
    }));

    on('hit', (e) => this.#onHit(e));
    on('block', (e) => this.#onBlock(e));
    on('parry', (e) => this.#onParry(e));
    on('armorAbsorb', (e) => this.#onArmor(e));
    on('partBreak', (e) => this.#onPartBreak(e));
    on('launch', (e) => this.#onLaunch(e));
    on('knockdown', (e) => this.#onKnockdown(e));
    on('wallSplat', (e) => this.#onWallSplat(e));
    on('groundImpact', (e) => this.#onGroundImpact(e));
    on('footstep', (e) => this.#onFootstep(e));
    on('dash', (e) => this.#onDash(e));
    on('jump', (e) => this.#onJump(e));
    on('meterFull', (e) => this.#onMeterFull(e));
    on('superStart', (e) => this.#onSuperStart(e));
    on('superHit', (e) => this.#onSuperHit(e));
    on('roundStart', () => this.reset());
    on('roundEnd', (e) => this.#onRoundEnd(e));
    on('phase', (e) => { if (e?.phase === 'menu' || e?.phase === 'select') this.reset(); });
  }

  #learn(f) {
    if (!f || typeof f.index !== 'number' || !f.def) return;
    if (this.fighters[f.index] !== f) this.fighters[f.index] = f;
  }

  /**
   * Character colour lookup with a safe default, returned in a scratch colour.
   * @param {any} fighter
   * @param {'accent'|'emissive'|'primary'|'trim'} key
   * @param {THREE.Color} out
   */
  #palette(fighter, key, out) {
    const hex = fighter?.def?.palette?.[key];
    if (typeof hex === 'string') return out.set(hex);
    if (typeof hex === 'number') return out.setHex(hex);
    const idx = typeof fighter?.index === 'number' ? fighter.index & 1 : 0;
    return out.copy(DEFAULT_ACCENT[idx]);
  }

  /**
   * Billboard roll that puts a quad's local x-axis along a world direction as
   * the camera sees it. Impact effects that ignore this are identical whichever
   * way the blow travelled, which is the single clearest tell that a hit was
   * drawn rather than caused.
   * @param {THREE.Vector3} dir world-space direction of travel
   * @returns {number} roll in radians
   */
  #screenRoll(dir) {
    if (!this.camera) return 0;
    _roll.copy(dir).transformDirection(this.camera.matrixWorldInverse);
    if (_roll.x * _roll.x + _roll.y * _roll.y < 1e-8) return 0;
    return Math.atan2(_roll.y, _roll.x);
  }

  // -------------------------------------------------------------------------
  // combat events
  // -------------------------------------------------------------------------

  /**
   * The direction of the blow, written to `out` as a unit vector.
   *
   * `velocity` is the striking bone's measured world displacement over the tick
   * that landed the hit — the direction the limb was actually travelling.
   * `normal` is the capsule separation axis, which is a property of where the
   * two boxes happened to be rather than of the strike, and using it is why
   * sparks used to spray along an arbitrary line. It stays as the fallback for
   * events that carry no swept velocity.
   * @param {Object} e bus payload
   * @param {THREE.Vector3} out
   */
  #blowDir(e, out) {
    const v = e.velocity;
    if (v && v.lengthSq() > 1.0) return out.copy(v).normalize();
    if (e.normal && e.normal.lengthSq() > 1e-6) return out.copy(e.normal).normalize();
    return out.set(e.attacker?.facing || 1, 0.2, 0).normalize();
  }

  /**
   * Fills a hit context from a bus payload and returns it.
   *
   * Everything the beats will need is frozen here, at contact: the direction of
   * the blow, the two derived spray axes, the shape table, and the palettes.
   * Beats fire over the following tenth of a second and the scratch registers at
   * the top of this file will have been reused a hundred times by then, so a
   * beat may not read anything it did not capture.
   */
  #openHit(e, recipe, counter, scale) {
    const c = this._hits[this._hitCursor];
    this._hitCursor = (this._hitCursor + 1) % this._hits.length;

    const shape = SHAPE_FX[e.move?.fx?.shape] || SHAPE_FX[FX_SHAPE.THRUST];
    c.point.copy(e.point);
    this.#blowDir(e, c.dir);
    c.shape = shape;
    c.recipe = recipe;
    c.counter = counter;
    c.scale = scale;
    c.ultra = e.move?.weight === WEIGHT.ULTRA;
    c.roll = this.#screenRoll(c.dir);

    // The wide fan carries the volume of the burst, tilted off the strike line
    // toward vertical so it stays legible against the floor. How far depends on
    // the shape: an uppercut drives its material straight up the front of the
    // body, a body check throws it sideways and barely lifts at all.
    c.fan.copy(c.dir).setY(c.dir.y * (1 - shape.lift) + shape.lift * 1.25).normalize();
    c.ember.set(c.dir.x * 0.28, 1.0, c.dir.z * 0.28).normalize();
    // Inherited velocity shifts the whole population downrange, so even the slow
    // motes drift the way the hit went.
    c.inherit.copy(c.dir).multiplyScalar(recipe.speed * shape.carry);

    this.#palette(e.attacker, 'emissive', _c2);
    c.hot.copy(_c2).lerp(_c.setRGB(1, 0.95, 0.88), 0.7);
    c.ring.copy(_c2).lerp(_c.setRGB(1, 1, 1), 0.45);
    this.#palette(e.defender, 'trim', c.shard);
    this.#palette(e.defender, 'emissive', c.coolant);
    return c;
  }

  /**
   * Posts a move's beats against a hit context.
   *
   * `at` is in simulation ticks but the queue runs on the FX clock, which is
   * what makes this behave: hitstop stretches the clock, so the first two or
   * three beats land inside the freeze — the frames the player is actually
   * looking at — and the tail arrives as the reaction starts moving.
   */
  #schedule(c, timeline) {
    for (let i = 0; i < timeline.length; i++) {
      const beat = timeline[i];
      const due = this.time + Math.max(0, beat.at || 0) * TICK_DT;
      const parts = beat.parts;
      for (let k = 0; k < parts.length; k++) {
        const b = this._beats[this._beatCursor];
        this._beatCursor = (this._beatCursor + 1) % MAX_BEATS;
        b.due = due;
        b.part = parts[k];
        b.hit = c;
      }
    }
  }

  /** Drains every beat that has come due. Called once per frame. */
  #runBeats() {
    const beats = this._beats;
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b.due < 0 || b.due > this.time) continue;
      b.due = -1;
      if (b.hit) this.#fire(b.part, b.hit);
    }
  }

  /**
   * Spawns one element of an impact. Every case reads its geometry from the
   * context and its magnitude from the weight recipe, and nothing here knows
   * what tick it is on — the schedule already decided that.
   */
  #fire(part, c) {
    const r = c.recipe;
    const s = c.shape;
    const k = c.scale;

    switch (part) {
      // The flare at the contact point: the brightest element in the game and
      // the one the bloom pass actually feeds on. Its streak lies along the blow.
      case FX_PART.FLASH:
        this.flashes.pop(c.point, {
          size: r.flash * k, life: r.flashLife, heat: r.flashHeat * k,
          roll: c.roll, tint: c.hot,
        });
        break;

      // The heat the flare leaves behind. Without it the contact point is dark
      // again four frames in, while the reaction animation is still playing.
      case FX_PART.CORE:
        this.flashes.pop(c.point, {
          size: r.core * k, life: r.coreLife, heat: r.coreHeat * k, cool: true,
        });
        break;

      // The tight lance straight down the line of travel. This is what makes the
      // direction readable in a single frame instead of leaving an isotropic ball.
      case FX_PART.JET:
        this.sparks.burst(c.point, c.dir, {
          count: r.jet * k, speed: r.speed * s.jetSpeed * k, spread: s.jetSpread,
          life: r.sparkLife * 0.8,
          inherit: _v3.copy(c.dir).multiplyScalar(r.speed * 0.5),
          size: r.size * 1.15, heat: r.heat * 1.15,
        });
        break;

      case FX_PART.FAN:
        this.sparks.burst(c.point, c.fan, {
          count: r.sparks * k, speed: r.speed * k, spread: s.fanSpread,
          life: r.sparkLife, inherit: c.inherit, size: r.size, heat: r.heat,
          tint: c.counter ? _c.setRGB(1.0, 0.86, 0.72) : null,
        });
        break;

      // Slow motes lofted out of the contact, so the burst has a near field that
      // is not travelling at ten metres a second. They are the tail of the same
      // event, not a second one: no inherited velocity, and dead a handful of
      // frames after the fast sparks are.
      case FX_PART.EMBER:
        if (!r.ember) break;
        this.sparks.burst(c.point, c.ember, {
          count: r.ember * k, speed: r.speed * 0.22, spread: 0.85,
          life: r.sparkLife * 1.25, size: r.size * 0.8, heat: r.heat * 0.85,
        });
        break;

      // The pressure front, rolled onto the line of the hit and stretched along
      // it, so its long axis reads as the direction the force went.
      case FX_PART.RING:
        this.shock.spawn(c.point, {
          mode: 'facing', tilt: c.roll, aspect: s.ringAspect,
          radius: r.ring * s.ringScale * k,
          life: r.ringLife * (c.counter ? 1.15 : 1),
          thickness: r.thick, heat: r.ringHeat * k, tint: c.ring,
          distort: r.impact > 0 ? 1.1 * k : 0.45,
        });
        break;

      case FX_PART.DEBRIS:
        if (!r.debris) break;
        this.debris.burst(c.point, c.dir, {
          count: r.debris * s.debris * k, speed: 4.6, spread: 0.9,
          size: 0.055, life: 4.5, color: c.shard,
        });
        break;

      case FX_PART.FLUID:
        if (!r.fluid) break;
        this.fluid.spray(c.point, c.dir, {
          count: r.fluid * k, speed: 4.0, spread: 0.9,
          life: 1.2, size: 0.04, tint: c.coolant,
        });
        break;

      // Thrown clear of the contact along the blow, so the puff never sits on
      // top of the heat core and swallows the one bright thing in the frame.
      case FX_PART.DUST:
        if (!r.dust) break;
        _v3.copy(c.point).addScaledVector(c.dir, 0.18);
        this.smoke.puff(_v3, {
          count: Math.max(1, Math.round(r.dust * s.dust)), dir: c.dir,
          speed: 2.6, spread: 1.5, radius: 0.13, size: 0.15, growth: 1.7,
          life: 0.6, buoyancy: 0.32, curl: 1.1, tint: DUST,
        });
        break;

      case FX_PART.LIGHT:
        this.#flashLight(c.point, r.light * k, c.counter ? 0xfff0d8 : 0xffd0a0);
        break;

      case FX_PART.PUNCH:
        if (r.impact > 0) this.#punch(c.point, r.impact * k, c.ultra);
        break;

      default:
        break;
    }
  }

  /**
   * A hit no longer dumps every element onto one tick. It opens a context and
   * hands the move's own beat table to the scheduler; `#fire` does the spawning
   * over the following two to eight ticks. Moves that never authored a timeline
   * still get one, derived from their own data by `MoveSchema.resolveFx`.
   */
  #onHit(e) {
    if (!this.enabled || !e?.point) return;
    const recipe = HIT_FX[e.move?.weight] || HIT_FX[WEIGHT.MEDIUM];
    const counter = !!e.counter;
    const c = this.#openHit(e, recipe, counter, counter ? 1.35 : 1);
    this.#schedule(c, e.move?.fx?.timeline || DEFAULT_TIMELINE);
  }

  #onBlock(e) {
    if (!this.enabled || !e?.point) return;
    this.#palette(e.defender, 'emissive', _c);
    // A guard throws the blow's own energy back the way it came, so the spray
    // is the reverse of the swept limb rather than a fixed sideways puff.
    this.#blowDir(e, _n).negate().setY(0.25).normalize();
    const roll = this.#screenRoll(_n);

    this.sparks.burst(e.point, _n, {
      count: 210, speed: 7.2, spread: 0.34, life: 0.2, size: 0.028,
      heat: 2.6, tint: _c2.copy(_c).lerp(_c3.setRGB(1, 1, 1), 0.6),
    });
    this.shock.spawn(e.point, {
      mode: 'facing', tilt: roll, aspect: 1.9, radius: 0.42, life: 0.16,
      thickness: 0.15, heat: 2.6, tint: _c, distort: 0.4,
    });
    this.flashes.pop(e.point, { size: 0.3, life: 0.08, heat: 3.4, roll, tint: _c });
    this.flashes.pop(e.point, { size: 0.13, life: 0.34, heat: 2.2, cool: true });
    this.#flashLight(e.point, 4, 0xbfe4ff);
  }

  #onParry(e) {
    if (!this.enabled || !e?.point) return;
    this.#palette(e.defender, 'emissive', _c);
    this.shock.spawn(e.point, {
      mode: 'facing', radius: 0.8, life: 0.26, thickness: 0.14,
      heat: 4.6, tint: _c2.copy(_c).lerp(_c3.setRGB(1, 1, 1), 0.5), distort: 1.2,
    });
    this.sparks.burst(e.point, _v.set(0, 1, 0), {
      count: 320, speed: 8.5, spread: 1.0, life: 0.26, size: 0.032, heat: 3.2, tint: _c,
    });
    this.flashes.pop(e.point, { size: 0.6, life: 0.11, heat: 4.4, tint: _c });
    this.flashes.pop(e.point, { size: 0.24, life: 0.55, heat: 3.2, cool: true });
    this.#flashLight(e.point, 9, 0xd8f0ff);
    this.#punch(e.point, 0.3, false);
  }

  #onArmor(e) {
    if (!this.enabled || !e?.point) return;
    this.sparks.burst(e.point, _v.set(0, 0.6, 0).normalize(), {
      count: 260, speed: 5.4, spread: 1.0, life: 0.22, size: 0.032, heat: 2.7,
    });
    this.shock.spawn(e.point, {
      mode: 'facing', radius: 0.52, life: 0.19, thickness: 0.2, aspect: 1.3,
      heat: 2.4, tint: _c.setRGB(1, 0.62, 0.24), distort: 0.5,
    });
    this.flashes.pop(e.point, { size: 0.4, life: 0.085, heat: 3.4, tint: _c.setRGB(1, 0.62, 0.24) });
    this.flashes.pop(e.point, { size: 0.18, life: 0.5, heat: 2.8, cool: true });
    this.#flashLight(e.point, 6, 0xffb066);
  }

  #onPartBreak(e) {
    if (!this.enabled || !e?.point) return;
    _n.set(e.fighter?.facing ? -e.fighter.facing : 1, 0.5, 0).normalize();
    const roll = this.#screenRoll(_n);
    this.#palette(e.fighter, 'trim', _c);

    this.debris.burst(e.point, _n, {
      count: 18, speed: 6.4, spread: 1.3, size: 0.085, life: 6.5, color: _c,
    });
    this.sparks.burst(e.point, _n, {
      count: 700, speed: 9.6, spread: 0.72, life: 0.28, size: 0.04, heat: 3.4,
    });
    this.#palette(e.fighter, 'emissive', _c2);
    this.fluid.spray(e.point, _n, {
      count: 40, speed: 5.0, spread: 1.1, life: 1.6, size: 0.05, tint: _c2,
    });
    this.smoke.puff(e.point, {
      count: 10, dir: _n, speed: 2.4, spread: 1.6, radius: 0.2,
      size: 0.32, growth: 1.5, life: 1.2, buoyancy: 0.5, curl: 1.1,
      tint: _c.setRGB(0.34, 0.31, 0.28),
    });
    this.shock.spawn(e.point, {
      mode: 'facing', tilt: roll, aspect: 1.6, radius: 0.85, life: 0.26, thickness: 0.2,
      heat: 3.6, tint: _c2, distort: 1.0,
    });
    this.flashes.pop(e.point, { size: 0.7, life: 0.13, heat: 5.0, roll });
    this.flashes.pop(e.point, { size: 0.34, life: 0.95, heat: 4.6, cool: true });
    this.#flashLight(e.point, 16, 0xffc48a);
    this.#punch(e.point, 0.5, false);
  }

  #onLaunch(e) {
    if (!this.enabled || !e?.fighter) return;
    _v.copy(e.fighter.position);
    _v.y = this.floorY;
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.1, life: 0.55, thickness: 0.22,
      heat: 1.6, tint: _c.setRGB(0.9, 0.86, 0.78), distort: 0.7,
    });
    this.#groundDust(_v, 7, 2.6, 0.26);
    // Boots tearing off the floor scrape a short ember shower out of the
    // concrete. It has to die with the launch itself: this burst is spawned at
    // floor level, so anything that outlives its own upward arc lands straight
    // back down and becomes a glowing pool at the fighters' feet — exactly where
    // there is no longer anything happening.
    _v3.copy(_v).setY(this.floorY + 0.12);
    this.sparks.burst(_v3, _v2.set(0, 1, 0), {
      count: 90, speed: 5.4, spread: 0.9, life: 0.26, size: 0.032, heat: 2.6,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.9, { life: 14, strength: 0.34 });
  }

  #onKnockdown(e) {
    if (!this.enabled || !e?.point) return;
    _v.copy(e.point); _v.y = this.floorY;
    this.#groundDust(_v, 11, 3.4, 0.32);
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.6, life: 0.6, thickness: 0.24,
      heat: 1.2, tint: _c.setRGB(0.86, 0.82, 0.76), distort: 0.6,
    });
    this.#palette(e.fighter, 'trim', _c);
    this.debris.burst(_v, _v2.set(0, 1, 0), {
      count: 6, speed: 3.4, spread: 1.4, size: 0.05, life: 5, color: _c,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 1.35, { life: 20, strength: 0.45 });
    this.decals.add(DECAL.FRACTURE, _v.x, _v.z, 0.8, { life: 22, strength: 0.35 });
    this.#flashLight(_v, 4, 0xd8c8b0);
  }

  #onWallSplat(e) {
    if (!this.enabled || !e?.point) return;
    _n.copy(e.normal && e.normal.lengthSq() > 1e-6 ? e.normal : _v.set(0, 1, 0)).normalize();
    const roll = this.#screenRoll(_n);
    this.sparks.burst(e.point, _n, {
      count: 820, speed: 11.6, spread: 0.62, life: 0.3, size: 0.046, heat: 3.6,
    });
    this.#palette(e.fighter, 'trim', _c);
    this.debris.burst(e.point, _n, {
      count: 12, speed: 6.0, spread: 1.0, size: 0.07, life: 5.5, color: _c,
    });
    this.smoke.puff(e.point, {
      count: 12, dir: _n, speed: 3.0, spread: 1.5, radius: 0.26,
      size: 0.36, growth: 1.6, life: 1.3, buoyancy: 0.4, curl: 1.0,
      tint: DUST,
    });
    this.shock.spawn(e.point, {
      mode: 'facing', tilt: roll, aspect: 1.5, radius: 1.25, life: 0.3, thickness: 0.22,
      heat: 3.8, tint: _c2.setRGB(1, 0.92, 0.82), distort: 1.3,
    });
    // The impact dust settles at the base of the wall.
    const fx = THREE.MathUtils.clamp(e.point.x, -ARENA_HALF_WIDTH + 0.3, ARENA_HALF_WIDTH - 0.3);
    const fz = THREE.MathUtils.clamp(e.point.z, -ARENA_HALF_DEPTH + 0.3, ARENA_HALF_DEPTH - 0.3);
    this.decals.add(DECAL.SCORCH, fx, fz, 1.1, { life: 24, strength: 0.55 });
    this.flashes.pop(e.point, { size: 0.8, life: 0.13, heat: 5.2, roll });
    this.flashes.pop(e.point, { size: 0.4, life: 1.0, heat: 4.8, cool: true });
    this.#flashLight(e.point, 18, 0xffd0a0);
    this.#punch(e.point, 0.7, false);
  }

  #onGroundImpact(e) {
    if (!this.enabled || !e?.point) return;
    const speed = Math.max(0, e.speed || 0);
    if (speed < 3) return;
    const k = THREE.MathUtils.clamp(speed / 12, 0.2, 1.6);
    _v.copy(e.point); _v.y = this.floorY;

    this.#groundDust(_v, Math.round(6 + 9 * k), 2.2 + 2.0 * k, 0.22 + 0.13 * k);
    this.shock.spawn(_v, {
      mode: 'ground', radius: 1.4 + 1.8 * k, life: 0.4 + 0.25 * k,
      thickness: 0.24, heat: 1.4 + k, tint: _c.setRGB(0.88, 0.84, 0.78),
      distort: 0.5 * k,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.7 + 0.8 * k, { life: 16, strength: 0.3 + 0.22 * k });
    if (k > 0.9) {
      this.sparks.burst(_v, _v2.set(0, 1, 0), {
        count: 240, speed: 5.0, spread: 1.0, life: 0.24, size: 0.03, heat: 2.5,
      });
      this.decals.add(DECAL.FRACTURE, _v.x, _v.z, 0.9, { life: 20, strength: 0.4 });
    }
  }

  #onFootstep(e) {
    if (!this.enabled || !e?.point) return;
    const force = THREE.MathUtils.clamp(e.force ?? 0.5, 0, 2);
    if (force < 0.15) return;
    _v.copy(e.point); _v.y = this.floorY + 0.02;
    this.smoke.puff(_v, {
      count: Math.round(1 + force * 3), dir: _v2.set(0, 1, 0), speed: 0.5 + force,
      spread: 0.9, radius: 0.14, size: 0.18 + force * 0.1, growth: 1.0,
      life: 0.65 + force * 0.3, buoyancy: 0.16, curl: 0.7,
      tint: _c.setRGB(0.42, 0.4, 0.37),
    });
    if (force > 0.8) this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.28, { life: 9, strength: 0.22 });
  }

  #onDash(e) {
    if (!this.enabled || !e?.fighter) return;
    const f = e.fighter;
    _v.copy(f.position);
    _v.y = this.floorY;

    // Ground wash behind the dash.
    const dir = e.dir || -(f.facing || 1);
    _v2.set(-dir * 1.4, 0.9, 0).normalize();
    _v3.copy(_v).setY(this.floorY + 0.12);
    this.smoke.puff(_v3, {
      count: 7, dir: _v2, speed: 2.4, spread: 1.2, radius: 0.3,
      size: 0.22, growth: 1.2, life: 0.8, buoyancy: 0.2, curl: 1.0,
      tint: DUST,
    });
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.5, { life: 8, strength: 0.28 });

    // Thruster plume from the dorsal unit, in the character's own light.
    this.#palette(f, 'emissive', _c2);
    _v.copy(f.position);
    _v.y += 1.15;
    _v.x += (f.facing || 1) * -0.22;
    this.smoke.puff(_v, {
      count: 14, dir: _v2, speed: 5.0, spread: 0.5, radius: 0.07,
      size: 0.11, growth: 1.6, life: 0.3, buoyancy: 0.05, curl: 0.45,
      tint: _c2, emissive: 0.9,
    });
    this.sparks.burst(_v, _v2, {
      count: 90, speed: 6.5, spread: 0.35, life: 0.3, size: 0.022,
      heat: 2.2, tint: _c2,
    });
    this.#flashLight(_v, 3, _c2.getHex());
  }

  #onJump(e) {
    if (!this.enabled || !e?.fighter) return;
    _v.copy(e.fighter.position);
    _v.y = this.floorY;
    this.#groundDust(_v, 6, 2.0, 0.24);
    this.decals.add(DECAL.SCUFF, _v.x, _v.z, 0.44, { life: 8, strength: 0.24 });
  }

  #onMeterFull(e) {
    if (!this.enabled || !e?.fighter) return;
    this.#palette(e.fighter, 'emissive', _c);
    _v.copy(e.fighter.position);
    _v.y = this.floorY;
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.2, life: 0.75, thickness: 0.22,
      heat: 2.6, tint: _c, distort: 0.8,
    });
    _v3.copy(_v).setY(this.floorY + 0.4);
    this.smoke.puff(_v3, {
      count: 16, dir: _v2.set(0, 1, 0), speed: 2.6, spread: 0.9, radius: 0.42,
      size: 0.28, growth: 1.1, life: 1.1, buoyancy: 0.9, curl: 0.8,
      tint: _c, emissive: 0.55,
    });
    this.sparks.burst(_v.setY(this.floorY + 0.2), _v2.set(0, 1, 0), {
      count: 340, speed: 7.0, spread: 0.55, life: 0.45, size: 0.028, heat: 2.8, tint: _c,
    });
  }

  #onSuperStart(e) {
    if (!this.enabled || !e?.fighter) return;
    const f = e.fighter;
    this.#palette(f, 'emissive', _c);
    this.overdrive.on = true;
    this.overdrive.t = 0;
    this.overdrive.hold = 1.1;
    this.overdrive.fighter = f;
    this.overdrive.color.copy(_c);

    _v.copy(f.position);
    _v.y = this.floorY;

    // A column of charge: ground ring, rising embers, a coloured plume and a
    // scorch ring that stays on the floor after the move.
    this.shock.spawn(_v, {
      mode: 'ground', radius: 2.4, life: 0.75, thickness: 0.24,
      heat: 1.8, tint: _c, distort: 1.0,
    });
    _v3.copy(_v).setY(this.floorY + 0.1);
    this.sparks.burst(_v3, _v2.set(0, 1, 0), {
      count: 560, speed: 9.0, spread: 0.5, life: 0.5, size: 0.028,
      heat: 2.8, tint: _c,
    });
    // The plume is charged, not incandescent. Pushing its self-illumination up
    // gives the bloom a metre-wide white sun to chew on, and the camera is a
    // metre and a half away on this cinematic: the whole frame goes to paper.
    _v3.setY(this.floorY + 0.7);
    this.smoke.puff(_v3, {
      count: 20, dir: _v2.set(0, 1, 0), speed: 3.6, spread: 1.0, radius: 0.36,
      size: 0.2, growth: 1.5, life: 1.1, buoyancy: 1.3, curl: 1.3,
      tint: _c, emissive: 0.22,
    });
    this.decals.add(DECAL.SCORCH, _v.x, _v.z, 1.9, {
      life: 26, strength: 0.7, tint: _c2.copy(_c).lerp(_c3.setRGB(0.2, 0.2, 0.2), 0.55),
    });
    _v3.setY(this.floorY + 1.1);
    this.#flashLight(_v3, 16, _c.getHex());
  }

  #onSuperHit(e) {
    if (!this.enabled) return;
    const d = e?.defender;
    _v.copy(d?.position || new THREE.Vector3());
    _v.y += 1.05;
    this.#palette(e?.attacker, 'emissive', _c);

    this.overdrive.flash = 1;
    _n.set(e?.attacker?.facing || 1, 0.2, 0).normalize();
    const roll = this.#screenRoll(_n);
    this.sparks.burst(_v, _v2.copy(_n).setY(0.55).normalize(), {
      count: 900, speed: 14.0, spread: 0.7, life: 0.34, size: 0.038, heat: 3.6,
    });
    this.shock.spawn(_v, {
      mode: 'facing', tilt: roll, aspect: 2.2, radius: 1.5, life: 0.32, thickness: 0.24,
      heat: 3.4, tint: _c, distort: 1.6,
    });
    this.shock.spawn(_v.clone().setY(this.floorY), {
      mode: 'ground', radius: 3.4, life: 0.65, thickness: 0.26,
      heat: 1.5, tint: _c, distort: 0.9,
    });
    this.#palette(d, 'trim', _c2);
    this.debris.burst(_v, _v2.set(0, 0.6, 0).normalize(), {
      count: 26, speed: 8.0, spread: 1.4, size: 0.09, life: 6, color: _c2,
    });
    // The super's flare is the brightest thing in the game and the camera is a
    // metre and a half away on this cinematic. It is sized for radiance, not for
    // coverage — `FlashSystem` caps its projected radius, and the drama comes
    // from the frame around it still being readable.
    this.flashes.pop(_v, { size: 0.62, life: 0.16, heat: 3.6, roll, tint: _c });
    this.flashes.pop(_v, { size: 0.26, life: 0.7, heat: 3.0, cool: true });
    this.#punch(_v, 1.0, true);
    this.#flashLight(_v, 10, 0xffffff);
  }

  #onRoundEnd(e) {
    if (!this.enabled) return;
    this.flash.amount = e?.ko ? 0.45 : 0.2;
    this.overdrive.on = false;
    this.overdrive.hold = 0;
  }

  // -------------------------------------------------------------------------
  // shared spawn helpers
  // -------------------------------------------------------------------------

  /**
   * A ring of dust kicked outward along the floor. Spawned a little above the
   * floor plane: a billboard whose centre sits on the ground cuts a hard line
   * across it on tiers that have no depth prepass to fade against.
   *
   * The life is short for the same reason the sparks' is. A puff that grows for
   * a second is at its largest and its most opaque at the end, so it is still a
   * solid tan mass sitting on the fighter's boots long after the blow that threw
   * it — which is the one place in the frame nothing should be drawing the eye.
   */
  #groundDust(at, count, speed, size) {
    const c = Math.max(1, Math.round(count * this.budget));
    _v3.copy(at).setY(at.y + size * 0.55);
    for (let i = 0; i < c; i += 4) {
      const a = Math.random() * Math.PI * 2;
      _v2.set(Math.cos(a), 0.42, Math.sin(a)).normalize();
      this.smoke.puff(_v3, {
        count: Math.min(4, c - i), dir: _v2, speed, spread: 0.7, radius: 0.24,
        size, growth: 1.2, life: 0.62, buoyancy: 0.18, curl: 1.1, tint: DUST,
      });
    }
  }

  /**
   * Fires one of the pooled impact lights. Nothing is created or added; the
   * lights live in the scene at zero intensity so no material ever recompiles.
   */
  #flashLight(at, intensity, hex) {
    if (!this.impactLights || !this.lightsEnabled) return;
    const l = this.impactLights[this._lightCursor];
    this._lightCursor = (this._lightCursor + 1) % this.impactLights.length;
    l.position.copy(at);
    l.color.setHex(hex);
    l.intensity = intensity * (this.lightScale ?? 1);
    l.distance = 6.5;
    l.visible = true;
    l.userData.decay = 1;
  }

  /**
   * Impact frame. Restrained on purpose: a short radial smear toward the
   * contact point, a few frames of speed lines, and — only for ULTRA — a single
   * inverted frame. Overusing this is the fastest way to make a game unreadable.
   */
  #punch(point, strength, extreme) {
    if (!this.camera) return;
    _v2.copy(point).project(this.camera);
    this.overlayCenter = this.overlayCenter || new THREE.Vector2();
    this.overlayCenter.set(
      THREE.MathUtils.clamp(_v2.x, -1, 1),
      THREE.MathUtils.clamp(_v2.y, -1, 1),
    );
    const s = Math.min(1, strength);
    this.impact.level = Math.max(this.impact.level, s);
    this.impact.lines = Math.max(this.impact.lines, s * 0.85);
    if (extreme) this.impact.invert = Math.max(this.impact.invert, 0.85);
    this._speedSeed = Math.random() * 90;
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------

  /**
   * The one per-frame entry point.
   *
   * `alpha` is accepted for interface symmetry but deliberately unused: every
   * particle here is parameterised on the FX clock rather than on sim ticks, and
   * the bone matrices trails read from have already been interpolated by
   * `Fighter.render()` before this runs.
   *
   * @param {number} dt seconds of *visual* time (already scaled by hitstop)
   * @param {number} alpha simulation interpolation factor, 0..1
   */
  update(dt, alpha) {
    if (!this._ready) return;
    const step = Math.min(dt, 0.1);
    this.time += step;

    if (this.pipeline && this.pipeline.quality !== this.quality) {
      this.#applyQuality(this.pipeline.quality);
    }
    this.camera = this.pipeline?.camera || this.camera;
    // The environment can swap its rig when the lighting mood cross-fades.
    // Rescanning is a full scene traverse, so it is throttled to once a second.
    if ((!this.keyLight || !this.keyLight.parent) && --this._lightScan <= 0) {
      this._lightScan = 60;
      this.#findStageLight();
    }

    // Scheduled impact beats first: anything that comes due this frame must be
    // in the buffers before the systems flush them.
    this.#runBeats();

    this.#updateTrails(step);
    this.debris.update(step);

    this.sparks.update(this.time);
    this.fluid.update(this.time);
    this.smoke.update(this.time);
    this.shock.update(this.time);
    this.flashes.update(this.time);
    this.decals.update(this.time);

    // Coolant that has finished falling leaves a splat where it landed.
    this.fluid.drainSplats(this.time, this._onSplat);

    this.#updateLights(step);
    this.#updateLighting();
    this.#updateOverlay(step);
  }

  /**
   * Trails are driven by measured bone speed, so every fast limb streaks
   * whether or not its move declared one, and a move that *does* declare one
   * forces the ribbon on through its active frames.
   */
  #updateTrails(dt) {
    if (dt <= 0) return;
    if (!this._trailState) {
      this._trailState = [];
      for (let i = 0; i < 2; i++) {
        const slots = [];
        for (let k = 0; k < TRAIL_BONES.length; k++) {
          slots.push({ bone: null, joint: null, handle: -1, last: new THREE.Vector3(), primed: false });
        }
        this._trailState.push(slots);
      }
    }

    for (let fi = 0; fi < 2; fi++) {
      let rig = this.rigs[fi];
      if (!rig || !rig.parent) {
        rig = this.scene.getObjectByName(`fighter${fi}`) || null;
        this.rigs[fi] = rig;
        if (rig) for (const s of this._trailState[fi]) { s.bone = null; s.primed = false; }
      }
      if (!rig) continue;

      const fighter = this.fighters[fi];
      const forced = fighter?.currentMove?.trail || null;
      this.#palette(fighter, 'accent', _c);

      const slots = this._trailState[fi];
      for (let k = 0; k < TRAIL_BONES.length; k++) {
        const [boneName, jointName, width] = TRAIL_BONES[k];
        const s = slots[k];
        if (!s.bone) {
          s.bone = rig.getObjectByName(boneName) || null;
          s.joint = rig.getObjectByName(jointName) || null;
          s.primed = false;
          if (!s.bone) continue;
        }

        _v.setFromMatrixPosition(s.bone.matrixWorld);
        if (!s.primed) { s.last.copy(_v); s.primed = true; continue; }
        const speed = _v.distanceTo(s.last) / dt;
        s.last.copy(_v);

        const wanted = forced === boneName || speed > TRAIL_START_SPEED;
        const keep = forced === boneName || speed > TRAIL_STOP_SPEED;

        if (s.handle < 0 && wanted) {
          s.handle = this.trails.acquire(s.bone, s.joint, {
            tint: _c, extend: 0.5, width,
          });
        } else if (s.handle >= 0 && !keep) {
          this.trails.release(s.handle, 0.14);
          s.handle = -1;
        }
      }
    }

    this.trails.update(dt);
  }

  /** Decays the pooled impact lights and parks them when spent. */
  #updateLights(dt) {
    if (!this.lightsEnabled) return;
    for (const l of this.impactLights) {
      if (!l.visible) continue;
      const d = l.userData.decay - dt * 9.0;
      if (d <= 0) { l.visible = false; l.intensity = 0; l.userData.decay = 0; continue; }
      l.userData.decay = d;
      l.intensity *= Math.exp(-dt * 11.0);
      if (l.intensity < 0.05) { l.visible = false; l.intensity = 0; l.userData.decay = 0; }
    }
  }

  /** Feeds the arena lighting and the depth prepass into the smoke shader. */
  #updateLighting() {
    if (!this.camera) return;
    const key = this.keyLight;
    if (key) {
      key.getWorldDirection(_lightDir);
      if (key.target) {
        _v.setFromMatrixPosition(key.matrixWorld);
        _v2.setFromMatrixPosition(key.target.matrixWorld);
        _lightDir.copy(_v2).sub(_v).normalize();
      }
      _c.copy(key.color).multiplyScalar(Math.min(2.4, 0.35 + key.intensity * 0.22));
    } else {
      _lightDir.set(0.4, -0.85, 0.32).normalize();
      _c.setRGB(1.0, 0.94, 0.86);
    }
    const env = this.scene.environment;
    _c2.setRGB(0.14, 0.17, 0.24);
    if (env && this.scene.environmentIntensity) _c2.multiplyScalar(this.scene.environmentIntensity);
    this.smoke.setLighting(_lightDir, _c, _c2, this.camera);

    // Soft particles, when the pipeline is running its depth prepass. The
    // flashes need it as much as the smoke does: a contact flare sits right on
    // the surface it struck, and without the fade its halo cuts a hard circular
    // arc across the fighter that reads as a sphere hanging in the air.
    const gbuffer = this.pipeline?._passes?.gbuffer;
    const depth = gbuffer?.depthTexture || null;
    const size = this.pipeline?.renderer?.getDrawingBufferSize?.(_size) || null;
    const w = size ? size.x : 1920;
    const h = size ? size.y : 1080;
    const near = this.camera.near ?? 0.15;
    const far = this.camera.far ?? 260;
    this.smoke.setDepth(depth, w, h, near, far);
    this.flashes.setDepth(depth, w, h, near, far);
  }

  /** Drives the composer overlay: refraction rings, impact frames, overdrive. */
  #updateOverlay(dt) {
    this.#ensurePass();
    const pass = this._pass;
    if (!pass) return;
    const u = pass.uniforms;

    // Screen-space refraction from the live shockwaves.
    if (this.camera) {
      const n = this.shock.writeDistortion(this.camera, this._ringData);
      for (let i = 0; i < MAX_DISTORT_RINGS; i++) {
        const o = i * 4;
        u.uRings.value[i].set(
          this._ringData[o], this._ringData[o + 1],
          this._ringData[o + 2], i < n ? this._ringData[o + 3] : 0,
        );
      }
    }

    // Impact frame decay.
    const imp = this.impact;
    imp.level = Math.max(0, imp.level - dt * imp.decay);
    imp.lines = Math.max(0, imp.lines - dt * imp.linesDecay);
    imp.invert = Math.max(0, imp.invert - dt * imp.invertDecay);
    this.flash.amount = Math.max(0, this.flash.amount - dt * this.flash.decay);

    u.uImpact.value = imp.level;
    u.uSpeedLines.value = imp.lines;
    u.uInvert.value = imp.invert > 0.5 ? 1 : 0;
    u.uSpeedSeed.value = this._speedSeed || 0;
    u.uFlashAmount.value = this.flash.amount;
    if (this.overlayCenter) u.uImpactCenter.value.copy(this.overlayCenter);
    u.uImpactTint.value.setRGB(1.0, 0.86, 0.7);

    // Overdrive envelope: build, hold, release.
    const od = this.overdrive;
    if (od.on) {
      od.t += dt;
      od.level = Math.min(1, od.t / 0.32);
      od.hold -= dt;
      if (od.hold <= 0) od.on = false;
    } else if (od.level > 0) {
      od.level = Math.max(0, od.level - dt * 1.8);
    }
    od.flash = Math.max(0, od.flash - dt * 5.5);
    od.desat = od.level * 0.6;

    u.uSuper.value = od.level;
    u.uDesat.value = od.desat;
    u.uSuperFlash.value = od.flash;
    if (od.color) u.uSuperColor.value.copy(od.color);
    if (od.fighter && this.camera && od.level > 0) {
      _v.copy(od.fighter.position);
      _v.y += 1.0;
      _v.project(this.camera);
      u.uSuperCenter.value.set(
        THREE.MathUtils.clamp(_v.x, -1.2, 1.2),
        THREE.MathUtils.clamp(_v.y, -1.2, 1.2),
      );
    }

    u.uTime.value = this.time;
    pass.refreshActive();
  }

  /**
   * Keeps the overlay pass installed at the end of the composer. The render
   * pipeline rebuilds its chain whenever the quality tier changes, so this
   * checks identity every frame rather than assuming a one-time install.
   */
  #ensurePass() {
    const composer = this.pipeline?.composer;
    if (!composer) { this._pass = null; this._installedComposer = null; return; }
    if (composer === this._installedComposer && composer.passes.includes(this._pass)) return;

    this._pass = new OverlayPass();
    this._pass.setBeamTexture(this.textures.beam);
    const size = this.pipeline.renderer?.getDrawingBufferSize?.(_size);
    this._pass.setSize(size ? size.x : 1920, size ? size.y : 1080);
    composer.addPass(this._pass);
    this._installedComposer = composer;
  }

  // -------------------------------------------------------------------------
  // quality / lifecycle
  // -------------------------------------------------------------------------

  /** @param {'ultra'|'high'|'medium'|'low'} q */
  #applyQuality(q) {
    this.quality = q;
    this.budget = this.pipeline?.particleBudget ?? 1;
    const ultra = q === 'ultra';
    const high = ultra || q === 'high';

    this.lightsEnabled = high;
    if (!high && this.impactLights) {
      for (const l of this.impactLights) { l.visible = false; l.intensity = 0; }
    }
    this.debris.setShadows(ultra);
    this.trails.setIntensity(high ? 1.6 : 1.3);
    this.sparks.setScale(high ? 1 : 1.15);
    this.flashes.setScale(high ? 1 : 0.9);
    // Hard ceiling on how much of the frame any single flare may cover, in NDC
    // half-heights. 0.46 puts the outer falloff at under a quarter of the frame
    // height, and the hot core is a fraction of that again. This is what stops a
    // super connecting at close range from whiting out the shot.
    this.flashes.setMaxRadius(0.46);
    this.smoke.setScale(high ? 1 : 1.2);
    this.smoke.material.uniforms.uOpacity.value = q === 'low' ? 0.72 : 1;
    this.fluid.setScale(1);
    this.decals.material.uniforms.uOpacity.value = q === 'low' ? 0.7 : 1;
  }

  /** Retires every live particle, decal, trail and screen effect. */
  reset() {
    if (!this._ready) return;
    this.sparks.reset();
    this.fluid.reset();
    this.smoke.reset();
    this.debris.reset();
    this.shock.reset();
    this.flashes.reset();
    this.decals.reset();
    this.trails.reset();
    for (const b of this._beats) { b.due = -1; b.hit = null; }

    if (this._trailState) {
      for (const slots of this._trailState) {
        for (const s of slots) { s.handle = -1; s.primed = false; }
      }
    }
    if (this.impactLights) {
      for (const l of this.impactLights) { l.visible = false; l.intensity = 0; l.userData.decay = 0; }
    }

    this.impact.level = 0; this.impact.lines = 0; this.impact.invert = 0;
    this.flash.amount = 0;
    this.overdrive.on = false;
    this.overdrive.level = 0;
    this.overdrive.desat = 0;
    this.overdrive.flash = 0;
    this.overdrive.hold = 0;

    if (this._pass) {
      const u = this._pass.uniforms;
      u.uImpact.value = 0; u.uSpeedLines.value = 0; u.uInvert.value = 0;
      u.uSuper.value = 0; u.uDesat.value = 0; u.uSuperFlash.value = 0;
      u.uFlashAmount.value = 0;
      for (const r of u.uRings.value) r.set(0, 0, 0, 0);
      u.uActive.value = 0;
    }
  }

  dispose() {
    for (const off of this._unsub) off();
    this._unsub.length = 0;
    this.scene.remove(this.group);
    this.sparks?.dispose();
    this.fluid?.dispose();
    this.smoke?.dispose();
    this.debris?.dispose();
    this.shock?.dispose();
    this.flashes?.dispose();
    this.decals?.dispose();
    this.trails?.dispose();
    if (this.textures) for (const t of Object.values(this.textures)) t.dispose();
    if (this._pass && this._installedComposer) {
      const i = this._installedComposer.passes.indexOf(this._pass);
      if (i >= 0) this._installedComposer.passes.splice(i, 1);
      this._pass.dispose();
    }
    this._pass = null;
    this._ready = false;
  }
}

export default EffectsDirector;
