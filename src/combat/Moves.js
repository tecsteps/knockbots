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
  [/^(hand|wrist|fingers)_/, 0.19],
  [/^elbow_/, 0.17],
  [/^(foot|ankle|toe)_/, 0.20],
  [/^knee_/, 0.16],
  [/^(shoulder|clavicle)_/, 0.24],
  [/^(chest|spine|hips)/, 0.36],
  [/^(head|neck)/, 0.22],
];

// Reusable hitbox shapes, so a "right straight" reads the same on every set.
const FIST_R = (r = 0.21) => [B('hand_R', r, [0, -0.05, 0]), B('wrist_R', r * 0.8, [0, -0.04, 0])];
const FIST_L = (r = 0.21) => [B('hand_L', r, [0, -0.05, 0]), B('wrist_L', r * 0.8, [0, -0.04, 0])];
const ELBOW_R = (r = 0.24) => [B('elbow_R', r, [0, -0.06, 0]), B('wrist_R', r * 0.7, [0, 0, 0])];
const FOOT_R = (r = 0.24) => [B('foot_R', r, [0, -0.02, 0.04]), B('ankle_R', r * 0.85, [0, 0, 0])];
const FOOT_L = (r = 0.24) => [B('foot_L', r, [0, -0.02, 0.04]), B('ankle_L', r * 0.85, [0, 0, 0])];
const KNEE_R = (r = 0.25) => [B('knee_R', r, [0, -0.08, 0.05]), B('ankle_R', r * 0.7, [0, 0, 0])];
const SHIN_L = (r = 0.23) => [B('ankle_L', r, [0, 0, 0.03]), B('foot_L', r, [0, -0.02, 0.05])];

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
  if (p.throw) n.push(p.throw.type === 'back' ? 'Back throw' : 'Throw');
  if (p.counterLaunch) n.push('Launches on counter');
  if (p.hitsGrounded) n.push('Hits grounded');
  if (m.meterCost > 0) n.push(`${m.meterCost} meter`);
  if (m.height === HEIGHT.UNBLOCKABLE) n.push('Unblockable');
  return n.join(' · ');
}

/**
 * Turn an authored spec into a validated Move, applying archetype tuning.
 * @param {Object} s   authored spec, mutated in place
 * @param {Object} cfg archetype tuning
 */
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
      b.fwd = Math.round(b.fwd * reach * 1000) / 1000;
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

  if (cfg.names && cfg.names[s.id]) s.name = cfg.names[s.id];
  if (cfg.clips && cfg.clips[s.id]) s.clip = cfg.clips[s.id];

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
  mv({
    id: 'jab', name: 'Servo Jab', input: '1', clip: 'p.jab', tag: 'jab',
    active: [W(10, 11, FIST_L(0.2))], total: 21,
    height: HEIGHT.HIGH, weight: WEIGHT.LIGHT, damage: 8,
    adv: { block: 1, hit: 8 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [1.2, 0, 0], blockPush: [0.8, 0, 0],
    cancels: ['jab2', 'jabLow'], cancelWindow: [10, 20], meterGain: 3,
    sfx: 'lightHit',
  });
  mv({
    id: 'jab2', name: 'Cross Follow', input: '1,2', clip: 'p.straight', tag: 'string',
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
    active: [W(20, 22, FIST_R(0.27))], total: 45,
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
    active: [W(11, 12, FIST_R(0.2))], total: 25,
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
  mv({
    id: 'sweep', name: 'Rotor Sweep', input: 'db+3', clip: 'k.sweep', tag: 'sweep',
    active: [W(19, 21, [B('foot_L', 0.27, [0, -0.02, 0.06]), B('ankle_L', 0.24, [0, 0, 0])])], total: 47,
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
    active: [W(20, 22, FOOT_L(0.27))], total: 50,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 23,
    adv: { block: -12, hit: 4 }, reaction: REACTION.SPIN,
    knockback: [5.4, 1.2, 0], blockPush: [3.0, 0, 0], meterGain: 9, trail: 'foot_L',
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
    active: [W(17, 19, FOOT_R(0.27))], total: 39,
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
    active: [W(20, 22, FOOT_R(0.29))], total: 48,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 27,
    adv: { block: -13, hit: 5 }, reaction: REACTION.KNOCKDOWN,
    knockback: [6.6, 1.6, 0], blockPush: [3.2, 0, 0], meterGain: 10, trail: 'foot_R',
    props: { wallCarry: 2.2, wallBounce: true },
  });
  mv({
    id: 'spinKick', name: 'Gyro Sweepline', input: 'b+3', clip: 'k.spinKick', tag: 'heavy',
    active: [W(22, 24, FOOT_L(0.28))], total: 52,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 25,
    adv: { block: -9, hit: 3 }, reaction: REACTION.KNOCKDOWN,
    knockback: [4.4, 1.0, 0], blockPush: [2.6, 0, 0], meterGain: 9, trail: 'foot_L',
    props: { homing: true },
  });
  mv({
    id: 'axeKick', name: 'Guillotine Axe', input: 'uf+4', clip: 'k.axeKick', tag: 'heavy',
    active: [W(22, 24, FOOT_R(0.27))], total: 54,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 25,
    adv: { block: -13, hit: 4 }, reaction: REACTION.KNOCKDOWN,
    knockback: [2.0, -1.2, 0], blockPush: [2.2, 0, 0], meterGain: 9, trail: 'foot_R',
    props: { crushLow: true, groundBounce: 0.6, airborne: [8, 26] },
  });
  mv({
    id: 'stomp', name: 'Servo Stomp', input: 'd+3+4', clip: 'k.stomp', tag: 'heavy',
    active: [W(20, 22, [B('foot_R', 0.3, [0, -0.04, 0.02])])], total: 48,
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
    active: [W(20, 22, FOOT_L(0.26))], total: 48,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 18,
    adv: { block: -8, hit: 4 }, reaction: REACTION.FLINCH_MID,
    knockback: [3.0, 0, 0], blockPush: [2.0, 0, 0], meterGain: 7, trail: 'foot_L',
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
  mv({
    id: 'throwFwd', name: 'Chassis Toss', input: '1+2', clip: 't.grabAttempt', tag: 'throw',
    active: [W(12, 14, [B('hand_R', 0.3, [0, -0.06, 0]), B('hand_L', 0.3, [0, -0.06, 0])])], total: 46,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 34,
    adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [4.0, 2.0, 0], meterGain: 12,
    props: {
      throw: { type: 'forward', range: 1.35, breakWindow: [0, 19], breakButtons: [1, 2], clip: 't.throwForward', victimClip: 't.beingThrown', duration: 74 },
    },
  });
  mv({
    id: 'throwBack', name: 'Reactor Suplex', input: 'b+1+2', clip: 't.grabAttempt', tag: 'throw',
    active: [W(12, 14, [B('hand_L', 0.3, [0, -0.06, 0]), B('hand_R', 0.3, [0, -0.06, 0])])], total: 50,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 42,
    adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [-3.0, 2.4, 0], meterGain: 14,
    props: {
      throw: { type: 'back', range: 1.3, breakWindow: [0, 14], breakButtons: [1], clip: 't.throwBack', victimClip: 't.beingThrown', duration: 86 },
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
  mv({
    id: 'risingFang', name: 'Rising Fang', input: 'dp+1', clip: 'sp.risingFang', tag: 'reversalLauncher',
    active: [W(12, 16, [B('hand_R', 0.28, [0, -0.12, 0]), B('elbow_R', 0.22, [0, 0, 0])])], total: 56,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 23,
    adv: { block: -21, hit: 22 }, reaction: REACTION.LAUNCH, juggleHeight: 7.2,
    knockback: [1.2, 0, 0], blockPush: [1.4, 0, 0], meterGain: 12, trail: 'hand_R',
    props: { invulnFrom: 1, invulnTo: 11, airborne: [6, 34] },
  });
  mv({
    id: 'groundSpike', name: 'Fault Line', input: 'dd+3', clip: 'sp.groundSpike', tag: 'low',
    active: [W(24, 28, [B('foot_R', 0.3, [0, -0.02, 0.3]), B('foot_L', 0.28, [0, -0.02, 0.1])])], total: 60,
    height: HEIGHT.LOW, weight: WEIGHT.HEAVY, damage: 27,
    adv: { block: -16, hit: 8 }, reaction: REACTION.SWEEP,
    knockback: [3.0, 2.2, 0], blockPush: [2.4, 0, 0], meterGain: 12,
    props: { crushHigh: true, groundBounce: 0.5 },
  });

  // --- overdrive -----------------------------------------------------------
  mv({
    id: 'overdrive', name: 'Overdrive Cascade', input: 'qcf+5', clip: 'sp.overdriveStart', tag: 'super',
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
    active: [W(18, 20, FOOT_R(0.29))], total: 44,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 24,
    adv: { block: -10, hit: 3 }, reaction: REACTION.KNOCKDOWN,
    knockback: [9.0, 0.6, 0], blockPush: [5.8, 0, 0], meterGain: 9, trail: 'foot_R',
    props: { wallCarry: 3.2, wallBounce: true, travel: [{ from: 4, to: 19, x: 5.0, z: 0 }] },
  });
}

function heavyExtras(mv, cfg, set) {
  mv({
    id: 'siegeSlam', name: 'Siege Slam', input: 'dd+2', clip: 'p.hammerFist', tag: 'unblockable',
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
    active: [W(22, 25, [B('foot_L', 0.34, [0, -0.04, 0.04])])], total: 56,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 26,
    adv: { block: -18, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [2.0, -2.6, 0], blockPush: [2.4, 0, 0], meterGain: 10,
    props: { hitsGrounded: true, groundBounce: 0.5 },
  });
  set.stomp.cancels = ['quakeStomp'];
  set.stomp.cancelWindow = [set.stomp.startup, set.stomp.total - 2];
  mv({
    id: 'grinderLow', name: 'Grinder Low', input: 'db+1+2', clip: 'sp.groundSpike', tag: 'low',
    active: [W(24, 27, [B('hand_R', 0.3, [0, -0.06, 0.16]), B('foot_R', 0.28, [0, -0.02, 0.1])])], total: 58,
    height: HEIGHT.LOW, weight: WEIGHT.HEAVY, damage: 28,
    adv: { block: -15, hit: 5 }, reaction: REACTION.SWEEP,
    knockback: [3.4, 1.6, 0], blockPush: [2.6, 0, 0], meterGain: 12,
    props: { armorFrom: 8, armorTo: 24, armorScale: 0.5, crushHigh: true },
  });
  mv({
    id: 'titanGrab', name: 'Titan Clamp', input: 'f+1+3', clip: 't.grabAttempt', tag: 'throw',
    active: [W(16, 19, [B('hand_R', 0.32, [0, -0.06, 0]), B('hand_L', 0.32, [0, -0.06, 0])])], total: 56,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 48,
    adv: { block: 0, hit: 0 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.0, 3.0, 0], meterGain: 16,
    props: { throw: { type: 'command', range: 1.55, breakWindow: [0, 12], breakButtons: [1, 2], clip: 't.throwForward', victimClip: 't.beingThrown', duration: 96 } },
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
    active: [W(9, 10, FIST_R(0.19))], total: 22,
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
    id: 'diveKick', name: 'Falcon Dive', input: 'd+4', clip: 'k.jumpKick', tag: 'air',
    active: [W(8, 16, FOOT_R(0.26))], total: 36,
    height: HEIGHT.MID, weight: WEIGHT.MEDIUM, damage: 18,
    adv: { block: -5, hit: 4 }, reaction: REACTION.KNOCKDOWN,
    knockback: [3.0, -1.4, 0], blockPush: [2.6, 0, 0], meterGain: 7, trail: 'foot_R',
    props: { requireAir: true, travel: [{ from: 2, to: 16, x: 5.0, z: 0 }] },
  });
  mv({
    id: 'phaseStep', name: 'Phase Step', input: 'bb+1', clip: 'p.backfist', tag: 'evade',
    active: [W(16, 17, FIST_R(0.23))], total: 40,
    height: HEIGHT.HIGH, weight: WEIGHT.MEDIUM, damage: 15,
    adv: { block: -5, hit: 7 }, reaction: REACTION.FLINCH_HIGH,
    knockback: [3.4, 0, 0], blockPush: [1.8, 0, 0], meterGain: 8,
    props: { invulnFrom: 1, invulnTo: 14, travel: [{ from: 0, to: 8, x: -5.0, z: 0 }, { from: 9, to: 16, x: 4.0, z: 0 }] },
  });
  mv({
    id: 'heelSlice', name: 'Heel Slice', input: 'db+4', clip: 'k.sweep', tag: 'low',
    active: [W(14, 15, SHIN_L(0.24))], total: 34,
    height: HEIGHT.LOW, weight: WEIGHT.LIGHT, damage: 12,
    adv: { block: -10, hit: 3 }, reaction: REACTION.FLINCH_LOW,
    knockback: [1.6, 0, 0], blockPush: [1.2, 0, 0], meterGain: 5,
    props: { crushHigh: true },
  });
  mv({
    id: 'whirlwind', name: 'Whirlwind Arc', input: 'qcb+4', clip: 'k.roundhouse', tag: 'special',
    active: [W(18, 22, [B('foot_L', 0.3, [0, -0.02, 0.05]), B('foot_R', 0.28, [0, -0.02, 0.05])])], total: 50,
    height: HEIGHT.MID, weight: WEIGHT.HEAVY, damage: 23,
    adv: { block: -9, hit: 3 }, reaction: REACTION.SPIN,
    knockback: [5.6, 1.4, 0], blockPush: [3.0, 0, 0], meterGain: 11, trail: 'foot_L',
    props: { homing: true, wallCarry: 2.4 },
  });
  mv({
    id: 'shadowRush', name: 'Shadow Rush', input: 'ff+3', clip: 'k.spinKick', tag: 'rush',
    active: [W(16, 18, FOOT_L(0.27))], total: 46,
    height: HEIGHT.HIGH, weight: WEIGHT.HEAVY, damage: 21,
    adv: { block: -11, hit: 4 }, reaction: REACTION.SPIN,
    knockback: [6.0, 1.2, 0], blockPush: [2.8, 0, 0], meterGain: 9,
    props: { wallCarry: 2.2, travel: [{ from: 4, to: 16, x: 4.4, z: 0 }] },
    cancels: ['shadowRush2'], cancelWindow: [16, 45],
  });
  mv({
    id: 'shadowRush2', name: 'Shadow Terminus', input: 'ff+3,4', clip: 'k.axeKick', tag: 'string',
    active: [W(17, 19, FOOT_R(0.27))], total: 48,
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
    active: [W(18, 19, SHIN_L(0.26))], total: 42,
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
    active: [W(20, 23, FOOT_L(0.29))], total: 56,
    height: HEIGHT.MID, weight: WEIGHT.LAUNCHER, damage: 24,
    adv: { block: -15, hit: 22 }, reaction: REACTION.LAUNCH, juggleHeight: 7.0,
    knockback: [3.0, 0, 0], blockPush: [2.4, 0, 0], meterGain: 12, trail: 'foot_L',
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

/** @type {Record<string, Record<string, import('./MoveSchema.js').Move>>} */
export const MOVES = {
  standard: buildMoveSet(ARCHETYPES.standard),
  heavy: buildMoveSet(ARCHETYPES.heavy),
  agile: buildMoveSet(ARCHETYPES.agile),
  technical: buildMoveSet(ARCHETYPES.technical),
};

export const MOVE_SET_KEYS = Object.keys(MOVES);

/** Display label for a move set, for the character-select and command list. */
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
    }));
    rows.sort((a, b) => (a.input.split(',')[0].localeCompare(b.input.split(',')[0])) ||
      (a.input.length - b.input.length) || (a.startup - b.startup));
    return [key, rows];
  }),
);

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
function matchesEntry(p, e, live, tick) {
  for (const b of p.buttons) if (!e.btns.has(b)) return false;
  if (p.motion) return e.motion === p.motion || (live && live.motion === p.motion && tick - e.tick <= 4);
  if (dirMatches(p.dir, e)) return true;
  if (live && tick - e.tick <= 4 && dirMatches(p.dir, live)) return true;
  return false;
}

/**
 * Resolve the move a fighter should start this tick.
 *
 * Handles, in priority order: string continuations inside the current move's
 * cancel window, then root moves ordered by input specificity. Every candidate
 * is tested against the fighter's input buffer newest-first, so a press made a
 * few ticks before the fighter became actionable still comes out.
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

  const tryMatch = (mv, parsed) => {
    if (!canUse(mv, fighterState)) return false;
    for (let i = buffer.length - 1; i >= 0; i--) {
      const e = buffer[i];
      if (e.used) continue;
      if (tick - e.tick > window) break;
      if (matchesEntry(parsed, e, cmd, tick)) {
        e.used = true;
        fighterState.matchedInput = e;
        return true;
      }
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
        if (tryMatch(nxt, nxt.parsedStep)) return nxt;
      }
    }
  }

  // 2. Root moves, most specific input first.
  if (fighterState.allowRoot === false) return null;
  for (const mv of set.__ordered) {
    if (tryMatch(mv, mv.parsed)) return mv;
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
