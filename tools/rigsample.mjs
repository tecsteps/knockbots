/**
 * Drive an animation clip through the real skeleton, offline, and read world
 * bone positions per tick.
 *
 * This exists because every interesting question about an animation is a
 * question about where the bones actually end up, and reading the authored
 * Euler tracks does not answer it — a clip that yaws the root -360 degrees
 * moves a foot a metre without that metre appearing in any track. Several
 * rounds of this project asserted things about clips from their source and
 * were wrong; the rule since is to measure against the rig.
 *
 * The composition here must match Animator's: `bone.quaternion = rest * clip`,
 * layered over the A-pose rest rather than replacing it. If Animator's
 * composition changes, this changes with it or every measurement taken through
 * it becomes a confident lie.
 */
import * as THREE from 'three';
import { createSkeleton, BONE_NAMES } from '../src/characters/Skeleton.js';
import { sampleClip, Pose } from '../src/characters/AnimationFormat.js';

export { BONE_NAMES };

export function makeRig() {
  const { bones, byName } = createSkeleton(null);
  const rest = Object.create(null);
  for (const b of bones) rest[b.name] = b.quaternion.clone();
  return { bones, byName, rest, pose: new Pose(BONE_NAMES) };
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Sample `clip` at tick `t`. Returns a map of bone name to world-space
 * Vector3. Root translation and yaw are applied, because for a spinning move
 * they are most of the motion.
 */
export function sampleWorld(rig, clip, t) {
  const { bones, byName, rest, pose } = rig;
  pose.reset();
  sampleClip(clip, t, pose, 1);
  for (const b of bones) {
    const w = pose.weight[b.name] || 0;
    if (w > 0) {
      _q.copy(pose.rot[b.name]);
      if (w < 1) _q.slerp(new THREE.Quaternion(), 1 - w);
      b.quaternion.copy(rest[b.name]).multiply(_q);
    } else {
      b.quaternion.copy(rest[b.name]);
    }
  }
  byName.root.position.copy(pose.rootPos);
  _e.set(0, (pose.rootYaw * Math.PI) / 180, 0);
  byName.root.quaternion.setFromEuler(_e);
  byName.root.updateMatrixWorld(true);
  const out = Object.create(null);
  for (const b of bones) out[b.name] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  return out;
}

/** Limb tips a strike can plausibly land with. */
export const STRIKERS = [
  'hand_L', 'hand_R', 'wrist_L', 'wrist_R', 'elbow_L', 'elbow_R',
  'foot_L', 'foot_R', 'ankle_L', 'ankle_R', 'knee_L', 'knee_R', 'head',
];

/**
 * For one move: how far its hitbox anchors travel from stance by the impact
 * tick, against how far the *furthest-travelling* limb travels.
 *
 * A ratio near 1 means the capsule is on the limb that swings. A ratio near 0
 * means it is on a limb standing still — the defect this measures. Returns
 * null for moves with no active window or no impact tick to measure at.
 */
export function anchorTravel(rig, move, clip) {
  if (!move.active?.length || !clip?.impact) return null;
  const stance = sampleWorld(rig, clip, 0);
  const at = sampleWorld(rig, clip, clip.impact.tick);
  const travel = (b) => (at[b] && stance[b] ? at[b].distanceTo(stance[b]) : 0);
  const anchors = [...new Set(move.active.flatMap((a) => a.boxes.map((b) => b.bone)))];
  const leader = STRIKERS.reduce((a, b) => (travel(b) > travel(a) ? b : a));
  const best = Math.max(...anchors.map(travel));
  const lead = travel(leader);
  return { anchors, best, leader, lead, ratio: lead > 1e-6 ? best / lead : 1 };
}
