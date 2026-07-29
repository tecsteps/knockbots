/**
 * Knockbots — the menu flow: title, character select, options, pause and
 * results.
 *
 * `ui.css` is imported once by `HUD.js`; this module only relies on the
 * class names it defines. Screens are built once in the constructor as
 * plain DOM trees and toggled with a `menu-screen--visible` class — nothing
 * here is re-rendered from a template string, so there is no per-frame (or
 * even per-show) `innerHTML` cost.
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
 */

import { bus } from '../core/Bus.js';
import { ROSTER } from '../characters/roster.js';
import { QUALITY_TIERS } from '../engine/RenderPipeline.js';
import { applyKbText } from './Typeface.js';

/** Game#phase -> the screen that phase implies. `null` means "hide the menu". */
const SCREEN_FOR_PHASE = {
  boot: null, menu: 'title', select: 'select', intro: null, ready: null,
  fight: null, ko: null, roundEnd: null, matchEnd: 'results', replay: null,
};

const PAUSABLE_PHASES = new Set(['intro', 'ready', 'fight', 'ko', 'roundEnd']);
const GRID_COLS = 5;

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

/** Skeleton used for the character-select holo preview: enough joints to
 *  read as a robot silhouette, cheap enough to redraw at 60fps in 2D. */
const PREVIEW_RIG = {
  points: {
    head: [0, 1.72, 0], neck: [0, 1.56, 0], chestTop: [0, 1.4, 0], chestBot: [0, 1.04, 0], hips: [0, 0.94, 0],
    shoulderL: [-0.34, 1.44, 0], shoulderR: [0.34, 1.44, 0],
    elbowL: [-0.46, 1.14, 0.06], elbowR: [0.46, 1.14, 0.06],
    handL: [-0.5, 0.84, 0.12], handR: [0.5, 0.84, 0.12],
    hipL: [-0.19, 0.94, 0], hipR: [0.19, 0.94, 0],
    kneeL: [-0.21, 0.5, 0.04], kneeR: [0.21, 0.5, 0.04],
    footL: [-0.23, 0.04, 0.1], footR: [0.23, 0.04, 0.1],
  },
  bones: [
    ['head', 'neck'], ['neck', 'chestTop'], ['chestTop', 'chestBot'], ['chestBot', 'hips'],
    ['chestTop', 'shoulderL'], ['chestTop', 'shoulderR'],
    ['shoulderL', 'elbowL'], ['elbowL', 'handL'],
    ['shoulderR', 'elbowR'], ['elbowR', 'handR'],
    ['hips', 'hipL'], ['hips', 'hipR'],
    ['hipL', 'kneeL'], ['kneeL', 'footL'],
    ['hipR', 'kneeR'], ['kneeR', 'footR'],
  ],
};

function hexToRgba(hex, alpha) {
  const h = (hex || '#888888').replace('#', '');
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class MenuSystem {
  /**
   * @param {HTMLElement} uiRoot
   * @param {import('../core/Game.js').Game} game
   */
  constructor(uiRoot, game) {
    this.uiRoot = uiRoot;
    this.game = game;

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

    /** @type {{items:Array, index:number, cols:number}} */
    this.nav = { items: [], index: 0, cols: 1 };
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
    if (!screen) { this.nav = { items: [], index: 0, cols: 1 }; return; }
    const s = this.screens[screen];
    s.el.classList.add('menu-screen--visible');
    this.#setNav(s.nav, s.cols || 1);
    s.onShow?.();
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

  #setNav(items, cols) {
    this.nav = { items, index: 0, cols };
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

  #moveGrid(dx, dy) {
    const { items, cols } = this.nav;
    if (!items.length) return;
    const idx = this.nav.index;
    const rows = Math.ceil(items.length / cols);
    let row = Math.floor(idx / cols);
    let col = idx % cols;
    if (dx) col = (col + dx + cols) % cols;
    if (dy) row = (row + dy + rows) % rows;
    let ni = row * cols + col;
    if (ni >= items.length) ni = items.length - 1;
    this.nav.index = ni;
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
    const el = document.createElement('div');
    el.className = 'menu-screen';
    const bg = document.createElement('div');
    bg.className = 'menu-bg';

    const wrap = document.createElement('div');
    wrap.className = 'title-wrap';
    const logo = document.createElement('div');
    logo.className = 'title-logo';
    applyKbText(logo, 'KNOCKBOTS');
    const tagline = document.createElement('div');
    tagline.className = 'title-tagline';
    tagline.textContent = 'Steel Settles Everything';
    const nav = document.createElement('div');
    nav.className = 'title-nav';

    const items = [];
    nav.appendChild(this.#addNavButton(items, 'ARCADE', () => this.game.setPhase('select')));
    nav.appendChild(this.#addNavButton(items, 'OPTIONS', () => this.#openOptions('title')));

    const hint = document.createElement('div');
    hint.className = 'title-hint';
    hint.textContent = 'ENTER TO SELECT · ARROW KEYS TO NAVIGATE';
    const tag = document.createElement('div');
    tag.className = 'build-tag';
    tag.textContent = 'KNOCKBOTS';

    wrap.append(logo, tagline, nav);
    el.append(bg, wrap, hint, tag);
    this.root.appendChild(el);
    this.screens.title = { el, nav: items, cols: 1 };
  }

  // -------------------------------------------------------------------------
  // Character select
  // -------------------------------------------------------------------------

  #buildSelect() {
    const el = document.createElement('div');
    el.className = 'menu-screen';
    const bg = document.createElement('div');
    bg.className = 'menu-bg';

    const wrap = document.createElement('div');
    wrap.className = 'select-wrap';
    const title = document.createElement('div');
    title.className = 'select-title';
    const titleAccent = document.createElement('span');
    titleAccent.textContent = 'MACHINE';
    title.append(document.createTextNode('SELECT YOUR '), titleAccent);

    const body = document.createElement('div');
    body.className = 'select-body';
    const grid = document.createElement('div');
    grid.className = 'roster-grid';

    const items = [];
    const cards = ROSTER.map((def, i) => {
      const card = document.createElement('div');
      card.className = 'roster-card';
      card.style.setProperty('--rc-color', def.palette.accent);
      card.style.setProperty('--rc-glow', hexToRgba(def.palette.emissive, 0.45));
      const letter = document.createElement('div');
      letter.className = 'roster-card-letter';
      letter.textContent = def.name.slice(0, 1);
      const name = document.createElement('div');
      name.className = 'roster-card-name';
      name.textContent = def.name;
      const arch = document.createElement('div');
      arch.className = 'roster-card-arch';
      arch.textContent = def.archetype;
      card.append(letter, name, arch);
      grid.appendChild(card);

      const idx = items.length;
      card.addEventListener('mouseenter', () => { this.nav.index = idx; this.#applyFocus(); bus.emit('uiHover', {}); });
      card.addEventListener('click', () => { this.nav.index = idx; this.#applyFocus(); bus.emit('uiConfirm', {}); this.#confirmSelect(i); });
      items.push({ el: card, action: () => this.#confirmSelect(i), focusClass: 'roster-card--focus', onFocusEnter: () => this.#refreshDetail(i) });
      return card;
    });

    const detail = document.createElement('div');
    detail.className = 'select-detail';
    const preview = document.createElement('div');
    preview.className = 'preview-slot';
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 220;
    preview.appendChild(canvas);

    const dName = document.createElement('div');
    dName.className = 'detail-name';
    const dSub = document.createElement('div');
    dSub.className = 'detail-subtitle';
    const dBio = document.createElement('div');
    dBio.className = 'detail-bio';

    const statBlock = document.createElement('div');
    const statFills = {};
    for (const key of ['power', 'speed', 'reach', 'weight', 'defense']) {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const lab = document.createElement('div');
      lab.className = 'stat-label';
      lab.textContent = key;
      const track = document.createElement('div');
      track.className = 'stat-track';
      const fill = document.createElement('div');
      fill.className = 'stat-fill';
      track.appendChild(fill);
      row.append(lab, track);
      statBlock.appendChild(row);
      statFills[key] = fill;
    }

    const swatchRow = document.createElement('div');
    swatchRow.className = 'swatch-row';
    const swatches = [];
    for (let s = 0; s < 5; s++) {
      const sw = document.createElement('div');
      sw.className = 'swatch';
      swatchRow.appendChild(sw);
      swatches.push(sw);
    }

    detail.append(preview, dName, dSub, dBio, statBlock, swatchRow);
    body.append(grid, detail);

    const footer = document.createElement('div');
    footer.className = 'select-footer';
    const opponentNote = document.createElement('div');
    const opponentTag = document.createElement('b');
    opponentTag.textContent = 'CPU';
    opponentNote.append(document.createTextNode('OPPONENT '), opponentTag);
    const backBtn = this.#addNavButton(items, 'BACK', () => this.game.setPhase('menu'));
    footer.append(opponentNote, backBtn);

    wrap.append(title, body, footer);
    el.append(bg, wrap);
    this.root.appendChild(el);

    this._select = { cards, dName, dSub, dBio, statFills, swatches, canvas, ctx: canvas.getContext('2d'), previewDef: ROSTER[0] };
    this.screens.select = {
      el, nav: items, cols: GRID_COLS,
      onShow: () => { this.#refreshDetail(this.p1Index); this.#startPreview(); },
      onHide: () => this.#stopPreview(),
    };
  }

  #refreshDetail(i) {
    const def = ROSTER[i];
    if (!def) return;
    const r = this._select;
    r.dName.textContent = def.name;
    r.dSub.textContent = def.subtitle;
    r.dBio.textContent = def.bio;
    for (const key in r.statFills) {
      r.statFills[key].style.transform = `scaleX(${(def.stats?.[key] ?? 0) / 10})`;
    }
    const pal = def.palette || {};
    const values = [pal.primary, pal.secondary, pal.accent, pal.emissive, pal.trim];
    r.swatches.forEach((sw, idx) => { sw.style.background = values[idx] || '#333'; });
    r.previewDef = def;
  }

  #confirmSelect(i) {
    this._select.cards[this.p1Index]?.classList.remove('roster-card--picked');
    this.p1Index = i;
    this._select.cards[i]?.classList.add('roster-card--picked');
    this.cpuIndex = ROSTER.length > 1 ? (i + 1 + Math.floor(Math.random() * (ROSTER.length - 1))) % ROSTER.length : i;
    this.game.startMatch(this.p1Index, this.cpuIndex);
  }

  // -- holo preview: a stylised rotating wireframe rig, not a live 3D model --

  #startPreview() {
    if (this._previewRAF) return;
    this._previewT = 0;
    const step = () => {
      this._previewRAF = requestAnimationFrame(step);
      this._previewT += 1 / 60;
      this.#drawPreview();
    };
    this._previewRAF = requestAnimationFrame(step);
  }

  #stopPreview() {
    if (this._previewRAF) cancelAnimationFrame(this._previewRAF);
    this._previewRAF = null;
  }

  #drawPreview() {
    const { ctx, canvas, previewDef } = this._select;
    const w = canvas.width, h = canvas.height;
    const pal = previewDef?.palette || {};
    const lineColor = pal.emissive || '#7fd4ff';
    const jointColor = pal.accent || '#ffffff';

    ctx.fillStyle = 'rgba(4, 6, 10, 0.28)';
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.5, cy = h * 0.92, scaleUnit = h * 0.42;
    const theta = this._previewT * 0.7;
    const ct = Math.cos(theta), st = Math.sin(theta);

    // ground disc
    ctx.save();
    ctx.strokeStyle = hexToRgba(pal.accent || '#7fd4ff', 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, scaleUnit * 0.62, scaleUnit * 0.14, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    const project = ([x, y, z]) => {
      const rx = x * ct - z * st;
      const rz = x * st + z * ct;
      const depth = 1 / (2.4 + rz);
      return [cx + rx * scaleUnit * depth * 1.6, cy - (y - 0.02) * scaleUnit * depth * 1.6];
    };

    ctx.lineCap = 'round';
    ctx.strokeStyle = lineColor;
    ctx.shadowColor = lineColor;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of PREVIEW_RIG.bones) {
      const [ax, ay] = project(PREVIEW_RIG.points[a]);
      const [bx, by] = project(PREVIEW_RIG.points[b]);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();

    ctx.fillStyle = jointColor;
    ctx.shadowBlur = 6;
    for (const key in PREVIEW_RIG.points) {
      const [px, py] = project(PREVIEW_RIG.points[key]);
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // -------------------------------------------------------------------------
  // Options
  // -------------------------------------------------------------------------

  #buildOptions() {
    const el = document.createElement('div');
    el.className = 'menu-screen';
    const bg = document.createElement('div');
    bg.className = 'menu-bg menu-bg--dim';
    const wrap = document.createElement('div');
    wrap.className = 'options-wrap';
    const panel = document.createElement('div');
    panel.className = 'options-panel';
    const title = document.createElement('div');
    title.className = 'options-title';
    title.textContent = 'OPTIONS';

    const items = [];

    // -- display --
    const dispSection = document.createElement('div');
    dispSection.className = 'options-section';
    const dispH = document.createElement('h3');
    dispH.textContent = 'Display';
    const qualRow = document.createElement('div');
    qualRow.className = 'option-row';
    const qualLabel = document.createElement('div');
    qualLabel.className = 'option-row-label';
    qualLabel.textContent = 'Render Quality';
    const tiers = Object.keys(QUALITY_TIERS);
    const segGroup = document.createElement('div');
    segGroup.className = 'seg-group';
    const segBtns = tiers.map((tier) => {
      const b = document.createElement('button');
      b.className = 'seg-btn';
      b.textContent = tier;
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
    const audioSection = document.createElement('div');
    audioSection.className = 'options-section';
    const audioH = document.createElement('h3');
    audioH.textContent = 'Audio';
    const sliders = {};
    for (const [channel, label] of [['master', 'Master Volume'], ['music', 'Music'], ['sfx', 'Effects']]) {
      const { row, setValue } = this.#buildSlider(items, label, this.settings[channel], (v) => this.#setVolume(channel, v));
      audioSection.appendChild(row);
      sliders[channel] = setValue;
    }
    audioSection.prepend(audioH);

    // -- controls (read-only reference) --
    const ctrlSection = document.createElement('div');
    ctrlSection.className = 'options-section';
    const ctrlH = document.createElement('h3');
    ctrlH.textContent = 'Controls';
    const table = document.createElement('div');
    table.className = 'keybind-table';
    for (const [player, rows] of Object.entries(KEYBINDS)) {
      const col = document.createElement('div');
      col.className = 'keybind-col';
      const h4 = document.createElement('h4');
      h4.textContent = player;
      col.appendChild(h4);
      for (const [action, key] of rows) {
        const line = document.createElement('div');
        line.className = 'keybind-line';
        const span = document.createElement('span');
        span.textContent = action;
        const b = document.createElement('b');
        b.textContent = key;
        line.append(span, b);
        col.appendChild(line);
      }
      table.appendChild(col);
    }
    ctrlSection.append(ctrlH, table);

    const actions = document.createElement('div');
    actions.className = 'options-actions';
    actions.appendChild(this.#addNavButton(items, 'BACK', () => this.show(this.pendingReturn)));

    panel.append(title, dispSection, audioSection, ctrlSection, actions);
    wrap.appendChild(panel);
    el.append(bg, wrap);
    this.root.appendChild(el);

    this._options = { segBtns, tiers, sliders };
    this.screens.options = {
      el, nav: items, cols: 1,
      onShow: () => { this.#refreshQualitySeg(); for (const c in sliders) sliders[c](this.settings[c], false); },
    };
  }

  /** Builds one audio slider row and registers it as a nav item with keyboard adjust. */
  #buildSlider(items, label, initial, onChange) {
    const row = document.createElement('div');
    row.className = 'option-row';
    const lab = document.createElement('div');
    lab.className = 'option-row-label';
    lab.textContent = label;
    const wrap = document.createElement('div');
    wrap.className = 'slider-wrap';
    const track = document.createElement('div');
    track.className = 'slider-track';
    const fill = document.createElement('div');
    fill.className = 'slider-fill';
    track.appendChild(fill);
    const valueEl = document.createElement('div');
    valueEl.className = 'slider-value';
    wrap.append(track, valueEl);
    row.append(lab, wrap);
    row.classList.add('option-row--slider');

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
      const r = track.getBoundingClientRect();
      const p = (e.clientX - r.left) / Math.max(1, r.width);
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
    const el = document.createElement('div');
    el.className = 'menu-screen';
    const bg = document.createElement('div');
    bg.className = 'menu-bg menu-bg--dim';
    const wrap = document.createElement('div');
    wrap.className = 'pause-wrap';
    const panel = document.createElement('div');
    panel.className = 'pause-panel';
    const title = document.createElement('div');
    title.className = 'pause-title';
    title.textContent = 'PAUSED';

    const items = [];
    const resumeBtn = this.#addNavButton(items, 'RESUME', () => this.#resume());
    const optionsBtn = this.#addNavButton(items, 'OPTIONS', () => this.#openOptions('pause'));
    const quitBtn = this.#addNavButton(items, 'QUIT TO TITLE', () => {
      this.game.paused = false;
      this.game.setPhase('menu');
    });

    panel.append(title, resumeBtn, optionsBtn, quitBtn);
    wrap.appendChild(panel);
    el.append(bg, wrap);
    this.root.appendChild(el);
    this.screens.pause = { el, nav: items, cols: 1 };
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  #buildResults() {
    const el = document.createElement('div');
    el.className = 'menu-screen';
    const bg = document.createElement('div');
    bg.className = 'menu-bg';
    const wrap = document.createElement('div');
    wrap.className = 'results-wrap';

    const winnerEl = document.createElement('div');
    winnerEl.className = 'results-winner';
    const subEl = document.createElement('div');
    subEl.className = 'results-sub';
    subEl.textContent = 'MATCH COMPLETE';
    const scoreEl = document.createElement('div');
    scoreEl.className = 'results-score';
    const s1 = document.createElement('span');
    const s2 = document.createElement('span');
    scoreEl.append(s1, document.createTextNode(' — '), s2);

    const actions = document.createElement('div');
    actions.className = 'results-actions';
    const items = [];
    actions.appendChild(this.#addNavButton(items, 'REMATCH', () => this.game.startMatch(this.p1Index, this.cpuIndex)));
    actions.appendChild(this.#addNavButton(items, 'CHARACTER SELECT', () => this.game.setPhase('select')));
    actions.appendChild(this.#addNavButton(items, 'MAIN MENU', () => this.game.setPhase('menu')));

    wrap.append(winnerEl, subEl, scoreEl, actions);
    el.append(bg, wrap);
    this.root.appendChild(el);

    this.screens.results = {
      el, nav: items, cols: 1,
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
}

/** Local clamp so this file has no dependency on three.js for one number op. */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
