/**
 * Knockbots — input notation, rendered for people who have not played Tekken.
 *
 * The move list is authored in fighting-game shorthand: `qcf+2`, `b+1,2`,
 * `df+1+2`. That shorthand is excellent and it is also completely opaque. This
 * game is played on a phone by people who have never seen it, and a move whose
 * input cannot be read is a move that does not exist.
 *
 * So nothing in the UI ever prints the raw string. Every input goes through
 * here and comes out as:
 *
 *   - **arrows**, not letters. `df` is `↘`. There is nothing to learn and
 *     nothing to translate, and the arrow is the shape the thumb draws.
 *   - **motions spelled out**, not named. `qcf` is `↓ ↘ →` and not the letters
 *     "qcf", because the letters are a name for a thing the player has to be
 *     told separately, whereas the three arrows *are* the instruction.
 *   - **buttons labelled the way the player's own device labels them.** The
 *     touch pad prints 1/2/3/4, the keyboard legend prints J/K/N/M (or whatever
 *     the player's layout puts on those physical keys), a gamepad prints
 *     X/Y/A/B. One table in `ControlLegend.js` owns all four names, and
 *     `buttonLabel()` is how this file asks. Under each chip sits the limb
 *     ("RP"), which is the same on every device and is what makes two players
 *     on different hardware able to talk to each other.
 *   - **a plain-English caption** on anything that is not a single button
 *     press, because "↓ ↘ → + K" is still a notation and "roll down to forward,
 *     then Right punch" is a sentence.
 *
 * Directions are facing-relative — `→` is toward the opponent on both sides of
 * the arena — and any surface that draws them owes the player `FACING_NOTE`
 * once, somewhere it can be read.
 *
 * The DOM built here is deliberately flat and class-driven: a move list is a
 * few hundred of these and they are built when the panel opens, so the cost has
 * to be a handful of elements per input and no layout reads at all.
 */

import { parseToken } from '../combat/Moves.js';
import {
  DIR_GLYPH, DIR_WORD, MOTION_STEPS, MOTION_WORD, MOTION_SWIPE,
  buttonDef, buttonLabel,
} from '../core/ControlLegend.js';

/**
 * One step of an input, i.e. one comma-separated token.
 * @typedef {Object} Step
 * @property {?string} motion   'qcf' | 'qcb' | 'dp' | 'hcf' | 'dd' | 'ff' | 'bb'
 * @property {string}  dir      '' | 'f' | 'b' | 'u' | 'd' | 'df' | 'db' | 'uf' | 'ub'
 * @property {number[]} buttons 1..5
 * @property {string}  raw
 */

/**
 * Split an authored input into its steps.
 * `parseToken` is imported rather than reimplemented so this file and the move
 * matcher can never disagree about what `db+4,3` means.
 * @param {string} input
 * @returns {Step[]}
 */
export function parseInput(input) {
  return String(input || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(parseToken);
}

// ---------------------------------------------------------------------------
// Glyph rendering
// ---------------------------------------------------------------------------

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** One direction arrow. */
function arrow(dir, extra = '') {
  const a = el('i', `kbn-arw${extra}`, DIR_GLYPH[dir] || '·');
  a.setAttribute('aria-hidden', 'true');
  return a;
}

/**
 * One button chip: the device's own label, with the limb under it.
 *
 * The limb line is not decoration. It is the only part of the chip that means
 * the same thing on a phone, a keyboard and a pad, so it is what a player reads
 * when the number they see on screen is not the number written in a guide —
 * and it is how the four chips stay distinguishable when a colourblind player
 * cannot use the punch/kick tint.
 */
function chip(n, scheme, labels) {
  const def = buttonDef(n);
  const c = el('span', `kbn-btn kbn-btn--${def?.kind || 'punch'}`);
  c.append(el('b', null, buttonLabel(n, scheme, labels)));
  if (def) c.append(el('i', null, def.limb));
  c.title = def ? `${def.label} — button ${def.n}` : `button ${n}`;
  return c;
}

/**
 * Render one input string as glyphs.
 *
 * @param {string} input
 * @param {Object} opts
 * @param {'keyboard'|'gamepad'|'touch'} opts.scheme
 * @param {Map<string,string>} [opts.labels]  layout map from ControlLegend
 * @returns {HTMLElement}
 */
export function renderNotation(input, { scheme = 'keyboard', labels } = {}) {
  const wrap = el('span', 'kbn');
  wrap.setAttribute('aria-label', describeInput(input, { scheme }));
  const steps = parseInput(input);

  steps.forEach((step, i) => {
    if (i > 0) {
      // The "then" mark. A comma would be read as part of the notation; a
      // chevron reads as sequence to anyone, in any language.
      const sep = el('i', 'kbn-then', '›');
      sep.setAttribute('aria-hidden', 'true');
      wrap.append(sep);
    }
    const g = el('span', 'kbn-step');

    if (step.motion) {
      const m = el('span', 'kbn-motion');
      for (const d of MOTION_STEPS[step.motion] || []) m.append(arrow(d));
      g.append(m);
    } else if (step.dir) {
      // A direction with a button on it is a position you are *in* when you
      // press, and gets the ring. A direction on its own is a tap in a
      // sequence — `d,b,d,2` — and must not look like the same instruction.
      g.append(arrow(step.dir, step.buttons.length ? ' kbn-arw--hold' : ''));
    }

    step.buttons.forEach((b, bi) => {
      if (bi > 0 || step.motion || step.dir) {
        const plus = el('i', 'kbn-plus', '+');
        plus.setAttribute('aria-hidden', 'true');
        g.append(plus);
      }
      g.append(chip(b, scheme, labels));
    });

    wrap.append(g);
  });

  return wrap;
}

// ---------------------------------------------------------------------------
// Plain English
// ---------------------------------------------------------------------------

/** "Left punch", or "Left punch + Right punch together" for a multi-button step. */
function buttonWords(buttons) {
  const names = buttons.map((b) => buttonDef(b)?.label || `button ${b}`);
  if (names.length <= 1) return names[0] || '';
  return `${names.join(' + ')} together`;
}

/**
 * Describe one input in a sentence.
 *
 * Used for the caption line, for `title`, and for `aria-label` — a screen
 * reader given "↓ ↘ → + K" reads out three arrow names and a letter, which is
 * worse than useless.
 *
 * @param {string} input
 * @param {{scheme?: string}} [opts]
 * @returns {string}
 */
export function describeInput(input, { scheme = 'keyboard' } = {}) {
  const steps = parseInput(input);
  // Clauses are built lower-case and the sentence is capitalised once at the
  // end, so a four-beat input does not come out as "Tap down, then Tap back,
  // then Tap down". Button names keep their capitals — they are the names of
  // controls, not ordinary words.
  const parts = steps.map((s) => {
    const btns = buttonWords(s.buttons);
    if (s.motion) {
      const roll = MOTION_WORD[s.motion] || s.motion;
      const swipe = scheme === 'touch' && MOTION_SWIPE[s.motion];
      const base = btns ? `${roll}, then ${btns}` : roll;
      return swipe ? `${base} (${swipe})` : base;
    }
    // A direction with no button is one beat of a sequence like `d,b,d,2`, not
    // a held stance. Without this branch it read "hold down and press " with
    // nothing after the verb, three times in a row, on the finisher — the one
    // input in the game that has to be unambiguous.
    if (s.dir) return btns ? `hold ${DIR_WORD[s.dir]} and press ${btns}` : `tap ${DIR_WORD[s.dir]}`;
    return btns;
  });
  return cap(parts.join(', then '));
}

/**
 * True when the input needs its caption shown rather than merely attached.
 *
 * A single button press is self-explanatory once the chip is on screen and a
 * caption under it would be noise repeated forty times down the list. Anything
 * with a motion, a held direction, two buttons at once or more than one step is
 * where a beginner actually stalls, so those get the sentence in the open.
 */
export function needsCaption(input) {
  const steps = parseInput(input);
  if (steps.length > 1) return true;
  const s = steps[0];
  return !!s && (!!s.motion || !!s.dir || s.buttons.length > 1);
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

/**
 * Notation styles, namespaced `kbn-`.
 *
 * Exported as a string rather than injected here, so the one panel that uses it
 * installs it with its own sheet and there is exactly one `<style>` for the
 * move list instead of two.
 */
export const KBN_CSS = `
.kbn {
  display: inline-flex; align-items: center; flex-wrap: wrap;
  gap: 0.25em; white-space: nowrap;
}
.kbn-step { display: inline-flex; align-items: center; gap: 0.16em; }
.kbn-motion {
  display: inline-flex; align-items: center; gap: 0.05em;
  padding: 0.1em 0.34em;
  background: rgba(120, 140, 180, 0.1);
  box-shadow: inset 0 0 0 1px var(--kb-line);
  clip-path: polygon(0.3em 0, 100% 0, calc(100% - 0.3em) 100%, 0 100%);
}
.kbn-arw {
  font-style: normal; font-size: 1.05em; line-height: 1;
  color: var(--kb-text-dim);
}
/* A held direction is a different instruction from a rolled one — it is a
   position, not a path — so it gets the ring the motion arrows do not. */
.kbn-arw--hold {
  color: var(--kb-text);
  padding: 0.12em 0.3em;
  box-shadow: inset 0 0 0 1px var(--kb-line-strong);
}
.kbn-plus { font-style: normal; font-size: 0.72em; color: var(--kb-text-faint); }
.kbn-then {
  font-style: normal; font-size: 0.95em; color: var(--kb-accent);
  padding: 0 0.1em;
}
.kbn-btn {
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  min-width: 1.9em; padding: 0.14em 0.3em 0.1em;
  line-height: 1;
  clip-path: polygon(0.28em 0, 100% 0, 100% calc(100% - 0.28em), calc(100% - 0.28em) 100%, 0 100%, 0 0.28em);
}
.kbn-btn b { font-size: 0.92em; font-weight: 800; letter-spacing: 0.02em; }
.kbn-btn i {
  font-style: normal; font-size: 0.5em; font-weight: 700; letter-spacing: 0.08em;
  opacity: 0.72; margin-top: 0.12em;
}
.kbn-btn--punch { background: rgba(63,224,255,0.14); color: var(--kb-cyan); box-shadow: inset 0 0 0 1px rgba(63,224,255,0.4); }
.kbn-btn--kick  { background: rgba(255,138,42,0.14); color: var(--kb-accent-soft); box-shadow: inset 0 0 0 1px rgba(255,138,42,0.42); }
.kbn-btn--super { background: rgba(255,207,74,0.16); color: var(--kb-gold); box-shadow: inset 0 0 0 1px rgba(255,207,74,0.45); }
`;
