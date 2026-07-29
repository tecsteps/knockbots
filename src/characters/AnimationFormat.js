/**
 * Knockbots — animation clip format.
 *
 * Clips are hand-authored data, not imported assets. The format is designed to
 * be readable and diffable: every key is a bone name mapped to a list of
 * keyframes holding an XYZ Euler rotation **in degrees**, applied ON TOP OF the
 * skeleton rest pose. That means a clip that omits a bone leaves it at rest,
 * so a punch clip only needs to talk about the arm and spine.
 *
 * Times `t` are in ticks at 60Hz and must be ascending. `duration` is the clip
 * length in ticks; a non-looping clip holds its final pose past `duration`.
 *
 * @typedef {Object} Key
 * @property {number} t                 tick
 * @property {[number,number,number]} r XYZ Euler in DEGREES, additive over rest
 * @property {string} [ease]            'linear'|'sine'|'quad'|'cubic'|'quart'|'expo'|'back'|'snap'|'hold'
 *
 * @typedef {Object} RootKey
 * @property {number} t
 * @property {[number,number,number]} [p] root offset in metres, +Z is FORWARD
 *   (the direction the fighter faces). Verified against the data rather than
 *   asserted: loco.dashFwd's root track ends at z = +0.94 and loco.dashBack at
 *   z = -1.08, and toe_L sits at z = +0.14 from the foot. This comment
 *   previously claimed the opposite and caused hardware to be mounted on the
 *   front of the chest instead of the back.
 * @property {number} [ry]                root yaw offset in degrees
 * @property {string} [ease]
 *
 * @typedef {Object} Clip
 * @property {string} name
 * @property {number} duration                 ticks
 * @property {boolean} [loop]
 * @property {Record<string, Key[]>} tracks
 * @property {RootKey[]} [root]                root motion
 * @property {number} [blendIn]                ticks to blend in (default 4)
 * @property {number} [blendOut]               ticks to blend out (default 6)
 * @property {string[]} [mask]                 if set, only these bones are driven
 */

import * as THREE from 'three';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Easing. `snap` is the fighting-game workhorse: slow wind-up, violent release.
// ---------------------------------------------------------------------------
export const EASE = {
  linear: (x) => x,
  sine: (x) => 0.5 - 0.5 * Math.cos(Math.PI * x),
  quad: (x) => (x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x)),
  cubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  quart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  expo: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.pow(2, 10 * x - 10)),
  back: (x) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
  snap: (x) => 1 - Math.pow(1 - x, 5),
  hold: () => 0,
};

/** Resolve an easing name to a function, defaulting to `snap`. */
export function ease(name) {
  return EASE[name] || EASE.snap;
}

/**
 * A reusable evaluation buffer: bone name -> THREE.Quaternion, expressed as a
 * delta from the rest pose. The animator composes these.
 */
export class Pose {
  constructor(boneNames) {
    /** @type {Record<string, THREE.Quaternion>} */
    this.rot = Object.create(null);
    /** @type {Record<string, number>} weight per bone, 0..1 */
    this.weight = Object.create(null);
    for (const n of boneNames) {
      this.rot[n] = new THREE.Quaternion();
      this.weight[n] = 0;
    }
    this.rootPos = new THREE.Vector3();
    this.rootYaw = 0;
  }

  reset() {
    for (const n in this.rot) {
      this.rot[n].identity();
      this.weight[n] = 0;
    }
    this.rootPos.set(0, 0, 0);
    this.rootYaw = 0;
  }
}

const _qa = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Sample a clip at time `t` (ticks) into `out`, scaled by `weight`.
 * Accumulates: call `out.reset()` first, then sample layers in order.
 * @param {Clip} clip
 * @param {number} t
 * @param {Pose} out
 * @param {number} weight
 */
export function sampleClip(clip, t, out, weight = 1) {
  if (weight <= 0) return;
  const time = clip.loop ? ((t % clip.duration) + clip.duration) % clip.duration : Math.min(t, clip.duration);

  for (const bone in clip.tracks) {
    const keys = clip.tracks[bone];
    if (!keys || keys.length === 0) continue;
    if (!(bone in out.rot)) continue;
    sampleTrack(keys, time, clip.loop ? clip.duration : Infinity, _e);
    _qa.setFromEuler(_e);
    const w = weight;
    const prev = out.weight[bone];
    const total = prev + w;
    // Normalised accumulation so layers blend rather than overwrite.
    out.rot[bone].slerp(_qa, total > 0 ? w / total : 0);
    out.weight[bone] = total;
  }

  if (clip.root && clip.root.length) {
    sampleRoot(clip.root, time, out, weight);
  }
}

function sampleTrack(keys, time, loopLen, outEuler) {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= time) i++;

  const a = keys[i];
  let b = keys[i + 1];

  if (!b) {
    if (loopLen !== Infinity && keys.length > 1) {
      b = keys[0];
      const span = loopLen - a.t + keys[0].t;
      const u = span > 0 ? ease(a.ease)((time - a.t) / span) : 0;
      lerpKey(a, b, u, outEuler);
      return;
    }
    outEuler.set(a.r[0] * DEG, a.r[1] * DEG, a.r[2] * DEG);
    return;
  }

  const span = b.t - a.t;
  const u = span > 0 ? ease(a.ease)(THREE.MathUtils.clamp((time - a.t) / span, 0, 1)) : 1;
  lerpKey(a, b, u, outEuler);
}

function lerpKey(a, b, u, outEuler) {
  outEuler.set(
    (a.r[0] + (b.r[0] - a.r[0]) * u) * DEG,
    (a.r[1] + (b.r[1] - a.r[1]) * u) * DEG,
    (a.r[2] + (b.r[2] - a.r[2]) * u) * DEG,
  );
}

function sampleRoot(keys, time, out, weight) {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= time) i++;
  const a = keys[i];
  const b = keys[i + 1] || a;
  const span = b.t - a.t;
  const u = span > 0 ? ease(a.ease)(THREE.MathUtils.clamp((time - a.t) / span, 0, 1)) : 1;
  const ap = a.p || [0, 0, 0], bp = b.p || [0, 0, 0];
  out.rootPos.x += (ap[0] + (bp[0] - ap[0]) * u) * weight;
  out.rootPos.y += (ap[1] + (bp[1] - ap[1]) * u) * weight;
  out.rootPos.z += (ap[2] + (bp[2] - ap[2]) * u) * weight;
  const ar = a.ry || 0, br = b.ry || 0;
  out.rootYaw += (ar + (br - ar) * u) * DEG * weight;
}

/** Validate a clip at authoring time; throws with a precise message. */
export function validateClip(clip, boneNames) {
  const known = new Set(boneNames);
  if (!clip.name) throw new Error('clip missing name');
  if (!(clip.duration > 0)) throw new Error(`clip ${clip.name}: duration must be > 0`);
  for (const bone in clip.tracks) {
    if (!known.has(bone)) throw new Error(`clip ${clip.name}: unknown bone "${bone}"`);
    const keys = clip.tracks[bone];
    if (!Array.isArray(keys) || !keys.length) throw new Error(`clip ${clip.name}: track "${bone}" empty`);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (typeof k.t !== 'number') throw new Error(`clip ${clip.name}/${bone}[${i}]: missing t`);
      if (!Array.isArray(k.r) || k.r.length !== 3) throw new Error(`clip ${clip.name}/${bone}[${i}]: r must be [x,y,z]`);
      if (i > 0 && k.t < keys[i - 1].t) throw new Error(`clip ${clip.name}/${bone}[${i}]: t not ascending`);
    }
  }
  return clip;
}
