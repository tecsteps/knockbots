/**
 * Knockbots — win poses.
 *
 * Three long ones for the end of a match and one short one for the end of a
 * round. All of them start from the fight stance and spend their first ten ticks
 * putting the guard away, because a fighter who drops his hands is the clearest
 * possible signal that the fight is over.
 *
 * Every pose is built around one readable silhouette held for at least half a
 * second — a raised fist, a salute, a flexed chest — with the movement either
 * side of it existing only to arrive at and leave that shape.
 *
 * Axis conventions and the pose helpers live in ./idle.js.
 */

import { STANCE, STANCE_Y, UPRIGHT, UPRIGHT_Y, add, over, makeClip, carry, contrapposto, sagittal } from './idle.js';

// ---------------------------------------------------------------------------
// Arm sets, solved against an opened-up torso.
// ---------------------------------------------------------------------------
/** Guard put away: hands low and loose, elbows off the ribs. */
const A_RELAXED = {
  clavicle_L: [2, -4, -2], shoulder_L: [-8, 4, -34], elbow_L: [-40, 0, 8], wrist_L: [-6, 0, 0], hand_L: [-12, 0, 0],
  clavicle_R: [2, 4, 2], shoulder_R: [-6, -4, 34], elbow_R: [-36, 0, -8], wrist_R: [-6, 0, 0], hand_R: [-12, 0, 0],
};
/** Both arms swept wide and slightly forward — the opening of the big pose. */
const A_SWEEP = {
  clavicle_L: [-6, -6, 8], shoulder_L: [-14, 0, 26], elbow_L: [-18, 0, 6], wrist_L: [2, 0, 0], hand_L: [4, 0, 0],
  clavicle_R: [-6, 6, -8], shoulder_R: [-12, 0, -26], elbow_R: [-16, 0, -6], wrist_R: [2, 0, 0], hand_R: [4, 0, 0],
};
/** Rear fist raised above the head, lead fist pulled in to the hip. */
const A_FIST_UP = {
  clavicle_L: [4, -6, -6], shoulder_L: [26, 0, -32], elbow_L: [-52, 22, -22], wrist_L: [-14, 0, 0], hand_L: [-20, 0, 0],
  clavicle_R: [-10, 4, -10], shoulder_R: [-82, 10, -68], elbow_R: [-49, 70, -11], wrist_R: [-8, 0, 0], hand_R: [-14, 0, 0],
};
/** Fists at the waist, elbows driven back, chest open — the flex. */
const A_POWER = {
  clavicle_L: [6, -6, -6], shoulder_L: [34, 4, -35], elbow_L: [-37, 27, -38], wrist_L: [-18, 0, 0], hand_L: [-26, 0, 0],
  clavicle_R: [6, 6, 6], shoulder_R: [32, -4, 36], elbow_R: [-32, -25, 37], wrist_R: [-18, 0, 0], hand_R: [-26, 0, 0],
};
/** Right hand flat at the temple. */
const A_SALUTE = {
  clavicle_L: [4, -2, -4], shoulder_L: [4, 0, -40], elbow_L: [-18, 0, 6], wrist_L: [-4, 0, 0], hand_L: [-8, 0, 0],
  clavicle_R: [-6, 4, -6], shoulder_R: [-50, 11, 8], elbow_R: [-81, 70, -55], wrist_R: [-10, 0, 0], hand_R: [4, 0, 0],
};
/** Arms pinned at the sides, thumbs down the seams. */
const A_ATTENTION = {
  clavicle_L: [-2, -2, 2], shoulder_L: [2, 0, -42], elbow_L: [-10, 0, 4], wrist_L: [-2, 0, 0], hand_L: [-6, 0, 0],
  clavicle_R: [-2, 2, -2], shoulder_R: [2, 0, 42], elbow_R: [-9, 0, -4], wrist_R: [-2, 0, 0], hand_R: [-6, 0, 0],
};
/** Lead fist held at eye level and turned over, being looked at. */
const A_INSPECT = {
  clavicle_L: [-2, -10, 2], shoulder_L: [-29, -2, -33], elbow_L: [-108, -70, -4], wrist_L: [-14, 0, 0], hand_L: [-18, 0, 0],
  clavicle_R: [2, 4, 2], shoulder_R: [-4, -4, 34], elbow_R: [-34, 0, -8], wrist_R: [-6, 0, 0], hand_R: [-12, 0, 0],
};

/** Chest open, pelvis square, weight even — the posture all four clips resolve to. */
const T_OPEN = { hips: [0, 22, 0], spine01: [-3, -2, 0], spine02: [-3, -3, 0], chest: [-5, -4, 2], neck: [1, -3, 0], head: [0, -4, 0] };
/** Feet a little wider and squarer than the fight stance. */
const L_PLANTED = {
  hip_L: [-16, 12, 8], knee_L: [26, 0, 0], ankle_L: [-10, 4, 0],
  hip_R: [-12, -12, -10], knee_R: [28, 0, 0], ankle_R: [-16, -6, 0],
};
const OPEN = add(over(STANCE, L_PLANTED, A_RELAXED), T_OPEN);
const OPEN_Y = -0.024;

// ---------------------------------------------------------------------------
// v.pose — the headline win. Coil, a wide sweep, the fist goes up and stays up
// for three quarters of a second, and then it comes down into a flex that the
// clip holds to the end. The pelvis rises through the sweep and drops onto the
// flex so the two shapes have opposite weight.
// ---------------------------------------------------------------------------
const pose = makeClip('v.pose', { duration: 144, blendIn: 6, blendOut: 12 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 12, ease: 'sine', pose: OPEN, root: [0, OPEN_Y, 0] },
  // Coil: arms swing down and behind, chin drops, knees soften.
  { t: 24, ease: 'expo', pose: add(OPEN, { hips: [6, 0, 0], spine01: [5, 0, 0], spine02: [5, 0, 0], chest: [6, 0, 0], neck: [4, 0, 0], head: [8, 0, 0], clavicle_L: [6, 0, -6], clavicle_R: [6, 0, 6], shoulder_L: [24, 0, 6], shoulder_R: [22, 0, -6], elbow_L: [18, 0, 0], elbow_R: [16, 0, 0], knee_L: [14, 0, 0], knee_R: [14, 0, 0], hip_L: [-10, 0, 0], hip_R: [-10, 0, 0] }), root: [0, OPEN_Y - 0.11, -0.02] },
  // Sweep: both arms open wide, spine extends, head comes up.
  { t: 34, ease: 'quad', pose: add(over(STANCE, L_PLANTED, A_SWEEP), add(T_OPEN, { hips: [-8, 0, 0], spine01: [-6, 0, 0], spine02: [-7, 0, 0], chest: [-10, 0, 0], neck: [-4, 0, 0], head: [-12, 0, 0], knee_L: [-6, 0, 0], knee_R: [-6, 0, 0] })), root: [0, OPEN_Y + 0.045, 0.01] },
  // The fist. Snap into it, then let the body settle underneath it.
  { t: 44, ease: 'cubic', pose: add(over(STANCE, L_PLANTED, A_FIST_UP), add(T_OPEN, { hips: [-10, -4, -3], spine01: [-7, 2, -2], spine02: [-8, 2, -2], chest: [-12, 4, -5], neck: [-5, 2, 1], head: [-14, 3, 2] })), root: [0, OPEN_Y + 0.055, 0.01] },
  { t: 54, ease: 'sine', pose: add(over(STANCE, L_PLANTED, A_FIST_UP), add(T_OPEN, { hips: [-7, -3, -2], spine01: [-5, 2, -1], spine02: [-6, 2, -2], chest: [-9, 4, -4], neck: [-4, 2, 1], head: [-11, 3, 2] })), root: [0, OPEN_Y + 0.03, 0.005] },
  { t: 68, ease: 'sine', pose: add(over(STANCE, L_PLANTED, A_FIST_UP), add(T_OPEN, { hips: [-8, -3, -2], spine01: [-7, 2, -1], spine02: [-8, 2, -2], chest: [-12, 4, -4], neck: [-5, 2, 1], head: [-13, 3, 2], shoulder_R: [-6, 0, -4] })), root: [0, OPEN_Y + 0.045, 0.005] },
  // Fist comes down into the flex; the whole chassis compresses onto it.
  { t: 82, ease: 'quad', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [4, 0, 0], spine01: [-4, 0, 0], spine02: [-5, 0, 0], chest: [-8, 0, 0], neck: [-2, 0, 0], head: [-6, 0, 0], knee_L: [16, 0, 0], knee_R: [16, 0, 0], hip_L: [-12, 0, 0], hip_R: [-12, 0, 0] })), root: [0, OPEN_Y - 0.095, 0] },
  { t: 92, ease: 'cubic', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [-2, 0, 0], spine01: [-7, 0, 0], spine02: [-8, 0, 0], chest: [-13, 0, 0], neck: [-4, 0, 0], head: [-10, 0, 0], shoulder_L: [6, 0, -4], shoulder_R: [6, 0, 4], knee_L: [4, 0, 0], knee_R: [4, 0, 0] })), root: [0, OPEN_Y - 0.03, 0] },
  { t: 106, ease: 'sine', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [-1, 0, 0], spine01: [-5, 0, 0], spine02: [-6, 0, 0], chest: [-10, 0, 0], neck: [-3, 0, 0], head: [-8, 0, 0] })), root: [0, OPEN_Y - 0.045, 0] },
  // Head turns to camera on the last beat.
  { t: 122, ease: 'sine', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [-1, 0, 0], spine01: [-5, 1, 0], spine02: [-6, 1, 0], chest: [-10, 2, -1], neck: [-4, 4, 0], head: [-9, 9, 1] })), root: [0, OPEN_Y - 0.038, 0] },
  { t: 144, pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [-1, 0, 0], spine01: [-5, 1, 0], spine02: [-6, 1, 0], chest: [-10, 2, -1], neck: [-4, 4, 0], head: [-8, 10, 1] })), root: [0, OPEN_Y - 0.04, 0] },
]);

// ---------------------------------------------------------------------------
// v.saluteCharge — military. Snap to attention, hold a salute for a full second,
// cut the hand away, then power down into a charging flex. The two snaps are the
// only fast moves in the clip and everything else is deliberately slow.
// ---------------------------------------------------------------------------
const ATTENTION = add(over(UPRIGHT, A_ATTENTION), { hips: [-2, 6, 0], spine01: [-3, 0, 0], spine02: [-3, 0, 0], chest: [-5, 0, 0], neck: [1, 0, 0], head: [-2, 0, 0], hip_L: [0, 4, -2], hip_R: [0, -4, 2], knee_L: [-4, 0, 0], knee_R: [-4, 0, 0] });

const saluteCharge = makeClip('v.saluteCharge', { duration: 136, blendIn: 6, blendOut: 12 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 9, ease: 'expo', pose: add(STANCE, { hips: [4, 8, 0], chest: [3, -2, 2], head: [3, -2, 0], knee_L: [10, 0, 0], knee_R: [10, 0, 0], shoulder_L: [10, 0, 6], shoulder_R: [8, 0, -6] }), root: [0, STANCE_Y - 0.04, 0] },
  // Snap to attention. The feet close first, the spine straightens after.
  { t: 16, ease: 'cubic', pose: add(ATTENTION, { spine01: [2, 0, 0], chest: [3, 0, 0], head: [3, 0, 0] }), root: [0, UPRIGHT_Y - 0.01, 0.01] },
  { t: 22, ease: 'expo', pose: ATTENTION, root: [0, UPRIGHT_Y + 0.006, 0.01] },
  // Salute: elbow leads, hand arrives two ticks later.
  { t: 28, ease: 'snap', pose: add(over(ATTENTION, A_SALUTE), { shoulder_R: [10, 0, 14], elbow_R: [22, 0, 16], head: [1, 0, 0] }), root: [0, UPRIGHT_Y + 0.006, 0.01] },
  { t: 32, ease: 'sine', pose: over(ATTENTION, A_SALUTE), root: [0, UPRIGHT_Y + 0.008, 0.01] },
  { t: 48, ease: 'sine', pose: add(over(ATTENTION, A_SALUTE), { spine01: [-1.5, 0, 0], spine02: [-1.5, 0, 0], chest: [-2, 0, 0], clavicle_L: [0, 0, 2], clavicle_R: [0, 0, -2] }), root: [0, UPRIGHT_Y + 0.018, 0.01] },
  { t: 62, ease: 'quad', pose: over(ATTENTION, A_SALUTE), root: [0, UPRIGHT_Y + 0.008, 0.01] },
  // Cut the hand away.
  { t: 68, ease: 'cubic', pose: add(ATTENTION, { shoulder_R: [-6, 0, -4], elbow_R: [-10, 0, 0], chest: [-2, 0, 1] }), root: [0, UPRIGHT_Y + 0.004, 0.01] },
  { t: 76, ease: 'quad', pose: ATTENTION, root: [0, UPRIGHT_Y, 0.01] },
  // Power down into the charge: fists clench, elbows drive back, knees bend.
  { t: 88, ease: 'quad', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [6, 0, 0], spine01: [2, 0, 0], chest: [2, 0, 0], neck: [2, 0, 0], head: [5, 0, 0], knee_L: [18, 0, 0], knee_R: [18, 0, 0], hip_L: [-14, 0, 0], hip_R: [-14, 0, 0] })), root: [0, OPEN_Y - 0.115, 0] },
  { t: 98, ease: 'expo', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [7, 0, 0], spine01: [3, 0, 0], chest: [3, 0, 0], neck: [3, 0, 0], head: [7, 0, 0], knee_L: [20, 0, 0], knee_R: [20, 0, 0], hip_L: [-15, 0, 0], hip_R: [-15, 0, 0], shoulder_L: [4, 0, -3], shoulder_R: [4, 0, 3] })), root: [0, OPEN_Y - 0.125, 0] },
  // The release: chest thrown open, head up, pelvis rises.
  { t: 106, ease: 'cubic', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [-6, 0, 0], spine01: [-9, 0, 0], spine02: [-10, 0, 0], chest: [-16, 0, 0], neck: [-5, 0, 0], head: [-14, 0, 0], shoulder_L: [10, 0, -6], shoulder_R: [10, 0, 6], knee_L: [-4, 0, 0], knee_R: [-4, 0, 0] })), root: [0, OPEN_Y + 0.03, 0] },
  { t: 120, ease: 'sine', pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [-2, 0, 0], spine01: [-6, 0, 0], spine02: [-7, 0, 0], chest: [-11, 1, 0], neck: [-3, 2, 0], head: [-9, 5, 0] })), root: [0, OPEN_Y - 0.02, 0] },
  { t: 136, pose: add(over(STANCE, L_PLANTED, A_POWER), add(T_OPEN, { hips: [-2, 0, 0], spine01: [-6, 1, 0], spine02: [-7, 1, 0], chest: [-11, 2, 0], neck: [-3, 3, 0], head: [-9, 7, 0] })), root: [0, OPEN_Y - 0.026, 0] },
]);

// ---------------------------------------------------------------------------
// v.systemsNominal — the robot one. The fighter holds up a fist, turns it over,
// opens and closes it twice, rolls the shoulders, sweeps the head across its full
// arc and gives one short nod. Read as a self-diagnostic, and it is the only
// victory clip where the head does most of the acting.
// ---------------------------------------------------------------------------
const systemsNominal = makeClip('v.systemsNominal', { duration: 148, blendIn: 6, blendOut: 12 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 12, ease: 'sine', pose: OPEN, root: [0, OPEN_Y, 0] },
  // Fist comes up to eye level and the head comes down to meet it.
  { t: 24, ease: 'quad', pose: add(over(STANCE, L_PLANTED, A_INSPECT), add(T_OPEN, { hips: [0, -6, 0], spine01: [1, 2, 0], chest: [2, 3, -3], neck: [3, 2, 0], head: [7, 3, -2] })), root: [0, OPEN_Y - 0.01, 0.01] },
  // Turn it over.
  { t: 38, ease: 'sine', pose: add(over(STANCE, L_PLANTED, A_INSPECT), add(T_OPEN, { hips: [0, -6, 0], spine01: [1, 2, 0], chest: [2, 3, -3], neck: [3, 2, 0], head: [8, 4, -2], elbow_L: [0, 44, 0], wrist_L: [0, 22, 0], hand_L: [0, 18, 0] })), root: [0, OPEN_Y - 0.008, 0.01] },
  // Open, close, open, close — the second pair faster and smaller.
  { t: 48, ease: 'quad', pose: add(over(STANCE, L_PLANTED, A_INSPECT), add(T_OPEN, { hips: [0, -6, 0], spine01: [1, 2, 0], chest: [2, 3, -3], neck: [3, 2, 0], head: [8, 4, -2], elbow_L: [0, 44, 0], wrist_L: [26, 22, 0], hand_L: [34, 18, 0] })), root: [0, OPEN_Y - 0.008, 0.01] },
  { t: 56, ease: 'snap', pose: add(over(STANCE, L_PLANTED, A_INSPECT), add(T_OPEN, { hips: [0, -6, 0], spine01: [1, 2, 0], chest: [2, 3, -3], neck: [3, 2, 0], head: [8, 4, -2], elbow_L: [-6, 44, 0], wrist_L: [-14, 22, 0], hand_L: [-20, 18, 0] })), root: [0, OPEN_Y - 0.01, 0.01] },
  { t: 63, ease: 'quad', pose: add(over(STANCE, L_PLANTED, A_INSPECT), add(T_OPEN, { hips: [0, -6, 0], spine01: [1, 2, 0], chest: [2, 3, -3], neck: [3, 2, 0], head: [8, 4, -2], elbow_L: [0, 44, 0], wrist_L: [18, 22, 0], hand_L: [24, 18, 0] })), root: [0, OPEN_Y - 0.008, 0.01] },
  { t: 69, ease: 'sine', pose: add(over(STANCE, L_PLANTED, A_INSPECT), add(T_OPEN, { hips: [0, -6, 0], spine01: [1, 2, 0], chest: [2, 3, -3], neck: [3, 2, 0], head: [7, 4, -2], elbow_L: [-6, 44, 0], wrist_L: [-14, 22, 0], hand_L: [-20, 18, 0] })), root: [0, OPEN_Y - 0.01, 0.01] },
  // Hand drops away, shoulders roll back through their full travel.
  { t: 82, ease: 'sine', pose: add(OPEN, { clavicle_L: [4, 0, -7], clavicle_R: [4, 0, 7], shoulder_L: [16, 0, 8], shoulder_R: [14, 0, -8], chest: [4, 0, 0], head: [4, 0, 0] }), root: [0, OPEN_Y - 0.012, 0] },
  { t: 94, ease: 'sine', pose: add(OPEN, { clavicle_L: [-6, 0, 9], clavicle_R: [-6, 0, -9], shoulder_L: [-10, 0, -6], shoulder_R: [-9, 0, 6], chest: [-7, 0, 0], neck: [-2, 0, 0], head: [-6, 0, 0] }), root: [0, OPEN_Y + 0.014, 0] },
  // Head sweeps left, then right, then a single short nod.
  { t: 106, ease: 'sine', pose: add(OPEN, { chest: [-2, 3, 0], neck: [-1, 8, 0], head: [-3, 18, 1] }), root: [0, OPEN_Y + 0.004, 0] },
  { t: 122, ease: 'sine', pose: add(OPEN, { chest: [-2, -3, 0], neck: [-1, -8, 0], head: [-3, -19, -1] }), root: [0, OPEN_Y + 0.004, 0] },
  { t: 132, ease: 'snap', pose: add(OPEN, { chest: [-3, 0, 0], neck: [-2, 0, 0], head: [-8, 0, 0] }), root: [0, OPEN_Y + 0.008, 0] },
  { t: 137, ease: 'cubic', pose: add(OPEN, { chest: [1, 0, 0], neck: [2, 0, 0], head: [9, 0, 0] }), root: [0, OPEN_Y - 0.006, 0] },
  { t: 148, pose: add(OPEN, { chest: [-3, 0, 0], neck: [-1, 0, 0], head: [-5, 0, 0] }), root: [0, OPEN_Y + 0.004, 0] },
]);

// ---------------------------------------------------------------------------
// v.roundWin — the short one, played between rounds while the HUD updates. Two
// fist pumps, the second smaller and faster, and back into the guard before the
// clip ends so the next round can start on top of it.
// ---------------------------------------------------------------------------
const PUMP = {
  clavicle_L: [2, -4, -3], shoulder_L: [12, 0, -20], elbow_L: [-70, 0, 6], wrist_L: [-16, 0, 0], hand_L: [-22, 0, 0],
  clavicle_R: [-8, 4, -8], shoulder_R: [-70, 8, -46], elbow_R: [-64, 40, -14], wrist_R: [-14, 0, 0], hand_R: [-20, 0, 0],
};

const roundWin = makeClip('v.roundWin', { duration: 94, blendIn: 5, blendOut: 10 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 9, ease: 'expo', pose: add(STANCE, { hips: [6, 6, 0], spine01: [4, 0, 0], chest: [5, -2, 2], neck: [3, 0, 0], head: [7, -2, 0], knee_L: [14, 0, 0], knee_R: [14, 0, 0], hip_L: [-10, 0, 0], hip_R: [-10, 0, 0], shoulder_L: [12, 0, 6], shoulder_R: [10, 0, -6] }), root: [0, STANCE_Y - 0.1, -0.02] },
  // First pump. Real elevation, arms and head arriving on the same frame.
  { t: 17, ease: 'cubic', pose: add(over(STANCE, PUMP), { hips: [-8, 14, -2], spine01: [-6, -2, -1], spine02: [-7, -3, -2], chest: [-11, -4, -4], neck: [-4, -2, 1], head: [-13, -3, 2], knee_L: [-8, 0, 0], knee_R: [-8, 0, 0] }), root: [0, STANCE_Y + 0.075, 0.01] },
  { t: 26, ease: 'quad', pose: add(over(STANCE, PUMP), { hips: [2, 12, -1], spine01: [1, -2, 0], chest: [1, -3, -3], neck: [1, -2, 0], head: [2, -3, 1], knee_L: [12, 0, 0], knee_R: [12, 0, 0], shoulder_R: [26, 0, 20], elbow_R: [22, 0, 0] }), root: [0, STANCE_Y - 0.06, 0] },
  // Second pump: shorter, sharper, no air.
  { t: 34, ease: 'cubic', pose: add(over(STANCE, PUMP), { hips: [-5, 13, -2], spine01: [-4, -2, -1], spine02: [-4, -2, -1], chest: [-7, -4, -4], neck: [-3, -2, 1], head: [-9, -3, 2] }), root: [0, STANCE_Y + 0.015, 0.005] },
  { t: 42, ease: 'sine', pose: add(over(STANCE, PUMP), { hips: [0, 12, -1], spine01: [-1, -2, 0], chest: [-2, -3, -3], neck: [0, -2, 0], head: [-2, -3, 1], shoulder_R: [12, 0, 10], elbow_R: [10, 0, 0] }), root: [0, STANCE_Y - 0.03, 0] },
  // Chest out, head up, holding the beat before the guard comes back.
  { t: 56, ease: 'sine', pose: add(over(STANCE, A_RELAXED), { hips: [-2, 18, 0], spine01: [-5, -3, 0], spine02: [-6, -3, 0], chest: [-9, -4, 2], neck: [-3, -3, 0], head: [-10, -5, 0] }), root: [0, STANCE_Y + 0.02, 0] },
  { t: 70, ease: 'quad', pose: add(over(STANCE, A_RELAXED), { hips: [-1, 12, 0], spine01: [-3, -2, 0], chest: [-5, -3, 1], neck: [-2, -2, 0], head: [-6, -3, 0] }), root: [0, STANCE_Y + 0.008, 0] },
  { t: 82, ease: 'cubic', pose: add(STANCE, { chest: [-3, 0, -2], head: [-3, 0, 0], shoulder_L: [-6, 0, -4], shoulder_R: [-5, 0, 4], elbow_L: [-6, 0, 0] }), root: [0, STANCE_Y + 0.012, 0] },
  { t: 94, pose: STANCE, root: [0, STANCE_Y, 0] },
]);

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
export const VICTORY_CLIPS = {
  'v.pose': pose,
  'v.saluteCharge': saluteCharge,
  'v.systemsNominal': systemsNominal,
  'v.roundWin': roundWin,
};

// ---------------------------------------------------------------------------
// VELOCITY CARRY. See the note above `carry` in idle.js.
// ---------------------------------------------------------------------------
for (const id in VICTORY_CLIPS) carry(VICTORY_CLIPS[id], { N: 2 });

// ---------------------------------------------------------------------------
// CONTRAPPOSTO. See the long note above `contrapposto` in ./idle.js. Amount and
// subset per clip are the largest the per-clip gate sweep accepted: extra
// grounded-foot burial >= -12 mm, extra foot skate <= 4 mm/tick, and where the
// clip carries a hitbox, <= 1 mm of striking-anchor movement at the contact
// tick and no loss of check.mjs's anchor-travel ratio.
// ---------------------------------------------------------------------------
const CONTRA_TABLE = {
  'v.pose': 1, 'v.saluteCharge': 0.3, 'v.systemsNominal': 1, 'v.roundWin': 1,
};
for (const id in CONTRA_TABLE) contrapposto(VICTORY_CLIPS[id], CONTRA_TABLE[id]);

// ---------------------------------------------------------------------------
// SAGITTAL LEAN. See the long note above `sagittal` in ./idle.js.
//
// Measured, not asserted: sagittal pitch converts to ON-SCREEN diagonal at very
// nearly 1:1 under both cameras this axis is judged through, while the coronal
// roll `contrapposto` writes converts at between -6.9 and +0.7 deg and at ~0 on
// the attack contact frames. This operator never keys `hips`, so every bone from
// the pelvis down is bit-identical -- 0.0000 mm on hips, hips, knees, ankles,
// feet and toes at every tick -- and no foot skate, burial or leg-compensation
// question arises at all.
//
// Amount is the largest the gate sweep accepted against a target of 10 deg of
// on-screen lean. No clip here carries a hitbox, so the
// only binding gate is the target itself.
// ---------------------------------------------------------------------------
const SAGITTAL_TABLE = {
  'v.pose': 14, 'v.roundWin': 14, 'v.saluteCharge': 14, 'v.systemsNominal': 14,
};
for (const id in SAGITTAL_TABLE) sagittal(VICTORY_CLIPS[id], SAGITTAL_TABLE[id]);
