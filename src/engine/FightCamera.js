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
 * 2. **Composition first, distance second.** Nothing here picks a dolly
 *    distance by hand. Each framing declares the world-space box it wants on
 *    screen — the fighters' silhouettes plus explicit headroom, floor and side
 *    margins — and the distance falls out of that box and the frustum angles.
 *    Because the box is asymmetric (more air above the heads than below the
 *    feet) the pair naturally sits a little below frame centre, which is where
 *    Tekken puts it. Separation then only chooses the *lens*: tight and
 *    compressed up close, wide and airy at range. Subject size stays constant
 *    because distance and lens move together.
 *
 * 3. **The guarantee survives everything.** Punch-in on impact eats the
 *    margins rather than shortening the solved distance, so it cannot crop
 *    anybody. Everything downstream of the solve — spring lag, a simulation
 *    frozen by hitstop while a launcher throws a body across the arena, the
 *    shake itself — is caught by re-solving the fit against the final transform
 *    in `render()`. Losing a fighter off the edge of the screen is the one
 *    thing a fighting-game camera may never do, so it is enforced last rather
 *    than merely intended first.
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

/**
 * Peak shake displacement at full trauma. The framing solver reserves exactly
 * these amounts as extra margin, so `render()` can never knock a fighter past
 * the frame edge no matter how many impacts overlap.
 */
const SHAKE = { lateral: 0.22, vertical: 0.16, dolly: 0.10, swing: 0.052, roll: 0.07 };

/**
 * Composition margins in metres, measured off a fighter's *standing* height.
 * A fighting stance sits a good fifteen centimetres under that, so the visible
 * headroom lands above the floor margin and the pair's midpoint falls just
 * below frame centre — which is where Tekken keeps it.
 */
const FRAME_MARGIN = { top: 0.32, bottom: 0.34, side: 0.36 };

/** Framings that compose both fighters and must therefore contain both. */
const PAIR_FRAMINGS = { fight: true, impact: true, intro: true, wide: true, replay: true };

/** Half-width of a robot's silhouette including shoulder plates and arms. */
const BODY_HALF_WIDTH = 0.55;

/** Radius a closeup should fill the frame height with, by target bone. */
const CLOSEUP_RADIUS = {
  headTop: 0.22, head: 0.24, neck: 0.30, chest: 0.48, spine02: 0.52,
  spine01: 0.52, hips: 0.48, hand_L: 0.24, hand_R: 0.24,
  foot_L: 0.26, foot_R: 0.26, shoulder_L: 0.38, shoulder_R: 0.38,
};

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
const _endPos = new THREE.Vector3();
const _endLook = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _upAxis = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _pt = new THREE.Vector3();
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

    // Trauma envelope leads the decaying trauma, so the margin the solver
    // reserves shrinks more slowly than the shake it is covering for.
    this._traumaEnvelope = 0;
    // Last solved framing, used to size the shake reserve without recursion.
    this._fitDistance = 6;
    this._fitHalfHeight = 1.45;
    this._pair = { x: 0, z: 0, sep: 2.4, top: 2, bottom: 0 };

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
    this._traumaEnvelope = Math.max(this._traumaEnvelope, this.trauma);
    this.traumaDecay = THREE.MathUtils.clamp(60 / Math.max(ticks, 4), 0.7, 6.5);
  }

  /**
   * Switches to a cinematic framing. Names are contractual: `tools/capture.mjs`
   * calls `closeup`, `portrait` and `wide`, `TestHarness` drives `impact`,
   * `super`, `ko` and `lineup`, and the phase machine drives `intro`, `ko` and
   * `replay`. Passing `'fight'` or nothing returns to normal pair tracking.
   *
   * Every framing honours the same option vocabulary where it is meaningful:
   * - `target` fighter the shot is about (defaults to player one, or to the
   *   losing fighter for `ko`)
   * - `bone` bone name a `closeup` frames
   * - `dist` dolly distance in metres; the lens is then solved so the subject
   *   still fits, so asking for a closer camera really does get you one
   * - `yaw` azimuth in radians, measured from the audience axis (+Z)
   * - `height` camera height above the stage floor
   * - `fov` pins the lens and lets the distance do the fitting instead
   * - `ticks` how long the framing lasts before falling back to `fight`
   *
   * @param {string} name
   * @param {object} [opts]
   */
  cinematic(name = 'fight', opts = {}) {
    const mode = name || 'fight';
    this.mode = mode;
    this.modeOpts = opts || {};
    this.modeTicks = 0;
    this._orbit = 0;

    // Cinematic framings are cuts. Moves are moves.
    const cuts = { closeup: true, portrait: true, wide: true, ko: true, lineup: true };
    this._snapNext = !!cuts[mode];

    const durations = { intro: 150, super: 220, fight: Infinity };
    this.modeDuration = opts?.ticks ?? durations[mode] ?? Infinity;

    // Combat tracking is loose enough to breathe; moving cinematics are tighter;
    // held portraits are rigid, because a subject that drifts a hand's width in
    // a shot this close leaves the frame entirely.
    const rigid = mode === 'closeup' || mode === 'portrait';
    const fast = mode !== 'fight';
    this.posSpring.frequency = rigid ? 9 : (fast ? 3.6 : 2.9);
    this.lookSpring.frequency = rigid ? 11 : (fast ? 5.0 : 4.2);
    this.fovSpring.frequency = rigid ? 7 : (fast ? 3.4 : 2.6);
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
    this._traumaEnvelope = Math.max(
      this.trauma,
      this._traumaEnvelope - this.traumaDecay * 0.55 * TICK_DT,
    );
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

      // Amplitudes are exactly the ones the solver reserved margin for.
      _posOut.addScaledVector(_right, snoise(t, 0.0) * SHAKE.lateral * k);
      _posOut.addScaledVector(_v, snoise(t, 37.1) * SHAKE.vertical * k);
      _posOut.addScaledVector(_fwd, snoise(t * 0.82, 71.9) * SHAKE.dolly * k);

      // Rotational shake is applied to the look target so it stays a rotation
      // about the camera rather than a second translation.
      const swing = dist * SHAKE.swing * k;
      _lookOut.addScaledVector(_right, snoise(t * 1.13, 113.4) * swing);
      _lookOut.addScaledVector(_v, snoise(t * 1.07, 151.2) * swing);
      roll += snoise(t * 0.91, 197.6) * SHAKE.roll * k;
    }

    if (PAIR_FRAMINGS[this.mode]) this.#enforceFraming(_posOut, _lookOut, fov);

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
      case 'impact': return this.#framingImpact(outPos, outLook);
      case 'lineup': return this.#framingLineup(outPos, outLook);
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

  /**
   * Normal combat tracking — the framing the game is actually played in.
   *
   * Separation picks the lens and nothing else. The distance comes from the
   * composition box, so a robot occupies the same slice of the frame whether
   * the pair is nose to nose or at poking range; only the compression changes.
   */
  #framingFight(outPos, outLook) {
    const m = this.#pairMetrics();
    const floor = this.floorY;

    const t = THREE.MathUtils.clamp((m.sep - 0.9) / (MAX_PAIR_DISTANCE - 0.9), 0, 1);
    // Impacts widen the lens a touch while the margins tighten, so the punch-in
    // is a genuine dolly rather than a zoom.
    const fov = THREE.MathUtils.lerp(31, 43, Math.pow(t, 0.7)) + 1.5 * this.punch;

    // Punch-in eats margin instead of distance: the frame gets tighter but the
    // solve still contains both bodies, so nobody can be cropped by an impact.
    const bite = 1 - 0.6 * this.punch;
    const shake = this.#shakeMargin();

    const top = m.top + FRAME_MARGIN.top * bite + shake.vert;
    const bottom = m.bottom - FRAME_MARGIN.bottom * bite - shake.vert;
    _focus.set(m.x, (top + bottom) * 0.5, m.z);

    const halfH = (top - bottom) * 0.5;
    const side = FRAME_MARGIN.side * bite + shake.side;

    // A few degrees of yaw keeps the pair off dead-on when they are pinned to a
    // wall; the solver is told about it so the fit stays exact.
    const yaw = THREE.MathUtils.clamp(-m.x * 0.02, -0.14, 0.14);
    const dist = THREE.MathUtils.clamp(this.#fitDistance(_focus, fov, halfH, side, yaw), 3.4, 16);
    this._fitDistance = dist;
    this._fitHalfHeight = halfH;
    this.focusRadius = Math.max(halfH, m.sep * 0.5 + BODY_HALF_WIDTH) + 0.6;

    const pitch = THREE.MathUtils.lerp(5, 9, t) * DEG;
    const horiz = Math.cos(pitch) * dist;
    outPos.set(
      _focus.x + Math.sin(yaw) * horiz,
      Math.max(_focus.y + Math.sin(pitch) * dist, floor + 1.0),
      _focus.z + Math.cos(yaw) * horiz,
    );
    outLook.copy(_focus);
    return fov;
  }

  /** Tight lens on a single bone — the material and panel-detail shot. */
  #framingCloseup(outPos, outLook) {
    const opts = this.modeOpts;
    const target = opts.target ?? this.fighters[0];
    const bone = opts.bone ?? 'head';
    const radius = CLOSEUP_RADIUS[bone] ?? 0.42;

    this.#boneCentre(target, bone, _focus);
    this.focusRadius = radius + 0.35;

    // `dist` is the caller's to choose; the lens is then solved so the bone
    // still fills the frame. That is what makes the option mean something.
    const dist = THREE.MathUtils.clamp(opts.dist ?? radius / Math.tan(15 * DEG), 0.55, 6);
    const fov = opts.fov ?? THREE.MathUtils.clamp(2 * Math.atan(radius / dist) / DEG, 20, 46);

    const facing = target?.facing ?? 1;
    const yaw = opts.yaw ?? 0.85;
    // Three-quarter front: swing off the audience axis toward the fighter's
    // forward direction, never behind it and never past the stage edge.
    _v.set(facing * Math.sin(yaw), 0, Math.cos(yaw));
    outPos.copy(_focus).addScaledVector(_v, dist);
    // A hair under the bone, looking fractionally up. Above it and a robot's
    // shoulder pack eats the frame while the head reads as an afterthought.
    outPos.y = Math.max(_focus.y + (opts.height ?? -dist * 0.05), this.floorY + 0.3);

    // Sit the subject above centre and give it room to look into: dead-centre
    // reads as a debug view, not as a portrait.
    outLook.copy(_focus);
    outLook.y -= radius * 0.30;
    _fwd.copy(_focus).sub(outPos).normalize();
    _right.crossVectors(_fwd, _upAxis).normalize();
    outLook.addScaledVector(_right, (Math.sign(facing * _right.x) || 1) * radius * 0.42);
    return fov;
  }

  /** Full body three-quarter — silhouette and proportion. */
  #framingPortrait(outPos, outLook) {
    const opts = this.modeOpts;
    const target = opts.target ?? this.fighters[0];
    const floor = this.floorY;
    const p = this.#targetPosition(target, _pt);

    const top = this.#subjectTop(target) + 0.34;
    const bottom = (p ? p.y : floor) - 0.44;
    _focus.set(p ? p.x : 0, (top + bottom) * 0.5, p ? p.z : 0);

    const halfH = (top - bottom) * 0.5;
    this.focusRadius = halfH + 0.5;

    const dist = THREE.MathUtils.clamp(opts.dist ?? halfH / Math.tan(15 * DEG), 2.2, 14);
    const fov = opts.fov ?? THREE.MathUtils.clamp(2 * Math.atan(halfH / dist) / DEG, 22, 46);

    const facing = target?.facing ?? 1;
    const yaw = opts.yaw ?? 0.62;
    // Yaw runs from the audience axis toward the subject's front. Measuring it
    // off the fighter's own forward axis instead would walk the camera onto the
    // pair axis, where the opponent stands squarely between lens and subject.
    _v.set(facing * Math.sin(yaw), 0, Math.cos(yaw));
    outPos.copy(_focus).addScaledVector(_v, dist);
    outPos.y = floor + (opts.height ?? _focus.y - floor + 0.06);
    outLook.copy(_focus);

    this.#composeSubject(outPos, outLook, target, fov);
    return fov;
  }

  /**
   * Impact hold: the pair framing driven hard in on the point of contact.
   *
   * It is allowed to be greedy because it is a pair framing, so
   * `#enforceFraming` runs after the springs and dollies straight back out the
   * moment the push-in would clip either fighter.
   */
  #framingImpact(outPos, outLook) {
    const opts = this.modeOpts;
    const fov = this.#framingFight(outPos, outLook);

    // Weight the frame onto whoever threw the blow.
    if (this.#targetPosition(opts.target, _v2)) {
      outLook.x = THREE.MathUtils.lerp(outLook.x, _v2.x, 0.3);
      outLook.z = THREE.MathUtils.lerp(outLook.z, _v2.z, 0.3);
      _focus.copy(outLook);
    }

    const dist = Math.max(opts.dist ?? outPos.distanceTo(outLook) * 0.78, 2.4);
    outPos.sub(outLook).setLength(dist).add(outLook);
    outPos.y = Math.max(outPos.y, this.floorY + 0.85);
    this._fitDistance = dist;
    return fov;
  }

  /**
   * Roster lineup: a level, symmetrical shot of a row of fighters standing off
   * to one side of the stage. `target` is a bare world point here, not a
   * fighter, which is why every framing resolves targets through one helper.
   */
  #framingLineup(outPos, outLook) {
    const opts = this.modeOpts;
    const floor = this.floorY;
    if (!this.#targetPosition(opts.target, _focus)) _focus.set(0, floor + 1.0, 0);

    const dist = THREE.MathUtils.clamp(opts.dist ?? 10, 3, 30);
    const fov = opts.fov ?? 34;
    this.focusRadius = dist * 0.55;

    const yaw = opts.yaw ?? 0;
    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + (opts.height ?? 1.9),
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return fov;
  }

  /** Wide arena establishing shot. */
  #framingWide(outPos, outLook) {
    const opts = this.modeOpts;
    const m = this.#pairMetrics();
    const floor = this.floorY;
    const fov = opts.fov ?? 34;

    // A generous box: the shot is about the room the fight happens in, so the
    // pair should sit small and low with architecture above them.
    const top = m.top + 1.35;
    const bottom = m.bottom - 0.9;
    _focus.set(m.x * 0.6, (top + bottom) * 0.5, m.z * 0.5);

    const halfH = (top - bottom) * 0.5;
    this.focusRadius = Math.max(halfH, m.sep * 0.5) + 1.6;

    const yaw = opts.yaw ?? 0.16;
    const dist = Math.max(opts.dist ?? 13, this.#fitDistance(_focus, fov, halfH, 1.2, yaw));
    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + (opts.height ?? 4.5),
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return fov;
  }

  /**
   * Opening crane: high, wide and slow, landing exactly on the framing the
   * round will be played in so the cut to `fight` is invisible.
   */
  #framingIntro(outPos, outLook) {
    const opts = this.modeOpts;
    const t = THREE.MathUtils.clamp(this.modeTicks / Math.max(1, this.modeDuration), 0, 1);
    const e = t * t * t * (t * (t * 6 - 15) + 10); // smootherstep

    const endFov = this.#framingFight(_endPos, _endLook);
    const dx = _endPos.x - _endLook.x;
    const dz = _endPos.z - _endLook.z;
    const endYaw = Math.atan2(dx, dz);
    const endDist = Math.hypot(dx, dz);

    const yaw = THREE.MathUtils.lerp(endYaw + (opts.yaw ?? -0.9), endYaw, e);
    const dist = THREE.MathUtils.lerp(endDist + (opts.dist ?? 4.2), endDist, e);
    const height = THREE.MathUtils.lerp(this.floorY + (opts.height ?? 5.6), _endPos.y, e);

    outLook.copy(_endLook);
    outPos.set(_endLook.x + Math.sin(yaw) * dist, height, _endLook.z + Math.cos(yaw) * dist);
    return THREE.MathUtils.lerp(endFov + 6, endFov, e);
  }

  /** KO: drop to a low hero angle on the loser and orbit slowly. */
  #framingKo(outPos, outLook) {
    const opts = this.modeOpts;
    const floor = this.floorY;
    const loser = opts.target ?? this.#lowestHealthFighter();
    const p = this.#targetPosition(loser, _pt);

    const top = this.#subjectTop(loser) + 0.30;
    const bottom = (p ? p.y : floor) - 0.44;
    _focus.set(p ? p.x : 0, (top + bottom) * 0.5, p ? p.z : 0);

    const halfH = (top - bottom) * 0.5;
    this.focusRadius = halfH + 0.6;

    const dist = THREE.MathUtils.clamp(opts.dist ?? halfH / Math.tan(16 * DEG), 2, 12);
    const fov = opts.fov ?? THREE.MathUtils.clamp(2 * Math.atan(halfH / dist) / DEG, 22, 46);

    // Orbit from the audience side, biased around the fallen fighter's front.
    const yaw = (opts.yaw ?? 0.55) * (loser?.facing ?? 1) + this._orbit * 0.17;
    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + (opts.height ?? 0.75),
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    this.#composeSubject(outPos, outLook, loser, fov);
    return fov;
  }

  /** Super: a fast whip-pan onto the attacker, then a hard push-in. */
  #framingSuper(outPos, outLook) {
    const opts = this.modeOpts;
    const attacker = opts.target ?? this.fighters[0];
    const floor = this.floorY;
    const p = this.#targetPosition(attacker, _pt);

    const top = this.#subjectTop(attacker) + 0.28;
    const bottom = (p ? p.y : floor) - 0.36;
    _focus.set(p ? p.x : 0, (top + bottom) * 0.5, p ? p.z : 0);

    const halfH = (top - bottom) * 0.5;
    this.focusRadius = halfH + 0.5;

    // Whip in the first 20 ticks, push in over the next 60, then hold.
    const whip = THREE.MathUtils.clamp(this.modeTicks / 20, 0, 1);
    const whipEase = 1 - Math.pow(1 - whip, 3);
    const push = THREE.MathUtils.clamp((this.modeTicks - 14) / 62, 0, 1);
    const pushEase = push * push * (3 - 2 * push);

    // The lens is pinned to its end state while the distance animates, so the
    // attacker genuinely grows in frame instead of holding a constant size.
    const endDist = THREE.MathUtils.clamp(opts.dist ?? halfH / Math.tan(17 * DEG), 1.8, 12);
    const endFov = opts.fov ?? THREE.MathUtils.clamp(2 * Math.atan(halfH / endDist) / DEG, 24, 44);
    const dist = THREE.MathUtils.lerp(endDist * 2.6, endDist, pushEase);

    const facing = attacker?.facing ?? 1;
    const endYaw = (opts.yaw ?? 0.34) * facing;
    const yaw = THREE.MathUtils.lerp(endYaw - 1.6 * facing, endYaw, whipEase);
    const endHeight = floor + (opts.height ?? _focus.y - floor + 0.15);

    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      THREE.MathUtils.lerp(endHeight + 1.3, endHeight, pushEase),
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return THREE.MathUtils.lerp(endFov + 12, endFov, pushEase);
  }

  /** Replay: a patient orbit around the pair. */
  #framingReplay(outPos, outLook) {
    const opts = this.modeOpts;
    const m = this.#pairMetrics();
    const floor = this.floorY;

    const top = m.top + 0.45;
    const bottom = m.bottom - 0.32;
    _focus.set(m.x, (top + bottom) * 0.5, m.z);

    const halfH = (top - bottom) * 0.5;
    this.focusRadius = Math.max(halfH, m.sep * 0.5) + 0.8;

    const fov = opts.fov ?? 34;
    const yaw = (opts.yaw ?? -0.5) + this._orbit * 0.22;
    const dist = Math.max(opts.dist ?? 6.4, this.#fitDistance(_focus, fov, halfH, 0.5, yaw));
    outPos.set(
      _focus.x + Math.sin(yaw) * dist,
      floor + (opts.height ?? _focus.y - floor + 0.9),
      _focus.z + Math.cos(yaw) * dist,
    );
    outLook.copy(_focus);
    return fov;
  }

  // -- framing solver -------------------------------------------------------

  /**
   * Midpoint, separation and vertical silhouette extent of the pair, led very
   * slightly along their shared motion so the camera is never behind the
   * action. Written into a reused record; valid until the next call.
   */
  #pairMetrics() {
    const [a, b] = this.fighters;
    const floor = this.floorY;
    const m = this._pair;

    if (!a?.position || !b?.position) {
      m.x = 0; m.z = 0; m.sep = 2.4;
      m.top = floor + FIGHTER_HEIGHT; m.bottom = floor;
      return m;
    }

    m.x = (a.position.x + b.position.x) * 0.5;
    m.z = (a.position.z + b.position.z) * 0.5;
    if (a.velocity && b.velocity) {
      m.x += THREE.MathUtils.clamp((a.velocity.x + b.velocity.x) * 0.065, -1.2, 1.2);
      m.z += THREE.MathUtils.clamp((a.velocity.z + b.velocity.z) * 0.065, -1.2, 1.2);
    }

    m.sep = Math.min(
      Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z),
      MAX_PAIR_DISTANCE,
    );
    m.top = Math.max(this.#silhouetteTop(a), this.#silhouetteTop(b));
    m.bottom = Math.min(a.position.y, b.position.y, floor);
    return m;
  }

  /**
   * World Y of the top of a fighter's silhouette. Robots are built from the
   * shared skeleton scaled by their `proportions.height`, so a fixed constant
   * crops the tall chassis by a good fifteen centimetres — which is exactly the
   * kind of error that reads as "the camera cut his head off".
   *
   * @param {object} fighter
   * @returns {number}
   */
  #silhouetteTop(fighter) {
    const scale = fighter?.def?.proportions?.height ?? 1;
    const base = fighter?.position ? fighter.position.y : this.floorY;
    return base + FIGHTER_HEIGHT * scale + 0.08;
  }

  /**
   * Top of a fighter's silhouette *in its current pose*, from the crown bone.
   *
   * The pair framing deliberately uses the standing height instead — a camera
   * that breathes with the idle animation is a camera you notice. A single
   * subject is different: a crouched fighter framed against its standing height
   * ends up as a small shape in the bottom of an empty frame. The floor at four
   * fifths of standing height stops the same adaptivity from diving at a
   * knocked-down fighter and turning a portrait into a shot of the ground.
   *
   * @param {object} fighter
   * @returns {number}
   */
  /**
   * World position of a cinematic `target`, which callers pass either as a
   * fighter or as a bare point (the roster lineup has no fighter to aim at).
   * @returns {THREE.Vector3|null} `out`, or null when the target is unusable
   */
  #targetPosition(target, out) {
    if (!target) return null;
    if (target.isVector3) return out.copy(target);
    if (target.position) return out.copy(target.position);
    return null;
  }

  #subjectTop(fighter) {
    const scale = fighter?.def?.proportions?.height ?? 1;
    const base = fighter?.position ? fighter.position.y : this.floorY;
    this.#bonePosition(fighter, 'headTop', _v2);
    return Math.max(_v2.y + 0.16, base + FIGHTER_HEIGHT * scale * 0.8);
  }

  /**
   * Smallest distance from the focus point that keeps every fighter inside the
   * frustum, solved per fighter against both frustum angles.
   *
   * Solving per axis rather than against one bounding sphere matters: the pair
   * is spread along X and barely at all along Y, and a sphere fit would let the
   * narrow vertical angle dictate a distance a third too far. Fighters nearer
   * the camera than the focus plane are given their depth back, so a sidestep
   * toward the lens cannot clip anybody either.
   *
   * @param {THREE.Vector3} focus composition point the box is centred on
   * @param {number} fovDeg vertical field of view being considered
   * @param {number} halfHeight half the composition box height, about `focus`
   * @param {number} sideMargin clear air demanded outboard of each silhouette
   * @param {number} yaw azimuth the camera will sit at, radians from +Z
   * @returns {number} required distance in metres
   */
  #fitDistance(focus, fovDeg, halfHeight, sideMargin, yaw = 0) {
    const vTan = Math.tan(fovDeg * DEG * 0.5);
    const hTan = vTan * (this.camera?.aspect || 16 / 9);
    const sy = Math.sin(yaw);
    const cy = Math.cos(yaw);

    let need = halfHeight / vTan;
    for (const f of this.fighters) {
      const p = f?.position;
      if (!p) continue;
      const dx = p.x - focus.x;
      const dz = p.z - focus.z;
      const lateral = Math.abs(dx * cy - dz * sy) + BODY_HALF_WIDTH + sideMargin;
      const depth = Math.max(0, dx * sy + dz * cy);
      need = Math.max(need, lateral / hTan + depth, halfHeight / vTan + depth);
    }
    return need;
  }

  /**
   * Last line of defence for the pair framings, applied to the transform that
   * is about to be handed to the renderer.
   *
   * The desired framing is always solvable, but three things happen between
   * solving it and drawing it: the springs deliberately lag, `Game` stops
   * ticking the simulation entirely during hitstop — exactly when a launcher
   * has just thrown a body across the arena — and shake displaces the result.
   * Re-solving the fit against the final position, after shake, turns the
   * containment promise into something no other stage of the pipeline can
   * break. It asks only for bare clearance rather than the full composition, so
   * it stays silent unless the alternative was a cropped fighter.
   */
  #enforceFraming(pos, look, fovDeg) {
    _v.copy(pos).sub(look);
    const dist = _v.length();
    if (dist < 1e-3) return;

    let halfH = 0;
    for (const f of this.fighters) {
      const p = f?.position;
      if (!p) continue;
      halfH = Math.max(halfH, this.#silhouetteTop(f) + 0.14 - look.y, look.y - p.y + 0.18);
    }

    const need = this.#fitDistance(look, fovDeg, halfH, 0.26, Math.atan2(_v.x, _v.z));
    if (need > dist) pos.copy(look).addScaledVector(_v.divideScalar(dist), need);
  }

  /**
   * Extra margin, in metres, that the current trauma envelope could displace a
   * silhouette by once `render()` applies shake. Reserving it up front is what
   * makes "shake never pushes a fighter out of frame" a property of the solve
   * rather than a hope.
   */
  #shakeMargin() {
    const k = this._traumaEnvelope * this._traumaEnvelope;
    if (k < 1e-4) return { side: 0, vert: 0 };
    const swing = this._fitDistance * SHAKE.swing * k;
    const tilt = SHAKE.roll * k * this._fitHalfHeight;
    return {
      side: SHAKE.lateral * k + swing + tilt,
      vert: SHAKE.vertical * k + swing + tilt,
    };
  }

  /**
   * Slides a single-subject framing so the subject sits on the far side of the
   * frame from whoever else is in shot.
   *
   * Both robots stand on the axis the subject faces, so a three-quarter
   * portrait cannot exclude the opponent: panning is a pure rotation and moves
   * both of them together. What it *can* decide is who owns which half of the
   * frame. Composing the subject away from the intruder separates the two
   * silhouettes instead of stacking them, which is the whole point of the shot.
   */
  #composeSubject(pos, look, subject, fovDeg) {
    _fwd.copy(look).sub(pos);
    const d = _fwd.length();
    if (d < 1e-4) return;
    _fwd.divideScalar(d);
    _right.crossVectors(_fwd, _upAxis);
    if (_right.lengthSq() < 1e-6) return;
    _right.normalize();

    const hTan = Math.tan(fovDeg * DEG * 0.5) * (this.camera?.aspect || 16 / 9);
    let side = 0;
    for (const f of this.fighters) {
      if (!f || f === subject || !f.position) continue;
      _v2.set(f.position.x, f.position.y + 0.9, f.position.z).sub(pos);
      const along = _v2.dot(_fwd);
      if (along <= 0.25) continue;
      const lateral = _v2.dot(_right);
      if ((Math.abs(lateral) - BODY_HALF_WIDTH) / along >= hTan) continue; // out of shot anyway
      side = Math.sign(lateral) || 1;
    }
    if (side === 0) return;
    look.addScaledVector(_right, side * hTan * d * 0.24);
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Keeps the camera out of the floor, off the fighters, and inside a sane box
   * around the stage. The arena bounds are combat walls, so the camera is
   * allowed outside them on its own side — it just may not sink or swing wide
   * enough to show the void.
   */
  #clampCamera(pos, look) {
    const floor = this.floorY;
    const b = this.bounds;
    pos.y = Math.max(pos.y, floor + 0.45);
    pos.x = THREE.MathUtils.clamp(pos.x, -(b.halfWidth + 3.5), b.halfWidth + 3.5);
    pos.z = THREE.MathUtils.clamp(pos.z, -(b.halfDepth + 4.5), b.halfDepth + 14);

    // Never let the lens pass through a body. Fighters are capsules, so the
    // test is radial about their vertical axis over the height they occupy.
    for (const f of this.fighters) {
      const p = f?.position;
      if (!p) continue;
      const axisY = THREE.MathUtils.clamp(pos.y, p.y + 0.25, this.#silhouetteTop(f) - 0.2);
      _v.set(p.x, axisY, p.z);
      const d = pos.distanceTo(_v);
      const minD = BODY_HALF_WIDTH + 0.12;
      if (d < minD && d > 1e-4) {
        _v2.copy(pos).sub(_v).divideScalar(d);
        pos.copy(_v).addScaledVector(_v2, minD);
        pos.y = Math.max(pos.y, floor + 0.45);
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
   * The named bone on a fighter, or null. Fighter modules expose their rig in
   * several shapes depending on how they were assembled, so every known shape
   * is probed.
   */
  #bone(fighter, name) {
    if (!fighter) return null;
    return (
      fighter.boneByName?.[name] ??
      fighter.byName?.[name] ??
      fighter.bonesByName?.[name] ??
      fighter.skeletonBundle?.byName?.[name] ??
      fighter.skeleton?.byName?.[name] ??
      fighter.rig?.byName?.[name] ??
      (Array.isArray(fighter.bones) ? fighter.bones.find((b) => b?.name === name) : null) ??
      fighter.group?.getObjectByName?.(name) ??
      null
    );
  }

  /**
   * World position of a named bone, falling back to a rest-pose height when the
   * rig cannot be reached.
   */
  #bonePosition(fighter, name, out) {
    const bone = this.#bone(fighter, name);
    if (bone?.matrixWorld) {
      bone.updateWorldMatrix?.(true, false);
      out.setFromMatrixPosition(bone.matrixWorld);
      if (Number.isFinite(out.x)) return out;
    }

    const p = fighter?.position;
    const scale = fighter?.def?.proportions?.height ?? 1;
    const h = (BONE_HEIGHT[name] ?? 1.4) * scale;
    if (p) out.set(p.x, p.y + h, p.z);
    else out.set(0, this.floorY + h, 0);
    return out;
  }

  /**
   * Visual centre of a named bone: the midpoint between its joint and its first
   * child joint.
   *
   * A joint sits at the *base* of the part it drives — the head bone is level
   * with the jaw, not the middle of the skull — so aiming a tight lens straight
   * at it puts the subject's chin on the centre line and fills the frame with
   * whatever is below. Splitting the difference with the child joint centres
   * the part itself, for any bone, with no per-bone table.
   */
  #boneCentre(fighter, name, out) {
    this.#bonePosition(fighter, name, out);
    const bone = this.#bone(fighter, name);
    const child = bone?.children?.find?.((c) => c?.isBone);
    if (!child) return out;
    _v2.setFromMatrixPosition(child.matrixWorld);
    if (Number.isFinite(_v2.x)) out.lerp(_v2, 0.5);
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
