/**
 * Knockbots — the CPU opponent.
 *
 * `think(tick)` returns a synthetic `Command`, shaped exactly like the object
 * `Input.commandsFor()` produces (see `src/core/Input.js`), so `Fighter` cannot
 * tell the difference between a human and the CPU: both are just a Command fed
 * into `simulate()`.
 *
 * The bot is built from three layers rather than one big switch:
 *
 *  1. Perception — every tick we record a snapshot of the opponent's public
 *     state (state machine, current move, airborne flag) into a small ring
 *     buffer. Reactive decisions (blocking, anti-air) read that buffer
 *     `reactionTicks` ago instead of the live value, so the CPU is physically
 *     incapable of blocking a move before it has had time to see it start.
 *     Own-body facts (did I just leave blockstun, am I being thrown) need no
 *     such delay — that is proprioception, not reaction.
 *  2. Event memory — the bus tells us the things a snapshot can't capture:
 *     a whiff, a landed launcher, a block. These arm one-shot opportunities
 *     (punish, combo route) that decay if not used.
 *  3. Decision — a fixed priority list per tick: finish what I'm committed to,
 *     cash in an armed opportunity, react to a threat, otherwise play the
 *     neutral game (space, poke, throw, approach).
 *
 * Every random decision (block roll, punish roll, move choice inside a pool)
 * goes through `Rng`, reseeded on `roundStart`, so a given seed reproduces a
 * given match — the CPU is exactly as deterministic as the rest of the sim.
 *
 * Ten difficulty levels are one interpolation each across a handful of curves
 * (reaction ticks, block/punish/tech/whiff accuracy, combo length, aggression).
 * Level 1 reacts slowly, whiffs punishes, drops combos after one hit and rarely
 * techs. Level 10 reacts inside a jab's startup, punishes every unsafe string
 * on frame data, runs the full route off a launcher, and techs throws often
 * enough to make grabbing risky — dangerous, but still bounded by the same
 * perception delay and dice rolls a human opponent would be, never omniscient.
 */

import { STATE } from '../combat/Fighter.js';
import { MOVES, getMove, findMoveByTag } from '../combat/Moves.js';
import { HEIGHT } from '../core/Constants.js';
import { Rng } from '../core/Rng.js';
import { bus } from '../core/Bus.js';

// ---------------------------------------------------------------------------
// Difficulty curves. `lerpLevel(1)` is the floor, `lerpLevel(10)` the ceiling.
// ---------------------------------------------------------------------------

function curve(level, lo, hi) {
  const t = (Math.min(10, Math.max(1, level)) - 1) / 9;
  return lo + (hi - lo) * t;
}

/** Direction-prefix -> Command flags, mirroring Input.js's own axis convention. */
const DIR_FLAGS = {
  '': { fwd: false, back: false, up: false, down: false, x: 0, y: 0 },
  f: { fwd: true, back: false, up: false, down: false, x: 1, y: 0 },
  b: { fwd: false, back: true, up: false, down: false, x: -1, y: 0 },
  u: { fwd: false, back: false, up: true, down: false, x: 0, y: 1 },
  d: { fwd: false, back: false, up: false, down: true, x: 0, y: -1 },
  df: { fwd: true, back: false, up: false, down: true, x: 1, y: -1 },
  db: { fwd: false, back: true, up: false, down: true, x: -1, y: -1 },
  uf: { fwd: true, back: false, up: true, down: false, x: 1, y: 1 },
  ub: { fwd: false, back: true, up: true, down: false, x: -1, y: 1 },
};

// Spacing bands, metres. Rough — real reach varies per character — but stable
// enough to drive believable footsies without reading hidden hitbox data.
const THROW_RANGE = 1.55;
const FOOTSIE_RANGE = 2.65;
const APPROACH_RANGE = 3.6;
const ANTI_AIR_RANGE = 2.3;
const PUNISH_RANGE = 2.4;

// A launcher connects; this is the string the CPU throws out while the
// opponent is still in the air. All four move sets share these core ids
// (see Moves.js `coreMoves`), so one table serves every character. Ordered
// cheapest/fastest first so a short `comboLength` still lands *something*.
const JUGGLE_ROUTE = ['midPunch', 'elbow', 'overhand', 'launcherPunch'];

// How many recent (height) observations the read-history keeps before it
// starts halving instead of growing, so it tracks the opponent's *recent*
// tendency rather than their entire match.
const HEIGHT_HISTORY_CAP = 40;

const PERCEPTION_BUFFER = 48; // ticks of history; comfortably covers the reaction range below

const BLANK_PERCEIVED = Object.freeze({ state: STATE.IDLE, moveId: null, moveTick: 0, moveInstance: -1, airborne: false });

export class CPU {
  /**
   * @param {import('../combat/Fighter.js').Fighter} self
   * @param {import('../combat/Fighter.js').Fighter} opponent
   * @param {{level:number}} opts level 1..10, 1 = easiest, 10 = hardest
   */
  constructor(self, opponent, { level = 5 } = {}) {
    this.self = self;
    this.opponent = opponent;
    this.setLevel(level);

    this._seedBase = 0xC0FFEE ^ (self.index << 16);
    this.rng = new Rng(this._seedBase);

    // The Command object. Reused every tick — Fighter only ever reads it, and
    // nothing downstream retains it past the tick it was issued.
    this.cmd = {
      x: 0, y: 0, up: false, down: false, fwd: false, back: false,
      pressed: new Set(), held: new Set(), notation: '', buffer: [], motion: null,
    };

    // Perception ring buffer: what did the opponent look like N ticks ago?
    // Indexed by an internal counter, not the raw sim tick, because CPU.think
    // is only called during PHASE.FIGHT — ticks elapse without a corresponding
    // write during intros, KO holds and round transitions, and a modulo of the
    // raw tick would then collide with stale entries from a previous phase.
    this._localTick = 0;
    this.buf = Array.from({ length: PERCEPTION_BUFFER }, () => ({
      state: STATE.IDLE, moveId: null, moveTick: 0, moveInstance: -1, airborne: false,
    }));

    // One-shot opportunities, armed by bus events and consumed by the
    // decision layer. `null`/`false` means "nothing pending".
    this._oppWhiff = null;             // { tick, move }
    this._pendingPunish = null;        // { move, sinceTick }
    this.pendingRouteTrigger = false;  // our own launcher just connected
    this.route = null;                 // { steps, idx, pressed, pressTick, confirmedStarted }

    // Per-incoming-move guard decision, so a block roll happens once per
    // attack rather than once per tick (which would make `blockRate` mean
    // "chance per frame", not "chance to guess right").
    this._guardDecision = null;        // { instance, willBlock, willCrouch }
    this._heightHist = { high: 0, mid: 0, low: 0 };

    this._techGrab = null;             // the throwData object we've already rolled tech for
    this._willTech = false;
    this._wakeupDecided = false;
    this._wakeupAttack = false;
    this._cancelAttempted = -1;        // moveInstance we already rolled a string-extension for

    this._notationHistory = [];

    this._unsubs = [
      bus.on('whiff', (p) => { if (p.fighter === this.opponent) this._oppWhiff = { tick: this._lastTick, move: p.move }; }),
      bus.on('launch', (p) => { if (p.fighter === this.opponent) this.pendingRouteTrigger = true; }),
      bus.on('block', (p) => {
        if (p.defender === this.self && p.attacker === this.opponent) this._pendingPunish = { move: p.move, sinceTick: this._lastTick };
        if (p.attacker === this.opponent) this.#recordHeight(p.move.height);
      }),
      bus.on('hit', (p) => { if (p.attacker === this.opponent) this.#recordHeight(p.move.height); }),
      bus.on('roundStart', ({ round }) => this.#resetForRound(round)),
    ];
  }

  /** Re-tune every difficulty curve. Safe to call mid-match (e.g. a menu slider). */
  setLevel(level) {
    this.level = level;
    this.reactionTicks = Math.round(curve(level, 26, 6));
    this.blockRate = curve(level, 0.28, 0.94);
    this.crouchConfidence = curve(level, 0.12, 0.85);
    this.punishAccuracy = curve(level, 0.15, 0.95);
    this.techRate = curve(level, 0.08, 0.85);
    this.antiAirRate = curve(level, 0.12, 0.9);
    this.whiffPunishRate = curve(level, 0.1, 0.9);
    this.aggression = curve(level, 0.28, 0.75);
    this.comboLength = Math.round(curve(level, 1, JUGGLE_ROUTE.length));
    this.dashInRate = curve(level, 0.05, 0.3);
    this.wakeupAggression = curve(level, 0.1, 0.7);
    this.throwRate = curve(level, 0.04, 0.3);
    this.sidestepRate = curve(level, 0.015, 0.12);
  }

  #resetForRound(round = 1) {
    this.rng.reseed(this._seedBase ^ Math.imul(round + 1, 0x9E3779B1));
    this._localTick = 0;
    for (const r of this.buf) { r.state = STATE.IDLE; r.moveId = null; r.moveTick = 0; r.moveInstance = -1; r.airborne = false; }
    this._oppWhiff = null;
    this._pendingPunish = null;
    this.pendingRouteTrigger = false;
    this.route = null;
    this._guardDecision = null;
    this._techGrab = null;
    this._wakeupDecided = false;
    this._cancelAttempted = -1;
  }

  dispose() { for (const off of this._unsubs) off(); }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  /**
   * Advance one tick and return this fighter's Command for it.
   * @param {number} tick global sim tick, for event-recency comparisons
   * @returns {Object} Command — see src/core/Input.js
   */
  think(tick) {
    this._lastTick = tick;
    this.#writePerception();
    this._localTick++;
    this.#neutralCmd();

    const s = this.self.state;
    if (s === STATE.KO || s === STATE.VICTORY || s === STATE.INTRO) return this.cmd;
    if (s === STATE.THROWN) { this.#tickThrown(); return this.cmd; }
    if (s === STATE.KNOCKDOWN || s === STATE.WAKEUP) { this.#tickWakeup(); return this.cmd; }
    if (s === STATE.HITSTUN || s === STATE.LAUNCHED || s === STATE.JUGGLED ||
        s === STATE.BLOCKSTUN || s === STATE.THROW) return this.cmd;

    this.#decide();
    return this.cmd;
  }

  // -------------------------------------------------------------------------
  // Perception
  // -------------------------------------------------------------------------

  #writePerception() {
    const rec = this.buf[this._localTick % this.buf.length];
    const o = this.opponent;
    rec.state = o.state;
    rec.moveId = o.currentMove ? o.currentMove.id : null;
    rec.moveTick = o.moveTick;
    rec.moveInstance = o.moveInstance;
    rec.airborne = o.airborne;
  }

  /** The opponent as this CPU currently *believes* them to be — delayed. */
  #perceived() {
    if (this._localTick <= this.reactionTicks) return BLANK_PERCEIVED;
    return this.buf[(this._localTick - 1 - this.reactionTicks) % this.buf.length];
  }

  #recordHeight(height) {
    const h = this._heightHist;
    if (h.high + h.mid + h.low >= HEIGHT_HISTORY_CAP) { h.high *= 0.5; h.mid *= 0.5; h.low *= 0.5; }
    if (height === HEIGHT.LOW) h.low++;
    else if (height === HEIGHT.MID) h.mid++;
    else h.high++;
  }

  /** Blend a neutral guess with the opponent's recent high/mid/low mix — a read, not a peek. */
  #lowReadProbability() {
    const h = this._heightHist;
    const total = h.high + h.mid + h.low;
    const observed = total > 3 ? h.low / total : 0.28;
    return 0.28 + (observed - 0.28) * this.crouchConfidence;
  }

  // -------------------------------------------------------------------------
  // Decision
  // -------------------------------------------------------------------------

  #decide() {
    const dist = Math.abs(this.opponent.position.x - this.self.position.x);

    if (this.route) { this.#runRoute(); return; }
    if (this.self.state === STATE.ATTACK) { this.#duringOwnAttack(); return; }
    if (this.pendingRouteTrigger) { this.#startRoute(); this.#runRoute(); return; }
    if (this.#tryPunish()) return;

    const opp = this.#perceived();
    if (this.#tryAntiAir(opp, dist)) return;
    if (this.#tryBlock(opp)) return;
    if (this.#tryWhiffPunish(dist)) return;

    this.#neutralGame(dist);
  }

  // --- committed states ------------------------------------------------

  /** Mid-move: usually just ride it out, but a real bot strings pressure together. */
  #duringOwnAttack() {
    const mv = this.self.currentMove;
    if (!mv || !mv.cancels || !mv.cancels.length) return;
    if (this._cancelAttempted === this.self.moveInstance) return;
    const [from] = mv.cancelWindow || [mv.startup];
    if (this.self.moveTick < from) return;
    this._cancelAttempted = this.self.moveInstance;
    if (this.rng.next() >= this.aggression) return; // chose to stay safe instead of extending

    const set = MOVES[this.self.moveSetKey] || MOVES.standard;
    const candidates = mv.cancels.map((id) => set[id]).filter(Boolean);
    if (!candidates.length) return;
    this.#pressCancel(this.rng.pick(candidates));
  }

  /** Combo route: fire each queued step once, waiting for confirmation before advancing. */
  #startRoute() {
    this.pendingRouteTrigger = false;
    const set = MOVES[this.self.moveSetKey] || MOVES.standard;
    const steps = JUGGLE_ROUTE.slice(0, this.comboLength).map((id) => getMove(set, id)).filter(Boolean);
    this.route = steps.length ? { steps, idx: 0, pressed: false, pressTick: 0, confirmedStarted: false } : null;
  }

  #runRoute() {
    const r = this.route;
    const opp = this.opponent;
    // The juggle window closed — the victim is down, not airborne. Stop
    // throwing moves into empty air; fall through to neutral/oki next tick.
    if (r.idx === 0 && !r.confirmedStarted && !opp.airborne &&
        opp.state !== STATE.LAUNCHED && opp.state !== STATE.JUGGLED && opp.state !== STATE.KNOCKDOWN) {
      this.route = null;
      return;
    }
    if (opp.state === STATE.KNOCKDOWN) { this.route = null; return; }

    const step = r.steps[r.idx];
    const cur = this.self.currentMove;

    if (!r.confirmedStarted) {
      if (cur && cur.id === step.id && this.self.state === STATE.ATTACK) {
        r.confirmedStarted = true;
        return;
      }
      if (!r.pressed) {
        this.#press(step);
        r.pressed = true;
        r.pressTick = this._localTick;
        return;
      }
      // Gave the buffer a fair window (well under INPUT_BUFFER_TICKS) to land;
      // if it never confirmed, drop the step rather than stall the route.
      if (this._localTick - r.pressTick > 16) {
        r.idx++; r.pressed = false; r.confirmedStarted = false;
        if (r.idx >= r.steps.length) this.route = null;
      }
      return;
    }

    // Running or just finished.
    if (this.self.state !== STATE.ATTACK || !cur || cur.id !== step.id) {
      r.idx++; r.pressed = false; r.confirmedStarted = false;
      if (r.idx >= r.steps.length) this.route = null;
    }
  }

  #tickThrown() {
    const d = this.self.throwData;
    if (!d) return;
    if (this._techGrab !== d) {
      this._techGrab = d;
      this._willTech = this.rng.next() < this.techRate;
    }
    if (!this._willTech) return;
    // Reuse `reactionTicks` as the recognition delay before tech attempts
    // start — a slow bot's reaction alone can outlast a short break window,
    // which is exactly why low levels almost never escape a grab.
    if (d.ticks < this.reactionTicks) return;
    const btns = (d.t && d.t.breakButtons) || [1];
    this.cmd.pressed.clear();
    this.cmd.held.clear();
    for (const b of btns) { this.cmd.pressed.add(b); this.cmd.held.add(b); }
    this.cmd.notation = String(btns[0]);
  }

  #tickWakeup() {
    const self = this.self;
    if (self.state === STATE.KNOCKDOWN) { this._wakeupDecided = false; return; }
    if (!this._wakeupDecided) {
      this._wakeupDecided = true;
      this._wakeupAttack = this.rng.next() < this.wakeupAggression;
    }
    // Fighter itself won't act on a Command until WAKEUP ends, but its own
    // input buffer keeps presses alive for INPUT_BUFFER_TICKS — so pressing
    // near the tail end means the chosen option comes out the instant control
    // returns, which is exactly what a wake-up input is.
    if (self.stunTicks > 6) return;
    if (this._wakeupAttack) {
      const set = MOVES[self.moveSetKey] || MOVES.standard;
      const mv = getMove(set, 'jab') || findMoveByTag(set, 'poke');
      if (mv) this.#press(mv);
    } else {
      this.cmd.back = true; this.cmd.x = -1;
    }
  }

  // --- reactive checks ---------------------------------------------------

  /** Cash in a block-exit: the frame data says what's safe, punishAccuracy says whether we take it. */
  #tryPunish() {
    const p = this._pendingPunish;
    if (!p) return false;
    if (this._lastTick - p.sinceTick > 90) { this._pendingPunish = null; return false; }
    this._pendingPunish = null;
    if (p.move.onBlock > -8) return false;         // nothing worth taking
    if (this.rng.next() >= this.punishAccuracy) return false;
    const set = MOVES[this.self.moveSetKey] || MOVES.standard;
    const mv = p.move.onBlock <= -13 ? (findMoveByTag(set, 'launcher') || getMove(set, 'jab')) : getMove(set, 'jab');
    if (!mv) return false;
    this.#press(mv);
    return true;
  }

  #tryAntiAir(opp, dist) {
    const jumping = opp.state === STATE.JUMP_RISE || opp.state === STATE.JUMP_APEX || opp.state === STATE.JUMP_FALL;
    if (!jumping || dist > ANTI_AIR_RANGE) return false;
    if (this.rng.next() >= this.antiAirRate) return false;
    const set = MOVES[this.self.moveSetKey] || MOVES.standard;
    const mv = findMoveByTag(set, 'launcher') || findMoveByTag(set, 'mid');
    if (!mv) return false;
    this.#press(mv);
    return true;
  }

  #tryBlock(opp) {
    if (opp.state !== STATE.ATTACK) { this._guardDecision = null; return false; }
    if (this._guardDecision?.instance !== opp.moveInstance) {
      this._guardDecision = {
        instance: opp.moveInstance,
        willBlock: this.rng.next() < this.blockRate,
        willCrouch: this.rng.next() < this.#lowReadProbability(),
      };
    }
    if (!this._guardDecision.willBlock) return false;
    this.cmd.back = true; this.cmd.fwd = false; this.cmd.x = -1;
    if (this._guardDecision.willCrouch) { this.cmd.down = true; this.cmd.y = -1; }
    return true;
  }

  #tryWhiffPunish(dist) {
    const w = this._oppWhiff;
    if (!w) return false;
    const age = this._lastTick - w.tick;
    if (age < this.reactionTicks) return false;      // still "reacting"
    this._oppWhiff = null;
    if (age > 40 || dist > PUNISH_RANGE) return false; // opportunity gone
    if (this.rng.next() >= this.whiffPunishRate) return false;
    const set = MOVES[this.self.moveSetKey] || MOVES.standard;
    const mv = (dist < THROW_RANGE + 0.3 && findMoveByTag(set, 'launcher')) || getMove(set, 'elbow') || getMove(set, 'jab');
    if (!mv) return false;
    this.#press(mv);
    return true;
  }

  // --- neutral game --------------------------------------------------------

  #neutralGame(dist) {
    const self = this.self;
    const set = MOVES[self.moveSetKey] || MOVES.standard;

    if (self.meter >= 100 && dist < FOOTSIE_RANGE && this.rng.next() < this.aggression * 0.5) {
      const overdrive = getMove(set, 'overdrive');
      if (overdrive) { this.#press(overdrive); return; }
    }

    if (dist > APPROACH_RANGE) {
      if (this.rng.next() < this.dashInRate) this.cmd.motion = 'ff';
      this.cmd.fwd = true; this.cmd.x = 1;
      return;
    }

    // Whiff-bait: hang at the edge of range and retreat instead of always
    // pressing forward — this is what makes an opponent throw the first move.
    if (dist > THROW_RANGE && dist < APPROACH_RANGE && this.rng.next() < this.sidestepRate) {
      this.cmd.back = true; this.cmd.x = -1;
      return;
    }

    if (dist <= THROW_RANGE) {
      if (this.rng.next() < this.throwRate) {
        const mv = getMove(set, this.rng.next() < 0.5 ? 'throwFwd' : 'throwBack');
        if (mv) { this.#press(mv); return; }
      }
      if (this.rng.next() < this.aggression) {
        const mv = getMove(set, 'jab');
        if (mv) { this.#press(mv); return; }
      }
      if (this.rng.next() < 0.3) { this.cmd.back = true; this.cmd.x = -1; }
      return;
    }

    // Footsie range: poke to check the opponent, or hold ground.
    if (this.rng.next() < this.aggression) {
      const pool = ['midPunch', 'elbow', 'midKick', 'knee', 'straight', 'jab'];
      const mv = getMove(set, this.rng.pick(pool));
      if (mv) { this.#press(mv); return; }
    }
    this.cmd.fwd = true; this.cmd.x = 1;
  }

  // -------------------------------------------------------------------------
  // Command assembly
  // -------------------------------------------------------------------------

  #neutralCmd() {
    this.cmd.fwd = false; this.cmd.back = false; this.cmd.up = false; this.cmd.down = false;
    this.cmd.x = 0; this.cmd.y = 0; this.cmd.motion = null; this.cmd.notation = '';
    this.cmd.pressed.clear();
    this.cmd.held.clear();
  }

  #setDir(dir) {
    const f = DIR_FLAGS[dir] || DIR_FLAGS[''];
    this.cmd.fwd = f.fwd; this.cmd.back = f.back; this.cmd.up = f.up; this.cmd.down = f.down;
    this.cmd.x = f.x; this.cmd.y = f.y;
  }

  #applyParsed(p, notation) {
    this.#setDir(p.dir);
    this.cmd.motion = p.motion || null;
    this.cmd.pressed.clear();
    this.cmd.held.clear();
    for (const b of p.buttons) { this.cmd.pressed.add(b); this.cmd.held.add(b); }
    this.cmd.notation = notation || '';
    this._notationHistory.push(this.cmd.notation);
    if (this._notationHistory.length > 8) this._notationHistory.shift();
    this.cmd.buffer = this._notationHistory;
  }

  /** Press a root move (its full notation). */
  #press(move) { this.#applyParsed(move.parsed, move.input); }

  /** Press a string continuation (its trailing token, what the cancel window matches on). */
  #pressCancel(move) { this.#applyParsed(move.parsedStep, move.stepInput); }
}
