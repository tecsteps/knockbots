/**
 * Knockbots — everything the defender does.
 *
 * Impact is sold by ORDER, not amplitude. A head hit whips the skull on tick 2,
 * the ribcage on tick 4, the pelvis on tick 6 and the feet on tick 8; by the time
 * the hips have given up the head is already coming back. Every flinch in this
 * file is authored on that stagger, and the recoveries deliberately overshoot the
 * stance before settling so the body reads as mass being moved rather than a
 * curve being played.
 *
 * Ground reactions are real contacts. `hips` is pitched to -88deg for supine and
 * +88deg for prone and the root drops the pelvis to 0.20m, which puts the spine
 * flat on the floor with the head trailing behind or ahead of it; the feet, hips,
 * shoulders and skull each land on their own frame, and the slide is root motion.
 * Nothing here fades out to the stance.
 *
 * Axis conventions and the pose helpers live in ./idle.js.
 */

import { STANCE, STANCE_Y, CROUCH, add, over, makeClip } from './idle.js';

// ---------------------------------------------------------------------------
// Solved leg sets.
// ---------------------------------------------------------------------------
const L_BRACE = { hip_L: [-43, 4.9, 11], knee_L: [50.9, 0, 0], ankle_L: [-7.5, 2.4, 0], hip_R: [-3.4, 6, -12.1], knee_R: [48.6, 0, 0], ankle_R: [-38.5, -21.3, 0] };
const L_BUCKLE = { hip_L: [-56.4, 3.6, 11], knee_L: [73.2, 0, 0], ankle_L: [-17, -6.8, 0], hip_R: [-22.7, 5.8, -12], knee_R: [78.8, 0, 0], ankle_R: [-50.8, -14.5, 0] };
const L_SKATE = { hip_L: [-31, 4.4, 13.8], knee_L: [4.4, 0, 0], ankle_L: [29.8, -0.2, 0], hip_R: [-13, -2, -12], knee_R: [53.4, 0, 0], ankle_R: [-37.1, -10.8, 0] };
const L_KNEEL = { hip_L: [-96.2, -15.8, 5.4], knee_L: [106.8, 0, 0], ankle_L: [-19.4, -14.5, 0], hip_R: [-6.5, 16.1, -4.7], knee_R: [95.1, 0, 0], ankle_R: [30.8, -3.7, 0] };
const L_ALLFOUR = { hip_L: [-140, -17, 9.3], knee_L: [111.8, 0, 0], ankle_L: [-22, -22.6, 0], hip_R: [-101.6, -0.1, -8], knee_R: [127, 0, 0], ankle_R: [-62.6, -22.2, 0] };
const L_SPLAT = { hip_L: [-33.3, 8.9, 11], knee_L: [41.3, 0, 0], ankle_L: [4.3, -1.7, 0], hip_R: [-15, 7.5, -12], knee_R: [65.1, 0, 0], ankle_R: [-35.1, -14.1, 0] };
const L_SUPINE = { hip_L: [-17.2, 16.8, 10.3], knee_L: [50.5, 0, 0], ankle_L: [-38.8, -0.1, 0], hip_R: [-53.7, 13, 3.7], knee_R: [121.6, 0, 0], ankle_R: [13, -4, 0] };
const L_PRONE = { hip_L: [-39.7, 7.6, 8.8], knee_L: [62.5, 0, 0], ankle_L: [22.8, -1.8, 0], hip_R: [-4.8, -16.9, -8.1], knee_R: [0, 0, 0], ankle_R: [54.7, -3.3, 0] };
const L_SEATED = { hip_L: [-52.5, 2.2, 20.1], knee_L: [101.7, 0, 0], ankle_L: [-8.3, -7.2, 0], hip_R: [-56.8, 5.7, -16.3], knee_R: [107.1, 0, 0], ankle_R: [-14.7, 5, 0] };
/** Legs whipped off the floor and out in front — sweeps and launches. */
const L_AIRBORNE_UP = { hip_L: [-104, 4, 14], knee_L: [34, 0, 0], ankle_L: [-26, 0, 0], hip_R: [-88, -4, -16], knee_R: [58, 0, 0], ankle_R: [-20, 0, 0] };
/** Dead weight: knees soft, ankles loose, no muscle anywhere. */
const L_LIMP = { hip_L: [-26, 6, 9], knee_L: [46, 0, 0], ankle_L: [16, 0, 0], hip_R: [-14, -6, -10], knee_R: [58, 0, 0], ankle_R: [12, 0, 0] };

// ---------------------------------------------------------------------------
// Solved arm sets.
// ---------------------------------------------------------------------------
const A_GUARD_TIGHT = {
  clavicle_L: [-4, -12, 6], shoulder_L: [-42, 10, -39], elbow_L: [-150, 15, 17], wrist_L: [-14, 0, 0], hand_L: [-18, 0, 0],
  clavicle_R: [-4, 10, -6], shoulder_R: [-33, -24, 45], elbow_R: [-142, 63, 7], wrist_R: [-14, 0, 0], hand_R: [-18, 0, 0],
};
const A_GUARD_LOW = {
  clavicle_L: [2, -10, -6], shoulder_L: [-37, -37, -14], elbow_L: [-90, -67, 14], wrist_L: [-12, 0, 0], hand_L: [-16, 0, 0],
  clavicle_R: [-4, 10, -6], shoulder_R: [-76, -32, 27], elbow_R: [-147, 29, -1], wrist_R: [-12, 0, 0], hand_R: [-16, 0, 0],
};
const A_CLUTCH = {
  clavicle_L: [6, -8, -6], shoulder_L: [-35, -17, -25], elbow_L: [-124, 46, 10], wrist_L: [-22, 0, 0], hand_L: [-26, 0, 0],
  clavicle_R: [6, 8, 6], shoulder_R: [-56, 28, 32], elbow_R: [-124, -50, -22], wrist_R: [-22, 0, 0], hand_R: [-26, 0, 0],
};
const A_SPREAD = {
  clavicle_L: [-6, -4, 10], shoulder_L: [14, 0, 40], elbow_L: [-22, 0, 0], wrist_L: [4, 0, 0], hand_L: [6, 0, 0],
  clavicle_R: [-6, 4, -10], shoulder_R: [14, 0, -40], elbow_R: [-22, 0, 0], wrist_R: [4, 0, 0], hand_R: [6, 0, 0],
};
const A_PAW = {
  clavicle_L: [0, -10, -4], shoulder_L: [-18, 6, -18], elbow_L: [-93, -25, 11], wrist_L: [-20, 0, 0], hand_L: [-14, 0, 0],
  clavicle_R: [0, 8, 4], shoulder_R: [-42, 0, 26], elbow_R: [-93, -17, -15], wrist_R: [-20, 0, 0], hand_R: [-14, 0, 0],
};
/** Arms thrown behind and above the head — the top of a launch arc. */
const A_TRAIL = {
  clavicle_L: [-8, -4, 8], shoulder_L: [64, 0, -12], elbow_L: [-46, 0, 12], wrist_L: [4, 0, 0], hand_L: [8, 0, 0],
  clavicle_R: [-8, 4, -8], shoulder_R: [72, 0, 10], elbow_R: [-38, 0, -10], wrist_R: [4, 0, 0], hand_R: [8, 0, 0],
};
/** No tone at all: shoulders hang, elbows half open, wrists broken. */
const A_LIMP = {
  clavicle_L: [4, 0, -6], shoulder_L: [8, 0, -30], elbow_L: [-34, 0, 8], wrist_L: [16, 0, 0], hand_L: [22, 0, 0],
  clavicle_R: [4, 0, 6], shoulder_R: [10, 0, 28], elbow_R: [-30, 0, -8], wrist_R: [16, 0, 0], hand_R: [22, 0, 0],
};
/** Sprawled flat: works supine and prone because abduction stays in the body plane. */
const A_SPRAWL = {
  clavicle_L: [0, -4, 8], shoulder_L: [-8, 0, 34], elbow_L: [-52, 0, 14], wrist_L: [10, 0, 0], hand_L: [14, 0, 0],
  clavicle_R: [0, 4, -8], shoulder_R: [-4, 0, -30], elbow_R: [-46, 0, -12], wrist_R: [10, 0, 0], hand_R: [14, 0, 0],
};
/** Both arms flung high and wide, fingers spread — the middle of a stumble. */
const A_WINDMILL_UP = {
  clavicle_L: [-8, -6, 10], shoulder_L: [-124, 0, -6], elbow_L: [-34, 0, 14], wrist_L: [8, 0, 0], hand_L: [10, 0, 0],
  clavicle_R: [-8, 6, -10], shoulder_R: [-116, 0, 4], elbow_R: [-28, 0, -12], wrist_R: [8, 0, 0], hand_R: [10, 0, 0],
};
const A_WINDMILL_DOWN = {
  clavicle_L: [6, -2, -8], shoulder_L: [40, 0, -20], elbow_L: [-18, 0, 8], wrist_L: [6, 0, 0], hand_L: [8, 0, 0],
  clavicle_R: [6, 2, 8], shoulder_R: [46, 0, 18], elbow_R: [-14, 0, -6], wrist_R: [6, 0, 0], hand_R: [8, 0, 0],
};
/** One hand planted on the floor behind, the other free — pushing off to get up. */
const A_POST = {
  clavicle_L: [2, -8, -6], shoulder_L: [-30, -10, -34], elbow_L: [-68, 0, 16], wrist_L: [22, 0, 0], hand_L: [10, 0, 0],
  clavicle_R: [-4, 6, 6], shoulder_R: [40, 0, 22], elbow_R: [-24, 0, -6], wrist_R: [24, 0, 0], hand_R: [8, 0, 0],
};

// Torso attitudes reused across the file.
const T_BRACED = { hips: [4, 6, 0], spine01: [4, 4, 0], spine02: [5, 5, 0], chest: [6, 6, -2], neck: [4, 4, 0], head: [8, 5, 0] };
const T_FOLDED = { hips: [14, 8, 0], spine01: [12, 3, 0], spine02: [13, 4, 0], chest: [14, 5, -3], neck: [8, 4, 0], head: [14, 4, 0] };
const T_SUPINE = { hips: [-88, -10, 0], spine01: [-5, 0, 0], spine02: [-4, 0, 0], chest: [-3, 0, 0], neck: [10, 0, 0], head: [16, 0, 0] };
const T_PRONE = { hips: [88, 10, 0], spine01: [-4, 0, 0], spine02: [-4, 0, 0], chest: [-5, 0, 0], neck: [-14, 0, 0], head: [-20, 0, 0] };
const T_SEATED = { hips: [-64, -8, 0], spine01: [8, 2, 0], spine02: [9, 2, 0], chest: [11, 3, -4], neck: [10, 2, 0], head: [16, 3, -2] };
const T_SPLAT = { hips: [-12, 6, 0], spine01: [-10, 2, 0], spine02: [-11, 3, 0], chest: [-13, 4, 0], neck: [-6, 2, 0], head: [-20, 3, 0] };

/** Assemble a whole-body pose out of the sets above. */
const P = (...parts) => over(STANCE, ...parts);
/** Same, but the torso attitude is a delta on the stance rather than a replacement. */
const B = (torso, ...parts) => add(over(STANCE, ...parts), torso);

const GUARD_HIGH = B(T_BRACED, L_BRACE, A_GUARD_TIGHT);
const GUARD_HIGH_Y = -0.115;
const SUPINE = P(T_SUPINE, L_SUPINE, A_SPRAWL);
const SUPINE_Y = -0.78;
const PRONE = P(T_PRONE, L_PRONE, A_SPRAWL);
const PRONE_Y = -0.76;

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
const blockHigh = makeClip('r.blockHigh', { duration: 20, blendIn: 2, blendOut: 4 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 3, ease: 'cubic', pose: add(GUARD_HIGH, { chest: [3, 0, 0], head: [4, 0, 0], elbow_L: [-6, 0, 0], elbow_R: [-4, 0, 0], knee_L: [6, 0, 0], knee_R: [6, 0, 0] }), root: [0, GUARD_HIGH_Y - 0.02, -0.05] },
  { t: 7, ease: 'sine', pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.04] },
  { t: 14, ease: 'sine', pose: add(GUARD_HIGH, { spine02: [-1, 0, 0], chest: [-1.5, 0, 0], clavicle_L: [0, 0, 1.5], clavicle_R: [0, 0, -1.5] }), root: [0, GUARD_HIGH_Y + 0.006, -0.04] },
  { t: 20, pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.04] },
]);

const GUARD_LOW_POSE = add(over(CROUCH, L_BUCKLE, A_GUARD_LOW), { hips: [0, 4, 0], chest: [2, 2, 0], head: [4, 2, 0] });
const blockLow = makeClip('r.blockLow', { duration: 20, blendIn: 2, blendOut: 4 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 4, ease: 'cubic', pose: add(GUARD_LOW_POSE, { hips: [4, 0, 0], chest: [3, 0, 0], head: [4, 0, 0] }), root: [0, -0.335, -0.05] },
  { t: 8, ease: 'sine', pose: GUARD_LOW_POSE, root: [0, -0.315, -0.04] },
  { t: 15, ease: 'sine', pose: add(GUARD_LOW_POSE, { chest: [-1.5, 0, 0], head: [-1, 0, 0] }), root: [0, -0.308, -0.04] },
  { t: 20, pose: GUARD_LOW_POSE, root: [0, -0.315, -0.04] },
]);

// The blocked hit itself: the guard is driven into the face for two ticks, the
// feet are pushed 22cm and the fighter has to re-set the elbows afterwards.
const blockImpact = makeClip('r.blockImpact', { duration: 18, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.04] },
  { t: 2, ease: 'quad', pose: add(GUARD_HIGH, { hips: [-4, 3, 0], spine01: [-5, 0, 0], spine02: [-6, 0, 0], chest: [-7, 2, 2], neck: [-4, 0, 0], head: [-9, 2, 2], clavicle_L: [4, 0, -6], clavicle_R: [4, 0, 6], shoulder_L: [12, 0, 8], shoulder_R: [10, 0, -8], elbow_L: [8, 0, 0], elbow_R: [6, 0, 0], knee_L: [12, 0, 0], knee_R: [10, 0, 0] }), root: [0, GUARD_HIGH_Y - 0.035, -0.14] },
  { t: 6, ease: 'cubic', pose: add(GUARD_HIGH, { hips: [-2, 1, 0], chest: [-3, 1, 1], head: [-4, 1, 1], shoulder_L: [5, 0, 3], shoulder_R: [4, 0, -3], knee_L: [6, 0, 0], knee_R: [5, 0, 0] }), root: [0, GUARD_HIGH_Y - 0.02, -0.24] },
  { t: 11, ease: 'sine', pose: add(GUARD_HIGH, { chest: [2, 0, 0], head: [2, 0, 0], elbow_L: [-5, 0, 0], elbow_R: [-4, 0, 0] }), root: [0, GUARD_HIGH_Y, -0.26] },
  { t: 18, pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.26] },
]);

// ---------------------------------------------------------------------------
// Flinches — the whip chain
//
// The whip is what `easeBy` is for. A flinch is one event arriving at different
// parts of the body at different speeds: the head is thrown before the ribcage
// knows about it, and the ribcage is thrown before the pelvis does. Timing the
// keys apart gets the ORDER right but not the character — with one curve per
// keyframe the head and the hips both accelerate the same way, which reads as
// the whole chassis being pushed rather than as a blow landing on a head. So the
// part the blow is arriving at snaps on its segment while everything else keeps
// the frame's own curve.
// ---------------------------------------------------------------------------
const flinchHigh = makeClip('r.flinchHigh', { duration: 18, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', easeBy: { head: 'snap', neck: 'snap' }, pose: add(STANCE, { neck: [-15, -5, -5], head: [-27, -11, -9], clavicle_L: [0, 0, 3], shoulder_L: [-4, 0, 0] }), root: [0, STANCE_Y, -0.025] },
  { t: 4, ease: 'quad', easeBy: { spine01: 'snap', spine02: 'snap', chest: 'snap', hips: 'snap', head: 'sine', neck: 'sine' }, pose: add(STANCE, { spine02: [-7, 2, 2], chest: [-13, 5, 4], neck: [-16, -4, -5], head: [-30, -10, -9], clavicle_L: [-3, 0, 6], clavicle_R: [-3, 0, -4], shoulder_L: [8, 0, 6], shoulder_R: [6, 0, -5], elbow_L: [10, 0, 0] }), root: [0, STANCE_Y - 0.008, -0.075] },
  { t: 6, ease: 'cubic', pose: add(over(STANCE, L_SKATE), { hips: [-7, 5, 2], spine01: [-6, 2, 1], spine02: [-8, 3, 2], chest: [-14, 6, 5], neck: [-11, -2, -4], head: [-23, -7, -7], clavicle_L: [-3, 0, 5], clavicle_R: [-3, 0, -4], shoulder_L: [10, 0, 7], shoulder_R: [8, 0, -6], elbow_L: [12, 0, 0], elbow_R: [8, 0, 0] }), root: [0, STANCE_Y - 0.012, -0.115] },
  { t: 10, ease: 'cubic', pose: add(over(STANCE, L_SKATE), { hips: [2, 1, 0], chest: [4, -2, -2], neck: [3, 1, 1], head: [9, 3, 3], shoulder_L: [-6, 0, -4], shoulder_R: [-4, 0, 3] }), root: [0, STANCE_Y - 0.004, -0.13] },
  { t: 13, ease: 'sine', pose: add(STANCE, { chest: [-2, 0, 0], head: [-4, -1, -1], shoulder_L: [2, 0, 2] }), root: [0, STANCE_Y, -0.135] },
  { t: 18, pose: STANCE, root: [0, STANCE_Y, -0.135] },
]);

const flinchMid = makeClip('r.flinchMid', { duration: 18, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', easeBy: { hips: 'snap', spine01: 'snap', spine02: 'snap', chest: 'snap' }, pose: add(STANCE, { hips: [6, 2, 0], spine01: [7, 0, 0], spine02: [8, 0, 0], chest: [7, 2, 0], neck: [4, 0, 0], head: [7, 0, 0], clavicle_L: [4, 0, -4], clavicle_R: [4, 0, 4], elbow_L: [-8, 0, 0], elbow_R: [-4, 0, 0] }), root: [0, STANCE_Y - 0.03, -0.045] },
  { t: 5, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_CLUTCH), T_FOLDED), root: [0, -0.2, -0.1] },
  { t: 9, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_CLUTCH), add(T_FOLDED, { hips: [-4, 0, 0], spine01: [-4, 0, 0], spine02: [-5, 0, 0], chest: [-5, 0, 0], head: [-5, 0, 0] })), root: [0, -0.175, -0.125] },
  { t: 13, ease: 'sine', pose: add(STANCE, { hips: [4, 2, 0], spine01: [4, 0, 0], chest: [4, 1, 0], head: [3, 0, 0], elbow_L: [-6, 0, 0] }), root: [0, STANCE_Y - 0.02, -0.13] },
  { t: 18, pose: STANCE, root: [0, STANCE_Y, -0.13] },
]);

const flinchLow = makeClip('r.flinchLow', { duration: 16, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', easeBy: { hip_L: 'snap', knee_L: 'snap', ankle_L: 'snap' }, pose: add(STANCE, { hip_L: [-8, 0, -6], knee_L: [12, 0, 0], hips: [3, 0, 4], chest: [3, 0, -2], head: [4, 0, -2] }), root: [0, STANCE_Y - 0.045, -0.02] },
  { t: 4, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE), { hips: [9, 4, 7], spine01: [7, 0, -2], spine02: [8, 0, -3], chest: [9, 2, -5], neck: [4, 0, 0], head: [10, 0, -4], clavicle_L: [5, 0, -4], shoulder_L: [10, 0, 6], elbow_L: [12, 0, 0], shoulder_R: [6, 0, -5] }), root: [0, -0.205, -0.055] },
  { t: 8, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE), { hips: [4, 2, 3], spine01: [3, 0, -1], chest: [4, 1, -2], head: [4, 0, -2], shoulder_L: [4, 0, 2] }), root: [0, -0.16, -0.07] },
  { t: 12, ease: 'sine', pose: add(STANCE, { hips: [-2, 0, 0], chest: [-2, 0, 0], head: [-3, 0, 0], knee_L: [-4, 0, 0] }), root: [0, STANCE_Y - 0.008, -0.075] },
  { t: 16, pose: STANCE, root: [0, STANCE_Y, -0.075] },
]);

// ---------------------------------------------------------------------------
// r.stagger — two stumbled steps backwards. The torso oscillates twice against
// the feet, half a beat out of phase with them, and the arms windmill up on the
// first stumble and down on the second as the fighter fights for the balance.
// ---------------------------------------------------------------------------
const stagger = makeClip('r.stagger', { duration: 42, blendIn: 2, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 3, ease: 'quad', pose: add(STANCE, { spine02: [-8, 0, 3], chest: [-14, 4, 6], neck: [-10, -3, -4], head: [-24, -8, -8], clavicle_L: [-4, 0, 7], clavicle_R: [-4, 0, -6], shoulder_L: [14, 0, 8], shoulder_R: [12, 0, -7] }), root: [0, STANCE_Y - 0.01, -0.07] },
  { t: 10, ease: 'quad', pose: add(over(STANCE, L_SKATE, A_WINDMILL_UP), { hips: [-10, 8, 4], spine01: [-8, 3, 2], spine02: [-9, 4, 3], chest: [-12, 6, 5], neck: [-4, -2, -2], head: [-12, -5, -5] }), root: [0, STANCE_Y - 0.03, -0.3] },
  { t: 17, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_WINDMILL_DOWN), { hips: [10, -4, -3], spine01: [9, -2, -1], spine02: [10, -3, -2], chest: [12, -5, -4], neck: [-4, 2, 2], head: [-8, 4, 3] }), root: [0, -0.185, -0.42] },
  { t: 25, ease: 'quad', pose: add(over(STANCE, L_SKATE, A_WINDMILL_UP), { hips: [-8, 5, -3], spine01: [-7, 2, -2], spine02: [-8, 3, -2], chest: [-10, 4, -4], neck: [-3, -2, 2], head: [-9, -4, 4] }), root: [0, STANCE_Y - 0.025, -0.56] },
  { t: 32, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_WINDMILL_DOWN), { hips: [8, -3, 2], spine01: [7, -2, 1], chest: [9, -3, 3], neck: [-3, 1, -1], head: [-6, 3, -2] }), root: [0, -0.21, -0.65] },
  { t: 37, ease: 'sine', pose: add(STANCE, { hips: [-3, 2, 0], chest: [-4, 0, 0], head: [-5, 0, 0], knee_L: [8, 0, 0], knee_R: [8, 0, 0], shoulder_L: [-8, 0, -5], shoulder_R: [-6, 0, 4] }), root: [0, STANCE_Y - 0.03, -0.69] },
  { t: 42, pose: STANCE, root: [0, STANCE_Y, -0.7] },
]);

// ---------------------------------------------------------------------------
// r.crumple — the counter-hit collapse. The spine gives before the legs do, so
// the fighter is already folded in half by the time the knees stop holding him,
// and the hands arrive at the floor after the head does.
// ---------------------------------------------------------------------------
const crumple = makeClip('r.crumple', { duration: 54, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 4, ease: 'quad', pose: add(over(STANCE, A_CLUTCH), { hips: [6, 4, 0], spine01: [10, 0, 0], spine02: [11, 0, 0], chest: [12, 3, -2], neck: [6, 2, 0], head: [12, 2, 0], knee_L: [14, 0, 0], knee_R: [12, 0, 0], hip_L: [-10, 0, 0], hip_R: [-8, 0, 0] }), root: [0, -0.155, -0.05] },
  { t: 13, ease: 'cubic', pose: add(over(STANCE, A_PAW), { hips: [8, 6, -3], spine01: [14, 1, -2], spine02: [15, 2, -2], chest: [16, 4, -5], neck: [8, 2, 0], head: [14, 2, -2], hip_L: [-24, 0, 4], knee_L: [40, 0, 0], hip_R: [-20, 0, -4], knee_R: [38, 0, 0], ankle_L: [-12, 0, 0], ankle_R: [-10, 0, 0] }), root: [0, -0.32, -0.09] },
  { t: 24, ease: 'cubic', pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 6, -4], spine01: [16, 1, -3], spine02: [17, 2, -3], chest: [18, 4, -6], neck: [9, 2, 0], head: [16, 2, -3] }), root: [0, -0.46, -0.12] },
  { t: 36, ease: 'sine', pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 5, -5], spine01: [18, 1, -4], spine02: [19, 2, -4], chest: [20, 3, -8], neck: [10, 2, 0], head: [18, 1, -4], shoulder_L: [-14, 0, 0], shoulder_R: [-12, 0, 0], elbow_L: [16, 0, 0], elbow_R: [16, 0, 0] }), root: [0, -0.51, -0.14] },
  { t: 46, ease: 'sine', pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 5, -6], spine01: [19, 1, -4], spine02: [20, 2, -5], chest: [22, 3, -9], neck: [11, 2, 0], head: [20, 1, -5], shoulder_L: [-18, 0, 0], shoulder_R: [-16, 0, 0], elbow_L: [22, 0, 0], elbow_R: [22, 0, 0] }), root: [0, -0.535, -0.15] },
  { t: 54, pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 5, -6], spine01: [20, 1, -4], spine02: [21, 2, -5], chest: [23, 3, -9], neck: [12, 2, 0], head: [21, 1, -5], shoulder_L: [-19, 0, 0], shoulder_R: [-17, 0, 0], elbow_L: [23, 0, 0], elbow_R: [23, 0, 0] }), root: [0, -0.54, -0.15] },
]);

// ---------------------------------------------------------------------------
// r.launch — the whole body bent into a backward C. Two ticks of compression,
// then the pelvis is thrown forward and up while the shoulders, head and arms
// are left behind; the legs swing through last. Vertical travel is deliberately
// NOT in the root track — the juggle physics owns the height, and doubling it
// here would put the fighter through the ceiling.
// ---------------------------------------------------------------------------
const launch = makeClip('r.launch', { duration: 30, blendIn: 1, blendOut: 6 }, [
  { t: 0, ease: 'expo', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', pose: add(STANCE, { hips: [8, 2, 0], spine01: [6, 0, 0], chest: [6, 2, 0], neck: [3, 0, 0], head: [6, 0, 0], knee_L: [14, 0, 0], knee_R: [12, 0, 0], hip_L: [-8, 0, 0], hip_R: [-6, 0, 0] }), root: [0, -0.15, -0.01] },
  { t: 7, ease: 'quad', pose: add(over(STANCE, A_TRAIL), { hips: [-10, 6, 2], spine01: [-7, 2, 2], spine02: [-8, 3, 3], chest: [-12, 6, 6], neck: [-5, -2, -3], head: [-14, -6, -7], hip_L: [-30, 0, 4], knee_L: [-18, 0, 0], hip_R: [-24, 0, -4], knee_R: [-14, 0, 0] }), root: [0, -0.03, -0.1] },
  { t: 13, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-14, 8, 3], spine01: [-9, 3, 3], spine02: [-10, 4, 4], chest: [-15, 8, 8], neck: [-6, -3, -4], head: [-18, -8, -9] }), root: [0, 0.04, -0.22] },
  { t: 21, ease: 'sine', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-17, 9, 4], spine01: [-10, 3, 4], spine02: [-11, 4, 4], chest: [-17, 9, 9], neck: [-7, -3, -4], head: [-20, -9, -10], hip_L: [8, 0, 0], hip_R: [10, 0, 0], knee_L: [16, 0, 0], knee_R: [12, 0, 0] }), root: [0, 0.06, -0.32] },
  { t: 30, pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-13, 8, 4], spine01: [-8, 3, 3], spine02: [-9, 4, 4], chest: [-14, 8, 8], neck: [-6, -3, -4], head: [-16, -8, -9], hip_L: [22, 0, 0], hip_R: [24, 0, 0], knee_L: [34, 0, 0], knee_R: [30, 0, 0] }), root: [0, 0.03, -0.4] },
]);

// ---------------------------------------------------------------------------
// r.airFlail — the juggle hold. Everything is dead weight being carried by
// momentum: the limbs lag the torso and the whole body rotates slowly. Loops.
// ---------------------------------------------------------------------------
const AIR = over(STANCE, L_LIMP, A_LIMP);
const airFlail = makeClip('r.airFlail', { duration: 36, loop: true, blendIn: 5, blendOut: 5 }, [
  { t: 0, ease: 'sine', pose: add(AIR, { hips: [-16, 6, 3], spine01: [-9, 2, 2], spine02: [-10, 2, 2], chest: [-10, 4, 5], neck: [-3, -2, -2], head: [-12, -4, -5] }), root: [0, -0.02, 0] },
  { t: 9, ease: 'sine', pose: add(AIR, { hips: [-10, 10, -2], spine01: [-5, 4, -2], spine02: [-6, 4, -2], chest: [-8, 8, -4], neck: [-2, -3, 2], head: [-9, -6, 4], shoulder_L: [-18, 0, -8], shoulder_R: [14, 0, 6], hip_L: [-14, 0, 0], hip_R: [10, 0, 0], knee_L: [-16, 0, 0], knee_R: [14, 0, 0] }), root: [0, 0.02, 0.03] },
  { t: 18, ease: 'sine', pose: add(AIR, { hips: [-20, 2, -4], spine01: [-11, 0, -3], spine02: [-12, 0, -3], chest: [-16, 1, -6], neck: [-5, 1, 3], head: [-19, 2, 6], shoulder_L: [10, 0, 6], shoulder_R: [-16, 0, -7], hip_L: [12, 0, 0], hip_R: [-12, 0, 0], knee_L: [18, 0, 0], knee_R: [-14, 0, 0] }), root: [0, 0.01, -0.02] },
  { t: 27, ease: 'sine', pose: add(AIR, { hips: [-14, -4, 4], spine01: [-8, -2, 3], spine02: [-9, -2, 3], chest: [-12, -4, 6], neck: [-3, 2, -3], head: [-13, 4, -6], shoulder_L: [-8, 0, -4], shoulder_R: [6, 0, 3], hip_L: [-6, 0, 0], hip_R: [6, 0, 0], knee_L: [-8, 0, 0], knee_R: [8, 0, 0] }), root: [0, -0.01, 0.01] },
]);

// ---------------------------------------------------------------------------
// r.spinFall — hit hard enough to be turned around in the air. The root yaws a
// full 400deg so the fighter over-rotates past facing and has to settle back;
// the limbs are flung outward by the spin and lag it by about a fifth of a turn.
// ---------------------------------------------------------------------------
const spinFall = makeClip('r.spinFall', { duration: 44, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0], ry: 0 },
  { t: 4, ease: 'quad', pose: add(over(STANCE, A_TRAIL), { hips: [-10, -14, 8], spine01: [-6, -6, 4], spine02: [-7, -7, 5], chest: [-10, -12, 10], neck: [-4, 4, -3], head: [-12, 9, -8], knee_L: [-10, 0, 0], hip_L: [-16, 0, 0] }), root: [0, -0.03, -0.14], ry: 46 },
  { t: 14, ease: 'linear', pose: add(over(STANCE, L_LIMP, A_SPRAWL), { hips: [-14, -10, 16], spine01: [-8, -4, 8], spine02: [-9, -4, 9], chest: [-13, -8, 18], neck: [-4, 3, -6], head: [-15, 7, -14] }), root: [0, 0.02, -0.4], ry: 170 },
  { t: 26, ease: 'linear', pose: add(over(STANCE, L_LIMP, A_SPRAWL), { hips: [-12, -6, -14], spine01: [-7, -2, -7], spine02: [-8, -3, -8], chest: [-11, -5, -16], neck: [-3, 2, 5], head: [-13, 5, 12] }), root: [0, -0.04, -0.7], ry: 306 },
  { t: 36, ease: 'cubic', pose: add(over(STANCE, L_LIMP, A_LIMP), { hips: [16, 6, -6], spine01: [10, 2, -3], spine02: [11, 2, -3], chest: [14, 5, -7], neck: [4, -2, 2], head: [12, -4, 5] }), root: [0, -0.42, -0.9], ry: 392 },
  { t: 44, pose: add(PRONE, { hips: [0, -8, 0] }), root: [0, PRONE_Y, -1.0], ry: 400 },
]);

// ---------------------------------------------------------------------------
// Knockdowns. Four separate contacts: hips, shoulders, skull, then the limbs.
// ---------------------------------------------------------------------------
const knockdownBack = makeClip('r.knockdownBack', { duration: 58, blendIn: 2, blendOut: 10 }, [
  { t: 0, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-14, 6, 3], spine01: [-9, 2, 2], spine02: [-10, 3, 3], chest: [-14, 6, 7], neck: [-5, -3, -4], head: [-17, -7, -8] }), root: [0, -0.02, -0.06] },
  { t: 8, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-48, 4, 3], spine01: [-8, 2, 2], spine02: [-8, 2, 2], chest: [-12, 5, 6], neck: [-4, -2, -3], head: [-15, -6, -7] }), root: [0, -0.36, -0.24] },
  { t: 13, ease: 'snap', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-70, 2, 2], spine01: [-6, 1, 1], spine02: [-6, 1, 1], chest: [-9, 3, 4], neck: [-4, -1, -2], head: [-13, -4, -5] }), root: [0, -0.7, -0.4] },
  { t: 17, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP, A_SPRAWL), { hips: [-86, 0, 0], spine01: [-4, 0, 0], spine02: [-4, 0, 0], chest: [-6, 1, 2], neck: [-8, 0, -1], head: [-24, -2, -3] }), root: [0, -0.775, -0.5] },
  { t: 21, ease: 'cubic', pose: add(SUPINE, { hips: [2, 0, 0], neck: [4, 0, 0], head: [10, 0, 0], hip_L: [-40, 0, 0], hip_R: [-34, 0, 0], knee_L: [-22, 0, 0] }), root: [0, -0.75, -0.56] },
  { t: 27, ease: 'cubic', pose: add(SUPINE, { hip_L: [-18, 0, 0], hip_R: [-14, 0, 0], shoulder_L: [-6, 0, 6], shoulder_R: [-4, 0, -6] }), root: [0, SUPINE_Y, -0.6] },
  { t: 36, ease: 'sine', pose: add(SUPINE, { hips: [2, 0, 0], chest: [2, 0, 0], head: [-5, 0, 0], hip_L: [-4, 0, 0], knee_R: [-10, 0, 0] }), root: [0, SUPINE_Y, -0.63] },
  { t: 44, ease: 'sine', pose: add(SUPINE, { head: [3, 0, 2], shoulder_L: [3, 0, -3], knee_R: [6, 0, 0] }), root: [0, SUPINE_Y + 0.006, -0.64] },
  { t: 58, pose: SUPINE, root: [0, SUPINE_Y, -0.64] },
]);

const knockdownFace = makeClip('r.knockdownFace', { duration: 58, blendIn: 2, blendOut: 10 }, [
  { t: 0, ease: 'quad', pose: add(over(STANCE, A_TRAIL), { hips: [24, -6, -4], spine01: [16, -2, -2], spine02: [17, -2, -2], chest: [22, -5, -6], neck: [-8, 2, 3], head: [-14, 5, 6], hip_L: [16, 0, 0], hip_R: [20, 0, 0], knee_L: [26, 0, 0], knee_R: [22, 0, 0] }), root: [0, -0.06, 0.02] },
  { t: 9, ease: 'quad', pose: add(over(STANCE, A_PAW), { hips: [52, -4, -3], spine01: [14, -1, -1], spine02: [15, -1, -1], chest: [18, -3, -4], neck: [-10, 1, 2], head: [-18, 3, 4], hip_L: [34, 0, 0], hip_R: [38, 0, 0], knee_L: [46, 0, 0], knee_R: [40, 0, 0] }), root: [0, -0.4, 0.14] },
  { t: 14, ease: 'snap', pose: add(over(STANCE, A_PAW), { hips: [74, -2, -2], spine01: [8, 0, 0], spine02: [9, 0, 0], chest: [10, -2, -2], neck: [-12, 1, 1], head: [-22, 2, 2], hip_L: [52, 0, 0], hip_R: [56, 0, 0], knee_L: [58, 0, 0], knee_R: [52, 0, 0] }), root: [0, -0.68, 0.24] },
  { t: 18, ease: 'quad', pose: add(PRONE, { hips: [-4, 0, 0], neck: [6, 0, 0], head: [12, 0, 0], hip_L: [-16, 0, 0], hip_R: [-12, 0, 0], shoulder_L: [-10, 0, 4], shoulder_R: [-8, 0, -4] }), root: [0, -0.745, 0.3] },
  { t: 23, ease: 'cubic', pose: add(PRONE, { neck: [3, 0, 0], head: [6, 0, 0], knee_L: [22, 0, 0], knee_R: [18, 0, 0] }), root: [0, -0.775, 0.34] },
  { t: 30, ease: 'cubic', pose: add(PRONE, { head: [-4, 0, 3], knee_L: [8, 0, 0] }), root: [0, PRONE_Y, 0.37] },
  { t: 40, ease: 'sine', pose: add(PRONE, { chest: [2, 0, 0], head: [2, 0, -2], shoulder_R: [4, 0, 4] }), root: [0, PRONE_Y + 0.005, 0.38] },
  { t: 58, pose: PRONE, root: [0, PRONE_Y, 0.38] },
]);

// r.sweepFall — the floor arrives before anything else does. No arc, no air
// time: the feet go out from under the pelvis, the pelvis drops straight down
// and the shoulders catch up three ticks later.
const sweepFall = makeClip('r.sweepFall', { duration: 40, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 3, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP), { hips: [-16, 4, 4], spine01: [-8, 2, 2], spine02: [-9, 2, 2], chest: [-12, 4, 5], neck: [4, -2, -2], head: [10, -5, -5], clavicle_L: [-4, 0, 6], shoulder_L: [24, 0, 6], shoulder_R: [26, 0, -6], elbow_L: [30, 0, 0], elbow_R: [40, 0, 0] }), root: [0, -0.32, -0.06] },
  { t: 7, ease: 'snap', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-58, 2, 2], spine01: [-8, 1, 1], spine02: [-9, 1, 1], chest: [-12, 2, 3], neck: [-4, -1, -1], head: [-14, -3, -3] }), root: [0, -0.68, -0.16] },
  { t: 11, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP, A_SPRAWL), { hips: [-86, 0, 0], spine01: [-3, 0, 0], chest: [-4, 1, 1], neck: [-8, 0, 0], head: [-26, -2, -2] }), root: [0, -0.79, -0.22] },
  { t: 16, ease: 'cubic', pose: add(SUPINE, { hips: [2, 0, 0], head: [10, 0, 0], hip_L: [-46, 0, 0], hip_R: [-40, 0, 0] }), root: [0, -0.755, -0.28] },
  { t: 24, ease: 'cubic', pose: add(SUPINE, { hip_L: [-14, 0, 0], hip_R: [-10, 0, 0] }), root: [0, SUPINE_Y, -0.32] },
  { t: 32, ease: 'sine', pose: add(SUPINE, { head: [-4, 0, 0], knee_R: [-8, 0, 0], shoulder_L: [-4, 0, 4] }), root: [0, SUPINE_Y, -0.34] },
  { t: 40, pose: SUPINE, root: [0, SUPINE_Y, -0.34] },
]);

// ---------------------------------------------------------------------------
// Wall
// ---------------------------------------------------------------------------
const SPLAT = add(over(STANCE, L_SPLAT, A_SPREAD), T_SPLAT);
const wallSplat = makeClip('r.wallSplat', { duration: 34, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: add(over(STANCE, A_TRAIL), { hips: [-12, 4, 2], spine01: [-8, 2, 1], chest: [-14, 5, 4], neck: [-6, -2, -2], head: [-18, -5, -5], hip_L: [-14, 0, 0], hip_R: [-10, 0, 0] }), root: [0, -0.06, 0.1] },
  { t: 3, ease: 'quad', pose: add(SPLAT, { hips: [-6, 0, 0], spine01: [-5, 0, 0], spine02: [-6, 0, 0], chest: [-8, 0, 0], neck: [-6, 0, 0], head: [-16, 0, 0], shoulder_L: [-6, 0, 8], shoulder_R: [-6, 0, -8], knee_L: [16, 0, 0], knee_R: [14, 0, 0] }), root: [0, -0.19, -0.06] },
  { t: 7, ease: 'cubic', pose: SPLAT, root: [0, -0.13, -0.04] },
  { t: 13, ease: 'sine', pose: add(SPLAT, { chest: [3, 0, 0], neck: [4, 0, 0], head: [12, 0, 0], shoulder_L: [4, 0, -6], shoulder_R: [4, 0, 6], elbow_L: [-10, 0, 0], elbow_R: [-10, 0, 0] }), root: [0, -0.15, -0.04] },
  { t: 22, ease: 'sine', pose: add(SPLAT, { hips: [6, 0, 0], spine01: [5, 0, 0], spine02: [5, 0, 0], chest: [8, 0, 0], neck: [6, 0, 0], head: [20, 0, 0], shoulder_L: [10, 0, -14], shoulder_R: [10, 0, 14], elbow_L: [-24, 0, 0], elbow_R: [-24, 0, 0], knee_L: [10, 0, 0], knee_R: [10, 0, 0] }), root: [0, -0.21, -0.02] },
  { t: 34, pose: add(SPLAT, { hips: [10, 0, 0], spine01: [8, 0, 0], spine02: [8, 0, 0], chest: [12, 0, 0], neck: [8, 0, 0], head: [24, 0, 0], shoulder_L: [16, 0, -20], shoulder_R: [16, 0, 20], elbow_L: [-34, 0, 0], elbow_R: [-34, 0, 0], knee_L: [18, 0, 0], knee_R: [18, 0, 0] }), root: [0, -0.28, -0.02] },
]);

const SEATED = add(over(STANCE, L_SEATED, A_LIMP), T_SEATED);
const wallSlide = makeClip('r.wallSlide', { duration: 50, blendIn: 3, blendOut: 10 }, [
  { t: 0, ease: 'quad', pose: SPLAT, root: [0, -0.13, -0.04] },
  { t: 9, ease: 'sine', pose: add(SPLAT, { hips: [8, 0, 0], spine01: [6, 0, 0], spine02: [6, 0, 0], chest: [8, 0, 0], neck: [8, 0, 0], head: [22, 0, 2], shoulder_L: [16, 0, -18], shoulder_R: [16, 0, 18], elbow_L: [-28, 0, 0], elbow_R: [-26, 0, 0], knee_L: [26, 0, 0], knee_R: [24, 0, 0], hip_L: [-16, 0, 0], hip_R: [-14, 0, 0] }), root: [0, -0.29, -0.03] },
  { t: 20, ease: 'sine', pose: add(SPLAT, { hips: [18, 0, 0], spine01: [12, 0, 0], spine02: [12, 0, 0], chest: [16, 0, -2], neck: [10, 0, 0], head: [28, 0, 3], shoulder_L: [26, 0, -30], shoulder_R: [26, 0, 30], elbow_L: [-40, 0, 0], elbow_R: [-38, 0, 0], knee_L: [52, 0, 0], knee_R: [50, 0, 0], hip_L: [-34, 0, 0], hip_R: [-30, 0, 0] }), root: [0, -0.48, -0.02] },
  { t: 32, ease: 'cubic', pose: add(SEATED, { chest: [-4, 0, 0], neck: [-3, 0, 0], head: [-8, 0, 0], shoulder_L: [-6, 0, 8], shoulder_R: [-6, 0, -8] }), root: [0, -0.68, -0.02] },
  { t: 40, ease: 'sine', pose: SEATED, root: [0, -0.7, -0.02] },
  { t: 50, pose: add(SEATED, { spine01: [3, 0, -1], spine02: [3, 0, -1], chest: [4, 0, -3], neck: [4, 0, 0], head: [9, 0, -2], shoulder_L: [4, 0, -3], shoulder_R: [3, 0, 3] }), root: [0, -0.705, -0.02] },
]);

// ---------------------------------------------------------------------------
// Getting up
// ---------------------------------------------------------------------------
const getUp = makeClip('r.getUp', { duration: 50, blendIn: 6, blendOut: 8 }, [
  { t: 0, ease: 'quad', pose: SUPINE, root: [0, SUPINE_Y, 0] },
  { t: 8, ease: 'quad', pose: add(over(STANCE, A_POST), { hips: [-72, -14, 8], spine01: [6, 2, 4], spine02: [7, 2, 4], chest: [9, 4, 6], neck: [6, 2, 0], head: [10, 3, 2], hip_L: [-58, 8, 10], knee_L: [78, 0, 0], hip_R: [-70, -6, -6], knee_R: [96, 0, 0], ankle_L: [-18, 0, 0], ankle_R: [-14, 0, 0] }), root: [0, -0.71, 0.06] },
  { t: 18, ease: 'quad', pose: add(over(STANCE, L_ALLFOUR, A_POST), { hips: [46, -12, 4], spine01: [-6, 2, 2], spine02: [-6, 2, 2], chest: [-8, 4, 3], neck: [-12, 2, 0], head: [-18, 3, 0] }), root: [0, -0.5, 0.02] },
  { t: 28, ease: 'cubic', pose: add(over(STANCE, L_KNEEL, A_POST), { hips: [8, -6, 2], spine01: [2, 1, 1], spine02: [2, 1, 1], chest: [3, 2, 0], neck: [-2, 1, 0], head: [-4, 2, 0], shoulder_R: [-24, 0, -8], elbow_R: [-30, 0, 0] }), root: [0, -0.45, -0.02] },
  { t: 38, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE), { hips: [6, 2, 0], spine01: [4, 0, 0], chest: [5, 0, -2], neck: [-2, 0, 0], head: [-3, 0, 0], clavicle_L: [0, 0, 3], shoulder_L: [-16, 0, -6], elbow_L: [-14, 0, 4], shoulder_R: [-12, 0, 6], elbow_R: [-8, 0, 0] }), root: [0, -0.23, -0.06] },
  { t: 44, ease: 'sine', pose: add(STANCE, { hips: [-3, 0, 0], chest: [-3, 0, 0], head: [3, 0, 0], knee_L: [-6, 0, 0], knee_R: [-6, 0, 0], shoulder_L: [-4, 0, -3] }), root: [0, -0.06, -0.08] },
  { t: 50, pose: STANCE, root: [0, STANCE_Y, -0.08] },
]);

// A backward roll to the feet. The pelvis pitches through a full half turn while
// the root rides an arc, and the fighter comes up 0.78m further from the attacker
// than he went down.
const getUpRoll = makeClip('r.getUpRoll', { duration: 42, blendIn: 5, blendOut: 6 }, [
  { t: 0, ease: 'quad', pose: SUPINE, root: [0, SUPINE_Y, 0] },
  { t: 7, ease: 'quad', pose: add(over(STANCE, A_SPRAWL), { hips: [-92, -6, 0], spine01: [10, 0, 0], spine02: [10, 0, 0], chest: [12, 0, 0], neck: [10, 0, 0], head: [18, 0, 0], hip_L: [-108, 6, 8], knee_L: [42, 0, 0], hip_R: [-104, -6, -8], knee_R: [50, 0, 0] }), root: [0, -0.72, -0.16] },
  { t: 14, ease: 'linear', pose: add(over(STANCE, A_POST), { hips: [-136, -4, 0], spine01: [14, 0, 0], spine02: [14, 0, 0], chest: [16, 0, 0], neck: [12, 0, 0], head: [22, 0, 0], hip_L: [-124, 6, 10], knee_L: [86, 0, 0], hip_R: [-120, -6, -10], knee_R: [92, 0, 0] }), root: [0, -0.56, -0.4] },
  { t: 21, ease: 'quad', pose: add(over(STANCE, L_ALLFOUR, A_POST), { hips: [46, -10, 0], spine01: [-8, 1, 0], spine02: [-8, 1, 0], chest: [-10, 2, 0], neck: [-14, 1, 0], head: [-22, 2, 0] }), root: [0, -0.48, -0.6] },
  { t: 28, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE), { hips: [22, -4, 0], spine01: [12, 0, 0], spine02: [12, 0, 0], chest: [14, 2, -2], neck: [-6, 0, 0], head: [-10, 1, 0], clavicle_L: [0, 0, 2], shoulder_L: [-28, 0, -8], elbow_L: [-20, 0, 6], shoulder_R: [-22, 0, 8], elbow_R: [-16, 0, 0] }), root: [0, -0.3, -0.72] },
  { t: 35, ease: 'cubic', pose: add(STANCE, { hips: [-4, 0, 0], chest: [-4, 0, 0], head: [4, 0, 0], knee_L: [10, 0, 0], knee_R: [10, 0, 0] }), root: [0, -0.13, -0.78] },
  { t: 42, pose: STANCE, root: [0, STANCE_Y, -0.78] },
]);

// r.groundBounce — the body hits the floor with enough speed left to come off
// it again. Compression on tick 3, release on tick 6, a slow limp apex, and back
// down. Only the pelvis is driven; the limbs simply lag it.
const groundBounce = makeClip('r.groundBounce', { duration: 30, blendIn: 1, blendOut: 6 }, [
  { t: 0, ease: 'quad', pose: add(over(STANCE, L_LIMP, A_SPRAWL), { hips: [-70, -6, 2], spine01: [-6, 0, 0], spine02: [-6, 0, 0], chest: [-8, 2, 3], neck: [-6, 0, -1], head: [-18, -2, -3] }), root: [0, -0.5, 0] },
  { t: 3, ease: 'snap', pose: add(over(STANCE, L_LIMP, A_SPRAWL), { hips: [-88, -8, 0], spine01: [-2, 0, 0], spine02: [-2, 0, 0], chest: [-3, 1, 1], neck: [-10, 0, 0], head: [-28, -1, -1], hip_L: [-30, 0, 0], hip_R: [-26, 0, 0] }), root: [0, -0.815, -0.1] },
  { t: 7, ease: 'quad', pose: add(over(STANCE, L_LIMP, A_SPRAWL), { hips: [-82, -6, 2], spine01: [-4, 0, 0], chest: [-6, 1, 2], neck: [2, 0, 0], head: [6, -1, -2], hip_L: [-52, 0, 0], hip_R: [-46, 0, 0], knee_L: [-18, 0, 0] }), root: [0, -0.57, -0.22] },
  { t: 13, ease: 'sine', pose: add(over(STANCE, L_LIMP, A_LIMP), { hips: [-74, -4, 4], spine01: [-6, 0, 1], chest: [-9, 2, 4], neck: [1, 0, -1], head: [2, -2, -4], hip_L: [-40, 0, 0], hip_R: [-34, 0, 0] }), root: [0, -0.43, -0.36] },
  { t: 21, ease: 'quad', pose: add(over(STANCE, L_LIMP, A_LIMP), { hips: [-80, -6, 2], spine01: [-5, 0, 0], chest: [-7, 1, 2], neck: [-4, 0, 0], head: [-12, -1, -2], hip_L: [-24, 0, 0], hip_R: [-20, 0, 0] }), root: [0, -0.62, -0.52] },
  { t: 30, pose: add(SUPINE, { hip_L: [-10, 0, 0], hip_R: [-8, 0, 0] }), root: [0, SUPINE_Y, -0.62] },
]);

// ---------------------------------------------------------------------------
// KO — the slow ones. Nothing here is a reaction any more; it is a machine
// running out of power, so the timing is loose, the eases are all sine, and the
// limbs arrive whenever gravity gets to them.
// ---------------------------------------------------------------------------
const koFall = makeClip('r.koFall', { duration: 80, blendIn: 2, blendOut: 12 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 5, ease: 'sine', pose: add(over(STANCE, A_LIMP), { hips: [4, 2, 0], spine01: [4, 0, 0], spine02: [4, 0, 0], chest: [3, 2, -2], neck: [6, 0, 0], head: [12, 1, -2], knee_L: [10, 0, 0], knee_R: [8, 0, 0] }), root: [0, -0.13, -0.02] },
  { t: 14, ease: 'sine', pose: add(over(STANCE, A_LIMP), { hips: [-8, 3, 2], spine01: [-4, 1, 1], spine02: [-5, 1, 1], chest: [-8, 3, 3], neck: [2, -1, -1], head: [4, -3, -3], knee_L: [18, 0, 0], knee_R: [16, 0, 0], hip_L: [-12, 0, 0], hip_R: [-8, 0, 0] }), root: [0, -0.22, -0.08] },
  { t: 26, ease: 'quad', pose: add(over(STANCE, A_LIMP), { hips: [-30, 4, 3], spine01: [-7, 1, 1], spine02: [-8, 2, 2], chest: [-12, 4, 5], neck: [-3, -2, -2], head: [-10, -5, -5], hip_L: [-24, 0, 2], knee_L: [22, 0, 0], hip_R: [-18, 0, -2], knee_R: [20, 0, 0] }), root: [0, -0.38, -0.22] },
  { t: 38, ease: 'quad', pose: add(over(STANCE, A_TRAIL), { hips: [-58, 3, 2], spine01: [-8, 1, 1], spine02: [-8, 1, 1], chest: [-12, 3, 4], neck: [-4, -2, -2], head: [-14, -4, -4], hip_L: [-42, 0, 2], knee_L: [16, 0, 0], hip_R: [-36, 0, -2], knee_R: [14, 0, 0] }), root: [0, -0.62, -0.4] },
  { t: 45, ease: 'snap', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-80, 1, 1], spine01: [-8, 0, 0], spine02: [-8, 0, 0], chest: [-12, 2, 2], neck: [-8, -1, -1], head: [-26, -2, -3] }), root: [0, -0.79, -0.52] },
  { t: 50, ease: 'cubic', pose: add(SUPINE, { hips: [2, 0, 0], head: [12, 0, 0], hip_L: [-44, 0, 0], hip_R: [-38, 0, 0] }), root: [0, -0.755, -0.58] },
  { t: 58, ease: 'cubic', pose: add(SUPINE, { hip_L: [-16, 0, 0], hip_R: [-12, 0, 0], shoulder_L: [-6, 0, 6], shoulder_R: [-4, 0, -6] }), root: [0, SUPINE_Y, -0.63] },
  { t: 66, ease: 'sine', pose: add(SUPINE, { chest: [2, 0, 0], head: [-6, 0, 1], knee_R: [-12, 0, 0], shoulder_L: [4, 0, -4] }), root: [0, SUPINE_Y, -0.66] },
  { t: 73, ease: 'sine', pose: add(SUPINE, { head: [2, 0, 2], knee_R: [4, 0, 0] }), root: [0, SUPINE_Y + 0.004, -0.67] },
  { t: 80, pose: SUPINE, root: [0, SUPINE_Y, -0.67] },
]);

const koSlump = makeClip('r.koSlump', { duration: 70, blendIn: 2, blendOut: 12 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 7, ease: 'sine', pose: add(over(STANCE, A_LIMP), { hips: [8, 3, 0], spine01: [8, 0, 0], spine02: [9, 0, 0], chest: [10, 2, -3], neck: [8, 1, 0], head: [16, 1, -2], knee_L: [16, 0, 0], knee_R: [14, 0, 0], hip_L: [-12, 0, 0], hip_R: [-10, 0, 0] }), root: [0, -0.19, -0.03] },
  { t: 18, ease: 'quad', pose: add(over(STANCE, A_PAW), { hips: [10, 5, -2], spine01: [13, 1, -1], spine02: [14, 1, -2], chest: [16, 3, -5], neck: [8, 2, 0], head: [17, 2, -3], hip_L: [-26, 0, 3], knee_L: [44, 0, 0], hip_R: [-22, 0, -3], knee_R: [42, 0, 0], ankle_L: [-14, 0, 0] }), root: [0, -0.35, -0.06] },
  { t: 28, ease: 'quad', pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 5, -4], spine01: [16, 1, -3], spine02: [17, 2, -3], chest: [19, 3, -7], neck: [9, 2, 0], head: [18, 1, -4] }), root: [0, -0.46, -0.08] },
  { t: 38, ease: 'quad', pose: add(over(STANCE, L_KNEEL, A_LIMP), { hips: [30, 4, -4], spine01: [22, 1, -2], spine02: [23, 1, -3], chest: [24, 2, -6], neck: [-4, 1, 0], head: [-8, 1, -3], shoulder_L: [-30, 0, 0], shoulder_R: [-28, 0, 0] }), root: [0, -0.6, 0.06] },
  { t: 45, ease: 'snap', pose: add(PRONE, { hips: [-8, 0, 0], spine01: [6, 0, 0], spine02: [6, 0, 0], chest: [8, 0, 0], neck: [8, 0, 0], head: [16, 0, 0], hip_L: [-30, 0, 0], hip_R: [-26, 0, 0], knee_L: [40, 0, 0], knee_R: [36, 0, 0] }), root: [0, -0.735, 0.2] },
  { t: 52, ease: 'cubic', pose: add(PRONE, { neck: [4, 0, 0], head: [8, 0, 0], hip_L: [-10, 0, 0], knee_L: [16, 0, 0], knee_R: [14, 0, 0] }), root: [0, -0.775, 0.28] },
  { t: 60, ease: 'sine', pose: add(PRONE, { head: [-4, 0, 3], knee_L: [5, 0, 0], shoulder_L: [-4, 0, 5] }), root: [0, PRONE_Y, 0.32] },
  { t: 70, pose: PRONE, root: [0, PRONE_Y, 0.33] },
]);

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
export const REACTION_CLIPS = {
  'r.blockHigh': blockHigh,
  'r.blockLow': blockLow,
  'r.blockImpact': blockImpact,
  'r.flinchHigh': flinchHigh,
  'r.flinchMid': flinchMid,
  'r.flinchLow': flinchLow,
  'r.stagger': stagger,
  'r.crumple': crumple,
  'r.launch': launch,
  'r.airFlail': airFlail,
  'r.spinFall': spinFall,
  'r.knockdownBack': knockdownBack,
  'r.knockdownFace': knockdownFace,
  'r.sweepFall': sweepFall,
  'r.wallSplat': wallSplat,
  'r.wallSlide': wallSlide,
  'r.getUp': getUp,
  'r.getUpRoll': getUpRoll,
  'r.groundBounce': groundBounce,
  'r.koFall': koFall,
  'r.koSlump': koSlump,
};
