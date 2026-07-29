/**
 * Knockbots — the fight camera.
 *
 * In a 3D fighter the camera is a character. It has to keep two moving bodies
 * legible at all times, sell the weight of every impact, and never once draw
 * attention to itself by snapping, drifting or clipping. This one is built on
 * four ideas:
 *
 * 1. **Real springs, not lerps.** Every tracked quantity (position, look-at,
 *    field of view, roll) is a critically damped spring integrated with its
 *    exact analytic solution, so it is unconditionally stable, frame-rate
 *    independent, and — crucially — has a *velocity* that impacts can kick.
 *    A lerp cannot recoil; a spring can.
 *
 * 2. **Distance drives dolly and lens together.** As the fighters close, the
 *    camera dollies in and the lens tightens slightly. Both moving at once is
 *    what makes close range feel claustrophobic instead of merely nearer.
 *
 * 3. **Framing is guaranteed, not hoped for.** After the artistic distance is
 *    chosen, the camera solves for the distance that actually contains both
 *    fighters' bounding spheres inside the smaller of the two frustum angles
 *    and takes whichever is larger. Juggles pull the camera back on their own.
 *
 * 4. **Trauma, not shake.** Impacts add trauma; shake is trauma squared driven
 *    by smooth value noise on three positional and two rotational axes. Trauma
 *    decays, so overlapping hits accumulate and settle naturally instead of
 *    stacking into a seizure.
 *
 * The simulation half runs on the fixed 60Hz tick and is deterministic (noise
 * is analytic, nothing calls Math.random). `render()` interpolates between the
 * last two sim states and adds the presentation-only shake, so the camera is
 * perfectly smooth regardless of how many ticks a frame consumed.
 *
 * It also publishes a `cameraFocus` bus event every frame carrying the focus
 * point, the pair radius and the focus distance; `RenderPipeline` uses that to
 * fit the shadow cascade and set the depth-of-field plane.
 */

import * as THREE from 'three';
import { bus } from '../core/Bus.js';
import {
  TICK_DT, GROUND_Y, ARENA_HALF_WIDTH, ARENA_HALF_DEPTH,
  MAX_PAIR_DISTANCE, FIGHTER_HEIGHT, WEIGHT,
} from '../core/Constants.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Critically damped springs
//
// Exact solution of x'' + 2w x' + w^2 (x - target) = 0 for zeta = 1:
//   x(t) = target + (c1 + c2 t) e^-wt,  c1 = x0 - target,  c2 = v0 + w c1
// Unconditionally stable at any dt, and an impulse on v produces the single
// clean overshoot that reads as recoil.
// ---------------------------------------------------------------------------

/** Scalar critically damped spring. */
class Spring1 {
  constructor(value = 0, frequency = 3) {
    this.value = value;
    this.velocity = 0;
    this.omega = frequency * 2 * Math.PI;
  }
  set frequency(hz) { this.omega = hz * 2 * Math.PI; }
  step(target, dt) {
    const w = this.omega;
    const e = Math.exp(-w * dt);
    const c1 = this.value - target;
    const c2 = this.velocity + w * c1;
    this.value = target + (c1 + c2 * dt) * e;
    this.velocity = (c2 - w * (c1 + c2 * dt)) * e;
  }
  snap(value) { this.value = value; this.velocity = 0; }
}

/** Vector3 critically damped spring. */
class Spring3 {
  constructor(frequency = 3) {
    this.value = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.omega = frequency * 2 * Math.PI;
  }
  set frequency(hz) { this.omega = hz * 2 * Math.PI; }
  step(target, dt) {
    const w = this.omega;
    const e = Math.exp(-w * dt);
    const v = this.value;
    const d = this.velocity;

    let c1 = v.x - target.x, c2 = d.x + w * c1;
    v.x = target.x + (c1 + c2 * dt) * e;
    d.x = (c2 - w * (c1 + c2 * dt)) * e;

    c1 = v.y - target.y; c2 = d.y + w * c1;
    v.y = target.y + (c1 + c2 * dt) * e;
    d.y = (c2 - w * (c1 + c2 * dt)) * e;

    c1 = v.z - target.z; c2 = d.z + w * c1;
    v.z = target.z + (c1 + c2 * dt) * e;
    d.z = (c2 - w * (c1 + c2 * dt)) * e;
  }
  snap(target) { this.value.copy(target); this.velocity.set(0, 0, 0); }
}

// ---------------------------------------------------------------------------
// Smooth value noise, used for shake. Deterministic and continuous, unlike
// per-frame random, which produces a strobing rattle instead of a camera that
// is being physically knocked about.
// ---------------------------------------------------------------------------

function hash1(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453123;
  return s - Math.floor(s);
}
function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}
/** Two-octave signed noise in roughly [-1, 1]. */
function snoise(x, seed) {
  return (noise1(x + seed) * 2 - 1) * 0.68 + (noise1(x * 2.37 + seed * 1.7 + 11.3) * 2 - 1) * 0.32;
}

// ---------------------------------------------------------------------------

/** Fallback bone heights, in metres above the fighter's feet. */
const BONE_HEIGHT = {
  headTop: 1.82, head: 1.62, neck: 1.5, chest: 1.36, spine02: 1.2,
  spine01: 1.06, hips: 0.96, hand_L: 1.0, hand_R: 1.0, foot_L: 0.1, foot_R: 0.1,
};

/** Trauma an impact contributes, by attack weight class. */
const IMPACT_TRAUMA = {
  [WEIGHT.LIGHT]: 0.15,
  [WEIGHT.MEDIUM]: 0.26,
  [WEIGHT.HEAVY]: 0.48,
  [WEIGHT.LAUNCHER]: 0.44,
  [WEIGHT.ULTRA]: 0.72,
};

const _focus = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _desiredLook = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _lookOut = new THREE.Vector3();
const _posOut = new THREE.Vector3();

export class FightCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {Array<object>} fighters
   * @param {object} stage exposing `bounds` and `floorY`
   */
  constructor(camera, fighters, stage) {
    this.camera = camera;
    this.fighters = fighters || [];
    this.stage = stage || null;

    // --- sim state ------------------------------------------------------
    this.posSpring = new Spring3(2.9);
    this.lookSpring = new Spring3(4.2);
    this.fovSpring = new Spring1(camera?.fov ?? 38, 2.6);
    this.rollSpring = new Spring1(0, 3.4);

    /** Previous tick's sim state, for interpolation. */
    this.prev = {
      pos: new THREE.Vector3(),
      look: new THREE.Vector3(),
      fov: camera?.fov ?? 38,
      roll: 0,
      trauma: 0,
    };

    /** Impact state. */
    this.trauma = 0;
    this.traumaDecay = 1.7;
    this.punch = 0;

    /** Focus report consumed by RenderPipeline. */
    this.focus = new THREE.Vector3(0, 1.05, 0);
    this.focusRadius = 3.2;
    this._focusPayload = {
      center: new THREE.Vector3(), radius: 3.2, distance: 6.4,
      nearRange: 2.4, farRange: 9.5,
    };

    /** @type {string} active cinematic, `'fight'` means normal tracking. */
    this.mode = 'fight';
    this.modeOpts = {};
    this.modeTicks = 0;
    this.modeDuration = Infinity;
    this._snapNext = true;
    this._lastPhase = null;

    this._shakeTime = 0;
    this._orbit = 0;
    this._tick = 0;

    // Prime on the current pair so the very first frame is already framed.
    this.#desiredForMode(_desiredPos, _desiredLook);
    this.posSpring.snap(_desiredPos);
    this.lookSpring.snap(_desiredLook);
    this.#storePrev();

    this._unsubs = [
      bus.on('shake', (e) => this.shake(e?.amount ?? 0.3, e?.ticks ?? 14)),
      bus.on('hit', (e) => this.#onHit(e)),
      bus.on('block', (e) => this.#onBlock(e)),
      bus.on('parry', () => this.shake(0.2, 10)),
      bus.on('wallSplat', (e) => this.#onBigImpact(e, 0.5)),
      bus.on('knockdown', (e) => this.#onBigImpact(e, 0.34)),
      bus.on('groundImpact', (e) => this.#onBigImpact(e, Math.min(0.42, 0.06 * (e?.speed ?? 3)))),
      bus.on('superStart', (e) => this.cinematic('super', { target: e?.fighter })),
      bus.on('superHit', () => { this.shake(0.62, 26); this.punch = Math.min(1, this.punch + 0.7); }),
    ];
  }

  dispose() {
    for (const off of this._unsubs) off?.();
    this._unsubs.length = 0;
  }

  // -- public API ----------------------------------------------------------

  /**
   * Adds camera trauma. Shake is trauma squared, so a 0.5 hit is a quarter as
   * violent as a 1.0 hit rather than half — which is what makes big hits read
   * as genuinely bigger.
   * @param {number} amount 0..1
   * @param {number} ticks how long the trauma should take to bleed off
   */
  shake(amount, ticks = 14) {
    if (!(amount > 0)) return;
    this.trauma = Math.min(1, this.trauma + amount);
    this.traumaDecay = THREE.MathUtils.clamp(60 / Math.max(ticks, 4), 0.7, 6.5);
  }

  /**
   * Switches to a cinematic framing. Names are contractual: `tools/capture.mjs`
   * calls `closeup`, `portrait`, `wide`, and the phase machine drives `intro`,
   * `ko`, `super` and `replay`. Passing `'fight'` or nothing returns to normal
   * pair tracking.
   *
   * @param {string} name
   * @param {object} [opts] `{ target, bone, dist, height, yaw, fov, ticks }`
   */
  cinematic(name = 'fight', opts = {}) {
    const mode = name || 'fight';
    this.mode = mode;
    this.modeOpts = opts || {};
    this.modeTicks = 0;
    this._orbit = 0;

    // Cinematic framings are cuts. Moves are moves.
    const cuts = { closeup: true, portrait: true, wide: true, ko: true };
    this._snapNext = !!cuts[mode];

    const durations = { intro: 150, super: 220, fight: Infinity };
    this.modeDuration = opts?.ticks ?? durations[mode] ?? Infinity;

    // Cinematic framings want a tighter, faster rig than combat tracking.
    const fast = mode !== 'fight';
    this.posSpring.frequency = fast ? 3.6 : 2.9;
    this.lookSpring.frequency = fast ? 5.0 : 4.2;
    this.fovSpring.frequency = fast ? 3.4 : 2.6;
  }

  /**
   * One 60Hz tick of camera simulation.
   * @param {string} phase current `PHASE` value
   * @param {number} phaseTicks ticks elapsed in this phase
   */
  simulate(phase, phaseTicks) {
    this.#storePrev();
    this._tick++;

    if (phase !== this._lastPhase) {
      this._lastPhase = phase;
      this.#onPhaseChange(phase);
    }

    this.modeTicks++;
    this._orbit += TICK_DT;
    if (this.modeTicks > this.modeDuration) this.cinematic('fight');

    this.trauma = Math.max(0, this.trauma - this.traumaDecay * TICK_DT);
    this.punch = Math.max(0, this.punch - 3.4 * TICK_DT * (0.4 + this.punch));

    const fov = this.#desiredForMode(_desiredPos, _desiredLook);
    // Every framing leaves the point it is composing around in `_focus`.
    if (Number.isFinite(_focus.x)) this.focus.copy(_focus);

    if (this._snapNext) {
      this._snapNext = false;
      this.posSpring.snap(_desiredPos);
      this.lookSpring.snap(_desiredLook);
      this.fovSpring.snap(fov);
      this.rollSpring.snap(0);
      this.#storePrev();
    } else {
      this.posSpring.step(_desiredPos, TICK_DT);
      this.lookSpring.step(_desiredLook, TICK_DT);
      this.fovSpring.step(fov, TICK_DT);
      this.rollSpring.step(0, TICK_DT);
    }

    this.#clampCamera(this.posSpring.value, this.lookSpring.value);
  }

  /**
   * Writes the interpolated camera transform for this display frame.
   * @param {number} alpha 0..1 between the last two sim ticks
   * @param {number} dt display delta in seconds
   */
  render(alpha, dt) {
    const cam = this.camera;
    if (!cam) return;
    const a = THREE.MathUtils.clamp(alpha, 0, 1);

    _posOut.lerpVectors(this.prev.pos, this.posSpring.value, a);
    _lookOut.lerpVectors(this.prev.look, this.lookSpring.value, a);
    const fov = THREE.MathUtils.lerp(this.prev.fov, this.fovSpring.value, a);
    let roll = THREE.MathUtils.lerp(this.prev.roll, this.rollSpring.value, a);
    const trauma = THREE.MathUtils.lerp(this.prev.trauma, this.trauma, a);

    // Shake keeps moving during hitstop (dt is scaled to a crawl there), which
    // is exactly when the biggest hits land.
    this._shakeTime += Math.max(dt || 0, 0.0025);

    const k = trauma * trauma;
    if (k > 0.0001) {
      const t = this._shakeTime * 26;
      _fwd.copy(_lookOut).sub(_posOut);
      const dist = _fwd.length() || 1;
      _fwd.divideScalar(dist);
      _right.crossVectors(_fwd, _upAxis).normalize();
      _v.crossVectors(_right, _fwd).normalize(); // orthonormal up

      const ax = snoise(t, 0.0) * 0.24 * k;
      const ay = snoise(t, 37.1) * 0.17 * k;
      const az = snoise(t * 0.82, 71.9) * 0.11 * k;
      _posOut.addScaledVector(_right, ax);
      _posOut.addScaledVector(_v, ay);
      _posOut.addScaledVector(_fwd, az);

      // Rotational shake is applied to the look target so it stays a rotation
      // about the camera rather than a second translation.
      const swing = dist * 0.055 * k;
      _lookOut.addScaledVector(_right, snoise(t * 1.13, 113.4) * swing);
      _lookOut.addScaledVector(_v, snoise(t * 1.07, 151.2) * swing);
      roll += snoise(t * 0.91, 197.6) * 0.075 * k;
    }

    cam.position.copy(_posOut);
    cam.up.set(0, 1, 0);
    cam.lookAt(_lookOut);
    if (Math.abs(roll) > 1e-5) cam.rotateZ(roll);

    if (cam.isPerspectiveCamera && Math.abs(cam.fov - fov) > 1e-3) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);

    this.#publishFocus(_posOut, _lookOut);
  }

  // -- desired framing ------------------------------------------------------

  /**
   * Fills `outPos` / `outLook` for the active mode and returns the field of
   * view it wants.
   * @returns {number} fov in degrees
   */
  #desiredForMode(outPos, outLook) {
    switch (this.mode) {
      case 'closeup': return this.#framingCloseup(outPos, outLook);
      case 'portrait': return this.#framingPortrait(outPos, outLook);
      case 'wide': return this.#framingWide(outPos, outLook);
      case 'intro': return this.#framingIntro(outPos, outLook);
      case 'ko': return this.#framingKo(outPos, outLook);
      case 'super': return this.#framingSuper(outPos, outLook);
      case 'replay': return this.#framingReplay(outPos, outLook);
      default: return this.#framingFight(outPos, outLook);
    }
  }

  get floorY() {
    const y = this.stage?.floorY;
    return typeof y === 'number' ? y : GROUND_Y;
  }

  get bounds() {
    return this.stage?.bounds ?? { halfWidth: ARENA_HALF_WIDTH, halfDepth: ARENA_HALF_DEPTH };
  }

  /** Midpoint of the pair, raised to chest height and led by their motion. */
  #computeFocus(out) {
    const [a, b] = this.fighters;
    const floor = this.floorY;
    if (!a?.position || !b?.position) {
      out.set(0, floor + 1.05, 0);
      this.focusRadius = 3.0;
      return 2.6;
    }

    out.copy(a.position).add(b.position).multiplyScalar(0.5);
    // Feet-relative midpoint raised to chest height; airborne fighters lift it
    // on their own, which is what keeps a juggle in frame.
    out.y = (a.position.y + b.position.y) * 0.5 + 1.14;

    // Lead the camera along the pair's shared motion so it is never behind the
    // action, but only a little — a camera that anticipates too hard swims.
    if (a.velocity && b.velocity) {
      _v.copy(a.velocity).add(b.velocity).multiplyScalar(0.5 * 0.13);
      _v.y = 0;
      if (_v.lengthSq() > 4) _v.setLength(2);
      out.add(_v);
    }

    _v.copy(a.position).sub(b.position);
    _v.y = 0;
    const sep = Math.min(_v.length(), MAX_PAIR_DISTANCE);

    // Bounding sphere of both bodies about the focus point, used for framing.
    let r = 0;
    for (const f of this.fighters) {
      if (!f?.position) continue;
      _v2.copy(f.position);
      _v2.y += FIGHTER_HEIGHT * 0.52;
      r = Math.max(r, _v2.distanceTo(out));
    }
    this.focusRadius = r + 1.24;
    return sep;
  }

  /** Normal combat tracking. */
  #framingFight(outPos, outLook) {
    const sep = this.#computeFocus(_focus);
    const floor = this.floorY;

    const t = THREE.MathUtils.clamp((sep - 1.1) / 5.4, 0, 1);
    const eased = Math.pow(t, 0.85);

    let dist = THREE.MathUtils.lerp(3.55, 7.9, eased);
    let fov = THREE.MathUtils.lerp(31.5, 40.5, t);
    const pitch = THREE.MathUtils.lerp(6.5, 12.5, t) * DEG;

    // Punch-in on impact: dolly and lens tighten together.
    dist *= 1 - 0.15 * this.punch;
    fov -= 3.4 * this.punch;

    // Slight yaw so the pair is not dead-on when they are pinned to a wall.
    const yaw = THREE.MathUtils.clamp(-_focus.x * 0.021, -0.15, 0.15);

    // Honour the artistic distance unless it would cut somebody off.
    const need = this.#distanceToFrame(fov);
    dist = THREE.MathUtils.clamp(Math.max(dist, need), 3.1, 14.5);

    const horiz = Math.cos(pitch) * dist;
    outPos.set(
      _focus.x + Math.sin(yaw) * horiz,
      _focus.y + Math.sin(pitch) * dist + 0.28,
      _focus.z + Math.cos(yaw) * horiz,
    );
    outPos.y = Math.max(outPos.y, floor + 0.95);
    outLook.copy(_focus);
    return fov;
  }

  /** Tight lens on a single bone — the material and panel-detail shot. */
  #framingCloseup(outPos, outLook) {
    const opts = this.modeOpts;
    const target = opts.target ?? this.fighters[0];
    const bone = opts.bone ?? 'head';
    const dist = opts.dist ?? 1.15;
    const fov = opts.fov ?? 26;

    this.#bonePosition(target, bone, _focus);
    this.focus.copy(_focus);
    this.focusRadius = 1.4;

    const facing = target?.facing ?? 1;
    const yaw = opts.yaw ?? 0.95;
    // Three-quarter front view: swing off the fighter's forward axis toward
    // the camera side of the stage.
    _v.set(facing * Math.cos(yaw), 0, Math.sin(yaw)).normalize();
    outPos.copy(_focus).addScaledVector(_v, dist);
    outPos.y = _focus.y + dist * 0.13;
    outPos.y = Math.max(outPos.y, this.floorY + 0.35);
    outLook.copy(_focus);
    return fov;
  }

  /** Full body three-quarter — silhouette and proportion. */
  #framingPortrait(outPos, outLook) {
    const opts = this.modeOpts;
    const target = opts.target ?? this.fighters[0];
    const dist = opts.dist ?? 4.2;
    const fov = opts.fov ?? 30;
    const floor = this.floorY;

    const base = target?.position ?? _focus.set(0, floor, 0);
    _focus.set(base.x, floor + FIGHTER_HEIGHT * 0.54, base.z);
    this.focus.copy(_focus);
    this.focusRadius = FIGHTER_HEIGHT * 0.62;

    const facing = target?.facing ?? 1;
    const yaw = opts.yaw ?? 0.6;
    _v.set(facing * Math.cos(yaw), 0, Math.sin(yaw)).normalize();
    outPos.copy(_focus).addScaledVector(_v, dist);
    // A hair below eyeline: heroic without becoming a low-angle gimmick.
    outPos.y = floor + (opts.height ?? FIGHTER_HEIGHT * 0.62);
    outLook.copy(_focus);
    return fov;
  }

  /** Wide arena establishing shot. */
  #framingWide(outPos, outLook) {
    const opts = this.modeOpts;
    const dist = opts.dist ?? 13;
    const height = opts.height ?? 4.5;
    const fov = opts.fov ?? 34;
    const floor = this.floorY;

    this.#computeFocus(_focus);
    _focus.y = floor + 1.35;
    this.focus.copy(_focus);
    this.focusRadius = Math.max(this.focusRadius, 6.5);

    const yaw = opts.yaw ?? 0.16;
    outPos.set(
      _focus.x * 0.35 + Math.sin(yaw) * dist,
      floor + height,
      _focus.z * 0.3 + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return fov;
  }

  /** Opening crane: high, wide and slow, settling into the fight framing. */
  #framingIntro(outPos, outLook) {
    const total = Math.max(1, this.modeDuration);
    const t = THREE.MathUtils.clamp(this.modeTicks / total, 0, 1);
    const e = t * t * t * (t * (t * 6 - 15) + 10); // smootherstep
    const floor = this.floorY;

    this.#computeFocus(_focus);
    _focus.y = floor + THREE.MathUtils.lerp(1.55, 1.15, e);
    this.focus.copy(_focus);

    const yaw = THREE.MathUtils.lerp(-0.95, -0.06, e);
    const dist = THREE.MathUtils.lerp(9.6, 6.0, e);
    const height = THREE.MathUtils.lerp(5.4, 1.95, e);
    const fov = THREE.MathUtils.lerp(44, 38, e);

    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + height,
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return fov;
  }

  /** KO: drop to a low hero angle on the loser and orbit slowly. */
  #framingKo(outPos, outLook) {
    const opts = this.modeOpts;
    const floor = this.floorY;
    const loser = opts.target ?? this.#lowestHealthFighter();
    const base = loser?.position ?? _focus.set(0, floor, 0);

    _focus.set(base.x, floor + 0.82, base.z);
    this.focus.copy(_focus);
    this.focusRadius = 2.6;

    const facing = loser?.facing ?? 1;
    const yaw = (opts.yaw ?? 0.55) * facing + this._orbit * 0.17;
    const dist = opts.dist ?? 3.5;

    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + (opts.height ?? 0.62),
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    outLook.y = floor + 1.0;
    return opts.fov ?? 33;
  }

  /** Super: a fast whip-pan onto the attacker, then a hard push-in. */
  #framingSuper(outPos, outLook) {
    const opts = this.modeOpts;
    const attacker = opts.target ?? this.fighters[0];
    const floor = this.floorY;
    const base = attacker?.position ?? _focus.set(0, floor, 0);

    _focus.set(base.x, floor + 1.22, base.z);
    this.focus.copy(_focus);
    this.focusRadius = 2.4;

    // Whip in the first 20 ticks, push in over the next 60, then hold.
    const whip = THREE.MathUtils.clamp(this.modeTicks / 20, 0, 1);
    const whipEase = 1 - Math.pow(1 - whip, 3);
    const push = THREE.MathUtils.clamp((this.modeTicks - 14) / 62, 0, 1);
    const pushEase = push * push * (3 - 2 * push);

    const facing = attacker?.facing ?? 1;
    const yaw = THREE.MathUtils.lerp(-1.45 * facing, 0.34 * facing, whipEase);
    const dist = THREE.MathUtils.lerp(7.4, 2.85, pushEase);
    const fov = THREE.MathUtils.lerp(48, 29, pushEase);
    const height = THREE.MathUtils.lerp(2.6, 1.42, pushEase);

    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + height,
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return fov;
  }

  /** Replay: a patient orbit around the pair. */
  #framingReplay(outPos, outLook) {
    const opts = this.modeOpts;
    const floor = this.floorY;
    this.#computeFocus(_focus);
    _focus.y = floor + 1.2;
    this.focus.copy(_focus);

    const yaw = (opts.yaw ?? -0.5) + this._orbit * 0.22;
    const dist = opts.dist ?? 6.4;
    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + (opts.height ?? 2.15),
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return opts.fov ?? 34;
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Smallest distance that still contains both fighters, with headroom.
   *
   * Solved per axis against the real frustum rather than against a bounding
   * sphere: the pair is almost always spread along X and barely at all along
   * Y, and a sphere fit would let the narrow vertical angle dictate a distance
   * two thirds too far. Assumes the camera looks roughly down -Z, which the
   * yaw clamp in `#framingFight` guarantees. `_focus` must already hold the
   * current focus point.
   *
   * @param {number} fovDeg vertical field of view being considered
   * @returns {number} required distance in metres
   */
  #distanceToFrame(fovDeg) {
    const vFov = fovDeg * DEG;
    const aspect = this.camera?.aspect || 16 / 9;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);

    let halfW = 0;
    let above = 0;
    let below = 0;
    let towardCamera = 0;
    for (const f of this.fighters) {
      const p = f?.position;
      if (!p) continue;
      halfW = Math.max(halfW, Math.abs(p.x - _focus.x));
      above = Math.max(above, p.y + FIGHTER_HEIGHT - _focus.y);
      below = Math.max(below, _focus.y - p.y);
      towardCamera = Math.max(towardCamera, p.z - _focus.z);
    }
    halfW += 1.0;                                   // body radius plus side margin
    const halfH = Math.max(above + 0.34, below + 0.22);

    const needH = halfW / Math.tan(hFov / 2);
    const needV = halfH / Math.tan(vFov / 2);
    return Math.max(needH, needV) + Math.max(0, towardCamera);
  }

  /**
   * Keeps the camera out of the floor, off the fighters, and inside a sane box
   * around the stage. The arena bounds are combat walls, so the camera is
   * allowed outside them on its own side — it just may not sink or swing wide
   * enough to show the void.
   */
  #clampCamera(pos, look) {
    const floor = this.floorY;
    const b = this.bounds;
    pos.y = Math.max(pos.y, floor + 0.5);
    pos.x = THREE.MathUtils.clamp(pos.x, -(b.halfWidth + 3.5), b.halfWidth + 3.5);
    pos.z = THREE.MathUtils.clamp(pos.z, -(b.halfDepth + 4.5), b.halfDepth + 12);

    // Never let the lens pass through a body.
    for (const f of this.fighters) {
      if (!f?.position) continue;
      _v.set(f.position.x, f.position.y + 0.95, f.position.z);
      const d = pos.distanceTo(_v);
      const minD = 0.62;
      if (d < minD && d > 1e-4) {
        _v2.copy(pos).sub(_v).divideScalar(d);
        pos.copy(_v).addScaledVector(_v2, minD);
        pos.y = Math.max(pos.y, floor + 0.5);
      }
    }
    look.y = Math.max(look.y, floor + 0.1);
  }

  #storePrev() {
    this.prev.pos.copy(this.posSpring.value);
    this.prev.look.copy(this.lookSpring.value);
    this.prev.fov = this.fovSpring.value;
    this.prev.roll = this.rollSpring.value;
    this.prev.trauma = this.trauma;
  }

  #publishFocus(pos, look) {
    const p = this._focusPayload;
    p.center.copy(this.focus);
    if (!Number.isFinite(p.center.x)) p.center.copy(look);
    p.radius = this.focusRadius;
    p.distance = pos.distanceTo(p.center);
    // Generous ranges: the fighters and the near stage must stay sharp, only
    // the far walls and ceiling rig are allowed to soften.
    p.nearRange = THREE.MathUtils.clamp(p.distance * 0.45, 1.8, 5.5);
    p.farRange = THREE.MathUtils.clamp(p.distance * 2.4, 9, 45);
    bus.emit('cameraFocus', p);
  }

  #lowestHealthFighter() {
    let worst = null;
    for (const f of this.fighters) {
      if (!f) continue;
      if (!worst || (f.health ?? 0) < (worst.health ?? 0)) worst = f;
    }
    return worst;
  }

  /**
   * World position of a named bone on a fighter. Fighter modules expose their
   * rig in several shapes depending on how they were assembled, so every known
   * shape is probed before falling back to a rest-pose height.
   */
  #bonePosition(fighter, name, out) {
    const floor = this.floorY;
    if (!fighter) { out.set(0, floor + 1.6, 0); return out; }

    const bone =
      fighter.byName?.[name] ??
      fighter.bonesByName?.[name] ??
      fighter.bones?.byName?.[name] ??
      fighter.skeleton?.byName?.[name] ??
      fighter.rig?.byName?.[name] ??
      (Array.isArray(fighter.bones) ? fighter.bones.find((b) => b?.name === name) : null) ??
      fighter.group?.getObjectByName?.(name) ??
      null;

    if (bone?.matrixWorld) {
      bone.updateWorldMatrix?.(true, false);
      out.setFromMatrixPosition(bone.matrixWorld);
      if (Number.isFinite(out.x)) return out;
    }

    const p = fighter.position;
    const h = BONE_HEIGHT[name] ?? 1.4;
    if (p) out.set(p.x, p.y + h, p.z);
    else out.set(0, floor + h, 0);
    return out;
  }

  // -- events ---------------------------------------------------------------

  #onPhaseChange(phase) {
    switch (phase) {
      case 'intro': this.cinematic('intro'); break;
      case 'ko': this.cinematic('ko'); break;
      case 'replay': this.cinematic('replay'); break;
      case 'matchEnd': this.cinematic('replay'); break;
      case 'ready':
      case 'fight':
        this.cinematic('fight');
        break;
      default:
        if (this.mode !== 'fight') this.cinematic('fight');
    }
  }

  #onHit(e) {
    if (!e) return;
    const weight = e.move?.weight;
    const base = IMPACT_TRAUMA[weight] ?? IMPACT_TRAUMA[WEIGHT.MEDIUM];
    const counter = e.counter ? 1.45 : 1;
    const strength = Math.min(1, base * counter);

    this.shake(strength, weight === WEIGHT.ULTRA ? 30 : 16);
    this.punch = Math.min(1, this.punch + (e.counter ? 0.62 : 0.34) * (0.5 + base));

    // Roll away from the direction of the blow; counter-hits roll harder.
    const dirX = e.attacker?.facing ?? (e.point && e.defender?.position
      ? Math.sign(e.defender.position.x - e.point.x) || 1
      : 1);
    this.rollSpring.velocity += dirX * strength * (e.counter ? 4.6 : 2.9);

    // Recoil: a real impulse on the position spring, which the critically
    // damped return turns into a single clean kick.
    _fwd.copy(this.lookSpring.value).sub(this.posSpring.value);
    if (_fwd.lengthSq() > 1e-6) {
      _fwd.normalize();
      _right.crossVectors(_fwd, _upAxis).normalize();
      this.posSpring.velocity.addScaledVector(_fwd, strength * 2.4);
      this.posSpring.velocity.addScaledVector(_right, -dirX * strength * 1.35);
      this.lookSpring.velocity.addScaledVector(_right, dirX * strength * 0.9);
    }
  }

  #onBlock(e) {
    this.shake(0.11, 9);
    const dirX = e?.attacker?.facing ?? 1;
    this.rollSpring.velocity += dirX * 0.7;
  }

  #onBigImpact(e, amount) {
    this.shake(amount, 22);
    this.punch = Math.min(1, this.punch + amount * 0.5);
    _fwd.copy(this.lookSpring.value).sub(this.posSpring.value);
    if (_fwd.lengthSq() > 1e-6) {
      _fwd.normalize();
      this.posSpring.velocity.addScaledVector(_upAxis, -amount * 2.6);
      this.posSpring.velocity.addScaledVector(_fwd, amount * 1.2);
    }
  }
}
