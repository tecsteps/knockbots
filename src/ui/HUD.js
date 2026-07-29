/**
 * Knockbots — the fight HUD.
 *
 * On screen for the entire match, so it carries as much of the "does this
 * feel AAA" verdict as the 3D scene does. The whole tree is built once in
 * the constructor; `update()` never touches `innerHTML` and only ever
 * writes `transform`/`opacity`/`textContent` on cached node references, per
 * the perf budget in the charter (no layout thrash from a HUD that redraws
 * every frame at 60-144Hz).
 *
 * Three health layers per fighter, matching real fighting-game convention:
 *   - `.hp-fill`  the true, current health — snaps instantly, no easing.
 *   - `.hp-drain` a hot red layer that holds at the pre-hit value for a
 *     short beat (`DRAIN_HOLD_TICKS`, counted in sim ticks — see the note
 *     below) and then eases down to meet `.hp-fill`, pulsing while it bleeds,
 *     so a big hit visibly "bleeds out" rather than just vanishing.
 *   - `.hp-ghost` a grey layer at `(health + recoverable) / max`, i.e. the
 *     ceiling health regenerates back up to. It shrinks smoothly as
 *     `Fighter#recoverable` is spent by time or consumed by more damage.
 * All three are `<div>`s stacked with `transform: scaleX()` from a fixed
 * `transform-origin` (left for P1, right for P2) — never `width`, which
 * would force layout every frame during an ease.
 *
 * Everything else (timer, meter, combo, callouts, announcements) is driven
 * by subscribing to `bus` events once in the constructor rather than
 * polling fighter state for edges, exactly as the charter asks.
 */

import './ui.css';
import * as THREE from 'three';
import { bus } from '../core/Bus.js';
import { MAX_HEALTH, METER_MAX, ROUNDS_TO_WIN, ROUND_TIME_SECONDS, TICK_HZ } from '../core/Constants.js';
import { applyKbText } from './Typeface.js';

// Hold/ease timing below is counted in *simulated ticks*, not real seconds.
// A real-dt hold reads fine at a steady 60fps, but the moment a hit lands is
// exactly the moment the frame is most likely to be expensive (hitstop,
// sparks, screen shake, a camera cut all firing at once) — the render can
// go slow right when the drain/combo readout most needs to be legible, and
// a countdown driven by wall-clock dt then burns through its whole budget in
// a couple of chunky frames before anyone sees it ease (see docs/CRITIC.md's
// 08b-hud-motion capture, which caught exactly this). Ticks advance at a
// fixed 60Hz regardless of render pace, so counting against the fighters'
// own `simTick` keeps the beat the same length in game-time whether the
// frame that tick lands on took 2ms or 200ms to draw.
//
// A hold long enough to read as a deliberate beat, short enough that the
// bleed-down itself still fits inside the window a hit's hitstop/callouts
// hold the eye for — at the old 0.5s-of-real-time the chip gap sat frozen
// for nearly the whole of that window and the ease that followed was over
// almost before it started.
const DRAIN_HOLD_TICKS = 10;
const DRAIN_RATE_PER_TICK = 6.0 / TICK_HZ; // damp lambda, per tick, once the hold expires
const GHOST_RATE_PER_TICK = 3.0 / TICK_HZ;
const CRITICAL_RATIO = 0.22;
const COMBO_HOLD_TICKS = 66; // ~1.1s of game-time with no new hit before the combo readout dismisses
const MAX_CALLOUTS = 24;

const IN_FIGHT_PHASES = new Set(['intro', 'ready', 'fight', 'ko', 'roundEnd']);

/**
 * Fixed camera layer used only for the offscreen portrait pass — high
 * enough that it can never collide with `LAYER.BLOOM_ONLY`/`NO_REFLECT`
 * from `Constants.js`. Tagging a fighter's group with it and pointing a
 * layer-exclusive camera at it is what lets `#capturePortrait` render just
 * that one robot (still fully lit by the real scene lights, which are not
 * layer-gated) with the opponent, stage and background left out of frame.
 */
const PORTRAIT_LAYER = 6;
const PORTRAIT_SIZE = 128;

/** Reusable scratch vector for world -> screen projection. */
const _proj = new THREE.Vector3();

export class HUD {
  /**
   * @param {HTMLElement} uiRoot
   * @param {import('../combat/Fighter.js').Fighter[]} fighters
   */
  constructor(uiRoot, fighters) {
    this.uiRoot = uiRoot;
    this.fighters = fighters;

    this.root = document.createElement('div');
    this.root.className = 'hud hud--hidden';
    uiRoot.appendChild(this.root);

    this.sides = [this.#buildSide(0), this.#buildSide(1)];
    this.#buildTop();
    this.#buildMeters();
    this.#buildCombos();
    this.#buildCallouts();
    this.#buildAnnouncements();

    /** Per-fighter animated health-bar state. `drainHoldUntil` is an
     * absolute `simTick`, not a countdown, so a slow/batched frame can never
     * over-consume it (see the timing note above `DRAIN_HOLD_TICKS`). */
    this.hp = fighters.map(() => ({
      fill: 1, drain: 1, ghost: 1, drainHoldUntil: 0, lastTick: null,
    }));
    this.lastName = [null, null];
    this.lastWins = [-1, -1];

    this.combo = fighters.map(() => ({
      visible: false, hits: 0, shownHits: 0, damage: 0, tag: 'COMBO', holdUntilTick: 0,
    }));

    this.calloutPool = [];
    this.announceQueue = [];
    this.announceBusy = false;

    this.visible = null; // last hud--hidden state written, to avoid redundant class writes
    this.tenseState = null;

    /** Lazily-created offscreen render target + camera for `#capturePortrait`. */
    this.portraitRT = null;
    this.portraitCamera = new THREE.PerspectiveCamera(26, 1, 0.05, 4);
    this.portraitCamera.layers.set(PORTRAIT_LAYER);
    this._portraitPos = new THREE.Vector3();

    this.#wireBus();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  #buildSide(i) {
    const p = i === 0 ? 'p1' : 'p2';
    const block = document.createElement('div');
    block.className = `hp-block hp-block--${p}`;

    // Portrait chip: a live render of the fighter's head (see
    // `#capturePortrait`) over a beveled metal plate, with a monogram
    // fallback shown until that first capture lands.
    const portrait = document.createElement('div');
    portrait.className = 'portrait-chip';
    const portraitCanvas = document.createElement('canvas');
    portraitCanvas.className = 'portrait-canvas';
    portraitCanvas.width = PORTRAIT_SIZE;
    portraitCanvas.height = PORTRAIT_SIZE;
    const portraitFallback = document.createElement('div');
    portraitFallback.className = 'portrait-fallback';
    const portraitMono = document.createElement('span');
    portraitFallback.appendChild(portraitMono);
    portrait.append(portraitCanvas, portraitFallback);

    // The bar is two nested boxes: `.hp-frame` is the outer metal bezel
    // (bevel + keyline + cast shadow, see ui.css), `.hp-inner` is the
    // clipped window the health layers actually scale inside.
    const frame = document.createElement('div');
    frame.className = 'hp-frame';
    const inner = document.createElement('div');
    inner.className = 'hp-inner';
    const ghost = document.createElement('div');
    ghost.className = 'hp-layer hp-ghost';
    const drain = document.createElement('div');
    drain.className = 'hp-layer hp-drain';
    const fill = document.createElement('div');
    fill.className = 'hp-layer hp-fill';
    const sheen = document.createElement('div');
    sheen.className = 'hp-sheen';
    const flash = document.createElement('div');
    flash.className = 'hp-flash';
    inner.append(ghost, drain, fill, sheen, flash);
    frame.appendChild(inner);

    const plate = document.createElement('div');
    plate.className = 'nameplate';
    const name = document.createElement('span');
    name.className = 'nameplate-name';
    applyKbText(name, '');
    const pips = document.createElement('div');
    pips.className = 'pips';
    const pipEls = [];
    for (let r = 0; r < ROUNDS_TO_WIN; r++) {
      const pip = document.createElement('i');
      pip.className = 'pip';
      pips.appendChild(pip);
      pipEls.push(pip);
    }
    plate.append(...(i === 0 ? [name, pips] : [pips, name]));

    block.append(portrait, frame, plate);

    return {
      block, frame, ghost, drain, fill, flash, name, pipEls,
      portrait, portraitCanvas, portraitCtx: portraitCanvas.getContext('2d'), portraitMono,
    };
  }

  #buildTop() {
    const top = document.createElement('div');
    top.className = 'hud-top';
    const timerWrap = document.createElement('div');
    timerWrap.className = 'timer-wrap';
    const timerFrame = document.createElement('div');
    timerFrame.className = 'timer-frame';
    const timerValue = document.createElement('div');
    timerValue.className = 'timer-value';
    applyKbText(timerValue, String(ROUND_TIME_SECONDS));
    timerFrame.appendChild(timerValue);
    const roundLabel = document.createElement('div');
    roundLabel.className = 'round-label';
    roundLabel.textContent = 'ROUND 1';
    timerWrap.append(timerFrame, roundLabel);

    top.append(this.sides[0].block, timerWrap, this.sides[1].block);
    this.root.appendChild(top);

    this.timerFrame = timerFrame;
    this.timerValue = timerValue;
    this.roundLabel = roundLabel;
    this.lastTimerText = timerValue.textContent;
    this.lastRoundText = roundLabel.textContent;
  }

  /**
   * Both meter blocks are built with *identical* DOM order — label, then
   * bar, into fixed named grid rows — so there is no per-player branch left
   * to drift out of sync. `.meter-block--p2` alone carries `transform:
   * scaleX(-1)` in CSS, which mirrors the whole assembly (bar geometry,
   * clip-path cut, fill growth direction) for free; the label's own text
   * gets an equal, opposite `scaleX(-1)` so the glyphs still read left to
   * right. The result is a true reflection, not two hand-tuned mirrors that
   * can quietly stop matching each other.
   */
  #buildMeters() {
    const wrap = document.createElement('div');
    wrap.className = 'meter-wrap';
    this.meters = [0, 1].map((i) => {
      const p = i === 0 ? 'p1' : 'p2';
      const block = document.createElement('div');
      block.className = `meter-block meter-block--${p}`;
      const label = document.createElement('div');
      label.className = 'meter-label';
      label.textContent = 'OVERDRIVE';
      const frame = document.createElement('div');
      frame.className = 'meter-frame';
      const fill = document.createElement('div');
      fill.className = 'meter-fill';
      const ticks = document.createElement('div');
      ticks.className = 'meter-ticks';
      frame.append(fill, ticks);
      block.append(label, frame);
      wrap.appendChild(block);
      return { block, frame, fill, label };
    });
    this.root.appendChild(wrap);
  }

  #buildCombos() {
    this.comboEls = [0, 1].map((i) => {
      const el = document.createElement('div');
      el.className = `combo combo--p${i}`;
      const hits = document.createElement('div');
      hits.className = 'combo-hits';
      applyKbText(hits, '0');
      const tag = document.createElement('div');
      tag.className = 'combo-tag';
      tag.dataset.tag = 'COMBO';
      tag.textContent = 'COMBO';
      const dmg = document.createElement('div');
      dmg.className = 'combo-dmg';
      dmg.textContent = '0 DMG';
      el.append(hits, tag, dmg);
      this.root.appendChild(el);
      return { el, hits, tag, dmg };
    });
  }

  #buildCallouts() {
    const layer = document.createElement('div');
    layer.className = 'callouts-layer';
    this.root.appendChild(layer);
    this.calloutLayer = layer;
  }

  /**
   * The announcement layer is deliberately appended to `uiRoot` — a sibling
   * of `this.root`, not a child of it — so it never inherits `.hud`'s
   * visibility fade. "FIGHT"/"K.O."/etc. fire in lockstep with the HUD
   * becoming visible (see `#onPhase`), and if the banner shared that 0.4s
   * opacity transition its own fly-in would render at partial opacity,
   * reading as washed-out instead of a crisp foreground overlay. Appending
   * it after `this.root` keeps it painting on top with no z-index needed.
   *
   * There is no backing plate. Legibility comes from the letterforms
   * themselves — `.announce-text` layers the same shadow/body/gloss stack
   * every `kb-text` uses, plus a hard silhouette outline (see ui.css) — so
   * the word reads as lit cast metal hanging in front of the fight, not a
   * rectangle with text stamped on it.
   */
  #buildAnnouncements() {
    const layer = document.createElement('div');
    layer.className = 'announce-layer';
    const banner = document.createElement('div');
    banner.className = 'announce-banner';
    const inner = document.createElement('div');
    inner.className = 'announce-inner';
    const text = document.createElement('div');
    text.className = 'announce-text';
    inner.appendChild(text);
    banner.appendChild(inner);
    layer.appendChild(banner);
    this.uiRoot.appendChild(layer);
    this.announceBanner = banner;
    this.announceText = text;
    banner.addEventListener('animationend', () => this.#advanceAnnounceQueue());
  }

  // -------------------------------------------------------------------------
  // Bus wiring — event-driven, not polled
  // -------------------------------------------------------------------------

  #wireBus() {
    bus.on('hit', (e) => this.#onHit(e));
    bus.on('block', (e) => this.#onBlock(e));
    bus.on('comboEnd', (e) => this.#onComboEnd(e));
    bus.on('roundStart', (e) => this.#queueAnnounce('round', `ROUND ${e.round}`));
    bus.on('roundEnd', (e) => this.#onRoundEnd(e));
    bus.on('phase', (e) => this.#onPhase(e));
    bus.on('meterFull', (e) => this.#onMeterFull(e.fighter.index));
  }

  #onMeterFull(i) {
    const el = this.meters[i]?.frame;
    if (!el) return;
    el.classList.remove('meter--burst');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('meter--burst');
  }

  #onPhase({ phase }) {
    if (phase === 'fight') this.#queueAnnounce('fight', 'FIGHT');
  }

  #onHit({ attacker, defender, damage, counter, point, comboCount }) {
    const flash = this.sides[defender.index].flash;
    flash.classList.remove('hp-flash--go');
    void flash.offsetWidth; // restart the CSS animation
    flash.classList.add('hp-flash--go');

    // Prime the drain/hold state straight off the event instead of waiting
    // for `#updateHealth`'s next polled frame to notice the drop. A single
    // busy tick can carry more than one health write (a test-harness floor
    // clamp, then the hit itself; or several hitboxes in one move) before the
    // next render, and a plain before/after comparison only ever sees the
    // last of those — which can be a net rise, hiding the bleed gap
    // completely even though a real hit landed. `damage` is exactly what
    // health just lost, so the pre-hit ratio is reconstructable here without
    // racing the next frame for it.
    const s = this.hp[defender.index];
    const preRatio = THREE.MathUtils.clamp((defender.health + damage) / MAX_HEALTH, 0, 1);
    s.drain = Math.max(s.drain, preRatio);
    s.drainHoldUntil = defender.simTick + DRAIN_HOLD_TICKS;

    this.#spawnCallout(point, `-${Math.round(damage)}`, 'callout--damage', defender.index === 0 ? -1 : 1);
    if (counter) this.#spawnCallout(point, 'COUNTER HIT', 'callout--counter', 0);

    const c = this.combo[attacker.index];
    c.hits = comboCount;
    c.damage = attacker.comboDamage;
    const airborne = defender.airborne;
    if (airborne) c.tag = 'JUGGLE';
    else if (comboCount === 1) c.tag = counter ? 'COUNTER' : 'COMBO';
    c.holdUntilTick = attacker.simTick + COMBO_HOLD_TICKS;
    // A launcher's own first hit already puts the defender airborne — that
    // is the start of a combo opportunity even though the tally itself only
    // reads 1, so it earns the same slam-in beat a second hit would rather
    // than staying silent until one arrives.
    const visible = comboCount >= 2 || airborne;
    if (visible) this.#punchCombo(attacker.index);
    c.visible = visible;
  }

  #onBlock({ defender, point, move }) {
    const chip = Math.round((move.damage ?? 0) * 0.08) || 1;
    this.#spawnCallout(point, `-${chip}`, 'callout--chip', defender.index === 0 ? -1 : 1);

    // Same reasoning as `#onHit`: prime the chip layer from the event so a
    // block's small health loss gets the same guaranteed drain-and-hold read.
    const s = this.hp[defender.index];
    const preRatio = THREE.MathUtils.clamp((defender.health + chip) / MAX_HEALTH, 0, 1);
    s.drain = Math.max(s.drain, preRatio);
    s.drainHoldUntil = defender.simTick + DRAIN_HOLD_TICKS;
  }

  #onComboEnd({ fighter }) {
    const c = this.combo[fighter.index];
    c.visible = false;
  }

  #onRoundEnd({ ko, perfect }) {
    if (ko) {
      if (perfect) this.#queueAnnounce('perfect', 'PERFECT');
      this.#queueAnnounce('ko', 'K.O.');
    } else {
      this.#queueAnnounce('timeup', 'TIME UP');
      this.#queueAnnounce('great', 'GREAT');
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  /**
   * @param {import('../core/Game.js').Game} game
   * @param {number} dt real seconds since the last frame
   */
  update(game, dt) {
    const showHud = IN_FIGHT_PHASES.has(game.phase);
    if (showHud !== this.visible) {
      this.root.classList.toggle('hud--hidden', !showHud);
      this.visible = showHud;
    }
    if (!showHud) return;

    this.#updateHealth();
    this.#updateNamesAndPips(game);
    this.#updateTimer(game);
    this.#updateMeters(dt);
    this.#updateCombos();
    this.#updateCallouts(dt, game.camera);
  }

  #updateHealth() {
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      const s = this.hp[i];
      const el = this.sides[i];

      // Ease against ticks the fighter has actually simulated since the last
      // render, not real dt — see the timing note above `DRAIN_HOLD_TICKS`.
      const tick = f.simTick;
      const tickDelta = s.lastTick == null ? 0 : Math.max(0, tick - s.lastTick);
      s.lastTick = tick;

      const ht = THREE.MathUtils.clamp(f.health / MAX_HEALTH, 0, 1);
      const gt = THREE.MathUtils.clamp((f.health + f.recoverable) / MAX_HEALTH, 0, 1);

      s.fill = ht; // instant — the "true" layer never eases
      if (tick < s.drainHoldUntil) {
        s.drain = Math.max(s.drain, ht);
      } else {
        s.drain = THREE.MathUtils.damp(s.drain, ht, DRAIN_RATE_PER_TICK, tickDelta);
      }
      s.ghost = THREE.MathUtils.damp(s.ghost, gt, GHOST_RATE_PER_TICK, tickDelta);

      el.fill.style.transform = `scaleX(${s.fill})`;
      el.drain.style.transform = `scaleX(${Math.max(s.drain, s.fill)})`;
      el.ghost.style.transform = `scaleX(${Math.max(s.ghost, s.fill)})`;

      const critical = ht > 0 && ht <= CRITICAL_RATIO;
      el.block.classList.toggle('hp-block--critical', critical);

      // A pulsing hot edge while the chip is actively bleeding down toward
      // the true value — the only way an eased `transform` reads as motion
      // in a single sampled frame instead of a static gap.
      const bleeding = tick >= s.drainHoldUntil && s.drain - s.fill > 0.002;
      el.drain.classList.toggle('hp-drain--bleeding', bleeding);
    }
  }

  #updateNamesAndPips(game) {
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      const el = this.sides[i];
      const nm = f.def?.name || '';
      if (this.lastName[i] !== nm) {
        applyKbText(el.name, nm);
        applyKbText(el.portraitMono, nm.slice(0, 1));
        this.lastName[i] = nm;
        this.#capturePortrait(game, i);
      }
      const wins = game.wins?.[i] ?? 0;
      if (this.lastWins[i] !== wins) {
        for (let p = 0; p < el.pipEls.length; p++) el.pipEls[p].classList.toggle('pip--won', p < wins);
        this.lastWins[i] = wins;
      }
    }
  }

  /**
   * Renders fighter `i`'s head to `PORTRAIT_SIZE`x`PORTRAIT_SIZE` and paints
   * it into that side's portrait canvas — a bonus, not a dependency: any
   * failure (renderer without readback support, robot not built yet, no
   * `head` bone) is swallowed and just leaves the monogram fallback chip
   * showing, never crashes the HUD.
   * @param {import('../core/Game.js').Game} game
   * @param {number} i fighter index
   */
  #capturePortrait(game, i) {
    const fighter = this.fighters[i];
    const side = this.sides[i];
    const renderer = game.renderer?.renderer;
    const scene = game.scene;
    const head = fighter?.robot?.parts?.byName?.head;
    if (!renderer || !scene || !head || typeof renderer.readRenderTargetPixels !== 'function') return;

    try {
      if (!this.portraitRT) {
        this.portraitRT = new THREE.WebGLRenderTarget(PORTRAIT_SIZE, PORTRAIT_SIZE, {
          colorSpace: THREE.SRGBColorSpace,
        });
      }

      fighter.group.traverse((o) => o.layers?.enable(PORTRAIT_LAYER));

      head.getWorldPosition(this._portraitPos);
      const { x: hx, y: hy, z: hz } = this._portraitPos;
      const facing = fighter.facing || 1;
      this.portraitCamera.position.set(hx - facing * 0.6, hy + 0.12, hz + 0.5);
      this.portraitCamera.lookAt(hx + facing * 0.06, hy + 0.02, hz);
      this.portraitCamera.updateProjectionMatrix();

      const prevTarget = renderer.getRenderTarget();
      const prevBackground = scene.background;
      const prevClearColor = new THREE.Color();
      renderer.getClearColor(prevClearColor);
      const prevClearAlpha = renderer.getClearAlpha();

      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.portraitRT);
      renderer.clear(true, true, true);
      renderer.render(scene, this.portraitCamera);
      renderer.setRenderTarget(prevTarget);
      scene.background = prevBackground;
      renderer.setClearColor(prevClearColor, prevClearAlpha);

      fighter.group.traverse((o) => o.layers?.disable(PORTRAIT_LAYER));

      const buf = new Uint8Array(PORTRAIT_SIZE * PORTRAIT_SIZE * 4);
      renderer.readRenderTargetPixels(this.portraitRT, 0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE, buf);

      // WebGL render targets read back bottom-to-top; canvas ImageData is
      // top-to-bottom, so flip rows on the way in.
      const img = side.portraitCtx.createImageData(PORTRAIT_SIZE, PORTRAIT_SIZE);
      const rowBytes = PORTRAIT_SIZE * 4;
      for (let y = 0; y < PORTRAIT_SIZE; y++) {
        const src = (PORTRAIT_SIZE - 1 - y) * rowBytes;
        img.data.set(buf.subarray(src, src + rowBytes), y * rowBytes);
      }
      side.portraitCtx.putImageData(img, 0, 0);
      side.portrait.classList.add('portrait-chip--ready');
    } catch {
      // Portraits are a finishing touch; the monogram fallback already
      // covers this case, so there is nothing else to do here.
    }
  }

  #updateTimer(game) {
    const secs = Math.max(0, Math.ceil((game.roundTimer ?? 0) / TICK_HZ));
    const text = String(secs);
    if (text !== this.lastTimerText) {
      applyKbText(this.timerValue, text);
      this.lastTimerText = text;
    }
    const tense = secs > 0 && secs <= 10 && game.phase === 'fight';
    if (tense !== this.tenseState) {
      this.timerFrame.classList.toggle('timer--tense', tense);
      this.tenseState = tense;
    }
    const rt = `ROUND ${game.round ?? 1}`;
    if (rt !== this.lastRoundText) {
      this.roundLabel.textContent = rt;
      this.lastRoundText = rt;
    }
  }

  #updateMeters(dt) {
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      const m = this.meters[i];
      const frac = THREE.MathUtils.clamp(f.meter / METER_MAX, 0, 1);
      m.fill.style.transform = `scaleX(${frac})`;
      const full = f.meter >= METER_MAX;
      if (full !== m._full) {
        m.frame.classList.toggle('meter--full', full);
        m.label.classList.toggle('meter-label--full', full);
        m.label.textContent = full ? 'OVERDRIVE READY' : 'OVERDRIVE';
        m._full = full;
      }
    }
  }

  #punchCombo(i) {
    const el = this.comboEls[i].el;
    el.classList.remove('combo--punch');
    void el.offsetWidth;
    el.classList.add('combo--punch');
  }

  #updateCombos() {
    for (let i = 0; i < this.combo.length; i++) {
      const c = this.combo[i];
      const els = this.comboEls[i];
      if (c.visible && this.fighters[i].simTick >= c.holdUntilTick) c.visible = false;
      els.el.classList.toggle('combo--show', c.visible);
      if (!c.visible) continue;

      // Count-up: chase the true hit count over a couple of frames so a
      // multi-hit string still reads as an accelerating tally, not a jump-cut.
      if (c.shownHits !== c.hits) {
        c.shownHits = c.hits >= c.shownHits + 3
          ? c.shownHits + Math.ceil((c.hits - c.shownHits) * 0.4)
          : c.hits;
        applyKbText(els.hits, String(c.shownHits));
        // Tier climbs with the count so a long combo visibly escalates —
        // bigger and hotter in colour, not just a bigger number.
        const tier = c.shownHits >= 8 ? '3' : c.shownHits >= 5 ? '2' : '1';
        if (els.el.dataset.tier !== tier) els.el.dataset.tier = tier;
        els.el.dataset.count = c.shownHits === 1 ? 'one' : 'many';
      }
      if (els.tag.dataset.tag !== c.tag) {
        els.tag.dataset.tag = c.tag;
        els.tag.textContent = c.tag;
      }
      const dmgText = `${Math.round(c.damage)} DMG`;
      if (els.dmg.textContent !== dmgText) els.dmg.textContent = dmgText;
    }
  }

  // -------------------------------------------------------------------------
  // Screen-space callouts
  // -------------------------------------------------------------------------

  #worldToScreen(point, camera) {
    if (!camera || !point) return null;
    _proj.copy(point).project(camera);
    if (_proj.z > 1) return null; // behind the camera
    const rect = this.uiRoot.getBoundingClientRect();
    return {
      x: (_proj.x * 0.5 + 0.5) * rect.width,
      y: (1 - (_proj.y * 0.5 + 0.5)) * rect.height,
    };
  }

  /**
   * @param {THREE.Vector3} point   hit location, world space
   * @param {string} text
   * @param {string} cls            extra class, e.g. 'callout--damage'
   * @param {number} xBias          nudges the spawn left/right so stacked hits fan out
   */
  #spawnCallout(point, text, cls, xBias = 0) {
    let node = this.calloutPool.find((n) => !n._busy);
    if (!node) {
      if (this.calloutPool.length >= MAX_CALLOUTS) return;
      node = document.createElement('div');
      node.className = 'callout';
      node.addEventListener('animationend', () => {
        node._busy = false;
        node.style.opacity = '0';
        node.classList.remove(node._cls);
      });
      this.calloutLayer.appendChild(node);
      this.calloutPool.push(node);
    }
    node._cls = cls;
    node._busy = true;
    node.className = `callout ${cls}`;
    node.textContent = text;
    node.style.opacity = '';
    node._pending = { point: point.clone(), xBias };
  }

  #updateCallouts(dt, camera) {
    for (const node of this.calloutPool) {
      if (!node._pending) continue;
      const screen = this.#worldToScreen(node._pending.point, camera);
      if (screen) {
        const jitter = node._pending.xBias * 22;
        node.style.left = `${screen.x + jitter}px`;
        node.style.top = `${screen.y}px`;
      }
      node._pending = null; // project once at spawn time; the CSS animation drives motion from there
    }
  }

  // -------------------------------------------------------------------------
  // Announcements
  // -------------------------------------------------------------------------

  #queueAnnounce(kind, text) {
    this.announceQueue.push({ kind, text });
    if (!this.announceBusy) this.#advanceAnnounceQueue();
  }

  #advanceAnnounceQueue() {
    this.announceBanner.classList.remove('announce--run');
    const next = this.announceQueue.shift();
    if (!next) { this.announceBusy = false; return; }
    this.announceBusy = true;
    this.announceBanner.dataset.kind = next.kind;
    applyKbText(this.announceText, next.text);
    void this.announceBanner.offsetWidth;
    this.announceBanner.classList.add('announce--run');
  }
}
