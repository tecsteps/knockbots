/**
 * Knockbots — the move lists.
 *
 * Four archetype movesets ('standard', 'heavy', 'agile', 'technical') keyed by
 * the `moveSet` field of a roster entry. Every move goes through `defineMove()`
 * so frame data can never disagree with the simulation.
 *
 * Authoring model
 * ---------------
 * Frame advantage is the thing a designer actually reasons about ("this poke is
 * -1 on block, +8 on hit"), while the schema stores *stun*. So moves are
 * authored with `adv: { block, hit }` and the stun values are derived from the
 * move's own recovery. Change a move's total and its advantage stays where it
 * was authored — the numbers cannot rot.
 *
 * Archetypes share one core list of ~37 moves and then diverge: each set is
 * shifted in startup, scaled in damage and reach, given its own display names
 * and clips, and finally extended with six moves nobody else has. That keeps the
 * balance skeleton coherent (the i10 jab, the -13 launcher, the -12 low all sit
 * in the same places for every character) while making each set play
 * differently.
 *
 * Balance invariants held across all four sets:
 *   - the fastest normal is i9..i12 and is at worst -2 on block
 *   - every launcher is -13 or worse on block (the 10-frame punisher matters)
 *   - every low is minus on block; sweeps are -14 or worse
 *   - moves that are plus on block are slow, short, or push the defender out
 *   - armour and invulnerability are always paid for with recovery
 */

import { HEIGHT, WEIGHT, REACTION, METER_MAX, INPUT_BUFFER_TICKS } from '../core/Constants.js';
import { defineMove } from './MoveSchema.js';
// roster.js is pure data and imports nothing, so this cannot cycle. It is the
// source of truth for which machine exists and which archetype its signature
// layer is merged over; see CHARACTER_EXTRAS below.
import { ROSTER } from '../characters/roster.js';

// ---------------------------------------------------------------------------
// Authoring helpers
// ---------------------------------------------------------------------------

/**
 * A hitbox anchored to a posed bone. `length` makes it a capsule down bone -Y.
 *
 * `fwd` shifts the box a few centimetres along the *fighter's* facing after the
 * bone transform. Every fighting game does this: the hitbox leads the visual so
 * a strike that clearly reaches on screen cannot whiff because the animation
 * stopped a hand's width short. It stays anchored to the live bone — it just
 * sits slightly in front of the fist.
 */
const B = (bone, radius, offset = [0, 0, 0], length = 0, fwd = 0) => {
  const b = { bone, radius, offset };
  if (length > 0) b.length = length;
  if (fwd) b.fwd = fwd;
  return b;
};

/** An active window. `damage` overrides the move damage for multi-hit strings. */
const W = (from, to, boxes, damage) =>
  (damage != null ? { from, to, boxes, damage } : { from, to, boxes });

/**
 * How far in front of each anchor bone an un-annotated box sits, by limb. Long
 * limbs lead further because their strikes travel further; a body check leads
 * most of all because the chest bone is buried inside the torso.
 */
const DEFAULT_FWD = [
  [/^(hand|wrist|fingers)_/, 0.24],
  [/^elbow_/, 0.24],
  [/^(foot|ankle|toe)_/, 0.31],
  [/^knee_/, 0.27],
  [/^(shoulder|clavicle)_/, 0.34],
  [/^(chest|spine|hips)/, 0.46],
  [/^(head|neck)/, 0.24],
];

// Reusable hitbox shapes, so a "right straight" reads the same on every set.
const FIST_R = (r = 0.21) => [B('hand_R', r, [0, -0.05, 0]), B('wrist_R', r * 0.8, [0, -0.04, 0])];
const FIST_L = (r = 0.21) => [B('hand_L', r, [0, -0.05, 0]), B('wrist_L', r * 0.8, [0, -0.04, 0])];
const ELBOW_R = (r = 0.24) => [B('elbow_R', r, [0, -0.06, 0]), B('wrist_R', r * 0.7, [0, 0, 0])];
// k.spinKick's consumers anchor FOOT_R, not FOOT_L, and that is deliberate.
// Measured by driving the clip through the real rig at its impact tick: foot_R
// travels 1.02m from stance while foot_L travels 0.14m, with hip_R fully
// abducted at Z=-70 and knee_R straight at 2 degrees. The right leg is the
// kicking leg; the left is the planted pivot. Every consumer previously anchored
// the pivot foot, so the hit capsule and the weapon trail sat on the grounded leg
// while the other swung through the opponent.
const FOOT_R = (r = 0.24) => [B('foot_R', r, [0, -0.02, 0.04]), B('ankle_R', r * 0.85, [0, 0, 0])];
const FOOT_L = (r = 0.24) => [B('foot_L', r, [0, -0.02, 0.04]), B('ankle_L', r * 0.85, [0, 0, 0])];
const KNEE_R = (r = 0.25) => [B('knee_R', r, [0, -0.08, 0.05]), B('ankle_R', r * 0.7, [0, 0, 0])];
// Low attacks sweep the whole lower leg, so the box is a capsule down the shin
// rather than a ball at the toe — otherwise a sweep passes under the target's
// leg hurtboxes and connects with nothing.
const SHIN_L = (r = 0.23) => [B('knee_L', r, [0, -0.04, 0.04], 0.42), B('foot_L', r, [0, -0.02, 0.05])];
const SHIN_R = (r = 0.23) => [B('knee_R', r, [0, -0.04, 0.04], 0.42), B('foot_R', r, [0, -0.02, 0.05])];

/**
 * The vestigial hitbox on a throw, tucked inside the thrower's own chest.
 *
 * A throw is resolved by RANGE, in `CombatSystem#resolveThrow`, which never
 * looks at these boxes — it compares |dx| against `props.throw.range` and calls
 * `beginThrow`. The boxes exist only because `defineMove` requires at least one
 * active window and `#resolveThrow` uses `isActive()` to find the grab frames.
 *
 * They were authored as real 0.30 m capsules on both hands leading 0.25 m
 * forward, and that was a live bug rather than dead weight. `#resolveThrow`
 * refuses a long list of defender states — airborne, juggled, launched,
 * backdashing (`throwInvuln`), invulnerable — and returns *without* consuming
 * the window. `#findConnection` then runs on the very same tick, and
 * `#guardResult` answers `'hit'` for anything carrying `props.throw` before it
 * tests guard or height. So a rejected grab could pay out instead as an
 * unblockable 34-62 damage knockdown that could not be blocked, ducked, or
 * armoured through.
 *
 * How close it actually came, measured offline against the real rig at the grab
 * frame — clearance in metres between the grab capsule and the nearest defender
 * hurtbox, negative meaning it connects, at the 0.84 m minimum separation the
 * push-out enforces:
 *
 *     defender pose      standing  launched  crouching  mid-whiff
 *     0.30 m boxes, +0.25   +0.17     -0.05      -0.05      -0.13
 *     as authored now       +1.17     +1.18      +1.03      +0.97
 *
 * Standing, it missed — which is why this never showed up as an obvious "throws
 * do damage from nowhere" report. Against a launched opponent, which is the one
 * state `#resolveThrow` explicitly refuses, it connected: 1+2 during a juggle
 * was free unblockable damage.
 *
 * `fwd: -0.7` pulls the anchor back through the fighter's own spine, so the box
 * is behind its own hurtboxes and cannot reach anything the push-out has
 * separated — a metre of clearance in every pose above. The grab frames still
 * exist, `isActive` still finds them, and the throw path is untouched.
 *
 * The clean fix belongs one line up the stack in CombatSystem — see the note on
 * `throwFwd` — but this file can make the boxes harmless on its own, and does.
 */
const GRAB = () => [
  B('hand_R', 0.04, [0, -0.05, 0], 0, -0.7),
  B('hand_L', 0.04, [0, -0.05, 0], 0, -0.7),
];

const MOTIONS = new Set(['qcf', 'qcb', 'dp', 'hcf', 'dd', 'ff', 'bb']);
const DIRS = new Set(['f', 'b', 'u', 'd', 'df', 'db', 'uf', 'ub']);

/**
 * Parse one notation token, e.g. `"df+1+2"`, `"qcf+2"`, `"1"`.
 * @returns {{ motion:?string, dir:string, buttons:number[], raw:string, score:number }}
 */
function parseToken(tok) {
  const parts = String(tok).trim().split('+');
  let prefix = '';
  if (MOTIONS.has(parts[0]) || DIRS.has(parts[0])) prefix = parts.shift();
  const buttons = parts.map((p) => Number(p)).filter((n) => n >= 1 && n <= 5);
  const motion = MOTIONS.has(prefix) ? prefix : null;
  const dir = DIRS.has(prefix) ? prefix : '';
  const score = (motion ? 100 : 0) + (dir ? (dir.length === 2 ? 40 : 25) : 0) + buttons.length * 10;
  return { motion, dir, buttons, raw: tok, score };
}

/** Does a held-direction state satisfy a notation direction prefix? */
function dirMatches(dir, e) {
  switch (dir) {
    case '': return !e.fwd && !e.back && !e.up && !e.down;
    case 'f': return e.fwd && !e.up && !e.down;
    case 'b': return e.back && !e.up && !e.down;
    case 'u': return e.up && !e.fwd && !e.back;
    case 'd': return e.down && !e.fwd && !e.back;
    case 'df': return e.fwd && e.down;
    case 'db': return e.back && e.down;
    case 'uf': return e.fwd && e.up;
    case 'ub': return e.back && e.up;
    default: return false;
  }
}

/**
 * Shift every tick-valued field of a spec by `d`. Because both the active
 * windows and `total` move together, recovery — and therefore frame advantage —
 * is unchanged: a shift makes a move faster or slower, never safer.
 */
function shiftSpec(s, d) {
  if (!d) return s;
  for (const w of s.active) { w.from += d; w.to += d; }
  s.total += d;
  if (s.cancelWindow) s.cancelWindow = [s.cancelWindow[0] + d, s.cancelWindow[1] + d];
  const p = s.props;
  if (p) {
    if (p.invulnFrom != null) { p.invulnFrom = Math.max(0, p.invulnFrom + d); p.invulnTo += d; }
    if (p.armorFrom != null) { p.armorFrom = Math.max(0, p.armorFrom + d); p.armorTo += d; }
    if (p.parryFrom != null) { p.parryFrom = Math.max(0, p.parryFrom + d); p.parryTo += d; }
    if (p.travel) for (const t of p.travel) { t.from += d; t.to += d; }
    if (p.airborne) p.airborne = [Math.max(0, p.airborne[0] + d), p.airborne[1] + d];
    if (p.throw) p.throw.breakWindow = [p.throw.breakWindow[0], p.throw.breakWindow[1]];
  }
  return s;
}

/** Human-readable annotations for the command list. */
function noteFor(m) {
  const n = [];
  const p = m.props;
  if (m.juggleHeight) n.push('Launcher');
  if (p.armorFrom != null) n.push(`Armour ${p.armorFrom}-${p.armorTo}`);
  if (p.invulnFrom != null) n.push(`Invuln ${p.invulnFrom}-${p.invulnTo}`);
  if (p.parryFrom != null) n.push(`Parry ${p.parryFrom}-${p.parryTo}`);
  if (p.crushHigh) n.push('Ducks highs');
  if (p.crushLow) n.push('Jumps lows');
  if (p.homing) n.push('Homing');
  if (p.wallBounce) n.push('Wall bounce');
  if (p.groundBounce) n.push('Floor bounce');
  // A throw the player cannot see the break for is a coin flip, not a mix-up.
  // The break button and the size of the window are the whole defensive read,
  // so they go in the command list next to the frame data rather than in a wiki.
  if (p.throw) {
    const t = p.throw;
    const kind = t.type === 'back' ? 'Back throw' : t.type === 'command' ? 'Command throw' : 'Throw';
    n.push(`${kind} · reach ${t.range.toFixed(2)}m · break ${t.breakButtons.join(' or ')} within ${t.breakWindow[1]}f`);
  }
  if (p.counterLaunch) n.push('Launches on counter');
  if (p.hitsGrounded) n.push('Hits grounded');
  if (p.finisher) n.push(`Finisher · ${p.finisher.condition} · ${p.finisher.sequenceText} within ${(p.finisher.window / 60).toFixed(1)}s`);
  if (m.meterCost > 0) n.push(`${m.meterCost} meter`);
  if (m.height === HEIGHT.UNBLOCKABLE) n.push('Unblockable');
  return n.join(' · ');
}

/**
 * Turn an authored spec into a validated Move, applying archetype tuning.
 * @param {Object} s   authored spec, mutated in place
 * @param {Object} cfg archetype tuning
 */
/**
 * Flip a spec's hitbox anchors and weapon trail across the body's midline.
 *
 * An archetype that overrides a move's *clip* can silently swap the striking
 * limb with it, and the hitbox does not follow. `heavy.clips.backfist` replaces
 * p.backfist — which throws the left hand — with p.overhand, which throws the
 * right; `agile.clips.midPunch` replaces p.elbow (right elbow) with p.jabAlt
 * (left hand). Both kept the base move's anchors, so the hit capsule and the
 * weapon ribbon sat on the limb standing still while the other one swung
 * through the opponent. Measured at the impact tick: heavy/backfist anchored a
 * hand travelling 0.19m while the striking hand travelled 0.95m.
 *
 * Listing a move in an archetype's `mirrorBoxes` states the swap instead of
 * leaving it implicit. tools/check.mjs re-derives the striking limb from the
 * clip the rig actually plays and fails the build on any disagreement, so a
 * missing entry cannot ship.
 */
function mirrorAnchors(s) {
  const flip = (n) => (n.endsWith('_L') ? `${n.slice(0, -2)}_R` : n.endsWith('_R') ? `${n.slice(0, -2)}_L` : n);
  for (const w of s.active) for (const b of w.boxes) b.bone = flip(b.bone);
  if (s.trail) s.trail = flip(s.trail);
}

function make(s, cfg) {
  s.props = s.props || {};
  shiftSpec(s, s.lockFrames ? 0 : cfg.shift);

  // Reach: default the forward lead by limb, then scale the whole box by the
  // archetype's reach so a Bulwark's arms really do out-range a Wraith's.
  const reach = s.lockReach ? 1 : cfg.reach;
  for (const w of s.active) {
    for (const b of w.boxes) {
      if (b.fwd == null) {
        b.fwd = 0.2;
        for (const [re, v] of DEFAULT_FWD) if (re.test(b.bone)) { b.fwd = v; break; }
      }
      b.radius = Math.round(b.radius * reach * 1000) / 1000;
      // Reach moves the lead only half as much as the box size: a shorter-armed
      // archetype should have a smaller strike, not an unusable one.
      b.fwd = Math.round(b.fwd * (1 + (reach - 1) * 0.5) * 1000) / 1000;
    }
  }
  const power = s.lockPower ? 1 : cfg.power;
  s.damage = Math.max(1, Math.round(s.damage * power));
  for (const w of s.active) if (w.damage != null) w.damage = Math.max(1, Math.round(w.damage * power));
  if (s.juggleHeight) s.juggleHeight = Math.round(s.juggleHeight * (cfg.launch ?? 1) * 100) / 100;

  // Derive stun from authored frame advantage.
  const last = Math.max(...s.active.map((a) => a.to));
  const recovery = s.total - last - 1;
  const adv = s.adv || {};
  s.blockStun = Math.max(0, recovery + (adv.block ?? -6));
  s.hitStun = Math.max(1, recovery + (adv.hit ?? 4));
  delete s.adv;

  // The archetype's rename/reclip tables exist to give the SHARED core list a
  // local accent, and a character's own move must not be caught by them. Without
  // this gate BASTION's `counterStance` override came out named "Ablative
  // Guard" — the heavy archetype's name for the move it had just replaced.
  if (!s.character) {
    if (cfg.names && cfg.names[s.id]) s.name = cfg.names[s.id];
    if (cfg.clips && cfg.clips[s.id]) s.clip = cfg.clips[s.id];
    if (cfg.mirrorBoxes && cfg.mirrorBoxes.includes(s.id)) mirrorAnchors(s);
  }
  delete s.character;

  const m = defineMove(s);
  m.followUp = m.input.includes(',');
  m.stepInput = m.input.split(',').pop().trim();
  m.parsed = parseToken(m.input.split(',')[0]);
  m.parsedStep = parseToken(m.stepInput);
  m.note = noteFor(m);
  m.moveSet = cfg.key;
  return m;
}

// ---------------------------------------------------------------------------
// The core list. Every archetype gets these; tuning and clips differ.
// ---------------------------------------------------------------------------

function coreMoves(mv, cfg) {
  // --- jab string: 1 -> 1,2 -> 1,2,3 --------------------------------------
  // The jab and its cross are frame-locked across every archetype. Tekken does
  // the same thing: everyone has the i10 punisher, and characters differentiate
  // everywhere *except* the one move the whole punishment game is built on.
  mv({
    id: 'jab', name: 'Servo Jab', input: '1', clip: 'p.jab', tag: 'jab', lockFrames: true,
    active: [W(10, 11, FIST_L(0.2))], total: 21,
    height: HEIGHT.HIGH, weight: WEIGHT.LIGHT, damage: 8,
    adv: { block: 1, hit: 8 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [1.2, 0, 0], blockPush: [0.8, 0, 0],
    cancels: ['jab2', 'jabLow'], cancelWindow: [10, 20], meterGain: 3,
    sfx: 'lightHit',
  });
  mv({
    id: 'jab2', name: 'Cross Follow', input: '1,2', clip: 'p.straight', tag: 'string', lockFrames: true,
    active: [W(12, 13, FIST_R(0.21))], total: 26,
    height: HEIGHT.HIGH, weight: WEIGHT.LIGHT, damage: 11,
    adv: { block: -1, hit: 7 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [1.6, 0, 0], blockPush: [1.0, 0, 0],
    cancels: ['jab3'], cancelWindow: [12, 25], meterGain: 4, trail: 'hand_R',
  });
  mv({
    id: 'jab3', name: 'Rising Cutter', input: '1,2,3', clip: 'k.midKick', tag: 'string',
    active: [W(16, 18, FOOT_R(0.25))], total: 40,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 17,
    adv: { block: -9, hit: 4 }, reaction: REACTION.FLINCH_MID,
    knockback: [3.4, 0, 0], blockPush: [2.2, 0, 0], meterGain: 6, trail: 'foot_R',
  });
  mv({
    id: 'jabLow', name: 'Ankle Tap', input: '1,4', clip: 'k.lowKick', tag: 'string',
    active: [W(16, 17, SHIN_L(0.22))], total: 36,
    height: HEIGHT.LOW, weight: WEIGHT.LIGHT, damage: 11,
    adv: { block: -12, hit: 1 }, reaction: REACTION.FLINCH_LOW,
    knockback: [1.4, 0, 0], blockPush: [1.4, 0, 0], meterGain: 4,
  });

  // --- straight string: 2 -> 2,1 -> 2,1,2 (launcher ender) ----------------
  mv({
    id: 'straight', name: 'Piston Straight', input: '2', clip: 'p.straight', tag: 'poke',
    active: [W(12, 13, FIST_R(0.22))], total: 27,
    height: HEIGHT.HIGH, weight: WEIGHT.LIGHT, damage: 13,
    adv: { block: -2, hit: 8 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [1.8, 0, 0], blockPush: [1.1, 0, 0],
    cancels: ['straight2'], cancelWindow: [12, 26], meterGain: 4, trail: 'hand_R',
  });
  mv({
    id: 'straight2', name: 'Reverse Hook', input: '2,1', clip: 'p.hook', tag: 'string',
    active: [W(14, 15, FIST_L(0.23))], total: 31,
    height: HEIGHT.HIGH, weight: WEIGHT.MEDIUM, damage: 14,
    adv: { block: -4, hit: 6 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [2.2, 0, 0], blockPush: [1.4, 0, 0],
    cancels: ['straight3'], cancelWindow: [14, 30], meterGain: 5, trail: 'hand_L',
  });
  mv({
    id: 'straight3', name: 'Skyward Uppercut', input: '2,1,2', clip: 'p.uppercut', tag: 'launcher',
    active: [W(18, 20, FIST_R(0.26))], total: 46,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 21,
    adv: { block: -14, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 5.6,
    knockback: [1.6, 0, 0], blockPush: [1.8, 0, 0], meterGain: 9, trail: 'hand_R',
  });

  // --- standing pokes -----------------------------------------------------
  mv({
    id: 'midPunch', name: 'Panel Check', input: 'df+1', clip: 'p.elbow', tag: 'poke',
    active: [W(13, 14, ELBOW_R(0.23))], total: 27,
    height: HEIGHT.MID, weight: WEIGHT.LIGHT, damage: 14,
    adv: { block: -1, hit: 7 }, reaction: REACTION.FLINCH_MID,
    knockback: [1.6, 0, 0], blockPush: [1.0, 0, 0], meterGain: 4,
  });
  mv({
    id: 'elbow', name: 'Drive Elbow', input: 'f+2', clip: 'p.elbow', tag: 'mid',
    active: [W(16, 18, ELBOW_R(0.26))], total: 35,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 19,
    adv: { block: -5, hit: 8 }, reaction: REACTION.FLINCH_MID,
    knockback: [4.6, 0, 0], blockPush: [2.6, 0, 0], meterGain: 6,
    props: { wallCarry: 1.3, travel: [{ from: 8, to: 17, x: 3.4, z: 0 }] },
  });
  mv({
    id: 'overhand', name: 'Crown Breaker', input: 'b+2', clip: 'p.overhand', tag: 'mid',
    active: [W(20, 22, [B('hand_R', 0.27, [0, -0.05, 0], 0, 0.36), B('wrist_R', 0.22, [0, -0.04, 0], 0, 0.34)])], total: 45,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 25,
    adv: { block: -9, hit: 6 }, reaction: REACTION.FLINCH_MID,
    knockback: [2.4, 0, 0], blockPush: [2.6, 0, 0], meterGain: 8, trail: 'hand_R',
    props: { counterLaunch: { reaction: REACTION.CRUMPLE, hitStun: 46 } },
  });
  mv({
    id: 'backfist', name: 'Rotor Backfist', input: 'b+1', clip: 'p.backfist', tag: 'poke',
    active: [W(15, 16, FIST_L(0.25))], total: 33,
    height: HEIGHT.HIGH, weight: WEIGHT.MEDIUM, damage: 16,
    adv: { block: -6, hit: 5 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [3.0, 0, 0], blockPush: [1.8, 0, 0], meterGain: 5, trail: 'hand_L',
    cancels: ['backfist2'], cancelWindow: [15, 32],
    props: { counterLaunch: { reaction: REACTION.SPIN, hitStun: 40 } },
  });
  mv({
    id: 'backfist2', name: 'Rotor Finish', input: 'b+1,2', clip: 'p.hammerFist', tag: 'string',
    active: [W(17, 19, FIST_R(0.26))], total: 44,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 22,
    adv: { block: -11, hit: 3 }, reaction: REACTION.KNOCKDOWN,
    knockback: [5.0, 1.4, 0], blockPush: [2.8, 0, 0], meterGain: 8, trail: 'hand_R',
  });
  mv({
    id: 'hammerFist', name: 'Anvil Drop', input: 'df+1+2', clip: 'p.hammerFist', tag: 'mid',
    active: [W(18, 20, [B('hand_R', 0.27, [0, -0.06, 0]), B('hand_L', 0.27, [0, -0.06, 0])])], total: 42,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
    adv: { block: -10, hit: 2 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.2, 0.8, 0], blockPush: [2.4, 0, 0], meterGain: 8,
    props: { groundBounce: 0.45 },
  });

  // --- lows ---------------------------------------------------------------
  mv({
    id: 'lowJab', name: 'Shin Poke', input: 'd+1', clip: 'p.lowJab', tag: 'low',
    active: [W(11, 12, FIST_L(0.2))], total: 25,
    height: HEIGHT.LOW, weight: WEIGHT.LIGHT, damage: 7,
    adv: { block: -4, hit: 3 }, reaction: REACTION.FLINCH_LOW,
    knockback: [0.9, 0, 0], blockPush: [0.7, 0, 0], meterGain: 3,
    props: { crushHigh: true },
  });
  mv({
    id: 'lowKick', name: 'Piston Low', input: 'd+3', clip: 'k.lowKick', tag: 'low',
    active: [W(16, 17, SHIN_L(0.24))], total: 35,
    height: HEIGHT.LOW, weight: WEIGHT.LIGHT, damage: 13,
    adv: { block: -12, hit: 2 }, reaction: REACTION.FLINCH_LOW,
    knockback: [1.6, 0, 0], blockPush: [1.5, 0, 0], meterGain: 4,
    props: { crushHigh: true },
  });

  // Crouching 4. THE RIGHT KICK HAD NO CROUCHING MOVE: `d+4` resolved only to
  // `diveKick`, which carries `requireAir`, so ducking and pressing 4 matched a
  // move that could never pass `canUse` on the ground and the fighter just sat
  // there. Ducking 3 worked, which is what made it read as a side-specific bug
  // from play rather than a missing entry.
  //
  // The two coexist on `d+4` safely because `findMove`'s `tryMatch` tests
  // `canUse` BEFORE matching the buffer and continues on failure, so the air
  // gate picks between them: airborne gets the dive, grounded gets this.
  //
  // Deliberately a sweep rather than another poke -- 3 already owns the fast
  // low, so 4 gets the slow one that knocks down, which is the standard
  // fighting-game split and gives crouch a reason to hold two buttons.
  //
  // ANCHORED TO THE LEFT LEG DESPITE BEING A RIGHT-BUTTON MOVE, and that is
  // correct rather than a slip: `k.sweep` swings the left leg and plants the
  // right. My first pass anchored SHIN_R to match the button and the anchor
  // guard rejected it -- knee_R+foot_R travel 0.45m at the impact tick while
  // hand_L travels 1.34m, i.e. the capsule would have sat on the planted leg
  // while the other one swept through the opponent. That is the same defect
  // that put 27 hitboxes on the wrong limb, and the guard exists because of it.
  // The button a move is bound to says nothing about which limb its clip moves.
  mv({
    id: 'lowSweep', name: 'Servo Sweep', input: 'd+4', clip: 'k.sweep', tag: 'low',
    active: [W(20, 23, [B('knee_L', 0.25, [0, -0.04, 0.04], 0.44), B('foot_L', 0.26, [0, -0.02, 0.06]), B('hand_L', 0.23, [0, -0.05, 0])])], total: 44,
    height: HEIGHT.LOW, weight: WEIGHT.MEDIUM, damage: 19,
    adv: { block: -18, hit: 4 }, reaction: REACTION.SWEEP,
    knockback: [2.4, 0, 0], blockPush: [1.8, 0, 0], meterGain: 5, trail: 'foot_L',
    props: { crushHigh: true },
  });
  mv({
    id: 'sweep', name: 'Rotor Sweep', input: 'db+3', clip: 'k.sweep', tag: 'sweep',
    active: [W(19, 21, [B('knee_L', 0.25, [0, -0.04, 0.04], 0.44), B('foot_L', 0.27, [0, -0.02, 0.06]), B('hand_L', 0.24, [0, -0.05, 0])])], total: 47,
    height: HEIGHT.LOW, weight: WEIGHT.MEDIUM, damage: 21,
    adv: { block: -14, hit: 6 }, reaction: REACTION.SWEEP,
    knockback: [3.6, 0.6, 0], blockPush: [2.0, 0, 0], meterGain: 7, trail: 'foot_L',
    props: { crushHigh: true },
  });

  // --- kicks --------------------------------------------------------------
  mv({
    id: 'midKick', name: 'Turbine Kick', input: '3', clip: 'k.midKick', tag: 'mid',
    active: [W(15, 16, FOOT_R(0.25))], total: 34,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 17,
    adv: { block: -7, hit: 4 }, reaction: REACTION.FLINCH_MID,
    knockback: [3.0, 0, 0], blockPush: [2.0, 0, 0], meterGain: 6, trail: 'foot_R',
    cancels: ['midKick2'], cancelWindow: [15, 33],
  });
  mv({
    id: 'midKick2', name: 'Turbine Spin', input: '3,4', clip: 'k.spinKick', tag: 'string',
    active: [W(20, 22, [...FOOT_R(0.27), B('hand_R', 0.25, [0, -0.05, 0])])], total: 50,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 23,
    adv: { block: -12, hit: 4 }, reaction: REACTION.SPIN,
    knockback: [5.4, 1.2, 0], blockPush: [3.0, 0, 0], meterGain: 9, trail: 'foot_R',
    props: { wallCarry: 1.6 },
  });
  mv({
    id: 'highKick', name: 'Snap High', input: '4', clip: 'k.highKick', tag: 'poke',
    active: [W(13, 14, FOOT_R(0.24))], total: 31,
    height: HEIGHT.HIGH, weight: WEIGHT.MEDIUM, damage: 16,
    adv: { block: -8, hit: 7 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [2.6, 0, 0], blockPush: [1.8, 0, 0], meterGain: 5, trail: 'foot_R',
  });
  mv({
    id: 'sideKick', name: 'Bulkhead Kick', input: 'f+3', clip: 'k.sideKick', tag: 'mid',
    active: [W(17, 19, FOOT_L(0.27))], total: 39,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 21,
    adv: { block: -6, hit: 5 }, reaction: REACTION.FLINCH_MID,
    knockback: [6.2, 0, 0], blockPush: [4.2, 0, 0], meterGain: 6, trail: 'foot_R',
    props: { wallCarry: 2.0 },
  });
  mv({
    id: 'knee', name: 'Piston Knee', input: 'df+3', clip: 'k.kneeStrike', tag: 'mid',
    active: [W(14, 15, KNEE_R(0.25))], total: 31,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 16,
    adv: { block: -4, hit: 6 }, reaction: REACTION.FLINCH_MID,
    knockback: [2.0, 0, 0], blockPush: [1.4, 0, 0], meterGain: 5,
    props: { crushLow: true },
  });
  mv({
    id: 'roundhouse', name: 'Wrecking Round', input: 'b+4', clip: 'k.roundhouse', tag: 'heavy',
    active: [W(20, 22, [...FOOT_R(0.29), B('hand_R', 0.28, [0, -0.05, 0], 0, 0.4), B('wrist_R', 0.24, [0, -0.04, 0], 0, 0.38)])], total: 48,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 27,
    adv: { block: -13, hit: 5 }, reaction: REACTION.KNOCKDOWN,
    knockback: [6.6, 1.6, 0], blockPush: [3.2, 0, 0], meterGain: 10, trail: 'foot_R',
    props: { wallCarry: 2.2, wallBounce: true },
  });
  mv({
    id: 'spinKick', name: 'Gyro Sweepline', input: 'b+3', clip: 'k.spinKick', tag: 'heavy',
    active: [W(22, 24, [...FOOT_R(0.28), B('hand_R', 0.26, [0, -0.05, 0])])], total: 52,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 25,
    adv: { block: -9, hit: 3 }, reaction: REACTION.KNOCKDOWN,
    knockback: [4.4, 1.0, 0], blockPush: [2.6, 0, 0], meterGain: 9, trail: 'foot_R',
    props: { homing: true },
  });
  mv({
    id: 'axeKick', name: 'Guillotine Axe', input: 'uf+4', clip: 'k.axeKick', tag: 'heavy',
    active: [W(22, 24, FOOT_L(0.27))], total: 54,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 25,
    adv: { block: -13, hit: 4 }, reaction: REACTION.KNOCKDOWN,
    knockback: [2.0, -1.2, 0], blockPush: [2.2, 0, 0], meterGain: 9, trail: 'foot_R',
    props: { crushLow: true, groundBounce: 0.6, airborne: [8, 26] },
  });
  mv({
    id: 'stomp', name: 'Servo Stomp', input: 'd+3+4', clip: 'k.stomp', tag: 'heavy',
    active: [W(20, 22, [B('foot_R', 0.3, [0, -0.04, 0.02]), B('knee_R', 0.26, [0, -0.04, 0.04], 0.4), B('hand_L', 0.26, [0, -0.05, 0])])], total: 48,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 22,
    adv: { block: -16, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [1.4, -2.0, 0], blockPush: [1.8, 0, 0], meterGain: 8,
    props: { hitsGrounded: true },
  });

  // --- launchers ----------------------------------------------------------
  mv({
    id: 'launcherPunch', name: 'Reactor Uppercut', input: 'df+2', clip: 'p.launcherPunch', tag: 'launcher',
    active: [W(15, 17, FIST_R(0.26))], total: 43,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 19,
    adv: { block: -13, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 6.2,
    knockback: [1.4, 0, 0], blockPush: [1.6, 0, 0], meterGain: 9, trail: 'hand_R',
  });
  mv({
    id: 'launcherKick', name: 'Ascension Kick', input: 'uf+3', clip: 'k.launcherKick', tag: 'launcher',
    active: [W(19, 21, FOOT_R(0.28))], total: 51,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 23,
    adv: { block: -16, hit: 22 }, reaction: REACTION.LAUNCH, juggleHeight: 6.9,
    knockback: [2.6, 0, 0], blockPush: [2.0, 0, 0], meterGain: 11, trail: 'foot_R',
    props: { crushLow: true, airborne: [6, 24] },
  });
  mv({
    id: 'duckingStraight', name: 'Ducking Lance', input: 'd+2', clip: 'p.duckingStraight', tag: 'mid',
    active: [W(16, 17, FIST_R(0.24))], total: 37,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 18,
    adv: { block: -6, hit: 5 }, reaction: REACTION.FLINCH_MID,
    knockback: [2.4, 0, 0], blockPush: [1.8, 0, 0], meterGain: 6,
    props: { crushHigh: true, counterLaunch: { reaction: REACTION.LAUNCH, juggleHeight: 5.2, hitStun: 30 } },
  });
  mv({
    id: 'jumpKick', name: 'Vault Kick', input: 'u+3', clip: 'k.jumpKick', tag: 'air',
    active: [W(14, 18, FOOT_R(0.27))], total: 42,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 19,
    adv: { block: -6, hit: 2 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.4, 0.4, 0], blockPush: [2.4, 0, 0], meterGain: 6, trail: 'foot_R',
    props: { crushLow: true, airborne: [4, 34], travel: [{ from: 4, to: 20, x: 4.2, z: 0 }] },
  });
  // The only move in the game that is legal WHILE AIRBORNE.
  //
  // `canUse` has supported `requireAir` since it was written and nothing had
  // ever set it, and its other branch — `st.airborne && !m.followUp` — rejects
  // every ground move. So a jumping fighter had no attack at all: measured by
  // holding up to a full jump and pressing 4 on ten consecutive airborne ticks,
  // `#tryMove` returned null on all ten and the fighter simply floated. A player
  // asked for an air kick; there was no such thing to find.
  //
  // Bare 4 in the air, which cannot collide with the standing `4` because the
  // two are separated by exactly that gate. Deliberately weak on block: it
  // lands late in the jump arc and the recovery runs into the ground, which is
  // what stops a jump-in being the whole game.
  mv({
    id: 'airKick', name: 'Drop Kick', input: '4', clip: 'k.jumpKick', tag: 'air',
    active: [W(11, 15, FOOT_R(0.27))], total: 34,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 17,
    adv: { block: -13, hit: 2 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.0, 0.2, 0], blockPush: [2.4, 0, 0], meterGain: 6, trail: 'foot_R',
    props: { requireAir: true, crushLow: true },
  });

  // Bare 3 in the air. THE LEFT KICK HAD NO AIR MOVE AT ALL, so jumping and
  // pressing 3 did nothing while 4 worked -- reported from play, and the move
  // table shows it plainly: `requireAir` appeared on exactly two moves, both of
  // them on 4 (`airKick` on `4`, `diveKick` on `d+4`). The gate was written
  // symmetric and the content was not.
  //
  // It is not a copy of the drop kick. A left air kick that traded identically
  // would just be a second button for the same option, so this one is faster
  // and shorter-ranged with a flatter arc: it beats the drop kick to the punch
  // in the air and loses the knockdown, which is the trade that makes having
  // both worth it.
  // The two air punches. Jumping and pressing either punch did NOTHING -- the
  // whole airborne row of the state/button matrix was two-thirds empty:
  //
  //   airborne   LP: none   RP: none   LK: none   RK: airKick
  //
  // Three of four buttons dead in the air, which is why it read from play as
  // "left kick does nothing in the jump" -- the one that worked was the only
  // one that existed. Ground moves are rejected in the air by canUse's
  // `st.airborne && !m.followUp` branch, so an air option has to be authored
  // deliberately; nobody had.
  mv({
    id: 'airJab', name: 'Air Rivet', input: '1', clip: 'p.jab', tag: 'air',
    active: [W(7, 10, FIST_L(0.23))], total: 26,
    height: HEIGHT.MID, weight: WEIGHT.LIGHT, damage: 10,
    adv: { block: -9, hit: 3 }, reaction: REACTION.FLINCH_MID,
    knockback: [1.8, 0.1, 0], blockPush: [1.5, 0, 0], meterGain: 4, trail: 'hand_L',
    props: { requireAir: true },
  });

  // The heavy air option: slower, and the only air punch that carries a real
  // downward arc, so it beats an air jab trade and loses to anti-air.
  mv({
    id: 'airHammer', name: 'Anvil Drop', input: '2', clip: 'p.hammerFist', tag: 'air',
    active: [W(12, 16, FIST_R(0.25))], total: 34,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 18,
    adv: { block: -14, hit: 4 }, reaction: REACTION.KNOCKDOWN,
    knockback: [2.8, 0.2, 0], blockPush: [2.2, 0, 0], meterGain: 6, trail: 'hand_R',
    props: { requireAir: true, groundBounce: 0.4 },
  });

  mv({
    id: 'airSideKick', name: 'Air Lance', input: '3', clip: 'k.sideKick', tag: 'air',
    active: [W(9, 12, FOOT_L(0.25))], total: 30,
    height: HEIGHT.MID, weight: WEIGHT.LIGHT, damage: 13,
    adv: { block: -11, hit: 3 }, reaction: REACTION.FLINCH_MID,
    knockback: [2.2, 0.1, 0], blockPush: [1.9, 0, 0], meterGain: 5, trail: 'foot_L',
    props: { requireAir: true, crushLow: true },
  });

  // --- rushing / wall-carry ------------------------------------------------
  mv({
    id: 'pistonRush', name: 'Piston Rush', input: 'ff+2', clip: 'p.pistonRush', tag: 'rush',
    active: [
      W(17, 18, FIST_L(0.22), 8),
      W(22, 23, FIST_R(0.22), 8),
      W(27, 29, FIST_R(0.26), 16),
    ], total: 54,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 8,
    adv: { block: -8, hit: 3 }, reaction: REACTION.STAGGER,
    knockback: [5.6, 0.6, 0], blockPush: [3.4, 0, 0], meterGain: 10, trail: 'hand_R',
    props: { wallCarry: 2.4, travel: [{ from: 4, to: 28, x: 3.0, z: 0 }] },
    cancels: ['pistonRush2'], cancelWindow: [27, 52],
  });
  mv({
    id: 'pistonRush2', name: 'Piston Terminus', input: 'ff+2,1', clip: 'p.hammerFist', tag: 'string',
    active: [W(19, 21, FIST_L(0.27))], total: 50,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
    adv: { block: -13, hit: 3 }, reaction: REACTION.KNOCKDOWN,
    knockback: [7.4, 1.2, 0], blockPush: [3.0, 0, 0], meterGain: 10,
    props: { wallCarry: 2.6, wallBounce: true },
  });
  mv({
    id: 'powerCrush', name: 'Bulwark Charge', input: 'f+1+2', clip: 'sp.chargeShoulder', tag: 'armor',
    active: [W(20, 23, [B('shoulder_R', 0.32, [0, -0.1, 0]), B('chest', 0.3, [0, 0, -0.16])])], total: 52,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 28,
    adv: { block: -9, hit: 4 }, reaction: REACTION.KNOCKDOWN,
    knockback: [7.0, 1.0, 0], blockPush: [4.0, 0, 0], meterGain: 12,
    props: { armorFrom: 8, armorTo: 23, armorScale: 0.55, wallCarry: 2.6, travel: [{ from: 8, to: 23, x: 4.6, z: 0 }] },
  });

  // --- evasion and defence -------------------------------------------------
  mv({
    id: 'evadeSpin', name: 'Phase Spiral', input: 'bb+3', clip: 'k.spinKick', tag: 'evade',
    active: [W(20, 22, FOOT_R(0.26))], total: 48,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 18,
    adv: { block: -8, hit: 4 }, reaction: REACTION.FLINCH_MID,
    knockback: [3.0, 0, 0], blockPush: [2.0, 0, 0], meterGain: 7, trail: 'foot_R',
    props: { invulnFrom: 4, invulnTo: 18, travel: [{ from: 0, to: 10, x: -3.0, z: 0 }] },
  });
  mv({
    id: 'counterStance', name: 'Reflex Guard', input: 'b+3+4', clip: 'sp.counterStance', tag: 'parry',
    active: [W(26, 28, FIST_R(0.28))], total: 58,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 26,
    adv: { block: -6, hit: 8 }, reaction: REACTION.CRUMPLE,
    knockback: [2.0, 0, 0], blockPush: [2.0, 0, 0], meterGain: 14,
    props: { parryFrom: 3, parryTo: 20, parryHeights: ['high', 'mid'], parryClip: 'sp.parrySuccess', parryRiposte: 22 },
  });

  // --- throws --------------------------------------------------------------
  //
  // THROWS DID EXIST AND THEY DID NOT COME OUT, and the reason was one line in
  // the matcher rather than anything in this block. `Fighter#pushInput` writes
  // one buffer entry per tick from `cmd.pressed`, which is edge-triggered, and
  // `matchesEntry` required every button of a notation token to live in that ONE
  // entry. So `1+2` demanded that both keys go down inside the same 16.7 ms
  // tick. Driven through `findMove` with a hand-built buffer:
  //
  //     1+2 on the same tick        -> throwFwd
  //     1 then 2, one tick apart    -> jab
  //     1 then 2, two ticks apart   -> jab
  //     b+1+2 split by two ticks    -> backfist
  //     f+1+3 split by two ticks    -> sideKick
  //
  // A player who is a single frame off gets a jab, which is exactly what "the
  // throws don't work" looks like from the seat. The fix is `CHORD_TICKS` down
  // in the matcher; the throws themselves were fine.
  //
  // The second defect was that a rejected grab still paid out as an unblockable
  // strike — see the `GRAB` note above.
  //
  // Still owed, and NOT expressible from this file (CombatSystem.js is another
  // agent's this round; the patch is in the handover):
  //   - `#findConnection` should return null outright for `props.throw`, so a
  //     grab can never resolve down the strike path.
  //   - `#resolveThrow` should refuse a crouching defender for a standing throw,
  //     which is what makes ducking a real answer to a throw loop.
  mv({
    id: 'throwFwd', name: 'Chassis Toss', input: '1+2', clip: 't.grabAttempt', tag: 'throw',
    active: [W(12, 14, GRAB())], total: 46,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 34,
    adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [4.0, 2.0, 0], meterGain: 12,
    props: {
      // 1.45 m against a 0.84 m minimum separation: the grab reaches about two
      // thirds of a body past the push-out, which is jab range. At the authored
      // 1.35 it only worked from a stance the push-out rarely leaves you in.
      throw: { type: 'forward', range: 1.45, breakWindow: [0, 19], breakButtons: [1, 2], clip: 't.throwForward', victimClip: 't.beingThrown', duration: 74 },
    },
  });
  mv({
    id: 'throwBack', name: 'Reactor Suplex', input: 'b+1+2', clip: 't.grabAttempt', tag: 'throw',
    active: [W(12, 14, GRAB())], total: 50,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 42,
    adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [-3.0, 2.4, 0], meterGain: 14,
    props: {
      throw: { type: 'back', range: 1.4, breakWindow: [0, 14], breakButtons: [1], clip: 't.throwBack', victimClip: 't.beingThrown', duration: 86 },
    },
  });

  // --- motion specials ------------------------------------------------------
  mv({
    id: 'rocketPunch', name: 'Rocket Lance', input: 'qcf+2', clip: 'sp.rocketPunch', tag: 'special',
    active: [W(18, 23, [B('hand_R', 0.26, [0, -0.1, 0], 0.9), B('elbow_R', 0.2, [0, 0, 0], 0.3)])], total: 56,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 27,
    adv: { block: -12, hit: 2 }, reaction: REACTION.KNOCKDOWN,
    knockback: [8.4, 1.2, 0], blockPush: [4.6, 0, 0], meterGain: 12, trail: 'hand_R',
    props: { wallBounce: true, wallCarry: 3.0 },
  });
  mv({
    id: 'plasmaBurst', name: 'Plasma Vent', input: 'qcb+1', clip: 'sp.plasmaBurst', tag: 'special',
    active: [W(22, 27, [B('hand_L', 0.34, [0, -0.16, 0]), B('chest', 0.28, [0, 0, -0.3])])], total: 58,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 25,
    adv: { block: -8, hit: 4 }, reaction: REACTION.STAGGER,
    knockback: [5.0, 0.8, 0], blockPush: [4.4, 0, 0], meterGain: 12,
    props: { homing: true },
  });
  // `contact: 9` is the whole fix for the one move that whiffed 4/4 at every
  // range after the strike-aim fix landed, and it is not a tuning number.
  //
  // `sp.risingFang` declares `impact: { tick: 14 }`. `retimeFor` PINS the clip's
  // declared contact onto the move's first active frame, so whatever tick the
  // window is authored on, the clip is in its frame-14 pose on it — and at clip
  // frame 14 this dragon punch has already left the ground and locked the arm
  // out overhead. Driven through the real sim and measured with the engine's own
  // `segSegDistSq`, at every one of the five active frames:
  //
  //     move tick   12      13      14      15      16
  //     clearance  +0.524  +0.778  +0.867  +0.913  +0.937   metres
  //     fist y      2.34    2.73    2.89    2.98    3.03     (head hurtbox 1.68)
  //
  // The fist is a metre and a quarter above the target and receding. That is why
  // cutting the forward lead did nothing and why no window could have fixed it:
  // the window was never the free variable. Sweeping the pinned clip frame
  // instead, at 0.9 / 1.02 / 1.2 m, worst clearance on the first active frame:
  //
  //     pinned clip frame   14 (clip)    8       9       10      11
  //     connections /4         0         3       3       3        3
  //     clearance @1.02 m   +0.524   -0.269  -0.270  -0.187  -0.162
  //     clearance @1.2  m   +0.563   -0.158  -0.167  -0.123  -0.037
  //     fist y at contact     2.34     1.68    1.73    1.93    2.04
  //     strike-aim solve      -55      -15     -16     -23     -28  deg
  //
  // 9 is the pick: the deepest clearance at the outer range, connecting on four
  // of the five active frames rather than one, and the fist 5 cm above a 1.68 m
  // head — an uppercut landing through the jaw. It also drops the aim solve from
  // -55 degrees, which is `AIM_LIMIT` clamping because the solve was reading a
  // near-vertical arm where the horizontal bearing is degenerate, to -16.
  //
  // 1.5 m is still a whiff by 7 cm and is left alone: this is a 12-frame reversal
  // launcher with no authored travel, and its short range is the cost of its
  // i1-i11 invulnerability. Closing it is a balance change, not a defect fix.
  mv({
    id: 'risingFang', name: 'Rising Fang', input: 'dp+1', clip: 'sp.risingFang', tag: 'reversalLauncher',
    active: [W(12, 16, [B('hand_L', 0.28, [0, -0.12, 0]), B('elbow_L', 0.22, [0, 0, 0])])], total: 56,
    contact: 9,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 23,
    adv: { block: -21, hit: 22 }, reaction: REACTION.LAUNCH, juggleHeight: 7.2,
    knockback: [1.2, 0, 0], blockPush: [1.4, 0, 0], meterGain: 12, trail: 'hand_R',
    props: { invulnFrom: 1, invulnTo: 11, airborne: [6, 34] },
  });
  mv({
    id: 'groundSpike', name: 'Fault Line', input: 'dd+3', clip: 'sp.groundSpike', tag: 'low',
    active: [W(24, 28, [B('hand_L', 0.3, [0, -0.06, 0], 0, 0.42), B('foot_R', 0.3, [0, -0.02, 0.3], 0, 0.5), B('knee_R', 0.26, [0, -0.04, 0.05], 0.44, 0.42), B('foot_L', 0.28, [0, -0.02, 0.1])])], total: 60,
    height: HEIGHT.LOW, weight: WEIGHT.HEAVY, damage: 27,
    adv: { block: -16, hit: 8 }, reaction: REACTION.SWEEP,
    knockback: [3.0, 2.2, 0], blockPush: [2.4, 0, 0], meterGain: 12,
    props: { crushHigh: true, groundBounce: 0.5 },
  });

  // --- overdrive -----------------------------------------------------------
  mv({
    // INPUT IS A BARE BUTTON, NOT `qcf+5`, AND THAT IS WHY OD DID NOTHING ON
    // MOBILE. The pad is wired correctly -- `.kbt-od` has its own touchstart
    // calling `#down(5)` -- but a tap sends the button with NO motion, so the
    // move could never match and the pad silently did nothing. The bug was in
    // the notation, not the control.
    //
    // A quarter-circle was also the wrong ask on glass by this file's own
    // reasoning: TouchControls' header says drawing a clean qcf with no tactile
    // feedback is "the single hardest thing to ask of a thumb", which is why
    // motions there are swipes rather than arcs. And it is wrong against the
    // reference too -- Tekken 8's Rage Art, the move this is modelled on, is a
    // single button press. It costs the full meter, so it cannot come out by
    // accident regardless of how easy the input is.
    id: 'overdrive', name: 'Overdrive Cascade', input: '5', clip: 'sp.overdriveStart', tag: 'super',
    active: [
      W(8, 11, [B('hand_R', 0.3, [0, -0.1, 0])], 18),
      W(20, 24, [B('hand_L', 0.32, [0, -0.1, 0])], 18),
      W(36, 42, [B('chest', 0.42, [0, 0, -0.34]), B('hand_R', 0.34, [0, -0.12, 0])], 34),
    ], total: 96,
    height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 18,
    adv: { block: -28, hit: 10 }, reaction: REACTION.CRUMPLE,
    knockback: [9.0, 2.6, 0], blockPush: [5.4, 0, 0], meterCost: METER_MAX, meterGain: 0,
    trail: 'hand_R',
    props: {
      super: true, invulnFrom: 1, invulnTo: 7, wallBounce: true, wallCarry: 3.4,
      travel: [{ from: 2, to: 18, x: 3.6, z: 0 }, { from: 30, to: 40, x: 4.4, z: 0 }],
      cinematic: { zoom: 1.35, slow: 0.35, slowTicks: 26 },
      finishClip: 'sp.overdriveFinish', hitClip: 'sp.overdriveHit',
    },
  });
}

// ---------------------------------------------------------------------------
// Archetype-exclusive moves
// ---------------------------------------------------------------------------

function standardExtras(mv, cfg, set) {
  mv({
    id: 'jetElbow', name: 'Jet Elbow', input: 'qcf+1', clip: 'sp.chargeShoulder', tag: 'special',
    active: [W(19, 21, ELBOW_R(0.28))], total: 48,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
    adv: { block: -7, hit: 6 }, reaction: REACTION.FLINCH_MID,
    knockback: [7.2, 0, 0], blockPush: [4.6, 0, 0], meterGain: 10,
    props: { wallCarry: 2.8, travel: [{ from: 6, to: 20, x: 5.4, z: 0 }] },
  });
  mv({
    id: 'lowSpin', name: 'Cutter Low', input: 'db+4', clip: 'k.lowKick', tag: 'low',
    active: [W(17, 18, SHIN_L(0.25))], total: 38,
    height: HEIGHT.LOW, weight: WEIGHT.MEDIUM, damage: 16,
    adv: { block: -11, hit: 3 }, reaction: REACTION.FLINCH_LOW,
    knockback: [2.0, 0, 0], blockPush: [1.6, 0, 0], meterGain: 5,
    props: { crushHigh: true }, cancels: ['lowSpin2'], cancelWindow: [17, 37],
  });
  mv({
    id: 'lowSpin2', name: 'Cutter Rise', input: 'db+4,3', clip: 'k.launcherKick', tag: 'string',
    active: [W(18, 20, FOOT_R(0.27))], total: 52,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 20,
    adv: { block: -17, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 5.8,
    knockback: [2.0, 0, 0], blockPush: [1.8, 0, 0], meterGain: 10,
  });
  mv({
    id: 'heelDrop', name: 'Heel Terminus', input: 'uf+4,4', clip: 'k.axeKick', tag: 'string',
    active: [W(20, 22, FOOT_L(0.28))], total: 52,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
    adv: { block: -14, hit: 2 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.0, -2.6, 0], blockPush: [2.2, 0, 0], meterGain: 9,
    props: { groundBounce: 0.7, hitsGrounded: true },
  });
  set.axeKick.cancels = ['heelDrop'];
  set.axeKick.cancelWindow = [set.axeKick.startup, set.axeKick.total - 2];
  mv({
    id: 'riseUpper', name: 'Coil Upper', input: 'd+1+2', clip: 'p.uppercut', tag: 'mid',
    active: [W(17, 19, FIST_R(0.25))], total: 44,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 20,
    adv: { block: -9, hit: 5 }, reaction: REACTION.FLINCH_MID,
    knockback: [2.0, 0, 0], blockPush: [2.0, 0, 0], meterGain: 8,
    props: { crushHigh: true, counterLaunch: { reaction: REACTION.LAUNCH, juggleHeight: 6.0, hitStun: 32 } },
  });
  mv({
    id: 'railKick', name: 'Rail Driver', input: 'ff+3', clip: 'k.sideKick', tag: 'rush',
    active: [W(18, 20, FOOT_L(0.29))], total: 44,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
    adv: { block: -10, hit: 3 }, reaction: REACTION.KNOCKDOWN,
    knockback: [9.0, 0.6, 0], blockPush: [5.8, 0, 0], meterGain: 9, trail: 'foot_L',
    props: { wallCarry: 3.2, wallBounce: true, travel: [{ from: 4, to: 19, x: 5.0, z: 0 }] },
  });
}

function heavyExtras(mv, cfg, set) {
  mv({
    id: 'siegeSlam', name: 'Siege Slam', input: 'dd+2', clip: 'p.siegeSlam', tag: 'unblockable',
    active: [W(46, 50, [B('hand_R', 0.34, [0, -0.08, 0]), B('hand_L', 0.34, [0, -0.08, 0])])], total: 86,
    height: HEIGHT.UNBLOCKABLE, weight: WEIGHT.ULTRA, damage: 44,
    adv: { block: 0, hit: 8 }, reaction: REACTION.CRUMPLE,
    knockback: [4.0, 1.0, 0], meterGain: 16,
    props: { armorFrom: 18, armorTo: 50, armorScale: 0.4, groundBounce: 0.8 },
  });
  mv({
    id: 'bulwarkRam', name: 'Siege Ram', input: 'ff+1+2', clip: 'sp.chargeShoulder', tag: 'armor',
    active: [W(24, 30, [B('shoulder_L', 0.34, [0, -0.1, 0]), B('chest', 0.34, [0, 0, -0.2])])], total: 62,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 32,
    adv: { block: -11, hit: 4 }, reaction: REACTION.KNOCKDOWN,
    knockback: [9.5, 1.2, 0], blockPush: [5.6, 0, 0], meterGain: 14,
    props: { armorFrom: 6, armorTo: 30, armorScale: 0.45, wallCarry: 3.4, wallBounce: true, travel: [{ from: 6, to: 30, x: 5.2, z: 0 }] },
  });
  mv({
    id: 'quakeStomp', name: 'Quake Stomp', input: 'd+3+4,3', clip: 'k.stomp', tag: 'string',
    active: [W(22, 25, [B('foot_L', 0.34, [0, -0.04, 0.04]), B('knee_L', 0.28, [0, -0.04, 0.04], 0.4), B('hand_L', 0.28, [0, -0.05, 0])])], total: 56,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 26,
    adv: { block: -18, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [2.0, -2.6, 0], blockPush: [2.4, 0, 0], meterGain: 10,
    props: { hitsGrounded: true, groundBounce: 0.5 },
  });
  set.stomp.cancels = ['quakeStomp'];
  set.stomp.cancelWindow = [set.stomp.startup, set.stomp.total - 2];
  mv({
    id: 'grinderLow', name: 'Grinder Low', input: 'db+1+2', clip: 'sp.groundSpike', tag: 'low',
    active: [W(24, 27, [B('hand_L', 0.3, [0, -0.06, 0.16], 0, 0.4), B('knee_R', 0.26, [0, -0.04, 0.04], 0.44), B('foot_R', 0.28, [0, -0.02, 0.1])])], total: 58,
    height: HEIGHT.LOW, weight: WEIGHT.HEAVY, damage: 28,
    adv: { block: -15, hit: 5 }, reaction: REACTION.SWEEP,
    knockback: [3.4, 1.6, 0], blockPush: [2.6, 0, 0], meterGain: 12,
    props: { armorFrom: 8, armorTo: 24, armorScale: 0.5, crushHigh: true },
  });
  mv({
    id: 'titanGrab', name: 'Titan Clamp', input: 'f+1+3', clip: 't.grabAttempt', tag: 'throw',
    active: [W(16, 19, GRAB())], total: 56,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 48,
    adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.0, 3.0, 0], meterGain: 16,
    // A command throw pays for its damage with a one-button escape: `1` only,
    // where the two generic throws take either punch. Reach 1.8 m — a siege
    // frame's arms are the reason to respect its walk-forward.
    props: { throw: { type: 'command', range: 1.8, breakWindow: [0, 12], breakButtons: [1], clip: 't.throwForward', victimClip: 't.beingThrown', duration: 96 } },
  });
  mv({
    id: 'meteorDrop', name: 'Meteor Drop', input: 'uf+1+2', clip: 'p.overhand', tag: 'heavy',
    active: [W(26, 29, [B('hand_R', 0.34, [0, -0.08, 0]), B('hand_L', 0.3, [0, -0.08, 0])])], total: 62,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 34,
    adv: { block: -14, hit: 2 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.0, -3.4, 0], blockPush: [3.0, 0, 0], meterGain: 13,
    props: { crushLow: true, airborne: [8, 30], groundBounce: 0.9, hitsGrounded: true },
  });
}

function agileExtras(mv, cfg, set) {
  mv({
    id: 'flurry', name: 'Needle Flurry', input: '1,1', clip: 'p.jabAlt', tag: 'string',
    active: [W(9, 10, FIST_L(0.19))], total: 22,
    height: HEIGHT.HIGH, weight: WEIGHT.LIGHT, damage: 7,
    adv: { block: 0, hit: 7 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [1.0, 0, 0], blockPush: [0.6, 0, 0], meterGain: 3,
    cancels: ['flurry2'], cancelWindow: [9, 21],
  });
  mv({
    id: 'flurry2', name: 'Needle Terminus', input: '1,1,2', clip: 'p.backfist', tag: 'string',
    active: [W(11, 12, FIST_L(0.22))], total: 34,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 15,
    adv: { block: -6, hit: 6 }, reaction: REACTION.FLINCH_MID,
    knockback: [3.4, 0, 0], blockPush: [2.0, 0, 0], meterGain: 6,
  });
  set.jab.cancels = ['flurry', 'jab2', 'jabLow'];
  mv({
    id: 'diveKick', name: 'Falcon Dive', input: 'd+4', clip: 'k.diveKick', tag: 'air',
    active: [W(8, 16, FOOT_R(0.26))], total: 36,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 18,
    adv: { block: -5, hit: 4 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.0, -1.4, 0], blockPush: [2.6, 0, 0], meterGain: 7, trail: 'foot_R',
    props: { requireAir: true, travel: [{ from: 2, to: 16, x: 5.0, z: 0 }] },
  });
  mv({
    id: 'phaseStep', name: 'Phase Step', input: 'bb+1', clip: 'p.backfist', tag: 'evade',
    active: [W(16, 17, FIST_L(0.23))], total: 40,
    height: HEIGHT.HIGH, weight: WEIGHT.MEDIUM, damage: 15,
    adv: { block: -5, hit: 7 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [3.4, 0, 0], blockPush: [1.8, 0, 0], meterGain: 8,
    props: { invulnFrom: 1, invulnTo: 14, travel: [{ from: 0, to: 8, x: -5.0, z: 0 }, { from: 9, to: 16, x: 4.0, z: 0 }] },
  });
  mv({
    id: 'heelSlice', name: 'Heel Slice', input: 'db+4', clip: 'k.sweep', tag: 'low',
    active: [W(14, 15, [...SHIN_L(0.24), B('hand_L', 0.23, [0, -0.05, 0])])], total: 34,
    height: HEIGHT.LOW, weight: WEIGHT.LIGHT, damage: 12,
    adv: { block: -10, hit: 3 }, reaction: REACTION.FLINCH_LOW,
    knockback: [1.6, 0, 0], blockPush: [1.2, 0, 0], meterGain: 5,
    props: { crushHigh: true },
  });
  mv({
    id: 'whirlwind', name: 'Whirlwind Arc', input: 'qcb+4', clip: 'k.roundhouse', tag: 'special',
    active: [W(18, 22, [B('foot_L', 0.3, [0, -0.02, 0.05]), B('foot_R', 0.28, [0, -0.02, 0.05]), B('hand_R', 0.26, [0, -0.05, 0], 0, 0.38)])], total: 50,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 23,
    adv: { block: -9, hit: 3 }, reaction: REACTION.SPIN,
    knockback: [5.6, 1.4, 0], blockPush: [3.0, 0, 0], meterGain: 11, trail: 'foot_L',
    props: { homing: true, wallCarry: 2.4 },
  });
  mv({
    id: 'shadowRush', name: 'Shadow Rush', input: 'ff+3', clip: 'k.spinKick', tag: 'rush',
    active: [W(16, 18, FOOT_R(0.27))], total: 46,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 21,
    adv: { block: -11, hit: 4 }, reaction: REACTION.SPIN,
    knockback: [6.0, 1.2, 0], blockPush: [2.8, 0, 0], meterGain: 9,
    props: { wallCarry: 2.2, travel: [{ from: 4, to: 16, x: 4.4, z: 0 }] },
    cancels: ['shadowRush2'], cancelWindow: [16, 45],
  });
  mv({
    id: 'shadowRush2', name: 'Shadow Terminus', input: 'ff+3,4', clip: 'k.axeKick', tag: 'string',
    active: [W(17, 19, FOOT_L(0.27))], total: 48,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 22,
    adv: { block: -13, hit: 2 }, reaction: REACTION.KNOCKDOWN,
    knockback: [4.4, -1.6, 0], blockPush: [2.4, 0, 0], meterGain: 10,
    props: { groundBounce: 0.6 },
  });
}

function technicalExtras(mv, cfg, set) {
  mv({
    id: 'reversalStance', name: 'Mirror Protocol', input: 'b+1+3', clip: 'sp.counterStance', tag: 'parry',
    active: [W(20, 22, ELBOW_R(0.28))], total: 50,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 22,
    adv: { block: -4, hit: 9 }, reaction: REACTION.STAGGER,
    knockback: [2.6, 0, 0], blockPush: [1.6, 0, 0], meterGain: 16,
    props: { parryFrom: 2, parryTo: 16, parryHeights: ['high', 'mid', 'low'], parryClip: 'sp.parrySuccess', parryRiposte: 16 },
  });
  mv({
    id: 'hellsweep', name: 'Fracture Sweep', input: 'db+4', clip: 'k.sweep', tag: 'low',
    active: [W(18, 19, [...SHIN_L(0.26), B('hand_L', 0.24, [0, -0.05, 0])])], total: 42,
    height: HEIGHT.LOW, weight: WEIGHT.MEDIUM, damage: 18,
    adv: { block: -13, hit: 4 }, reaction: REACTION.FLINCH_LOW,
    knockback: [2.2, 0, 0], blockPush: [1.8, 0, 0], meterGain: 7,
    props: { crushHigh: true }, cancels: ['hellsweep2'], cancelWindow: [18, 41],
  });
  mv({
    id: 'hellsweep2', name: 'Fracture Ascent', input: 'db+4,4', clip: 'k.launcherKick', tag: 'string',
    active: [W(17, 19, FOOT_R(0.28))], total: 54,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 22,
    adv: { block: -19, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 6.4,
    knockback: [2.2, 0, 0], blockPush: [2.0, 0, 0], meterGain: 11,
  });
  mv({
    id: 'homingBlade', name: 'Tracking Blade', input: 'f+3+4', clip: 'k.roundhouse', tag: 'mid',
    active: [W(19, 22, FOOT_R(0.29))], total: 46,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
    adv: { block: -6, hit: 5 }, reaction: REACTION.FLINCH_MID,
    knockback: [4.6, 0, 0], blockPush: [3.0, 0, 0], meterGain: 10, trail: 'foot_R',
    props: { homing: true, wallCarry: 1.8 },
  });
  mv({
    id: 'orbitalKick', name: 'Orbital Arc', input: 'qcf+4', clip: 'k.launcherKick', tag: 'launcher',
    active: [W(20, 23, FOOT_R(0.29))], total: 56,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 24,
    adv: { block: -15, hit: 22 }, reaction: REACTION.LAUNCH, juggleHeight: 7.0,
    knockback: [3.0, 0, 0], blockPush: [2.4, 0, 0], meterGain: 12, trail: 'foot_R',
    props: { homing: true, airborne: [8, 28] },
  });
  mv({
    id: 'mindReader', name: 'Predict Sequence', input: 'b+2,1', clip: 'p.hook', tag: 'string',
    active: [W(15, 16, FIST_L(0.24))], total: 36,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 16,
    adv: { block: -3, hit: 7 }, reaction: REACTION.FLINCH_MID,
    knockback: [2.4, 0, 0], blockPush: [1.4, 0, 0], meterGain: 6,
    cancels: ['mindReader2'], cancelWindow: [15, 35],
  });
  mv({
    id: 'mindReader2', name: 'Predict Terminus', input: 'b+2,1,2', clip: 'p.launcherPunch', tag: 'string',
    active: [W(18, 20, FIST_R(0.26))], total: 50,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 21,
    adv: { block: -18, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 6.0,
    knockback: [1.8, 0, 0], blockPush: [1.8, 0, 0], meterGain: 10,
  });
  set.overhand.cancels = ['mindReader'];
  set.overhand.cancelWindow = [set.overhand.startup, set.overhand.total - 2];
}

// ---------------------------------------------------------------------------
// Archetype configuration
// ---------------------------------------------------------------------------

/**
 * `shift` moves every startup and total by the same amount, so archetypes differ
 * in speed without differing in safety. `power` and `reach` pay for that speed.
 */
const ARCHETYPES = {
  standard: {
    key: 'standard', label: 'Vanguard', shift: 0, power: 1.0, reach: 1.0, launch: 1.0,
    extras: standardExtras,
    names: {},
    clips: {},
  },
  heavy: {
    key: 'heavy', label: 'Bulwark', shift: 2, power: 1.3, reach: 1.09, launch: 0.94,
    extras: heavyExtras,
    names: {
      jab: 'Hammer Jab', straight: 'Girder Straight', elbow: 'Ram Elbow',
      midKick: 'Piledriver Kick', launcherPunch: 'Foundry Upper',
      launcherKick: 'Derrick Kick', evadeSpin: 'Weight Shift',
      counterStance: 'Ablative Guard', rocketPunch: 'Demolition Lance',
      plasmaBurst: 'Furnace Vent', overdrive: 'Overdrive: Foundry Collapse',
    },
    clips: { midPunch: 'p.hammerFist', backfist: 'p.overhand' },
    // p.overhand throws the right hand; the base backfist anchors the left.
    mirrorBoxes: ['backfist'],
  },
  agile: {
    key: 'agile', label: 'Wraith', shift: -1, power: 0.84, reach: 0.93, launch: 1.06,
    extras: agileExtras,
    names: {
      jab: 'Needle Jab', straight: 'Filament Straight', elbow: 'Razor Elbow',
      midKick: 'Scythe Kick', highKick: 'Talon High', launcherPunch: 'Kite Upper',
      launcherKick: 'Skyhook', sweep: 'Wire Sweep', evadeSpin: 'Ghost Spiral',
      counterStance: 'Read Protocol', rocketPunch: 'Harpoon Line',
      plasmaBurst: 'Ion Spray', overdrive: 'Overdrive: Thousand Cuts',
    },
    clips: { midPunch: 'p.jabAlt', hammerFist: 'p.backfist', spinKick: 'k.spinKick' },
    // p.jabAlt throws the left hand; the base midPunch anchors the right elbow.
    mirrorBoxes: ['midPunch'],
  },
  technical: {
    key: 'technical', label: 'Arbiter', shift: 0, power: 0.94, reach: 0.99, launch: 1.0,
    extras: technicalExtras,
    names: {
      jab: 'Calibration Jab', straight: 'Vector Straight', elbow: 'Angle Elbow',
      midPunch: 'Data Check', midKick: 'Protocol Kick', launcherPunch: 'Solve Upper',
      launcherKick: 'Vertex Kick', sweep: 'Basis Sweep', evadeSpin: 'Sidestep Arc',
      counterStance: 'Counter Protocol', rocketPunch: 'Lance Algorithm',
      plasmaBurst: 'Field Collapse', overdrive: 'Overdrive: Total Solution',
    },
    clips: { overhand: 'p.overhand', hammerFist: 'p.uppercut' },
  },
};

/** Build one archetype's move table and precompute matching metadata. */
function buildMoveSet(cfg) {
  const out = Object.create(null);
  const mv = (spec) => {
    const m = make(spec, cfg);
    if (out[m.id]) throw new Error(`duplicate move id ${cfg.key}/${m.id}`);
    out[m.id] = m;
    return m;
  };
  coreMoves(mv, cfg);
  cfg.extras(mv, cfg, out);

  // Root moves, most specific first, so "df+2" is tested before "2".
  const ordered = Object.values(out)
    .filter((m) => !m.followUp)
    .sort((a, b) => (b.parsed.score - a.parsed.score) || (a.startup - b.startup));
  Object.defineProperty(out, '__ordered', { value: ordered, enumerable: false });
  Object.defineProperty(out, '__label', { value: cfg.label, enumerable: false });
  return out;
}

// ---------------------------------------------------------------------------
// Per-character signature layers
// ---------------------------------------------------------------------------

/**
 * Ten fighters shared four move tables, so any two machines on the same
 * archetype played *identically* — VULKAN and BASTION are a furnace and a door
 * and they had the same 52 moves with the same numbers. This layer closes that.
 *
 * Each function below is merged over its character's archetype table at load.
 * `mv()` adds a move, and adds it under an id that already exists to OVERRIDE
 * that move — ANVIL replaces the generic `throwFwd`, BASTION replaces the
 * generic `counterStance`, and the archetype tables are untouched because the
 * character table copies the references before it writes. `chain()` clones a
 * base move before hanging a cancel off it, for the same reason: mutating
 * `set.elbow` in place would give every heavy character VULKAN's string.
 *
 * A character that declares nothing gets its archetype table verbatim.
 *
 * Design rules these obey, because a signature that is just another button is
 * not a signature:
 *
 *  - Every one is a motion input or a multi-step string. Motions are `qcf`,
 *    `qcb`, `dp` — the four the touch pad can draw as swipes — so a signature is
 *    reachable on glass as well as on a keyboard. `hcf`, `ff` and `bb` are
 *    deliberately unused here: TouchControls only recognises the first four.
 *  - Every one comes out of the machine. The stats and the bio pick the move:
 *    a courier frame gets the plus-on-block advancing knee, a substation rig
 *    gets the 50/50 off an arc, a door gets the only armoured plus-frame check
 *    in the cast, and the dockyard lifting rig gets the second command throw.
 *  - The balance invariants at the top of this file still hold. Every launcher
 *    here is -13 or worse, every low is minus, and the two moves that are plus
 *    on block (KESTREL's Slipstream, BASTION's Blast Door) pay for it in damage
 *    and push-out exactly as the invariant requires.
 *
 * Frame data is authored PRE-SHIFT, like everything else: `make()` applies the
 * archetype's startup shift, power, reach and launch scaling on the way in, so
 * VULKAN's signature is a heavy move and KESTREL's is an agile one without
 * either being written twice.
 */
/**
 * The rule every finisher in the game shares, so it is one thing to learn.
 *
 * A finisher is a window you can MISS — that is the whole difference between it
 * and the overdrive, which is a resource you spend. `CombatSystem` opens the
 * window once per fighter per round the tick the opponent drops under 20% on a
 * round that can decide the match, `Fighter` recognises the sequence, and both
 * halves of the rule live here: `condition` and `sequenceText` are rendered on
 * screen verbatim, `healthPct` / `finalRoundOnly` / `window` drive the engine.
 * See docs/CONTRACT-character-moves.md.
 *
 * Uniform on purpose. Ten different opening conditions would be ten things to
 * memorise before anyone saw a single finisher; the identity is in the sequence,
 * the machine and what it does, not in the paperwork.
 *
 * 130 ticks is 2.2 seconds for a four-step sequence — long enough to think, far
 * too short to stumble into. `window` being finite is the point.
 */
const FINISH_RULE = {
  condition: 'Opponent below 20% health, on a round that can win the match',
  healthPct: 0.2,
  finalRoundOnly: true,
  window: 130,
};

/**
 * A finisher's shared frame shape. Ten of these differ in clip, hitbox, damage,
 * sequence and follow-through — not in how long they take, because a finisher
 * that is faster than another finisher is a balance decision nobody asked for.
 *
 * `travel` is deliberate and is not a gimmick: the sequence is entered from
 * neutral at whatever range the round happened to end at, so a finisher that
 * could whiff would be a two-second animation of missing. It closes the gap.
 */
const FIN_TRAVEL = [{ from: 4, to: 34, x: 5.0, z: 0 }];

const CHARACTER_EXTRAS = {
  // --- VULKAN — forge-born, power 10, speed 3 -------------------------------
  // The furnace never backs up. Both signatures commit forward through armour
  // and both are punishable if they are wrong; nothing here retreats.
  vulkan(mv, cfg, set, chain) {
    mv({
      id: 'slagVent', name: 'Slag Vent', input: 'qcb+2', clip: 'sp.plasmaBurst', tag: 'special',
      desc: 'Dumps the chest furnace forward through armour: walks into a jab, staggers on hit, and shoves a blocker most of a body away.',
      active: [W(24, 29, [B('hand_L', 0.34, [0, -0.16, 0]), B('chest', 0.3, [0, 0, -0.3])])], total: 62,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 30,
      adv: { block: -9, hit: 6 }, reaction: REACTION.STAGGER,
      knockback: [4.2, 0.6, 0], blockPush: [5.6, 0, 0], meterGain: 13,
      // Twenty frames of armour on a 32-frame recovery: it walks through a jab
      // to open the chest, and loses the round to anything that waits for it.
      props: { armorFrom: 6, armorTo: 26, armorScale: 0.5, wallCarry: 2.0 },
    });
    mv({
      id: 'pourOff', name: 'Pour-Off', input: 'f+2,1', clip: 'p.overhand', tag: 'string',
      desc: 'Follow the drive elbow with an overhand that staggers rather than knocks down, so the string can keep going.',
      active: [W(18, 20, [B('hand_R', 0.27, [0, -0.05, 0], 0, 0.36), B('wrist_R', 0.22, [0, -0.04, 0], 0, 0.34)])], total: 46,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
      adv: { block: -10, hit: 4 }, reaction: REACTION.STAGGER,
      knockback: [3.2, 0, 0], blockPush: [2.6, 0, 0], meterGain: 9, trail: 'hand_R',
      props: { wallCarry: 1.6 },
      cancels: ['tapOut'], cancelWindow: [18, 44],
    });
    mv({
      id: 'tapOut', name: 'Tap Out', input: 'f+2,1,2', clip: 'p.siegeSlam', tag: 'string',
      desc: 'The string ender. Armoured, crumples on hit, floor-bounces for a pickup, and -16 if they block it.',
      active: [W(24, 27, [B('hand_R', 0.34, [0, -0.08, 0]), B('hand_L', 0.34, [0, -0.08, 0])])], total: 62,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 32,
      adv: { block: -16, hit: 2 }, reaction: REACTION.CRUMPLE,
      knockback: [4.0, 1.0, 0], blockPush: [3.4, 0, 0], meterGain: 14,
      props: { armorFrom: 10, armorTo: 27, armorScale: 0.6, groundBounce: 0.7 },
    });
    chain('elbow', ['pourOff']);
    // The furnace is the character, so the finisher is the furnace opened all the way. Longest active window of the ten — it is a pour, not a blow.
    mv({
      id: 'bessemerPour', name: 'Bessemer Pour', input: 'd,b,d,2', clip: 'sp.plasmaBurst', tag: 'finisher',
      desc: 'Tips the chest furnace over them and holds it there. Twelve active frames of molten pour; the follow-through is VULKAN charging its own reactor back up.',
      active: [W(28, 40, [B('hand_L', 0.4, [0, -0.16, 0]), B('chest', 0.36, [0, 0, -0.32])])], total: 112,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 96,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Down, Back, Down, RP' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.45, slow: 0.26, slowTicks: 52 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.saluteCharge',
      },
    });
  },

  // --- KESTREL — courier, speed 10, weight 3 --------------------------------
  // Arrives first. The identity is frame advantage from movement rather than
  // damage: the only plus-on-block advancing mid in the cast, paid for with 11
  // damage and a block push that ends the pressure it just earned.
  kestrel(mv, cfg, set, chain) {
    mv({
      id: 'slipstream', name: 'Slipstream', input: 'qcf+3', clip: 'k.kneeStrike', tag: 'rush',
      desc: 'Closes half the screen and is PLUS on block — the only advancing mid in the cast that is. It does almost no damage and shoves them out again.',
      active: [W(17, 18, KNEE_R(0.24))], total: 34,
      height: HEIGHT.MID, weight: WEIGHT.LIGHT, damage: 13,
      adv: { block: 2, hit: 8 }, reaction: REACTION.FLINCH_MID,
      knockback: [1.0, 0, 0], blockPush: [3.8, 0, 0], meterGain: 6,
      props: { crushLow: true, travel: [{ from: 4, to: 16, x: 5.2, z: 0 }] },
      cancels: ['slipstream2'], cancelWindow: [17, 32],
    });
    mv({
      id: 'slipstream2', name: 'Overtake', input: 'qcf+3,4', clip: 'k.spinKick', tag: 'string',
      desc: 'Spinning high off the slipstream. Carries to the wall; duckable, and -12 if it is.',
      active: [W(20, 22, [...FOOT_R(0.27), B('hand_R', 0.24, [0, -0.05, 0])])], total: 50,
      height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 22,
      adv: { block: -12, hit: 4 }, reaction: REACTION.SPIN,
      knockback: [6.0, 1.2, 0], blockPush: [3.0, 0, 0], meterGain: 10, trail: 'foot_R',
      props: { wallCarry: 2.2 },
    });
    mv({
      id: 'coolantLance', name: 'Coolant Lance', input: 'qcb+2', clip: 'p.duckingStraight', tag: 'evade',
      desc: 'Ducks under a high with ten frames of real invulnerability and answers it. Launches on counter-hit. Loses clean to a low.',
      active: [W(15, 16, FIST_R(0.24))], total: 42,
      height: HEIGHT.MID, weight: WEIGHT.LIGHT, damage: 15,
      adv: { block: -11, hit: 5 }, reaction: REACTION.FLINCH_MID,
      knockback: [2.4, 0, 0], blockPush: [1.8, 0, 0], meterGain: 7, trail: 'hand_R',
      // Ten frames of outright invulnerability on an i14 move, bought with 25
      // frames of recovery and -11: it beats a high, and it loses to a low.
      props: { crushHigh: true, invulnFrom: 3, invulnTo: 12, counterLaunch: { reaction: REACTION.LAUNCH, juggleHeight: 5.6, hitStun: 30 } },
    });
    // Three windows on the three-hit rush clip, anchored L,R,R exactly as `pistonRush` is, because that is the order p.pistonRush actually throws them.
    mv({
      id: 'terminalVelocity', name: 'Terminal Velocity', input: 'f,b,f,3', clip: 'p.pistonRush', tag: 'finisher',
      desc: 'Arrives from three places at once. Three separate impacts down the same line, each one faster than the last, and KESTREL is already posing before the last one lands.',
      active: [
        W(26, 27, FIST_L(0.3), 30),
        W(32, 33, FIST_R(0.3), 34),
        W(40, 45, FIST_R(0.38), 58),
      ], total: 108,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 122,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Forward, Back, Forward, LK' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.5, slow: 0.24, slowTicks: 48 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.pose',
      },
    });
  },

  // --- ANVIL — dockyard lifting rig, weight 10, the grappler ----------------
  // "Never learned a strike it liked more than a hug." It is the only machine in
  // the cast with two command grabs, and its generic forward throw is REPLACED
  // rather than added to — the override path, demonstrated on the character the
  // feature exists for.
  anvil(mv, cfg, set, chain) {
    mv({
      id: 'throwFwd', name: 'Industrial Embrace', input: '1+2', clip: 't.grabAttempt', tag: 'throw',
      desc: 'ANVIL\'s grab, not the standard one: longer reach, more damage, and five fewer frames to break it.',
      active: [W(12, 14, GRAB())], total: 48,
      height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 40,
      adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
      knockback: [4.4, 2.2, 0], meterGain: 14,
      props: { throw: { type: 'forward', range: 1.7, breakWindow: [0, 14], breakButtons: [1, 2], clip: 't.throwForward', victimClip: 't.beingThrown', duration: 82 } },
    });
    mv({
      id: 'dockClamp', name: 'Dock Clamp', input: 'qcf+1', clip: 't.grabAttempt', tag: 'throw',
      desc: 'A command throw with the longest reach in the game and a ten-frame break window. This is why you do not stand in front of ANVIL.',
      active: [W(18, 21, GRAB())], total: 60,
      height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 46,
      adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
      knockback: [4.0, 2.6, 0], meterGain: 18,
      props: { throw: { type: 'command', range: 1.95, breakWindow: [0, 10], breakButtons: [1], clip: 't.throwForward', victimClip: 't.beingThrown', duration: 102 } },
    });
    mv({
      id: 'counterweight', name: 'Counterweight', input: 'qcb+2', clip: 'sp.chargeShoulder', tag: 'armor',
      desc: 'Armoured, homing body check that wall-bounces. Built to close the gap the grabs need closed.',
      active: [W(22, 26, [B('shoulder_R', 0.34, [0, -0.1, 0]), B('chest', 0.32, [0, 0, -0.18])])], total: 58,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 28,
      adv: { block: -10, hit: 4 }, reaction: REACTION.KNOCKDOWN,
      knockback: [8.0, 1.0, 0], blockPush: [5.0, 0, 0], meterGain: 14,
      // The answer to a machine that has to close the gap: armoured, homing, and
      // it carries the opponent to the wall the grabs want them against.
      props: { armorFrom: 6, armorTo: 26, armorScale: 0.5, homing: true, wallCarry: 3.0, wallBounce: true, travel: [{ from: 6, to: 26, x: 3.6, z: 0 }] },
    });
    // The dockyard rig's finisher is a lift and a drop, which is the one thing it was actually built to do.
    mv({
      id: 'loadTest', name: 'Load Test', input: 'b,d,f,1', clip: 'p.siegeSlam', tag: 'finisher',
      desc: 'Picks the opponent up, reads the number off the load cell, and puts them through the floor. ANVIL files the result.',
      active: [W(34, 40, [B('hand_R', 0.42, [0, -0.08, 0]), B('hand_L', 0.42, [0, -0.08, 0])])], total: 116,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 104,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Back, Down, Forward, LP' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.35, slow: 0.22, slowTicks: 54 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.systemsNominal',
      },
    });
  },

  // --- SERAPH — choir-drone, reach 9, defense 4 -----------------------------
  // "Considers the ring an acoustically interesting room." Holds the room at
  // arm's length and punishes anyone who tries to come over the top of it.
  seraph(mv, cfg, set, chain) {
    mv({
      id: 'chorale', name: 'Chorale Line', input: 'qcb+3', clip: 'k.sideKick', tag: 'poke',
      desc: 'The longest poke in the game that does not travel. -4 on block and it pushes them back out to where SERAPH wants them.',
      // Authored fwd 0.46 against the 0.31 default for a foot: this is the
      // longest non-travelling poke in the game, which is what reach 9 means.
      active: [W(20, 22, [B('foot_L', 0.3, [0, -0.02, 0.04], 0, 0.46), B('ankle_L', 0.25, [0, 0, 0], 0, 0.44)])], total: 44,
      height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 22,
      adv: { block: -4, hit: 5 }, reaction: REACTION.FLINCH_MID,
      knockback: [7.0, 0, 0], blockPush: [5.2, 0, 0], meterGain: 8, trail: 'foot_L',
      props: { wallCarry: 2.4 },
      cancels: ['chorale2'], cancelWindow: [20, 42],
    });
    mv({
      id: 'chorale2', name: 'Antiphon', input: 'qcb+3,4', clip: 'k.axeKick', tag: 'string',
      desc: 'Axe-kick ender off the chorale. Hops over lows, floor-bounces, and is -14 for the privilege.',
      active: [W(20, 22, FOOT_L(0.29))], total: 52,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 26,
      adv: { block: -14, hit: 2 }, reaction: REACTION.KNOCKDOWN,
      knockback: [2.4, -2.0, 0], blockPush: [2.4, 0, 0], meterGain: 10, trail: 'foot_L',
      props: { crushLow: true, groundBounce: 0.6, airborne: [8, 24] },
    });
    mv({
      id: 'descant', name: 'Descant', input: 'dp+3', clip: 'k.launcherKick', tag: 'reversalLauncher',
      desc: 'Anti-air reversal: invulnerable for its first thirteen frames, full launch on hit, -19 if it does not.',
      active: [W(14, 17, FOOT_R(0.28))], total: 54,
      height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 21,
      adv: { block: -19, hit: 22 }, reaction: REACTION.LAUNCH, juggleHeight: 7.4,
      knockback: [2.2, 0, 0], blockPush: [2.0, 0, 0], meterGain: 12, trail: 'foot_R',
      props: { invulnFrom: 1, invulnTo: 13, airborne: [6, 30] },
    });
    // Reach 9 gets the longest capsule in the game: a 1.1 m lance down the arm rather than a fist.
    mv({
      id: 'finalCadence', name: 'Final Cadence', input: 'd,f,b,1', clip: 'sp.rocketPunch', tag: 'finisher',
      desc: 'Resolves the chord. A single lance of cold light the length of the room, held long enough for the interval to close.',
      active: [W(30, 38, [B('hand_R', 0.32, [0, -0.1, 0], 1.1), B('elbow_R', 0.26, [0, 0, 0], 0.34)])], total: 110,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 88,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Down, Forward, Back, LP' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.55, slow: 0.28, slowTicks: 50 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.pose',
      },
    });
  },

  // --- RONIN-07 — bodyguard line, precision frame ---------------------------
  // One draw, one return cut, one diagonal. The whole kit is built around the
  // counter-hit: the draw crumples anything that presses a button into it, and
  // the return cut is the only wall-bouncing string ender a technical frame has.
  ronin(mv, cfg, set, chain) {
    mv({
      id: 'iaiDraw', name: 'Iai Draw', input: 'qcf+1', clip: 'p.backfist', tag: 'special',
      desc: 'The draw cut. Crumples anything that pressed a button into it; a plain high otherwise, and duckable.',
      active: [W(20, 22, [B('hand_L', 0.28, [0, -0.05, 0], 0, 0.36), B('wrist_L', 0.22, [0, -0.04, 0], 0, 0.34)])], total: 50,
      height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 24,
      adv: { block: -9, hit: 5 }, reaction: REACTION.FLINCH_HIGH,
      knockback: [4.0, 0, 0], blockPush: [2.4, 0, 0], meterGain: 10, trail: 'hand_L',
      props: { counterLaunch: { reaction: REACTION.CRUMPLE, hitStun: 52 } },
      cancels: ['iaiNoto'], cancelWindow: [20, 48],
    });
    mv({
      id: 'iaiNoto', name: 'Noto', input: 'qcf+1,2', clip: 'p.straight', tag: 'string',
      desc: 'The return cut off the draw. Wall-bounces for the follow-up, -13 on block.',
      active: [W(14, 16, FIST_R(0.26))], total: 46,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 26,
      adv: { block: -13, hit: 6 }, reaction: REACTION.KNOCKDOWN,
      knockback: [5.6, 1.0, 0], blockPush: [2.8, 0, 0], meterGain: 11, trail: 'hand_R',
      props: { wallBounce: true, wallCarry: 2.6 },
    });
    mv({
      id: 'kesaLine', name: 'Kesa Line', input: 'qcb+2', clip: 'p.overhand', tag: 'mid',
      desc: 'The diagonal. Floor-bounces on hit, crumples on counter-hit, and stays -11 either way.',
      active: [W(22, 24, [B('hand_R', 0.28, [0, -0.05, 0], 0, 0.36), B('wrist_R', 0.23, [0, -0.04, 0], 0, 0.34)])], total: 50,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 27,
      adv: { block: -11, hit: 3 }, reaction: REACTION.KNOCKDOWN,
      knockback: [3.0, 1.2, 0], blockPush: [2.6, 0, 0], meterGain: 10, trail: 'hand_R',
      props: { groundBounce: 0.5, counterLaunch: { reaction: REACTION.CRUMPLE, hitStun: 48 } },
    });
    // Six frames active and nothing else. The shortest finisher window of the ten, on the machine whose entire kit is one decision made correctly.
    mv({
      id: 'seventhSerial', name: 'Seventh Serial', input: 'b,f,d,2', clip: 'p.overhand', tag: 'finisher',
      desc: 'One cut, straight down, and then RONIN-07 etches an eighth number inside its forearm.',
      active: [W(30, 35, [B('hand_R', 0.34, [0, -0.05, 0], 0, 0.42), B('wrist_R', 0.28, [0, -0.04, 0], 0, 0.4)])], total: 106,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 92,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Back, Forward, Down, RP' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.6, slow: 0.25, slowTicks: 46 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.pose',
      },
    });
  },

  // --- MANTIS — pest control, reach 8, defense 3 ----------------------------
  // "Holds still for exactly as long as it takes you to relax." The signature is
  // one string that forks at the end into a low and a launcher off the same two
  // frames, which is the entire reason a rushdown frame is frightening. It has
  // the worst defence in the cast and no evasive option: it wins by guessing
  // right on the third hit.
  mantis(mv, cfg, set, chain) {
    mv({
      id: 'raptorRake', name: 'Raptor Rake', input: 'qcf+1', clip: 'p.jabAlt', tag: 'poke',
      desc: 'i11 high that is 0 on block. The opener; on its own it is worth nothing.',
      active: [W(12, 13, FIST_L(0.22))], total: 28,
      height: HEIGHT.HIGH, weight: WEIGHT.LIGHT, damage: 10,
      adv: { block: 0, hit: 8 }, reaction: REACTION.FLINCH_HIGH,
      knockback: [1.2, 0, 0], blockPush: [0.9, 0, 0], meterGain: 4,
      cancels: ['raptorRake2'], cancelWindow: [12, 27],
    });
    mv({
      id: 'raptorRake2', name: 'Second Angle', input: 'qcf+1,1', clip: 'p.backfist', tag: 'string',
      desc: 'Second rake. Sets up the fork — from here MANTIS is either sweeping your legs or launching you.',
      active: [W(12, 13, FIST_L(0.24))], total: 32,
      height: HEIGHT.HIGH, weight: WEIGHT.MEDIUM, damage: 13,
      adv: { block: -4, hit: 6 }, reaction: REACTION.FLINCH_HIGH,
      knockback: [2.4, 0, 0], blockPush: [1.6, 0, 0], meterGain: 5, trail: 'hand_L',
      cancels: ['raptorRake3', 'raptorRakeUp'], cancelWindow: [12, 31],
    });
    mv({
      id: 'raptorRake3', name: 'Sixth Angle', input: 'qcf+1,1,3', clip: 'k.sweep', tag: 'low',
      desc: 'The low half of the fork. Sweeps on hit, -15 if they were crouching.',
      active: [W(18, 20, [B('knee_L', 0.25, [0, -0.04, 0.04], 0.44), B('foot_L', 0.26, [0, -0.02, 0.06]), B('hand_L', 0.23, [0, -0.05, 0])])], total: 48,
      height: HEIGHT.LOW, weight: WEIGHT.MEDIUM, damage: 18,
      adv: { block: -15, hit: 4 }, reaction: REACTION.SWEEP,
      knockback: [2.8, 0.4, 0], blockPush: [2.0, 0, 0], meterGain: 7, trail: 'foot_L',
      props: { crushHigh: true },
    });
    mv({
      id: 'raptorRakeUp', name: 'Fourth Angle', input: 'qcf+1,1,2', clip: 'p.launcherPunch', tag: 'string',
      desc: 'The mid half of the fork. Full launch on hit, -18 if they blocked. Same two frames as the sweep — that is the guess.',
      active: [W(17, 19, FIST_R(0.26))], total: 50,
      height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 18,
      adv: { block: -18, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 6.0,
      knockback: [1.8, 0, 0], blockPush: [1.8, 0, 0], meterGain: 10, trail: 'hand_R',
    });
    // Anchored on the hand and the driving leg the way the base `groundSpike` is; the spike clip drives both.
    mv({
      id: 'harvest', name: 'Harvest', input: 'd,f,d,4', clip: 'sp.groundSpike', tag: 'finisher',
      desc: 'Pins them to the floor with the raptor arms and does not stop. Pest control, as originally specified.',
      active: [W(30, 39, [B('hand_L', 0.36, [0, -0.06, 0], 0, 0.44), B('foot_R', 0.34, [0, -0.02, 0.3], 0, 0.5), B('knee_R', 0.3, [0, -0.04, 0.05], 0.44, 0.42)])], total: 112,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 86,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Down, Forward, Down, RK' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.4, slow: 0.26, slowTicks: 50 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.pose',
      },
    });
  },

  // --- NYX — casino security, wildcard --------------------------------------
  // "Its outcomes are fair; its inputs are not." Everything is a gamble with a
  // stated price: the teleport is invulnerable for eighteen frames and its
  // follow-up is -21, and the low does nothing at all unless it counter-hits.
  nyx(mv, cfg, set, chain) {
    mv({
      id: 'houseEdge', name: 'House Edge', input: 'qcb+3', clip: 'k.spinKick', tag: 'evade',
      desc: 'Vanishes backwards through the attack and reappears through them. Eighteen frames of invulnerability.',
      active: [W(22, 24, [...FOOT_R(0.27), B('hand_R', 0.24, [0, -0.05, 0])])], total: 52,
      height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 19,
      adv: { block: -9, hit: 5 }, reaction: REACTION.SPIN,
      knockback: [4.0, 0.8, 0], blockPush: [2.6, 0, 0], meterGain: 9, trail: 'foot_R',
      props: { invulnFrom: 1, invulnTo: 18, travel: [{ from: 0, to: 9, x: -6.0, z: 0 }, { from: 10, to: 22, x: 5.2, z: 0 }] },
      cancels: ['doubleOrNothing'], cancelWindow: [22, 50],
    });
    mv({
      id: 'doubleOrNothing', name: 'Double or Nothing', input: 'qcb+3,1', clip: 'p.launcherPunch', tag: 'string',
      desc: 'The gamble off House Edge: full launcher on hit, -21 on block. Nothing in the game punishes harder.',
      active: [W(16, 18, FIST_R(0.26))], total: 52,
      height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 20,
      adv: { block: -21, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 6.4,
      knockback: [1.8, 0, 0], blockPush: [1.8, 0, 0], meterGain: 11, trail: 'hand_R',
    });
    mv({
      id: 'snakeEyes', name: 'Snake Eyes', input: 'db+1', clip: 'k.lowKick', tag: 'low',
      desc: 'A low that does nothing much — unless it counter-hits, and then it launches.',
      active: [W(16, 17, SHIN_L(0.25))], total: 40,
      height: HEIGHT.LOW, weight: WEIGHT.LIGHT, damage: 12,
      adv: { block: -11, hit: 5 }, reaction: REACTION.FLINCH_LOW,
      knockback: [1.6, 0, 0], blockPush: [1.4, 0, 0], meterGain: 5,
      props: { crushHigh: true, counterLaunch: { reaction: REACTION.LAUNCH, juggleHeight: 5.4, hitStun: 30 } },
    });
    // The one finisher built on the full three-clip overdrive staging, because the wildcard is the character a staged reveal belongs to.
    mv({
      id: 'lastHand', name: 'Last Hand', input: 'f,b,d,4', clip: 'sp.overdriveStart', tag: 'finisher',
      desc: 'Deals three cards face down and turns all three over. The only finisher that pays out in stages, on the only machine that would.',
      active: [
        W(24, 28, [B('hand_R', 0.36, [0, -0.1, 0])], 30),
        W(38, 43, [B('hand_L', 0.38, [0, -0.1, 0])], 34),
        W(56, 64, [B('chest', 0.46, [0, 0, -0.34]), B('hand_R', 0.4, [0, -0.12, 0])], 56),
      ], total: 120,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 120,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Forward, Back, Down, RK' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.5, slow: 0.2, slowTicks: 58 },
        hitClip: 'sp.overdriveHit', finishClip: 'sp.overdriveFinish',
      },
    });
  },

  // --- BASTION — twenty years in one corridor, defense 10 -------------------
  // "Patience is a weapon and everyone eventually swings first." Its generic
  // counter stance is REPLACED by one that reads lows as well as highs and mids,
  // and holds the read for 27 frames instead of 18 — the best parry in the game,
  // on the character whose whole biography is waiting.
  bastion(mv, cfg, set, chain) {
    mv({
      id: 'counterStance', name: 'Bulkhead Protocol', input: 'b+3+4', clip: 'sp.counterStance', tag: 'parry',
      desc: 'BASTION\'s parry, not the generic one: it reads lows as well as highs and mids, and it holds the read for twenty-seven frames.',
      active: [W(26, 28, FIST_R(0.28))], total: 66,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
      adv: { block: -8, hit: 8 }, reaction: REACTION.CRUMPLE,
      knockback: [2.0, 0, 0], blockPush: [2.0, 0, 0], meterGain: 16,
      props: { parryFrom: 2, parryTo: 28, parryHeights: ['high', 'mid', 'low'], parryClip: 'sp.parrySuccess', parryRiposte: 20 },
    });
    mv({
      id: 'blastDoor', name: 'Blast Door', input: 'qcb+4', clip: 'sp.chargeShoulder', tag: 'armor',
      desc: 'Armoured for its whole startup and PLUS on block, which nothing else in the game manages. The +1 buys nothing but the right to walk forward again.',
      active: [W(24, 28, [B('shoulder_R', 0.34, [0, -0.1, 0]), B('chest', 0.32, [0, 0, -0.18])])], total: 58,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 22,
      // The one move in the game that is plus on block WITH armour, and it is
      // legal by the invariant at the top of the file for both reasons the
      // invariant allows: it is i26, and 7.0 of block push means the +1 buys
      // nothing but the right to walk forward again.
      adv: { block: 1, hit: 3 }, reaction: REACTION.STAGGER,
      knockback: [5.0, 0, 0], blockPush: [7.0, 0, 0], meterGain: 12,
      props: { armorFrom: 4, armorTo: 28, armorScale: 0.45, wallCarry: 3.0, travel: [{ from: 6, to: 26, x: 3.0, z: 0 }] },
    });
    mv({
      id: 'holdTheLine', name: 'Hold the Line', input: 'dp+2', clip: 'p.hammerFist', tag: 'mid',
      desc: 'Armoured mid that hops lows and crumples on counter-hit. The answer to someone finally swinging first.',
      active: [W(18, 20, [B('hand_R', 0.27, [0, -0.06, 0]), B('hand_L', 0.27, [0, -0.06, 0])])], total: 48,
      height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
      adv: { block: -11, hit: 2 }, reaction: REACTION.KNOCKDOWN,
      knockback: [3.0, 1.0, 0], blockPush: [2.6, 0, 0], meterGain: 11,
      props: { crushLow: true, armorFrom: 8, armorTo: 20, armorScale: 0.6, counterLaunch: { reaction: REACTION.CRUMPLE, hitStun: 50 } },
    });
    // The heaviest travel of the ten and the lowest zoom: the camera stays wide because the read is the distance covered, not the blow.
    mv({
      id: 'lockdown', name: 'Lockdown', input: 'b,d,b,3', clip: 'sp.chargeShoulder', tag: 'finisher',
      desc: 'Walks them backwards into the wall and stands there. Twenty years of standing in one corridor, delivered all at once.',
      active: [W(32, 40, [B('shoulder_R', 0.42, [0, -0.1, 0]), B('chest', 0.4, [0, 0, -0.2])])], total: 114,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 98,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Back, Down, Back, LK' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.3, slow: 0.24, slowTicks: 52 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.systemsNominal',
      },
    });
  },

  // --- AXIOM — the reference chassis, "quietly furious about being boring" ---
  // The only character whose signature IS the frame data. No armour, no
  // invulnerability, no travel, nothing bolted on: the cleanest poke in the game
  // (i13 mid, 0 on block, +9 on hit), the safest low in the game (-9, where
  // every other low in the cast is -10 to -18), and one launcher off the poke.
  axiom(mv, cfg, set, chain) {
    mv({
      id: 'errata', name: 'Errata', input: 'qcf+3', clip: 'k.kneeStrike', tag: 'poke',
      desc: 'i13 mid, 0 on block, +9 on hit. The cleanest poke in the game and the whole of AXIOM\'s argument.',
      active: [W(13, 14, KNEE_R(0.25))], total: 30,
      height: HEIGHT.MID, weight: WEIGHT.LIGHT, damage: 13,
      adv: { block: 0, hit: 9 }, reaction: REACTION.FLINCH_MID,
      knockback: [1.4, 0, 0], blockPush: [2.6, 0, 0], meterGain: 5,
      props: { crushLow: true },
      cancels: ['errata2'], cancelWindow: [13, 29],
    });
    mv({
      id: 'errata2', name: 'Errata, Revised', input: 'qcf+3,2', clip: 'p.launcherPunch', tag: 'string',
      desc: 'Launcher off Errata. -15 on block, which is the price of the check being free.',
      active: [W(16, 18, FIST_R(0.26))], total: 48,
      height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 20,
      adv: { block: -15, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 6.0,
      knockback: [1.6, 0, 0], blockPush: [1.8, 0, 0], meterGain: 10, trail: 'hand_R',
    });
    mv({
      id: 'footnote', name: 'Footnote', input: 'db+1', clip: 'k.lowKick', tag: 'low',
      desc: '-9. Every other low in the cast is -10 to -18. It does ten damage and nothing else, and it is always your turn afterwards.',
      active: [W(17, 18, SHIN_L(0.24))], total: 34,
      height: HEIGHT.LOW, weight: WEIGHT.LIGHT, damage: 10,
      adv: { block: -9, hit: 0 }, reaction: REACTION.FLINCH_LOW,
      knockback: [1.2, 0, 0], blockPush: [1.2, 0, 0], meterGain: 4,
      props: { crushHigh: true },
    });
    // The fastest finisher and the tightest camera. Nothing bolted on, which is the character.
    mv({
      id: 'qed', name: 'Q.E.D.', input: 'd,b,f,3', clip: 'p.launcherPunch', tag: 'finisher',
      desc: 'One uppercut, thrown exactly correctly. AXIOM would like it noted that this is not boring.',
      active: [W(26, 31, [B('hand_R', 0.34, [0, -0.05, 0]), B('wrist_R', 0.28, [0, -0.04, 0])])], total: 104,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 90,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Down, Back, Forward, LK' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.65, slow: 0.3, slowTicks: 44 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.systemsNominal',
      },
    });
  },

  // --- VOLTA — substation rig, mixup ----------------------------------------
  // "Every move it knows ends with something arcing." One staggering opener that
  // forks into a low and a mid launcher off the SAME cancel window — a genuine
  // 50/50 rather than a string with a decorative branch. The opener is only -3,
  // so blocking it does not end the guess.
  volta(mv, cfg, set, chain) {
    mv({
      id: 'arcTap', name: 'Arc Tap', input: 'qcb+2', clip: 'sp.plasmaBurst', tag: 'special',
      desc: 'Staggers on hit and is only -3 on block, so blocking it does not end the guess. Cancels into a low OR a launcher.',
      active: [W(20, 23, [B('hand_L', 0.32, [0, -0.16, 0]), B('chest', 0.28, [0, 0, -0.3])])], total: 46,
      height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 18,
      adv: { block: -3, hit: 7 }, reaction: REACTION.STAGGER,
      knockback: [2.2, 0, 0], blockPush: [3.0, 0, 0], meterGain: 9,
      cancels: ['arcSplit', 'arcOverload'], cancelWindow: [20, 45],
    });
    mv({
      id: 'arcSplit', name: 'Earth Return', input: 'qcb+2,4', clip: 'k.sweep', tag: 'low',
      desc: 'The low half of the arc. Sweeps on hit, -14 on block.',
      active: [W(19, 21, [B('knee_L', 0.25, [0, -0.04, 0.04], 0.44), B('foot_L', 0.27, [0, -0.02, 0.06]), B('hand_L', 0.24, [0, -0.05, 0])])], total: 46,
      height: HEIGHT.LOW, weight: WEIGHT.MEDIUM, damage: 19,
      adv: { block: -14, hit: 5 }, reaction: REACTION.SWEEP,
      knockback: [3.0, 0.6, 0], blockPush: [2.0, 0, 0], meterGain: 8, trail: 'foot_L',
      props: { crushHigh: true },
    });
    mv({
      id: 'arcOverload', name: 'Overload', input: 'qcb+2,2', clip: 'p.uppercut', tag: 'string',
      desc: 'The mid half of the arc. Full launch on hit, -14 on block. Identical window to the low — that is the 50/50.',
      active: [W(17, 19, FIST_R(0.26))], total: 48,
      height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 21,
      adv: { block: -14, hit: 20 }, reaction: REACTION.LAUNCH, juggleHeight: 5.8,
      knockback: [1.8, 0, 0], blockPush: [1.8, 0, 0], meterGain: 10, trail: 'hand_R',
    });
    // Two hundred amps needs a path to earth, so the finisher is the one that puts them on the floor and keeps them there.
    mv({
      id: 'deadShort', name: 'Dead Short', input: 'f,d,f,2', clip: 'k.stomp', tag: 'finisher',
      desc: 'Drives the grounding spike through them and closes the circuit. Everything VOLTA knows ends with something arcing; this ends with everything arcing.',
      active: [W(30, 38, [B('foot_R', 0.4, [0, -0.04, 0.02]), B('knee_R', 0.34, [0, -0.04, 0.04], 0.4), B('hand_L', 0.34, [0, -0.05, 0])])], total: 110,
      height: HEIGHT.MID, weight: WEIGHT.ULTRA, damage: 94,
      adv: { block: -30, hit: 10 }, reaction: REACTION.CRUMPLE,
      knockback: [7.0, 2.2, 0], blockPush: [5.0, 0, 0], meterGain: 0,
      props: {
        finisher: { ...FINISH_RULE, sequenceText: 'Forward, Down, Forward, RP' },
        invulnFrom: 1, invulnTo: 8, wallBounce: true, wallCarry: 3.2,
        travel: FIN_TRAVEL, hitsGrounded: true,
        cinematic: { zoom: 1.45, slow: 0.25, slowTicks: 50 },
        hitClip: 'sp.overdriveHit', finishClip: 'v.saluteCharge',
      },
    });
  },
};

/**
 * Merge a character's signature layer over its archetype table.
 *
 * The base moves are copied BY REFERENCE — a hundred-odd Move objects shared by
 * ten characters, not cloned ten times — so the whole per-character layer costs
 * one small object per fighter plus the two or three moves it actually defines.
 * `chain()` is the one thing that would break that sharing, so it clones.
 *
 * @param {Object} def          roster entry
 * @param {Object} base         the archetype table
 * @param {Object} archCfg      the archetype tuning
 */
function buildCharacterSet(def, base, archCfg) {
  const cfg = { ...archCfg, key: def.moveSet };
  const out = Object.create(null);
  for (const id of Object.keys(base)) out[id] = base[id];

  const owned = [];
  const overlay = Object.create(null);
  const mv = (spec) => {
    spec.character = true;
    const m = make(spec, cfg);
    // `owner`, not `signature`: the roster already uses `signature` for the
    // intro/victory/taunt/idle clip ids, and the UI has to read both.
    // docs/CONTRACT-character-moves.md pins this.
    m.owner = def.id;
    if (!m.desc) throw new Error(`character move ${def.id}/${m.id}: needs a one-line desc`);
    out[m.id] = m;
    overlay[m.id] = m;
    owned.push(m.id);
    return m;
  };
  /**
   * Hang a cancel off a base move without touching the archetype's copy of it.
   * VULKAN's `f+2,1` has to be reachable from the shared `elbow`, and mutating
   * that in place is how every heavy character would end up with it.
   */
  const chain = (id, cancels, window) => {
    const b = out[id];
    if (!b) throw new Error(`character ${def.id}: chain target ${id} not in ${def.moveBase}`);
    const c = { ...b };
    c.cancels = [...(b.cancels || []), ...cancels];
    c.cancelWindow = window || b.cancelWindow || [b.startup, b.total - 2];
    out[id] = c;
    return c;
  };

  const extras = CHARACTER_EXTRAS[def.id];
  if (extras) extras(mv, cfg, out, chain);

  // The roster NAMES each machine's signature moves and this file DEFINES them.
  // Two places, so the select screen can list them without importing the move
  // table — which means they can rot apart, so they are checked at load and
  // `tools/check.mjs` fails the build on a disagreement.
  const declared = (def.signatureMoves || []).slice().sort();
  const built = owned.slice().sort();
  if (declared.join(',') !== built.join(',')) {
    throw new Error(`roster ${def.id}: signatureMoves [${declared}] does not match the moves `
      + `Moves.js defines for it [${built}]`);
  }

  const ordered = Object.values(out)
    .filter((m) => !m.followUp)
    .sort((a, b) => (b.parsed.score - a.parsed.score) || (a.startup - b.startup));
  Object.defineProperty(out, '__ordered', { value: ordered, enumerable: false });
  Object.defineProperty(out, '__label', { value: archCfg.label, enumerable: false });
  Object.defineProperty(out, '__base', { value: def.moveBase, enumerable: false });
  Object.defineProperty(out, '__overlay', { value: overlay, enumerable: false });
  return out;
}

/** @type {Record<string, Record<string, import('./MoveSchema.js').Move>>} */
export const MOVES = {
  standard: buildMoveSet(ARCHETYPES.standard),
  heavy: buildMoveSet(ARCHETYPES.heavy),
  agile: buildMoveSet(ARCHETYPES.agile),
  technical: buildMoveSet(ARCHETYPES.technical),
};

/**
 * The ten per-character tables, registered into `MOVES` under the character id.
 *
 * Doing it here rather than in a parallel export is deliberate: `Fighter` already
 * resolves `MOVES[def.moveSet]`, `CPU` and `TestHarness` already fall back to
 * `MOVES.standard`, and `tools/check.mjs` already walks every entry of `MOVES`
 * through the hitbox-anchor guard. Registering here means a signature move gets
 * the same validation as everything else and no consumer changes at all — the
 * roster simply points `moveSet` at the character's own table.
 */
export const CHARACTER_MOVE_KEYS = [];

/**
 * The per-character OVERLAYS, keyed by roster id — only what each machine adds
 * or replaces, not the merged table. `movesFor()` returns the merged one.
 * Pinned by docs/CONTRACT-character-moves.md.
 * @type {Record<string, Record<string, import('./MoveSchema.js').Move>>}
 */
export const CHARACTER_MOVES = Object.create(null);

for (const def of ROSTER) {
  const archCfg = ARCHETYPES[def.moveBase] || ARCHETYPES.standard;
  const base = MOVES[def.moveBase] || MOVES.standard;
  const set = buildCharacterSet(def, base, archCfg);
  MOVES[def.moveSet] = set;
  CHARACTER_MOVES[def.id] = set.__overlay;
  CHARACTER_MOVE_KEYS.push(def.moveSet);
}

export const MOVE_SET_KEYS = Object.keys(MOVES);

/**
 * Display label for a move set. A character table reports its archetype family
 * ("Bulwark", "Wraith"), which is what the select screen wants to say about a
 * machine — the character's own name is right next to it already.
 */
export const MOVE_SET_LABELS = Object.fromEntries(
  MOVE_SET_KEYS.map((k) => [k, MOVES[k].__label]),
);

/**
 * A flat, UI-renderable projection of every move set. Sorted the way a real
 * command list is: strings grouped under their opener, then everything else by
 * startup.
 * @type {Record<string, Array<{id,name,input,startup,onBlock,onHit,damage,height,weight,tag,note}>>}
 */
export const COMMAND_LIST = Object.fromEntries(
  MOVE_SET_KEYS.map((key) => {
    const set = MOVES[key];
    const rows = Object.values(set).map((m) => ({
      id: m.id,
      name: m.name,
      input: m.input,
      startup: m.startup,
      active: m.active.reduce((n, w) => n + (w.to - w.from + 1), 0),
      recovery: m.recovery,
      onBlock: m.onBlock,
      onHit: m.onHit,
      damage: m.damage,
      height: m.height,
      weight: m.weight,
      tag: m.tag,
      note: m.note,
      // Which rows are this machine's own. A signature move nobody can find is
      // not a move, so the projection the UI renders has to be able to say
      // "these four are yours" without knowing anything about archetypes.
      // `owner` is the pinned flag; its presence IS the signature marker.
      owner: m.owner || null,
      desc: m.desc || '',
      finisher: m.props.finisher || null,
    }));
    rows.sort((a, b) => (a.input.split(',')[0].localeCompare(b.input.split(',')[0])) ||
      (a.input.length - b.input.length) || (a.startup - b.startup));
    return [key, rows];
  }),
);

/**
 * Just the character's own rows, per character, in the order the roster names
 * them —
 * which is authored order, not alphabetical, so a string reads opener-first.
 *
 * This is the block a command list or a character-select dossier should show
 * under a heading like "VULKAN ONLY". Everything else in `COMMAND_LIST[id]` is
 * shared with the rest of the archetype.
 * @type {Record<string, Array<Object>>}
 */
export const SIGNATURE_MOVES = Object.fromEntries(
  ROSTER.map((def) => {
    const rows = COMMAND_LIST[def.moveSet] || [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return [def.id, (def.signatureMoves || []).map((id) => byId.get(id)).filter(Boolean)];
  }),
);

/**
 * The move table a machine actually fights with.
 *
 * This is the accessor `src/ui/MoveList.js` asks for by name, and the one thing
 * outside this file that should ever have to know how a character's table is
 * assembled. It takes a roster entry, a character id, or an archetype key, and
 * it always returns a renderable table.
 *
 * @param {Object|string} defOrId
 * @returns {Record<string, import('./MoveSchema.js').Move>}
 */
export function movesFor(defOrId) {
  const k = typeof defOrId === 'string' ? defOrId : (defOrId?.moveSet || defOrId?.id);
  return MOVES[k] || MOVES[ROSTER_SET_BY_ID[k]] || MOVES.standard;
}

/** Character id -> its move-set key, so `movesFor('vulkan')` works either way. */
const ROSTER_SET_BY_ID = Object.fromEntries(ROSTER.map((d) => [d.id, d.moveSet]));

/**
 * The command list for a roster entry, tolerating a def, an id, or a set key.
 * @param {Object|string} defOrKey
 */
export function commandListFor(defOrKey) {
  const k = typeof defOrKey === 'string' ? defOrKey : (defOrKey?.moveSet || defOrKey?.id);
  return COMMAND_LIST[k] || COMMAND_LIST[ROSTER_SET_BY_ID[k]] || COMMAND_LIST.standard;
}

/**
 * The archetype table a character's set was built over — named, not guessed.
 * @param {Object|string} defOrId
 */
export function baseMovesFor(defOrId) {
  const id = typeof defOrId === 'string' ? defOrId : defOrId?.id;
  const def = ROSTER.find((d) => d.id === id || d.moveSet === id);
  return MOVES[def?.moveBase] || MOVES.standard;
}

// ---------------------------------------------------------------------------
// Input matching
// ---------------------------------------------------------------------------

/**
 * One buffered press. The Fighter pushes these; `findMove` consumes them.
 * @typedef {Object} InputEntry
 * @property {number} tick
 * @property {Set<number>} btns
 * @property {boolean} fwd, back, up, down
 * @property {?string} motion
 * @property {boolean} used
 */

function canUse(m, st) {
  if (m.meterCost > 0 && (st.meter ?? 0) < m.meterCost) return false;
  const p = m.props;
  // Ground moves need the ground — except string continuations, which stay
  // legal while the opener has the fighter briefly airborne (hopping kicks).
  if (p.requireAir) { if (!st.airborne) return false; }
  else if (st.airborne && !m.followUp) return false;
  if (p.requireCrouch && !st.crouching) return false;
  if (p.requireStance && st.stance !== p.requireStance) return false;
  return true;
}

/**
 * Match one parsed notation token against a buffered press.
 * `live` supplies the *current* direction so that a press followed within a few
 * ticks by the direction still comes out — the leniency real fighting games have.
 */
/**
 * How far apart two presses may land and still count as one simultaneous press.
 *
 * Everything with a `+` between buttons — all three throws, the power crush, the
 * counter stance, the two-handed slams — used to require both keys inside the
 * SAME 16.7 ms tick, because `Fighter#pushInput` writes one buffer entry per
 * tick from the edge-triggered `cmd.pressed` and this function demanded that a
 * single entry hold every button. Human hands do not do that: two fingers on a
 * keyboard land 10-40 ms apart, two thumbs on glass rather more. The result is
 * that pressing 1+2 gave you a jab, which is indistinguishable from the throw
 * not existing.
 *
 * Four ticks is 66 ms — wide enough that a deliberate chord always registers,
 * narrow enough that a jab-then-cross string does not turn into a throw. The
 * bound is also self-limiting: a fighter who is *actionable* starts the jab on
 * the tick the first button lands and marks that entry `used`, so the chord path
 * can only fire when both presses were buffered while the fighter could not act
 * — which is precisely when the player meant them as one input.
 */
const CHORD_TICKS = 4;

/** Shared "nothing extra to consume" result, so the common path allocates nothing. */
const EMPTY = [];

/**
 * Collect the extra buffer entries needed to satisfy a multi-button token.
 * @returns {?Array} entries to consume alongside `buffer[i]`, or null if the
 *          chord cannot be completed.
 */
function gatherChord(p, buffer, i, live, tick, reuse) {
  const e = buffer[i];
  let extra = null;
  for (const b of p.buttons) {
    if (e.btns.has(b)) continue;
    // A single-button token has to be in the entry it matched; borrowing across
    // entries there would let any two taps satisfy any one-button move.
    if (p.buttons.length < 2) return null;
    let found = null;
    for (let j = buffer.length - 1; j >= 0; j--) {
      if (j === i) continue;
      const o = buffer[j];
      if ((o.used && !reuse) || (extra && extra.includes(o))) continue;
      if (Math.abs(o.tick - e.tick) > CHORD_TICKS) continue;
      if (o.btns.has(b)) { found = o; break; }
    }
    if (found) { (extra || (extra = [])).push(found); continue; }
    // Still holding it. Real pads are held-state machines, and holding 1 while
    // tapping 2 is how most people actually press 1+2.
    if (live && live.held && live.held.has(b) && tick - e.tick <= CHORD_TICKS) continue;
    return null;
  }
  return extra || EMPTY;
}

/**
 * @param {boolean} asStep true when matching a string continuation rather than
 *   a root move. A continuation written without a direction prefix — the `1` of
 *   `b+2,1`, the `3` of `db+4,3` — means "the next button", not "the next button
 *   with the stick centred". Requiring a centred stick meant every string with a
 *   directional opener silently died unless the player let go of the direction
 *   mid-string, which nobody does. Root moves keep the strict test, because
 *   there `''` really does have to mean neutral or `2` would eat `f+2`.
 */
function matchesEntry(p, e, live, tick, asStep) {
  if (p.motion) return e.motion === p.motion || (live && live.motion === p.motion && tick - e.tick <= 4);
  if (asStep && !p.dir) return true;
  if (dirMatches(p.dir, e)) return true;
  if (live && tick - e.tick <= 4 && dirMatches(p.dir, live)) return true;
  return false;
}

/**
 * Resolve the move a fighter should start this tick.
 *
 * Handles, in priority order: string continuations inside the current move's
 * cancel window, then a chord upgrade of a single-button move that has only just
 * started, then root moves ordered by input specificity. Every candidate is
 * tested against the fighter's input buffer newest-first, so a press made a few
 * ticks before the fighter became actionable still comes out.
 *
 * On a match the consumed buffer entry is flagged `used` and exposed as
 * `fighterState.matchedInput`, so the caller can see what produced the move.
 *
 * @param {string|Object} moveSet   move-set key, or a move table
 * @param {Object} cmd              the live Command this tick (may be null)
 * @param {Object} fighterState     { buffer, tick, meter, airborne, crouching,
 *                                    currentMove, moveTick, stance, canCancel,
 *                                    allowRoot }
 *   `allowRoot: false` restricts matching to string continuations, which is what
 *   a fighter mid-attack must do — otherwise any button would cancel any move at
 *   any frame and the whole frame-data contract collapses.
 * @returns {?Object} the Move to start, or null
 */
export function findMove(moveSet, cmd, fighterState = {}) {
  const set = typeof moveSet === 'string' ? MOVES[moveSet] : moveSet;
  if (!set) return null;
  const buffer = fighterState.buffer || [];
  if (!buffer.length) return null;
  const tick = fighterState.tick ?? (buffer.length ? buffer[buffer.length - 1].tick : 0);
  const window = fighterState.bufferWindow ?? INPUT_BUFFER_TICKS;

  const tryMatch = (mv, parsed, asStep, reuse) => {
    if (!canUse(mv, fighterState)) return false;
    for (let i = buffer.length - 1; i >= 0; i--) {
      const e = buffer[i];
      if (e.used) continue;
      if (tick - e.tick > window) break;
      const chord = gatherChord(parsed, buffer, i, cmd, tick, reuse);
      if (!chord) continue;
      if (!matchesEntry(parsed, e, cmd, tick, asStep)) continue;
      e.used = true;
      for (const o of chord) o.used = true;
      fighterState.matchedInput = e;
      return true;
    }
    return false;
  };

  // 1. String continuation from the move currently running.
  const cur = fighterState.currentMove;
  if (cur && cur.cancels && cur.cancels.length && fighterState.canCancel !== false) {
    const t = fighterState.moveTick ?? 0;
    const [from, to] = cur.cancelWindow || [cur.startup, cur.total];
    if (t >= from && t <= to) {
      for (const id of cur.cancels) {
        const nxt = set[id];
        if (!nxt) continue;
        if (tryMatch(nxt, nxt.parsedStep, true)) return nxt;
      }
    }
  }

  // 2. Chord upgrade.
  //
  // THIS IS THE HALF OF THE THROW FIX THE BUFFER ALONE CANNOT DO, and it took a
  // run through the real sim to see it. `CHORD_TICKS` makes `1+2` match when
  // both presses are already sitting in the buffer, which is the case while the
  // fighter is in stun or recovery — but from NEUTRAL the fighter is actionable
  // on the tick the first button lands, so `1` resolves to a jab and marks its
  // entry used before `2` has been pressed at all. Driven end-to-end with real
  // Fighters and a real CombatSystem, one tick of spread still produced:
  //
  //     1+2 on the same tick    -> throwFwd, 42.3 damage, victim in 'thrown'
  //     1 then 2, two ticks     -> jab, 10.5 damage
  //
  // A single-button move inside its own first few frames has not started up
  // (the fastest startup in the game is i9, this window is 4) and cannot have
  // hit anything, so replacing it costs nothing. When the completing button
  // arrives, the fighter switches to the chord it was obviously trying to press.
  // `#tickAttack` already restarts on a different move returned mid-attack, so
  // this needs no engine change.
  //
  // It is checked AFTER string continuations on purpose, and that ordering is
  // the whole high/low distinction the player feels: `1` then `2` two frames
  // apart is a throw, `1` then `2` ten frames apart is inside the jab's cancel
  // window and is the jab string. Tekken behaves the same way for the same
  // reason.
  const src = fighterState.currentMove;
  if (src && fighterState.canCancel !== false &&
      (fighterState.moveTick ?? 0) <= CHORD_TICKS &&
      (fighterState.moveTick ?? 0) < src.startup &&
      src.parsed.buttons.length === 1) {
    for (const mv of set.__ordered) {
      const p = mv.parsed;
      if (p.buttons.length <= src.parsed.buttons.length) continue;
      if (!src.parsed.buttons.every((b) => p.buttons.includes(b))) continue;
      // `reuse` lets the chord borrow the very entry that started `src`: it is
      // marked used, and the move it produced is the one being replaced.
      if (tryMatch(mv, p, false, true)) return mv;
    }
  }

  // 3. Root moves, most specific input first.
  if (fighterState.allowRoot === false) return null;
  for (const mv of set.__ordered) {
    if (tryMatch(mv, mv.parsed, false)) return mv;
  }
  return null;
}

/** First move in a set carrying a given tag — used by the CPU and QA harness. */
export function findMoveByTag(moveSet, tag) {
  const set = typeof moveSet === 'string' ? MOVES[moveSet] : moveSet;
  if (!set) return null;
  for (const m of Object.values(set)) if (m.tag === tag) return m;
  return null;
}

/** Look a move up by id in a set, tolerating an unknown set. */
export function getMove(moveSet, id) {
  const set = typeof moveSet === 'string' ? MOVES[moveSet] : moveSet;
  return set ? set[id] || null : null;
}

/** Every move in a set that can be started from neutral, ordered by startup. */
export function neutralMoves(moveSet) {
  const set = typeof moveSet === 'string' ? MOVES[moveSet] : moveSet;
  if (!set) return [];
  return set.__ordered.slice().sort((a, b) => a.startup - b.startup);
}

export { parseToken, dirMatches };
