/**
 * Is the off-hand's travel its OWN motion, or is the torso carrying it?
 *
 * `offhand.mjs` established the off-hand travels 727-2089 mm during attacks, so
 * "frozen" is false. `offhandspread.mjs` established it lands within 129 mm of
 * the same place whether the move was a punch or a kick, so the critic's
 * OBSERVATION is true. This separates the last ambiguity between them.
 *
 * A hand can travel two metres with a completely rigid arm, if the chest it
 * hangs off rotates. That is exactly what a critic would describe as "the arm
 * doesn't move" -- and it would be right in the sense that matters, because an
 * arm carried by the torso has no follow-through, no counterbalance and no
 * independent silhouette.
 *
 * METHOD: sample each clip twice. Once as authored. Once with the off-arm's own
 * tracks (clavicle, shoulder, elbow, wrist, hand on that side) deleted, so those
 * bones sit at their A-pose rest and the hand is carried by the torso alone. The
 * difference between the two path lengths is the arm's OWN contribution.
 *
 * CONTROLS:
 *   positive  do the same ablation to the STRIKING arm on a punch. Its path
 *             must collapse -- a straight right is almost entirely arm. If it
 *             does not, the ablation is not doing anything.
 *   null      ablate a bone the hand does not descend from (a leg). The path
 *             must be identical to 0.000000 mm.
 */
import { makeRig, sampleWorld } from './rigsample.mjs';
import { CLIPS } from '../src/characters/animations/index.js';

const rig = makeRig();

function pathLen(clip, bone) {
  let prev = null; let sum = 0;
  for (let t = 0; t <= (clip.duration ?? 0); t++) {
    const p = sampleWorld(rig, clip, t)[bone];
    if (!p) return null;
    if (prev) sum += p.distanceTo(prev) * 1000;
    prev = p.clone();
  }
  return sum;
}

/** A shallow copy of `clip` with the named tracks removed. */
function ablate(clip, bones) {
  const tracks = {};
  for (const b in clip.tracks) if (!bones.includes(b)) tracks[b] = clip.tracks[b];
  return { ...clip, tracks };
}

const armOf = (s) => [`clavicle_${s}`, `shoulder_${s}`, `elbow_${s}`, `wrist_${s}`, `hand_${s}`];

// --- null control ----------------------------------------------------------
const nullClip = ablate(CLIPS['p.straight'], ['hip_L', 'knee_L', 'ankle_L']);
const nullDelta = Math.abs(pathLen(CLIPS['p.straight'], 'hand_R') - pathLen(nullClip, 'hand_R'));
console.log(`null control (ablate the LEFT LEG, measure hand_R): ${nullDelta.toFixed(6)} mm ${nullDelta === 0 ? 'OK' : 'VIOLATED'}`);
if (nullDelta !== 0) process.exit(1);

// --- positive control ------------------------------------------------------
const pFull = pathLen(CLIPS['p.straight'], 'hand_R');
const pAbl = pathLen(ablate(CLIPS['p.straight'], armOf('R')), 'hand_R');
const pOwn = 100 * (1 - pAbl / pFull);
console.log(`positive control (ablate the STRIKING arm on p.straight): ${pFull.toFixed(0)} -> ${pAbl.toFixed(0)} mm, ${pOwn.toFixed(0)}% was the arm's own ${pOwn > 50 ? 'OK' : 'VIOLATED'}`);

// --- the measurement -------------------------------------------------------
const CASES = [
  ['p.jab', 'R'], ['p.straight', 'L'], ['p.uppercut', 'L'],
  ['k.lowKick', 'L'], ['k.midKick', 'L'], ['k.highKick', 'L'], ['k.roundhouse', 'L'],
  ['loco.runFwd', 'L'], ['loco.walkFwd', 'L'],
];

console.log('\nclip              off-hand(mm)  carried-only(mm)   own%   has own tracks?');
for (const [id, side] of CASES) {
  const c = CLIPS[id];
  const bone = `hand_${side}`;
  const full = pathLen(c, bone);
  const carried = pathLen(ablate(c, armOf(side)), bone);
  const own = full > 0 ? 100 * (1 - carried / full) : 0;
  const has = armOf(side).filter((b) => c.tracks[b] && c.tracks[b].length > 1);
  console.log(
    `${id.padEnd(17)} ${full.toFixed(0).padStart(9)} ${carried.toFixed(0).padStart(16)} ${own.toFixed(0).padStart(6)}%   ${has.length ? has.join(',') : 'NONE — carried entirely by the torso'}`,
  );
}
