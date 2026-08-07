/**
 * Knockbots — the letterforms.
 *
 * ONE DRAWING, TWO CONSUMERS. Everything visible in `#ui` is set in the shapes
 * below: `FontBuilder.js` packs them into a real `.ttf` that the CSS cascade
 * names, and `Typeface.js` also rasterises the display cut into the SVG masks
 * that give the announcement / timer / winner headline their bevel and gloss.
 * Two rendering paths, one alphabet — which is the point. Before this the
 * headline path and the label path were different typefaces (a hand-cut
 * stencil against whatever the platform had), and no amount of tracking makes
 * a screen with two unrelated faces on it look designed.
 *
 * THE DESIGN. A condensed engineered grotesk whose corners are CUT, not
 * rounded: every outer corner and every terminal is a 45-degree chamfer, the
 * same cut the HUD's plates and health frames already carry (`--kb-bev` in
 * `ui.css`). Bowls are octagons rather than ellipses. That is a deliberate
 * material claim — this is lettering stencilled onto a machine, matching the
 * chamfered armour plate the robots are built from — and it is also what
 * survives 11px, because an octagonal counter is very nearly a rectangle and a
 * rectangle is the shape a pixel grid is best at holding open.
 *
 * TWO OPTICAL SIZES, WHICH IS THE WHOLE REASON THIS FILE IS PARAMETRIC.
 * The face this replaced was, by its own comment, "cut for a 100px+ cap
 * height", closed its counters below ~16px, and so the entire small-label
 * layer of the interface was routed to a system stack instead — which on this
 * machine meant Arial Narrow, and on a machine without Arial Narrow meant
 * something else. A display cut cannot do label work and a label cut cannot do
 * headline work, so both are drawn, from one skeleton, with different:
 *
 *                     display cut     text cut      what it buys
 *   cap               720             700
 *   x-height          0.700 cap       0.771 cap     the lowercase, at label size
 *   ink width         0.660 cap       0.636 cap
 *   advance / cap     0.742-0.764     0.756-0.790   display is set tighter
 *   chamfer           0.085 cap       0.039 cap     bevel vs. not-mud
 *   sidebearing       0.053-0.064     0.071-0.089   text needs air between stems
 *   figure width      0.876 of normal 0.98          see `figRatio`
 *
 * X-HEIGHT IS THE REAL SEPARATION, and it is worth being precise about which
 * claims survive measurement. Rasterised through CoreText at matched sizes and
 * counting enclosed background pixels across `e a o s g`, the two cuts do NOT
 * separate on counter area (ratios of 0.88-1.09 over 14-120px) — an earlier
 * revision of this comment claimed 0.68-0.81 and that was measured before the
 * display cut was widened to stop its Black collapsing, so it does not
 * reproduce and is gone. What does separate them is the lowercase: 0.540 em of
 * x-height against 0.504, i.e. 10.1% more, which at a 14px label is 7.56 device
 * pixels against 7.06.
 *
 * AND NOTHING BELOW 13px IS MEASURABLE HERE. Counter counts at 9-12px are
 * non-monotonic for every face tested — this one, and Arial Narrow, which
 * reads 8 / 2 / 0 / 22 at 9 / 10 / 11 / 12px. That is the rasteriser's grid
 * phase, not a property of a typeface, and no claim about 11px legibility can
 * be built on it. Where the instrument IS stable, 13-16px, the text cut carries
 * 11-19% more counter area than Arial Narrow (42 vs 31, 48 vs 43, 62 vs 52).
 *
 * WHY THE HORIZONTALS ARE THIN. Weight in a condensed face lives in the stems,
 * so the horizontals are free to be the lightest stroke in the font (0.86 of
 * the stem at Regular, falling to 0.68 at Black). At display sizes that stops
 * the letter looking bottom-heavy; at label sizes it is what stops three
 * stacked bars from eating the two counters of an `e`. The two reasons happen
 * to want the same thing.
 *
 * WINDING. Contours are tagged `dir: 1` (solid) or `dir: -1` (counter) and the
 * fill rule is nonzero everywhere. A counter is a hole; every other stroke
 * unions. That is what lets a bowl and the bar crossing it be two independent
 * rectangles instead of one traced outline, and it is why adding a stroke to a
 * glyph here can never punch an accidental hole in it — the failure mode the
 * old mask path had to normalise winding by hand to avoid.
 */

/* ---------------------------------------------------------------------- *
 * Pens
 * ---------------------------------------------------------------------- */

/**
 * A chamfered rectangle — the only closed shape in the font.
 *
 * `ch` is either one length applied to all four corners or `[bl, br, tr, tl]`
 * (counter-clockwise from bottom-left, matching the point order). A corner
 * with 0 stays square, which is what every corner that meets another stroke
 * wants: chamfering a joint would open a notch in it.
 */
function plate(x, y, w, h, ch = 0) {
  const lim = Math.min(w, h) / 2;
  const [bl, br, tr, tl] = (Array.isArray(ch) ? ch : [ch, ch, ch, ch])
    .map((c) => Math.max(0, Math.min(c, lim)));
  const p = [];
  const push = (px, py) => p.push([Math.round(px), Math.round(py)]);
  if (bl) { push(x + bl, y); } else { push(x, y); }
  if (br) { push(x + w - br, y); push(x + w, y + br); } else { push(x + w, y); }
  if (tr) { push(x + w, y + h - tr); push(x + w - tr, y + h); } else { push(x + w, y + h); }
  if (tl) { push(x + tl, y + h); push(x, y + h - tl); } else { push(x, y + h); }
  if (bl) push(x, y + bl);
  return { dir: 1, pts: p };
}

/** Same rectangle, wound as a hole. */
function hole(x, y, w, h, ch = 0) {
  return { dir: -1, pts: plate(x, y, w, h, ch).pts };
}

/**
 * A diagonal whose two ends are cut VERTICALLY, so it butts cleanly against a
 * flat top or a baseline. `tx` is the horizontal width of the cut, not the
 * perpendicular thickness — stated in the axis it is measured on, because
 * every caller is positioning it against a vertical stem.
 */
function vbar(x0, y0, x1, y1, tx) {
  return {
    dir: 1,
    pts: [[x0 - tx / 2, y0], [x1 - tx / 2, y1], [x1 + tx / 2, y1], [x0 + tx / 2, y0]]
      .map(([x, y]) => [Math.round(x), Math.round(y)]),
  };
}

/** A diagonal cut HORIZONTALLY at both ends — for the waist of a `Z`, whose
 *  ends meet horizontal bars rather than vertical stems. */
function hbar(x0, y0, x1, y1, ty) {
  return {
    dir: 1,
    pts: [[x0, y0 - ty / 2], [x0, y0 + ty / 2], [x1, y1 + ty / 2], [x1, y1 - ty / 2]]
      .map(([x, y]) => [Math.round(x), Math.round(y)]),
  };
}

/* ---------------------------------------------------------------------- *
 * The alphabet
 * ---------------------------------------------------------------------- */

/**
 * Builds every glyph for one cut.
 *
 * @param {object} p
 * @param {number} p.upm         units per em
 * @param {number} p.cap         cap height
 * @param {number} p.xhRatio     x-height as a fraction of cap
 * @param {number} p.widthRatio  normal ink width as a fraction of cap
 * @param {number} p.stem        vertical stroke thickness
 * @param {number} p.barRatio    horizontal stroke thickness / stem
 * @param {number} p.chamfer     45-degree corner cut length
 * @param {number} p.side        sidebearing
 * @param {number} [p.figRatio]  figure ink width / normal ink width. Its own
 *                               parameter because the display cut's figures
 *                               have to fit `.timer-frame`, which `ui.css`
 *                               sized around the old numeral: 9.7em wide,
 *                               clearing the octagon's chamfer by 10.6px
 *                               when `timerPulse` scales to 1.14. Figures at
 *                               the text cut's proportions are 10.2% wider
 *                               than that housing was cut for.
 * @param {number} [p.fixed]     if set, every advance is forced to this width
 *                               and the ink is centred in it (the data cut)
 */
export function buildGlyphs(p) {
  const H = p.cap;
  const X = Math.round(H * p.xhRatio);
  const A = H;                     // lowercase ascender == cap: flat, engineered
  const D = -Math.round(H * 0.27); // descender depth
  const s = p.stem;
  const b = Math.round(p.stem * p.barRatio);
  const c = p.chamfer;
  const c2 = c * 2;                 // a "terminal" cut: twice a corner cut
  const W = Math.round(H * p.widthRatio);
  const lc = Math.round(W * 0.94);  // lowercase is marginally narrower than caps
  const dotY = X + Math.round((A - X) * 0.34);

  /** @type {Record<string, {f:number, ink?:number, draw:(w:number)=>object[]}>} */
  const defs = {};
  const def = (ch, f, draw, base = W) => { defs[ch] = { w: Math.round(base * f), draw }; };

  /* -- capitals ------------------------------------------------------- */

  def('A', 1.0, (w) => {
    const tx = Math.round(s * 1.08);
    const barY = Math.round(H * 0.22);
    const off = ((w / 2 - tx / 2) * barY) / H;
    return [
      vbar(tx / 2, 0, w / 2, H, tx),
      vbar(w - tx / 2, 0, w / 2, H, tx),
      plate(off, barY, w - off * 2, b),
    ];
  });
  def('B', 1.0, (w) => {
    const mid = Math.round(H * 0.52);
    return [
      plate(0, 0, w, mid + b / 2, [0, c, 0, 0]),
      hole(s, b, w - s * 2, mid - b / 2 - b, [0, c, 0, 0]),
      plate(0, mid - b / 2, w, H - mid + b / 2, [0, 0, c, 0]),
      hole(s, mid + b / 2, w - s * 2, H - b - mid - b / 2, [0, 0, c, 0]),
    ];
  });
  def('C', 0.98, (w) => [
    plate(0, 0, s, H, [c, 0, 0, c]),
    plate(0, H - b, w, b, [0, c2, 0, c]),
    plate(0, 0, w, b, [c, 0, c2, 0]),
  ]);
  def('D', 1.02, (w) => [
    plate(0, 0, w, H, [c, c2, c2, c]),
    hole(s, b, w - s * 2, H - b * 2, [0, c, c, 0]),
  ]);
  def('E', 0.86, (w) => [
    plate(0, 0, s, H, [c, 0, 0, c]),
    plate(0, H - b, w, b, [0, c, 0, 0]),
    plate(0, Math.round(H * 0.5 - b / 2), Math.round(w * 0.84), b, [0, c, c, 0]),
    plate(0, 0, w, b, [0, c, 0, 0]),
  ]);
  def('F', 0.84, (w) => [
    plate(0, 0, s, H, [c, 0, 0, c]),
    plate(0, H - b, w, b, [0, c, 0, 0]),
    plate(0, Math.round(H * 0.5 - b / 2), Math.round(w * 0.86), b, [0, c, c, 0]),
  ]);
  def('G', 1.02, (w) => [
    plate(0, 0, s, H, [c, 0, 0, c]),
    plate(0, H - b, w, b, [0, c2, 0, c]),
    plate(0, 0, w, b, [c, c, 0, 0]),
    plate(w - s, 0, s, Math.round(H * 0.46), [0, c, 0, 0]),
    plate(Math.round(w * 0.46), Math.round(H * 0.46 - b), w - Math.round(w * 0.46), b, [0, 0, 0, c]),
  ]);
  def('H', 1.0, (w) => [
    plate(0, 0, s, H, [c, 0, 0, c]),
    plate(w - s, 0, s, H, [0, c, c, 0]),
    plate(0, Math.round(H * 0.5 - b / 2), w, b),
  ]);
  def('I', 0.46, (w) => [
    plate(0, H - b, w, b, [0, c, c, 0]),
    plate(0, 0, w, b, [c, c, 0, 0]),
    plate(Math.round(w / 2 - s / 2), 0, s, H),
  ]);
  def('J', 0.78, (w) => [
    plate(w - s, Math.round(H * 0.20), s, H - Math.round(H * 0.20), [0, c, c, 0]),
    plate(0, 0, w, b, [c, c, 0, 0]),
    plate(0, 0, s, Math.round(H * 0.30), [c, 0, c, 0]),
  ]);
  def('K', 1.0, (w) => {
    const j = Math.round(H * 0.46);
    const tx = Math.round(s * 1.42);
    return [
      plate(0, 0, s, H, [c, 0, 0, c]),
      vbar(tx / 2, j, w - tx / 2, H, tx),
      vbar(tx / 2, j, w - tx / 2, 0, tx),
      plate(0, j - s * 0.6, s * 1.5, s * 1.2),
    ];
  });
  def('L', 0.78, (w) => [
    plate(0, 0, s, H, [0, 0, 0, c]),
    plate(0, 0, w, b, [c, c, 0, 0]),
  ]);
  def('M', 1.36, (w) => {
    const tx = Math.round(s * 1.14);
    const v = Math.round(H * 0.28);
    return [
      plate(0, 0, s, H, [c, 0, 0, c]),
      plate(w - s, 0, s, H, [0, c, c, 0]),
      vbar(tx / 2, H, w / 2, v, tx),
      vbar(w - tx / 2, H, w / 2, v, tx),
      plate(w / 2 - tx / 2, v, tx, s),
    ];
  });
  def('N', 1.04, (w) => {
    const tx = Math.round(s * 1.30);
    return [
      plate(0, 0, s, H, [c, 0, 0, c]),
      plate(w - s, 0, s, H, [0, c, c, 0]),
      vbar(tx / 2, H, w - tx / 2, 0, tx),
    ];
  });
  def('O', 1.04, (w) => [
    plate(0, 0, w, H, [c2, c2, c2, c2]),
    hole(s, b, w - s * 2, H - b * 2, [c, c, c, c]),
  ]);
  def('P', 0.94, (w) => {
    const mid = Math.round(H * 0.48);
    return [
      plate(0, 0, s, H, [c, 0, 0, c]),
      plate(0, mid, w, H - mid, [0, 0, c, 0]),
      hole(s, mid + b, w - s * 2, H - mid - b * 2, [0, 0, c, 0]),
      plate(0, mid, w, b, [0, c, 0, 0]),
    ];
  });
  def('Q', 1.04, (w) => [
    plate(0, 0, w, H, [c2, c2, c2, c2]),
    hole(s, b, w - s * 2, H - b * 2, [c, c, c, c]),
    vbar(Math.round(w * 0.56), Math.round(H * 0.30), w - Math.round(s * 0.65), -Math.round(H * 0.06), Math.round(s * 1.3)),
  ]);
  def('R', 1.0, (w) => {
    const mid = Math.round(H * 0.50);
    return [
      plate(0, 0, s, H, [c, 0, 0, c]),
      plate(0, mid, w, H - mid, [0, 0, c, 0]),
      hole(s, mid + b, w - s * 2, H - mid - b * 2, [0, 0, c, 0]),
      plate(0, mid, w, b),
      vbar(Math.round(w * 0.50), mid + b, w - Math.round(s * 0.62), 0, Math.round(s * 1.24)),
    ];
  });
  def('S', 0.94, (w) => {
    const mid = Math.round(H * 0.5 - b / 2);
    return [
      plate(0, H - b, w, b, [0, c2, c, c]),
      plate(0, mid, w, b),
      plate(0, 0, w, b, [c, c, c2, 0]),
      plate(0, mid, s, H - b - mid, [0, 0, 0, c]),
      plate(w - s, b, s, mid - b, [0, c, 0, 0]),
    ];
  });
  def('T', 0.86, (w) => [
    plate(0, H - b, w, b, [0, 0, c, c]),
    plate(Math.round(w / 2 - s / 2), 0, s, H, [c, c, 0, 0]),
  ]);
  def('U', 1.02, (w) => [
    plate(0, b, s, H - b, [0, 0, 0, c]),
    plate(w - s, b, s, H - b, [0, 0, c, 0]),
    plate(0, 0, w, b, [c2, c2, 0, 0]),
  ]);
  def('V', 1.02, (w) => {
    const tx = Math.round(s * 1.14);
    return [
      vbar(tx / 2, H, w / 2, 0, tx),
      vbar(w - tx / 2, H, w / 2, 0, tx),
      plate(w / 2 - tx / 2, 0, tx, s * 0.8, [c, c, 0, 0]),
    ];
  });
  def('W', 1.42, (w) => {
    const tx = Math.round(s * 1.10);
    const v = Math.round(H * 0.30);
    return [
      vbar(tx / 2, H, Math.round(w * 0.28), 0, tx),
      vbar(Math.round(w * 0.28), 0, w / 2, v, tx),
      vbar(w / 2, v, Math.round(w * 0.72), 0, tx),
      vbar(Math.round(w * 0.72), 0, w - tx / 2, H, tx),
      plate(w / 2 - tx / 2, v - s * 0.5, tx, s),
    ];
  });
  def('X', 1.0, (w) => {
    const tx = Math.round(s * 1.34);
    return [vbar(tx / 2, 0, w - tx / 2, H, tx), vbar(w - tx / 2, 0, tx / 2, H, tx)];
  });
  def('Y', 1.0, (w) => {
    const tx = Math.round(s * 1.24);
    const j = Math.round(H * 0.44);
    return [
      vbar(tx / 2, H, w / 2, j, tx),
      vbar(w - tx / 2, H, w / 2, j, tx),
      plate(Math.round(w / 2 - s / 2), 0, s, j + s, [c, c, 0, 0]),
    ];
  });
  def('Z', 0.94, (w) => [
    plate(0, H - b, w, b, [0, 0, c, c]),
    plate(0, 0, w, b, [c, c, 0, 0]),
    hbar(w - s * 0.2, H - b, s * 0.2, b, Math.round(b * 1.9)),
  ]);

  /* -- figures -------------------------------------------------------- *
   * Tabular by construction: every digit is drawn on the same ink width
   * and gets the same advance, so a timer counting down and a damage
   * readout ticking up never reflow. `0` carries the engineer's slash for
   * the same reason the rest of the face is cut the way it is — and
   * because at 11px a slashless zero and an `O` are the same shape.
   * -------------------------------------------------------------------- */
  const fw = p.figRatio ?? 0.98;
  def('0', fw, (w) => [
    plate(0, 0, w, H, [c2, c2, c2, c2]),
    hole(s, b, w - s * 2, H - b * 2, [c, c, c, c]),
    vbar(Math.round(w * 0.72), Math.round(H * 0.80), Math.round(w * 0.28), Math.round(H * 0.20), Math.round(s * 1.2)),
  ]);
  def('1', fw, (w) => [
    plate(Math.round(w / 2 - s / 2), 0, s, H),
    vbar(Math.round(w / 2), H, Math.round(w * 0.14), Math.round(H * 0.74), Math.round(s * 1.5)),
    plate(0, 0, w, b, [c, c, 0, 0]),
  ]);
  def('2', fw, (w) => {
    const mid = Math.round(H * 0.5 - b / 2);
    return [
      plate(0, H - b, w, b, [0, 0, c, c]),
      plate(w - s, mid, s, H - b - mid, [0, c, 0, 0]),
      plate(0, mid, w, b),
      plate(0, 0, s, mid, [c, 0, 0, 0]),
      plate(0, 0, w, b, [c, c, 0, 0]),
    ];
  });
  def('3', fw, (w) => [
    plate(0, H - b, w, b, [0, 0, c, c]),
    plate(Math.round(w * 0.22), Math.round(H * 0.5 - b / 2), w - Math.round(w * 0.22), b),
    plate(0, 0, w, b, [c, c, 0, 0]),
    plate(w - s, b, s, H - b * 2, [0, c, c, 0]),
  ]);
  def('4', fw, (w) => {
    const cross = Math.round(H * 0.30);
    return [
      plate(0, cross, s, H - cross, [0, 0, 0, c]),
      plate(0, cross, w, b, [c, 0, 0, 0]),
      plate(w - s, 0, s, H, [c, c, c, 0]),
    ];
  });
  def('5', fw, (w) => {
    const mid = Math.round(H * 0.5 - b / 2);
    return [
      plate(0, H - b, w, b, [0, c2, c, c]),
      plate(0, mid, s, H - b - mid, [0, 0, 0, 0]),
      plate(0, mid, w, b),
      plate(w - s, b, s, mid - b, [0, c, 0, 0]),
      plate(0, 0, w, b, [c, c, c2, 0]),
    ];
  });
  def('6', fw, (w) => [
    plate(0, 0, s, H, [c, 0, 0, c]),
    plate(0, H - b, w, b, [0, c2, 0, c]),
    plate(0, Math.round(H * 0.5 - b / 2), w, b),
    plate(0, 0, w, b, [c, c, 0, 0]),
    plate(w - s, b, s, Math.round(H * 0.5 - b / 2) - b, [0, c, 0, 0]),
  ]);
  def('7', fw, (w) => [
    plate(0, H - b, w, b, [0, 0, c, c]),
    vbar(w - s * 0.6, H - b, Math.round(w * 0.30), 0, Math.round(s * 1.24)),
  ]);
  def('8', fw, (w) => {
    const mid = Math.round(H * 0.52);
    return [
      plate(0, 0, w, mid + b / 2, [c, c, 0, 0]),
      hole(s, b, w - s * 2, mid - b / 2 - b, [c, c, 0, 0]),
      plate(0, mid - b / 2, w, H - mid + b / 2, [0, 0, c, c]),
      hole(s, mid + b / 2, w - s * 2, H - b - mid - b / 2, [0, 0, c, c]),
    ];
  });
  def('9', fw, (w) => [
    plate(w - s, 0, s, H, [c, c, c, 0]),
    plate(0, H - b, w, b, [0, 0, c, c]),
    plate(0, Math.round(H * 0.5 - b / 2), w, b),
    plate(0, 0, w, b, [c2, c, 0, 0]),
    plate(0, Math.round(H * 0.5 - b / 2), s, H - b - Math.round(H * 0.5 - b / 2)),
  ]);

  /* -- lowercase ------------------------------------------------------ *
   * The half of the font the old one did not have. Two rules govern every
   * shape here and both exist to keep 11px readable:
   *
   *  1. NO SHAPE MAY BE ANOTHER SHAPE ROTATED. A rectilinear `a` drawn as
   *     a single-storey bowl is identical to `o`, and `l` drawn as a bare
   *     stem is identical to `I` and to `1`. So `a` is double-storey with
   *     an open upper-left aperture, `l` has a foot, `I` has both serifs
   *     and `1` has a flag. Distinctness beats consistency.
   *  2. APERTURES STAY OPEN. `c`, `e` and `s` keep their opening at full
   *     stroke width rather than closing toward a terminal, because at
   *     x-height 8px a narrowed aperture is a closed one.
   * -------------------------------------------------------------------- */

  def('a', 0.94, (w) => {
    const bowl = Math.round(X * 0.54);
    return [
      plate(w - s, 0, s, X, [0, c, c, 0]),
      plate(0, X - b, w - s, b, [0, 0, 0, c]),
      plate(0, 0, w, b, [c, 0, 0, 0]),
      plate(0, 0, s, bowl),
      plate(0, bowl - b, w, b),
    ];
  }, lc);
  def('b', 0.94, (w) => [
    plate(0, 0, s, A, [c, 0, 0, c]),
    plate(0, 0, w, X, [0, c, c, 0]),
    hole(s, b, w - s * 2, X - b * 2, [0, c, c, 0]),
  ], lc);
  def('c', 0.90, (w) => [
    plate(0, 0, s, X, [c, 0, 0, c]),
    plate(0, X - b, w, b, [0, c2, 0, 0]),
    plate(0, 0, w, b, [0, 0, c2, 0]),
  ], lc);
  def('d', 0.94, (w) => [
    plate(w - s, 0, s, A, [0, c, c, 0]),
    plate(0, 0, w, X, [c, 0, 0, c]),
    hole(s, b, w - s * 2, X - b * 2, [c, 0, 0, c]),
  ], lc);
  def('e', 0.94, (w) => {
    const mid = Math.round(X * 0.5 - b / 2);
    return [
      plate(0, 0, s, X, [c, 0, 0, c]),
      plate(0, X - b, w, b, [0, c, 0, 0]),
      plate(0, mid, w, b),
      plate(0, 0, w, b, [0, 0, c2, 0]),
      plate(w - s, mid, s, X - b - mid, [0, c, 0, 0]),
    ];
  }, lc);
  // The stem sits in from the left so the crossbar can overhang it, which is
  // the only thing that separates an `f` from an `F` set at x-height.
  def('f', 0.66, (w) => {
    const fx = Math.round(w * 0.30);
    return [
      plate(fx, 0, s, A - b, [0, 0, 0, c]),
      plate(fx, A - b, w - fx, b, [0, c, c, 0]),
      plate(0, X - b, w, b, [0, c, c, 0]),
    ];
  }, lc);
  // The tail starts in from the left edge and turns back up. Drawn flush to
  // x=0 it is a full-width rule under the bowl, and in a word it reads as an
  // underline rather than as a descender — which is what it did.
  def('g', 0.94, (w) => {
    const tx = Math.round(w * 0.18);
    return [
      plate(0, 0, w, X, [0, 0, c, c]),
      hole(s, b, w - s * 2, X - b * 2, [0, 0, c, c]),
      plate(w - s, D, s, -D, [0, c, 0, 0]),
      plate(tx, D, w - s - tx, b, [c, 0, 0, 0]),
      plate(tx, D, s, Math.round(-D * 0.42), [c, 0, 0, 0]),
    ];
  }, lc);
  def('h', 0.94, (w) => [
    plate(0, 0, s, A, [c, 0, 0, c]),
    plate(0, X - b, w, b),
    plate(w - s, 0, s, X, [c, c, 0, 0]),
  ], lc);
  def('i', 0.42, (w) => [
    plate(Math.round(w / 2 - s / 2), 0, s, X, [c, c, c, c]),
    plate(Math.round(w / 2 - s / 2), dotY, s, s, [c, c, c, c]),
  ], lc);
  def('j', 0.50, (w) => [
    plate(w - s, D + b, s, X - D - b, [0, 0, c, c]),
    plate(0, D, w - s, b, [c, 0, 0, 0]),
    plate(0, D, s, Math.round(-D * 0.42), [c, 0, 0, 0]),
    plate(w - s, dotY, s, s, [c, c, c, c]),
  ], lc);
  def('k', 0.92, (w) => {
    const j = Math.round(X * 0.44);
    const tx = Math.round(s * 1.42);
    return [
      plate(0, 0, s, A, [c, 0, 0, c]),
      vbar(tx / 2, j, w - tx / 2, X, tx),
      vbar(tx / 2, j, w - tx / 2, 0, tx),
      plate(0, j - s * 0.55, s * 1.4, s * 1.1),
    ];
  }, lc);
  def('l', 0.46, (w) => [
    plate(0, 0, s, A, [0, 0, 0, c]),
    plate(0, 0, w, b, [c, c, 0, 0]),
  ], lc);
  def('m', 1.44, (w) => [
    plate(0, 0, s, X, [c, 0, 0, c]),
    plate(0, X - b, w, b, [0, 0, c, 0]),
    plate(Math.round(w / 2 - s / 2), 0, s, X, [c, c, 0, 0]),
    plate(w - s, 0, s, X, [c, c, 0, 0]),
  ], lc);
  def('n', 0.94, (w) => [
    plate(0, 0, s, X, [c, 0, 0, c]),
    plate(0, X - b, w, b, [0, 0, c, 0]),
    plate(w - s, 0, s, X, [c, c, 0, 0]),
  ], lc);
  def('o', 0.94, (w) => [
    plate(0, 0, w, X, [c2, c2, c2, c2]),
    hole(s, b, w - s * 2, X - b * 2, [c, c, c, c]),
  ], lc);
  def('p', 0.94, (w) => [
    plate(0, D, s, X - D, [c, 0, 0, 0]),
    plate(0, 0, w, X, [0, c, c, 0]),
    hole(s, b, w - s * 2, X - b * 2, [0, c, c, 0]),
  ], lc);
  def('q', 0.94, (w) => [
    plate(w - s, D, s, X - D, [0, c, 0, 0]),
    plate(0, 0, w, X, [c, 0, 0, c]),
    hole(s, b, w - s * 2, X - b * 2, [c, 0, 0, c]),
  ], lc);
  def('r', 0.66, (w) => [
    plate(0, 0, s, X, [c, 0, 0, c]),
    plate(0, X - b, w, b, [0, c, c, 0]),
  ], lc);
  def('s', 0.90, (w) => {
    const mid = Math.round(X * 0.5 - b / 2);
    return [
      plate(0, X - b, w, b, [0, c2, c, c]),
      plate(0, mid, w, b),
      plate(0, 0, w, b, [c, c, c2, 0]),
      plate(0, mid, s, X - b - mid),
      plate(w - s, b, s, mid - b),
    ];
  }, lc);
  def('t', 0.62, (w) => [
    plate(0, b, s, Math.round(A * 0.84) - b, [0, 0, c, c]),
    plate(0, X - b, w, b, [0, c, c, 0]),
    plate(0, 0, w, b, [c, c, 0, 0]),
  ], lc);
  def('u', 0.94, (w) => [
    plate(0, b, s, X - b, [0, 0, c, c]),
    plate(0, 0, w, b, [c, 0, 0, 0]),
    plate(w - s, 0, s, X, [0, c, c, 0]),
  ], lc);
  def('v', 0.92, (w) => {
    const tx = Math.round(s * 1.16);
    return [
      vbar(tx / 2, X, w / 2, 0, tx),
      vbar(w - tx / 2, X, w / 2, 0, tx),
      plate(w / 2 - tx / 2, 0, tx, s * 0.7, [c, c, 0, 0]),
    ];
  }, lc);
  def('w', 1.40, (w) => {
    const tx = Math.round(s * 1.10);
    const v = Math.round(X * 0.30);
    return [
      vbar(tx / 2, X, Math.round(w * 0.28), 0, tx),
      vbar(Math.round(w * 0.28), 0, w / 2, v, tx),
      vbar(w / 2, v, Math.round(w * 0.72), 0, tx),
      vbar(Math.round(w * 0.72), 0, w - tx / 2, X, tx),
      plate(w / 2 - tx / 2, v - s * 0.45, tx, s * 0.9),
    ];
  }, lc);
  def('x', 0.90, (w) => {
    const tx = Math.round(s * 1.34);
    return [vbar(tx / 2, 0, w - tx / 2, X, tx), vbar(w - tx / 2, 0, tx / 2, X, tx)];
  }, lc);
  def('y', 0.92, (w) => {
    const tx = Math.round(s * 1.16);
    return [
      vbar(w - tx / 2, X, tx / 2, D, tx),
      vbar(tx / 2, X, Math.round(w * 0.52), Math.round(X * 0.36), tx),
    ];
  }, lc);
  def('z', 0.88, (w) => [
    plate(0, X - b, w, b, [0, 0, c, c]),
    plate(0, 0, w, b, [c, c, 0, 0]),
    hbar(w - s * 0.2, X - b, s * 0.2, b, Math.round(b * 1.9)),
  ], lc);

  /* -- punctuation and symbols ---------------------------------------- *
   * Coverage here is not decoration. A code point with no glyph falls back
   * PER CHARACTER to the next family in the CSS stack, so one missing
   * middot puts a system font on screen inside an otherwise correct line —
   * and that is exactly the failure this whole module exists to end. The
   * set below is the union of every character `src/ui/*` and
   * `src/characters/roster.js` actually emit, plus the rest of printable
   * ASCII so a future string cannot open a hole.
   * -------------------------------------------------------------------- */

  const dot = Math.round(s * 1.06);
  def(' ', 0.62, () => []);
  def('.', 0.42, (w) => [plate(w / 2 - dot / 2, 0, dot, dot, [c, c, c, c])]);
  def(',', 0.42, (w) => [
    plate(w / 2 - dot / 2, 0, dot, dot, [c, c, c, c]),
    plate(w / 2 - dot / 2, -Math.round(dot * 0.9), Math.round(dot * 0.62), Math.round(dot * 1.0)),
  ]);
  def(':', 0.42, (w) => [
    plate(w / 2 - dot / 2, Math.round(X * 0.06), dot, dot, [c, c, c, c]),
    plate(w / 2 - dot / 2, Math.round(X - dot - X * 0.06), dot, dot, [c, c, c, c]),
  ]);
  def(';', 0.42, (w) => [
    plate(w / 2 - dot / 2, 0, dot, dot, [c, c, c, c]),
    plate(w / 2 - dot / 2, -Math.round(dot * 0.9), Math.round(dot * 0.62), Math.round(dot * 1.0)),
    plate(w / 2 - dot / 2, Math.round(X - dot), dot, dot, [c, c, c, c]),
  ]);
  def('!', 0.42, (w) => [
    plate(w / 2 - s / 2, Math.round(H * 0.26), s, H - Math.round(H * 0.26), [0, 0, c, c]),
    plate(w / 2 - dot / 2, 0, dot, dot, [c, c, c, c]),
  ]);
  def('?', 0.80, (w) => {
    const shoulder = Math.round(H * 0.62);
    const cx = Math.round(w / 2 - s / 2);
    return [
      plate(0, H - b, w, b, [0, 0, c, c]),
      plate(0, shoulder, s, H - b - shoulder, [0, 0, 0, c]),
      plate(w - s, shoulder, s, H - b - shoulder, [0, c, 0, 0]),
      plate(cx, shoulder, w - s - cx, b),
      plate(cx, Math.round(H * 0.28), s, shoulder - Math.round(H * 0.28), [c, c, 0, 0]),
      plate(w / 2 - dot / 2, 0, dot, dot, [c, c, c, c]),
    ];
  });
  def("'", 0.34, (w) => [plate(w / 2 - s / 2, Math.round(H * 0.66), s, Math.round(H * 0.34), [0, 0, c, c])]);
  def('"', 0.60, (w) => [
    plate(Math.round(w * 0.16) - s / 2, Math.round(H * 0.66), s, Math.round(H * 0.34), [0, 0, c, c]),
    plate(Math.round(w * 0.84) - s / 2, Math.round(H * 0.66), s, Math.round(H * 0.34), [0, 0, c, c]),
  ]);
  def('/', 0.72, (w) => [vbar(Math.round(s * 0.6), 0, w - Math.round(s * 0.6), H, Math.round(s * 1.2))]);
  def('\\', 0.72, (w) => [vbar(w - Math.round(s * 0.6), 0, Math.round(s * 0.6), H, Math.round(s * 1.2))]);
  def('|', 0.40, (w) => [plate(w / 2 - s / 2, -Math.round(H * 0.12), s, H * 1.12)]);
  // Parentheses are the bracket skeleton with the corner cuts opened all the
  // way out, so they read as the round pair against the square `[ ]` — the
  // only distinction available in a face with no curves in it.
  def('(', 0.50, (w) => [
    plate(0, Math.round(H * 0.14), s, Math.round(H * 0.72), [c2, 0, 0, c2]),
    vbar(s / 2, Math.round(H * 0.14), Math.round(w * 0.9), 0, Math.round(s * 1.6)),
    vbar(s / 2, Math.round(H * 0.86), Math.round(w * 0.9), H, Math.round(s * 1.6)),
  ]);
  def(')', 0.50, (w) => [
    plate(w - s, Math.round(H * 0.14), s, Math.round(H * 0.72), [0, c2, c2, 0]),
    vbar(w - s / 2, Math.round(H * 0.14), Math.round(w * 0.1), 0, Math.round(s * 1.6)),
    vbar(w - s / 2, Math.round(H * 0.86), Math.round(w * 0.1), H, Math.round(s * 1.6)),
  ]);
  def('[', 0.48, (w) => [
    plate(0, 0, s, H, [c, 0, 0, c]),
    plate(0, H - b, w, b, [0, c, 0, 0]),
    plate(0, 0, w, b, [0, c, 0, 0]),
  ]);
  def(']', 0.48, (w) => [
    plate(w - s, 0, s, H, [0, c, c, 0]),
    plate(0, H - b, w, b, [0, 0, 0, c]),
    plate(0, 0, w, b, [c, 0, 0, 0]),
  ]);
  def('{', 0.56, (w) => [
    plate(Math.round(w * 0.34), 0, s, H, [c, 0, 0, c]),
    plate(Math.round(w * 0.34), H - b, Math.round(w * 0.66), b, [0, c, 0, 0]),
    plate(Math.round(w * 0.34), 0, Math.round(w * 0.66), b, [0, c, 0, 0]),
    plate(0, Math.round(H * 0.5 - b / 2), Math.round(w * 0.34) + s, b, [c, 0, 0, c]),
  ]);
  def('}', 0.56, (w) => [
    plate(Math.round(w * 0.66) - s, 0, s, H, [0, c, c, 0]),
    plate(0, H - b, Math.round(w * 0.66), b, [0, 0, 0, c]),
    plate(0, 0, Math.round(w * 0.66), b, [c, 0, 0, 0]),
    plate(Math.round(w * 0.66) - s, Math.round(H * 0.5 - b / 2), w - Math.round(w * 0.66) + s, b, [0, c, c, 0]),
  ]);
  def('<', 0.72, (w) => {
    const m = Math.round(H * 0.46);
    return [hbar(w, H * 0.82, 0, m, Math.round(b * 1.5)), hbar(0, m, w, H * 0.10, Math.round(b * 1.5))];
  });
  def('>', 0.72, (w) => {
    const m = Math.round(H * 0.46);
    return [hbar(0, H * 0.82, w, m, Math.round(b * 1.5)), hbar(w, m, 0, H * 0.10, Math.round(b * 1.5))];
  });
  def('+', 0.78, (w) => [
    plate(0, Math.round(H * 0.42 - b / 2), w, b),
    plate(w / 2 - b / 2, Math.round(H * 0.42) - Math.round(w / 2), b, w),
  ]);
  def('-', 0.62, (w) => [plate(0, Math.round(H * 0.42 - b / 2), w, b, [0, c, 0, c])]);
  def('=', 0.72, (w) => [
    plate(0, Math.round(H * 0.28), w, b, [0, c, 0, c]),
    plate(0, Math.round(H * 0.54), w, b, [0, c, 0, c]),
  ]);
  def('_', 0.72, (w) => [plate(0, -Math.round(H * 0.14), w, b)]);
  def('*', 0.62, (w) => {
    const cy = Math.round(H * 0.74);
    const r = Math.round(w * 0.5);
    return [
      plate(w / 2 - b / 2, cy - r, b, r * 2),
      hbar(w / 2 - r * 0.86, cy - r * 0.5, w / 2 + r * 0.86, cy + r * 0.5, Math.round(b * 1.7)),
      hbar(w / 2 - r * 0.86, cy + r * 0.5, w / 2 + r * 0.86, cy - r * 0.5, Math.round(b * 1.7)),
    ];
  });
  def('#', 0.94, (w) => [
    plate(0, Math.round(H * 0.26), w, b),
    plate(0, Math.round(H * 0.54), w, b),
    plate(Math.round(w * 0.26), 0, b, H * 0.86),
    plate(Math.round(w * 0.62), 0, b, H * 0.86),
  ]);
  def('%', 1.12, (w) => {
    const r = Math.round(H * 0.30);
    return [
      plate(0, H - r, r, r, [c, c, c, c]),
      hole(b, H - r + b, r - b * 2, r - b * 2),
      plate(w - r, 0, r, r, [c, c, c, c]),
      hole(w - r + b, b, r - b * 2, r - b * 2),
      vbar(w - Math.round(s * 0.55), H, Math.round(s * 0.55), 0, Math.round(s * 1.1)),
    ];
  });
  def('&', 1.06, (w) => {
    const uw = Math.round(w * 0.60);
    const lw = Math.round(w * 0.74);
    const mid = Math.round(H * 0.54);
    return [
      plate(0, mid, uw, H - mid, [0, 0, c, c]),
      hole(s, mid + b, uw - s * 2, H - mid - b * 2),
      plate(0, 0, lw, mid + b, [c, c, 0, 0]),
      hole(s, b, lw - s * 2, mid - b),
      vbar(Math.round(w * 0.42), Math.round(H * 0.30), w - Math.round(s * 0.65), H, Math.round(s * 1.3)),
    ];
  });
  def('@', 1.18, (w) => [
    plate(0, 0, w, H, [c2, c2, c2, c2]),
    hole(s, b, w - s * 2, H - b * 2, [c, c, c, c]),
    plate(Math.round(w * 0.30), Math.round(H * 0.24), Math.round(w * 0.40), Math.round(H * 0.44), [c, c, c, c]),
    hole(Math.round(w * 0.30) + b, Math.round(H * 0.24) + b, Math.round(w * 0.40) - b * 2, Math.round(H * 0.44) - b * 2),
    plate(Math.round(w * 0.62), Math.round(H * 0.24), Math.round(w * 0.20), b),
  ]);
  def('$', 0.94, (w) => {
    const mid = Math.round(H * 0.5 - b / 2);
    return [
      plate(0, Math.round(H * 0.80), w, b),
      plate(0, mid, w, b),
      plate(0, Math.round(H * 0.10), w, b),
      plate(0, mid, s, Math.round(H * 0.80) - mid),
      plate(w - s, Math.round(H * 0.10), s, mid - Math.round(H * 0.10)),
      plate(w / 2 - b / 2, 0, b, H),
    ];
  });
  def('~', 0.78, (w) => [
    hbar(0, Math.round(H * 0.40), w / 2, Math.round(H * 0.52), Math.round(b * 1.5)),
    hbar(w / 2, Math.round(H * 0.52), w, Math.round(H * 0.40), Math.round(b * 1.5)),
  ]);
  def('^', 0.72, (w) => [
    vbar(Math.round(s * 0.6), Math.round(H * 0.62), w / 2, H, Math.round(s * 1.2)),
    vbar(w - Math.round(s * 0.6), Math.round(H * 0.62), w / 2, H, Math.round(s * 1.2)),
  ]);
  def('`', 0.40, (w) => [vbar(Math.round(s * 0.6), H, w - Math.round(s * 0.6), Math.round(H * 0.72), Math.round(s * 1.2))]);

  /* Non-ASCII, all of it in use: the move list's direction arrows and
   * separators, the roster dossier's em/en dashes, the section mark and the
   * true minus in the frame-data tables. */
  def('·', 0.42, (w) => [plate(w / 2 - dot / 2, Math.round(H * 0.34), dot, dot, [c, c, c, c])]);
  def('–', 0.86, (w) => [plate(0, Math.round(H * 0.42 - b / 2), w, b)]);          // en dash
  def('—', 1.20, (w) => [plate(0, Math.round(H * 0.42 - b / 2), w, b)]);          // em dash
  def('−', 0.78, (w) => [plate(0, Math.round(H * 0.42 - b / 2), w, b)]);          // minus
  def('…', 1.20, (w) => {                                                        // ellipsis
    const g = Math.round((w - dot) / 2);
    return [0, 1, 2].map((i) => plate(i * g, 0, dot, dot, [c, c, c, c]));
  });
  def('§', 0.80, (w) => {
    const q = Math.round(H * 0.5);
    return [
      plate(0, q, w, b), plate(0, H - b, w, b), plate(0, q, s, H - b - q),
      plate(w - s, q + b, s, H - b - q - b),
      plate(0, 0, w, b), plate(0, q - b, w, b), plate(w - s, 0, s, q - b),
      plate(0, b, s, q - b * 2),
    ];
  });
  def('▸', 0.66, (w) => [                                                        // ▸
    vbar(Math.round(w * 0.22), Math.round(H * 0.14), Math.round(w * 0.78), Math.round(H * 0.42), Math.round(s * 1.5)),
    vbar(Math.round(w * 0.22), Math.round(H * 0.70), Math.round(w * 0.78), Math.round(H * 0.42), Math.round(s * 1.5)),
    plate(Math.round(w * 0.22), Math.round(H * 0.14), Math.round(s * 1.2), Math.round(H * 0.56)),
  ]);
  def('›', 0.52, (w) => [                                                        // ›
    hbar(0, Math.round(H * 0.68), w, Math.round(H * 0.40), Math.round(b * 1.5)),
    hbar(w, Math.round(H * 0.40), 0, Math.round(H * 0.12), Math.round(b * 1.5)),
  ]);

  /**
   * Direction arrows. The move list sets a whole notation language in these
   * (`↗` is up-forward, not a decoration), so they are drawn on the same
   * stroke weight as the letters and sit on the same optical centre — an
   * arrow lifted from a system font would be the one glyph on the row in a
   * different typeface, at a different weight, on a different baseline.
   */
  const arrowCY = Math.round(H * 0.42);
  const at = Math.round(s * 1.15);
  const head = (w2) => Math.round(w2 * 0.34);
  def('←', 0.92, (w) => {                                                        // <-
    const hd = head(w);
    return [
      plate(0, arrowCY - b / 2, w, b),
      vbar(hd, arrowCY + hd, 0, arrowCY, at),
      vbar(hd, arrowCY - hd, 0, arrowCY, at),
    ];
  });
  def('→', 0.92, (w) => {                                                        // ->
    const hd = head(w);
    return [
      plate(0, arrowCY - b / 2, w, b),
      vbar(w - hd, arrowCY + hd, w, arrowCY, at),
      vbar(w - hd, arrowCY - hd, w, arrowCY, at),
    ];
  });
  def('↑', 0.92, (w) => {                                                        // up
    const hd = head(w);
    return [
      plate(w / 2 - b / 2, arrowCY - Math.round(H * 0.36), b, Math.round(H * 0.72)),
      vbar(w / 2 - hd, arrowCY + Math.round(H * 0.36) - hd, w / 2, arrowCY + Math.round(H * 0.36), at),
      vbar(w / 2 + hd, arrowCY + Math.round(H * 0.36) - hd, w / 2, arrowCY + Math.round(H * 0.36), at),
    ];
  });
  def('↓', 0.92, (w) => {                                                        // down
    const hd = head(w);
    return [
      plate(w / 2 - b / 2, arrowCY - Math.round(H * 0.36), b, Math.round(H * 0.72)),
      vbar(w / 2 - hd, arrowCY - Math.round(H * 0.36) + hd, w / 2, arrowCY - Math.round(H * 0.36), at),
      vbar(w / 2 + hd, arrowCY - Math.round(H * 0.36) + hd, w / 2, arrowCY - Math.round(H * 0.36), at),
    ];
  });
  const diag = (chr, sx, sy, ex, ey) => def(chr, 0.92, (w) => {
    const r = Math.round(H * 0.30);
    const x0 = w / 2 + sx * r; const y0 = arrowCY + sy * r;
    const x1 = w / 2 + ex * r; const y1 = arrowCY + ey * r;
    // The barbs of a 45-degree arrow are exactly horizontal and vertical, so
    // they are plates rather than diagonals. They were 1.8 times as long as
    // they were thick, which reads as a hook on the end of a stick rather
    // than as an arrowhead; at 2.9 it reads as a chevron. This is the move
    // list's whole notation language — `↗` means up-forward, not decoration —
    // so it has to be unambiguous at a glance.
    const hd = Math.round(r * 0.88);
    const bt = Math.round(b * 0.86);
    return [
      vbar(x0, y0, x1, y1, Math.round(at * 1.35)),
      plate(x1 - (ex > 0 ? hd : 0), y1 - bt / 2, hd, bt),
      plate(x1 - (ex > 0 ? bt : 0), y1 - (ey > 0 ? hd : 0), bt, hd),
    ];
  });
  diag('↗', -1, -1, 1, 1);   // up-right
  diag('↘', -1, 1, 1, -1);   // down-right
  diag('↖', 1, -1, -1, 1);   // up-left
  diag('↙', 1, 1, -1, -1);   // down-left

  /* -- assemble -------------------------------------------------------- */

  /*
   * SPACING IS DERIVED FROM THE INK, NOT FROM THE NOMINAL WIDTH.
   *
   * Each drawing above is laid out on a nominal box, but a diagonal is a
   * parallelogram and its corners sit half a stroke-width outside the
   * centreline it was given — so `K`, `M`, `N`, the `R` leg, the `Q` tail, the
   * solidus and every arrowhead put ink outside their box. Rendered at 220px
   * the `K` had a visible spike through the left of its stem, and every one of
   * them was quietly eating its own right sidebearing and colliding with the
   * next letter.
   *
   * The drawings that were wrong are fixed. But sizing the advance off a
   * nominal width is the thing that let a drawing error become a SPACING error
   * silently, so the advance is now measured from the outline that actually
   * exists: left sidebearing, ink, right sidebearing. A future glyph that
   * overshoots its box is then merely a drawing to look at, not a collision.
   */
  const glyphs = new Map();
  const inkCap = p.fixed ? p.fixed - p.side * 2 : Infinity;
  const tabular = Math.round(W * fw) + p.side * 2; // one advance for all figures
  for (const [ch, d] of Object.entries(defs)) {
    // On the data cut the wide glyphs (`M W m w @ —`) are redrawn narrower
    // rather than overflowing their slot — which is what a monospaced face
    // does, and the reason `M` is the letter that tells you a face is one.
    const iw = Math.min(d.w, inkCap);
    const contours = d.draw(iw).filter(Boolean);
    const code = ch.codePointAt(0);

    let lo = Infinity;
    let hi = -Infinity;
    for (const { pts } of contours) for (const [x] of pts) { if (x < lo) lo = x; if (x > hi) hi = x; }
    const inked = hi >= lo;
    const width = inked ? hi - lo : 0;

    let advance;
    let shift;
    if (p.fixed) {
      advance = p.fixed;
      shift = Math.round((p.fixed - width) / 2) - (inked ? lo : 0);
    } else if (code >= 0x30 && code <= 0x39) {
      // Figures stay tabular whatever their ink measures, so a timer counting
      // down and a damage readout ticking up never reflow mid-animation.
      advance = tabular;
      shift = Math.round((tabular - width) / 2) - lo;
    } else if (!inked) {
      advance = d.w + p.side * 2; // the space glyph: nominal is all there is
      shift = 0;
    } else {
      advance = width + p.side * 2;
      shift = p.side - lo;
    }
    for (const c2r of contours) c2r.pts = c2r.pts.map(([x, y]) => [Math.round(x + shift), Math.round(y)]);
    glyphs.set(code, { advance: Math.round(advance), contours, ink: width });
  }

  return {
    upm: p.upm,
    capHeight: H,
    xHeight: X,
    ascender: Math.round(H * 1.06),
    descender: D,
    lineGap: 0,
    stem: s,
    bar: b,
    glyphs,
  };
}
