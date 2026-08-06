/**
 * Knockbots — input, buffering and motion recognition.
 *
 * Produces a `Command` object per fighter per tick. Attack buttons follow the
 * Tekken limb mapping — 1 = left punch, 2 = right punch, 3 = left kick,
 * 4 = right kick — because the whole move list is authored in that notation.
 *
 * Directions are *relative to the fighter's facing*: `f` is toward the
 * opponent, `b` is away. The raw axis is converted per fighter using its
 * `facing` sign, so a move list never has to care which side it is on.
 *
 * @typedef {Object} Command
 * @property {number} x        -1..1 relative horizontal (f positive)
 * @property {number} y        -1..1 (up positive)
 * @property {boolean} up, down, fwd, back
 * @property {Set<number>} pressed   buttons pressed this tick (1..4, 5=overdrive)
 * @property {Set<number>} held
 * @property {string} notation  resolved notation token for this tick, e.g. "f+2"
 * @property {string[]} buffer  last N notation tokens, newest last
 * @property {?string} motion   'qcf'|'qcb'|'dp'|'hcf'|'dd'|'ff'|'bb' if recognised
 */

import { INPUT_BUFFER_TICKS, MOTION_WINDOW_TICKS } from './Constants.js';

const KEYMAP = {
  // Player 1 — WASD + JKLI, overdrive on U
  0: {
    up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
    b1: ['KeyJ'], b2: ['KeyK'], b3: ['KeyN'], b4: ['KeyM'], b5: ['KeyU'],
    guard: ['KeyQ'],
  },
  // Player 2 — arrows + numpad
  1: {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    b1: ['Numpad4', 'KeyF'], b2: ['Numpad5', 'KeyG'], b3: ['Numpad1', 'KeyV'], b4: ['Numpad2', 'KeyB'], b5: ['Numpad7', 'KeyT'],
    guard: ['Numpad0', 'KeyR'],
  },
};

const DIR_NUMPAD = { '-1,-1': 1, '0,-1': 2, '1,-1': 3, '-1,0': 4, '0,0': 5, '1,0': 6, '-1,1': 7, '0,1': 8, '1,1': 9 };

export class Input {
  constructor(target = window) {
    this.keys = new Set();
    this.prevKeys = new Set();
    this.gamepads = [null, null];
    this.tick = 0;

    /** Per player: rolling history of { tick, dir:number(numpad), buttons:number[] } */
    this.history = [[], []];
    this.commands = [this.#blankCommand(), this.#blankCommand()];

    this.enabled = true;

    this._onDown = (e) => {
      if (!this.enabled) return;
      if (e.repeat) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    this._onUp = (e) => { this.keys.delete(e.code); };
    this._onBlur = () => this.keys.clear();

    target.addEventListener('keydown', this._onDown, { passive: false });
    target.addEventListener('keyup', this._onUp);
    target.addEventListener('blur', this._onBlur);
    this.target = target;
  }

  dispose() {
    this.target.removeEventListener('keydown', this._onDown);
    this.target.removeEventListener('keyup', this._onUp);
    this.target.removeEventListener('blur', this._onBlur);
  }

  #blankCommand() {
    return {
      x: 0, y: 0, up: false, down: false, fwd: false, back: false,
      pressed: new Set(), held: new Set(), notation: '', buffer: [], motion: null,
    };
  }

  beginTick(tick) {
    this.tick = tick;
    this.#pollGamepads();
  }

  endTick() {
    this.prevKeys = new Set(this.keys);
    this.touch?.endTick();
  }

  #pollGamepads() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    for (let i = 0; i < 2; i++) this.gamepads[i] = pads[i] || null;
  }

  /**
   * Attach a touch pad. Player 0 only — a second thumb pair on one screen is
   * not a thing, and P2 on mobile is the CPU.
   * @param {import('./TouchControls.js').TouchControls} touch
   */
  attachTouch(touch) {
    this.touch = touch;
  }

  #rawAxis(player) {
    // Touch wins outright once it has been used, rather than being merged: a
    // phone has no keyboard to blend with, and merging would let a stale key
    // fight the stick.
    if (player === 0 && this.touch?.active) {
      return { x: Math.sign(this.touch.axis.x), y: Math.sign(this.touch.axis.y) };
    }

    const km = KEYMAP[player];
    let x = 0, y = 0;
    if (km.right.some((k) => this.keys.has(k))) x += 1;
    if (km.left.some((k) => this.keys.has(k))) x -= 1;
    if (km.up.some((k) => this.keys.has(k))) y += 1;
    if (km.down.some((k) => this.keys.has(k))) y -= 1;

    const pad = this.gamepads[player];
    if (pad) {
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      if (Math.abs(ax) > 0.4) x = Math.sign(ax);
      if (Math.abs(ay) > 0.4) y = -Math.sign(ay);
      if (pad.buttons[12]?.pressed) y = 1;
      if (pad.buttons[13]?.pressed) y = -1;
      if (pad.buttons[14]?.pressed) x = -1;
      if (pad.buttons[15]?.pressed) x = 1;
    }
    return { x: Math.sign(x), y: Math.sign(y) };
  }

  /**
   * Is the dedicated guard key held?
   *
   * Touch keeps guard on back, because a thumbstick has no spare key and the
   * pad's own layout already separates movement from the four limb buttons.
   */
  #guardHeld(player) {
    if (player === 0 && this.touch?.active) return false;
    const codes = KEYMAP[player]?.guard || [];
    if (codes.some((k) => this.keys.has(k))) return true;
    const pad = this.gamepads[player];
    return !!(pad && pad.buttons[6]?.pressed);
  }

  #buttons(player) {
    if (player === 0 && this.touch?.active) {
      return { held: new Set(this.touch.held), pressed: new Set(this.touch.pressed) };
    }
    const km = KEYMAP[player];
    const held = new Set();
    const pressed = new Set();
    const pad = this.gamepads[player];
    const PAD_BTN = { 1: 2, 2: 3, 3: 0, 4: 1, 5: 5 };

    for (let b = 1; b <= 5; b++) {
      const codes = km[`b${b}`] || [];
      const down = codes.some((k) => this.keys.has(k)) || (pad && pad.buttons[PAD_BTN[b]]?.pressed);
      const was = codes.some((k) => this.prevKeys.has(k));
      if (down) held.add(b);
      if (down && !was) pressed.add(b);
    }
    return { held, pressed };
  }

  /**
   * @param {number} player
   * @param {{facing:number}} fighter — facing is +1 if looking toward -X... the
   *   fighter reports `facing` as +1 when the opponent is at greater X.
   * @returns {Command}
   */
  commandsFor(player, fighter) {
    const cmd = this.commands[player];
    const raw = this.#rawAxis(player);
    const facing = fighter?.facing ?? 1;

    cmd.x = raw.x * facing;
    cmd.y = raw.y;
    cmd.fwd = cmd.x > 0;
    cmd.back = cmd.x < 0;
    cmd.up = cmd.y > 0;
    cmd.down = cmd.y < 0;
    /*
     * Guard is its own key, so BACK can be a direction again.
     *
     * Block used to be "hold back", which is the fighting-game default and is
     * why a player reported being unable to walk backwards: Fighter#tickNeutral
     * returns at the isBlocking branch above the walk branch, so loco.walkBack
     * was wired up and unreachable. Measured -- holding back moved the fighter
     * -0.040m and put it in blockHigh, while holding forward moved it +0.733m
     * and played the walk.
     *
     * The player proposed Q and that is the right key: it frees the whole b+
     * command column (roundhouse on b+4, spin kick on b+3) to be used while
     * actually retreating, which is how those moves are meant to come out.
     */
    // The touch pad now has a real BLOCK button, so it feeds the same field Q
    // does rather than relying on hold-back alone. Reported from play as a
    // missing control, and it was: on a keyboard the guard is free because the
    // hand is already on the direction keys, but on glass the left thumb is on a
    // FLOATING stick, so blocking meant holding a precise direction that has no
    // fixed position while the other thumb attacks -- and releasing it to walk
    // forward dropped the guard.
    cmd.guard = this.#guardHeld(player) || (player === 0 && !!this.touch?.guard);
    // Hold-back still guards on touch. The pad is an addition, not a
    // replacement: players who already know back-to-block keep it.
    cmd.touchGuard = player === 0 && !!this.touch?.active;

    const { held, pressed } = this.#buttons(player);
    cmd.held = held;
    cmd.pressed = pressed;

    const dir = DIR_NUMPAD[`${cmd.x},${cmd.y}`] ?? 5;
    const hist = this.history[player];
    const last = hist[hist.length - 1];
    if (!last || last.dir !== dir || pressed.size) {
      hist.push({ tick: this.tick, dir, buttons: [...pressed] });
      while (hist.length && this.tick - hist[0].tick > INPUT_BUFFER_TICKS) hist.shift();
    }

    cmd.notation = this.#notation(cmd, pressed);
    cmd.buffer = hist.map((h) => h.dir).join('') ? hist.map((h) => String(h.dir)) : [];
    // A recognised swipe is authoritative — the pad already decided what the
    // player meant, and re-deriving it from the snapped 8-way history would
    // only lose that intent.
    cmd.motion = (player === 0 && this.touch?.active && this.touch.motion)
      ? this.touch.motion
      : this.#motion(hist);
    return cmd;
  }

  #notation(cmd, pressed) {
    if (!pressed.size) return '';
    const btns = [...pressed].sort().join('+');
    let pre = '';
    if (cmd.fwd && cmd.down) pre = 'df';
    else if (cmd.back && cmd.down) pre = 'db';
    else if (cmd.fwd && cmd.up) pre = 'uf';
    else if (cmd.back && cmd.up) pre = 'ub';
    else if (cmd.fwd) pre = 'f';
    else if (cmd.back) pre = 'b';
    else if (cmd.up) pre = 'u';
    else if (cmd.down) pre = 'd';
    return pre ? `${pre}+${btns}` : btns;
  }

  /** Recognise classic motions from the recent direction history. */
  #motion(hist) {
    /*
     * CONSECUTIVE DUPLICATE DIRECTIONS ARE COLLAPSED, AND WITHOUT THAT A HELD
     * DIRECTION SYNTHESISED A MOTION THAT NOBODY ENTERED.
     *
     * `commandsFor` pushes a fresh history entry on ANY tick a button is
     * pressed, not only when the direction changes. So holding down and
     * pressing a button wrote `2` twice, `/2.*2/` matched, and the input came
     * out as `dd` -- a double-tap-down motion the player never made. Measured
     * through real key events: holding down and pressing 2 produced
     * `siegeSlam`, an 86-frame UNBLOCKABLE, where the player asked for
     * `duckingStraight`; holding down and pressing 3 produced `groundSpike`
     * instead of `lowKick`. The same duplicate turned a held back into `bb`,
     * which is why back+RP and back+RK were reported as not working -- they
     * were resolving, just to the wrong move.
     *
     * A real double-tap passes through neutral -- `6,5,6` -- so it survives the
     * dedupe. A held direction is `6,6` and collapses to one. That is exactly
     * the distinction the motion test needs and was not making.
     *
     * WHY MY OWN AUDIT MISSED IT: I verified the state/button matrix by driving
     * `findMove` with a hand-built buffer and reported 12/12. A synthesised
     * buffer cannot contain this defect, because the defect is created upstream
     * in the history the real input path writes. Testing the matcher is not
     * testing the game.
     */
    const recent = hist.filter((h) => this.tick - h.tick <= MOTION_WINDOW_TICKS)
      .map((h) => h.dir)
      .filter((d, i, a) => d !== a[i - 1]);
    const s = recent.join('');
    // Directions here are already facing-relative: 6 = forward, 4 = back.
    if (/2[\s]*3[\s]*6/.test(s)) return 'qcf';
    if (/2[\s]*1[\s]*4/.test(s)) return 'qcb';
    if (/6[\s]*2[\s]*3/.test(s)) return 'dp';
    if (/4[\s]*1[\s]*2[\s]*3[\s]*6/.test(s)) return 'hcf';
    if (/2.*2/.test(s.replace(/5/g, ''))) return 'dd';
    const dashes = recent.filter((d) => d !== 5);
    if (dashes.length >= 2 && dashes.slice(-2).every((d) => d === 6)) return 'ff';
    if (dashes.length >= 2 && dashes.slice(-2).every((d) => d === 4)) return 'bb';
    return null;
  }
}
