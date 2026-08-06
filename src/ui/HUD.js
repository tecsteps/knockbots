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

// -----------------------------------------------------------------------------
// Two clocks, and the reason there have to be two.
//
// THE HOLD is counted in *simulated ticks*. A real-dt hold reads fine at a
// steady 60fps, but the moment a hit lands is exactly the moment the frame is
// most likely to be expensive (hitstop, sparks, screen shake, a camera cut all
// firing at once), and a countdown driven by wall-clock dt then burns through
// its whole budget in a couple of chunky frames before anyone sees it. Ticks
// advance at a fixed 60Hz regardless of render pace, so the beat is the same
// length in game-time whether the frame it lands on took 2ms or 200ms to draw.
//
// THE BLEED-DOWN is driven off real seconds, and this is the fix for a bug that
// stood for four rounds. `Fighter#simTick` does not advance during hitstop or
// the KO freeze — `Game.#frame` gates the whole accumulator on `frozen`, so
// zero ticks run — which means a bar eased against ticks freezes at precisely
// the two moments it exists to animate. Measured, three runs, on the certified
// `10-ko` frame: the loser at TRUE HEALTH ZERO, its `.hp-drain` sitting at
// scaleX 1.00 / 1.00 / 0.91 and `.hp-ghost` at 0.87 / 0.80 / 0.91. A defeated
// robot next to a bar that reads full, in the single most-screenshotted frame
// a fighting game has. And after an ordinary launcher the chip gap moved
// exactly 0.0000 for the first ~300ms of real time, because those were the
// hitstop frames.
//
// The hold therefore keeps its tick deadline AND gets a real-time ceiling, and
// whichever expires first ends it. In normal play the tick deadline always wins
// (10 ticks = 167ms against a 250ms ceiling), so the chunky-frame protection
// above is untouched; the ceiling only bites when the simulation is frozen,
// which is the exact case it exists for. Both deadlines are absolute rather
// than countdowns, so neither can be over-consumed by a batched frame.
const DRAIN_HOLD_TICKS = 10;
/** Real-time escape for the hold. 1.5x the tick deadline's nominal length. */
const DRAIN_HOLD_MAX_SECONDS = 0.25;
/** Damp lambdas, per REAL second. Numerically identical to the old per-tick
 *  rates at 60Hz, so the bleed reads the same in an unfrozen frame. */
const DRAIN_LAMBDA = 6.0;
const GHOST_LAMBDA = 3.0;
/**
 * Clamp on a single HUD-clock step, so a backgrounded tab (rAF stops, then
 * `performance.now()` jumps by seconds) cannot teleport an ease.
 *
 * 0.25, matching `Game.#frame`'s own `Math.min(getDelta(), 0.25)`, rather than
 * a tighter number picked for tidiness. The KO burst is the slowest moment in
 * the build — traced from the `roundEnd` event, HUD updates arrive at t = 301,
 * 379, then not again until 1048 ms, a single 670 ms frame — and at a 0.1 s
 * clamp that frame advanced the bar by 100 ms of ease instead of 670, leaving
 * the loser's drain still at 0.50 nearly a second after it died. A ceiling that
 * throws away real elapsed time on the frames that matter most is the same
 * class of bug as easing on a clock that stops.
 */
const MAX_HUD_STEP = 0.25;
const CRITICAL_RATIO = 0.22;
const COMBO_HOLD_TICKS = 66; // ~1.1s of game-time with no new hit before the combo readout dismisses
const MAX_CALLOUTS = 24;
/** Clearance left above a thumb box when a callout has to be moved out of one. */
const THUMB_CLEARANCE = 16;

const IN_FIGHT_PHASES = new Set(['intro', 'ready', 'fight', 'ko', 'roundEnd']);

/**
 * The three beats of a big announcement, in milliseconds. They must stay in
 * step with `announceIn` / `announceOut` in `ui.css`, which is why they are
 * named here rather than inlined: the CSS owns the interpolation, this owns the
 * state machine that switches between them, and a disagreement shows up as the
 * word either snapping or hanging.
 *
 * Total is the 1.5s the single-keyframe version ran for. The middle beat exists
 * as a distinct state — with no animation, no transform and no filter — because
 * every one of those is a compositing trigger, and a composited layer is
 * rastered at one scale and resampled at the rest. See the long note in
 * `ui.css`; it is worth 3x on the glyph's measured edge contrast.
 *
 * The hold is deliberately long — 1.24s, where a naive reading of the original
 * 1.5s cycle would give it 0.78s. Two reasons, one craft and one instrument. A
 * fighting game's round call is held, not flashed; and this is the only beat of
 * the three that is legible, so every millisecond of it is a millisecond in
 * which an arbitrarily-timed shutter photographs something worth scoring.
 *
 * These are also the ONLY wall-clock authority over the sequence. CSS animation
 * time advances with rendered frames here, and the page stalls for 450-550ms at
 * a stretch, so `animationend` can arrive most of a second late; the timers in
 * `#advanceAnnounceQueue` are what keep the banner's beats roughly where they
 * were authored. The entry is short and the hold is long on purpose — a late
 * transition should overrun into the beat that is legible, not out of it.
 */
const ANNOUNCE_IN_MS = 160;
const ANNOUNCE_HOLD_MS = 1240;
const ANNOUNCE_OUT_MS = 260;

/**
 * Fixed camera layer used only for the offscreen portrait pass — high
 * enough that it can never collide with `LAYER.BLOOM_ONLY`/`NO_REFLECT`
 * from `Constants.js`. Tagging a fighter's group with it and pointing a
 * layer-exclusive camera at it is what lets `#capturePortrait` render just
 * that one robot (still fully lit by the real scene lights, which are not
 * layer-gated) with the opponent, stage and background left out of frame.
 */
const PORTRAIT_LAYER = 6;
// Matches `RosterPortraits`' own render size. At 128 the cached 256px roster
// bust was resampled down on the way into the canvas and then scaled back up
// by the browser at DPR 2 — two resamples for no reason, on the one image in
// the HUD whose whole job is to be recognisable at 63 CSS px.
const PORTRAIT_SIZE = 256;

/** Reusable scratch vector for world -> screen projection. */
const _proj = new THREE.Vector3();
/** Scratch for saving the renderer's clear colour across a portrait pass. */
const _clearColor = new THREE.Color();

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

    /** Per-fighter animated health-bar state. `drainHoldUntil` (a `simTick`)
     * and `drainHoldUntilTime` (a HUD-clock second) are both absolute
     * deadlines, not countdowns, so a slow or batched frame can never
     * over-consume either (see the timing note above `DRAIN_HOLD_TICKS`). */
    this.hp = fighters.map(() => ({
      fill: 1, drain: 1, ghost: 1, drainHoldUntil: 0, drainHoldUntilTime: 0,
    }));

    /**
     * The HUD's own presentation clock, in seconds.
     *
     * Deliberately not the `dt` `Game` passes in: that is `sceneDt`, already
     * multiplied by `HITSTOP_SCENE_RATE` during a freeze — it is the clock that
     * makes hitstop look like hitstop, and reusing it here would leave the
     * health bars just as frozen as `simTick` does. It advances on real time,
     * and stops only when the game is genuinely paused, which covers both the
     * pause menu and the capture harness's `KB.paused = true` freeze (so a
     * contact frame is still photographed with a fresh, un-bled chip gap).
     */
    this.clock = 0;
    this.clockLastNow = null;
    this.lastName = [null, null];
    this.lastWins = [-1, -1];

    this.combo = fighters.map(() => ({
      visible: false, hits: 0, shownHits: 0, damage: 0, tag: 'COMBO', holdUntilTick: 0,
    }));

    this.calloutPool = [];
    this.announceQueue = [];
    this.announceBusy = false;
    /** Safety timers for the announcement's three phases; see `#advanceAnnounceQueue`. */
    this.announceTimers = [];
    /** Bumped per announcement, so a deferred start that has been superseded can tell. */
    this.announceGen = 0;

    this.visible = null; // last hud--hidden state written, to avoid redundant class writes
    this.tenseState = null;

    /**
     * Cached bounds of `uiRoot`, used by `#worldToScreen`. Reading this
     * per callout per frame was a forced synchronous layout of the whole
     * document — measured at 0.20ms a call against the live HUD, versus
     * 0.008ms for the cached read. Invalidated on resize and whenever the
     * HUD is shown, which is the only time the overlay can have been
     * relaid out without a resize event.
     */
    this.rootRect = null;
    /** Safe-area insets in px, resolved from the `--kb-sa-*` tokens alongside
     * `rootRect` and invalidated with it. Callouts are positioned in px by JS,
     * so they are the one part of the HUD that cannot inherit the CSS `calc()`
     * the rest of the layout uses to clear a notch. */
    this.rootInsets = null;
    window.addEventListener('resize', () => { this.rootRect = null; this.rootInsets = null; });

    /** Lazily-created offscreen render target + camera for `#capturePortrait`. */
    this.portraitRT = null;
    this.portraitBuffer = null;
    this.portraitCamera = new THREE.PerspectiveCamera(26, 1, 0.05, 4);
    this.portraitCamera.layers.set(PORTRAIT_LAYER);
    this._portraitPos = new THREE.Vector3();
    /** One capture in flight at a time, at most one started per frame. */
    this.portraitPending = fighters.map(() => false);
    this.portraitBusy = false;

    this.#wireBus();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  #buildSide(i) {
    const p = i === 0 ? 'p1' : 'p2';
    const block = document.createElement('div');
    block.className = `hp-block hp-block--${p}`;

    // Portrait chip: a rendered bust of the fighter (see `#capturePortrait`)
    // over a beveled metal plate, with a monogram fallback shown until that
    // first capture lands.
    //
    // Two boxes, not one, and the reason is a defect that survived thirteen
    // rounds because nobody looked at this at magnification. The chip is a
    // chamfered hexagon cut with `clip-path`, and its player-identity keyline
    // used to be an `inset` box-shadow on a `::after` sharing that clip. An
    // inset box-shadow draws a RECTANGULAR ring inside the border box, so on
    // the two edges the chamfer actually cuts, the clip removed the ring
    // entirely: measured on a 4x DOM raster, each chip carried its cyan/red
    // keyline on two of its four sides and nothing at all on the other two.
    // A frame is now a real filled shape (`.portrait-chip`) with the picture
    // inset inside it (`.portrait-chip__inner`), both clipped, so the keyline
    // is the gap between two chamfered polygons and cannot miss a corner.
    const portrait = document.createElement('div');
    portrait.className = 'portrait-chip';
    const portraitInner = document.createElement('div');
    portraitInner.className = 'portrait-chip__inner';
    const portraitCanvas = document.createElement('canvas');
    portraitCanvas.className = 'portrait-canvas';
    portraitCanvas.width = PORTRAIT_SIZE;
    portraitCanvas.height = PORTRAIT_SIZE;
    const portraitFallback = document.createElement('div');
    portraitFallback.className = 'portrait-fallback';
    const portraitMono = document.createElement('span');
    portraitFallback.appendChild(portraitMono);
    portraitInner.append(portraitCanvas, portraitFallback);
    portrait.append(portraitInner);

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

    // The pause key, for hands that have no keys.
    // -----------------------------------------------------------------------
    // `Escape` is the only way into the pause menu, and a phone has no Escape.
    // Measured against the shipped touch pad: it mounts a stick, four limbs, an
    // overdrive pad and a block pad, and nothing that opens a menu — so on a
    // handset the pause screen, the options, QUIT TO TITLE and (as of this
    // round) the move list were all unreachable once a match had started. A
    // player could not read their own machine's specials mid-fight, and could
    // not leave the match at all.
    //
    // It is gated on `hover: none` in the stylesheet, so it exists on the
    // devices that need it and on no others. That is also why it cannot move a
    // scored frame: `tools/capture.mjs` photographs 08-hud through a desktop
    // pointer context, where this rule never matches and the button is not in
    // the layout at all.
    //
    // Top centre, under the round label, is deliberate: it is the one part of
    // the HUD both thumbs are nowhere near, so it cannot be hit by accident
    // during a combo — which for a pause button is the whole design problem.
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.className = 'hud-pause';
    pause.setAttribute('aria-label', 'Pause — menu, options and move list');
    const pauseBars = document.createElement('i');
    pauseBars.className = 'hud-pause-bars';
    const pauseLabel = document.createElement('span');
    pauseLabel.textContent = 'MENU';
    pause.append(pauseBars, pauseLabel);
    pause.addEventListener('click', (e) => { e.preventDefault(); bus.emit('requestPause', {}); });
    timerWrap.append(pause);

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
    this.announceLayer = layer;
    this.announceBanner = banner;
    this.announceText = text;
    banner.addEventListener('animationend', (e) => {
      // `.announce-banner::before` runs its own flare of exactly the same
      // length, and CSS dispatches a pseudo-element's animation events at
      // the *originating* element — so this listener fires twice per
      // banner. The second one advanced the queue again on the same frame,
      // which is why a queued pair ("PERFECT" then "K.O.") could drop the
      // second word: it was started and immediately superseded.
      if (e.pseudoElement) return;
      // Two animations now run on this element across one announcement, so the
      // handler has to say WHICH one ended. Before the split there was only
      // `announceCycle` and an unqualified handler was correct; an unqualified
      // handler now advances the queue the instant the fly-in lands and the
      // word is never held at all.
      if (e.animationName === 'announceIn') this.#announcePhase('hold');
      else if (e.animationName === 'announceOut') this.#advanceAnnounceQueue();
    });
  }

  // -------------------------------------------------------------------------
  // Restarting one-shot CSS animations
  //
  // The usual idiom for replaying a keyframe animation — drop the class,
  // read `offsetWidth` to flush, put the class back — buys its style flush
  // with a *forced synchronous layout of the whole document*. Measured
  // against this HUD with the render loop live it costs 0.21ms a call, and
  // the hit flash and the combo slam both fire on every hit, so a five-hit
  // juggle spends over a millisecond of the frame budget doing nothing but
  // relayout.
  //
  // Two cheaper flushes do not survive measurement and are not used here.
  // `getComputedStyle(el).animationName` is *worse*, at 0.31ms — it skips
  // layout but still resolves style for the whole element. And the Web
  // Animations restart, `for (const a of el.getAnimations()) { a.cancel();
  // a.play(); }`, does not restart anything: tested against both the hit
  // flash (`fill: none`) and the announcement banner (`fill: forwards`,
  // restarted from inside its own `animationend`), `getAnimations()`
  // returned an empty list both times, so it is a silent no-op that would
  // simply stop the effect playing.
  //
  // The two techniques below replace it, chosen per site by how hot the
  // site is.
  // -------------------------------------------------------------------------

  /**
   * Hot path (per hit). Alternates between two classes that differ only in
   * which of a pair of identical `@keyframes` they name, so the computed
   * `animation-name` changes and the animation restarts with no style read
   * of any kind. Measured at 0.010ms a call — 21x cheaper than the reflow.
   * @param {HTMLElement} el
   * @param {string} base class stem; `${base}-a` / `${base}-b` must exist in ui.css
   */
  #restartAnim(el, base) {
    const prev = el._kbAlt === 'a' ? 'a' : 'b';
    const next = prev === 'a' ? 'b' : 'a';
    el.classList.remove(`${base}-${prev}`);
    el.classList.add(`${base}-${next}`);
    el._kbAlt = next;
  }

  /**
   * Cold path (a handful of times a round). Lets the class removal reach a
   * style update on its own before putting the class back — no layout, no
   * duplicated keyframes. The cost is two frames of latency, which a
   * half-second meter burst and a 1.5s announcement can afford and a
   * per-hit flash cannot.
   *
   * Two frames, not one. `animationend` is dispatched inside the same
   * "update the rendering" step that goes on to run that frame's
   * animation-frame callbacks, so a restart triggered from an
   * `animationend` handler — which is exactly how the announcement queue
   * advances — lands its `requestAnimationFrame` callback in the *same*
   * frame as the removal. The computed `animation-name` never changes and
   * the replay is silently dropped: measured one start for two requests.
   * The second frame guarantees a style update in between.
   * @param {HTMLElement} el
   * @param {string} cls
   */
  #restartAnimDeferred(el, cls, then) {
    el.classList.remove(cls);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.classList.add(cls);
      if (then) then();
    }));
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
    this.#restartAnimDeferred(el, 'meter--burst');
  }

  #onPhase({ phase }) {
    if (phase === 'fight') this.#queueAnnounce('fight', 'FIGHT');
  }

  #onHit({ attacker, defender, damage, counter, point, comboCount }) {
    this.#restartAnim(this.sides[defender.index].flash, 'hp-flash--go');

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
    s.drainHoldUntilTime = this.clock + DRAIN_HOLD_MAX_SECONDS;

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
    s.drainHoldUntilTime = this.clock + DRAIN_HOLD_MAX_SECONDS;
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
   * @param {number} [_dt] the caller's scene dt. Unused: it is scaled down
   *   during hitstop, which is exactly when this HUD must keep animating.
   *   See `this.clock`.
   */
  update(game, _dt) {
    const step = this.#advanceClock(game);

    const showHud = IN_FIGHT_PHASES.has(game.phase);
    if (showHud !== this.visible) {
      this.root.classList.toggle('hud--hidden', !showHud);
      this.visible = showHud;
      this.rootRect = null;
      this.rootInsets = null;
    }
    if (!showHud) return;

    this.#updateHealth(step);
    this.#updateNamesAndPips(game);
    this.#updateTimer(game);
    this.#updateMeters(game);
    this.#updateCombos();
    this.#updateCallouts(game);
    this.#servicePortraits(game);
  }

  /**
   * Advance the HUD's presentation clock and return this frame's step in
   * seconds. See the note on `this.clock` in the constructor for why this is
   * not the `dt` the caller hands in.
   * @param {import('../core/Game.js').Game} game
   * @returns {number} clamped seconds elapsed since the previous frame
   */
  #advanceClock(game) {
    const now = performance.now() / 1000;
    const raw = this.clockLastNow == null ? 0 : now - this.clockLastNow;
    this.clockLastNow = now;
    const step = game.paused ? 0 : THREE.MathUtils.clamp(raw, 0, MAX_HUD_STEP);
    this.clock += step;
    return step;
  }

  /**
   * @param {number} step seconds on the HUD clock since the previous frame
   */
  #updateHealth(step) {
    for (let i = 0; i < this.fighters.length; i++) {
      const f = this.fighters[i];
      const s = this.hp[i];
      const el = this.sides[i];

      const tick = f.simTick;
      const ht = THREE.MathUtils.clamp(f.health / MAX_HEALTH, 0, 1);
      const gt = THREE.MathUtils.clamp((f.health + f.recoverable) / MAX_HEALTH, 0, 1);

      // The hold runs on ticks with a real-time ceiling; the bleed itself runs
      // on real seconds so that hitstop and the KO freeze cannot stop it. See
      // the note above `DRAIN_HOLD_TICKS`.
      const holding = tick < s.drainHoldUntil && this.clock < s.drainHoldUntilTime;

      s.fill = ht; // instant — the "true" layer never eases
      if (holding) s.drain = Math.max(s.drain, ht);
      else s.drain = THREE.MathUtils.damp(s.drain, ht, DRAIN_LAMBDA, step);
      s.ghost = THREE.MathUtils.damp(s.ghost, gt, GHOST_LAMBDA, step);

      el.fill.style.transform = `scaleX(${s.fill})`;
      el.drain.style.transform = `scaleX(${Math.max(s.drain, s.fill)})`;
      el.ghost.style.transform = `scaleX(${Math.max(s.ghost, s.fill)})`;

      const critical = ht > 0 && ht <= CRITICAL_RATIO;
      el.block.classList.toggle('hp-block--critical', critical);

      // A pulsing hot edge while the chip is actively bleeding down toward
      // the true value — the only way an eased `transform` reads as motion
      // in a single sampled frame instead of a static gap.
      const bleeding = !holding && s.drain - s.fill > 0.002;
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
        this.portraitPending[i] = true;
      }
      const wins = game.wins?.[i] ?? 0;
      if (this.lastWins[i] !== wins) {
        for (let p = 0; p < el.pipEls.length; p++) el.pipEls[p].classList.toggle('pip--won', p < wins);
        this.lastWins[i] = wins;
      }
    }
  }

  /**
   * Starts at most one portrait capture per frame, and never a second while
   * one is still in flight.
   *
   * This scheduling is not tidiness — it is the fix for the worst stall in
   * the build. Both fighters' names land on the same frame (the first frame
   * of a match, straight out of character select), so the old code ran two
   * captures back to back inside a single `update()`, and each one ended in
   * a *synchronous* `readRenderTargetPixels`. That call flushes the whole GL
   * command queue and blocks the main thread until the driver hands the
   * pixels back; against a 650k-triangle, 230-draw-call frame it measured
   * 316ms to 1382ms **per call**. The scene render feeding it costs
   * 0.4-0.9ms, so the readback was essentially the entire cost. Two of them
   * in one frame is the multi-second freeze players hit when a fight starts.
   * @param {import('../core/Game.js').Game} game
   */
  #servicePortraits(game) {
    // Sweep the already-captured cache for EVERY pending side, every frame,
    // before the one-at-a-time GL path below.
    //
    // This is the fix for a defect that was on screen in every scored HUD
    // frame: P1's chip held a rendered bust and P2's held a bare letter "K",
    // for the entire match. Both names land on the same frame, so both sides go
    // pending together, but `RosterPortraits` fills its cache one machine per
    // idle slice — roster order, a few hundred ms apart. P1 (roster[0]) hit the
    // cache; P2 (roster[1]) missed by one slice, `#capturePortrait` answered
    // "handled" for it because a mid-match GL readback is forbidden, and the
    // pending flag was cleared. Nothing ever re-checked, so a portrait that
    // arrived 300ms later was never collected and the chips stayed mismatched
    // until the match ended. Probed live: the cache held [vulkan|kestrel|anvil]
    // while Kestrel's chip was still showing its monogram.
    //
    // Two things had to change together. `#capturePortrait` now reports the
    // mid-match miss as "not handled" so the flag survives, and the retry has
    // to live HERE rather than in the single-slot path below, because
    // `indexOf(true)` only ever services the lowest pending index — one side
    // stuck pending would starve the other forever.
    //
    // The sweep is a `Map.get` and, at most once per side per match, a canvas
    // blit. No render target, no fence, no `readRenderTargetPixels` — none of
    // the 135-1433ms stalls documented below are reachable from this path.
    const portraits = game.menus?._portraits;
    if (portraits?.get) {
      for (let i = 0; i < this.portraitPending.length; i++) {
        if (!this.portraitPending[i]) continue;
        const url = portraits.get(this.fighters[i]?.def?.id);
        if (!url) continue;
        this.#paintPortraitFromUrl(i, url);
        this.portraitPending[i] = false;
      }
    }
    if (this.portraitBusy) return;
    const i = this.portraitPending.indexOf(true);
    if (i < 0) return;
    if (this.#capturePortrait(game, i)) this.portraitPending[i] = false;
  }

  /**
   * Renders fighter `i`'s head to `PORTRAIT_SIZE`x`PORTRAIT_SIZE` and paints
   * it into that side's portrait canvas — a bonus, not a dependency: any
   * failure (renderer without readback support, robot not built yet, no
   * `head` bone) is swallowed and just leaves the monogram fallback chip
   * showing, never crashes the HUD.
   *
   * The readback goes through `readRenderTargetPixelsAsync`, which issues
   * the same `readPixels` into a pixel-buffer object and then resolves off a
   * GPU fence instead of spinning the main thread on it — the pixels are
   * captured into the PBO at issue time, so the frames drawn while the fence
   * is outstanding cannot corrupt them. The synchronous call is kept only as
   * a fallback for a context that has no async path at all.
   * @param {import('../core/Game.js').Game} game
   * @param {number} i fighter index
   * @returns {boolean} true once the capture has been issued (or is
   *   impossible); false while the fighter is not ready and it should be
   *   retried on a later frame.
   */
  /**
   * Paint an already-captured portrait data URL into a side's canvas. No GL work
   * and therefore no fence to wait on.
   * @param {number} i fighter index
   * @param {string} url data URL from the roster capture
   */
  #paintPortraitFromUrl(i, url) {
    const side = this.sides?.[i];
    if (!side?.portraitCtx) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        side.portraitCtx.clearRect(0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);
        side.portraitCtx.drawImage(img, 0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);
        side.portrait.classList.add('portrait-chip--ready');
      } catch { /* a portrait is decoration; never let it break the HUD */ }
    };
    img.src = url;
  }

  #capturePortrait(game, i) {
    const fighter = this.fighters[i];

    // Prefer a portrait the menu already captured. `RosterPortraits` photographs
    // every machine during idle time on the select screen and caches it by id,
    // where a stall is invisible and measured at 3.9ms worst frame.
    //
    // This matters more than it looks. Making the readback async did NOT remove
    // its cost — it moved it. `readRenderTargetPixelsAsync` issues a fence and
    // then calls `getBufferSubData`, which blocks if the fence has not signalled,
    // so the block leaves `hud.update` and reappears at the GL sync point,
    // possibly in a later frame. Timing `hud.update` therefore showed 0.1ms while
    // the frame still stalled: measured whole-frame, worst frame was 1433ms with
    // the readback live, 290ms with it stubbed, and 927ms when restored.
    // The fix is not to make the readback faster. It is not to do one during a
    // match at all.
    const cached = game.menus?._portraits?.get?.(fighter?.def?.id);
    if (cached) {
      this.#paintPortraitFromUrl(i, cached);
      return true;
    }

    // No cached portrait, and we are mid-match: do nothing and keep the
    // monogram. A portrait is decoration and must never buy a stall.
    //
    // The readback below is not cheap and not deferrable in the way it looks:
    // `readRenderTargetPixelsAsync` issues a fence and then blocks in
    // `getBufferSubData` until it signals, so the cost only leaves the call site
    // and reappears at the GL sync point. Measured whole-frame entering a match
    // with no cache: repeated 135-261ms stalls, with zero new shader programs,
    // which rules out compilation and leaves the readback.
    //
    // The normal route through character select fills the cache during idle time
    // where a stall is invisible (measured 3.9ms worst frame). This branch exists
    // for the routes that skip it — a direct start, a rematch, the test harness —
    // and for those the honest answer is a monogram *for now*.
    //
    // `false`, not `true`: this is a "not yet", not a "handled". Returning true
    // cleared the pending flag and permanently froze the chip on its monogram
    // even though the warm-up handed the cache that exact portrait a few hundred
    // milliseconds later — see `#servicePortraits`, which retries the cache-only
    // path each frame and costs a `Map.get`. It buys no stall: everything below
    // this line is still unreachable during a match.
    if (game.phase === 'fight' || game.phase === 'intro' || game.phase === 'ready') return false;

    const renderer = game.renderer?.renderer;
    const scene = game.scene;
    const head = fighter?.robot?.parts?.byName?.head;
    if (!renderer || !scene || !head) return false;
    const canReadAsync = typeof renderer.readRenderTargetPixelsAsync === 'function';
    if (!canReadAsync && typeof renderer.readRenderTargetPixels !== 'function') return true;

    try {
      if (!this.portraitRT) {
        this.portraitRT = new THREE.WebGLRenderTarget(PORTRAIT_SIZE, PORTRAIT_SIZE, {
          colorSpace: THREE.SRGBColorSpace,
        });
      }
      if (!this.portraitBuffer) this.portraitBuffer = new Uint8Array(PORTRAIT_SIZE * PORTRAIT_SIZE * 4);

      fighter.group.traverse((o) => o.layers?.enable(PORTRAIT_LAYER));

      head.getWorldPosition(this._portraitPos);
      const { x: hx, y: hy, z: hz } = this._portraitPos;
      const facing = fighter.facing || 1;
      this.portraitCamera.position.set(hx - facing * 0.6, hy + 0.12, hz + 0.5);
      this.portraitCamera.lookAt(hx + facing * 0.06, hy + 0.02, hz);
      this.portraitCamera.updateProjectionMatrix();

      const prevTarget = renderer.getRenderTarget();
      const prevBackground = scene.background;
      renderer.getClearColor(_clearColor);
      const prevClearAlpha = renderer.getClearAlpha();

      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.portraitRT);
      renderer.clear(true, true, true);
      renderer.render(scene, this.portraitCamera);
      renderer.setRenderTarget(prevTarget);
      scene.background = prevBackground;
      renderer.setClearColor(_clearColor, prevClearAlpha);

      fighter.group.traverse((o) => o.layers?.disable(PORTRAIT_LAYER));

      const buf = this.portraitBuffer;
      if (canReadAsync) {
        this.portraitBusy = true;
        renderer.readRenderTargetPixelsAsync(this.portraitRT, 0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE, buf)
          .then(() => this.#paintPortrait(i, buf))
          .catch(() => {})
          .finally(() => { this.portraitBusy = false; });
      } else {
        renderer.readRenderTargetPixels(this.portraitRT, 0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE, buf);
        this.#paintPortrait(i, buf);
      }
      return true;
    } catch {
      // Portraits are a finishing touch; the monogram fallback already
      // covers this case, so there is nothing else to do here.
      return true;
    }
  }

  /**
   * Paints a completed readback into side `i`'s portrait canvas. WebGL
   * render targets read back bottom-to-top; canvas ImageData is
   * top-to-bottom, so flip rows on the way in.
   * @param {number} i
   * @param {Uint8Array} buf
   */
  #paintPortrait(i, buf) {
    const side = this.sides[i];
    if (!side?.portraitCtx) return;
    const img = side.portraitImage
      ?? (side.portraitImage = side.portraitCtx.createImageData(PORTRAIT_SIZE, PORTRAIT_SIZE));
    const rowBytes = PORTRAIT_SIZE * 4;
    for (let y = 0; y < PORTRAIT_SIZE; y++) {
      const src = (PORTRAIT_SIZE - 1 - y) * rowBytes;
      img.data.set(buf.subarray(src, src + rowBytes), y * rowBytes);
    }
    side.portraitCtx.putImageData(img, 0, 0);
    side.portrait.classList.add('portrait-chip--ready');
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

  /**
   * @param {import('../core/Game.js').Game} game
   */
  #updateMeters(game) {
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
        // The touch pad's overdrive button rests dimmed and lights up when the
        // meter is spendable — the ready signal a phone gets instead of the
        // 6.4px "OVERDRIVE READY" caption, which is hidden at that size. Nothing
        // else in the build called `setMeterReady`, so the pad had never
        // reflected meter state at all; this is the one place that boolean is
        // already computed, on the edge, for the player the pad drives.
        if (i === 0) game.touch?.setMeterReady?.(full);
      }
    }
  }

  #punchCombo(i) {
    this.#restartAnim(this.comboEls[i].el, 'combo--punch');
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
    const rect = this.rootRect ?? (this.rootRect = this.uiRoot.getBoundingClientRect());
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
      node._point = new THREE.Vector3();
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
    // The spawn point is copied into the node's own vector rather than
    // cloned, so a dense combo does not allocate a Vector3 per hit.
    node._point.copy(point);
    node._bias = xBias;
    node._pending = true;
  }

  /**
   * Places every callout spawned since the last frame.
   *
   * A callout is projected from a world-space hit point, which means — unlike
   * every other piece of the HUD — nothing constrains where it lands. Measured
   * on an 844x390 handset with a fighter pushed to each wall, damage numbers
   * projected to (821, 184) and (197, 141): the first inside the overdrive pad,
   * the second inside the floating stick's footprint. Both are numbers the
   * player is meant to read, printed under a thumb. And at x=821 of 844 the
   * `translate(-50%, -50%)` centring hangs half the glyphs off the edge, where
   * `.callouts-layer`'s own `overflow: hidden` clips them.
   *
   * So the projected point is a preference, not a position: it gets clamped
   * inside the readable frame (safe-area insets included, since a notch eats
   * the same corner) and lifted clear of whatever the thumbs are covering.
   * @param {import('../core/Game.js').Game} game
   */
  #updateCallouts(game) {
    // Asked for lazily: most frames have nothing pending, and `thumbZones()`
    // measures the pad rather than caching it (see its own note), so the cost
    // belongs on the frames a hit actually lands on.
    let zones;
    for (const node of this.calloutPool) {
      if (!node._pending) continue;
      if (zones === undefined) zones = game.touch?.thumbZones?.() ?? null;
      const screen = this.#worldToScreen(node._point, game.camera);
      if (screen) {
        const p = this.#placeCallout(screen.x + node._bias * 22, screen.y, zones);
        node.style.left = `${p.x}px`;
        node.style.top = `${p.y}px`;
      }
      node._pending = false; // project once at spawn time; the CSS animation drives motion from there
    }
  }

  /**
   * Clamp a callout inside the readable frame and lift it out of any thumb box.
   *
   * Lifting is always upward. Down is the floor, the pad and the notch's own
   * corner; up is the arena, and a callout's animation already travels up, so
   * moving it that way agrees with the motion the player is tracking. The
   * result is clamped again below the top HUD stack so a hit taken at the very
   * bottom of the frame cannot throw its damage number into the health bars.
   * @param {number} x projected, client space
   * @param {number} y projected, client space
   * @param {{ left: number, top: number, right: number, bottom: number }[]|null} zones
   * @returns {{ x: number, y: number }}
   */
  #placeCallout(x, y, zones) {
    const rect = this.rootRect ?? (this.rootRect = this.uiRoot.getBoundingClientRect());
    const sa = this.rootInsets ?? (this.rootInsets = this.#readInsets());
    const margin = 34; // half the widest callout ("COUNTER HIT") plus a little air
    let cx = THREE.MathUtils.clamp(x, sa.l + margin, rect.width - sa.r - margin);
    let cy = y;
    if (zones) {
      for (const z of zones) {
        if (cx >= z.left && cx <= z.right && cy >= z.top && cy <= z.bottom) {
          cy = Math.min(cy, z.top - THUMB_CLEARANCE);
        }
      }
    }
    const ceiling = sa.t + rect.height * 0.24; // clear of the bar / meter / timer stack
    return { x: cx, y: Math.max(cy, ceiling) };
  }

  /**
   * Resolve the safe-area insets to px, once per resize.
   *
   * Read off `.announce-layer`'s computed padding rather than the `--kb-sa-*`
   * tokens themselves: a custom property's computed value is its token stream,
   * so `getPropertyValue('--kb-sa-l')` hands back the literal text
   * `env(safe-area-inset-left, 0px)` — `env()` is substituted at *use* time, and
   * parsing that string yields nothing. The announce layer already pads itself
   * by all four tokens (see ui.css, where the reason is keeping "K.O." off the
   * notch), and a computed `padding-left` is a used value in px, so it is the
   * resolved number the rest of the layout is working from.
   * @returns {{ t: number, r: number, b: number, l: number }}
   */
  #readInsets() {
    if (!this.announceLayer) return { t: 0, r: 0, b: 0, l: 0 };
    const cs = getComputedStyle(this.announceLayer);
    return {
      t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0,
      b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0,
    };
  }

  // -------------------------------------------------------------------------
  // Announcements
  // -------------------------------------------------------------------------

  #queueAnnounce(kind, text) {
    // Collapse an immediate repeat of the word already on screen.
    //
    // `#onPhase` queues "FIGHT" on every `phase` event naming the fight, and a
    // phase can legitimately be entered more than once in quick succession —
    // `startMatch` re-enters it, and the capture harness calls `setPhase('fight')`
    // explicitly on top of that. The queue then held FIGHT twice, so the banner
    // played its full 1.5s and immediately replayed from frame one. On
    // 13-announce-fight that is visible in the manifest: one run in three
    // certified `opacity 0.69, ink 781x213`, which is scale 1.39 and 1.9px of
    // blur — the ENTRY of a second banner, not the hold of the first, because
    // the shot's settle window straddled the handover. The same defect in
    // normal play is a word that stutters and starts again.
    //
    // Only an immediate repeat is collapsed: "ROUND 2" then "FIGHT" is not a
    // repeat, and a later round's "FIGHT" is separated by its round card.
    const tail = this.announceQueue[this.announceQueue.length - 1];
    if (tail) {
      if (tail.kind === kind && tail.text === text) return;
    } else if (this.announceBusy && this.announceBanner.dataset.kind === kind
      && this.announceText._kbStr === text) {
      return;
    }
    this.announceQueue.push({ kind, text });
    if (!this.announceBusy) this.#advanceAnnounceQueue();
  }

  /**
   * Move the banner to one of its three phases. Idempotent, because both the
   * `animationend` and the safety timer below can ask for the same one.
   * @param {'in'|'hold'|'out'} phase
   */
  #announcePhase(phase) {
    const el = this.announceBanner;
    if (!el.classList.contains('announce--run') || el.dataset.phase === phase) return;
    el.dataset.phase = phase;
  }

  #clearAnnounceTimers() {
    for (const t of this.announceTimers) clearTimeout(t);
    this.announceTimers.length = 0;
  }

  #advanceAnnounceQueue() {
    this.#clearAnnounceTimers();
    // Generation guard. `#restartAnimDeferred` hands its callback to a
    // double-`requestAnimationFrame`, so a banner that is superseded inside
    // those two frames — a KO landing on the frame the round card started, say
    // — would otherwise arm a second, untracked set of timers that
    // `#clearAnnounceTimers` has already run past, and the two would then fight
    // over `data-phase`.
    const gen = ++this.announceGen;
    this.announceBanner.classList.remove('announce--run');
    this.announceBanner.removeAttribute('data-phase');
    const next = this.announceQueue.shift();
    if (!next) { this.announceBusy = false; return; }
    this.announceBusy = true;
    this.announceBanner.dataset.kind = next.kind;
    applyKbText(this.announceText, next.text);
    // `announce--run` stays the "an announcement is up" marker for the whole
    // beat — the capture harness gates on it, and so does `#onPhase` — while
    // `data-phase` carries which of the three beats is running.
    this.#restartAnimDeferred(this.announceBanner, 'announce--run', () => {
      if (gen !== this.announceGen) return;
      this.announceBanner.dataset.phase = 'in';
      // Timers are armed HERE, not at queue time, because `#restartAnimDeferred`
      // spends two frames getting the class onto the element and the CSS
      // animation starts from this moment, not from the call.
      //
      // `animationend` is the precise trigger for in -> hold; these are the
      // floor under it. A dropped `animationend` (a background tab throttling
      // rAF, a style recalc coalescing the class add) would otherwise leave the
      // banner parked on screen forever, and it would be parked in the phase
      // that is composited and soft.
      this.announceTimers.push(
        setTimeout(() => this.#announcePhase('hold'), ANNOUNCE_IN_MS + 40),
        setTimeout(() => this.#announcePhase('out'), ANNOUNCE_IN_MS + ANNOUNCE_HOLD_MS),
        setTimeout(() => this.#advanceAnnounceQueue(),
          ANNOUNCE_IN_MS + ANNOUNCE_HOLD_MS + ANNOUNCE_OUT_MS + 60),
      );
    });
  }
}
