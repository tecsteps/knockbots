/**
 * Knockbots — touch controls.
 *
 * The move list is authored in Tekken notation: four limb buttons, motion
 * inputs, and string continuations. A plain virtual pad reaches all of it in
 * principle and none of it in practice, because drawing a clean quarter-circle
 * on glass with no tactile feedback is the single hardest thing to ask of a
 * thumb. So the scheme here keeps the full move list addressable and removes
 * exactly the part that does not survive touch:
 *
 *   left thumb   a floating stick that appears wherever the thumb lands, so
 *                there is no fixed target to find without looking
 *   right thumb  the four limbs as a 2x2 panel — punches over kicks, left limb
 *                left of right limb, the order the notation is written in
 *   swipe        dragging across the limb cluster fires a motion special. The
 *                direction of the drag chooses the motion, so `qcf` is "swipe
 *                toward the opponent" rather than an arc to be drawn
 *   two fingers  overdrive, which is deliberately awkward to hit by accident
 *
 * Everything is emitted as the same `Command` shape `Input.js` builds for
 * keyboard and gamepad, so combat, the AI and the move matcher never learn that
 * touch exists.
 *
 * Directions here are RAW (screen space). `Input.commandsFor()` applies the
 * fighter's facing, exactly as it does for the other two sources.
 *
 * ---------------------------------------------------------------------------
 * Geometry, and why these numbers
 *
 * All of it is measured on an iPhone 13 in landscape: 844x390 CSS px over a
 * 139.8x64.6mm display, so 1 CSS px = 0.166mm (460ppi at a device pixel ratio
 * of 3, not the 0.183mm a "CSS px is a point" shorthand gives). The first cut of
 * this pad placed the limbs on a diagonal parallelogram sized as percentages of
 * the cluster box, and an automated tap sweep over the cluster found two defects
 * that the eye had not:
 *
 *   - The rows were 40px apart while the buttons were 66px across, so 1 and 3
 *     (and 2 and 4) overlapped by 26px of diameter and their hit circles by
 *     36px. `#limbAt` returned the first match in map order, so the top of the
 *     kick buttons fired a punch. Tapping the north edge of 4 (RK) produced 2
 *     (RP) — a punch when the player asked for a kick.
 *   - Sweeping a 7x7 grid over the cluster, 24 of 49 cells fired nothing at
 *     all: half of what looks like a control surface was dead.
 *
 * The layout below is therefore built from the button size outward — pitch =
 * button + gap, cluster = button + pitch — so an overlap is not expressible.
 * `#limbAt` now takes the nearest centre with no radius at all, which is safe
 * because the listener lives on the cluster and every point inside a 2x2 panel
 * has an unambiguous nearest button. That turns the 12px gutter from dead
 * space into slop that resolves the way the thumb intended.
 *
 * Reach, from a right-thumb pivot just off the bottom-right corner, at that
 * 0.166mm/px: the near kick is 13.6mm away, the two middle limbs 24.5mm, the far
 * punch 31.9mm and the overdrive pad 34.8mm. A comfortable thumb sweep is about
 * 35mm, so all four limbs sit inside it and overdrive sits exactly on the line —
 * and there is nowhere better to put it. Four 10.9mm buttons plus their gutters
 * consume the whole bottom-right quadrant of a 64.6mm-tall display; the obvious
 * alternative, docking it left of the cluster along the floor, measures 37.8mm,
 * further out than where it already is. So overdrive keeps the two-finger
 * gesture as the way it is actually thrown from a settled hand, and the pad is
 * the affordance that teaches the mechanic exists.
 *
 * What the pad should not do is sit at full contrast over the middle of the
 * arena — which on a 390px-tall screen is exactly where it is — for the whole
 * of a round in which it does nothing. It is inert until the meter fills, so it
 * rests dimmed and going bright is the ready signal.
 *
 * A 9x9 tap sweep over the cluster and a 24-step angular swipe sweep both pass
 * as authored: no dead cells, every cell resolves to its nearest button, and
 * the four motions own the sectors the constants below claim (qcf/qcb 105deg,
 * dp/dd 75deg). The numbers are therefore left alone.
 */

import { bus } from './Bus.js';

/**
 * Phases the pad belongs on screen for — the same set `HUD.js` shows itself
 * for, so the two appear and leave together. Everything else (`boot`, `menu`,
 * `select`, `matchEnd`, `replay`) is a front-end screen whose own controls the
 * pad must not be sitting on top of.
 */
const IN_PLAY_PHASES = new Set(['intro', 'ready', 'fight', 'ko', 'roundEnd']);

const DEAD_ZONE = 12;      // px of radial travel before the stick reads at all
/**
 * How far the nub is drawn from the ring's centre at full deflection.
 *
 * Purely visual: `#placeStick` clamps the deflection to this before snapping it,
 * and clamping preserves direction, so the eight-way result is identical either
 * way. It is 30 because that is what keeps the nub inside its own ring — the
 * ring is 118px across with a 2px border (57px of inner radius) and the nub is
 * 52px across (26px of radius), so 31px is the furthest the nub's edge can travel
 * before it breaks the ring's inner edge. At the previous 44 it visibly spilled
 * out of the ring on any full deflection, which reads as a broken widget rather
 * than a stick at its limit.
 */
const FULL_TILT = 30;
const CARDINAL_ARC = 56;   // deg each cardinal owns; the four diagonals split the rest
const SWIPE_MIN = 44;      // px from touchdown to lift to count as a motion
const SWIPE_ARC = 105;     // deg each of forward/back owns; up/down split the rest

/**
 * Snap a stick vector to one of eight directions.
 *
 * The previous rule thresholded each axis independently, which makes the dead
 * zone a *square*: measured, the stick needed 14px of travel to register a
 * cardinal and 20px to register a diagonal, and between those two radii a
 * deliberate diagonal came out as whichever cardinal crossed first. A radial
 * gate plus an angular snap removes both artefacts, and lets the cardinals be
 * widened past their natural 45deg: holding a clean back to block is the most
 * used stick input in the game, and a thumb sweeping away from its pivot
 * travels on an arc rather than a straight line, so the sectors that must be
 * *held* get the tolerance and the diagonals — which are tapped, not held —
 * give it up.
 *
 * @param {number} dx screen-space deflection, px
 * @param {number} dy screen-space deflection, px (y grows downward)
 * @returns {{ x: number, y: number }} -1/0/1 per axis, y positive up
 */
function snapDirection(dx, dy) {
  if (Math.hypot(dx, dy) < DEAD_ZONE) return { x: 0, y: 0 };
  let deg = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  const cell = Math.floor(deg / 90) * 90;
  const within = deg - cell;
  const half = CARDINAL_ARC / 2;
  const snapped = within < half ? cell : within > 90 - half ? cell + 90 : cell + 45;
  const rad = (snapped * Math.PI) / 180;
  return { x: Math.round(Math.cos(rad)) || 0, y: Math.round(Math.sin(rad)) || 0 };
}

/** Limb buttons on a 2x2 panel: punches on the top row, kicks below. */
const LIMBS = [
  { id: 1, label: '1', tag: 'LP', gx: 0, gy: 0 },
  { id: 2, label: '2', tag: 'RP', gx: 1, gy: 0 },
  { id: 3, label: '3', tag: 'LK', gx: 0, gy: 1 },
  { id: 4, label: '4', tag: 'RK', gx: 1, gy: 1 },
];

const CSS = `
.kbt-root {
  position: fixed; inset: 0; z-index: 40; pointer-events: none;
  touch-action: none; -webkit-user-select: none; user-select: none;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  transition: opacity .25s ease;

  /* One name per inset, defaulting through the shared token in ui.css so the
     HUD and the pad hold the same edge, and falling back to env() so the pad
     still clears a notch if it is ever mounted without that stylesheet. */
  --kbt-sa-r: var(--kb-sa-r, env(safe-area-inset-right, 0px));
  --kbt-sa-b: var(--kb-sa-b, env(safe-area-inset-bottom, 0px));
  --kbt-sa-l: var(--kb-sa-l, env(safe-area-inset-left, 0px));

  /* The whole pad derives from these four. Pitch is button + gap, and the
     cluster is button + pitch, so the 2x2 panel can never overlap itself. */
  --kbt-btn: 66px;
  --kbt-gap: 12px;
  --kbt-pitch: calc(var(--kbt-btn) + var(--kbt-gap));
  --kbt-edge: 16px;
  --kbt-floor: 14px;
}
/* Inert, not merely invisible. Hiding the pad with opacity alone left the stick
   catchment hit-testable across the whole lower-left of the screen, including
   over the menus — on a landscape phone that swallowed the taps for eight of the
   ten character tiles and the BACK button, which is what was reported as the
   select screen "not being responsive". Opacity hides it; pointer-events is what
   stops it stealing input. */
.kbt-root.kbt-off { opacity: 0; }
.kbt-root.kbt-off > * { pointer-events: none !important; }

/* The whole lower-left quadrant is the stick's catchment, so the thumb never
   has to find a target. The ring only becomes visible once it is holding one.
   Capped in px as well as percent, because a percentage of a tall viewport
   reaches far past anything a thumb can do: the drawn stick's own worst case is
   the 118px ring plus a full 44px deflection either way, 206px, so 60%/300px is
   the envelope with slack rather than an arbitrary band. The previous 70% put
   the catchment's top edge at y=117 on an 844x390 phone, 13px inside the combo
   counter's box — measured, the one place the pad and the HUD still met. */
.kbt-stickzone {
  position: absolute; left: var(--kbt-sa-l); bottom: var(--kbt-sa-b);
  width: min(46%, 330px); height: min(60%, 300px); pointer-events: auto;
}
.kbt-ring, .kbt-nub {
  position: absolute; border-radius: 50%; opacity: 0; transition: opacity .12s ease;
  transform: translate(-50%, -50%); will-change: transform, opacity;
}
.kbt-ring { width: 118px; height: 118px; border: 2px solid rgba(120,190,255,.34); background: rgba(10,16,26,.30); }
.kbt-nub  { width: 52px; height: 52px; background: rgba(150,210,255,.42); border: 2px solid rgba(190,230,255,.75); }
.kbt-stickzone.kbt-live .kbt-ring, .kbt-stickzone.kbt-live .kbt-nub { opacity: 1; }

.kbt-cluster {
  position: absolute;
  right: calc(var(--kbt-edge) + var(--kbt-sa-r));
  bottom: calc(var(--kbt-floor) + var(--kbt-sa-b));
  width: calc(var(--kbt-btn) + var(--kbt-pitch));
  height: calc(var(--kbt-btn) + var(--kbt-pitch));
  pointer-events: auto; touch-action: none;
}
.kbt-btn {
  position: absolute;
  left: calc(var(--gx) * var(--kbt-pitch));
  top: calc(var(--gy) * var(--kbt-pitch));
  width: var(--kbt-btn); height: var(--kbt-btn); border-radius: 50%;
  display: grid; place-items: center;
  background: radial-gradient(circle at 34% 30%, rgba(58,84,120,.92), rgba(16,26,42,.92));
  border: 2px solid rgba(126,180,240,.5);
  box-shadow: 0 3px 0 rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.16);
  color: #dbeaff; transition: transform .06s ease, background .06s ease;
}
.kbt-btn b { font-size: 21px; font-weight: 700; line-height: 1; }
.kbt-btn i { font-size: 8.5px; letter-spacing: .16em; font-style: normal; color: #7fa2cc; margin-top: 3px; }
.kbt-btn.kbt-down {
  transform: scale(.9);
  background: radial-gradient(circle at 34% 30%, rgba(255,168,74,.95), rgba(150,72,16,.95));
  border-color: rgba(255,206,142,.9);
}

/* Overdrive sits one row above the limbs, hard against the screen edge — the
   furthest-out control on the pad, right on the 35mm line, and no alternative
   placement measures nearer (see the reach note in the header). So two fingers
   anywhere on the cluster remains the way it is actually thrown and this pad is
   the affordance that teaches the mechanic exists. It rests at low opacity
   because it is inert until the meter fills: at full contrast it was a lit pill
   hanging over the fighters at mid-screen for most of a round, and going bright
   is worth more as the ready signal than as a permanent obstruction. */
.kbt-od {
  position: absolute;
  right: calc(var(--kbt-edge) + var(--kbt-sa-r));
  bottom: calc(var(--kbt-floor) + var(--kbt-sa-b) + var(--kbt-btn) + var(--kbt-pitch) + 12px);
  width: 84px; height: 38px; border-radius: 19px; pointer-events: auto;
  display: grid; place-items: center; letter-spacing: .18em; font-size: 10px;
  color: #9fe3ff; background: rgba(12,26,40,.85); border: 1px solid rgba(80,200,255,.45);
  opacity: .4; transition: opacity .2s ease, transform .06s ease;
}
.kbt-od.kbt-ready {
  opacity: 1;
  color: #062330; background: linear-gradient(180deg, #8fe6ff, #34b6e6); border-color: #bff2ff;
}
.kbt-od.kbt-down { transform: scale(.92); }

/* BLOCK.
   Holding back guards, and on a keyboard that is free because the hand is
   already on the direction keys. On glass it is not: the left thumb is on a
   floating stick, so blocking means finding and holding a precise direction
   while the right thumb attacks, and letting go of it to walk forward drops the
   guard. Reported from play as simply missing, and it was -- there was no block
   affordance on the pad at all.

   It sits on the LEFT, above the stick zone, for the reason the header's reach
   note gives for putting overdrive where it is: four 10.9mm limb buttons plus
   their gutters already consume the whole bottom-right quadrant of a 64.6mm
   display, and overdrive is at 34.8mm, exactly on the edge of a comfortable
   35mm sweep. There is no room on the right. The left thumb, by contrast, rests
   on a stick that has no fixed position and therefore no fixed obstruction, and
   guard is the input it holds rather than taps -- so it belongs on that hand.

   Holding back still guards. This does not replace it; it gives the mechanic a
   surface for players who never discover that back is also block. */
.kbt-blk {
  position: absolute;
  left: calc(var(--kbt-edge) + var(--kbt-sa-l));
  bottom: calc(var(--kbt-floor) + var(--kbt-sa-b) + var(--kbt-btn) + var(--kbt-pitch) + 12px);
  width: 84px; height: 38px; border-radius: 19px; pointer-events: auto;
  display: grid; place-items: center; letter-spacing: .18em; font-size: 10px;
  color: #cfd8e6; background: rgba(14,20,30,.85); border: 1px solid rgba(150,170,200,.4);
  opacity: .55; transition: opacity .2s ease, transform .06s ease;
}
.kbt-blk.kbt-down {
  transform: scale(.92); opacity: 1;
  color: #0b1420; background: linear-gradient(180deg, #dfe8f4, #9fb3cc); border-color: #eef4ff;
}

/* Fires on a successful swipe so the player learns the gesture landed. Offset by
   the cluster's own width rather than a tuned constant, which puts it entirely
   to the left of both the limbs and the overdrive pad: at the old 96px its right
   third sat in the gap the thumb crosses travelling between the two, so the one
   piece of feedback confirming a motion landed was printed under the hand that
   had just drawn it. */
.kbt-flash {
  position: absolute;
  right: calc(var(--kbt-edge) + var(--kbt-sa-r) + var(--kbt-btn) + var(--kbt-pitch) + 12px);
  bottom: calc(var(--kbt-floor) + var(--kbt-sa-b) + var(--kbt-btn) + var(--kbt-pitch) + 16px);
  padding: 6px 12px; white-space: nowrap;
  border-radius: 4px; font-size: 10px; letter-spacing: .2em; color: #08131f;
  background: #ffae4a; opacity: 0; transform: translateY(6px);
  transition: opacity .16s ease, transform .16s ease;
}
.kbt-flash.kbt-show { opacity: 1; transform: translateY(0); }

/* A fighting game needs the pair side by side and the stick and limbs under
   opposite thumbs. In a tall frame the fighters are two slivers and the pad
   overruns the edge, so ask for the rotation instead of pretending. */
.kbt-rotate {
  position: absolute; inset: 0; display: none; place-items: center; text-align: center;
  pointer-events: auto; color: #cfe6ff;
  background: radial-gradient(120% 90% at 50% 45%, rgba(13,20,34,.95), rgba(5,7,12,.99) 70%);
}
.kbt-root.kbt-portrait .kbt-rotate { display: grid; }
.kbt-root.kbt-portrait .kbt-stickzone,
.kbt-root.kbt-portrait .kbt-cluster,
.kbt-root.kbt-portrait .kbt-od,
.kbt-root.kbt-portrait .kbt-blk,
.kbt-root.kbt-portrait .kbt-flash { display: none; }
.kbt-phone {
  width: 58px; height: 96px; margin: 0 auto 26px; border-radius: 11px;
  border: 2px solid rgba(126,180,240,.7); background: rgba(20,32,52,.7);
  box-shadow: inset 0 0 0 4px rgba(5,8,14,.9), 0 0 26px rgba(80,160,255,.22);
  animation: kbtRotate 2.4s cubic-bezier(.6,0,.2,1) infinite;
}
@keyframes kbtRotate {
  0%, 22% { transform: rotate(0deg); }
  48%, 88% { transform: rotate(-90deg); }
  100% { transform: rotate(0deg); }
}
.kbt-rotate b { display: block; font-size: 15px; font-weight: 700; letter-spacing: .28em; color: #ffae4a; }
.kbt-rotate i { display: block; margin-top: 10px; font-size: 10px; font-style: normal; letter-spacing: .22em; color: #5f7c9e; }

/* Tablets and anything with real vertical room take a bigger, more spaced pad —
   the reach envelope grows with the device, the thumb does not shrink. */
@media (min-height: 500px) {
  .kbt-root { --kbt-btn: 82px; --kbt-gap: 14px; --kbt-edge: 22px; --kbt-floor: 20px; }
  .kbt-btn b { font-size: 25px; }
  .kbt-od, .kbt-blk { width: 96px; height: 44px; border-radius: 22px; }
}
`;

export class TouchControls {
  /**
   * @param {HTMLElement} host element to mount into (the UI overlay is fine)
   * @param {{ enabled?: boolean }} [opts]
   */
  constructor(host, opts = {}) {
    // Whether the pad is live. `Input` reads touch only while this is true, and
    // it is derived from match state rather than from the first touch — see
    // `#applyLiveness`.
    this.active = false;
    this.axis = { x: 0, y: 0 };
    /** Held while the BLOCK pad is down. Read by Input.commandsFor as `cmd.guard`. */
    this.guard = false;
    this.held = new Set();
    this.pressed = new Set();
    this.motion = null;
    this._motionTtl = 0;

    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
    /** Top-left of `.kbt-stickzone`, sampled per gesture — see `#placeStick`. */
    this._zoneOrigin = { x: 0, y: 0 };
    /** Live cluster touches, keyed by touch identifier — a swipe has to survive
     * a second finger landing for overdrive, which a single slot could not. */
    this._drags = new Map();

    // Decide from the device, not from a first touch. The pad used to mount
    // hidden with `display: none` and reveal itself on touchstart, which cannot
    // work: a display:none element receives no events, so the touch that was
    // meant to wake it never arrived. Gate on the same signal the boot legend
    // uses — a coarse primary pointer that cannot hover.
    const coarse = typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches
      && matchMedia('(hover: none)').matches;
    this.supported = typeof window !== 'undefined'
      && (coarse || navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
    if (!this.supported || opts.enabled === false) return;

    this.#mount(host);

    /** Latest phase seen on the bus. Unset until the first match, so the pad
     * starts inert and the title screen is never under it. */
    this._phase = null;
    this._portrait = false;
    /**
     * Whether a pad is wanted on this device at all.
     *
     * A coarse pointer is a handset: the answer is yes before anything is
     * touched. Anything that merely *reports* touch support — a laptop with a
     * touchscreen, whose owner is on the keyboard — has to prove a finger is in
     * use, and it cannot prove it through the pad, because an inert pad receives
     * no events. That is the same paradox the `display: none` version had, so
     * the proof comes from a one-shot listener on the window instead, which
     * fires whether the pad is hit-testable or not.
     */
    this._touchProven = coarse;
    if (!coarse) {
      this._onFirstTouch = () => {
        this._touchProven = true;
        window.removeEventListener('touchstart', this._onFirstTouch, true);
        this.#applyLiveness();
      };
      window.addEventListener('touchstart', this._onFirstTouch, { capture: true, passive: true });
    }

    /*
     * Go fullscreen on a handset, on the first touch.
     *
     * A player's screenshot showed the game squeezed between Brave's URL bar and
     * its bottom toolbar — a 2340x1080 phone rendering the fight into roughly
     * half its height, with the touch buttons crowding the fighters. Browser
     * chrome is not free real estate on a device this size, and a fighting game
     * needs the width.
     *
     * It has to be the FIRST TOUCH and nothing earlier: every engine gates
     * requestFullscreen on a user gesture and rejects it outside one, so calling
     * it at boot silently fails. Coarse pointers only, because forcing a desktop
     * browser fullscreen because someone clicked would be hostile. The promise
     * rejection is swallowed on purpose — iOS Safari does not implement
     * requestFullscreen on non-video elements at all, and a console error there
     * would be noise about a platform limitation rather than a defect.
     *
     * Orientation lock is attempted separately and is allowed to fail on its
     * own: it is unsupported on iOS and rejects when the device is not already
     * in the requested orientation, and neither case should cost us fullscreen.
     */
    if (coarse) {
      this._onFirstGesture = () => {
        window.removeEventListener('touchend', this._onFirstGesture, true);
        window.removeEventListener('pointerup', this._onFirstGesture, true);
        const el = document.documentElement;
        if (!document.fullscreenElement && el.requestFullscreen) {
          el.requestFullscreen({ navigationUI: 'hide' })
            .then(() => screen.orientation?.lock?.('landscape'))
            .catch(() => {});
        }
      };
      window.addEventListener('touchend', this._onFirstGesture, { capture: true, passive: true });
      window.addEventListener('pointerup', this._onFirstGesture, { capture: true, passive: true });
    }

    // The rotate prompt is for real handsets only. A desktop window dragged
    // narrow is not a device that can be turned, and telling its owner to
    // rotate it would be nonsense.
    if (coarse && typeof matchMedia === 'function') {
      this._orient = matchMedia('(orientation: portrait)');
      this._onOrient = () => this.#applyOrientation();
      this._orient.addEventListener('change', this._onOrient);
      this.#applyOrientation();
    }

    this._unsub = bus.on('phase', ({ phase }) => {
      this._phase = phase;
      this.#applyLiveness();
    });
    this.#applyLiveness();
  }

  /**
   * Decide whether the pad should be live, from match state rather than from
   * whoever touched the screen first.
   *
   * Revealing on first touch could not work once `kbt-off` started killing
   * `pointer-events` — which it has to, since an invisible-but-hit-testable
   * stick catchment covers the lower-left of every front-end screen and was
   * swallowing the taps for most of the character-select grid. So liveness is
   * derived instead: in play, on a device that wants a pad.
   *
   * Portrait overrides all of it, because the rotate prompt is the one thing
   * that must appear on a screen the game cannot be played on at all — the
   * select grid's own layout does not survive a 390px-wide frame either, so
   * asking for the rotation on the front end is right rather than premature.
   */
  #applyLiveness() {
    this.setLive(this._portrait || (this._touchProven && IN_PLAY_PHASES.has(this._phase)));
  }

  #mount(host) {
    const doc = host.ownerDocument;
    if (!doc.getElementById('kbt-style')) {
      const style = doc.createElement('style');
      style.id = 'kbt-style';
      style.textContent = CSS;
      doc.head.appendChild(style);
    }

    const root = doc.createElement('div');
    root.className = 'kbt-root kbt-off';
    root.innerHTML = `
      <div class="kbt-stickzone"><div class="kbt-ring"></div><div class="kbt-nub"></div></div>
      <div class="kbt-cluster"></div>
      <div class="kbt-od">OD</div>
      <div class="kbt-blk">BLOCK</div>
      <div class="kbt-flash"></div>
      <div class="kbt-rotate"><div>
        <div class="kbt-phone"></div>
        <b>ROTATE YOUR DEVICE</b>
        <i>KNOCKBOTS PLAYS IN LANDSCAPE</i>
      </div></div>`;
    host.appendChild(root);

    this.root = root;
    this.zone = root.querySelector('.kbt-stickzone');
    this.ring = root.querySelector('.kbt-ring');
    this.nub = root.querySelector('.kbt-nub');
    this.cluster = root.querySelector('.kbt-cluster');
    this.odEl = root.querySelector('.kbt-od');
    this.blkEl = root.querySelector('.kbt-blk');
    this.flashEl = root.querySelector('.kbt-flash');

    // Position comes from the grid cell alone; the pitch that separates the
    // cells is the same value the cluster is sized from, so the panel tiles
    // exactly and cannot be tuned into an overlap from here.
    this.btnEls = new Map();
    for (const l of LIMBS) {
      const el = doc.createElement('div');
      el.className = 'kbt-btn';
      el.dataset.id = String(l.id);
      el.style.setProperty('--gx', String(l.gx));
      el.style.setProperty('--gy', String(l.gy));
      el.innerHTML = `<b>${l.label}</b><i>${l.tag}</i>`;
      this.cluster.appendChild(el);
      this.btnEls.set(l.id, el);
    }

    this.#bind();
  }

  #bind() {
    const opt = { passive: false };

    this.zone.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      this._stickId = t.identifier;
      this._stickOrigin = { x: t.clientX, y: t.clientY };
      // Measured once per gesture, not per move: the catchment cannot be
      // relaid out while a finger is down on it, and `touchmove` fires often
      // enough that a rect read there is a forced layout per frame.
      const z = this.zone.getBoundingClientRect();
      this._zoneOrigin = { x: z.left, y: z.top };
      this.#placeStick(t.clientX, t.clientY, t.clientX, t.clientY);
      this.zone.classList.add('kbt-live');
      e.preventDefault();
    }, opt);

    this.zone.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._stickId) continue;
        this.#placeStick(this._stickOrigin.x, this._stickOrigin.y, t.clientX, t.clientY);
        e.preventDefault();
      }
    }, opt);

    const endStick = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this._stickId) continue;
        this._stickId = null;
        this.axis.x = 0;
        this.axis.y = 0;
        this.zone.classList.remove('kbt-live');
      }
    };
    this.zone.addEventListener('touchend', endStick, opt);
    this.zone.addEventListener('touchcancel', endStick, opt);

    // The cluster owns its touches wholesale rather than putting listeners on
    // each button: a swipe has to be tracked across button boundaries, and a
    // thumb that starts on 1 and ends on 2 is a gesture, not two presses.
    this.cluster.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        const id = this.#limbAt(t.clientX, t.clientY);
        this._drags.set(t.identifier, { x0: t.clientX, y0: t.clientY, limb: id });
        if (id) this.#down(id);
      }
      /*
       * TWO FINGERS ON THE CLUSTER IS A THROW, NOT AN OVERDRIVE.
       *
       * It used to be overdrive, and that made throws UNREACHABLE on a handset:
       * every throw in the game is a chord -- `1+2`, `b+1+2`, `f+1+3` -- and any
       * two-finger tap was swallowed as a super before the two buttons could be
       * read. A whole mechanic was unreachable on the platform most people play
       * on, and the player asked for throws without knowing that was why.
       *
       * Overdrive does not lose anything: it has its own pad, and that pad now
       * works -- the move was `qcf+5` until this session, so a tap sent the
       * button with no motion and the gesture was the only way to throw a super
       * at all. With `5` as a bare input the pad is the honest affordance and
       * the gesture is redundant.
       *
       * `#limbAt` has already resolved each finger to its nearest button, so the
       * chord comes out of the two limbs actually touched rather than being
       * hardcoded to 1+2 -- which is what makes `f+1+3` reachable too. The move
       * matcher gathers a chord across up to 4 ticks (CHORD_TICKS), so two
       * fingers landing a frame apart is still one throw.
       */
      e.preventDefault();
    }, opt);

    this.cluster.addEventListener('touchmove', (e) => {
      if (this._drags.size) e.preventDefault();
    }, opt);

    const endCluster = (e) => {
      for (const t of e.changedTouches) {
        const d = this._drags.get(t.identifier);
        if (!d) continue;
        this._drags.delete(t.identifier);
        // Decide swipe-versus-press from where the finger actually lifted, not
        // from a latch set the first time it crossed the threshold: a thumb
        // that wanders out and rolls back has not drawn a direction, and the
        // latch used to hand `#resolveSwipe` a near-zero vector to read one
        // out of anyway.
        if (Math.hypot(t.clientX - d.x0, t.clientY - d.y0) >= SWIPE_MIN) {
          this.#resolveSwipe(d, t.clientX, t.clientY);
        } else if (d.limb) {
          this.#up(d.limb);
        }
      }
      // The paired release for the old two-finger overdrive gesture is gone with
      // it. Leaving it would have raised button 5 on every second lift anywhere
      // on the cluster, cancelling an overdrive the OD pad was legitimately
      // holding -- the pad and the gesture shared one button and only one of
      // them still exists.
    };
    this.cluster.addEventListener('touchend', endCluster, opt);
    this.cluster.addEventListener('touchcancel', endCluster, opt);

    this.odEl.addEventListener('touchstart', (e) => {
      this.#down(5); this.odEl.classList.add('kbt-down'); e.preventDefault();
    }, opt);
    /*
     * BLOCK is a HELD state, not a button press, so it does not go through
     * `#down`/`#up` -- there is no limb 6. It sets a flag that
     * `Input.commandsFor` reads straight into `cmd.guard`, which is the same
     * field the keyboard's Q sets, so combat never learns where a guard came
     * from. `touchcancel` matters here more than anywhere else on the pad: a
     * guard stuck on because a call arrived mid-round would be unlosable.
     */
    const blkDown = (e) => { this.guard = true; this.blkEl.classList.add('kbt-down'); e.preventDefault(); };
    const blkUp = (e) => { this.guard = false; this.blkEl.classList.remove('kbt-down'); e.preventDefault(); };
    this.blkEl.addEventListener('touchstart', blkDown, opt);
    this.blkEl.addEventListener('touchend', blkUp, opt);
    this.blkEl.addEventListener('touchcancel', blkUp, opt);

    const endOd = (e) => { this.#up(5); this.odEl.classList.remove('kbt-down'); e.preventDefault(); };
    this.odEl.addEventListener('touchend', endOd, opt);
    this.odEl.addEventListener('touchcancel', endOd, opt);
  }

  /**
   * Show and enable the pad, or hide and disable it. `active` gates whether
   * `Input` reads touch at all, so releasing it also drops any held button —
   * otherwise a limb held when a round ended would stay held into the menu.
   * @param {boolean} live
   */
  setLive(live) {
    const on = !!live;
    if (on === this.active) return;
    this.active = on;
    this.root.classList.toggle('kbt-off', !on);
    if (!on) {
      this.held.clear();
      this.pressed.clear();
      this.motion = null;
      this.axis.x = 0;
      this.axis.y = 0;
      this._stickId = null;
      // `_drags`, not a `_swipe` slot: cluster touches have been tracked per
      // identifier since two fingers had to coexist for overdrive, and leaving
      // that map populated meant a finger still down when the pad went inert
      // resolved into a press or a motion the moment it lifted.
      this._drags.clear();
      this.zone.classList.remove('kbt-live');
      for (const [, el] of this.btnEls) el.classList.remove('kbt-down');
    }
  }

  /**
   * Swap the pad for the rotate prompt while the handset is held upright.
   * Clearing the inputs is `setLive`'s job on the way out; on the way *in* it
   * still has to happen here, because nothing can be held through a rotation
   * the player is being asked to make and a direction left stuck down would
   * keep driving the fighter behind the prompt.
   */
  #applyOrientation() {
    this._portrait = this._orient.matches;
    this.root.classList.toggle('kbt-portrait', this._portrait);
    if (this._portrait) {
      this.axis.x = 0;
      this.axis.y = 0;
      this.held.clear();
      this._drags.clear();
      this._stickId = null;
    }
    this.#applyLiveness();
  }

  /**
   * Draw the floating stick at the thumb.
   *
   * The offset is taken against `.kbt-stickzone`, which is what the ring and
   * nub are actually positioned inside — they are `position: absolute` children
   * of the catchment, and the catchment is itself positioned, so it is their
   * containing block. Measuring against `.kbt-root` instead put the ring
   * exactly `stickzone.top` px *below* the finger: 117px on an 844x390 phone,
   * and 780px — entirely off the bottom of the screen — in a 1080p window,
   * where the catchment is capped at 300px tall against a much taller viewport.
   * The axis was always correct, so this never broke movement; it meant the
   * primary movement control had no visible feedback anywhere it was drawn.
   * @param {number} ox touchdown, client space
   * @param {number} oy touchdown, client space
   * @param {number} x current position, client space
   * @param {number} y current position, client space
   */
  #placeStick(ox, oy, x, y) {
    const o = this._zoneOrigin ?? { x: 0, y: 0 };
    this.ring.style.transform = `translate(${ox - o.x}px, ${oy - o.y}px) translate(-50%, -50%)`;
    let dx = x - ox, dy = y - oy;
    const len = Math.hypot(dx, dy);
    if (len > FULL_TILT) { dx = (dx / len) * FULL_TILT; dy = (dy / len) * FULL_TILT; }
    this.nub.style.transform = `translate(${ox - o.x + dx}px, ${oy - o.y + dy}px) translate(-50%, -50%)`;

    // Snap to eight directions. A fighting game reads discrete directions, and
    // an analog value here would only be quantised downstream anyway.
    const dir = snapDirection(dx, dy);
    this.axis.x = dir.x;
    this.axis.y = dir.y;
  }

  /**
   * Which limb button sits under a screen point.
   *
   * Nearest centre, with no capture radius: the listener that calls this lives
   * on the cluster, and every point inside a 2x2 panel has one unambiguous
   * nearest button, so the gutter between them behaves as slop instead of dead
   * space. The old radius test dropped a quarter of the cluster and — because
   * it returned the first match in map order rather than the closest — handed
   * overlapping buttons to whichever was declared first.
   * @param {number} x
   * @param {number} y
   * @returns {number|null} button id, or null if the cluster has no buttons
   */
  #limbAt(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const [id, el] of this.btnEls) {
      const r = el.getBoundingClientRect();
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < bestDist) { bestDist = d; best = id; }
    }
    return best;
  }

  /**
   * Turn a drag across the cluster into a motion input. Forward and back are
   * screen-relative here; `Input.commandsFor` flips them for the fighter's
   * facing along with everything else.
   *
   * Forward and back own a wider sector than up and down, which is the
   * opposite of what a symmetric split would give them. The right thumb pivots
   * near the bottom-right corner, so an outward flick is an arc that gains
   * height on the way: measured on the symmetric split, a swipe aimed straight
   * forward came out as `qcf` only between -30 and +30 degrees and turned into
   * `dp` from +45 up. Forward and back are also the motions the move list
   * leans on hardest, so they get the tolerance.
   * @param {{ x0: number, y0: number, limb: number|null }} drag
   * @param {number} x lift position
   * @param {number} y lift position
   */
  #resolveSwipe(drag, x, y) {
    const dx = x - drag.x0, dy = y - drag.y0;
    const limb = drag.limb ?? this.#limbAt(x, y) ?? 2;
    const deg = Math.abs((Math.atan2(-dy, dx) * 180) / Math.PI);
    const horizontal = deg <= SWIPE_ARC / 2 || deg >= 180 - SWIPE_ARC / 2;
    const motion = horizontal ? (dx > 0 ? 'qcf' : 'qcb') : (dy < 0 ? 'dp' : 'dd');

    this.motion = motion;
    this._motionTtl = 8;   // ticks; long enough for the matcher to see it
    this.pressed.add(limb);
    this.#up(limb);

    this.flashEl.textContent = `${motion.toUpperCase()} + ${limb}`;
    this.flashEl.classList.add('kbt-show');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this.flashEl.classList.remove('kbt-show'), 420);
  }

  #down(id) {
    if (!this.held.has(id)) this.pressed.add(id);
    this.held.add(id);
    this.btnEls.get(id)?.classList.add('kbt-down');
  }

  #up(id) {
    this.held.delete(id);
    this.btnEls.get(id)?.classList.remove('kbt-down');
  }

  /** Reflect meter state so the overdrive pad reads as available. */
  setMeterReady(ready) {
    this.odEl?.classList.toggle('kbt-ready', !!ready);
  }

  /**
   * The screen boxes a playing pair of thumbs covers, so anything the player
   * has to *read* can be kept out of them.
   *
   * Two boxes, both derived from geometry rather than guessed. On the right it
   * is the limb cluster unioned with the overdrive pad — real opaque controls,
   * so their own rects are the answer. On the left the catchment is 330x273 and
   * deliberately huge (the point of a floating stick is that there is no target
   * to find), but a thumb does not cover 330x273; it rests at the corner and
   * draws a ring there. So the left box is the drawn stick's own worst case —
   * the ring plus a full deflection of nub travel in each direction — anchored
   * at the corner the hand comes in from.
   *
   * Measured need for this: with a fighter pushed to either wall, damage
   * callouts project to (821, 184) and (197, 141) on an 844x390 screen, which
   * are inside the overdrive pad and inside the stick's footprint respectively.
   *
   * Measured fresh rather than memoised. A cache here has to be invalidated on
   * everything that can move the pad — resize, orientation, a safe-area inset
   * arriving late — and one taken on the first frame of a match, before the
   * stylesheet that positions the pad has applied, is wrong for the rest of the
   * round with nothing to correct it. The caller only asks when it actually has
   * a callout to place, which is a few times a combo rather than every frame, so
   * three rect reads is the cheaper of the two options as well as the safer one.
   * @returns {{ left: number, top: number, right: number, bottom: number }[]}
   *   client-space boxes, empty while the pad is not driving anything
   */
  thumbZones() {
    if (!this.active || !this.root || this.root.classList.contains('kbt-portrait')) return [];
    const zones = [];
    const z = this.zone?.getBoundingClientRect();
    if (z) {
      const span = (this.ring?.offsetWidth || 118) + FULL_TILT * 2;
      zones.push({
        left: z.left, top: Math.max(z.top, z.bottom - span),
        right: Math.min(z.right, z.left + span), bottom: z.bottom,
      });
    }
    const boxes = [this.cluster, this.odEl].filter(Boolean).map((el) => el.getBoundingClientRect());
    if (boxes.length) {
      zones.push({
        left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)),
        right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)),
      });
    }
    return zones;
  }

  /**
   * Called once per tick by `Input`. Clears the edge-triggered sets after they
   * have been read, exactly as the keyboard path does.
   */
  endTick() {
    this.pressed.clear();
    if (this._motionTtl > 0 && --this._motionTtl === 0) this.motion = null;
  }

  dispose() {
    this._unsub?.();
    clearTimeout(this._flashT);
    this._orient?.removeEventListener('change', this._onOrient);
    if (this._onFirstGesture) {
      window.removeEventListener('touchend', this._onFirstGesture, true);
      window.removeEventListener('pointerup', this._onFirstGesture, true);
    }
    if (this._onFirstTouch) window.removeEventListener('touchstart', this._onFirstTouch, true);
    this.root?.remove();
  }
}
