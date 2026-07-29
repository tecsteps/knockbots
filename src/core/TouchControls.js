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
 *   right thumb  the four limbs as a diamond — the layout an arcade player
 *                already has in muscle memory
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
 */

const DEAD_ZONE = 14;      // px before the stick reads as a direction at all
const FULL_TILT = 46;      // px for a fully deflected axis
const SWIPE_MIN = 38;      // px of travel across the cluster to count as a motion
const SWIPE_SLOPE = 0.7;   // |dy/dx| above this reads as vertical, not forward/back

/** Limb buttons, laid out as a diamond. Values are the button ids Input uses. */
const LIMBS = [
  { id: 1, label: '1', tag: 'LP', gx: 0, gy: 1 },
  { id: 2, label: '2', tag: 'RP', gx: 1, gy: 0 },
  { id: 3, label: '3', tag: 'LK', gx: 0, gy: 2 },
  { id: 4, label: '4', tag: 'RK', gx: 1, gy: 1 },
];

const CSS = `
.kbt-root {
  position: fixed; inset: 0; z-index: 40; pointer-events: none;
  touch-action: none; -webkit-user-select: none; user-select: none;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}
.kbt-root.kbt-off { opacity: 0; }
.kbt-root { transition: opacity .25s ease; }

/* The whole left half is the stick's catchment, so the thumb never has to find
   a target. The ring only becomes visible once it is holding one. */
.kbt-stickzone { position: absolute; left: 0; bottom: 0; width: 46%; height: 62%; pointer-events: auto; }
.kbt-ring, .kbt-nub {
  position: absolute; border-radius: 50%; opacity: 0; transition: opacity .12s ease;
  transform: translate(-50%, -50%); will-change: transform, opacity;
}
.kbt-ring { width: 118px; height: 118px; border: 2px solid rgba(120,190,255,.34); background: rgba(10,16,26,.30); }
.kbt-nub  { width: 52px; height: 52px; background: rgba(150,210,255,.42); border: 2px solid rgba(190,230,255,.75); }
.kbt-stickzone.kbt-live .kbt-ring, .kbt-stickzone.kbt-live .kbt-nub { opacity: 1; }

.kbt-cluster {
  position: absolute; right: 4.5vw; bottom: 5vh; width: 210px; height: 210px;
  pointer-events: auto; touch-action: none;
}
.kbt-btn {
  position: absolute; width: 82px; height: 82px; border-radius: 50%;
  display: grid; place-items: center; transform: translate(-50%, -50%);
  background: radial-gradient(circle at 34% 30%, rgba(58,84,120,.92), rgba(16,26,42,.92));
  border: 2px solid rgba(126,180,240,.5);
  box-shadow: 0 3px 0 rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.16);
  color: #dbeaff; transition: transform .06s ease, background .06s ease;
}
.kbt-btn b { font-size: 21px; font-weight: 700; line-height: 1; }
.kbt-btn i { font-size: 8.5px; letter-spacing: .16em; font-style: normal; color: #7fa2cc; margin-top: 3px; }
.kbt-btn.kbt-down {
  transform: translate(-50%, -50%) scale(.9);
  background: radial-gradient(circle at 34% 30%, rgba(255,168,74,.95), rgba(150,72,16,.95));
  border-color: rgba(255,206,142,.9);
}

/* Overdrive sits away from the limbs so a stray thumb cannot spend the meter. */
.kbt-od {
  position: absolute; right: 4.5vw; bottom: calc(5vh + 226px);
  width: 72px; height: 40px; border-radius: 20px; pointer-events: auto;
  display: grid; place-items: center; letter-spacing: .18em; font-size: 9px;
  color: #9fe3ff; background: rgba(12,26,40,.85); border: 1px solid rgba(80,200,255,.45);
}
.kbt-od.kbt-ready { color: #062330; background: linear-gradient(180deg, #8fe6ff, #34b6e6); border-color: #bff2ff; }
.kbt-od.kbt-down { transform: scale(.92); }

/* Fires on a successful swipe so the player learns the gesture landed. */
.kbt-flash {
  position: absolute; right: 4.5vw; bottom: calc(5vh + 226px); padding: 6px 12px;
  border-radius: 4px; font-size: 10px; letter-spacing: .2em; color: #08131f;
  background: #ffae4a; opacity: 0; transform: translateY(6px);
  transition: opacity .16s ease, transform .16s ease;
}
.kbt-flash.kbt-show { opacity: 1; transform: translateY(0); }

@media (max-height: 420px) {
  .kbt-cluster { width: 168px; height: 168px; bottom: 4vh; }
  .kbt-btn { width: 66px; height: 66px; }
  .kbt-btn b { font-size: 18px; }
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
    this._swipe = null;

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
      <div class="kbt-flash"></div>`;
    host.appendChild(root);

    this.root = root;
    this.zone = root.querySelector('.kbt-stickzone');
    this.ring = root.querySelector('.kbt-ring');
    this.nub = root.querySelector('.kbt-nub');
    this.cluster = root.querySelector('.kbt-cluster');
    this.odEl = root.querySelector('.kbt-od');
    this.flashEl = root.querySelector('.kbt-flash');

    // Diamond: 1 and 3 on the near column, 2 and 4 on the far one, so the
    // punch/kick rows read left-to-right the way the notation is written.
    this.btnEls = new Map();
    for (const l of LIMBS) {
      const el = doc.createElement('div');
      el.className = 'kbt-btn';
      el.dataset.id = String(l.id);
      el.style.left = `${l.gx === 0 ? 27 : 73}%`;
      el.style.top = `${[26, 50, 74][l.gy]}%`;
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
        this._swipe = { id: t.identifier, x0: t.clientX, y0: t.clientY, limb: id, moved: false };
        if (id) this.#down(id);
      }
      if (e.touches.length >= 2) this.#down(5); // two-finger overdrive
      e.preventDefault();
    }, opt);

    this.cluster.addEventListener('touchmove', (e) => {
      const s = this._swipe;
      if (!s) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== s.id) continue;
        if (Math.hypot(t.clientX - s.x0, t.clientY - s.y0) > SWIPE_MIN) s.moved = true;
      }
      e.preventDefault();
    }, opt);

    const endCluster = (e) => {
      const s = this._swipe;
      for (const t of e.changedTouches) {
        if (!s || t.identifier !== s.id) continue;
        if (s.moved) this.#resolveSwipe(s, t.clientX, t.clientY);
        this._swipe = null;
      }
      for (const id of [1, 2, 3, 4, 5]) this.#up(id);
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

  #placeStick(ox, oy, x, y) {
    const r = this.root.getBoundingClientRect();
    this.ring.style.transform = `translate(${ox - r.left}px, ${oy - r.top}px) translate(-50%, -50%)`;
    let dx = x - ox, dy = y - oy;
    const len = Math.hypot(dx, dy);
    if (len > FULL_TILT) { dx = (dx / len) * FULL_TILT; dy = (dy / len) * FULL_TILT; }
    this.nub.style.transform = `translate(${ox - r.left + dx}px, ${oy - r.top + dy}px) translate(-50%, -50%)`;

    // Snap to eight directions. A fighting game reads discrete directions, and
    // an analog value here would only be quantised downstream anyway.
    this.axis.x = Math.abs(dx) < DEAD_ZONE ? 0 : Math.sign(dx);
    this.axis.y = Math.abs(dy) < DEAD_ZONE ? 0 : -Math.sign(dy);
  }

  /** Which limb button, if any, sits under a screen point. */
  #limbAt(x, y) {
    for (const [id, el] of this.btnEls) {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (Math.hypot(x - cx, y - cy) <= r.width * 0.58) return id;
    }
    return null;
  }

  /**
   * Turn a drag across the cluster into a motion input. Forward and back are
   * screen-relative here; `Input.commandsFor` flips them for the fighter's
   * facing along with everything else.
   */
  #resolveSwipe(s, x, y) {
    const dx = x - s.x0, dy = y - s.y0;
    const limb = s.limb ?? this.#limbAt(x, y) ?? 2;
    let motion;
    if (Math.abs(dy) > Math.abs(dx) * SWIPE_SLOPE) motion = dy < 0 ? 'dp' : 'dd';
    else motion = dx > 0 ? 'qcf' : 'qcb';

    this.motion = motion;
    this._motionTtl = 8;   // ticks; long enough for the matcher to see it
    this.pressed.add(limb);
    this.held.add(limb);
    this._releaseAt = 3;

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
    if (this._releaseAt > 0 && --this._releaseAt === 0) {
      for (const id of [1, 2, 3, 4]) if (!this._swipe) this.#up(id);
    }
  }

  dispose() {
    clearTimeout(this._flashT);
    this.root?.remove();
  }
}
