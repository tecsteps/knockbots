/**
 * Knockbots — the pose engine.
 *
 * One Animator drives one skeleton. It is the only thing that writes bone
 * quaternions, and it does so in two clearly separated phases:
 *
 *   simulate(tick)      runs at the fixed 60Hz sim rate, is deterministic, and
 *                       produces one complete Pose per tick.
 *   applyTo(bones, a)   runs at the render rate and writes the bones by slerping
 *                       the last two simulated poses by the interpolation alpha.
 *
 * Keeping those apart is what makes the game look smooth at 144Hz while the
 * frame data stays exactly Tekken-accurate at 60Hz, and it means a rollback can
 * re-run simulate() without touching the scene graph.
 *
 * The pose pipeline, in order, every tick:
 *
 *   1. advance every playing clip entry, retire finished ones
 *   2. compose clip LAYERS: base + masked override layers + additive layers
 *   3. forward kinematics pass A (world transforms of the clip pose)
 *   4. procedural additive stack: breathing, look-at, secondary-motion springs,
 *      impact recoil ripple, then user layers from addProceduralLayer()
 *   5. forward kinematics pass B (world transforms of the procedural pose)
 *   6. two-bone IK: explicit targets and foot planting, written back as local
 *      deltas so the result survives into the pose snapshot
 *   7. swap the pose snapshots
 *
 * Everything is expressed as a *delta from the rest pose*, exactly like the clip
 * format, so `bone.quaternion = restQuat * poseDelta`. Nothing in here ever
 * reads a bone's current quaternion, which is why retriggering a clip mid-play,
 * crossfading three clips at once, or blending IK in and out cannot drift.
 *
 * An entry keeps two clocks. `clock` is the caller's — a move's frame counter —
 * and `time` is where that lands inside the clip. With no retime the two are the
 * same. With one, the clip's authored contact tick is pinned onto the frame the
 * caller needs it on and the wind-up and the recovery are stretched separately,
 * so a clip lands its blow on the right frame AND still finishes when the move
 * does. Everything downstream reads `time`, so root motion, blending and clip
 * end detection all follow the retime for free.
 *
 * Root motion is extracted, not applied: horizontal translation and yaw are
 * accumulated into a delta that Fighter drains with consumeRootMotion() and
 * feeds to the physical body. Vertical root motion stays visual by default,
 * because height is owned by the physics integrator. Alongside the delta the
 * animator publishes `rootYawDrive`, the share of the base layer that is
 * actually authoring yaw this tick, so the consumer can tell "the clip is
 * mid-spin" from "the clip has let go and the residual should unwind".
 */

import * as THREE from 'three';
import { BONES, BONE_NAMES, IK_CHAINS } from './Skeleton.js';
import { Pose, sampleClip, EASE } from './AnimationFormat.js';
import { TICK_DT } from '../core/Constants.js';

const DEG = Math.PI / 180;

/** Bone-name groups that are useful as layer masks. */
export const BONE_GROUPS = {
  upperBody: [
    'spine01', 'spine02', 'chest', 'neck', 'head', 'headTop',
    'clavicle_L', 'shoulder_L', 'elbow_L', 'wrist_L', 'hand_L', 'fingers_L', 'thumb_L',
    'clavicle_R', 'shoulder_R', 'elbow_R', 'wrist_R', 'hand_R', 'fingers_R', 'thumb_R',
  ],
  lowerBody: [
    'hips',
    'hip_L', 'knee_L', 'ankle_L', 'foot_L', 'toe_L',
    'hip_R', 'knee_R', 'ankle_R', 'foot_R', 'toe_R',
  ],
  armL: ['clavicle_L', 'shoulder_L', 'elbow_L', 'wrist_L', 'hand_L', 'fingers_L', 'thumb_L'],
  armR: ['clavicle_R', 'shoulder_R', 'elbow_R', 'wrist_R', 'hand_R', 'fingers_R', 'thumb_R'],
  spine: ['hips', 'spine01', 'spine02', 'chest'],
  headOnly: ['neck', 'head', 'headTop'],
};

/**
 * Bones that carry a secondary-motion spring. Order matters: the impact ripple
 * walks this list outward from the struck region.
 */
const SPRING_DEFAULTS = {
  hips:       { k: 190, c: 21, driveRot: 0.20, driveAcc: 0.06, limit: 0.12 },
  spine01:    { k: 175, c: 20, driveRot: 0.26, driveAcc: 0.09, limit: 0.15 },
  spine02:    { k: 160, c: 19, driveRot: 0.32, driveAcc: 0.12, limit: 0.18 },
  chest:      { k: 150, c: 18, driveRot: 0.38, driveAcc: 0.16, limit: 0.21 },
  clavicle_L: { k: 210, c: 22, driveRot: 0.28, driveAcc: 0.08, limit: 0.15 },
  clavicle_R: { k: 210, c: 22, driveRot: 0.28, driveAcc: 0.08, limit: 0.15 },
  neck:       { k: 135, c: 15, driveRot: 0.50, driveAcc: 0.20, limit: 0.24 },
  head:       { k: 118, c: 13, driveRot: 0.62, driveAcc: 0.25, limit: 0.30 },
};

/** How an impact propagates: [boneName, delayTicks, gain] per struck region. */
const RIPPLE = {
  head: [['head', 0, 1.0], ['neck', 1, 0.85], ['chest', 2, 0.5], ['clavicle_L', 3, 0.3], ['clavicle_R', 3, 0.3], ['spine02', 3, 0.34], ['spine01', 4, 0.22], ['hips', 5, 0.14]],
  torso: [['chest', 0, 1.0], ['spine02', 1, 0.8], ['neck', 1, 0.7], ['spine01', 2, 0.58], ['head', 2, 0.62], ['clavicle_L', 2, 0.45], ['clavicle_R', 2, 0.45], ['hips', 3, 0.34]],
  arm: [['clavicle_L', 0, 0.9], ['clavicle_R', 0, 0.9], ['chest', 1, 0.66], ['spine02', 2, 0.44], ['neck', 2, 0.4], ['head', 3, 0.36], ['spine01', 3, 0.28], ['hips', 4, 0.18]],
  leg: [['hips', 0, 1.0], ['spine01', 1, 0.7], ['spine02', 2, 0.5], ['chest', 3, 0.38], ['neck', 4, 0.3], ['head', 5, 0.28]],
};

/** Bones whose per-tick delta feeds the "how busy is the body" estimate. */
const ENERGY_BONES = ['chest', 'head', 'shoulder_L', 'shoulder_R', 'hip_L', 'hip_R'];

/**
 * Ceiling on the inertialization offset's opening rate, as a multiple of
 * `x0 / t1`. The quintic bulges past its start value when the offset is still
 * growing — which is follow-through and wanted — but the bulge is 1.27x at 2
 * and 1.64x at 4, so it is capped where a fast retraction still reads as
 * carry-through rather than as a lurch.
 */
const INERTIA_RISE_CAP = 2.5;

/** Offsets under this many radians are not worth arming (~0.023 degrees). */
const INERTIA_EPS = 4e-4;

// --- scratch, module-level so simulate() allocates nothing -------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e0 = new THREE.Euler();
const _AXIS_Y = new THREE.Vector3(0, 1, 0);
const _AXIS_X = new THREE.Vector3(1, 0, 0);
const _BONE_AXIS = new THREE.Vector3(0, -1, 0); // every chain points down its local -Y
const IDENTITY = new THREE.Quaternion();

/** Deterministic integer hash in [0,1). Never uses Math.random or Math.sin. */
function hash1(n) {
  let h = n | 0;
  h = (h ^ 61) ^ (h >>> 16);
  h = (h + (h << 3)) | 0;
  h ^= h >>> 4;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise, C1 continuous, deterministic. */
function noise1(x, seed = 0) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i * 374761393 + seed * 668265263);
  const b = hash1((i + 1) * 374761393 + seed * 668265263);
  return (a + (b - a) * u) * 2 - 1;
}

/** Rotation vector (axis * angle) of a unit quaternion, shortest arc. */
function quatToVec(q, out) {
  let x = q.x, y = q.y, z = q.z, w = q.w;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-7) return out.set(x * 2, y * 2, z * 2);
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return out.set(x * k, y * k, z * k);
}

/** Inverse of quatToVec. */
function vecToQuat(v, out) {
  const len = v.length();
  if (len < 1e-8) return out.set(0, 0, 0, 1);
  return out.setFromAxisAngle(_v4.copy(v).divideScalar(len), len);
}

/** Post-multiply an additive delta onto a pose bone, scaled by weight. */
function addQuat(pose, bone, q, weight) {
  if (weight <= 0 || !(bone in pose.rot)) return;
  _q3.set(0, 0, 0, 1).slerp(q, Math.min(1, weight));
  pose.rot[bone].multiply(_q3);
}

/** Post-multiply an additive XYZ-Euler (radians) onto a pose bone. */
function addEuler(pose, bone, x, y, z, weight) {
  if (weight <= 0 || !(bone in pose.rot)) return;
  _e0.set(x, y, z, 'XYZ');
  _q2.setFromEuler(_e0);
  addQuat(pose, bone, _q2, weight);
}

/**
 * A damped second-order spring on a rotation vector (axis * angle).
 *
 * Two ways in: a continuous `drive` acceleration, used for the lag that a bone
 * shows while its parent is turning, and a `kick` velocity impulse, used for
 * the discrete recoil of an impact. Steady-state displacement under a constant
 * drive is `drive / k`, and the peak after an impulse is about `0.37 * dv / w`
 * with `w = sqrt(k)`, which is how the tables above were tuned.
 */
class Spring3 {
  constructor(p) {
    this.x = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.k = p.k; this.c = p.c;
    this.driveRot = p.driveRot; this.driveAcc = p.driveAcc;
    this.limit = p.limit;
  }

  /** Velocity impulse — impacts. */
  kick(vec, scale) {
    this.v.addScaledVector(vec, scale);
  }

  /**
   * Semi-implicit Euler, sub-stepped so a stiff spring stays stable at 60Hz.
   * @param {number} dt
   * @param {THREE.Vector3} [drive] continuous acceleration term
   */
  step(dt, drive = null, substeps = 2) {
    const h = dt / substeps;
    const dx = drive ? drive.x : 0, dy = drive ? drive.y : 0, dz = drive ? drive.z : 0;
    for (let i = 0; i < substeps; i++) {
      this.v.x += (dx - this.k * this.x.x - this.c * this.v.x) * h;
      this.v.y += (dy - this.k * this.x.y - this.c * this.v.y) * h;
      this.v.z += (dz - this.k * this.x.z - this.c * this.v.z) * h;
      this.x.addScaledVector(this.v, h);
    }
    const l2 = this.x.lengthSq();
    if (l2 > this.limit * this.limit) {
      const l = Math.sqrt(l2);
      this.x.multiplyScalar(this.limit / l);
      // Bleed the outward velocity so the spring rests against the clamp
      // instead of buzzing on it.
      const along = this.v.dot(this.x) / (this.limit * this.limit);
      if (along > 0) this.v.addScaledVector(this.x, -along);
    }
  }

  reset() { this.x.set(0, 0, 0); this.v.set(0, 0, 0); }
}

/**
 * Map an entry's own clock onto clip time through two anchored segments.
 *
 * A retime descriptor pins two points — the clip's authored contact tick and its
 * end — onto the ticks the caller needs them to land on, and stretches only the
 * span between them. Inside a segment the mapping is linear, so the shape of
 * every authored easing curve survives; what changes is the length of the
 * wind-up and the length of the recovery, independently. A single global speed
 * multiplier cannot do that: forcing contact onto the right frame with one
 * number necessarily drags the whole recovery with it, which is what leaves a
 * clip finished a third of the way through its move, holding a dead pose.
 * @param {{pivot:number, pivotAt:number, inScale:number, outScale:number}} r
 * @param {number} clock
 */
function retimeClip(r, clock) {
  if (clock <= r.pivotAt) return clock * r.inScale;
  return r.pivot + (clock - r.pivotAt) * r.outScale;
}

/** One playing clip instance inside a layer. */
class Entry {
  constructor(clipId, clip, opts) {
    this.clipId = clipId;
    this.clip = clip;
    /** The entry's own clock, in the caller's ticks. */
    this.clock = opts.offset || 0;
    /** @type {?{pivot:number, pivotAt:number, inScale:number, outScale:number}} */
    this.retime = opts.retime || null;
    this.time = this.retime ? retimeClip(this.retime, this.clock) : this.clock;
    this.speed = opts.speed ?? 1;
    this.loop = opts.loop ?? !!clip.loop;
    this.weight = 0;
    this.fadeFrom = 0;
    this.target = 1;
    this.fadeTicks = 0;
    this.fadeElapsed = 0;
    this.easeFn = opts.easeFn || EASE.sine;
    this.dying = false;
    this.ended = false;
    this.autoBlendOut = !!opts.autoBlendOut;
    this.onEnd = opts.onEnd || null;
    this.rootAbs = new THREE.Vector3();
    this.rootYawAbs = 0;
    this.dPos = new THREE.Vector3();
    this.dYaw = 0;
  }
}

/** A stack of clip entries with a mask, a weight and a blend mode. */
class Layer {
  constructor(name, index) {
    this.name = name;
    this.index = index;
    this.additive = false;
    this.weight = 1;
    this.mask = null;        // Record<boneName, 0..1> or null for "everything"
    this.entries = [];
    this.pose = null;        // allocated lazily for non-base layers
    this.fade = null;        // { from, to, ticks, elapsed }
  }

  maskWeight(bone) {
    if (!this.mask) return 1;
    const w = this.mask[bone];
    return w === undefined ? 0 : w;
  }
}

export class Animator {
  /**
   * @param {{skeleton?:THREE.Skeleton, bones:THREE.Bone[], byName:Record<string,THREE.Bone>}} skeletonBundle
   * @param {Record<string, import('./AnimationFormat.js').Clip>} clipLibrary
   * @param {{seed?:number, floorY?:number}} [options]
   */
  constructor(skeletonBundle, clipLibrary, options = {}) {
    const bundle = Array.isArray(skeletonBundle) ? { bones: skeletonBundle } : (skeletonBundle || {});
    /** @type {THREE.Bone[]} */
    this.bones = bundle.bones || [];
    this.byName = bundle.byName || Object.fromEntries(this.bones.map((b) => [b.name, b]));
    this.skeleton = bundle.skeleton || null;
    this.clips = clipLibrary || {};

    this.names = this.bones.length ? this.bones.map((b) => b.name) : BONE_NAMES.slice();
    this.index = Object.fromEntries(this.names.map((n, i) => [n, i]));
    this.count = this.names.length;

    this.#buildRestPose();
    this.#buildHierarchy();

    // --- pose snapshots -----------------------------------------------------
    this._poseA = new Pose(this.names);
    this._poseB = new Pose(this.names);
    this.prev = this._poseA;
    this.cur = this._poseB;
    /** Root-only sample sink: sampleClip skips bones it cannot find in `rot`. */
    this._rootSink = { rot: Object.create(null), weight: Object.create(null), rootPos: new THREE.Vector3(), rootYaw: 0 };
    this._cycleCache = new WeakMap();

    // --- layers -------------------------------------------------------------
    /** @type {Map<string, Layer>} */
    this.layers = new Map();
    this.base = this.#layer('base');

    // --- inertialization ----------------------------------------------------
    /**
     * A transition is not a crossfade: the incoming clip takes over whole, and
     * what decays is the OFFSET between it and the pose the body was actually
     * in. `pending` is armed by play() and solved against the next composed
     * pose. Everything below is a scalar advanced at the fixed tick rate, so
     * the same inputs replay to the same pose.
     */
    this.inertia = { enabled: true, scale: 1, active: false, pending: 0, t: 0, t1: 0 };
    this._inSrc = Array.from({ length: this.count }, () => new THREE.Quaternion());
    this._inSrcPrev = Array.from({ length: this.count }, () => new THREE.Quaternion());
    this._inAxis = Array.from({ length: this.count }, () => new THREE.Vector3());
    this._inX0 = new Float64Array(this.count);
    this._inV0 = new Float64Array(this.count);
    this._inA = new Float64Array(this.count);
    this._inB = new Float64Array(this.count);
    this._inC = new Float64Array(this.count);
    this._inT1 = new Float64Array(this.count);
    this._inLive = new Uint8Array(this.count);
    this._inPrevPose = new Pose(this.names);

    // --- forward kinematics caches -----------------------------------------
    this.worldQuat = Array.from({ length: this.count }, () => new THREE.Quaternion());
    this.worldPos = Array.from({ length: this.count }, () => new THREE.Vector3());
    this._prevParentQuat = Array.from({ length: this.count }, () => new THREE.Quaternion());
    // The same transforms as they stood before IK ran — see simulate().
    this._preIkQuat = Array.from({ length: this.count }, () => new THREE.Quaternion());
    this._preIkPos = Array.from({ length: this.count }, () => new THREE.Vector3());

    // --- root motion --------------------------------------------------------
    this.rootMotionAxes = { x: true, y: false, z: true, yaw: true };
    this._rootAccum = new THREE.Vector3();
    this._rootYawAccum = 0;
    /** 0..1 share of the base layer authoring root yaw this tick. */
    this.rootYawDrive = 0;
    this._yawClips = new WeakMap();

    // --- IK -----------------------------------------------------------------
    /** @type {Record<string, {target:THREE.Vector3|null, weight:number, current:number, preserveEnd:boolean, space:string}>} */
    this.ik = Object.create(null);
    for (const chain in IK_CHAINS) {
      this.ik[chain] = { target: null, weight: 0, current: 0, preserveEnd: true, space: 'world' };
    }
    // Floor contact is owned by Fighter, which drives the leg chains with its
    // own targets, so the built-in planter is off by default. Turn it on for
    // rigs nobody else is driving: character select, the model viewer, replays.
    this.footPlant = {
      enabled: false,
      floorY: options.floorY ?? 0,
      weight: 1,
      probe: 0.07,      // start pulling when the sole is this close to the floor
      maxLift: 0.22,
      soleClearance: 0.012,
      responsiveness: 0.35,
      _w: { legL: 0, legR: 0 },
    };
    /**
     * Object3D that defines model space. Left null it is resolved lazily from
     * whatever the root bone is parented to — for a Fighter that is the group
     * carrying the body's position and facing, which is exactly the transform
     * needed to bring a world-space IK or look target into the rig's frame.
     */
    this.rootObject = null;
    this._autoRoot = null;
    this._invWorld = new THREE.Matrix4();
    this._hasSpace = false;
    this._spaceTick = -1;
    this._ikTarget = new THREE.Vector3();
    this._springsPrimed = false;

    // --- procedural ---------------------------------------------------------
    this.springs = Object.create(null);
    for (const bone in SPRING_DEFAULTS) {
      if (bone in this.index) this.springs[bone] = new Spring3(SPRING_DEFAULTS[bone]);
    }
    this._ripple = [];       // pending { bone, at, vec:Vector3 }
    this._rippleTick = 0;

    this.look = {
      target: null,
      weight: 0,
      current: 0,
      yaw: 0, pitch: 0,
      yawVel: 0, pitchVel: 0,
      yawLimit: 62 * DEG,
      pitchLimit: 34 * DEG,
      stiffness: 118,
      damping: 20,
      share: { chest: 0.22, neck: 0.3, head: 0.48 },
      space: 'world',
    };

    this.breathing = {
      enabled: true,
      rate: 0.055,           // cycles per tick, ~3.3s per breath
      amplitude: 1,
      /** Scale on the below-the-waist weight shift and the arm micro-drift. */
      stance: 1,
      phase: 0,
      idleness: 1,
      _energy: 0,
    };

    this.secondary = { enabled: true, scale: 1 };
    this.recoil = { enabled: true, scale: 1 };

    this.bodyVelocity = new THREE.Vector3();
    this._prevBodyVelocity = new THREE.Vector3();
    this._bodyAccel = new THREE.Vector3();

    this._proceduralPre = [];
    this._proceduralPost = [];
    this._ctx = {
      animator: this, tick: 0, dt: TICK_DT, pose: this.cur,
      idleness: 1, energy: 0, names: this.names,
      addEuler: (bone, x, y, z, w) => addEuler(this._ctx.pose, bone, x, y, z, w),
      addQuat: (bone, q, w) => addQuat(this._ctx.pose, bone, q, w),
      worldPos: (bone) => this.worldPos[this.index[bone]],
      worldQuat: (bone) => this.worldQuat[this.index[bone]],
    };

    // --- energy tracking ----------------------------------------------------
    this._energyBones = ENERGY_BONES.filter((n) => n in this.index);
    this._energyPrev = this._energyBones.map(() => new THREE.Quaternion());

    // --- public read-only state --------------------------------------------
    this.current = null;
    this.time = 0;
    this.finished = true;
    this.tick = 0;

    this._appliedBones = null;
    this._appliedOrder = null;
    this._warned = new Set();
  }

  // =========================================================================
  // Construction helpers
  // =========================================================================

  #buildRestPose() {
    this.restQuat = [];
    this.restQuatInv = [];
    this.restPos = [];
    for (let i = 0; i < this.count; i++) {
      const bone = this.bones[i];
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      if (bone) { q.copy(bone.quaternion); p.copy(bone.position); }
      else {
        const def = BONES.find((b) => b.name === this.names[i]);
        if (def) {
          p.set(def.pos[0], def.pos[1], def.pos[2]);
          if (def.rot) q.setFromEuler(new THREE.Euler(def.rot[0], def.rot[1], def.rot[2], 'XYZ'));
        }
      }
      this.restQuat.push(q);
      this.restQuatInv.push(q.clone().invert());
      this.restPos.push(p);
    }
  }

  #buildHierarchy() {
    this.parent = new Int32Array(this.count).fill(-1);
    for (let i = 0; i < this.count; i++) {
      const bone = this.bones[i];
      let parentName = null;
      if (bone?.userData?.def?.parent) parentName = bone.userData.def.parent;
      else if (bone?.parent && bone.parent.isBone) parentName = bone.parent.name;
      else parentName = BONES.find((b) => b.name === this.names[i])?.parent ?? null;
      if (parentName != null && parentName in this.index) this.parent[i] = this.index[parentName];
    }

    // Topological evaluation order (parents strictly before children).
    const order = [];
    const done = new Uint8Array(this.count);
    let guard = 0;
    while (order.length < this.count && guard++ < this.count + 2) {
      for (let i = 0; i < this.count; i++) {
        if (done[i]) continue;
        const p = this.parent[i];
        if (p === -1 || done[p]) { done[i] = 1; order.push(i); }
      }
    }
    for (let i = 0; i < this.count; i++) if (!done[i]) order.push(i);
    this.order = Int32Array.from(order);
    this.rootIndex = this.index.root ?? this.order[0];
  }

  #layer(name) {
    let l = this.layers.get(name);
    if (!l) {
      l = new Layer(name, this.layers.size);
      this.layers.set(name, l);
      // Map iteration is insertion-ordered, so layers composite in creation
      // order and the result is reproducible tick to tick.
      if (name !== 'base') l.pose = new Pose(this.names);
    }
    return l;
  }

  /**
   * Bring a world-space point into model space, in place. A no-op when the rig
   * is not mounted under anything (standalone previews, unit tests), where the
   * two spaces are the same. The inverse is computed once per tick.
   * @param {THREE.Vector3} v
   */
  #toModel(v) {
    if (this._spaceTick !== this.tick) {
      this._spaceTick = this.tick;
      let obj = this.rootObject;
      if (!obj) {
        const rootBone = this.bones[this.rootIndex];
        const p = rootBone?.parent;
        if (p && p.isObject3D && !p.isBone) this._autoRoot = p;
        obj = this._autoRoot;
      }
      if (obj) {
        obj.updateWorldMatrix(true, false);
        this._invWorld.copy(obj.matrixWorld).invert();
        this._hasSpace = true;
      } else {
        this._hasSpace = false;
      }
    }
    return this._hasSpace ? v.applyMatrix4(this._invWorld) : v;
  }

  #warn(msg) {
    if (this._warned.has(msg)) return;
    this._warned.add(msg);
    console.warn(`[Animator] ${msg}`);
  }

  // =========================================================================
  // Playback API
  // =========================================================================

  /**
   * Start a clip on a layer, crossfading from whatever that layer was playing.
   *
   * Retriggering the same clip pushes a *new* entry and fades the old one out,
   * which is what makes a repeated jab restart cleanly instead of snapping.
   *
   * `inertia` is the better transition and the one to reach for: instead of
   * mixing two poses for a few ticks it hands the layer straight to the new
   * clip and decays the difference, so the body leaves the old pose at the
   * speed it was already moving. A crossfade cannot do that — it blends
   * positions and knows nothing about velocity, which is why even a long one
   * still has a corner in it at both ends.
   *
   * @param {string} clipId
   * @param {Object} [opts]
   * @param {number}  [opts.inertia]   inertialize over this many ticks; replaces
   *   the crossfade entirely (the incoming clip starts at full weight)
   * @param {number}  [opts.blend]     crossfade length in ticks (default clip.blendIn ?? 4)
   * @param {number}  [opts.speed]     playback rate multiplier (default 1)
   * @param {string}  [opts.layer]     layer name (default 'base')
   * @param {boolean} [opts.loop]      override the clip's own loop flag
   * @param {boolean} [opts.additive]  make this layer additive over the ones below
   * @param {string[]|Record<string,number>} [opts.mask]  per-bone mask for this layer
   * @param {string|Function} [opts.ease] crossfade easing name or function
   * @param {number}  [opts.offset]    start time in ticks
   * @param {boolean} [opts.restart]   if false and this clip is already the top
   *                                   entry, do nothing (default true)
   * @param {boolean} [opts.autoBlendOut] fade the entry out when it ends
   * @param {Function}[opts.onEnd]     called once when a non-looping clip ends
   * @param {{pivot:number,pivotAt:number,inScale:number,outScale:number}} [opts.retime]
   *   two-anchor time map: play the clip so its `pivot` tick falls on the
   *   caller's `pivotAt`, at `inScale` before it and `outScale` after
   * @returns {Entry|null}
   */
  play(clipId, opts = {}) {
    const clip = this.clips[clipId];
    if (!clip) { this.#warn(`unknown clip "${clipId}"`); return null; }

    const layer = this.#layer(opts.layer ?? 'base');
    const isBase = layer === this.base;

    if (opts.additive !== undefined) layer.additive = !!opts.additive;
    if (opts.mask !== undefined) this.setLayerMask(layer.name, opts.mask);
    else if (!isBase && !layer.mask && clip.mask) this.setLayerMask(layer.name, clip.mask);

    const top = layer.entries.length ? layer.entries[layer.entries.length - 1] : null;
    if (opts.restart === false && top && !top.dying && top.clipId === clipId) return top;

    const easeFn = typeof opts.ease === 'function' ? opts.ease : (EASE[opts.ease] || EASE.sine);
    // An inertialized transition owns the whole cut, so the crossfade that
    // would otherwise run underneath it is turned off rather than layered on.
    const inertiaTicks = this.inertia.enabled ? Math.max(0, opts.inertia ?? 0) : 0;
    const armed = inertiaTicks > 0 && this.#armInertia(inertiaTicks);
    const blend = armed ? 0 : Math.max(0, opts.blend ?? clip.blendIn ?? 4);

    // A retrigger inside the same tick reuses the entry rather than stacking.
    if (top && !top.dying && top.clipId === clipId && top.fadeElapsed === 0 && top.weight <= 0) {
      top.retime = opts.retime || null;
      top.clock = opts.offset || 0;
      top.time = top.retime ? retimeClip(top.retime, top.clock) : top.clock;
      top.speed = opts.speed ?? top.speed;
      this.#primeRoot(top);
      return top;
    }

    const entry = new Entry(clipId, clip, {
      speed: opts.speed,
      loop: opts.loop,
      offset: opts.offset,
      retime: opts.retime,
      easeFn,
      autoBlendOut: opts.autoBlendOut ?? !isBase,
      onEnd: opts.onEnd,
    });
    this.#primeRoot(entry);

    if (blend === 0) {
      layer.entries.length = 0;
      entry.weight = 1;
      entry.fadeFrom = 1;
      entry.fadeTicks = 0;
      entry.fadeElapsed = 1;
    } else {
      for (const e of layer.entries) {
        e.dying = true;
        e.fadeFrom = e.weight;
        e.target = 0;
        e.fadeTicks = blend;
        e.fadeElapsed = 0;
        e.easeFn = easeFn;
      }
      entry.weight = 0;
      entry.fadeFrom = 0;
      entry.target = 1;
      entry.fadeTicks = blend;
      entry.fadeElapsed = 0;
    }

    layer.entries.push(entry);
    this.#trimEntries(layer);

    if (isBase) {
      this.current = clipId;
      this.time = entry.time;
      this.finished = false;
    }
    return entry;
  }

  /**
   * Crossfade the base layer to a clip over `ticks`.
   * @param {string} clipId
   * @param {number} ticks
   */
  crossfade(clipId, ticks = 8, opts = {}) {
    return this.play(clipId, { ...opts, blend: ticks });
  }

  /** Play only if that clip is not already the top entry of the layer. */
  playIfNot(clipId, opts = {}) {
    return this.play(clipId, { ...opts, restart: false });
  }

  /**
   * Fade a layer out and clear it.
   * @param {string} [layerName]
   * @param {number} [ticks]
   */
  stop(layerName = 'base', ticks = 6) {
    const layer = this.layers.get(layerName);
    if (!layer) return;
    if (ticks <= 0) { layer.entries.length = 0; return; }
    for (const e of layer.entries) {
      if (e.dying) continue;
      e.dying = true;
      e.fadeFrom = e.weight;
      e.target = 0;
      e.fadeTicks = ticks;
      e.fadeElapsed = 0;
    }
  }

  /** Fade a whole layer's contribution without stopping playback. */
  setLayerWeight(layerName, weight, ticks = 0) {
    const layer = this.#layer(layerName);
    if (ticks <= 0) { layer.weight = THREE.MathUtils.clamp(weight, 0, 1); layer.fade = null; return; }
    layer.fade = { from: layer.weight, to: THREE.MathUtils.clamp(weight, 0, 1), ticks, elapsed: 0 };
  }

  /**
   * Set a layer's bone mask.
   * @param {string} layerName
   * @param {string[]|Record<string,number>|null} mask array of bone names, or
   *   a bone->weight record for feathered masks, or null for "all bones".
   */
  setLayerMask(layerName, mask) {
    const layer = this.#layer(layerName);
    if (!mask) { layer.mask = null; return; }
    const table = Object.create(null);
    if (Array.isArray(mask)) for (const n of mask) table[n] = 1;
    else for (const n in mask) table[n] = THREE.MathUtils.clamp(mask[n], 0, 1);
    layer.mask = table;
  }

  /** Mark a layer additive (its pose multiplies onto the layers below). */
  setLayerAdditive(layerName, additive = true) {
    this.#layer(layerName).additive = !!additive;
  }

  /** Playback speed of the top entry on a layer. */
  setSpeed(speed, layerName = 'base') {
    const layer = this.layers.get(layerName);
    const top = layer?.entries[layer.entries.length - 1];
    if (top) top.speed = speed;
  }

  /**
   * Jump the top entry of a layer to an exact tick of the CALLER's clock, which
   * is the move's frame counter when a retime is in force and clip time
   * otherwise. Used by move syncing.
   */
  setTime(t, layerName = 'base') {
    const layer = this.layers.get(layerName);
    const top = layer?.entries[layer.entries.length - 1];
    if (!top) return;
    top.clock = t;
    top.time = top.retime ? retimeClip(top.retime, top.clock) : top.clock;
    this.#primeRoot(top);
    if (layer === this.base) this.time = top.time;
  }

  /** True if a clip is currently contributing to a layer. */
  isPlaying(clipId, layerName = 'base') {
    const layer = this.layers.get(layerName);
    if (!layer) return false;
    for (const e of layer.entries) if (e.clipId === clipId && e.weight > 0.001) return true;
    return false;
  }

  /**
   * Snapshot the pose the body is actually in, and the one before it, so the
   * next composed pose can be met with an offset that starts where the body was
   * AND is moving the way the body was moving. `cur` and `prev` are already one
   * tick apart, so the outgoing angular velocity costs nothing to obtain.
   *
   * Re-arming mid-decay is safe and is the common case — a cancel into another
   * move — because the offset is written into `cur`, so the snapshot is the
   * pose on screen rather than the clip's idea of it.
   * @param {number} ticks
   */
  #armInertia(ticks) {
    const dur = ticks * this.inertia.scale;
    if (!(dur > 0)) return false;
    for (let i = 0; i < this.count; i++) {
      const n = this.names[i];
      this._inSrc[i].copy(this.cur.rot[n]);
      this._inSrcPrev[i].copy(this.prev.rot[n]);
    }
    this.inertia.pending = dur;
    return true;
  }

  #trimEntries(layer) {
    const MAX = 4;
    while (layer.entries.length > MAX) {
      let worst = 0;
      for (let i = 1; i < layer.entries.length - 1; i++) {
        if (layer.entries[i].weight < layer.entries[worst].weight) worst = i;
      }
      layer.entries.splice(worst, 1);
    }
  }

  // =========================================================================
  // Root motion
  // =========================================================================

  /**
   * Root displacement contributed by one full cycle of a looping clip.
   * Sampled through a non-looping view of the clip, because sampleClip wraps
   * `t == duration` back to 0 and would report a zero-length cycle.
   */
  #cycleOf(clip) {
    let c = this._cycleCache.get(clip);
    if (c) return c;
    const a = new THREE.Vector3(); let ay = 0;
    const b = new THREE.Vector3(); let by = 0;
    if (clip.root && clip.root.length) {
      const linear = { ...clip, loop: false };
      this.#sampleRootAt(linear, 0, a); ay = this._rootSink.rootYaw;
      this.#sampleRootAt(linear, clip.duration, b); by = this._rootSink.rootYaw;
    }
    c = { pos: b.sub(a), yaw: by - ay };
    this._cycleCache.set(clip, c);
    return c;
  }

  /** Samples only the root track of a clip at a raw (unwrapped) time. */
  #sampleRootAt(clip, t, out) {
    const sink = this._rootSink;
    sink.rootPos.set(0, 0, 0);
    sink.rootYaw = 0;
    if (clip.root && clip.root.length) sampleClip(clip, t, sink, 1);
    return out ? out.copy(sink.rootPos) : sink.rootPos;
  }

  /**
   * Absolute root offset of an entry at time `t`, unwrapped across loops so the
   * per-tick delta is continuous even as the clip wraps.
   */
  #rootAbs(clip, t, out) {
    if (!clip.root || !clip.root.length) { out.set(0, 0, 0); return 0; }
    if (clip.loop && clip.duration > 0) {
      const n = Math.floor(t / clip.duration);
      const tw = t - n * clip.duration;
      this.#sampleRootAt(clip, tw, out);
      const yaw = this._rootSink.rootYaw;
      if (n !== 0) {
        const cyc = this.#cycleOf(clip);
        out.addScaledVector(cyc.pos, n);
        return yaw + cyc.yaw * n;
      }
      return yaw;
    }
    this.#sampleRootAt(clip, Math.min(t, clip.duration), out);
    return this._rootSink.rootYaw;
  }

  #primeRoot(entry) {
    entry.rootYawAbs = this.#rootAbs(entry.clip, entry.time, entry.rootAbs);
  }

  /**
   * Does this clip's root track author any yaw at all? A property of the data,
   * so it is answered once and cached; it is asked for every entry every tick.
   */
  #authorsYaw(clip) {
    let v = this._yawClips.get(clip);
    if (v === undefined) {
      v = !!(clip.root && clip.root.some((k) => k.ry));
      this._yawClips.set(clip, v);
    }
    return v;
  }

  /**
   * Drain the root-motion delta accumulated since the last call.
   * The vector is in the fighter's LOCAL space using the clip convention from
   * AnimationFormat: -Z is forward, +X is the fighter's left, +Y is up. Fighter
   * rotates it by `facing` before adding it to the physical position.
   * @returns {{x:number, y:number, z:number, yaw:number}}
   */
  consumeRootMotion() {
    const out = { x: this._rootAccum.x, y: this._rootAccum.y, z: this._rootAccum.z, yaw: this._rootYawAccum };
    this._rootAccum.set(0, 0, 0);
    this._rootYawAccum = 0;
    return out;
  }

  /** Discard pending root motion without applying it (used on reset/teleport). */
  clearRootMotion() {
    this._rootAccum.set(0, 0, 0);
    this._rootYawAccum = 0;
    this.rootYawDrive = 0;
  }

  // =========================================================================
  // IK / look-at / impacts — external control
  // =========================================================================

  /**
   * Point an IK chain at a target.
   * @param {string} chain  key of Skeleton.IK_CHAINS: armL|armR|legL|legR
   * @param {THREE.Vector3|null} target target position; null releases the chain
   * @param {number} weight 0..1
   * @param {{space?:'model'|'world', preserveEnd?:boolean}} [opts] targets are
   *   world space by default; pass `space: 'model'` for rig-local coordinates
   */
  setIkTarget(chain, target, weight = 1, opts = {}) {
    const slot = this.ik[chain];
    if (!slot) { this.#warn(`unknown IK chain "${chain}"`); return; }
    if (!target) { slot.target = null; slot.weight = 0; return; }
    if (!slot.target) slot.target = new THREE.Vector3();
    slot.target.copy(target);
    slot.weight = THREE.MathUtils.clamp(weight, 0, 1);
    if (opts.space) slot.space = opts.space;
    if (opts.preserveEnd !== undefined) slot.preserveEnd = !!opts.preserveEnd;
  }

  /**
   * Look-at target for head/chest, applied additively over whatever is playing.
   * @param {THREE.Vector3|null} target world space unless `opts.space` says otherwise
   * @param {number} weight
   * @param {{space?:'model'|'world'}} [opts]
   */
  setLookTarget(target, weight = 1, opts = {}) {
    if (!target) { this.look.target = null; this.look.weight = 0; return; }
    if (!this.look.target) this.look.target = new THREE.Vector3();
    this.look.target.copy(target);
    this.look.weight = THREE.MathUtils.clamp(weight, 0, 1);
    if (opts.space) this.look.space = opts.space;
  }

  /**
   * Model-space height of a point fixed in one bone's frame, taken from the pose
   * the clips produced BEFORE inverse kinematics touched it. This is what a
   * planter asks when it wants to know whether the animation is lifting a foot,
   * a question its own corrected output cannot answer.
   * @param {string} boneName
   * @param {THREE.Vector3} local point in the bone's local frame
   * @returns {?number} null when the bone is not in this skeleton
   */
  preIkPointY(boneName, local) {
    const i = this.index[boneName];
    if (i === undefined) return null;
    _v0.copy(local).applyQuaternion(this._preIkQuat[i]).add(this._preIkPos[i]);
    return _v0.y;
  }

  /** Velocity of the body in model space; drives lean and secondary motion. */
  setBodyVelocity(v) {
    this.bodyVelocity.copy(v);
  }

  /**
   * Register an impact so it visibly ripples through the chassis.
   * @param {Object} o
   * @param {THREE.Vector3} o.dir  direction the blow travels, model space
   * @param {number} o.force       0..1 for a jab, up to ~2.5 for a launcher
   * @param {string} [o.region]    head|torso|arm|leg (default 'torso')
   */
  impact({ dir, force = 1, region = 'torso' }) {
    if (!this.recoil.enabled) return;
    const chain = RIPPLE[region] || RIPPLE.torso;
    // A blow travelling along `dir` torques the chassis about the axis
    // perpendicular to it and to up, which is what makes a hook spin the torso
    // and an uppercut throw the head back.
    _v0.copy(dir);
    if (_v0.lengthSq() < 1e-8) _v0.set(0, 0, -1);
    _v0.normalize();
    _v1.crossVectors(_AXIS_Y, _v0);
    if (_v1.lengthSq() < 1e-6) _v1.copy(_AXIS_X); else _v1.normalize();
    // Torque about the horizontal axis perpendicular to the blow, plus a twist
    // about up so a hook spins the torso instead of only tipping it.
    const twist = -_v0.x * 0.45;
    for (const [bone, delay, gain] of chain) {
      const spring = this.springs[bone];
      if (!spring) continue;
      const s = gain * force * 9.0 * this.recoil.scale;
      const vec = new THREE.Vector3(_v1.x * s, twist * s, _v1.z * s);
      this._ripple.push({ bone, at: this._rippleTick + delay, vec });
    }
  }

  /**
   * Add a procedural pose modifier.
   * @param {(pose: Pose, ctx: Object) => void} fn
   * @param {{stage?:'pre'|'post'}} [opts] 'pre' runs before IK (default), 'post' after
   * @returns {() => void} remover
   */
  addProceduralLayer(fn, opts = {}) {
    const list = opts.stage === 'post' ? this._proceduralPost : this._proceduralPre;
    list.push(fn);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Register an extra spring bone (antennae, cable ends, tails). */
  addSpringBone(name, params = {}) {
    if (!(name in this.index)) { this.#warn(`spring bone "${name}" not in skeleton`); return null; }
    const p = { ...SPRING_DEFAULTS.head, ...params };
    const s = new Spring3(p);
    this.springs[name] = s;
    return s;
  }

  // =========================================================================
  // Simulation
  // =========================================================================

  /**
   * Advance one fixed 60Hz tick and build the new pose snapshot.
   * @param {number} tick absolute sim tick; used for deterministic noise phase
   */
  simulate(tick = this.tick + 1) {
    this.tick = tick;
    this._rippleTick++;

    // 1 — swap snapshots and build into `cur`.
    const prev = this.cur;
    const cur = prev === this._poseA ? this._poseB : this._poseA;
    this.prev = prev;
    this.cur = cur;
    cur.reset();

    // 2 — advance and compose the clip layers.
    this.#advanceEntries();
    this.#composeLayers(cur);
    this.#applyInertia(cur);
    this.#trackEnergy(cur);

    // 3 — world transforms of the clip pose.
    this.#forwardKinematics(cur);

    // 4 — procedural additive stack.
    this._ctx.tick = tick;
    this._ctx.dt = TICK_DT;
    this._ctx.pose = cur;
    this._ctx.idleness = this.breathing.idleness;
    this._ctx.energy = this.breathing._energy;

    this.#applyBreathing(cur);
    this.#applyLookAt(cur);
    this.#applySecondary(cur);
    for (let i = 0; i < this._proceduralPre.length; i++) this._proceduralPre[i](cur, this._ctx);

    // 5 — world transforms of the procedural pose, for IK.
    this.#forwardKinematics(cur);

    // Snapshot the pose the clips asked for, before IK edits it. A foot planter
    // has to be able to tell "the animation is holding this foot down" from
    // "the planter is holding this foot down", and it cannot do that by reading
    // its own output: the correction hides the lift that should release it.
    for (let i = 0; i < this.count; i++) {
      this._preIkPos[i].copy(this.worldPos[i]);
      this._preIkQuat[i].copy(this.worldQuat[i]);
    }

    // 6 — IK, then refresh the world cache so anything reading worldPos /
    // worldQuat after simulate() sees the pose that will actually be rendered.
    this._ikApplied = false;
    this.#applyIk(cur);
    if (this._ikApplied) this.#forwardKinematics(cur);
    for (let i = 0; i < this._proceduralPost.length; i++) this._proceduralPost[i](cur, this._ctx);

    // 7 — public state.
    const top = this.#topEntry(this.base);
    if (top) {
      this.current = top.clipId;
      this.time = top.time;
      this.finished = !top.loop && top.time >= top.clip.duration;
    } else {
      this.finished = true;
    }
  }

  #topEntry(layer) {
    for (let i = layer.entries.length - 1; i >= 0; i--) {
      if (!layer.entries[i].dying) return layer.entries[i];
    }
    return layer.entries[layer.entries.length - 1] || null;
  }

  #advanceEntries() {
    for (const layer of this.layers.values()) {
      if (layer.fade) {
        layer.fade.elapsed++;
        const u = THREE.MathUtils.clamp(layer.fade.elapsed / layer.fade.ticks, 0, 1);
        layer.weight = layer.fade.from + (layer.fade.to - layer.fade.from) * EASE.sine(u);
        if (u >= 1) layer.fade = null;
      }

      const isBase = layer === this.base;
      for (let i = layer.entries.length - 1; i >= 0; i--) {
        const e = layer.entries[i];
        const clip = e.clip;

        // Advance time and measure this entry's own root delta. Doing it
        // per-entry, from the entry's own unwrapped absolute offset, is what
        // keeps a looping walk from emitting a huge negative step on the wrap
        // and a crossfade from double-counting.
        e.clock += e.speed;
        e.time = e.retime ? retimeClip(e.retime, e.clock) : e.clock;
        if (clip.root && clip.root.length) {
          _v0.copy(e.rootAbs);
          const yaw0 = e.rootYawAbs;
          e.rootYawAbs = this.#rootAbs(clip, e.time, e.rootAbs);
          e.dPos.copy(e.rootAbs).sub(_v0);
          e.dYaw = e.rootYawAbs - yaw0;
        } else {
          e.dPos.set(0, 0, 0);
          e.dYaw = 0;
        }

        // Clip end handling.
        if (!e.loop && !e.ended && e.time >= clip.duration) {
          e.ended = true;
          if (e.onEnd) { const fn = e.onEnd; e.onEnd = null; fn(e.clipId, this); }
          if (e.autoBlendOut && !e.dying) {
            e.dying = true;
            e.fadeFrom = e.weight;
            e.target = 0;
            e.fadeTicks = Math.max(1, clip.blendOut ?? 6);
            e.fadeElapsed = 0;
          }
        }

        // Weight blending.
        if (e.fadeTicks > 0) {
          e.fadeElapsed++;
          const u = THREE.MathUtils.clamp(e.fadeElapsed / e.fadeTicks, 0, 1);
          e.weight = e.fadeFrom + (e.target - e.fadeFrom) * e.easeFn(u);
          if (u >= 1) {
            e.weight = e.target;
            e.fadeTicks = 0;
          }
        } else {
          e.weight = e.target;
        }

        if (e.dying && e.weight <= 0.0005) {
          // Never remove the last entry of the base layer: it holds the pose.
          if (!(isBase && layer.entries.length === 1)) layer.entries.splice(i, 1);
        }
      }
    }
  }

  /**
   * Where an entry stood one tick ago, through its own retime map. Used only by
   * the rewound compose that inertialization needs — knowing where the incoming
   * animation *came from* is what separates its velocity from the outgoing
   * pose's, and without that separation the offset velocity double-counts.
   */
  #prevTime(e) {
    const clock = e.clock - e.speed;
    const t = e.retime ? retimeClip(e.retime, clock) : clock;
    return e.clip.loop ? t : Math.max(0, t);
  }

  /**
   * @param {Pose} out
   * @param {boolean} [rewind] sample every entry one tick earlier and extract no
   *   root motion; the result is the pose the current clips would have produced
   *   last tick, which is a velocity reference, not something to render.
   */
  #composeLayers(out, rewind = false) {
    // --- base layer -------------------------------------------------------
    //
    // Entries are sampled with their RAW weight, not a weight normalised across
    // the stack. That matters: a clip only talks about the bones it moves, so
    // during a jab -> idle crossfade the legs are driven by idle alone. With
    // normalised weights those bones would read as fully driven right up until
    // the outgoing entry was retired, and then snap. With raw weights the
    // accumulated per-bone weight tells us exactly how much of that bone is
    // authored this tick, and anything short of 1 is blended back toward the
    // rest pose instead of popping.
    const base = this.base;
    let total = 0;
    for (const e of base.entries) total += e.weight;
    if (total > 1e-6) {
      for (const e of base.entries) {
        if (e.weight <= 1e-6) continue;
        sampleClip(e.clip, rewind ? this.#prevTime(e) : e.time, out, e.weight);
      }
      for (let i = 0; i < this.count; i++) {
        const n = this.names[i];
        const w = out.weight[n];
        if (w <= 0 || w >= 0.9999) continue;
        _q0.set(0, 0, 0, 1).slerp(out.rot[n], w);
        out.rot[n].copy(_q0);
      }
      // Root motion is extracted from the base layer only, weight-normalised so
      // a crossfade blends the two clips' motion instead of summing it.
      let yawDrive = 0;
      if (!rewind) for (const e of base.entries) {
        if (e.weight <= 1e-6) continue;
        const w = e.weight / total;
        if (this.rootMotionAxes.x) this._rootAccum.x += e.dPos.x * w;
        if (this.rootMotionAxes.y) this._rootAccum.y += e.dPos.y * w;
        if (this.rootMotionAxes.z) this._rootAccum.z += e.dPos.z * w;
        if (this.rootMotionAxes.yaw) this._rootYawAccum += e.dYaw * w;
        if (this.#authorsYaw(e.clip)) yawDrive += w;
      }
      if (!rewind) this.rootYawDrive = yawDrive;
    } else if (!rewind) {
      this.rootYawDrive = 0;
    }
    // Zero the axes we extracted so the visual root never double-applies them.
    if (this.rootMotionAxes.x) out.rootPos.x = 0;
    if (this.rootMotionAxes.y) out.rootPos.y = 0;
    if (this.rootMotionAxes.z) out.rootPos.z = 0;
    if (this.rootMotionAxes.yaw) out.rootYaw = 0;

    // --- override and additive layers -------------------------------------
    for (const layer of this.layers.values()) {
      if (layer === base || layer.weight <= 1e-4 || !layer.entries.length) continue;
      const pose = layer.pose;
      pose.reset();
      let live = false;
      for (const e of layer.entries) {
        if (e.weight <= 1e-6) continue;
        sampleClip(e.clip, rewind ? this.#prevTime(e) : e.time, pose, e.weight);
        live = true;
      }
      if (!live) continue;

      // Same raw-weight rule as the base layer, except an override layer falls
      // back to the pose UNDER it rather than to rest, so the accumulated
      // per-bone weight goes straight into the blend factor.
      for (const bone of this.names) {
        const ew = pose.weight[bone];
        if (ew <= 0) continue;
        const w = layer.weight * layer.maskWeight(bone) * Math.min(1, ew);
        if (w <= 1e-4) continue;
        if (layer.additive) {
          addQuat(out, bone, pose.rot[bone], w);
        } else {
          out.rot[bone].slerp(pose.rot[bone], Math.min(1, w));
          if (w > out.weight[bone]) out.weight[bone] = w;
        }
      }
    }
  }

  /**
   * Decay the transition offset onto the composed pose.
   *
   * `Pose.rot` is a rest-relative delta, so the offset is just another delta
   * and composes by pre-multiplication — it rides in the bone's rest frame and
   * does not get dragged around by the clip that is now playing. The whole
   * state is per-bone scalars plus a fixed axis, advanced at TICK_DT, so it
   * re-simulates exactly.
   */
  #applyInertia(pose) {
    const I = this.inertia;
    if (I.pending > 0) {
      // Where the incoming clips stood one tick ago. The offset's rate of
      // change is the difference of two velocities, and this is the half of it
      // the outgoing snapshots cannot supply.
      this._inPrevPose.reset();
      this.#composeLayers(this._inPrevPose, true);
      this.#solveInertia(pose, I.pending * TICK_DT);
      I.pending = 0;
    }
    if (!I.active) return;
    // Advance first: the tick the transition was armed on should already show
    // one tick of the outgoing motion carried through, not a repeat of the
    // frame before it.
    I.t += TICK_DT;
    if (I.t >= I.t1) { I.active = false; return; }
    const t = I.t, t2 = t * t, t3 = t2 * t;
    for (let i = 0; i < this.count; i++) {
      if (!this._inLive[i]) continue;
      if (t >= this._inT1[i]) { this._inLive[i] = 0; continue; }
      const x = (this._inA[i] * t2 + this._inB[i] * t + this._inC[i]) * t3
        + this._inV0[i] * t + this._inX0[i];
      if (Math.abs(x) < 1e-5) continue;
      _q0.setFromAxisAngle(this._inAxis[i], x);
      pose.rot[this.names[i]].premultiply(_q0);
    }
  }

  /**
   * Bollo's quintic, fitted per bone on the tick a clip is armed.
   *
   * The offset that takes the new pose back to the pose the body was in has
   * magnitude `x0` about a fixed axis; `v0` is the rate that magnitude was
   * changing, measured along the same axis from the snapshot one tick earlier.
   * The curve satisfies x(0)=x0, x'(0)=v0 and x(t1)=x'(t1)=x''(t1)=0, so
   * position and velocity are continuous across the cut and the offset arrives
   * at zero with no residual motion for the next layer to fight.
   *
   * `t1` is shortened per bone when the offset is already closing fast enough
   * to reach zero early — otherwise the quintic would drive it past the target
   * and swing back, which is the one artefact this technique can introduce.
   * @param {Pose} pose the freshly composed incoming pose
   * @param {number} dur decay window in seconds
   */
  #solveInertia(pose, dur) {
    const I = this.inertia;
    I.t = 0;
    I.t1 = 0;
    I.active = false;
    for (let i = 0; i < this.count; i++) {
      this._inLive[i] = 0;
      _q1.copy(pose.rot[this.names[i]]).invert();
      quatToVec(_q0.copy(this._inSrc[i]).multiply(_q1), _v0);
      const x0 = _v0.length();
      if (x0 < INERTIA_EPS) continue;
      const axis = this._inAxis[i].copy(_v0).divideScalar(x0);
      _q1.copy(this._inPrevPose.rot[this.names[i]]).invert();
      quatToVec(_q0.copy(this._inSrcPrev[i]).multiply(_q1), _v1);
      let v0 = (x0 - _v1.dot(axis)) / TICK_DT;
      if (v0 > 0) v0 = Math.min(v0, INERTIA_RISE_CAP * x0 / dur);
      const t1 = v0 < 0 ? Math.min(dur, -5 * x0 / v0) : dur;
      const t3 = t1 * t1 * t1, t4 = t3 * t1, t5 = t4 * t1;
      this._inA[i] = -(6 * v0 * t1 + 12 * x0) / (2 * t5);
      this._inB[i] = (16 * v0 * t1 + 30 * x0) / (2 * t4);
      this._inC[i] = -(12 * v0 * t1 + 20 * x0) / (2 * t3);
      this._inX0[i] = x0;
      this._inV0[i] = v0;
      this._inT1[i] = t1;
      this._inLive[i] = 1;
      if (t1 > I.t1) I.t1 = t1;
      I.active = true;
    }
  }

  /**
   * How much authored motion is happening right now, so the breathing layer can
   * step out of the way instead of fighting a punch.
   */
  #trackEnergy(pose) {
    let sum = 0;
    for (let i = 0; i < this._energyBones.length; i++) {
      const n = this._energyBones[i];
      const q = pose.rot[n];
      sum += this._energyPrev[i].angleTo(q);
      this._energyPrev[i].copy(q);
    }
    const raw = this._energyBones.length ? sum / this._energyBones.length : 0;
    const b = this.breathing;
    // Rise fast, fall slow: the body should not start breathing mid-recovery.
    const k = raw > b._energy ? 0.55 : 0.035;
    b._energy += (raw - b._energy) * k;
    b.idleness = THREE.MathUtils.clamp(1 - b._energy / 0.022, 0, 1);
  }

  // =========================================================================
  // Forward kinematics
  // =========================================================================

  /** Model-space transforms for every bone under `pose`. */
  #forwardKinematics(pose) {
    const rootI = this.rootIndex;
    for (let oi = 0; oi < this.order.length; oi++) {
      const i = this.order[oi];
      const p = this.parent[i];
      const wq = this.worldQuat[i];
      const wp = this.worldPos[i];

      // local = rest * poseDelta
      _q0.copy(this.restQuat[i]).multiply(pose.rot[this.names[i]]);

      if (p === -1) {
        wq.copy(_q0);
        if (i === rootI && pose.rootYaw !== 0) {
          _q1.setFromAxisAngle(_AXIS_Y, pose.rootYaw);
          wq.multiply(_q1);
        }
        wp.copy(this.restPos[i]);
        if (i === rootI) wp.add(pose.rootPos);
      } else {
        const pq = this.worldQuat[p];
        wq.copy(pq).multiply(_q0);
        wp.copy(this.restPos[i]).applyQuaternion(pq).add(this.worldPos[p]);
      }
    }
  }

  // =========================================================================
  // Procedural layers
  // =========================================================================

  #applyBreathing(pose) {
    const b = this.breathing;
    if (!b.enabled) return;
    b.phase += b.rate;
    const amp = b.amplitude * b.idleness;
    if (amp <= 1e-4) return;

    const p = b.phase * Math.PI * 2;
    const s = Math.sin(p);
    const s2 = Math.sin(p - 0.55);
    const n = this.tick * 0.006;

    // Chest expands and the shoulders rise a hair behind it.
    addEuler(pose, 'chest', -1.35 * DEG * s, 0, 0, amp);
    addEuler(pose, 'spine02', 0.55 * DEG * s2, 0, 0, amp);
    addEuler(pose, 'spine01', 0.32 * DEG * s2, 0, 0, amp);
    addEuler(pose, 'clavicle_L', 0, 0, -0.9 * DEG * s2, amp);
    addEuler(pose, 'clavicle_R', 0, 0, 0.9 * DEG * s2, amp);
    addEuler(pose, 'neck', 0.7 * DEG * s, 0, 0, amp);
    addEuler(pose, 'head', -0.5 * DEG * s, 0, 0, amp);

    // Slow, non-repeating weight shift so a standing robot is never frozen.
    const swayX = noise1(n, 11) * 0.9 * DEG;
    const swayZ = noise1(n * 0.83, 29) * 1.15 * DEG;
    const swayY = noise1(n * 0.61, 47) * 1.4 * DEG;
    addEuler(pose, 'hips', swayX, swayY * 0.4, swayZ, amp);
    addEuler(pose, 'spine01', swayX * 0.4, swayY * 0.3, -swayZ * 0.5, amp);
    addEuler(pose, 'head', noise1(n * 1.7, 71) * 1.1 * DEG, noise1(n * 1.3, 83) * 1.6 * DEG, 0, amp);

    const st = amp * b.stance;
    if (st <= 1e-4) return;

    // Nothing else in the pipeline writes a bone below the hips or past the
    // clavicles, so a standing frame holds the legs and the forearms perfectly
    // still while the chest breathes — which is the tell. The weight shift uses
    // the same joint relationship the authored idle rock does (loaded side
    // extends and its ankle rolls under the pelvis, free side softens) at a
    // third of the amplitude, driven by noise rather than the breath phase so
    // the two never beat together.
    const shift = noise1(n * 0.95, 103);
    addEuler(pose, 'hip_L', -2.6 * DEG * shift, 0, 1.1 * DEG * shift, st);
    addEuler(pose, 'knee_L', 3.8 * DEG * shift, 0, 0, st);
    addEuler(pose, 'ankle_L', -2.4 * DEG * shift, 0, 0, st);
    addEuler(pose, 'hip_R', 2.2 * DEG * shift, 0, -0.6 * DEG * shift, st);
    addEuler(pose, 'knee_R', -3.3 * DEG * shift, 0, 0, st);
    addEuler(pose, 'ankle_R', 2.7 * DEG * shift, 0, 0, st);

    // The arms drift on their own clocks: a guard being held, not parked. The
    // two sides get separate seeds AND separate rates, or the hands move as one
    // rigid object and the whole thing reads as the camera shaking.
    const dl = noise1(n * 2.1, 131), dl2 = noise1(n * 1.5, 149);
    const dr = noise1(n * 1.9, 167), dr2 = noise1(n * 1.65, 181);
    addEuler(pose, 'shoulder_L', 1.2 * DEG * dl, 0.85 * DEG * dl2, -1.0 * DEG * dl2, st);
    addEuler(pose, 'elbow_L', 1.6 * DEG * dl2, 0, 0.7 * DEG * dl, st);
    addEuler(pose, 'wrist_L', 1.3 * DEG * dl, 1.1 * DEG * dl2, 0, st);
    addEuler(pose, 'shoulder_R', 1.2 * DEG * dr, 0.85 * DEG * dr2, 1.0 * DEG * dr2, st);
    addEuler(pose, 'elbow_R', 1.6 * DEG * dr2, 0, -0.7 * DEG * dr, st);
    addEuler(pose, 'wrist_R', 1.3 * DEG * dr, 1.1 * DEG * dr2, 0, st);
  }

  #applyLookAt(pose) {
    const L = this.look;
    const targetActive = L.target && L.weight > 1e-4;

    let wantYaw = 0, wantPitch = 0;
    if (targetActive) {
      const headI = this.index.head ?? this.index.neck;
      const chestI = this.index.chest ?? this.rootIndex;
      _v0.copy(L.target);
      if (L.space === 'world') this.#toModel(_v0);
      _v0.sub(this.worldPos[headI]);
      if (_v0.lengthSq() > 1e-8) {
        _v0.normalize();
        // Express the direction in the chest's frame; the rig faces -Z.
        _q0.copy(this.worldQuat[chestI]).invert();
        _v0.applyQuaternion(_q0);
        wantYaw = Math.atan2(-_v0.x, -_v0.z);
        wantPitch = Math.asin(THREE.MathUtils.clamp(_v0.y, -1, 1));
        wantYaw = THREE.MathUtils.clamp(wantYaw, -L.yawLimit, L.yawLimit);
        wantPitch = THREE.MathUtils.clamp(wantPitch, -L.pitchLimit, L.pitchLimit);
      }
    }

    // Critically damped approach so the head never snaps to a new target.
    const dt = TICK_DT;
    L.current += ((targetActive ? L.weight : 0) - L.current) * 0.18;
    L.yawVel += (-L.stiffness * (L.yaw - wantYaw) - L.damping * L.yawVel) * dt;
    L.yaw += L.yawVel * dt;
    L.pitchVel += (-L.stiffness * (L.pitch - wantPitch) - L.damping * L.pitchVel) * dt;
    L.pitch += L.pitchVel * dt;

    const w = L.current;
    if (w <= 1e-4) return;
    const sh = L.share;
    addEuler(pose, 'chest', L.pitch * sh.chest, L.yaw * sh.chest, 0, w);
    addEuler(pose, 'neck', L.pitch * sh.neck, L.yaw * sh.neck, 0, w);
    addEuler(pose, 'head', L.pitch * sh.head, L.yaw * sh.head, 0, w);
  }

  #applySecondary(pose) {
    const S = this.secondary;

    // Body acceleration in model space becomes a torque about the horizontal
    // axis, so a dash tips the chassis back into the acceleration and settles.
    this._bodyAccel.copy(this.bodyVelocity).sub(this._prevBodyVelocity).divideScalar(TICK_DT);
    this._prevBodyVelocity.copy(this.bodyVelocity);
    _v3.crossVectors(_AXIS_Y, this._bodyAccel);

    // Deliver any ripple impulses whose propagation delay has elapsed.
    for (let i = this._ripple.length - 1; i >= 0; i--) {
      const r = this._ripple[i];
      if (r.at > this._rippleTick) continue;
      this.springs[r.bone]?.kick(r.vec, 1);
      this._ripple.splice(i, 1);
    }

    const primed = this._springsPrimed;
    for (const bone in this.springs) {
      const spring = this.springs[bone];
      const i = this.index[bone];
      const p = this.parent[i];

      _v2.set(0, 0, 0);
      if (p !== -1) {
        // Angular velocity of the parent over this tick, in the parent frame.
        _q0.copy(this._prevParentQuat[i]).invert().multiply(this.worldQuat[p]);
        this._prevParentQuat[i].copy(this.worldQuat[p]);
        if (primed && S.enabled) {
          quatToVec(_q0, _v1);
          // The bone wants to hold its orientation, so it lags by -omega.
          _v2.addScaledVector(_v1, -spring.driveRot * S.scale / TICK_DT);
          _v2.addScaledVector(_v3, spring.driveAcc * S.scale);
        }
      }

      spring.step(TICK_DT, _v2);
      if (spring.x.lengthSq() < 1e-10) continue;
      vecToQuat(spring.x, _q1);
      addQuat(pose, bone, _q1, 1);
    }
    this._springsPrimed = true;
  }

  // =========================================================================
  // Inverse kinematics
  // =========================================================================

  #applyIk(pose) {
    for (const name in IK_CHAINS) {
      const slot = this.ik[name];
      const isLeg = name === 'legL' || name === 'legR';

      if (slot.target && slot.weight > 1e-3) {
        _v0.copy(slot.target);
        if (slot.space === 'world') this.#toModel(_v0);
        slot.current += (slot.weight - slot.current) * 0.35;
        this.#solveTwoBone(pose, name, _v0, slot.current, slot.preserveEnd);
        if (isLeg) this.footPlant._w[name] = 0;
        continue;
      }
      slot.current += (0 - slot.current) * 0.3;

      if (isLeg && this.footPlant.enabled) this.#plantFoot(pose, name);
    }
  }

  /**
   * Foot planting: find the lowest point of the foot, and if it is at or below
   * the floor lift the ankle by exactly that much, preserving the ankle's
   * authored orientation so the sole angle from the clip survives.
   */
  #plantFoot(pose, chainName) {
    const fp = this.footPlant;
    const c = IK_CHAINS[chainName];
    const ankleI = this.index[c.end];
    if (ankleI === undefined) return;
    const side = chainName === 'legL' ? 'L' : 'R';
    const footI = this.index[`foot_${side}`];
    const toeI = this.index[`toe_${side}`];

    const ankle = this.worldPos[ankleI];
    let soleY = ankle.y;
    if (footI !== undefined) soleY = Math.min(soleY, this.worldPos[footI].y);
    if (toeI !== undefined) soleY = Math.min(soleY, this.worldPos[toeI].y);
    soleY -= fp.soleClearance;

    const gap = soleY - fp.floorY;
    let want = 0;
    let lift = 0;
    if (gap <= 0) {
      want = fp.weight;
      lift = Math.min(-gap, fp.maxLift);
    } else if (gap < fp.probe) {
      // Just above the floor: pull down so the contact reads as solid. Both the
      // weight AND the correction fall off across the probe band, so they reach
      // zero together and the foot leaves the ground without a step. Smoothstep
      // rather than a linear ramp, so the derivative is continuous at both ends
      // of the band and there is no kink as the foot breaks contact.
      const u = 1 - gap / fp.probe;
      const falloff = u * u * (3 - 2 * u);
      want = fp.weight * falloff;
      lift = -gap * falloff;
    }

    const w = (fp._w[chainName] += (want - fp._w[chainName]) * fp.responsiveness);
    if (w <= 1e-3 || Math.abs(lift) < 1e-5) return;

    _v0.copy(ankle);
    _v0.y += lift;
    this.#solveTwoBone(pose, chainName, _v0, w, true);
  }

  /**
   * Analytic two-bone IK with a pole vector.
   *
   * Works entirely from the FK snapshot: it computes the *world* orientations
   * the two bones need, then converts them back into rest-relative local deltas
   * and slerps the existing pose toward them by `weight`. Because it never reads
   * the previous IK result, blending the weight in and out is stable and the
   * twist of the limb from the authored clip is preserved (the aim is applied as
   * a minimal-arc delta on top of the current world orientation).
   *
   * @param {Pose} pose
   * @param {string} chainName
   * @param {THREE.Vector3} target model space
   * @param {number} weight
   * @param {boolean} preserveEnd keep the end bone's world orientation
   */
  #solveTwoBone(pose, chainName, target, weight, preserveEnd) {
    const c = IK_CHAINS[chainName];
    const ri = this.index[c.root], mi = this.index[c.mid], ei = this.index[c.end];
    if (ri === undefined || mi === undefined || ei === undefined) return;

    const len1 = this.restPos[mi].length();
    const len2 = this.restPos[ei].length();
    if (len1 < 1e-6 || len2 < 1e-6) return;

    // Copy first: callers legitimately pass module scratch as the target.
    const tgt = this._ikTarget.copy(target);
    const rootPos = this.worldPos[ri];
    _v1.copy(tgt).sub(rootPos);
    const dist = _v1.length();
    if (dist < 1e-5) return;

    const maxReach = (len1 + len2) * 0.9985;
    const minReach = Math.abs(len1 - len2) * 1.0015 + 1e-4;
    const reach = THREE.MathUtils.clamp(dist, minReach, maxReach);
    _v0.copy(_v1).divideScalar(dist);            // unit direction root -> target

    // Bend plane. IK_CHAINS.pole points AWAY from the joint's protrusion
    // (legs +Z / behind, arms -Z / in front), so the joint bends toward -pole:
    // knees forward, elbows back, which is what both a human and this chassis do.
    _v2.set(-c.pole[0], -c.pole[1], -c.pole[2]);
    _v2.addScaledVector(_v0, -_v2.dot(_v0));
    if (_v2.lengthSq() < 1e-8) {
      // Degenerate: the pole is parallel to the limb. Fall back to any
      // perpendicular, chosen deterministically.
      _v2.crossVectors(_v0, _AXIS_Y);
      if (_v2.lengthSq() < 1e-8) _v2.crossVectors(_v0, _AXIS_X);
    }
    _v2.normalize();

    const cosA = THREE.MathUtils.clamp(
      (len1 * len1 + reach * reach - len2 * len2) / (2 * len1 * reach), -1, 1,
    );
    const a = Math.acos(cosA);
    this._ikApplied = true;

    // Desired direction of the upper bone, and the resulting mid-joint position.
    _v3.copy(_v0).multiplyScalar(Math.cos(a)).addScaledVector(_v2, Math.sin(a)).normalize();
    _v4.copy(rootPos).addScaledVector(_v3, len1);

    // Clamped effective target: when out of reach the limb straightens at it.
    _v2.copy(rootPos).addScaledVector(_v0, reach);

    // --- upper bone -------------------------------------------------------
    _v1.copy(_BONE_AXIS).applyQuaternion(this.worldQuat[ri]).normalize();
    _q0.setFromUnitVectors(_v1, _v3);                       // minimal-arc aim delta
    _q1.copy(_q0).multiply(this.worldQuat[ri]);             // new world quat of root bone

    // --- lower bone -------------------------------------------------------
    _v2.sub(_v4);
    if (_v2.lengthSq() < 1e-10) _v2.copy(_v3); else _v2.normalize();
    _v1.copy(_BONE_AXIS).applyQuaternion(_q2.copy(_q0).multiply(this.worldQuat[mi])).normalize();
    _q3.setFromUnitVectors(_v1, _v2);
    const newMid = _q3.multiply(_q2);                       // _q3 now = new world quat of mid

    // --- write back as rest-relative local deltas -------------------------
    const pr = this.parent[ri];
    _q2.copy(pr === -1 ? IDENTITY : this.worldQuat[pr]).invert().multiply(_q1);
    _q2.premultiply(this.restQuatInv[ri]);
    pose.rot[this.names[ri]].slerp(_q2, weight);

    _q0.copy(_q1).invert().multiply(newMid).premultiply(this.restQuatInv[mi]);
    pose.rot[this.names[mi]].slerp(_q0, weight);

    if (preserveEnd) {
      _q0.copy(newMid).invert().multiply(this.worldQuat[ei]).premultiply(this.restQuatInv[ei]);
      pose.rot[this.names[ei]].slerp(_q0, weight);
    }
  }

  // =========================================================================
  // Presentation
  // =========================================================================

  /**
   * Write the final pose to the bones, interpolating between the last two
   * simulated snapshots. Call once per rendered frame.
   * @param {THREE.Bone[]|Record<string,THREE.Bone>} [bones] defaults to the rig
   *   this Animator was constructed with
   * @param {number} alpha 0..1 fraction of a tick since the last simulate()
   */
  applyTo(bones = this.bones, alpha = 1) {
    const list = this.#resolveBones(bones);
    if (!list) return;
    const a = THREE.MathUtils.clamp(alpha, 0, 1);
    const prev = this.prev, cur = this.cur;
    const rootName = this.names[this.rootIndex];

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry) continue;
      const bone = entry.bone;
      const name = entry.name;
      const bi = entry.index;
      _q0.copy(prev.rot[name]).slerp(cur.rot[name], a);
      bone.quaternion.copy(this.restQuat[bi]).multiply(_q0);

      if (name === rootName) {
        _v0.copy(prev.rootPos).lerp(cur.rootPos, a);
        bone.position.copy(this.restPos[bi]).add(_v0);
        const yaw = prev.rootYaw + (cur.rootYaw - prev.rootYaw) * a;
        if (yaw !== 0) {
          _q1.setFromAxisAngle(_AXIS_Y, yaw);
          bone.quaternion.multiply(_q1);
        }
      }
    }
  }

  /** Resolve and cache the bone list handed to applyTo. */
  #resolveBones(bones) {
    if (this._appliedBones === bones && this._appliedOrder) return this._appliedOrder;
    let arr = null;
    if (Array.isArray(bones)) arr = bones;
    else if (bones && typeof bones === 'object') arr = Object.values(bones);
    if (!arr) return null;

    const out = [];
    for (const bone of arr) {
      if (!bone || !bone.isObject3D) continue;
      const i = this.index[bone.name];
      if (i === undefined) continue;
      out.push({ bone, name: bone.name, index: i });
    }
    this._appliedBones = bones;
    this._appliedOrder = out;
    return out;
  }

  /** Snap both snapshots to the current pose; kills interpolation for one frame. */
  snap() {
    for (const n of this.names) {
      this.prev.rot[n].copy(this.cur.rot[n]);
      this.prev.weight[n] = this.cur.weight[n];
    }
    this.prev.rootPos.copy(this.cur.rootPos);
    this.prev.rootYaw = this.cur.rootYaw;
  }

  /**
   * Return the animator to a clean state: no clips, no springs in flight, no
   * pending root motion. Used between rounds so nothing leaks across a reset.
   */
  reset() {
    for (const layer of this.layers.values()) {
      layer.entries.length = 0;
      layer.fade = null;
      layer.weight = 1;
      if (layer.pose) layer.pose.reset();
    }
    this._poseA.reset();
    this._poseB.reset();
    this.prev = this._poseA;
    this.cur = this._poseB;
    this.clearRootMotion();
    this.inertia.active = false;
    this.inertia.pending = 0;
    this.inertia.t = 0;
    this.inertia.t1 = 0;
    this._inLive.fill(0);
    this._ripple.length = 0;
    for (const b in this.springs) this.springs[b].reset();
    for (const q of this._prevParentQuat) q.identity();
    for (const q of this._energyPrev) q.identity();
    for (const chain in this.ik) {
      this.ik[chain].target = null;
      this.ik[chain].weight = 0;
      this.ik[chain].current = 0;
    }
    this.footPlant._w.legL = 0;
    this.footPlant._w.legR = 0;
    this._springsPrimed = false;
    this._rippleTick = 0;
    this.look.target = null;
    this.look.weight = 0; this.look.current = 0;
    this.look.yaw = 0; this.look.pitch = 0;
    this.look.yawVel = 0; this.look.pitchVel = 0;
    this._spaceTick = -1;
    this.bodyVelocity.set(0, 0, 0);
    this._prevBodyVelocity.set(0, 0, 0);
    this.breathing._energy = 0;
    this.breathing.idleness = 1;
    this.current = null;
    this.time = 0;
    this.finished = true;
    this.#forwardKinematics(this.cur);
  }

  /** Drop references so the fighter can be torn down. */
  dispose() {
    this.layers.clear();
    this._proceduralPre.length = 0;
    this._proceduralPost.length = 0;
    this._ripple.length = 0;
    this._appliedBones = null;
    this._appliedOrder = null;
  }
}

export default Animator;
