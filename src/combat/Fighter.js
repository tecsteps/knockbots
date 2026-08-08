/**
 * Knockbots — the fighter: state machine, physics, and the bridge between the
 * simulation and the visible robot.
 *
 * Authority split
 * ---------------
 * `simulate()` is the only thing that may change game state, and it runs at a
 * fixed 60Hz. It advances the animator by exactly one tick, writes the *final*
 * pose onto the bones, and reads hurtboxes and hitboxes straight off the posed
 * bone world matrices — never off the rest pose — so a hitbox is where the fist
 * actually is on that frame. `render()` re-applies the same pose interpolated by
 * `alpha` and drives purely cosmetic systems (emissive pulse, actuator
 * extension, damage smoke). Nothing in `render()` is allowed to feed back into
 * the sim.
 *
 * Facing convention
 * -----------------
 * `facing` is +1 when the opponent sits at a greater X.
 *
 * The rig's front is its local **+Z**. Skeleton.js's prose header says -Z, but
 * its geometry says otherwise and the geometry is what everything else is built
 * on: `toe_*` sits at +Z of the foot, `IK_CHAINS` aims the knee poles at +Z and
 * the elbow poles at -Z, and every animation clip was authored against that
 * frame (see `animations/punches.js`, which states it outright). Hitboxes come
 * off those posed bones, so combat has to agree with the animation or a jab
 * would travel backwards. `FORWARD_SIGN` is the single switch if the rig is
 * ever re-authored.
 *
 * A fighter auto-turns when crossed up, but never in the middle of an attack —
 * that is what makes crossovers and back throws readable.
 *
 * Clips may also carry their own yaw in the root track: a spin kick turns the
 * whole chassis through 360 degrees. That is applied as `animYaw`, an offset ON
 * TOP of the facing yaw, never as a change to `facing` itself — so a spin swings
 * the body and its hitboxes without ever deciding which way the fighter ends up
 * pointing, and auto-turn keeps working underneath it.
 */

import * as THREE from 'three';
import {
  GRAVITY, GROUND_Y, TICK_DT, FIGHTER_RADIUS, ARENA_HALF_WIDTH, ARENA_HALF_DEPTH,
  MAX_HEALTH, CHIP_DAMAGE_RATIO, RECOVERABLE_RATIO, RECOVERY_PER_TICK,
  METER_MAX, METER_ON_DEAL, METER_ON_TAKE, METER_ON_BLOCK,
  INPUT_BUFFER_TICKS, MOTION_WINDOW_TICKS, HEIGHT, REACTION,
} from '../core/Constants.js';
import { bus } from '../core/Bus.js';
import { Rng } from '../core/Rng.js';
import { BONES, BONE_NAMES, HURTBOX_BONES, IK_CHAINS, SPRING_BONES, SPRING_DEFS, createSkeleton } from '../characters/Skeleton.js';
import { sampleClip, Pose } from '../characters/AnimationFormat.js';
import { activeBoxes, isActive, isInvulnerable } from './MoveSchema.js';
import { MOVES, findMove, movesFor, parseToken, dirMatches } from './Moves.js';
import { Animator } from '../characters/Animator.js';
import { CLIPS } from '../characters/animations/index.js';
import { buildRobot } from '../characters/RobotBuilder.js';

export const STATE = {
  IDLE: 'idle', WALK: 'walk', DASH: 'dash', BACKDASH: 'backdash', CROUCH: 'crouch',
  SIDESTEP: 'sidestep', JUMP_RISE: 'jumpRise', JUMP_APEX: 'jumpApex', JUMP_FALL: 'jumpFall',
  ATTACK: 'attack', BLOCK_HIGH: 'blockHigh', BLOCK_LOW: 'blockLow', BLOCKSTUN: 'blockstun',
  HITSTUN: 'hitstun', LAUNCHED: 'launched', JUGGLED: 'juggled', KNOCKDOWN: 'knockdown',
  WAKEUP: 'wakeup', THROW: 'throw', THROWN: 'thrown', KO: 'ko', INTRO: 'intro',
  VICTORY: 'victory',
};

// Movement tuning, metres/second and ticks.
// Movement speeds are matched to the authored stride of the clip that plays at
// each one, measured by sampling the clips through the real rig. A mismatch
// here reads as skating and no amount of animation polish hides it.
//   forward 2.75 -> loco.runFwd  (authored 2.69, ratio 1.02)
//   back    2.00 -> loco.runBack (authored 2.03, ratio 0.99)
//   crouch  0.32 -> loco.crouchWalk (authored 0.27, ratio 1.19)
// Those ratios are against the NOMINAL constant. The body actually travels 0.8x
// of it, because GROUND_FRICTION is applied to the velocity this branch just
// set before the position integrates — measured, a held forward covers 2.20 m/s
// and a held back 1.61. So every gait in this table is really striding about
// 1.22-1.26x its own travel, and matching the new one to the constant the way
// the others are matched keeps it in the same place as the forward run (1.26
// against 1.22) rather than making it uniquely correct against a convention
// nothing else follows.
// Backward and crouch speeds were previously 2.25 and 1.25 against clips
// authored for a fifth of that. Slowing them is also the correct fighting-game
// choice — retreating should not outrun advancing.
//
// THERE WAS NO NEUTRAL GAME, and it was an asset gap rather than a tuning one.
// Forward had two gaits and back had one, so back was pinned to the only clip
// that existed for it: 2.75 against 0.55 meant a full-time retreat cancelled a
// fifth of an advance, and opposed inputs from the round-start gap reached
// contact in 101 ticks — 1.68 seconds — with the defender still 8 metres from
// the wall it never got pushed into. Walking backwards was wired up and
// verified, and bought nothing, which is why a verified input is not a working
// neutral game.
//
// `loco.runBack` is the missing gait (see locomotion.js). Retreat now costs the
// attacker 2.4x the time and costs the defender the whole arena: 2.75 against
// 2.00 closes at 0.75 m/s, so the defender who never stops giving ground is
// pinned against the back wall by the time contact happens. That is the trade
// the neutral game is made of — ground for time — and it did not exist before.
//
// Back is deliberately NOT ramped from a walk into the retreat the way a real
// run builds. Forward is not ramped either, and the asymmetry is the whole
// defect; a break-in window on one side only would have re-created it in
// miniature. Fine spacing is bought with tap length, which is symmetric.
const WALK_FWD = 2.75;
const WALK_BACK = 2.00;
const CROUCH_WALK = 0.32;
const DASH_SPEED = 7.4;
const DASH_TICKS = 14;
const BACKDASH_SPEED = 8.6;
const BACKDASH_TICKS = 22;
const SIDESTEP_SPEED = 3.8;
const SIDESTEP_TICKS = 20;
const JUMP_VY = 7.7;
const JUMP_HOLD_TICKS = 7;      // hold up this long and the sidestep becomes a jump
/** Widest depth gap the pair may hold, in metres. Roughly one body width. */
const AXIS_MAX_GAP = 0.85;
/** Per-tick fraction of the remaining depth gap closed once the evade is over. */
const AXIS_REALIGN_RATE = 0.06;
const GROUND_FRICTION = 0.80;
const SLIDE_FRICTION = 0.93;    // while stunned — knockback should actually carry
const AIR_DRAG = 0.996;
// Juggle gravity is deliberately weaker than jump gravity. A jump wants to feel
// snappy; a juggle needs a full second of hang time or there is no combo to
// perform. Every fighting game runs two gravities and so do we.
const JUGGLE_GRAVITY = 0.42;
// Authored launch heights are tuned against normal gravity; under juggle gravity
// they need trimming or the victim floats above the camera framing.
const LAUNCH_SCALE = 0.85;
// --- foot planting ---------------------------------------------------------
// Every threshold here is a distance from the SOLE to the floor, and the sole is
// not the ankle: on this chassis the boot hangs 16cm below the toe bone and 26cm
// below the ankle. Thresholds written against bone positions — which is what
// this used to do, at 5.5cm — can therefore never fire at all, so the offsets
// are measured off the built robot rather than assumed. See `#measureSole`.
const PLANT_BAND = 0.025;       // sole this close to the floor counts as contact
const PLANT_RATE = 0.3;         // per-tick approach of the plant weight
const FOOT_ROLL_LIMIT = 0.30;   // radians of ankle/ball pitch the roll may add
const ROLL_CAPACITY = 0.05;     // penetration the roll can absorb before the leg must move
// A fighting-stance walk is a shuffle: the sole clears the floor by five
// centimetres, not fifteen. Footfall thresholds have to live inside that.
const FOOTFALL_DOWN = 0.02;     // sole below this, and falling, is a footfall
const FOOTFALL_UP = 0.035;      // and above this the foot has left again
// --- pelvis lift -----------------------------------------------------------
// Ceiling and per-tick approach for the pelvis correction. 0.3m covers the
// worst measured case (k.stomp's landing, both boots 288mm under) with nothing
// spare; the rate closes 95% of a correction in nine ticks, which is inside the
// window a landing squat actually lasts.
const PELVIS_LIFT_MAX = 0.32;
// Metres the correction may move in one tick. Taking it on is capped at the
// speed the body legitimately moves anyway (0.10m/tick is 6m/s, a jump's launch
// speed), because growing the lift only ever SLOWS a descent the clip is already
// driving — it cannot push the body up. Giving it back is capped lower, since
// that direction does move the body, and 45mm/tick reads as settling.
const PELVIS_LIFT_RISE = 0.10;
const PELVIS_LIFT_FALL = 0.045;
// Below this the correction is not worth carrying and is snapped away, so the
// pelvis is not left riding a fraction of a millimetre high forever.
const PELVIS_LIFT_EPS = 0.0008;
// How much of the animation's authored root translation the body actually takes.
const ROOT_MOTION_SCALE = 1.0;
// Per-tick share of the leftover animation yaw that unwinds once no clip is
// driving it. A move may spin the chassis; it may not decide where it ends up.
const ANIM_YAW_RELEASE = 0.22;
/**
 * Most the chassis may be turned to put a strike on the line to the opponent.
 * See `strikeAim` for what this fixes and how it was measured.
 *
 * Swept against the connection rate of all 182 non-throw moves at four ranges,
 * 728 attempts in total. 0 is the behaviour before this existed:
 *
 *     cap      0    20    35    45    55    70    90 deg
 *     connect 82 %  91 %  92 %  93 %  94 %  94 %  94 %
 *     dead    21     9     4     4     4     4     4  moves
 *
 * It is flat past 55 because nothing is left that a turn can fix — the four
 * moves still dead at every cap are all `sp.risingFang`, whose aim is corrected
 * to 13 degrees and which whiffs anyway, so it is a separate defect. 55 is
 * therefore the smallest cap that buys the whole improvement, and a cap matters:
 * past this the clip is not aiming badly, it is striking somewhere else
 * entirely, and turning the whole chassis that far to chase it would read worse
 * than the whiff does.
 */
const AIM_LIMIT = 55 * Math.PI / 180;

/**
 * States whose clips are authored to keep the fighter on its feet, and so the
 * only ones the pelvis correction may run in.
 *
 * The exclusions are the point. A reaction clip puts the body on the FLOOR: a
 * crumple drops the trunk while the boots come up, which reads to a sole-height
 * test as "both feet buried" for a few frames and then as "both feet in the
 * air". Correcting it built the lift to its ceiling and then hovered a fallen
 * fighter 174mm off the concrete on the way back out. There is no release curve
 * that fixes that, because the premise — that the boot is the lowest part of the
 * body — stops being true the moment the fighter goes down.
 */
const PELVIS_LIFT_STATES = new Set([
  STATE.IDLE, STATE.WALK, STATE.DASH, STATE.BACKDASH, STATE.CROUCH, STATE.SIDESTEP,
  STATE.ATTACK, STATE.BLOCK_HIGH, STATE.BLOCK_LOW, STATE.BLOCKSTUN, STATE.THROW,
  STATE.INTRO, STATE.VICTORY,
]);

/**
 * States in which a boot under the floor is a foot problem the planter may act
 * on. The exclusions are the same argument the pelvis correction makes, one step
 * further out: a fighter getting up off the concrete has its shins vertical and
 * its soles nowhere near the ground, so the sole test reads "buried by 670mm" and
 * asks the leg solver for a correction two thirds of a metre tall. Measured over
 * 5000 ticks of CPU-vs-CPU that produced a 119-degree single-tick snap on
 * `ankle_L`, six times, every one of them during a wake-up.
 *
 * Hitstun stays IN, deliberately: most flinches are on the feet and want
 * planting, and the ones that go down (`r.crumple`) are covered by the burial
 * ceiling below rather than by excluding the whole state.
 */
const PLANT_STATES = new Set([
  STATE.IDLE, STATE.WALK, STATE.DASH, STATE.BACKDASH, STATE.CROUCH, STATE.SIDESTEP,
  STATE.ATTACK, STATE.BLOCK_HIGH, STATE.BLOCK_LOW, STATE.BLOCKSTUN, STATE.THROW,
  STATE.INTRO, STATE.VICTORY, STATE.HITSTUN, STATE.JUMP_FALL,
]);

/**
 * Burial past which the planter starts handing authority back, and the band it
 * takes to hand all of it back.
 *
 * A correction much larger than the ceiling is not a plant, it is a different
 * pose: the deepest a clip that is genuinely standing was measured asking for,
 * after the pelvis correction has taken its share, is 51mm. Past that the clip
 * has put the body somewhere the legs cannot reach and the honest answer is to
 * leave it alone — hauling a leg 200mm through its own bend plane is what a snap
 * looks like.
 *
 * It is a BAND and not a threshold, and that was measured too. Swept as a hard
 * cutoff the pop count was not monotone in it — 0.10 gave 14 pops past 60
 * degrees, 0.14 gave 36, 0.22 gave 16 — because a pose that sits near the value
 * crosses it and back on alternating ticks and the correction chatters. Every
 * other gate in this file fades for the same reason.
 */
const PLANT_CEILING = 0.10;
const PLANT_CEILING_BAND = 0.12;

// ---------------------------------------------------------------------------
// Taking a hit
//
// Impact is judged as much on the receiver as on the striker, and until now
// nothing on the receiver moved: `applyHit` picked a reaction clip and that was
// the whole of it. One clip cannot carry a blow, because the clip does not know
// which direction the blow came from — `r.flinchMid` plays identically for a
// hook from the left and a straight from the front.
//
// The bus event does know. `velocity` is the striking bone's swept world
// velocity over the contact tick and `region` is the hurtbox it landed on, so
// the receiving animator can be driven from the real impact vector and the clip
// left to do what it is good at: the recovery and the footwork.
// ---------------------------------------------------------------------------

/**
 * Swept bone speed, in m/s, that counts as a full-force blow.
 *
 * MEASURED, not assumed, and the first guess was wrong by 3.6x. Over 23 hits of
 * a real CPU-vs-CPU match the striking bone's swept speed ran min 1.75, p25
 * 2.67, median 3.20, max 8.00 m/s — not the 9-24 a limb tip intuitively suggests,
 * because `CombatSystem.#strikeVelocity` measures one tick of DISPLACEMENT and a
 * fist at the end of its travel has already begun decelerating into the contact.
 * A reference of 18 put every single blow on the lower clamp, which would have
 * shipped the whole layer at a flat third of its authored strength.
 *
 * 5.0 spreads the real distribution across the usable range: a glancing 1.75
 * lands on the floor, a median 3.2 gives 0.64, and the 8.00 ceiling gives 1.6.
 *
 * Note what 8.00 is: `#strikeVelocity` falls back to `facing * 8` whenever the
 * measured delta is under 1 m/s, and roughly a third of hits take that path. It
 * is a stand-in for "a strike landed", so the move's own weight class is folded
 * in as well — otherwise every capped hit would shake the body identically
 * whether it was a jab or a launcher.
 */
const HIT_REF_SPEED = 5.0;
const HIT_FORCE_MIN = 0.35;
const HIT_FORCE_MAX = 1.6;
/** Reaction multiplier by the move's declared weight class. */
const HIT_WEIGHT_SCALE = { light: 0.78, medium: 1, heavy: 1.22, launcher: 1.3, ultra: 1.45 };
/** A blocked blow still moves the guard, at roughly a third of the reaction. */
const BLOCK_FORCE_SCALE = 0.34;
/** Share of the reaction that also rings the chassis springs. */
const HIT_RIPPLE_SCALE = 0.8;

/** +1 when the rig's local +Z is its front. See the file header. */
export const FORWARD_SIGN = 1;
/** Root yaw that points the rig's front along the fighter's facing. */
export const yawForFacing = (facing) => facing * FORWARD_SIGN * Math.PI / 2;
/** Wrap an angle into (-PI, PI]. A full turn is not a turn. */
const wrapPi = (a) => {
  const x = (a + Math.PI) % (Math.PI * 2);
  return (x < 0 ? x + Math.PI * 2 : x) - Math.PI;
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
/**
 * Scratch for the bus handlers only. They run re-entrantly, part way through
 * another Fighter's tick, so they may not borrow the vectors above.
 */
const _hv = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Clip retiming
//
// Frame data and animation are authored independently, and they disagree: a
// clip may throw its punch on frame 22 while the move it belongs to is i15, and
// one clip serves a dozen moves with a dozen different startups. The frame data
// is law — it is balanced — so the art has to be made to land on it.
//
// It used to be made to land on it by *guessing*: a scratch rig was walked
// through every clip, the tick where some striking bone reached furthest forward
// was taken as the contact frame, and the whole clip was then played at one
// global speed multiplier. That was wrong twice over. The guess was frequently
// nowhere near the authored contact — it picked frame 52 of a 66-tick special
// whose punch lands on 26 — and even a correct guess produced a single speed,
// which cannot pin contact without dragging the recovery with it. Multipliers
// of 2.6 and 0.42 were routine; at 2.6 a clip finishes in a third of its move
// and then holds one dead pose for the rest of it.
//
// So the clip declares its own contact, in `impact: { tick, bone }`, and
// playback is anchored rather than scaled: contact is pinned onto the move's
// first active frame and the clip's end onto the move's last, and only the
// wind-up and the recovery stretch, each by its own factor. Inside a segment the
// map is linear, so every authored 'snap' and 'expo' keeps its shape. The
// factors are clamped to a narrow band as a safety net for the handful of pairs
// that genuinely disagree — a 44-tick hammer fist serving an i48 siege slam —
// and where the clamp bites the clip simply blends out early rather than smearing.
// ---------------------------------------------------------------------------

/**
 * How far a segment may be stretched or squeezed before the mismatch is treated
 * as an authoring problem rather than something to hide. Past roughly a third
 * either way a strike stops reading as the same strike.
 */
const RETIME_MIN = 0.72;
const RETIME_MAX = 1.38;

/**
 * The tick a clip declares as its contact frame, or 0 when it declares none.
 * @param {string} clipId
 * @returns {number}
 */
export function clipContactFrame(clipId) {
  const t = CLIPS[clipId]?.impact?.tick;
  return typeof t === 'number' && t > 0 ? t : 0;
}

/**
 * Two-anchor time map that plays `move`'s clip against the move's frame counter.
 * Cached on the move: it is a property of a (clip, frame data) pair, and both
 * are static.
 *
 * A move may override the clip's declared contact with its own `contact` (a
 * CLIP frame, not a move frame, so it is not touched by the archetype shift).
 * That exists because the retime PINS the clip's contact onto the move's first
 * active frame, which means a wrong `impact.tick` cannot be worked around by
 * re-authoring the window: whatever tick the window starts on, the clip will be
 * at its declared contact pose on it. `sp.risingFang` declares 14 and at clip
 * frame 14 its fist is 1.2 m above the defender's head, so every window that
 * clip could ever be given whiffed. See the risingFang note in `Moves.js`.
 *
 * @param {Object} move
 * @returns {?{pivot:number, pivotAt:number, inScale:number, outScale:number}}
 */
export function retimeFor(move) {
  if (move.retime !== undefined) return move.retime;
  const clip = CLIPS[move.clip];
  const pivot = move.contact > 0 ? move.contact : clipContactFrame(move.clip);
  const pivotAt = move.startup;
  // A clip with no declared contact — a stance, a reaction, a whiff — plays at
  // its authored rate. There is nothing to line up.
  if (!clip || !(pivot > 0) || !(pivotAt > 0)) { move.retime = null; return null; }
  const tail = clip.duration - pivot;
  const tailAt = Math.max(1, move.total - pivotAt);
  move.retime = {
    pivot,
    pivotAt,
    inScale: THREE.MathUtils.clamp(pivot / pivotAt, RETIME_MIN, RETIME_MAX),
    outScale: THREE.MathUtils.clamp(tail / tailAt, RETIME_MIN, RETIME_MAX),
  };
  return move.retime;
}

// ---------------------------------------------------------------------------
// Strike aiming
//
// A clip's `root` track may author a body pivot — `ry` — and the Animator
// EXTRACTS it rather than baking it into the bones, so the only place it is ever
// applied is `animYaw` on the fighter's group. Which means it rotates the
// striking limb along with everything else, and the strike leaves the body at
// whatever angle the pivot happens to leave it at.
//
// That is the kicks-never-connect defect, and here is the measurement. Driving
// all 182 non-throw moves through the real sim at 0.9/1.02/1.2/1.5 m and
// listening on the bus, then recording the angle between (striking bone - hips)
// and the line to the opponent on the first active frame:
//
//     |aim error| <= 25 deg   409/432 connections = 95 %
//     |aim error| >  25 deg   186/296 connections = 63 %
//
// and every move that connected at NONE of the four distances is in the second
// group bar one clip. The four worst offenders, all of which whiffed 4/4:
//
//     clip           authored ry at contact   aim error   connects
//     k.midKick            -58 deg             39 deg       0/4
//     k.highKick           -70 deg             37 deg       0/4
//     k.roundhouse         -96 deg             44 deg       0/4
//     p.backfist          -276 deg            102 deg       0/4
//
// The pivot itself is not the fault — `k.spinKick` pivots 249 degrees and hits
// 4/4, because its leg track is authored to come round with the spin and its aim
// error is 2 degrees. What breaks a move is the pivot the limb does NOT
// compensate for.
//
// So the correction is aiming, not suppression: the chassis is turned by
// whatever puts the strike back on the line, ramped in over the startup so
// nothing snaps, held through the active window, and released over the recovery
// so the move still ends where the animation says. A clip whose limb already
// tracks the target asks for nothing.

/** Lazy scratch rig for the static aim solve. Built once, never rendered. */
let _aimRig = null;
function aimRig() {
  if (_aimRig) return _aimRig;
  const { bones, byName } = createSkeleton(null);
  const rest = Object.create(null);
  for (const b of bones) rest[b.name] = b.quaternion.clone();
  _aimRig = { bones, byName, rest, pose: new Pose(BONE_NAMES) };
  return _aimRig;
}
const _aimQ = new THREE.Quaternion();
const _aimId = new THREE.Quaternion();
const _aimV = new THREE.Vector3();
const _aimV2 = new THREE.Vector3();

/**
 * Radians to add to `animYaw` so this move's strike leaves the body pointing at
 * the opponent. Static — a property of (clip, frame data) — so it is solved once
 * and cached on the move next to its retime.
 *
 * Measured on the CLIP's own forward kinematics at its declared contact tick,
 * not on last tick's bone matrices, for the same reason `#installPelvisLift`
 * does: a servo reading its own output cannot tell its correction from the thing
 * it is correcting.
 *
 * @param {Object} move
 * @returns {number} radians, clamped to +/- AIM_LIMIT
 */
export function strikeAim(move) {
  if (move.aimBias !== undefined) return move.aimBias;
  move.aimBias = 0;
  const clip = CLIPS[move.clip];
  const box = move.active?.[0]?.boxes?.[0];
  if (!clip || !box) return 0;
  const rig = aimRig();
  const bone = rig.byName[box.bone];
  const hips = rig.byName.hips;
  if (!bone || !hips) return 0;

  // The contact tick in CLIP time. `retimeFor` pins the clip's declared contact
  // onto the move's first active frame, so when the clip declares one that tick
  // IS the first active frame; without one the clip plays at its authored rate
  // and the move's own frame number is the clip's.
  const r = retimeFor(move);
  const t = r ? r.pivot : move.active[0].from;

  const { bones, rest, pose } = rig;
  pose.reset();
  sampleClip(clip, t, pose, 1);
  for (const b of bones) {
    const w = pose.weight[b.name] || 0;
    if (w > 0) {
      _aimQ.copy(pose.rot[b.name]);
      if (w < 1) _aimQ.slerp(_aimId, 1 - w);
      b.quaternion.copy(rest[b.name]).multiply(_aimQ);
    } else {
      b.quaternion.copy(rest[b.name]);
    }
  }
  // Root translation only. The authored yaw is added below as a scalar, exactly
  // as the runtime adds it — through `animYaw` on the group, never on the bones.
  rig.byName.root.position.copy(pose.rootPos);
  rig.byName.root.quaternion.identity();
  rig.byName.root.updateMatrixWorld(true);

  _aimV.set(box.offset[0], box.offset[1], box.offset[2]).applyMatrix4(bone.matrixWorld);
  _aimV2.setFromMatrixPosition(hips.matrixWorld);
  _aimV.sub(_aimV2);
  // The rig's front is +Z, so a strike on the line has x = 0 after the pivot.
  const err = wrapPi(Math.atan2(_aimV.x, _aimV.z) + pose.rootYaw);
  move.aimBias = -THREE.MathUtils.clamp(err, -AIM_LIMIT, AIM_LIMIT);
  return move.aimBias;
}

// ---------------------------------------------------------------------------
// Finishers
//
// A finisher is not a bigger super. A super is a resource you spend; a finisher
// is a *window you can miss*, and everything below exists to make that true and
// to make it learnable. The data contract is pinned in
// `docs/CONTRACT-character-moves.md` and this file implements exactly it:
//
//     tag: 'finisher',
//     input: 'b,b,d+4',                 // the SEQUENCE, comma-separated
//     props: { finisher: {
//       condition: 'Opponent below 20% health on the final round',  // verbatim UI
//       healthPct: 0.20, finalRoundOnly: true, window: 90,          // the engine
//       sequenceText: 'Back, Back, Down, RK',                       // verbatim UI
//     } }
//
// Four things separate it from `overdrive`:
//
//   CONDITION — `CombatSystem` opens the window, once per round per fighter,
//     the tick the opponent drops under `healthPct` (and, if `finalRoundOnly`,
//     on a round that can decide the match). Deterministic: it is a comparison
//     on two integers the sim already owns.
//   WINDOW — `window` ticks, counted on the sim clock, and it does NOT re-open.
//     Miss it and the round is won the ordinary way. That is the whole point:
//     a finisher you cannot fail is a cutscene.
//   SEQUENCE — the move's own `input`, split on commas, each token parsed by the
//     same `parseToken` the move list uses. Direction-only tokens match on a
//     direction EDGE (a tap), button tokens on a press. A button press that does
//     not advance the sequence resets it, so mashing cannot find it.
//   PRESENTATION — the move's `cinematic`, plus the two clips the overdrive has
//     always declared and nothing has ever played: `hitClip` on the connect and
//     `finishClip` on the follow-through. `specials.js` authored the overdrive as
//     three clips precisely "so the combat system can hold the cinematic between
//     them", and until now it held nothing.
//
// The end state is deliberately the ordinary one. A landed finisher zeroes the
// victim's health and goes through `#toKO`, so `CombatSystem.#checkKO`, the KO
// banner, round scoring, the victory screen and the rematch path all run exactly
// as they do for any other knockout. A finisher that needed its own match flow
// would be a second, weaker copy of the one that already works.
// ---------------------------------------------------------------------------

/**
 * Stance value stamped onto a finisher so the ordinary matcher can never start
 * one. `canUse` already gates on `props.requireStance` and nothing ever sets
 * this stance, so this is the existing mechanism rather than a new one — and it
 * matters, because a sequence like `b,b,d+4` parses its first token as a bare
 * `b`, which would otherwise out-rank every plain button and fire the finisher
 * on any press made while holding back.
 */
const FINISHER_STANCE = '__finisher';
/** Window length when the data does not name one, in ticks. 1.5 seconds. */
const FINISHER_WINDOW_DEFAULT = 90;
/**
 * Fraction of MAX_HEALTH the opponent must be under, when the data omits it.
 * Exported so `CombatSystem` — which evaluates the condition — and this file,
 * which describes it, cannot disagree about the number.
 */
export const FINISHER_HEALTH_DEFAULT = 0.2;

/** States a finisher may be launched from. It is a neutral-game input. */
const FINISHER_START_STATES = new Set([
  STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.BLOCK_HIGH, STATE.BLOCK_LOW,
]);

/** Mirror of Skeleton.scaleFor — hurtbox radii must scale with the proportions. */
function proportionScale(name, p) {
  if (!p) return 1;
  if (/^(hip_|knee_|ankle_|foot_|toe_)/.test(name)) return p.legs ?? 1;
  if (/^(shoulder_|elbow_|wrist_|hand_|fingers_|thumb_|clavicle_)/.test(name)) return p.arms ?? 1;
  if (/^(spine|chest|neck)/.test(name)) return p.torso ?? 1;
  if (name === 'head' || name === 'headTop') return p.head ?? 1;
  if (name === 'hips') return p.height ?? 1;
  return 1;
}

export class Fighter {
  /** Clip ids we have already warned about, so the console stays readable. */
  static missingClips = new Set();

  /**
   * @param {{index:number, def:Object, scene:THREE.Scene, environment:Object}} opts
   */
  constructor({ index, def, scene, environment }) {
    this.index = index;
    this.def = def;
    this.scene = scene;
    this.environment = environment;

    this.facing = index === 0 ? 1 : -1;
    this.visualYaw = yawForFacing(this.facing);
    // Yaw the animation is currently adding on top of `facing`, and its value
    // on the previous tick so render() can interpolate across a spin.
    this.animYaw = 0;
    this.prevAnimYaw = 0;
    /** How much of the current move's aim correction is already in `animYaw`. */
    this.aimYaw = 0;
    this.position = new THREE.Vector3((index === 0 ? -1.9 : 1.9), 0, 0);
    this.prevPosition = this.position.clone();
    this.velocity = new THREE.Vector3();

    this.state = STATE.IDLE;
    this.stateTicks = 0;
    this.simTick = 0;

    this.health = MAX_HEALTH;
    this.recoverable = 0;
    this.meter = 0;
    this.comboCount = 0;
    this.comboDamage = 0;
    this.juggleCount = 0;

    this.airborne = false;
    this.grounded = true;
    this.crouching = false;
    this.isBlocking = false;
    this.guardHeight = HEIGHT.HIGH;
    this.isCounterHit = false;
    this.invulnerable = false;
    this.throwInvuln = 0;

    this.currentMove = null;
    this.moveTick = 0;
    this.moveInstance = 0;
    this.connected = new Set();     // "<instance>:<windowIndex>" already landed
    this.hitConnectedThisMove = false;
    this.moveEndTick = null;        // set by beginRecovery once a blow lands
    this.postActive = false;        // the "windows are over" beat has fired

    this.hurtboxes = [];
    this.hitboxes = [];
    this.activeHitboxes = 0;

    this.inputBuffer = [];
    this.cmd = null;
    this.upHeldTicks = 0;
    this.pendingSidestep = 0;
    /**
     * Direction-edge bookkeeping, used to tell a real double-tap from a dash
     * motion the input layer manufactured. See `#trackDirection`.
     */
    this.dirSign = 0;
    this.dirReleaseTick = -999;
    this.prevDir = { fwd: false, back: false, up: false, down: false };
    /**
     * A copy of this tick's command with the dash motion validated, handed to
     * `findMove` in place of the raw one. It carries exactly the fields
     * `matchesEntry` reads; see `#liveCommand`.
     */
    this._live = { fwd: false, back: false, up: false, down: false, motion: null, pressed: null, held: null };

    /** Finisher state. `move` is resolved from the character's move table. */
    this.finisher = {
      move: null, steps: [], spec: null,
      open: false, openedThisRound: false, fired: false, ready: false,
      ticksLeft: 0, window: FINISHER_WINDOW_DEFAULT, index: 0,
    };

    this.radius = FIGHTER_RADIUS;
    this.floorY = GROUND_Y;
    this.bounds = { halfWidth: ARENA_HALF_WIDTH, halfDepth: ARENA_HALF_DEPTH };
    this.gravityScale = 1;
    this.wallImpact = null;
    this.bounceRemaining = 0;
    this.bounceFactor = 0;

    this.stunTicks = 0;
    this.reaction = null;
    this.lastDamageTick = -999;
    /** Tick a blow last landed or was blocked; see #inertiaFor. */
    this.impactTick = -999;
    this.damageLevel = 0;
    this.brokenParts = new Set();

    this.throwPartner = null;
    this.throwData = null;
    this.throwBroken = false;

    this.opponent = null;
    this.moveSetKey = def?.moveSet && MOVES[def.moveSet] ? def.moveSet : 'standard';
    /** The table this fighter actually fights with. See `#bindMoveSet`. */
    this.moveTable = null;
    this.stats = def?.stats || { power: 5, speed: 5, reach: 5, weight: 5, defense: 5 };

    this.rng = new Rng(0x51ed2701 + index * 0x9e37);
    this.group = new THREE.Group();
    this.group.name = `fighter${index}`;
    this.group.matrixAutoUpdate = true;

    this.robot = null;
    this.animator = null;
    this.bones = null;
    this.boneByName = null;
    this.emissiveMats = [];
    this.actuators = [];
    this.footState = { L: { y: 1, down: false }, R: { y: 1, down: false } };
    /**
     * Latched floor contact per foot: where it was put, how much it holds, and
     * where its ankle stood last tick — the target is consumed one tick after it
     * is set, so that distance is exactly how stale the target will be.
     */
    this.plantState = {
      L: { contact: 0, weight: 0, target: new THREE.Vector3(), sole: [], last: new THREE.Vector3(), hasLast: false },
      R: { contact: 0, weight: 0, target: new THREE.Vector3(), sole: [], last: new THREE.Vector3(), hasLast: false },
    };
    this.legLength = 0.86;
    /** Metres the pelvis is being held above where the clip put it. */
    this.pelvisLift = 0;
    this.currentClip = '';
    /** Bus unsubscribers for the two events that land on this body. */
    this._offHit = null;
    this._offBlock = null;
    this.ready = false;
    this.#bindMoveSet();
  }

  /**
   * Resolve the move table this fighter fights with, and the finisher inside it.
   *
   * `movesFor` is the supported accessor (docs/CONTRACT-character-moves.md):
   * reading `MOVES[archetype]` directly silently misses every character-specific
   * move, which is most of what makes two robots of the same archetype
   * different. `moveSetKey` is kept because the CPU and the QA harness pass it
   * around by name.
   */
  #bindMoveSet() {
    this.moveSetKey = this.def?.moveSet && MOVES[this.def.moveSet] ? this.def.moveSet : 'standard';
    this.moveTable = movesFor(this.def) || MOVES[this.moveSetKey] || MOVES.standard;

    const fs = this.finisher;
    fs.move = null; fs.steps = []; fs.spec = null;
    fs.open = false; fs.openedThisRound = false; fs.fired = false; fs.ready = false;
    fs.index = 0; fs.ticksLeft = 0; fs.window = FINISHER_WINDOW_DEFAULT;

    let found = null;
    for (const m of Object.values(this.moveTable)) {
      if (m && (m.tag === 'finisher' || m.props?.finisher)) { found = m; break; }
    }
    if (!found) return;

    fs.move = found;
    fs.spec = found.props.finisher || {};
    fs.window = Math.max(12, Math.round(fs.spec.window ?? FINISHER_WINDOW_DEFAULT));
    fs.steps = String(found.input || '').split(',').map((t) => parseToken(t.trim())).filter((t) => t);
    // The ordinary matcher must never be able to start it. See FINISHER_STANCE.
    if (found.props.requireStance == null) found.props.requireStance = FINISHER_STANCE;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /** Build the rig, the robot mesh and the animator. */
  async init() {
    this.scene.add(this.group);
    this.#buildRig();
    Fighter.warmClipTiming();
    this.#listenForBlows();
    this.ready = true;
    return this;
  }

  /**
   * Subscribe to the two events that land on this body.
   *
   * Both fire synchronously inside `CombatSystem.simulate`, which is inside the
   * sim tick, so what they arm is as deterministic as anything else in here.
   * The handlers are held so `dispose()` can drop them — a fighter that has been
   * torn down must not keep receiving blows.
   */
  #listenForBlows() {
    this.#dropBlowListeners();
    this._offHit = bus.on('hit', (p) => {
      if (p.defender === this) this.#reactToBlow(p, false);
    });
    this._offBlock = bus.on('block', (p) => {
      if (p.defender === this) this.#reactToBlow(p, true);
    });
  }

  #dropBlowListeners() {
    if (this._offHit) { this._offHit(); this._offHit = null; }
    if (this._offBlock) { this._offBlock(); this._offBlock = null; }
  }

  /**
   * Drive the receiving animator from the blow that just landed.
   *
   * The vector arrives in world space and the animator wants model space, so it
   * is turned by the yaw the SIM believes in — `facing` plus the animation's own
   * yaw — and not by `visualYaw`, which is a render-rate spring chasing that
   * value and is therefore a different number on every frame.
   *
   * Force comes off the striking limb's speed rather than off the move's damage:
   * a 60-damage launcher thrown by a slow arm should shake the body less than a
   * fast one, and only the swept velocity knows the difference. The weight class
   * rides on top of it rather than replacing it, because a third of hits come in
   * on `#strikeVelocity`'s 8 m/s fallback and would otherwise be identical.
   *
   * The reaction is armed AFTER this tick's `animator.simulate` — `CombatSystem`
   * resolves once both fighters have advanced — and the sim then STOPS, because
   * every path that emits `hit` or `block` emits `hitstop` with it and
   * `Game.#frame` stops feeding the accumulator for 5 to 18 ticks. So the tick
   * after contact does not arrive for 83 to 300 milliseconds, and until round 13
   * the receiving fighter spent all of it in the pose it held before the blow:
   * measured 1 - IoU = 0.009 against its own pre-hit silhouette, and 0.000
   * between a blow from the front and the same blow from behind. `hitReaction`
   * now stamps the contact pose for the frozen frames — see `#armContactStamp`.
   * @param {Object} p the bus payload
   * @param {boolean} blocked
   */
  #reactToBlow(p, blocked) {
    const anim = this.animator;
    if (!anim) return;
    if (p.velocity) _hv.copy(p.velocity); else _hv.set(0, 0, 0);
    const speed = _hv.length();
    if (speed < 1e-4) _hv.set((p.attacker?.facing ?? this.facing), 0, 0);
    else _hv.divideScalar(speed);
    _hv.applyAxisAngle(UP, -(yawForFacing(this.facing) + this.animYaw));

    // A heavy chassis is moved less by the same blow, the same scaling the
    // knockback already uses, so the two never disagree on screen. The clamp
    // goes last, after every multiplier, or a counter-hit launcher stacks past
    // the ceiling and throws the head 41 degrees in two frames.
    let force = (speed / HIT_REF_SPEED) * (10 / (5 + (this.stats.weight ?? 5)));
    force *= HIT_WEIGHT_SCALE[p.move?.weight] ?? 1;
    if (p.counter) force *= 1.25;
    force = THREE.MathUtils.clamp(force, HIT_FORCE_MIN, HIT_FORCE_MAX);
    if (blocked) force *= BLOCK_FORCE_SCALE;

    const region = blocked ? 'arm' : (p.region || 'torso');
    anim.hitReaction({ dir: _hv, force, region });
    anim.impact({ dir: _hv, force: force * HIT_RIPPLE_SCALE, region });
  }

  /**
   * Resolve the retime of every move once, at load, and report any move whose
   * clip disagrees with its frame data by more than the clamp can absorb. That
   * warning is the whole point: a mismatch is a note to an animator, not
   * something to paper over silently at runtime.
   */
  static warmClipTiming() {
    if (Fighter._timingWarmed) return;
    Fighter._timingWarmed = true;
    const off = [];
    for (const set of Object.values(MOVES)) {
      for (const move of Object.values(set)) {
        const r = retimeFor(move);
        if (!r) continue;
        const wantIn = r.pivot / r.pivotAt;
        if (wantIn < RETIME_MIN || wantIn > RETIME_MAX) {
          off.push(`${move.id ?? move.name ?? move.clip} wants ${wantIn.toFixed(2)}x wind-up on ${move.clip}`);
        }
      }
    }
    if (off.length) {
      console.warn(`[Fighter] ${off.length} move(s) clamped on retime:\n  ${off.slice(0, 8).join('\n  ')}`);
    }
  }

  #buildRig() {
    const prop = this.def?.proportions || null;
    const bundle = createSkeleton(prop);
    this.skeletonBundle = bundle;
    this.bones = bundle.bones;
    this.boneByName = bundle.byName;

    // Hurtbox capsule descriptors, resolved once against the scaled rig.
    this.hurtDefs = HURTBOX_BONES.map((name) => {
      const d = BONES.find((b) => b.name === name);
      const s = proportionScale(name, prop);
      return { name, radius: (d.radius || 0.12) * s, length: (d.length || 0) * s, region: d.region };
    });
    this.hurtboxes = this.hurtDefs.map((d) => ({
      bone: d.name, region: d.region, radius: d.radius,
      p0: new THREE.Vector3(), p1: new THREE.Vector3(),
    }));
    // Hitbox pool — generous, reused, never reallocated during a match.
    this.hitboxPool = [];
    for (let i = 0; i < 8; i++) {
      this.hitboxPool.push({
        bone: '', radius: 0, windowIndex: 0, move: null,
        p0: new THREE.Vector3(), p1: new THREE.Vector3(), tip: new THREE.Vector3(),
      });
    }
    this.hitboxes = [];
    /** Per-bone world position this tick and last, for swept hitboxes. */
    this.boneTrack = Object.create(null);
    this.moveBones = null;

    this.robot = buildRobot(this.def, bundle, this.environment);
    if (this.robot?.group) this.group.add(this.robot.group);
    // Some builders parent the rig themselves; if not, do it here.
    if (!bundle.byName.root.parent) this.group.add(bundle.byName.root);

    // Reach of one leg on THIS rig — createSkeleton has already folded the
    // character's proportions into the bone offsets, so measure, do not guess.
    this.legLength = (bundle.byName.knee_L?.position.length() ?? 0.44) +
      (bundle.byName.ankle_L?.position.length() ?? 0.42);
    for (const side of ['L', 'R']) {
      const st = this.plantState[side];
      st.contact = 0;
      st.weight = 0;
      st.hasLast = false;
    }

    this.animator = new Animator(bundle, CLIPS);
    // The rig declares its own secondary-motion leaves; the animator ships the
    // integrator but registers nothing on its own, so hand them over here. Cost
    // is eight extra `Spring3.step` calls per fighter per tick.
    for (const name of SPRING_BONES) this.animator.addSpringBone(name, SPRING_DEFS[name]);
    this.#installPelvisLift();
    this.#installFootRoll();
    this.#collectVisualParts();
    this.#play('idle.fight', 0, true);
    this.#drivePose();
    this.#measureSole();
    this.#buildHurtboxes();
  }

  /**
   * Cache what the presentation layer drives every frame.
   *
   * A builder that exposes `robot.update(dt, state)` owns its own emissive
   * groups, so we hand it health/meter/pulse and stay out of its way. Otherwise
   * we drive the emissive materials directly. Actuators are the same deal: a
   * builder may hand back plain Object3Ds spanning two bones (we place them), or
   * an instanced rig that re-measures itself inside `updateMatrixWorld` (we only
   * have to keep the matrices fresh, which `#drivePose` and `render` both do).
   */
  #collectVisualParts() {
    this.robotUpdate = typeof this.robot?.update === 'function' ? this.robot.update : null;
    this.emissiveMats.length = 0;
    const seen = new Set();
    const glowy = [];
    const anyEmissive = [];
    if (this.robotUpdate) { this.#collectActuators(); return; }
    this.group.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : null;
      if (!mats) return;
      for (const m of mats) {
        if (!m || !m.emissive || seen.has(m)) continue;
        seen.add(m);
        const rec = { mat: m, base: m.emissiveIntensity ?? 1 };
        anyEmissive.push(rec);
        if (m.userData?.pulse === true || /emissive|glow|eye|vent|core|reactor/i.test(m.name || '')) glowy.push(rec);
      }
    });
    const chosen = glowy.length ? glowy : anyEmissive;
    for (const rec of chosen) this.emissiveMats.push(rec);
    this.#collectActuators();
  }

  #collectActuators() {
    this.actuators.length = 0;
    const list = this.robot?.parts?.actuators;
    const entries = Array.isArray(list) ? list : (list ? Object.values(list) : []);
    for (const e of entries) {
      const obj = e?.isObject3D ? e : (e?.object || e?.mesh);
      if (!obj) continue;
      const src = e.isObject3D ? (e.userData || {}) : e;
      const aName = src.from || src.boneA || obj.userData?.from;
      const bName = src.to || src.boneB || obj.userData?.to;
      const a = this.boneByName[aName];
      const b = this.boneByName[bName];
      if (!a || !b) continue;
      this.actuators.push({ obj, a, b, restLen: 0, baseScale: obj.scale.y || 1 });
    }
  }

  /** Swap character without rebuilding the scene graph wrapper. */
  setCharacter(def) {
    if (!def) return;
    // Rebuilding a robot is 96-135ms of procedural geometry and material work,
    // and `startMatch` calls this for both fighters on every rematch — so a
    // rematch with the same two characters was paying ~250ms of stall to
    // reconstruct meshes identical to the ones already on screen.
    if (this.ready && this.def === def && this.robot) return;
    this.def = def;
    this.stats = def.stats || this.stats;
    this.#bindMoveSet();
    if (!this.ready) return;
    if (this.robot?.dispose) this.robot.dispose();
    if (this.robot?.group) this.group.remove(this.robot.group);
    const root = this.skeletonBundle?.byName?.root;
    if (root?.parent) root.parent.remove(root);
    // The skeleton owns a GPU resource that `robot.dispose()` cannot see.
    //
    // `THREE.Skeleton` lazily allocates a bone DataTexture the first time the
    // rig is rendered (`computeBoneTexture`), and it is freed by
    // `Skeleton.dispose()` and by nothing else — not by disposing the meshes,
    // not by dropping the bones out of the scene. Nothing in this project
    // called it, so every character change orphaned one texture per fighter
    // and `renderer.info.memory.textures` climbed for the life of the page.
    //
    // Measured: it is a resource leak and NOT a performance one. 300 orphaned
    // bone textures — 25x what a full 20-shot capture pass leaks — moved the
    // frame by 0.4 ms against a 17.6 ms floor, with the program count
    // unchanged, so the "leaked textures push a shader past the texture-unit
    // ceiling" theory is wrong on its own terms: an orphaned texture belongs to
    // a skeleton that is no longer in any render list, and sampler counts are
    // fixed when the program links. See docs/PROFILING.md.
    this.skeletonBundle?.skeleton?.dispose?.();
    this.#buildRig();
  }

  setOpponent(other) { this.opponent = other; }

  /** Stage geometry, handed over by CombatSystem once the arena exists. */
  setBounds(bounds, floorY = GROUND_Y) {
    if (bounds) {
      this.bounds.halfWidth = bounds.halfWidth ?? this.bounds.halfWidth;
      this.bounds.halfDepth = bounds.halfDepth ?? this.bounds.halfDepth;
    }
    this.floorY = floorY;
  }

  reset(pos, facing) {
    /*
     * RESEED THE RNG. Round 2 used to depend on how round 1 went.
     *
     * `reset()` restored position, velocity, health and state, and left
     * `this.rng` wherever round 1 had advanced it to. So two matches that played
     * an identical round 2 diverged, because the generator entered it in a
     * different place. Measured by `tools/dtgate.mjs` DT-3, driving two real
     * 1400-tick scripts through actual key events and diffing round 2 after two
     * different round 1s:
     *
     *   TRIAL none   DIVERGES at round-2 tick 0   rng.s0 1130603015 vs 2498565824
     *                OBSERVABLE at tick 223       pos.x -3.5442645 vs -3.5358588
     *   TRIAL rng    CLEAN
     *   TRIAL anim   DIVERGES (identical to none)
     *   TRIAL both   CLEAN
     *
     * Four INDEPENDENT trials, which is the whole point: an earlier pass ran its
     * candidates in sequence, so the later ones may have inherited a settled
     * state rather than fixed anything, and it said so rather than claiming a
     * cause. Run separately, the answer is unambiguous -- **it is the rng and it
     * is not the animator clock.** Half the original hypothesis was wrong.
     *
     * 8.4 mm of divergence by tick 223 is not cosmetic: `#getUp` picks between
     * `r.getUp` and `r.getUpRoll` on `rng.next() < 0.35`, so a knockdown late in
     * round 2 could wake up differently depending on round 1. The charter says
     * "deterministic 60Hz simulation, because frame data is the game", and this
     * is the clause that was quietly untrue.
     *
     * Same expression as the constructor, deliberately: one definition of what a
     * fighter's initial randomness is, in two places that must not drift.
     */
    this.rng = new Rng(0x51ed2701 + this.index * 0x9e37);
    this.position.copy(pos);
    this.position.y = this.floorY;
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.facing = facing;
    this.visualYaw = yawForFacing(facing);
    this.animYaw = 0;
    this.prevAnimYaw = 0;
    this.aimYaw = 0;
    this.health = MAX_HEALTH;
    this.recoverable = 0;
    this.meter = Math.min(this.meter, METER_MAX * 0.25);
    this.comboCount = 0;
    this.comboDamage = 0;
    this.juggleCount = 0;
    this.state = STATE.IDLE;
    this.stateTicks = 0;
    this.stunTicks = 0;
    this.reaction = null;
    this.currentMove = null;
    this.moveTick = 0;
    this.moveEndTick = null;
    this.postActive = false;
    this.connected.clear();
    this.hitboxes.length = 0;
    this.inputBuffer.length = 0;
    this.airborne = false;
    this.grounded = true;
    this.crouching = false;
    this.isBlocking = false;
    this.isCounterHit = false;
    this.invulnerable = false;
    this.throwInvuln = 0;
    this.throwPartner = null;
    this.throwData = null;
    this.damageLevel = 0;
    this.brokenParts.clear();
    this.bounceRemaining = 0;
    this.wallImpact = null;
    this.upHeldTicks = 0;
    this.pendingSidestep = 0;
    this.dirSign = 0;
    this.dirReleaseTick = -999;
    this.prevDir.fwd = false; this.prevDir.back = false;
    this.prevDir.up = false; this.prevDir.down = false;
    // One finisher window per fighter per round, and a fresh one every round.
    this.finisher.open = false;
    this.finisher.openedThisRound = false;
    this.finisher.fired = false;
    this.finisher.ready = false;
    this.finisher.index = 0;
    this.finisher.ticksLeft = 0;
    this.lastDamageTick = -999;
    this.impactTick = -999;
    /*
     * THE SIM CLOCK, AND EVERY FIELD MEASURED AGAINST IT.
     *
     * `simTick` was left wherever round 1 had run it to, and
     * `Animator.simulate(tick)` takes that absolute tick as its deterministic
     * NOISE PHASE — so round 2 breathed on a different phase depending on how
     * long round 1 lasted, the pose handed to the hitbox builder differed from
     * the first tick, and an in-session reset was not a clean replay start. The
     * same field drives the input-buffer window (`#pushInput`), the motion
     * window (`#liveCommand`), the special-move repeat lock and the throw,
     * damage and KO clocks.
     *
     * The header above records a four-trial investigation that cleared "the
     * animator clock" as a cause of the round-2 divergence, and it was right
     * about what it measured: both of its arms ran round 1 for the SAME number
     * of ticks, so `simTick` was equal on both sides of the reset and cancelled
     * in the diff. dtgate DT-3 has the same shape and the same blind spot,
     * which is why DT-4 exists — it makes the two round 1s DIFFERENT LENGTHS,
     * and it goes red on this line alone.
     *
     * The companions are not optional. Every `*Tick` below is an ABSOLUTE tick
     * compared against `simTick`, so zeroing the clock without them leaves e.g.
     * `#regen`'s `simTick - lastDamageTick < 60` reading a large negative and
     * suppressing regeneration for the whole of round 2. They move together or
     * not at all.
     */
    this.simTick = 0;
    this.koTick = -999;
    this.lastMotion = null;
    this.lastMotionTick = -999;
    // Set every tick by `simulate`, but read by `#startMove` before the first
    // one of a round; a stale Command could start a move nobody pressed.
    this.cmd = null;
    // `#trackMoveBones` returns early on a null, and otherwise keeps sweeping
    // the PREVIOUS round's move bones into `boneTrack` — which is where a swept
    // hitbox gets its `p0`.
    this.moveBones = null;
    // Presentation only, but it is a clock and it belongs with the others.
    this.pulsePhase = 0;
    for (const hb of this.hitboxPool) { hb.move = null; hb.bone = null; hb.windowIndex = -1; }
    this.pelvisLift = 0;
    for (const side of ['L', 'R']) {
      const st = this.plantState[side];
      st.contact = 0;
      st.weight = 0;
      st.hasLast = false;
    }
    if (this.animator) {
      /*
       * `Animator.reset()`, AND IT WAS NEVER CALLED FROM HERE.
       *
       * This block used to be `clearImpacts()` plus a rewind, and the comment
       * above it said "nothing else in the loop calls `Animator.reset()`" —
       * which was true, and was the bug rather than the justification. The
       * animator carries springs, inertia, the ripple queue, the hit layer, the
       * IK hold quaternions, the foot-plant weights and the breathing energy
       * accumulator, and every one of them entered round 2 holding whatever
       * round 1 finished with. So the POSE at round-2 tick 0 depended on round
       * 1, and the pose is what the hitbox builder sweeps.
       *
       * Neither dtgate arm could see it until this round. DT-3 and DT-4 traced
       * position, velocity, state and the clocks — bulk simulation state, no
       * pose — so an animator-only divergence moved no column until it happened
       * to change whether a hitbox reached. `poseSig` (a sum over the rebuilt
       * hurtbox capsules) is the column that made it visible, and it turned
       * DT-3 red as well: the defect was never specific to round-1 LENGTH.
       *
       * `reset()` clears every stateful field except `tick`, which is the
       * animator's own clock and the phase its entries are stamped against, so
       * that is zeroed here too. The rewind has to follow, because `reset()`
       * empties `layer.entries` and would otherwise leave the fighter posed by
       * nothing at all.
       */
      this.animator.reset?.();
      this.animator.tick = 0;
      this.animator.clearImpacts?.();
      this.#play('idle.fight', 0, true);
    }
    this.#drivePose();
    this.#buildHurtboxes();
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /**
   * Advance one 60Hz tick.
   * @param {?Object} cmd the Command for this fighter, or null (no input)
   */
  simulate(cmd) {
    this.simTick++;
    this.stateTicks++;
    this.prevPosition.copy(this.position);
    this.prevAnimYaw = this.animYaw;
    this.cmd = cmd;
    this.wallImpact = null;

    this.#trackDirection(cmd);
    this.#pushInput(cmd);
    this.#tickFinisher(cmd);
    this.#updateFacing();
    this.#updateGuard(cmd);
    this.#updateState(cmd);
    this.#applyMoveMotion();
    this.#advanceAnimation();
    this.#integrate();
    this.#pushApart();
    this.#realignAxis();
    this.#clampToArena();
    this.#regen();
    this.#updateFlags();
    this.#writePose();
    this.#buildHurtboxes();
    this.#buildHitboxes();
    this.#footIk();
    this.#trackFootfalls();
  }

  /** Cinematic entrance; `t` is the intro phase tick. */
  simulateIntro(t) {
    this.simTick++;
    this.state = STATE.INTRO;
    const home = this.index === 0 ? -1.9 : 1.9;
    if (t === 0) {
      this.position.set(home + -this.facing * 3.2, this.floorY, this.index === 0 ? 0.6 : -0.6);
      this.prevPosition.copy(this.position);
      this.#play('i.walkOn', 0, false);
    }
    this.prevPosition.copy(this.position);

    if (t < 84) {
      const u = t / 84;
      const e = u * u * (3 - 2 * u);
      this.position.x = THREE.MathUtils.lerp(home + -this.facing * 3.2, home, e);
      this.position.z = THREE.MathUtils.lerp(this.index === 0 ? 0.6 : -0.6, 0, e);
    } else if (t === 84) {
      this.#play(this.index === 0 ? 'i.powerUp' : 'i.pointTaunt', 6, false);
    } else if (t === 128) {
      this.#play('i.stanceSet', 6, false);
    }
    this.position.y = this.floorY;
    this.facing = this.opponent ? Math.sign(this.opponent.position.x - this.position.x) || this.facing : this.facing;
    this.#drivePose();
    this.#buildHurtboxes();
    this.hitboxes.length = 0;
  }

  // --- input ---------------------------------------------------------------

  #pushInput(cmd) {
    const buf = this.inputBuffer;
    while (buf.length && this.simTick - buf[0].tick > INPUT_BUFFER_TICKS) buf.shift();
    if (!cmd) return;
    if (cmd.pressed && cmd.pressed.size) {
      buf.push({
        tick: this.simTick,
        btns: new Set(cmd.pressed),
        fwd: !!cmd.fwd, back: !!cmd.back, up: !!cmd.up, down: !!cmd.down,
        motion: this.#dashMotion(cmd),
        used: false,
      });
      if (buf.length > 24) buf.shift();
    }
  }

  /**
   * Track when a horizontal direction was last let go.
   *
   * This is one number and it exists to answer one question: was a `ff`/`bb`
   * dash motion TAPPED, or did the input layer manufacture it?
   */
  #trackDirection(cmd) {
    const sign = cmd ? (cmd.fwd ? 1 : cmd.back ? -1 : 0) : 0;
    if (sign !== this.dirSign) {
      if (this.dirSign !== 0) this.dirReleaseTick = this.simTick;
      this.dirSign = sign;
    }
  }

  /**
   * The command's motion, with a manufactured dash rejected.
   *
   * THE BUG THIS FIXES, and it is a live playability defect: holding a direction
   * and pressing a button reported a DASH. `Input.#motion` reads the direction
   * history, and `Input.commandsFor` pushes a fresh history entry on any tick a
   * button is pressed — so holding back for ten ticks and then pressing a button
   * produced two consecutive `4` samples with nothing between them, which the
   * matcher reads as back-back. Reproduced in a browser with real key events,
   * 16 attempts out of 16: `b+3` (Gyro Sweepline) never came out, `bb+3` (Phase
   * Spiral) came out every time, because a motion prefix scores 100 against a
   * single direction's 25 and `findMove` walks the table most-specific-first.
   * Any `bb+`/`ff+` move the move table gains silently eats the plain `b+`/`f+`
   * move on the same button, which is exactly the shape of "back + RP does
   * nothing" — the button is not dead, it is bound to something else.
   *
   * A real dash has the direction RELEASED between the two taps. A held one
   * never does, and that is the whole test. The window matches the one the
   * motion recogniser itself uses, so this is never stricter than the source.
   *
   * It is applied to the BUFFER ENTRY and to the live command handed to
   * `findMove` — the two things that pick a move — and deliberately not to the
   * raw `cmd.motion` that `#tickNeutral` reads for the neutral-game dash. A
   * synthetic CPU command sets `motion` with no direction at all on the press
   * tick (`CPU.#applyParsed` calls `#setDir('')`), which registers as a release
   * on that very tick, so the CPU's `ff+2` and `ff+3` still come out; its
   * `motion: 'ff'` dash-in, which holds forward and presses nothing, is not
   * routed through here at all.
   *
   * The root cause is one line in `src/core/Input.js` and the patch is in this
   * round's report; this gate stays either way, because a fighter should not be
   * able to be told it dashed by anything but a dash.
   *
   * @param {Object} cmd
   * @returns {?string}
   */
  #dashMotion(cmd) {
    const m = cmd?.motion || null;
    if (m !== 'ff' && m !== 'bb') return m;
    // Only a HELD direction can manufacture one. A dash reported with the stick
    // already back at neutral cannot be this defect, and the CPU's synthetic
    // commands arrive that way, so they are never touched.
    if (this.dirSign !== (m === 'ff' ? 1 : -1)) return m;
    return (this.simTick - this.dirReleaseTick) <= MOTION_WINDOW_TICKS ? m : null;
  }

  /**
   * This tick's command as `findMove` should see it: the same directions and
   * buttons, with a manufactured dash motion removed. `matchesEntry` reads
   * `motion` and the four direction flags off this object and nothing else.
   */
  #liveCommand(cmd) {
    if (!cmd) return null;
    const l = this._live;
    l.fwd = !!cmd.fwd; l.back = !!cmd.back; l.up = !!cmd.up; l.down = !!cmd.down;
    l.pressed = cmd.pressed; l.held = cmd.held;
    l.motion = this.#dashMotion(cmd);
    return l;
  }

  #updateFacing() {
    if (!this.opponent) return;
    if (this.state === STATE.ATTACK || this.state === STATE.THROW || this.state === STATE.THROWN) return;
    if (this.airborne || this.stunTicks > 0) return;
    const d = this.opponent.position.x - this.position.x;
    if (Math.abs(d) < 0.06) return;
    this.facing = d > 0 ? 1 : -1;
  }

  #updateGuard(cmd) {
    // Guard is its own key now (Q). Back stays a direction, so loco.walkBack --
    // wired up but unreachable while this branch sat above the walk branch --
    // finally plays. Touch has no spare key, so a pad still guards on back.
    const guardHeld = !!(cmd && (cmd.guard || (cmd.back && cmd.touchGuard)));
    this.crouching = !!(cmd && cmd.down) && !this.airborne;
    const canGuard = this.#canGuard();
    this.isBlocking = guardHeld && canGuard;
    this.guardHeight = (this.isBlocking && this.crouching) ? HEIGHT.LOW : HEIGHT.HIGH;
  }

  #canGuard() {
    switch (this.state) {
      case STATE.IDLE: case STATE.WALK: case STATE.CROUCH:
      case STATE.BLOCK_HIGH: case STATE.BLOCK_LOW: case STATE.BLOCKSTUN:
        return true;
      case STATE.SIDESTEP:
        return this.stateTicks > 10;
      case STATE.BACKDASH:
        return this.stateTicks > 12;
      default:
        return false;
    }
  }

  // --- state machine -------------------------------------------------------

  #updateState(cmd) {
    switch (this.state) {
      case STATE.KO:
        return;

      case STATE.VICTORY:
        if (this.animator?.finished) this.#play('v.pose', 8, true);
        return;

      case STATE.ATTACK:
        this.#tickAttack(cmd);
        return;

      case STATE.THROW:
        this.#tickThrow();
        return;

      case STATE.THROWN:
        this.#tickThrown(cmd);
        return;

      case STATE.BLOCKSTUN:
        if (--this.stunTicks <= 0) this.#toNeutral();
        return;

      case STATE.HITSTUN:
        if (--this.stunTicks <= 0) this.#toNeutral();
        return;

      case STATE.LAUNCHED:
      case STATE.JUGGLED:
        if (this.velocity.y < 0 && this.state === STATE.LAUNCHED) this.#enter(STATE.JUGGLED);
        return;

      case STATE.KNOCKDOWN:
        if (--this.stunTicks <= 0) {
          this.#enter(STATE.WAKEUP);
          this.stunTicks = 22;
          this.#play(this.rng.next() < 0.35 ? 'r.getUpRoll' : 'r.getUp', 4, false);
        }
        return;

      case STATE.WAKEUP:
        if (--this.stunTicks <= 0) this.#toNeutral();
        return;

      default:
        this.#tickNeutral(cmd);
    }
  }

  #tickNeutral(cmd) {
    // A completed finisher sequence outranks everything, including a buffered
    // move. It is armed by `#tickFinisher` and launched here, so it enters the
    // move state machine on the same tick boundary as any other move — and if
    // the fighter is not actionable yet, the arm survives and is retried every
    // tick until the window closes.
    if (this.finisher.ready && this.#fireFinisher()) return;

    // A move always wins over movement.
    const mv = this.#tryMove(false);
    if (mv) { this.#startMove(mv); return; }

    const timed = this.state === STATE.DASH || this.state === STATE.BACKDASH || this.state === STATE.SIDESTEP;
    if (timed) {
      if (--this.stunTicks <= 0) this.#toNeutral();
      return;
    }
    if (this.airborne) { this.#tickAir(cmd); return; }
    if (!cmd) { this.upHeldTicks = 0; this.#idle(); return; }

    // Tap up = sidestep, hold up = jump. Straight out of Tekken. A held-through
    // jump parks the counter at -1 so landing does not immediately re-launch.
    if (cmd.up) {
      if (this.upHeldTicks >= 0) {
        this.upHeldTicks++;
        if (this.upHeldTicks >= JUMP_HOLD_TICKS) { this.#jump(cmd); return; }
      }
      this.#idle();
      return;
    }
    if (this.upHeldTicks !== 0) {
      const held = this.upHeldTicks;
      this.upHeldTicks = 0;
      // Step toward the middle of the arena so a sidestep never buries the
      // fighter in the back wall.
      if (held > 0) { this.#sidestep(this.position.z > 0 ? -1 : 1); return; }
    }

    if (cmd.motion === 'ff' && this.#consumeMotion('ff')) { this.#dash(1); return; }
    if (cmd.motion === 'bb' && this.#consumeMotion('bb')) { this.#dash(-1); return; }

    if (this.isBlocking) {
      this.#enter(this.crouching ? STATE.BLOCK_LOW : STATE.BLOCK_HIGH);
      this.#play(this.crouching ? 'r.blockLow' : 'r.blockHigh', 4, true);
      this.velocity.x *= 0.6;
      return;
    }
    if (this.crouching) {
      this.#enter(STATE.CROUCH);
      if (cmd.fwd || cmd.back) {
        this.velocity.x = this.facing * (cmd.fwd ? CROUCH_WALK : -CROUCH_WALK);
        this.#play('loco.crouchWalk', 5, true);
      } else {
        this.velocity.x *= 0.5;
        this.#play('idle.crouch', 5, true);
      }
      return;
    }
    if (cmd.fwd || cmd.back) {
      this.#enter(STATE.WALK);
      this.velocity.x = this.facing * (cmd.fwd ? WALK_FWD : -WALK_BACK);
      // Pick the clip whose authored stride matches the speed we actually drive
      // the body at, rather than always playing the walk. Measured authored
      // ground speeds: walkFwd 0.46 m/s, walkBack 0.41, runFwd 2.69, runBack
      // 2.03. Playing walkFwd at WALK_FWD made the fighter skate at six times
      // its stride in every neutral-game frame; each gait now matches the speed
      // it is driven at to within 2%.
      this.#play(cmd.fwd ? 'loco.runFwd' : 'loco.runBack', 6, true);
      return;
    }
    this.#idle();
  }

  #idle() {
    this.#enter(STATE.IDLE);
    this.#play(this.health < MAX_HEALTH * 0.28 ? 'idle.lowHealth' : 'idle.fight', 7, true);
  }

  #tickAir(cmd) {
    const mv = this.#tryMove(false);
    if (mv) { this.#startMove(mv); return; }
    if (this.velocity.y > 0.4) this.#enter(STATE.JUMP_RISE);
    else if (this.velocity.y < -0.4) this.#enter(STATE.JUMP_FALL);
    else this.#enter(STATE.JUMP_APEX);
    this.#play('loco.jumpAir', 5, true);
    if (cmd && (cmd.fwd || cmd.back)) this.velocity.x += this.facing * (cmd.fwd ? 0.09 : -0.09);
  }

  #jump(cmd) {
    this.#enter(STATE.JUMP_RISE);
    this.airborne = true;
    this.grounded = false;
    this.velocity.y = JUMP_VY;
    if (cmd?.fwd) this.velocity.x = this.facing * 3.4;
    else if (cmd?.back) this.velocity.x = -this.facing * 3.0;
    this.upHeldTicks = -1;
    this.#play('loco.jumpStart', 3, false);
    bus.emit('jump', { fighter: this });
  }

  #sidestep(sign) {
    this.#enter(STATE.SIDESTEP);
    this.stunTicks = SIDESTEP_TICKS;
    const dir = sign >= 0 ? 1 : -1;
    this.velocity.z = dir * SIDESTEP_SPEED * this.facing;
    this.#play(dir > 0 ? 'loco.sidestepLeft' : 'loco.sidestepRight', 3, false);
    bus.emit('dash', { fighter: this, dir: 0 });
  }

  #dash(dir) {
    if (dir > 0) {
      this.#enter(STATE.DASH);
      this.stunTicks = DASH_TICKS;
      this.velocity.x = this.facing * DASH_SPEED;
      this.#play('loco.dashFwd', 3, false);
    } else {
      this.#enter(STATE.BACKDASH);
      this.stunTicks = BACKDASH_TICKS;
      this.velocity.x = -this.facing * BACKDASH_SPEED;
      this.throwInvuln = 10;
      this.#play('loco.dashBack', 3, false);
    }
    bus.emit('dash', { fighter: this, dir });
  }

  /** A recognised motion should only fire once; blank the buffer that made it. */
  #consumeMotion(kind) {
    if (this.lastMotion === kind && this.simTick - this.lastMotionTick < 18) return false;
    this.lastMotion = kind;
    this.lastMotionTick = this.simTick;
    return true;
  }

  // --- attacks -------------------------------------------------------------

  /**
   * @param {boolean} allowCancel true while an attack is running — only string
   *   continuations inside the current move's cancel window may come out.
   */
  #tryMove(allowCancel) {
    if (!this.cmd) return null;
    const st = {
      buffer: this.inputBuffer,
      tick: this.simTick,
      meter: this.meter,
      airborne: this.airborne,
      crouching: this.crouching,
      stance: this.stance || null,
      currentMove: allowCancel ? this.currentMove : null,
      moveTick: this.moveTick,
      canCancel: allowCancel,
      allowRoot: !allowCancel,
    };
    const mv = findMove(this.moveTable || this.moveSetKey, this.#liveCommand(this.cmd), st);
    // Belt and braces on FINISHER_STANCE: a finisher is started by the finisher
    // system and by nothing else. If one somehow matched, hand the press back so
    // the next tick can spend it on a real move rather than swallowing it.
    if (mv && (mv.tag === 'finisher' || mv.props?.finisher)) {
      if (st.matchedInput) st.matchedInput.used = false;
      return null;
    }
    return mv;
  }

  /** Begin a move. Public so the CPU and the QA harness can drive fighters. */
  startMove(move) { if (move) this.#startMove(move); }

  /**
   * Scrub the current move forward, keeping the animation in lockstep with the
   * frame counter. Jumping `moveTick` on its own would build hitboxes from a
   * wind-up pose, which is exactly the kind of desync that makes a capture look
   * wrong; this keeps the two clocks together.
   * @param {number} ticks
   */
  fastForward(ticks) {
    const mv = this.currentMove;
    if (!mv) return;
    const n = Math.max(0, Math.min(Math.round(ticks), mv.total - this.moveTick - 1));
    if (n === 0) return;
    this.moveTick += n;
    if (this.animator) {
      for (let i = 0; i < n; i++) {
        this.animator.simulate();
        // Take the root motion the skipped frames would have produced, so the
        // fighter ends up where the animation actually put it.
        if (this.animator.consumeRootMotion) {
          const rm = this.animator.consumeRootMotion();
          this.#advanceRootYaw(rm.yaw, this.animator.rootYawDrive ?? 0);
          _v.set(rm.x * ROOT_MOTION_SCALE, 0, rm.z * ROOT_MOTION_SCALE).applyAxisAngle(UP, yawForFacing(this.facing));
          this.position.x += _v.x;
          this.position.z += _v.z;
        }
      }
      this.animator.applyTo(this.bones, 1);
    }
    this.prevPosition.copy(this.position);
    this.prevAnimYaw = this.animYaw;
    this.#writePose();
    this.#buildHurtboxes();
    this.#buildHitboxes();
  }

  #startMove(move) {
    if (move.meterCost > 0) {
      if (this.meter < move.meterCost) return;
      this.meter -= move.meterCost;
    }
    this.#enter(STATE.ATTACK);
    this.currentMove = move;
    this.moveTick = 0;
    this.moveInstance++;
    this.moveEndTick = null;
    this.postActive = false;
    this.connected.clear();
    this.hitConnectedThisMove = false;
    this.isBlocking = false;
    // Fresh sweep history: the bones this move strikes with, tracked from tick 0.
    this.moveBones = [...new Set(move.active.flatMap((w) => w.boxes.map((b) => b.bone)))];
    for (const n of this.moveBones) if (this.boneTrack[n]) this.boneTrack[n].valid = false;
    this.velocity.x *= 0.4;
    this.velocity.z *= 0.3;
    this.#play(move.clip, move.startup > 16 ? 4 : 2, false, 1, retimeFor(move));

    const fin = !!move.props.finisher;
    if (move.props.super || fin) {
      // `superStart` is the event `FightCamera`, `EffectsDirector` and
      // `AudioDirector` already listen on for a cinematic. A finisher raises the
      // same one rather than asking three other workstreams for a second path,
      // and layers its own longer, deeper slow-motion on top.
      bus.emit('superStart', { fighter: this, move });
      const cin = move.props.cinematic;
      if (cin || fin) {
        bus.emit('timeScale', {
          scale: fin ? Math.min(cin?.slow ?? 0.3, 0.3) : (cin?.slow ?? 0.4),
          ticks: fin ? Math.max(cin?.slowTicks ?? 26, 40) : (cin?.slowTicks ?? 24),
        });
        bus.emit('shake', { amount: fin ? 0.5 : 0.35, ticks: fin ? 26 : 18 });
      }
    }
  }

  #tickAttack(cmd) {
    const mv = this.currentMove;
    if (!mv) { this.#toNeutral(); return; }
    this.moveTick++;

    // Cancels and string continuations.
    const nxt = this.#tryMove(true);
    if (nxt && nxt !== mv) { this.#startMove(nxt); return; }

    // A move that leaves the ground.
    const air = mv.props.airborne;
    if (air && this.moveTick === air[0] && !this.airborne) {
      this.airborne = true;
      this.grounded = false;
      this.velocity.y = mv.props.hopVelocity ?? 4.6;
    }

    // The move is past its hitboxes: either the last window has expired, or the
    // blow landed and `beginRecovery` has already ended the move short of it.
    // Guarded by a flag rather than by `moveTick === last + 1`, because a
    // truncated move can step over that tick or terminate before reaching it,
    // and the whiff event has to fire exactly once either way.
    const last = mv.active[mv.active.length - 1].to;
    const endAt = this.moveEndTick ?? mv.total;
    if (!this.postActive && (this.moveTick > last || this.moveTick >= endAt)) {
      this.postActive = true;
      if (!this.hitConnectedThisMove) {
        if (mv.props.throw) this.#play('t.grabWhiff', 2, false);
        bus.emit('whiff', { fighter: this, move: mv });
      } else if (mv.props.finishClip) {
        // The follow-through. `specials.js` authored the overdrive as three
        // clips "so the combat system can hold the cinematic between them" and
        // nothing has ever played the other two; a staged strike is most of what
        // makes a finisher read as bigger than a normal.
        this.#play(mv.props.finishClip, 4, false);
      }
    }

    if (this.moveTick >= endAt) {
      this.currentMove = null;
      this.hitboxes.length = 0;
      this.#toNeutral();
    }
  }

  // --- finishers -----------------------------------------------------------

  /** The finisher's authored rule, or null if this machine has no finisher. */
  get finisherSpec() { return this.finisher.move ? this.finisher.spec : null; }

  /**
   * Everything a prompt needs, polled per frame by the HUD.
   * @returns {?{name:string, sequenceText:string, condition:string,
   *             index:number, total:number, ticksLeft:number, window:number}}
   */
  get finisherPrompt() {
    const fs = this.finisher;
    if (!fs.open || !fs.move) return null;
    return {
      name: fs.move.name,
      sequenceText: fs.spec?.sequenceText || fs.move.input,
      condition: fs.spec?.condition || '',
      index: fs.index,
      total: fs.steps.length,
      ticksLeft: fs.ticksLeft,
      window: fs.window,
    };
  }

  /** Has this fighter's one window for this round already been spent? */
  canOpenFinisher() {
    const fs = this.finisher;
    return !!fs.move && !fs.openedThisRound && !fs.fired;
  }

  /**
   * Open the window. Called by `CombatSystem`, which owns the condition — it is
   * the only object that can see both fighters and the round score.
   *
   * Once per round, deliberately. A window that re-opens every tick the health
   * condition holds is not a window, and the player could not miss it.
   * @returns {boolean} true if it opened
   */
  openFinisherWindow() {
    const fs = this.finisher;
    if (!this.canOpenFinisher()) return false;
    fs.open = true;
    fs.openedThisRound = true;
    fs.ticksLeft = fs.window;
    fs.index = 0;
    bus.emit('finisherWindow', {
      fighter: this, opponent: this.opponent, move: fs.move,
      ticks: fs.window, input: fs.move.input,
      sequenceText: fs.spec?.sequenceText || fs.move.input,
      condition: fs.spec?.condition || '',
    });
    return true;
  }

  /** Shut the window without firing. */
  #closeFinisher(reason) {
    const fs = this.finisher;
    if (!fs.open) return;
    fs.open = false;
    fs.ready = false;
    fs.index = 0;
    fs.ticksLeft = 0;
    bus.emit('finisherExpired', { fighter: this, move: fs.move, reason });
  }

  /**
   * Advance the sequence recogniser by one tick.
   *
   * Steps are the move's own `input`, comma-split — the same string the move
   * list prints — so the thing the player is taught and the thing the engine
   * accepts cannot drift apart. A direction-only token wants an EDGE, so
   * `b,b` really is two taps and not one hold; a token with buttons wants a
   * press. A press that advances nothing resets the sequence, which is what
   * stops mashing from finding it by accident.
   */
  #tickFinisher(cmd) {
    const fs = this.finisher;
    if (!fs.open) {
      this.#rememberDir(cmd);
      return;
    }

    if (--fs.ticksLeft <= 0) { this.#closeFinisher('expired'); this.#rememberDir(cmd); return; }
    const opp = this.opponent;
    if (!opp || opp.state === STATE.KO || this.state === STATE.KO) {
      this.#closeFinisher('moot');
      this.#rememberDir(cmd);
      return;
    }

    const step = fs.steps[fs.index];
    if (!step) { fs.ready = true; this.#rememberDir(cmd); return; }

    if (cmd) {
      const pressed = cmd.pressed && cmd.pressed.size ? cmd.pressed : null;
      let advanced = false;
      if (step.buttons.length || step.motion) {
        // A press step: every button of the token down this tick, with the
        // token's direction (and motion) satisfied.
        //
        // A BARE button token — `2`, the last step of every authored finisher —
        // does not care which way the stick is pointing. `dirMatches('')` means
        // "no direction held", which is the right reading for a move list entry
        // and the wrong one for the trigger at the end of a direction sequence:
        // `d,b,d,2` would have demanded the player let go of down between the
        // third tap and the button, which is not what "Down, Back, Down, RP"
        // says on the card. A token that names a direction still gets it.
        const dirOk = step.motion ? this.#dashMotion(cmd) === step.motion
          : (step.dir ? dirMatches(step.dir, cmd) : true);
        if (pressed && step.buttons.every((b) => pressed.has(b)) && dirOk) {
          advanced = true;
          // The press is spent on the finisher. Without this the last button of
          // the sequence ALSO starts whatever ordinary move it is bound to —
          // measured, `d+4` fired the low sweep and the finisher had to wait for
          // its recovery — and the sequence would read as two moves.
          this.#consumePress();
        }
      } else if (step.dir) {
        // A direction step: the tap edge, not the hold.
        if (dirMatches(step.dir, cmd) && !dirMatches(step.dir, this.prevDir)) advanced = true;
      }
      if (advanced) {
        fs.index++;
        bus.emit('finisherProgress', { fighter: this, move: fs.move, index: fs.index, total: fs.steps.length });
        // Armed, not launched: the actual start belongs to `#tickNeutral`, so a
        // finisher enters the move state machine on exactly the same tick
        // boundary every other move does and its frame data is not shifted.
        if (fs.index >= fs.steps.length) fs.ready = true;
      } else if (pressed) {
        // Committed to the wrong thing. Start over — the window keeps running.
        fs.index = 0;
      }
    }
    this.#rememberDir(cmd);
  }

  /** Mark this tick's buffered press as spent, so no ordinary move claims it. */
  #consumePress() {
    const buf = this.inputBuffer;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].tick !== this.simTick) break;
      buf[i].used = true;
    }
  }

  #rememberDir(cmd) {
    const p = this.prevDir;
    p.fwd = !!(cmd && cmd.fwd); p.back = !!(cmd && cmd.back);
    p.up = !!(cmd && cmd.up); p.down = !!(cmd && cmd.down);
  }

  /**
   * The sequence completed. Launch it if the fighter is actually able to act;
   * if it is not, the sequence stays complete and this is retried every tick
   * until the window runs out — a finisher entered a frame before recovery
   * should not be thrown away, and a finisher entered from inside a combo
   * should not teleport out of it.
   */
  #fireFinisher() {
    const fs = this.finisher;
    const move = fs.move;
    if (!move) { this.#closeFinisher('nomove'); return false; }
    if (this.airborne || !FINISHER_START_STATES.has(this.state)) return false;
    if (move.meterCost > 0 && this.meter < move.meterCost) return false;

    fs.open = false;
    fs.ready = false;
    fs.fired = true;
    fs.ticksLeft = 0;
    // `#startMove` raises the cinematic; this is the event the UI, camera and
    // audio can key off to say FINISHER rather than SUPER.
    bus.emit('finisherStart', { fighter: this, defender: this.opponent, move });
    this.#startMove(move);
    return true;
  }

  #applyMoveMotion() {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return;
    const travel = mv.props.travel;
    if (!travel) return;
    for (const t of travel) {
      if (this.moveTick >= t.from && this.moveTick <= t.to) {
        this.velocity.x = this.facing * (t.x || 0);
        if (t.z) this.velocity.z = t.z * this.facing;
      }
    }
  }

  // --- throws --------------------------------------------------------------

  /**
   * Lock this fighter and `victim` into a throw animation.
   * @param {Object} move   the throw move
   * @param {Fighter} victim
   * @param {?{breakWindow:[number,number], damageScale:number}} override
   *        situational tuning — a throw landed from behind is harder to break
   */
  beginThrow(move, victim, override = null) {
    const t = move.props.throw;
    this.#enter(STATE.THROW);
    this.currentMove = move;
    this.moveTick = 0;
    this.throwPartner = victim;
    this.throwData = {
      move, t, ticks: 0, duration: t.duration, broken: false,
      breakWindow: override?.breakWindow || t.breakWindow,
      damageScale: override?.damageScale ?? 1,
    };
    this.velocity.set(0, 0, 0);
    this.#play(t.clip, 3, false);
    victim.beThrown(move, this, override);
  }

  /** Victim side of a throw. */
  beThrown(move, attacker, override = null) {
    const t = move.props.throw;
    this.#enter(STATE.THROWN);
    this.currentMove = null;
    this.throwPartner = attacker;
    this.throwData = {
      move, t, ticks: 0, duration: t.duration, broken: false,
      breakWindow: override?.breakWindow || t.breakWindow,
      damageScale: override?.damageScale ?? 1,
    };
    this.velocity.set(0, 0, 0);
    this.stunTicks = t.duration;
    this.#play(t.victimClip || 't.beingGrabbed', 3, false);
    // Face the thrower; a back throw deliberately leaves the victim turned away.
    if (t.type !== 'back') this.facing = -attacker.facing;
  }

  #tickThrow() {
    const d = this.throwData;
    if (!d) { this.#toNeutral(); return; }
    d.ticks++;
    const v = this.throwPartner;
    // Drag the victim along until the release frame.
    if (v && !d.broken && d.ticks < d.duration * 0.62) {
      v.position.x = this.position.x + this.facing * (this.radius + v.radius) * 0.86;
      v.position.z = this.position.z;
      v.clampToArena();
      v.prevPosition.copy(v.position);
      v.velocity.set(0, 0, 0);
    }
    if (v && !d.broken && d.ticks === Math.round(d.duration * 0.62)) {
      this.#releaseThrow(v, d);
    }
    if (d.ticks >= d.duration) {
      this.throwData = null;
      this.throwPartner = null;
      this.currentMove = null;
      this.#toNeutral();
    }
  }

  #releaseThrow(victim, d) {
    const mv = d.move;
    const kb = mv.knockback || [4, 2, 0];
    const dir = d.t.type === 'back' ? -this.facing : this.facing;
    const point = victim.position.clone().setY(victim.position.y + 0.95);
    const dmg = victim.applyHit(mv, this, point, {
      damage: mv.damage * (d.damageScale ?? 1), hitStun: 0, counter: false, reaction: REACTION.KNOCKDOWN,
      knockback: [Math.abs(kb[0]), kb[1], kb[2]], knockbackDir: dir,
      throwRelease: true,
    });
    this.addMeter(dmg * METER_ON_DEAL);
    // `velocity` and `bone` are part of the documented 'hit' payload and every
    // consumer orients off them; this emit used to omit both, so a throw release
    // was the one hit in the game that sprayed along the separation axis and
    // moved nothing on the victim. `applyHit` has just written the exact velocity
    // it is being thrown at, which is the honest answer for a release.
    bus.emit('hit', {
      attacker: this, defender: victim, move: mv, point, normal: _v2.set(dir, 0.3, 0).normalize().clone(),
      velocity: victim.velocity.clone(), bone: this.facing === dir ? 'hand_R' : 'hand_L',
      damage: dmg, counter: false, region: 'torso', comboCount: 1,
    });
    bus.emit('hitstop', { ticks: 12 });
    bus.emit('shake', { amount: 0.5, ticks: 14 });
  }

  #tickThrown(cmd) {
    const d = this.throwData;
    if (!d) { this.#toNeutral(); return; }
    d.ticks++;
    // Break window: the correct buttons within the first few frames escape.
    if (!d.broken && d.ticks >= d.breakWindow[0] && d.ticks <= d.breakWindow[1] && cmd?.pressed?.size) {
      for (const b of d.t.breakButtons) {
        if (cmd.pressed.has(b)) { this.#breakThrow(); return; }
      }
    }
    if (--this.stunTicks <= 0) {
      this.throwData = null;
      this.throwPartner = null;
      this.#toKnockdown(38, 'r.knockdownBack');
    }
  }

  #breakThrow() {
    const a = this.throwPartner;
    const d = this.throwData;
    if (d) d.broken = true;
    const point = _v.copy(this.position).setY(this.position.y + 1.1).clone();
    this.throwData = null;
    this.throwPartner = null;
    this.stunTicks = 0;
    this.#enter(STATE.BLOCKSTUN);
    this.stunTicks = 16;
    this.velocity.x = -this.facing * 3.0;
    this.#play('t.throwBreak', 3, false);
    if (a) {
      a.throwData = null;
      a.throwPartner = null;
      a.currentMove = null;
      a.state = STATE.BLOCKSTUN;
      a.stateTicks = 0;
      a.stunTicks = 16;
      a.velocity.x = -a.facing * 3.0;
      a.playClip('t.throwBreak', 3, false);
      // The pair were locked together for the grab; part them cleanly so the
      // push-out does not have to resolve a perfect overlap.
      const sep = this.radius + a.radius;
      const dir = Math.sign(this.position.x - a.position.x) ||
        -Math.sign(a.position.x) || -a.facing;
      this.position.x = a.position.x + dir * sep;
      this.position.z = a.position.z;
      this.#clampPosition();
      this.prevPosition.copy(this.position);
    }
    // 'throwBreak' is the precise event; 'parry' fires too so the FX and audio
    // layers, which only know the canonical list, still get their flash.
    bus.emit('throwBreak', { attacker: a, defender: this, point });
    bus.emit('parry', { attacker: a, defender: this, point });
    bus.emit('hitstop', { ticks: 8 });
    bus.emit('shake', { amount: 0.22, ticks: 10 });
  }

  // --- damage --------------------------------------------------------------

  /**
   * Apply a landed hit. Called by CombatSystem, which owns scaling and events.
   * @param {Object} move
   * @param {Fighter} attacker
   * @param {THREE.Vector3} point
   * @param {Object} [info] { damage, hitStun, counter, reaction, knockback,
   *                          juggleHeight, launch, wallSplat, groundBounce }
   * @returns {number} damage actually applied
   */
  applyHit(move, attacker, point, info = {}) {
    const raw = info.damage ?? move.damage;
    const dmg = Math.max(1, raw * this.#defenseScale());
    this.health = Math.max(0, this.health - dmg);
    // A finisher finishes. Its window only opens on an opponent already under
    // the authored health threshold, so this is not a damage number the balance
    // pass has to carry — it is the definition of the move. Going through the
    // ordinary `#toKO` below is what keeps rounds, scoring, the KO banner, the
    // victory screen and the rematch path working unchanged.
    if (move.props?.finisher) this.health = 0;
    this.recoverable = Math.min(this.recoverable + dmg * RECOVERABLE_RATIO, MAX_HEALTH - this.health);
    this.lastDamageTick = this.simTick;
    this.impactTick = this.simTick;
    this.addMeter(dmg * METER_ON_TAKE);
    this.#checkDamageThresholds(point);

    if (this.health <= 0) { this.#toKO(move, attacker); return dmg; }

    const reaction = info.reaction || move.reaction;
    const kb = info.knockback || move.knockback || [2, 0, 0];
    const dirX = info.knockbackDir ?? attacker.facing;
    const weightScale = 10 / (5 + (this.stats.weight ?? 5));

    this.currentMove = null;
    this.hitboxes.length = 0;
    this.isBlocking = false;
    this.throwData = null;
    this.throwPartner = null;

    const launching = info.launch || reaction === REACTION.LAUNCH;
    const wasAirborne = this.airborne;
    if (launching || wasAirborne) {
      const h = (info.juggleHeight ?? move.juggleHeight ?? 4.2) * (info.juggleScale ?? 1) * weightScale * LAUNCH_SCALE;
      // A fresh launch sets the arc; an airborne hit only tops it up, which is
      // what keeps juggles from floating forever.
      if (!wasAirborne) this.velocity.y = h;
      else this.velocity.y = Math.max(this.velocity.y, -1.5) + h * 0.5;
      this.airborne = true;
      this.grounded = false;
      this.velocity.x = dirX * kb[0] * 0.55 * weightScale;
      this.velocity.z *= 0.4;
      this.juggleCount++;
      this.bounceRemaining = info.groundBounce ? 1 : (move.props.groundBounce ? 1 : 0);
      this.bounceFactor = info.groundBounce || move.props.groundBounce || 0;
      this.#enter(launching && !wasAirborne ? STATE.LAUNCHED : STATE.JUGGLED);
      this.stunTicks = 0;
      this.#play(launching && !wasAirborne ? 'r.launch' : (reaction === REACTION.SPIN ? 'r.spinFall' : 'r.airFlail'), 3, false);
      if (launching && !wasAirborne) bus.emit('launch', { fighter: this, velocity: this.velocity.clone() });
      return dmg;
    }

    if (info.throwRelease) {
      this.airborne = true;
      this.grounded = false;
      this.velocity.set(dirX * Math.abs(kb[0]) * weightScale, Math.abs(kb[1]) * weightScale + 2.4, 0);
      this.bounceRemaining = 0;
      this.#enter(STATE.JUGGLED);
      this.#play('r.spinFall', 3, false);
      return dmg;
    }

    this.velocity.x = dirX * kb[0] * 0.5 * weightScale;
    if (kb[1] > 0.01) { this.velocity.y = kb[1] * weightScale; this.airborne = true; this.grounded = false; }

    switch (reaction) {
      case REACTION.KNOCKDOWN:
        this.#toKnockdown(40, 'r.knockdownBack');
        bus.emit('knockdown', { fighter: this, point: point.clone() });
        break;
      case REACTION.SWEEP:
        this.#toKnockdown(36, 'r.sweepFall');
        bus.emit('knockdown', { fighter: this, point: point.clone() });
        break;
      case REACTION.SPIN:
        this.#toKnockdown(44, 'r.spinFall');
        bus.emit('knockdown', { fighter: this, point: point.clone() });
        break;
      case REACTION.CRUMPLE:
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        this.velocity.x *= 0.3;
        this.#play('r.crumple', 3, false);
        break;
      case REACTION.STAGGER:
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        this.#play('r.stagger', 3, false);
        break;
      case REACTION.WALL_SPLAT:
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        this.#play('r.wallSplat', 2, false);
        break;
      default: {
        this.#enter(STATE.HITSTUN);
        this.stunTicks = info.hitStun ?? move.hitStun;
        this.reaction = reaction;
        const clip = reaction === REACTION.FLINCH_LOW ? 'r.flinchLow'
          : reaction === REACTION.FLINCH_HIGH ? 'r.flinchHigh' : 'r.flinchMid';
        this.#play(clip, 3, false);
      }
    }
    return dmg;
  }

  /**
   * Apply a blocked hit: chip damage, blockstun, pushback.
   * @returns {number} chip damage applied
   */
  applyBlock(move, attacker, point, info = {}) {
    const chip = (info.damage ?? move.damage) * CHIP_DAMAGE_RATIO * this.#defenseScale();
    this.health = Math.max(1, this.health - chip);
    this.recoverable = Math.min(this.recoverable + chip, MAX_HEALTH - this.health);
    this.addMeter((info.damage ?? move.damage) * METER_ON_BLOCK);
    const push = move.blockPush || [2, 0, 0];
    this.velocity.x = attacker.facing * push[0] * 0.6;
    this.currentMove = null;
    this.hitboxes.length = 0;
    this.#enter(STATE.BLOCKSTUN);
    this.stunTicks = info.blockStun ?? move.blockStun;
    this.impactTick = this.simTick;
    this.#play('r.blockImpact', 2, false);
    return chip;
  }

  /** Armour: eat the hit, keep going, pay reduced damage. */
  absorbArmor(move, attacker, point) {
    const scale = this.currentMove?.props?.armorScale ?? 0.5;
    const dmg = (move.damage * scale) * this.#defenseScale();
    this.health = Math.max(1, this.health - dmg);
    this.recoverable = Math.min(this.recoverable + dmg * RECOVERABLE_RATIO, MAX_HEALTH - this.health);
    this.addMeter(dmg * METER_ON_TAKE * 1.4);
    this.lastDamageTick = this.simTick;
    bus.emit('armorAbsorb', { fighter: this, move, point: point.clone() });
    return dmg;
  }

  /** Successful parry: skip straight to the riposte frames of the stance move. */
  parrySuccess(move, attacker, point) {
    const mv = this.currentMove;
    if (!mv) return;
    const riposte = mv.props.parryRiposte ?? mv.startup;
    this.moveTick = Math.max(0, riposte - 1);
    this.connected.clear();
    this.addMeter(14);
    this.#play(mv.props.parryClip || 'sp.parrySuccess', 2, false);
    bus.emit('parry', { attacker, defender: this, point: point.clone() });
  }

  /** Can this fighter parry an incoming attack of `move`'s height right now? */
  canParryMove(move) {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return false;
    const p = mv.props;
    if (p.parryFrom == null) return false;
    if (this.moveTick < p.parryFrom || this.moveTick > p.parryTo) return false;
    if (move.height === HEIGHT.UNBLOCKABLE) return false;
    const heights = p.parryHeights || ['high', 'mid'];
    return heights.includes(move.height);
  }

  /** Is armour live this tick? */
  armorActive() {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return false;
    const p = mv.props;
    return p.armorFrom != null && this.moveTick >= p.armorFrom && this.moveTick <= p.armorTo;
  }

  #defenseScale() {
    const d = this.stats.defense ?? 5;
    return THREE.MathUtils.clamp(1 - (d - 5) * 0.028, 0.7, 1.35);
  }

  #toKnockdown(ticks, clip) {
    this.#enter(STATE.KNOCKDOWN);
    this.stunTicks = ticks;
    this.juggleCount = 0;
    this.#play(clip, 3, false);
  }

  #toKO(move, attacker) {
    const fin = !!move?.props?.finisher;
    this.#enter(STATE.KO);
    this.currentMove = null;
    this.hitboxes.length = 0;
    this.airborne = true;
    this.grounded = false;
    // A finisher does not send the body across the arena; it puts it down. The
    // slump reads at the framing the KO camera holds, and `r.koSlump` was
    // authored and never played.
    this.velocity.set(attacker.facing * (fin ? 2.2 : 4.6), fin ? 3.2 : 5.2, 0);
    this.stunTicks = 0;
    this.#play(fin ? 'r.koSlump' : 'r.koFall', 2, false);
    this.koTick = this.simTick;
    if (fin) {
      bus.emit('finisherKO', { fighter: this, attacker, move });
      bus.emit('timeScale', { scale: 0.18, ticks: 110 });
      bus.emit('shake', { amount: 0.9, ticks: 30 });
    }
  }

  #toNeutral() {
    this.stunTicks = 0;
    this.reaction = null;
    this.juggleCount = 0;
    this.bounceRemaining = 0;
    if (this.airborne) { this.#enter(STATE.JUMP_FALL); return; }
    this.#enter(this.crouching ? STATE.CROUCH : STATE.IDLE);
  }

  #enter(s) {
    if (this.state !== s) { this.state = s; this.stateTicks = 0; }
  }

  // --- meter / regen -------------------------------------------------------

  addMeter(n) {
    const before = this.meter;
    this.meter = Math.min(METER_MAX, this.meter + n);
    if (before < METER_MAX && this.meter >= METER_MAX) bus.emit('meterFull', { fighter: this });
  }

  spendMeter(n) {
    if (this.meter < n) return false;
    this.meter -= n;
    return true;
  }

  #regen() {
    if (this.recoverable <= 0) return;
    if (this.simTick - this.lastDamageTick < 60) return;
    if (this.state === STATE.HITSTUN || this.state === STATE.LAUNCHED ||
        this.state === STATE.JUGGLED || this.state === STATE.KNOCKDOWN) return;
    const step = Math.min(RECOVERY_PER_TICK, this.recoverable);
    this.recoverable -= step;
    this.health = Math.min(MAX_HEALTH, this.health + step);
  }

  #checkDamageThresholds(point) {
    const r = this.health / MAX_HEALTH;
    const levels = [
      { at: 0.62, level: 1, part: 'shoulderPlate' },
      { at: 0.34, level: 2, part: 'chestVent' },
      { at: 0.14, level: 3, part: 'headCowl' },
    ];
    for (const l of levels) {
      if (r <= l.at && !this.brokenParts.has(l.part)) {
        this.brokenParts.add(l.part);
        this.damageLevel = l.level;
        bus.emit('partBreak', { fighter: this, part: l.part, point: point.clone() });
      }
    }
  }

  // --- physics -------------------------------------------------------------

  #integrate() {
    const dt = TICK_DT;
    const juggling = this.state === STATE.LAUNCHED || this.state === STATE.JUGGLED;
    this.gravityScale = juggling ? JUGGLE_GRAVITY : 1;
    if (this.airborne) {
      this.velocity.y += GRAVITY * dt * this.gravityScale;
      this.velocity.x *= AIR_DRAG;
      this.velocity.z *= AIR_DRAG;
    } else {
      const stunned = this.state === STATE.HITSTUN || this.state === STATE.BLOCKSTUN ||
        this.state === STATE.KNOCKDOWN || this.state === STATE.WAKEUP;
      const f = stunned ? SLIDE_FRICTION : GROUND_FRICTION;
      this.velocity.x *= f;
      this.velocity.z *= f;
      if (Math.abs(this.velocity.x) < 0.02) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 0.02) this.velocity.z = 0;
      this.velocity.y = 0;
    }

    this.position.addScaledVector(this.velocity, dt);

    if (this.position.y <= this.floorY) {
      const impactSpeed = -this.velocity.y;
      this.position.y = this.floorY;
      if (this.airborne) this.#land(impactSpeed);
      this.airborne = false;
      this.grounded = true;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.airborne = true;
      this.grounded = false;
    }
  }

  #land(speed) {
    const juggled = this.state === STATE.LAUNCHED || this.state === STATE.JUGGLED;
    bus.emit('groundImpact', { fighter: this, point: this.position.clone(), speed: Math.max(0, speed) });

    if (juggled && this.bounceRemaining > 0 && speed > 3.0) {
      this.bounceRemaining--;
      this.velocity.y = speed * THREE.MathUtils.clamp(this.bounceFactor, 0.25, 0.9);
      this.velocity.x *= 0.6;
      this.position.y = this.floorY + 0.01;
      this.airborne = true;
      this.grounded = false;
      this.#play('r.groundBounce', 2, false);
      return;
    }
    if (this.state === STATE.KO) {
      this.#play('r.koSlump', 4, false);
      this.velocity.x *= 0.3;
      return;
    }
    if (juggled) {
      this.#toKnockdown(44, speed > 7 ? 'r.knockdownFace' : 'r.knockdownBack');
      bus.emit('knockdown', { fighter: this, point: this.position.clone() });
      return;
    }
    if (this.state === STATE.JUMP_RISE || this.state === STATE.JUMP_APEX || this.state === STATE.JUMP_FALL) {
      this.#enter(STATE.IDLE);
      this.#play('loco.jumpLand', 2, false);
      this.velocity.x *= 0.35;
    }
  }

  /** Capsule push-out against the opponent; each side moves half the overlap. */
  #pushApart() {
    const o = this.opponent;
    if (!o || o.state === STATE.KO) return;
    if (this.state === STATE.THROW || this.state === STATE.THROWN) return;
    if (o.state === STATE.THROW || o.state === STATE.THROWN) return;
    let dx = this.position.x - o.position.x;
    let dz = this.position.z - o.position.z;
    const minD = this.radius + o.radius;
    let d2 = dx * dx + dz * dz;
    if (d2 >= minD * minD) return;
    if (d2 < 1e-6) { dx = -this.facing * 0.01; dz = 0; d2 = dx * dx; }
    const d = Math.sqrt(d2);
    const push = (minD - d) * 0.5;
    this.position.x += (dx / d) * push;
    this.position.z += (dz / d) * push;
  }

  /**
   * Pull the pair back toward a shared fight axis.
   *
   * `facing` is `Math.sign(opponent.x - this.x)` — a SIGN ALONG X, not a yaw.
   * Nothing in the rig can point a fighter at an opponent who is displaced in Z.
   * Sidestep, meanwhile, moves purely in Z and nothing ever undid it, so the
   * depth separation was bounded only by the arena wall.
   *
   * A player reported the end state: sidestep a few times in training against a
   * standing opponent and the two robots end up stacked along the camera axis,
   * one hidden behind the other, with every attack whiffing. Both halves follow
   * from the same cause. The strike capsules lead forward along ±X, so an
   * opponent parked off-axis is simply not in front of anything; and once the X
   * gap closes, `Math.sign` returns 0 and `facing` latches at its last value, so
   * the fighters stop even nominally facing each other. The camera framing
   * solver has nothing to frame either, which is why it looked like the camera
   * was stuck.
   *
   * Real fighting games let you leave the axis and then bring you back — the
   * sidestep is a brief evasion, not a new place to stand. This does the same:
   * while neither fighter is mid-sidestep and both are grounded, ease the depth
   * gap shut, and hard-cap it so it can never exceed a body's width even mid-
   * evade. Deliberately soft, so a sidestep still dodges; the cap is what makes
   * the broken state unreachable.
   */
  #realignAxis() {
    const o = this.opponent;
    if (!o || o.state === STATE.KO || this.state === STATE.KO) return;
    if (this.state === STATE.THROW || this.state === STATE.THROWN) return;
    if (o.state === STATE.THROW || o.state === STATE.THROWN) return;

    const dz = this.position.z - o.position.z;
    const evading = this.state === STATE.SIDESTEP || o.state === STATE.SIDESTEP;

    // Hard cap first: this is what makes "standing behind each other" impossible.
    if (Math.abs(dz) > AXIS_MAX_GAP) {
      const over = Math.abs(dz) - AXIS_MAX_GAP;
      this.position.z -= Math.sign(dz) * over * 0.5;
      o.position.z += Math.sign(dz) * over * 0.5;
      return;
    }
    // Then the ease, but never while the evade is still running or it would
    // cancel the very dodge the player asked for.
    if (evading || !this.grounded || !o.grounded) return;
    if (Math.abs(dz) < 0.004) { this.position.z -= dz * 0.5; o.position.z += dz * 0.5; return; }
    const step = dz * AXIS_REALIGN_RATE * 0.5;
    this.position.z -= step;
    o.position.z += step;
  }

  /** Walls and floor. Records the wall impact so CombatSystem can splat. */
  #clampToArena() {
    const limX = this.bounds.halfWidth - this.radius;
    const limZ = this.bounds.halfDepth - this.radius;
    if (this.position.x > limX) {
      if (this.velocity.x > 0) this.wallImpact = { speed: this.velocity.x, normal: -1, axis: 'x' };
      this.position.x = limX;
      this.velocity.x = Math.min(this.velocity.x, 0);
    } else if (this.position.x < -limX) {
      if (this.velocity.x < 0) this.wallImpact = { speed: -this.velocity.x, normal: 1, axis: 'x' };
      this.position.x = -limX;
      this.velocity.x = Math.max(this.velocity.x, 0);
    }
    if (this.position.z > limZ) { this.position.z = limZ; this.velocity.z = Math.min(this.velocity.z, 0); }
    else if (this.position.z < -limZ) { this.position.z = -limZ; this.velocity.z = Math.max(this.velocity.z, 0); }
  }

  /** Keep a directly-assigned position (throw drag, throw break) inside the arena. */
  clampToArena() { this.#clampPosition(); }

  #clampPosition() {
    const limX = this.bounds.halfWidth - this.radius;
    const limZ = this.bounds.halfDepth - this.radius;
    this.position.x = THREE.MathUtils.clamp(this.position.x, -limX, limX);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -limZ, limZ);
    this.position.y = Math.max(this.position.y, this.floorY);
  }

  #updateFlags() {
    if (this.throwInvuln > 0) this.throwInvuln--;
    const mv = this.currentMove;
    this.invulnerable = !!(mv && this.state === STATE.ATTACK && isInvulnerable(mv, this.moveTick));
  }

  // -------------------------------------------------------------------------
  // Pose, hurtboxes, hitboxes
  // -------------------------------------------------------------------------

  /**
   * Advance the animation one tick and fold its root motion into the physical
   * position. The Animator extracts horizontal root translation rather than
   * baking it into the bones (see its header) precisely so the body follows the
   * animation instead of sliding under it — a lunging jab has to actually close
   * the distance it appears to close, or the hitbox arrives somewhere the
   * fighter is not.
   */
  #advanceAnimation() {
    if (!this.animator) return;
    this.animator.simulate(this.simTick);
    if (!this.animator.consumeRootMotion) return;
    const rm = this.animator.consumeRootMotion();
    // Paired and dead states place the body by hand; the clip does not get a
    // vote, so its root motion is dropped and any leftover spin unwinds.
    const paired = this.state === STATE.THROW || this.state === STATE.THROWN || this.state === STATE.KO;
    this.#advanceRootYaw(paired ? 0 : rm.yaw, paired ? 0 : this.animator.rootYawDrive ?? 0);
    if (paired || (!rm.x && !rm.z)) return;
    // Authored translation is in the clip's own frame, which the spin does not
    // rotate — the yaw turns the body about its axis, not its line of travel.
    _v.set(rm.x * ROOT_MOTION_SCALE, 0, rm.z * ROOT_MOTION_SCALE)
      .applyAxisAngle(UP, yawForFacing(this.facing));
    this.position.x += _v.x;
    this.position.z += _v.z;
  }

  /**
   * Fold this tick's authored root yaw into the offset the body is rendered and
   * struck with.
   *
   * The offset follows the clip exactly while the clip is driving it, wraps at a
   * full turn so a 360 spin costs nothing, and bleeds back to neutral as the
   * drive fades — so a move that ends 180 degrees round pivots back to face the
   * opponent over its recovery instead of leaving the fighter back-turned.
   *
   * On top of the authored turn it folds in the strike-aiming bias (see
   * `strikeAim`), as a DELTA against however much of it is already folded in, so
   * the two live in one angle and everything downstream — the pose, the
   * hitboxes, the hit-reaction direction, the render interpolation — sees a
   * single consistent body yaw rather than a correction bolted on at one of them.
   * @param {number} dYaw  radians of authored yaw this tick
   * @param {number} drive 0..1 share of the animation still authoring yaw
   */
  #advanceRootYaw(dYaw, drive) {
    const aim = this.#aimBias();
    // The release is the AUTHORED turn bleeding back to neutral, so the aim bias
    // is lifted out before it runs and put back after. Leaving it in makes the
    // two fight: on a clip with no authored root track `drive` is 0, the release
    // takes 22 % of the whole angle every tick, and a 55-degree correction can
    // only ever reach the 15 degrees where the two balance.
    let yaw = this.animYaw - this.aimYaw + dYaw;
    if (drive < 1) yaw -= yaw * ANIM_YAW_RELEASE * (1 - drive);
    yaw += aim;
    this.aimYaw = aim;
    if (yaw > Math.PI || yaw <= -Math.PI) yaw = wrapPi(yaw);
    this.animYaw = Math.abs(yaw) < 1e-4 ? 0 : yaw;
  }

  /**
   * How much of this move's aim correction should be applied on this tick.
   *
   * Ramped in across the startup so the turn reads as the fighter squaring up to
   * throw the blow rather than as a snap, held flat across the active window so
   * every frame of the strike is aimed the same, and released across the
   * recovery so the move finishes on the pose the animation authored.
   * @returns {number} radians
   */
  #aimBias() {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK || !mv.active?.length) return 0;
    const bias = strikeAim(mv);
    if (!bias) return 0;
    const t = this.moveTick;
    if (t <= 0) return 0;
    const first = mv.active[0].from;
    if (t < first) return bias * (t / Math.max(1, first));
    const last = mv.active[mv.active.length - 1].to;
    if (t <= last) return bias;
    const out = Math.max(1, (mv.total ?? last) - last);
    return t - last >= out ? 0 : bias * (1 - (t - last) / out);
  }

  /** Write the simulated transform and the canonical pose onto the scene graph. */
  #writePose() {
    this.group.position.copy(this.position);
    this.group.rotation.y = yawForFacing(this.facing) + this.animYaw;
    if (this.animator) this.animator.applyTo(this.bones, 1);
    this.group.updateMatrixWorld(true);
  }

  /** Pose without advancing time — used on reset and during the intro. */
  #drivePose() {
    if (this.animator) {
      this.animator.simulate(this.simTick);
      this.animator.clearRootMotion?.();
    }
    this.#writePose();
  }

  #buildHurtboxes() {
    for (let i = 0; i < this.hurtDefs.length; i++) {
      const d = this.hurtDefs[i];
      const bone = this.boneByName[d.name];
      const hb = this.hurtboxes[i];
      if (!bone) continue;
      hb.p0.setFromMatrixPosition(bone.matrixWorld);
      if (d.length > 0) hb.p1.set(0, -d.length, 0).applyMatrix4(bone.matrixWorld);
      else hb.p1.copy(hb.p0);
      hb.radius = d.radius;
    }
  }

  /**
   * Record where every bone this move strikes with was last tick. A fist can
   * travel 30cm in a single frame — more than its own radius — so without a
   * swept test it will tunnel clean through a defender and whiff a punch that
   * visibly connected. Tracking runs on every tick of the move, not just the
   * active ones, so the *first* active frame sweeps correctly too.
   */
  #trackMoveBones() {
    if (!this.moveBones) return;
    for (const name of this.moveBones) {
      const bone = this.boneByName[name];
      if (!bone) continue;
      let rec = this.boneTrack[name];
      if (!rec) rec = this.boneTrack[name] = { prev: new THREE.Vector3(), cur: new THREE.Vector3(), valid: false };
      rec.prev.copy(rec.cur);
      rec.cur.setFromMatrixPosition(bone.matrixWorld);
      if (!rec.valid) { rec.prev.copy(rec.cur); rec.valid = true; }
    }
  }

  #buildHitboxes() {
    this.hitboxes.length = 0;
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return;
    this.#trackMoveBones();
    if (!isActive(mv, this.moveTick)) return;
    const boxes = activeBoxes(mv, this.moveTick);
    if (!boxes) return;
    const windowIndex = mv.active.findIndex((w) => this.moveTick >= w.from && this.moveTick <= w.to);
    const bonus = mv.props.homing ? 0.09 : 0;
    const lead = this.facing;

    for (let i = 0; i < boxes.length && i < this.hitboxPool.length; i++) {
      const b = boxes[i];
      const bone = this.boneByName[b.bone];
      if (!bone) continue;
      const hb = this.hitboxPool[i];

      // Anchor and far tip in world space.
      _v.set(b.offset[0], b.offset[1], b.offset[2]).applyMatrix4(bone.matrixWorld);
      if (b.length > 0) _v2.set(b.offset[0], b.offset[1] - b.length, b.offset[2]).applyMatrix4(bone.matrixWorld);
      else _v2.copy(_v);
      // The authored forward lead is in fighter space, not bone space, so a
      // strike reaches where the player expects regardless of limb orientation.
      if (b.fwd) { _v.x += lead * b.fwd; _v2.x += lead * b.fwd; }
      hb.tip.copy(_v2);

      // Sweep the capsule back to where the anchor was last tick.
      const rec = this.boneTrack[b.bone];
      if (rec && rec.valid) _v3.copy(_v).sub(rec.cur).add(rec.prev);
      else _v3.copy(_v);
      hb.p0.copy(_v3);
      hb.p1.copy(_v2);

      hb.radius = b.radius + bonus;
      hb.bone = b.bone;
      hb.windowIndex = windowIndex;
      hb.move = mv;
      this.hitboxes.push(hb);
    }
  }

  /** True once per move-instance/window pair, so multi-hits count once each. */
  registerConnect(windowIndex) {
    const key = `${this.moveInstance}:${windowIndex}`;
    if (this.connected.has(key)) return false;
    const first = !this.hitConnectedThisMove;
    this.connected.add(key);
    this.hitConnectedThisMove = true;
    // Stage two of a declared multi-clip strike. See `props.finishClip` above.
    const hitClip = first ? this.currentMove?.props?.hitClip : null;
    if (hitClip) this.#play(hitClip, 2, false);
    return true;
  }

  /**
   * The blow landed. From here the attacker owes exactly its printed recovery.
   *
   * WHY THIS EXISTS AT ALL
   *
   * `MoveSchema.defineMove` derives the frame data every move list, every
   * tooltip and every balance argument in this project is written against:
   *
   *     recovery = total - lastActive - 1
   *     onBlock  = blockStun - recovery
   *
   * — recovery measured from the END of the active window. The engine used to
   * measure it from wherever the capsules happened to overlap, which is
   * `contactTick`, and `contactTick <= lastActive` always. So the advantage the
   * simulation actually produced was `blockStun - (total - contactTick)`: short
   * of the printed number by `lastActive + 1 - contactTick`, which is >= 1
   * identically. Every blockable move in the game was less safe than its own
   * data — by its own active span at point blank — and `jab` printed +1 and
   * played -1. It was measured across all ten sets: 352 blockable moves, 1306
   * block rows at four ranges, and not ONE of them reached its printed number at
   * any range. tools/advgate.mjs is that measurement, and its `--control=
   * no-truncate` is this engine as it was.
   *
   * The owner's decision was that the printed number is the promise. So the
   * attacker's remaining move life is set to `recovery` from the connection, and
   * the identity holds by construction rather than by tuning: a move's advantage
   * is now a property of the MOVE and not of the tick a capsule happened to
   * touch, which is what frame data has always meant everywhere else.
   *
   * WHY NOT THE OBVIOUS IMPLEMENTATION
   *
   * The natural way to write this is "a connection consumes the rest of the
   * active window" — jump `moveTick` to `lastActive + 1` on contact. It makes
   * the same identity true, and it DELETES the later windows of every
   * multi-window move: `pistonRush` would land its first piston and lose the
   * other two, `overdrive` likewise. Hence the floor. The end tick is never set
   * earlier than the last tick of any window that has not yet connected, so a
   * multi-hit string keeps every hitbox it has coming, and the identity holds on
   * the connection that matters — the LAST one, the one whose blockstun the
   * defender is actually sitting in. The end tick can never be later than
   * `total - 1` either (`moveTick <= lastActive`, so `moveTick + recovery <=
   * total - 1`), so this only ever shortens a move; nothing gets a longer
   * recovery than it had.
   *
   * WHY IT IS CALLED FROM `#doHit`/`#doBlock`/`#doArmor` AND NOT FROM
   * `registerConnect`
   *
   * `registerConnect` is one call site instead of three and it is the WRONG one.
   * `CombatSystem#resolve` registers the window as consumed BEFORE it asks
   * `#guardResult`, so a HIGH that passes through a ducking defender registers a
   * connection and then resolves as a whiff. Cutting recovery there would make
   * ducking a high shorten the attacker's recovery — the punish for reading a
   * high correctly would silently shrink by the move's active span, and nothing
   * would have said so. A blow that hit nobody ends nothing. advgate AD-5 is
   * that rule, and it is why the call sits in the three places where the blow
   * demonstrably landed on somebody.
   */
  beginRecovery() {
    const mv = this.currentMove;
    if (!mv || this.state !== STATE.ATTACK) return;
    // The last tick of every window that has NOT yet connected. Windows already
    // spent are skipped: `#findConnection` will not use them again, so keeping
    // them alive would buy nothing and cost the identity on single-window moves.
    let floor = 0;
    for (let i = 0; i < mv.active.length; i++) {
      if (this.connected.has(`${this.moveInstance}:${i}`)) continue;
      const end = mv.active[i].to + 1;
      if (end > floor) floor = end;
    }
    this.moveEndTick = Math.max(this.moveTick + mv.recovery, floor);
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  /**
   * Foot contact.
   *
   * What this used to do was nothing at all, and it is worth being precise about
   * why, because the reason generalises. It compared the ANKLE bone's height
   * against `floorY + 0.055` — but on this chassis the boot's sole hangs 26cm
   * below the ankle joint and the ankle stands at 26cm in the fight stance, so
   * the test could only ever have fired with the leg driven a quarter of a metre
   * into the concrete. Written against the foot bone, `#trackFootfalls` had the
   * same fault and never emitted a single footstep. A threshold is only as good
   * as the thing it measures, so the sole is now measured off the built robot
   * (`#measureSole`) instead of assumed from the skeleton.
   *
   * Contact is decided on `#soleIntentHeight` — the height the CLIPS asked for,
   * sampled before IK — and never on the posed result. A planter that reads its
   * own output latches shut: holding a foot down keeps it in contact, which keeps
   * it held, and the swing phase never arrives. Measured on a walk cycle that is
   * exactly what happened; one foot's lift went to zero.
   *
   * `weight` is the contact ramp, published for the roll layer below and for the
   * footfall tracker. Correction itself is deliberately minimal — see the note in
   * the body about what a partially-weighted two-bone solve does to a leg that
   * was already right.
   */
  /**
   * Learn where each boot's sole actually is, once, off the built robot.
   *
   * Nothing in the skeleton says how thick a boot is, and on this chassis it is
   * thick: the sole sits 16cm below the toe bone. So the reference stance is
   * posed, the lowest point of the whole robot is taken as the floor it is
   * standing on, and the point directly under each foot bone at that height is
   * recorded in that bone's OWN frame. Storing it bone-local rather than as a
   * scalar drop is what makes it survive a rotation: as the foot pitches over on
   * to its toe, the recorded sole point pitches with it and still reports where
   * the boot is, which a fixed offset could not.
   */
  #measureSole() {
    this.group.updateMatrixWorld(true);
    let floor = Infinity;
    this.group.traverse((o) => {
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      if (!bb) return;
      for (let i = 0; i < 8; i++) {
        _v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z)
          .applyMatrix4(o.matrixWorld);
        if (_v.y < floor) floor = _v.y;
      }
    });
    for (const side of ['L', 'R']) {
      const st = this.plantState[side];
      st.sole.length = 0;
      if (!Number.isFinite(floor)) continue;
      for (const name of [`ankle_${side}`, `foot_${side}`, `toe_${side}`]) {
        const bone = this.boneByName[name];
        if (!bone) continue;
        _v.setFromMatrixPosition(bone.matrixWorld);
        const drop = _v.y - floor;
        // A bone whose "sole" is above it, or absurdly far below, is not part of
        // the boot; ignore it rather than plant the fighter on a bad number.
        if (!(drop > 0.01 && drop < 0.45)) continue;
        _v.y = floor;
        _m.copy(bone.matrixWorld).invert();
        st.sole.push({ bone, local: _v.clone().applyMatrix4(_m) });
      }
    }
  }

  /** World height of the lowest point of one boot as it is actually posed. */
  #soleHeight(side) {
    const pts = this.plantState[side].sole;
    let y = Infinity;
    for (const s of pts) {
      _v4.copy(s.local).applyMatrix4(s.bone.matrixWorld);
      if (_v4.y < y) y = _v4.y;
    }
    return Number.isFinite(y) ? y : this.floorY;
  }

  /**
   * World height of the lowest point of one boot under the pose the animator is
   * building RIGHT NOW, read from its own forward kinematics rather than from
   * the bone matrices. Inside a procedural layer the matrices still hold last
   * tick's pose, so this is the only reading that is not a frame behind.
   * @param {Object} ctx the animator's procedural-layer context
   * @param {'L'|'R'} side
   * @returns {number} world Y, or Infinity when the boot has not been measured
   */
  #soleNow(ctx, side) {
    let low = Infinity;
    for (const s of this.plantState[side].sole) {
      const wp = ctx.worldPos(s.bone.name);
      const wq = ctx.worldQuat(s.bone.name);
      if (!wp || !wq) continue;
      const y = _v3.copy(s.local).applyQuaternion(wq).add(wp).y + this.position.y;
      if (y < low) low = y;
    }
    return low;
  }

  /**
   * The same height as the CLIPS wanted it, before the planter's own correction.
   * Contact has to be decided on this and not on the posed result, or the plant
   * latches itself shut: holding a foot on the floor keeps it in contact, which
   * keeps it held, and the swing phase of a walk never comes.
   */
  #soleIntentHeight(side) {
    const pts = this.plantState[side].sole;
    if (!this.animator?.preIkPointY) return this.#soleHeight(side);
    let y = Infinity;
    for (const s of pts) {
      const v = this.animator.preIkPointY(s.bone.name, s.local);
      if (v !== null && v < y) y = v;
    }
    return Number.isFinite(y) ? y + this.position.y : this.floorY;
  }

  #footIk() {
    if (!this.animator?.setIkTarget) return;
    const A = this.animator;
    const grounded = !this.airborne && PLANT_STATES.has(this.state);
    for (const side of ['L', 'R']) {
      const chain = side === 'L' ? 'legL' : 'legR';
      const st = this.plantState[side];
      if (!IK_CHAINS[chain]) continue;
      // Both anchors come from the pre-IK pose in MODEL space. Neither the
      // bone matrices nor world space will do here, and both were wrong for
      // the same reason: the target is set on one tick and consumed on the
      // next, so anything the correction itself moved feeds straight back into
      // the next target, and anything the BODY moved drags the target with it.
      // On `k.sweep`, which spins the root through 180 degrees while a boot is
      // planted, the pair of them threw the right boot 915mm off the floor on
      // alternating frames.
      if (!A.preIkPos(`ankle_${side}`, _v) || !A.preIkPos(`hip_${side}`, _v2)) continue;

      const intent = this.#soleIntentHeight(side) - this.floorY;
      const bury = Math.max(0, -intent);
      // How far this ankle travelled in the body's own frame since the last
      // target was set, which is precisely how wrong the next one will be by the
      // time it is used.
      const travel = st.hasLast ? _v.distanceTo(st.last) : 0;
      st.last.copy(_v);
      st.hasLast = true;

      // Contact, decided on what the CLIP wanted rather than on what came out,
      // and held across a small band so a landing is not a switch. The ceiling is
      // the other half of the test: a boot a quarter of a metre under is not in
      // contact with anything, it belongs to a pose that is not standing. Smooth-
      // stepped so both ends of the band have a continuous derivative.
      const over = (bury - PLANT_CEILING) / PLANT_CEILING_BAND;
      const deep = over <= 0 ? 1 : over >= 1 ? 0 : 1 - over * over * (3 - 2 * over);
      const contact = grounded && intent < PLANT_BAND && deep > 0;
      st.contact = contact ? THREE.MathUtils.clamp(1 - intent / PLANT_BAND, 0, 1) * deep : 0;
      st.weight += (st.contact - st.weight) * PLANT_RATE;
      if (st.weight < 0.004) st.weight = 0;

      // The leg chain is only asked for help when the boot is buried deeper than
      // the ankle roll can lift it out of. That threshold is not caution, it is
      // measured: a partially-weighted two-bone solve does not leave a correct
      // leg alone. It rebuilds the limb in the chain's canonical bend plane and
      // slerps the ankle only part of the way back to its authored orientation,
      // which pitches the boot toe-down. Run on every contact frame of a walk it
      // took the deepest penetration from 2.6cm over 85 frames to 10cm over 400 —
      // it made the exact problem it exists to fix four times worse. Rolling the
      // ankle costs nothing and fixed 40% of those frames on its own, so the
      // solver is held back for the case it is genuinely needed: a landing or a
      // knockdown that drives the whole leg through the floor.
      //
      // The second gate is `travel`, and it is the one that matters on a fast
      // clip. A correction of `bury` metres aimed at a point that will be
      // `travel` metres out of date by the time it is applied only has
      // `1 - travel/bury` of itself left; past that the solver is not planting a
      // boot, it is dragging a moving leg back to where it used to be. Fading on
      // that ratio rather than switching on it keeps the release smooth.
      if (st.weight > 0.01 && bury > ROLL_CAPACITY && travel < bury) {
        _v.y += bury;
        // Past the end of the leg the solve would straighten the knee, so hand
        // the weight back to the clip rather than snap it.
        const easy = this.legLength * 0.94;
        const reach = _v.distanceTo(_v2);
        let w = st.weight * (1 - travel / bury);
        if (reach > easy) w *= THREE.MathUtils.clamp(1 - (reach - easy) / (this.legLength * 0.1), 0, 1);
        if (w > 0.01) {
          st.target.copy(_v);
          this.animator.setIkTarget(chain, st.target, w, { space: 'model' });
          continue;
        }
      }
      this.animator.setIkTarget(chain, null, 0);
    }
  }

  /**
   * Hold the pelvis at a height its legs can actually stand at.
   *
   * A large share of the floor penetration in this game is not a foot problem at
   * all. Measured across the 89 clips, 39 drive a sole more than 5cm under the
   * concrete, and on the worst of them BOTH boots are under it at once with both
   * legs already straight — `k.stomp`'s landing sits 288mm down with the hip-to-
   * ankle span at 805mm of an 808mm leg. No foot solver can fix that: there is no
   * leg length left to spend. The clip simply authored a root track lower than
   * the rig can stand at, and the only correction is to move the root.
   *
   * So this lifts by the SMALLER of the two boots' penetration, which is exactly
   * the amount that is the pelvis's fault. One boot under and one in the air is a
   * swing-arc problem and the minimum is negative, so the lift bleeds back out —
   * a walk is never touched. It writes `pose.rootPos.y` from a `pre` layer, ahead
   * of both IK and the ankle roll, so both of those then solve against a body
   * that is standing at a plausible height instead of fighting for the same
   * centimetres.
   *
   * It runs against the CLIP's own forward kinematics rather than against last
   * tick's bone matrices, and so carries no feedback lag. A servo reading its
   * own output one tick late was measured overshooting a crouch entry by 108mm
   * — the fighter visibly hovered for four frames on the way down — because the
   * error it was chasing collapsed faster than it could integrate. Read the need
   * fresh, rate-limit the response, and the overshoot cannot exist.
   */
  #installPelvisLift() {
    if (!this.animator?.addProceduralLayer) return;
    this.animator.addProceduralLayer((pose, ctx) => {
      const need = this.#pelvisNeed(ctx);
      // A body that has left its feet gives the correction back at once rather
      // than easing it out. Ramping down through a knockdown was measured
      // floating a fallen fighter 320mm off the concrete for eight frames: on a
      // prone chassis the boot is not the lowest point and the smoothing that
      // makes a landing read has nothing left to smooth.
      if (need === null) { this.pelvisLift = 0; return; }
      const want = THREE.MathUtils.clamp(need, 0, PELVIS_LIFT_MAX);
      const d = want - this.pelvisLift;
      // Falling is normally eased, but a negative need means the correction is
      // now holding the fighter off the floor, and that is not a thing to ease
      // out of: give back most of the measured gap at once. A `r.crumple` was
      // measured hovering 173mm for six frames on the fixed rate alone.
      const step = d > 0 ? PELVIS_LIFT_RISE : Math.max(PELVIS_LIFT_FALL, -need * 0.9);
      this.pelvisLift += Math.abs(d) <= step ? d : Math.sign(d) * step;
      if (this.pelvisLift < PELVIS_LIFT_EPS) this.pelvisLift = 0;
      if (this.pelvisLift !== 0) pose.rootPos.y += this.pelvisLift;
    }, { stage: 'pre' });
  }

  /**
   * How far the pelvis is below a height its legs can stand at, this tick.
   *
   * The lift is the penetration of the boot that is LEAST buried, because that
   * is the part of the error the pelvis is responsible for. One boot under and
   * one in the air is a swing-arc problem, the minimum goes negative and the
   * correction releases — a walk cycle is therefore never touched.
   *
   * @returns {?number} metres, or null when this state may not be corrected
   */
  #pelvisNeed(ctx) {
    if (this.airborne || !PELVIS_LIFT_STATES.has(this.state)) return null;
    let shared = Infinity;
    for (const side of ['L', 'R']) {
      if (!this.plantState[side].sole.length) return null;
      const low = this.#soleNow(ctx, side);
      if (!Number.isFinite(low)) return null;
      const bury = this.floorY - low;
      if (bury < shared) shared = bury;
    }
    return Number.isFinite(shared) ? shared : null;
  }

  /**
   * Roll a planted foot over its own ball instead of driving it through the
   * floor. Runs as a post-IK layer so it reads the leg the solver actually
   * produced, and writes only the two joints below the ankle.
   *
   * It reads that leg out of `ctx`, not out of the bone matrices. The matrices
   * are only written in `#writePose`, which has not run yet this tick, so a roll
   * that measured them was correcting the burial the boot had one frame ago —
   * a servo lagging its own output by exactly the interval it acts over, which
   * is the recipe for it to alternate rather than settle.
   */
  #installFootRoll() {
    if (!this.animator?.addProceduralLayer) return;
    this.animator.addProceduralLayer((pose, ctx) => {
      for (const side of ['L', 'R']) {
        const w = this.plantState[side].weight;
        if (w <= 0.01) continue;
        // How far the boot is buried, and how far down the foot that point sits.
        const deep = this.#soleNow(ctx, side) - this.floorY;
        if (!(deep < 0)) continue;
        const ankle = ctx.worldPos(`ankle_${side}`);
        const toe = ctx.worldPos(`toe_${side}`);
        if (!ankle || !toe) continue;
        const arm = Math.max(0.08, toe.distanceTo(ankle));
        // Positive X at the ankle plantar-flexes, which drives the toe DOWN, so
        // lifting the boot out of the floor is a negative rotation.
        const pitch = THREE.MathUtils.clamp(deep / arm, -FOOT_ROLL_LIMIT, 0);
        ctx.addEuler(`ankle_${side}`, pitch * 0.6, 0, 0, w);
        ctx.addEuler(`foot_${side}`, pitch * 0.4, 0, 0, w);
      }
    }, { stage: 'post' });
  }

  /**
   * A footstep fires when the SOLE arrives at the floor moving downward, not
   * when a bone crosses an arbitrary height. Written against the foot bone this
   * used the same wrong reference the old planter did and, on a chassis whose
   * foot bone rests 20cm up, never fired once.
   */
  #trackFootfalls() {
    if (this.airborne) return;
    for (const side of ['L', 'R']) {
      const s = this.footState[side];
      const h = this.#soleIntentHeight(side) - this.floorY;
      const dv = h - s.y;
      if (!s.down && h < FOOTFALL_DOWN && dv < -0.0015) {
        s.down = true;
        const bone = this.boneByName[`foot_${side}`];
        if (bone) _v.setFromMatrixPosition(bone.matrixWorld);
        _v.y = this.floorY;
        bus.emit('footstep', {
          fighter: this, foot: side, point: _v.clone(),
          force: THREE.MathUtils.clamp(-dv * 55 + Math.abs(this.velocity.x) * 0.09, 0.2, 1.6),
        });
      } else if (s.down && h > FOOTFALL_UP) {
        s.down = false;
      }
      s.y = h;
    }
  }

  /**
   * Cosmetic-only frame update.
   * @param {number} alpha interpolation between the previous and current tick
   * @param {number} dt    real seconds since the last frame
   */
  render(alpha, dt) {
    if (!this.ready) return;
    _v.lerpVectors(this.prevPosition, this.position, alpha);
    this.group.position.copy(_v);

    const targetYaw = yawForFacing(this.facing);
    let delta = targetYaw - this.visualYaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    // Exponential decay, not `dt * k`: the linear form converges at a different
    // rate on a 60Hz display than on a 144Hz one, so the turn looked slower the
    // better the machine. This is the only frame-rate-dependent smoothing on
    // this class — everything inside simulate() runs on the fixed tick and its
    // constants must stay as they are.
    this.visualYaw += delta * (1 - Math.exp(-14 * dt));
    // The animation's own yaw rides on top, interpolated the short way round so
    // the frame a spin wraps at is not rendered as a full turn backwards.
    this.group.rotation.y = this.visualYaw + this.prevAnimYaw + wrapPi(this.animYaw - this.prevAnimYaw) * alpha;

    if (this.animator) this.animator.applyTo(this.bones, alpha);
    this.group.updateMatrixWorld(true);

    this.#updateActuators();
    this.#updateEmissive(dt);
  }

  /**
   * Pistons: every actuator part spans two bones, so its length and orientation
   * fall straight out of the posed skeleton. Without this the joints read as
   * stiff plastic; with it the robot looks driven.
   */
  #updateActuators() {
    for (const act of this.actuators) {
      _v.setFromMatrixPosition(act.a.matrixWorld);
      _v2.setFromMatrixPosition(act.b.matrixWorld);
      const len = _v.distanceTo(_v2);
      if (act.restLen === 0) { act.restLen = Math.max(1e-3, len); continue; }
      const parent = act.obj.parent;
      if (!parent) continue;
      _m.copy(parent.matrixWorld).invert();
      _v3.copy(_v).add(_v2).multiplyScalar(0.5).applyMatrix4(_m);
      act.obj.position.copy(_v3);
      // Direction in the parent's space, then align the part's +Y to it.
      _v4.copy(_v2).sub(_v).normalize().transformDirection(_m);
      _q.setFromUnitVectors(UP, _v4);
      act.obj.quaternion.copy(_q);
      act.obj.scale.y = act.baseScale * THREE.MathUtils.clamp(len / act.restLen, 0.55, 1.9);
    }
  }

  /**
   * The robot has to read as *powered*: reactor glow tracks meter, the pulse
   * rate climbs as health falls, a full gauge strobes, and a fresh hit flashes
   * the vents. This is the cheapest thing in the renderer and one of the most
   * legible.
   */
  #updateEmissive(dt) {
    this.pulsePhase = (this.pulsePhase ?? 0) + dt * 3.2;
    const healthRatio = this.health / MAX_HEALTH;
    const meterRatio = this.meter / METER_MAX;
    const hurt = 1 - healthRatio;
    const beat = 0.5 + 0.5 * Math.sin(this.pulsePhase * (1 + hurt * 1.6));
    const full = this.meter >= METER_MAX ? 0.9 + 0.5 * Math.sin(this.pulsePhase * 4) : 0;
    const hitFlash = Math.max(0, 1 - (this.simTick - this.lastDamageTick) / 8);
    const pulse = beat * (0.12 + meterRatio * 0.5) + full + hitFlash * 2.2;

    if (this.robotUpdate) {
      this.robotUpdate(dt, {
        health: healthRatio, meter: meterRatio, pulse, flash: hitFlash,
        damageLevel: this.damageLevel, state: this.state,
      });
      return;
    }
    const gain = 1 + meterRatio * 1.1 + pulse;
    for (const rec of this.emissiveMats) rec.mat.emissiveIntensity = rec.base * gain;
  }

  /** Public clip driver, used by the harness, intros and paired animations. */
  playClip(id, blend = 4, loop = false, speed = 1) { this.#play(id, blend, loop, speed, null); }

  /**
   * Play a clip, skipping the call when a looping clip is already running so a
   * held walk does not restart every tick. An unknown id falls back to the
   * fight stance rather than throwing — one missing animation must never be
   * able to take the whole match down.
   */
  #play(id, blend = 4, loop = false, speed = 1, retime = null) {
    if (!this.animator || !id) return;
    let clipId = id;
    if (!CLIPS[clipId]) {
      if (!Fighter.missingClips.has(clipId)) {
        Fighter.missingClips.add(clipId);
        console.warn(`[Fighter] missing clip "${clipId}", falling back to idle.fight`);
      }
      clipId = 'idle.fight';
      speed = 1;
      retime = null;
      if (!CLIPS[clipId]) return;
    }
    if (loop && this.currentClip === clipId) return;
    this.currentClip = clipId;
    this.animator.play(clipId, { blend, loop, speed, retime, inertia: this.#inertiaFor(blend) });
  }

  /**
   * How long the transition into a clip should inertialize for.
   *
   * A blow is a cut, not a blend. The frame after contact has to show the body
   * already thrown, so anything played on the tick a hit landed or was blocked
   * keeps the hard transition and the impact reads at full force. Every other
   * transition decays the difference from the pose the body was actually in,
   * over a window scaled by the crossfade the call site asked for — that number
   * is already the site's statement of how urgent the change is, so it drives
   * the decay instead of being replaced by one constant for the whole game.
   * @param {number} blend the crossfade length the call site asked for
   */
  #inertiaFor(blend) {
    if (blend <= 0 || this.impactTick === this.simTick) return 0;
    return THREE.MathUtils.clamp(Math.round(blend * 2.4), 6, 14);
  }

  /** Round bookends. */
  celebrate() {
    this.#enter(STATE.VICTORY);
    this.velocity.set(0, 0, 0);
    this.#play(this.rng.next() < 0.5 ? 'v.pose' : 'v.saluteCharge', 8, false);
  }

  dispose() {
    this.#dropBlowListeners();
    if (this.robot?.dispose) this.robot.dispose();
    this.scene.remove(this.group);
  }
}
