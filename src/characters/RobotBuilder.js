/**
 * Knockbots — procedural hard-surface robot construction.
 *
 * Why this file exists in the shape it does:
 *
 * A mechanical character skinned with ordinary smooth weights smears at every
 * joint — armour plates stretch like rubber and the whole read collapses. Real
 * hard-surface rigs do the opposite: every plate is *rigid*, bound 100% to a
 * single bone, and the joints are covered by exposed mechanism (pistons, rotary
 * housings, cable looms) that is *supposed* to slide and rotate. So that is what
 * this builder produces:
 *
 *   - Hundreds of small chamfered plates, each authored in one bone's local
 *     rest frame, baked into bind space, given skinIndex = thatBone / weight 1,
 *     then merged per material into a handful of THREE.SkinnedMesh draw calls.
 *   - A short list of genuinely soft parts — braided cable looms and boot
 *     shrouds — that smooth-blend across exactly two bones along their length.
 *   - Standalone instanced actuators that measure the live distance between two
 *     bone anchors every frame and physically telescope. They are driven from an
 *     `updateMatrixWorld` override so they are correct even if nobody calls into
 *     this module.
 *
 * Nothing here is a placeholder: bevels are real geometry (a plain box never
 * catches a highlight on its edge, and that single omission is what makes
 * procedural robots look like programmer art), lathes emit hard normals across
 * profile corners and smooth normals around the axis, and every warning stripe
 * and serial number is drawn into a canvas atlas at build time.
 *
 * Coordinate reminder, from Skeleton.js: +Y up, +X is the fighter's LEFT, and
 * the fighter FACES -Z. So "front of the chest" is at negative Z.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BONES } from './Skeleton.js';
import { LAYER } from '../core/Constants.js';
import { makeMaterialLibrary } from './Materials.js';

const DEG = Math.PI / 180;
const FRONT = -1; // multiply a "forward" offset by this to get world Z

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

/** Detail tiers. 0 = primary silhouette forms, 1 = panelling, 2 = greebles. */
const TIER = { PRIMARY: 0, SECONDARY: 1, GREEBLE: 2 };
const DETAIL_TIER = { low: 0, medium: 1, high: 2, ultra: 2 };

// ---------------------------------------------------------------------------
// Triangle accumulator
//
// Everything is authored non-indexed. That guarantees flat facets stay flat
// (no normal averaging across a chamfer) and it means mergeGeometries never has
// to reconcile index buffers. The cost is ~3x vertices on a model that is a few
// tens of thousands of triangles total, which is irrelevant next to the win.
// ---------------------------------------------------------------------------

class Surf {
  constructor() {
    this.p = [];
    this.n = [];
    this.t = [];
  }

  get triangles() { return this.p.length / 9; }

  /** Raw triangle with explicit per-vertex normals and UVs. */
  tri(a, b, c, na, nb, nc, ua, ub, uc) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.n.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
    this.t.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
  }

  /**
   * Quad with per-vertex normals, auto-oriented so its winding agrees with the
   * supplied normals. Collapses to a triangle when an edge is degenerate, which
   * is what happens at the poles of a lathe.
   */
  quad(a, b, c, d, na, nb, nc, nd, ua, ub, uc, ud) {
    const ref = [na[0] + nb[0] + nc[0] + nd[0], na[1] + nb[1] + nc[1] + nd[1], na[2] + nb[2] + nc[2] + nd[2]];
    if (dot(faceNormal(a, b, c), ref) < 0) {
      // reverse winding: a d c b
      [b, d] = [d, b];
      [nb, nd] = [nd, nb];
      [ub, ud] = [ud, ub];
    }
    if (near(a, b)) this.tri(a, c, d, na, nc, nd, ua, uc, ud);
    else if (near(b, c)) this.tri(a, b, d, na, nb, nd, ua, ub, ud);
    else if (near(c, d)) this.tri(a, b, c, na, nb, nc, ua, ub, uc);
    else if (near(d, a)) this.tri(a, b, c, na, nb, nc, ua, ub, uc);
    else {
      this.tri(a, b, c, na, nb, nc, ua, ub, uc);
      this.tri(a, c, d, na, nc, nd, ua, uc, ud);
    }
  }

  /**
   * Flat convex polygon. `ref` is any outward-pointing direction used to fix
   * the winding — for a convex solid centred near the origin the polygon
   * centroid works, which is why every primitive here is built centred.
   */
  flatPoly(pts, ref, uvScale = 1, uvOffset = null) {
    let n = newell(pts);
    if (dot(n, ref) < 0) { pts = pts.slice().reverse(); n = newell(pts); }
    const uvs = pts.map((p) => boxUv(p, n, uvScale, uvOffset));
    for (let i = 1; i < pts.length - 1; i++) {
      this.tri(pts[0], pts[i], pts[i + 1], n, n, n, uvs[0], uvs[i], uvs[i + 1]);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    return g;
  }
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function near(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] - b[2]) < 1e-6;
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Newell's method — stable for near-degenerate polygons. */
function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Planar box projection onto the dominant axis of the face normal. */
function boxUv(p, n, s, off) {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let u, v;
  if (ax >= ay && ax >= az) { u = p[2]; v = p[1]; }
  else if (ay >= az) { u = p[0]; v = p[2]; }
  else { u = p[0]; v = p[1]; }
  return off ? [u * s + off[0], v * s + off[1]] : [u * s, v * s];
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Chamfered box: six inset faces, twelve edge bevels, eight corner triangles.
 * 44 triangles, and the only primitive in this file allowed to define a
 * character's primary mass. `taper` values scale the top/bottom cross-section so
 * one call produces trapezoidal pauldrons and tapering limb armour.
 *
 * @param {number} w width (X)
 * @param {number} h height (Y)
 * @param {number} d depth (Z)
 * @param {number} bevel chamfer width in metres; clamped to 42% of the smallest half-extent
 * @param {Object} [opts]
 * @param {number} [opts.topX=1] X scale of the +Y cross-section
 * @param {number} [opts.topZ] Z scale of the +Y cross-section (defaults to topX)
 * @param {number} [opts.botX=1] X scale of the -Y cross-section
 * @param {number} [opts.botZ] Z scale of the -Y cross-section (defaults to botX)
 * @param {number} [opts.shearX=0] X displacement applied at +Y, linear in Y
 * @param {number} [opts.shearZ=0] Z displacement applied at +Y, linear in Y
 * @param {number} [opts.uv=1.4] UV density in tiles per metre
 * @returns {THREE.BufferGeometry}
 */
export function bevelBox(w, h, d, bevel = 0.012, opts = {}) {
  const { topX = 1, topZ = null, botX = 1, botZ = null, shearX = 0, shearZ = 0, uv = 1.4 } = opts;
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  const tX = topX, tZ = topZ ?? topX, bX = botX, bZ = botZ ?? botX;
  const minHalf = Math.min(hx * Math.min(tX, bX), hy, hz * Math.min(tZ, bZ));
  const b = Math.max(1e-4, Math.min(bevel, minHalf * 0.42));

  const V = (sx, sy, sz, axis) => {
    const kx = hx * (sy > 0 ? tX : bX);
    const kz = hz * (sy > 0 ? tZ : bZ);
    let x = sx * kx, y = sy * hy, z = sz * kz;
    if (axis === 'x') { y -= sy * b; z -= sz * b; }
    else if (axis === 'y') { x -= sx * b; z -= sz * b; }
    else { x -= sx * b; y -= sy * b; }
    const f = y / (hy || 1);
    return [x + shearX * f, y, z + shearZ * f];
  };

  const s = new Surf();
  const S = [-1, 1];

  // six inset faces
  for (const sx of S) s.flatPoly([V(sx, 1, 1, 'x'), V(sx, 1, -1, 'x'), V(sx, -1, -1, 'x'), V(sx, -1, 1, 'x')], [sx, 0, 0], uv);
  for (const sy of S) s.flatPoly([V(1, sy, 1, 'y'), V(1, sy, -1, 'y'), V(-1, sy, -1, 'y'), V(-1, sy, 1, 'y')], [0, sy, 0], uv);
  for (const sz of S) s.flatPoly([V(1, 1, sz, 'z'), V(1, -1, sz, 'z'), V(-1, -1, sz, 'z'), V(-1, 1, sz, 'z')], [0, 0, sz], uv);

  // twelve edge chamfers
  for (const sx of S) for (const sy of S) {
    s.flatPoly([V(sx, sy, -1, 'x'), V(sx, sy, -1, 'y'), V(sx, sy, 1, 'y'), V(sx, sy, 1, 'x')], [sx, sy, 0], uv);
  }
  for (const sy of S) for (const sz of S) {
    s.flatPoly([V(-1, sy, sz, 'y'), V(-1, sy, sz, 'z'), V(1, sy, sz, 'z'), V(1, sy, sz, 'y')], [0, sy, sz], uv);
  }
  for (const sx of S) for (const sz of S) {
    s.flatPoly([V(sx, -1, sz, 'x'), V(sx, -1, sz, 'z'), V(sx, 1, sz, 'z'), V(sx, 1, sz, 'x')], [sx, 0, sz], uv);
  }

  // eight corner triangles
  for (const sx of S) for (const sy of S) for (const sz of S) {
    s.flatPoly([V(sx, sy, sz, 'x'), V(sx, sy, sz, 'y'), V(sx, sy, sz, 'z')], [sx, sy, sz], uv);
  }

  return s.geometry();
}

/**
 * Surface of revolution about +Y with explicit normal control.
 *
 * The profile is a polyline of `{ r, y, smooth }`. Normals are analytic: the 2D
 * segment normal swept around the axis. That yields the exact hard-surface
 * behaviour we want — perfectly smooth around the circumference, and a crisp
 * crease at every profile corner unless the corner is flagged `smooth`. With
 * `segments: 6` and `faceted: true` the same routine produces hex fastener heads
 * and hexagonal reactor housings.
 *
 * @param {Array<{r:number,y:number,smooth?:boolean}>} profile bottom-to-top
 * @param {number} [segments=16] angular subdivisions
 * @param {Object} [opts]
 * @param {boolean} [opts.faceted=false] use per-quad flat normals instead of swept normals
 * @param {number} [opts.arc=Math.PI*2] sweep angle
 * @param {number} [opts.phase=0] starting angle
 * @param {number} [opts.uvU=1] U tiling across the sweep
 * @param {number} [opts.uvV=1.4] V tiling per metre of profile arc length
 * @returns {THREE.BufferGeometry}
 */
export function latheProfile(profile, segments = 22, opts = {}) {
  const { faceted = false, arc = Math.PI * 2, phase = 0, uvU = 1, uvV = 1.4 } = opts;
  const s = new Surf();
  const nSeg = profile.length - 1;
  if (nSeg < 1) return s.geometry();

  // 2D outward normal per profile segment
  const segN = [];
  const arcLen = [0];
  for (let i = 0; i < nSeg; i++) {
    const a = profile[i], b = profile[i + 1];
    const dr = b.r - a.r, dy = b.y - a.y;
    const l = Math.hypot(dr, dy) || 1;
    segN.push([dy / l, -dr / l]);
    arcLen.push(arcLen[i] + l);
  }

  // per (segment, endpoint) 2D normal, averaged where the corner is smooth
  const nAt = (i, end) => {
    const k = i + end;
    const cur = segN[i];
    const other = end === 0 ? segN[i - 1] : segN[i + 1];
    if (!profile[k].smooth || !other) return cur;
    const nx = cur[0] + other[0], ny = cur[1] + other[1];
    const l = Math.hypot(nx, ny) || 1;
    return [nx / l, ny / l];
  };

  for (let i = 0; i < nSeg; i++) {
    const p0 = profile[i], p1 = profile[i + 1];
    const n0 = nAt(i, 0), n1 = nAt(i, 1);
    const v0 = arcLen[i] * uvV, v1 = arcLen[i + 1] * uvV;
    for (let j = 0; j < segments; j++) {
      const t0 = phase + (j / segments) * arc;
      const t1 = phase + ((j + 1) / segments) * arc;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      const A = [p0.r * c0, p0.y, p0.r * s0];
      const B = [p0.r * c1, p0.y, p0.r * s1];
      const C = [p1.r * c1, p1.y, p1.r * s1];
      const D = [p1.r * c0, p1.y, p1.r * s0];
      let nA, nB, nC, nD;
      if (faceted) {
        const mid = (t0 + t1) * 0.5;
        const mc = Math.cos(mid), ms = Math.sin(mid);
        const fn0 = [n0[0] * mc, n0[1], n0[0] * ms];
        const fn1 = [n1[0] * mc, n1[1], n1[0] * ms];
        nA = fn0; nB = fn0; nC = fn1; nD = fn1;
      } else {
        nA = [n0[0] * c0, n0[1], n0[0] * s0];
        nB = [n0[0] * c1, n0[1], n0[0] * s1];
        nC = [n1[0] * c1, n1[1], n1[0] * s1];
        nD = [n1[0] * c0, n1[1], n1[0] * s0];
      }
      const u0 = (j / segments) * uvU, u1 = ((j + 1) / segments) * uvU;
      s.quad(A, B, C, D, nA, nB, nC, nD, [u0, v0], [u1, v0], [u1, v1], [u0, v1]);
    }
  }
  return s.geometry();
}

/** Chamfered cylinder along +Y, centred on the origin. */
export function chamferCyl(radius, height, segments = 22, chamfer = 0.008, opts = {}) {
  const h = height * 0.5;
  const c = Math.min(chamfer, radius * 0.4, h * 0.4);
  return latheProfile([
    { r: 0, y: -h },
    { r: radius - c, y: -h },
    { r: radius, y: -h + c },
    { r: radius, y: h - c },
    { r: radius - c, y: h },
    { r: 0, y: h },
  ], segments, opts);
}

/** Hex fastener head, base at y = 0. */
function hexBolt(size, height) {
  return latheProfile([
    { r: 0, y: 0 },
    { r: size, y: 0 },
    { r: size, y: height * 0.62 },
    { r: size * 0.78, y: height },
    { r: 0, y: height },
  ], 6, { faceted: true, phase: Math.PI / 6, uvV: 6 });
}

/** Ring of hex fasteners lying in the XZ plane, heads pointing +Y. */
function boltRing(count, radius, size, height, phase = 0) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * Math.PI * 2;
    const g = hexBolt(size, height);
    g.translate(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    parts.push(g);
  }
  return joinGeometries(parts);
}

/**
 * Recessed rectangular channel — a panel split you can actually see a shadow
 * in. Opens toward +Y; the inner walls face inward so the recess reads as a
 * cavity rather than a raised block.
 */
function channelStrip(sizeX, sizeZ, depth) {
  const s = new Surf();
  const hx = sizeX * 0.5, hz = sizeZ * 0.5;
  s.flatPoly([[-hx, -depth, -hz], [hx, -depth, -hz], [hx, -depth, hz], [-hx, -depth, hz]], [0, 1, 0], 6);
  s.flatPoly([[-hx, -depth, -hz], [-hx, 0, -hz], [hx, 0, -hz], [hx, -depth, -hz]], [0, 0.35, 1], 6);
  s.flatPoly([[-hx, -depth, hz], [hx, -depth, hz], [hx, 0, hz], [-hx, 0, hz]], [0, 0.35, -1], 6);
  s.flatPoly([[-hx, -depth, -hz], [-hx, -depth, hz], [-hx, 0, hz], [-hx, 0, -hz]], [1, 0.35, 0], 6);
  s.flatPoly([[hx, -depth, -hz], [hx, 0, -hz], [hx, 0, hz], [hx, -depth, hz]], [-1, 0.35, 0], 6);
  return s.geometry();
}

/** Euler that turns a +Y-opening / +Z-facing local frame toward the fighter's front. */
const FACE_FRONT = [90 * DEG * FRONT, 0, 0];
/** ...and toward its back. */
const FACE_BACK = [-90 * DEG * FRONT, 0, 0];
/** Yaw that turns a +Z-facing local frame (louvres, decals) toward the front. */
const YAW_FRONT = FRONT < 0 ? Math.PI : 0;
const YAW_BACK = FRONT < 0 ? 0 : Math.PI;

/** Merge a list of geometries that already share the standard attribute set. */
function joinGeometries(list) {
  const usable = list.filter((g) => g && g.getAttribute('position') && g.getAttribute('position').count > 0);
  if (usable.length === 0) return new Surf().geometry();
  if (usable.length === 1) return usable[0];
  const flat = usable.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  if (!merged) return usable[0];
  for (const g of flat) g.dispose();
  for (const g of usable) g.dispose();
  return merged;
}

/** Catenary-ish sample points between two world points, sagging under gravity. */
function catenaryPoints(a, b, sag, count = 12, bow = null) {
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    const droop = 4 * sag * t * (1 - t);
    p.y -= droop;
    if (bow) p.addScaledVector(bow, droop);
    pts.push(p);
  }
  return pts;
}

/**
 * One strand of a braided loom: the base curve offset by a rotating vector in
 * its parallel-transport frame. Three of these interleaved read unmistakably as
 * a woven cable bundle at fighting-game camera distance.
 */
function braidStrand(base, phase, offset, twists, radius, tubular, radial) {
  const curve = new THREE.CatmullRomCurve3(base, false, 'catmullrom', 0.5);
  const samples = Math.max(8, tubular);
  const frames = curve.computeFrenetFrames(samples, false);
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = curve.getPoint(t);
    const a = phase + twists * Math.PI * 2 * t;
    p.addScaledVector(frames.normals[i], Math.cos(a) * offset);
    p.addScaledVector(frames.binormals[i], Math.sin(a) * offset);
    pts.push(p);
  }
  const strand = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
  return new THREE.TubeGeometry(strand, tubular, radius, radial, false);
}

// ---------------------------------------------------------------------------
// Decal atlas
//
// Warning stripes, stencil codes and roundels belong in a texture, not in
// geometry. This draws a 4x4 atlas on an offscreen canvas at build time; the
// builder then places paper-thin quads UV'd into one cell each. Guarded so the
// headless import check (which has no canvas) degrades to "no decals".
// ---------------------------------------------------------------------------

const DECAL = {
  HAZARD: 0, SERIAL: 1, TRIANGLE: 2, ARROW: 3,
  BARCODE: 4, ROUNDEL: 5, CHEVRON: 6, GAUGE: 7,
  GRID: 8, NAMEPLATE: 9, RIVETS: 10, CAUTION: 11,
};

const decalCache = new Map();

function makeDecalAtlas(key, palette) {
  if (decalCache.has(key)) return decalCache.get(key);
  let tex = null;
  try {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 1024;
    const g = cv.getContext('2d');
    if (g) {
      const C = 256;
      g.clearRect(0, 0, 1024, 1024);
      const cell = (i) => ({ x: (i % 4) * C, y: Math.floor(i / 4) * C });
      const accent = new THREE.Color(palette.accent || '#ff9d2e').getStyle();
      const trim = new THREE.Color(palette.trim || '#dfe4ea').getStyle();

      // 0 — diagonal hazard stripes with a worn top edge
      let c = cell(DECAL.HAZARD);
      g.save(); g.beginPath(); g.rect(c.x, c.y, C, C); g.clip();
      g.fillStyle = accent; g.fillRect(c.x, c.y, C, C);
      g.fillStyle = '#101315';
      for (let i = -C; i < C * 2; i += 44) {
        g.beginPath();
        g.moveTo(c.x + i, c.y); g.lineTo(c.x + i + 22, c.y);
        g.lineTo(c.x + i + 22 - C, c.y + C); g.lineTo(c.x + i - C, c.y + C);
        g.closePath(); g.fill();
      }
      g.restore();

      // 1 — stencil serial code
      c = cell(DECAL.SERIAL);
      g.fillStyle = trim;
      g.font = 'bold 74px "Arial Narrow", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(key.serial, c.x + C / 2, c.y + C * 0.36);
      g.font = 'bold 44px "Arial Narrow", Arial, sans-serif';
      g.fillText(key.sub, c.x + C / 2, c.y + C * 0.66);
      g.fillRect(c.x + 30, c.y + C * 0.82, C - 60, 5);

      // 2 — caution triangle
      c = cell(DECAL.TRIANGLE);
      g.fillStyle = accent;
      g.beginPath();
      g.moveTo(c.x + C / 2, c.y + 26); g.lineTo(c.x + C - 26, c.y + C - 34); g.lineTo(c.x + 26, c.y + C - 34);
      g.closePath(); g.fill();
      g.fillStyle = '#0d0f11';
      g.beginPath();
      g.moveTo(c.x + C / 2, c.y + 60); g.lineTo(c.x + C - 58, c.y + C - 58); g.lineTo(c.x + 58, c.y + C - 58);
      g.closePath(); g.fill();
      g.fillStyle = accent;
      g.fillRect(c.x + C / 2 - 9, c.y + 100, 18, 62);
      g.fillRect(c.x + C / 2 - 9, c.y + 172, 18, 18);

      // 3 — directional arrow
      c = cell(DECAL.ARROW);
      g.fillStyle = trim;
      g.beginPath();
      g.moveTo(c.x + C - 30, c.y + C / 2);
      g.lineTo(c.x + C * 0.55, c.y + 44); g.lineTo(c.x + C * 0.55, c.y + C * 0.38);
      g.lineTo(c.x + 32, c.y + C * 0.38); g.lineTo(c.x + 32, c.y + C * 0.62);
      g.lineTo(c.x + C * 0.55, c.y + C * 0.62); g.lineTo(c.x + C * 0.55, c.y + C - 44);
      g.closePath(); g.fill();

      // 4 — barcode / data strip
      c = cell(DECAL.BARCODE);
      g.fillStyle = '#0d0f11'; g.fillRect(c.x + 12, c.y + 60, C - 24, C - 120);
      g.fillStyle = trim;
      let x = c.x + 26;
      let seed = 0x2f6d;
      while (x < c.x + C - 26) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const w = 3 + (seed >> 16) % 9;
        g.fillRect(x, c.y + 74, w, C - 148);
        x += w + 4 + ((seed >> 8) % 6);
      }

      // 5 — unit roundel
      c = cell(DECAL.ROUNDEL);
      g.strokeStyle = trim; g.lineWidth = 11;
      g.beginPath(); g.arc(c.x + C / 2, c.y + C / 2, C * 0.36, 0, Math.PI * 2); g.stroke();
      g.fillStyle = accent;
      g.beginPath(); g.arc(c.x + C / 2, c.y + C / 2, C * 0.2, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0d0f11';
      g.font = 'bold 96px Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(key.num, c.x + C / 2, c.y + C / 2 + 4);

      // 6 — chevrons
      c = cell(DECAL.CHEVRON);
      g.fillStyle = accent;
      for (let i = 0; i < 3; i++) {
        const y = c.y + 40 + i * 70;
        g.beginPath();
        g.moveTo(c.x + 30, y); g.lineTo(c.x + C / 2, y + 42); g.lineTo(c.x + C - 30, y);
        g.lineTo(c.x + C - 30, y + 24); g.lineTo(c.x + C / 2, y + 66); g.lineTo(c.x + 30, y + 24);
        g.closePath(); g.fill();
      }

      // 7 — gauge ticks
      c = cell(DECAL.GAUGE);
      g.strokeStyle = trim;
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        const long = i % 4 === 0;
        g.lineWidth = long ? 8 : 4;
        const r0 = C * (long ? 0.28 : 0.33), r1 = C * 0.42;
        g.beginPath();
        g.moveTo(c.x + C / 2 + Math.cos(a) * r0, c.y + C / 2 + Math.sin(a) * r0);
        g.lineTo(c.x + C / 2 + Math.cos(a) * r1, c.y + C / 2 + Math.sin(a) * r1);
        g.stroke();
      }

      // 8 — fine panel grid
      c = cell(DECAL.GRID);
      g.strokeStyle = 'rgba(220,228,236,0.55)'; g.lineWidth = 3;
      for (let i = 1; i < 8; i++) {
        g.beginPath(); g.moveTo(c.x + i * 32, c.y + 16); g.lineTo(c.x + i * 32, c.y + C - 16); g.stroke();
      }
      g.strokeStyle = 'rgba(220,228,236,0.28)';
      for (let i = 1; i < 4; i++) {
        g.beginPath(); g.moveTo(c.x + 16, c.y + i * 64); g.lineTo(c.x + C - 16, c.y + i * 64); g.stroke();
      }

      // 9 — nameplate
      c = cell(DECAL.NAMEPLATE);
      g.fillStyle = 'rgba(12,15,17,0.92)'; g.fillRect(c.x + 8, c.y + 76, C - 16, C - 152);
      g.strokeStyle = accent; g.lineWidth = 5;
      g.strokeRect(c.x + 8, c.y + 76, C - 16, C - 152);
      g.fillStyle = trim;
      g.font = 'bold 58px "Arial Narrow", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(key.label, c.x + C / 2, c.y + C / 2);

      // 10 — rivet line
      c = cell(DECAL.RIVETS);
      for (let i = 0; i < 7; i++) {
        const cx = c.x + 30 + i * 33, cy = c.y + C / 2;
        const grd = g.createRadialGradient(cx - 4, cy - 4, 1, cx, cy, 13);
        grd.addColorStop(0, 'rgba(255,255,255,0.9)');
        grd.addColorStop(0.6, 'rgba(150,158,166,0.75)');
        grd.addColorStop(1, 'rgba(20,24,28,0.0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.fill();
      }

      // 11 — caution text bar
      c = cell(DECAL.CAUTION);
      g.fillStyle = accent; g.fillRect(c.x + 6, c.y + 88, C - 12, C - 176);
      g.fillStyle = '#0d0f11';
      g.font = 'bold 52px "Arial Narrow", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('HIGH VOLT', c.x + C / 2, c.y + C / 2);

      tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
    }
  } catch {
    tex = null;
  }
  decalCache.set(key, tex);
  return tex;
}

/** Flat quad UV-mapped into one atlas cell, facing +Z, centred on the origin. */
function decalQuad(cellIndex, w, h, flipU = false) {
  const s = new Surf();
  const cx = (cellIndex % 4) / 4, cy = Math.floor(cellIndex / 4) / 4;
  const e = 0.002; // trim the cell edges so bilinear filtering cannot bleed
  const u0 = cx + e, u1 = cx + 0.25 - e;
  const v0 = 1 - (cy + 0.25 - e), v1 = 1 - (cy + e);
  const a = flipU ? u1 : u0, b = flipU ? u0 : u1;
  const hw = w * 0.5, hh = h * 0.5;
  const n = [0, 0, 1];
  s.tri([-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], n, n, n, [a, v0], [b, v0], [b, v1]);
  s.tri([-hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0], n, n, n, [a, v0], [b, v1], [a, v1]);
  return s.geometry();
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const libraryCache = new Map();

function paletteKey(p) {
  return [p.primary, p.secondary, p.accent, p.emissive, p.trim].join('|');
}

function fallbackMaterial(name, palette) {
  const base = {
    armor: { color: palette.primary, metalness: 0.85, roughness: 0.34, clearcoat: 0.45, clearcoatRoughness: 0.25 },
    darkMetal: { color: '#22262b', metalness: 0.95, roughness: 0.48 },
    piston: { color: '#c9ced4', metalness: 1.0, roughness: 0.12 },
    rubber: { color: '#15171a', metalness: 0.05, roughness: 0.92 },
    carbon: { color: '#1a1d21', metalness: 0.4, roughness: 0.42, clearcoat: 0.8 },
    worn: { color: palette.secondary, metalness: 0.9, roughness: 0.55 },
    glass: { color: '#0a0d10', metalness: 0.1, roughness: 0.06, transmission: 0, opacity: 0.85, transparent: true },
    emissive: { color: '#05070a', metalness: 0.2, roughness: 0.3 },
  }[name] || { color: palette.primary, metalness: 0.8, roughness: 0.4 };
  return new THREE.MeshPhysicalMaterial(base);
}

/**
 * Resolve the palette-specific material set. Materials.js owns the procedural
 * texture generation; this only tints clones so one texture set serves the
 * primary / secondary / accent plates without extra VRAM.
 */
function resolveMaterials(environment, palette, def) {
  const key = paletteKey(palette);
  let lib = libraryCache.get(key);
  if (!lib) {
    const renderer = environment?.renderer ?? environment?.pmremRenderer ?? null;
    try {
      lib = typeof makeMaterialLibrary === 'function' ? makeMaterialLibrary(renderer, palette) : null;
    } catch {
      lib = null;
    }
    lib = lib || {};
    libraryCache.set(key, lib);
  }

  const pick = (name) => (lib[name] && lib[name].isMaterial ? lib[name] : fallbackMaterial(name, palette));
  const tint = (src, color, over = {}) => {
    const m = src.clone();
    m.color = new THREE.Color(color);
    Object.assign(m, over);
    return m;
  };

  const armorSrc = pick('armor');
  const mats = {
    armorPrimary: tint(armorSrc, palette.primary),
    armorSecondary: tint(armorSrc, palette.secondary, { roughness: Math.min(1, (armorSrc.roughness ?? 0.4) + 0.12) }),
    armorAccent: tint(pick('worn'), palette.accent),
    trim: tint(pick('worn'), palette.trim, { metalness: 1.0 }),
    darkMetal: pick('darkMetal').clone(),
    piston: pick('piston').clone(),
    rubber: pick('rubber').clone(),
    carbon: pick('carbon').clone(),
    glass: pick('glass').clone(),
  };

  // Emissive groups get their own material so the Fighter can pulse each
  // independently against health / meter / hit reactions.
  const emissiveSrc = pick('emissive');
  const glowColor = new THREE.Color(palette.emissive || '#4fd8ff');
  const GLOWS = {
    visor: { color: glowColor, intensity: 5.2 },
    core: { color: glowColor, intensity: 4.4 },
    vents: { color: new THREE.Color(palette.accent || '#ff8a3d'), intensity: 2.6 },
    spine: { color: glowColor, intensity: 3.0 },
    joints: { color: new THREE.Color(palette.accent || '#ff8a3d'), intensity: 2.2 },
  };
  const emissives = {};
  for (const [name, cfg] of Object.entries(GLOWS)) {
    const m = emissiveSrc.clone();
    m.color = new THREE.Color(0x05070a);
    m.emissive = cfg.color.clone();
    m.emissiveIntensity = cfg.intensity;
    m.metalness = 0.1;
    m.roughness = 0.24;
    m.name = `emissive:${name}`;
    emissives[name] = m;
    mats[`glow_${name}`] = m;
  }

  const atlas = makeDecalAtlas(decalKeyFor(def), palette);
  if (atlas) {
    mats.decal = new THREE.MeshStandardMaterial({
      map: atlas,
      transparent: true,
      alphaTest: 0.42,
      roughness: 0.55,
      metalness: 0.15,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.DoubleSide,
    });
  }

  for (const m of Object.values(mats)) {
    if (m.envMapIntensity !== undefined && environment?.envMapIntensity) {
      m.envMapIntensity = environment.envMapIntensity;
    }
    m.shadowSide = THREE.FrontSide;
  }

  return { mats, emissiveConfig: GLOWS };
}

function decalKeyFor(def) {
  const id = String(def?.id ?? def?.name ?? 'KB').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'KB';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  const k = {
    serial: `${id}-${String(100 + (h % 800))}`,
    sub: `MK ${1 + (h % 7)}  REV.${String.fromCharCode(65 + (h % 6))}`,
    num: String(1 + (h % 9)),
    label: String(def?.name ?? 'KNOCKBOT').toUpperCase().slice(0, 11),
  };
  k.toString = () => `${k.serial}/${k.label}`;
  // cache by value, not identity
  for (const existing of decalCache.keys()) {
    if (existing.serial === k.serial && existing.label === k.label) return existing;
  }
  return k;
}

// ---------------------------------------------------------------------------
// Rest pose
// ---------------------------------------------------------------------------

const BONE_DEF = Object.fromEntries(BONES.map((b) => [b.name, b]));

/**
 * Rest-pose world matrices for a live skeleton.
 *
 * Local translations are read from the actual bones (so per-character
 * `proportions` are honoured exactly, whatever roster.js chose) while local
 * rotations come from the canonical BONES table — bone rotations are what
 * animations drive, so reading them off a possibly-already-posed skeleton would
 * bake the current pose into the bind matrices.
 */
function restWorldMatrices(bones) {
  const out = Object.create(null);
  const byName = Object.create(null);
  for (const b of bones) byName[b.name] = b;
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);

  const order = BONES.map((d) => d.name).filter((n) => byName[n]);
  for (const b of bones) if (!order.includes(b.name)) order.push(b.name);

  for (const name of order) {
    const bone = byName[name];
    const def = BONE_DEF[name];
    const r = def?.rot;
    e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
    q.setFromEuler(e);
    const local = new THREE.Matrix4().compose(bone.position, q, one);
    const parentName = bone.parent && bone.parent.isBone ? bone.parent.name : null;
    const pm = parentName ? out[parentName] : null;
    out[name] = pm ? new THREE.Matrix4().multiplyMatrices(pm, local) : local;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actuators
// ---------------------------------------------------------------------------

/**
 * Instanced hydraulic actuators.
 *
 * Each entry measures the live world distance between an anchor on `boneA` and
 * an anchor on `boneB` and rebuilds two instance matrices: a fixed-proportion
 * housing sitting at A pointing at B, and a rod stretched to the full span so it
 * telescopes out of the housing exactly as far as the joint opens. Driven from
 * `updateMatrixWorld` so it stays correct without any cooperation from the
 * Fighter — including in the shadow pass, which happens inside the same
 * scene-graph update.
 */
class ActuatorRig extends THREE.Object3D {
  constructor(actuators, geo, mats, detail) {
    super();
    this.name = 'actuators';
    this.actuators = actuators;
    const n = actuators.length;

    this.housings = new THREE.InstancedMesh(geo.housing, mats.darkMetal, Math.max(1, n));
    this.rods = new THREE.InstancedMesh(geo.rod, mats.piston, Math.max(1, n));
    for (const m of [this.housings, this.rods]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = n;
      this.add(m);
    }
    this._inv = new THREE.Matrix4();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this.detail = detail;
  }

  updateMatrixWorld(force) {
    super.updateMatrixWorld(force);
    this.sync();
  }

  sync() {
    const list = this.actuators;
    if (list.length === 0) return;
    this._inv.copy(this.matrixWorld).invert();
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.boneA || !a.boneB) continue;
      this._a.copy(a.anchorA).applyMatrix4(a.boneA.matrixWorld).applyMatrix4(this._inv);
      this._b.copy(a.anchorB).applyMatrix4(a.boneB.matrixWorld).applyMatrix4(this._inv);
      this._d.subVectors(this._b, this._a);
      const len = this._d.length() || 1e-5;
      a.length = len;
      a.extension = len - a.restLength;
      this._d.multiplyScalar(1 / len);
      this._q.setFromUnitVectors(UP, this._d);

      this._s.set(a.radius, a.housingLength, a.radius);
      this._m.compose(this._a, this._q, this._s);
      this.housings.setMatrixAt(i, this._m);

      this._s.set(a.rodRadius, len, a.rodRadius);
      this._m.compose(this._a, this._q, this._s);
      this.rods.setMatrixAt(i, this._m);
    }
    this.housings.instanceMatrix.needsUpdate = true;
    this.rods.instanceMatrix.needsUpdate = true;
  }
}

/** Unit housing: base clevis, body, two collars, gland nut, bore mouth. y in [0,1]. */
function actuatorHousingGeo(segments) {
  return latheProfile([
    { r: 0, y: 0.0 },
    { r: 1.24, y: 0.0 },
    { r: 1.24, y: 0.055 },
    { r: 1.0, y: 0.085, smooth: false },
    { r: 1.0, y: 0.2 },
    { r: 1.16, y: 0.24 },
    { r: 1.16, y: 0.3 },
    { r: 1.0, y: 0.34 },
    { r: 1.0, y: 0.74 },
    { r: 1.18, y: 0.78 },
    { r: 1.18, y: 0.86 },
    { r: 0.94, y: 0.9 },
    { r: 0.94, y: 0.97 },
    { r: 0.62, y: 1.0 },
    { r: 0.6, y: 1.0 },
  ], segments, { uvV: 3.0 });
}

/** Unit rod: chamfered polished cylinder, y in [0,1]. */
function actuatorRodGeo(segments) {
  return latheProfile([
    { r: 0, y: 0.0 },
    { r: 1.0, y: 0.01 },
    { r: 1.0, y: 0.96 },
    { r: 0.82, y: 1.0 },
    { r: 0, y: 1.0 },
  ], segments, { uvV: 3.0 });
}

// ---------------------------------------------------------------------------
// Rig — the part accumulator
// ---------------------------------------------------------------------------

class Rig {
  /**
   * @param {THREE.Bone[]} bones
   * @param {Record<string, THREE.Matrix4>} restWorld
   * @param {Object} mats
   * @param {number} maxTier
   */
  constructor(bones, restWorld, mats, maxTier) {
    this.bones = bones;
    this.byName = Object.create(null);
    this.index = Object.create(null);
    bones.forEach((b, i) => { this.byName[b.name] = b; this.index[b.name] = i; });
    this.restWorld = restWorld;
    this.restPos = Object.create(null);
    for (const [n, m] of Object.entries(restWorld)) this.restPos[n] = new THREE.Vector3().setFromMatrixPosition(m);
    this.mats = mats;
    this.maxTier = maxTier;
    /** @type {Array<{geo:THREE.BufferGeometry, mat:string, tier:number}>} */
    this.parts = [];
    this.actuators = [];
    this.emitters = [];
    this._tmp = new THREE.Matrix4();
  }

  has(bone) { return !!this.byName[bone]; }

  /** Local frame matrix for a part attached to `bone`. */
  frame(bone, o) {
    const rw = this.restWorld[bone];
    if (!rw) return null;
    const p = o.p ? new THREE.Vector3(o.p[0], o.p[1], o.p[2]) : new THREE.Vector3();
    const q = new THREE.Quaternion();
    if (o.r) q.setFromEuler(new THREE.Euler(o.r[0], o.r[1], o.r[2], o.order || 'XYZ'));
    const sv = o.s === undefined ? new THREE.Vector3(1, 1, 1)
      : typeof o.s === 'number' ? new THREE.Vector3(o.s, o.s, o.s)
        : new THREE.Vector3(o.s[0], o.s[1], o.s[2]);
    // Mirroring is applied on the RIGHT of the local transform: callers already
    // express `p` and `r` in the target side's coordinates (that is what the
    // `sign` factors in the recipes do), so all that remains is to reflect the
    // geometry itself about the part's own YZ plane.
    const m = new THREE.Matrix4().compose(p, q, sv);
    if (o.mirror) m.multiply(MIRROR_X);
    if (o.world) {
      // world-axis-aligned frame anchored at the bone's rest origin
      const t = new THREE.Matrix4().makeTranslation(this.restPos[bone].x, this.restPos[bone].y, this.restPos[bone].z);
      m.premultiply(t);
    } else {
      m.premultiply(rw);
    }
    return m;
  }

  /**
   * Rigid plate: geometry authored in `bone`'s local rest frame (or, with
   * `world: true`, a world-axis-aligned frame anchored at that bone) bound
   * 100% to that bone.
   */
  add(bone, geo, mat, o = {}) {
    if (!geo) return this;
    const tier = o.tier ?? TIER.SECONDARY;
    if (tier > this.maxTier || !this.byName[bone]) { geo.dispose?.(); return this; }
    const m = this.frame(bone, o);
    if (!m) { geo.dispose?.(); return this; }
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    g.applyMatrix4(m);
    if (m.determinant() < 0) flipWinding(g);
    bindRigid(g, this.index[bone]);
    this.parts.push({ geo: g, mat, tier });
    return this;
  }

  /** Same as `add`, but for a list of geometries sharing one frame. */
  addAll(bone, geos, mat, o = {}) {
    return this.add(bone, joinGeometries(geos), mat, o);
  }

  /** Emissive plate. `group` selects which emissive material/mesh it lands in. */
  glow(bone, geo, group, o = {}) {
    return this.add(bone, geo, `glow_${group}`, { tier: TIER.PRIMARY, ...o });
  }

  /** Decal quad from the atlas, pushed slightly proud of the surface it sits on. */
  decal(bone, cell, w, h, o = {}) {
    if (!this.mats.decal) return this;
    return this.add(bone, decalQuad(cell, w, h, !!o.flipU), 'decal', { tier: TIER.GREEBLE, ...o });
  }

  /**
   * Soft part. Geometry must already be authored in bind space; `weightAt`
   * receives a 0..1 parameter along the vertex ordering and returns the blend
   * toward `boneB`.
   */
  soft(geo, boneA, boneB, weights, mat, tier = TIER.SECONDARY) {
    if (tier > this.maxTier || !this.byName[boneA] || !this.byName[boneB]) { geo.dispose?.(); return this; }
    const ia = this.index[boneA], ib = this.index[boneB];
    const n = geo.getAttribute('position').count;
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const w = weights[i] ?? 0;
      si[i * 4] = ia; si[i * 4 + 1] = ib;
      sw[i * 4] = 1 - w; sw[i * 4 + 1] = w;
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    this.parts.push({ geo: g, mat, tier });
    return this;
  }

  /**
   * Braided cable loom between two bone anchors, smooth-skinned along its
   * length. Anchors are given in each bone's local rest frame.
   */
  cable(boneA, aLocal, boneB, bLocal, o = {}) {
    const tier = o.tier ?? TIER.SECONDARY;
    if (tier > this.maxTier || !this.restWorld[boneA] || !this.restWorld[boneB]) return this;
    const a = new THREE.Vector3(...aLocal).applyMatrix4(this.restWorld[boneA]);
    const b = new THREE.Vector3(...bLocal).applyMatrix4(this.restWorld[boneB]);
    const sag = o.sag ?? a.distanceTo(b) * 0.22;
    const bow = o.bow ? new THREE.Vector3(...o.bow) : null;
    const base = catenaryPoints(a, b, sag, 10, bow);
    const strands = o.strands ?? 3;
    const radial = this.maxTier >= 2 ? 5 : 4;
    const tubular = this.maxTier >= 2 ? 18 : 12;
    const r = o.radius ?? 0.013;
    const offset = o.braid ?? r * 1.15;
    for (let k = 0; k < strands; k++) {
      const geo = braidStrand(base, (k / strands) * Math.PI * 2, offset, o.twists ?? 1.6, r, tubular, radial);
      const count = geo.getAttribute('position').count;
      const w = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const ring = Math.floor(i / (radial + 1));
        const t = Math.min(1, ring / tubular);
        w[i] = smootherstep(0.12, 0.88, t);
      }
      this.soft(geo, boneA, boneB, w, o.mat ?? 'rubber', tier);
    }
    return this;
  }

  /**
   * Exposed actuator across a joint, plus the two clevis brackets that anchor
   * it. The rod telescopes for real: it always spans the live A-to-B distance
   * while the housing keeps its length.
   */
  actuator(boneA, aLocal, boneB, bLocal, o = {}) {
    if (!this.restWorld[boneA] || !this.restWorld[boneB]) return this;
    const aW = new THREE.Vector3(...aLocal).applyMatrix4(this.restWorld[boneA]);
    const bW = new THREE.Vector3(...bLocal).applyMatrix4(this.restWorld[boneB]);
    const restLength = aW.distanceTo(bW);
    const radius = o.radius ?? 0.026;
    this.actuators.push({
      boneA: this.byName[boneA],
      boneB: this.byName[boneB],
      nameA: boneA,
      nameB: boneB,
      anchorA: new THREE.Vector3(...aLocal),
      anchorB: new THREE.Vector3(...bLocal),
      restLength,
      length: restLength,
      extension: 0,
      radius,
      rodRadius: radius * (o.rodRatio ?? 0.52),
      housingLength: restLength * (o.housing ?? 0.54),
    });

    // clevis brackets, rigid to their own bone
    const cw = radius * 2.6, ch = radius * 1.5, cd = radius * 2.1;
    this.add(boneA, bevelBox(cw, ch, cd, radius * 0.28), 'darkMetal',
      { p: [aLocal[0], aLocal[1], aLocal[2]], tier: TIER.SECONDARY });
    this.add(boneB, bevelBox(cw * 0.85, ch, cd * 0.85, radius * 0.26), 'darkMetal',
      { p: [bLocal[0], bLocal[1], bLocal[2]], tier: TIER.SECONDARY });
    return this;
  }

  /** Register an FX emission point (thruster nozzle, muzzle, exhaust). */
  emitter(name, bone, local, dir, radius) {
    if (!this.byName[bone]) return this;
    this.emitters.push({
      name,
      bone: this.byName[bone],
      boneName: bone,
      position: new THREE.Vector3(...local),
      direction: new THREE.Vector3(...dir).normalize(),
      radius,
    });
    return this;
  }
}

function smootherstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Reverse triangle winding in place for a non-indexed geometry. */
function flipWinding(geo) {
  for (const attr of Object.values(geo.attributes)) {
    const a = attr.array, is = attr.itemSize;
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < is; k++) {
        const p = (i + 1) * is + k, q = (i + 2) * is + k;
        const t = a[p]; a[p] = a[q]; a[q] = t;
      }
    }
    attr.needsUpdate = true;
  }
}

/** Attach 100%-single-bone skin attributes. */
function bindRigid(geo, boneIndex) {
  const n = geo.getAttribute('position').count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { si[i * 4] = boneIndex; sw[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
}

// ---------------------------------------------------------------------------
// Chassis design table
//
// The single most important thing about a fighting-game roster is that you can
// tell who is who from the silhouette at 100 pixels tall. These five entries
// exist to force that: different shoulder mass, different head shape, different
// leg plan, different back hardware, different chest core.
// ---------------------------------------------------------------------------

const CHASSIS = {
  heavy: {
    bulk: 1.00,
    torso: { chestW: 0.60, chestD: 0.34, chestH: 0.30, waistW: 0.34, waistD: 0.26, pelvisW: 0.46 },
    pauldron: { w: 0.30, h: 0.26, d: 0.32, taper: 0.62, out: 0.10, up: 0.06, tilt: 20, layers: 3 },
    arms: { upper: 0.155, fore: 0.145, gauntlet: 1.0 },
    legs: { plan: 'plantigrade', thigh: 0.22, shin: 0.20, foot: 0.30, footW: 0.20 },
    head: 'slab',
    core: 'hex',
    back: 'radiators',
    skirt: true, tail: false,
  },
  agile: {
    bulk: 0.80,
    torso: { chestW: 0.44, chestD: 0.27, chestH: 0.29, waistW: 0.25, waistD: 0.20, pelvisW: 0.34 },
    pauldron: { w: 0.17, h: 0.20, d: 0.24, taper: 0.5, out: 0.05, up: 0.04, tilt: 32, layers: 2 },
    arms: { upper: 0.108, fore: 0.10, gauntlet: 0.45 },
    legs: { plan: 'digitigrade', thigh: 0.165, shin: 0.145, foot: 0.30, footW: 0.13 },
    head: 'wedge',
    core: 'slit',
    back: 'thrusters',
    skirt: false, tail: false,
  },
  brute: {
    bulk: 1.15,
    torso: { chestW: 0.68, chestD: 0.40, chestH: 0.27, waistW: 0.36, waistD: 0.29, pelvisW: 0.50 },
    pauldron: { w: 0.34, h: 0.30, d: 0.36, taper: 0.78, out: 0.12, up: 0.10, tilt: 12, layers: 3 },
    arms: { upper: 0.185, fore: 0.175, gauntlet: 1.35 },
    legs: { plan: 'splayed', thigh: 0.25, shin: 0.225, foot: 0.32, footW: 0.24 },
    head: 'sunken',
    core: 'cage',
    back: 'stacks',
    skirt: false, tail: false,
  },
  precision: {
    bulk: 0.88,
    torso: { chestW: 0.48, chestD: 0.29, chestH: 0.31, waistW: 0.27, waistD: 0.22, pelvisW: 0.36 },
    pauldron: { w: 0.20, h: 0.22, d: 0.26, taper: 0.55, out: 0.06, up: 0.05, tilt: 26, layers: 2 },
    arms: { upper: 0.118, fore: 0.112, gauntlet: 0.6 },
    legs: { plan: 'plantigrade', thigh: 0.175, shin: 0.155, foot: 0.29, footW: 0.15 },
    head: 'tower',
    core: 'column',
    back: 'sensorWings',
    skirt: false, tail: false,
  },
  arcane: {
    bulk: 0.92,
    torso: { chestW: 0.50, chestD: 0.30, chestH: 0.32, waistW: 0.26, waistD: 0.21, pelvisW: 0.38 },
    pauldron: { w: 0.22, h: 0.24, d: 0.28, taper: 0.45, out: 0.09, up: 0.09, tilt: 34, layers: 2 },
    arms: { upper: 0.125, fore: 0.118, gauntlet: 0.7 },
    legs: { plan: 'digitigrade', thigh: 0.185, shin: 0.16, foot: 0.29, footW: 0.14 },
    head: 'crown',
    core: 'crystal',
    back: 'halo',
    skirt: true, tail: true,
  },
};

const SIDES = [
  { s: 'L', sign: 1, mirror: false },
  { s: 'R', sign: -1, mirror: true },
];

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

function buildPelvis(rig, spec) {
  const t = spec.torso;
  const w = t.pelvisW, d = t.waistD * 1.18;

  // primary pelvic girdle
  rig.add('hips', bevelBox(w, 0.20, d, 0.020, { topX: 0.88, botX: 0.94, botZ: 0.92 }), 'armorPrimary',
    { p: [0, -0.02, 0], tier: TIER.PRIMARY });

  // crotch guard, angled forward-down
  rig.add('hips', bevelBox(w * 0.36, 0.17, d * 0.5, 0.014, { topX: 1.25 }), 'armorSecondary',
    { p: [0, -0.115, FRONT * d * 0.28], r: [12 * DEG, 0, 0], tier: TIER.PRIMARY });

  // rear counterweight block
  rig.add('hips', bevelBox(w * 0.62, 0.16, d * 0.42, 0.016, { topX: 0.8 }), 'armorSecondary',
    { p: [0, -0.01, -FRONT * d * 0.42], tier: TIER.PRIMARY });

  // hip ball housings
  for (const { s, sign, mirror } of SIDES) {
    const hx = rig.restPos[`hip_${s}`] ? rig.restPos[`hip_${s}`].x : sign * 0.105;
    rig.add('hips', latheProfile([
      { r: 0, y: -0.055 }, { r: 0.052, y: -0.055 }, { r: 0.062, y: -0.032, smooth: true },
      { r: 0.066, y: 0.0, smooth: true }, { r: 0.062, y: 0.032, smooth: true },
      { r: 0.05, y: 0.052 }, { r: 0, y: 0.052 },
    ], 20), 'darkMetal', { p: [hx, -0.03, 0], r: [0, 0, 90 * DEG], mirror, tier: TIER.PRIMARY });

    rig.add('hips', boltRing(6, 0.05, 0.009, 0.011), 'trim',
      { p: [hx + sign * 0.052, -0.03, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.GREEBLE });

    // belt lamp
    rig.glow('hips', bevelBox(0.03, 0.012, 0.012, 0.004), 'joints',
      { p: [hx * 0.55, 0.04, FRONT * d * 0.5], mirror });
  }

  // waist power ring: recessed channel with a glow strip inside
  rig.add('hips', channelStrip(w * 0.7, d * 0.9, 0.018), 'darkMetal',
    { p: [0, 0.085, 0], tier: TIER.SECONDARY });
  rig.glow('hips', bevelBox(w * 0.5, 0.014, d * 0.62, 0.004), 'spine', { p: [0, 0.078, 0] });

  if (spec.skirt) {
    // segmented skirt plates, each rigid to hips so they read as armour, not cloth
    const plates = [
      { x: 0.0, z: 1.0, w: 0.20, rot: 8 },
      { x: 0.62, z: 0.72, w: 0.15, rot: 14 },
      { x: -0.62, z: 0.72, w: 0.15, rot: 14 },
      { x: 0.86, z: 0.0, w: 0.15, rot: 18 },
      { x: -0.86, z: 0.0, w: 0.15, rot: 18 },
      { x: 0.5, z: -0.85, w: 0.17, rot: 12 },
      { x: -0.5, z: -0.85, w: 0.17, rot: 12 },
    ];
    for (const pl of plates) {
      const ang = Math.atan2(pl.x, pl.z * -FRONT);
      rig.add('hips', bevelBox(pl.w, 0.24, 0.035, 0.010, { botX: 0.74 }), 'armorAccent', {
        p: [pl.x * w * 0.52, -0.14, pl.z * d * 0.62 * -FRONT],
        r: [pl.rot * DEG, ang, 0],
        order: 'YXZ',
        tier: TIER.PRIMARY,
      });
    }
  }

  rig.decal('hips', DECAL.HAZARD, w * 0.42, 0.05, {
    p: [0, -0.085, FRONT * (d * 0.5 + 0.052)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
}

function buildTorso(rig, spec, def) {
  const t = spec.torso;

  // --- lower spine: ribbed articulated column -----------------------------
  rig.add('spine01', latheProfile([
    { r: t.waistW * 0.42, y: -0.03 },
    { r: t.waistW * 0.46, y: 0.0, smooth: true },
    { r: t.waistW * 0.44, y: 0.05 },
    { r: t.waistW * 0.50, y: 0.07 },
    { r: t.waistW * 0.50, y: 0.10 },
    { r: t.waistW * 0.44, y: 0.12 },
  ], 16), 'darkMetal', { p: [0, 0.0, 0], s: [1, 1, t.waistD / t.waistW * 1.15], tier: TIER.PRIMARY });

  rig.add('spine01', bevelBox(t.waistW * 1.02, 0.13, t.waistD, 0.014, { topX: 1.12, botX: 0.92 }), 'armorSecondary',
    { p: [0, 0.055, 0], tier: TIER.PRIMARY });

  // abdominal segment plates
  for (let i = 0; i < 3; i++) {
    rig.add('spine01', bevelBox(t.waistW * (0.72 + i * 0.06), 0.035, 0.03, 0.008), 'armorPrimary',
      { p: [0, -0.005 + i * 0.045, FRONT * (t.waistD * 0.5 + 0.005)], r: [(6 - i * 5) * DEG, 0, 0], tier: TIER.SECONDARY });
  }

  // --- mid spine ----------------------------------------------------------
  rig.add('spine02', bevelBox(t.waistW * 1.25, 0.17, t.waistD * 1.12, 0.016, { topX: 1.22, topZ: 1.1, botX: 0.94 }), 'armorPrimary',
    { p: [0, 0.06, 0], tier: TIER.PRIMARY });

  // dorsal spine strip — the reactor line running up the back
  rig.add('spine02', channelStrip(0.05, 0.16, 0.016), 'darkMetal',
    { p: [0, 0.06, -FRONT * (t.waistD * 0.56)], r: FACE_BACK, tier: TIER.SECONDARY });
  for (let i = 0; i < 3; i++) {
    rig.glow('spine02', bevelBox(0.026, 0.03, 0.010, 0.004), 'spine',
      { p: [0, 0.005 + i * 0.052, -FRONT * (t.waistD * 0.56 + 0.004)] });
  }

  rig.decal('spine02', DECAL.SERIAL, 0.11, 0.11, {
    p: [t.waistW * 0.42, 0.07, -FRONT * (t.waistD * 0.58)], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE,
  });

  // --- chest --------------------------------------------------------------
  const cw = t.chestW, cd = t.chestD, ch = t.chestH;

  rig.add('chest', bevelBox(cw, ch, cd, 0.020, { topX: 1.04, topZ: 0.94, botX: 0.72, botZ: 0.86 }), 'armorPrimary',
    { p: [0, 0.06, 0], tier: TIER.PRIMARY });

  // pectoral plates angled off the centre line
  for (const { sign, mirror } of SIDES) {
    rig.add('chest', bevelBox(cw * 0.38, ch * 0.68, cd * 0.34, 0.014, { topX: 0.86, botX: 0.7 }), 'armorPrimary', {
      p: [sign * cw * 0.27, 0.075, FRONT * cd * 0.44],
      r: [-6 * DEG, sign * 14 * DEG, sign * -8 * DEG],
      mirror, tier: TIER.PRIMARY,
    });
    // intake louvres on the upper chest flank
    addLouvres(rig, 'chest', {
      p: [sign * cw * 0.40, 0.115, FRONT * cd * 0.22],
      r: [0, sign * 118 * DEG, 0],
      w: cd * 0.36, h: 0.075, n: 4, depth: 0.022, mirror, glow: 'vents',
    });
  }

  // gorget / collar ring
  rig.add('chest', latheProfile([
    { r: 0.088, y: 0.0 }, { r: 0.104, y: 0.018, smooth: true }, { r: 0.104, y: 0.05 },
    { r: 0.088, y: 0.062 }, { r: 0.076, y: 0.062 }, { r: 0.076, y: 0.0 },
  ], 20), 'darkMetal', { p: [0, 0.155, 0.005], tier: TIER.PRIMARY });

  // clavicle yokes
  for (const { s, sign, mirror } of SIDES) {
    const cp = rig.restPos[`clavicle_${s}`];
    const local = cp ? cp.clone().sub(rig.restPos.chest) : new THREE.Vector3(sign * 0.055, 0.13, 0.01);
    rig.add('chest', bevelBox(0.16, 0.075, 0.13, 0.012, { topX: 0.7, topZ: 0.8 }), 'armorSecondary', {
      p: [local.x + sign * 0.055, local.y - 0.005, local.z],
      r: [0, 0, sign * -14 * DEG], mirror, tier: TIER.PRIMARY,
    });
  }

  // back plate + shoulder-blade panels
  rig.add('chest', bevelBox(cw * 0.94, ch * 0.98, cd * 0.30, 0.016, { topX: 0.96, botX: 0.78 }), 'armorSecondary',
    { p: [0, 0.06, -FRONT * cd * 0.42], tier: TIER.PRIMARY });
  for (const { sign, mirror } of SIDES) {
    rig.add('chest', bevelBox(cw * 0.30, ch * 0.60, 0.03, 0.010, { topX: 0.88 }), 'carbon', {
      p: [sign * cw * 0.26, 0.085, -FRONT * (cd * 0.42 + cd * 0.16)],
      r: [0, sign * -10 * DEG, 0], mirror, tier: TIER.SECONDARY,
    });
  }

  buildChestCore(rig, spec, cw, cd, ch);
  buildBackHardware(rig, spec);

  rig.decal('chest', DECAL.ROUNDEL, 0.10, 0.10, {
    p: [-cw * 0.30, 0.10, FRONT * (cd * 0.5 + 0.03)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
  rig.decal('chest', DECAL.NAMEPLATE, 0.15, 0.062, {
    p: [0, -0.055, FRONT * (cd * 0.5 + 0.01)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
  if (def?.archetype) {
    rig.decal('chest', DECAL.CHEVRON, 0.07, 0.07, {
      p: [cw * 0.32, -0.02, FRONT * (cd * 0.5 + 0.02)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
    });
  }
}

function buildChestCore(rig, spec, cw, cd, ch) {
  const zf = FRONT * (cd * 0.5 + 0.008);
  switch (spec.core) {
    case 'hex': {
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.098, y: 0 }, { r: 0.098, y: 0.030 },
        { r: 0.080, y: 0.042 }, { r: 0.072, y: 0.042 }, { r: 0.072, y: 0.018 }, { r: 0, y: 0.018 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'darkMetal',
      { p: [0, 0.075, zf], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY });
      rig.glow('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.066, y: 0 }, { r: 0.066, y: 0.014 }, { r: 0, y: 0.014 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'core',
      { p: [0, 0.075, zf + FRONT * 0.014], r: [90 * DEG, 0, 0] });
      rig.add('chest', boltRing(6, 0.086, 0.010, 0.012, Math.PI / 6), 'trim',
        { p: [0, 0.075, zf + FRONT * 0.030], r: [-90 * DEG, 0, 0], tier: TIER.GREEBLE });
      break;
    }
    case 'slit': {
      rig.add('chest', bevelBox(0.05, ch * 0.66, 0.05, 0.010, { topX: 0.6, botX: 0.6 }), 'darkMetal',
        { p: [0, 0.07, zf], tier: TIER.PRIMARY });
      rig.glow('chest', bevelBox(0.020, ch * 0.54, 0.02, 0.005), 'core',
        { p: [0, 0.07, zf + FRONT * 0.020] });
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', bevelBox(0.045, ch * 0.72, 0.028, 0.008, { topX: 0.7 }), 'armorAccent',
          { p: [sign * 0.052, 0.07, zf + FRONT * 0.012], r: [0, sign * -22 * DEG, 0], mirror, tier: TIER.SECONDARY });
      }
      break;
    }
    case 'cage': {
      rig.glow('chest', latheProfile([
        { r: 0, y: -0.062 }, { r: 0.040, y: -0.055, smooth: true }, { r: 0.066, y: -0.028, smooth: true },
        { r: 0.072, y: 0, smooth: true }, { r: 0.066, y: 0.028, smooth: true },
        { r: 0.040, y: 0.055, smooth: true }, { r: 0, y: 0.062 },
      ], 20), 'core', { p: [0, 0.07, zf - FRONT * 0.012] });
      for (let i = 0; i < 5; i++) {
        const a = (-0.36 + i * 0.18) * Math.PI;
        rig.add('chest', bevelBox(0.022, 0.20, 0.03, 0.006, { topX: 0.55, botX: 0.55 }), 'darkMetal', {
          p: [Math.sin(a) * 0.062, 0.07, zf + FRONT * (0.012 + Math.cos(a) * 0.030)],
          r: [0, -a * 0.6, 0], tier: TIER.PRIMARY,
        });
      }
      rig.add('chest', latheProfile([
        { r: 0.086, y: 0 }, { r: 0.100, y: 0.012, smooth: true }, { r: 0.100, y: 0.03 }, { r: 0.086, y: 0.04 },
      ], 22), 'trim', { p: [0, 0.07, zf - FRONT * 0.03], r: [90 * DEG, 0, 0], tier: TIER.SECONDARY });
      break;
    }
    case 'column': {
      rig.add('chest', channelStrip(0.05, ch * 0.86, 0.018), 'darkMetal',
        { p: [0, 0.07, zf], r: FACE_FRONT, tier: TIER.PRIMARY });
      for (let i = 0; i < 5; i++) {
        rig.glow('chest', bevelBox(0.030, 0.022, 0.008, 0.003), 'core',
          { p: [0, 0.005 + i * 0.033, zf - FRONT * 0.006] });
      }
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', bevelBox(0.018, ch * 0.9, 0.024, 0.005), 'trim',
          { p: [sign * 0.036, 0.07, zf], mirror, tier: TIER.SECONDARY });
      }
      break;
    }
    default: { // crystal
      const crystal = latheProfile([
        { r: 0, y: -0.075 }, { r: 0.055, y: -0.020 }, { r: 0.062, y: 0.006 }, { r: 0, y: 0.078 },
      ], 6, { faceted: true, phase: Math.PI / 6 });
      rig.glow('chest', crystal, 'core', { p: [0, 0.07, zf + FRONT * 0.028], r: [-90 * DEG * FRONT, 0, 0] });
      rig.add('chest', latheProfile([
        { r: 0.086, y: 0 }, { r: 0.094, y: 0.010, smooth: true }, { r: 0.072, y: 0.040 }, { r: 0.062, y: 0.040 },
        { r: 0.078, y: 0.008 }, { r: 0.076, y: 0 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'trim',
      { p: [0, 0.07, zf], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY });
      for (let i = 0; i < 3; i++) {
        rig.decal('chest', DECAL.GAUGE, 0.05, 0.05, {
          p: [Math.cos(i * 2.1) * 0.11, 0.07 + Math.sin(i * 2.1) * 0.09, zf + FRONT * 0.006],
          r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
        });
      }
      break;
    }
  }
}

function buildBackHardware(rig, spec) {
  const t = spec.torso;
  const zb = -FRONT * (t.chestD * 0.5 + 0.03);

  switch (spec.back) {
    case 'radiators': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.26;
        rig.add('chest', bevelBox(0.13, 0.30, 0.11, 0.012, { topX: 0.82, topZ: 0.75 }), 'armorSecondary',
          { p: [x, 0.10, zb + 0.05 * -FRONT], r: [-14 * DEG, 0, sign * -5 * DEG], mirror, tier: TIER.PRIMARY });
        for (let i = 0; i < 6; i++) {
          rig.add('chest', bevelBox(0.145, 0.012, 0.115, 0.004), 'darkMetal', {
            p: [x, -0.008 + i * 0.045, zb + 0.05 * -FRONT + (0.10 - i * 0.028) * -FRONT * 0.14],
            r: [-14 * DEG, 0, 0], mirror, tier: TIER.SECONDARY,
          });
        }
        rig.glow('chest', bevelBox(0.10, 0.24, 0.012, 0.004), 'vents',
          { p: [x, 0.10, zb + 0.115 * -FRONT], r: [-14 * DEG, 0, 0], mirror });
        rig.emitter('exhaust', 'chest', [x, 0.25, zb + 0.05 * -FRONT], [0, 0.4, -FRONT], 0.05);
      }
      rig.add('chest', bevelBox(t.chestW * 0.46, 0.14, 0.12, 0.014, { topX: 0.8 }), 'armorPrimary',
        { p: [0, -0.02, zb + 0.03 * -FRONT], tier: TIER.PRIMARY });
      break;
    }
    case 'thrusters': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.30;
        rig.add('chest', bevelBox(0.11, 0.20, 0.14, 0.012, { topX: 0.8, topZ: 0.7 }), 'armorPrimary',
          { p: [x, 0.10, zb], r: [10 * DEG, 0, sign * -6 * DEG], mirror, tier: TIER.PRIMARY });
        const nozzle = latheProfile([
          { r: 0.030, y: 0 }, { r: 0.030, y: 0.05 }, { r: 0.044, y: 0.075, smooth: true },
          { r: 0.062, y: 0.115 }, { r: 0.056, y: 0.118 }, { r: 0.040, y: 0.082, smooth: true },
          { r: 0.026, y: 0.05 }, { r: 0.026, y: 0 },
        ], 22);
        rig.add('chest', nozzle, 'darkMetal',
          { p: [x, 0.02, zb + 0.02 * -FRONT], r: [(90 + 28) * DEG * -FRONT, 0, 0], mirror, tier: TIER.PRIMARY });
        rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.040, y: 0 }, { r: 0.040, y: 0.008 }, { r: 0, y: 0.008 }], 22), 'vents',
          { p: [x, -0.02, zb + 0.10 * -FRONT], r: [(90 + 28) * DEG * -FRONT, 0, 0], mirror });
        rig.emitter('thruster', 'chest', [x, -0.03, zb + 0.12 * -FRONT], [0, -0.35, -FRONT], 0.055);
      }
      rig.add('chest', bevelBox(t.chestW * 0.4, 0.22, 0.09, 0.012, { topX: 0.7, botX: 0.86 }), 'carbon',
        { p: [0, 0.09, zb - 0.01 * -FRONT], tier: TIER.PRIMARY });
      break;
    }
    case 'stacks': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.30;
        const pipe = latheProfile([
          { r: 0.040, y: 0 }, { r: 0.040, y: 0.28 }, { r: 0.050, y: 0.30, smooth: true },
          { r: 0.050, y: 0.335 }, { r: 0.036, y: 0.345 }, { r: 0.036, y: 0.30 }, { r: 0.030, y: 0.28 }, { r: 0.030, y: 0 },
        ], 20);
        rig.add('chest', pipe, 'darkMetal',
          { p: [x, 0.06, zb], r: [-16 * DEG, 0, sign * -8 * DEG], mirror, tier: TIER.PRIMARY });
        rig.add('chest', latheProfile([
          { r: 0.046, y: 0 }, { r: 0.056, y: 0.008, smooth: true }, { r: 0.056, y: 0.026 }, { r: 0.046, y: 0.034 },
        ], 20), 'trim', { p: [x, 0.14, zb + 0.03 * FRONT], r: [-16 * DEG, 0, 0], mirror, tier: TIER.SECONDARY });
        rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.030, y: 0 }, { r: 0.030, y: 0.006 }, { r: 0, y: 0.006 }], 16), 'vents',
          { p: [x + sign * 0.048, 0.395, zb + 0.10 * FRONT], r: [-16 * DEG, 0, 0], mirror });
        rig.emitter('exhaust', 'chest', [x + sign * 0.05, 0.40, zb + 0.10 * FRONT], [0.1 * sign, 1, -0.28 * FRONT], 0.04);
      }
      rig.add('chest', bevelBox(t.chestW * 0.62, 0.22, 0.10, 0.014, { topX: 0.86 }), 'armorSecondary',
        { p: [0, 0.05, zb], tier: TIER.PRIMARY });
      addLouvres(rig, 'chest', { p: [0, 0.05, zb + 0.055 * -FRONT], r: [0, YAW_BACK, 0], w: t.chestW * 0.44, h: 0.16, n: 5, depth: 0.02, glow: 'vents' });
      break;
    }
    case 'sensorWings': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.24;
        rig.add('chest', bevelBox(0.16, 0.30, 0.026, 0.008, { topX: 0.55, botX: 0.9, shearZ: 0.03 }), 'armorPrimary', {
          p: [x + sign * 0.06, 0.12, zb + 0.04 * -FRONT],
          r: [-22 * DEG, sign * 26 * DEG, sign * -12 * DEG], mirror, tier: TIER.PRIMARY,
        });
        rig.add('chest', bevelBox(0.11, 0.20, 0.014, 0.005, { topX: 0.5 }), 'carbon', {
          p: [x + sign * 0.075, 0.13, zb + 0.055 * -FRONT],
          r: [-22 * DEG, sign * 26 * DEG, sign * -12 * DEG], mirror, tier: TIER.SECONDARY,
        });
        rig.glow('chest', bevelBox(0.012, 0.16, 0.008, 0.003), 'spine', {
          p: [x + sign * 0.028, 0.13, zb + 0.05 * -FRONT], r: [-22 * DEG, sign * 26 * DEG, 0], mirror,
        });
      }
      // dorsal sensor drum
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.055, y: 0 }, { r: 0.062, y: 0.014, smooth: true }, { r: 0.062, y: 0.05 },
        { r: 0.048, y: 0.062 }, { r: 0, y: 0.062 },
      ], 22), 'darkMetal', { p: [0, 0.10, zb], r: [-90 * DEG * -FRONT, 0, 0], tier: TIER.PRIMARY });
      rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.034, y: 0 }, { r: 0.034, y: 0.006 }, { r: 0, y: 0.006 }], 22), 'vents',
        { p: [0, 0.10, zb + 0.064 * -FRONT], r: [-90 * DEG * -FRONT, 0, 0] });
      rig.add('chest', bevelBox(t.chestW * 0.5, 0.20, 0.08, 0.012, { topX: 0.8 }), 'armorSecondary',
        { p: [0, 0.02, zb - 0.01 * -FRONT], tier: TIER.PRIMARY });
      break;
    }
    default: { // halo
      const R = 0.30;
      // A segmented ring of chamfered blocks rather than a lathed torus: the
      // facets catch the rim light and read as forged metal, not a smooth donut.
      const blocks = [];
      const SEGS = 18;
      for (let i = 0; i < SEGS; i++) {
        const a = (i / SEGS) * Math.PI * 2;
        const g = bevelBox(0.036, 0.030, (2 * Math.PI * R) / SEGS * 0.92, 0.006);
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2)),
          new THREE.Vector3(1, 1, 1),
        );
        g.applyMatrix4(m);
        blocks.push(g);
      }
      rig.add('chest', joinGeometries(blocks), 'trim',
        { p: [0, 0.13, zb + 0.03 * -FRONT], r: [16 * DEG, 0, 0], tier: TIER.PRIMARY });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        rig.glow('chest', bevelBox(0.05, 0.018, 0.010, 0.004), 'spine', {
          p: [Math.cos(a) * R, 0.13 + Math.sin(a) * R, zb + 0.045 * -FRONT],
          r: [16 * DEG, 0, a + Math.PI / 2],
        });
      }
      rig.add('chest', bevelBox(t.chestW * 0.34, 0.24, 0.10, 0.012, { topX: 0.6 }), 'armorPrimary',
        { p: [0, 0.08, zb], r: [8 * DEG, 0, 0], tier: TIER.PRIMARY });
      rig.decal('chest', DECAL.GAUGE, 0.16, 0.16, {
        p: [0, 0.13, zb + 0.05 * -FRONT], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE,
      });
      break;
    }
  }
}

/**
 * Recessed louvre stack: dark backing, angled fins, a frame lip and (optionally)
 * a glow behind the fins. Built in a +Z-facing local frame.
 */
function addLouvres(rig, bone, o) {
  const { p = [0, 0, 0], r = [0, 0, 0], w, h, n = 4, depth = 0.02, mirror = false, glow = null } = o;
  const geos = [];
  const fins = [];
  const back = bevelBox(w, h, 0.012, 0.003);
  back.translate(0, 0, -depth);
  geos.push(back);
  for (let i = 0; i < n; i++) {
    const y = -h * 0.5 + h * ((i + 0.5) / n);
    const fin = bevelBox(w * 0.94, h / n * 0.42, 0.020, 0.004);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, -depth * 0.42),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-32 * DEG, 0, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    fin.applyMatrix4(m);
    fins.push(fin);
  }
  const lipT = bevelBox(w + 0.014, 0.011, 0.018, 0.004); lipT.translate(0, h * 0.5 + 0.005, -depth * 0.25);
  const lipB = bevelBox(w + 0.014, 0.011, 0.018, 0.004); lipB.translate(0, -h * 0.5 - 0.005, -depth * 0.25);
  const lipL = bevelBox(0.011, h + 0.024, 0.018, 0.004); lipL.translate(w * 0.5 + 0.005, 0, -depth * 0.25);
  const lipR = bevelBox(0.011, h + 0.024, 0.018, 0.004); lipR.translate(-w * 0.5 - 0.005, 0, -depth * 0.25);

  rig.add(bone, joinGeometries(geos), 'darkMetal', { p, r, mirror, tier: TIER.SECONDARY });
  rig.add(bone, joinGeometries(fins), 'darkMetal', { p, r, mirror, tier: TIER.SECONDARY });
  rig.add(bone, joinGeometries([lipT, lipB, lipL, lipR]), 'trim', { p, r, mirror, tier: TIER.SECONDARY });
  if (glow) {
    const g = bevelBox(w * 0.82, h * 0.84, 0.008, 0.003);
    g.translate(0, 0, -depth * 0.85);
    rig.glow(bone, g, glow, { p, r, mirror });
  }
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

function buildHead(rig, spec, def) {
  // neck column + shroud
  rig.add('neck', latheProfile([
    { r: 0.048, y: -0.02 }, { r: 0.052, y: 0.0, smooth: true }, { r: 0.046, y: 0.06 },
    { r: 0.054, y: 0.075, smooth: true }, { r: 0.050, y: 0.10 },
  ], 16), 'darkMetal', { p: [0, 0, 0], tier: TIER.PRIMARY });
  rig.add('neck', bevelBox(0.10, 0.05, 0.09, 0.010, { topX: 0.8 }), 'armorSecondary',
    { p: [0, 0.02, -FRONT * 0.012], tier: TIER.SECONDARY });

  switch (spec.head) {
    case 'slab': return headSlab(rig, spec);
    case 'wedge': return headWedge(rig, spec);
    case 'sunken': return headSunken(rig, spec);
    case 'tower': return headTower(rig, spec, def);
    default: return headCrown(rig, spec);
  }
}

function headSlab(rig) {
  // wide, low, armoured — reads as a bunker at 100px
  rig.add('head', bevelBox(0.25, 0.15, 0.22, 0.016, { topX: 0.90, topZ: 0.86, botX: 0.86, botZ: 0.92 }), 'armorPrimary',
    { p: [0, 0.055, 0], tier: TIER.PRIMARY });
  // brow ridge, overhanging the visor
  rig.add('head', bevelBox(0.24, 0.045, 0.06, 0.010, { botX: 0.9, shearZ: 0.018 }), 'armorSecondary',
    { p: [0, 0.10, FRONT * 0.10], r: [-16 * DEG, 0, 0], tier: TIER.PRIMARY });
  // recessed visor band
  rig.add('head', channelStrip(0.20, 0.058, 0.020), 'darkMetal',
    { p: [0, 0.055, FRONT * 0.108], r: FACE_FRONT, tier: TIER.SECONDARY });
  rig.glow('head', bevelBox(0.175, 0.030, 0.010, 0.004, { topX: 0.94 }), 'visor',
    { p: [0, 0.058, FRONT * 0.112] });
  // chin / vocoder grille
  rig.add('head', bevelBox(0.13, 0.045, 0.05, 0.008, { botX: 0.7 }), 'darkMetal',
    { p: [0, 0.0, FRONT * 0.10], r: [12 * DEG, 0, 0], tier: TIER.SECONDARY });
  for (let i = 0; i < 3; i++) {
    rig.add('head', bevelBox(0.10, 0.006, 0.008, 0.002), 'trim',
      { p: [0, -0.008 + i * 0.014, FRONT * 0.126], r: [12 * DEG, 0, 0], tier: TIER.GREEBLE });
  }
  // ear blocks with vents
  for (const { sign, mirror } of SIDES) {
    rig.add('head', bevelBox(0.05, 0.10, 0.13, 0.010, { topX: 0.7 }), 'armorSecondary',
      { p: [sign * 0.122, 0.055, -FRONT * 0.01], r: [0, 0, sign * -6 * DEG], mirror, tier: TIER.PRIMARY });
    addLouvres(rig, 'head', {
      p: [sign * 0.148, 0.055, -FRONT * 0.01], r: [0, sign * 90 * DEG, 0],
      w: 0.09, h: 0.06, n: 3, depth: 0.014, mirror, glow: 'joints',
    });
  }
  // crest fin
  rig.add('head', bevelBox(0.026, 0.05, 0.17, 0.006, { topX: 0.4, topZ: 0.8 }), 'armorAccent',
    { p: [0, 0.135, -FRONT * 0.015], tier: TIER.SECONDARY });
  rig.add('head', bevelBox(0.008, 0.055, 0.008, 0.002), 'trim',
    { p: [0.055, 0.145, -FRONT * 0.06], r: [-20 * DEG, 0, 8 * DEG], tier: TIER.GREEBLE });
}

function headWedge(rig) {
  // forward-raked wedge with a single cyclops optic
  rig.add('head', bevelBox(0.155, 0.155, 0.215, 0.012,
    { topX: 0.72, topZ: 0.80, botX: 0.60, botZ: 0.55, shearZ: FRONT * 0.030 }), 'armorPrimary',
  { p: [0, 0.06, FRONT * 0.012], tier: TIER.PRIMARY });
  // cheek intakes
  for (const { sign, mirror } of SIDES) {
    rig.add('head', bevelBox(0.030, 0.075, 0.10, 0.006, { topX: 0.6, topZ: 0.7 }), 'darkMetal',
      { p: [sign * 0.072, 0.035, FRONT * 0.045], r: [0, sign * 12 * DEG, sign * -10 * DEG], mirror, tier: TIER.SECONDARY });
    rig.glow('head', bevelBox(0.010, 0.045, 0.012, 0.003), 'joints',
      { p: [sign * 0.085, 0.035, FRONT * 0.055], r: [0, sign * 12 * DEG, 0], mirror });
  }
  // optic housing and lens
  rig.add('head', latheProfile([
    { r: 0.052, y: 0 }, { r: 0.052, y: 0.014 }, { r: 0.040, y: 0.026 }, { r: 0.034, y: 0.026 }, { r: 0.034, y: 0 },
  ], 20), 'darkMetal', { p: [0, 0.062, FRONT * 0.108], r: [-90 * DEG * -FRONT, 0, 0], tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.031, y: 0 }, { r: 0.030, y: 0.010, smooth: true }, { r: 0, y: 0.016 },
  ], 20), 'visor', { p: [0, 0.062, FRONT * 0.120], r: [-90 * DEG * -FRONT, 0, 0] });
  // swept crest sweeping back over the neck
  rig.add('head', bevelBox(0.030, 0.055, 0.26, 0.006, { topX: 0.35, topZ: 0.7, shearZ: -FRONT * 0.05 }), 'armorAccent',
    { p: [0, 0.125, -FRONT * 0.06], r: [12 * DEG, 0, 0], tier: TIER.PRIMARY });
  for (const { sign, mirror } of SIDES) {
    rig.add('head', bevelBox(0.014, 0.030, 0.19, 0.004, { topX: 0.4, shearZ: -FRONT * 0.04 }), 'armorSecondary',
      { p: [sign * 0.05, 0.115, -FRONT * 0.05], r: [16 * DEG, sign * -8 * DEG, sign * 16 * DEG], mirror, tier: TIER.SECONDARY });
  }
  // antennae
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0.008, y: 0 }, { r: 0.008, y: 0.06 }, { r: 0.004, y: 0.062 }, { r: 0.004, y: 0.16 }, { r: 0, y: 0.17 },
    ], 12), 'trim', { p: [sign * 0.055, 0.125, -FRONT * 0.02], r: [-18 * DEG, 0, sign * 14 * DEG], mirror, tier: TIER.GREEBLE });
  }
}

function headSunken(rig) {
  // small head sunk between the shoulders behind a caged mask
  rig.add('head', latheProfile([
    { r: 0.052, y: -0.01 }, { r: 0.080, y: 0.028, smooth: true }, { r: 0.086, y: 0.075, smooth: true },
    { r: 0.070, y: 0.115, smooth: true }, { r: 0.032, y: 0.135 }, { r: 0, y: 0.135 },
  ], 20), 'armorPrimary', { p: [0, 0.01, 0], tier: TIER.PRIMARY });
  // face cage
  for (let i = -2; i <= 2; i++) {
    rig.add('head', bevelBox(0.011, 0.115, 0.024, 0.003, { topX: 0.7, botX: 0.7 }), 'darkMetal', {
      p: [i * 0.021, 0.055, FRONT * (0.078 - Math.abs(i) * 0.006)],
      r: [0, i * -8 * DEG, 0], tier: TIER.PRIMARY,
    });
  }
  rig.add('head', bevelBox(0.14, 0.016, 0.03, 0.004), 'trim',
    { p: [0, 0.108, FRONT * 0.070], r: [-14 * DEG, 0, 0], tier: TIER.SECONDARY });
  rig.add('head', bevelBox(0.13, 0.016, 0.03, 0.004), 'trim',
    { p: [0, 0.008, FRONT * 0.070], r: [14 * DEG, 0, 0], tier: TIER.SECONDARY });
  // three furnace eyes behind the cage
  for (let i = -1; i <= 1; i++) {
    rig.glow('head', latheProfile([
      { r: 0, y: 0 }, { r: 0.014 - Math.abs(i) * 0.004, y: 0 }, { r: 0.012 - Math.abs(i) * 0.004, y: 0.008 }, { r: 0, y: 0.010 },
    ], 14), 'visor', { p: [i * 0.030, 0.062, FRONT * 0.060], r: [-90 * DEG * -FRONT, 0, 0] });
  }
  // skull cap and exhaust nubs
  rig.add('head', bevelBox(0.14, 0.05, 0.15, 0.010, { topX: 0.7, topZ: 0.7 }), 'armorSecondary',
    { p: [0, 0.118, -FRONT * 0.012], tier: TIER.PRIMARY });
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0.018, y: 0 }, { r: 0.018, y: 0.05 }, { r: 0.022, y: 0.054, smooth: true }, { r: 0.014, y: 0.062 }, { r: 0, y: 0.062 },
    ], 14), 'darkMetal', { p: [sign * 0.052, 0.135, -FRONT * 0.05], r: [-24 * DEG, 0, sign * 10 * DEG], mirror, tier: TIER.SECONDARY });
    rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.011, y: 0 }, { r: 0, y: 0.006 }], 14), 'vents',
      { p: [sign * 0.075, 0.190, -FRONT * 0.077], r: [-24 * DEG, 0, sign * 10 * DEG], mirror });
  }
}

function headTower(rig, spec, def) {
  // narrow head plus a sensor mast: unmistakable long-range silhouette
  rig.add('head', bevelBox(0.135, 0.155, 0.185, 0.012, { topX: 0.85, topZ: 0.85, botX: 0.68, botZ: 0.7 }), 'armorPrimary',
    { p: [0, 0.058, 0], tier: TIER.PRIMARY });
  rig.add('head', channelStrip(0.115, 0.030, 0.014), 'darkMetal',
    { p: [0, 0.072, FRONT * 0.094], r: FACE_FRONT, tier: TIER.SECONDARY });
  rig.glow('head', bevelBox(0.10, 0.016, 0.008, 0.003), 'visor', { p: [0, 0.074, FRONT * 0.098] });
  // targeting monocle on one side, on a swing arm
  rig.add('head', bevelBox(0.036, 0.036, 0.08, 0.006), 'darkMetal',
    { p: [0.078, 0.085, FRONT * 0.045], r: [0, 12 * DEG, 8 * DEG], tier: TIER.SECONDARY });
  rig.add('head', latheProfile([
    { r: 0.026, y: 0 }, { r: 0.026, y: 0.02 }, { r: 0.020, y: 0.028 }, { r: 0.016, y: 0.028 }, { r: 0.016, y: 0 },
  ], 16), 'trim', { p: [0.086, 0.085, FRONT * 0.088], r: [-90 * DEG * -FRONT, 0, 0], tier: TIER.SECONDARY });
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.015, y: 0 }, { r: 0, y: 0.008 }], 16), 'visor',
    { p: [0.086, 0.085, FRONT * 0.100], r: [-90 * DEG * -FRONT, 0, 0] });
  // sensor drum on the other side
  rig.add('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.034, y: 0 }, { r: 0.038, y: 0.010, smooth: true }, { r: 0.038, y: 0.034 },
    { r: 0.028, y: 0.042 }, { r: 0, y: 0.042 },
  ], 20), 'darkMetal', { p: [-0.072, 0.06, 0], r: [0, 0, 90 * DEG], tier: TIER.SECONDARY });
  rig.decal('head', DECAL.GAUGE, 0.055, 0.055, { p: [-0.116, 0.06, 0], r: [0, -90 * DEG, 0], tier: TIER.GREEBLE });
  // mast + antennae
  rig.add('head', bevelBox(0.05, 0.20, 0.06, 0.008, { topX: 0.5, topZ: 0.5 }), 'armorSecondary',
    { p: [0, 0.20, -FRONT * 0.035], r: [-8 * DEG, 0, 0], tier: TIER.PRIMARY });
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0.006, y: 0 }, { r: 0.006, y: 0.10 }, { r: 0.003, y: 0.105 }, { r: 0.003, y: 0.24 }, { r: 0, y: 0.25 },
    ], 12), 'trim', { p: [sign * 0.024, 0.28, -FRONT * 0.045], r: [-12 * DEG, 0, sign * 9 * DEG], mirror, tier: TIER.SECONDARY });
  }
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.010, y: 0 }, { r: 0, y: 0.012 }], 12), 'joints',
    { p: [0, 0.31, -FRONT * 0.035] });
  if (def) rig.decal('head', DECAL.BARCODE, 0.06, 0.03, { p: [0, 0.02, -FRONT * 0.096], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE });
}

function headCrown(rig) {
  // smooth ceremonial helm, faceted forehead crystal, four flared horn spines
  rig.add('head', latheProfile([
    { r: 0.038, y: -0.02 }, { r: 0.072, y: 0.015, smooth: true }, { r: 0.086, y: 0.062, smooth: true },
    { r: 0.078, y: 0.115, smooth: true }, { r: 0.046, y: 0.155, smooth: true }, { r: 0, y: 0.168 },
  ], 24), 'armorPrimary', { p: [0, 0.01, 0], s: [1, 1, 1.12], tier: TIER.PRIMARY });
  // face veil
  rig.add('head', bevelBox(0.115, 0.13, 0.055, 0.008, { topX: 0.92, botX: 0.58, botZ: 0.7, shearZ: FRONT * 0.016 }), 'trim',
    { p: [0, 0.055, FRONT * 0.070], tier: TIER.PRIMARY });
  rig.add('head', channelStrip(0.09, 0.020, 0.010), 'darkMetal',
    { p: [0, 0.078, FRONT * 0.098], r: FACE_FRONT, tier: TIER.SECONDARY });
  rig.glow('head', bevelBox(0.076, 0.012, 0.008, 0.003), 'visor', { p: [0, 0.079, FRONT * 0.101] });
  // forehead crystal
  rig.glow('head', latheProfile([
    { r: 0, y: -0.030 }, { r: 0.020, y: -0.008 }, { r: 0.022, y: 0.004 }, { r: 0, y: 0.034 },
  ], 6, { faceted: true, phase: Math.PI / 6 }), 'core',
  { p: [0, 0.122, FRONT * 0.062], r: [-70 * DEG * -FRONT, 0, 0] });
  // horns
  for (const { sign, mirror } of SIDES) {
    for (let k = 0; k < 2; k++) {
      const len = k === 0 ? 0.22 : 0.15;
      rig.add('head', bevelBox(0.024, len, 0.030, 0.005, { topX: 0.22, topZ: 0.3, shearZ: -FRONT * 0.05 }), 'armorAccent', {
        p: [sign * (0.052 + k * 0.026), 0.115 + k * 0.012, -FRONT * (0.01 + k * 0.035)],
        r: [(26 + k * 14) * DEG, 0, sign * (24 + k * 16) * DEG],
        mirror, tier: TIER.PRIMARY,
      });
    }
    rig.glow('head', bevelBox(0.006, 0.12, 0.006, 0.002), 'spine', {
      p: [sign * 0.058, 0.16, -FRONT * 0.035], r: [26 * DEG, 0, sign * 24 * DEG], mirror,
    });
  }
  // circlet
  const circlet = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const g = bevelBox(0.018, 0.020, 0.014, 0.004);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * 0.084, 0, Math.sin(a) * 0.094),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, 0)),
      new THREE.Vector3(1, 1, 1),
    ));
    circlet.push(g);
  }
  rig.add('head', joinGeometries(circlet), 'trim', { p: [0, 0.052, 0], tier: TIER.SECONDARY });
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

function buildArm(rig, spec, side, sign, mirror, opts = {}) {
  const a = spec.arms;
  const pd = spec.pauldron;
  const S = side;
  const gaunt = opts.gauntlet ?? a.gauntlet;
  const upper = a.upper * (opts.scale ?? 1);
  const fore = a.fore * (opts.scale ?? 1);

  // --- pauldron, on the clavicle so big shoulder armour does not spin with the arm
  const layers = pd.layers;
  for (let i = 0; i < layers; i++) {
    const f = 1 - i * 0.24;
    rig.add(`clavicle_${S}`, bevelBox(pd.w * f, pd.h * (1 - i * 0.16), pd.d * f, 0.016,
      { topX: pd.taper, topZ: pd.taper * 1.05, botX: 1.02 }), i === 0 ? 'armorPrimary' : 'armorSecondary', {
      p: [sign * (pd.out + pd.w * 0.28 + i * 0.006), pd.up - i * pd.h * 0.30, -FRONT * i * pd.d * 0.06],
      r: [0, 0, sign * -(pd.tilt + i * 7) * DEG],
      mirror, tier: TIER.PRIMARY,
    });
  }
  // pauldron rim and rivets
  rig.add(`clavicle_${S}`, bevelBox(pd.w * 0.30, 0.016, pd.d * 1.02, 0.005), 'trim', {
    p: [sign * (pd.out + pd.w * 0.62), pd.up + pd.h * 0.42, 0],
    r: [0, 0, sign * -pd.tilt * DEG], mirror, tier: TIER.SECONDARY,
  });
  rig.decal(`clavicle_${S}`, DECAL.HAZARD, pd.d * 0.7, 0.038, {
    p: [sign * (pd.out + pd.w * 0.30), pd.up + pd.h * 0.50, 0],
    r: [-90 * DEG, 0, sign * -pd.tilt * DEG], mirror, tier: TIER.GREEBLE,
  });
  rig.add(`clavicle_${S}`, boltRing(5, pd.w * 0.26, 0.008, 0.010), 'trim', {
    p: [sign * (pd.out + pd.w * 0.36), pd.up - pd.h * 0.05, FRONT * pd.d * 0.42],
    r: FACE_FRONT, mirror, tier: TIER.GREEBLE,
  });

  // --- rotary shoulder housing, world-aligned so its axis is horizontal
  rig.add(`shoulder_${S}`, latheProfile([
    { r: 0, y: -0.02 }, { r: upper * 0.62, y: -0.02 }, { r: upper * 0.70, y: 0.004, smooth: true },
    { r: upper * 0.70, y: 0.030 }, { r: upper * 0.56, y: 0.046 }, { r: 0, y: 0.046 },
  ], 22), 'darkMetal', { world: true, p: [sign * 0.012, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`shoulder_${S}`, boltRing(6, upper * 0.52, 0.008, 0.010), 'trim',
    { world: true, p: [sign * 0.056, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.GREEBLE });
  rig.glow(`shoulder_${S}`, latheProfile([
    { r: 0, y: 0 }, { r: upper * 0.26, y: 0 }, { r: 0, y: 0.006 },
  ], 16), 'joints', { world: true, p: [sign * 0.060, 0, 0], r: [0, 0, sign * -90 * DEG], mirror });

  // --- upper arm: tapered plates around the bone axis, front/back split
  const uLen = 0.29;
  rig.add(`shoulder_${S}`, bevelBox(upper * 1.5, uLen * 0.78, upper * 1.55, 0.012,
    { topX: 1.06, topZ: 1.0, botX: 0.80, botZ: 0.82 }), 'armorPrimary',
  { p: [0, -uLen * 0.46, 0], mirror, tier: TIER.PRIMARY });
  rig.add(`shoulder_${S}`, bevelBox(upper * 1.1, uLen * 0.40, upper * 0.5, 0.008, { topX: 0.9, botX: 0.7 }), 'armorSecondary',
    { p: [0, -uLen * 0.52, FRONT * upper * 0.82], r: [0, 0, 0], mirror, tier: TIER.SECONDARY });
  rig.add(`shoulder_${S}`, channelStrip(upper * 1.2, uLen * 0.5, 0.008), 'darkMetal',
    { p: [0, -uLen * 0.44, -FRONT * upper * 0.78], r: FACE_BACK, mirror, tier: TIER.SECONDARY });
  rig.add(`shoulder_${S}`, latheProfile([
    { r: upper * 0.55, y: 0 }, { r: upper * 0.62, y: 0.012, smooth: true }, { r: upper * 0.62, y: 0.03 },
    { r: upper * 0.55, y: 0.042 },
  ], 20), 'trim', { p: [0, -uLen * 0.80, 0], mirror, tier: TIER.SECONDARY });

  // --- elbow: rotary housing + floating cap
  rig.add(`elbow_${S}`, latheProfile([
    { r: 0, y: -0.018 }, { r: fore * 0.68, y: -0.018 }, { r: fore * 0.74, y: 0.0, smooth: true },
    { r: fore * 0.74, y: 0.022 }, { r: fore * 0.60, y: 0.036 }, { r: 0, y: 0.036 },
  ], 22), 'darkMetal', { world: true, p: [0, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`elbow_${S}`, bevelBox(fore * 1.35, fore * 1.1, fore * 0.75, 0.010, { topX: 0.85, botX: 0.9 }), 'armorSecondary',
    { p: [0, -fore * 0.10, -FRONT * fore * 0.85], r: [10 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });

  // --- forearm
  const fLen = 0.27;
  rig.add(`elbow_${S}`, bevelBox(fore * 1.55, fLen * 0.80, fore * 1.55, 0.012,
    { topX: 1.02, botX: 0.86 * (1 + gaunt * 0.20), botZ: 0.88 * (1 + gaunt * 0.20) }), 'armorPrimary',
  { p: [0, -fLen * 0.46, 0], mirror, tier: TIER.PRIMARY });
  // forearm panel with fasteners
  rig.add(`elbow_${S}`, bevelBox(fore * 1.0, fLen * 0.44, 0.012, 0.005), 'carbon',
    { p: [0, -fLen * 0.44, FRONT * fore * 0.82], mirror, tier: TIER.SECONDARY });
  rig.add(`elbow_${S}`, boltRing(4, fore * 0.42, 0.007, 0.009), 'trim',
    { p: [0, -fLen * 0.44, FRONT * (fore * 0.84)], r: FACE_FRONT, mirror, tier: TIER.GREEBLE });
  rig.decal(`elbow_${S}`, DECAL.SERIAL, fore * 1.1, fore * 1.1, {
    p: [sign * fore * 0.86, -fLen * 0.45, 0], r: [0, sign * 90 * DEG, 0], mirror, tier: TIER.GREEBLE,
  });

  // --- wrist cuff
  rig.add(`wrist_${S}`, latheProfile([
    { r: fore * 0.72, y: 0.03 }, { r: fore * 0.80, y: 0.012, smooth: true }, { r: fore * 0.80, y: -0.03 },
    { r: fore * 0.66, y: -0.048 },
  ], 20), 'darkMetal', { p: [0, 0, 0], mirror, tier: TIER.PRIMARY });
  rig.glow(`wrist_${S}`, latheProfile([
    { r: fore * 0.70, y: 0 }, { r: fore * 0.76, y: 0.004 }, { r: fore * 0.76, y: 0.014 }, { r: fore * 0.70, y: 0.018 },
  ], 20), 'joints', { p: [0, -0.006, 0], mirror });

  // --- hand: fist block, knuckle plates, thumb
  const hw = fore * (1.55 + gaunt * 0.85);
  rig.add(`hand_${S}`, bevelBox(hw * 0.72, 0.115, hw * 0.95, 0.012, { topX: 0.9, botX: 0.86, botZ: 0.9 }), 'armorPrimary',
    { p: [0, -0.045, 0], mirror, tier: TIER.PRIMARY });
  rig.add(`fingers_${S}`, bevelBox(hw * 0.70, 0.075, hw * 0.90, 0.010, { botX: 0.82, botZ: 0.84 }), 'armorSecondary',
    { p: [0, -0.03, 0], mirror, tier: TIER.PRIMARY });
  for (let i = 0; i < 4; i++) {
    rig.add(`fingers_${S}`, latheProfile([
      { r: 0, y: 0 }, { r: hw * 0.11, y: 0 }, { r: hw * 0.115, y: 0.012, smooth: true }, { r: hw * 0.08, y: 0.028 }, { r: 0, y: 0.030 },
    ], 14), 'trim', {
      p: [sign * hw * (0.24 - i * 0.16), 0.008, FRONT * (hw * 0.30 - Math.abs(i - 1.5) * hw * 0.06)],
      r: [-90 * DEG * -FRONT, 0, 0], mirror, tier: TIER.SECONDARY,
    });
  }
  rig.add(`thumb_${S}`, bevelBox(hw * 0.34, 0.075, hw * 0.34, 0.008, { topX: 0.8 }), 'armorSecondary',
    { p: [0, -0.02, 0], r: [0, 0, sign * -22 * DEG], mirror, tier: TIER.SECONDARY });

  if (gaunt > 0.9) {
    // heavy gauntlet shell: extra plating flaring past the wrist
    rig.add(`elbow_${S}`, bevelBox(fore * 2.1 * gaunt, fLen * 0.42, fore * 2.0 * gaunt, 0.014,
      { topX: 0.78, botX: 1.0 }), 'armorAccent',
    { p: [0, -fLen * 0.78, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`elbow_${S}`, boltRing(8, fore * 0.9 * gaunt, 0.009, 0.011), 'trim',
      { p: [0, -fLen * 0.98, 0], r: [180 * DEG, 0, 0], mirror, tier: TIER.GREEBLE });
    rig.glow(`elbow_${S}`, bevelBox(fore * 1.4, 0.016, 0.012, 0.004), 'vents',
      { p: [0, -fLen * 0.62, FRONT * fore * 1.02 * gaunt], mirror });
  }
}

/** Folded forearm blade — agile chassis signature hardware. */
function addForearmBlade(rig, spec, side, sign, mirror) {
  const fore = spec.arms.fore;
  const S = side;
  rig.add(`elbow_${S}`, bevelBox(0.028, 0.30, 0.055, 0.006, { topX: 0.35, topZ: 0.42, botX: 0.8 }), 'trim',
    { p: [sign * fore * 0.95, -0.15, -FRONT * fore * 0.30], r: [-6 * DEG, 0, sign * -4 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`elbow_${S}`, bevelBox(0.040, 0.075, 0.070, 0.008), 'darkMetal',
    { p: [sign * fore * 0.95, 0.02, -FRONT * fore * 0.30], mirror, tier: TIER.SECONDARY });
  rig.glow(`elbow_${S}`, bevelBox(0.010, 0.22, 0.010, 0.003), 'spine',
    { p: [sign * fore * 1.02, -0.13, -FRONT * fore * 0.30], mirror });
  rig.emitter('blade', `elbow_${S}`, [sign * fore * 0.95, -0.30, -FRONT * fore * 0.30], [0, -1, 0], 0.03);
}

/** Over-shoulder cannon — precision chassis signature hardware. */
function addShoulderCannon(rig, spec, side, sign, mirror) {
  const S = side;
  const pd = spec.pauldron;
  const bx = sign * (pd.out + pd.w * 0.28);
  rig.add(`clavicle_${S}`, bevelBox(0.09, 0.10, 0.34, 0.010, { topX: 0.8, topZ: 0.9 }), 'armorSecondary',
    { p: [bx, pd.up + pd.h * 0.62, -FRONT * 0.02], r: [-4 * DEG, 0, sign * -10 * DEG], mirror, tier: TIER.PRIMARY });
  const barrel = latheProfile([
    { r: 0.034, y: 0 }, { r: 0.034, y: 0.10 }, { r: 0.042, y: 0.115, smooth: true }, { r: 0.042, y: 0.16 },
    { r: 0.028, y: 0.175 }, { r: 0.028, y: 0.40 }, { r: 0.034, y: 0.415, smooth: true }, { r: 0.034, y: 0.45 },
    { r: 0.020, y: 0.46 }, { r: 0.018, y: 0.46 },
  ], 20);
  rig.add(`clavicle_${S}`, barrel, 'darkMetal',
    { p: [bx, pd.up + pd.h * 0.62, 0], r: [(90 * DEG) * FRONT, 0, sign * -10 * DEG], order: 'ZXY', mirror, tier: TIER.PRIMARY });
  rig.glow(`clavicle_${S}`, latheProfile([{ r: 0, y: 0 }, { r: 0.016, y: 0 }, { r: 0, y: 0.010 }], 16), 'core',
    { p: [bx, pd.up + pd.h * 0.62, FRONT * 0.46], r: [(90 * DEG) * FRONT, 0, 0], mirror });
  rig.add(`clavicle_${S}`, boltRing(6, 0.040, 0.007, 0.009), 'trim',
    { p: [bx, pd.up + pd.h * 0.62, -FRONT * 0.02], r: [(-90 * DEG) * FRONT, 0, 0], mirror, tier: TIER.GREEBLE });
  rig.decal(`clavicle_${S}`, DECAL.CAUTION, 0.10, 0.05, {
    p: [bx + sign * 0.048, pd.up + pd.h * 0.62, FRONT * 0.05], r: [0, sign * 90 * DEG, 90 * DEG], mirror, tier: TIER.GREEBLE,
  });
  rig.emitter('muzzle', `clavicle_${S}`, [bx, pd.up + pd.h * 0.62, FRONT * 0.47], [0, 0, FRONT], 0.035);
}

/** Floating shoulder ring — arcane chassis signature hardware. */
function addShoulderRing(rig, spec, side, sign, mirror) {
  const S = side;
  const pd = spec.pauldron;
  const R = 0.155;
  const blocks = [];
  const SEGS = 12;
  for (let i = 0; i < SEGS; i++) {
    const a = (i / SEGS) * Math.PI * 2;
    const g = bevelBox(0.030, 0.026, (2 * Math.PI * R) / SEGS * 0.88, 0.005);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2)),
      new THREE.Vector3(1, 1, 1),
    ));
    blocks.push(g);
  }
  rig.add(`clavicle_${S}`, joinGeometries(blocks), 'armorAccent', {
    p: [sign * (pd.out + 0.05), pd.up - 0.02, 0],
    r: [0, sign * 22 * DEG, sign * -18 * DEG], mirror, tier: TIER.PRIMARY,
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    rig.glow(`clavicle_${S}`, bevelBox(0.036, 0.012, 0.012, 0.003), 'spine', {
      p: [sign * (pd.out + 0.05) + Math.cos(a) * R * 0.94, pd.up - 0.02 + Math.sin(a) * R * 0.94, 0],
      r: [0, sign * 22 * DEG, a + Math.PI / 2], mirror,
    });
  }
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

function buildLeg(rig, spec, side, sign, mirror) {
  const L = spec.legs;
  const S = side;
  const digi = L.plan === 'digitigrade';
  const splay = L.plan === 'splayed';

  // --- thigh
  const tLen = 0.44;
  rig.add(`hip_${S}`, bevelBox(L.thigh * 1.45, tLen * 0.80, L.thigh * 1.5, 0.016,
    { topX: 1.06, topZ: 1.02, botX: 0.76, botZ: 0.80 }), 'armorPrimary',
  { p: [0, -tLen * 0.44, 0], r: [0, 0, sign * (splay ? 4 : 2) * DEG], mirror, tier: TIER.PRIMARY });
  // outer thigh panel + channel
  rig.add(`hip_${S}`, bevelBox(0.026, tLen * 0.52, L.thigh * 1.0, 0.006, { topX: 0.8 }), 'carbon',
    { p: [sign * L.thigh * 0.76, -tLen * 0.42, 0], mirror, tier: TIER.SECONDARY });
  rig.add(`hip_${S}`, channelStrip(L.thigh * 0.9, tLen * 0.5, 0.010), 'darkMetal',
    { p: [0, -tLen * 0.40, FRONT * L.thigh * 0.78], r: FACE_FRONT, mirror, tier: TIER.SECONDARY });
  rig.decal(`hip_${S}`, DECAL.ARROW, L.thigh * 0.7, L.thigh * 0.7, {
    p: [sign * L.thigh * 0.80, -tLen * 0.6, 0], r: [0, sign * 90 * DEG, 0], mirror, tier: TIER.GREEBLE,
  });
  // hip collar
  rig.add(`hip_${S}`, latheProfile([
    { r: L.thigh * 0.72, y: 0.02 }, { r: L.thigh * 0.80, y: 0.0, smooth: true }, { r: L.thigh * 0.80, y: -0.03 },
    { r: L.thigh * 0.68, y: -0.05 },
  ], 20), 'darkMetal', { p: [0, -0.01, 0], mirror, tier: TIER.PRIMARY });

  // --- knee assembly (knee_L is the SHIN bone; the cap rides with the shin)
  rig.add(`knee_${S}`, latheProfile([
    { r: 0, y: -0.022 }, { r: L.shin * 0.80, y: -0.022 }, { r: L.shin * 0.88, y: 0.0, smooth: true },
    { r: L.shin * 0.88, y: 0.026 }, { r: L.shin * 0.72, y: 0.044 }, { r: 0, y: 0.044 },
  ], 22), 'darkMetal', { world: true, p: [0, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`knee_${S}`, bevelBox(L.shin * 1.35, L.shin * 1.25, L.shin * 0.85, 0.012,
    { topX: 0.86, botX: 0.72, shearZ: FRONT * 0.02 }), 'armorAccent',
  { p: [0, -L.shin * 0.14, FRONT * L.shin * 0.85], r: [-8 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });
  rig.glow(`knee_${S}`, bevelBox(L.shin * 0.55, 0.012, 0.010, 0.003), 'joints',
    { p: [0, -L.shin * 0.40, FRONT * L.shin * 1.05], mirror });

  // --- shin
  const sLen = 0.42;
  if (digi) {
    // digitigrade read: the shin flares backwards at the top into a hock, then
    // sweeps forward into a slim lower leg
    rig.add(`knee_${S}`, bevelBox(L.shin * 1.3, sLen * 0.44, L.shin * 1.9, 0.012,
      { topX: 1.0, topZ: 1.0, botX: 0.72, botZ: 0.62, shearZ: -FRONT * 0.05 }), 'armorPrimary',
    { p: [0, -sLen * 0.26, -FRONT * L.shin * 0.30], mirror, tier: TIER.PRIMARY });
    rig.add(`knee_${S}`, bevelBox(L.shin * 1.0, sLen * 0.46, L.shin * 1.0, 0.010,
      { topX: 1.0, botX: 0.72, botZ: 0.72, shearZ: FRONT * 0.045 }), 'armorPrimary',
    { p: [0, -sLen * 0.72, -FRONT * L.shin * 0.05], mirror, tier: TIER.PRIMARY });
    // calf thruster
    rig.add(`knee_${S}`, latheProfile([
      { r: L.shin * 0.30, y: 0 }, { r: L.shin * 0.30, y: 0.05 }, { r: L.shin * 0.42, y: 0.085, smooth: true },
      { r: L.shin * 0.26, y: 0.09 }, { r: L.shin * 0.22, y: 0.05 }, { r: L.shin * 0.22, y: 0 },
    ], 16), 'darkMetal', { p: [0, -sLen * 0.30, -FRONT * L.shin * 0.95], r: [(160 * DEG) * -FRONT, 0, 0], mirror, tier: TIER.SECONDARY });
    rig.glow(`knee_${S}`, latheProfile([{ r: 0, y: 0 }, { r: L.shin * 0.22, y: 0 }, { r: 0, y: 0.008 }], 16), 'vents',
      { p: [0, -sLen * 0.38, -FRONT * L.shin * 1.02], r: [(160 * DEG) * -FRONT, 0, 0], mirror });
    rig.emitter('thruster', `knee_${S}`, [0, -sLen * 0.40, -FRONT * L.shin * 1.05], [0, -0.4, -FRONT], 0.04);
  } else {
    rig.add(`knee_${S}`, bevelBox(L.shin * 1.42, sLen * 0.80, L.shin * 1.5, 0.014,
      { topX: 1.02, botX: 0.80, botZ: 0.86 }), 'armorPrimary',
    { p: [0, -sLen * 0.44, 0], mirror, tier: TIER.PRIMARY });
    // calf vent stack
    addLouvres(rig, `knee_${S}`, {
      p: [0, -sLen * 0.42, -FRONT * (L.shin * 0.78)], r: [0, YAW_BACK, 0],
      w: L.shin * 0.9, h: sLen * 0.36, n: 4, depth: 0.016, mirror, glow: 'vents',
    });
    rig.add(`knee_${S}`, bevelBox(0.024, sLen * 0.5, L.shin * 0.9, 0.006, { topX: 0.8 }), 'carbon',
      { p: [sign * L.shin * 0.76, -sLen * 0.42, 0], mirror, tier: TIER.SECONDARY });
  }
  rig.decal(`knee_${S}`, DECAL.RIVETS, L.shin * 1.1, L.shin * 0.28, {
    p: [0, -sLen * 0.16, FRONT * (L.shin * 0.80)], r: [0, YAW_FRONT, 0], mirror, tier: TIER.GREEBLE,
  });

  // --- ankle
  rig.add(`ankle_${S}`, latheProfile([
    { r: 0, y: -0.02 }, { r: L.shin * 0.60, y: -0.02 }, { r: L.shin * 0.66, y: 0.004, smooth: true },
    { r: L.shin * 0.66, y: 0.024 }, { r: L.shin * 0.52, y: 0.038 }, { r: 0, y: 0.038 },
  ], 20), 'darkMetal', { world: true, p: [0, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });

  // --- foot
  const fw = L.footW, fl = L.foot;
  if (digi) {
    // slim pad + long toe + rearward heel spur
    rig.add(`foot_${S}`, bevelBox(fw * 1.05, 0.075, fl * 0.62, 0.010,
      { topX: 1.05, botX: 0.86, botZ: 0.9 }), 'armorPrimary',
    { p: [0, -0.005, FRONT * fl * 0.04], mirror, tier: TIER.PRIMARY });
    rig.add(`foot_${S}`, bevelBox(fw * 0.55, 0.05, fl * 0.42, 0.008, { topX: 0.9, botZ: 0.6, shearZ: -FRONT * 0.05 }), 'armorSecondary',
      { p: [0, 0.03, -FRONT * fl * 0.34], r: [-30 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`toe_${S}`, bevelBox(fw * 0.95, 0.055, fl * 0.55, 0.008,
      { topX: 0.85, botX: 0.62, botZ: 0.55, shearZ: FRONT * 0.03 }), 'armorPrimary',
    { p: [0, 0.005, FRONT * fl * 0.10], mirror, tier: TIER.PRIMARY });
    for (let i = -1; i <= 1; i++) {
      rig.add(`toe_${S}`, bevelBox(fw * 0.20, 0.030, fl * 0.24, 0.005, { topX: 0.4, topZ: 0.3, shearZ: FRONT * 0.02 }), 'trim',
        { p: [i * fw * 0.30, -0.012, FRONT * fl * 0.34], r: [8 * DEG, 0, 0], mirror, tier: TIER.SECONDARY });
    }
    rig.add(`foot_${S}`, bevelBox(fw * 0.95, 0.020, fl * 0.55, 0.005), 'rubber',
      { p: [0, -0.042, FRONT * fl * 0.04], mirror, tier: TIER.SECONDARY });
  } else {
    // heavy boot: sole, toe cap, ankle collar, cleats
    rig.add(`foot_${S}`, bevelBox(fw * 1.25, 0.11, fl * 0.86, 0.012,
      { topX: 0.90, topZ: 0.86, botX: 1.0, botZ: 1.0, shearZ: FRONT * 0.012 }), 'armorPrimary',
    { p: [0, 0.005, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`foot_${S}`, bevelBox(fw * 1.28, 0.030, fl * 0.90, 0.006), 'rubber',
      { p: [0, -0.058, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`toe_${S}`, bevelBox(fw * 1.1, 0.085, fl * 0.42, 0.010,
      { topX: 0.82, topZ: 0.7, botZ: 0.9, shearZ: FRONT * 0.02 }), 'armorAccent',
    { p: [0, 0.02, FRONT * fl * 0.06], r: [-6 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`toe_${S}`, bevelBox(fw * 1.12, 0.022, fl * 0.44, 0.005), 'rubber',
      { p: [0, -0.024, FRONT * fl * 0.06], mirror, tier: TIER.SECONDARY });
    // heel block
    rig.add(`foot_${S}`, bevelBox(fw * 0.9, 0.09, fl * 0.26, 0.008, { topX: 0.85, shearZ: -FRONT * 0.02 }), 'armorSecondary',
      { p: [0, 0.02, -FRONT * fl * 0.40], mirror, tier: TIER.PRIMARY });
    // cleats
    for (let i = 0; i < 3; i++) {
      rig.add(`foot_${S}`, bevelBox(fw * 1.1, 0.012, 0.022, 0.004), 'darkMetal',
        { p: [0, -0.070, FRONT * (fl * 0.26 - i * fl * 0.26)], mirror, tier: TIER.GREEBLE });
    }
    if (splay) {
      for (const o of [-1, 1]) {
        rig.add(`foot_${S}`, bevelBox(fw * 0.34, 0.06, fl * 0.5, 0.007, { topX: 0.6, botZ: 0.9 }), 'armorSecondary',
          { p: [o * fw * 0.72, 0.005, -FRONT * fl * 0.05], r: [0, 0, o * 14 * DEG], mirror, tier: TIER.SECONDARY });
      }
    }
  }
  rig.add(`ankle_${S}`, latheProfile([
    { r: L.shin * 0.62, y: 0.02 }, { r: L.shin * 0.70, y: 0.0, smooth: true }, { r: L.shin * 0.70, y: -0.028 },
    { r: L.shin * 0.58, y: -0.044 },
  ], 20), 'trim', { p: [0, -0.01, 0], mirror, tier: TIER.SECONDARY });
  rig.decal(`foot_${S}`, DECAL.HAZARD, fw * 0.9, 0.028, {
    p: [0, 0.045, FRONT * (fl * 0.44)], r: [0, YAW_FRONT, 0], mirror, tier: TIER.GREEBLE,
  });
}

/** Counterweight tail on the hips — arcane chassis signature hardware. */
function addTail(rig, spec) {
  const t = spec.torso;
  const segs = 6;
  let z = -FRONT * (t.waistD * 0.6);
  let y = -0.02;
  const parts = [];
  for (let i = 0; i < segs; i++) {
    const f = 1 - i * 0.11;
    const g = bevelBox(0.075 * f, 0.070 * f, 0.10 * f, 0.008);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(0, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-(12 + i * 8) * DEG * FRONT, 0, 0)),
      new THREE.Vector3(1, 1, 1),
    ));
    parts.push(g);
    z -= FRONT * 0.085 * f;
    y -= 0.035 + i * 0.012;
  }
  rig.add('hips', joinGeometries(parts), 'armorSecondary', { tier: TIER.PRIMARY });
  // terminal counterweight
  rig.add('hips', latheProfile([
    { r: 0, y: -0.055 }, { r: 0.044, y: -0.035, smooth: true }, { r: 0.052, y: 0, smooth: true },
    { r: 0.040, y: 0.040, smooth: true }, { r: 0, y: 0.052 },
  ], 20), 'trim', { p: [0, y + 0.02, z], tier: TIER.PRIMARY });
  rig.glow('hips', bevelBox(0.028, 0.010, 0.030, 0.003), 'spine', { p: [0, y + 0.06, z] });
  rig.emitter('tailTip', 'hips', [0, y + 0.02, z], [0, -1, 0], 0.05);
}

// ---------------------------------------------------------------------------
// Joint mechanism: actuators + cable looms
// ---------------------------------------------------------------------------

function buildMechanism(rig, spec) {
  const t = spec.torso;
  const L = spec.legs;
  const a = spec.arms;
  const back = -FRONT; // +1 toward the robot's back in local Z terms
  const k = spec.bulk; // a brute's hydraulics are visibly fatter than a scout's

  // waist actuators (twin, either side of the spine)
  for (const { sign } of SIDES) {
    rig.actuator('hips', [sign * t.waistW * 0.42, 0.06, back * t.waistD * 0.42],
      'spine02', [sign * t.waistW * 0.44, 0.10, back * t.waistD * 0.46], { radius: 0.022 * k });
  }
  // neck actuator
  rig.actuator('chest', [0, 0.14, back * 0.075], 'head', [0, 0.02, back * 0.075], { radius: 0.014 * k, rodRatio: 0.55 });

  for (const { s, sign } of SIDES) {
    // shoulder
    rig.actuator('chest', [sign * t.chestW * 0.34, 0.15, back * t.chestD * 0.32],
      `shoulder_${s}`, [0, -0.085, back * a.upper * 0.85], { radius: 0.020 * k });
    // elbow
    rig.actuator(`shoulder_${s}`, [0, -0.20, back * a.upper * 0.95],
      `elbow_${s}`, [0, -0.085, back * a.fore * 0.95], { radius: 0.018 * k });
    // wrist
    rig.actuator(`elbow_${s}`, [sign * a.fore * 0.55, -0.17, back * a.fore * 0.60],
      `wrist_${s}`, [sign * a.fore * 0.42, 0.0, back * a.fore * 0.55], { radius: 0.012 * k, rodRatio: 0.5 });
    // hip
    rig.actuator('hips', [sign * t.pelvisW * 0.44, 0.02, back * t.waistD * 0.30],
      `hip_${s}`, [sign * L.thigh * 0.70, -0.14, back * L.thigh * 0.55], { radius: 0.022 * k });
    // knee
    rig.actuator(`hip_${s}`, [0, -0.24, back * L.thigh * 1.05],
      `knee_${s}`, [0, -0.13, back * L.shin * 1.05], { radius: 0.022 * k });
    // ankle
    rig.actuator(`knee_${s}`, [0, -0.28, back * L.shin * 0.95],
      `foot_${s}`, [0, 0.02, back * L.foot * 0.36], { radius: 0.016 * k, rodRatio: 0.5 });
  }

  // --- cable looms -------------------------------------------------------
  rig.cable('hips', [0, 0.10, back * t.waistD * 0.62], 'chest', [0, 0.02, back * t.chestD * 0.52],
    { sag: 0.05, radius: 0.011 * k, strands: 3, twists: 2.0 });

  for (const { s, sign } of SIDES) {
    rig.cable('chest', [sign * t.chestW * 0.30, 0.13, back * t.chestD * 0.30],
      `shoulder_${s}`, [0, -0.11, back * a.upper * 0.7], { sag: 0.045, radius: 0.010 * k });
    rig.cable(`shoulder_${s}`, [sign * a.upper * 0.5, -0.22, back * a.upper * 0.7],
      `elbow_${s}`, [sign * a.fore * 0.5, -0.06, back * a.fore * 0.7], { sag: 0.035, radius: 0.009 * k });
    rig.cable('hips', [sign * t.pelvisW * 0.34, -0.02, back * t.waistD * 0.55],
      `hip_${s}`, [sign * L.thigh * 0.5, -0.18, back * L.thigh * 0.85], { sag: 0.04, radius: 0.010 * k });
    rig.cable(`hip_${s}`, [sign * L.thigh * 0.55, -0.30, back * L.thigh * 0.9],
      `knee_${s}`, [sign * L.shin * 0.55, -0.10, back * L.shin * 0.9], { sag: 0.035, radius: 0.009 * k });
    rig.cable(`knee_${s}`, [sign * L.shin * 0.45, -0.33, back * L.shin * 0.75],
      `foot_${s}`, [sign * L.footW * 0.40, 0.03, back * L.foot * 0.25], { sag: 0.025, radius: 0.008 * k, strands: 2 });
    // neck loom
    rig.cable('chest', [sign * 0.045, 0.16, back * 0.06], 'head', [sign * 0.04, 0.01, back * 0.07],
      { sag: 0.018, radius: 0.007 * k, strands: 2, twists: 1.2 });
  }

  // soft boot shroud: a lathed sleeve spanning ankle to foot, smooth-skinned so
  // it creases instead of shearing when the foot rolls
  for (const { s } of SIDES) {
    const g = latheProfile([
      { r: L.shin * 0.60, y: 0.0 }, { r: L.shin * 0.66, y: -0.022, smooth: true },
      { r: L.shin * 0.72, y: -0.050, smooth: true }, { r: L.shin * 0.68, y: -0.075 },
    ], 20);
    const m = rig.restWorld[`ankle_${s}`];
    if (!m) continue;
    g.applyMatrix4(m);
    const count = g.getAttribute('position').count;
    const pos = g.getAttribute('position');
    const w = new Float32Array(count);
    const ankleY = rig.restPos[`ankle_${s}`].y;
    for (let i = 0; i < count; i++) {
      const dy = (ankleY - pos.getY(i)) / 0.09;
      w[i] = smootherstep(0.1, 1.0, dy);
    }
    rig.soft(g, `ankle_${s}`, `foot_${s}`, w, 'rubber', TIER.SECONDARY);
  }
}

// ---------------------------------------------------------------------------
// buildRobot
// ---------------------------------------------------------------------------

const DEFAULT_PALETTE = {
  primary: '#7f878f',
  secondary: '#31373d',
  accent: '#e4762a',
  emissive: '#4fd8ff',
  trim: '#c9d0d8',
};

/**
 * Assemble a complete procedural hard-surface robot for a character definition.
 *
 * @param {Object} def CharacterDef from roster.js. Only `chassis`, `palette`,
 *   `proportions`, `id` and `name` are read, and every one of them is optional.
 * @param {{skeleton: THREE.Skeleton, bones: THREE.Bone[], byName: Object}} skeletonBundle
 *   The live skeleton from `createSkeleton()`. Its `boneInverses` are rewritten
 *   here to the canonical rest pose, which is what the geometry is baked against.
 * @param {Object} [environment] Environment instance; used for the renderer
 *   handle the material library needs and for `envMapIntensity`.
 * @param {Object} [opts]
 * @param {'low'|'medium'|'high'|'ultra'} [opts.detail] detail tier; defaults to
 *   `environment.quality` when present, else 'high'.
 * @param {boolean} [opts.lod=true] build a decimated far-distance level.
 * @returns {{group: THREE.Group, skinnedMeshes: THREE.SkinnedMesh[], parts: Object, dispose: () => void}}
 */
export function buildRobot(def, skeletonBundle, environment = null, opts = {}) {
  const bundle = skeletonBundle || {};
  const skeleton = bundle.skeleton;
  const bones = bundle.bones || (skeleton ? skeleton.bones : []);
  if (!skeleton || bones.length === 0) {
    throw new Error('buildRobot: a skeleton bundle from createSkeleton() is required');
  }

  const palette = { ...DEFAULT_PALETTE, ...(def?.palette || {}) };
  const spec = CHASSIS[def?.chassis] || CHASSIS.heavy;
  const quality = opts.detail ?? environment?.quality ?? 'high';
  const maxTier = DETAIL_TIER[quality] ?? TIER.GREEBLE;
  const wantLod = opts.lod !== false && maxTier > TIER.PRIMARY;

  // ---- bind pose --------------------------------------------------------
  const restWorld = restWorldMatrices(bones);
  skeleton.boneInverses.length = 0;
  for (const b of bones) {
    const rw = restWorld[b.name];
    skeleton.boneInverses.push(rw ? new THREE.Matrix4().copy(rw).invert() : new THREE.Matrix4());
  }

  // ---- materials --------------------------------------------------------
  const { mats, emissiveConfig } = resolveMaterials(environment, palette, def);

  // ---- assemble ---------------------------------------------------------
  const rig = new Rig(bones, restWorld, mats, maxTier);

  buildPelvis(rig, spec);
  buildTorso(rig, spec, def);
  buildHead(rig, spec, def);

  for (const { s, sign, mirror } of SIDES) {
    // The brute is deliberately asymmetric: one siege gauntlet, one lean arm.
    const armOpts = def?.chassis === 'brute'
      ? (s === 'R' ? { gauntlet: 1.55, scale: 1.22 } : { gauntlet: 0.35, scale: 0.92 })
      : {};
    buildArm(rig, spec, s, sign, mirror, armOpts);
    buildLeg(rig, spec, s, sign, mirror);
  }

  switch (def?.chassis) {
    case 'agile':
      for (const { s, sign, mirror } of SIDES) addForearmBlade(rig, spec, s, sign, mirror);
      break;
    case 'precision':
      addShoulderCannon(rig, spec, 'R', -1, true);
      break;
    case 'arcane':
      for (const { s, sign, mirror } of SIDES) addShoulderRing(rig, spec, s, sign, mirror);
      break;
    default:
      break;
  }
  if (spec.tail) addTail(rig, spec);

  buildMechanism(rig, spec);

  // ---- merge into SkinnedMeshes ----------------------------------------
  const group = new THREE.Group();
  group.name = `robot:${def?.id ?? 'unknown'}`;

  const rootBone = bundle.byName?.root ?? bones[0];
  if (rootBone && !rootBone.parent) group.add(rootBone);

  const skinnedMeshes = [];
  const emissiveMeshes = [];

  const makeLevel = (tierCap, suffix) => {
    const container = new THREE.Group();
    container.name = `robot:${suffix}`;
    const byMat = new Map();
    for (const part of rig.parts) {
      if (part.tier > tierCap) continue;
      let list = byMat.get(part.mat);
      if (!list) byMat.set(part.mat, (list = []));
      list.push(part.geo);
    }
    let tris = 0;
    for (const [matName, list] of byMat) {
      const mat = mats[matName];
      if (!mat) continue;
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      if (merged.boundingSphere) merged.boundingSphere.radius *= 1.9;
      merged.computeBoundingBox();
      const mesh = new THREE.SkinnedMesh(merged, mat);
      mesh.name = `${suffix}:${matName}`;
      mesh.castShadow = matName !== 'decal';
      mesh.receiveShadow = !matName.startsWith('glow_') && matName !== 'decal';
      mesh.bind(skeleton, new THREE.Matrix4());
      if (matName.startsWith('glow_')) {
        mesh.layers.enable(LAYER.BLOOM_ONLY);
        emissiveMeshes.push({ name: matName.slice(5), mesh, material: mat });
      }
      container.add(mesh);
      skinnedMeshes.push(mesh);
      tris += merged.getAttribute('position').count / 3;
    }
    container.userData.triangles = tris;
    return container;
  };

  const high = makeLevel(maxTier, 'lod0');
  let lod = null;
  if (wantLod) {
    const low = makeLevel(TIER.PRIMARY, 'lod1');
    lod = new THREE.LOD();
    lod.name = 'robotLOD';
    lod.addLevel(high, 0);
    lod.addLevel(low, 13);
    group.add(lod);
  } else {
    group.add(high);
  }

  // ---- actuators --------------------------------------------------------
  const actSegments = maxTier >= 2 ? 16 : 10;
  const actGeo = { housing: actuatorHousingGeo(actSegments), rod: actuatorRodGeo(actSegments) };
  const actuatorRig = new ActuatorRig(rig.actuators, actGeo, mats, maxTier);
  group.add(actuatorRig);
  group.updateMatrixWorld(true);

  // ---- emissive handles -------------------------------------------------
  const emissiveByName = Object.create(null);
  const emissives = [];
  for (const e of emissiveMeshes) {
    if (emissiveByName[e.name]) continue;
    const cfg = emissiveConfig[e.name] || { color: new THREE.Color(palette.emissive), intensity: 3 };
    const entry = {
      name: e.name,
      mesh: e.mesh,
      material: e.material,
      color: cfg.color.clone(),
      baseIntensity: cfg.intensity,
    };
    emissiveByName[e.name] = entry;
    emissives.push(entry);
  }

  const triangles = high.userData.triangles
    + rig.actuators.length * ((actGeo.housing.getAttribute('position').count + actGeo.rod.getAttribute('position').count) / 3);

  /**
   * Optional per-frame hook. Actuators self-drive, so this only exists so the
   * Fighter can pulse the emissive groups from health / meter / hit state.
   * @param {number} dt seconds
   * @param {{health?:number, meter?:number, pulse?:number, flash?:number}} [state]
   */
  const update = (dt, state = {}) => {
    const health = state.health ?? 1;
    const meter = state.meter ?? 0;
    const pulse = state.pulse ?? 0;
    for (const e of emissives) {
      let k = 1;
      if (e.name === 'core') k = 0.55 + 0.75 * health + meter * 0.5;
      else if (e.name === 'visor') k = 0.7 + 0.5 * health;
      else if (e.name === 'vents') k = 0.6 + 0.9 * (1 - health);
      else if (e.name === 'spine') k = 0.7 + 0.6 * meter;
      e.material.emissiveIntensity = e.baseIntensity * (k + pulse);
    }
  };

  const parts = {
    skeleton,
    bones,
    byName: bundle.byName ?? Object.fromEntries(bones.map((b) => [b.name, b])),
    restWorld,
    restPos: rig.restPos,
    materials: mats,
    palette,
    chassis: def?.chassis ?? 'heavy',
    detail: quality,
    triangles,
    lod,
    emissives,
    emissiveByName,
    actuators: rig.actuators,
    actuatorRig,
    emitters: rig.emitters,
    update,
  };

  const dispose = () => {
    for (const m of skinnedMeshes) {
      m.geometry.dispose();
      m.removeFromParent();
    }
    for (const p of rig.parts) p.geo.dispose();
    rig.parts.length = 0;
    actGeo.housing.dispose();
    actGeo.rod.dispose();
    actuatorRig.removeFromParent();
    for (const m of Object.values(mats)) {
      if (m && m.isMaterial) m.dispose();
    }
    group.removeFromParent();
  };

  return { group, lod, skinnedMeshes, parts, materials: mats, update, dispose };
}

export default buildRobot;
