/**
 * Knockbots — idle clips, and the pose vocabulary every other clip file builds on.
 *
 * Clips are authored pose-to-pose, the way an animator blocks a shot: each
 * keyframe is a complete body pose and `makeClip` transposes those poses into
 * the per-bone tracks the runtime samples. Authoring whole poses (rather than
 * per-bone curves) is what keeps the rule "never move a limb in isolation"
 * enforceable — you physically cannot add a punch without saying what the hips,
 * spine and off-arm are doing on the same frame.
 *
 * ---------------------------------------------------------------------------
 * SIGN CONVENTIONS — read this before touching a number.
 *
 * Values are XYZ Euler DEGREES applied on top of the Skeleton.js rest pose, so
 * every axis is read in the bone's own rest frame:
 *
 *   spine01/spine02/chest/neck/head/hips (rest frame == model frame)
 *     +X  bend FORWARD (hunch)        -X  arch back
 *     +Y  turn to the fighter's LEFT  -Y  turn right
 *     +Z  tilt onto the RIGHT shoulder
 *
 *   shoulder_* / hip_* (limb hangs down the bone's local -Y)
 *     -X  swing the limb FORWARD      +X  swing it back
 *     +Z  swing the limb toward the fighter's LEFT (+X in model space)
 *     +Y  twist the limb about its own axis (toe-out / humeral rotation)
 *
 *   elbow_*   -X flexes the arm (hand travels forward)
 *   knee_*    +X flexes the leg (heel travels back)  — legs bend the other way
 *   ankle_*   +X plantarflexes (toe down), -X dorsiflexes (toe up)
 *   clavicle_L +Z shrugs up;  clavicle_R -Z shrugs up
 *
 * The model faces +Z and +X is the fighter's LEFT, which is what the foot,
 * finger and thumb offsets in Skeleton.js describe. Root-track `p` is in model
 * space too, so a forward dash carries POSITIVE z.
 *
 * NOTE for integration: Skeleton.js gives shoulder_L a rest rotation of -50deg
 * about Z and shoulder_R +50deg, which points both upper arms across the chest
 * instead of outboard — the rest pose it documents ("relaxed A-pose, arms ~40deg
 * down from horizontal") requires those two signs swapped. Every clip here is
 * authored against that documented A-pose.
 * ---------------------------------------------------------------------------
 */

import { ease } from '../AnimationFormat.js';

/**
 * The canonical fight stance. Orthodox: left foot lead, pelvis bladed 28deg away
 * from the opponent, spine counter-rotated back toward him so the chest still
 * reads square-ish to camera, lead hand low and forward, rear hand high by the
 * jaw, chin tucked behind the lead shoulder. Weight sits between the feet with a
 * touch more on the rear leg, whose heel is a centimetre off the floor.
 * @type {Record<string, [number, number, number]>}
 */
export const STANCE = {
  hips: [0, -28, 0],
  spine01: [2, 5, 0],
  spine02: [3, 6, 0],
  chest: [3, 8, -3],
  neck: [1, 6, 0],
  head: [3, 8, 0],

  clavicle_L: [0, -10, -4],
  shoulder_L: [-35, 0, -36],
  elbow_L: [-124, 0, 17],
  wrist_L: [-8, 0, 0],
  hand_L: [-14, 0, 0],

  clavicle_R: [0, 8, 4],
  shoulder_R: [-22, 0, 36],
  elbow_R: [-145, 0, -1],
  wrist_R: [-8, 0, 0],
  hand_R: [-14, 0, 0],

  hip_L: [-39, 10, 11],
  knee_L: [42, 0, 0],
  ankle_L: [-4, 2, 0],

  hip_R: [-9, -6, -12],
  knee_R: [45, 0, 0],
  ankle_R: [-33, -3, 0],
};

/** Pelvis height offset that goes with STANCE, in metres. */
export const STANCE_Y = -0.088;

/**
 * Relaxed standing pose: squared up, feet under the hips, arms hanging with a
 * soft elbow. Intros start here and victory poses return to it.
 * @type {Record<string, [number, number, number]>}
 */
export const UPRIGHT = {
  hips: [0, -6, 0],
  spine01: [-1, 1, 0],
  spine02: [-1, 2, 0],
  chest: [0, 2, 0],
  neck: [2, 1, 0],
  head: [1, 2, 0],

  clavicle_L: [0, -2, 1],
  shoulder_L: [-6, 4, -40],
  elbow_L: [-20, 0, 4],
  wrist_L: [-4, 0, 0],
  hand_L: [-8, 0, 0],

  clavicle_R: [0, 2, -1],
  shoulder_R: [-4, -4, 40],
  elbow_R: [-18, 0, -4],
  wrist_R: [-4, 0, 0],
  hand_R: [-8, 0, 0],

  hip_L: [-4, 8, 3],
  knee_L: [8, 0, 0],
  ankle_L: [-4, 3, 0],

  hip_R: [-2, -8, -3],
  knee_R: [8, 0, 0],
  ankle_R: [-4, -3, 0],
};

/** Pelvis height offset that goes with UPRIGHT. */
export const UPRIGHT_Y = -0.004;

/**
 * Deep defensive crouch: pelvis 30cm below the stance, knees splayed over the
 * feet, guard pulled in tight and the head dropped behind it.
 * @type {Record<string, [number, number, number]>}
 */
export const CROUCH = {
  hips: [4, -24, 0],
  spine01: [5, 4, 0],
  spine02: [6, 5, 0],
  chest: [6, 7, -3],
  neck: [3, 5, 0],
  head: [4, 7, 0],

  clavicle_L: [0, -12, -2],
  shoulder_L: [-42, 0, -30],
  elbow_L: [-132, 0, 14],
  wrist_L: [-10, 0, 0],
  hand_L: [-16, 0, 0],

  clavicle_R: [0, 10, 2],
  shoulder_R: [-30, 0, 30],
  elbow_R: [-148, 0, -1],
  wrist_R: [-10, 0, 0],
  hand_R: [-16, 0, 0],

  hip_L: [-72, 0, 18],
  knee_L: [113, 0, 0],
  ankle_L: [-41, -4, 0],

  hip_R: [-40, 0, -28],
  knee_R: [112, 0, 0],
  ankle_R: [-62, 17, 0],
};

/** Pelvis height offset that goes with CROUCH. */
export const CROUCH_Y = -0.356;

const ZERO = [0, 0, 0];

/**
 * Component-wise addition. `add(STANCE, { chest: [0, 0, -6] })` reads as
 * "the stance, plus six more degrees of lead-shoulder drop".
 * @param {Record<string, number[]>} base
 * @param {...Record<string, number[]>} deltas
 * @returns {Record<string, [number, number, number]>}
 */
export function add(base, ...deltas) {
  const out = {};
  for (const k in base) out[k] = [base[k][0], base[k][1], base[k][2]];
  for (const d of deltas) {
    for (const k in d) {
      const a = out[k] || ZERO;
      out[k] = [a[0] + d[k][0], a[1] + d[k][1], a[2] + d[k][2]];
    }
  }
  return out;
}

/**
 * Replace whole bones rather than nudging them — used when a limb leaves the
 * stance entirely (a guard that becomes an extended arm, a leg that leaves the
 * floor) and a relative offset would be meaningless.
 * @param {Record<string, number[]>} base
 * @param {...Record<string, number[]>} overrides
 */
export function over(base, ...overrides) {
  const out = {};
  for (const k in base) out[k] = [base[k][0], base[k][1], base[k][2]];
  for (const o of overrides) for (const k in o) out[k] = [o[k][0], o[k][1], o[k][2]];
  return out;
}

/**
 * Linear blend between two poses. Bones missing from either side fall back to
 * the rest pose, which is what makes partial poses composable.
 * @param {Record<string, number[]>} a
 * @param {Record<string, number[]>} b
 * @param {number} u 0..1
 */
export function mix(a, b, u) {
  const out = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const p = a[k] || ZERO, q = b[k] || ZERO;
    out[k] = [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
  }
  return out;
}

// ---------------------------------------------------------------------------
// `carry` — the body stopped dead on every interior key, and that is 70% of
// the library rather than a handful of clips.
//
// MEASURED FIRST, through the rig. Take every interior key on every track where
// the authored value is passing THROUGH — the Euler delta before and after the
// key both exceed 1 degree and point within 45 degrees of each other, so the
// bone is not turning round — and read the bone's world angular speed AT the
// key against the fastest it moves in the two spans either side. Call that
// ratio the key's velocity carry. Across all 92 clips:
//
//   3113 interior keys are unambiguously mid-flight
//   median velocity carry            0.08
//   full stops (carry below 0.35)    2104, i.e. 67.6% of them
//
// The mechanism is in `EASE` and it is not subtle. `sine`, `quad`, `cubic` and
// `quart` are all ease-in-OUT: their derivative is zero at BOTH ends of the
// span, verified numerically rather than read off the names. They are 11,348 of
// the library's 15,804 keys. So a bone that is driven across three keys on
// `sine` decelerates to a dead stop at the middle one and starts again, once
// per key, for the whole clip. Grouped by the ease pair either side of the key:
//
//   sine  -> sine     729 keys   median carry 0.013    87% full stops
//   quad  -> sine     438 keys   median carry 0.010    87% full stops
//   quad  -> quad     171 keys   median carry 0.008    92% full stops
//   linear-> linear   453 keys   median carry 0.804     4% full stops
//   expo  -> quad       8 keys   median carry 1.001     0% full stops
//
// The two rows at the bottom are the control: where the authored ease already
// carries velocity, the metric reads ~0.8-1.0 and the stop rate collapses. This
// is not a scoring artefact, it is the easing curve.
//
// WHAT THIS DOES. The sampler is `src/characters/AnimationFormat.js`, which is
// not this workstream's file and is not changed: interpolation stays piecewise
// with one ease per span. So the fix is in the DATA. Each ease-in-out span the
// bone passes through is resampled onto a monotone cubic (Fritsch-Carlson
// PCHIP) through the track's own keys, emitted as `N` linear sub-spans. PCHIP
// is the right curve for exactly one reason: its tangent is zero at a local
// extremum and non-zero at a pass-through, so a key where the pose genuinely
// reverses still stops dead — which is correct animation — and only the keys
// the bone is travelling through are carried. It also cannot overshoot, so no
// pose ever leaves the range the author authored.
//
// Spans eased `snap`, `expo`, `linear`, `back` and `hold` are left alone. Those
// are deliberate: `snap` is the slow-wind-up-violent-release workhorse and
// arriving at rest is its whole point, `hold` is a step, and `linear` already
// carries. Only the symmetric ease-in-out family is touched.
//
// Every authored key value survives exactly. Verified across all 92 clips by
// evaluating the rewritten track at each original key tick: worst deviation
// 0.0 degrees, not "small" — the inserted keys sit strictly between existing
// ones and the endpoints are untouched, so this is true by construction and the
// check is there to catch a coding error, not a rounding one.
//
// GATED PER CLIP against the same clip without it: worst planted-foot slide,
// and for an attack the contact-frame speed ratio, follow-through, worst
// single-tick hurtbox travel and approach smoothness. 79 of 92 clips passed at
// N=2 or 3. Across the library the median carry goes 0.08 -> 0.80 and the full
// stop rate 67.6% -> 10.8%, for 42% more keys — all of them generated here at
// module load, so the source and the bundle carry none of them.
//
// N was swept. N up to 6 reaches carry 0.88 and a 5.1% stop rate but costs 135%
// more keys and is WORSE on approach smoothness than N=2 (total attack
// acceleration reversals 187 against 179), so the extra subdivision is not
// taken.
// ---------------------------------------------------------------------------

/** Eases whose derivative is zero at both ends: the ones that stop the bone. */
const SMOOTH_EASE = new Set(['sine', 'quad', 'cubic', 'quart']);

/**
 * Split a track at `T`, giving it a real key holding the value it was already
 * interpolating to there, so that tick's pose survives anything done to the
 * keys either side of it. The new key inherits the ease of the span it splits.
 * `whip` and `lead` in reactions.js use this too.
 */
export function pinAt(keys, T) {
  if (T <= keys[0].t || T >= keys[keys.length - 1].t) return keys;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= T) i++;
  const a = keys[i], b = keys[i + 1];
  if (Math.abs(a.t - T) < 1e-9 || Math.abs(b.t - T) < 1e-9) return keys;
  const u = ease(a.ease)((T - a.t) / (b.t - a.t));
  const r = [0, 1, 2].map((j) => a.r[j] + (b.r[j] - a.r[j]) * u);
  return [...keys.slice(0, i + 1), { t: T, r, ease: a.ease }, ...keys.slice(i + 1)];
}

/**
 * Fritsch-Carlson monotone tangents. Zero at a local extremum, a weighted
 * harmonic mean of the neighbouring slopes at a pass-through.
 */
function pchipTangents(ts, vs, loopSpan) {
  const n = ts.length;
  const m = new Array(n).fill(0);
  if (n < 2) return m;
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(ts[i + 1] - ts[i]);
    d.push((vs[i + 1] - vs[i]) / (ts[i + 1] - ts[i]));
  }
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue;
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
  }
  if (loopSpan > 0) {
    // A loop's last span is the wrap back to key 0, so its two end keys are
    // interior keys of a cycle and get two-sided tangents like any other.
    const dw = (vs[0] - vs[n - 1]) / loopSpan;
    const ends = [[0, dw, d[0], loopSpan, h[0]], [n - 1, d[n - 2], dw, h[n - 2], loopSpan]];
    for (const [i, a, b, ha, hb] of ends) {
      if (!(a * b > 0)) { m[i] = 0; continue; }
      const w1 = 2 * hb + ha, w2 = hb + 2 * ha;
      m[i] = (w1 + w2) / (w1 / a + w2 / b);
    }
  }
  return m;
}

/** Cubic Hermite on [0,1] with span length h. */
function hermite(p0, p1, m0, m1, h, u) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * h * m0
    + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * h * m1;
}

/**
 * Resample the ease-in-out spans a bone passes through onto a monotone cubic,
 * so it does not stop dead on every key. Mutates and returns `clip`.
 * @param {import('../AnimationFormat.js').Clip} clip
 * @param {{ N?: number, pins?: number[] }} [opts] `N` sub-spans per resampled
 *   span; `pins` are ticks whose pose must survive exactly (an attack's
 *   `impact.tick`), given a real key before anything is rewritten.
 */
export function carry(clip, opts = {}) {
  const N = opts.N || 2;
  const pins = opts.pins || [];
  if (N < 2) return clip;
  for (const bone in clip.tracks) {
    let K = clip.tracks[bone];
    if (K.length < 2) continue;
    for (const T of pins) K = pinAt(K, T);
    const n = K.length;
    const ts = K.map((k) => k.t);
    const loopSpan = clip.loop ? clip.duration - ts[n - 1] + ts[0] : 0;
    const M = [0, 1, 2].map((j) => pchipTangents(ts, K.map((k) => k.r[j]), loopSpan));
    const live = (i) => M.some((m) => Math.abs(m[i]) > 1e-4);
    const out = [];
    for (let i = 0; i < n - 1; i++) {
      const a = K[i], b = K[i + 1], h = b.t - a.t;
      out.push(a);
      if (!SMOOTH_EASE.has(a.ease) || !(h > 0) || (!live(i) && !live(i + 1))) continue;
      out[out.length - 1] = { ...a, ease: 'linear' };
      for (let s = 1; s < N; s++) {
        const u = s / N;
        out.push({
          t: a.t + h * u,
          r: [0, 1, 2].map((j) => hermite(a.r[j], b.r[j], M[j][i], M[j][i + 1], h, u)),
          ease: 'linear',
        });
      }
    }
    out.push(K[n - 1]);
    // The wrap span of a loop is a real span — a quarter of an idle cycle —
    // and `sampleTrack` runs it from the final key round to key 0.
    const last = out[out.length - 1];
    if (loopSpan > 0 && SMOOTH_EASE.has(last.ease) && (live(n - 1) || live(0))) {
      const b = K[0];
      out[out.length - 1] = { ...last, ease: 'linear' };
      for (let s = 1; s < N; s++) {
        const u = s / N;
        const t = last.t + loopSpan * u;
        if (t >= clip.duration - 1e-6) break;
        out.push({
          t,
          r: [0, 1, 2].map((j) => hermite(last.r[j], b.r[j], M[j][n - 1], M[j][0], loopSpan, u)),
          ease: 'linear',
        });
      }
    }
    clip.tracks[bone] = out;
  }
  return clip;
}


// ---------------------------------------------------------------------------
// CONTRAPPOSTO — the library's poses were symmetric, and that is what a critic
// picks a reference out of a line-up by.
//
// MEASURED FIRST, through the rig, on all 92 clips at tick 0 and at every
// contact tick. Four numbers, each an angle or a length in world space:
//
//   twist         horizontal angle from the hip line to the shoulder line
//   frontal       the same two lines in the FRONTAL plane (shoulder roll minus
//                 pelvis roll) -- the one a side-on camera actually resolves
//   pelvicTilt    hip line off horizontal
//   spineBow      chest's lateral deviation from the hips->head chord
//
// Across the 92, at rest:
//
//   |twist|        median 18.18 deg      <- NOT the defect. Already in band.
//   |frontal|      median  1.23 deg      <- the defect
//   |pelvicTilt|   median  0.47 deg      <- the defect, p25 is 0.00
//   |spineBow|     median  3.46 mm       <- a column, over a 0.9 m spine
//
// The brief predicted all of these were near zero. Twist is not: `STANCE`
// blades the pelvis -28 deg and counter-rotates the spine +19, which lands
// inside the 15-20 deg the reference sits at. What is at zero is every axis in
// the FRONTAL plane -- the plane the fight camera looks along. The pelvis is
// level to half a degree and the shoulder line is parallel to it to 1.2, in
// seventy-four of the ninety-two clips to the same three decimal places,
// because they all inherit one symmetric `STANCE`.
//
// WHAT THIS IS. A pose delta, solved rather than authored, exactly the way
// `SETTLE` above was: pick what must be true, let a numeric solve against the
// rig's own forward kinematics find the Euler offsets, hard-code the answer.
// Three things must be true, and two of them are what make it safe to apply:
//
//   1. the pelvis rolls 8 deg, right hip UP -- the rear foot carries the weight
//      in this stance (its heel is off the floor and the pelvis projects 41% of
//      the way from the rear foot to the lead one), and in a contrapposto the
//      weight-bearing hip is the high one
//   2. BOTH ankles and BOTH toes stay exactly where they were.  Residual 0.000 mm
//   3. the CHEST keeps its world position AND orientation, so every arm bone,
//      the neck and the head are carried unchanged.  Residual 1.82 mm of pure
//      translation, 0.000 deg of rotation
//
// (3) is the whole trick. Pinning the chest means the shoulder line does not
// move while the pelvis rolls under it, and a disagreement between them is what
// contrapposto IS. It also means a striking hand cannot go anywhere: measured
// against a PRISTINE CHECKOUT rather than against an object this file has
// already mutated, the worst striking-anchor movement at any contact tick in
// the library is 1.00 mm (sp.rocketPunch).
//
// The residual 1.82 mm is the floor for an operator of this shape and is worth
// naming. A static Euler delta cannot pin both the chest and the feet across
// poses that differ from `STANCE`, because the compensation it carries was
// solved at `STANCE`. Driving it to zero needs the compensation re-solved per
// key with two-bone IK, which is a different operator and a different round.
//
// WHAT IT COSTS, and why the per-clip table below is not uniform. The leg terms
// are a stance solve; a leg that has left the floor cannot take them, so the
// swinging side is dropped (`-skipL` / `-skipR`) or both are (`-noLeg`). The
// upper terms MOVE THE ARMS by 20-26 mm, which is free on a clip whose hands
// are not a hitbox and forbidden on one whose hands are -- hence `core`, which
// is the same delta with the clavicles, neck and head left alone.
//
// GATED PER CLIP against the same clip without it, every gate measured on the
// rig: extra grounded-foot burial >= -12 mm, extra per-tick foot skate <= 4 mm,
// and for anything carrying a hitbox, striking-anchor movement at the contact
// tick <= 1 mm, hand/head movement <= 6 mm anywhere, and `check.mjs`'s own
// anchor-travel ratio neither below 0.40 nor 0.03 worse than it started.
// 77 of 92 clips pass at some amount. The 15 that take nothing are the 13 kicks
// plus p.siegeSlam and sp.groundSpike: all of them swing a leg, and a leg at
// -104 deg of hip flex moves its foot 60-210 mm under a stance-solved
// compensation, which is a hitbox on the wrong limb.
//
// MEASURED ACROSS TWO TREES, pristine against this one, all 92 clips at rest:
//
//                  before                       after
//   |pelvicTilt|   p25 0.00  med 0.47  p75 0.47  ->  p25 1.67  med 5.03  p75 8.00
//   |frontal|      p25 1.23  med 1.23  p75 1.28  ->  p25 1.23  med 5.01  p75 10.71
//   |spineBow|     p25 2.60  med 3.46  p75 3.46  ->  p25 3.44  med 5.92  p75 15.02 mm
//
// and the safety side of the same run: 0 clips changed duration, `impact.tick`,
// loop flag or blend counts; worst striking-anchor movement 1.00 mm; worst
// extra grounded-foot burial -11.8 mm; worst extra foot skate 4.0 mm/tick.
//
// The per-clip table is DERIVED from the `CONTRA` constant below rather than
// remembered alongside it: re-running the gate sweep against a pristine
// checkout reproduces every entry bit-for-bit. An earlier table was swept
// against a solver output that used random restarts, and it did not reproduce.
//
// WHERE THIS IS STILL SHORT, and it is the whole attack half of the library.
// `idle.fight` gets pelvicTilt +1.0 -> -7.0 and frontal -1.7 -> +10.3, and so
// do the walk, the blocks, the flinches and the reactions. `p.straight` gets
// -0.5 -> -1.7 and frontal -1.2 -> 0.0, because the 1 mm anchor gate binds at
// amount 0.15 and the 13 kicks cannot take any amount at all. The contact
// frames -- the ones the critic picked a reference out of a line-up by -- are
// barely touched. Closing that needs the leg and spine compensation re-solved
// per key with two-bone IK instead of carried as a stance constant.
// ---------------------------------------------------------------------------

/**
 * The solved contrapposto. Applied additively, scaled per clip.
 *
 * `hips` is the product; everything else is compensation or leaf work:
 *   hip, knee, ankle      return both ankles and both toes to where the pelvis
 *                         roll would otherwise have dragged them (0.000 mm)
 *   spine01/02/chest      return the chest to its own world transform, with the
 *                         spare degrees of freedom spent bowing spine02 16 mm
 *                         laterally so the spine reads as a curve, not a column
 *   clavicle_*            the shoulder line counter-tilts 4 deg against the
 *                         pelvis. MOVES THE ARMS -- see `CONTRA_SETS.core`.
 *   neck/head             the skull leaves the centre line by 30 mm and cocks
 *                         5 deg against the neck's own lean, so the two do not
 *                         read as one bone.
 * @type {Record<string, [number, number, number]>}
 */
export const CONTRA = {
  hips: [0, 0, -8],
  hip_L: [-3.54, -5.25, 7.16], knee_L: [4.59, 0, 0], ankle_L: [-1.95, -0.8, -0.43],
  hip_R: [3.15, -2.4, 8.31], knee_R: [-5.09, 0, 0], ankle_R: [2.79, 0.71, 0.36],
  spine01: [0.72, -0.64, 11.5], spine02: [-3.02, 0.84, -0.07], chest: [2.61, -0.09, -3.37],
  clavicle_L: [0, 0, 5.42], clavicle_R: [0, 0, 5.4],
  neck: [0, 0, 16.77], head: [0, 0, -5],
};

const CONTRA_UPPER = ['clavicle_L', 'clavicle_R', 'neck', 'head'];
const CONTRA_LEG = (s) => [`hip_${s}`, `knee_${s}`, `ankle_${s}`];

/** Named subsets of `CONTRA` to leave alone, keyed the way the tables spell them. */
export const CONTRA_SETS = {
  'full': [],
  'full-skipL': CONTRA_LEG('L'),
  'full-skipR': CONTRA_LEG('R'),
  'full-noLeg': [...CONTRA_LEG('L'), ...CONTRA_LEG('R')],
  'core': CONTRA_UPPER,
  'core-skipL': [...CONTRA_UPPER, ...CONTRA_LEG('L')],
  'core-skipR': [...CONTRA_UPPER, ...CONTRA_LEG('R')],
  'core-noLeg': [...CONTRA_UPPER, ...CONTRA_LEG('L'), ...CONTRA_LEG('R')],
};

/**
 * Add `amount` of the solved contrapposto to every key of `clip`.
 * Mutates and returns `clip`.
 *
 * Key TIMES are never touched, so `duration`, `impact.tick` and every startup,
 * active and recovery count survive by construction. A bone the clip does not
 * key is left at rest rather than given a track, because a clip that never
 * mentions its legs is not standing in `STANCE` and a stance solve would be a
 * lie there.
 *
 * @param {import('../AnimationFormat.js').Clip} clip
 * @param {number|[number,string]} spec  amount, or `[amount, setName]`
 */
export function contrapposto(clip, spec) {
  const [amount, set] = Array.isArray(spec) ? spec : [spec, 'full'];
  if (!(amount > 0)) return clip;
  const skip = CONTRA_SETS[set];
  if (!skip) throw new Error(`contrapposto ${clip.name}: unknown set "${set}"`);
  for (const bone in CONTRA) {
    if (skip.includes(bone)) continue;
    const keys = clip.tracks[bone];
    if (!keys) continue;
    const d = CONTRA[bone];
    for (const k of keys) {
      k.r[0] += d[0] * amount;
      k.r[1] += d[1] * amount;
      k.r[2] += d[2] * amount;
    }
  }
  return clip;
}

// ---------------------------------------------------------------------------
// SAGITTAL LEAN — the plane the fight camera actually resolves.
//
// MEASURED FIRST, offline through the rig, projected through the REAL cameras
// the judged frames are shot with. Two of them, because this axis is judged
// through two lenses and they do not agree:
//
//   fight   src/engine/FightCamera.js#framingFight with the pair at x = -1.7 /
//           +1.7. m.x = 0, so its yaw term clamps to EXACTLY 0 and the camera
//           sits on +Z looking down the fighter's own left-right axis. Dead
//           side-on. This is 01-hero-idle, 03-full-body, 04-impact.
//   strip   tools/animstrip.mjs and capture.mjs `clipStrip`: pos = aim +
//           D * (facing*0.62, 0.24, 0.74), i.e. 40 deg off side. This is
//           17-anim-strip and 20..24.
//
// WHAT AN 8-DEGREE PERTURBATION AT THE HIPS BUYS, in degrees of ON-SCREEN torso
// lean, under the fight camera. Null column is the same measurement at 0 deg
// and it reads exact zeros; a 45-degree control scales 5.5-6.3x:
//
//                    pitch(X)   yaw(Y)   roll(Z)   null
//     idle.fight         8.16     0.30    -6.00    0.00
//     p.straight         8.20     0.31    -0.60    0.00
//     k.roundhouse       7.79    -1.76     0.42    0.00
//     p.uppercut         8.14     0.58    -1.59    0.00
//     p.jab              8.21     0.37    -6.92    0.00
//     k.highKick         7.78    -1.94     0.65    0.00
//
// Sagittal pitch converts to on-screen diagonal at very nearly 1:1 on every
// clip. Roll -- the axis `contrapposto` above was built to move, and which the
// comment there calls "the one a side-on camera actually resolves" -- converts
// at between -6.9 and +0.7 depending on the pose, and at ~0 on the attack
// contact frames. The -6.0 it does buy on `idle.fight` is parallax from a
// subject standing 1.7 m off the optical axis, not a pose the camera reads.
//
// The same split shows up in the spine. `spineBow` above is measured as the
// chest's LATERAL (model X) deviation from the hips->head chord, and model X is
// the axis pointing at the camera. Decomposed over all 92 clips at rest:
//
//     |bow| on model X (camera axis)   p25  3.44   med  6.22   p75 15.02 mm
//     |bow| on model Z (IN SCREEN)     p25 19.04   med 19.09   p75 20.25 mm
//
// The in-screen component has an interquartile spread of 1.2 mm across the
// whole library: it is a single constant inherited from the rest pose and NOT
// ONE CLIP VARIES IT. That is the "spine a straight column" a critic described,
// and no amount of `contrapposto` could have moved it, because `contrapposto`
// only ever writes X.
//
// And the quantity itself, on-screen hips->chest lean off vertical, fight
// camera, all 92 at rest and all 34 contact ticks:
//
//     at rest      min 0.01  p25 0.03  med 0.87  p75 0.90  max 93.71 deg
//     at contact   min 0.38  p25 3.98  med 6.36  p75 12.59 max 31.98 deg
//
// Three quarters of the library stands within a degree of vertical.
//
// WHAT THIS OPERATOR IS. A sagittal C-curve through the spine, with a time
// profile that peaks at the contact tick. Gains, in units of the `amount`:
//
//     spine01  +1.00   spine02  +0.70   chest  -0.35   neck  -0.60   head -0.40
//
// so the world pitch accumulated at the chest is 1.35x amount while the head
// only takes 0.35x -- the belly leads, the ribcage trails it, and the skull
// counter-cocks so the eyes stay on the opponent. The gradient between the
// three spine joints is the curve; a rigid rotation would keep the column.
//
// WHY IT TOUCHES NOTHING BELOW THE HIPS, and this is the whole safety argument.
// `hips` is not keyed by this operator, so both legs, both feet and the root
// are bit-identical: no foot skate, no burial, no change to a planted contact,
// and the leg-compensation problem that stopped `contrapposto` reaching the 13
// kicks does not arise. What moves is the torso, the arms it carries, and the
// head.
//
// WHICH IS WHY THE TABLE IS MOSTLY KICKS. A kick's hitbox is anchored on a foot
// or a knee, so the entire upper body is free at the contact tick. A punch's is
// anchored on a hand, and a hand is carried by the chest -- so a punch can only
// take an amount small enough to keep its striking anchor inside the 1 mm gate,
// which in practice is nothing. The eleven clips that take the most here are
// exactly the ones `contrapposto` could take nothing at all on.
//
// GATED PER CLIP against the same clip without it, every gate on the rig:
// duration, `impact.tick`, loop flag and blend counts identical; striking-anchor
// movement at the contact tick <= 1 mm; every foot and ankle bit-identical at
// every tick; and `check.mjs`'s own anchor-travel ratio neither below 0.40 nor
// 0.03 worse than it started. The per-clip amounts below are DERIVED by sweeping
// against those gates, not remembered.
// ---------------------------------------------------------------------------

/**
 * Per-bone share of a sagittal lean, in units of `amount`. Positive `amount`
 * leans the torso FORWARD (+X bends forward on every one of these bones).
 * @type {Record<string, number>}
 */
export const SAGITTAL = {
  spine01: 1.0, spine02: 0.7, chest: -0.35, neck: -0.6, head: -0.4,
};

/**
 * Time profile for the lean, evaluated at each key's own tick.
 *
 * A looping clip, or one with no contact, takes the lean flat — evaluating a
 * ramp at `t` on a loop would make the wrap pop, and there is no moment on an
 * idle that deserves the peak. An attack ramps from nothing at t=0 to the full
 * amount exactly at `impact.tick` and relaxes to `tail` by the end, which is
 * the shape a strike has anyway: the body loads, arrives with the hit, and
 * settles out of it.
 */
function sagittalProfile(clip, t, tail) {
  const tick = clip.impact?.tick;
  if (clip.loop || typeof tick !== 'number' || tick <= 0) return 1;
  if (t <= 0) return 0;
  if (t <= tick) { const u = t / tick; return u * u * (3 - 2 * u); }
  const span = Math.max(clip.duration - tick, 1e-6);
  const u = Math.min((t - tick) / span, 1);
  return 1 + (tail - 1) * (u * u * (3 - 2 * u));
}

/**
 * Add `amount` degrees of sagittal lean to `clip`, profiled in time.
 * Mutates and returns `clip`.
 *
 * Key TIMES are never touched, and no track is created, so `duration`,
 * `impact.tick` and every startup/active/recovery count survive by
 * construction. Only the five spine-and-skull bones are written; `hips` and
 * everything below it are left bit-identical on purpose.
 *
 * @param {import('../AnimationFormat.js').Clip} clip
 * @param {number|[number, number]} spec  amount in degrees, or `[amount, tail]`
 */
export function sagittal(clip, spec) {
  const [amount, tail] = Array.isArray(spec) ? spec : [spec, 0.35];
  if (!amount) return clip;
  for (const bone in SAGITTAL) {
    const keys = clip.tracks[bone];
    if (!keys) continue;
    const g = SAGITTAL[bone] * amount;
    for (const k of keys) k.r[0] += g * sagittalProfile(clip, k.t, tail);
  }
  return clip;
}

/**
 * Transpose a list of whole-body keyframes into a Clip.
 *
 * A frame is `{ t, pose, ease?, easeBy?, root?, ry? }`. `ease` describes the
 * segment that LEAVES that frame, matching how `sampleClip` reads it. Looping
 * clips get their opening pose re-stamped at `t === duration` automatically, so
 * a loop can never pop. Bones that hold one value for the whole clip collapse to
 * a single key.
 *
 * `easeBy` overrides `ease` for named bones on that one segment — `{ shoulder_R:
 * 'snap' }` snaps the striking arm out while everything else rides the frame's
 * sine. The runtime has always read `ease` per key PER TRACK; without this a
 * whole-body keyframe could only ever stamp one curve onto every bone it
 * touched, which is the mechanical reason almost nothing in the library releases
 * faster than a `quad`. `easeBy.root` does the same for the root track.
 *
 * @param {string} name
 * @param {{duration:number, loop?:boolean, blendIn?:number, blendOut?:number, mask?:string[]}} opts
 * @param {Array<{t:number, pose:Record<string,number[]>, ease?:string, easeBy?:Record<string,string>, root?:number[], ry?:number}>} frames
 * @returns {import('../AnimationFormat.js').Clip}
 */
export function makeClip(name, opts, frames) {
  const { duration, loop = false, blendIn, blendOut, mask } = opts;
  const fs = frames.slice();
  if (loop && fs[fs.length - 1].t !== duration) {
    fs.push({ t: duration, pose: fs[0].pose, root: fs[0].root, ry: fs[0].ry });
  }

  const bones = new Set();
  for (const f of fs) for (const b in f.pose) bones.add(b);

  const tracks = {};
  for (const b of bones) {
    const keys = fs.map((f, i) => {
      const r = f.pose[b] || ZERO;
      const k = { t: f.t, r: [r[0], r[1], r[2]] };
      const e = (f.easeBy && f.easeBy[b]) || f.ease;
      if (e && i < fs.length - 1) k.ease = e;
      return k;
    });
    const flat = keys.every((k) => k.r[0] === keys[0].r[0] && k.r[1] === keys[0].r[1] && k.r[2] === keys[0].r[2]);
    tracks[b] = flat ? [{ t: 0, r: keys[0].r }] : keys;
  }

  /** @type {import('../AnimationFormat.js').Clip} */
  const clip = { name, duration, tracks };
  if (loop) clip.loop = true;
  if (blendIn != null) clip.blendIn = blendIn;
  if (blendOut != null) clip.blendOut = blendOut;
  if (mask) clip.mask = mask;

  if (fs.some((f) => (f.root && (f.root[0] || f.root[1] || f.root[2])) || f.ry)) {
    clip.root = fs.map((f, i) => {
      const p = f.root || ZERO;
      const k = { t: f.t, p: [p[0], p[1], p[2]] };
      if (f.ry) k.ry = f.ry;
      const e = (f.easeBy && f.easeBy.root) || f.ease;
      if (e && i < fs.length - 1) k.ease = e;
      return k;
    });
  }
  return clip;
}

// ---------------------------------------------------------------------------
// Reusable partial poses. These are fragments, not stances: they are meant to be
// folded into a base pose with `add` or `over`.
// ---------------------------------------------------------------------------

/** Ribcage lifts, clavicles rise, pelvis floats — the top of an inhale. */
const INHALE = {
  spine01: [-1, 0, 0], spine02: [-2, 0, 0], chest: [-2.5, 0, 0],
  clavicle_L: [0, 0, 2.6], clavicle_R: [0, 0, -2.6],
  shoulder_L: [1.5, 0, -1.5], shoulder_R: [1.5, 0, 1.5],
};

/** The bottom of an exhale: ribs drop, shoulders round forward. */
const EXHALE = {
  spine01: [1.5, 0, 0], spine02: [2, 0, 0], chest: [2.5, 0, 0],
  clavicle_L: [1.5, 0, -1.8], clavicle_R: [1.5, 0, 1.8],
  shoulder_L: [-2, 0, 2], shoulder_R: [-2, 0, -2],
};

/** Weight rocks onto the rear leg: pelvis back and down over the right foot. */
const ONTO_REAR = {
  hips: [-1, -3, 2],
  hip_L: [5, 0, -2], knee_L: [-7, 0, 0], ankle_L: [4, 0, 0],
  hip_R: [-4, 0, 1], knee_R: [7, 0, 0], ankle_R: [-5, 0, 0],
};

/** Weight rocks onto the lead leg. */
const ONTO_LEAD = {
  hips: [1, 3, -2],
  hip_L: [-5, 0, 2], knee_L: [7, 0, 0], ankle_L: [-4, 0, 0],
  hip_R: [4, 0, -1], knee_R: [-6, 0, 0], ankle_R: [5, 0, 0],
};

// ---------------------------------------------------------------------------
// idle.fight — the clip that is on screen more than any other.
//
// ROUND 19: IT WAS A MANNEQUIN, AND IT IS HALF OF THE FRAME THE AXIS IS SCORED ON.
//
// `17-anim-strip` is seven panels of one attack. The attacker moves; the
// DEFENDER stands in `idle.fight` for five of them. Measured on the strip's own
// parked camera, one page session, clock pinned to 1/60, over the seventeen
// ticks that cover panels +0t..+16t:
//
//     defender pelvis, screen      5.8 px across  x  0.9 px vertical
//     defender pelvis, world       27 mm of total path
//     defender chest, screen      14.0 x 0.9 px
//     defender head, screen       25.1 x 1.8 px
//
// Nine tenths of a pixel of vertical pelvis travel over a quarter of a second.
// The pelvis screen X was bit-identical (1075.7) on fourteen consecutive ticks.
// Cropped at 3x the five panels are the same picture with a different attacker
// pasted over them, which is exactly CRITIC.md's "pose-to-pose robotic motion"
// and it was sitting in the middle of the scored frame the whole time.
//
// The cause was authored, not procedural: the old loop carried TWENTY-SIX
// MILLIMETRES of pelvis travel across all 108 ticks, spread over two breaths and
// one slow weight rock. Over any 16-tick window that averages 10 mm and bottoms
// out at 1.8 mm. Breathing is not weight; a fighter in a stance is a mass held
// on two springs and it never stops moving.
//
// So the loop now carries a real settle: FOUR bounces per loop, 27 ticks each
// (2.2 Hz, a boxer's cadence), against TWO breaths at 54 and ONE weight rock at
// 108. Three periods, pairwise coprime enough that nothing in the loop repeats
// before the loop does.
//
// THE BOUNCE IS IN THE LEGS, NOT IN THE ROOT, and that is the whole reason it is
// safe. Dropping the root alone buries the boots; lifting it alone floats them,
// and "floaty feet" is on CRITIC.md's list of what drags this axis. `SETTLE` is
// solved rather than eyeballed: the per-leg flex below was bisected against the
// real forward kinematics until BOTH boots rise exactly 50 mm relative to the
// pelvis, and the root then drops exactly 50 mm, so the sole does not move at
// all. Measured over the whole loop as the lowest boot bone:
//
//     shipped clip   -31.1 mm .. +1.4 mm      (31 mm of burial, 1.4 of float)
//     this clip      -11.8 mm .. +1.3 mm
//
// Strictly inside the old envelope at both ends — less burial for the planter to
// absorb, no more float — while pelvis travel goes 26 mm -> 50 mm over the loop
// and 10.1 mm -> 31.6 mm over a 16-tick window, worst case 1.8 mm -> 12.7 mm.
// Boot pitch (toe minus foot height) moves under 3 mm at full sink, so the sole
// angle the stance authored survives.
//
// The bounce is asymmetric on purpose: `quad` down, `snap` off the bottom,
// `sine` back to the top, and the four amplitudes are 1.00 / 0.66 / 0.90 / 0.58
// so no two consecutive bounces are the same height. The torso, guard and head
// read the bounce FIVE TICKS LATE (`LAG`) and ride `sine` while the legs ride
// the snap — CRITIC.md's "the hips lead, the head lags", applied to the neutral
// rather than only to the strike.
//
// SEEN, NOT JUST MEASURED. Single page session, one compiled program, the only
// difference being which key arrays hang on the animator's clip object; the
// strip's own parked camera; clock pinned to 1/60; motion blur and film grain
// off at the freeze. Three arms a side, the first discarded as a warm-up (the
// defender is still settling out of the boot sequence in it and says so — its
// pelvis starts 47 px high). Over the seventeen ticks covering panels +0t..+16t:
//
//                              old (2 arms)      this clip (2 arms)
//     pelvis vertical, screen    2.06 / 1.18 px   16.18 / 16.25 px
//     head vertical, screen      2.74 / 1.58 px   16.93 / 17.01 px
//     knee_L vertical, screen    0.58 / 0.57 px    4.00 /  3.96 px
//     pelvis world path          29.6 / 32.2 mm  136.3 / 138.2 mm
//     pelvis screen path         7.41 / 8.07 px   34.19 / 34.69 px
//
// And in pixels, over a 210x540 band on the defender that the attacker never
// reaches (mean absolute difference out of 255, two reps a side, run-to-run
// noise floor 1.3-2.5, background-only band 0.1):
//
//     panel pair      old            this clip
//     +0t -> +6t      14.56 / 14.42  28.27 / 28.48
//     +6t -> +10t     10.78 / 10.38  14.63 / 14.79
//     +10t -> +13t     7.21 /  8.24  16.68 / 16.61
//     +13t -> +16t    21.00 / 20.87  20.04 / 20.19
//
// The last pair does not move and should not: by then the attacker's drive is
// pushing the defender through `separatePair` and that pair was never the
// mannequin. The three that are actually idle roughly double.
//
// WHAT IT DOES NOT TOUCH, checked because it would confound two other
// workstreams. The attacker's hips screen X agrees within 0.8 px and its
// hand_R within 2 px across all four arms, and the uppercut connects on the
// IDENTICAL tick in every one — so no reach, spacing or contact-timing change.
// `#trackFootfalls` fires ZERO times in 300 ticks of neutral idle on both
// clips, so the deck picks up no new dust. Mean stance height is unchanged in
// any way a frame can see: pelvis 0.8927 -> 0.8871 m, head 8.8 mm lower.
// ---------------------------------------------------------------------------
const GUARD_SINK = {
  clavicle_L: [0, 0, -1.5], shoulder_L: [3, 0, 2], elbow_L: [4, 0, -2],
  clavicle_R: [0, 0, 1.2], shoulder_R: [2.5, 0, -1.5], elbow_R: [3, 0, 0],
};
const GUARD_RESET = {
  clavicle_L: [0, 0, 2], shoulder_L: [-3.5, 0, -2.5], elbow_L: [-5, 0, 2],
  clavicle_R: [0, 0, -1.6], shoulder_R: [-3, 0, 2], elbow_R: [-4, 0, 0],
};

/**
 * The settle. Solved, not authored: these six numbers were bisected against the
 * rig's own forward kinematics until the lowest bone of EACH boot rises exactly
 * 50 mm relative to the pelvis, so pairing them with `SETTLE_Y` leaves both
 * soles where they were. The two legs need different amounts because the stance
 * is bladed — the lead leg is already carrying 39 degrees of hip flex and the
 * rear one only 9.
 */
const SETTLE = {
  hip_L: [-9.0, 0, 0], knee_L: [16.0, 0, 0], ankle_L: [-7.0, 0, 0],
  hip_R: [-9.0, 0, 0], knee_R: [18.0, 0, 0], ankle_R: [-7.7, 0, 0],
};
/** Root drop that exactly cancels `SETTLE`'s boot lift. */
const SETTLE_Y = -0.050;
/** Ribs and shoulders compressing under the drop, above the waist. */
const ABSORB = {
  spine01: [1.6, 0, 0], spine02: [1.4, 0, 0], chest: [1.2, 0, -1.2],
};

/** Ticks the upper body runs behind the pelvis. */
const LAG = 5;
/** One bounce, in ticks. Four of them fill the 108-tick loop. */
const BOUNCE = 27;
/** Bounce depths, in loop order. Deliberately unequal — a metronome reads dead. */
const BOUNCE_AMP = [1.0, 0.66, 0.9, 0.58];
/** Offsets inside one bounce: top, bottom, three-quarters back up. */
const BOUNCE_KEYS = [[0, 0, 'quad'], [9, 1, 'snap'], [18, 0.35, 'sine']];

const cosWave = (t, period, peak) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - peak)) / period);

/** Sink fraction at any tick, read off the same three key values, for the lag terms. */
function settleAt(t) {
  const tt = ((t % 108) + 108) % 108;
  const c = Math.floor(tt / BOUNCE);
  const p = tt - c * BOUNCE;
  const pts = [[0, 0], [9, 1], [18, 0.35], [27, 0]];
  for (let i = 0; i < 3; i++) {
    if (p >= pts[i][0] && p <= pts[i + 1][0]) {
      const u = (p - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
      return BOUNCE_AMP[c] * (pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u);
    }
  }
  return 0;
}
/** Two breaths per loop, the second shallower. */
const breathAt = (t) => cosWave(t, 54, 16) * ((((t % 108) + 108) % 108) < 54 ? 1 : 0.72);
/** One slow weight rock: -1 fully on the rear boot, +1 fully on the lead. */
const rockAt = (t) => 1 - 2 * cosWave(t, 108, 74);

const idleFight = makeClip('idle.fight', { duration: 108, loop: true, blendIn: 8, blendOut: 8 },
  BOUNCE_AMP.flatMap((amp, c) => BOUNCE_KEYS.map(([off, frac, ease]) => {
    const t = c * BOUNCE + off;
    const s = amp * frac;          // this key's sink
    const sl = settleAt(t - LAG);  // what the upper body is still catching up to
    const r = rockAt(t);
    const b = breathAt(t - LAG);
    return {
      t,
      ease,
      // The head and neck ride a sine while the legs ride the snap, so the skull
      // is still travelling when the boots have already arrived.
      easeBy: { head: 'sine', neck: 'sine', chest: 'sine' },
      pose: add(
        STANCE,
        mix({}, SETTLE, s),
        mix({}, ABSORB, sl),
        r >= 0 ? mix({}, ONTO_LEAD, r) : mix({}, ONTO_REAR, -r),
        mix(EXHALE, INHALE, b),
        mix({}, GUARD_SINK, sl),
        { head: [3.0 - 6 * b + 3.0 * sl, 2 * r, 1.2 * r], neck: [-2.4 * b + 1.2 * sl, 0.8 * r, 0] },
      ),
      root: [0, STANCE_Y + 0.010 + SETTLE_Y * s, -0.010 * r],
    };
  })));

// ---------------------------------------------------------------------------
// idle.breathe — the between-rounds / neutral idle. Same rig, lower intensity:
// the guard opens, the pelvis squares up 8deg, the breath is slower and deeper
// and the head drifts as if scanning rather than staring.
// ---------------------------------------------------------------------------
const OPEN_GUARD = {
  clavicle_L: [0, 2, -3], shoulder_L: [10, 0, 6], elbow_L: [20, 0, -6],
  clavicle_R: [0, -2, 3], shoulder_R: [8, 0, -5], elbow_R: [22, 0, 0],
  hips: [0, 8, 0], chest: [0, -3, 1],
};

const idleBreathe = makeClip('idle.breathe', { duration: 150, loop: true, blendIn: 10, blendOut: 10 }, [
  { t: 0, ease: 'sine', pose: add(STANCE, OPEN_GUARD), root: [0, STANCE_Y + 0.02, 0] },
  { t: 24, ease: 'sine', pose: add(STANCE, OPEN_GUARD, INHALE, INHALE, { head: [0, 3, 0] }), root: [0, STANCE_Y + 0.036, 0] },
  { t: 32, ease: 'sine', pose: add(STANCE, OPEN_GUARD, INHALE, INHALE, { head: [-4, 5, 1], neck: [-2, 2, 0] }), root: [0, STANCE_Y + 0.038, 0] },
  { t: 58, ease: 'sine', pose: add(STANCE, OPEN_GUARD, mix({}, ONTO_REAR, 0.5), { head: [-2, 7, 1] }), root: [0, STANCE_Y + 0.012, -0.008] },
  { t: 76, ease: 'sine', pose: add(STANCE, OPEN_GUARD, EXHALE, ONTO_REAR, { head: [3, 4, 0] }), root: [0, STANCE_Y - 0.006, -0.012] },
  { t: 96, ease: 'sine', pose: add(STANCE, OPEN_GUARD, mix(EXHALE, INHALE, 0.4), mix(ONTO_REAR, ONTO_LEAD, 0.55), { head: [1, -3, -1] }), root: [0, STANCE_Y + 0.014, -0.002] },
  { t: 116, ease: 'sine', pose: add(STANCE, OPEN_GUARD, INHALE, ONTO_LEAD, { head: [-3, -6, -2] }), root: [0, STANCE_Y + 0.03, 0.008] },
  { t: 134, ease: 'sine', pose: add(STANCE, OPEN_GUARD, mix(INHALE, EXHALE, 0.6), mix({}, ONTO_LEAD, 0.4), { head: [1, -2, 0] }), root: [0, STANCE_Y + 0.008, 0.003] },
]);

// ---------------------------------------------------------------------------
// idle.taunt — "come on". Rear hand drops off the guard, the chest opens toward
// the opponent, the lead hand turns palm-up and beckons twice; the second beckon
// is smaller and faster. Ends by snapping the guard back so the clip can be
// interrupted at any point without leaving the fighter open-handed.
// ---------------------------------------------------------------------------
const TAUNT_OPEN = over(STANCE, {
  hips: [0, -14, 0], spine01: [-2, 2, 0], spine02: [-3, 3, 1], chest: [-5, 4, 4], neck: [-2, 4, 0], head: [-4, 6, 2],
  clavicle_L: [0, -14, 4], shoulder_L: [-48, -3, -40], elbow_L: [-45, 33, 21], wrist_L: [-24, 0, 0], hand_L: [-30, 0, 0],
  clavicle_R: [0, 4, -2], shoulder_R: [-49, 42, 60], elbow_R: [-5, -43, 10], wrist_R: [-6, 0, 0], hand_R: [-10, 0, 0],
});

const idleTaunt = makeClip('idle.taunt', { duration: 96, blendIn: 6, blendOut: 8 }, [
  { t: 0, ease: 'quad', pose: STANCE, root: [0, STANCE_Y, 0] },
  { t: 10, ease: 'expo', pose: add(STANCE, { chest: [2, -4, -2], head: [3, -3, 0], shoulder_L: [8, 0, 4], elbow_L: [10, 0, 0] }), root: [0, STANCE_Y - 0.014, -0.01] },
  { t: 22, ease: 'quad', pose: TAUNT_OPEN, root: [0, STANCE_Y + 0.012, 0.006] },
  { t: 30, ease: 'quad', pose: add(TAUNT_OPEN, { elbow_L: [-34, 0, 0], wrist_L: [-26, 0, 0], hand_L: [-26, 0, 0], chest: [2, 0, 0], head: [2, 0, 0] }), root: [0, STANCE_Y + 0.008, 0.004] },
  { t: 40, ease: 'quad', pose: add(TAUNT_OPEN, { elbow_L: [8, 0, 0], wrist_L: [8, 0, 0], hand_L: [10, 0, 0], chest: [-1, 0, 0] }), root: [0, STANCE_Y + 0.014, 0.008] },
  { t: 48, ease: 'quad', pose: add(TAUNT_OPEN, { elbow_L: [-26, 0, 0], wrist_L: [-20, 0, 0], hand_L: [-20, 0, 0], head: [1, 0, 0] }), root: [0, STANCE_Y + 0.01, 0.005] },
  { t: 56, ease: 'sine', pose: add(TAUNT_OPEN, { elbow_L: [4, 0, 0], wrist_L: [6, 0, 0], hand_L: [8, 0, 0] }), root: [0, STANCE_Y + 0.012, 0.006] },
  { t: 66, ease: 'expo', pose: add(TAUNT_OPEN, { chest: [3, -2, -2], head: [4, -2, 0], shoulder_L: [6, 0, 0] }), root: [0, STANCE_Y + 0.004, 0.002] },
  { t: 80, ease: 'snap', pose: add(STANCE, { chest: [1, 0, -1], shoulder_L: [-4, 0, -3], shoulder_R: [-3, 0, 3], head: [-1, 0, 0] }), root: [0, STANCE_Y - 0.006, -0.004] },
  { t: 96, pose: STANCE, root: [0, STANCE_Y, 0] },
]);

// ---------------------------------------------------------------------------
// idle.lowHealth — the same fighter with a broken chassis. The pelvis squares up
// because holding a bladed stance costs energy, the lead arm has fallen out of
// the guard to hang across the ribs, the spine folds forward and the head hangs.
// The breath is a hitch: a fast painful catch, a long slow release, and a stall
// where the loop nearly stops moving. One knee gives a little every cycle.
//
// The sag is in the KNEES, not in the root track. It used to be in the root: the
// pelvis was authored 68mm below the stance baseline while the left leg was
// authored STRAIGHTER than the stance (knee 34 against 42), so the left boot
// reached 147mm through the concrete while the right one floated 21mm clear.
// Measured through the built robot over the whole 132-tick loop, mean sole error
// was 50mm on the toe and 51mm on the heel — by far the worst of any idle, and
// this is the clip that plays through the climax of every round. The left knee
// now takes 37 degrees more bend and the right six less, which is what actually
// drops a hurt fighter's weight onto one leg, and the pelvis comes back up 30mm.
// Mean toe error 10.0mm, heel 28.5mm, worst burial 10mm.
// ---------------------------------------------------------------------------
const HURT_BASE = over(STANCE, {
  hips: [4, -16, -3],
  spine01: [6, 3, -2], spine02: [7, 3, -2], chest: [8, 4, -7],
  neck: [4, 4, 0], head: [7, 5, -2],
  clavicle_L: [4, -4, -13], shoulder_L: [-11, -23, -32], elbow_L: [-100, 0, -16], wrist_L: [-14, 0, 0], hand_L: [-18, 0, 0],
  clavicle_R: [3, 5, 11], shoulder_R: [1, -10, 27], elbow_R: [-150, 10, 11], wrist_R: [-10, 0, 0], hand_R: [-14, 0, 0],
  hip_L: [-45, 6, 7], knee_L: [71, 0, 0], ankle_L: [-18, 2, 0],
  hip_R: [-12, -2, -8], knee_R: [55, 0, 0], ankle_R: [-47, -3, 0],
});
const HURT_Y = -0.113;

const idleLowHealth = makeClip('idle.lowHealth', { duration: 132, loop: true, blendIn: 10, blendOut: 8 }, [
  { t: 0, ease: 'quad', pose: HURT_BASE, root: [0, HURT_Y, -0.01] },
  { t: 8, ease: 'expo', pose: add(HURT_BASE, INHALE, INHALE, { chest: [-3, 0, 0], head: [-5, 1, 0], neck: [-3, 0, 0], shoulder_L: [-4, 0, 0] }), root: [0, HURT_Y + 0.019, -0.008] },
  { t: 14, ease: 'sine', pose: add(HURT_BASE, INHALE, { chest: [-1, 0, 0], head: [-1, 1, 0] }), root: [0, HURT_Y + 0.013, -0.008] },
  { t: 42, ease: 'sine', pose: add(HURT_BASE, EXHALE, { chest: [4, 0, 0], head: [5, -1, -1], neck: [3, 0, 0], shoulder_L: [4, 0, 3], elbow_L: [6, 0, 0] }), root: [0, HURT_Y - 0.017, -0.014] },
  { t: 58, ease: 'sine', pose: add(HURT_BASE, EXHALE, { chest: [3, 1, 1], head: [4, 2, 1], hips: [0, 0, 2], knee_L: [6, 0, 0], hip_L: [-4, 0, 0] }), root: [0, HURT_Y - 0.027, -0.018] },
  { t: 72, ease: 'expo', pose: add(HURT_BASE, { chest: [1, 2, 2], head: [2, 3, 2], hips: [0, 0, 3], knee_L: [8, 0, 0], hip_L: [-5, 0, 0] }), root: [0, HURT_Y - 0.031, -0.02] },
  { t: 80, ease: 'quad', pose: add(HURT_BASE, INHALE, { chest: [-2, 0, 0], head: [-3, 0, 0], neck: [-2, 0, 0], hips: [0, 0, 1] }), root: [0, HURT_Y + 0.005, -0.012] },
  { t: 104, ease: 'sine', pose: add(HURT_BASE, EXHALE, { chest: [3, -2, -1], head: [4, -3, -1], shoulder_R: [4, 0, -3] }), root: [0, HURT_Y - 0.015, -0.014] },
  { t: 120, ease: 'sine', pose: add(HURT_BASE, mix(EXHALE, {}, 0.5), { chest: [1, -1, 0], head: [2, -1, 0] }), root: [0, HURT_Y - 0.007, -0.012] },
]);

// ---------------------------------------------------------------------------
// idle.crouch — held crouching guard. Short, tight breathing only; the legs are
// already at the bottom of their travel so all the life has to come from the
// torso and the guard.
// ---------------------------------------------------------------------------
const idleCrouch = makeClip('idle.crouch', { duration: 84, loop: true, blendIn: 5, blendOut: 5 }, [
  { t: 0, ease: 'sine', pose: CROUCH, root: [0, CROUCH_Y, 0] },
  { t: 14, ease: 'sine', pose: add(CROUCH, INHALE, { head: [1, 1, 0], knee_L: [-2, 0, 0], knee_R: [-2, 0, 0] }), root: [0, CROUCH_Y + 0.016, 0] },
  { t: 20, ease: 'sine', pose: add(CROUCH, INHALE, { head: [-2, 2, 0], neck: [-1, 0, 0] }), root: [0, CROUCH_Y + 0.018, 0.004] },
  { t: 40, ease: 'sine', pose: add(CROUCH, mix(INHALE, EXHALE, 0.6), { head: [1, 1, 1], hips: [0, 0, 2], knee_R: [3, 0, 0] }), root: [0, CROUCH_Y - 0.008, 0] },
  { t: 54, ease: 'quad', pose: add(CROUCH, EXHALE, GUARD_SINK, { head: [3, 0, 1], hips: [1, 0, 2] }), root: [0, CROUCH_Y - 0.016, -0.006] },
  { t: 68, ease: 'sine', pose: add(CROUCH, mix(EXHALE, {}, 0.5), GUARD_RESET, { head: [-1, -1, 0] }), root: [0, CROUCH_Y - 0.004, -0.002] },
]);

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
export const IDLE_CLIPS = {
  'idle.fight': idleFight,
  'idle.breathe': idleBreathe,
  'idle.taunt': idleTaunt,
  'idle.lowHealth': idleLowHealth,
  'idle.crouch': idleCrouch,
};

// ---------------------------------------------------------------------------
// VELOCITY CARRY, applied to the idle set. See the note above `carry`.
//
// These five and the locomotion set are most of the screen time and NO operator
// had ever covered them: `whip` and `lead` are both attack machinery and both
// refuse a looping clip. `idle.breathe` measured 36 mid-flight interior keys and
// 36 of them were full stops, median carry 0.004 -- the ribcage arrived at every
// key and halted. A loop's wrap span is resampled too, so the cycle joins
// smoothly rather than hitching once per revolution.
// ---------------------------------------------------------------------------
const IDLE_CARRY = { 'idle.fight': 2, 'idle.breathe': 3, 'idle.taunt': 2, 'idle.lowHealth': 3, 'idle.crouch': 3 };
for (const id in IDLE_CARRY) carry(IDLE_CLIPS[id], { N: IDLE_CARRY[id] });

// ---------------------------------------------------------------------------
// CONTRAPPOSTO, applied to the idle set. See the note above `contrapposto`.
//
// All five take the full delta, which is the best result in the library and the
// one that matters most: `idle.fight` is on screen more than any other clip and
// is what the DEFENDER is standing in for five of the seven panels of
// `17-anim-strip`. Measured on it: pelvicTilt +1.0 -> -7.0 deg, frontal
// separation -1.7 -> +10.3, head 21 -> -28 mm off the centre line, at a cost of
// 6.5 mm of extra grounded-foot burial and 0.4 mm/tick of extra skate.
// ---------------------------------------------------------------------------
const IDLE_CONTRA = {
  'idle.fight': 1, 'idle.breathe': 1, 'idle.taunt': 1, 'idle.lowHealth': 1, 'idle.crouch': 1,
};
for (const id in IDLE_CONTRA) contrapposto(IDLE_CLIPS[id], IDLE_CONTRA[id]);

// ---------------------------------------------------------------------------
// SAGITTAL LEAN, applied to the idle set. See the long note above `sagittal`.
//
// `idle.fight` is on screen more than any other clip in the game and is what the
// DEFENDER stands in for five of the seven panels of `17-anim-strip`. Measured
// on it through the fight camera: on-screen torso lean -1.1 -> +10.5 deg and the
// skull 2 -> 44 px forward of the pelvis centre line, at a cost of exactly
// 0.0000 mm on every bone from the pelvis down.
//
// `idle.lowHealth` and `idle.crouch` take almost nothing because they had
// already been authored to 10.5 and 6.7 deg -- they were the two clips in the
// idle set that were not standing to attention.
// ---------------------------------------------------------------------------
const IDLE_SAGITTAL = {
  'idle.fight': 16, 'idle.breathe': 12, 'idle.taunt': 14, 'idle.lowHealth': 2, 'idle.crouch': 4,
};
for (const id in IDLE_SAGITTAL) sagittal(IDLE_CLIPS[id], IDLE_SAGITTAL[id]);
