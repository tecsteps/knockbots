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
 */

/** @typedef {'keyboard'|'gamepad'|'touch'} Scheme */

/**
 * Physical key positions, as (row, col) on the standard alphanumeric block.
 * Row 0 is the QWERTY row, row 1 the home row, row 2 the bottom row. Columns
 * count from the left of each row. Rows are drawn with a half-column stagger,
 * which is what makes the shape recognisable.
 */
const MOVE_KEYS = [
  { code: 'KeyW', us: 'W', row: 0, col: 1 },
  { code: 'KeyA', us: 'A', row: 1, col: 0 },
  { code: 'KeyS', us: 'S', row: 1, col: 1 },
  { code: 'KeyD', us: 'D', row: 1, col: 2 },
];

const ATTACK_KEYS = [
  { code: 'KeyU', us: 'U', row: 0, col: 1, tag: 'OD', label: 'Overdrive' },
  { code: 'KeyJ', us: 'J', row: 1, col: 0, tag: '1', label: 'Left punch' },
  { code: 'KeyK', us: 'K', row: 1, col: 1, tag: '2', label: 'Right punch' },
  { code: 'KeyN', us: 'N', row: 2, col: 0, tag: '3', label: 'Left kick' },
  { code: 'KeyM', us: 'M', row: 2, col: 1, tag: '4', label: 'Right kick' },
];

const GAMEPAD = [
  { keys: ['L-stick'], label: 'Move' },
  { keys: ['X'], label: '1 · Left punch' },
  { keys: ['Y'], label: '2 · Right punch' },
  { keys: ['A'], label: '3 · Left kick' },
  { keys: ['B'], label: '4 · Right kick' },
  { keys: ['RB'], label: 'Overdrive' },
];

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
    cluster(doc, 'Move', MOVE_KEYS, null),
    cluster(doc, 'Attack', ATTACK_KEYS, ATTACK_KEYS),
  );

  if (scheme === 'touch') {
    note.textContent = 'Touch controls are active. A keyboard or gamepad also works.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  root.hidden = false;

  // Upgrade the caps to the user's real layout once the API answers.
  resolveKeyLabels([...MOVE_KEYS, ...ATTACK_KEYS].map((k) => k.code)).then((labels) => {
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
      li.innerHTML = `<b>${k.tag}</b>${k.label}`;
      list.appendChild(li);
    }
    wrap.appendChild(list);
  }
  return wrap;
}
