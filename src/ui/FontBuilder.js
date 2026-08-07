/**
 * Knockbots — TrueType (sfnt) assembler.
 *
 * The charter forbids fetching a font, and embedding somebody else's outlines
 * as base64 is the same thing with extra steps. So the interface's face is
 * *compiled at boot*: `src/ui/Glyphs.js` draws the outlines as integer
 * polygons, this file packs them into a real `.ttf` in memory, and
 * `Typeface.js` hands the buffer to `new FontFace(name, buffer)`. From CSS's
 * point of view it is an ordinary installed family; from the build's point of
 * view it is ~9 kB of arithmetic and no network request.
 *
 * WHY A FONT FILE AND NOT MORE SVG MASKS. `Typeface.js` already had a
 * mask-image path, and it covers exactly six elements (the announcement, the
 * timer, the combo tally, the select-screen name, the results winner, the
 * title logo). Everything else in `#ui` — every label, every stat key, every
 * button, every move-list row — is real text laid out by the browser, and no
 * mask can do line breaking, tabular figures, `text-transform`, selection or
 * accessibility. Those elements were resolving to whatever the platform had.
 * The only fix that reaches them is a family the CSS cascade can name.
 *
 * WHAT IS IN HERE. The nine tables a rasteriser actually requires, plus OS/2
 * which Chromium's OpenType Sanitiser rejects the file without:
 *
 *     head hhea maxp hmtx cmap loca glyf name post OS/2
 *
 * All outlines are straight-line polygons, so every point is on-curve and the
 * `glyf` encoder never has to emit a control point. Contours carry explicit
 * winding: counters are wound against their outer contour so `nonzero` cuts
 * them out, and every other stroke is wound *with* it so overlapping strokes
 * union instead of cancelling. That is the same rule the old mask path
 * depended on, and it is the reason a bowl and the bar crossing it can be
 * drawn as two independent rectangles.
 *
 * DETERMINISM. `head.created`/`modified` are a frozen constant rather than
 * `Date.now()`, so the same glyph set always compiles to a byte-identical
 * file. That is what lets `tools/` diff two builds and lets the offline
 * validator assert on a checksum.
 */

/** 1904-01-01 epoch seconds for 2026-01-01T00:00:00Z — frozen, see above. */
const FROZEN_DATE = 3849984000;

/** Growable big-endian byte sink. */
class Writer {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }

  _need(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v) { this._need(1); this.buf[this.len++] = v & 0xff; return this; }

  u16(v) {
    this._need(2);
    this.buf[this.len++] = (v >> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  /** int16; the caller is responsible for the value being in range. */
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }

  u32(v) {
    this._need(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); return this; }

  bytes(arr) { this._need(arr.length); this.buf.set(arr, this.len); this.len += arr.length; return this; }

  /** Pad to a 4-byte boundary; sfnt requires every table to start aligned. */
  pad4() { while (this.len & 3) this.u8(0); return this; }

  done() { return this.buf.slice(0, this.len); }
}

/** sfnt table checksum: sum of big-endian u32 words over the zero-padded table. */
function checksum(bytes) {
  let sum = 0;
  const n = (bytes.length + 3) & ~3;
  for (let i = 0; i < n; i += 4) {
    const w = ((bytes[i] || 0) << 24) | ((bytes[i + 1] || 0) << 16)
      | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0);
    sum = (sum + (w >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** Shoelace sign; used to force a contour's direction before it is written. */
function area2(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s;
}

/**
 * TrueType fills with `nonzero`, so the only thing that matters is that
 * counters wind opposite to the shape they are cut out of. `Glyphs.js` tags
 * every contour with `dir` (+1 solid, -1 counter) and this normalises the
 * point order to match, so a glyph author can list points in whichever
 * direction reads naturally in the source.
 */
function orient(pts, dir) {
  const a = area2(pts);
  const want = dir >= 0 ? 1 : -1;
  const have = a >= 0 ? 1 : -1;
  return have === want ? pts : pts.slice().reverse();
}

/**
 * One glyph's `glyf` entry.
 *
 * Every point is on-curve (flag bit 0) and every delta is written as a signed
 * 16-bit value — the short/same encodings would save perhaps 30% of a 9 kB
 * file and cost a class of bug that only shows up as a subtly wrong outline
 * at one size. Not a trade worth taking here.
 *
 * A glyph with no contours (the space) writes zero bytes; `loca` then has two
 * equal offsets, which is how a blank glyph is spelled.
 */
function glyfEntry(contours) {
  const rings = contours
    .map((c) => orient(c.pts, c.dir))
    .filter((p) => p.length >= 3);
  if (!rings.length) {
    return { bytes: new Uint8Array(0), blank: true, xMin: 0, yMin: 0, xMax: 0, yMax: 0, points: 0, contours: 0 };
  }

  let xMin = Infinity; let yMin = Infinity; let xMax = -Infinity; let yMax = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }

  const w = new Writer(256);
  w.i16(rings.length).i16(xMin).i16(yMin).i16(xMax).i16(yMax);
  let end = -1;
  for (const ring of rings) { end += ring.length; w.u16(end); }
  w.u16(0); // instructionLength
  const total = end + 1;
  for (let i = 0; i < total; i++) w.u8(0x01); // on-curve, long x and y deltas
  let px = 0;
  for (const ring of rings) for (const [x] of ring) { w.i16(x - px); px = x; }
  let py = 0;
  for (const ring of rings) for (const [, y] of ring) { w.i16(y - py); py = y; }
  w.pad4();
  return { bytes: w.done(), xMin, yMin, xMax, yMax, points: total, contours: rings.length };
}

/** `cmap` format 4: contiguous runs collapsed into segments with an idDelta. */
function cmapFormat4(codeToGid) {
  const codes = [...codeToGid.keys()].filter((c) => c > 0 && c <= 0xffff).sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < codes.length;) {
    const start = codes[i];
    const delta = (codeToGid.get(start) - start) & 0xffff;
    let j = i;
    while (j + 1 < codes.length
      && codes[j + 1] === codes[j] + 1
      && ((codeToGid.get(codes[j + 1]) - codes[j + 1]) & 0xffff) === delta) j++;
    segs.push({ start, end: codes[j], delta });
    i = j + 1;
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const n = segs.length;
  const sub = new Writer(64 + n * 8);
  const len = 16 + n * 8;
  // `sr` MUST seed at 1, not 2, or `es` lands one below log2(sr) and every cut
  // is rejected outright: Chromium's sanitiser validates cmap format 4's
  // entrySelector against segCount and refuses the whole file on a mismatch
  // ("Invalid font data in ArrayBuffer"), so all eight faces silently fell back
  // to the system stack. Verified against the browser: with segCount 11 this
  // wrote entrySelector 2 where the spec requires 3, and correcting that one
  // 16-bit field is the difference between REJECTED and LOADED. This is the
  // same computation the sfnt header does below, which seeds at 1 and is right.
  let sr = 1;
  let es = 0;
  while (sr * 2 <= n) { sr *= 2; es++; }
  sub.u16(4).u16(len).u16(0);
  sub.u16(n * 2).u16(sr * 2).u16(es).u16(n * 2 - sr * 2);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0);
  for (const s of segs) sub.u16(s.start);
  for (const s of segs) sub.u16(s.delta);
  for (let i = 0; i < n; i++) sub.u16(0); // idRangeOffset — all deltas, no glyph array
  const subtable = sub.done();

  // Two encoding records pointing at one subtable: (3,1) is what Chromium's
  // sanitiser looks for, (0,3) is what a strict Unicode-only consumer wants.
  const w = new Writer(subtable.length + 32);
  const off = 4 + 2 * 8;
  w.u16(0).u16(2);
  w.u16(3).u16(1).u32(off);
  w.u16(0).u16(3).u32(off);
  w.bytes(subtable);
  return w.done();
}

/** `name`, Windows/Unicode-BMP/English, UTF-16BE. */
function nameTable(records) {
  const enc = (s) => {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[i * 2] = c >> 8;
      out[i * 2 + 1] = c & 0xff;
    }
    return out;
  };
  const entries = records.map(([id, str]) => ({ id, data: enc(str) }));
  const w = new Writer(256);
  const storageStart = 6 + entries.length * 12;
  w.u16(0).u16(entries.length).u16(storageStart);
  let off = 0;
  for (const e of entries) {
    w.u16(3).u16(1).u16(0x0409).u16(e.id).u16(e.data.length).u16(off);
    off += e.data.length;
  }
  for (const e of entries) w.bytes(e.data);
  return w.done();
}

/**
 * Compile a glyph set into a `.ttf`.
 *
 * @param {object} font
 * @param {number} font.unitsPerEm
 * @param {number} font.ascender      hhea/typo ascender, font units
 * @param {number} font.descender     negative
 * @param {number} font.lineGap
 * @param {number} font.capHeight
 * @param {number} font.xHeight
 * @param {number} font.weightClass   OS/2 usWeightClass, 100..900
 * @param {number} font.widthClass    OS/2 usWidthClass, 1..9
 * @param {string} font.family
 * @param {string} font.subfamily     'Regular' | 'Bold' | ...
 * @param {string} font.postScriptName
 * @param {Map<number, {advance:number, contours:{pts:number[][], dir:number}[]}>} font.glyphs
 *        keyed by Unicode code point. Gid 0 (.notdef) is generated here.
 * @returns {Uint8Array} a complete sfnt
 */
export function buildTTF(font) {
  const {
    unitsPerEm, ascender, descender, lineGap, capHeight, xHeight,
    weightClass, widthClass, family, subfamily, postScriptName, glyphs,
  } = font;

  // Gid order: .notdef, then code points ascending. cmap segments collapse
  // nicely because ASCII is contiguous and so is most of what follows.
  const codes = [...glyphs.keys()].sort((a, b) => a - b);
  const codeToGid = new Map();
  codes.forEach((c, i) => codeToGid.set(c, i + 1));

  /** .notdef: a hollow box, per convention — a visible tofu is a bug report. */
  const nd = Math.round(unitsPerEm * 0.06);
  const bw = Math.round(unitsPerEm * 0.44);
  const bh = capHeight;
  const notdef = {
    advance: bw + nd * 2,
    contours: [
      { dir: 1, pts: [[nd, 0], [nd + bw, 0], [nd + bw, bh], [nd, bh]] },
      { dir: -1, pts: [[nd * 2, nd], [nd * 2 + bw - nd * 2, nd], [nd * 2 + bw - nd * 2, bh - nd], [nd * 2, bh - nd]] },
    ],
  };

  const order = [notdef, ...codes.map((c) => glyphs.get(c))];
  const numGlyphs = order.length;

  const glyfW = new Writer(8192);
  const loca = [0];
  let maxPoints = 0;
  let maxContours = 0;
  let xMin = 0; let yMin = 0; let xMax = 0; let yMax = 0;
  let advanceMax = 0;
  let minLsb = 0;
  let minRsb = 0;
  let maxExtent = 0;
  const hmtx = [];

  for (const g of order) {
    const e = glyfEntry(g.contours || []);
    if (e.blank) {
      // A blank glyph is spelled as two equal `loca` offsets and no `glyf`
      // bytes at all — an empty contour list is NOT the same thing and some
      // rasterisers draw a notdef box for it.
      loca.push(glyfW.len);
      hmtx.push({ adv: g.advance, lsb: 0 });
      advanceMax = Math.max(advanceMax, g.advance);
      continue;
    }
    glyfW.bytes(e.bytes);
    loca.push(glyfW.len);
    maxPoints = Math.max(maxPoints, e.points);
    maxContours = Math.max(maxContours, e.contours);
    xMin = Math.min(xMin, e.xMin); yMin = Math.min(yMin, e.yMin);
    xMax = Math.max(xMax, e.xMax); yMax = Math.max(yMax, e.yMax);
    const lsb = e.xMin;
    const rsb = g.advance - e.xMax;
    minLsb = Math.min(minLsb, lsb);
    minRsb = Math.min(minRsb, rsb);
    maxExtent = Math.max(maxExtent, e.xMax);
    advanceMax = Math.max(advanceMax, g.advance);
    hmtx.push({ adv: g.advance, lsb });
  }
  const glyf = glyfW.done();

  const locaW = new Writer(numGlyphs * 4 + 8);
  for (const o of loca) locaW.u32(o);
  const locaBytes = locaW.done();

  const hmtxW = new Writer(numGlyphs * 4);
  for (const m of hmtx) hmtxW.u16(Math.round(m.adv)).i16(Math.round(m.lsb));
  const hmtxBytes = hmtxW.done();

  const headW = new Writer(64);
  headW.u32(0x00010000).u32(0x00010000).u32(0) // version, revision, checkSumAdjustment
    .u32(0x5f0f3cf5) // magic
    .u16(0b1011) // baseline at y=0, lsb at x=0, ppem integer
    .u16(unitsPerEm)
    .u32(0).u32(FROZEN_DATE) // created  (64-bit, high word always 0 here)
    .u32(0).u32(FROZEN_DATE) // modified
    .i16(xMin).i16(yMin).i16(xMax).i16(yMax)
    .u16(weightClass >= 700 ? 1 : 0) // macStyle: bold bit
    .u16(8) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(1) // indexToLocFormat: long
    .i16(0);
  const head = headW.done();

  const hheaW = new Writer(40);
  hheaW.u32(0x00010000)
    .i16(ascender).i16(descender).i16(lineGap)
    .u16(Math.round(advanceMax)).i16(minLsb).i16(minRsb).i16(maxExtent)
    .i16(1).i16(0).i16(0)
    .i16(0).i16(0).i16(0).i16(0)
    .i16(0).u16(numGlyphs);
  const hhea = hheaW.done();

  const maxpW = new Writer(36);
  maxpW.u32(0x00010000).u16(numGlyphs)
    .u16(maxPoints).u16(maxContours).u16(0).u16(0)
    .u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);
  const maxp = maxpW.done();

  const postW = new Writer(32);
  postW.u32(0x00030000).u32(0)
    .i16(-Math.round(unitsPerEm * 0.1)).i16(Math.round(unitsPerEm * 0.05))
    .u32(0).u32(0).u32(0).u32(0).u32(0);
  const post = postW.done();

  const firstChar = codes[0];
  const lastChar = codes[codes.length - 1];
  const os2W = new Writer(96);
  const avg = Math.round(hmtx.reduce((a, m) => a + m.adv, 0) / hmtx.length);
  os2W.u16(4) // version
    .i16(avg).u16(weightClass).u16(widthClass).u16(0) // fsType 0 = installable
    .i16(Math.round(unitsPerEm * 0.65)).i16(Math.round(unitsPerEm * 0.7))
    .i16(0).i16(Math.round(unitsPerEm * 0.14))
    .i16(Math.round(unitsPerEm * 0.65)).i16(Math.round(unitsPerEm * 0.7))
    .i16(0).i16(Math.round(unitsPerEm * 0.48))
    .i16(Math.round(unitsPerEm * 0.05)).i16(Math.round(capHeight * 0.38))
    .i16(0); // sFamilyClass
  // PANOSE: 2 (latin text) / 11 (normal sans) / weight / 6 (modified) /
  // 9 (monospaced) or 3 (modern) proportion — descriptive only, but a
  // zeroed panose makes some matchers treat the family as "any".
  const panose = [2, 11, Math.min(11, Math.round(weightClass / 100) + 1), font.monospaced ? 9 : 6,
    2, 2, 2, 2, 2, 4];
  for (const p of panose) os2W.u8(p);
  os2W.u32(0x00000003).u32(0).u32(0).u32(0) // unicode ranges: latin-1 + basic latin
    .tag('KBOT')
    .u16(weightClass >= 700 ? 0x0020 : 0x0040) // fsSelection: BOLD or REGULAR
    .u16(firstChar).u16(lastChar)
    .i16(ascender).i16(descender).i16(lineGap)
    .u16(ascender).u16(-descender)
    .u32(0x00000001).u32(0) // codepage: latin-1
    .i16(xHeight).i16(capHeight)
    .u16(0x0020).u16(0x0020).u16(1);
  const os2 = os2W.done();

  const name = nameTable([
    [0, 'Generated at runtime by Knockbots. No third-party outlines.'],
    [1, family],
    [2, subfamily],
    [3, `Knockbots:${postScriptName}`],
    [4, `${family} ${subfamily}`],
    [5, 'Version 1.000'],
    [6, postScriptName],
  ]);

  const tables = [
    ['OS/2', os2], ['cmap', cmapFormat4(codeToGid)], ['glyf', glyf],
    ['head', head], ['hhea', hhea], ['hmtx', hmtxBytes], ['loca', locaBytes],
    ['maxp', maxp], ['name', name], ['post', post],
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const n = tables.length;
  let sr = 1;
  let es = 0;
  while (sr * 2 <= n) { sr *= 2; es++; }
  const out = new Writer(64 + tables.reduce((a, t) => a + t[1].length + 4, 0));
  out.u32(0x00010000).u16(n).u16(sr * 16).u16(es).u16(n * 16 - sr * 16);

  let offset = 12 + n * 16;
  const dirAt = [];
  for (const [tag, bytes] of tables) {
    out.tag(tag).u32(checksum(bytes)).u32(offset).u32(bytes.length);
    dirAt.push(offset);
    offset += (bytes.length + 3) & ~3;
  }
  let headOffset = 0;
  tables.forEach(([tag], i) => { if (tag === 'head') headOffset = dirAt[i]; });
  for (const [, bytes] of tables) { out.bytes(bytes); out.pad4(); }

  const file = out.done();
  // checkSumAdjustment is defined over the whole file with this field zeroed,
  // which it currently is.
  const adj = (0xb1b0afba - checksum(file)) >>> 0;
  const at = headOffset + 8;
  file[at] = (adj >>> 24) & 0xff;
  file[at + 1] = (adj >>> 16) & 0xff;
  file[at + 2] = (adj >>> 8) & 0xff;
  file[at + 3] = adj & 0xff;
  return file;
}
