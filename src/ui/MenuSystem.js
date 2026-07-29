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
import { createSkeleton } from '../characters/Skeleton.js';
import { buildRobot } from '../characters/RobotBuilder.js';
import { applyKbText } from './Typeface.js';

/** Game#phase -> the screen that phase implies. `null` means "hide the menu". */
const SCREEN_FOR_PHASE = {
  boot: null, menu: 'title', select: 'select', intro: null, ready: null,
  fight: null, ko: null, roundEnd: null, matchEnd: 'results', replay: null,
};

const PAUSABLE_PHASES = new Set(['intro', 'ready', 'fight', 'ko', 'roundEnd']);

/** Roster grid shape. Two columns of five reads as a rack of units. */
const GRID_COLS = 2;

/** Stat keys, in the order the dossier lists them. */
const STAT_KEYS = ['power', 'speed', 'reach', 'weight', 'defense'];

// --- live preview tuning -----------------------------------------------------
// Values found by sweeping `FightCamera.cinematic('portrait', …)` against the
// real stage and reading the frames back, not by guessing: `yaw` runs from the
// audience axis toward the subject's front, and only past ~-1.5 rad does the
// camera come round to where the chest and visor read. -1.72 lands a front
// three-quarter against the plain wall of the arena rather than the crowd.
const PREVIEW_YAW = -1.88;
const PREVIEW_DIST = 5.05;
const PREVIEW_HEIGHT = 1.12;
/** Centre mark the previewed machine stands on. Plain object: `Fighter#reset`
 *  only reads x/y/z and this module deliberately does not import three.js. */
const PREVIEW_MARK = { x: 0, y: 0, z: 0 };
/**
 * Where the opponent is parked while the screen is up — its normal right-hand
 * start mark, and pinned there for two reasons.
 *
 * A fighter auto-turns toward its opponent, and `#framingPortrait` swings the
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
    this.root.className = 'menu-root';
    uiRoot.appendChild(this.root);

    this.current = null;
    this.pendingReturn = 'title';
    this.p1Index = 0;
    this.cpuIndex = ROSTER.length > 1 ? 1 : 0;
    this._lastWinner = -1;

    this.settings = {
      quality: game.renderer?.quality || 'ultra',
      master: 80, music: 72, sfx: 88,
    };

    /** @type {{items:Array, index:number, cols:number, gridCount:number}} */
    this.nav = { items: [], index: 0, cols: 1, gridCount: 0 };
    this.screens = {};

    this.#buildTitle();
    this.#buildSelect();
    this.#buildOptions();
    this.#buildPause();
    this.#buildResults();

    this._onKeyDown = (e) => this.#onKeyDown(e);
    window.addEventListener('keydown', this._onKeyDown);

    bus.on('phase', (e) => this.#onPhase(e));
    bus.on('matchEnd', (e) => { this._lastWinner = e.winner; });
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
    if (!screen) { this.nav = { items: [], index: 0, cols: 1, gridCount: 0 }; return; }
    const s = this.screens[screen];
    s.el.classList.add('menu-screen--visible');
    s.onShow?.();
    this.#setNav(s.nav, s.cols || 1, s.gridCount ?? (s.nav.length || 0), s.startIndex?.() ?? 0);
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
      else if (dx) this.nav.index = n + ((t + dx + tail) % tail);
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

  /** Left/Right: adjust the focused control if it has one, else pan the grid. */
  #left(dir) {
    const it = this.nav.items[this.nav.index];
    if (it?.onAdjust) { it.onAdjust(dir); return; }
    if (this.current === 'select') this.#moveGrid(dir, 0);
  }

  #activateFocus() {
    const it = this.nav.items[this.nav.index];
    if (!it?.action) return;
    bus.emit('uiConfirm', {});
    it.action();
  }

  /** Builds a standard angular menu button and registers it as a nav item. */
  #addNavButton(items, label, action, extraClass = '') {
    const btn = document.createElement('button');
    btn.className = `mbtn ${extraClass}`.trim();
    btn.textContent = label;
    const idx = items.length;
    btn.addEventListener('click', () => { this.nav.index = idx; this.#applyFocus(); bus.emit('uiConfirm', {}); action(); });
    btn.addEventListener('mouseenter', () => { this.nav.index = idx; this.#applyFocus(); bus.emit('uiHover', {}); });
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
    nav.appendChild(this.#addNavButton(items, 'ARCADE', () => this.game.setPhase('select')));
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
        robot.dispose();
      } catch { /* a warm-up is an optimisation; it never gets to be a failure */ }
      idle(step);
    };
    idle(step);
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
    headMeta.append(
      el('span', 'kbs-chip kbs-chip--p1', 'PLAYER 1'),
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

      const sil = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sil.setAttribute('class', 'kbs-sil');
      sil.setAttribute('viewBox', '0 0 64 100');
      sil.setAttribute('aria-hidden', 'true');
      sil.innerHTML = silhouetteMarkup(def);

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
        if (this.nav.index === idx) return;
        this.nav.index = idx; this.#applyFocus(); bus.emit('uiHover', {});
      });
      tile.addEventListener('click', () => { this.nav.index = idx; this.#applyFocus(); bus.emit('uiConfirm', {}); this.#confirmSelect(i); });
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
    const opponent = el('div', 'kbs-opponent');
    opponent.append(document.createTextNode('OPPONENT '), el('b', null, 'CPU · RANDOM'));
    const backBtn = this.#addNavButton(items, 'BACK', () => this.game.setPhase('menu'), 'kbs-back');
    foot.append(hints, opponent, backBtn);

    grid.append(head, rack, stage, doss, foot);
    screen.append(scrim, grid, el('div', 'kbs-flash'));
    this.root.appendChild(screen);

    // The carriage is placed in pixels, so it has to be replaced whenever the
    // rack is re-laid out — a window resize, or the type scale crossing a clamp.
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        if (this.current !== 'select') return;
        this.#moveCarriage(this._select.tiles[this._select.focus]);
      }).observe(rackGrid);
    }

    this._select = {
      root: screen, grid, tiles, carriage, stage, sweep, fallback,
      dName, dSub, dArchTag, dArchNote, dBio, dNote, dossCard,
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

  #selectShow() {
    const r = this._select;
    r.locked = false;
    r.focus = -1;
    r.root.classList.remove('kbs-screen--lock');
    for (const t of r.tiles) t.classList.remove('kbs-tile--picked');
    r.tiles[this.p1Index]?.classList.add('kbs-tile--picked');
    this.#previewOpen();
    replayAnim(r.root, 'kbs-screen--enter');
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
    const { carriage } = this._select;
    if (!tile) return;
    carriage.style.transform = `translate3d(${tile.offsetLeft}px, ${tile.offsetTop}px, 0)`;
    carriage.style.width = `${tile.offsetWidth}px`;
    carriage.style.height = `${tile.offsetHeight}px`;
    carriage.style.opacity = '1';
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
   * `#framingPortrait` re-reads it every tick, so writing `yaw` on an object we
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
    if (r.locked) return;
    r.locked = true;

    r.tiles[this.p1Index]?.classList.remove('kbs-tile--picked');
    this.p1Index = i;
    r.tiles[i]?.classList.add('kbs-tile--picked');
    this.cpuIndex = ROSTER.length > 1
      ? (i + 1 + Math.floor(Math.random() * (ROSTER.length - 1))) % ROSTER.length
      : i;

    // The commit beat: brackets slam, the frame flashes, then the match starts.
    // A quarter of a second, deliberately spent — not a stall.
    replayAnim(r.root, 'kbs-screen--lock');
    this._swing = SWAP_SWING * 1.6;
    r.lockTimer = setTimeout(() => {
      r.locked = false;
      this.game.startMatch(this.p1Index, this.cpuIndex);
    }, LOCK_TICKS);
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

    panel.append(title, dispSection, audioSection, ctrlSection, actions);
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
    this.game.renderer?.setQuality?.(tier);
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

  #buildPause() {
    const screen = el('div', 'menu-screen');
    const bg = el('div', 'menu-bg menu-bg--dim');
    const wrap = el('div', 'pause-wrap');
    const panel = el('div', 'pause-panel');
    const title = el('div', 'pause-title', 'PAUSED');

    const items = [];
    const resumeBtn = this.#addNavButton(items, 'RESUME', () => this.#resume());
    const optionsBtn = this.#addNavButton(items, 'OPTIONS', () => this.#openOptions('pause'));
    const quitBtn = this.#addNavButton(items, 'QUIT TO TITLE', () => {
      this.game.paused = false;
      this.game.setPhase('menu');
    });

    panel.append(title, resumeBtn, optionsBtn, quitBtn);
    wrap.appendChild(panel);
    screen.append(bg, wrap);
    this.root.appendChild(screen);
    this.screens.pause = { el: screen, nav: items, cols: 1 };
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
  // Stylesheet
  // -------------------------------------------------------------------------

  /** Injects the select-screen stylesheet once per document. */
  static #installStyles() {
    if (document.getElementById('kbs-style')) return;
    const style = document.createElement('style');
    style.id = 'kbs-style';
    style.textContent = KBS_CSS;
    document.head.appendChild(style);
  }
}

/** Local clamp so this file has no dependency on three.js for one number op. */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
  padding: 1.8em clamp(1.4em, 2.6vw, 3.2em) 1.2em;
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
.kbs-foot {
  grid-area: foot;
  display: flex; align-items: center; justify-content: space-between; gap: 1.4em;
  border-top: 1px solid var(--kb-line);
  padding-top: 0.7em;
}
.kbs-hints { display: flex; gap: 1.3em; }
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
.kbs-opponent {
  font-size: 0.54em; letter-spacing: 0.18em; color: var(--kb-text-faint);
  text-transform: uppercase;
}
.kbs-opponent b { color: var(--kb-text-dim); }
.kbs-back.mbtn { width: auto; padding: 0 1.8em; }

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

@media (prefers-reduced-motion: reduce) {
  .kbs-screen *, .kbs-screen *::before, .kbs-screen *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`;
