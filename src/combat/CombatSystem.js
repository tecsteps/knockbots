/**
 * Knockbots — combat resolution.
 *
 * Every tick, after both fighters have simulated and posed themselves, this
 * system intersects the attacker's hitbox capsules with the defender's hurtbox
 * capsules, decides what happened, and tells the world about it. It is the only
 * place that may award damage or start a reaction, and it is the only place that
 * emits combat events, so the FX, audio, HUD and camera layers have exactly one
 * source of truth.
 *
 * Resolution order for a single connection:
 *   invulnerable  -> nothing happens, the box may connect again later
 *   parry window  -> parry, the attacker eats a big stagger
 *   armour window -> the defender pays reduced damage and keeps attacking
 *   guard         -> by attack height against the defender's stance
 *   counter-hit   -> the defender was mid-move: more damage, more stun
 *   hit           -> scaled by combo index and juggle decay
 *
 * Guard follows Tekken's rules rather than a simplified rock-paper-scissors:
 * standing guard stops highs and mids, crouching guard stops lows, mids beat a
 * crouching guard, lows beat a standing guard, and a full crouch ducks highs
 * entirely so they whiff and can be launch-punished.
 */

import * as THREE from 'three';
import {
  HEIGHT, WEIGHT, REACTION, HITSTOP, COMBO_SCALING, MIN_COMBO_SCALE,
  JUGGLE_DECAY, MIN_JUGGLE_SCALE, WALL_SPLAT_SPEED, MAX_HEALTH,
  METER_ON_DEAL, GROUND_Y, ARENA_HALF_WIDTH, ARENA_HALF_DEPTH,
} from '../core/Constants.js';
import { bus } from '../core/Bus.js';
import { Rng } from '../core/Rng.js';
import { isActive } from './MoveSchema.js';
import { STATE } from './Fighter.js';

const COUNTER_DAMAGE = 1.28;
const COUNTER_STUN = 7;
const COMBO_DROP_TICKS = 24;

const SHAKE_BY_WEIGHT = {
  [WEIGHT.LIGHT]: 0.10,
  [WEIGHT.MEDIUM]: 0.19,
  [WEIGHT.HEAVY]: 0.34,
  [WEIGHT.LAUNCHER]: 0.30,
  [WEIGHT.ULTRA]: 0.62,
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _c2 = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _nrm = new THREE.Vector3();

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Squared distance between two segments, writing the closest points to c1/c2.
 * This is the whole of collision detection in this game: hurtboxes and hitboxes
 * are both capsules, and a capsule is a segment plus a radius.
 */
function segSegDistSq(p1, q1, p2, q2, c1, c2) {
  const d1 = _a.subVectors(q1, p1);
  const d2 = _b.subVectors(q2, p2);
  const r = _c.subVectors(p1, p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const EPS = 1e-8;
  let s = 0, t = 0;

  if (a <= EPS && e <= EPS) {
    c1.copy(p1); c2.copy(p2);
    return c1.distanceToSquared(c2);
  }
  if (a <= EPS) {
    t = clamp01(f / e);
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      s = clamp01(-c / a);
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  c1.copy(p1).addScaledVector(d1, s);
  c2.copy(p2).addScaledVector(d2, t);
  return c1.distanceToSquared(c2);
}

export class CombatSystem {
  /**
   * @param {import('./Fighter.js').Fighter[]} fighters
   * @param {Object} stage
   */
  constructor(fighters, stage) {
    this.fighters = fighters;
    this.stage = stage;
    this.tick = 0;
    this.round = 0;
    this.roundOver = false;
    this.rng = new Rng(0x2f6e1b3d);

    /** Per-attacker combo bookkeeping. */
    this.combos = fighters.map(() => ({ hits: 0, damage: 0, lastTick: -999 }));

    this.applyBounds();
  }

  /** Push the stage's real dimensions into both fighters. */
  applyBounds() {
    const bounds = this.stage?.bounds || { halfWidth: ARENA_HALF_WIDTH, halfDepth: ARENA_HALF_DEPTH };
    const floorY = this.stage?.floorY ?? GROUND_Y;
    for (const f of this.fighters) f.setBounds(bounds, floorY);
  }

  reset() {
    this.round++;
    this.roundOver = false;
    for (const c of this.combos) { c.hits = 0; c.damage = 0; c.lastTick = -999; }
    this.applyBounds();
  }

  // -------------------------------------------------------------------------

  /** One tick of resolution. Call after both fighters have simulated. */
  simulate(tick) {
    this.tick = tick;
    const [f0, f1] = this.fighters;
    if (!f0 || !f1) return;

    this.#resolveThrow(f0, f1);
    this.#resolveThrow(f1, f0);

    // Gather both directions before applying anything, so simultaneous
    // connections are a genuine trade rather than an ordering artefact.
    const h0 = this.#findConnection(f0, f1);
    const h1 = this.#findConnection(f1, f0);
    const p0 = h0 ? this.#snapshot(f1) : null;
    const p1 = h1 ? this.#snapshot(f0) : null;

    if (h0 && h1) {
      const w = this.#tradeWinner(h0, h1);
      if (w === 0) { this.#resolve(f0, f1, h0, p0); }
      else if (w === 1) { this.#resolve(f1, f0, h1, p1); }
      else { this.#resolve(f0, f1, h0, p0); this.#resolve(f1, f0, h1, p1); }
    } else if (h0) {
      this.#resolve(f0, f1, h0, p0);
    } else if (h1) {
      this.#resolve(f1, f0, h1, p1);
    }

    this.#resolveWalls(f0);
    this.#resolveWalls(f1);
    this.#separateAtWall();
    this.#updateCombos();
    this.#checkKO();
  }

  /**
   * -1 = both land (a trade), otherwise the index of the move that wins outright.
   * A strike beats a throw attempt, and an overdrive beats anything short of
   * another overdrive.
   */
  #tradeWinner(h0, h1) {
    const m0 = h0.hitbox.move;
    const m1 = h1.hitbox.move;
    const t0 = !!m0.props.throw;
    const t1 = !!m1.props.throw;
    if (t0 !== t1) return t0 ? 1 : 0;
    const u0 = m0.weight === WEIGHT.ULTRA;
    const u1 = m1.weight === WEIGHT.ULTRA;
    if (u0 !== u1) return u0 ? 0 : 1;
    return -1;
  }

  /** Freeze the defender's guard/state before any hit mutates it. */
  #snapshot(f) {
    return {
      state: f.state,
      blocking: f.isBlocking,
      crouching: f.crouching,
      airborne: f.airborne,
      juggleCount: f.juggleCount,
      invulnerable: f.invulnerable,
    };
  }

  // --- intersection --------------------------------------------------------

  /**
   * First hitbox/hurtbox pair that overlaps this tick.
   * @returns {?{hitbox:Object, hurtbox:Object, point:THREE.Vector3, depth:number}}
   */
  #findConnection(attacker, defender) {
    const boxes = attacker.hitboxes;
    if (!boxes || !boxes.length) return null;
    if (defender.state === STATE.KO || attacker.state === STATE.KO) return null;
    if (defender.state === STATE.THROWN || attacker.state === STATE.THROW) return null;

    const move = boxes[0].move;
    const grounded = defender.state === STATE.KNOCKDOWN || defender.state === STATE.WAKEUP;
    if (grounded && !move.props.hitsGrounded) return null;

    let best = null;
    let bestDepth = -Infinity;
    for (const hb of boxes) {
      if (attacker.connected.has(`${attacker.moveInstance}:${hb.windowIndex}`)) continue;
      for (const hu of defender.hurtboxes) {
        const rr = hb.radius + hu.radius;
        const d2 = segSegDistSq(hb.p0, hb.p1, hu.p0, hu.p1, _c1, _c2);
        if (d2 > rr * rr) continue;
        const depth = rr - Math.sqrt(d2);
        if (depth > bestDepth) {
          bestDepth = depth;
          best = best || { hitbox: null, hurtbox: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), depth: 0 };
          best.hitbox = hb;
          best.hurtbox = hu;
          best.depth = depth;
          best.point.copy(_c1).add(_c2).multiplyScalar(0.5);
          best.normal.copy(_c2).sub(_c1);
          if (best.normal.lengthSq() < 1e-8) best.normal.set(attacker.facing, 0.2, 0);
          best.normal.normalize();
        }
      }
    }
    return best;
  }

  // --- resolution ----------------------------------------------------------

  #resolve(attacker, defender, hit, snap) {
    const move = hit.hitbox.move;

    // Invulnerability lets the box pass through without being consumed, so a
    // long active window can still catch the defender once the i-frames end.
    if (snap.invulnerable) return;

    attacker.registerConnect(hit.hitbox.windowIndex);

    if (defender.canParryMove(move)) { this.#doParry(attacker, defender, move, hit); return; }
    if (defender.armorActive()) { this.#doArmor(attacker, defender, move, hit); return; }

    const guard = this.#guardResult(move, snap);
    if (guard === 'whiff') return;
    if (guard === 'block') { this.#doBlock(attacker, defender, move, hit); return; }
    this.#doHit(attacker, defender, move, hit, snap);
  }

  /**
   * @returns {'hit'|'block'|'whiff'}
   */
  #guardResult(move, snap) {
    if (move.height === HEIGHT.UNBLOCKABLE) return 'hit';
    if (move.props.throw) return 'hit';
    // A full crouch ducks highs whether or not the defender is guarding.
    if (move.height === HEIGHT.HIGH && snap.crouching && !snap.airborne) return 'whiff';
    if (!snap.blocking || snap.airborne) return 'hit';
    if (move.height === HEIGHT.LOW) return snap.crouching ? 'block' : 'hit';
    if (move.height === HEIGHT.MID) return snap.crouching ? 'hit' : 'block';
    return 'block';
  }

  #doHit(attacker, defender, move, hit, snap) {
    const combo = this.combos[attacker.index];

    // A hit only continues the combo if the defender was already committed to
    // eating it. Anything else — neutral, block, wakeup — starts a fresh count.
    const chaining = snap.state === STATE.HITSTUN || snap.state === STATE.LAUNCHED ||
      snap.state === STATE.JUGGLED || snap.airborne;
    if (!chaining) { combo.hits = 0; combo.damage = 0; }

    const counter = !snap.airborne && !chaining && this.#isCounterState(snap);
    const scaleIdx = Math.min(combo.hits, COMBO_SCALING.length - 1);
    const comboScale = Math.max(MIN_COMBO_SCALE, COMBO_SCALING[scaleIdx]);
    const juggleScale = Math.max(MIN_JUGGLE_SCALE, Math.pow(JUGGLE_DECAY, snap.juggleCount));

    const windowDamage = move.active[hit.hitbox.windowIndex]?.damage ?? move.damage;
    let damage = windowDamage * comboScale * (counter ? COUNTER_DAMAGE : 1);
    damage *= 0.85 + (attacker.stats.power ?? 5) * 0.03;

    // Counter hits can promote a move into a launcher.
    const cl = counter ? move.props.counterLaunch : null;
    const reaction = cl?.reaction || move.reaction;
    const launch = reaction === REACTION.LAUNCH;
    const hitStun = Math.round((cl?.hitStun ?? move.hitStun) + (counter ? COUNTER_STUN : 0));

    const info = {
      damage,
      hitStun,
      counter,
      reaction,
      launch,
      juggleHeight: (cl?.juggleHeight ?? move.juggleHeight ?? 4.2) * juggleScale,
      juggleScale: 1,
      knockbackDir: attacker.facing,
      groundBounce: move.props.groundBounce || 0,
    };

    defender.isCounterHit = counter;
    const applied = defender.applyHit(move, attacker, hit.point, info);

    combo.hits++;
    combo.damage += applied;
    combo.lastTick = this.tick;
    attacker.comboCount = combo.hits;
    attacker.comboDamage = combo.damage;

    attacker.addMeter(applied * METER_ON_DEAL + move.meterGain);

    // Wall carry: heavy pushes shove the pair toward the wall for splats.
    if (move.props.wallCarry) {
      defender.velocity.x += attacker.facing * move.props.wallCarry;
    }

    const stopTicks = Math.round((HITSTOP[move.weight] ?? 6) * (counter ? 1.35 : 1));
    const shake = (SHAKE_BY_WEIGHT[move.weight] ?? 0.2) * (counter ? 1.4 : 1);

    bus.emit('hit', {
      attacker, defender, move,
      point: hit.point.clone(), normal: hit.normal.clone(),
      damage: applied, counter, region: hit.hurtbox.region || 'torso',
      comboCount: combo.hits,
    });
    bus.emit('hitstop', { ticks: stopTicks });
    bus.emit('shake', { amount: shake, ticks: Math.max(6, Math.round(stopTicks * 1.3)) });

    if (move.props.super) {
      bus.emit('superHit', { attacker, defender, move });
      bus.emit('timeScale', { scale: 0.3, ticks: 22 });
    } else if (counter && move.weight !== WEIGHT.LIGHT) {
      bus.emit('timeScale', { scale: 0.55, ticks: 8 });
    }

    if (this.stage?.impact && move.weight !== WEIGHT.LIGHT) {
      this.stage.impact(hit.point, (SHAKE_BY_WEIGHT[move.weight] ?? 0.2) * 3);
    }
  }

  /** A defender is counter-hit when caught inside their own move. */
  #isCounterState(snap) {
    return snap.state === STATE.ATTACK || snap.state === STATE.THROW ||
      snap.state === STATE.SIDESTEP || snap.state === STATE.DASH;
  }

  #doBlock(attacker, defender, move, hit) {
    const chip = defender.applyBlock(move, attacker, hit.point, {});
    attacker.addMeter(move.meterGain * 0.4);
    // The attacker is pushed back too, which is what makes strings safe at range.
    const push = move.blockPush || [1.5, 0, 0];
    attacker.velocity.x -= attacker.facing * push[0] * 0.35;
    this.combos[attacker.index].hits = 0;
    this.combos[attacker.index].damage = 0;

    bus.emit('block', { attacker, defender, move, point: hit.point.clone() });
    bus.emit('hitstop', { ticks: Math.max(3, Math.round((HITSTOP[move.weight] ?? 6) * 0.55)) });
    bus.emit('shake', { amount: (SHAKE_BY_WEIGHT[move.weight] ?? 0.2) * 0.45, ticks: 6 });
    if (this.stage?.impact && move.weight === WEIGHT.HEAVY) this.stage.impact(hit.point, 0.6);
    return chip;
  }

  #doArmor(attacker, defender, move, hit) {
    defender.absorbArmor(move, attacker, hit.point);
    attacker.addMeter(move.meterGain * 0.3);
    this.combos[attacker.index].hits = 0;
    this.combos[attacker.index].damage = 0;
    bus.emit('hitstop', { ticks: 6 });
    bus.emit('shake', { amount: 0.25, ticks: 8 });
  }

  #doParry(attacker, defender, move, hit) {
    defender.parrySuccess(move, attacker, hit.point);
    // The parried attacker is frozen long enough to be punished by the riposte.
    attacker.applyBlock(move, defender, hit.point, { blockStun: 30, damage: 0 });
    this.combos[attacker.index].hits = 0;
    this.combos[attacker.index].damage = 0;
    bus.emit('hitstop', { ticks: 14 });
    bus.emit('shake', { amount: 0.3, ticks: 12 });
    bus.emit('timeScale', { scale: 0.4, ticks: 14 });
  }

  // --- throws --------------------------------------------------------------

  #resolveThrow(attacker, defender) {
    if (attacker.state !== STATE.ATTACK) return;
    const move = attacker.currentMove;
    if (!move || !move.props.throw) return;
    if (!isActive(move, attacker.moveTick)) return;
    const wi = move.active.findIndex((w) => attacker.moveTick >= w.from && attacker.moveTick <= w.to);
    if (attacker.connected.has(`${attacker.moveInstance}:${wi}`)) return;

    const t = move.props.throw;
    const dx = Math.abs(defender.position.x - attacker.position.x);
    const dz = Math.abs(defender.position.z - attacker.position.z);
    if (dx > t.range || dz > 0.95) return;

    // Throws do not catch airborne, downed, already-stunned or backdashing
    // opponents — that is what makes backdash a real defensive option.
    if (defender.airborne || defender.throwInvuln > 0) return;
    if (defender.state === STATE.KNOCKDOWN || defender.state === STATE.KO ||
        defender.state === STATE.THROWN || defender.state === STATE.LAUNCHED ||
        defender.state === STATE.JUGGLED) return;
    if (defender.invulnerable) return;

    attacker.registerConnect(wi);
    // Caught from behind: more damage, and barely any time to break out.
    const behind = attacker.facing === defender.facing;
    attacker.beginThrow(move, defender, behind
      ? { breakWindow: [t.breakWindow[0], Math.min(t.breakWindow[1], 7)], damageScale: 1.25 }
      : null);
    bus.emit('shake', { amount: 0.18, ticks: 8 });
  }

  // --- walls, floors, combos, KO -------------------------------------------

  #resolveWalls(f) {
    const wi = f.wallImpact;
    if (!wi) return;
    // Anything the fighter did not choose counts: a knockdown flying backwards
    // splats just as hard as a juggle does.
    const stunned = f.state === STATE.HITSTUN || f.state === STATE.LAUNCHED ||
      f.state === STATE.JUGGLED || f.state === STATE.BLOCKSTUN ||
      f.state === STATE.KNOCKDOWN;
    _pt.copy(f.position);
    _pt.y += 1.0;
    if (!stunned || wi.speed < WALL_SPLAT_SPEED) {
      if (wi.speed > 2.5 && this.stage?.impact) this.stage.impact(_pt, 0.4);
      return;
    }

    _nrm.set(wi.normal, 0, 0);
    bus.emit('wallSplat', { fighter: f, point: _pt.clone(), normal: _nrm.clone() });
    bus.emit('hitstop', { ticks: 9 });
    bus.emit('shake', { amount: 0.42, ticks: 14 });
    if (this.stage?.impact) this.stage.impact(_pt, 1.4);

    f.velocity.set(wi.normal * 1.6, Math.max(f.velocity.y * 0.2, 0.6), 0);
    f.airborne = true;
    f.grounded = false;
    f.state = STATE.HITSTUN;
    f.stateTicks = 0;
    f.stunTicks = Math.max(f.stunTicks, 34);
    f.reaction = REACTION.WALL_SPLAT;
    f.playClip('r.wallSplat', 2, false);
    f.wallImpact = null;
  }

  /**
   * When one fighter is pinned against a wall the symmetric half-and-half push
   * cannot separate the pair, so shove the free one out the rest of the way.
   */
  #separateAtWall() {
    const [a, b] = this.fighters;
    if (!a || !b) return;
    if (a.state === STATE.THROW || a.state === STATE.THROWN) return;
    const minD = a.radius + b.radius;
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const d = Math.hypot(dx, dz);
    if (d >= minD) return;
    const limX = a.bounds.halfWidth - a.radius;
    const aPinned = Math.abs(a.position.x) >= limX - 1e-3;
    const bPinned = Math.abs(b.position.x) >= limX - 1e-3;
    if (aPinned === bPinned) return;
    const free = aPinned ? b : a;
    const pinned = aPinned ? a : b;
    const need = minD - d + 1e-3;
    let ux, uz;
    if (d < 1e-5) { ux = -Math.sign(pinned.position.x) || 1; uz = 0; }
    else { ux = (free.position.x - pinned.position.x) / d; uz = (free.position.z - pinned.position.z) / d; }
    free.position.x = THREE.MathUtils.clamp(free.position.x + ux * need, -limX, limX);
    free.position.z += uz * need;
  }

  #updateCombos() {
    for (let i = 0; i < this.fighters.length; i++) {
      const c = this.combos[i];
      if (c.hits === 0) continue;
      const attacker = this.fighters[i];
      const defender = this.fighters[1 - i];
      const stillGoing = defender.state === STATE.HITSTUN || defender.state === STATE.LAUNCHED ||
        defender.state === STATE.JUGGLED || defender.state === STATE.THROWN ||
        defender.state === STATE.KNOCKDOWN || defender.airborne ||
        this.tick - c.lastTick <= COMBO_DROP_TICKS;
      if (stillGoing) continue;
      bus.emit('comboEnd', { fighter: attacker, hits: c.hits, damage: Math.round(c.damage) });
      c.hits = 0;
      c.damage = 0;
      attacker.comboCount = 0;
      attacker.comboDamage = 0;
    }
  }

  #checkKO() {
    if (this.roundOver) return;
    const [a, b] = this.fighters;
    const aDead = a.health <= 0;
    const bDead = b.health <= 0;
    if (!aDead && !bDead) return;

    this.roundOver = true;
    const winner = aDead && bDead ? -1 : (aDead ? 1 : 0);
    const loser = winner === -1 ? -1 : 1 - winner;
    const perfect = winner >= 0 && this.fighters[winner].health >= MAX_HEALTH - 0.01;

    for (let i = 0; i < this.combos.length; i++) {
      const c = this.combos[i];
      if (c.hits > 0) {
        bus.emit('comboEnd', { fighter: this.fighters[i], hits: c.hits, damage: Math.round(c.damage) });
        c.hits = 0; c.damage = 0;
      }
    }

    bus.emit('timeScale', { scale: 0.22, ticks: 90 });
    bus.emit('shake', { amount: 0.75, ticks: 22 });
    bus.emit('hitstop', { ticks: 16 });
    if (loser >= 0 && this.stage?.impact) {
      _pt.copy(this.fighters[loser].position).setY(this.fighters[loser].position.y + 0.6);
      this.stage.impact(_pt, 2.2);
    }
    if (winner >= 0) this.fighters[winner].celebrate();
    bus.emit('roundEnd', { round: this.round, winner, ko: true, perfect });
  }

  /** The clock ran out: whoever has more health left takes the round. */
  timeOut() {
    if (this.roundOver) return;
    this.roundOver = true;
    const [a, b] = this.fighters;
    const winner = a.health === b.health ? -1 : (a.health > b.health ? 0 : 1);
    if (winner >= 0) this.fighters[winner].celebrate();
    bus.emit('timeScale', { scale: 0.4, ticks: 60 });
    bus.emit('roundEnd', { round: this.round, winner, ko: false, perfect: false });
  }
}
