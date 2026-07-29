/**
 * Knockbots — procedural display typeface.
 *
 * The charter forbids fetching fonts at runtime, and shipping a licensed
 * commercial face as an embedded base64 blob is not something we have rights
 * to do. So the HUD's large display type — character names, the timer
 * numerals, combo count, the big round announcements — does not use a font
 * file at all: every glyph below is a small set of straight strokes (`bar` =
 * axis-aligned rectangle, `seg` = an arbitrary-angle thick line with square
 * caps) laid out on a 32-unit cap-height grid, in the spirit of the
 * stencil/engineering lettering this kind of hard-surface HUD actually
 * references (compare Eurostile/Bank Gothic, both built almost entirely from
 * straight edges).
 *
 * This face is display type, not body type: its counters and joints are cut
 * for a 100px+ cap height, and it visibly breaks down below ~16px (the "D"
 * bowl fills in, the seven-segment digits smear). Small labels ("ROUND 1",
 * "OVERDRIVE", combo tags) use the system sans in `ui.css` instead — see
 * `--kb-font-label`. Knowing where a display face stops working is part of
 * using one; this module does not try to be both.
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
const KERN_GAP = 5; // target optical gap between adjacent letterforms, in glyph units
const KERN_SAMPLES = 16; // sample rows across cap height used to measure ink profiles

/**
 * Every stroke is a separate closed subpath in one SVG `<path>`, filled with
 * the default `nonzero` rule so overlapping strokes union together instead
 * of requiring one continuous outline. That union only holds if every
 * subpath winds the *same* direction — where two strokes overlap with
 * opposite winding, `nonzero` cancels them to a winding number of zero,
 * i.e. punches a hole in exactly the overlap, rather than filling it. This
 * was the real cause of the square-cap notches at diagonal joins: `seg()`'s
 * point order (and so its winding) flips with travel direction, so a
 * diagonal could wind opposite to the stem it met. Every polygon is
 * normalised to the same (positive-shoelace) winding before it is used, so
 * any overlap — deliberate joins included — is always additive.
 */
function windingSign(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    s += x0 * y1 - x1 * y0;
  }
  return s;
}
function normalizeWinding(poly) {
  return windingSign(poly) >= 0 ? poly : poly.slice().reverse();
}

/** Axis-aligned stroke: (x, y) is the top-left corner. */
function bar(x, y, w, h) {
  return normalizeWinding([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
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
  return normalizeWinding([[ax0 + nx, ay0 + ny], [ax1 + nx, ay1 + ny], [ax1 - nx, ay1 - ny], [ax0 - nx, ay0 - ny]]);
}

/**
 * A `seg()`'s caps are square and cut perpendicular to *its own* travel
 * direction, not mitred to whatever straight stem or second diagonal it
 * meets — at a shallow angle that leaves a visible triangular notch right at
 * the join (the "N" and "K" diagonals both did this). Rather than solving
 * the mitre geometry per letter, every diagonal join gets one of these: a
 * small square centred exactly on the nominal meeting point and sized a
 * little past the stroke thickness, so it bridges whatever sliver the two
 * square-capped strokes left between them regardless of the angle.
 */
function joint(cx, cy, t = T + 2) {
  return bar(cx - t / 2, cy - t / 2, t, t);
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
  K: { w: 22, quads: [bar(0, 0, 5, 32), seg(5, 16, 20, 0, 5), seg(5, 16, 20, 32, 5), joint(5, 16)] },
  L: { w: 18, quads: [bar(0, 0, 5, 32), bar(0, 27, 18, 5)] },
  M: {
    w: 28,
    quads: [bar(0, 0, 5, 32), bar(23, 0, 5, 32), seg(5, 0, 14, 18, 5), seg(23, 0, 14, 18, 5), joint(14, 18)],
  },
  N: {
    w: 22,
    quads: [bar(0, 0, 5, 32), bar(17, 0, 5, 32), seg(2.5, 2, 19.5, 30, 5), joint(2.5, 2), joint(19.5, 30)],
  },
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
  V: { w: 22, quads: [seg(0, 0, 11, 32, 5), seg(22, 0, 11, 32, 5), joint(11, 31)] },
  W: {
    w: 28,
    quads: [seg(0, 0, 7, 32, 5), seg(7, 32, 14, 10, 5), seg(14, 10, 21, 32, 5), seg(21, 32, 28, 0, 5),
      joint(7, 31), joint(14, 10), joint(21, 31)],
  },
  X: { w: 22, quads: [seg(2, 0, 20, 32, 5), seg(20, 0, 2, 32, 5)] },
  Y: { w: 22, quads: [seg(0, 0, 11, 17, 5), seg(22, 0, 11, 17, 5), bar(8.5, 16, 5, 16), joint(11, 17)] },
  Z: { w: 20, quads: [bar(0, 0, 20, 5), seg(18, 2.5, 2, 29.5, 5), bar(0, 27, 20, 5)] },

  '.': { w: 10, quads: [bar(2.5, 25, 5, 5)] },
  ':': { w: 10, quads: [bar(2.5, 10, 5, 5), bar(2.5, 21, 5, 5)] },
  "'": { w: 10, quads: [bar(2.5, 0, 5, 9)] },
  '-': { w: 18, quads: [bar(0, 13.5, 18, 5)] },
  ' ': { w: 14, quads: [] },
};

/**
 * Ink extent of a glyph's quads at height `y` — the min/max x any of its
 * strokes actually cover there, or `null` where the glyph has no ink at all
 * (e.g. inside the counter of an "O", or above the crossbar of a "T"). Used
 * only to build the optical kerning table below, never at render time.
 * @returns {[number, number] | null}
 */
function spanAtY(quads, y) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const poly of quads) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = poly[i];
      const [x1, y1] = poly[(i + 1) % n];
      if ((y0 <= y) === (y1 <= y)) continue; // this edge doesn't cross the sample line
      const t = (y - y0) / (y1 - y0);
      const x = x0 + t * (x1 - x0);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Per-glyph ink profile, sampled once and cached: one [minX, maxX] span (or
 *  `null`) per row across the cap height. */
const _profileCache = new WeakMap();
function profile(glyph) {
  let p = _profileCache.get(glyph);
  if (p) return p;
  p = [];
  for (let i = 0; i < KERN_SAMPLES; i++) {
    p.push(spanAtY(glyph.quads, (i + 0.5) * (H / KERN_SAMPLES)));
  }
  _profileCache.set(glyph, p);
  return p;
}

/**
 * Optical advance from glyph `a`'s origin to glyph `b`'s — real kerning
 * rather than a flat gap between bounding boxes. Both glyphs' ink profiles
 * are sampled at the same rows; the advance is whatever leaves `KERN_GAP`
 * units of clear space at their closest approach, so a diagonal like the
 * foot of "A" tucks under the following stroke instead of carrying the same
 * empty margin a straight-sided "H" needs. Pairs with no vertical overlap in
 * ink (either glyph is the blank space glyph, or one is much shorter) fall
 * back to a flat `a.w + KERN_GAP`.
 */
function kernAdvance(a, b) {
  const pa = profile(a);
  const pb = profile(b);
  let worst = -Infinity;
  for (let i = 0; i < KERN_SAMPLES; i++) {
    const sa = pa[i];
    const sb = pb[i];
    if (!sa || !sb) continue;
    const need = sa[1] - sb[0]; // how far b's nearest ink would sit into a's, before the gap
    if (need > worst) worst = need;
  }
  return worst === -Infinity ? a.w + KERN_GAP : worst + KERN_GAP;
}

/**
 * @param {string} str
 * @returns {number} total advance width, in glyph units (cap height = 32)
 */
export function measureKbText(str) {
  const s = String(str).toUpperCase();
  let x = 0;
  let prev = null;
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]] || GLYPHS[' '];
    if (prev) x += kernAdvance(prev, g);
    prev = g;
  }
  return prev ? x + prev.w : 0;
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
  let prev = null;
  let d = '';
  for (let i = 0; i < s.length; i++) {
    const g = GLYPHS[s[i]] || GLYPHS[' '];
    if (prev) x += kernAdvance(prev, g);
    for (const poly of g.quads) {
      d += `M${poly.map(([px, py]) => `${(px + x).toFixed(1)},${py.toFixed(1)}`).join('L')}Z`;
    }
    prev = g;
  }
  const width = Math.max(prev ? x + prev.w : 1, 1);
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
