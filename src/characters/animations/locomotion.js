/**
 * Knockbots — locomotion clips.
 *
 * Ground contacts are solved, not eyeballed: every planted foot in these clips
 * sits within a couple of centimetres of a real floor position for the pelvis
 * height on that frame, so the animator's foot IK has almost nothing to correct
 * and the fighter does not skate.
 *
 * The walks are treadmill clips — the fighter's world velocity is driven by the
 * simulation, so a planted foot travels BACKWARD through model space at exactly
 * the body's speed and the swinging foot catches back up. The dashes, hops and
 * sidesteps are the opposite: they carry real root motion, because their
 * displacement is part of the move, not part of a velocity.
 *
 * Axis conventions and the pose helpers live in ./idle.js.
 */

import { STANCE, STANCE_Y, CROUCH, CROUCH_Y, add, over, makeClip } from './idle.js';

/** Fold a solved leg set and a torso offset onto the fight stance. */
const step = (legs, torso) => (torso ? add(over(STANCE, legs), torso) : over(STANCE, legs));

// ---------------------------------------------------------------------------
// Solved leg sets. Names describe the contact, not the frame number, so they can
// be reused between clips.
// ---------------------------------------------------------------------------

// Forward walk — a 48-tick shuffle. The stance opens to 0.74m and closes to
// 0.41m once per cycle; the rear foot swings first, the lead foot second.
const W_SPREAD = { hip_L: [-34.8, -6, 11.4], knee_L: [22.5, 0, 0], ankle_L: [17, 9, 0], hip_R: [-9.1, -1.1, -12], knee_R: [50, 0, 0], ankle_R: [-37.3, -12.1, 0] };
const W_REAR_OFF = { hip_L: [-35.5, -0.2, 11], knee_L: [27.3, 0, 0], ankle_L: [11.1, 6.6, 0], hip_R: [-12.2, 0.8, -12], knee_R: [56.5, 0, 0], ankle_R: [-29.1, -4.7, 0] };
const W_REAR_SWING = { hip_L: [-33.4, 5.9, 11], knee_L: [25.6, 0, 0], ankle_L: [9.2, 3.8, 0], hip_R: [-22.5, -2.2, -12], knee_R: [67.7, 0, 0], ankle_R: [-27.8, 2.3, 0] };
const W_CLOSED = { hip_L: [-31.6, 14, 11], knee_L: [27.3, 0, 0], ankle_L: [4.2, -0.7, 0], hip_R: [-22.2, -18.8, -12], knee_R: [47.2, 0, 0], ankle_R: [-26.2, 2.1, 0] };
const W_LEAD_OFF = { hip_L: [-40.6, 5.8, 11], knee_L: [45.2, 0, 0], ankle_L: [8.5, 5.6, 0], hip_R: [-19.9, -14.7, -12.7], knee_R: [49.3, 0, 0], ankle_R: [-29.6, -0.2, 0] };
const W_LEAD_SWING = { hip_L: [-49.4, -2.2, 11], knee_L: [55.1, 0, 0], ankle_L: [13.8, 6.4, 0], hip_R: [-17.9, -8.8, -12], knee_R: [52.1, 0, 0], ankle_R: [-32.9, -5.1, 0] };

// Explosive sets shared by the dashes, the jump and the skid.
const L_COIL = { hip_L: [-59.3, -3.2, 11], knee_L: [81, 0, 0], ankle_L: [-19.7, 3.6, 0], hip_R: [-25.6, 4.6, -12], knee_R: [85.4, 0, 0], ankle_R: [-55, -13.2, 0] };
const L_DRIVE = { hip_L: [-47.1, 4.7, 11], knee_L: [62.1, 0, 0], ankle_L: [-0.6, 4.3, 0], hip_R: [25.8, 3.9, -15.7], knee_R: [2.1, 0, 0], ankle_R: [9.8, -4.7, 0] };
const L_PLANT = { hip_L: [-30, -1.3, 14.5], knee_L: [4.5, 0, 0], ankle_L: [31.3, 5.9, 0], hip_R: [-24.6, 1.7, -12], knee_R: [75, 0, 0], ankle_R: [-29.7, -3.2, 0] };
const L_TUCK = { hip_L: [-57.4, -0.7, 11], knee_L: [88.1, 0, 0], ankle_L: [-8.7, 1.2, 0], hip_R: [-31.3, -4.3, -12], knee_R: [74.8, 0, 0], ankle_R: [-19.3, 1.4, 0] };
const L_ABSORB = { hip_L: [-62.5, -5.6, 11], knee_L: [89.3, 0, 0], ankle_L: [-24.3, 3.2, 0], hip_R: [-32.3, 5, -12], knee_R: [95.4, 0, 0], ankle_R: [-58.4, -12.1, 0] };
const L_EXTEND = { hip_L: [-21.4, 33.6, 10.5], knee_L: [9.8, 0, 0], ankle_L: [31, -10.8, 0], hip_R: [-5.1, -23.3, -11.8], knee_R: [19.7, 0, 0], ankle_R: [8.3, 10, 0] };
const L_HOP = { hip_L: [-52.8, -1.5, 11], knee_L: [73, 0, 0], ankle_L: [0.7, 1.1, 0], hip_R: [-23.8, -4.5, -12], knee_R: [63.5, 0, 0], ankle_R: [-19.1, -0.7, 0] };
const L_SKID = { hip_L: [-43.2, -6, 15.7], knee_L: [26.3, 0, 0], ankle_L: [10.9, 2.3, 0], hip_R: [-27.4, -0.3, -12], knee_R: [74.8, 0, 0], ankle_R: [-36.1, -7.3, 0] };

// Sidesteps: the leading foot reaches across, the trailing foot gathers.
const L_SIDE_L_PUSH = { hip_L: [-42.3, 13.5, 34.3], knee_L: [43.7, 0, 0], ankle_L: [6.3, -10.3, 0], hip_R: [-11.2, -2.5, -12], knee_R: [51.1, 0, 0], ankle_R: [-36.7, -10.7, 0] };
const L_SIDE_L_GATHER = { hip_L: [-22.2, -5.8, 20.5], knee_L: [24.9, 0, 0], ankle_L: [4.8, 6.7, 0], hip_R: [-13.2, -23.6, -12], knee_R: [59.8, 0, 0], ankle_R: [-35, 16.4, 0] };
const L_SIDE_R_PUSH = { hip_L: [-33.7, -6, 11.4], knee_L: [20.6, 0, 0], ankle_L: [17.9, 9.1, 0], hip_R: [-29.8, -12.6, -34.8], knee_R: [47.9, 0, 0], ankle_R: [-8.9, 11.3, 0] };
const L_SIDE_R_GATHER = { hip_L: [-49.8, 22.7, 11], knee_L: [38.1, 0, 0], ankle_L: [22.9, -3.8, 0], hip_R: [-9, 5.7, -20.7], knee_R: [30.8, 0, 0], ankle_R: [-11.5, -15.9, 0] };

// Crouch shuffle, solved against CROUCH rather than STANCE.
const C_SPREAD = { hip_L: [-80.7, -1.6, 20.2], knee_L: [97.8, 0, 0], ankle_L: [-20, -7.8, 0], hip_R: [-34.8, -1.5, -28], knee_R: [105.1, 0, 0], ankle_R: [-68.9, 4.2, 0] };
const C_REAR_SWING = { hip_L: [-75.9, -2, 17.1], knee_L: [98, 0, 0], ankle_L: [-24.9, -4.6, 0], hip_R: [-46.6, -3.1, -30.5], knee_R: [113.8, 0, 0], ankle_R: [-52.3, 18.7, 0] };
const C_CLOSED = { hip_L: [-73.1, 1.2, 18], knee_L: [99.7, 0, 0], ankle_L: [-30, -5.2, 0], hip_R: [-59.4, -19.3, -46.9], knee_R: [108.5, 0, 0], ankle_R: [-60.7, 30.2, 0] };
const C_LEAD_SWING = { hip_L: [-84.5, -3.4, 19.2], knee_L: [107.2, 0, 0], ankle_L: [-10.1, -5.7, 0], hip_R: [-45.5, -8.8, -34.2], knee_R: [107.4, 0, 0], ankle_R: [-65.3, 14.9, 0] };

// Full run, 32-tick cycle, pelvis nearly square so the stride can open up.
const R_L_STRIKE = { hip_L: [-39, 17, 7.1], knee_L: [23.7, 0, 0], ankle_L: [10.6, -13.8, 0], hip_R: [-3.1, -17, -11.1], knee_R: [42.8, 0, 0], ankle_R: [-12.7, 14.3, 0] };
const R_L_STANCE = { hip_L: [-28.8, 17, 5.8], knee_L: [29.3, 0, 0], ankle_L: [-4.1, -14.6, 0], hip_R: [-40.5, -8.8, -11.3], knee_R: [90.6, 0, 0], ankle_R: [-27, 9.1, 0] };
const R_L_PUSH = { hip_L: [-26.7, 14.4, 7], knee_L: [56.7, 0, 0], ankle_L: [-4.2, -8.8, 0], hip_R: [-54.8, 3.4, 4.7], knee_R: [63.1, 0, 0], ankle_R: [-6.6, -11, 0] };
const R_R_STRIKE = { hip_L: [0.4, 17, 2.9], knee_L: [42, 0, 0], ankle_L: [-14.1, -13.1, 0], hip_R: [-33, 17, 4.5], knee_R: [8.7, 0, 0], ankle_R: [20.4, -22.7, 0] };
const R_R_STANCE = { hip_L: [-39.3, 11.6, 9.6], knee_L: [90.7, 0, 0], ankle_L: [-28.4, -8.9, 0], hip_R: [-27.9, -17, -2.4], knee_R: [25.4, 0, 0], ankle_R: [-0.6, 6.3, 0] };
const R_R_PUSH = { hip_L: [-55.9, 12.2, 11], knee_L: [64.7, 0, 0], ankle_L: [-8, -11.3, 0], hip_R: [-28.5, -6.8, -4.7], knee_R: [56.7, 0, 0], ankle_R: [-2.1, 2.1, 0] };

/**
 * The six run contacts, exported so the intro walk-on can borrow a real stride
 * instead of duplicating six solved leg sets. Keyed by contact, not by frame.
 * @type {Record<string, Record<string, [number, number, number]>>}
 */
export const STRIDE_LEGS = {
  leadStrike: R_L_STRIKE, leadStance: R_L_STANCE, leadPush: R_L_PUSH,
  rearStrike: R_R_STRIKE, rearStance: R_R_STANCE, rearPush: R_R_PUSH,
};

// ---------------------------------------------------------------------------
// Arm sets. Absolute, because these leave the guard entirely.
// ---------------------------------------------------------------------------
const ARMS_BACKSWING = {
  clavicle_L: [3, -4, -5], shoulder_L: [30, 0, -40], elbow_L: [-25, 0, 6], wrist_L: [-4, 0, 0], hand_L: [-10, 0, 0],
  clavicle_R: [3, 4, 5], shoulder_R: [30, 0, 40], elbow_R: [-25, 0, -6], wrist_R: [-4, 0, 0], hand_R: [-10, 0, 0],
};
const ARMS_UPSWING = {
  clavicle_L: [-4, -2, 7], shoulder_L: [-102, 0, -18], elbow_L: [-32, 0, 10], wrist_L: [-6, 0, 0], hand_L: [-12, 0, 0],
  clavicle_R: [-4, 2, -7], shoulder_R: [-102, 0, 18], elbow_R: [-32, 0, -10], wrist_R: [-6, 0, 0], hand_R: [-12, 0, 0],
};
const ARMS_AIR = {
  clavicle_L: [0, -6, 2], shoulder_L: [-42, 0, -10], elbow_L: [-74, 0, 16], wrist_L: [-8, 0, 0], hand_L: [-14, 0, 0],
  clavicle_R: [0, 6, -2], shoulder_R: [-32, 0, 10], elbow_R: [-90, 0, -8], wrist_R: [-8, 0, 0], hand_R: [-14, 0, 0],
};
const ARMS_FLARE = {
  clavicle_L: [4, -6, -2], shoulder_L: [-62, 0, -14], elbow_L: [-56, 0, 20], wrist_L: [-14, 0, 0], hand_L: [-18, 0, 0],
  clavicle_R: [4, 6, 2], shoulder_R: [-54, 0, 14], elbow_R: [-60, 0, -14], wrist_R: [-14, 0, 0], hand_R: [-18, 0, 0],
};
const ARMS_REACH = {
  clavicle_L: [-2, -8, 5], shoulder_L: [-92, 0, -22], elbow_L: [-40, 0, 12], wrist_L: [-10, 0, 0], hand_L: [-14, 0, 0],
  clavicle_R: [-2, 8, -5], shoulder_R: [-86, 0, 22], elbow_R: [-46, 0, -10], wrist_R: [-10, 0, 0], hand_R: [-14, 0, 0],
};
// Contralateral run pump: A is left-arm-back, B is left-arm-forward.
const RUN_ARM_A = {
  clavicle_L: [0, -8, -3], shoulder_L: [16, 0, -26], elbow_L: [-86, 0, 10], wrist_L: [-8, 0, 0], hand_L: [-14, 0, 0],
  clavicle_R: [0, 8, -2], shoulder_R: [-66, 0, 26], elbow_R: [-98, 0, -6], wrist_R: [-8, 0, 0], hand_R: [-14, 0, 0],
};
const RUN_ARM_B = {
  clavicle_L: [0, -8, 2], shoulder_L: [-70, 0, -26], elbow_L: [-98, 0, 12], wrist_L: [-8, 0, 0], hand_L: [-14, 0, 0],
  clavicle_R: [0, 8, 3], shoulder_R: [20, 0, 26], elbow_R: [-86, 0, -8], wrist_R: [-8, 0, 0], hand_R: [-14, 0, 0],
};
const RUN_TORSO = { hips: [5, 20, 0], spine01: [4, -2, 0], spine02: [4, -3, 0], chest: [4, -4, 2], neck: [-4, -1, 0], head: [-7, -2, 0] };

// ---------------------------------------------------------------------------
// loco.walkFwd — the fighting shuffle. The pelvis dips 5cm at full stride and
// rises as the feet close, the shoulders counter-rotate two degrees against the
// hips, and the head is pinned on the opponent throughout: a fighter walking
// forward never looks at his feet.
// ---------------------------------------------------------------------------
const walkFwd = makeClip('loco.walkFwd', { duration: 48, loop: true, blendIn: 6, blendOut: 6 }, [
  { t: 0, ease: 'quad', pose: step(W_SPREAD, { hips: [0, -3, 1], chest: [0, 3, -1], neck: [0, -1, 0], head: [-1, 1, 0], shoulder_L: [3, 0, 0], shoulder_R: [-2, 0, 0] }), root: [0, -0.098, 0] },
  { t: 8, ease: 'sine', pose: step(W_REAR_OFF, { hips: [0, -1, 0], chest: [0, 1, 0], head: [-1, 0, 0], shoulder_L: [1, 0, 0] }), root: [0, -0.086, 0] },
  { t: 14, ease: 'sine', pose: step(W_REAR_SWING, { hips: [0, 2, -1], chest: [0, -2, 1], head: [0, 0, 0], shoulder_R: [2, 0, 0] }), root: [0, -0.068, 0] },
  { t: 24, ease: 'quad', pose: step(W_CLOSED, { hips: [0, 4, -1], chest: [0, -3, 1], neck: [0, 1, 0], head: [1, 0, 0], shoulder_R: [3, 0, 0] }), root: [0, -0.05, 0] },
  { t: 32, ease: 'sine', pose: step(W_LEAD_OFF, { hips: [0, 1, 0], chest: [0, -1, 0], head: [0, 0, 0] }), root: [0, -0.062, 0] },
  { t: 38, ease: 'sine', pose: step(W_LEAD_SWING, { hips: [0, -2, 1], chest: [0, 2, -1], head: [-1, 1, 0], shoulder_L: [2, 0, 0] }), root: [0, -0.078, 0] },
]);

// ---------------------------------------------------------------------------
// loco.walkBack — the same contacts run in reverse so the retreat is a genuine
// step-back rather than a mirrored walk, plus the things that only happen going
// backwards: the chest stays behind the hips, the guard rides higher because
// nothing is being thrown, and the chin pulls in.
// ---------------------------------------------------------------------------
const BACK_TORSO = {
  spine01: [-3, 0, 0], spine02: [-3, 0, 0], chest: [-3, 0, 0], neck: [3, 0, 0], head: [4, 0, 0],
  clavicle_L: [0, 0, 3], shoulder_L: [-5, 0, -3], elbow_L: [-6, 0, 0],
  clavicle_R: [0, 0, -3], shoulder_R: [-5, 0, 3], elbow_R: [-4, 0, 0],
};
const walkBack = makeClip('loco.walkBack', { duration: 48, loop: true, blendIn: 6, blendOut: 6 }, [
  { t: 0, ease: 'quad', pose: step(W_SPREAD, add(BACK_TORSO, { hips: [0, 3, -1], chest: [0, -2, 1] })), root: [0, -0.098, 0] },
  { t: 10, ease: 'sine', pose: step(W_LEAD_SWING, add(BACK_TORSO, { hips: [0, 1, 0], chest: [0, -1, 0] })), root: [0, -0.078, 0] },
  { t: 18, ease: 'sine', pose: step(W_LEAD_OFF, BACK_TORSO), root: [0, -0.062, 0] },
  { t: 24, ease: 'quad', pose: step(W_CLOSED, add(BACK_TORSO, { hips: [0, -3, 1], chest: [0, 3, -1], head: [0, 1, 0] })), root: [0, -0.05, 0] },
  { t: 34, ease: 'sine', pose: step(W_REAR_SWING, add(BACK_TORSO, { hips: [0, -1, 0], chest: [0, 1, 0] })), root: [0, -0.068, 0] },
  { t: 42, ease: 'sine', pose: step(W_REAR_OFF, add(BACK_TORSO, { hips: [0, 1, 0], chest: [0, -1, 0] })), root: [0, -0.086, 0] },
]);

// ---------------------------------------------------------------------------
// loco.dashFwd — 0.94m in 24 ticks. Three ticks of coil that dip the pelvis 16cm
// and rock the weight onto the rear foot, six ticks of drive with the rear leg
// snapped straight behind and the chest ahead of the hips, then the lead foot
// stabs out to catch the body and the guard re-forms on the settle.
// ---------------------------------------------------------------------------
const dashFwd = makeClip('loco.dashFwd', { duration: 24, blendIn: 3, blendOut: 5 }, [
  { t: 0, ease: 'expo', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 4, ease: 'snap', pose: step(L_COIL, { spine01: [4, 0, 0], spine02: [4, 0, 0], chest: [3, -3, 0], neck: [-3, 0, 0], head: [-5, 0, 0], shoulder_L: [10, 0, 3], elbow_L: [10, 0, 0], shoulder_R: [8, 0, -3] }), root: [0, -0.245, -0.03] },
  { t: 9, ease: 'quad', pose: step(L_DRIVE, { hips: [8, -6, 0], spine01: [5, 0, 0], spine02: [5, 0, 0], chest: [4, 4, -4], neck: [-5, 0, 0], head: [-8, 2, 0], clavicle_L: [0, 4, -4], shoulder_L: [26, 0, 6], elbow_L: [24, 0, -6], clavicle_R: [0, -6, 4], shoulder_R: [-34, 0, -8], elbow_R: [30, 0, 4] }), root: [0, -0.055, 0.36] },
  { t: 15, ease: 'cubic', pose: step(L_PLANT, { hips: [4, 4, 0], spine01: [2, 0, 0], chest: [1, -3, 2], neck: [-2, 0, 0], head: [-3, -1, 0], shoulder_L: [-12, 0, -4], elbow_L: [-8, 0, 4], shoulder_R: [14, 0, 6], elbow_R: [-6, 0, 0] }), root: [0, -0.105, 0.74] },
  { t: 19, ease: 'cubic', pose: step(L_ABSORB, { chest: [2, 0, -2], head: [1, 0, 0], shoulder_L: [-4, 0, -2], shoulder_R: [4, 0, 2] }), root: [0, -0.15, 0.89] },
  { t: 24, pose: STANCE, root: [0, STANCE_Y, 0.94] },
]);

// ---------------------------------------------------------------------------
// loco.dashBack — 1.08m of backdash. A three-tick fake forward, then both feet
// leave the floor together, the knees tuck, the guard clamps shut and the chest
// pulls behind the hips; the landing is taken on the rear foot and rolled onto
// the lead one.
// ---------------------------------------------------------------------------
const dashBack = makeClip('loco.dashBack', { duration: 26, blendIn: 3, blendOut: 5 }, [
  { t: 0, ease: 'expo', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 3, ease: 'snap', pose: add(STANCE, { hips: [3, 0, 0], spine01: [3, 0, 0], chest: [3, 0, 0], head: [-2, 0, 0], knee_L: [8, 0, 0], knee_R: [8, 0, 0], hip_L: [-6, 0, 0], hip_R: [-6, 0, 0] }), root: [0, -0.13, 0.035] },
  { t: 9, ease: 'quad', pose: step(L_HOP, { hips: [-6, 0, 0], spine01: [-4, 0, 0], spine02: [-4, 0, 0], chest: [-5, -2, 0], neck: [4, 0, 0], head: [6, 1, 0], clavicle_L: [0, 0, 4], shoulder_L: [-6, 0, -6], elbow_L: [-8, 0, 4], clavicle_R: [0, 0, -4], shoulder_R: [-8, 0, 6], elbow_R: [-4, 0, 0] }), root: [0, -0.02, -0.52] },
  { t: 14, ease: 'quad', pose: step(L_TUCK, { hips: [-4, 0, 0], spine01: [-3, 0, 0], chest: [-3, -1, 0], neck: [3, 0, 0], head: [4, 0, 0], shoulder_L: [-4, 0, -4], shoulder_R: [-5, 0, 4] }), root: [0, -0.012, -0.81] },
  { t: 19, ease: 'cubic', pose: step(L_ABSORB, { hips: [4, 0, 0], spine01: [3, 0, 0], chest: [4, 0, -2], neck: [-2, 0, 0], head: [-3, 0, 0], shoulder_L: [6, 0, 4], shoulder_R: [6, 0, -4] }), root: [0, -0.205, -1.03] },
  { t: 26, pose: STANCE, root: [0, STANCE_Y, -1.08] },
]);

// ---------------------------------------------------------------------------
// loco.sidestepLeft / Right — 0.62m of lateral travel in 28 ticks. The pelvis
// leads, the torso counter-rotates so the fighter never stops facing the
// opponent, and the trailing foot is dragged in rather than stepped.
// ---------------------------------------------------------------------------
const sidestepLeft = makeClip('loco.sidestepLeft', { duration: 28, blendIn: 4, blendOut: 6 }, [
  { t: 0, ease: 'expo', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 4, ease: 'snap', pose: add(STANCE, { hips: [2, 0, -5], chest: [0, 2, 4], head: [0, 2, 2], knee_R: [10, 0, 0], hip_R: [-8, 0, 0], shoulder_R: [-4, 0, 2] }), root: [0.02, -0.118, 0] },
  { t: 11, ease: 'quad', pose: step(L_SIDE_L_PUSH, { hips: [0, 9, 4], spine01: [0, -3, -2], spine02: [0, -3, -2], chest: [0, -4, -3], neck: [0, 2, 0], head: [0, 3, -1], clavicle_L: [0, 0, -3], shoulder_L: [4, 0, 5], shoulder_R: [-3, 0, -3] }), root: [0.3, -0.098, 0] },
  { t: 18, ease: 'quad', pose: step(L_SIDE_L_GATHER, { hips: [0, 6, 2], spine01: [0, -2, -1], chest: [0, -3, -2], head: [0, 2, -1], shoulder_L: [2, 0, 3] }), root: [0.52, -0.082, 0] },
  { t: 23, ease: 'cubic', pose: add(STANCE, { hips: [2, -2, 2], chest: [1, 1, -2], head: [1, 0, 0], knee_L: [8, 0, 0], knee_R: [8, 0, 0] }), root: [0.61, -0.115, 0] },
  { t: 28, pose: STANCE, root: [0.62, STANCE_Y, 0] },
]);

const sidestepRight = makeClip('loco.sidestepRight', { duration: 28, blendIn: 4, blendOut: 6 }, [
  { t: 0, ease: 'expo', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 4, ease: 'snap', pose: add(STANCE, { hips: [2, 0, 5], chest: [0, -2, -4], head: [0, -2, -2], knee_L: [10, 0, 0], hip_L: [-8, 0, 0], shoulder_L: [-4, 0, -2] }), root: [-0.02, -0.118, 0] },
  { t: 11, ease: 'quad', pose: step(L_SIDE_R_PUSH, { hips: [0, -9, -4], spine01: [0, 3, 2], spine02: [0, 3, 2], chest: [0, 4, 3], neck: [0, -2, 0], head: [0, -3, 1], clavicle_R: [0, 0, 3], shoulder_R: [4, 0, -5], shoulder_L: [-3, 0, 3] }), root: [-0.3, -0.098, 0] },
  { t: 18, ease: 'quad', pose: step(L_SIDE_R_GATHER, { hips: [0, -6, -2], spine01: [0, 2, 1], chest: [0, 3, 2], head: [0, -2, 1], shoulder_R: [2, 0, -3] }), root: [-0.52, -0.082, 0] },
  { t: 23, ease: 'cubic', pose: add(STANCE, { hips: [2, 2, -2], chest: [1, -1, 2], head: [1, 0, 0], knee_L: [8, 0, 0], knee_R: [8, 0, 0] }), root: [-0.61, -0.115, 0] },
  { t: 28, pose: STANCE, root: [-0.62, STANCE_Y, 0] },
]);

// ---------------------------------------------------------------------------
// loco.jumpStart — coil and launch. The arms swing down and behind on the coil
// and whip up on the extension; that counter-swing is where the height reads
// from, not the legs.
// ---------------------------------------------------------------------------
const jumpStart = makeClip('loco.jumpStart', { duration: 14, blendIn: 3, blendOut: 3 }, [
  { t: 0, ease: 'expo', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 6, ease: 'snap', pose: over(add(STANCE, { hips: [10, 0, 0], spine01: [7, 0, 0], spine02: [7, 0, 0], chest: [7, -2, 0], neck: [-6, 0, 0], head: [-9, 0, 0] }), L_COIL, ARMS_BACKSWING), root: [0, -0.25, -0.02] },
  { t: 11, ease: 'quad', pose: over(add(STANCE, { hips: [-6, 0, 0], spine01: [-3, 0, 0], spine02: [-3, 0, 0], chest: [-4, 0, 0], neck: [2, 0, 0], head: [3, 0, 0] }), L_EXTEND, ARMS_UPSWING), root: [0, 0.005, 0.02] },
  { t: 14, pose: over(add(STANCE, { hips: [-3, 0, 0], chest: [-2, 0, 0] }), L_TUCK, ARMS_UPSWING), root: [0, 0.1, 0.03] },
]);

// ---------------------------------------------------------------------------
// loco.jumpAir — airborne hold. Nothing is in contact so everything drifts:
// the knees settle a few degrees, the arms float outward and the torso rolls
// very slowly. Loops so air time can be any length.
// ---------------------------------------------------------------------------
const jumpAir = makeClip('loco.jumpAir', { duration: 44, loop: true, blendIn: 5, blendOut: 5 }, [
  { t: 0, ease: 'sine', pose: over(add(STANCE, { hips: [-2, 0, 1], spine01: [-2, 0, 0], chest: [-3, -2, 1], neck: [2, 0, 0], head: [3, 1, 0] }), L_TUCK, ARMS_AIR), root: [0, 0.09, 0] },
  { t: 12, ease: 'sine', pose: over(add(STANCE, { hips: [1, 3, -1], spine01: [-1, -1, 0], chest: [-1, -3, -1], neck: [1, 1, 0], head: [2, 2, 1], knee_L: [-8, 0, 0], knee_R: [6, 0, 0], shoulder_L: [-6, 0, -4], shoulder_R: [5, 0, 3] }), L_TUCK, ARMS_AIR), root: [0, 0.105, 0.01] },
  { t: 24, ease: 'sine', pose: over(add(STANCE, { hips: [3, 1, -2], spine01: [1, 1, 0], chest: [2, 1, -2], neck: [-1, -1, 0], head: [-2, -2, -1], knee_L: [4, 0, 0], knee_R: [-9, 0, 0], shoulder_L: [7, 0, 5], shoulder_R: [-6, 0, -4] }), L_TUCK, ARMS_AIR), root: [0, 0.085, -0.01] },
  { t: 34, ease: 'sine', pose: over(add(STANCE, { hips: [0, -2, 0], chest: [0, 2, 1], head: [1, -1, 0], knee_L: [-3, 0, 0], knee_R: [-3, 0, 0], shoulder_L: [2, 0, 2], shoulder_R: [-2, 0, -1] }), L_TUCK, ARMS_AIR), root: [0, 0.08, 0] },
]);

// ---------------------------------------------------------------------------
// loco.jumpLand — the whole point is the absorb. Contact on tick 3, pelvis
// bottoms out 20cm below the stance on tick 8 with the chest folded over it and
// the arms thrown forward for balance, then a slightly overshot rise.
// ---------------------------------------------------------------------------
const jumpLand = makeClip('loco.jumpLand', { duration: 20, blendIn: 2, blendOut: 6 }, [
  { t: 0, ease: 'quad', pose: over(add(STANCE, { chest: [-2, 0, 0], head: [2, 0, 0] }), L_EXTEND, ARMS_AIR), root: [0, 0.07, 0] },
  { t: 3, ease: 'snap', pose: over(add(STANCE, { hips: [4, 0, 0], spine01: [3, 0, 0], chest: [4, 0, 0], neck: [-2, 0, 0], head: [-3, 0, 0] }), L_PLANT, ARMS_FLARE), root: [0, -0.09, 0] },
  { t: 8, ease: 'cubic', pose: over(add(STANCE, { hips: [14, 0, 0], spine01: [9, 0, 0], spine02: [9, 0, 0], chest: [9, -2, 0], neck: [-6, 0, 0], head: [-10, 0, 0] }), L_ABSORB, ARMS_FLARE), root: [0, -0.285, 0.02] },
  { t: 13, ease: 'cubic', pose: over(add(STANCE, { hips: [4, 0, 0], spine01: [2, 0, 0], chest: [2, 0, 0], neck: [-2, 0, 0], head: [-3, 0, 0], shoulder_L: [-8, 0, -4], shoulder_R: [-6, 0, 4] }), L_COIL), root: [0, -0.135, 0.01] },
  { t: 16, ease: 'sine', pose: add(STANCE, { hips: [-2, 0, 0], chest: [-2, 0, 0], head: [2, 0, 0], knee_L: [-5, 0, 0], knee_R: [-5, 0, 0] }), root: [0, -0.065, 0] },
  { t: 20, pose: STANCE, root: [0, STANCE_Y, 0] },
]);

// ---------------------------------------------------------------------------
// loco.crouchWalk — the crouch shuffle. Half the stride and twice the effort:
// the pelvis barely moves vertically, the guard never opens, and the head stays
// tucked behind the lead forearm.
// ---------------------------------------------------------------------------
const crouchWalk = makeClip('loco.crouchWalk', { duration: 56, loop: true, blendIn: 6, blendOut: 6 }, [
  { t: 0, ease: 'sine', pose: add(over(CROUCH, C_SPREAD), { hips: [0, -2, 1], chest: [0, 2, -1] }), root: [0, -0.36, 0] },
  { t: 14, ease: 'sine', pose: add(over(CROUCH, C_REAR_SWING), { hips: [0, 1, 0], chest: [0, -1, 1], head: [0, 1, 0] }), root: [0, -0.34, 0] },
  { t: 28, ease: 'sine', pose: add(over(CROUCH, C_CLOSED), { hips: [0, 3, -1], chest: [0, -2, 1], head: [0, 1, 0] }), root: [0, -0.33, 0] },
  { t: 42, ease: 'sine', pose: add(over(CROUCH, C_LEAD_SWING), { hips: [0, -1, 1], chest: [0, 1, -1] }), root: [0, -0.345, 0] },
]);

// ---------------------------------------------------------------------------
// loco.runFwd — a real sprint, not a fast walk. The pelvis squares up 20deg
// because you cannot run bladed, the torso pitches 12deg over the lead foot, the
// arms drive contralaterally through 85deg of shoulder travel, and the head is
// held level while everything under it oscillates.
// ---------------------------------------------------------------------------
const run = (legs, arms, extra) => add(over(STANCE, legs, arms), add(RUN_TORSO, extra || {}));

const runFwd = makeClip('loco.runFwd', { duration: 32, loop: true, blendIn: 5, blendOut: 5 }, [
  { t: 0, ease: 'quad', pose: run(R_L_STRIKE, RUN_ARM_A, { hips: [2, -4, -2], chest: [1, 5, 2], head: [-1, -3, -1] }), root: [0, -0.07, 0] },
  { t: 6, ease: 'sine', pose: run(R_L_STANCE, RUN_ARM_A, { hips: [-2, -2, -1], chest: [-1, 3, 1] }), root: [0, -0.025, 0] },
  { t: 12, ease: 'quad', pose: run(R_L_PUSH, RUN_ARM_B, { hips: [0, 2, 1], chest: [0, -2, -1], head: [0, 1, 0] }), root: [0, -0.05, 0] },
  { t: 16, ease: 'quad', pose: run(R_R_STRIKE, RUN_ARM_B, { hips: [2, 4, 2], chest: [1, -5, -2], head: [-1, 3, 1] }), root: [0, -0.07, 0] },
  { t: 22, ease: 'sine', pose: run(R_R_STANCE, RUN_ARM_B, { hips: [-2, 2, 1], chest: [-1, -3, -1] }), root: [0, -0.025, 0] },
  { t: 28, ease: 'quad', pose: run(R_R_PUSH, RUN_ARM_A, { hips: [0, -2, -1], chest: [0, 2, 1], head: [0, -1, 0] }), root: [0, -0.05, 0] },
]);

// ---------------------------------------------------------------------------
// loco.stopShort — killing a run. The lead foot stabs out well ahead of the
// centre of mass and the whole body keeps travelling over it for four ticks
// before the torso finally rocks back; the arms are thrown forward and then
// clamped, and there is a deliberate overshoot past the stance on the way in.
// ---------------------------------------------------------------------------
const stopShort = makeClip('loco.stopShort', { duration: 22, blendIn: 3, blendOut: 6 }, [
  { t: 0, ease: 'snap', pose: run(R_L_PUSH, RUN_ARM_B), root: [0, -0.06, 0] },
  { t: 5, ease: 'quad', pose: over(add(STANCE, { hips: [10, 8, 0], spine01: [6, -3, 0], spine02: [6, -3, 0], chest: [6, -4, 3], neck: [-5, 1, 0], head: [-8, 2, 0] }), L_SKID, ARMS_REACH), root: [0, -0.16, 0.2] },
  { t: 10, ease: 'cubic', pose: over(add(STANCE, { hips: [-6, 2, 0], spine01: [-5, 0, 0], spine02: [-5, 0, 0], chest: [-6, 0, -2], neck: [5, 0, 0], head: [7, 0, 0] }), L_SKID, { clavicle_L: [0, -6, 2], shoulder_L: [-64, 0, -26], elbow_L: [-72, 0, 16], clavicle_R: [0, 6, -2], shoulder_R: [-58, 0, 26], elbow_R: [-84, 0, -8] }), root: [0, -0.14, 0.28] },
  { t: 15, ease: 'cubic', pose: add(STANCE, { hips: [-3, 0, 0], spine01: [-2, 0, 0], chest: [-3, 0, 0], neck: [2, 0, 0], head: [3, 0, 0], knee_L: [-6, 0, 0], shoulder_L: [-6, 0, -3], shoulder_R: [-5, 0, 3] }), root: [0, -0.1, 0.28] },
  { t: 22, pose: STANCE, root: [0, STANCE_Y, 0.27] },
]);

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
export const LOCOMOTION_CLIPS = {
  'loco.walkFwd': walkFwd,
  'loco.walkBack': walkBack,
  'loco.dashFwd': dashFwd,
  'loco.dashBack': dashBack,
  'loco.sidestepLeft': sidestepLeft,
  'loco.sidestepRight': sidestepRight,
  'loco.jumpStart': jumpStart,
  'loco.jumpAir': jumpAir,
  'loco.jumpLand': jumpLand,
  'loco.crouchWalk': crouchWalk,
  'loco.runFwd': runFwd,
  'loco.stopShort': stopShort,
};
