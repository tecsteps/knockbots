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
