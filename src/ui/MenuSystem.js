/**
 * Knockbots — the menu flow: title, character select, options, pause and
 * results.
 *
 * `ui.css` is imported once by `HUD.js` and owns the shared token set plus the
 * title/options/pause/results chrome. Character select owns its own stylesheet
 * instead — the `KBS_CSS` block at the foot of this file, injected once — so
 * the screen, its markup and its motion live in one place and nothing here can
 * collide with the HUD's selectors. Every class it defines is prefixed `kbs-`.
 *
 * Screens are built once in the constructor as plain DOM trees and toggled with
 * a `menu-screen--visible` class — nothing is re-rendered from a template
 * string, so there is no per-frame (or even per-show) `innerHTML` cost.
 *
 * State machine: `Game#phase` stays authoritative. Title/select/results are
 * driven *by* phase changes (`SCREEN_FOR_PHASE`) rather than shown directly,
 * so the phase and the visible screen can never disagree — a "BACK" button
 * calls `game.setPhase(...)`, it does not call `this.show(...)` itself.
 * Options and pause are modal overlays that do not correspond to a phase
 * (pausing freezes the sim without changing what phase it is in), so those
 * two are shown directly.
 *
 * Navigation is a single flat, per-screen array of `{ el, action, onAdjust,
 * onFocusEnter, focusClass }` records built once alongside each screen's
 * DOM. Arrow keys walk the array (or its grid, for character select);
 * mouse `mouseenter` sets the same focus index so keyboard and mouse users
 * always see one consistent highlight. This keeps every screen navigable
 * by both without a second, separate mouse-only code path.
 *
 * Sound hooks: this module does not know `AudioDirector`'s API, so it emits
 * generic `bus` events — `uiHover`, `uiConfirm`, `uiBack` — for it (or
 * anything else) to subscribe to, the same decoupling the sim itself uses
 * for FX and camera.
 *
 * ---------------------------------------------------------------------------
 * Difficulty, training, and the practice overlay
 * ---------------------------------------------------------------------------
 * `Game` already owns all of it — `setDifficulty(1..10)` retunes the live CPU
 * mid-round, `setTraining(bool)` detaches it entirely, `startTraining()` does
 * both and starts a match. This file only drives them, and it does so from
 * three places for three different reasons:
 *
 *   character select footer  the last screen before a first match, and the
 *                            only one every player passes through
 *   options                  where a player goes looking for it
 *   pause                    because the engine applies a level change mid-round
 *                            and that is worth exposing
 *
 * The footer slot is one control with two meanings: in arcade it sets the CPU
 * level, in training it picks which machine stands there. Both answer the same
 * question, so they share a nav index rather than one of them being a hidden
 * item the keyboard can still land on.
 *
 * The practice overlay (`kbg-` classes, a sibling of the menu tree rather than
 * a screen inside it) is the frame-data readout, the input log and the hit/hurt
 * volume viewer, plus the badge that says a session is running at all — the HUD
 * keeps drawing a timer and round pips through training and neither means
 * anything there, and `HUD.js` belongs to another workstream. Nothing in the
 * overlay is interactive; its three switches live in the pause menu.
 *
 * ---------------------------------------------------------------------------
 * Why character select has no renderer of its own
 * ---------------------------------------------------------------------------
 * The obvious way to give the screen a 3D preview is a second `WebGLRenderer`
 * on a second canvas. That was built and measured first, and it is the wrong
 * answer on this project:
 *
 *   creating the context                 184 – 511 ms
 *   PMREM environment                     16 – 213 ms
 *   buildRobot()                          18 – 128 ms
 *   FIRST render (shader link + texture
 *   upload into the new context)         892 – 1273 ms   <-- a visible freeze
 *
 * A second GL context shares no compiled programs and no uploaded textures
 * with the first, so every one of Materials.js's procedural 1–2k maps has to
 * be pushed across again. That is the exact multi-second stall the screen was
 * supposed to be fixing.
 *
 * Meanwhile the game's own renderer keeps drawing the arena at full quality
 * behind every menu — measured at ~85 ms/frame of the ~97 ms the select screen
 * costs — so the frame the player is looking at is already paying for a lit,
 * post-processed, shadowed robot. This screen therefore *uses* that render
 * instead of adding a second one: it puts the focused machine on player one,
 * cuts `FightCamera` to its contractual `portrait` framing, and leaves a
 * transparent window through the middle of the layout for it to show through.
 * Cost of entering the screen: one `setCharacter()` (~40–130 ms, and skipped
 * entirely when the focused machine is already loaded) and nothing else.
 */

import { bus } from '../core/Bus.js';
import { ROSTER, ARCHETYPES, chassisOf, massOf } from '../characters/roster.js';
import { QUALITY_TIERS } from '../engine/RenderPipeline.js';
import { CPU } from '../ai/CPU.js';
import { createSkeleton } from '../characters/Skeleton.js';
import { buildRobot } from '../characters/RobotBuilder.js';
import { RosterPortraits } from './RosterPortraits.js';
import { applyKbText } from './Typeface.js';

/** Game#phase -> the screen that phase implies. `null` means "hide the menu". */
const SCREEN_FOR_PHASE = {
  boot: null, menu: 'title', select: 'select', intro: null, ready: null,
  fight: null, ko: null, roundEnd: null, matchEnd: 'results', replay: null,
};

const PAUSABLE_PHASES = new Set(['intro', 'ready', 'fight', 'ko', 'roundEnd']);

/** Roster grid shape on a wide screen. Two columns of five reads as a rack of
 *  units. The compact layouts reflow the rack, so the keyboard grid walk reads
 *  the *used* column count back out of the DOM (`#syncGridCols`) rather than
 *  trusting this — a walk that disagrees with what is on screen sends the
 *  cursor sideways when the player presses down. */
const GRID_COLS = 2;

/**
 * True on a device with no hover — a phone or tablet.
 *
 * Queried per event, never cached: a tablet with a trackpad paired mid-session
 * changes the answer, and this decides whether a tap browses or commits.
 */
function isTouchPointer() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
}

/** Stat keys, in the order the dossier lists them. */
const STAT_KEYS = ['power', 'speed', 'reach', 'weight', 'defense'];

// --- live preview tuning -----------------------------------------------------
// Values found by sweeping `FightCamera.cinematic('portrait', …)` against the
// real stage and reading the frames back, not by guessing: `yaw` runs from the
// audience axis toward the subject's front, and only past ~-1.5 rad does the
// camera come round to where the chest and visor read. -1.72 lands a front
// three-quarter against the plain wall of the arena rather than the crowd.
// The camera offset is `(facing * sin(yaw), 0, cos(yaw))`, and a fighter faces
// along +/-X toward its opponent — so it is SIN, not cos, that decides whether we
// see the machine's front. The previous -1.88 put sin at -0.95, i.e. squarely
// behind it, and every machine in the roster was presented from the back. A
// positive yaw under pi/2 shows a front three-quarter, which is what a select
// screen is for.
const PREVIEW_YAW = 1.26;
const PREVIEW_DIST = 5.96;
const PREVIEW_HEIGHT = 1.12;
/** Centre mark the previewed machine stands on. Plain object: `Fighter#reset`
 *  only reads x/y/z and this module deliberately does not import three.js. */
const PREVIEW_MARK = { x: 0, y: 0, z: 0 };
/**
 * Where the opponent is parked while the screen is up — its normal right-hand
 * start mark, and pinned there for two reasons.
 *
 * A fighter auto-turns toward its opponent, and \`#framingPortrait\` swings the
 * lens around the subject's *facing*: leave the opponent wherever the last
 * round dropped it and the camera lands on either side of the machine at
 * random. Second, `FightCamera#composeSubject` slides the look point sideways
 * whenever the other fighter would fall inside the frame — hidden or not — so
 * the subject is pushed a fixed 12% right of centre. Both are stable given a
 * fixed opponent mark, and the grid's flanks are sized around that push rather
 * than fighting it.
 */
const OPPONENT_MARK = { x: 1.9, y: 0, z: 0 };
/** Radians the camera swings out and settles back through on a machine swap.
 *  Applied away from the axis, never toward it — see PREVIEW_YAW. */
const SWAP_SWING = 0.34;
/** Amplitude and period of the idle turntable drift, radians / seconds. */
const DRIFT_AMOUNT = 0.115;
const DRIFT_PERIOD = 17;
/** How long a focus must hold before the rig is rebuilt, ms. Arrowing across
 *  the roster must not queue ten `setCharacter()` calls. */
const SWAP_DEBOUNCE = 130;
/** The commit beat, ms: long enough to read the lock, short enough to be a cut. */
const LOCK_TICKS = 250;

/** Mirrors the keymap documented in `Input.js` — that module does not export
 *  it, and this table is meant for a human to read, not to be executed. */
const KEYBINDS = {
  P1: [
    ['Move', 'W A S D'],
    ['Left Punch', 'J'],
    ['Right Punch', 'K'],
    ['Left Kick', 'N'],
    ['Right Kick', 'M'],
    ['Overdrive', 'U'],
  ],
  P2: [
    ['Move', 'Arrow Keys'],
    ['Left Punch', 'F / Num 4'],
    ['Right Punch', 'G / Num 5'],
    ['Left Kick', 'V / Num 1'],
    ['Right Kick', 'B / Num 2'],
    ['Overdrive', 'T / Num 7'],
  ],
};

/** Glyph pool the name readout scrambles through before it settles. */
const SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

// ---------------------------------------------------------------------------
// Difficulty
// ---------------------------------------------------------------------------

/**
 * The ten CPU levels, presented as five named bands.
 *
 * Ten is a number, not a choice. A player picking an opponent before their
 * first match wants to know what kind of fight they are asking for, and "7"
 * does not say — so the band is what the control shows large and the level is
 * the fine adjustment underneath it.
 *
 * Every note here describes behaviour the CPU's own curves actually produce
 * across that pair of levels (`CPU#setLevel`, and the prose at the head of
 * `CPU.js` which states the level 1 and level 10 ends outright). Nothing in
 * this table is aspirational.
 */
const DIFFICULTY_BANDS = [
  { name: 'ROOKIE', from: 1, to: 2, ink: 'var(--kb-cyan)', note: 'Sees a strike late, guards on a guess, drops the juggle after one hit.' },
  { name: 'CONTENDER', from: 3, to: 4, ink: 'var(--kb-good)', note: 'Blocks what it has time to read and takes the obvious punish.' },
  { name: 'PROFESSIONAL', from: 5, to: 6, ink: 'var(--kb-gold)', note: 'Punishes whiffs, techs some throws, carries a short combo route.' },
  { name: 'VETERAN', from: 7, to: 8, ink: 'var(--kb-accent)', note: 'Guards high and low on read, anti-airs, presses its advantage.' },
  { name: 'APEX', from: 9, to: 10, ink: 'var(--kb-danger)', note: 'Reacts inside a jab, punishes every unsafe string, runs the full route.' },
];

const DIFFICULTY_MIN = 1;
const DIFFICULTY_MAX = 10;

function bandFor(level) {
  for (const b of DIFFICULTY_BANDS) if (level <= b.to) return b;
  return DIFFICULTY_BANDS[DIFFICULTY_BANDS.length - 1];
}

/**
 * The four numbers the difficulty readout quotes, taken from `CPU#setLevel`
 * itself rather than restated here.
 *
 * `setLevel` writes thirteen tuned scalars onto `this` and reads nothing else
 * off the instance, so calling it against a scratch object yields exactly the
 * values the live bot would run at that level. Copying the curve table into
 * this file would agree with the AI today and be a lie the first time that
 * workstream retunes it — and a difficulty selector that misreports what it
 * selects is worse than no selector.
 */
const PROFILE_SCRATCH = {};
function difficultyProfile(level) {
  CPU.prototype.setLevel.call(PROFILE_SCRATCH, level);
  return {
    reaction: PROFILE_SCRATCH.reactionTicks,
    block: PROFILE_SCRATCH.blockRate,
    punish: PROFILE_SCRATCH.punishAccuracy,
    combo: PROFILE_SCRATCH.comboLength,
  };
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/** Numpad direction -> arrow, matching `Input.js`'s `DIR_NUMPAD` exactly. */
const DIR_GLYPH = { 1: '↙', 2: '↓', 3: '↘', 4: '←', 5: '·', 6: '→', 7: '↖', 8: '↑', 9: '↗' };
/** Attack buttons, in the Tekken limb order `Input.js` produces. */
const BUTTON_LABEL = { 1: 'LP', 2: 'RP', 3: 'LK', 4: 'RK', 5: 'OD' };
/** Rows kept in the input history readout. Fixed, so the card never resizes
 *  under the player mid-session; the surplus rows hold their space at zero
 *  opacity and the log fills from the bottom. */
const HISTORY_ROWS = 10;
/** Frame-data cells, in the order a frame display lists them. */
const FRAME_CELLS = [
  ['startup', 'STARTUP'], ['active', 'ACTIVE'], ['recovery', 'RECOVERY'],
  ['onBlock', 'ON BLOCK'], ['onHit', 'ON HIT'], ['damage', 'DAMAGE'],
];

/** Mean of each stat across the cast, computed once, for the reference ticks. */
function castAverages() {
  const out = {};
  for (const key of STAT_KEYS) {
    let sum = 0;
    for (const def of ROSTER) sum += def.stats?.[key] ?? 0;
    out[key] = sum / Math.max(1, ROSTER.length);
  }
  return out;
}

function hexToRgba(hex, alpha) {
  const h = (hex || '#888888').replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Restarts a one-shot CSS animation on `el`. The reflow read is the point. */
function replayAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** One `LABEL value` cell of a stepper's consequence line. */
function metaCell(label, value) {
  const cell = el('span', 'kbg-meta-cell');
  cell.append(el('i', null, label), el('b', null, value));
  return cell;
}

// ---------------------------------------------------------------------------
// Chassis silhouettes
// ---------------------------------------------------------------------------

/**
 * Draws a roster tile's silhouette from the character's own `silhouette` and
 * `proportions` blocks, so the shape on the tile is derived from the same
 * numbers RobotBuilder grows the body out of. Shoulder span, waist taper, head
 * style, leg articulation, dorsal unit and spike count all change the outline —
 * which is what makes ten tiles read as ten machines instead of ten swatches.
 *
 * @param {import('../characters/roster.js').CharacterDef} def
 * @returns {string} inner SVG markup for a `0 0 64 100` viewBox
 */
function silhouetteMarkup(def) {
  const s = def.silhouette || {};
  const p = def.proportions || {};
  const cx = 32;
  const sw = 13 * (s.shoulders ?? 1);                 // half shoulder span
  const ww = Math.max(4, 8.5 * (s.waist ?? 0.8));     // half waist
  const taper = s.limbTaper ?? 0.6;

  const headH = 15 * (p.head ?? 1);
  const headTop = 7;
  const headBot = headTop + headH;
  const shoulderY = headBot + 3.5;
  const waistY = shoulderY + 27 * (p.torso ?? 1);
  const hipY = waistY + 4;
  const footY = 95;
  const legSpan = footY - hipY;

  const body = [];
  const accent = [];
  const poly = (into, pts) => into.push(`<polygon points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`);
  const rect = (into, x, y, w, h) => poly(into, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

  // -- dorsal unit, behind everything ---------------------------------------
  const back = [];
  const bx = cx + sw * 0.35;
  switch (s.backpack) {
    case 'reactor':
      back.push(`<circle cx="${(cx).toFixed(1)}" cy="${(shoulderY + 9).toFixed(1)}" r="${(sw * 0.72).toFixed(1)}"/>`);
      break;
    case 'thrusters':
      poly(back, [[bx, shoulderY - 3], [bx + 13, shoulderY - 9], [bx + 16, shoulderY - 2], [bx + 4, shoulderY + 6]]);
      poly(back, [[cx - sw * 0.35, shoulderY - 3], [cx - sw * 0.35 - 13, shoulderY - 9], [cx - sw * 0.35 - 16, shoulderY - 2], [cx - sw * 0.35 - 4, shoulderY + 6]]);
      break;
    case 'coil':
      for (let i = 0; i < 3; i++) rect(back, cx - sw * 0.8, shoulderY + 2 + i * 6, sw * 1.6, 4);
      break;
    case 'tank':
      rect(back, cx - sw * 0.85, shoulderY - 1, sw * 1.7, 17);
      break;
    case 'wings':
      poly(back, [[cx - 2, shoulderY], [cx - sw - 17, shoulderY - 24], [cx - sw - 6, shoulderY + 2]]);
      poly(back, [[cx + 2, shoulderY], [cx + sw + 17, shoulderY - 24], [cx + sw + 6, shoulderY + 2]]);
      break;
    case 'drum':
      back.push(`<circle cx="${cx.toFixed(1)}" cy="${(shoulderY + 11).toFixed(1)}" r="${(sw * 0.9).toFixed(1)}"/>`);
      break;
    case 'spine':
      for (let i = 0; i < 4; i++) {
        const y = shoulderY + 2 + i * 6;
        poly(back, [[cx + sw * 0.6, y], [cx + sw * 0.6 + 9, y + 2.5], [cx + sw * 0.6, y + 5]]);
      }
      break;
    default:
      break;
  }

  // -- torso ----------------------------------------------------------------
  poly(body, [
    [cx - sw, shoulderY], [cx + sw, shoulderY],
    [cx + ww, waistY], [cx - ww, waistY],
  ]);
  // chest plate, in the character's accent
  poly(accent, [
    [cx - sw * 0.42, shoulderY + 3], [cx + sw * 0.42, shoulderY + 3],
    [cx + ww * 0.5, waistY - 5], [cx - ww * 0.5, waistY - 5],
  ]);

  // -- pauldrons ------------------------------------------------------------
  const pw = sw * 0.46;
  poly(body, [[cx - sw - 2, shoulderY - 2], [cx - sw + pw, shoulderY - 3], [cx - sw + pw * 0.9, shoulderY + 8], [cx - sw - 3, shoulderY + 7]]);
  poly(body, [[cx + sw + 2, shoulderY - 2], [cx + sw - pw, shoulderY - 3], [cx + sw - pw * 0.9, shoulderY + 8], [cx + sw + 3, shoulderY + 7]]);

  // -- spikes ---------------------------------------------------------------
  const spikes = Math.min(6, s.spikes ?? 0);
  for (let i = 0; i < spikes; i++) {
    const side = i % 2 ? 1 : -1;
    const t = Math.floor(i / 2);
    const x = cx + side * (sw + 1);
    const y = shoulderY - 1 + t * 4.5;
    poly(accent, [[x, y], [x + side * (9 - t * 1.6), y - 5 - t], [x, y + 4]]);
  }

  // -- arms -----------------------------------------------------------------
  const armLen = 30 * (p.arms ?? 1);
  const upper = 4.6 * (1 + (1 - taper) * 0.4);
  const lower = upper * (0.45 + taper * 0.5);
  for (const side of [-1, 1]) {
    const ax = cx + side * (sw * 0.86);
    const elbowY = shoulderY + armLen * 0.5;
    const handY = shoulderY + armLen;
    const ex = ax + side * 2.5;
    poly(body, [[ax - upper, shoulderY + 3], [ax + upper, shoulderY + 3], [ex + lower, elbowY], [ex - lower, elbowY]]);
    poly(body, [[ex - lower, elbowY], [ex + lower, elbowY], [ex + side * 1.5 + lower * 1.25, handY], [ex + side * 1.5 - lower * 1.25, handY]]);
  }

  // -- legs -----------------------------------------------------------------
  const hipX = ww * 0.72;
  const thigh = 5.4 * (0.7 + (1 - taper) * 0.6);
  const shin = thigh * (0.5 + taper * 0.5);
  for (const side of [-1, 1]) {
    const hx = cx + side * hipX;
    if (s.legs === 'digitigrade') {
      const kneeY = hipY + legSpan * 0.42;
      const ankleY = hipY + legSpan * 0.80;
      const kx = hx + side * 4;
      const axk = hx - side * 2.5;
      poly(body, [[hx - thigh, hipY], [hx + thigh, hipY], [kx + shin, kneeY], [kx - shin, kneeY]]);
      poly(body, [[kx - shin, kneeY], [kx + shin, kneeY], [axk + shin * 0.8, ankleY], [axk - shin * 0.8, ankleY]]);
      poly(body, [[axk - shin * 0.8, ankleY], [axk + shin * 0.8, ankleY], [axk + shin + 5, footY], [axk - shin * 0.6, footY]]);
    } else if (s.legs === 'piston') {
      const kneeY = hipY + legSpan * 0.5;
      rect(body, hx - thigh, hipY, thigh * 2, kneeY - hipY);
      rect(body, hx - thigh * 1.15, kneeY - 2.5, thigh * 2.3, 5);
      rect(body, hx - shin, kneeY + 2, shin * 2, footY - kneeY - 5);
      rect(body, hx - shin * 1.5, footY - 4, shin * 3, 4);
    } else {
      const kneeY = hipY + legSpan * 0.48;
      poly(body, [[hx - thigh, hipY], [hx + thigh, hipY], [hx + shin, kneeY], [hx - shin, kneeY]]);
      poly(body, [[hx - shin, kneeY], [hx + shin, kneeY], [hx + shin * 0.95, footY - 4], [hx - shin * 0.95, footY - 4]]);
      poly(body, [[hx - shin * 1.1, footY - 4], [hx + shin * 1.5, footY - 4], [hx + shin * 1.7, footY], [hx - shin * 1.2, footY]]);
    }
  }

  // -- head -----------------------------------------------------------------
  const hw = 6.2 * (p.head ?? 1);
  const neck = shoulderY - 1;
  switch (s.head) {
    case 'visor':
      rect(body, cx - hw, headTop, hw * 2, headBot - headTop);
      rect(accent, cx - hw * 0.92, headTop + headH * 0.34, hw * 1.84, 3.2);
      break;
    case 'mono':
      rect(body, cx - hw * 0.8, headTop, hw * 1.6, headBot - headTop);
      accent.push(`<circle cx="${cx}" cy="${(headTop + headH * 0.45).toFixed(1)}" r="2.2"/>`);
      break;
    case 'crest':
      rect(body, cx - hw, headTop + 2, hw * 2, headBot - headTop - 2);
      poly(body, [[cx - 1.6, headTop + 2], [cx + 1.6, headTop + 2], [cx + 1, headTop - 6], [cx - 1, headTop - 6]]);
      rect(accent, cx - hw * 0.85, headTop + headH * 0.5, hw * 1.7, 2.6);
      break;
    case 'dome':
      body.push(`<path d="M${(cx - hw).toFixed(1)},${headBot.toFixed(1)} L${(cx - hw).toFixed(1)},${(headTop + hw).toFixed(1)} A${hw.toFixed(1)},${hw.toFixed(1)} 0 0 1 ${(cx + hw).toFixed(1)},${(headTop + hw).toFixed(1)} L${(cx + hw).toFixed(1)},${headBot.toFixed(1)} Z"/>`);
      rect(accent, cx - hw * 0.7, headTop + headH * 0.52, hw * 1.4, 2.6);
      break;
    case 'crown':
      rect(body, cx - hw, headTop + 4, hw * 2, headBot - headTop - 4);
      for (let i = -1; i <= 1; i++) poly(accent, [[cx + i * hw * 0.72 - 1.4, headTop + 4], [cx + i * hw * 0.72 + 1.4, headTop + 4], [cx + i * hw * 0.72, headTop - 5]]);
      break;
    case 'mandible':
      poly(body, [[cx - hw, headTop], [cx + hw, headTop], [cx + hw * 0.62, headBot], [cx - hw * 0.62, headBot]]);
      poly(accent, [[cx - hw * 0.6, headBot - 2], [cx - hw * 0.1, headBot - 2], [cx - hw * 1.1, headBot + 7]]);
      poly(accent, [[cx + hw * 0.6, headBot - 2], [cx + hw * 0.1, headBot - 2], [cx + hw * 1.1, headBot + 7]]);
      break;
    case 'lantern':
      rect(body, cx - hw * 1.15, headTop + 2, hw * 2.3, headBot - headTop - 3);
      accent.push(`<circle cx="${cx}" cy="${(headTop + headH * 0.5).toFixed(1)}" r="${(hw * 0.55).toFixed(1)}"/>`);
      break;
    default: // mask
      poly(body, [[cx - hw, headTop], [cx + hw, headTop], [cx + hw * 0.8, headBot - 3], [cx, headBot + 2], [cx - hw * 0.8, headBot - 3]]);
      rect(accent, cx - hw * 0.75, headTop + headH * 0.36, hw * 1.5, 2.8);
      break;
  }
  rect(body, cx - 2.6, neck - 4, 5.2, 5);

  return `<g class="kbs-sil-back">${back.join('')}</g>`
    + `<g class="kbs-sil-body">${body.join('')}</g>`
    + `<g class="kbs-sil-accent">${accent.join('')}</g>`;
}

export class MenuSystem {
  /**
   * @param {HTMLElement} uiRoot
   * @param {import('../core/Game.js').Game} game
   */
  constructor(uiRoot, game) {
    this.uiRoot = uiRoot;
    this.game = game;

    MenuSystem.#installStyles();

    this.root = document.createElement('div');
    // `kbs-layer` is this module's own hook for raising the menu tree above the
    // in-fight touch pad — see the rule of that name in KBS_CSS. It has to be a
    // class of ours on an element of ours, because `menu-root` belongs to
    // `ui.css` and `kbt-root` belongs to `TouchControls.js`.
    this.root.className = 'menu-root kbs-layer';
    uiRoot.appendChild(this.root);

    this.current = null;
    this.pendingReturn = 'title';
    this.p1Index = 0;
    this.cpuIndex = ROSTER.length > 1 ? 1 : 0;
    this._lastWinner = -1;

    /**
     * What the next commit on character select means: 'arcade' starts a match
     * against the CPU, 'training' calls `startTraining`. The screen is shared
     * because picking a machine is the same act either way — only the footer's
     * opponent control and the commit differ.
     */
    this._selectIntent = 'arcade';
    /** Which machine the practice dummy is, chosen in the select footer. */
    this._dummyIndex = ROSTER.length > 1 ? 1 : 0;

    this.settings = {
      quality: game.renderer?.quality || 'ultra',
      master: 80, music: 72, sfx: 88,
    };

    /** Every difficulty control on screen, re-synced together on the bus event. */
    this._diffViews = [];

    /** What the practice overlay shows. The pause menu's toggles write here and
     *  nothing else does; the overlay's own scratch lives on `_train`. */
    this.training = { boxes: false, frames: true, inputs: true };

    /** @type {{items:Array, index:number, cols:number, gridCount:number}} */
    this.nav = { items: [], index: 0, cols: 1, gridCount: 0 };
    this.screens = {};

    this.#buildTitle();
    this.#buildSelect();
    this.#buildOptions();
    this.#buildPause();
    this.#buildResults();
    this.#buildTrainingOverlay();

    this._onKeyDown = (e) => this.#onKeyDown(e);
    window.addEventListener('keydown', this._onKeyDown);

    bus.on('phase', (e) => this.#onPhase(e));
    bus.on('matchEnd', (e) => { this._lastWinner = e.winner; });
    bus.on('difficulty', () => this.#syncDifficulty());
    bus.on('training', ({ on }) => {
      if (on) this.#resetTrainingReadout();
      this.#syncTrainingOverlay();
      this.#syncPauseMode();
    });
    // The frame-data readout says what the last move was worth, so it has to
    // know whether it landed. `whiff` fires on the move that missed, the other
    // two on the blow that connected.
    bus.on('hit', (e) => this.#noteMoveResult(e.attacker, e.counter ? 'COUNTER HIT' : 'HIT'));
    bus.on('block', (e) => this.#noteMoveResult(e.attacker, 'BLOCKED'));
    bus.on('whiff', (e) => this.#noteMoveResult(e.fighter, 'WHIFF'));
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** @param {?string} screen one of 'title'|'select'|'options'|'pause'|'results', or null to hide everything */
  show(screen) {
    if (this.current === screen) return;
    const prev = this.current && this.screens[this.current];
    if (prev) {
      prev.el.classList.remove('menu-screen--visible');
      prev.onHide?.();
    }
    this.current = screen;
    this.root.classList.toggle('menu-root--active', !!screen);
    if (!screen) { this.nav = { items: [], index: 0, cols: 1, gridCount: 0 }; this.#syncTrainingOverlay(); return; }
    const s = this.screens[screen];
    s.el.classList.add('menu-screen--visible');
    s.onShow?.();
    this.#setNav(s.nav, s.cols || 1, s.gridCount ?? (s.nav.length || 0), s.startIndex?.() ?? 0);
    this.#syncTrainingOverlay();
  }

  // -------------------------------------------------------------------------
  // Phase wiring
  // -------------------------------------------------------------------------

  #onPhase({ phase }) {
    const mapped = SCREEN_FOR_PHASE[phase];
    if (mapped) { this.show(mapped); return; }
    if (this.current !== 'pause' && this.current !== 'options') this.show(null);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  #onKeyDown(e) {
    if (e.code === 'Escape') { e.preventDefault(); this.#handleEscape(); return; }
    if (!this.current) return;
    switch (e.code) {
      case 'Enter': case 'Space': case 'NumpadEnter':
        e.preventDefault(); this.#activateFocus(); break;
      case 'ArrowUp':
        e.preventDefault(); this.current === 'select' ? this.#moveGrid(0, -1) : this.#move(-1); break;
      case 'ArrowDown':
        e.preventDefault(); this.current === 'select' ? this.#moveGrid(0, 1) : this.#move(1); break;
      case 'ArrowLeft':
        e.preventDefault(); this.#left(-1); break;
      case 'ArrowRight':
        e.preventDefault(); this.#left(1); break;
      default: break;
    }
  }

  #handleEscape() {
    if (this.current === 'options') { this.show(this.pendingReturn); return; }
    if (this.current === 'pause') { this.#resume(); return; }
    if (this.current === 'select') { this.game.setPhase('menu'); return; }
    if (!this.current && PAUSABLE_PHASES.has(this.game.phase)) { this.#pause(); return; }
  }

  #pause() { this.game.paused = true; this.show('pause'); bus.emit('uiBack', {}); }
  #resume() { this.game.paused = false; this.show(null); bus.emit('uiConfirm', {}); }

  // -- focus/nav --------------------------------------------------------------

  #setNav(items, cols, gridCount, index = 0) {
    this.nav = { items, index: clamp(index, 0, Math.max(0, items.length - 1)), cols, gridCount };
    this.#applyFocus();
  }

  #applyFocus() {
    const { items, index } = this.nav;
    for (let i = 0; i < items.length; i++) {
      items[i].el.classList.toggle(items[i].focusClass || 'mbtn--focus', i === index);
    }
    items[index]?.onFocusEnter?.();
  }

  #move(delta) {
    const { items } = this.nav;
    if (!items.length) return;
    this.nav.index = (this.nav.index + delta + items.length) % items.length;
    this.#applyFocus();
    bus.emit('uiHover', {});
  }

  /**
   * Grid walk for character select.
   *
   * The nav array is a grid of `gridCount` cells followed by a tail row of
   * plain buttons (BACK). Treating the tail as more grid cells is what used to
   * make the bottom row of the roster unreachable from the keyboard, so the two
   * zones are walked separately and joined at the seam: down off the last grid
   * row lands on the tail, up off the tail returns to the column it left.
   */
  #moveGrid(dx, dy) {
    const { items, cols } = this.nav;
    if (!items.length) return;
    const n = Math.max(1, Math.min(this.nav.gridCount || items.length, items.length));
    const tail = items.length - n;
    const rows = Math.ceil(n / cols);
    const idx = this.nav.index;

    if (idx >= n) {
      const t = idx - n;
      if (dy > 0) this.nav.index = 0;
      else if (dy < 0) this.nav.index = Math.min(n - 1, (rows - 1) * cols + Math.min(t, cols - 1));
      else if (dx) this.nav.index = n + this.#nextVisibleTail(t, dx, tail);
    } else {
      let row = Math.floor(idx / cols);
      let col = idx % cols;
      if (dx) col = (col + dx + cols) % cols;
      if (dy > 0 && row === rows - 1 && tail > 0) {
        this.nav.index = n + Math.min(col, tail - 1);
      } else {
        if (dy > 0) row = (row + 1) % rows;
        if (dy < 0) row = (row - 1 + rows) % rows;
        let ni = row * cols + col;
        if (ni >= n) ni = n - 1;
        this.nav.index = ni;
      }
    }
    this.#applyFocus();
    bus.emit('uiHover', {});
  }

  /**
   * Next tail slot in direction `dx` that is actually on screen.
   *
   * LOCK IN is `display: none` on a pointer device — it exists for a finger,
   * which has no ENTER key — so walking the footer sideways used to park the
   * cursor on an invisible control for one keypress. Bounded by the tail
   * length, and it falls back to the raw step, so a footer whose buttons were
   * all hidden would still move rather than hang.
   */
  #nextVisibleTail(t, dx, tail) {
    const items = this.nav.items;
    const base = items.length - tail;
    let slot = t;
    for (let hop = 0; hop < tail; hop++) {
      slot = (slot + dx + tail) % tail;
      if (items[base + slot]?.el.offsetParent !== null) return slot;
    }
    return (t + dx + tail) % tail;
  }

  /**
   * Left/Right: adjust the focused control if it has one, else pan the grid.
   *
   * An `onAdjust` that returns `false` has declined the input — it is already
   * at the end of its own range — and the key falls through to the walk. That
   * is what keeps the difficulty stepper in the select footer from being a trap
   * on a keyboard: the row it sits in is walked with left/right, so a control
   * that swallowed both directions unconditionally could never be left. The
   * volume sliders return nothing and so keep their old behaviour exactly.
   */
  #left(dir) {
    const it = this.nav.items[this.nav.index];
    if (it?.onAdjust && it.onAdjust(dir) !== false) return;
    if (this.current === 'select') this.#moveGrid(dir, 0);
  }

  #activateFocus() {
    const it = this.nav.items[this.nav.index];
    if (!it?.action) return;
    bus.emit('uiConfirm', {});
    it.action();
  }

  /**
   * Moves focus onto the nav item that owns `el`.
   *
   * Looked up rather than captured at build time: the pause screen publishes
   * two different nav arrays depending on whether a training session is running,
   * so a button's index is not a property of the button.
   */
  #focusEl(el) {
    const i = this.nav.items.findIndex((it) => it.el === el);
    if (i < 0 || i === this.nav.index) return false;
    this.nav.index = i;
    this.#applyFocus();
    return true;
  }

  /** Builds a standard angular menu button and registers it as a nav item. */
  #addNavButton(items, label, action, extraClass = '') {
    const btn = document.createElement('button');
    btn.className = `mbtn ${extraClass}`.trim();
    btn.textContent = label;
    btn.addEventListener('click', () => { this.#focusEl(btn); bus.emit('uiConfirm', {}); action(); });
    btn.addEventListener('mouseenter', () => { if (this.#focusEl(btn)) bus.emit('uiHover', {}); });
    items.push({ el: btn, action });
    return btn;
  }

  // -------------------------------------------------------------------------
  // Title
  // -------------------------------------------------------------------------

  #buildTitle() {
    const screen = el('div', 'menu-screen');
    const bg = el('div', 'menu-bg');

    const wrap = el('div', 'title-wrap');
    const logo = el('div', 'title-logo');
    applyKbText(logo, 'KNOCKBOTS');
    const tagline = el('div', 'title-tagline', 'Steel Settles Everything');
    const nav = el('div', 'title-nav');

    const items = [];
    nav.appendChild(this.#addNavButton(items, 'ARCADE', () => this.#enterSelect('arcade')));
    // Training is a first-class mode, not an options checkbox: it is where a
    // player learns a machine's frame data, and it is one row from the title.
    // `.mbtn` is a single flex row, so the note rides along inside it on
    // `margin-left: auto` rather than being positioned under it — an absolutely
    // placed caption disappeared entirely under `.title-nav`'s own box.
    const trainBtn = this.#addNavButton(items, 'TRAINING', () => this.#enterSelect('training'));
    trainBtn.appendChild(el('span', 'title-nav-note', 'STANDING DUMMY · NO CLOCK'));
    nav.appendChild(trainBtn);
    nav.appendChild(this.#addNavButton(items, 'OPTIONS', () => this.#openOptions('title')));

    const hint = el('div', 'title-hint', 'ENTER TO SELECT · ARROW KEYS TO NAVIGATE');
    const tag = el('div', 'build-tag', 'KNOCKBOTS');

    wrap.append(logo, tagline, nav);
    screen.append(bg, wrap, hint, tag);
    this.root.appendChild(screen);
    this.screens.title = {
      el: screen, nav: items, cols: 1,
      onShow: () => this.#warmRoster(),
    };
  }

  /**
   * Pre-builds every machine once, in idle time, while the title screen sits
   * there doing nothing.
   *
   * `Fighter#setCharacter` regrows the rig from scratch, and measurement says
   * the first build of a palette costs ~85 ms while every later one costs
   * 21–27 ms — the difference is RobotBuilder's per-palette material library
   * and marking atlas, which are module-level caches and survive `dispose()`.
   * Warming the caches (not the robots: those are thrown away immediately) is
   * therefore what turns browsing the roster from a string of ~90 ms hitches
   * into something under two frames, and it also pays for the `startMatch`
   * rebuild on the way out of character select.
   *
   * Purely opportunistic: one machine per idle slice, abandoned the moment the
   * player leaves the front end, and every step guarded — a warm-up that can
   * break the game is worse than no warm-up.
   */
  #warmRoster() {
    if (this._warmed || !this.game.environment) return;
    this._warmed = true;
    const queue = ROSTER.slice();
    const idle = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 900 })
      : (fn) => setTimeout(fn, 220);
    const step = () => {
      if (!queue.length || this.game.phase === 'fight') return;
      const def = queue.shift();
      try {
        const robot = buildRobot(def, createSkeleton(def.proportions), this.game.environment);
        // The build is already being paid for; photograph it on the way to the
        // bin so the roster tiles can show the real machine instead of a
        // pictogram. Disposal waits for the readback, which is async.
        this.#portraits().capture(def.id, robot)
          .then((url) => { if (url) this.#applyPortrait(def.id, url); })
          .catch(() => {})
          .finally(() => { try { robot.dispose(); } catch { /* already gone */ } });
      } catch { /* a warm-up is an optimisation; it never gets to be a failure */ }
      idle(step);
    };
    idle(step);
  }

  /** Lazily built so a session that never opens the front end pays nothing. */
  #portraits() {
    if (!this._portraits) {
      this._portraits = new RosterPortraits(this.game.renderer.renderer, this.game.environment);
    }
    return this._portraits;
  }

  /**
   * Swap a tile's monogram for its rendered portrait. Fades rather than cuts,
   * because ten tiles resolving at idle-callback intervals would otherwise pop
   * one by one while the player is reading them.
   */
  #applyPortrait(id, url) {
    for (const el of document.querySelectorAll(`.kbs-por[data-id="${id}"]`)) {
      const img = el.querySelector('img');
      if (!img || img.src === url) continue;
      img.src = url;
      img.addEventListener('load', () => el.classList.add('kbs-por--on'), { once: true });
    }
  }

  // -------------------------------------------------------------------------
  // Character select
  // -------------------------------------------------------------------------

  #buildSelect() {
    const screen = el('div', 'menu-screen kbs-screen');
    const scrim = el('div', 'kbs-scrim');
    const grid = el('div', 'kbs');

    // -- header -------------------------------------------------------------
    const head = el('div', 'kbs-head');
    const title = el('div', 'kbs-title');
    title.append(el('span', 'kbs-title-a', 'SELECT YOUR '), el('span', 'kbs-title-b', 'MACHINE'));
    const headMeta = el('div', 'kbs-head-meta');
    const modeChip = el('span', 'kbs-chip kbs-chip--p1', 'PLAYER 1');
    headMeta.append(
      modeChip,
      el('span', 'kbs-head-count', `${String(ROSTER.length).padStart(2, '0')} UNITS ONLINE`),
    );
    head.append(title, headMeta);

    // -- roster rack --------------------------------------------------------
    const rack = el('div', 'kbs-rack');
    rack.append(el('div', 'kbs-eyebrow', 'ROSTER'));
    const rackGrid = el('div', 'kbs-grid');
    rackGrid.setAttribute('role', 'listbox');
    rackGrid.setAttribute('aria-label', 'Character roster');
    const carriage = el('div', 'kbs-carriage');
    carriage.setAttribute('aria-hidden', 'true');
    rackGrid.appendChild(carriage);

    const items = [];
    const tiles = ROSTER.map((def, i) => {
      const tile = el('button', 'kbs-tile');
      tile.type = 'button';
      tile.setAttribute('role', 'option');
      tile.setAttribute('aria-label', `${def.name}, ${def.archetype}, ${chassisOf(def).label}`);
      tile.style.setProperty('--kbs-c', def.palette.accent);
      tile.style.setProperty('--kbs-e', def.palette.emissive);
      tile.style.setProperty('--kbs-glow', hexToRgba(def.palette.emissive, 0.42));

      // A rendered bust of the actual machine, or its initial until the render
      // arrives. The old hand-drawn silhouettes were ten near-identical grey
      // humanoids and were the reason the cast was unreadable from the tiles.
      const sil = el('div', 'kbs-por');
      sil.dataset.id = def.id;
      sil.setAttribute('aria-hidden', 'true');
      const mono = el('span', 'kbs-por-mono', def.name.slice(0, 1));
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      sil.append(mono, img);
      const cached = this._portraits?.get(def.id);
      if (cached) { img.src = cached; sil.classList.add('kbs-por--on'); }

      const text = el('div', 'kbs-tile-text');
      text.append(
        el('div', 'kbs-tile-name', def.name),
        el('div', 'kbs-tile-arch', def.archetype),
        el('div', 'kbs-tile-frame', `${chassisOf(def).label} · ${massOf(def)} kg`),
      );

      const spark = el('div', 'kbs-spark');
      for (const key of STAT_KEYS) {
        const cell = el('i', 'kbs-spark-b');
        cell.style.setProperty('--v', String((def.stats?.[key] ?? 0) / 10));
        cell.title = key;
        spark.appendChild(cell);
      }

      tile.append(el('span', 'kbs-tile-no', String(i + 1).padStart(2, '0')), sil, text, spark, el('span', 'kbs-tile-lock', 'LOADED'));
      rackGrid.appendChild(tile);

      const idx = items.length;
      tile.addEventListener('mouseenter', () => {
        // A tap on a touch screen synthesises mouseenter immediately before
        // click. Honouring it would focus the tile and then let the click read
        // that focus as "already inspected" and start the match — so a phone
        // player could never browse the roster at all, the first tile they
        // touched was the one they fought with. There is no hover to track on
        // such a device; the click handler below owns the whole gesture.
        if (isTouchPointer()) return;
        if (this.nav.index === idx) return;
        this.nav.index = idx; this.#applyFocus(); bus.emit('uiHover', {});
      });
      tile.addEventListener('click', () => {
        // First tap inspects, second tap on the same machine commits. On a
        // pointer device the hover above has already done the inspecting, so
        // `browsing` is false and one click still locks in as before.
        const browsing = isTouchPointer() && this.nav.index !== idx;
        this.nav.index = idx;
        this.#applyFocus();
        bus.emit(browsing ? 'uiHover' : 'uiConfirm', {});
        if (!browsing) this.#confirmSelect(i);
      });
      items.push({
        el: tile,
        action: () => this.#confirmSelect(i),
        focusClass: 'kbs-tile--focus',
        onFocusEnter: () => this.#focusCharacter(i),
      });
      return tile;
    });
    rack.appendChild(rackGrid);

    // -- live preview window ------------------------------------------------
    const stage = el('div', 'kbs-stage');
    stage.append(
      el('i', 'kbs-bracket kbs-bracket--tl'), el('i', 'kbs-bracket kbs-bracket--tr'),
      el('i', 'kbs-bracket kbs-bracket--bl'), el('i', 'kbs-bracket kbs-bracket--br'),
    );
    const sweep = el('div', 'kbs-sweep');
    const stageTag = el('div', 'kbs-stage-tag');
    stageTag.append(el('b', null, 'LIVE'), document.createTextNode(' CHASSIS FEED'));
    const fallback = el('div', 'kbs-stage-fallback', 'PREVIEW OFFLINE');
    stage.append(sweep, stageTag, fallback);

    // -- dossier ------------------------------------------------------------
    const doss = el('div', 'kbs-doss');
    doss.append(el('div', 'kbs-eyebrow', 'UNIT DOSSIER'));
    const dossCard = el('div', 'kbs-card');

    const dName = el('div', 'kbs-name');
    const dSub = el('div', 'kbs-sub');
    const dArch = el('div', 'kbs-arch');
    const dArchTag = el('span', 'kbs-arch-tag');
    const dArchNote = el('span', 'kbs-arch-note');
    dArch.append(dArchTag, dArchNote);

    const statBlock = el('div', 'kbs-stats');
    const statFills = {};
    const statNums = {};
    const avg = castAverages();
    STAT_KEYS.forEach((key, i) => {
      const row = el('div', 'kbs-stat');
      row.style.setProperty('--i', String(i));
      const track = el('div', 'kbs-stat-track');
      const fill = el('div', 'kbs-stat-fill');
      const notches = el('div', 'kbs-stat-notch');
      // Cast average, drawn once and never moved: the reference line is what
      // lets two machines be compared without visiting both.
      const mark = el('i', 'kbs-stat-avg');
      mark.style.left = `${(avg[key] * 10).toFixed(1)}%`;
      mark.title = `cast average ${avg[key].toFixed(1)}`;
      track.append(fill, notches, mark);
      const num = el('div', 'kbs-stat-num', '0');
      row.append(el('div', 'kbs-stat-label', key), track, num);
      statBlock.appendChild(row);
      statFills[key] = fill;
      statNums[key] = num;
    });

    const spec = el('div', 'kbs-spec');
    const specVals = {};
    for (const [key, label] of [['chassis', 'Chassis'], ['mass', 'Mass'], ['moveset', 'Move Set'], ['frame', 'Plating']]) {
      const cell = el('div', 'kbs-spec-cell');
      const v = el('b', null, '—');
      cell.append(el('span', null, label), v);
      spec.appendChild(cell);
      specVals[key] = v;
    }

    const dNote = el('div', 'kbs-note');
    const dBio = el('div', 'kbs-bio');

    const swatchRow = el('div', 'kbs-swatches');
    const swatches = [];
    for (let s = 0; s < 5; s++) {
      const sw = el('i', 'kbs-swatch');
      swatchRow.appendChild(sw);
      swatches.push(sw);
    }
    const livery = el('div', 'kbs-livery');
    livery.append(el('span', 'kbs-livery-label', 'LIVERY'), swatchRow);

    dossCard.append(dArch, dName, dSub, statBlock, spec, dNote, dBio, livery);
    doss.appendChild(dossCard);

    // -- footer -------------------------------------------------------------
    const foot = el('div', 'kbs-foot');
    const hints = el('div', 'kbs-hints');
    for (const [k, v] of [['↑ ↓ ← →', 'BROWSE'], ['ENTER', 'LOCK IN'], ['ESC', 'BACK']]) {
      const h = el('span', 'kbs-hint');
      h.append(el('kbd', null, k), document.createTextNode(v));
      hints.appendChild(h);
    }
    // Both hint sets are built once and swapped by media query rather than by
    // script: the keyboard legend is meaningless on a phone, and the two-tap
    // rule is meaningless with a mouse.
    const touchHint = el('div', 'kbs-touch-hint', 'TAP TO INSPECT · TAP AGAIN TO LOCK IN');
    // The footer used to print "OPPONENT CPU · RANDOM" and mean it literally —
    // an inert label in the one place a player is guaranteed to look before
    // their first match. It is the opponent control now: how hard the CPU
    // fights in arcade, which machine stands there in training. Registered
    // before the two buttons so the footer's left-to-right order and the tail's
    // walk order are the same thing.
    const opponent = this.#buildOpponentControl(items);
    // A visible commit control. The two-tap rule works without it, but a
    // touch player has no ENTER key and nothing on screen said so.
    const lockBtn = this.#addNavButton(items, 'LOCK IN', () => this.#confirmSelect(this._select.focus), 'kbs-lock');
    const backBtn = this.#addNavButton(items, 'BACK', () => this.game.setPhase('menu'), 'kbs-back');
    foot.append(hints, touchHint, opponent, lockBtn, backBtn);

    grid.append(head, rack, stage, doss, foot);
    screen.append(scrim, grid, el('div', 'kbs-flash'));
    this.root.appendChild(screen);

    // The carriage is placed in pixels, so it has to be replaced whenever the
    // rack is re-laid out — a window resize, a phone rotating, or the type
    // scale crossing a clamp. The same event is what can change the column
    // count under the grid walk, so both are refreshed together.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (this.current !== 'select') return;
        this.#syncGridCols();
        this.#moveCarriage(this._select.tiles[this._select.focus]);
      }).observe(rackGrid);
    }

    this._select = {
      root: screen, grid, rackGrid, tiles, carriage, stage, sweep, fallback,
      dName, dSub, dArchTag, dArchNote, dBio, dNote, dossCard, modeChip,
      statFills, statNums, specVals, swatches,
      focus: -1, scrambleTimer: 0, swapTimer: 0, lockTimer: 0, locked: false,
    };

    this.screens.select = {
      el: screen,
      nav: items,
      cols: GRID_COLS,
      gridCount: ROSTER.length,
      // Open on the machine the player last used, not on slot one.
      startIndex: () => this.p1Index,
      onShow: () => this.#selectShow(),
      onHide: () => this.#selectHide(),
    };
  }

  // -- screen lifecycle -------------------------------------------------------

  /** Title -> character select, remembering what the commit at the end means. */
  #enterSelect(intent) {
    this._selectIntent = intent;
    this.game.setPhase('select');
  }

  #selectShow() {
    const r = this._select;
    r.locked = false;
    r.focus = -1;
    r.root.classList.remove('kbs-screen--lock');
    const training = this._selectIntent === 'training';
    r.root.classList.toggle('kbs-screen--training', training);
    r.modeChip.textContent = training ? 'TRAINING' : 'PLAYER 1';
    // A dummy that is the machine you are practising with teaches nothing about
    // spacing, so the default steps off P1 rather than sitting on slot two.
    if (training && this._dummyIndex === this.p1Index && ROSTER.length > 1) {
      this._dummyIndex = (this.p1Index + 1) % ROSTER.length;
    }
    this.#syncOpponentControl();
    for (const t of r.tiles) t.classList.remove('kbs-tile--picked');
    r.tiles[this.p1Index]?.classList.add('kbs-tile--picked');
    // Runs before `show()` reads `screens.select.cols`, so the first grid walk
    // of the session already matches the layout the breakpoints chose.
    this.#syncGridCols();
    this.#previewOpen();
    replayAnim(r.root, 'kbs-screen--enter');
  }

  /**
   * Re-reads the rack's used column count and republishes it to the grid walk.
   *
   * The compact layouts reflow `.kbs-grid`, so `GRID_COLS` is only the wide
   * default. Taking the number from the resolved `grid-template-columns` — a
   * list of used pixel lengths once the grid is laid out — means the walk and
   * the stylesheet cannot drift apart when a breakpoint is retuned.
   */
  #syncGridCols() {
    const r = this._select;
    if (!r?.rackGrid || !this.screens.select) return;
    const tracks = getComputedStyle(r.rackGrid).gridTemplateColumns;
    if (!tracks || tracks === 'none') return;
    const cols = Math.max(1, tracks.split(' ').filter(Boolean).length);
    this.screens.select.cols = cols;
    if (this.current === 'select') this.nav.cols = cols;
  }

  #selectHide() {
    const r = this._select;
    clearTimeout(r.scrambleTimer);
    clearTimeout(r.swapTimer);
    clearTimeout(r.lockTimer);
    r.locked = false;
    this.#previewClose();
  }

  /**
   * Focus moved to roster index `i`: refresh the dossier, drive the carriage,
   * and ask the live preview for that machine. Everything here is cheap; the
   * one expensive step — rebuilding the rig — is debounced inside `#previewSet`.
   */
  #focusCharacter(i) {
    const r = this._select;
    if (r.focus === i) return;
    const def = ROSTER[i];
    if (!def) return;
    const first = r.focus < 0;
    r.tiles[r.focus]?.setAttribute('aria-selected', 'false');
    r.tiles[i].setAttribute('aria-selected', 'true');
    r.focus = i;

    const pal = def.palette || {};
    r.root.style.setProperty('--kbs-c', pal.accent);
    r.root.style.setProperty('--kbs-e', pal.emissive);
    r.root.style.setProperty('--kbs-glow', hexToRgba(pal.emissive, 0.5));

    this.#scrambleName(def.name);
    r.dSub.textContent = def.subtitle;
    r.dArchTag.textContent = def.archetype;
    r.dArchNote.textContent = ARCHETYPES[def.archetype] || '';
    r.dBio.textContent = def.bio;

    const chassis = chassisOf(def);
    r.dNote.textContent = chassis.description;
    r.specVals.chassis.textContent = chassis.label;
    r.specVals.mass.textContent = `${massOf(def)} kg`;
    r.specVals.moveset.textContent = def.moveSet;
    r.specVals.frame.textContent = def.silhouette?.plating || '—';

    for (const key of STAT_KEYS) {
      const v = def.stats?.[key] ?? 0;
      r.statFills[key].style.transform = `scaleX(${(v / 10).toFixed(3)})`;
      r.statNums[key].textContent = String(v);
    }

    const values = [pal.primary, pal.secondary, pal.accent, pal.emissive, pal.trim];
    r.swatches.forEach((sw, idx) => { sw.style.background = values[idx] || '#333'; });

    this.#moveCarriage(r.tiles[i]);
    if (!first) {
      replayAnim(r.dossCard, 'kbs-card--cut');
      replayAnim(r.sweep, 'kbs-sweep--go');
    }
    this.#previewSet(i, first);
  }

  /** Slides the rack carriage onto the focused tile. One layout read per move. */
  #moveCarriage(tile) {
    const { carriage, rackGrid } = this._select;
    if (!tile) return;
    // offsetLeft/Top are measured against the grid's padding box, so they stay
    // correct while it scrolls and the carriage scrolls with the tile.
    carriage.style.transform = `translate3d(${tile.offsetLeft}px, ${tile.offsetTop}px, 0)`;
    carriage.style.width = `${tile.offsetWidth}px`;
    carriage.style.height = `${tile.offsetHeight}px`;
    carriage.style.opacity = '1';
    // The compact layouts let the rack scroll as a safety valve on a very short
    // viewport. Only reach for the scroller when there actually is one — on
    // every other screen this is a wasted layout read.
    const scrolls = !!rackGrid && rackGrid.scrollHeight > rackGrid.clientHeight + 1;
    // The one read above pays for the affordance too. A rank cut off flat at the
    // rack's bottom edge reads as a clipping bug rather than as more content,
    // and on a notched handset in landscape that is exactly what the valve
    // produces: 45px of safe-area inset off a 390px screen is one rank's worth.
    rackGrid?.classList.toggle('kbs-grid--scroll', scrolls);
    if (scrolls) tile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Six frames of glyph noise before the name resolves. Motion, not decoration:
   *  it is what makes the readout feel driven rather than swapped. */
  #scrambleName(name) {
    const r = this._select;
    clearTimeout(r.scrambleTimer);
    let step = 0;
    const total = 5;
    const tick = () => {
      step++;
      if (step > total) { applyKbText(r.dName, name); return; }
      const keep = Math.floor((name.length * step) / (total + 1));
      let out = '';
      for (let i = 0; i < name.length; i++) {
        const c = name[i];
        out += (i < keep || c === ' ' || c === '-') ? c : SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
      }
      applyKbText(r.dName, out);
      r.scrambleTimer = setTimeout(tick, 26);
    };
    tick();
  }

  // -- live preview -----------------------------------------------------------

  /**
   * Hands the middle of the screen over to the game's own renderer.
   *
   * Player one becomes the display stand: it is moved to the centre mark, the
   * opponent is hidden, and `FightCamera` is cut to its `portrait` framing. The
   * options object handed to `cinematic()` is kept and mutated per frame —
   * \`#framingPortrait\` re-reads it every tick, so writing `yaw` on an object we
   * own is all it takes to drive a turntable through the camera's own springs
   * without reaching into anything that belongs to FightCamera.
   */
  #previewOpen() {
    const g = this.game;
    const fighter = g.fighters?.[0];
    const cam = g.fightCamera;
    const r = this._select;
    if (!fighter || !cam?.cinematic) {
      r.stage.classList.add('kbs-stage--offline');
      return;
    }
    r.stage.classList.remove('kbs-stage--offline');

    const foe = g.fighters?.[1];
    this._foeGroup = foe?.group || null;
    if (this._foeGroup) {
      this._foeWasVisible = this._foeGroup.visible;
      this._foeGroup.visible = false;
    }
    foe?.reset?.(OPPONENT_MARK, 1);

    fighter.reset(PREVIEW_MARK, 1);
    this._camOpts = {
      target: fighter, dist: PREVIEW_DIST, yaw: PREVIEW_YAW, height: PREVIEW_HEIGHT,
    };
    cam.cinematic('portrait', this._camOpts);

    this._swing = SWAP_SWING;
    this._previewT0 = performance.now();
    this.#previewStart();
  }

  #previewClose() {
    this.#previewStop();
    if (this._foeGroup) this._foeGroup.visible = this._foeWasVisible !== false;
    this._foeGroup = null;
    this._camOpts = null;
  }

  /**
   * Loads roster index `i` onto the display stand.
   *
   * `Fighter#setCharacter` tears down and regrows the whole rig — measured at
   * 40–130 ms per machine — so arrowing across the rack must not queue one call
   * per keystroke. The focus has to hold for `SWAP_DEBOUNCE` first, and a
   * machine that is already loaded costs nothing at all, which is why entering
   * the screen on the last-used character is free.
   */
  #previewSet(i, immediate) {
    const fighter = this.game.fighters?.[0];
    const def = ROSTER[i];
    const r = this._select;
    clearTimeout(r.swapTimer);
    if (!fighter || !def || !this._camOpts) return;
    if (fighter.def === def) return;
    const run = () => {
      if (!this._camOpts || this.current !== 'select') return;
      fighter.setCharacter(def);
      this._swing = SWAP_SWING;
    };
    if (immediate) run();
    else r.swapTimer = setTimeout(run, SWAP_DEBOUNCE);
  }

  #previewStart() {
    if (this._previewRAF) return;
    const step = () => {
      this._previewRAF = requestAnimationFrame(step);
      const o = this._camOpts;
      if (!o) return;
      // FightCamera resolves a phase change inside its own `simulate()`, one
      // tick AFTER the bus event that opened this screen, and its default
      // branch pulls any non-fight mode back to pair tracking. So the framing
      // cannot simply be set once on show — it is asserted here, which also
      // makes the preview self-healing if anything else takes the camera.
      const cam = this.game.fightCamera;
      if (cam && cam.mode !== 'portrait') cam.cinematic('portrait', o);
      const t = (performance.now() - this._previewT0) / 1000;
      // A swap swings the lens out and lets the portrait spring pull it back:
      // the machine reads as being turned into place, not cross-faded.
      this._swing *= 0.9;
      o.yaw = PREVIEW_YAW + Math.sin((t / DRIFT_PERIOD) * Math.PI * 2) * DRIFT_AMOUNT - this._swing;
    };
    this._previewRAF = requestAnimationFrame(step);
  }

  #previewStop() {
    if (this._previewRAF) cancelAnimationFrame(this._previewRAF);
    this._previewRAF = null;
  }

  // -- commit -----------------------------------------------------------------

  #confirmSelect(i) {
    const r = this._select;
    if (r.locked || !ROSTER[i]) return;
    r.locked = true;

    r.tiles[this.p1Index]?.classList.remove('kbs-tile--picked');
    this.p1Index = i;
    r.tiles[i]?.classList.add('kbs-tile--picked');
    const training = this._selectIntent === 'training';
    this.cpuIndex = training
      ? this._dummyIndex
      : (ROSTER.length > 1
        ? (i + 1 + Math.floor(Math.random() * (ROSTER.length - 1))) % ROSTER.length
        : i);

    // The commit beat: brackets slam, the frame flashes, then the match starts.
    // A quarter of a second, deliberately spent — not a stall.
    replayAnim(r.root, 'kbs-screen--lock');
    this._swing = SWAP_SWING * 1.6;
    r.lockTimer = setTimeout(() => {
      r.locked = false;
      if (training) {
        this.game.startTraining(this.p1Index, this.cpuIndex);
      } else {
        // `startMatch` does not clear the training flag, and a session left on
        // would hold the clock and refill both fighters through a whole arcade
        // match. Leaving training is this screen's job because this screen is
        // the only way back into a real one.
        if (this.game.training) this.game.setTraining(false);
        this.game.startMatch(this.p1Index, this.cpuIndex);
      }
    }, LOCK_TICKS);
  }

  // -------------------------------------------------------------------------
  // Difficulty and the opponent control
  // -------------------------------------------------------------------------

  /**
   * A labelled value with a decrement and an increment either side of it, a
   * ten-notch gauge under the value and two lines of consequence beneath that.
   *
   * One nav item, not three: arrow keys adjust it in place, which is the idiom
   * the options sliders already established, and the two buttons exist for the
   * pointer and the finger — both pinned to 44px in the touch block, because a
   * stepper whose targets are 24px is a stepper a phone player cannot use.
   *
   * `onStep` returns false when it is already at the end of its own range; see
   * `#left` for what that buys.
   */
  #buildStepper(items, { klass = '', ladder = 0, onStep, onActivate }) {
    const root = el('div', `kbg-step ${klass}`.trim());
    const top = el('div', 'kbg-step-top');
    const label = el('span', 'kbg-step-label');
    const tag = el('span', 'kbg-step-tag');
    top.append(label, tag);

    const row = el('div', 'kbg-step-row');
    // Drawn, not typeset. Both faces in the stack render U+2212 as a short bar
    // low in the em box — it photographed as an underscore next to a correctly
    // centred plus — and two CSS rules are cheaper than trusting a glyph.
    const mk = (dir, aria) => {
      const b = el('button', `kbg-step-btn kbg-step-btn--${dir > 0 ? 'plus' : 'minus'}`);
      b.type = 'button';
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#focusEl(root);
        if (onStep(dir) !== false) bus.emit('uiConfirm', {});
      });
      return b;
    };
    const mid = el('div', 'kbg-step-mid');
    const value = el('div', 'kbg-step-value');
    const gauge = el('div', 'kbg-step-gauge');
    const notches = [];
    for (let i = 0; i < ladder; i++) {
      const n = el('i', 'kbg-notch');
      gauge.appendChild(n);
      notches.push(n);
    }
    mid.append(value, gauge);
    row.append(mk(-1, 'lower'), mid, mk(1, 'raise'));

    // Note and consequence line share a wrapper so the footer variant can put
    // them in a second column instead of a third and fourth row — five stacked
    // lines turned the select footer into a 110px band and took that height
    // straight out of the live preview, which is the screen's whole point.
    const text = el('div', 'kbg-step-text');
    const note = el('div', 'kbg-step-note');
    const meta = el('div', 'kbg-step-meta');
    text.append(note, meta);
    root.append(top, row, text);
    root.addEventListener('mouseenter', () => { if (this.#focusEl(root)) bus.emit('uiHover', {}); });

    items.push({ el: root, onAdjust: onStep, action: onActivate, focusClass: 'kbg-step--focus' });
    return { root, label, tag, value, note, meta, notches };
  }

  /** Nudge the CPU level. Applies immediately — mid-round included. */
  #stepDifficulty(dir) {
    const next = clamp(this.game.difficulty + dir, DIFFICULTY_MIN, DIFFICULTY_MAX);
    if (next === this.game.difficulty) return false;
    this.game.setDifficulty(next);
    bus.emit('uiHover', {});
    return true;
  }

  /** Writes `game.difficulty` into one stepper. */
  #paintDifficulty(st) {
    const lv = this.game.difficulty;
    const band = bandFor(lv);
    const p = difficultyProfile(lv);
    st.label.textContent = 'CPU DIFFICULTY';
    st.tag.textContent = `LV ${String(lv).padStart(2, '0')}`;
    st.value.textContent = band.name;
    st.note.textContent = band.note;
    // Discrete per band, not interpolated: a single `color-mix` from cyan to
    // red passes through grey at the middle of its own range, and the middle of
    // this range is the default opponent. Five steps up the existing token
    // ramp read as an escalation; a two-stop mix read as a fault.
    st.root.style.setProperty('--kbg-hot', band.ink);
    for (let i = 0; i < st.notches.length; i++) st.notches[i].classList.toggle('kbg-notch--on', i < lv);
    st.meta.replaceChildren(
      metaCell('REACTION', `${p.reaction}f`),
      metaCell('GUARD', `${Math.round(p.block * 100)}%`),
      metaCell('PUNISH', `${Math.round(p.punish * 100)}%`),
      metaCell('COMBO', `${p.combo} hit${p.combo === 1 ? '' : 's'}`),
    );
  }

  /** Builds a difficulty stepper and enrols it in the shared re-sync. */
  #buildDifficultyStepper(items, klass) {
    const st = this.#buildStepper(items, {
      klass,
      ladder: DIFFICULTY_MAX,
      onStep: (dir) => this.#stepDifficulty(dir),
      // Enter on a stepper cycles rather than doing nothing: at the ceiling it
      // wraps to the floor, so the control is still usable from a pad or a
      // keyboard that never leaves the confirm button.
      onActivate: () => { if (!this.#stepDifficulty(1)) this.game.setDifficulty(DIFFICULTY_MIN); },
    });
    this._diffViews.push(() => this.#paintDifficulty(st));
    this.#paintDifficulty(st);
    return st;
  }

  #syncDifficulty() {
    for (const paint of this._diffViews) paint();
  }

  /**
   * The select footer's one contextual control: difficulty in arcade, which
   * machine the dummy is in training. Same slot, same nav index, because in
   * both modes the question it answers is "who am I about to fight".
   */
  #buildOpponentControl(items) {
    const st = this.#buildStepper(items, {
      klass: 'kbg-step--foot',
      ladder: DIFFICULTY_MAX,
      onStep: (dir) => this.#stepOpponent(dir),
      onActivate: () => this.#stepOpponent(1) || this.#stepOpponentWrap(),
    });
    this._oppStep = st;
    this._diffViews.push(() => { if (this._selectIntent !== 'training') this.#syncOpponentControl(); });
    return st.root;
  }

  #stepOpponent(dir) {
    if (this._selectIntent !== 'training') return this.#stepDifficulty(dir);
    const next = this._dummyIndex + dir;
    if (next < 0 || next >= ROSTER.length) return false;
    this._dummyIndex = next;
    this.#syncOpponentControl();
    bus.emit('uiHover', {});
    return true;
  }

  #stepOpponentWrap() {
    if (this._selectIntent === 'training') { this._dummyIndex = 0; this.#syncOpponentControl(); }
    else this.game.setDifficulty(DIFFICULTY_MIN);
  }

  #syncOpponentControl() {
    const st = this._oppStep;
    if (!st) return;
    if (this._selectIntent !== 'training') { this.#paintDifficulty(st); return; }
    const def = ROSTER[this._dummyIndex] || ROSTER[0];
    const n = ROSTER.length;
    st.label.textContent = 'PRACTICE DUMMY';
    st.tag.textContent = `${String(this._dummyIndex + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}`;
    st.value.textContent = def.name;
    st.note.textContent = `${def.archetype} · ${chassisOf(def).label} · ${massOf(def)} kg`.toUpperCase();
    st.root.style.setProperty('--kbg-hot', 'var(--kb-cyan)');
    for (let i = 0; i < st.notches.length; i++) {
      st.notches[i].classList.toggle('kbg-notch--on', i === Math.round((this._dummyIndex / Math.max(1, n - 1)) * (st.notches.length - 1)));
    }
    st.meta.replaceChildren(
      metaCell('REACH', String(def.stats?.reach ?? '—')),
      metaCell('WEIGHT', String(def.stats?.weight ?? '—')),
      metaCell('DEFENSE', String(def.stats?.defense ?? '—')),
      metaCell('MODE', 'STANDING'),
    );
  }

  // -------------------------------------------------------------------------
  // Options
  // -------------------------------------------------------------------------

  #buildOptions() {
    const screen = el('div', 'menu-screen');
    const bg = el('div', 'menu-bg menu-bg--dim');
    const wrap = el('div', 'options-wrap');
    const panel = el('div', 'options-panel');
    const title = el('div', 'options-title', 'OPTIONS');

    const items = [];

    // -- gameplay --
    // First section, above Display: the one setting here that changes how the
    // game plays rather than how it looks.
    const gameSection = el('div', 'options-section');
    gameSection.append(el('h3', null, 'Gameplay'), this.#buildDifficultyStepper(items, 'kbg-step--panel').root);

    // -- display --
    const dispSection = el('div', 'options-section');
    const dispH = el('h3', null, 'Display');
    const qualRow = el('div', 'option-row');
    const qualLabel = el('div', 'option-row-label', 'Render Quality');
    const tiers = Object.keys(QUALITY_TIERS);
    const segGroup = el('div', 'seg-group');
    const segBtns = tiers.map((tier) => {
      const b = el('button', 'seg-btn', tier);
      const idx = items.length;
      const pick = () => { this.#setQuality(tier); this.nav.index = idx; this.#applyFocus(); };
      b.addEventListener('click', () => { bus.emit('uiConfirm', {}); pick(); });
      b.addEventListener('mouseenter', () => { this.nav.index = idx; this.#applyFocus(); bus.emit('uiHover', {}); });
      items.push({ el: b, action: pick, onAdjust: pick, focusClass: 'seg-btn--focus' });
      segGroup.appendChild(b);
      return b;
    });
    qualRow.append(qualLabel, segGroup);
    dispSection.append(dispH, qualRow);

    // -- audio --
    const audioSection = el('div', 'options-section');
    const audioH = el('h3', null, 'Audio');
    const sliders = {};
    for (const [channel, label] of [['master', 'Master Volume'], ['music', 'Music'], ['sfx', 'Effects']]) {
      const { row, setValue } = this.#buildSlider(items, label, this.settings[channel], (v) => this.#setVolume(channel, v));
      audioSection.appendChild(row);
      sliders[channel] = setValue;
    }
    audioSection.prepend(audioH);

    // -- controls (read-only reference) --
    const ctrlSection = el('div', 'options-section');
    const ctrlH = el('h3', null, 'Controls');
    const table = el('div', 'keybind-table');
    for (const [player, rows] of Object.entries(KEYBINDS)) {
      const col = el('div', 'keybind-col');
      col.appendChild(el('h4', null, player));
      for (const [action, key] of rows) {
        const line = el('div', 'keybind-line');
        line.append(el('span', null, action), el('b', null, key));
        col.appendChild(line);
      }
      table.appendChild(col);
    }
    ctrlSection.append(ctrlH, table);

    const actions = el('div', 'options-actions');
    actions.appendChild(this.#addNavButton(items, 'BACK', () => this.show(this.pendingReturn)));

    panel.append(title, gameSection, dispSection, audioSection, ctrlSection, actions);
    wrap.appendChild(panel);
    screen.append(bg, wrap);
    this.root.appendChild(screen);

    this._options = { segBtns, tiers, sliders };
    this.screens.options = {
      el: screen, nav: items, cols: 1,
      onShow: () => { this.#refreshQualitySeg(); for (const c in sliders) sliders[c](this.settings[c], false); },
    };
  }

  /** Builds one audio slider row and registers it as a nav item with keyboard adjust. */
  #buildSlider(items, label, initial, onChange) {
    const row = el('div', 'option-row option-row--slider');
    const lab = el('div', 'option-row-label', label);
    const wrap = el('div', 'slider-wrap');
    const track = el('div', 'slider-track');
    const fill = el('div', 'slider-fill');
    track.appendChild(fill);
    const valueEl = el('div', 'slider-value');
    wrap.append(track, valueEl);
    row.append(lab, wrap);

    let value = initial;
    const setValue = (v, emit = true) => {
      value = clamp(Math.round(v), 0, 100);
      fill.style.transform = `scaleX(${value / 100})`;
      valueEl.textContent = String(value);
      if (emit) onChange(value);
    };
    setValue(initial, false);

    const idx = items.length;
    const fromEvent = (e) => {
      const rect = track.getBoundingClientRect();
      const p = (e.clientX - rect.left) / Math.max(1, rect.width);
      setValue(p * 100);
    };
    track.addEventListener('mousedown', (e) => {
      this.nav.index = idx; this.#applyFocus();
      fromEvent(e);
      const move = (ev) => fromEvent(ev);
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    track.addEventListener('mouseenter', () => { this.nav.index = idx; this.#applyFocus(); bus.emit('uiHover', {}); });

    items.push({ el: row, onAdjust: (dir) => setValue(value + dir * 5), focusClass: 'option-row--focus' });
    return { row, setValue };
  }

  #openOptions(from) {
    this.pendingReturn = from;
    this.show('options');
  }

  #refreshQualitySeg() {
    const { segBtns, tiers } = this._options;
    for (let i = 0; i < tiers.length; i++) segBtns[i].classList.toggle('seg-btn--on', tiers[i] === this.settings.quality);
  }

  #setQuality(tier) {
    this.settings.quality = tier;
    // Through Game, not straight at the renderer. Environment and Stage both
    // implement setQuality and neither was ever called from here, so choosing
    // Low changed the post stack and left the full lighting rig running — on
    // exactly the machines the Low tier exists for.
    this.game.setQuality?.(tier);
    this.#refreshQualitySeg();
    bus.emit('settingsChange', { ...this.settings });
  }

  #setVolume(channel, value) {
    this.settings[channel] = value;
    bus.emit('volumeChange', { channel, value: value / 100 });
  }

  // -------------------------------------------------------------------------
  // Pause
  // -------------------------------------------------------------------------

  /**
   * Pause carries one contextual block between RESUME and OPTIONS: the CPU
   * difficulty stepper in an arcade match, the practice display toggles in a
   * training session. They are mutually exclusive by construction — training
   * has no CPU to tune and a match has nothing to draw boxes for — so the
   * screen publishes two nav arrays and `#syncPauseMode` picks one before
   * `show()` reads it. A hidden control left in the array would still take
   * keyboard focus, which is the whole reason this is not one array with a
   * `display: none` in it.
   */
  #buildPause() {
    const screen = el('div', 'menu-screen');
    const bg = el('div', 'menu-bg menu-bg--dim');
    const wrap = el('div', 'pause-wrap');
    const panel = el('div', 'pause-panel');
    const title = el('div', 'pause-title', 'PAUSED');
    const eyebrow = el('div', 'pause-mode', 'TRAINING');

    const shared = { resume: null, options: null, quit: null };
    const build = (mode) => {
      const items = [];
      shared.resume = this.#addNavButton(items, 'RESUME', () => this.#resume());
      const block = mode === 'training'
        ? this.#buildTrainingToggles(items)
        : this.#buildDifficultyStepper(items, 'kbg-step--panel').root;
      shared.options = this.#addNavButton(items, 'OPTIONS', () => this.#openOptions('pause'));
      shared.quit = this.#addNavButton(items, mode === 'training' ? 'END TRAINING' : 'QUIT TO TITLE', () => {
        this.game.paused = false;
        if (this.game.training) this.game.setTraining(false);
        this.game.setPhase('menu');
      });
      const body = el('div', 'pause-body');
      body.append(shared.resume, block, shared.options, shared.quit);
      return { items, body };
    };

    const arcade = build('arcade');
    const training = build('training');
    training.body.classList.add('pause-body--hidden');

    panel.append(title, eyebrow, arcade.body, training.body);
    wrap.appendChild(panel);
    screen.append(bg, wrap);
    this.root.appendChild(screen);

    this._pause = { eyebrow, arcade, training };
    this.screens.pause = {
      el: screen, nav: arcade.items, cols: 1,
      onShow: () => this.#syncPauseMode(),
    };
  }

  /** Points the pause screen at the block that matches the session. */
  #syncPauseMode() {
    const p = this._pause;
    if (!p) return;
    const training = !!this.game.training;
    p.arcade.body.classList.toggle('pause-body--hidden', training);
    p.training.body.classList.toggle('pause-body--hidden', !training);
    p.eyebrow.classList.toggle('pause-mode--on', training);
    this.screens.pause.nav = training ? p.training.items : p.arcade.items;
    if (this.current === 'pause') this.#setNav(this.screens.pause.nav, 1, this.screens.pause.nav.length, 0);
  }

  /** The three practice readouts, as nav items. */
  #buildTrainingToggles(items) {
    const block = el('div', 'kbg-toggles');
    for (const [key, label, note] of [
      ['boxes', 'HITBOXES', 'hit and hurt volumes'],
      ['frames', 'FRAME DATA', 'last move, startup and advantage'],
      ['inputs', 'INPUT HISTORY', 'rolling command log'],
    ]) {
      const row = el('button', 'kbg-toggle');
      row.type = 'button';
      const text = el('span', 'kbg-toggle-text');
      text.append(el('b', null, label), el('i', null, note));
      const sw = el('span', 'kbg-toggle-sw');
      row.append(text, sw);
      const flip = () => this.#setTrainingOption(key, !this.training[key]);
      row.addEventListener('click', () => { this.#focusEl(row); bus.emit('uiConfirm', {}); flip(); });
      row.addEventListener('mouseenter', () => { if (this.#focusEl(row)) bus.emit('uiHover', {}); });
      items.push({ el: row, action: flip, onAdjust: (dir) => this.#setTrainingOption(key, dir > 0), focusClass: 'kbg-toggle--focus' });
      block.appendChild(row);
      (this._trainToggleEls ||= {})[key] = row;
    }
    this.#syncTrainingToggles();
    return block;
  }

  #setTrainingOption(key, on) {
    if (this.training[key] === on) return;
    this.training[key] = on;
    // `debug.hitboxes` is the game's own flag and stays the source of truth, so
    // flipping it from the console draws the overlay too.
    if (key === 'boxes') this.game.debug.hitboxes = on;
    this.#syncTrainingToggles();
    this.#syncTrainingOverlay();
  }

  #syncTrainingToggles() {
    for (const key in this._trainToggleEls || {}) {
      this._trainToggleEls[key].classList.toggle('kbg-toggle--on', !!this.training[key]);
      this._trainToggleEls[key].setAttribute('aria-pressed', String(!!this.training[key]));
    }
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  #buildResults() {
    const screen = el('div', 'menu-screen');
    const bg = el('div', 'menu-bg');
    const wrap = el('div', 'results-wrap');

    const winnerEl = el('div', 'results-winner');
    const subEl = el('div', 'results-sub', 'MATCH COMPLETE');
    const scoreEl = el('div', 'results-score');
    const s1 = document.createElement('span');
    const s2 = document.createElement('span');
    scoreEl.append(s1, document.createTextNode(' — '), s2);

    const actions = el('div', 'results-actions');
    const items = [];
    actions.appendChild(this.#addNavButton(items, 'REMATCH', () => this.game.startMatch(this.p1Index, this.cpuIndex)));
    actions.appendChild(this.#addNavButton(items, 'CHARACTER SELECT', () => this.game.setPhase('select')));
    actions.appendChild(this.#addNavButton(items, 'MAIN MENU', () => this.game.setPhase('menu')));

    wrap.append(winnerEl, subEl, scoreEl, actions);
    screen.append(bg, wrap);
    this.root.appendChild(screen);

    this.screens.results = {
      el: screen, nav: items, cols: 1,
      onShow: () => this.#refreshResults(winnerEl, s1, s2),
    };
  }

  #refreshResults(winnerEl, s1, s2) {
    const names = this.game.fighters?.map((f) => f.def?.name || '???') ?? ['P1', 'P2'];
    const wins = this.game.wins || [0, 0];
    const w = this._lastWinner;
    applyKbText(winnerEl, w === 0 || w === 1 ? `${names[w]} WINS` : 'DRAW');
    s1.textContent = `${names[0]} ${wins[0]}`;
    s2.textContent = `${names[1]} ${wins[1]}`;
    s1.classList.toggle('win', w === 0);
    s2.classList.toggle('win', w === 1);
  }

  // -------------------------------------------------------------------------
  // Training overlay
  // -------------------------------------------------------------------------

  /**
   * The practice HUD, and the one thing that tells a player they are in a
   * practice session at all.
   *
   * It is a sibling of the menu tree rather than a screen inside it: a screen
   * is shown *instead of* the fight, and this is shown *during* it. It sits at
   * z-index 39 — above the HUD, below the touch pad at 40 and below the menu
   * layer at 41 — so pausing covers it and the thumb stick is never fighting a
   * readout for a tap. Nothing in it is interactive; the toggles live in the
   * pause menu, which is where a fighting game has always put them and which
   * keeps this layer at `pointer-events: none` entire.
   *
   * The banner exists because `HUD.js` belongs to another workstream and still
   * draws a round timer and round pips through a training session, where the
   * clock is held at 60 and the pips can never advance. Naming that outright is
   * cheaper and more honest than reaching into someone else's DOM to hide it.
   */
  #buildTrainingOverlay() {
    const root = el('div', 'kbg-root');
    root.setAttribute('aria-hidden', 'true');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'kbg-boxes');
    svg.setAttribute('preserveAspectRatio', 'none');
    root.appendChild(svg);

    const banner = el('div', 'kbg-banner');
    banner.append(el('b', null, 'TRAINING'), el('span', null, 'CLOCK HELD · ROUNDS OFF · HEALTH RESTORES'));
    banner.setAttribute('role', 'status');

    const panel = el('div', 'kbg-panel');

    const frames = el('div', 'kbg-card kbg-card--frames');
    const fHead = el('div', 'kbg-card-h');
    const fResult = el('span', 'kbg-result');
    fHead.append(el('span', null, 'LAST MOVE'), fResult);
    const fName = el('div', 'kbg-mv-name', '—');
    const fInput = el('div', 'kbg-mv-input', 'throw a move');
    const fGrid = el('div', 'kbg-fd');
    const fCells = {};
    for (const [key, label] of FRAME_CELLS) {
      const cell = el('div', 'kbg-fd-cell');
      const v = el('b', null, '—');
      cell.append(el('i', null, label), v);
      fGrid.appendChild(cell);
      fCells[key] = { cell, v };
    }
    frames.append(fHead, fName, fInput, fGrid);

    const inputs = el('div', 'kbg-card kbg-card--inputs');
    inputs.append(el('div', 'kbg-card-h', 'INPUTS'));
    const hist = el('div', 'kbg-hist');
    const histRows = [];
    for (let i = 0; i < HISTORY_ROWS; i++) {
      const row = el('div', 'kbg-hist-row');
      const dir = el('span', 'kbg-hist-dir', '');
      const btns = el('span', 'kbg-hist-btns');
      const gap = el('span', 'kbg-hist-gap', '');
      row.append(dir, btns, gap);
      hist.appendChild(row);
      histRows.push({ row, dir, btns, gap });
    }
    inputs.appendChild(hist);

    panel.append(frames, inputs);
    root.append(banner, panel);
    this.uiRoot.appendChild(root);

    this._train = {
      root, svg, banner, panel, frames, inputs, fResult, fName, fInput, fCells, histRows,
      // Per-frame scratch, all of it derived and none of it authoritative.
      lines: [], move: null, moveInstance: -1, result: '', resultInstance: -1,
      history: [], lastTick: -1, raf: 0, viewW: 0, viewH: 0,
    };
    this.#syncTrainingOverlay();
  }

  /** Clears the readouts so a new session does not open on the last one's
   *  last move and a log of inputs the player has forgotten making. */
  #resetTrainingReadout() {
    const t = this._train;
    if (!t) return;
    t.move = null; t.moveInstance = -1; t.result = ''; t.resultInstance = -1;
    t.history.length = 0; t.lastTick = -1;
    t.fName.textContent = '—';
    t.fInput.textContent = 'throw a move';
    t.fResult.textContent = '';
    t.fResult.dataset.kind = '';
    for (const [key] of FRAME_CELLS) {
      t.fCells[key].v.textContent = '—';
      delete t.fCells[key].cell.dataset.sign;
    }
    for (const r of t.histRows) {
      r.row.classList.add('kbg-hist-row--empty');
      r.dir.textContent = ''; r.btns.replaceChildren(); r.gap.textContent = '';
    }
  }

  /** Visible only during a live practice session with no full screen over it. */
  #syncTrainingOverlay() {
    const t = this._train;
    if (!t) return;
    const modal = this.current && this.current !== 'pause';
    const on = !!this.game.training && !modal;
    t.root.classList.toggle('kbg-root--on', on);
    t.frames.classList.toggle('kbg-card--off', !this.training.frames);
    t.inputs.classList.toggle('kbg-card--off', !this.training.inputs);
    t.svg.classList.toggle('kbg-boxes--on', !!this.game.debug.hitboxes);
    if (on) this.#trainingStart();
    else this.#trainingStop();
  }

  #trainingStart() {
    if (this._train.raf) return;
    const step = () => {
      this._train.raf = requestAnimationFrame(step);
      this.#trainingSample();
    };
    this._train.raf = requestAnimationFrame(step);
  }

  #trainingStop() {
    if (this._train.raf) cancelAnimationFrame(this._train.raf);
    this._train.raf = 0;
  }

  /** Records what the player's last move did, for the frame-data readout. */
  #noteMoveResult(fighter, result) {
    if (!this.game.training || fighter !== this.game.fighters?.[0]) return;
    this._train.result = result;
    this._train.resultInstance = fighter.moveInstance;
  }

  #trainingSample() {
    const f = this.game.fighters?.[0];
    if (!f) return;
    if (this.training.frames) this.#sampleFrameData(f);
    if (this.training.inputs) this.#sampleInputs();
    if (this.game.debug.hitboxes) this.#drawBoxes();
    else if (this._train.lines.length) this.#clearBoxes();
  }

  /**
   * `currentMove` is cleared the moment the move ends, so the readout latches
   * it: what a frame display is for is reading the numbers *after* the move,
   * with the recovery already spent.
   */
  #sampleFrameData(f) {
    const t = this._train;
    const mv = f.currentMove;
    if (mv && f.moveInstance !== t.moveInstance) {
      t.moveInstance = f.moveInstance;
      t.move = mv;
      t.result = '';
      this.#paintFrameData(mv);
    } else if (mv && mv !== t.move) {
      // A cancel keeps the instance and swaps the move underneath it.
      t.move = mv;
      this.#paintFrameData(mv);
    }
    const shown = t.resultInstance === t.moveInstance ? t.result : '';
    if (t.fResult.textContent !== shown) {
      t.fResult.textContent = shown;
      t.fResult.dataset.kind = shown.startsWith('COUNTER') ? 'counter'
        : shown === 'HIT' ? 'hit' : shown === 'BLOCKED' ? 'block' : shown ? 'whiff' : '';
    }
  }

  #paintFrameData(mv) {
    const t = this._train;
    t.fName.textContent = mv.name || mv.id;
    const props = [];
    if (mv.props?.armor) props.push('ARMOR');
    if (mv.props?.throw) props.push('THROW');
    if (mv.props?.crushLow) props.push('LOW CRUSH');
    if (mv.props?.crushHigh) props.push('HIGH CRUSH');
    if (mv.juggleHeight) props.push('LAUNCHER');
    t.fInput.textContent = [mv.input, mv.height?.toUpperCase(), ...props].filter(Boolean).join(' · ');
    // The active span is the whole authored window set, first frame to last —
    // a multi-hit string is one move with two windows and reporting only the
    // first would understate it.
    const first = Math.min(...mv.active.map((a) => a.from));
    const last = Math.max(...mv.active.map((a) => a.to));
    const values = {
      startup: `${mv.startup}f`,
      active: `${last - first + 1}f`,
      recovery: `${mv.recovery}f`,
      onBlock: signed(mv.onBlock),
      onHit: signed(mv.onHit),
      damage: String(mv.damage),
    };
    for (const [key] of FRAME_CELLS) {
      const c = t.fCells[key];
      c.v.textContent = values[key];
      if (key === 'onBlock' || key === 'onHit') {
        const adv = mv[key];
        c.cell.dataset.sign = adv > 0 ? 'plus' : adv < -9 ? 'bad' : adv < 0 ? 'minus' : 'even';
      }
    }
  }

  /**
   * `Input#history` is a 20-tick *buffer*, not a log — it is trimmed to the
   * motion-recognition window and holds a third of a second. So this keeps its
   * own list and merges in every entry newer than the last one it saw, which
   * also means a dropped frame costs nothing until the drop exceeds the buffer.
   */
  #sampleInputs() {
    const src = this.game.input?.history?.[0];
    if (!src) return;
    const t = this._train;
    const list = t.history;
    let added = false;
    for (const h of src) {
      if (h.tick <= t.lastTick) continue;
      t.lastTick = h.tick;
      list.push({ tick: h.tick, dir: h.dir, buttons: h.buttons.slice() });
      added = true;
    }
    if (!added) return;
    while (list.length > HISTORY_ROWS) list.shift();
    const rows = t.histRows;
    for (let i = 0; i < rows.length; i++) {
      // Newest at the bottom, the way a command log reads.
      const entry = list[list.length - rows.length + i];
      const r = rows[i];
      if (!entry) { r.row.classList.add('kbg-hist-row--empty'); r.dir.textContent = ''; r.btns.replaceChildren(); r.gap.textContent = ''; continue; }
      r.row.classList.remove('kbg-hist-row--empty');
      r.dir.textContent = DIR_GLYPH[entry.dir] || '·';
      r.dir.classList.toggle('kbg-hist-dir--idle', entry.dir === 5);
      r.btns.replaceChildren(...entry.buttons.map((b) => el('i', `kbg-btn kbg-btn--${b}`, BUTTON_LABEL[b] || String(b))));
      // Frames since the previous input — the number a player counts to learn a
      // link. Anything past 99 is "a while ago" and says nothing useful.
      const prev = list[list.length - rows.length + i - 1];
      const gap = prev ? entry.tick - prev.tick : -1;
      r.gap.textContent = gap < 0 ? '' : gap > 99 ? '99+' : String(gap);
    }
  }

  // -- hit/hurt volume overlay ------------------------------------------------

  /**
   * Draws every live capsule as a round-capped SVG stroke.
   *
   * A capsule *is* a segment swept by a sphere, and a round-capped stroke is
   * exactly that in two dimensions, so this is the projection of the volume
   * rather than a box approximating it. Width comes off the clip-space `w` of
   * the segment's midpoint, which for a perspective camera is the view depth —
   * the same divide the vertex stage does.
   *
   * No three.js import: this file has never had one, and the two matrices are
   * plain 16-element column-major arrays. `matrixWorldInverse` is refreshed by
   * `WebGLRenderer` on every render, so reading it from a rAF that runs after
   * the frame is reading this frame's camera.
   *
   * Boxes come off the simulation, which advanced on the last 60Hz tick, while
   * the visible pose is interpolated by `alpha` — so on a frame between ticks
   * the volume leads or trails the limb by under one frame. That is what the
   * collision test actually used and it is the honest thing to draw.
   */
  #drawBoxes() {
    const t = this._train;
    const cam = this.game.camera;
    const fighters = this.game.fighters;
    if (!cam || !fighters) return;

    const w = t.root.clientWidth;
    const h = t.root.clientHeight;
    if (!w || !h) return;
    if (w !== this._train.viewW || h !== this._train.viewH) {
      this._train.viewW = w; this._train.viewH = h;
      t.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    }

    const vp = mulMat4(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements, VP);
    const fy = cam.projectionMatrix.elements[5];
    let used = 0;

    const draw = (p0, p1, radius, kind) => {
      const a = projectPoint(vp, p0.x, p0.y, p0.z, w, h, PT_A);
      const b = projectPoint(vp, p1.x, p1.y, p1.z, w, h, PT_B);
      if (!a || !b) return;
      const depth = (a.w + b.w) * 0.5;
      const px = (radius * fy * 0.5 * h) / depth;
      if (px < 0.4) return;
      const line = this.#boxLine(used++);
      line.setAttribute('x1', a.x.toFixed(1));
      line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1));
      line.setAttribute('y2', b.y.toFixed(1));
      line.setAttribute('stroke-width', (px * 2).toFixed(1));
      if (line.dataset.kind !== kind) { line.dataset.kind = kind; line.setAttribute('class', `kbg-box kbg-box--${kind}`); }
    };

    for (const f of fighters) {
      if (!f?.hurtboxes) continue;
      for (const hb of f.hurtboxes) draw(hb.p0, hb.p1, hb.radius, f.index === 0 ? 'hurt1' : 'hurt2');
      for (const hb of f.hitboxes) draw(hb.p0, hb.p1, hb.radius, 'hit');
    }
    this.#trimBoxes(used);
  }

  #boxLine(i) {
    const t = this._train;
    let line = t.lines[i];
    if (!line) {
      line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'kbg-box');
      t.svg.appendChild(line);
      t.lines[i] = line;
    } else if (line.style.display) {
      line.style.display = '';
    }
    return line;
  }

  /** Pooled: the strokes are hidden, never removed, so a frame never allocates. */
  #trimBoxes(used) {
    const lines = this._train.lines;
    for (let i = used; i < lines.length; i++) {
      if (!lines[i].style.display) lines[i].style.display = 'none';
    }
  }

  #clearBoxes() { this.#trimBoxes(0); }

  // -------------------------------------------------------------------------
  // Stylesheet
  // -------------------------------------------------------------------------

  /** Injects the select-screen stylesheet once per document. */
  static #installStyles() {
    if (document.getElementById('kbs-style')) return;
    const style = document.createElement('style');
    style.id = 'kbs-style';
    style.textContent = KBS_CSS + KBG_CSS;
    document.head.appendChild(style);
  }
}

/** Local clamp so this file has no dependency on three.js for one number op. */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Frame advantage reads as a sign, always — "+4" and "-13", never "4". */
function signed(n) { return `${n > 0 ? '+' : ''}${n}`; }

// --- the four lines of linear algebra the box overlay needs ------------------
// three.js is not imported here and is not going to be: these are two plain
// column-major Float32/number arrays off the camera, and reusing three scratch
// buffers keeps the overlay allocation-free per frame.

const VP = new Array(16).fill(0);
const PT_A = { x: 0, y: 0, w: 0 };
const PT_B = { x: 0, y: 0, w: 0 };

/** out = a * b, both column-major 4x4. */
function mulMat4(a, b, out) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4]
        + a[4 + r] * b[c * 4 + 1]
        + a[8 + r] * b[c * 4 + 2]
        + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** World point -> viewport pixels, or null if it is behind the lens. */
function projectPoint(m, x, y, z, w, h, out) {
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 0.02) return null;
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  out.x = (cx / cw * 0.5 + 0.5) * w;
  out.y = (0.5 - cy / cw * 0.5) * h;
  out.w = cw;
  return out;
}

/**
 * Character-select stylesheet.
 *
 * Owned entirely by this module and namespaced `kbs-` so it cannot collide with
 * `ui.css`, which another workstream edits. It reads the shared design tokens
 * (`--kb-*`) but defines no globals of its own.
 *
 * Three rules the whole sheet obeys:
 *  - the middle column stays transparent, because the game's renderer is what
 *    draws the machine there;
 *  - nothing full-screen animates and nothing uses `mix-blend-mode` — measured
 *    at ~25 ms/frame of compositing on the old screen's drifting screen-blend
 *    backdrop alone;
 *  - every transition is `transform`/`opacity`, so focus changes never touch
 *    layout.
 */
const KBS_CSS = `
/* Lifts the whole menu tree above the touch pad.
   -------------------------------------------------------------------------
   Measured, on a 844x390 handset with the pad awake: eight of the ten roster
   tiles and the BACK button returned "BLOCKED by .kbt-stickzone" from
   elementFromPoint, so a phone player could reach the first two machines and
   nothing else. That is the whole of the reported "not responsive" — the
   breakpoints were laying the screen out correctly and another layer was
   eating the taps.

   TouchControls mounts \`.kbt-root\` (z-index 40) into the same #ui stacking
   context and is not phase-aware, and \`kbt-off\` only zeroes its opacity, so
   its stick catchment stays hit-testable over every front-end screen. The pad
   ought not to be live outside a fight at all, but that is another module's
   file; 41 here is the fix this one can make, and it is the correct z-order
   regardless: a modal front-end screen is the topmost interactive layer.

   Safe because \`menu-root\` is \`pointer-events: none\` unless a screen is up,
   so during a fight this changes nothing about who receives a touch. */
.kbs-layer { z-index: 41; }

/* Its own type scale. .menu-root clamps at 23px, which is right for a centred
   title card but leaves this screen's readouts unreadably small on a 4K panel —
   every dimension below is in em off this one number. */
.kbs-screen {
  font-size: clamp(13px, 1.12vw, 34px);
  --kbs-c: #ff8a2a; --kbs-e: #3fe0ff; --kbs-glow: rgba(255,138,42,0.45);
}

/* The veil: dark under the side columns, clear through the middle so the live
   render reads, plus a top/bottom falloff to seat the header and footer. */
.kbs-scrim {
  position: absolute; inset: 0;
  background:
    linear-gradient(180deg, rgba(4,6,10,0.92) 0%, rgba(4,6,10,0.34) 16%, rgba(4,6,10,0) 30%,
                    rgba(4,6,10,0) 62%, rgba(4,6,10,0.5) 84%, rgba(4,6,10,0.95) 100%),
    linear-gradient(90deg, rgba(4,6,10,0.96) 0%, rgba(4,6,10,0.9) 24%, rgba(4,6,10,0.42) 31%,
                    rgba(4,6,10,0.06) 40%, rgba(4,6,10,0) 55%, rgba(4,6,10,0.08) 68%,
                    rgba(4,6,10,0.5) 76%, rgba(4,6,10,0.94) 82%, rgba(4,6,10,0.97) 100%),
    radial-gradient(90% 70% at 50% 46%, rgba(255,138,42,0.06), transparent 62%);
  pointer-events: none;
}

.kbs {
  position: absolute; inset: 0;
  display: grid;
  /* The flanks are deliberately unequal. FightCamera's portrait framing sits
     the subject a fixed fraction right of centre, so the window it lives in is
     pushed the same way rather than fighting it. */
  grid-template-columns: clamp(18em, 29vw, 37em) minmax(0, 1fr) clamp(17em, 19vw, 26em);
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas:
    "head head head"
    "rack stage doss"
    "foot foot foot";
  gap: 1.1em 1.4em;
  /* Safe areas: a notched phone held in landscape puts the sensor housing over
     one flank and the home indicator under the footer, and this screen pads in
     em only, so the rack ends up beneath the notch. The four insets are named
     here rather than called inline so that every breakpoint below reads the
     same source, and so the capture harness — where env() is always zero and
     cannot be faked — can force a notch and photograph the result. */
  --kbs-safe-t: env(safe-area-inset-top, 0px);
  --kbs-safe-r: env(safe-area-inset-right, 0px);
  --kbs-safe-b: env(safe-area-inset-bottom, 0px);
  --kbs-safe-l: env(safe-area-inset-left, 0px);
  --kbs-pad-x: clamp(1.4em, 2.6vw, 3.2em);
  padding:
    calc(1.8em + var(--kbs-safe-t)) calc(var(--kbs-pad-x) + var(--kbs-safe-r))
    calc(1.2em + var(--kbs-safe-b)) calc(var(--kbs-pad-x) + var(--kbs-safe-l));
}

/* -- entry ------------------------------------------------------------------ */
/* backwards, never both: a forwards-filling animation would pin the brackets'
   transform and the lock beat below could never move them. */
.kbs-screen--enter .kbs-rack { animation: kbsInL 0.34s cubic-bezier(.16,1,.3,1) backwards; }
.kbs-screen--enter .kbs-doss { animation: kbsInR 0.34s cubic-bezier(.16,1,.3,1) 0.05s backwards; }
.kbs-screen--enter .kbs-head,
.kbs-screen--enter .kbs-foot { animation: kbsInY 0.3s cubic-bezier(.16,1,.3,1) backwards; }
.kbs-screen--enter .kbs-bracket { animation: kbsBracket 0.5s cubic-bezier(.16,1,.3,1) 0.1s backwards; }
@keyframes kbsInL { from { opacity: 0; transform: translate3d(-1.6em,0,0); } }
@keyframes kbsInR { from { opacity: 0; transform: translate3d(1.6em,0,0); } }
@keyframes kbsInY { from { opacity: 0; transform: translate3d(0,0.8em,0); } }
@keyframes kbsBracket { from { opacity: 0; transform: scale(1.5); } }

/* -- header ----------------------------------------------------------------- */
.kbs-head {
  grid-area: head;
  display: flex; align-items: flex-end; justify-content: space-between; gap: 1em;
  border-bottom: 1px solid var(--kb-line);
  padding-bottom: 0.5em;
}
.kbs-title { font-size: 1.55em; font-weight: 900; letter-spacing: 0.16em; line-height: 1; }
.kbs-title-a { color: var(--kb-text); }
.kbs-title-b { color: var(--kbs-c); text-shadow: 0 0 0.8em var(--kbs-glow); }
.kbs-head-meta { display: flex; align-items: center; gap: 0.9em; }
.kbs-head-count {
  font-family: var(--kb-font-mono);
  font-size: 0.56em; letter-spacing: 0.2em; color: var(--kb-text-faint);
}
.kbs-chip {
  font-size: 0.55em; font-weight: 800; letter-spacing: 0.22em;
  padding: 0.42em 0.9em 0.36em;
  clip-path: polygon(0.6em 0, 100% 0, calc(100% - 0.6em) 100%, 0 100%);
}
.kbs-chip--p1 { background: rgba(79,210,255,0.16); color: var(--kb-p1); box-shadow: inset 0 0 0 1px rgba(79,210,255,0.4); }

.kbs-eyebrow {
  font-size: 0.55em; font-weight: 800; letter-spacing: 0.3em;
  color: var(--kb-text-faint); text-transform: uppercase;
  margin-bottom: 0.7em;
  display: flex; align-items: center; gap: 0.7em;
}
.kbs-eyebrow::after { content: ''; flex: 1; height: 1px; background: var(--kb-line); }

/* -- roster rack ------------------------------------------------------------- */
.kbs-rack { grid-area: rack; min-height: 0; display: flex; flex-direction: column; }
.kbs-grid {
  position: relative;
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: repeat(${GRID_COLS}, minmax(0, 1fr));
  grid-auto-rows: minmax(3.2em, 1fr);
  max-height: 34em;
  gap: 0.45em;
  align-content: stretch;
}
/* Below this the rack has no room for a third line and it clips mid-glyph. */
@media (max-height: 840px) {
  .kbs-tile-frame { display: none; }
}
/* Set from #moveCarriage, which has already measured the overflow, and only
   when there is some — a fade over a rack that is not scrolling would dim its
   last rank for nothing. Masked rather than overlaid so it works over the live
   render behind the compact layouts, where a solid gradient strip would not. */
.kbs-grid--scroll {
  -webkit-mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 1.5em), transparent 100%);
  mask-image: linear-gradient(180deg, #000 0, #000 calc(100% - 1.5em), transparent 100%);
}
.kbs-carriage {
  position: absolute; left: 0; top: 0;
  width: 0; height: 0; opacity: 0;
  pointer-events: none;
  border: 1px solid var(--kbs-c);
  box-shadow: 0 0 1.1em var(--kbs-glow), inset 0 0 1.6em rgba(0,0,0,0.5);
  transition: transform 0.16s cubic-bezier(.2,.9,.2,1), width 0.16s ease, height 0.16s ease, opacity 0.2s ease;
  z-index: 2;
}
.kbs-carriage::before, .kbs-carriage::after {
  content: ''; position: absolute; width: 0.5em; height: 0.5em;
  border: 2px solid var(--kbs-c);
}
.kbs-carriage::before { left: -2px; top: -2px; border-right: 0; border-bottom: 0; }
.kbs-carriage::after { right: -2px; bottom: -2px; border-left: 0; border-top: 0; }

.kbs-tile {
  position: relative;
  display: grid;
  grid-template-columns: 3.4em minmax(0, 1fr);
  align-items: center;
  gap: 0.5em;
  min-height: 0;
  padding: 0.35em 0.55em 0.35em 0.4em;
  text-align: left;
  overflow: hidden;
  background: linear-gradient(100deg, rgba(18,23,32,0.94), rgba(11,14,20,0.9));
  box-shadow: inset 0 0 0 1px var(--kb-line);
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 0.55em), calc(100% - 0.55em) 100%, 0 100%);
  transition: transform 0.13s cubic-bezier(.2,1.3,.4,1), background 0.13s ease, box-shadow 0.13s ease;
}
.kbs-tile::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 0.18em;
  background: var(--kbs-c);
  opacity: 0.85;
}
.kbs-tile::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(100deg, var(--kbs-c) -30%, transparent 46%);
  opacity: 0.1;
  transition: opacity 0.13s ease;
}
.kbs-tile-no {
  position: absolute; right: 0.45em; top: 0.2em;
  font-family: var(--kb-font-mono); font-size: 0.5em;
  color: var(--kb-text-faint); letter-spacing: 0.08em;
}
.kbs-sil {
  position: relative;
  width: 100%; height: 100%; max-height: 4.6em;
  overflow: visible;
}
/* Portrait frame. Sized from the same variable the old silhouette used so the
   rack's row height is unchanged. The monogram sits underneath and is simply
   covered once the render lands, which means no layout shift and no empty box
   during the idle-time capture. */
.kbs-por {
  position: relative; display: grid; place-items: center;
  height: var(--kbs-sil-h, 2.4em); aspect-ratio: 3 / 4;
  border-radius: 3px; overflow: hidden;
  background:
    radial-gradient(115% 90% at 50% 18%, color-mix(in srgb, var(--kbs-c) 22%, transparent), transparent 68%),
    linear-gradient(180deg, rgba(18,26,40,.92), rgba(8,12,20,.96));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kbs-c) 30%, transparent);
}
.kbs-por-mono {
  font: 700 1.35em/1 var(--kb-font-display, inherit);
  color: color-mix(in srgb, var(--kbs-c) 70%, #dbeaff);
  opacity: .55; letter-spacing: .02em; transition: opacity .28s ease;
}
.kbs-por img {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover; object-position: 50% 22%;
  opacity: 0; transition: opacity .32s ease;
}
.kbs-por--on img { opacity: 1; }
.kbs-por--on .kbs-por-mono { opacity: 0; }

.kbs-sil-back { fill: var(--kbs-c); opacity: 0.35; }
.kbs-sil-body { fill: #cfd8e6; opacity: 0.62; }
.kbs-sil-accent { fill: var(--kbs-e); opacity: 0.95; }
.kbs-tile-text { position: relative; min-width: 0; }
.kbs-tile-name {
  font-size: 0.88em; font-weight: 900; letter-spacing: 0.05em; color: var(--kb-text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: color 0.13s ease;
}
.kbs-tile-arch {
  font-size: 0.54em; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--kbs-c);
  opacity: 0.85;
}
.kbs-tile-frame {
  margin-top: 0.35em;
  font-family: var(--kb-font-mono);
  font-size: 0.48em; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--kb-text-faint);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kbs-spark {
  position: absolute; right: 0.55em; bottom: 0.55em;
  display: flex; align-items: flex-end; gap: 0.14em;
  height: 1.3em;
}
.kbs-spark-b {
  display: block; width: 0.24em; height: 100%;
  background: linear-gradient(180deg, var(--kbs-c), var(--kb-grey-dim));
  transform: scaleY(var(--v, 0.4));
  transform-origin: bottom center;
  opacity: 0.55;
  transition: opacity 0.13s ease;
}
.kbs-tile-lock {
  position: absolute; right: 0.5em; top: 50%;
  transform: translate(0.6em, -50%) scale(0.9);
  font-size: 0.5em; font-weight: 900; letter-spacing: 0.2em;
  color: var(--kb-good);
  opacity: 0; pointer-events: none;
  transition: opacity 0.16s ease, transform 0.16s cubic-bezier(.2,1.4,.4,1);
}

.kbs-tile:hover, .kbs-tile--focus {
  transform: translate3d(0.3em, 0, 0);
  background: linear-gradient(100deg, rgba(30,38,52,0.96), rgba(14,18,26,0.92));
}
.kbs-tile--focus::after { opacity: 0.26; }
.kbs-tile--focus .kbs-tile-name { color: var(--kb-text); }
.kbs-tile--focus .kbs-sil-body { opacity: 0.95; fill: #eef4ff; }
.kbs-tile--focus .kbs-spark-b { opacity: 1; }
/* The screen's own highlight is the carriage, driven identically by mouse and
   arrow keys. This is only for a player who tabs in with the browser's focus
   ring, so that never lands on an invisible control. */
.kbs-tile:focus-visible, .kbs-back:focus-visible {
  outline: 2px solid var(--kb-cyan);
  outline-offset: 2px;
}
.kbs-tile--picked { box-shadow: inset 0 0 0 1px rgba(51,255,180,0.55); }
.kbs-tile--picked .kbs-tile-lock { opacity: 1; transform: translate(0, -50%) scale(1); }
.kbs-tile--picked .kbs-spark { opacity: 0; }

/* -- live preview window ----------------------------------------------------- */
.kbs-stage { grid-area: stage; position: relative; pointer-events: none; }
.kbs-bracket {
  position: absolute; width: 1.5em; height: 1.5em;
  border: 2px solid var(--kbs-c);
  opacity: 0.55;
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(.2,1.3,.4,1);
}
.kbs-bracket--tl { left: 0; top: 0; border-right: 0; border-bottom: 0; }
.kbs-bracket--tr { right: 0; top: 0; border-left: 0; border-bottom: 0; }
.kbs-bracket--bl { left: 0; bottom: 0; border-right: 0; border-top: 0; }
.kbs-bracket--br { right: 0; bottom: 0; border-left: 0; border-top: 0; }
.kbs-stage-tag {
  position: absolute; left: 0; top: 2.1em;
  font-family: var(--kb-font-mono); font-size: 0.5em;
  letter-spacing: 0.24em; color: var(--kb-text-faint);
}
.kbs-stage-tag b { color: var(--kb-danger); }
.kbs-sweep {
  position: absolute; inset: 0; overflow: hidden; opacity: 0;
}
.kbs-sweep::before {
  content: ''; position: absolute; left: -30%; top: 0; bottom: 0; width: 30%;
  background: linear-gradient(90deg, transparent, var(--kbs-glow), transparent);
}
.kbs-sweep--go { animation: kbsSweep 0.42s ease-out; }
@keyframes kbsSweep {
  0% { opacity: 0.9; }
  100% { opacity: 0; }
}
.kbs-sweep--go::before { animation: kbsSweepX 0.42s cubic-bezier(.3,.7,.3,1); }
@keyframes kbsSweepX { from { transform: translateX(0); } to { transform: translateX(440%); } }
.kbs-stage-fallback {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  font-family: var(--kb-font-mono); font-size: 0.6em; letter-spacing: 0.3em;
  color: var(--kb-text-faint); display: none;
}
.kbs-stage--offline .kbs-stage-fallback { display: block; }

/* -- dossier ----------------------------------------------------------------- */
.kbs-doss { grid-area: doss; min-height: 0; display: flex; flex-direction: column; }
.kbs-card {
  position: relative;
  /* Sizes to its content and shrinks rather than stretching: a card padded out
     to 2000px of empty panel on a 4K screen reads as a layout bug. */
  flex: 0 1 auto; min-height: 0; max-height: 100%;
  display: flex; flex-direction: column; gap: 0.62em;
  padding: 1em 1.1em 1.2em;
  background: linear-gradient(160deg, rgba(19,24,34,0.93), rgba(9,12,18,0.9));
  box-shadow: inset 0 0 0 1px var(--kb-line), 0 0.7em 2.4em rgba(0,0,0,0.55);
  clip-path: polygon(0 0, 100% 0, 100% 100%, 1.1em 100%, 0 calc(100% - 1.1em));
  overflow: hidden;
}
.kbs-card::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px;
  background: linear-gradient(90deg, var(--kbs-c), transparent 70%);
}
.kbs-card--cut { animation: kbsCut 0.34s cubic-bezier(.16,1,.3,1); }
@keyframes kbsCut {
  0% { transform: translate3d(0.5em,0,0); opacity: 0.25; }
  100% { transform: none; opacity: 1; }
}

.kbs-arch { display: flex; align-items: baseline; gap: 0.6em; flex-wrap: wrap; }
.kbs-arch-tag {
  font-size: 0.55em; font-weight: 900; letter-spacing: 0.2em; text-transform: uppercase;
  color: #06080c; background: var(--kbs-c);
  padding: 0.35em 0.7em 0.28em;
  clip-path: polygon(0.4em 0, 100% 0, calc(100% - 0.4em) 100%, 0 100%);
}
.kbs-arch-note { font-size: 0.54em; line-height: 1.4; color: var(--kb-text-faint); flex: 1; min-width: 8em; }

/* .kb-text sizes itself as height:1em with a width in em, so the cap height is
   the font-size — set that, never the height, or the glyphs stretch. */
.kbs-name.kb-text {
  font-size: 1.75em;
  --kb-ink-a: #ffffff;
  --kb-ink-b: #6a727f;
  filter: drop-shadow(0 0 0.35em rgba(0,0,0,0.7));
  margin: 0.14em 0 0.1em;
}
.kbs-sub {
  font-size: 0.62em; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--kbs-c);
}

.kbs-stats { display: flex; flex-direction: column; gap: 0.26em; margin-top: 0.2em; }
.kbs-stat { display: flex; align-items: center; gap: 0.55em; font-size: 0.56em; }
.kbs-stat-label {
  width: 5.6em; flex-shrink: 0;
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--kb-text-faint);
}
.kbs-stat-track {
  position: relative; flex: 1; height: 0.85em;
  background: #070a10;
  box-shadow: inset 0 0 0 1px var(--kb-line);
  overflow: hidden;
}
.kbs-stat-fill {
  position: absolute; inset: 0;
  background: var(--kbs-c);
  background: linear-gradient(90deg, color-mix(in srgb, var(--kbs-c) 45%, #101722), var(--kbs-c));
  transform: scaleX(0); transform-origin: left center;
  transition: transform 0.3s cubic-bezier(.2,.9,.2,1);
  transition-delay: calc(var(--i, 0) * 34ms);
}
.kbs-stat-notch {
  position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), rgba(4,6,10,0.85) calc(10% - 1px) 10%);
}
.kbs-stat-avg {
  position: absolute; top: -0.14em; bottom: -0.14em; width: 1px;
  background: var(--kb-text-dim);
  opacity: 0.75;
}
.kbs-stat-num {
  width: 1.6em; text-align: right; flex-shrink: 0;
  font-family: var(--kb-font-mono); font-weight: 700; color: var(--kb-text);
}

.kbs-spec {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0.3em 0.8em;
  margin-top: 0.3em;
  font-size: 0.54em;
}
.kbs-spec-cell {
  display: flex; justify-content: space-between; gap: 0.6em;
  padding-bottom: 0.24em;
  border-bottom: 1px solid var(--kb-line);
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--kb-text-faint);
}
.kbs-spec-cell b { color: var(--kb-text); font-weight: 700; }

.kbs-note {
  font-size: 0.55em; line-height: 1.5; color: var(--kb-text-dim);
  padding-left: 0.7em; border-left: 2px solid var(--kbs-c);
}
.kbs-bio { font-size: 0.56em; line-height: 1.55; color: var(--kb-text-faint); }

.kbs-livery {
  margin-top: auto;
  padding-top: 0.7em;
  border-top: 1px solid var(--kb-line);
  display: flex; align-items: center; gap: 0.9em;
}
.kbs-livery-label {
  font-size: 0.5em; font-weight: 800; letter-spacing: 0.28em; color: var(--kb-text-faint);
}
.kbs-swatches { display: flex; gap: 0.3em; }
.kbs-swatch {
  width: 1.5em; height: 0.65em;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.22);
  clip-path: polygon(22% 0, 100% 0, 78% 100%, 0 100%);
}

/* -- footer ------------------------------------------------------------------ */
/* The footer carries the opponent control now, which is a block rather than a
   line of text, so it wraps rather than crushing the two buttons off the edge.
   The hints take the whole of the first line's slack so the control and the
   buttons stay grouped on the right. */
.kbs-foot {
  grid-area: foot;
  display: flex; align-items: center; justify-content: flex-end;
  flex-wrap: wrap; gap: 0.6em 1.2em;
  border-top: 1px solid var(--kb-line);
  padding-top: 0.7em;
}
.kbs-hints { display: flex; gap: 1.3em; margin-right: auto; }
.kbs-hint {
  display: inline-flex; align-items: center; gap: 0.5em;
  font-size: 0.52em; letter-spacing: 0.18em; color: var(--kb-text-faint);
}
.kbs-hint kbd {
  font-family: var(--kb-font-mono); font-size: 0.92em; letter-spacing: 0.05em;
  color: var(--kb-text-dim);
  padding: 0.2em 0.45em;
  box-shadow: inset 0 0 0 1px var(--kb-line-strong);
}
.kbs-back.mbtn, .kbs-lock.mbtn { width: auto; padding: 0 1.8em; }
/* Both only exist for a hover-less device; the pointer legend above is the
   desktop equivalent and they would only compete with it. */
.kbs-touch-hint, .kbs-lock.mbtn { display: none; }
.kbs-touch-hint { margin-right: auto; }
.kbs-lock.mbtn { color: var(--kb-text); box-shadow: inset 0 0 0 1px rgba(255,138,42,0.55); }

/* Training reuses this whole screen, so the one thing that has to change is the
   badge that says which commit the LOCK IN button is about to make. */
.kbs-screen--training .kbs-chip--p1 {
  background: rgba(51,255,180,0.14); color: var(--kb-good);
  box-shadow: inset 0 0 0 1px rgba(51,255,180,0.42);
}
.kbs-screen--training .kbs-title-b { color: var(--kb-good); }

/* -- the commit beat --------------------------------------------------------- */
.kbs-flash {
  position: absolute; inset: 0; pointer-events: none; opacity: 0;
  background: radial-gradient(70% 55% at 50% 50%, var(--kbs-glow), transparent 70%);
}
.kbs-screen--lock .kbs-flash { animation: kbsFlash 0.3s ease-out; }
@keyframes kbsFlash { 0% { opacity: 0.95; } 100% { opacity: 0; } }
.kbs-screen--lock .kbs-bracket { opacity: 1; }
.kbs-screen--lock .kbs-bracket--tl { transform: translate3d(0.9em, 0.9em, 0); }
.kbs-screen--lock .kbs-bracket--tr { transform: translate3d(-0.9em, 0.9em, 0); }
.kbs-screen--lock .kbs-bracket--bl { transform: translate3d(0.9em, -0.9em, 0); }
.kbs-screen--lock .kbs-bracket--br { transform: translate3d(-0.9em, -0.9em, 0); }
.kbs-screen--lock .kbs-card { animation: kbsLockCard 0.25s ease-out; }
@keyframes kbsLockCard { 0% { transform: translate3d(0,-0.3em,0); } 100% { transform: none; } }

/* ===========================================================================
   Compact layouts
   ---------------------------------------------------------------------------
   The wide grid has hard em minimums on both flanks — 18em + 17em is 35em,
   about 455px at this screen's own font-size — so the centre column is squeezed
   to nothing long before either flank gives up a pixel. Measured on a 390px
   phone: rack 234px, dossier 221px running 120px off the right edge, and the
   live preview window exactly 0px wide. The whole reason this screen exists is
   that middle column, so it is the first thing that has to survive.

   The split is on HEIGHT first, not width, because this is a fighting game and
   the fight is landscape: 844x390 has width to spare and no height at all, and
   a stack is the worst possible answer there.

     short   (max-height: 560px)              three columns kept, compressed
     narrow  (max-width: 760px, and taller)   one column, stacked

   The two conditions are mutually exclusive by construction, so a small
   landscape phone (667x375) gets the short layout and never a stack it has no
   room for. Both keep the middle transparent — the machine is drawn there by
   the game's own renderer and nothing may cover it.
   =========================================================================== */

/* -- short: landscape phones ------------------------------------------------- */
@media (max-height: 560px) {
  /* Height is the scarce axis here, so the type scale comes off vh. */
  .kbs-screen { font-size: clamp(12px, 3.6vh, 16px); }
  .kbs {
    /* Same three columns, but the flanks now shrink with the viewport instead
       of holding an em floor that eats the preview. */
    grid-template-columns: clamp(12.5em, 30vw, 22em) minmax(0, 1fr) clamp(11.5em, 25vw, 20em);
    --kbs-pad-x: clamp(0.8em, 2vw, 1.6em);
    gap: 0.5em 0.9em;
    padding:
      calc(0.6em + var(--kbs-safe-t)) calc(var(--kbs-pad-x) + var(--kbs-safe-r))
      calc(0.5em + var(--kbs-safe-b)) calc(var(--kbs-pad-x) + var(--kbs-safe-l));
  }
  /* Retuned for the narrower flanks: the clear window has moved inward. */
  .kbs-scrim {
    background:
      linear-gradient(180deg, rgba(4,6,10,0.9) 0%, rgba(4,6,10,0.22) 14%, rgba(4,6,10,0) 26%,
                      rgba(4,6,10,0) 66%, rgba(4,6,10,0.5) 88%, rgba(4,6,10,0.95) 100%),
      linear-gradient(90deg, rgba(4,6,10,0.96) 0%, rgba(4,6,10,0.9) 27%, rgba(4,6,10,0.38) 34%,
                      rgba(4,6,10,0.04) 43%, rgba(4,6,10,0) 56%, rgba(4,6,10,0.1) 66%,
                      rgba(4,6,10,0.55) 73%, rgba(4,6,10,0.94) 79%, rgba(4,6,10,0.97) 100%),
      radial-gradient(90% 70% at 48% 46%, rgba(255,138,42,0.06), transparent 62%);
  }
  .kbs-head { padding-bottom: 0.3em; }
  .kbs-title { font-size: 1.15em; }
  .kbs-eyebrow { margin-bottom: 0.3em; }
  /* Rows in px, not em: 44 is a fingertip and the type scale must not be able
     to argue with it. Overflow is a safety valve for a viewport short enough
     that ten of them do not fit — moveCarriage scrolls the focus in. */
  .kbs-grid {
    max-height: none;
    grid-auto-rows: minmax(44px, 1fr);
    gap: 0.3em;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .kbs-grid::-webkit-scrollbar { display: none; }
  .kbs-tile { padding: 0.25em 0.4em 0.25em 0.35em; gap: 0.4em; }
  /* The wide tile lets the silhouette run past the row and relies on the row
     being tall; at 44px it has to fit instead. */
  .kbs-sil { max-height: 100%; }
  .kbs-tile-no { font-size: 0.44em; }
  .kbs-spark { display: none; }
  .kbs-card { padding: 0.7em 0.8em 0.8em; gap: 0.4em; overflow-y: auto; }
  .kbs-name.kb-text { font-size: 1.3em; }
  /* The one block with no fixed height. Everything else in the dossier is a
     number the player is comparing machines on; the flavour text is not. */
  .kbs-bio { display: none; }
  .kbs-stage-tag { top: 1.4em; }
  .kbs-bracket { width: 1.1em; height: 1.1em; }
  .kbs-foot { padding-top: 0.4em; gap: 0.8em; }
  .kbs-hints { gap: 0.9em; }
}

/* -- narrow: portrait phones -------------------------------------------------- */
@media (max-width: 760px) and (min-height: 561px) {
  /* Width is the scarce axis, and 13px flat left the 0.5em readouts at 6px.
     Off vw with a 14px floor they land at 15-16px base on a real phone. */
  .kbs-screen { font-size: clamp(14px, 4.1vw, 19px); }
  /* Four rows, and the dossier is not one of them.
     -----------------------------------------------------------------------
     FightCamera has no vertical framing option: \`#framingPortrait\` sets the
     look point to the subject's mid-height, so the machine is always drawn on
     the vertical centre of the *viewport*. A window that does not contain that
     centre line photographs the wrong part of the body, and the first stacked
     build proved it — on a 390x844 handset the stage band ran y=50..197 while
     the machine's centre was at 422, so the window showed a pair of arms and
     cut the head off entirely.

     The arithmetic then says the dossier cannot have a row of its own. Budget
     at 390x844: 844 less header 27, rack 272, footer 53, four gaps 35 and
     padding 26 leaves 431 for stage plus dossier, and the stage alone needs
     ~375 to reach past the centre line. So the dossier docks *over* the foot
     of the window instead — which is what these screens look like anyway, and
     costs the render nothing, since it covers the shins.

     Done with explicit line placement rather than named areas because two
     children have to share row 3, and a \`grid-template-areas\` cell can only be
     named once. Every child is re-placed here for that reason. */
  .kbs {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(6em, 1fr) auto auto auto;
    grid-template-areas: none;
    --kbs-pad-x: 1.1em;
    gap: 0.55em;
    padding:
      calc(0.9em + var(--kbs-safe-t)) calc(var(--kbs-pad-x) + var(--kbs-safe-r))
      calc(0.7em + var(--kbs-safe-b)) calc(var(--kbs-pad-x) + var(--kbs-safe-l));
  }
  .kbs-head { grid-area: 1 / 1 / 2 / 2; }
  .kbs-stage { grid-area: 2 / 1 / 4 / 2; }
  .kbs-doss { grid-area: 3 / 1 / 4 / 2; justify-content: flex-end; }
  .kbs-rack { grid-area: 4 / 1 / 5 / 2; }
  .kbs-foot { grid-area: 5 / 1 / 6 / 2; }
  /* Stacked, so the veil is stacked too: clear across the band the machine
     stands in, solid under the rack below it. The horizontal gradient of the
     wide layout would darken exactly the wrong thing.

     The stops are percentages and the dock is not: the card's top edge sits at
     37% of a 390x844 screen and 27% of a 360x640 one, so a ramp tuned to the
     tall case left the machine showing through the gaps between the roster
     tiles on the short one. Tuned to the short case instead, which costs the
     tall one a soft falloff across the machine's waist just above the card —
     and that reads as the figure being seated into the panel rather than as
     anything lost. */
  .kbs-scrim {
    background:
      linear-gradient(180deg, rgba(4,6,10,0.94) 0%, rgba(4,6,10,0.34) 6%, rgba(4,6,10,0.03) 13%,
                      rgba(4,6,10,0) 25%, rgba(4,6,10,0.34) 33%, rgba(4,6,10,0.74) 40%,
                      rgba(4,6,10,0.93) 45%, rgba(4,6,10,0.97) 50%, rgba(4,6,10,0.97) 100%),
      radial-gradient(130% 34% at 50% 22%, rgba(255,138,42,0.07), transparent 68%);
  }
  .kbs-head { padding-bottom: 0.4em; }
  .kbs-title { font-size: 1.2em; }
  .kbs-head-count { display: none; }
  /* The rack is full width now, so two columns are wide tiles rather than the
     squeezed pair the wide layout's flank produced. What it is not allowed to
     be is tall: five rows at the wide layout's tile height came to 358px of the
     844 available and that is the budget the preview needs, so the silhouette —
     which is what sets the row height — is capped well under it. \`overflow-y\`
     is the valve for a viewport short enough that even these do not fit; a
     390x640 handset scrolls rather than running the last rank off the screen
     and under the footer, which is what it did before. */
  .kbs-grid {
    max-height: none;
    grid-auto-rows: minmax(46px, auto);
    gap: 0.35em;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }
  .kbs-grid::-webkit-scrollbar { display: none; }
  .kbs-tile { padding: 0.24em 0.5em 0.24em 0.4em; }
  .kbs-sil { max-height: 2.4em; }
  .kbs-tile-frame { display: none; }
  /* Sized to its content in the wide layout; here it is the docked panel over
     the foot of the preview, so it is trimmed to the readout the player is
     actually comparing machines on and its own eyebrow goes — the card leads
     with the name, and a second label printed across the machine's knees is
     noise. */
  .kbs-doss .kbs-eyebrow { display: none; }
  .kbs-card {
    padding: 0.6em 0.75em 0.7em;
    gap: 0.3em;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0.9em 100%, 0 calc(100% - 0.9em));
  }
  .kbs-name.kb-text { font-size: 1.25em; margin: 0.06em 0 0.04em; }
  .kbs-arch-note, .kbs-note, .kbs-bio, .kbs-livery { display: none; }
  .kbs-stats { gap: 0.16em; }
  .kbs-stat-track { height: 0.7em; }
  .kbs-spec { grid-template-columns: 1fr 1fr; gap: 0.2em 0.7em; }
  /* Full-bleed stage, so the corner marks and the feed tag would sit against
     the screen edge. Inset them instead of losing them. */
  .kbs-bracket { width: 1.2em; height: 1.2em; }
  .kbs-stage-tag { top: 0.4em; left: 0.2em; }
  .kbs-foot { padding-top: 0.5em; gap: 0.4em 0.7em; }
}

/* -- narrow and short: the stacked layout's tightest case ---------------------- */
/* A 360x640 handset, and any phone whose browser chrome is eating the viewport.
   The rack and footer cost the same there as on a tall screen, so the whole
   squeeze lands on the preview: measured at 640 the docked card was 173px of a
   270px window, 64% of it, and the machine's head fell outside the visible band
   altogether. The spec grid is the block to give up, because the roster tile
   already carries chassis and mass — nothing is lost that is not on screen
   twice. Trimming the card does not shrink the window, it moves the dock down:
   row 3 is the card and row 2 takes back every pixel it releases. */
@media (max-width: 760px) and (min-height: 561px) and (max-height: 720px) {
  .kbs-spec, .kbs-sub { display: none; }
  .kbs-name.kb-text { font-size: 1.08em; }
  .kbs-card { padding: 0.5em 0.7em 0.6em; }
}

/* -- touch: no hover to browse with ------------------------------------------- */
/* Keyed on the input device, not the viewport: a small window on a desktop
   still has a mouse, and a large tablet still has none. */
@media (hover: none) {
  .kbs-hints { display: none; }
  .kbs-touch-hint {
    display: block;
    font-size: 0.5em; letter-spacing: 0.16em; color: var(--kb-text-faint);
    text-transform: uppercase;
  }
  .kbs-lock.mbtn { display: flex; }
  /* 44px is the floor for anything a finger has to land on. The em scale can
     fall below it on a small phone, so these are pinned in px. */
  .kbs-tile { min-height: 44px; }
  .kbs-back.mbtn, .kbs-lock.mbtn { min-height: 44px; padding: 0 1.3em; }
  /* Nothing here has a hover state worth keeping — on touch it latches on the
     last tile tapped and reads as a second, wrong highlight next to the
     carriage. */
  .kbs-tile:hover { transform: none; background: linear-gradient(100deg, rgba(18,23,32,0.94), rgba(11,14,20,0.9)); }
  .kbs-tile--focus:hover { transform: translate3d(0.3em, 0, 0); background: linear-gradient(100deg, rgba(30,38,52,0.96), rgba(14,18,26,0.92)); }
}

@media (prefers-reduced-motion: reduce) {
  .kbs-screen *, .kbs-screen *::before, .kbs-screen *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;

/**
 * Difficulty stepper, training toggles and the practice overlay.
 *
 * Same rules as the sheet above: `kbg-` prefixed so it cannot collide with
 * `ui.css` or with `kbt-` (TouchControls); reads the shared `--kb-*` tokens and
 * defines no globals; every transition on `transform`/`opacity` only, and no
 * `mix-blend-mode` anywhere — the compositing cost of one full-screen blended
 * layer was measured at ~25 ms/frame on the old select screen and none of this
 * is worth a fraction of that.
 */
const KBG_CSS = `
/* =========================================================================
   Stepper — the difficulty / dummy control
   ========================================================================= */
.kbg-step {
  position: relative;
  display: flex; flex-direction: column; gap: 0.4em;
  padding: 0.6em 0.75em 0.65em;
  background: linear-gradient(150deg, rgba(19,24,34,0.92), rgba(9,12,18,0.88));
  box-shadow: inset 0 0 0 1px var(--kb-line);
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 0.6em), calc(100% - 0.6em) 100%, 0 100%);
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
/* Set per band from #paintDifficulty; this is the floor if nothing has. */
.kbg-step { --kbg-hot: var(--kb-accent); }
.kbg-step::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 0.16em;
  background: var(--kbg-hot);
  transform: scaleY(0.35); transform-origin: top center;
  transition: transform 0.18s ease;
}
.kbg-step--focus, .kbg-step:hover { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--kbg-hot) 55%, transparent), 0 0 1.3em rgba(0,0,0,0.5); }
.kbg-step--focus::before { transform: scaleY(1); }

/* Both hold one line: "PRACTICE DUMMY" wrapping to two and "02 / 10" splitting
   across them was what a 390px footer did to this row before. */
.kbg-step-top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.8em; }
.kbg-step-label {
  min-width: 0;
  font-size: 0.5em; font-weight: 800; letter-spacing: 0.28em;
  color: var(--kb-text-faint); text-transform: uppercase;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kbg-step-tag {
  flex: 0 0 auto;
  font-family: var(--kb-font-mono); font-size: 0.5em; letter-spacing: 0.14em;
  color: var(--kb-text-dim);
  white-space: nowrap;
}

.kbg-step-row { display: flex; align-items: center; gap: 0.5em; }
/* The two signs are drawn, not typeset — see #buildStepper. \`currentColor\` on
   the bars means the hover and focus states are still one colour change. */
.kbg-step-btn {
  position: relative;
  flex: 0 0 auto;
  width: 1.7em; height: 1.7em;
  color: var(--kb-text-dim);
  background: rgba(255,255,255,0.07);
  /* One chamfered corner rather than a full parallelogram: an inset box-shadow
     is clipped along with the box, so cutting both ends leaves the outline as
     two floating dashes and the control stops reading as a button at all. This
     is the same single-cut shape the roster tiles use, and three of its four
     edges survive to draw the border. */
  box-shadow: inset 0 0 0 1px var(--kb-line-strong);
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 0.4em), calc(100% - 0.4em) 100%, 0 100%);
  transition: color 0.12s ease, background 0.12s ease;
}
.kbg-step-btn::before, .kbg-step-btn::after {
  content: ''; position: absolute; left: 50%; top: 50%;
  background: currentColor;
  transform: translate(-50%, -50%);
}
.kbg-step-btn::before { width: 0.72em; height: 0.11em; }
.kbg-step-btn--minus::after { display: none; }
.kbg-step-btn--plus::after { width: 0.11em; height: 0.72em; }
.kbg-step-btn:hover { color: var(--kb-text); background: rgba(255,138,42,0.18); }
.kbg-step-btn:active { transform: scale(0.94); }
.kbg-step-btn:focus-visible { outline: 2px solid var(--kb-cyan); outline-offset: 2px; }

.kbg-step-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.3em; }
.kbg-step-value {
  font-family: var(--kb-font-display);
  font-size: 0.92em; font-weight: 900; letter-spacing: 0.1em;
  color: var(--kb-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kbg-step-gauge { display: flex; gap: 0.16em; height: 0.36em; }
.kbg-notch {
  flex: 1; display: block;
  background: #0a0e15;
  box-shadow: inset 0 0 0 1px var(--kb-line);
  transition: background 0.14s ease;
}
.kbg-notch--on { background: var(--kbg-hot); box-shadow: none; }

.kbg-step-text { display: flex; flex-direction: column; gap: 0.3em; min-width: 0; }
.kbg-step-note {
  font-size: 0.54em; line-height: 1.45; color: var(--kb-text-dim);
}
.kbg-step-meta { display: flex; flex-wrap: wrap; gap: 0.25em 0.9em; }
.kbg-meta-cell {
  display: inline-flex; align-items: baseline; gap: 0.4em;
  font-size: 0.46em; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--kb-text-faint);
}
.kbg-meta-cell b { font-family: var(--kb-font-mono); letter-spacing: 0.04em; color: var(--kb-text); }

/* In the select footer the control sits between the hints and the two buttons
   and every pixel of its height comes out of the live preview above it, so the
   two consequence lines move into a second column and the block is three lines
   tall instead of five. In the options and pause panels there is no such
   pressure and it stacks. */
.kbg-step--foot {
  flex: 0 1 34em; min-width: 17em; font-size: 1em;
  display: grid;
  grid-template-columns: minmax(9em, 1fr) minmax(0, 1.15fr);
  grid-template-areas: "top text" "row text";
  align-items: center;
  column-gap: 1.1em; row-gap: 0.25em;
}
.kbg-step--foot .kbg-step-top { grid-area: top; }
.kbg-step--foot .kbg-step-row { grid-area: row; }
.kbg-step--foot .kbg-step-text { grid-area: text; }
.kbg-step--panel { width: 100%; font-size: 0.95em; }

/* =========================================================================
   Training toggles — pause menu
   ========================================================================= */
.kbg-toggles { display: flex; flex-direction: column; gap: 0.35em; width: 100%; }
.kbg-toggle {
  display: flex; align-items: center; justify-content: space-between; gap: 1em;
  width: 100%; min-height: 2.4em;
  padding: 0.4em 0.8em;
  text-align: left;
  background: rgba(255,255,255,0.028);
  box-shadow: inset 0 0 0 1px var(--kb-line);
  clip-path: polygon(0.7em 0, 100% 0, calc(100% - 0.7em) 100%, 0 100%);
  transition: background 0.14s ease, box-shadow 0.14s ease, transform 0.14s ease;
}
.kbg-toggle-text { display: flex; flex-direction: column; gap: 0.1em; min-width: 0; }
.kbg-toggle-text b {
  font-size: 0.6em; font-weight: 800; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--kb-text-dim);
}
.kbg-toggle-text i {
  font-style: normal; font-size: 0.48em; letter-spacing: 0.1em;
  color: var(--kb-text-faint);
}
.kbg-toggle-sw {
  position: relative; flex: 0 0 auto;
  width: 2.4em; height: 1.1em;
  background: #080b12;
  box-shadow: inset 0 0 0 1px var(--kb-line-strong);
  clip-path: polygon(0.3em 0, 100% 0, calc(100% - 0.3em) 100%, 0 100%);
}
.kbg-toggle-sw::after {
  content: ''; position: absolute; left: 0.14em; top: 0.14em;
  width: 0.95em; height: calc(100% - 0.28em);
  background: var(--kb-grey-dim);
  transition: transform 0.16s cubic-bezier(.2,1.3,.4,1), background 0.16s ease;
}
.kbg-toggle--on { background: rgba(51,255,180,0.08); box-shadow: inset 0 0 0 1px rgba(51,255,180,0.34); }
.kbg-toggle--on .kbg-toggle-text b { color: var(--kb-text); }
.kbg-toggle--on .kbg-toggle-sw::after { transform: translateX(1.2em); background: var(--kb-good); }
.kbg-toggle--focus, .kbg-toggle:hover { transform: translateX(0.2em); box-shadow: inset 0 0 0 1px rgba(255,138,42,0.5); }
.kbg-toggle:focus-visible { outline: 2px solid var(--kb-cyan); outline-offset: 2px; }

.pause-body { display: flex; flex-direction: column; gap: 0.6em; width: 100%; }
.pause-body--hidden { display: none; }
.pause-mode {
  font-size: 0.55em; font-weight: 800; letter-spacing: 0.3em;
  color: var(--kb-good);
  text-align: center;
  display: none;
}
.pause-mode--on { display: block; }

/* Rides the right edge of the TRAINING row, inside the button's own flex line. */
.title-nav-note {
  margin-left: auto; padding-left: 2em;
  font-size: 0.6em; font-weight: 600; letter-spacing: 0.16em;
  color: var(--kb-text-faint);
  pointer-events: none;
}
.mbtn--focus .title-nav-note, .mbtn:hover .title-nav-note { color: var(--kb-text-dim); }

/* =========================================================================
   Practice overlay
   -------------------------------------------------------------------------
   z-index 39: above .hud, below .kbt-root (40) and below .kbs-layer (41), so
   pausing covers it and the thumb stick always wins a tap. The whole layer is
   pointer-events: none — every control it has lives in the pause menu.

   Its font-size deliberately matches \`.hud\`'s clamp rather than \`.menu-root\`'s,
   because the banner is placed in em under the timer frame and the two have to
   agree on what an em is.
   ========================================================================= */
.kbg-root {
  position: absolute; inset: 0;
  z-index: 39;
  pointer-events: none;
  font-size: clamp(11px, 1.05vw, 21px);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease;
}
.kbg-root--on { opacity: 1; visibility: visible; }

.kbg-boxes { position: absolute; inset: 0; width: 100%; height: 100%; display: none; }
.kbg-boxes--on { display: block; }
.kbg-box { stroke-linecap: round; fill: none; }
/* Hurt volumes read as the body's own outline and must not fight the machine
   for attention; the hit volume is the thing being studied, so it is the only
   opaque colour on screen. */
.kbg-box--hurt1 { stroke: rgba(79,210,255,0.30); }
.kbg-box--hurt2 { stroke: rgba(255,95,109,0.30); }
.kbg-box--hit { stroke: rgba(255,72,60,0.62); }

/* Bottom centre, not under the timer.
   -------------------------------------------------------------------------
   Measured on a 1920x1080 capture: at 7.5em the badge landed exactly on the
   HUD's own "ROUND 1" caption and both were unreadable. The top of the screen
   belongs to \`HUD.js\`, top to bottom, and the bottom centre is the only strip
   nothing else claims — the touch pad puts its stick bottom-left and its
   buttons bottom-right, and this layer takes no input anyway. */
/* One row, not two. Stacked, the caption sat within a few pixels of the
   viewport's bottom edge on the 1080p capture and was clipped; a single line
   also reads in one glance, which is all a mode badge has to do. */
.kbg-banner {
  position: absolute; bottom: calc(1.5em + var(--kb-sa-b)); left: 50%;
  transform: translateX(-50%);
  display: flex; align-items: center; gap: 0.8em;
  white-space: nowrap;
}
.kbg-banner b {
  font-family: var(--kb-font-display);
  font-size: 0.66em; font-weight: 900; letter-spacing: 0.4em;
  color: var(--kb-good);
  padding: 0.3em 0.55em 0.24em 0.95em;
  background: rgba(51,255,180,0.12);
  box-shadow: inset 0 0 0 1px rgba(51,255,180,0.38);
  clip-path: polygon(0.65em 0, 100% 0, calc(100% - 0.65em) 100%, 0 100%);
}
.kbg-banner span {
  font-family: var(--kb-font-mono);
  font-size: 0.46em; letter-spacing: 0.22em;
  color: var(--kb-text-dim);
}

/* Left flank, not right.
   -------------------------------------------------------------------------
   The dummy stands on the right and the box overlay is drawn on it, so a panel
   over that half hides the one thing the player opened the mode to look at —
   the first capture had the stack across the dummy's head and chest. P1 is on
   the left and is the machine you are driving rather than reading.

   15em down clears \`.combo--p0\`, which is \`top: 8.6em\` and about four em tall
   at its largest tier; a juggle counter fired straight into the frame readout
   would be the same mistake one layer down. */
.kbg-panel {
  position: absolute;
  left: calc(1.1em + var(--kb-sa-l));
  top: calc(15em + var(--kb-sa-t));
  width: 14.5em;
  display: flex; flex-direction: column; gap: 0.5em;
}
.kbg-card {
  padding: 0.55em 0.7em 0.6em;
  background: linear-gradient(160deg, rgba(12,16,24,0.86), rgba(7,10,16,0.82));
  box-shadow: inset 0 0 0 1px var(--kb-line);
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0.7em 100%, 0 calc(100% - 0.7em));
}
.kbg-card--off { display: none; }
.kbg-card-h {
  display: flex; align-items: baseline; justify-content: space-between; gap: 0.6em;
  font-size: 0.46em; font-weight: 800; letter-spacing: 0.3em;
  color: var(--kb-text-faint); text-transform: uppercase;
  padding-bottom: 0.5em; margin-bottom: 0.6em;
  border-bottom: 1px solid var(--kb-line);
}
.kbg-result { letter-spacing: 0.18em; color: var(--kb-text-dim); }
.kbg-result[data-kind='hit'] { color: var(--kb-good); }
.kbg-result[data-kind='counter'] { color: var(--kb-gold); }
.kbg-result[data-kind='block'] { color: var(--kb-cyan); }
.kbg-result[data-kind='whiff'] { color: var(--kb-danger); }

.kbg-mv-name {
  font-family: var(--kb-font-display);
  font-size: 0.7em; font-weight: 900; letter-spacing: 0.06em;
  color: var(--kb-text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kbg-mv-input {
  font-family: var(--kb-font-mono);
  font-size: 0.46em; letter-spacing: 0.12em;
  color: var(--kb-accent);
  margin: 0.15em 0 0.55em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.kbg-fd { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.3em 0.4em; }
.kbg-fd-cell { display: flex; flex-direction: column; gap: 0.1em; min-width: 0; }
.kbg-fd-cell i {
  font-style: normal; font-size: 0.4em; letter-spacing: 0.14em;
  color: var(--kb-text-faint); text-transform: uppercase;
  white-space: nowrap;
}
.kbg-fd-cell b {
  font-family: var(--kb-font-mono); font-size: 0.58em; font-weight: 700;
  color: var(--kb-text);
}
/* The two advantage cells are the reason a frame display exists: plus means
   you keep your turn, and past -10 the whole cast can launch you. */
.kbg-fd-cell[data-sign='plus'] b { color: var(--kb-good); }
.kbg-fd-cell[data-sign='even'] b { color: var(--kb-text-dim); }
.kbg-fd-cell[data-sign='minus'] b { color: var(--kb-gold); }
.kbg-fd-cell[data-sign='bad'] b { color: var(--kb-danger); }

.kbg-hist { display: flex; flex-direction: column; gap: 0.06em; }
.kbg-hist-row {
  display: grid; grid-template-columns: 1em minmax(0, 1fr) auto;
  align-items: center; gap: 0.35em;
  height: 0.78em;
}
.kbg-hist-row--empty { opacity: 0; }
/* Oldest at the top, faded out — the log reads as scrolling away without
   animating anything. */
.kbg-hist-row:nth-child(1) { opacity: 0.3; }
.kbg-hist-row:nth-child(2) { opacity: 0.45; }
.kbg-hist-row:nth-child(3) { opacity: 0.6; }
.kbg-hist-row:nth-child(4) { opacity: 0.75; }
.kbg-hist-row--empty:nth-child(-n+4) { opacity: 0; }
.kbg-hist-dir {
  font-size: 0.7em; line-height: 1; text-align: center;
  color: var(--kb-cyan);
}
.kbg-hist-dir--idle { color: var(--kb-grey-dim); }
.kbg-hist-btns { display: flex; gap: 0.18em; min-width: 0; }
.kbg-btn {
  font-style: normal; font-family: var(--kb-font-mono);
  font-size: 0.38em; font-weight: 700; letter-spacing: 0.06em;
  padding: 0.16em 0.34em 0.1em;
  color: #05070c;
}
.kbg-btn--1, .kbg-btn--2 { background: var(--kb-cyan); }
.kbg-btn--3, .kbg-btn--4 { background: var(--kb-accent); }
.kbg-btn--5 { background: var(--kb-gold); }
.kbg-hist-gap {
  font-family: var(--kb-font-mono); font-size: 0.4em;
  color: var(--kb-text-faint);
}

/* -- compact: landscape phones and short windows ---------------------------- */
/* 390px of height is the whole budget and the frame readout is the thing that
   cannot be got any other way, so the input log — which a player can at least
   feel through their own thumbs — is what goes. The stack still starts below
   the combo counter's footprint. */
/* Type is in px through this whole block, not em.
   -------------------------------------------------------------------------
   \`.hud\`'s clamp bottoms out at 11px on an 844-wide viewport, and this panel's
   labels are 0.4em of that — 4.4px, photographed and unreadable. The em scale
   is right for a desktop where the root is 20px and wrong at the floor, so on
   a handset the small type stops scaling and holds a legible size instead. */
@media (max-height: 560px) {
  .kbg-panel { top: calc(14em + var(--kb-sa-t)); width: 150px; }
  .kbg-banner b { font-size: 11px; letter-spacing: 0.26em; padding: 0.3em 0.5em 0.24em 0.8em; }
  /* The chip alone carries the message at this size; the caption would be 5px. */
  .kbg-banner span { display: none; }
  .kbg-card--inputs { display: none; }
  .kbg-card { padding: 0.5em 0.6em 0.55em; }
  .kbg-card-h { font-size: 9px; letter-spacing: 0.18em; padding-bottom: 0.4em; margin-bottom: 0.45em; }
  .kbg-mv-name { font-size: 13px; }
  .kbg-mv-input { font-size: 9px; letter-spacing: 0.08em; margin-bottom: 0.5em; }
  .kbg-fd { gap: 0.35em 0.4em; }
  .kbg-fd-cell i { font-size: 8px; letter-spacing: 0.08em; }
  .kbg-fd-cell b { font-size: 12px; }
  .kbg-step--foot .kbg-step-label, .kbg-step--foot .kbg-step-tag { font-size: 9px; letter-spacing: 0.16em; }
  .kbg-step--foot .kbg-step-value { font-size: 15px; letter-spacing: 0.06em; }
  .kbg-step--foot .kbg-meta-cell { font-size: 8px; letter-spacing: 0.1em; }
  /* Two lines of consequence text will not fit next to a stepper on a 844px
     row that also carries the hints and two buttons; the band name and the
     ladder are what the control is for, and the note goes. */
  /* Wide enough that the four consequence cells hold one line. Measured on a
     touch 844x390: at 19em they wrapped to two, which added a whole line to the
     footer and took it out of the roster rack below. */
  .kbg-step--foot {
    flex: 0 1 23em; min-width: 15em; font-size: 0.92em;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "top" "row" "text";
    row-gap: 0.2em;
  }
  .kbg-step { padding: 0.4em 0.55em 0.45em; gap: 0.25em; }
  .kbg-step-note { display: none; }
  .kbg-step-meta { gap: 0.15em 0.6em; }
}

/* -- narrow: portrait phones ------------------------------------------------ */
/* Same px floor as the short block, and for the same measured reason: at 390px
   wide \`.hud\` clamps to 11px and every fraction of it disappears. */
@media (max-width: 760px) and (min-height: 561px) {
  /* Docked low rather than high. \`FightCamera\` frames the pair on the vertical
     centre of the viewport, so in portrait the machines sit in a band across
     the middle and the top half is sky — a panel at 15em landed straight on
     them. The floor below is the empty half. */
  .kbg-panel {
    top: auto; bottom: calc(3.6em + var(--kb-sa-b));
    width: min(165px, 48vw);
  }
  .kbg-card-h { font-size: 9px; letter-spacing: 0.18em; }
  .kbg-mv-name { font-size: 13px; }
  .kbg-mv-input { font-size: 9px; letter-spacing: 0.08em; }
  .kbg-fd-cell i { font-size: 8px; letter-spacing: 0.08em; }
  .kbg-fd-cell b { font-size: 12px; }
  .kbg-hist-row { height: 12px; }
  .kbg-hist-dir { font-size: 11px; }
  .kbg-btn { font-size: 7px; }
  .kbg-hist-gap { font-size: 8px; }
  .kbg-banner b { font-size: 11px; letter-spacing: 0.26em; }
  .kbg-banner span { display: none; }
  /* The footer is a wrapping row on a phone; the control takes its own line,
     which also gives the two consequence lines their column back. */
  .kbg-step--foot { flex: 1 1 100%; min-width: 0; font-size: 0.95em; }
  .kbg-step-label, .kbg-step-tag { font-size: 9px; letter-spacing: 0.1em; }
  .kbg-step-value { font-size: 16px; }
  .kbg-step-note { font-size: 10px; }
  .kbg-meta-cell { font-size: 8px; letter-spacing: 0.1em; }
}

/* -- touch: 44px is the floor for anything a finger lands on ---------------- */
@media (hover: none) {
  .kbg-step-btn { min-width: 44px; min-height: 44px; }
  .kbg-toggle { min-height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  .kbg-root *, .kbg-step, .kbg-step *, .kbg-toggle, .kbg-toggle * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
