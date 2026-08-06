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

import { ease } from '../AnimationFormat.js';
import { STANCE, STANCE_Y, CROUCH, add, over, makeClip, pinAt, carry } from './idle.js';

// ---------------------------------------------------------------------------
// OVERLAPPING ACTION — `whip`.
//
// `makeClip` transposes whole-body keyframes, so every bone in a clip comes out
// keyed on ONE SHARED TIME GRID: the head's key times are exactly the hips'.
// That is why the whole library moved as one rigid jointed object — the head
// arrives with the chest and the fist arrives with the hips, because the format
// gives them no way not to. Authoring whole poses is worth keeping (it is what
// makes "never move a limb in isolation" enforceable); what it cannot express
// is that the pelvis gets there FIRST.
//
// `whip` fixes that after the fact by re-timing, not re-posing. Each track is
// pushed later by a delay proportional to how far down the kinetic chain the
// bone sits — hips 0, spine01 0.20W, chest 0.50W, head 1.00W, and the same
// walk out each arm and leg. The delay tapers to zero at the clip's end, so
// the pose at t=0 and at t=duration is bit-for-bit what it was: this changes
// WHEN a joint does its moving, never where it ends up.
//
// While a distal track is still holding its opening value its bone is simply
// carried by its parent — dragged, not driven — and then has to cover its own
// rotation in a shorter window, which is the snap. Both halves of "the hips
// lead, the head lags" fall out of the one operation.
//
// An ATTACK cannot be re-timed that loosely: its `impact.tick` is load-bearing,
// pinned to a move's first active frame, and the hitbox capsule rides a bone
// whose position on that exact tick is what `tools/check.mjs` measures. So an
// attack passes `pivot: clip.impact.tick`. `whip` then splits the taper in two —
// full delay at t=0 falling to zero at the pivot, full delay again just past it
// falling to zero at the end — and PINS the pivot by first inserting a real key
// there at the value the track already interpolated to. Contact frame out is
// bit-identical to contact frame in; measured at 0.00mm across all 33 striking
// clips, against 87mm for the naive version that shifted keys without pinning.
//
// MEASURED, not asserted. The metric is the head's angular-speed centroid
// minus the hips', sampled through the real skeleton in world space (a bone
// with no track of its own still swings when its parent rotates, so this is a
// world question and reading the authored Euler tracks answers the wrong one).
// Per-clip W was swept and kept only where the lag and the chain's monotonicity
// improved and NOTHING regressed — not contact-frame speed ratio, not
// follow-through past contact, not single-tick hurtbox travel. Eleven of the
// twenty-one reactions here are whipped; the ten that are not (r.blockLow,
// r.stagger, r.airFlail, r.spinFall, r.knockdownFace, r.wallSlide, r.getUp,
// r.getUpRoll, r.groundBounce, r.koSlump) failed that test at every W and ship
// unchanged. r.airFlail could not be whipped at all — it loops. Across the
// whole library the head-lag centroid went 0.48 -> 1.07 ticks and chain
// monotonicity 0.47 -> 0.57, with zero clips regressing on either.
//
// TWO THINGS THIS IS NOT. It is not a substitute for authoring the recovery of
// an attack, which is where the remaining negative lag lives — k.roundhouse
// (-3.7), p.overhand (-3.3), sp.chargeShoulder (-3.5) and k.highKick (-2.1)
// hold their contact pose and then unwind the whole chain on one grid, and no
// re-time reaches that. They need re-posing. And this function belongs next to
// `makeClip` in idle.js rather than here — it is general authoring machinery
// that reactions.js merely happens to own this round.
// ---------------------------------------------------------------------------

/** Fraction of the whip budget each joint is delayed by, walking distally. */
const CHAIN = (() => {
  const f = { spine01: 0.20, spine02: 0.35, chest: 0.50, neck: 0.78, head: 1.0 };
  for (const s of ['L', 'R']) {
    f[`clavicle_${s}`] = 0.28; f[`shoulder_${s}`] = 0.50; f[`elbow_${s}`] = 0.74;
    f[`wrist_${s}`] = 0.90; f[`hand_${s}`] = 1.0;
    f[`hip_${s}`] = 0.22; f[`knee_${s}`] = 0.52; f[`ankle_${s}`] = 0.80; f[`foot_${s}`] = 1.0;
  }
  return f;
})();

/**
 * Push each track later down the kinetic chain. Mutates and returns `clip`.
 * @param {import('../AnimationFormat.js').Clip} clip
 * @param {number} W whip budget in ticks — the delay applied to the chain tips
 * @param {{ pivot?: number, only?: Record<string, number> }} [opts]
 *   `pivot` is a tick whose pose must survive the re-time untouched (an
 *   attack's `impact.tick`); `only` overrides the per-bone chain fractions.
 */
export function whip(clip, W, opts = {}) {
  // A looping clip cannot be whipped this way: holding a track's opening value
  // for the first `d` ticks would hitch once per cycle rather than read as lag.
  if (!(W > 0) || clip.loop) return clip;
  const D = clip.duration;
  const { pivot, only } = opts;
  const T = pivot > 0 && pivot < D ? pivot : null;
  for (const bone in clip.tracks) {
    // A single-key track is a bone that holds one value all clip; there is
    // nothing to delay, and a loop's re-stamped closing key must not drift.
    if (clip.tracks[bone].length < 2) continue;
    const frac = (only && bone in only) ? only[bone] : CHAIN[bone];
    const d = (frac || 0) * W;
    if (!(d > 0)) continue;
    const keys = T === null ? clip.tracks[bone] : pinAt(clip.tracks[bone], T);
    for (const k of keys) {
      if (T === null) k.t = Math.min(D, k.t + d * (1 - k.t / D));
      else if (k.t < T) k.t += d * (1 - k.t / T);
      else if (k.t > T) k.t = Math.min(D, k.t + d * (1 - (k.t - T) / (D - T)));
    }
    // The taper keeps times ascending for any W < duration, but clamping at D
    // can still collide two keys at the very end. Nudge rather than reorder.
    for (let i = 1; i < keys.length; i++) if (keys[i].t <= keys[i - 1].t) keys[i].t = keys[i - 1].t + 1e-3;
    clip.tracks[bone] = keys;
  }
  return clip;
}

// ---------------------------------------------------------------------------
// `lead` — the half of the kinetic chain that `whip` structurally cannot reach.
//
// MEASURED FIRST. Driving all 34 clips that declare an `impact` through the real
// rig and taking each chain link's tick of PEAK angular speed:
//
//   hips->tip lag        median 0 ticks, and in 24 of 34 the striking tip peaks
//                        at or BEFORE the hips
//   hips at contact      median 1.00 of the hips' own peak; in 17 of 34 the
//                        pelvis is at 90%+ of its top speed on the exact frame
//                        the blow lands
//   chain concordance    median 0.50 — pure chance, i.e. no ordering at all
//
// p.straight, p.uppercut, p.overhand, p.hook, p.elbow, k.highKick and k.midKick
// all peak every link of the chain — hips, spine01, spine02, chest, shoulder,
// elbow, wrist — on ONE tick. That is not a chain, it is a rigid body, and
// CRITIC.md's 90+ text for this axis is literally "the hips lead, the head lags".
//
// WHY `whip` DOES NOT FIX IT. `whip` delays distal bones, but on an attack its
// taper is `d * (1 - k.t / T)`, which goes to zero AT the pivot. Every bone's
// drive therefore still converges on the contact tick no matter what W is, so
// the peaks stay simultaneous by construction. That is the mechanism behind its
// own honest note that the residual "needs re-posing" — it does not; it needs
// the dual operation.
//
// WHAT THIS DOES. It advances the PROXIMAL tracks instead: the drive between
// tick 0 and the pivot is compressed by `d` ticks and the authored contact value
// is then HELD from `T - d` to `T`. So the pelvis arrives early and locks, and
// the arm covers the last few ticks on its own — which is what transfers
// momentum in a real strike, and it is why the hips are nearly stopped at
// contact in any reference footage.
//
// The pose ON the contact tick is bit-identical because the held value IS the
// authored one; tick 0 and the final tick are untouched because the map fixes
// t=0 and nothing past the pivot moves. `impact.tick`, `duration` and every
// startup/active/recovery count are therefore unchanged — verified pointwise
// against all three poses on every clip below.
//
// `d` is capped at 0.30 of the startup so a 10-tick jab cannot lock its pelvis
// for eight ticks. At 60Hz the kept budgets put the pelvis 0.8-6 ticks (13-100ms)
// ahead of contact, which is the range a real cross or roundhouse sits in.
//
// Applied only where a per-clip sweep improved chain concordance and NOTHING
// regressed: not the contact-frame speed ratio, not follow-through past contact,
// not worst single-tick hurtbox travel, not any of the three pinned poses.
// 27 of 34 clips passed. Across all 34: concordance 0.50 -> 0.73, hips-at-contact
// 1.00 -> 0.00, hips->tip lag 0 -> 4 ticks.

/** Fraction of the lead budget each joint arrives EARLY by, walking distally. */
const LEAD_CHAIN = { hips: 1.0, spine01: 0.78, spine02: 0.58, chest: 0.40, clavicle_L: 0.24, clavicle_R: 0.24 };

/** The hips may never arrive more than this fraction of the startup early. */
const LEAD_CAP = 0.30;

/**
 * Advance the proximal chain so it arrives before the blow and holds.
 * Mutates and returns `clip`.
 * @param {import('../AnimationFormat.js').Clip} clip
 * @param {number} L lead budget in ticks — the advance applied to the hips
 * @param {{ pivot: number, chain?: Record<string, number> }} opts
 *   `pivot` is the tick whose pose must survive untouched (an attack's
 *   `impact.tick`); `chain` overrides the per-bone lead fractions.
 */
export function lead(clip, L, opts = {}) {
  const T = opts.pivot;
  if (!(L > 0) || clip.loop || !(T > 1) || T >= clip.duration) return clip;
  const frac = opts.chain || LEAD_CHAIN;
  for (const bone in clip.tracks) {
    const f = frac[bone];
    if (!(f > 0)) continue;
    const d = Math.min(f * L, LEAD_CAP * T);
    if (!(d > 1e-6)) continue;
    // A real key at the pivot is what gets held; without one the compression
    // would drag the contact pose earlier along with everything else.
    const keys = pinAt(clip.tracks[bone], T);
    const s = (T - d) / T;
    const out = [];
    let pinned = null;
    for (const k of keys) {
      if (k.t < T - 1e-9) out.push({ ...k, t: k.t * s });
      else if (Math.abs(k.t - T) < 1e-9) { pinned = k; out.push({ ...k, t: T - d }); }
      else out.push({ ...k });
    }
    if (pinned) {
      const i = out.findIndex((k) => k.t > T);
      const held = { t: T, r: [...pinned.r], ease: pinned.ease };
      if (i < 0) out.push(held); else out.splice(i, 0, held);
    }
    for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) out[i].t = out[i - 1].t + 1e-3;
    clip.tracks[bone] = out;
  }
  return clip;
}

// `carry` — the operator that stops the body stopping dead on every interior
// key — lives in idle.js, next to `makeClip`. It is general authoring machinery
// and idle.js is the only file in this directory with no imports of its own, so
// putting it there is what lets idle.js and locomotion.js use it too. Those two
// are most of the screen time and no operator had ever covered them.

// ---------------------------------------------------------------------------
// Solved leg sets.
// ---------------------------------------------------------------------------
const L_BRACE = { hip_L: [-43, 4.9, 11], knee_L: [71.9, 0, 0], ankle_L: [-28.5, 2.4, 0], hip_R: [-3.4, 6, -12.1], knee_R: [48.6, 0, 0], ankle_R: [-38.5, -21.3, 0] };
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
/**
 * Airborne legs WOUND rather than mirrored. `L_AIRBORNE_UP` abducts both hips by
 * the same 4deg and flexes both knees to within 24deg of each other, which is a
 * pair of near-parallel sticks; the two sets below tuck one knee hard (interior
 * ~80deg) and leave the other trailing half-open (~150deg), and swap which leg
 * is which. A thrown body's legs are never doing the same thing.
 */
const L_SPIRAL_TUCK_L = { hip_L: [-122, 20, 26], knee_L: [98, 0, 0], ankle_L: [-36, 6, 0], hip_R: [-64, -22, -10], knee_R: [26, 0, 0], ankle_R: [14, -4, 0] };
const L_SPIRAL_TUCK_R = { hip_L: [-78, 14, 20], knee_L: [30, 0, 0], ankle_L: [10, 4, 0], hip_R: [-110, -26, -14], knee_R: [92, 0, 0], ankle_R: [-32, -6, 0] };
/** Dead weight: knees soft, ankles loose, no muscle anywhere. */
const L_LIMP = { hip_L: [-26, 6, 9], knee_L: [46, 0, 0], ankle_L: [16, 0, 0], hip_R: [-14, -6, -10], knee_R: [58, 0, 0], ankle_R: [12, 0, 0] };
/**
 * The same dead weight, wound. `L_LIMP` puts the two knees 12deg apart, which
 * on a body being carried by momentum reads as a mannequin; these two put them
 * ~50deg apart and swap which leg is folded, so alternating them across a
 * loop's keys turns the legs over instead of bobbing them.
 */
const L_LIMP_A = { hip_L: [-46, 16, 15], knee_L: [80, 0, 0], ankle_L: [24, 0, 0], hip_R: [-6, -18, -8], knee_R: [28, 0, 0], ankle_R: [6, 0, 0] };
const L_LIMP_B = { hip_L: [-10, 12, 7], knee_L: [24, 0, 0], ankle_L: [8, 0, 0], hip_R: [-42, -22, -13], knee_R: [84, 0, 0], ankle_R: [20, 0, 0] };

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
/**
 * THE OFF-ARM COUNTER-SWING. `A_TRAIL` throws both arms back by 64 and 72deg
 * with both elbows open to 133 and 141deg interior — two parallel sticks, held
 * frozen for the twenty ticks a juggle parks the pose on screen. These two sets
 * are the two halves of one swing rather than a mirrored pair: one arm is flung
 * back over the head with the elbow broken to ~90deg interior while the other is
 * dragged ACROSS the chest with the elbow broken to ~70, and `_B` swaps which
 * arm is doing which. Alternating them through a clip drives the shoulder plate
 * around the spine instead of carrying it square.
 */
const A_SPIRAL_A = {
  clavicle_L: [-12, -16, 14], shoulder_L: [88, -26, -34], elbow_L: [-92, 28, 26], wrist_L: [22, 0, 0], hand_L: [28, 0, 0],
  clavicle_R: [4, 16, -2], shoulder_R: [22, 28, 56], elbow_R: [-112, -36, -20], wrist_R: [-16, 0, 0], hand_R: [-22, 0, 0],
};
const A_SPIRAL_B = {
  clavicle_L: [4, -14, -4], shoulder_L: [18, -30, -58], elbow_L: [-116, 32, 22], wrist_L: [-18, 0, 0], hand_L: [-24, 0, 0],
  clavicle_R: [-12, 20, -14], shoulder_R: [94, 24, 30], elbow_R: [-86, -24, -28], wrist_R: [20, 0, 0], hand_R: [26, 0, 0],
};

/**
 * THE SPINE-TWIST CHANNEL.
 *
 * A thrown body spirals; ours translated. Measured through the rig, the heading
 * of the shoulder plate (clavicle_L -> clavicle_R) against the heading of the
 * pelvis plate (hip_L -> hip_R) sat at 10.6deg averaged over `r.launch`'s
 * airborne window and fell to 0.7deg at the top of the arc, against about 35deg
 * on a matched Tekken
 * airborne frame — the two plates stayed parallel and only the Y coordinate
 * changed, which is an elevator rather than a launch.
 *
 * `SPIRAL(k, roll)` is a whole-torso delta that winds the ribcage `k` degrees
 * against the pelvis and rolls it `roll` degrees on top: the pelvis takes 30%
 * of the turn the other way, the three spine joints share the rest of it, and
 * the skull is driven a further `lead` fraction PAST the chest (positive) or
 * held back behind it (negative), so the head leads or lags instead of riding
 * square to the shoulders. Sign convention is idle.js's: +Y turns toward the
 * fighter's left, +Z tilts onto the right shoulder.
 *
 * It is a delta, so it composes with `add()` over any pose and leaves the
 * clip's own pitch curve — which the juggle physics is timed against —
 * untouched.
 *
 * Note that the three spine deltas SUM to `k` rather than each carrying it —
 * these are additive over a parent chain, so a per-bone `k` would deliver 1.8k
 * of shoulder turn. The first draft did exactly that and put the plates 172deg
 * apart, i.e. the shoulders on backwards.
 */
const SPIRAL = (k, roll = 0, lead = 0.4) => ({
  hips: [0, -0.3 * k, -0.22 * roll],
  spine01: [0, 0.18 * k, 0.18 * roll],
  spine02: [0, 0.3 * k, 0.3 * roll],
  chest: [0, 0.52 * k, 0.52 * roll],
  neck: [0, 0.3 * lead * k, 0.3 * roll],
  head: [0, 0.7 * lead * k, 0.7 * roll],
});
/** No tone at all: shoulders hang, elbows half open, wrists broken. */
const A_LIMP = {
  clavicle_L: [4, 0, -6], shoulder_L: [8, 0, -30], elbow_L: [-34, 0, 8], wrist_L: [16, 0, 0], hand_L: [22, 0, 0],
  clavicle_R: [4, 0, 6], shoulder_R: [10, 0, 28], elbow_R: [-30, 0, -8], wrist_R: [16, 0, 0], hand_R: [22, 0, 0],
};
/**
 * Dead-weight arms with the elbows actually broken. `A_LIMP` leaves both at 34
 * and 30deg of flex — 146 and 150deg interior, which is a pair of straight
 * sticks — and mirrors them exactly. These hold ~100 and ~75deg interior on
 * opposite sides and swap over, so the off-arm counter-swings the torso's turn
 * rather than tracking it.
 */
const A_LIMP_A = {
  clavicle_L: [6, -8, -10], shoulder_L: [34, -14, -44], elbow_L: [-80, 18, 14], wrist_L: [20, 0, 0], hand_L: [26, 0, 0],
  clavicle_R: [0, 10, 8], shoulder_R: [-16, 16, 20], elbow_R: [-106, -22, -10], wrist_R: [10, 0, 0], hand_R: [16, 0, 0],
};
const A_LIMP_B = {
  clavicle_L: [0, -10, -6], shoulder_L: [-12, -18, -22], elbow_L: [-110, 24, 8], wrist_L: [12, 0, 0], hand_L: [18, 0, 0],
  clavicle_R: [6, 12, 10], shoulder_R: [38, 12, 42], elbow_R: [-76, -16, -16], wrist_R: [22, 0, 0], hand_R: [28, 0, 0],
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
const blockHigh = whip(makeClip('r.blockHigh', { duration: 20, blendIn: 2, blendOut: 4 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 3, ease: 'cubic', pose: add(GUARD_HIGH, { chest: [3, 0, 0], head: [4, 0, 0], elbow_L: [-6, 0, 0], elbow_R: [-4, 0, 0], knee_L: [6, 0, 0], knee_R: [6, 0, 0] }), root: [0, GUARD_HIGH_Y - 0.02, -0.05] },
  { t: 7, ease: 'sine', pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.04] },
  { t: 14, ease: 'sine', pose: add(GUARD_HIGH, { spine02: [-1, 0, 0], chest: [-1.5, 0, 0], clavicle_L: [0, 0, 1.5], clavicle_R: [0, 0, -1.5] }), root: [0, GUARD_HIGH_Y + 0.006, -0.04] },
  { t: 20, pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.04] },
]), 5);

const GUARD_LOW_POSE = add(over(CROUCH, A_GUARD_LOW), { hips: [0, 4, 0], chest: [2, 2, 0], head: [4, 2, 0] });
const blockLow = makeClip('r.blockLow', { duration: 20, blendIn: 2, blendOut: 4 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 4, ease: 'cubic', pose: add(GUARD_LOW_POSE, { hips: [4, 0, 0], chest: [3, 0, 0], head: [4, 0, 0] }), root: [0, -0.335, -0.05] },
  { t: 8, ease: 'sine', pose: GUARD_LOW_POSE, root: [0, -0.315, -0.04] },
  { t: 15, ease: 'sine', pose: add(GUARD_LOW_POSE, { chest: [-1.5, 0, 0], head: [-1, 0, 0] }), root: [0, -0.308, -0.04] },
  { t: 20, pose: GUARD_LOW_POSE, root: [0, -0.315, -0.04] },
]);

// The blocked hit itself: the guard is driven into the face for two ticks, the
// feet are pushed 22cm and the fighter has to re-set the elbows afterwards.
const blockImpact = whip(makeClip('r.blockImpact', { duration: 18, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.04] },
  { t: 2, ease: 'quad', pose: add(GUARD_HIGH, { hips: [-4, 3, 0], spine01: [-5, 0, 0], spine02: [-6, 0, 0], chest: [-7, 2, 2], neck: [-4, 0, 0], head: [-9, 2, 2], clavicle_L: [4, 0, -6], clavicle_R: [4, 0, 6], shoulder_L: [12, 0, 8], shoulder_R: [10, 0, -8], elbow_L: [8, 0, 0], elbow_R: [6, 0, 0], knee_L: [12, 0, 0], knee_R: [10, 0, 0] }), root: [0, GUARD_HIGH_Y - 0.035, -0.14] },
  { t: 6, ease: 'cubic', pose: add(GUARD_HIGH, { hips: [-2, 1, 0], chest: [-3, 1, 1], head: [-4, 1, 1], shoulder_L: [5, 0, 3], shoulder_R: [4, 0, -3], knee_L: [6, 0, 0], knee_R: [5, 0, 0] }), root: [0, GUARD_HIGH_Y - 0.02, -0.24] },
  { t: 11, ease: 'sine', pose: add(GUARD_HIGH, { chest: [2, 0, 0], head: [2, 0, 0], elbow_L: [-5, 0, 0], elbow_R: [-4, 0, 0] }), root: [0, GUARD_HIGH_Y, -0.26] },
  { t: 18, pose: GUARD_HIGH, root: [0, GUARD_HIGH_Y, -0.26] },
]), 5);

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
const flinchHigh = whip(makeClip('r.flinchHigh', { duration: 18, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', easeBy: { head: 'snap', neck: 'snap' }, pose: add(STANCE, { neck: [-15, -5, -5], head: [-27, -11, -9], clavicle_L: [0, 0, 3], shoulder_L: [-4, 0, 0] }), root: [0, STANCE_Y, -0.025] },
  { t: 4, ease: 'quad', easeBy: { spine01: 'snap', spine02: 'snap', chest: 'snap', hips: 'snap', head: 'sine', neck: 'sine' }, pose: add(STANCE, { spine02: [-7, 2, 2], chest: [-13, 5, 4], neck: [-16, -4, -5], head: [-30, -10, -9], clavicle_L: [-3, 0, 6], clavicle_R: [-3, 0, -4], shoulder_L: [8, 0, 6], shoulder_R: [6, 0, -5], elbow_L: [10, 0, 0] }), root: [0, STANCE_Y - 0.008, -0.075] },
  { t: 6, ease: 'cubic', pose: add(over(STANCE, L_SKATE), { hips: [-7, 5, 2], spine01: [-6, 2, 1], spine02: [-8, 3, 2], chest: [-14, 6, 5], neck: [-11, -2, -4], head: [-23, -7, -7], clavicle_L: [-3, 0, 5], clavicle_R: [-3, 0, -4], shoulder_L: [10, 0, 7], shoulder_R: [8, 0, -6], elbow_L: [12, 0, 0], elbow_R: [8, 0, 0] }), root: [0, STANCE_Y - 0.012, -0.115] },
  { t: 10, ease: 'cubic', pose: add(over(STANCE, L_SKATE), { hips: [2, 1, 0], chest: [4, -2, -2], neck: [3, 1, 1], head: [9, 3, 3], shoulder_L: [-6, 0, -4], shoulder_R: [-4, 0, 3] }), root: [0, STANCE_Y - 0.004, -0.13] },
  { t: 13, ease: 'sine', pose: add(STANCE, { chest: [-2, 0, 0], head: [-4, -1, -1], shoulder_L: [2, 0, 2] }), root: [0, STANCE_Y, -0.135] },
  { t: 18, pose: STANCE, root: [0, STANCE_Y, -0.135] },
]), 6);

const flinchMid = whip(makeClip('r.flinchMid', { duration: 18, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', easeBy: { hips: 'snap', spine01: 'snap', spine02: 'snap', chest: 'snap' }, pose: add(STANCE, { hips: [6, 2, 0], spine01: [7, 0, 0], spine02: [8, 0, 0], chest: [7, 2, 0], neck: [4, 0, 0], head: [7, 0, 0], clavicle_L: [4, 0, -4], clavicle_R: [4, 0, 4], elbow_L: [-8, 0, 0], elbow_R: [-4, 0, 0] }), root: [0, STANCE_Y - 0.03, -0.045] },
  { t: 5, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_CLUTCH), T_FOLDED), root: [0, -0.14, -0.1] },
  { t: 9, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_CLUTCH), add(T_FOLDED, { hips: [-4, 0, 0], spine01: [-4, 0, 0], spine02: [-5, 0, 0], chest: [-5, 0, 0], head: [-5, 0, 0] })), root: [0, -0.115, -0.125] },
  { t: 13, ease: 'sine', pose: add(STANCE, { hips: [4, 2, 0], spine01: [4, 0, 0], chest: [4, 1, 0], head: [3, 0, 0], elbow_L: [-6, 0, 0] }), root: [0, STANCE_Y - 0.02, -0.13] },
  { t: 18, pose: STANCE, root: [0, STANCE_Y, -0.13] },
]), 6);

const flinchLow = whip(makeClip('r.flinchLow', { duration: 16, blendIn: 1, blendOut: 5 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', easeBy: { hip_L: 'snap', knee_L: 'snap', ankle_L: 'snap' }, pose: add(STANCE, { hip_L: [-8, 0, -6], knee_L: [12, 0, 0], hips: [3, 0, 4], chest: [3, 0, -2], head: [4, 0, -2] }), root: [0, STANCE_Y - 0.045, -0.02] },
  { t: 4, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE), { hips: [9, 4, 7], spine01: [7, 0, -2], spine02: [8, 0, -3], chest: [9, 2, -5], neck: [4, 0, 0], head: [10, 0, -4], clavicle_L: [5, 0, -4], shoulder_L: [10, 0, 6], elbow_L: [12, 0, 0], shoulder_R: [6, 0, -5] }), root: [0, -0.15, -0.055] },
  { t: 8, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE), { hips: [4, 2, 3], spine01: [3, 0, -1], chest: [4, 1, -2], head: [4, 0, -2], shoulder_L: [4, 0, 2] }), root: [0, -0.105, -0.07] },
  { t: 12, ease: 'sine', pose: add(STANCE, { hips: [-2, 0, 0], chest: [-2, 0, 0], head: [-3, 0, 0], knee_L: [-4, 0, 0] }), root: [0, STANCE_Y - 0.008, -0.075] },
  { t: 16, pose: STANCE, root: [0, STANCE_Y, -0.075] },
]), 5);

// ---------------------------------------------------------------------------
// r.stagger — two stumbled steps backwards. The torso oscillates twice against
// the feet, half a beat out of phase with them, and the arms windmill up on the
// first stumble and down on the second as the fighter fights for the balance.
// ---------------------------------------------------------------------------
const stagger = makeClip('r.stagger', { duration: 42, blendIn: 2, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 3, ease: 'quad', pose: add(STANCE, { spine02: [-8, 0, 3], chest: [-14, 4, 6], neck: [-10, -3, -4], head: [-24, -8, -8], clavicle_L: [-4, 0, 7], clavicle_R: [-4, 0, -6], shoulder_L: [14, 0, 8], shoulder_R: [12, 0, -7] }), root: [0, STANCE_Y - 0.01, -0.07] },
  { t: 10, ease: 'quad', pose: add(over(STANCE, L_SKATE, A_WINDMILL_UP), { hips: [-10, 8, 4], spine01: [-8, 3, 2], spine02: [-9, 4, 3], chest: [-12, 6, 5], neck: [-4, -2, -2], head: [-12, -5, -5] }), root: [0, STANCE_Y - 0.03, -0.3] },
  { t: 17, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_WINDMILL_DOWN), { hips: [10, -4, -3], spine01: [9, -2, -1], spine02: [10, -3, -2], chest: [12, -5, -4], neck: [-4, 2, 2], head: [-8, 4, 3] }), root: [0, -0.135, -0.42] },
  { t: 25, ease: 'quad', pose: add(over(STANCE, L_SKATE, A_WINDMILL_UP), { hips: [-8, 5, -3], spine01: [-7, 2, -2], spine02: [-8, 3, -2], chest: [-10, 4, -4], neck: [-3, -2, 2], head: [-9, -4, 4] }), root: [0, STANCE_Y - 0.025, -0.56] },
  { t: 32, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE, A_WINDMILL_DOWN), { hips: [8, -3, 2], spine01: [7, -2, 1], chest: [9, -3, 3], neck: [-3, 1, -1], head: [-6, 3, -2] }), root: [0, -0.16, -0.65] },
  { t: 37, ease: 'sine', pose: add(STANCE, { hips: [-3, 2, 0], chest: [-4, 0, 0], head: [-5, 0, 0], knee_L: [8, 0, 0], knee_R: [8, 0, 0], shoulder_L: [-8, 0, -5], shoulder_R: [-6, 0, 4] }), root: [0, STANCE_Y - 0.03, -0.69] },
  { t: 42, pose: STANCE, root: [0, STANCE_Y, -0.7] },
]);

// ---------------------------------------------------------------------------
// r.crumple — the counter-hit collapse. The spine gives before the legs do, so
// the fighter is already folded in half by the time the knees stop holding him,
// and the hands arrive at the floor after the head does.
// ---------------------------------------------------------------------------
const crumple = whip(makeClip('r.crumple', { duration: 54, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 4, ease: 'quad', pose: add(over(STANCE, A_CLUTCH), { hips: [6, 4, 0], spine01: [10, 0, 0], spine02: [11, 0, 0], chest: [12, 3, -2], neck: [6, 2, 0], head: [12, 2, 0], knee_L: [14, 0, 0], knee_R: [12, 0, 0], hip_L: [-10, 0, 0], hip_R: [-8, 0, 0] }), root: [0, -0.155, -0.05] },
  { t: 13, ease: 'cubic', pose: add(over(STANCE, A_PAW), { hips: [8, 6, -3], spine01: [14, 1, -2], spine02: [15, 2, -2], chest: [16, 4, -5], neck: [8, 2, 0], head: [14, 2, -2], hip_L: [-24, 0, 4], knee_L: [40, 0, 0], hip_R: [-20, 0, -4], knee_R: [38, 0, 0], ankle_L: [-12, 0, 0], ankle_R: [-10, 0, 0] }), root: [0, -0.32, -0.09] },
  { t: 24, ease: 'cubic', pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 6, -4], spine01: [16, 1, -3], spine02: [17, 2, -3], chest: [18, 4, -6], neck: [9, 2, 0], head: [16, 2, -3] }), root: [0, -0.46, -0.12] },
  { t: 36, ease: 'sine', pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 5, -5], spine01: [18, 1, -4], spine02: [19, 2, -4], chest: [20, 3, -8], neck: [10, 2, 0], head: [18, 1, -4], shoulder_L: [-14, 0, 0], shoulder_R: [-12, 0, 0], elbow_L: [16, 0, 0], elbow_R: [16, 0, 0] }), root: [0, -0.51, -0.14] },
  { t: 46, ease: 'sine', pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 5, -6], spine01: [19, 1, -4], spine02: [20, 2, -5], chest: [22, 3, -9], neck: [11, 2, 0], head: [20, 1, -5], shoulder_L: [-18, 0, 0], shoulder_R: [-16, 0, 0], elbow_L: [22, 0, 0], elbow_R: [22, 0, 0] }), root: [0, -0.535, -0.15] },
  { t: 54, pose: add(over(STANCE, L_KNEEL, A_PAW), { hips: [8, 5, -6], spine01: [20, 1, -4], spine02: [21, 2, -5], chest: [23, 3, -9], neck: [12, 2, 0], head: [21, 1, -5], shoulder_L: [-19, 0, 0], shoulder_R: [-17, 0, 0], elbow_L: [23, 0, 0], elbow_R: [23, 0, 0] }), root: [0, -0.54, -0.15] },
]), 5);

// ---------------------------------------------------------------------------
// r.launch — the whole body bent into a backward C. Two ticks of compression,
// then the pelvis is thrown forward and up while the shoulders, head and arms
// are left behind; the legs swing through last. Vertical travel is deliberately
// NOT in the root track — the juggle physics owns the height, and doubling it
// here would put the fighter through the ceiling.
//
// ROUND 15. THE BODY NOW TURNS OVER INSTEAD OF RIDING UP FACING FORWARD.
//
// Measured through the rig, the old clip's angle between the pelvis-to-head axis
// and vertical ran 5 / 17 / 27 / 31 / 36 / 28 degrees across t0..t30: over the
// whole launch the torso never left its own standing axis by more than 36
// degrees, so the only thing that changed was the Y coordinate the juggle
// physics was writing. That is precisely the critic's "two bodies each holding
// its own vertical axis with both hip lines level" — and it is why nothing in
// the delivered set reads as airborne. A rising body that stays upright reads as
// an elevator, not as a launch.
//
// `hips` X is the lever and it was the thing doing nothing: -10 at t7 and -17 at
// its extreme. It now folds to +16 on the two compression ticks and then pitches
// through -40 / -70 / -88, with the roll and yaw opening alongside it so the
// body turns about all three axes rather than hinging in the camera plane. The
// pelvis-to-head axis reaches 96 degrees — past horizontal — by the time the
// juggle hands over to `r.airFlail`, and the head, five ticks behind the pelvis
// on the whip chain, is dragged through the arc rather than carried level.
//
// The root track is untouched, both height and slide: the fighter's trajectory
// through the world is the juggle physics' business and this is only the pose it
// holds while travelling it. Nothing about the arc's shape, distance or timing
// moves — an A/B on this clip isolates the pose and only the pose.
// ---------------------------------------------------------------------------
// ROUND 18. THE BODY NOW SPIRALS INSTEAD OF TURNING OVER AS ONE PIECE.
//
// Round 15 got the pelvis-to-head axis past horizontal, and the critic's next
// note was that the two PLATES stay parallel while it does: the shoulder line's
// heading against the pelvis line's heading averaged 10.6deg over t2..t30 and
// collapsed to 0.7deg at the top of the arc, against about 35deg on a matched
// Tekken airborne frame. Both arms were also frozen at `A_TRAIL` from t13 to
// t30 with elbows open to 133 and 141deg interior, and both knees within 24deg
// of each other — near-straight sticks, held for the twenty-odd ticks a juggle
// parks this pose on screen.
//
// Three channels are added and the pitch curve is untouched, so the juggle
// physics' timing and the arc it is written against do not move:
//   * `SPIRAL(k, roll)` winds the ribcage against the pelvis, ramping
//     -10 / +16 / +27 / +35 / +40 across the five keys — a continuous turn, not
//     a static offset, which is the difference between a spiral and a blade.
//   * the arms alternate `A_SPIRAL_A` and `A_SPIRAL_B`, which are the two
//     halves of one counter-swing rather than a mirrored pair.
//   * the legs alternate `L_SPIRAL_TUCK_L` and `L_SPIRAL_TUCK_R`, so the tuck
//     swaps legs mid-flight.
// Measured over t2..t30 through the real skeleton: plate heading 10.6 -> 33.8deg
// (peak 45.6), elbow interior 117.7 -> 81.1deg, the two elbows 10.5 -> 21.9deg
// apart and the two knees 15.3 -> 35.8deg apart. The root track, the hips pitch
// curve and every key time are byte-identical, so the arc the juggle physics is
// written against has not moved: probed in-page, the victim's height at five,
// thirteen, twenty-one and thirty-one ticks past contact is 0.427 / 0.977 /
// 1.363 / 1.614m before AND after.
// The head's `lead` alternates sign key to key, so the skull leads the chest
// into the turn and then is left behind by it.
const launch = whip(makeClip('r.launch', { duration: 30, blendIn: 1, blendOut: 6 }, [
  { t: 0, ease: 'expo', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 2, ease: 'quad', pose: add(STANCE, { hips: [15, 3, -3], spine01: [6, 0, -2], spine02: [7, 0, -2], chest: [7, 3, -1], neck: [3, 0, 0], head: [7, 0, 1], knee_L: [22, 0, 0], knee_R: [19, 0, 0], hip_L: [-13, 0, 0], hip_R: [-10, 0, 0] }, SPIRAL(-10, -6, -0.5)), root: [0, -0.15, -0.01] },
  { t: 7, ease: 'quad', pose: add(over(STANCE, A_SPIRAL_A), { hips: [-40, 10, 8], spine01: [-9, 3, 3], spine02: [-10, 4, 4], chest: [-15, 7, 8], neck: [-7, -3, -4], head: [-20, -8, -10], hip_L: [-34, 0, 5], knee_L: [-20, 0, 0], hip_R: [-27, 0, -5], knee_R: [-16, 0, 0] }, SPIRAL(16, 15, 0.55)), root: [0, -0.03, -0.1] },
  { t: 13, ease: 'quad', pose: add(over(STANCE, L_SPIRAL_TUCK_L, A_SPIRAL_A), { hips: [-70, 17, 15], spine01: [-11, 4, 4], spine02: [-12, 5, 5], chest: [-18, 10, 10], neck: [-9, -4, -6], head: [-26, -11, -13] }, SPIRAL(27, 27, -0.35)), root: [0, 0.04, -0.22] },
  { t: 21, ease: 'sine', pose: add(over(STANCE, L_SPIRAL_TUCK_R, A_SPIRAL_B), { hips: [-88, 22, 21], spine01: [-12, 4, 5], spine02: [-13, 5, 5], chest: [-20, 11, 11], neck: [-10, -4, -6], head: [-29, -12, -14], hip_L: [10, 0, 0], hip_R: [13, 0, 0], knee_L: [18, 0, 0], knee_R: [14, 0, 0] }, SPIRAL(35, 36, 0.5)), root: [0, 0.06, -0.32] },
  { t: 30, pose: add(over(STANCE, L_SPIRAL_TUCK_R, A_SPIRAL_B), { hips: [-96, 24, 24], spine01: [-10, 4, 4], spine02: [-11, 5, 5], chest: [-17, 10, 10], neck: [-9, -4, -6], head: [-25, -11, -13], hip_L: [26, 0, 0], hip_R: [29, 0, 0], knee_L: [38, 0, 0], knee_R: [34, 0, 0] }, SPIRAL(40, 42, -0.55)), root: [0, 0.03, -0.4] },
]), 5);

// ---------------------------------------------------------------------------
// r.airFlail — the juggle hold. Everything is dead weight being carried by
// momentum: the limbs lag the torso and the whole body rotates slowly. Loops.
//
// The pelvis pitch here is the OTHER half of the launch's arc and has to be read
// with it: `r.launch` hands over at hips -96, and this loop used to sit at -10
// to -20, so a juggled fighter snapped 80 degrees back upright over the six
// ticks of blend and spent the rest of the juggle standing in mid-air. The loop
// now holds -78 to -92 — still oscillating by the same 10 degrees, so the hold
// is unchanged as a hold — and the handover costs about 10 degrees instead of
// 80. Nothing here is in the shot list; it is the continuity the launch edit
// would otherwise have broken.
// ---------------------------------------------------------------------------
//
// ROUND 18. The loop now WINDS as well as bobs. Its four keys alternate the
// wound limp sets and carry a `SPIRAL` that oscillates 34 / 56 / 23 / 49 — a
// loop cannot accumulate turn, but it can keep the two plates out of parallel
// on every frame of the cycle, which is what was missing: the shoulder-line
// against hip-line heading averaged 8.7deg here and touched 0.2; it now averages
// 23.0. Elbow interior went 147 -> 91deg and the two knees 20.6 -> 37.0deg apart.
const AIR = over(STANCE, L_LIMP, A_LIMP);
const airFlail = makeClip('r.airFlail', { duration: 36, loop: true, blendIn: 5, blendOut: 5 }, [
  { t: 0, ease: 'sine', pose: add(over(AIR, L_LIMP_A, A_LIMP_A), { hips: [-88, 6, 3], spine01: [-9, 2, 2], spine02: [-10, 2, 2], chest: [-10, 4, 5], neck: [-3, -2, -2], head: [-12, -4, -5] }, SPIRAL(34, 26, 0.5)), root: [0, -0.02, 0] },
  { t: 9, ease: 'sine', pose: add(over(AIR, L_LIMP_A, A_LIMP_B), { hips: [-82, 10, -2], spine01: [-5, 4, -2], spine02: [-6, 4, -2], chest: [-8, 8, -4], neck: [-2, -3, 2], head: [-9, -6, 4], shoulder_L: [-18, 0, -8], shoulder_R: [14, 0, 6], hip_L: [-14, 0, 0], hip_R: [10, 0, 0], knee_L: [-16, 0, 0], knee_R: [14, 0, 0] }, SPIRAL(56, 38, -0.4)), root: [0, 0.02, 0.03] },
  { t: 18, ease: 'sine', pose: add(over(AIR, L_LIMP_B, A_LIMP_B), { hips: [-92, 2, -4], spine01: [-11, 0, -3], spine02: [-12, 0, -3], chest: [-16, 1, -6], neck: [-5, 1, 3], head: [-19, 2, 6], shoulder_L: [10, 0, 6], shoulder_R: [-16, 0, -7], hip_L: [12, 0, 0], hip_R: [-12, 0, 0], knee_L: [18, 0, 0], knee_R: [-14, 0, 0] }, SPIRAL(23, 13, 0.6)), root: [0, 0.01, -0.02] },
  { t: 27, ease: 'sine', pose: add(over(AIR, L_LIMP_B, A_LIMP_A), { hips: [-86, -4, 4], spine01: [-8, -2, 3], spine02: [-9, -2, 3], chest: [-12, -4, 6], neck: [-3, 2, -3], head: [-13, 4, -6], shoulder_L: [-8, 0, -4], shoulder_R: [6, 0, 3], hip_L: [-6, 0, 0], hip_R: [6, 0, 0], knee_L: [-8, 0, 0], knee_R: [8, 0, 0] }, SPIRAL(49, 32, -0.5)), root: [0, -0.01, 0.01] },
]);

// ---------------------------------------------------------------------------
// r.spinFall — hit hard enough to be turned around in the air. The root yaws a
// full 400deg so the fighter over-rotates past facing and has to settle back;
// the limbs are flung outward by the spin and lag it by about a fifth of a turn.
//
// ROUND 18. The root yaw was doing all of the turning and the body rode it as
// one piece: the shoulder plate's heading against the pelvis plate's averaged
// 13.5deg over t4..t36 with both elbows locked near 127/133deg interior for
// twenty ticks; it now averages 37.0 and the elbows 91. The
// airborne keys now carry a `SPIRAL` that trails the pelvis consistently (the
// spin only goes one way, so the wind does not reverse) plus the wound limp
// sets. The landing key at t44 is untouched — it is a real floor contact.
// ---------------------------------------------------------------------------
const spinFall = makeClip('r.spinFall', { duration: 44, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0], ry: 0 },
  { t: 4, ease: 'quad', pose: add(over(STANCE, A_SPIRAL_A), { hips: [-10, -14, 8], spine01: [-6, -6, 4], spine02: [-7, -7, 5], chest: [-10, -12, 10], neck: [-4, 4, -3], head: [-12, 9, -8], knee_L: [-10, 0, 0], hip_L: [-16, 0, 0] }, SPIRAL(12, 10, 0.5)), root: [0, -0.03, -0.14], ry: 46 },
  { t: 14, ease: 'linear', pose: add(over(STANCE, L_LIMP_A, A_LIMP_A), { hips: [-14, -10, 16], spine01: [-8, -4, 8], spine02: [-9, -4, 9], chest: [-13, -8, 18], neck: [-4, 3, -6], head: [-15, 7, -14] }, SPIRAL(21, 18, -0.45)), root: [0, 0.02, -0.4], ry: 170 },
  { t: 26, ease: 'linear', pose: add(over(STANCE, L_LIMP_B, A_LIMP_B), { hips: [-12, -6, -14], spine01: [-7, -2, -7], spine02: [-8, -3, -8], chest: [-11, -5, -16], neck: [-3, 2, 5], head: [-13, 5, 12] }, SPIRAL(24, 21, 0.55)), root: [0, -0.04, -0.7], ry: 306 },
  { t: 36, ease: 'cubic', pose: add(over(STANCE, L_LIMP_B, A_LIMP_A), { hips: [16, 6, -6], spine01: [10, 2, -3], spine02: [11, 2, -3], chest: [14, 5, -7], neck: [4, -2, 2], head: [12, -4, 5] }, SPIRAL(14, 11, -0.4)), root: [0, -0.42, -0.9], ry: 392 },
  { t: 44, pose: add(PRONE, { hips: [0, -8, 0] }), root: [0, PRONE_Y, -1.0], ry: 400 },
]);

// ---------------------------------------------------------------------------
// Knockdowns. Four separate contacts: hips, shoulders, skull, then the limbs.
// ---------------------------------------------------------------------------
// ROUND 18. Only the four AIRBORNE keys are touched — from t21 the body is on
// the floor and the plates are supposed to be flat and parallel there, which is
// why this clip measured 0.0deg of divergence from t24 on and should keep doing
// so. Over t0..t17 it averaged 16.7deg with the two knees 24deg apart; it now
// averages 38.8 with them 63.5 apart, and t24..t58 still measures exactly 0.0.
const knockdownBack = whip(makeClip('r.knockdownBack', { duration: 58, blendIn: 2, blendOut: 10 }, [
  { t: 0, ease: 'quad', pose: add(over(STANCE, L_SPIRAL_TUCK_L, A_SPIRAL_A), { hips: [-14, 6, 3], spine01: [-9, 2, 2], spine02: [-10, 3, 3], chest: [-14, 6, 7], neck: [-5, -3, -4], head: [-17, -7, -8] }, SPIRAL(18, 15, 0.5)), root: [0, -0.02, -0.06] },
  { t: 8, ease: 'quad', pose: add(over(STANCE, L_SPIRAL_TUCK_L, A_SPIRAL_A), { hips: [-48, 4, 3], spine01: [-8, 2, 2], spine02: [-8, 2, 2], chest: [-12, 5, 6], neck: [-4, -2, -3], head: [-15, -6, -7] }, SPIRAL(23, 20, -0.4)), root: [0, -0.36, -0.24] },
  { t: 13, ease: 'snap', pose: add(over(STANCE, L_SPIRAL_TUCK_R, A_SPIRAL_B), { hips: [-70, 2, 2], spine01: [-6, 1, 1], spine02: [-6, 1, 1], chest: [-9, 3, 4], neck: [-4, -1, -2], head: [-13, -4, -5] }, SPIRAL(20, 17, 0.45)), root: [0, -0.7, -0.4] },
  { t: 17, ease: 'quad', pose: add(over(STANCE, L_SPIRAL_TUCK_R, A_SPRAWL), { hips: [-86, 0, 0], spine01: [-4, 0, 0], spine02: [-4, 0, 0], chest: [-6, 1, 2], neck: [-8, 0, -1], head: [-24, -2, -3] }, SPIRAL(10, 8, -0.3)), root: [0, -0.775, -0.5] },
  { t: 21, ease: 'cubic', pose: add(SUPINE, { hips: [2, 0, 0], neck: [4, 0, 0], head: [10, 0, 0], hip_L: [-40, 0, 0], hip_R: [-34, 0, 0], knee_L: [-22, 0, 0] }), root: [0, -0.75, -0.56] },
  { t: 27, ease: 'cubic', pose: add(SUPINE, { hip_L: [-18, 0, 0], hip_R: [-14, 0, 0], shoulder_L: [-6, 0, 6], shoulder_R: [-4, 0, -6] }), root: [0, SUPINE_Y, -0.6] },
  { t: 36, ease: 'sine', pose: add(SUPINE, { hips: [2, 0, 0], chest: [2, 0, 0], head: [-5, 0, 0], hip_L: [-4, 0, 0], knee_R: [-10, 0, 0] }), root: [0, SUPINE_Y, -0.63] },
  { t: 44, ease: 'sine', pose: add(SUPINE, { head: [3, 0, 2], shoulder_L: [3, 0, -3], knee_R: [6, 0, 0] }), root: [0, SUPINE_Y + 0.006, -0.64] },
  { t: 58, pose: SUPINE, root: [0, SUPINE_Y, -0.64] },
]), 5);

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
const sweepFall = whip(makeClip('r.sweepFall', { duration: 40, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 3, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP), { hips: [-16, 4, 4], spine01: [-8, 2, 2], spine02: [-9, 2, 2], chest: [-12, 4, 5], neck: [4, -2, -2], head: [10, -5, -5], clavicle_L: [-4, 0, 6], shoulder_L: [24, 0, 6], shoulder_R: [26, 0, -6], elbow_L: [30, 0, 0], elbow_R: [40, 0, 0] }), root: [0, -0.32, -0.06] },
  { t: 7, ease: 'snap', pose: add(over(STANCE, L_AIRBORNE_UP, A_TRAIL), { hips: [-58, 2, 2], spine01: [-8, 1, 1], spine02: [-9, 1, 1], chest: [-12, 2, 3], neck: [-4, -1, -1], head: [-14, -3, -3] }), root: [0, -0.68, -0.16] },
  { t: 11, ease: 'quad', pose: add(over(STANCE, L_AIRBORNE_UP, A_SPRAWL), { hips: [-86, 0, 0], spine01: [-3, 0, 0], chest: [-4, 1, 1], neck: [-8, 0, 0], head: [-26, -2, -2] }), root: [0, -0.79, -0.22] },
  { t: 16, ease: 'cubic', pose: add(SUPINE, { hips: [2, 0, 0], head: [10, 0, 0], hip_L: [-46, 0, 0], hip_R: [-40, 0, 0] }), root: [0, -0.755, -0.28] },
  { t: 24, ease: 'cubic', pose: add(SUPINE, { hip_L: [-14, 0, 0], hip_R: [-10, 0, 0] }), root: [0, SUPINE_Y, -0.32] },
  { t: 32, ease: 'sine', pose: add(SUPINE, { head: [-4, 0, 0], knee_R: [-8, 0, 0], shoulder_L: [-4, 0, 4] }), root: [0, SUPINE_Y, -0.34] },
  { t: 40, pose: SUPINE, root: [0, SUPINE_Y, -0.34] },
]), 5);

// ---------------------------------------------------------------------------
// Wall
// ---------------------------------------------------------------------------
const SPLAT = add(over(STANCE, L_SPLAT, A_SPREAD), T_SPLAT);
const wallSplat = whip(makeClip('r.wallSplat', { duration: 34, blendIn: 1, blendOut: 8 }, [
  { t: 0, ease: 'snap', pose: add(over(STANCE, A_TRAIL), { hips: [-12, 4, 2], spine01: [-8, 2, 1], chest: [-14, 5, 4], neck: [-6, -2, -2], head: [-18, -5, -5], hip_L: [-14, 0, 0], hip_R: [-10, 0, 0] }), root: [0, -0.06, 0.1] },
  { t: 3, ease: 'quad', pose: add(SPLAT, { hips: [-6, 0, 0], spine01: [-5, 0, 0], spine02: [-6, 0, 0], chest: [-8, 0, 0], neck: [-6, 0, 0], head: [-16, 0, 0], shoulder_L: [-6, 0, 8], shoulder_R: [-6, 0, -8], knee_L: [16, 0, 0], knee_R: [14, 0, 0] }), root: [0, -0.19, -0.06] },
  { t: 7, ease: 'cubic', pose: SPLAT, root: [0, -0.13, -0.04] },
  { t: 13, ease: 'sine', pose: add(SPLAT, { chest: [3, 0, 0], neck: [4, 0, 0], head: [12, 0, 0], shoulder_L: [4, 0, -6], shoulder_R: [4, 0, 6], elbow_L: [-10, 0, 0], elbow_R: [-10, 0, 0] }), root: [0, -0.15, -0.04] },
  { t: 22, ease: 'sine', pose: add(SPLAT, { hips: [6, 0, 0], spine01: [5, 0, 0], spine02: [5, 0, 0], chest: [8, 0, 0], neck: [6, 0, 0], head: [20, 0, 0], shoulder_L: [10, 0, -14], shoulder_R: [10, 0, 14], elbow_L: [-24, 0, 0], elbow_R: [-24, 0, 0], knee_L: [10, 0, 0], knee_R: [10, 0, 0] }), root: [0, -0.21, -0.02] },
  { t: 34, pose: add(SPLAT, { hips: [10, 0, 0], spine01: [8, 0, 0], spine02: [8, 0, 0], chest: [12, 0, 0], neck: [8, 0, 0], head: [24, 0, 0], shoulder_L: [16, 0, -20], shoulder_R: [16, 0, 20], elbow_L: [-34, 0, 0], elbow_R: [-34, 0, 0], knee_L: [18, 0, 0], knee_R: [18, 0, 0] }), root: [0, -0.28, -0.02] },
]), 6);

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
  { t: 28, ease: 'cubic', pose: add(over(STANCE, L_BUCKLE), { hips: [22, -4, 0], spine01: [12, 0, 0], spine02: [12, 0, 0], chest: [14, 2, -2], neck: [-6, 0, 0], head: [-10, 1, 0], clavicle_L: [0, 0, 2], shoulder_L: [-28, 0, -8], elbow_L: [-20, 0, 6], shoulder_R: [-22, 0, 8], elbow_R: [-16, 0, 0] }), root: [0, -0.23, -0.72] },
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
const koFall = whip(makeClip('r.koFall', { duration: 80, blendIn: 2, blendOut: 12 }, [
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
]), 5);

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

// ---------------------------------------------------------------------------
// VELOCITY CARRY. See the note above `carry` in idle.js. Three clips are
// absent: `r.stagger` (12 of 12 mid-flight keys are full stops, median carry
// 0.002, and it is the worst clip in the library by that measure -- but every N
// raises its worst planted-foot slide from 188 to 207-227 mm/tick, which is a
// stagger sliding rather than stumbling), `r.launch` (246 -> 389 mm/tick) and
// `r.airFlail` (36 -> 42). All three are the same failure: the smoothing moves
// velocity into the span where a foot is nominally planted.
// ---------------------------------------------------------------------------
const REACTION_CARRY = {
  'r.blockHigh': 2, 'r.blockLow': 2, 'r.blockImpact': 3, 'r.flinchHigh': 3,
  'r.flinchMid': 3, 'r.flinchLow': 3, 'r.crumple': 3, 'r.spinFall': 2,
  'r.knockdownBack': 3, 'r.knockdownFace': 3, 'r.sweepFall': 2,
  'r.wallSplat': 3, 'r.wallSlide': 3, 'r.getUp': 2, 'r.getUpRoll': 2,
  'r.groundBounce': 2, 'r.koFall': 3, 'r.koSlump': 2,
};
for (const id in REACTION_CARRY) carry(REACTION_CLIPS[id], { N: REACTION_CARRY[id] });
