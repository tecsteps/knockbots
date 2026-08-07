/**
 * Knockbots — the interface typeface.
 *
 * WHAT WAS WRONG. `ui.css` asked for `'Eurostile Extended', 'Bank Gothic',
 * 'Segoe UI Semibold', 'Arial Narrow', ...`. Probed with
 * `system_profiler SPFontsDataType` on the machine every capture is taken on,
 * the first three families return 0 hits and `Arial Narrow` returns 4 — so the
 * whole `#ui` subtree was set in Arial Narrow, a 1982 newspaper condensed, on
 * this platform; in something else on Windows; and in the intended face
 * nowhere, because the intended face is not installed anywhere. `--kb-font-label`
 * names the same three absent families in a different order, so the design's
 * two distinct faces were in fact one face. The file already contained a
 * comment ("THE FIVE NAMES THAT WERE NEVER THERE") that had found this for the
 * mono token and not followed it two lines up.
 *
 * That is a quality defect and it is also a charter violation: the charter
 * says every asset is generated in code so the build is self-contained, and
 * the interface was the last surface still betting on what a stranger's
 * machine happens to have.
 *
 * WHAT THIS IS NOW. Three families, compiled to real TrueType at boot from the
 * outlines in `Glyphs.js` and handed to the platform through `FontFace` — no
 * download, no base64 of somebody else's type, no `local()`:
 *
 *   Knockbots Display   400/700/900   headlines, the logo, announcements
 *   Knockbots Text      400/700/900   every label, name, button and paragraph
 *   Knockbots Data      400/700       monospaced: numerals, keycaps, stats
 *
 * THE OPTICAL SIZES ARE THE POINT. The old procedural face — good, and the
 * ancestor of this one — was cut for a 100px+ cap height and said so; below
 * ~16px its counters closed, which is exactly why small labels had been routed
 * to a system stack in the first place. A single face cannot do a 150px "FIGHT"
 * and an 11px stat key.
 *
 * What separates the two cuts, in the numbers that reproduce: the display cut
 * has a 0.085-cap chamfer that reads as a machined bevel and is set TIGHT
 * (advance 0.742-0.764 of cap); the text cut gives up that chamfer (0.039 cap)
 * and that fit (0.756-0.790) to buy a 10.1% larger lowercase — x-height 0.540
 * em against 0.504 — which is the property a label at 14px actually spends.
 * The display cut is not the narrower drawing; after its Black was widened to
 * stop `S`, `R`, `G` and `Q` collapsing into blocks, its ink is fractionally
 * the wider of the two (0.660 cap against 0.636). Tight fitting, not narrow
 * ink, is what makes a headline read condensed.
 *
 * SIZED AGAINST WHAT IT REPLACES, so nothing reflows. Measured with CoreText
 * at 1000 upm, Arial Narrow — the face actually on screen until now — has cap
 * 0.7222 em, x-height 0.5244 em, and a mean uppercase advance of 0.5527 em
 * over HAMBURGEFONTSIV. The text cut is cap 0.700, x-height 0.540, mean
 * advance 0.5531 — 0.07% off the number every plate in the interface was laid
 * out against. Menlo, which `--kb-font-mono` was really resolving to, is a
 * fixed 0.60205 em; the data cut's advance is 0.602 em exactly, so the stat
 * columns and keycap rows keep their measure to the pixel.
 *
 * AND THE TIMER GOT TABULAR FIGURES IT DID NOT HAVE. The face this replaces
 * drew its digits as seven-segment shapes on per-digit widths: "59" masked to
 * 153.1px and "10" to 115.7px at the HUD's 5.4em, so the clock's ink box
 * changed width by 37px — a quarter of itself — as the seconds ran down, inside
 * a housing whose fit had been tuned twice. Every figure in all three families
 * now shares one advance. Measured at 1920x1080 the two-digit clock is 153.6px
 * at rest and clears `.timer-frame`'s chamfer by 21.0px a side, against 21.2px
 * before; pulsed to 1.14 under ten seconds it clears by 10.2px, against 10.5px.
 * Same fit, and it no longer moves.
 *
 * THE HEADLINE PATH IS THE SAME DRAWING. `.kb-text` still composites its
 * shadow / metal-body / gloss / edge-light stack through an SVG mask, because
 * that treatment is what makes the announcement read as cast metal and no font
 * feature reproduces it. But the mask is now cut from the display outlines
 * below rather than from a second, unrelated alphabet. One face on screen, two
 * rendering paths.
 *
 * `ui.css` still owns all `.kb-text` presentation; this module owns geometry,
 * compilation and registration only.
 */

import { buildGlyphs } from './Glyphs.js';
import { buildTTF } from './FontBuilder.js';

const UPM = 1000;

/** Family names, exported so nothing has to spell them twice. */
export const KB_FONTS = {
  display: 'Knockbots Display',
  text: 'Knockbots Text',
  data: 'Knockbots Data',
};

/**
 * The cuts.
 *
 * `barRatio` falls as weight rises and that is deliberate, not a typo. A
 * horizontal stroke scaled with the stem is what closes a counter first: at
 * 11px the clear height inside a lowercase `e` is `(xHeight - 3 * bar) / 2`,
 * so a bold whose bars track its stems loses the counter about 200 units
 * before it loses anything else. Weight in a condensed face lives in the
 * stems anyway.
 */
const CUTS = [
  // Display — headlines only, never below ~24px.
  //
  // The width and the black's stem are tied together and were retuned after
  // looking at a 150px specimen: at widthRatio 0.62 with a 190 stem the black
  // left an `O` counter of 66 units, and `S`, `R`, `G` and `Q` came back as
  // solid blocks with notches in them. A counter has to be a shape, not a
  // residue. 0.66 wide against a 148 stem leaves 174 — about a quarter of the
  // cap — which is what a condensed black wants.
  { fam: 'display', weight: 400, cap: 720, xhRatio: 0.70, widthRatio: 0.66, figRatio: 0.876, stem: 88, barRatio: 0.84, chamfer: 61, side: 46 },
  { fam: 'display', weight: 700, cap: 720, xhRatio: 0.70, widthRatio: 0.66, figRatio: 0.876, stem: 122, barRatio: 0.76, chamfer: 61, side: 42 },
  { fam: 'display', weight: 900, cap: 720, xhRatio: 0.70, widthRatio: 0.66, figRatio: 0.876, stem: 148, barRatio: 0.70, chamfer: 61, side: 38 },
  // text — the working face, cut to survive 11px
  { fam: 'text', weight: 400, cap: 700, xhRatio: 0.771, widthRatio: 0.635, stem: 86, barRatio: 0.86, chamfer: 27, side: 62 },
  { fam: 'text', weight: 700, cap: 700, xhRatio: 0.771, widthRatio: 0.635, stem: 126, barRatio: 0.76, chamfer: 27, side: 56 },
  { fam: 'text', weight: 900, cap: 700, xhRatio: 0.771, widthRatio: 0.635, stem: 166, barRatio: 0.68, chamfer: 27, side: 50 },
  // data — monospaced, advance pinned to Menlo's 0.602 em
  { fam: 'data', weight: 400, cap: 700, xhRatio: 0.771, widthRatio: 0.60, stem: 84, barRatio: 0.88, chamfer: 22, side: 40, fixed: 602 },
  { fam: 'data', weight: 700, cap: 700, xhRatio: 0.771, widthRatio: 0.60, stem: 122, barRatio: 0.78, chamfer: 22, side: 34, fixed: 602 },
];

const SUBFAMILY = { 400: 'Regular', 700: 'Bold', 900: 'Black' };

/** Cache so the display cut is only drawn once even though both the font and
 *  the mask path want it. */
const _cut = new Map();
function cutFor(spec) {
  const key = `${spec.fam}${spec.weight}`;
  let g = _cut.get(key);
  if (!g) {
    g = buildGlyphs({ upm: UPM, ...spec });
    _cut.set(key, g);
  }
  return g;
}

/**
 * Compile one cut to a `.ttf`.
 * @returns {{family:string, weight:number, bytes:Uint8Array}}
 */
export function compileCut(spec) {
  const g = cutFor(spec);
  const family = KB_FONTS[spec.fam];
  const sub = SUBFAMILY[spec.weight] || 'Regular';
  const bytes = buildTTF({
    unitsPerEm: g.upm,
    ascender: g.ascender,
    descender: g.descender,
    lineGap: g.lineGap,
    capHeight: g.capHeight,
    xHeight: g.xHeight,
    weightClass: spec.weight,
    // usWidthClass 3 = condensed. Descriptive, but a matcher that is asked for
    // a condensed family and finds `usWidthClass 5` can decide to synthesise
    // one, and a synthetically squashed stencil is worse than either.
    widthClass: spec.fixed ? 4 : 3,
    monospaced: !!spec.fixed,
    family,
    subfamily: sub,
    postScriptName: `Knockbots${spec.fam[0].toUpperCase()}${spec.fam.slice(1)}-${sub}`,
    glyphs: g.glyphs,
  });
  return { family, weight: spec.weight, bytes };
}

/** Every cut, compiled. Used by the offline validator as well as by boot. */
export function compileAll() {
  return CUTS.map(compileCut);
}

/* ---------------------------------------------------------------------- *
 * Registration
 * ---------------------------------------------------------------------- */

let _ready = null;

/**
 * Compile and register every cut with the document.
 *
 * Idempotent, and safe where there is no `FontFace` at all — `tools/check.mjs`
 * imports this module through a DOM shim and must not throw, and neither must
 * a worker.
 *
 * @returns {Promise<string[]>} the family/weight pairs that are now loaded
 */
export function installKbFonts() {
  if (_ready) return _ready;
  const canRegister = typeof FontFace === 'function'
    && typeof document !== 'undefined' && document.fonts && typeof document.fonts.add === 'function';
  if (!canRegister) {
    _ready = Promise.resolve([]);
    return _ready;
  }
  const loads = [];
  for (const spec of CUTS) {
    const { family, weight, bytes } = compileCut(spec);
    // `bytes.buffer` is the whole backing store; `slice()` in FontBuilder
    // already returns an exactly-sized copy, so this is the right ArrayBuffer.
    const face = new FontFace(family, bytes.buffer, {
      weight: String(weight),
      style: 'normal',
      stretch: spec.fixed ? 'semi-condensed' : 'condensed',
      display: 'block',
    });
    document.fonts.add(face);
    loads.push(face.load().then(() => `${family} ${weight}`));
  }
  _ready = Promise.all(loads).then((names) => {
    if (typeof document !== 'undefined' && document.documentElement
      && document.documentElement.classList) {
      // A hook for CSS and for the capture harness: the class only appears
      // once every cut is decoded, so a shot can wait on it instead of on a
      // guessed delay.
      document.documentElement.classList.add('kb-fonts-ready');
    }
    return names;
  }).catch((err) => {
    // Never take the game down over type. Report loudly, fall through to the
    // stack's tail, and let the gate in tools/ catch it.
    console.error('[Typeface] font registration failed', err);
    return [];
  });
  return _ready;
}

/**
 * Resolves once every generated cut is decoded and usable.
 * `tools/capture.mjs` should await `window.__kbFontsReady` before a shot;
 * without it the first frame can be typeset in the fallback.
 */
export const kbFontsReady = installKbFonts();
if (typeof window !== 'undefined') window.__kbFontsReady = kbFontsReady;

/* ---------------------------------------------------------------------- *
 * The headline mask path
 * ---------------------------------------------------------------------- */

/**
 * Which cut the masks are drawn from. The headline stack is always heavy and
 * always large, so it takes the display Black.
 */
const MASK = CUTS.find((c) => c.fam === 'display' && c.weight === 900);

/**
 * Optical gap between adjacent letterforms in the mask, in glyph units.
 * Sized as a fraction of cap so it tracks the cut rather than a magic 5.
 */
const KERN_GAP = Math.round(MASK.cap * 0.15);
const KERN_SAMPLES = 20;

/** Ink extent of a contour set at height `y` (font units, y-up), or `null`
 *  where the glyph has no ink at all on that line — inside the counter of an
 *  `O`, or above the crossbar of a `T`. Kerning only; never at render time. */
function spanAtY(contours, y) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const { pts } of contours) {
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      if ((y0 <= y) === (y1 <= y)) continue; // edge does not cross the sample line
      const t = (y - y0) / (y1 - y0);
      const x = x0 + t * (x1 - x0);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

const _profile = new Map();
function profile(code) {
  let p = _profile.get(code);
  if (p) return p;
  const g = cutFor(MASK).glyphs.get(code);
  p = [];
  for (let i = 0; i < KERN_SAMPLES; i++) {
    p.push(spanAtY(g ? g.contours : [], (i + 0.5) * (MASK.cap / KERN_SAMPLES)));
  }
  _profile.set(code, p);
  return p;
}

/**
 * Optical advance from glyph `a`'s origin to glyph `b`'s — real kerning rather
 * than a flat gap between bounding boxes. Both ink profiles are sampled at the
 * same rows and the advance is whatever leaves `KERN_GAP` of clear space at
 * their closest approach, so the foot of an `A` tucks under a following `T`
 * instead of carrying the margin a straight-sided `H` needs. Pairs with no
 * vertical ink overlap (the space glyph, or two glyphs at different heights)
 * fall back to the flat advance.
 */
function kernAdvance(ca, cb) {
  const ga = cutFor(MASK).glyphs.get(ca);
  const pa = profile(ca);
  const pb = profile(cb);
  let worst = -Infinity;
  for (let i = 0; i < KERN_SAMPLES; i++) {
    const sa = pa[i];
    const sb = pb[i];
    if (!sa || !sb) continue;
    const need = sa[1] - sb[0];
    if (need > worst) worst = need;
  }
  const flat = (ga ? ga.advance : MASK.cap * 0.4);
  return worst === -Infinity ? flat : worst + KERN_GAP;
}

/** Code points a headline string is allowed to ask for; anything else becomes
 *  a space rather than a `.notdef` box. */
function maskCode(ch) {
  const cut = cutFor(MASK);
  const c = ch.codePointAt(0);
  return cut.glyphs.has(c) ? c : 32;
}

/**
 * @param {string} str
 * @returns {number} total advance, in units of the cap height
 */
export function measureKbText(str) {
  const s = String(str).toUpperCase();
  const cut = cutFor(MASK);
  let x = 0;
  let prev = null;
  for (let i = 0; i < s.length; i++) {
    const c = maskCode(s[i]);
    if (prev !== null) x += kernAdvance(prev, c);
    prev = c;
  }
  if (prev === null) return 0;
  const g = cut.glyphs.get(prev);
  return (x + (g ? g.advance : 0)) / MASK.cap;
}

/**
 * One SVG `<path>` covering every glyph in `str`, laid out left to right, as a
 * `mask-image` data URI.
 *
 * The viewBox is exactly one CAP HEIGHT tall and the outlines are flipped into
 * it, because `.kb-text` in `ui.css` is `height: 1em` and every offset in that
 * stack (the shadow's 8%, the gloss ramp, the `--kb-edge` chamfer) is written
 * against a box whose height is the cap. Descending ink — the tail of a `Q`,
 * a comma — is clipped at the baseline by design; headline strings are
 * uppercased and this is the only place that contract is written down.
 *
 * @param {string} str
 * @returns {{uri: string, aspect: number}} aspect = total width / cap height
 */
export function kbTextSVG(str) {
  const s = String(str).toUpperCase();
  const cut = cutFor(MASK);
  const H = MASK.cap;
  let x = 0;
  let prev = null;
  let d = '';
  let last = null;
  for (let i = 0; i < s.length; i++) {
    const c = maskCode(s[i]);
    if (prev !== null) x += kernAdvance(prev, c);
    const g = cut.glyphs.get(c);
    if (g) {
      for (const { pts } of g.contours) {
        d += `M${pts.map(([px, py]) => `${(px + x).toFixed(1)},${(H - py).toFixed(1)}`).join('L')}Z`;
      }
      last = g;
    }
    prev = c;
  }
  const width = Math.max(last ? x + last.advance : 1, 1);
  // `fill-rule="nonzero"` is the default and is load-bearing: counters are
  // wound against their outer contour, every other stroke with it.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${H}">`
    + `<path d="${d || `M0,0L0,${H}L1,${H}L1,0Z`}" fill="#fff"/></svg>`;
  return { uri: `data:image/svg+xml,${encodeURIComponent(svg)}`, aspect: width / H };
}

/**
 * Renders `text` into `el` through the mask stack, building the
 * shadow/body/gloss children on first use and thereafter touching only the
 * mask and the width when the string actually changes — the same
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
