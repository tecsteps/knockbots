/**
 * Knockbots — the boot-screen control legend.
 *
 * Two things this has to get right, and the first is a correctness issue rather
 * than a presentation one.
 *
 * **It must not lie about which key to press.** `Input.js` matches on
 * `KeyboardEvent.code`, which identifies a key by its *physical position*, not
 * by the character printed on it. `KeyW` is the key one row above and one to the
 * right of the leftmost home-row letter — on QWERTY that cap reads "W", on
 * AZERTY it reads "Z", on Dvorak "," and on QWERTZ "W" again. A legend that
 * hard-codes "W" is wrong for a large fraction of the world. So the label for
 * each key is resolved at runtime through the Keyboard Map API, which reports
 * what the user's own layout prints on that physical key, and falls back to the
 * US label only where the API is unavailable (currently Safari and Firefox).
 *
 * **It should show the keys where they actually are.** A flat row of caps makes
 * the reader translate names into positions. Laying WASD out as an inverted T,
 * and the attack cluster in its true relative arrangement with the usual
 * half-key row stagger, means the shape can be matched against the keyboard
 * without reading at all.
 *
 * Which scheme is shown is decided from the device: telling someone holding a
 * controller about WASD is worse than showing nothing, and showing a keyboard
 * legend on a phone is worse still.
 *
 * The key codes below MUST agree with `KEYMAP` in `Input.js`. They are duplicated
 * rather than imported because the legend renders during boot, before the game's
 * module graph is loaded — it must not wait on a 1MB bundle to tell a player
 * which key punches.
 *
 * ---------------------------------------------------------------------------
 * This file is also the *vocabulary* for talking about a button anywhere else.
 *
 * The move list has to print an input like `qcf+2` in a form a player can act
 * on, and what "2" is called depends entirely on what they are holding: the
 * touch pad prints `2`, the keyboard legend prints `K` (or whatever their own
 * layout puts on that physical key), a gamepad prints `Y`. Three names for one
 * thing, and if they are enumerated in two files they will disagree. So
 * `BUTTONS` below is the single table, `ATTACK_KEYS` is derived from it, and
 * `buttonLabel()` is how every other module asks what to call button N.
 *
 * `limb` ("LP"/"RP"/"LK"/"RK") is the fourth name, and the only one that is the
 * same on every device — it is what lets a move list caption a chip without
 * knowing what the player is holding.
 */

/** @typedef {'keyboard'|'gamepad'|'touch'} Scheme */

/**
 * Physical key positions, as (row, col) on the standard alphanumeric block.
 * Row 0 is the QWERTY row, row 1 the home row, row 2 the bottom row. Columns
 * count from the left of each row. Rows are drawn with a half-column stagger,
 * which is what makes the shape recognisable.
 */
const MOVE_KEYS = [
  { code: 'KeyW', us: 'W', row: 0, col: 1, axis: 'up' },
  { code: 'KeyA', us: 'A', row: 1, col: 0, axis: 'left' },
  { code: 'KeyS', us: 'S', row: 1, col: 1, axis: 'down' },
  { code: 'KeyD', us: 'D', row: 1, col: 2, axis: 'right' },
];

/**
 * The movement keys by screen axis, for anything that has to say "the arrows in
 * this move list are these keys". Screen axis, not facing: which of left/right
 * is "toward the opponent" flips with the side of the arena a fighter is on,
 * and no legend can resolve that — which is exactly why the move list draws
 * directions as arrows relative to the opponent rather than naming a key.
 * @type {Record<'up'|'down'|'left'|'right', {code:string, us:string}>}
 */
export const MOVE_AXES = Object.fromEntries(
  MOVE_KEYS.map((k) => [k.axis, { code: k.code, us: k.us }]),
);

/** The guard key, in the same shape. */
export const GUARD_KEY = { code: 'KeyQ', us: 'Q' };

// Guard sits beside the movement cluster rather than with the limb buttons:
// it is held like a direction, and its physical Q position makes that clear at
// a glance. `tag` annotates the cap while `listTag` keeps the compact key list
// below it in the same "Q  BLOCK" form as the attack legend.
const GUARD_KEYS = [
  { ...GUARD_KEY, row: 0, col: 0, tag: 'BLOCK', listTag: GUARD_KEY.us, label: 'Block' },
];

/**
 * The four limbs and overdrive, in notation order, with every name each one
 * goes by. `n` is the digit the move list is authored in; `touch` is what the
 * pad prints; `us` is the US-QWERTY cap for `code`; `pad` is the gamepad face
 * button; `limb` is the device-independent abbreviation.
 *
 * @typedef {Object} ButtonDef
 * @property {number} n          1..5, as written in move notation
 * @property {string} code       physical key, must match KEYMAP in Input.js
 * @property {string} us         US-QWERTY cap for that key
 * @property {string} touch      what the touch pad prints
 * @property {string} pad        gamepad face/shoulder button
 * @property {string} limb       LP | RP | LK | RK | OD
 * @property {string} label      plain English
 * @property {string} kind       'punch' | 'kick' | 'super'
 * @property {number} row, col   physical position, for the boot legend only
 */
export const BUTTONS = [
  { n: 5, code: 'KeyU', us: 'U', touch: 'OD', pad: 'RB', limb: 'OD', label: 'Overdrive', kind: 'super', row: 0, col: 1 },
  { n: 1, code: 'KeyJ', us: 'J', touch: '1', pad: 'X', limb: 'LP', label: 'Left punch', kind: 'punch', row: 1, col: 0 },
  { n: 2, code: 'KeyK', us: 'K', touch: '2', pad: 'Y', limb: 'RP', label: 'Right punch', kind: 'punch', row: 1, col: 1 },
  { n: 3, code: 'KeyN', us: 'N', touch: '3', pad: 'A', limb: 'LK', label: 'Left kick', kind: 'kick', row: 2, col: 0 },
  { n: 4, code: 'KeyM', us: 'M', touch: '4', pad: 'B', limb: 'RK', label: 'Right kick', kind: 'kick', row: 2, col: 1 },
];

/** @type {Map<number, ButtonDef>} */
const BY_N = new Map(BUTTONS.map((b) => [b.n, b]));

/** The definition for a notation digit, or null. @returns {?ButtonDef} */
export function buttonDef(n) { return BY_N.get(Number(n)) || null; }

/**
 * What to call button `n` on the device the player is holding.
 *
 * `keyLabels` is an optional `code -> cap` map from `resolveKeyLabels()`; pass
 * it and a non-QWERTY player sees their own cap instead of ours. Everything
 * else falls back to the table, which is correct for touch and gamepad because
 * neither has a layout to vary.
 *
 * @param {number} n
 * @param {Scheme} scheme
 * @param {Map<string,string>} [keyLabels]
 * @returns {string}
 */
export function buttonLabel(n, scheme, keyLabels) {
  const b = buttonDef(n);
  if (!b) return String(n);
  if (scheme === 'touch') return b.touch;
  if (scheme === 'gamepad') return b.pad;
  return keyLabels?.get(b.code) || b.us;
}

// The boot legend wants the caps in physical order with a display tag; that is
// a projection of BUTTONS, not a second list of it.
const ATTACK_KEYS = BUTTONS.map((b) => ({
  code: b.code, us: b.us, row: b.row, col: b.col,
  tag: b.n === 5 ? 'OD' : String(b.n), label: b.label,
}));

const GAMEPAD = [
  { keys: ['L-stick'], label: 'Move' },
  ...BUTTONS.filter((b) => b.kind !== 'super')
    .sort((a, b) => a.n - b.n)
    .map((b) => ({ keys: [b.pad], label: `${b.n} · ${b.label}` })),
  { keys: [BY_N.get(5).pad], label: 'Overdrive' },
];

// ---------------------------------------------------------------------------
// Directions and motions — the other half of the vocabulary
// ---------------------------------------------------------------------------

/**
 * Directions as glyphs.
 *
 * These are **facing-relative**, exactly as `Input.commandsFor()` resolves them:
 * `f` is toward the opponent whichever side of the arena you are standing on.
 * That is the single fact a move list has to state out loud — see `FACING_NOTE`
 * — because it is the difference between an arrow being an instruction and an
 * arrow being a riddle.
 */
export const DIR_GLYPH = {
  f: '→', b: '←', u: '↑', d: '↓',
  df: '↘', db: '↙', uf: '↗', ub: '↖',
};

/** The same eight in words, for a caption or a screen reader. */
export const DIR_WORD = {
  f: 'forward', b: 'back', u: 'up', d: 'down',
  df: 'down-forward', db: 'down-back', uf: 'up-forward', ub: 'up-back',
};

export const FACING_NOTE = '→ is always toward your opponent, whichever side you are on.';

/**
 * Motion inputs, decomposed into the directions they are actually rolled
 * through. The sequences match what `Input.#motion()` recognises, so a player
 * following these arrows produces the motion the matcher is looking for — and
 * an agent editing one of the two has the other written next to it.
 */
export const MOTION_STEPS = {
  qcf: ['d', 'df', 'f'],
  qcb: ['d', 'db', 'b'],
  dp: ['f', 'd', 'df'],
  hcf: ['b', 'db', 'd', 'df', 'f'],
  dd: ['d', 'd'],
  ff: ['f', 'f'],
  bb: ['b', 'b'],
};

/** Each motion in plain English, for the caption line under the glyphs. */
export const MOTION_WORD = {
  qcf: 'roll down to forward',
  qcb: 'roll down to back',
  dp: 'forward, down, down-forward',
  hcf: 'half circle from back to forward',
  dd: 'tap down twice',
  ff: 'tap forward twice',
  bb: 'tap back twice',
};

/**
 * The touch shortcut for a motion, where one exists.
 *
 * `TouchControls` turns a drag across the limb cluster straight into a motion —
 * forward and back on the horizontal, `dp` and `dd` on the vertical — so on a
 * phone these four never have to be drawn on the stick at all. The other three
 * have no swipe and come out of the floating stick like any other direction,
 * which is why they are absent here rather than invented.
 */
export const MOTION_SWIPE_DIR = { qcf: 'f', qcb: 'b', dp: 'u', dd: 'd' };

/**
 * The same four as a caption fragment. Derived from `MOTION_SWIPE_DIR` rather
 * than written out again: a display string and its machine-readable form kept
 * in two hand-maintained tables is a drift waiting to happen, and a glyph
 * renderer needs the direction, not the sentence.
 *
 * No leading "or" — a fragment that carries its own conjunction can only be
 * used in the one sentence it was written for, and the move list's legend
 * already tried to use it in a second and came out with "can also be swiped: or
 * swipe → across the buttons". Callers supply their own joining word.
 */
export const MOTION_SWIPE = Object.fromEntries(
  Object.entries(MOTION_SWIPE_DIR)
    .map(([m, d]) => [m, `swipe ${DIR_GLYPH[d]} across the buttons`]),
);

/**
 * The whole swipe scheme in one line, for a legend.
 *
 * `MOTION_SWIPE` names one motion at a time, which is right in a caption under
 * the move it belongs to and wrong in a key — a touch player reading the key
 * learns one of the four shortcuts and never finds out the other three exist.
 * Built from the same table so it cannot list a swipe the pad does not accept.
 */
export const SWIPE_NOTE = `Any motion can be swiped across the buttons instead: ${
  [['qcf', 'toward'], ['qcb', 'away'], ['dp', 'rising'], ['dd', 'slam']]
    .map(([m, what]) => `${DIR_GLYPH[MOTION_SWIPE_DIR[m]]} ${what}`)
    .join(', ')
}.`;

/** What a player pushes to make a direction happen, per device. */
export const DIRECTION_SOURCE = {
  keyboard: 'movement keys',
  gamepad: 'left stick or D-pad',
  touch: 'left thumb stick',
};

const GUARD_PAD = 'LB';

/**
 * How guard is held, per device. Holding back guards on every device and always
 * has; the dedicated control is the one a player can find without being told.
 */
export function guardHint(scheme, labels) {
  if (scheme === 'touch') return 'Hold BLOCK, or hold ← away from your opponent.';
  if (scheme === 'gamepad') return `Hold ${GUARD_PAD}, or hold ← away from your opponent.`;
  return `Hold ${labels?.get(GUARD_KEY.code) || GUARD_KEY.us}, or hold ← away from your opponent.`;
}

// ---------------------------------------------------------------------------
// Cached layout labels
// ---------------------------------------------------------------------------

/**
 * Every code any legend or move list ever asks about, resolved once.
 *
 * `resolveKeyLabels` is an async permission-gated API call, and the move list
 * opens on a keypress — it cannot await anything without either flashing the US
 * caps or delaying the panel. So the answer is primed at boot (the legend
 * already pays for it) and read synchronously afterwards. `keyLabels()` is
 * therefore empty on the first call and populated forever after, which is
 * exactly the fallback behaviour the US labels were designed for.
 */
const ALL_CODES = [
  GUARD_KEY.code,
  ...MOVE_KEYS.map((k) => k.code),
  ...BUTTONS.map((b) => b.code),
];

/** @type {Map<string,string>} */
let LABEL_CACHE = new Map();
/** @type {?Promise<Map<string,string>>} */
let labelPromise = null;

/** The layout map resolved so far. Synchronous; may be empty. */
export function keyLabels() { return LABEL_CACHE; }

/** Resolve every key this module knows about, once per document. */
export function primeKeyLabels() {
  if (!labelPromise) {
    labelPromise = resolveKeyLabels(ALL_CODES).then((m) => {
      if (m.size) LABEL_CACHE = m;
      return LABEL_CACHE;
    });
  }
  return labelPromise;
}

/**
 * Detect the scheme the player is most likely holding.
 *
 * Order matters. A connected gamepad wins outright. Otherwise a device whose
 * primary pointer is coarse and which reports no hover is a touch device —
 * `maxTouchPoints` alone is not enough, because plenty of touch-capable laptops
 * are driven with a keyboard.
 *
 * @returns {Scheme}
 */
export function detectScheme() {
  if (typeof navigator !== 'undefined' && navigator.getGamepads) {
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected) return 'gamepad';
    }
  }
  if (typeof matchMedia === 'function') {
    const coarse = matchMedia('(pointer: coarse)').matches;
    const noHover = matchMedia('(hover: none)').matches;
    if (coarse && noHover) return 'touch';
  }
  return 'keyboard';
}

/**
 * Resolve physical key codes to the characters the user's own layout prints on
 * them. Returns a `code -> label` map. Where the Keyboard Map API is missing the
 * map comes back empty and callers fall back to the US labels.
 * @param {string[]} codes
 * @returns {Promise<Map<string,string>>}
 */
export async function resolveKeyLabels(codes) {
  const out = new Map();
  try {
    const map = await navigator.keyboard?.getLayoutMap?.();
    if (!map) return out;
    for (const code of codes) {
      const label = map.get(code);
      if (label) out.set(code, label.toUpperCase());
    }
  } catch {
    // Permissions policy can refuse this. The US fallback is correct for most
    // users and wrong for some, which is strictly better than being wrong for
    // everyone who is not on QWERTY.
  }
  return out;
}

/**
 * Render the legend into the boot screen. Draws immediately with US labels so
 * nothing waits on the layout query, then upgrades in place once it resolves.
 * @param {Document} doc
 * @param {Scheme} [scheme] override, for testing
 * @returns {Scheme}
 */
export function renderControlLegend(doc, scheme = detectScheme()) {
  const root = doc.getElementById('controls');
  const grid = doc.getElementById('controls-grid');
  const title = doc.getElementById('controls-title');
  const note = doc.getElementById('controls-note');
  if (!root || !grid) return scheme;

  // Started before the branch below: a gamepad player who later touches a
  // keyboard still gets their own caps in the move list, and the request is
  // idempotent.
  const primed = primeKeyLabels();

  title.textContent = scheme === 'gamepad' ? 'Gamepad detected'
    : scheme === 'touch' ? 'Touch device' : 'Keyboard';

  if (scheme === 'gamepad') {
    grid.className = 'grid';
    grid.replaceChildren(...GAMEPAD.map((r) => row(doc, r.keys, r.label)));
    note.hidden = true;
    root.hidden = false;
    return scheme;
  }

  // Keyboard and touch both show the key map: a phone player who pairs a
  // keyboard still needs it, and it is the only scheme that currently works.
  grid.className = 'keymap';
  grid.replaceChildren(
    cluster(doc, 'Move', [...GUARD_KEYS, ...MOVE_KEYS], GUARD_KEYS),
    cluster(doc, 'Attack', ATTACK_KEYS, ATTACK_KEYS),
  );

  if (scheme === 'touch') {
    note.textContent = 'Touch controls are active. A keyboard or gamepad also works.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  root.hidden = false;

  // Upgrade the caps to the user's real layout once the API answers. Primed
  // rather than resolved directly so the move list, which opens on a keypress
  // and cannot await anything, gets the same answer for free.
  primed.then((labels) => {
    if (!labels.size) return;
    for (const el of grid.querySelectorAll('kbd[data-code]')) {
      const l = labels.get(el.dataset.code);
      if (l && l !== el.textContent) el.textContent = l;
    }
  });

  return scheme;
}

/** One flat `keys + label` row, used for the gamepad scheme. */
function row(doc, keys, label) {
  const el = doc.createElement('div');
  el.className = 'row';
  const ks = doc.createElement('span');
  ks.className = 'keys';
  for (const k of keys) {
    const kbd = doc.createElement('kbd');
    kbd.textContent = k;
    ks.appendChild(kbd);
  }
  el.appendChild(ks);
  const lbl = doc.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = label;
  el.appendChild(lbl);
  return el;
}

/**
 * A positional cluster: the caps drawn where they physically sit, with a
 * half-column stagger per row, and a legend beside it naming what each does.
 */
function cluster(doc, heading, keys, withLabels) {
  const wrap = doc.createElement('div');
  wrap.className = 'kc';

  const h = doc.createElement('span');
  h.className = 'kc-h';
  h.textContent = heading;
  wrap.appendChild(h);

  const pad = doc.createElement('div');
  pad.className = 'kc-pad';
  const rows = Math.max(...keys.map((k) => k.row)) + 1;
  for (let r = 0; r < rows; r++) {
    const line = doc.createElement('div');
    line.className = 'kc-row';
    // Half-key stagger, the thing that makes a keyboard look like a keyboard.
    line.style.marginLeft = `${r * 0.5}em`;
    for (const k of keys.filter((x) => x.row === r).sort((a, b) => a.col - b.col)) {
      const kbd = doc.createElement('kbd');
      kbd.dataset.code = k.code;
      kbd.textContent = k.us;
      if (k.tag) kbd.dataset.tag = k.tag;
      line.appendChild(kbd);
    }
    pad.appendChild(line);
  }
  wrap.appendChild(pad);

  if (withLabels) {
    const list = doc.createElement('div');
    list.className = 'kc-list';
    for (const k of withLabels) {
      const li = doc.createElement('span');
      li.className = 'kc-li';
      li.innerHTML = `<b>${k.listTag || k.tag}</b>${k.label}`;
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }
  return wrap;
}
