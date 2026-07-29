/**
 * Knockbots — the boot-screen control legend.
 *
 * Which scheme a player is shown has to be decided from the device, not
 * guessed: telling someone holding a controller about WASD is worse than
 * showing nothing, and showing a keyboard legend on a phone is worse still.
 *
 * The mappings here MUST agree with `KEYMAP` and `PAD_BTN` in `Input.js`. They
 * are duplicated rather than imported because this renders during boot, before
 * the game module graph is loaded, and the legend is the first thing a player
 * reads — it must not wait on a 1MB bundle.
 *
 * Buttons follow the Tekken limb convention the whole move list is authored in:
 * 1 = left punch, 2 = right punch, 3 = left kick, 4 = right kick.
 */

/** @typedef {'keyboard'|'gamepad'|'touch'} Scheme */

const KEYBOARD = [
  { keys: ['W', 'A', 'S', 'D'], label: 'Move' },
  { keys: ['J'], label: '1 · Left punch' },
  { keys: ['K'], label: '2 · Right punch' },
  { keys: ['N'], label: '3 · Left kick' },
  { keys: ['M'], label: '4 · Right kick' },
  { keys: ['U'], label: 'Overdrive' },
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
 * Render the legend into the boot screen.
 * @param {Document} doc
 * @param {Scheme} [scheme] override, for testing
 */
export function renderControlLegend(doc, scheme = detectScheme()) {
  const root = doc.getElementById('controls');
  const grid = doc.getElementById('controls-grid');
  const title = doc.getElementById('controls-title');
  const note = doc.getElementById('controls-note');
  if (!root || !grid) return scheme;

  const rows = scheme === 'gamepad' ? GAMEPAD : KEYBOARD;
  title.textContent = scheme === 'gamepad' ? 'Gamepad detected' : scheme === 'touch' ? 'Touch device' : 'Keyboard';

  grid.replaceChildren(...rows.map((r) => {
    const row = doc.createElement('div');
    row.className = 'row';
    const keys = doc.createElement('span');
    keys.className = 'keys';
    for (const k of r.keys) {
      const kbd = doc.createElement('kbd');
      kbd.textContent = k;
      keys.appendChild(kbd);
    }
    row.appendChild(keys);
    const lbl = doc.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = r.label;
    row.appendChild(lbl);
    return row;
  }));

  if (scheme === 'touch') {
    // Say the true thing. Touch controls are not implemented yet, and a legend
    // that implies otherwise would send a phone player into a fight with no
    // way to act.
    note.textContent = 'Touch controls are still in development. Pair a keyboard or gamepad to play.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }

  root.hidden = false;
  return scheme;
}
