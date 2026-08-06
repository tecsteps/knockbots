/**
 * Knockbots — round-opening cinematics.
 *
 * These are the only clips the camera is allowed to linger on, so they are
 * authored longer and looser than anything in combat: eases are mostly `sine`
 * and `quad`, the accents land off the beat, and every one of them finishes by
 * arriving at the exact fight stance so the transition into READY is invisible.
 *
 * `i.walkOn` runs 150 ticks because that is the length of Game.PHASE.INTRO.
 *
 * Axis conventions and the pose helpers live in ./idle.js.
 */

import { STANCE, STANCE_Y, UPRIGHT, UPRIGHT_Y, add, over, makeClip, carry } from './idle.js';
import { STRIDE_LEGS } from './locomotion.js';

// ---------------------------------------------------------------------------
// i.walkOn — 2.9 metres of approach at 1.2m/s, four strides, then a deceleration
// into the stance. The torso is upright and the arms swing from the shoulder
// rather than pumping; the head is locked on the opponent from the first frame,
// which is what makes a walk read as a challenge instead of as travel.
// ---------------------------------------------------------------------------
const WALKON_TORSO = { hips: [0, 22, 0], spine01: [-2, -2, 0], spine02: [-2, -3, 0], chest: [-3, -4, 0], neck: [1, -2, 0], head: [1, -3, 0] };
const WALKON_ARM_A = {
  clavicle_L: [0, -6, -2], shoulder_L: [22, 0, -32], elbow_L: [-40, 0, 8], wrist_L: [-6, 0, 0], hand_L: [-12, 0, 0],
  clavicle_R: [0, 6, -1], shoulder_R: [-34, 0, 32], elbow_R: [-54, 0, -6], wrist_R: [-6, 0, 0], hand_R: [-12, 0, 0],
};
const WALKON_ARM_B = {
  clavicle_L: [0, -6, 1], shoulder_L: [-38, 0, -32], elbow_L: [-56, 0, 8], wrist_L: [-6, 0, 0], hand_L: [-12, 0, 0],
  clavicle_R: [0, 6, 2], shoulder_R: [26, 0, 32], elbow_R: [-38, 0, -6], wrist_R: [-6, 0, 0], hand_R: [-12, 0, 0],
};

/** One 30-tick stride pair: [phaseOffset, legs, arms, torso wobble, pelvis height]. */
const STRIDE = [
  [0, STRIDE_LEGS.leadStrike, WALKON_ARM_A, { hips: [1, -4, -2], chest: [0, 5, 2], head: [0, -3, -1] }, -0.055],
  [6, STRIDE_LEGS.leadStance, WALKON_ARM_A, { hips: [-1, -2, -1], chest: [0, 3, 1] }, -0.018],
  [11, STRIDE_LEGS.leadPush, WALKON_ARM_B, { hips: [0, 2, 1], chest: [0, -2, -1] }, -0.04],
  [15, STRIDE_LEGS.rearStrike, WALKON_ARM_B, { hips: [1, 4, 2], chest: [0, -5, -2], head: [0, 3, 1] }, -0.055],
  [21, STRIDE_LEGS.rearStance, WALKON_ARM_B, { hips: [-1, 2, 1], chest: [0, -3, -1] }, -0.018],
  [26, STRIDE_LEGS.rearPush, WALKON_ARM_A, { hips: [0, -2, -1], chest: [0, 2, 1] }, -0.04],
];

// z travel: -2.9m at tick 0, decelerating to a stop just before the stance.
const walkOnZ = (t) => (t >= 120 ? -0.26 + 0.26 * ((t - 120) / 30) ** 0.6 : -2.9 + 2.64 * (t / 120));

const walkOnFrames = [];
for (let cycle = 0; cycle < 4; cycle++) {
  for (const [off, legs, arms, wobble, y] of STRIDE) {
    const t = cycle * 30 + off;
    walkOnFrames.push({
      t,
      ease: off === 0 || off === 15 ? 'quad' : 'sine',
      pose: add(over(STANCE, legs, arms), add(WALKON_TORSO, wobble)),
      root: [0, y, walkOnZ(t)],
    });
  }
}
walkOnFrames.push(
  // Deceleration: the lead foot plants long, the pelvis drops onto it and the
  // guard comes up on the way down rather than after the feet have settled.
  { t: 124, ease: 'cubic', pose: add(over(STANCE, STRIDE_LEGS.leadStrike, WALKON_ARM_A), add(WALKON_TORSO, { hips: [4, -6, -2], spine01: [3, 0, 0], chest: [3, 6, 2], neck: [-2, 0, 0], head: [-3, -4, -1] })), root: [0, -0.075, walkOnZ(124)] },
  { t: 132, ease: 'cubic', pose: add(STANCE, { hips: [4, 6, 0], spine01: [2, 0, 0], chest: [2, -4, 2], head: [-2, 3, 0], knee_L: [10, 0, 0], knee_R: [10, 0, 0], shoulder_L: [-10, 0, -5], shoulder_R: [-8, 0, 5], elbow_L: [12, 0, 0], elbow_R: [10, 0, 0] }), root: [0, -0.135, walkOnZ(132)] },
  { t: 140, ease: 'sine', pose: add(STANCE, { chest: [-2, 0, -1], head: [-2, 0, 0], shoulder_L: [-3, 0, -2], shoulder_R: [-2, 0, 2] }), root: [0, -0.07, walkOnZ(140)] },
  { t: 150, pose: STANCE, root: [0, STANCE_Y, 0] },
);

const walkOn = makeClip('i.walkOn', { duration: 150, blendIn: 0, blendOut: 8 }, walkOnFrames);

// ---------------------------------------------------------------------------
// i.powerUp — a cold chassis coming online. Nothing moves for the first eight
// ticks; the surge then travels up the body one segment at a time, the head
// snaps up last and hardest, and the whole thing is punctuated by a compression
// on tick 60 where the fighter drops into the stance under his own weight.
// ---------------------------------------------------------------------------
const INERT = over(UPRIGHT, {
  hips: [5, -4, 0], spine01: [5, 0, 0], spine02: [5, 0, 0], chest: [6, -2, 3], neck: [8, 0, 0], head: [14, -1, 2],
  clavicle_L: [7, 0, -8], shoulder_L: [10, 0, -44], elbow_L: [-18, 0, 5], wrist_L: [16, 0, 0], hand_L: [20, 0, 0],
  clavicle_R: [7, 0, 8], shoulder_R: [12, 0, 44], elbow_R: [-15, 0, -5], wrist_R: [16, 0, 0], hand_R: [20, 0, 0],
  hip_L: [3, 6, 3], knee_L: [11, 0, 0], ankle_L: [-8, 3, 0],
  hip_R: [4, -6, -3], knee_R: [13, 0, 0], ankle_R: [-9, -3, 0],
});
const ARMS_FLUNG = {
  clavicle_L: [-9, -4, 12], shoulder_L: [34, 0, 22], elbow_L: [-30, 0, 10], wrist_L: [8, 0, 0], hand_L: [10, 0, 0],
  clavicle_R: [-9, 4, -12], shoulder_R: [36, 0, -22], elbow_R: [-26, 0, -10], wrist_R: [8, 0, 0], hand_R: [10, 0, 0],
};
const ARMS_CLENCH = {
  clavicle_L: [4, -4, -6], shoulder_L: [26, 0, -30], elbow_L: [-52, 0, -18], wrist_L: [-16, 0, 0], hand_L: [-24, 0, 0],
  clavicle_R: [4, 4, 6], shoulder_R: [28, 0, 30], elbow_R: [-48, 0, 18], wrist_R: [-16, 0, 0], hand_R: [-24, 0, 0],
};

const powerUp = makeClip('i.powerUp', { duration: 112, blendIn: 0, blendOut: 8 }, [
  { t: 0, ease: 'hold', pose: INERT, root: [0, -0.026, 0] },
  { t: 9, ease: 'quad', pose: INERT, root: [0, -0.026, 0] },
  // First twitch: the pelvis only. Everything above it is still dead.
  { t: 13, ease: 'sine', pose: add(INERT, { hips: [-5, 3, -2], hip_L: [-3, 0, 0], hip_R: [-3, 0, 0], knee_L: [4, 0, 0], knee_R: [4, 0, 0] }), root: [0, -0.045, 0] },
  { t: 20, ease: 'quad', pose: add(INERT, { hips: [-2, -1, 1] }), root: [0, -0.028, 0] },
  // The surge reaches the ribcage: chest inflates, clavicles lift, head still down.
  { t: 30, ease: 'quad', pose: add(INERT, { hips: [-4, 2, 0], spine01: [-4, 0, 0], spine02: [-4, 0, 0], chest: [-6, 1, -2], clavicle_L: [-6, 0, 7], clavicle_R: [-6, 0, -7], shoulder_L: [-6, 0, 4], shoulder_R: [-6, 0, -4] }), root: [0, -0.012, 0] },
  // Head snaps up on tick 38 — the only `snap` in the clip.
  { t: 38, ease: 'snap', pose: add(INERT, { hips: [-5, 3, 0], spine01: [-5, 0, 0], spine02: [-5, 0, 0], chest: [-8, 2, -3], neck: [-14, 0, 0], head: [-26, 1, -2] }), root: [0, -0.004, 0] },
  // Overshoot: chest thrown open, arms flung back and out.
  { t: 46, ease: 'quad', pose: add(over(INERT, ARMS_FLUNG), { hips: [-8, 4, 0], spine01: [-8, 0, 0], spine02: [-8, 0, 0], chest: [-12, 3, -4], neck: [-16, 0, 0], head: [-30, 2, -3], knee_L: [-9, 0, 0], knee_R: [-11, 0, 0] }), root: [0, 0.028, -0.02] },
  { t: 54, ease: 'expo', pose: add(over(INERT, ARMS_FLUNG), { hips: [-9, 4, 0], spine01: [-9, 0, 0], spine02: [-9, 0, 0], chest: [-13, 3, -4], neck: [-15, 0, 0], head: [-28, 2, -3] }), root: [0, 0.03, -0.02] },
  // The slam: fists clench, arms drive down, the whole chassis compresses.
  { t: 60, ease: 'cubic', pose: add(over(INERT, ARMS_CLENCH), { hips: [4, 6, 0], spine01: [-2, 0, 0], spine02: [-3, 0, 0], chest: [-4, 4, -4], neck: [-10, 0, 0], head: [-18, 3, -2], hip_L: [-26, 0, 4], knee_L: [34, 0, 0], hip_R: [-24, 0, -4], knee_R: [36, 0, 0] }), root: [0, -0.175, -0.01] },
  { t: 68, ease: 'sine', pose: add(over(INERT, ARMS_CLENCH), { hips: [-2, 8, 0], spine01: [-4, 0, 0], spine02: [-4, 0, 0], chest: [-6, 5, -4], neck: [-12, 0, 0], head: [-22, 4, -2], hip_L: [-16, 0, 3], knee_L: [20, 0, 0], hip_R: [-14, 0, -3], knee_R: [22, 0, 0] }), root: [0, -0.078, -0.01] },
  // Shoulder roll on the way into the stance.
  { t: 80, ease: 'sine', pose: add(STANCE, { clavicle_L: [-4, 0, 6], clavicle_R: [-4, 0, -6], shoulder_L: [14, 0, 8], shoulder_R: [12, 0, -8], elbow_L: [26, 0, 0], elbow_R: [22, 0, 0], chest: [-4, 0, 0], head: [-4, 0, 0] }), root: [0, STANCE_Y + 0.02, 0] },
  { t: 92, ease: 'quad', pose: add(STANCE, { clavicle_L: [3, 0, -4], clavicle_R: [3, 0, 4], shoulder_L: [-8, 0, -5], shoulder_R: [-7, 0, 5], elbow_L: [-10, 0, 0], chest: [3, 0, 0], head: [3, 0, 0] }), root: [0, STANCE_Y - 0.03, 0] },
  { t: 102, ease: 'sine', pose: add(STANCE, { chest: [-2, 0, -1], head: [-2, 0, 0], elbow_L: [4, 0, 0] }), root: [0, STANCE_Y + 0.008, 0] },
  { t: 112, pose: STANCE, root: [0, STANCE_Y, 0] },
]);

// ---------------------------------------------------------------------------
// i.stanceSet — the short intro: squared up, then one deliberate step into the
// guard. The lead foot lands before the hands arrive, and the pelvis drops
// 4cm past the stance before bouncing back up to it.
// ---------------------------------------------------------------------------
const stanceSet = makeClip('i.stanceSet', { duration: 64, blendIn: 4, blendOut: 6 }, [
  { t: 0, ease: 'sine', pose: UPRIGHT, root: [0, UPRIGHT_Y, 0] },
  { t: 10, ease: 'quad', pose: add(UPRIGHT, { hips: [2, -4, 3], spine01: [1, 2, 0], chest: [1, 3, -2], neck: [1, 2, 0], head: [2, 3, -1], hip_R: [-8, 0, 0], knee_R: [14, 0, 0], hip_L: [4, 0, 0], knee_L: [4, 0, 0] }), root: [0, -0.05, 0] },
  { t: 20, ease: 'quad', pose: add(UPRIGHT, { hips: [1, -12, 4], spine01: [1, 3, 0], spine02: [1, 3, 0], chest: [2, 4, -3], neck: [1, 3, 0], head: [3, 4, -1], hip_L: [-42, 4, 6], knee_L: [46, 0, 0], ankle_L: [-14, 0, 0], hip_R: [-4, 0, -4], knee_R: [20, 0, 0], clavicle_L: [0, -4, -2], shoulder_L: [-14, 0, -6], elbow_L: [-34, 0, 6], shoulder_R: [-10, 0, 6], elbow_R: [-32, 0, 0] }), root: [0, -0.075, 0.01] },
  { t: 29, ease: 'cubic', pose: add(STANCE, { hips: [3, 0, 0], spine01: [2, 0, 0], chest: [2, 0, 0], head: [2, 0, 0], knee_L: [10, 0, 0], knee_R: [12, 0, 0], hip_L: [-8, 0, 0], hip_R: [-8, 0, 0], shoulder_L: [8, 0, 5], shoulder_R: [7, 0, -5], elbow_L: [22, 0, 0], elbow_R: [18, 0, 0] }), root: [0, STANCE_Y - 0.045, 0.02] },
  { t: 38, ease: 'quad', pose: add(STANCE, { chest: [-2, 0, -1], head: [-3, 0, 0], shoulder_L: [-4, 0, -3], shoulder_R: [-3, 0, 3], elbow_L: [-6, 0, 0] }), root: [0, STANCE_Y + 0.018, 0.01] },
  { t: 48, ease: 'sine', pose: add(STANCE, { chest: [1, 0, 0], head: [1, 0, 0] }), root: [0, STANCE_Y - 0.008, 0] },
  { t: 64, pose: STANCE, root: [0, STANCE_Y, 0] },
]);

// ---------------------------------------------------------------------------
// i.pointTaunt — pull back, point, hold, stab once for emphasis, then clamp the
// guard shut. The head cocks away from the pointing arm so the silhouette reads
// as contempt rather than as aiming.
// ---------------------------------------------------------------------------
const POINT_ARM = {
  clavicle_L: [0, -12, 3], shoulder_L: [-54, 31, -30], elbow_L: [-33, -9, -2], wrist_L: [-8, 0, 0], hand_L: [-6, 0, 0],
  clavicle_R: [0, 4, -1], shoulder_R: [4, 0, 30], elbow_R: [-48, 0, -6], wrist_R: [-6, 0, 0], hand_R: [-10, 0, 0],
};
const POINT_TORSO = { hips: [0, 14, 0], spine01: [-3, -1, -1], spine02: [-4, -2, -1], chest: [-6, -2, -4], neck: [-1, -1, 2], head: [-3, -2, 5] };

const pointTaunt = makeClip('i.pointTaunt', { duration: 104, blendIn: 5, blendOut: 8 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 9, ease: 'expo', pose: add(STANCE, { hips: [3, -6, 0], spine01: [3, 2, 0], chest: [4, 3, 2], neck: [2, 2, 0], head: [4, 3, -2], shoulder_L: [14, 0, 6], elbow_L: [16, 0, 0], shoulder_R: [8, 0, -4] }), root: [0, STANCE_Y - 0.022, -0.02] },
  { t: 19, ease: 'quad', pose: add(over(STANCE, POINT_ARM), POINT_TORSO), root: [0, STANCE_Y + 0.012, 0.03] },
  { t: 26, ease: 'sine', pose: add(over(STANCE, POINT_ARM), add(POINT_TORSO, { chest: [1, 0, 1], head: [1, 0, -1], elbow_L: [5, 0, 0] })), root: [0, STANCE_Y + 0.006, 0.02] },
  { t: 40, ease: 'sine', pose: add(over(STANCE, POINT_ARM), add(POINT_TORSO, { spine02: [-1, 0, 0], chest: [-2, 0, 0], head: [-2, 1, 1], clavicle_L: [0, 0, 2] })), root: [0, STANCE_Y + 0.016, 0.03] },
  // The stab for emphasis: shoulder drives, elbow snaps straight, head follows.
  { t: 50, ease: 'snap', pose: add(over(STANCE, POINT_ARM), add(POINT_TORSO, { chest: [2, -3, 0], head: [3, -2, -2], shoulder_L: [4, 0, 0], elbow_L: [10, 0, 0] })), root: [0, STANCE_Y + 0.004, 0.01] },
  { t: 56, ease: 'sine', pose: add(over(STANCE, POINT_ARM), add(POINT_TORSO, { hips: [0, -3, 0], chest: [-3, 2, -1], head: [-4, 2, 2], shoulder_L: [-6, 0, -2], elbow_L: [-8, 0, 0] })), root: [0, STANCE_Y + 0.02, 0.06] },
  { t: 70, ease: 'sine', pose: add(over(STANCE, POINT_ARM), add(POINT_TORSO, { chest: [1, 0, 0], head: [1, 0, 0] })), root: [0, STANCE_Y + 0.012, 0.05] },
  { t: 82, ease: 'expo', pose: add(over(STANCE, POINT_ARM), add(POINT_TORSO, { hips: [0, -4, 0], chest: [3, 2, -2], head: [4, 2, -3], shoulder_L: [10, 0, 4], elbow_L: [-14, 0, 0] })), root: [0, STANCE_Y - 0.01, 0.01] },
  { t: 92, ease: 'cubic', pose: add(STANCE, { chest: [-3, 0, -2], head: [-3, 0, 0], clavicle_L: [0, 0, 4], shoulder_L: [-8, 0, -5], shoulder_R: [-6, 0, 5], elbow_L: [-8, 0, 0] }), root: [0, STANCE_Y + 0.014, 0] },
  { t: 104, pose: STANCE, root: [0, STANCE_Y, 0] },
]);

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
export const INTRO_CLIPS = {
  'i.walkOn': walkOn,
  'i.powerUp': powerUp,
  'i.stanceSet': stanceSet,
  'i.pointTaunt': pointTaunt,
};

// ---------------------------------------------------------------------------
// VELOCITY CARRY. See the note above `carry` in idle.js. `i.walkOn` had 64
// mid-flight interior keys and 64 of them were full stops, median carry 0.01.
// ---------------------------------------------------------------------------
for (const id in INTRO_CLIPS) carry(INTRO_CLIPS[id], { N: 2 });
