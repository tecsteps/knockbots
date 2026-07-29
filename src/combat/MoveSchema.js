/**
 * Knockbots — move / frame-data schema.
 *
 * Frame data follows Tekken conventions. A move is described by ticks at 60Hz:
 *
 *   startup   — ticks before the first active frame (i.e. `active[0].from`)
 *   active    — the windows where a hitbox exists
 *   recovery  — ticks after the last active frame until the fighter is neutral
 *   total     — startup + active span + recovery
 *
 * On-block / on-hit advantage is derived, not authored: the defender's stun is
 * compared against the attacker's remaining recovery. Author `blockStun` and
 * `hitStun` and the engine reports the frame advantage, exactly like the real
 * thing, so the numbers can never disagree with the simulation.
 *
 * @typedef {Object} Hitbox
 * @property {string} bone      anchor bone from Skeleton.js
 * @property {[number,number,number]} offset  local offset from the bone, metres
 * @property {number} radius    sphere/capsule radius, metres
 * @property {number} [length]  if set, a capsule extending along the bone's -Y
 *
 * @typedef {Object} ActiveWindow
 * @property {number} from      first active tick (inclusive)
 * @property {number} to        last active tick (inclusive)
 * @property {Hitbox[]} boxes
 *
 * @typedef {Object} Move
 * @property {string}  id
 * @property {string}  name          display name, e.g. "Piston Rush"
 * @property {string}  input         notation, e.g. "1,2" or "f+3" or "qcf+2"
 * @property {string}  clip          animation clip id
 * @property {number}  startup
 * @property {number}  total
 * @property {ActiveWindow[]} active
 * @property {string}  height        HEIGHT.*
 * @property {string}  weight        WEIGHT.*
 * @property {number}  damage
 * @property {number}  blockStun     ticks the defender is locked on block
 * @property {number}  hitStun       ticks the defender is locked on hit
 * @property {string}  reaction      REACTION.*
 * @property {[number,number,number]} [knockback] impulse on hit, metres/s, local
 * @property {[number,number,number]} [blockPush] impulse on block
 * @property {number}  [juggleHeight]  vertical launch, metres/s, if launcher
 * @property {boolean} [counterOnly]
 * @property {number}  [meterCost]
 * @property {number}  [meterGain]
 * @property {string[]} [cancels]   move ids this can be cancelled into, and when
 * @property {[number,number]} [cancelWindow] [fromTick, toTick]
 * @property {string}  [trail]      bone whose motion draws a weapon trail
 * @property {string}  [sfx]
 * @property {Object}  [props]      { armor:bool, crushLow:bool, crushHigh:bool,
 *                                    invulnFrom:number, invulnTo:number,
 *                                    homing:bool, throw:bool, wallBounce:bool }
 */

import { HEIGHT, WEIGHT, REACTION } from '../core/Constants.js';
import { BONE_NAMES } from '../characters/Skeleton.js';

/** Fills in derived fields and validates. Call on every authored move. */
export function defineMove(m) {
  if (!m.id) throw new Error('move missing id');
  const ctx = `move ${m.id}`;
  if (!m.active || !m.active.length) throw new Error(`${ctx}: needs at least one active window`);
  if (!Object.values(HEIGHT).includes(m.height)) throw new Error(`${ctx}: bad height "${m.height}"`);
  if (!Object.values(WEIGHT).includes(m.weight)) throw new Error(`${ctx}: bad weight "${m.weight}"`);
  if (!Object.values(REACTION).includes(m.reaction)) throw new Error(`${ctx}: bad reaction "${m.reaction}"`);

  const firstActive = Math.min(...m.active.map((a) => a.from));
  const lastActive = Math.max(...m.active.map((a) => a.to));
  if (m.startup == null) m.startup = firstActive;
  if (m.startup !== firstActive) throw new Error(`${ctx}: startup ${m.startup} != first active frame ${firstActive}`);
  if (m.total == null) throw new Error(`${ctx}: needs total`);
  if (m.total <= lastActive) throw new Error(`${ctx}: total ${m.total} must exceed last active ${lastActive}`);

  for (const w of m.active) {
    if (w.to < w.from) throw new Error(`${ctx}: active window ${w.from}..${w.to} inverted`);
    for (const b of w.boxes) {
      if (!BONE_NAMES.includes(b.bone)) throw new Error(`${ctx}: hitbox on unknown bone "${b.bone}"`);
      if (!(b.radius > 0)) throw new Error(`${ctx}: hitbox radius must be > 0`);
      if (!b.offset) b.offset = [0, 0, 0];
    }
  }

  m.recovery = m.total - lastActive - 1;
  // Frame advantage, Tekken-style: defender stun minus attacker recovery.
  m.onBlock = m.blockStun - m.recovery;
  m.onHit = m.hitStun - m.recovery;
  m.meterGain = m.meterGain ?? 0;
  m.meterCost = m.meterCost ?? 0;
  m.props = m.props || {};
  return m;
}

/** True if the move has a hitbox on this tick. */
export function isActive(move, tick) {
  for (const w of move.active) if (tick >= w.from && tick <= w.to) return true;
  return false;
}

/** All hitboxes live on this tick. */
export function activeBoxes(move, tick) {
  for (const w of move.active) if (tick >= w.from && tick <= w.to) return w.boxes;
  return null;
}

/** Whether the fighter is invulnerable on this tick (evasive moves). */
export function isInvulnerable(move, tick) {
  const p = move.props;
  return p.invulnFrom != null && tick >= p.invulnFrom && tick <= (p.invulnTo ?? p.invulnFrom);
}
