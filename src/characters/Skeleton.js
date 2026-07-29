/**
 * Knockbots — the canonical humanoid rig.
 *
 * EVERY system depends on this file: the mesh builder skins to these bones,
 * the animator poses these bones by name, the combat system reads hurtbox and
 * hitbox anchors from these bones. Do not rename bones. Adding bones is fine.
 *
 * Coordinate convention (three.js, Y-up, right-handed):
 *   +Y is up, +X is the fighter's LEFT, -Z is the direction the fighter FACES
 *   when its root rotation is identity. Fighters are mirrored by rotating the
 *   root about Y, never by negative scale.
 *
 * Rest pose is a relaxed A-pose (arms ~40deg down from horizontal) which skins
 * far better at the shoulder than a T-pose.
 *
 * Units are metres. Total height ~1.85m for the reference chassis; per-character
 * proportion multipliers in roster.js scale segments without breaking retargeting.
 */

import * as THREE from 'three';

/**
 * @typedef {Object} BoneDef
 * @property {string}   name
 * @property {?string}  parent
 * @property {[number,number,number]} pos   local rest translation from parent
 * @property {[number,number,number]} [rot] local rest rotation, XYZ euler radians
 * @property {number}   [radius]  capsule radius used for hurtbox generation
 * @property {number}   [length]  capsule length toward the child, for hurtboxes
 * @property {string}   [region]  hurtbox region: head|torso|arm|leg
 */

const D = Math.PI / 180;

/** @type {BoneDef[]} — declared parents-before-children. */
export const BONES = [
  // --- root / locomotion ------------------------------------------------
  { name: 'root', parent: null, pos: [0, 0, 0] },
  { name: 'hips', parent: 'root', pos: [0, 0.98, 0], radius: 0.19, length: 0.14, region: 'torso' },

  // --- spine ------------------------------------------------------------
  { name: 'spine01', parent: 'hips', pos: [0, 0.14, 0], radius: 0.18, length: 0.15, region: 'torso' },
  { name: 'spine02', parent: 'spine01', pos: [0, 0.15, 0], radius: 0.2, length: 0.16, region: 'torso' },
  { name: 'chest', parent: 'spine02', pos: [0, 0.16, 0], radius: 0.23, length: 0.17, region: 'torso' },
  { name: 'neck', parent: 'chest', pos: [0, 0.19, 0.005], radius: 0.075, length: 0.09, region: 'torso' },
  { name: 'head', parent: 'neck', pos: [0, 0.1, 0], radius: 0.125, length: 0.16, region: 'head' },
  { name: 'headTop', parent: 'head', pos: [0, 0.19, 0] },

  // --- left arm (fighter's left = +X) -----------------------------------
  { name: 'clavicle_L', parent: 'chest', pos: [0.055, 0.13, 0.01], radius: 0.09, length: 0.13 },
  { name: 'shoulder_L', parent: 'clavicle_L', pos: [0.155, 0.015, 0], rot: [0, 0, -50 * D], radius: 0.105, length: 0.28, region: 'arm' },
  { name: 'elbow_L', parent: 'shoulder_L', pos: [0, -0.29, 0], radius: 0.082, length: 0.26, region: 'arm' },
  { name: 'wrist_L', parent: 'elbow_L', pos: [0, -0.27, 0], radius: 0.07, length: 0.11, region: 'arm' },
  { name: 'hand_L', parent: 'wrist_L', pos: [0, -0.12, 0], radius: 0.085, length: 0.1, region: 'arm' },
  { name: 'fingers_L', parent: 'hand_L', pos: [0, -0.1, 0.01] },
  { name: 'thumb_L', parent: 'hand_L', pos: [0.045, -0.035, 0.045] },

  // --- right arm --------------------------------------------------------
  { name: 'clavicle_R', parent: 'chest', pos: [-0.055, 0.13, 0.01], radius: 0.09, length: 0.13 },
  { name: 'shoulder_R', parent: 'clavicle_R', pos: [-0.155, 0.015, 0], rot: [0, 0, 50 * D], radius: 0.105, length: 0.28, region: 'arm' },
  { name: 'elbow_R', parent: 'shoulder_R', pos: [0, -0.29, 0], radius: 0.082, length: 0.26, region: 'arm' },
  { name: 'wrist_R', parent: 'elbow_R', pos: [0, -0.27, 0], radius: 0.07, length: 0.11, region: 'arm' },
  { name: 'hand_R', parent: 'wrist_R', pos: [0, -0.12, 0], radius: 0.085, length: 0.1, region: 'arm' },
  { name: 'fingers_R', parent: 'hand_R', pos: [0, -0.1, 0.01] },
  { name: 'thumb_R', parent: 'hand_R', pos: [-0.045, -0.035, 0.045] },

  // --- left leg ---------------------------------------------------------
  { name: 'hip_L', parent: 'hips', pos: [0.105, -0.03, 0], radius: 0.125, length: 0.42, region: 'leg' },
  { name: 'knee_L', parent: 'hip_L', pos: [0, -0.44, 0], radius: 0.1, length: 0.4, region: 'leg' },
  { name: 'ankle_L', parent: 'knee_L', pos: [0, -0.42, 0], radius: 0.085, length: 0.1, region: 'leg' },
  { name: 'foot_L', parent: 'ankle_L', pos: [0, -0.06, 0.06], radius: 0.09, length: 0.16, region: 'leg' },
  { name: 'toe_L', parent: 'foot_L', pos: [0, -0.045, 0.14] },

  // --- right leg --------------------------------------------------------
  { name: 'hip_R', parent: 'hips', pos: [-0.105, -0.03, 0], radius: 0.125, length: 0.42, region: 'leg' },
  { name: 'knee_R', parent: 'hip_R', pos: [0, -0.44, 0], radius: 0.1, length: 0.4, region: 'leg' },
  { name: 'ankle_R', parent: 'knee_R', pos: [0, -0.42, 0], radius: 0.085, length: 0.1, region: 'leg' },
  { name: 'foot_R', parent: 'ankle_R', pos: [0, -0.06, 0.06], radius: 0.09, length: 0.16, region: 'leg' },
  { name: 'toe_R', parent: 'foot_R', pos: [0, -0.045, 0.14] },
];

export const BONE_NAMES = BONES.map((b) => b.name);
export const BONE_INDEX = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

/** Bones that carry a hurtbox capsule, in the order the combat system tests them. */
export const HURTBOX_BONES = BONES.filter((b) => b.region).map((b) => b.name);

/** Limb chains used for two-bone IK: [rootBone, midBone, endBone, poleAxis]. */
export const IK_CHAINS = {
  armL: { root: 'shoulder_L', mid: 'elbow_L', end: 'wrist_L', pole: [0, 0, -1] },
  armR: { root: 'shoulder_R', mid: 'elbow_R', end: 'wrist_R', pole: [0, 0, -1] },
  legL: { root: 'hip_L', mid: 'knee_L', end: 'ankle_L', pole: [0, 0, 1] },
  legR: { root: 'hip_R', mid: 'knee_R', end: 'ankle_R', pole: [0, 0, 1] },
};

/** Bones whose motion leaves a weapon trail when a move requests one. */
export const TRAIL_ANCHORS = ['hand_L', 'hand_R', 'foot_L', 'foot_R', 'elbow_L', 'elbow_R', 'knee_L', 'knee_R'];

/**
 * Builds a THREE.Skeleton plus the bone array, in BONES order.
 * @returns {{ skeleton: THREE.Skeleton, bones: THREE.Bone[], byName: Record<string, THREE.Bone> }}
 */
export function createSkeleton(proportions = null) {
  const bones = [];
  const byName = Object.create(null);

  for (const def of BONES) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    const s = proportions ? scaleFor(def, proportions) : 1;
    bone.position.set(def.pos[0] * s, def.pos[1] * s, def.pos[2] * s);
    if (def.rot) bone.rotation.set(def.rot[0], def.rot[1], def.rot[2]);
    bone.userData.def = def;
    byName[def.name] = bone;
    if (def.parent) byName[def.parent].add(bone);
    bones.push(bone);
  }

  const skeleton = new THREE.Skeleton(bones);
  return { skeleton, bones, byName };
}

/**
 * Per-character proportion multipliers. Keys are coarse body groups so that a
 * character definition can say `{ legs: 1.08, arms: 0.95, torso: 1.02 }` and
 * every animation still retargets correctly.
 */
function scaleFor(def, p) {
  const n = def.name;
  if (/^(hip_|knee_|ankle_|foot_|toe_)/.test(n)) return p.legs ?? 1;
  if (/^(shoulder_|elbow_|wrist_|hand_|fingers_|thumb_|clavicle_)/.test(n)) return p.arms ?? 1;
  if (/^(spine|chest|neck)/.test(n)) return p.torso ?? 1;
  if (n === 'head' || n === 'headTop') return p.head ?? 1;
  if (n === 'hips') return p.height ?? 1;
  return 1;
}

/** Rest-pose world positions, useful for building geometry and debug views. */
export function restWorldPositions(proportions = null) {
  const { bones, byName } = createSkeleton(proportions);
  byName.root.updateMatrixWorld(true);
  const out = Object.create(null);
  for (const b of bones) out[b.name] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  return out;
}
