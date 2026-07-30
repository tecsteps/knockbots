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
 * All of it is measured on an iPhone 13 in landscape (844x390 CSS px, where a
 * CSS px is a point, so 1px = 0.183mm). The first cut of this pad placed the
 * limbs on a diagonal parallelogram sized as percentages of the cluster box,
 * and an automated tap sweep over the cluster found two defects that the eye
 * had not:
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
 * Reach, from a right-thumb pivot just off the bottom-right corner: the near
 * kick is 12mm away, the far punch 33mm, and the overdrive pad 37mm. A
 * comfortable thumb sweep is about 35mm, so every limb sits inside it and
 * overdrive sits deliberately at the edge of it — it spends the whole meter and
 * should cost a small reach, not a brush. Its old position was 50mm out, over
 * the middle of the arena, and could not be hit without moving the hand.
 */

const DEAD_ZONE = 12;      // px of radial travel before the stick reads at all
const FULL_TILT = 44;      // px for a fully deflected axis
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
.kbt-root.kbt-off { opacity: 0; }

/* The whole lower-left quadrant is the stick's catchment, so the thumb never
   has to find a target. The ring only becomes visible once it is holding one.
   Capped in px as well as percent: on a tall screen a 70% band would reach
   halfway up the arena for no gain, since no thumb travels that far. */
.kbt-stickzone {
  position: absolute; left: var(--kbt-sa-l); bottom: var(--kbt-sa-b);
  width: min(46%, 330px); height: min(70%, 300px); pointer-events: auto;
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

/* Overdrive sits one row above the limbs, hard against the screen edge: far
   enough that a stray thumb cannot spend the meter, close enough to reach
   without lifting the palm, and out of the arena rather than floating over the
   middle of it. Two fingers anywhere on the cluster still does the same job. */
.kbt-od {
  position: absolute;
  right: calc(var(--kbt-edge) + var(--kbt-sa-r));
  bottom: calc(var(--kbt-floor) + var(--kbt-sa-b) + var(--kbt-btn) + var(--kbt-pitch) + 12px);
  width: 84px; height: 38px; border-radius: 19px; pointer-events: auto;
  display: grid; place-items: center; letter-spacing: .18em; font-size: 10px;
  color: #9fe3ff; background: rgba(12,26,40,.85); border: 1px solid rgba(80,200,255,.45);
}
.kbt-od.kbt-ready { color: #062330; background: linear-gradient(180deg, #8fe6ff, #34b6e6); border-color: #bff2ff; }
.kbt-od.kbt-down { transform: scale(.92); }

/* Fires on a successful swipe so the player learns the gesture landed. Sits
   beside the overdrive pad, not on top of it, and clear of the combo readout
   the HUD puts in this corner. */
.kbt-flash {
  position: absolute;
  right: calc(var(--kbt-edge) + var(--kbt-sa-r) + 96px);
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
  .kbt-od { width: 96px; height: 44px; border-radius: 22px; }
}
`;

export class TouchControls {
  /**
   * @param {HTMLElement} host element to mount into (the UI overlay is fine)
   * @param {{ enabled?: boolean }} [opts]
   */
  constructor(host, opts = {}) {
    this.active = false;              // true once a real touch has happened
    this.axis = { x: 0, y: 0 };
    this.held = new Set();
    this.pressed = new Set();
    this.motion = null;
    this._motionTtl = 0;

    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
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
    // The rotate prompt is for real handsets only. A desktop window dragged
    // narrow is not a device that can be turned, and telling its owner to
    // rotate it would be nonsense.
    if (coarse && typeof matchMedia === 'function') {
      this._orient = matchMedia('(orientation: portrait)');
      this._onOrient = () => this.#applyOrientation();
      this._orient.addEventListener('change', this._onOrient);
      this.#applyOrientation();
    }
    // Show immediately on a genuine touch device; on a touch-capable laptop
    // stay dimmed until a finger actually lands, so a mouse user is not given
    // a pad they never asked for.
    if (coarse) this.#wake();
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
      this.#wake();
      const t = e.changedTouches[0];
      this._stickId = t.identifier;
      this._stickOrigin = { x: t.clientX, y: t.clientY };
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
      this.#wake();
      for (const t of e.changedTouches) {
        const id = this.#limbAt(t.clientX, t.clientY);
        this._drags.set(t.identifier, { x0: t.clientX, y0: t.clientY, limb: id });
        if (id) this.#down(id);
      }
      if (e.touches.length >= 2) this.#down(5); // two-finger overdrive
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
      // Only drop overdrive once the second finger is genuinely gone. Releasing
      // every button on any lift used to cancel a held limb the other thumb was
      // still on.
      if (e.touches.length < 2) this.#up(5);
    };
    this.cluster.addEventListener('touchend', endCluster, opt);
    this.cluster.addEventListener('touchcancel', endCluster, opt);

    this.odEl.addEventListener('touchstart', (e) => {
      this.#wake(); this.#down(5); this.odEl.classList.add('kbt-down'); e.preventDefault();
    }, opt);
    const endOd = (e) => { this.#up(5); this.odEl.classList.remove('kbt-down'); e.preventDefault(); };
    this.odEl.addEventListener('touchend', endOd, opt);
    this.odEl.addEventListener('touchcancel', endOd, opt);
  }

  /** Reveal the pad the first time a finger touches the screen. */
  #wake() {
    if (this.active) return;
    this.active = true;
    this.root.classList.remove('kbt-off');
  }

  /** Swap the pad for the rotate prompt while the handset is held upright. */
  #applyOrientation() {
    const portrait = this._orient.matches;
    this.root.classList.toggle('kbt-portrait', portrait);
    if (portrait) {
      this.#wake();
      // Nothing can be held through a rotation the player is being asked to
      // make, and a direction left stuck down would still be driving the
      // fighter behind the prompt.
      this.axis.x = 0;
      this.axis.y = 0;
      this.held.clear();
      this._drags.clear();
      this._stickId = null;
    }
  }

  #placeStick(ox, oy, x, y) {
    const r = this.root.getBoundingClientRect();
    this.ring.style.transform = `translate(${ox - r.left}px, ${oy - r.top}px) translate(-50%, -50%)`;
    let dx = x - ox, dy = y - oy;
    const len = Math.hypot(dx, dy);
    if (len > FULL_TILT) { dx = (dx / len) * FULL_TILT; dy = (dy / len) * FULL_TILT; }
    this.nub.style.transform = `translate(${ox - r.left + dx}px, ${oy - r.top + dy}px) translate(-50%, -50%)`;

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
   * Called once per tick by `Input`. Clears the edge-triggered sets after they
   * have been read, exactly as the keyboard path does.
   */
  endTick() {
    this.pressed.clear();
    if (this._motionTtl > 0 && --this._motionTtl === 0) this.motion = null;
  }

  dispose() {
    clearTimeout(this._flashT);
    this._orient?.removeEventListener('change', this._onOrient);
    this.root?.remove();
  }
}
