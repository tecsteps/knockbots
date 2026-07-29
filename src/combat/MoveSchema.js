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
 * @property {MoveFx}  [fx]         presentation metadata; see `resolveFx`
 *
 * @typedef {Object} MoveFx
 * @property {string}   bone      contact bone the effects anchor to
 * @property {string}   shape     FX_SHAPE.* — how the blow throws its material
 * @property {FxBeat[]} timeline  2-6 beats, in ticks after contact
 *
 * @typedef {Object} FxBeat
 * @property {number}   at        ticks after the contact frame
 * @property {string[]} parts     FX_PART.* names fired on that beat
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
  m.fx = resolveFx(m);
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

// ---------------------------------------------------------------------------
// Presentation metadata
// ---------------------------------------------------------------------------

/**
 * The five ways a blow throws material.
 *
 * This is a *shape* of impact, not a limb: an uppercut and a rising knee both
 * drive material up the front of the body and want the same treatment, while a
 * hook and a backfist both rake across it. Selecting FX by `WEIGHT` alone — the
 * only thing the director had before this — means every heavy hit in the game
 * produces the identical burst regardless of whether it was a spinning heel or a
 * piston to the chest, which is the difference between an effect that punctuates
 * a specific move and an effect that is merely loud.
 */
export const FX_SHAPE = {
  THRUST: 'thrust',   // straight down the line: jabs, straights, piston rushes
  SLASH:  'slash',    // raking across: hooks, backfists, spinning kicks, sweeps
  RISING: 'rising',   // up the front of the body: uppercuts, launchers, knees
  CRUSH:  'crush',    // blunt and downward: hammers, stomps, body checks, throws
  DRILL:  'drill',    // sustained penetration: rocket lances, jet elbows, supers
};

/**
 * The elements a hit can fire. The director owns what each one looks like; the
 * schema owns only *when* it happens.
 */
export const FX_PART = {
  FLASH: 'flash',     // the contact flare, the brightest frame of the hit
  CORE: 'core',       // the heat left behind, still glowing under the reaction
  JET: 'jet',         // tight spark lance down the line of travel
  FAN: 'fan',         // the wide spark population, the volume of the burst
  EMBER: 'ember',     // slow motes lofted out of the contact
  RING: 'ring',       // pressure front, elongated across the blow
  DEBRIS: 'debris',   // armour shards with real mass
  FLUID: 'fluid',     // coolant, which will splat where it lands
  DUST: 'dust',       // pulverised paint and oxide
  LIGHT: 'light',     // the point light that flashes the chrome nearby
  PUNCH: 'punch',     // the screen-space impact frame
};

const P = FX_PART;

/**
 * Default beat tables, in ticks after the contact frame.
 *
 * Everything used to fire on one tick, which is why an impact read as a single
 * pop of confetti rather than as an event with a shape. A real hit resolves over
 * several frames and in a fixed order: the flare and the light are simultaneous
 * with contact because they *are* contact; the material comes off next; the
 * pressure front is visible only once it has expanded away from the flare; and
 * the dust — the slowest, heaviest thing in the hit — arrives last, by which
 * time the sparks it would otherwise have hidden are already dying.
 *
 * The tables are short on purpose. Six ticks is a tenth of a second: long enough
 * to read as a sequence, short enough that the whole hit is over before the
 * reaction animation has finished its first beat.
 */
const TIMELINES = {
  [FX_SHAPE.THRUST]: [
    { at: 0, parts: [P.FLASH, P.LIGHT, P.JET, P.PUNCH] },
    { at: 1, parts: [P.FAN, P.CORE] },
    { at: 2, parts: [P.RING, P.DEBRIS] },
    { at: 4, parts: [P.EMBER, P.FLUID] },
    { at: 6, parts: [P.DUST] },
  ],
  [FX_SHAPE.SLASH]: [
    { at: 0, parts: [P.FLASH, P.LIGHT, P.JET, P.PUNCH] },
    { at: 1, parts: [P.FAN] },
    { at: 2, parts: [P.RING, P.CORE] },
    { at: 3, parts: [P.DEBRIS, P.FLUID] },
    { at: 5, parts: [P.EMBER] },
    { at: 7, parts: [P.DUST] },
  ],
  [FX_SHAPE.RISING]: [
    { at: 0, parts: [P.FLASH, P.LIGHT, P.JET, P.PUNCH] },
    { at: 1, parts: [P.CORE, P.FAN] },
    { at: 3, parts: [P.RING, P.DEBRIS] },
    { at: 5, parts: [P.EMBER, P.FLUID] },
    { at: 8, parts: [P.DUST] },
  ],
  [FX_SHAPE.CRUSH]: [
    { at: 0, parts: [P.FLASH, P.LIGHT, P.JET, P.PUNCH] },
    { at: 1, parts: [P.CORE, P.FAN] },
    { at: 2, parts: [P.RING] },
    { at: 3, parts: [P.DEBRIS, P.DUST] },
    { at: 5, parts: [P.FLUID] },
    { at: 8, parts: [P.EMBER] },
  ],
  [FX_SHAPE.DRILL]: [
    { at: 0, parts: [P.FLASH, P.JET, P.LIGHT, P.PUNCH] },
    { at: 1, parts: [P.FAN, P.CORE] },
    { at: 2, parts: [P.RING] },
    { at: 3, parts: [P.JET, P.DEBRIS] },
    { at: 5, parts: [P.EMBER, P.FLUID, P.DUST] },
  ],
};

/** Clip and move ids that name their own geometry. Checked before the fallbacks. */
const SHAPE_BY_PATTERN = [
  [/uppercut|launcher|rising|knee|ascension|coilUpper|riseUpper|fang/i, FX_SHAPE.RISING],
  [/hook|backfist|spin|sweep|roundhouse|axe|overhand|cutter|heel/i, FX_SHAPE.SLASH],
  [/hammer|stomp|slam|quake|ram|shoulder|charge|drop|anvil/i, FX_SHAPE.CRUSH],
  [/rocket|lance|rush|piston|jet|drill|plasma|burst|spike|overdrive/i, FX_SHAPE.DRILL],
];

/**
 * Picks an impact shape for a move that did not author one.
 *
 * Every field consulted here is already in the move data, which is the point:
 * the whole roster gets move-specific presentation without a table to maintain
 * and without touching a single frame of balance. An authored `fx.shape` always
 * wins, so a move that wants something the heuristic cannot guess just says so.
 */
function inferShape(m) {
  if (m.props.throw) return FX_SHAPE.CRUSH;
  if (m.props.super) return FX_SHAPE.DRILL;
  const text = `${m.id} ${m.clip || ''} ${m.tag || ''}`;
  for (const [re, shape] of SHAPE_BY_PATTERN) if (re.test(text)) return shape;
  if (m.juggleHeight) return FX_SHAPE.RISING;
  if (m.height === HEIGHT.LOW) return FX_SHAPE.SLASH;
  return FX_SHAPE.THRUST;
}

/** The bone the blow is delivered with: the first box of the first window. */
function inferBone(m) {
  const first = m.active.reduce((a, b) => (b.from < a.from ? b : a));
  return first.boxes[0]?.bone || '';
}

/**
 * Fills in a move's presentation metadata, merging over anything authored.
 * Called by `defineMove`, so every move in the game carries `fx` and the
 * effects director never has to branch on whether it is present.
 * @param {Move} m
 * @returns {MoveFx}
 */
export function resolveFx(m) {
  const authored = m.fx || {};
  const shape = TIMELINES[authored.shape] ? authored.shape : inferShape(m);
  const timeline = Array.isArray(authored.timeline) && authored.timeline.length
    ? authored.timeline
    : TIMELINES[shape];
  return { bone: authored.bone || inferBone(m), shape, timeline };
}
