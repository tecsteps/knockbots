/**
 * Knockbots — procedural display typeface.
 *
 * The charter forbids fetching fonts at runtime, and shipping a licensed
 * commercial face as an embedded base64 blob is not something we have rights
 * to do. So the HUD's headline text — names, timer, combo count, the big
 * round announcements — does not use a font file at all: every glyph below
 * is a small set of straight strokes (`bar` = axis-aligned rectangle, `seg`
 * = an arbitrary-angle thick line with square caps) laid out on a 32-unit
 * cap-height grid, in the spirit of the stencil/engineering lettering this
 * kind of hard-surface HUD actually references (compare Eurostile/Bank
 * Gothic, both built almost entirely from straight edges).
 *
 * A glyph's strokes are unioned into one SVG `<path>` and consumed as a CSS
 * `mask-image` data URI: `applyKbText()` builds (once) a small 3-layer stack
 * — cast shadow, metal-gradient body, top gloss — all sharing that mask, so
 * every headline word gets the same beveled, lit-metal treatment the bars
 * and panels already use, instead of falling back to whatever sans-serif
 * happens to be installed on the machine.
 *
 * `ui.css` owns the `.kb-text` presentation (colours, offsets, blend
 * modes); this module only knows geometry and DOM wiring.
 */

const H = 32; // shared cap height, in glyph units
const T = 5; // default stroke thickness
const TRACK = 5; // gap between glyphs, in glyph units

/** Axis-aligned stroke: (x, y) is the top-left corner. */
function bar(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** Arbitrary-angle thick line from (x0,y0) to (x1,y1), square-capped and
 *  slightly overshot at both ends so it always fills the joint it meets. */
function seg(x0, y0, x1, y1, t = T) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy * t * 0.5;
  const ny = ux * t * 0.5;
  const ex = ux * t * 0.5;
  const ey = uy * t * 0.5;
  const ax0 = x0 - ex;
  const ay0 = y0 - ey;
  const ax1 = x1 + ex;
  const ay1 = y1 + ey;
  return [[ax0 + nx, ay0 + ny], [ax1 + nx, ay1 + ny], [ax1 - nx, ay1 - ny], [ax0 - nx, ay0 - ny]];
}

/** Standard seven-segment digit, built from `bar()` only — every timer,
 *  combo and damage readout in the HUD routes through this shape set. */
function digit(bits, w = 20, t = T) {
  const [a, b, c, d, e, f, g] = bits;
  const quads = [];
  if (a) quads.push(bar(0, 0, w, t));
  if (d) quads.push(bar(0, H - t, w, t));
  if (g) quads.push(bar(0, 13.5, w, t));
  if (f) quads.push(bar(0, 0, t, 17));
  if (e) quads.push(bar(0, 15, t, 17));
  if (b) quads.push(bar(w - t, 0, t, 17));
  if (c) quads.push(bar(w - t, 15, t, 17));
  return { w, quads };
}

/** @type {Record<string, {w:number, quads:number[][][]}>} */
const GLYPHS = {
  '0': digit([1, 1, 1, 1, 1, 1, 0]),
  '1': { w: 13, quads: [bar(4, 0, 5, 32), seg(4, 0.5, 0, 7, 4)] },
  '2': digit([1, 1, 0, 1, 1, 0, 1]),
  '3': digit([1, 1, 1, 1, 0, 0, 1]),
  '4': digit([0, 1, 1, 0, 0, 1, 1]),
  '5': digit([1, 0, 1, 1, 0, 1, 1]),
  '6': digit([1, 0, 1, 1, 1, 1, 1]),
  '7': digit([1, 1, 1, 0, 0, 0, 0]),
  '8': digit([1, 1, 1, 1, 1, 1, 1]),
  '9': digit([1, 1, 1, 1, 0, 1, 1]),

  A: { w: 22, quads: [seg(11, 2.5, 3, 32, 5), seg(11, 2.5, 19, 32, 5), bar(6.8, 13.5, 8.4, 5)] },
  B: {
    w: 22,
    quads: [bar(0, 0, 5, 32), bar(0, 0, 22, 5), bar(0, 13.5, 22, 5), bar(0, 27, 22, 5),
      bar(17, 0, 5, 18), bar(17, 16, 5, 16)],
  },
  C: { w: 20, quads: [bar(0, 0, 20, 5), bar(0, 0, 5, 32), bar(0, 27, 20, 5)] },
  D: {
    w: 22,
    quads: [bar(0, 0, 5, 32), bar(0, 0, 22, 5), bar(0, 27, 22, 5),
      seg(20, 2.5, 22, 8, 5), bar(17, 8, 5, 16), seg(22, 24, 20, 29.5, 5)],
  },
  E: { w: 20, quads: [bar(0, 0, 5, 32), bar(0, 0, 20, 5), bar(0, 13.5, 16, 5), bar(0, 27, 20, 5)] },
  F: { w: 20, quads: [bar(0, 0, 5, 32), bar(0, 0, 20, 5), bar(0, 13.5, 16, 5)] },
  G: {
    w: 22,
    quads: [bar(0, 0, 22, 5), bar(0, 0, 5, 32), bar(0, 27, 22, 5), bar(17, 16, 5, 16), bar(11, 13.5, 6, 5)],
  },
  H: { w: 22, quads: [bar(0, 0, 5, 32), bar(17, 0, 5, 32), bar(0, 13.5, 22, 5)] },
  I: { w: 14, quads: [bar(4.5, 0, 5, 32), bar(0, 0, 14, 5), bar(0, 27, 14, 5)] },
  J: { w: 18, quads: [bar(0, 0, 18, 5), bar(13, 0, 5, 27), bar(3, 22, 15, 5)] },
  K: { w: 22, quads: [bar(0, 0, 5, 32), seg(5, 16, 20, 0, 5), seg(5, 16, 20, 32, 5)] },
  L: { w: 18, quads: [bar(0, 0, 5, 32), bar(0, 27, 18, 5)] },
  M: { w: 28, quads: [bar(0, 0, 5, 32), bar(23, 0, 5, 32), seg(5, 0, 14, 18, 5), seg(23, 0, 14, 18, 5)] },
  N: { w: 22, quads: [bar(0, 0, 5, 32), bar(17, 0, 5, 32), seg(2.5, 2, 19.5, 30, 5)] },
  O: { w: 22, quads: [bar(0, 0, 22, 5), bar(0, 27, 22, 5), bar(0, 0, 5, 32), bar(17, 0, 5, 32)] },
  P: { w: 20, quads: [bar(0, 0, 5, 32), bar(0, 0, 20, 5), bar(0, 13.5, 20, 5), bar(15, 0, 5, 18)] },
  Q: {
    w: 26,
    quads: [bar(0, 0, 22, 5), bar(0, 27, 22, 5), bar(0, 0, 5, 32), bar(17, 0, 5, 32), seg(13, 20, 25, 31, 5)],
  },
  R: {
    w: 22,
    quads: [bar(0, 0, 5, 32), bar(0, 0, 22, 5), bar(0, 13.5, 22, 5), bar(17, 0, 5, 18), seg(15, 18, 22, 32, 5)],
  },
  S: {
    w: 20,
    quads: [bar(0, 0, 20, 5), bar(0, 0, 5, 16), bar(0, 13.5, 20, 5), bar(15, 16, 5, 16), bar(0, 27, 20, 5)],
  },
  T: { w: 20, quads: [bar(0, 0, 20, 5), bar(7.5, 0, 5, 32)] },
  U: { w: 22, quads: [bar(0, 0, 5, 27), bar(17, 0, 5, 27), bar(0, 27, 22, 5)] },
  V: { w: 22, quads: [seg(0, 0, 11, 32, 5), seg(22, 0, 11, 32, 5)] },
  W: { w: 28, quads: [seg(0, 0, 7, 32, 5), seg(7, 32, 14, 10, 5), seg(14, 10, 21, 32, 5), seg(21, 32, 28, 0, 5)] },
  X: { w: 22, quads: [seg(2, 0, 20, 32, 5), seg(20, 0, 2, 32, 5)] },
  Y: { w: 22, quads: [seg(0, 0, 11, 17, 5), seg(22, 0, 11, 17, 5), bar(8.5, 16, 5, 16)] },
  Z: { w: 20, quads: [bar(0, 0, 20, 5), seg(18, 2.5, 2, 29.5, 5), bar(0, 27, 20, 5)] },

  '.': { w: 10, quads: [bar(2.5, 25, 5, 5)] },
  ':': { w: 10, quads: [bar(2.5, 10, 5, 5), bar(2.5, 21, 5, 5)] },
  "'": { w: 10, quads: [bar(2.5, 0, 5, 9)] },
  '-': { w: 18, quads: [bar(0, 13.5, 18, 5)] },
  ' ': { w: 14, quads: [] },
};

/**
 * @param {string} str
 * @returns {number} total advance width, in glyph units (cap height = 32)
 */
export function measureKbText(str) {
  const s = String(str).toUpperCase();
  let x = 0;
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]] || GLYPHS[' '];
    x += g.w + (i > 0 ? TRACK : 0);
  }
  return x;
}

/**
 * Builds one SVG `<path>` covering every glyph in `str`, laid out left to
 * right, and returns it as a `mask-image`-ready data URI.
 * @param {string} str
 * @returns {{uri: string, aspect: number}} aspect = total width / cap height
 */
export function kbTextSVG(str) {
  const s = String(str).toUpperCase();
  let x = 0;
  let d = '';
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]] || GLYPHS[' '];
    if (i > 0) x += TRACK;
    for (const poly of g.quads) {
      d += `M${poly.map(([px, py]) => `${(px + x).toFixed(1)},${py.toFixed(1)}`).join('L')}Z`;
    }
    x += g.w;
  }
  const width = Math.max(x, 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${H}">`
    + `<path d="${d || `M0,0L0,${H}L1,${H}L1,0Z`}" fill="#fff"/></svg>`;
  return { uri: `data:image/svg+xml,${encodeURIComponent(svg)}`, aspect: width / H };
}

/**
 * Renders `text` into `el` using the procedural glyphs, building the
 * shadow/body/gloss layer stack on first use and thereafter only touching
 * the mask + width when the string actually changes — the same
 * write-only-on-change discipline the rest of the HUD follows.
 * @param {HTMLElement} el
 * @param {string} text
 */
export function applyKbText(el, text) {
  if (!el._kbBuilt) {
    el.classList.add('kb-text');
    const shadow = document.createElement('span');
    shadow.className = 'kb-text__shadow';
    const body = document.createElement('span');
    body.className = 'kb-text__body';
    const gloss = document.createElement('span');
    gloss.className = 'kb-text__gloss';
    el.append(shadow, body, gloss);
    el._kbBuilt = true;
    el._kbStr = null;
  }
  if (el._kbStr === text) return;
  el._kbStr = text;
  const { uri, aspect } = kbTextSVG(text);
  el.style.setProperty('--kb-mask', `url("${uri}")`);
  el.style.width = `${aspect.toFixed(3)}em`;
}
