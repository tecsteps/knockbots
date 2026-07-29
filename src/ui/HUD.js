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
 *   - `.hp-drain` a pale/red layer that holds at the pre-hit value for
 *     ~0.5s and then eases down to meet `.hp-fill`, so a big hit visibly
 *     "bleeds out" rather than just vanishing.
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

const DRAIN_HOLD_SEC = 0.5;
const DRAIN_RATE = 5.2; // damp lambda once the hold expires
const GHOST_RATE = 3.0;
const CRITICAL_RATIO = 0.22;
const COMBO_HOLD_SEC = 1.1; // time with no new hit before the combo readout dismisses
const MAX_CALLOUTS = 24;

const IN_FIGHT_PHASES = new Set(['intro', 'ready', 'fight', 'ko', 'roundEnd']);

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

    /** Per-fighter animated health-bar state. */
    this.hp = fighters.map(() => ({
      fill: 1, drain: 1, ghost: 1, drainHold: 0, prevHealth: MAX_HEALTH,
    }));
    this.lastName = [null, null];
    this.lastWins = [-1, -1];

    this.combo = fighters.map(() => ({
      visible: false, hits: 0, shownHits: 0, damage: 0, tag: 'COMBO', holdTimer: 0,
    }));

    this.calloutPool = [];
    this.announceQueue = [];
    this.announceBusy = false;

    this.visible = null; // last hud--hidden state written, to avoid redundant class writes
    this.tenseState = null;

    this.#wireBus();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  #buildSide(i) {
    const p = i === 0 ? 'p1' : 'p2';
    const block = document.createElement('div');
    block.className = `hp-block hp-block--${p}`;

    const frame = document.createElement('div');
    frame.className = 'hp-frame';
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
    frame.append(ghost, drain, fill, sheen, flash);

    const plate = document.createElement('div');
    plate.className = 'nameplate';
    const name = document.createElement('span');
    name.className = 'nameplate-name';
    name.textContent = '—';
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

    block.append(frame, plate);

    return { block, frame, ghost, drain, fill, flash, name, pipEls };
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
    timerValue.textContent = String(ROUND_TIME_SECONDS);
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
      if (i === 0) block.append(label, frame); else block.append(frame, label);
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
      hits.textContent = '0';
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
   */
  #buildAnnouncements() {
    const layer = document.createElement('div');
    layer.className = 'announce-layer';
    const banner = document.createElement('div');
    banner.className = 'announce-banner';
    layer.appendChild(banner);
    this.uiRoot.appendChild(layer);
    this.announceBanner = banner;
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

    this.#spawnCallout(point, `-${Math.round(damage)}`, 'callout--damage', defender.index === 0 ? -1 : 1);
    if (counter) this.#spawnCallout(point, 'COUNTER HIT', 'callout--counter', 0);

    const c = this.combo[attacker.index];
    c.hits = comboCount;
    c.damage = attacker.comboDamage;
    if (defender.airborne) c.tag = 'JUGGLE';
    else if (comboCount === 1) c.tag = counter ? 'COUNTER' : 'COMBO';
    c.holdTimer = COMBO_HOLD_SEC;
    if (comboCount >= 2) this.#punchCombo(attacker.index);
    c.visible = comboCount >= 2;
  }

  #onBlock({ defender, point, move }) {
    const chip = Math.round((move.damage ?? 0) * 0.08) || 1;
    this.#spawnCallout(point, `-${chip}`, 'callout--chip', defender.index === 0 ? -1 : 1);
  }

  #onComboEnd({ fighter }) {
    const c = this.combo[fighter.index];
    c.holdTimer = 0;
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

    this.#updateHealth(dt);
    this.#updateNamesAndPips(game);
    this.#updateTimer(game);
    this.#updateMeters(dt);
    this.#updateCombos(dt);
    this.#updateCallouts(dt, game.camera);
  }

  #updateHealth(dt) {
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      const s = this.hp[i];
      const el = this.sides[i];

      const ht = THREE.MathUtils.clamp(f.health / MAX_HEALTH, 0, 1);
      const gt = THREE.MathUtils.clamp((f.health + f.recoverable) / MAX_HEALTH, 0, 1);

      if (ht < s.prevHealth / MAX_HEALTH - 1e-4) {
        s.drain = Math.max(s.drain, s.prevHealth / MAX_HEALTH);
        s.drainHold = DRAIN_HOLD_SEC;
      }
      s.prevHealth = f.health;

      s.fill = ht; // instant — the "true" layer never eases
      if (s.drainHold > 0) {
        s.drainHold -= dt;
        s.drain = Math.max(s.drain, ht);
      } else {
        s.drain = THREE.MathUtils.damp(s.drain, ht, DRAIN_RATE, dt);
      }
      s.ghost = THREE.MathUtils.damp(s.ghost, gt, GHOST_RATE, dt);

      el.fill.style.transform = `scaleX(${s.fill})`;
      el.drain.style.transform = `scaleX(${Math.max(s.drain, s.fill)})`;
      el.ghost.style.transform = `scaleX(${Math.max(s.ghost, s.fill)})`;

      const critical = ht > 0 && ht <= CRITICAL_RATIO;
      el.block.classList.toggle('hp-block--critical', critical);
    }
  }

  #updateNamesAndPips(game) {
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      const el = this.sides[i];
      const nm = f.def?.name || '—';
      if (this.lastName[i] !== nm) {
        el.name.textContent = nm;
        this.lastName[i] = nm;
      }
      const wins = game.wins?.[i] ?? 0;
      if (this.lastWins[i] !== wins) {
        for (let p = 0; p < el.pipEls.length; p++) el.pipEls[p].classList.toggle('pip--won', p < wins);
        this.lastWins[i] = wins;
      }
    }
  }

  #updateTimer(game) {
    const secs = Math.max(0, Math.ceil((game.roundTimer ?? 0) / TICK_HZ));
    const text = String(secs);
    if (text !== this.lastTimerText) {
      this.timerValue.textContent = text;
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

  #updateCombos(dt) {
    for (let i = 0; i < this.combo.length; i++) {
      const c = this.combo[i];
      const els = this.comboEls[i];
      if (c.holdTimer > 0) {
        c.holdTimer -= dt;
        if (c.holdTimer <= 0) c.visible = false;
      }
      els.el.classList.toggle('combo--show', c.visible && c.hits >= 2);
      if (!c.visible) continue;

      // Count-up: chase the true hit count over a couple of frames so a
      // multi-hit string still reads as an accelerating tally, not a jump-cut.
      if (c.shownHits !== c.hits) {
        c.shownHits = c.hits >= c.shownHits + 3
          ? c.shownHits + Math.ceil((c.hits - c.shownHits) * 0.4)
          : c.hits;
        els.hits.textContent = String(c.shownHits);
        // Tier climbs with the count so a long combo visibly escalates —
        // bigger and hotter in colour, not just a bigger number.
        const tier = c.shownHits >= 8 ? '3' : c.shownHits >= 5 ? '2' : '1';
        if (els.el.dataset.tier !== tier) els.el.dataset.tier = tier;
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
    this.announceBanner.textContent = next.text;
    void this.announceBanner.offsetWidth;
    this.announceBanner.classList.add('announce--run');
  }
}
