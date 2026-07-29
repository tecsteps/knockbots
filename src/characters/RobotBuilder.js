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
import { Rng } from '../core/Rng.js';
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
    // At a lathe pole one edge collapses, so the obvious triangle has a zero
    // normal and would silently skip the winding test — leaving every cone cap
    // inside-out. Test whichever corner triangle is actually non-degenerate.
    const g = firstValidNormal(a, b, c, d);
    if (dot(g, ref) < 0) {
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

/** Geometric normal of the first non-degenerate corner triangle of a quad. */
function firstValidNormal(a, b, c, d) {
  const corners = [[a, b, c], [b, c, d], [c, d, a], [d, a, b]];
  for (const [p, q, r] of corners) {
    const n = faceNormal(p, q, r);
    if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] > 1e-18) return n;
  }
  return [0, 0, 0];
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

/**
 * Rounded-rectangle cross-section with an exact outward normal per sample.
 *
 * Sampling by quadrant rather than by uniform angle is the whole point: every
 * sample on a straight run carries the same normal, so the swept surface shades
 * as one plane, while each sample on a corner arc carries its own, so the corner
 * shades smoothly. Planar faces meeting radiused corners is the difference
 * between a machined part and a box, and no amount of chamfering a cuboid gets
 * there.
 *
 * @param {number} hw half-width (X)
 * @param {number} hd half-depth (Z)
 * @param {number} radius corner radius in metres
 * @param {number} perQuad arc samples per quadrant
 * @returns {Array<{x:number,z:number,nx:number,nz:number}>} counter-clockwise
 */
function roundedRectRing(hw, hd, radius, perQuad) {
  const rr = Math.max(1e-4, Math.min(radius, hw * 0.98, hd * 0.98));
  const ring = [];
  for (let q = 0; q < 4; q++) {
    const sx = (q === 0 || q === 3) ? 1 : -1;
    const sz = (q === 0 || q === 1) ? 1 : -1;
    const cx = sx * (hw - rr), cz = sz * (hd - rr);
    for (let i = 0; i <= perQuad; i++) {
      const a = (q + i / perQuad) * Math.PI * 0.5;
      const ca = Math.cos(a), sa = Math.sin(a);
      ring.push({ x: cx + ca * rr, z: cz + sa * rr, nx: ca, nz: sa });
    }
  }
  return ring;
}

/**
 * Hull lofted through a stack of rounded-rectangle stations.
 *
 * This is the primary mass primitive and it exists because `bevelBox` cannot
 * make a *volume*: stacking cuboids gives stacked cuboids however carefully they
 * are tapered, and the critic reads that instantly. A loft can taper, shift,
 * roll and swell between stations, so one call produces a torso that narrows at
 * the waist and flares at the ribs, a thigh that is oval at the hip and
 * rectangular at the knee, or a pauldron that sweeps.
 *
 * Normals are analytic rather than averaged: the 2D ring normal is known
 * exactly, the segment rise is measured, and the two are crossed. Corners
 * between stations stay crisp unless the station is flagged `smooth`.
 *
 * @param {Array<{y:number, w:number, d:number, x?:number, z?:number,
 *   round?:number, roll?:number, smooth?:boolean}>} stations bottom-to-top;
 *   `round` is the corner radius as a fraction of the smaller half-extent
 * @param {{perQuad?:number, capBottom?:boolean, capTop?:boolean, uv?:number}} [opts]
 * @returns {THREE.BufferGeometry}
 */
export function loftHull(stations, opts = {}) {
  const { perQuad = 3, capBottom = true, capTop = true, uv = 1.4 } = opts;
  const s = new Surf();
  const n = stations.length;
  if (n < 2) return s.geometry();

  const rings = stations.map((st) => {
    const hw = Math.max(1e-4, st.w * 0.5), hd = Math.max(1e-4, st.d * 0.5);
    const rr = (st.round ?? 0.30) * Math.min(hw, hd);
    const roll = st.roll ?? 0;
    const c = Math.cos(roll), si = Math.sin(roll);
    const ox = st.x ?? 0, oz = st.z ?? 0;
    return roundedRectRing(hw, hd, rr, perQuad).map((p) => ({
      p: [p.x * c - p.z * si + ox, st.y, p.x * si + p.z * c + oz],
      n: [p.nx * c - p.nz * si, p.nx * si + p.nz * c],
    }));
  });

  const m = rings[0].length;

  // one 3D normal per (segment, ring sample): the exact 2D normal crossed with
  // the segment's own rise, which is what carries the taper into the shading
  const segN = [];
  for (let j = 0; j < n - 1; j++) {
    const row = [];
    for (let i = 0; i < m; i++) {
      const a = rings[j][i], b = rings[j + 1][i];
      const up = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
      const around = [-a.n[1], 0, a.n[0]];
      let nx = up[1] * around[2] - up[2] * around[1];
      let ny = up[2] * around[0] - up[0] * around[2];
      let nz = up[0] * around[1] - up[1] * around[0];
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) { nx = a.n[0]; ny = 0; nz = a.n[1]; } else { nx /= l; ny /= l; nz /= l; }
      if (nx * a.n[0] + nz * a.n[1] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      row.push([nx, ny, nz]);
    }
    segN.push(row);
  }

  /** Normals for one end of one segment, averaged across the seam if smooth. */
  const nAt = (j, end) => {
    const other = end === 0 ? segN[j - 1] : segN[j + 1];
    if (!stations[j + end].smooth || !other) return segN[j];
    return segN[j].map((c, i) => {
      const o = other[i];
      const x = c[0] + o[0], y = c[1] + o[1], z = c[2] + o[2];
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    });
  };

  // U runs around the perimeter, V up the loft, both in metres — so one texture
  // scale covers a shin and a chest without per-part tuning
  const uAt = rings.map((ring) => {
    const acc = [0];
    for (let i = 1; i <= m; i++) {
      const a = ring[i - 1].p, b = ring[i % m].p;
      acc.push(acc[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    return acc;
  });
  const vAt = [0];
  for (let j = 1; j < n; j++) vAt.push(vAt[j - 1] + Math.abs(stations[j].y - stations[j - 1].y));

  for (let j = 0; j < n - 1; j++) {
    const N0 = nAt(j, 0), N1 = nAt(j, 1);
    const v0 = vAt[j] * uv, v1 = vAt[j + 1] * uv;
    for (let i = 0; i < m; i++) {
      const i2 = (i + 1) % m;
      s.quad(
        rings[j][i].p, rings[j][i2].p, rings[j + 1][i2].p, rings[j + 1][i].p,
        N0[i], N0[i2], N1[i2], N1[i],
        [uAt[j][i] * uv, v0], [uAt[j][i + 1] * uv, v0],
        [uAt[j + 1][i + 1] * uv, v1], [uAt[j + 1][i] * uv, v1],
      );
    }
  }
  if (capBottom) s.flatPoly(rings[0].map((r) => r.p), [0, -1, 0], uv);
  if (capTop) s.flatPoly(rings[n - 1].map((r) => r.p), [0, 1, 0], uv);
  return s.geometry();
}

/** Inward normal offset of a lathe profile, used to give a swept plate thickness. */
function offsetProfile(profile, t) {
  const segN = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const dr = profile[i + 1].r - profile[i].r, dy = profile[i + 1].y - profile[i].y;
    const l = Math.hypot(dr, dy) || 1;
    segN.push([dy / l, -dr / l]);
  }
  return profile.map((p, i) => {
    const a = segN[i - 1], b = segN[i];
    let nx = (a ? a[0] : 0) + (b ? b[0] : 0);
    let ny = (a ? a[1] : 0) + (b ? b[1] : 0);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    return { r: Math.max(5e-4, p.r - nx * t), y: p.y - ny * t, smooth: p.smooth };
  });
}

/**
 * Curved armour shell — a lathe profile given real thickness and swept over a
 * partial arc, so the plate has an outer face, an inner face and a rim you can
 * see the frame through.
 *
 * A pauldron built from boxes is the single most obvious tell of a procedural
 * robot. A pauldron built from two of these, offset and overlapping, reads as
 * layered plate armour on a machine, which is what the reference does.
 *
 * @param {Array<{r:number,y:number,smooth?:boolean}>} profile outer surface
 * @param {number} thickness plate thickness in metres
 * @param {number} [segments=20] angular subdivisions across the arc
 * @param {{arc?:number, phase?:number, uvV?:number, caps?:boolean}} [opts]
 * @returns {THREE.BufferGeometry}
 */
export function shellLathe(profile, thickness, segments = 20, opts = {}) {
  const { arc = Math.PI, phase = 0, uvV = 1.4, caps = true } = opts;
  if (profile.length < 2) return new Surf().geometry();
  const inner = offsetProfile(profile, thickness);
  // Closing the profile loop lets one lathe call emit the outer face, both rims
  // and the inner face with correct analytic normals throughout.
  const closed = profile.concat(inner.slice().reverse());
  closed.push({ r: profile[0].r, y: profile[0].y });
  const shell = latheProfile(closed, segments, { arc, phase, uvV });
  if (!caps || arc >= Math.PI * 2 - 1e-4) return shell;

  const s = new Surf();
  const k = profile.length;
  for (const [ang, dir] of [[phase, -1], [phase + arc, 1]]) {
    const c = Math.cos(ang), si = Math.sin(ang);
    const nrm = [-si * dir, 0, c * dir];
    const P = (q) => [q.r * c, q.y, q.r * si];
    for (let i = 0; i < k - 1; i++) {
      s.quad(P(profile[i]), P(profile[i + 1]), P(inner[i + 1]), P(inner[i]),
        nrm, nrm, nrm, nrm, [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
  return joinGeometries([shell, s.geometry()]);
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
  // cached by value, not identity: two Fighters on the same character share one atlas
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

/**
 * Rest-pose measurements taken off the skeleton that was actually built.
 *
 * roster.js multiplies whole groups of bone offsets per character (`arms: 1.15`,
 * `legs: 1.12`, ...). Any segment length written here as a literal metre value
 * would therefore drift away from the bone it is supposed to clothe, and an
 * armour plate authored 4cm short of its joint is exactly how a robot comes
 * apart into floating panels. So every length below is read back from the live
 * bones instead.
 *
 * The `*K` values convert a *length* multiplier into the matching
 * *cross-section* multiplier at roughly half strength: a leg 12% longer gets 7%
 * thicker, which keeps a long-limbed scout lanky rather than merely enlarged.
 *
 * @param {Rig} rig
 */
function measure(rig) {
  const seg = (n) => (rig.byName[n] ? rig.byName[n].position.length() : 0);
  const canon = (n) => {
    const d = BONE_DEF[n];
    return d ? Math.hypot(d.pos[0], d.pos[1], d.pos[2]) : 0;
  };
  const ratio = (n) => {
    const c = canon(n);
    return c > 1e-6 ? seg(n) / c : 1;
  };
  const K = (s) => 1 + (s - 1) * 0.55;

  const armS = ratio('elbow_L');
  const legS = ratio('knee_L');
  const torsoS = ratio('spine02');
  const headS = ratio('headTop');
  const hip = rig.byName.hip_L;

  return {
    // limb segment lengths, bone origin to bone origin
    upper: seg('elbow_L') || 0.29,
    fore: seg('wrist_L') || 0.27,
    palm: seg('hand_L') || 0.12,
    grip: seg('fingers_L') || 0.10,
    thigh: seg('knee_L') || 0.44,
    shin: seg('ankle_L') || 0.42,
    ankle: seg('foot_L') || 0.085,
    toe: seg('toe_L') || 0.147,
    // spine column
    lumbar: seg('spine01') || 0.14,
    mid: seg('spine02') || 0.15,
    thorax: seg('chest') || 0.16,
    collar: seg('neck') || 0.19,
    nape: seg('head') || 0.10,
    skull: seg('headTop') || 0.19,
    // lateral room between the two leg chains, which is what stops a heavy's
    // thigh armour from swallowing the gap and reading as one column
    hipSep: hip ? Math.abs(hip.position.x) * 2 : 0.21 * legS,
    armS, legS, torsoS, headS,
    armK: K(armS), legK: K(legS), torsoK: K(torsoS), headK: headS,
  };
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
  constructor(actuators, geo, mats) {
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

      // A cylinder can never be longer than the span it bridges: under extreme
      // compression squash the housing rather than let it burst out of the joint.
      this._s.set(a.radius, Math.min(a.housingLength, len * 0.92), a.radius);
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
    /** Uniform author-space scale applied by `scaled()`. */
    this.autoScale = 1;
    /** Unscaled bone-local Y shift applied by `lifted()`. */
    this.autoLift = 0;
    /** Monotonic plate counter; seeds the per-plate vertex attributes. */
    this.plateCount = 0;
    /** Rest-pose metrics of this particular skeleton; see `measure()`. */
    this.dim = measure(this);
    /** @type {Array<{geo:THREE.BufferGeometry, mat:string, tier:number}>} */
    this.parts = [];
    this.actuators = [];
    this.emitters = [];
    this._tmp = new THREE.Matrix4();
  }

  /**
   * Run `fn` with every placement uniformly scaled by `k`, position included.
   * Used for the head, which is authored at reference size and has to follow
   * the roster's `head` multiplier exactly as its bone does.
   * @param {number} k
   * @param {() => void} fn
   */
  scaled(k, fn) {
    const prev = this.autoScale;
    this.autoScale = prev * k;
    try { fn(); } finally { this.autoScale = prev; }
  }

  /**
   * Run `fn` with every placement raised by `dy` in the bone's local Y, without
   * scaling it. The head uses this: the skull has to clear the shoulder line
   * whatever the roster's `arms` and `torso` multipliers did to the pauldrons,
   * and that offset is a clearance in metres, not a proportion.
   * @param {number} dy
   * @param {() => void} fn
   */
  lifted(dy, fn) {
    const prev = this.autoLift;
    this.autoLift = prev + dy;
    try { fn(); } finally { this.autoLift = prev; }
  }

  /** Local frame matrix for a part attached to `bone`. */
  frame(bone, o) {
    const rw = this.restWorld[bone];
    if (!rw) return null;
    const k = this.autoScale;
    const lift = this.autoLift;
    const p = o.p
      ? new THREE.Vector3(o.p[0] * k, o.p[1] * k + lift, o.p[2] * k)
      : new THREE.Vector3(0, lift, 0);
    const q = new THREE.Quaternion();
    if (o.r) q.setFromEuler(new THREE.Euler(o.r[0], o.r[1], o.r[2], o.order || 'XYZ'));
    const sv = o.s === undefined ? new THREE.Vector3(k, k, k)
      : typeof o.s === 'number' ? new THREE.Vector3(o.s * k, o.s * k, o.s * k)
        : new THREE.Vector3(o.s[0] * k, o.s[1] * k, o.s[2] * k);
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
    tagPlate(g, this.plateCount++, o.wear ?? WEAR_BY_MAT[mat] ?? 0.6, tier);
    this.parts.push({ geo: g, mat, tier });
    return this;
  }

  /**
   * Armour section spanning `[y0, y1]` on the bone axis, with an explicit
   * width and depth at each end.
   *
   * Authoring a section by its two ENDS rather than by a centre and a size is
   * the whole trick behind a continuous machine: neighbouring sections are
   * given the same cross-section where they meet and told to overlap slightly,
   * so no gap can open at a joint however roster.js scales the bone.
   *
   * @param {string} bone
   * @param {{y0:number, y1:number, w0:number, w1:number, d0?:number, d1?:number,
   *   mat:string, x?:number, z?:number, r?:number[], mirror?:boolean,
   *   bevel?:number, shearX?:number, shearZ?:number, tier?:number}} o
   */
  section(bone, o) {
    const h = Math.abs(o.y1 - o.y0);
    if (h < 1e-5) return this;
    // Stations are authored about the section's own centre so that `r` still
    // rolls the section in place, exactly as the box version did.
    const cy = (o.y0 + o.y1) * 0.5;
    const geo = loftHull(this.stations(o, cy), { perQuad: o.perQuad ?? 3, uv: 1.4 });
    return this.add(bone, geo, o.mat, {
      p: [o.x ?? 0, cy, o.z ?? 0],
      r: o.r, mirror: o.mirror, tier: o.tier ?? TIER.PRIMARY, wear: o.wear,
    });
  }

  /**
   * Station list for a `section`-shaped description.
   *
   * A section is authored by its two ends; the middle station is what turns it
   * from a truncated pyramid into a *volume*. `swell` pushes the waist of the
   * loft out (or in) so a thigh bulges at the quadriceps and a waist pinches,
   * which is the read a stack of tapered boxes can never produce.
   */
  stations(o, cy = 0) {
    const e0 = o.d0 ?? o.w0, e1 = o.d1 ?? o.w1;
    const sx = o.shearX ?? 0, sz = o.shearZ ?? 0;
    const round = o.round ?? 0.34;
    const at = (t, extra = 1) => ({
      y: o.y0 + (o.y1 - o.y0) * t - cy,
      w: (o.w0 + (o.w1 - o.w0) * t) * extra,
      d: (e0 + (e1 - e0) * t) * extra,
      x: sx * (t * 2 - 1),
      z: sz * (t * 2 - 1),
      round,
      smooth: true,
    });
    const swell = o.swell ?? 0;
    if (Math.abs(swell) < 1e-4) return [at(0), at(0.5), at(1)];
    return [at(0), at(o.swellAt ?? 0.42, 1 + swell), at(1)];
  }

  /**
   * Armour band over a visible frame.
   *
   * The single change that stops a robot reading as its own chassis: the dark
   * structural hull runs the full length of the bone, and the painted plate
   * covers only the middle of it, so a shadowed groove of machine shows at both
   * ends. Panel gaps that hold shadow are what the reference has and a
   * continuous painted column does not.
   *
   * @param {string} bone
   * @param {Object} o same shape as `section`, plus:
   *   `gap` metres of frame left exposed at each end, `inset` frame
   *   cross-section as a fraction of the armour's.
   */
  plated(bone, o) {
    const gap = o.gap ?? 0.016;
    const inset = o.inset ?? 0.86;
    const dir = Math.sign(o.y1 - o.y0) || 1;
    const over = gap * 0.7 * dir;
    this.section(bone, {
      ...o,
      y0: o.y0 - over, y1: o.y1 + over,
      w0: o.w0 * inset, w1: o.w1 * inset,
      d0: (o.d0 ?? o.w0) * inset, d1: (o.d1 ?? o.w1) * inset,
      mat: 'darkMetal', round: 0.5, perQuad: 2, swell: 0,
      tier: TIER.PRIMARY,
    });
    const t0 = gap * dir / (o.y1 - o.y0);
    const lerp = (a, b, t) => a + (b - a) * t;
    return this.section(bone, {
      ...o,
      y0: lerp(o.y0, o.y1, t0), y1: lerp(o.y1, o.y0, t0),
      w0: lerp(o.w0, o.w1, t0), w1: lerp(o.w1, o.w0, t0),
      d0: lerp(o.d0 ?? o.w0, o.d1 ?? o.w1, t0), d1: lerp(o.d1 ?? o.w1, o.d0 ?? o.w0, t0),
    });
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
    tagPlate(g, this.plateCount++, WEAR_BY_MAT[mat] ?? 0.6, tier);
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
      housingLength: restLength * (o.housing ?? 0.48),
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

/**
 * How exposed a plate is to the world, by material role. Drives the wear channel
 * of the per-plate seed: a leading-edge armour plate collects scuffs, a bracket
 * buried under three layers of it does not, and shading them identically is what
 * makes procedural hard-surface read as one extruded lump.
 */
const WEAR_BY_MAT = {
  armorPrimary: 0.86, armorSecondary: 0.68, armorAccent: 1.0, trim: 0.92,
  darkMetal: 0.30, piston: 0.55, rubber: 0.62, carbon: 0.44, glass: 0.15, decal: 0.5,
};

/** Two decorrelated 0..1 hashes from one 32-bit plate index. */
function plateHash(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  const a = (Math.imul(h, 0xc2b2ae35) >>> 0) / 4294967295;
  let g = Math.imul(i + 0x7feb352d, 0x27d4eb2f) >>> 0;
  g ^= g >>> 15;
  const b = (Math.imul(g, 0x165667b1) >>> 0) / 4294967295;
  return [a, b];
}

/**
 * Stamp a plate's identity onto every one of its vertices.
 *
 * Two attributes, because two consumers are plausible and neither should have to
 * guess. `plateSeed` is the rich signal a shader injection wants; `color` is the
 * same seed pre-baked into a near-unity albedo multiplier so that a material
 * which merely flips `vertexColors: true` gets sane per-plate variation instead
 * of a rainbow.
 *
 *   attribute vec4 plateSeed;  // Uint8 normalised, 0..1
 *     .x  per-plate hash A
 *     .y  per-plate hash B, decorrelated from A
 *     .z  exposure / wear likelihood, 0 = buried bracket, 1 = leading edge
 *     .w  detail tier: 0.0 primary silhouette, 0.5 panelling, 1.0 greeble
 *
 *   attribute vec3 color;      // Float32, 0.90 .. 1.10, mean 1.0
 *     per-channel albedo multiplier derived from the same hashes; recover the
 *     seed with `(color - 1.0) / 0.20 + 0.5` if the raw value is wanted.
 */
function tagPlate(geo, index, wear, tier) {
  const n = geo.getAttribute('position').count;
  if (!n) return;
  const [a, b] = plateHash(index);
  const seed = new Uint8Array(n * 4);
  const col = new Float32Array(n * 3);
  const sx = Math.round(a * 255), sy = Math.round(b * 255);
  const sz = Math.round(Math.min(1, Math.max(0, wear)) * 255);
  const sw = Math.round(Math.min(1, tier * 0.5) * 255);
  // Channels are pulled apart so the jitter is a slight hue shift as well as a
  // value shift — real paint batches differ in both.
  const cr = 1 + (a - 0.5) * 0.20;
  const cg = 1 + (a * 0.6 + b * 0.4 - 0.5) * 0.20;
  const cb = 1 + (b - 0.5) * 0.20;
  for (let i = 0; i < n; i++) {
    seed[i * 4] = sx; seed[i * 4 + 1] = sy; seed[i * 4 + 2] = sz; seed[i * 4 + 3] = sw;
    col[i * 3] = cr; col[i * 3 + 1] = cg; col[i * 3 + 2] = cb;
  }
  geo.setAttribute('plateSeed', new THREE.Uint8BufferAttribute(seed, 4, true));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
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
    torso: { chestW: 0.52, chestD: 0.32, chestH: 0.30, waistW: 0.30, waistD: 0.25, pelvisW: 0.40 },
    pauldron: { w: 0.235, h: 0.215, d: 0.26, taper: 0.62, out: 0.055, up: 0.05, tilt: 20, layers: 3 },
    arms: { upper: 0.155, fore: 0.145, gauntlet: 1.0 },
    legs: { plan: 'plantigrade', thigh: 0.19, shin: 0.165, foot: 0.30, footW: 0.19 },
    head: 'slab',
    core: 'hex',
    back: 'radiators',
    skirt: true, tail: false,
  },
  agile: {
    bulk: 0.80,
    torso: { chestW: 0.40, chestD: 0.26, chestH: 0.29, waistW: 0.23, waistD: 0.19, pelvisW: 0.31 },
    pauldron: { w: 0.145, h: 0.17, d: 0.20, taper: 0.5, out: 0.03, up: 0.035, tilt: 32, layers: 2 },
    arms: { upper: 0.108, fore: 0.10, gauntlet: 0.45 },
    legs: { plan: 'digitigrade', thigh: 0.125, shin: 0.105, foot: 0.30, footW: 0.125 },
    head: 'wedge',
    core: 'slit',
    back: 'thrusters',
    skirt: false, tail: false,
  },
  brute: {
    bulk: 1.15,
    torso: { chestW: 0.58, chestD: 0.37, chestH: 0.27, waistW: 0.32, waistD: 0.27, pelvisW: 0.44 },
    pauldron: { w: 0.265, h: 0.245, d: 0.30, taper: 0.78, out: 0.065, up: 0.075, tilt: 12, layers: 3 },
    arms: { upper: 0.185, fore: 0.175, gauntlet: 1.35 },
    legs: { plan: 'splayed', thigh: 0.215, shin: 0.19, foot: 0.32, footW: 0.225 },
    head: 'sunken',
    core: 'cage',
    back: 'stacks',
    skirt: false, tail: false,
  },
  precision: {
    bulk: 0.88,
    torso: { chestW: 0.43, chestD: 0.28, chestH: 0.31, waistW: 0.25, waistD: 0.21, pelvisW: 0.33 },
    pauldron: { w: 0.165, h: 0.19, d: 0.215, taper: 0.55, out: 0.035, up: 0.045, tilt: 26, layers: 2 },
    arms: { upper: 0.118, fore: 0.112, gauntlet: 0.6 },
    legs: { plan: 'plantigrade', thigh: 0.145, shin: 0.125, foot: 0.29, footW: 0.145 },
    head: 'tower',
    core: 'column',
    back: 'sensorWings',
    skirt: false, tail: false,
  },
  arcane: {
    bulk: 0.92,
    torso: { chestW: 0.45, chestD: 0.29, chestH: 0.32, waistW: 0.24, waistD: 0.20, pelvisW: 0.34 },
    pauldron: { w: 0.18, h: 0.205, d: 0.235, taper: 0.45, out: 0.05, up: 0.075, tilt: 34, layers: 2 },
    arms: { upper: 0.125, fore: 0.118, gauntlet: 0.7 },
    legs: { plan: 'digitigrade', thigh: 0.15, shin: 0.128, foot: 0.29, footW: 0.135 },
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

/**
 * Cross-section of the torso column at each bone station.
 *
 * Neighbouring plates read the SAME entry where they meet, so the column tapers
 * continuously from pelvis to collar instead of stepping between four boxes of
 * unrelated width. Every station is a width/depth pair in metres.
 */
function torsoStations(spec) {
  const t = spec.torso;
  return {
    pelvis: { w: t.pelvisW * 0.98, d: t.waistD * 1.12 },
    waistLo: { w: t.waistW * 1.16, d: t.waistD * 1.04 },
    waistHi: { w: t.waistW * 1.34, d: t.waistD * 1.14 },
    ribs: { w: t.chestW * 0.80, d: t.chestD * 0.86 },
    chest: { w: t.chestW, d: t.chestD },
    yoke: { w: t.chestW * 0.84, d: t.chestD * 0.86 },
  };
}

function buildPelvis(rig, spec) {
  const t = spec.torso;
  const m = rig.dim;
  const P = torsoStations(spec);
  const w = t.pelvisW, d = t.waistD * 1.18;
  const hipY = -0.03 * m.legS;          // the hip pivots, in hips-local Y
  const floor = hipY - 0.10;            // girdle skirt line, just under them

  // Lower girdle — wraps the hip ball joints from below so the thigh armour
  // slides under a lip instead of ending in mid-air.
  rig.section('hips', {
    y0: floor, y1: 0.0,
    w0: P.pelvis.w * 0.80, w1: P.pelvis.w,
    d0: P.pelvis.d * 0.84, d1: P.pelvis.d,
    mat: 'armorPrimary',
  });
  // Upper girdle — carries up past the spine01 origin so the lumbar section
  // lands inside it whatever `torso` multiplier the roster chose.
  rig.section('hips', {
    y0: -0.004, y1: m.lumbar * 0.68,
    w0: P.pelvis.w, w1: P.waistLo.w,
    d0: P.pelvis.d, d1: P.waistLo.d,
    mat: 'armorPrimary',
  });

  // crotch guard, angled forward-down
  rig.add('hips', bevelBox(w * 0.36, 0.17, d * 0.5, 0.014, { topX: 1.25 }), 'armorSecondary',
    { p: [0, floor + 0.02, FRONT * d * 0.28], r: [12 * DEG, 0, 0], tier: TIER.PRIMARY });

  // rear counterweight block
  rig.add('hips', bevelBox(w * 0.62, 0.16, d * 0.42, 0.016, { topX: 0.8 }), 'armorSecondary',
    { p: [0, -0.01, -FRONT * d * 0.42], tier: TIER.PRIMARY });

  // hip ball housings
  for (const { s, sign, mirror } of SIDES) {
    const hx = rig.restPos[`hip_${s}`] ? rig.restPos[`hip_${s}`].x : sign * 0.105;
    const r = m.hipSep * 0.32;
    rig.add('hips', latheProfile([
      { r: 0, y: -r * 0.84 }, { r: r * 0.79, y: -r * 0.84 }, { r: r * 0.94, y: -r * 0.49, smooth: true },
      { r, y: 0.0, smooth: true }, { r: r * 0.94, y: r * 0.49, smooth: true },
      { r: r * 0.76, y: r * 0.79 }, { r: 0, y: r * 0.79 },
    ], 20), 'darkMetal', { p: [hx, hipY, 0], r: [0, 0, 90 * DEG], mirror, tier: TIER.PRIMARY });

    rig.add('hips', boltRing(6, r * 0.76, 0.009, 0.011), 'trim',
      { p: [hx + sign * r * 0.79, hipY, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.GREEBLE });

    // belt lamp
    rig.glow('hips', bevelBox(0.03, 0.012, 0.012, 0.004), 'joints',
      { p: [hx * 0.55, m.lumbar * 0.30, FRONT * d * 0.5], mirror });
  }

  // waist power ring: recessed channel with a glow strip inside, seated on the
  // seam where the girdle hands over to the lumbar section
  const ringY = m.lumbar * 0.50;
  rig.add('hips', channelStrip(P.waistLo.w * 0.82, P.waistLo.d * 1.02, 0.018), 'darkMetal',
    { p: [0, ringY, 0], tier: TIER.SECONDARY });
  rig.glow('hips', bevelBox(P.waistLo.w * 0.60, 0.014, P.waistLo.d * 0.70, 0.004), 'spine',
    { p: [0, ringY - 0.007, 0] });

  if (spec.skirt) {
    // segmented skirt plates, each rigid to hips so they read as armour, not cloth
    const drop = 0.24 * m.legS;
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
      rig.add('hips', bevelBox(pl.w, drop, 0.035, 0.010, { botX: 0.74 }), 'armorAccent', {
        p: [pl.x * w * 0.50, floor + drop * 0.34, pl.z * d * 0.60 * -FRONT],
        r: [pl.rot * DEG, ang, 0],
        order: 'YXZ',
        tier: TIER.PRIMARY,
      });
    }
  }

  addPanelDetail(rig, 'hips', {
    p: [0, -0.01, -FRONT * (d * 0.62 + 0.006)], r: [0, YAW_BACK, 0],
    w: w * 0.52, h: 0.13, bolts: 4, splitsY: [0.10], splitsX: [-0.24, 0.24],
  });
  for (const { sign, mirror } of SIDES) {
    addPipeRun(rig, 'hips', [
      [sign * w * 0.12, m.lumbar * 0.40, -FRONT * d * 0.5],
      [sign * w * 0.30, 0.01, -FRONT * d * 0.52],
      [sign * w * 0.42, -0.06, -FRONT * d * 0.34],
    ], { radius: 0.010, mirror });
  }

  rig.decal('hips', DECAL.HAZARD, w * 0.42, 0.05, {
    p: [0, floor + 0.05, FRONT * (d * 0.5 + 0.052)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
}

function buildTorso(rig, spec, def) {
  const t = spec.torso;
  const m = rig.dim;
  const P = torsoStations(spec);

  // --- lower spine: armour banded over a visible frame --------------------
  // Every band is authored end-to-end against the measured bone spacing and
  // overlaps its neighbour, so the column is airtight from the girdle to the
  // collar on any set of proportions — but the *painted* plate stops short at
  // both ends, leaving a shadowed groove of dark machine at each joint. That
  // groove is what stops the torso reading as one extruded prism.
  rig.plated('spine01', {
    y0: -m.lumbar * 0.46, y1: m.mid * 0.66,
    w0: P.waistLo.w * 0.98, w1: P.waistHi.w,
    d0: P.waistLo.d * 0.98, d1: P.waistHi.d,
    mat: 'armorPrimary', gap: 0.020, inset: 0.82, round: 0.30, swell: -0.06,
  });
  // articulated ribs, proud of the frame in the gap the armour leaves
  for (let i = 0; i < 3; i++) {
    const y = -m.lumbar * 0.40 + i * (m.lumbar * 0.40 + m.mid * 0.60) * 0.5;
    rig.add('spine01', latheProfile([
      { r: P.waistLo.w * 0.42, y: -0.010 }, { r: P.waistLo.w * 0.46, y: -0.004, smooth: true },
      { r: P.waistLo.w * 0.46, y: 0.004, smooth: true }, { r: P.waistLo.w * 0.42, y: 0.010 },
    ], 18), 'trim', { p: [0, y, 0], s: [1, 1, P.waistLo.d / P.waistLo.w * 1.10], tier: TIER.SECONDARY });
  }

  // abdominal segment plates, floating off the frame on a visible standoff
  for (let i = 0; i < 3; i++) {
    rig.add('spine01', loftHull([
      { y: -0.019, w: P.waistLo.w * (0.60 + i * 0.05), d: 0.026, round: 0.34 },
      { y: 0.019, w: P.waistLo.w * (0.64 + i * 0.05), d: 0.030, round: 0.30 },
    ]), 'armorPrimary', {
      p: [0, -m.lumbar * 0.30 + i * m.mid * 0.30, FRONT * (P.waistLo.d * 0.5 + 0.010)],
      r: [(6 - i * 5) * DEG, 0, 0], tier: TIER.SECONDARY,
    });
  }

  // --- mid spine ----------------------------------------------------------
  rig.plated('spine02', {
    y0: -m.mid * 0.46, y1: m.thorax * 0.70,
    w0: P.waistHi.w * 0.98, w1: P.ribs.w,
    d0: P.waistHi.d * 0.98, d1: P.ribs.d,
    mat: 'armorPrimary', gap: 0.018, inset: 0.84, round: 0.28, swell: 0.03,
  });

  // dorsal spine strip — the reactor line running up the back
  rig.add('spine02', channelStrip(0.05, m.thorax * 0.9, 0.016), 'darkMetal',
    { p: [0, m.thorax * 0.18, -FRONT * (P.waistHi.d * 0.54)], r: FACE_BACK, tier: TIER.SECONDARY });
  for (let i = 0; i < 3; i++) {
    rig.glow('spine02', bevelBox(0.026, 0.03, 0.010, 0.004), 'spine',
      { p: [0, -m.mid * 0.22 + i * m.thorax * 0.30, -FRONT * (P.waistHi.d * 0.54 + 0.004)] });
  }

  rig.decal('spine02', DECAL.SERIAL, 0.11, 0.11, {
    p: [P.waistHi.w * 0.34, m.thorax * 0.24, -FRONT * (P.waistHi.d * 0.56)], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE,
  });

  // --- chest --------------------------------------------------------------
  const cw = t.chestW, cd = t.chestD, ch = t.chestH;

  // vertical centre of the chest mass — every piece of front and back hardware
  // hangs off this rather than a literal, so it follows the `torso` multiplier
  const cy = m.collar * 0.25;

  // Structural frame. It runs the full height of the chest at a reduced
  // cross-section, so every gap the armour leaves shows dark machine rather than
  // sky, and the plates above have something to sit proud of.
  rig.section('chest', {
    y0: -m.thorax * 0.52, y1: m.collar * 0.92,
    w0: P.ribs.w * 0.80, w1: P.yoke.w * 0.82,
    d0: P.ribs.d * 0.84, d1: P.yoke.d * 0.84,
    mat: 'darkMetal', round: 0.5, perQuad: 2, swell: 0.05,
  });

  // Ribcage: one continuous lofted volume rather than two stacked boxes. It
  // flares off the mid-spine handover, swells at the pectoral line and necks
  // back in toward the gorget, and the whole run reads as one machined part.
  rig.add('chest', loftHull([
    { y: -m.thorax * 0.42, w: P.ribs.w * 0.98, d: P.ribs.d * 0.98, round: 0.32 },
    { y: -m.thorax * 0.04, w: P.chest.w * 0.93, d: P.chest.d * 0.95, round: 0.27, smooth: true },
    { y: m.collar * 0.22, w: P.chest.w, d: P.chest.d, round: 0.24, smooth: true },
    { y: m.collar * 0.48, w: P.chest.w * 0.94, d: P.chest.d * 0.92, round: 0.26 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });
  // shoulder deck, lifted clear of the ribcage so the seam holds a shadow
  rig.add('chest', loftHull([
    { y: m.collar * 0.52, w: P.chest.w * 0.90, d: P.chest.d * 0.90, round: 0.28 },
    { y: m.collar * 0.72, w: P.chest.w * 0.88, d: P.chest.d * 0.86, round: 0.28, smooth: true },
    { y: m.collar * 0.90, w: P.yoke.w, d: P.yoke.d, round: 0.34 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });

  // Front planes. Two facets at different rakes with a shadowed split between
  // them: the deck catches the key light square on, the sternum sits in half
  // shade, and the chest finally reads as a form instead of the face of a box.
  rig.add('chest', loftHull([
    { y: -m.thorax * 0.26, w: cw * 0.52, d: 0.034, round: 0.32 },
    { y: 0, w: cw * 0.62, d: 0.044, round: 0.26, smooth: true },
    { y: m.collar * 0.22, w: cw * 0.58, d: 0.040, round: 0.30 },
  ]), 'armorSecondary', {
    p: [0, 0, FRONT * (cd * 0.48)], r: [9 * DEG, 0, 0], tier: TIER.PRIMARY,
  });
  rig.add('chest', loftHull([
    { y: m.collar * 0.28, w: cw * 0.66, d: 0.036, round: 0.28 },
    { y: m.collar * 0.56, w: cw * 0.62, d: 0.030, round: 0.30, smooth: true },
    { y: m.collar * 0.82, w: cw * 0.44, d: 0.024, round: 0.36 },
  ]), 'armorSecondary', {
    p: [0, 0, FRONT * (cd * 0.44)], r: [-19 * DEG, 0, 0], tier: TIER.PRIMARY,
  });
  rig.add('chest', channelStrip(cw * 0.60, 0.020, 0.014), 'darkMetal', {
    p: [0, m.collar * 0.25, FRONT * (cd * 0.50)], r: FACE_FRONT, tier: TIER.SECONDARY,
  });

  // pectoral plates, floated off the ribcage on a standoff so the gap reads
  for (const { sign, mirror } of SIDES) {
    rig.add('chest', loftHull([
      { y: -ch * 0.34, w: cw * 0.30, d: cd * 0.26, round: 0.34 },
      { y: 0, w: cw * 0.38, d: cd * 0.34, round: 0.26, smooth: true },
      { y: ch * 0.34, w: cw * 0.33, d: cd * 0.28, round: 0.32 },
    ]), 'armorPrimary', {
      p: [sign * cw * 0.28, m.collar * 0.20, FRONT * cd * 0.44],
      r: [-6 * DEG, sign * 14 * DEG, sign * -8 * DEG],
      mirror, tier: TIER.PRIMARY,
    });
    // intake louvres on the upper chest flank
    addLouvres(rig, 'chest', {
      p: [sign * cw * 0.40, m.collar * 0.42, FRONT * cd * 0.22],
      r: [0, sign * 118 * DEG, 0],
      w: cd * 0.30, h: 0.062, n: 4, depth: 0.020, mirror, glow: 'vents',
    });
  }

  // gorget / collar ring — bridges the deck to the neck column
  const gr = P.yoke.w * 0.26;
  rig.add('chest', latheProfile([
    { r: gr * 0.86, y: 0.0 }, { r: gr, y: 0.018, smooth: true }, { r: gr, y: m.collar * 0.26 },
    { r: gr * 0.86, y: m.collar * 0.33 }, { r: gr * 0.74, y: m.collar * 0.33 }, { r: gr * 0.74, y: 0.0 },
  ], 20), 'darkMetal', { p: [0, m.collar * 0.62, 0.005], tier: TIER.PRIMARY });

  // clavicle yokes
  for (const { s, sign, mirror } of SIDES) {
    const cp = rig.restPos[`clavicle_${s}`];
    const local = cp ? cp.clone().sub(rig.restPos.chest) : new THREE.Vector3(sign * 0.055, 0.13, 0.01);
    rig.add('chest', bevelBox(0.16 * m.armK, 0.075, 0.13 * m.armK, 0.012, { topX: 0.7, topZ: 0.8 }), 'armorSecondary', {
      p: [local.x + sign * 0.055 * m.armS, local.y - 0.005, local.z],
      r: [0, 0, sign * -14 * DEG], mirror, tier: TIER.PRIMARY,
    });
  }

  // back plate + shoulder-blade panels
  rig.add('chest', bevelBox(cw * 0.94, ch * 0.98, cd * 0.30, 0.016, { topX: 0.96, botX: 0.78 }), 'armorSecondary',
    { p: [0, m.collar * 0.18, -FRONT * cd * 0.42], tier: TIER.PRIMARY });
  for (const { sign, mirror } of SIDES) {
    rig.add('chest', bevelBox(cw * 0.30, ch * 0.60, 0.03, 0.010, { topX: 0.88 }), 'carbon', {
      p: [sign * cw * 0.26, m.collar * 0.30, -FRONT * (cd * 0.42 + cd * 0.16)],
      r: [0, sign * -10 * DEG, 0], mirror, tier: TIER.SECONDARY,
    });
  }

  addPanelDetail(rig, 'chest', {
    p: [0, m.collar * 0.18, -FRONT * (cd * 0.42 + cd * 0.15 + 0.004)], r: [0, YAW_BACK, 0],
    w: cw * 0.80, h: ch * 0.82, bolts: 5,
  });
  for (const { sign, mirror } of SIDES) {
    addPanelDetail(rig, 'chest', {
      p: [sign * (cw * 0.52), m.collar * 0.18, 0], r: [0, sign * 90 * DEG, 0],
      w: cd * 0.68, h: ch * 0.62, bolts: 3, splitsY: [0.22], splitsX: [-0.2], mirror,
    });
    addPipeRun(rig, 'chest', [
      [sign * cw * 0.18, -m.thorax * 0.36, -FRONT * cd * 0.46],
      [sign * cw * 0.34, m.collar * 0.06, -FRONT * cd * 0.48],
      [sign * cw * 0.40, m.collar * 0.44, -FRONT * cd * 0.36],
    ], { radius: 0.011, mirror });
  }

  buildChestCore(rig, spec, cw, cd, ch, cy);
  buildBackHardware(rig, spec, cy);

  rig.decal('chest', DECAL.ROUNDEL, 0.10, 0.10, {
    p: [-cw * 0.30, m.collar * 0.34, FRONT * (cd * 0.5 + 0.03)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
  rig.decal('chest', DECAL.NAMEPLATE, 0.15, 0.062, {
    p: [0, -m.thorax * 0.32, FRONT * (cd * 0.5 + 0.01)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
  if (def?.archetype) {
    rig.decal('chest', DECAL.CHEVRON, 0.07, 0.07, {
      p: [cw * 0.32, -m.thorax * 0.10, FRONT * (cd * 0.5 + 0.02)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
    });
  }
}

function buildChestCore(rig, spec, cw, cd, ch, cy) {
  const zf = FRONT * (cd * 0.5 + 0.008);
  switch (spec.core) {
    case 'hex': {
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.102, y: 0 }, { r: 0.102, y: 0.034 },
        { r: 0.084, y: 0.048 }, { r: 0.070, y: 0.048 }, { r: 0.070, y: 0.010 }, { r: 0, y: 0.010 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'darkMetal',
      { p: [0, cy, zf], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY });
      // the glow sits at the bottom of the well, behind an iris of trim blades,
      // so the core reads as depth rather than a sticker
      rig.glow('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.052, y: 0 }, { r: 0.048, y: 0.010 }, { r: 0, y: 0.012 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'core',
      { p: [0, cy, zf + FRONT * 0.008], r: [90 * DEG, 0, 0] });
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + Math.PI / 6;
        rig.add('chest', bevelBox(0.030, 0.014, 0.020, 0.004, { topX: 0.5 }), 'trim', {
          p: [Math.cos(ang) * 0.062, cy + Math.sin(ang) * 0.062, zf + FRONT * 0.030],
          r: [0, 0, ang + Math.PI / 2], tier: TIER.SECONDARY,
        });
      }
      rig.add('chest', boltRing(6, 0.092, 0.010, 0.012, 0), 'trim',
        { p: [0, cy, zf + FRONT * 0.036], r: [-90 * DEG, 0, 0], tier: TIER.GREEBLE });
      break;
    }
    case 'slit': {
      rig.add('chest', bevelBox(0.05, ch * 0.66, 0.05, 0.010, { topX: 0.6, botX: 0.6 }), 'darkMetal',
        { p: [0, cy, zf], tier: TIER.PRIMARY });
      rig.glow('chest', bevelBox(0.020, ch * 0.54, 0.02, 0.005), 'core',
        { p: [0, cy, zf + FRONT * 0.020] });
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', bevelBox(0.045, ch * 0.72, 0.028, 0.008, { topX: 0.7 }), 'armorAccent',
          { p: [sign * 0.052, cy, zf + FRONT * 0.012], r: [0, sign * -22 * DEG, 0], mirror, tier: TIER.SECONDARY });
      }
      break;
    }
    case 'cage': {
      rig.glow('chest', latheProfile([
        { r: 0, y: -0.062 }, { r: 0.040, y: -0.055, smooth: true }, { r: 0.066, y: -0.028, smooth: true },
        { r: 0.072, y: 0, smooth: true }, { r: 0.066, y: 0.028, smooth: true },
        { r: 0.040, y: 0.055, smooth: true }, { r: 0, y: 0.062 },
      ], 20), 'core', { p: [0, cy, zf - FRONT * 0.012] });
      for (let i = 0; i < 5; i++) {
        const a = (-0.36 + i * 0.18) * Math.PI;
        rig.add('chest', bevelBox(0.022, 0.20, 0.03, 0.006, { topX: 0.55, botX: 0.55 }), 'darkMetal', {
          p: [Math.sin(a) * 0.062, cy, zf + FRONT * (0.012 + Math.cos(a) * 0.030)],
          r: [0, -a * 0.6, 0], tier: TIER.PRIMARY,
        });
      }
      rig.add('chest', latheProfile([
        { r: 0.086, y: 0 }, { r: 0.100, y: 0.012, smooth: true }, { r: 0.100, y: 0.03 }, { r: 0.086, y: 0.04 },
      ], 22), 'trim', { p: [0, cy, zf - FRONT * 0.03], r: [90 * DEG, 0, 0], tier: TIER.SECONDARY });
      break;
    }
    case 'column': {
      rig.add('chest', channelStrip(0.05, ch * 0.86, 0.018), 'darkMetal',
        { p: [0, cy, zf], r: FACE_FRONT, tier: TIER.PRIMARY });
      for (let i = 0; i < 5; i++) {
        rig.glow('chest', bevelBox(0.030, 0.022, 0.008, 0.003), 'core',
          { p: [0, cy - ch * 0.28 + i * ch * 0.14, zf - FRONT * 0.006] });
      }
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', bevelBox(0.018, ch * 0.9, 0.024, 0.005), 'trim',
          { p: [sign * 0.036, cy, zf], mirror, tier: TIER.SECONDARY });
      }
      break;
    }
    default: { // crystal
      const crystal = latheProfile([
        { r: 0, y: -0.075 }, { r: 0.055, y: -0.020 }, { r: 0.062, y: 0.006 }, { r: 0, y: 0.078 },
      ], 6, { faceted: true, phase: Math.PI / 6 });
      rig.glow('chest', crystal, 'core', { p: [0, cy, zf + FRONT * 0.028], r: [-90 * DEG * FRONT, 0, 0] });
      rig.add('chest', latheProfile([
        { r: 0.086, y: 0 }, { r: 0.094, y: 0.010, smooth: true }, { r: 0.072, y: 0.040 }, { r: 0.062, y: 0.040 },
        { r: 0.078, y: 0.008 }, { r: 0.076, y: 0 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'trim',
      { p: [0, cy, zf], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY });
      for (let i = 0; i < 3; i++) {
        rig.decal('chest', DECAL.GAUGE, 0.05, 0.05, {
          p: [Math.cos(i * 2.1) * 0.11, cy + Math.sin(i * 2.1) * 0.09, zf + FRONT * 0.006],
          r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
        });
      }
      break;
    }
  }
}

function buildBackHardware(rig, spec, cyIn) {
  const t = spec.torso;
  const zb = -FRONT * (t.chestD * 0.5 + 0.03);
  // Everything on the back hangs from here, dropped clear of the collar: a
  // reactor pack level with the head is a reactor pack in front of the head from
  // three quarters of the angles the fight camera ever chooses.
  const cy = cyIn - 0.055;

  switch (spec.back) {
    case 'radiators': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.26;
        rig.add('chest', loftHull([
          { y: -0.130, w: 0.126, d: 0.104, round: 0.30 },
          { y: 0.020, w: 0.134, d: 0.112, round: 0.26, smooth: true },
          { y: 0.128, w: 0.106, d: 0.084, round: 0.34 },
        ]), 'armorSecondary',
        { p: [x, cy + 0.02, zb + 0.05 * -FRONT], r: [-14 * DEG, 0, sign * -5 * DEG], mirror, tier: TIER.PRIMARY });
        for (let i = 0; i < 6; i++) {
          rig.add('chest', bevelBox(0.145, 0.012, 0.115, 0.004), 'darkMetal', {
            p: [x, cy - 0.086 + i * 0.040, zb + 0.05 * -FRONT + (0.10 - i * 0.028) * -FRONT * 0.14],
            r: [-14 * DEG, 0, 0], mirror, tier: TIER.SECONDARY,
          });
        }
        rig.glow('chest', bevelBox(0.10, 0.21, 0.012, 0.004), 'vents',
          { p: [x, cy + 0.02, zb + 0.115 * -FRONT], r: [-14 * DEG, 0, 0], mirror });
        rig.emitter('exhaust', 'chest', [x, cy + 0.15, zb + 0.05 * -FRONT], [0, 0.4, -FRONT], 0.05);
      }
      rig.add('chest', bevelBox(t.chestW * 0.46, 0.14, 0.12, 0.014, { topX: 0.8 }), 'armorPrimary',
        { p: [0, cy - 0.08, zb + 0.03 * -FRONT], tier: TIER.PRIMARY });
      break;
    }
    case 'thrusters': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.30;
        rig.add('chest', bevelBox(0.11, 0.20, 0.14, 0.012, { topX: 0.8, topZ: 0.7 }), 'armorPrimary',
          { p: [x, cy + 0.04, zb], r: [10 * DEG, 0, sign * -6 * DEG], mirror, tier: TIER.PRIMARY });
        const nozzle = latheProfile([
          { r: 0.030, y: 0 }, { r: 0.030, y: 0.05 }, { r: 0.044, y: 0.075, smooth: true },
          { r: 0.062, y: 0.115 }, { r: 0.056, y: 0.118 }, { r: 0.040, y: 0.082, smooth: true },
          { r: 0.026, y: 0.05 }, { r: 0.026, y: 0 },
        ], 22);
        rig.add('chest', nozzle, 'darkMetal',
          { p: [x, cy - 0.04, zb + 0.02 * -FRONT], r: [(90 + 28) * DEG * -FRONT, 0, 0], mirror, tier: TIER.PRIMARY });
        rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.040, y: 0 }, { r: 0.040, y: 0.008 }, { r: 0, y: 0.008 }], 22), 'vents',
          { p: [x, cy - 0.08, zb + 0.10 * -FRONT], r: [(90 + 28) * DEG * -FRONT, 0, 0], mirror });
        rig.emitter('thruster', 'chest', [x, cy - 0.09, zb + 0.12 * -FRONT], [0, -0.35, -FRONT], 0.055);
      }
      rig.add('chest', bevelBox(t.chestW * 0.4, 0.22, 0.09, 0.012, { topX: 0.7, botX: 0.86 }), 'carbon',
        { p: [0, cy + 0.03, zb - 0.01 * -FRONT], tier: TIER.PRIMARY });
      break;
    }
    case 'stacks': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.30;
        const pipe = latheProfile([
          { r: 0.042, y: 0 }, { r: 0.042, y: 0.20 }, { r: 0.053, y: 0.22, smooth: true },
          { r: 0.053, y: 0.252 }, { r: 0.038, y: 0.262 }, { r: 0.038, y: 0.22 }, { r: 0.031, y: 0.20 }, { r: 0.031, y: 0 },
        ], 20);
        rig.add('chest', pipe, 'darkMetal',
          { p: [x, cy, zb], r: [-18 * DEG, 0, sign * -22 * DEG], mirror, tier: TIER.PRIMARY });
        rig.add('chest', latheProfile([
          { r: 0.046, y: 0 }, { r: 0.056, y: 0.008, smooth: true }, { r: 0.056, y: 0.026 }, { r: 0.046, y: 0.034 },
        ], 20), 'trim', { p: [x, cy + 0.07, zb + 0.03 * FRONT], r: [-18 * DEG, 0, sign * -22 * DEG], mirror, tier: TIER.SECONDARY });
        rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.030, y: 0 }, { r: 0.030, y: 0.006 }, { r: 0, y: 0.006 }], 16), 'vents',
          { p: [x + sign * 0.128, cy + 0.245, zb + 0.10 * FRONT], r: [-18 * DEG, 0, sign * -22 * DEG], mirror });
        rig.emitter('exhaust', 'chest', [x + sign * 0.13, cy + 0.25, zb + 0.10 * FRONT], [0.3 * sign, 1, -0.28 * FRONT], 0.04);
      }
      rig.add('chest', bevelBox(t.chestW * 0.62, 0.22, 0.10, 0.014, { topX: 0.86 }), 'armorSecondary',
        { p: [0, cy - 0.01, zb], tier: TIER.PRIMARY });
      addLouvres(rig, 'chest', { p: [0, cy - 0.01, zb + 0.055 * -FRONT], r: [0, YAW_BACK, 0], w: t.chestW * 0.44, h: 0.16, n: 5, depth: 0.02, glow: 'vents' });
      break;
    }
    case 'sensorWings': {
      for (const { sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.24;
        rig.add('chest', bevelBox(0.16, 0.30, 0.026, 0.008, { topX: 0.55, botX: 0.9, shearZ: 0.03 }), 'armorPrimary', {
          p: [x + sign * 0.06, cy + 0.06, zb + 0.04 * -FRONT],
          r: [-22 * DEG, sign * 26 * DEG, sign * -12 * DEG], mirror, tier: TIER.PRIMARY,
        });
        rig.add('chest', bevelBox(0.11, 0.20, 0.014, 0.005, { topX: 0.5 }), 'carbon', {
          p: [x + sign * 0.075, cy + 0.07, zb + 0.055 * -FRONT],
          r: [-22 * DEG, sign * 26 * DEG, sign * -12 * DEG], mirror, tier: TIER.SECONDARY,
        });
        rig.glow('chest', bevelBox(0.012, 0.16, 0.008, 0.003), 'spine', {
          p: [x + sign * 0.028, cy + 0.07, zb + 0.05 * -FRONT], r: [-22 * DEG, sign * 26 * DEG, 0], mirror,
        });
      }
      // dorsal sensor drum
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.055, y: 0 }, { r: 0.062, y: 0.014, smooth: true }, { r: 0.062, y: 0.05 },
        { r: 0.048, y: 0.062 }, { r: 0, y: 0.062 },
      ], 22), 'darkMetal', { p: [0, cy + 0.04, zb], r: [-90 * DEG * -FRONT, 0, 0], tier: TIER.PRIMARY });
      rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.034, y: 0 }, { r: 0.034, y: 0.006 }, { r: 0, y: 0.006 }], 22), 'vents',
        { p: [0, cy + 0.04, zb + 0.064 * -FRONT], r: [-90 * DEG * -FRONT, 0, 0] });
      rig.add('chest', bevelBox(t.chestW * 0.5, 0.20, 0.08, 0.012, { topX: 0.8 }), 'armorSecondary',
        { p: [0, cy - 0.04, zb - 0.01 * -FRONT], tier: TIER.PRIMARY });
      break;
    }
    default: { // halo
      const R = 0.255;
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
        { p: [0, cy + 0.07, zb + 0.03 * -FRONT], r: [16 * DEG, 0, 0], tier: TIER.PRIMARY });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        rig.glow('chest', bevelBox(0.05, 0.018, 0.010, 0.004), 'spine', {
          p: [Math.cos(a) * R, cy + 0.07 + Math.sin(a) * R, zb + 0.045 * -FRONT],
          r: [16 * DEG, 0, a + Math.PI / 2],
        });
      }
      rig.add('chest', bevelBox(t.chestW * 0.34, 0.24, 0.10, 0.012, { topX: 0.6 }), 'armorPrimary',
        { p: [0, cy + 0.02, zb], r: [8 * DEG, 0, 0], tier: TIER.PRIMARY });
      rig.decal('chest', DECAL.GAUGE, 0.16, 0.16, {
        p: [0, cy + 0.07, zb + 0.05 * -FRONT], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE,
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

/**
 * Panel breakup for a large flat armour face: raised split strips, corner
 * brackets and a fastener row. Authored in a +Z-facing local frame so it drops
 * onto any plate with the same placement convention as `addLouvres`.
 */
function addPanelDetail(rig, bone, o) {
  const { p = [0, 0, 0], r = [0, 0, 0], w, h, mirror = false, bolts = 4, accent = 'armorSecondary' } = o;
  const strips = [];
  const t = 0.0075;
  for (const fy of (o.splitsY ?? [-0.22, 0.26])) {
    const g = bevelBox(w * 0.92, t, 0.012, 0.0022);
    g.translate(0, h * fy, 0.005);
    strips.push(g);
  }
  for (const fx of (o.splitsX ?? [0.18])) {
    const g = bevelBox(t, h * 0.80, 0.012, 0.0022);
    g.translate(w * fx, 0, 0.005);
    strips.push(g);
  }
  rig.add(bone, joinGeometries(strips), 'armorSecondary', { p, r, mirror, tier: TIER.SECONDARY });

  const brackets = [];
  const bw = w * 0.16, bh = h * 0.16;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const a = bevelBox(bw, 0.0055, 0.010, 0.0018);
    a.translate(sx * (w * 0.5 - bw * 0.5 - 0.004), sy * (h * 0.5 - 0.006), 0.005);
    const b = bevelBox(0.0055, bh, 0.010, 0.0018);
    b.translate(sx * (w * 0.5 - 0.006), sy * (h * 0.5 - bh * 0.5 - 0.004), 0.005);
    brackets.push(a, b);
  }
  rig.add(bone, joinGeometries(brackets), accent, { p, r, mirror, tier: TIER.SECONDARY });

  if (bolts > 0) {
    const heads = [];
    for (let i = 0; i < bolts; i++) {
      const g = hexBolt(0.0062, 0.0075);
      g.rotateX(-Math.PI / 2);
      g.translate(-w * 0.5 + w * ((i + 0.5) / bolts), -h * 0.5 + 0.014, 0.007);
      heads.push(g);
    }
    rig.add(bone, joinGeometries(heads), 'trim', { p, r, mirror, tier: TIER.GREEBLE });
  }
}

/**
 * Greeble pipe run: a tube threaded through a list of bone-local points with a
 * connector collar at each end. Purely tertiary — the kind of detail that reads
 * as "this machine was assembled" rather than "this mesh was extruded".
 */
function addPipeRun(rig, bone, points, o = {}) {
  const radius = o.radius ?? 0.010;
  const pts = points.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
  if (pts.length < 2) return;
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
  const tube = new THREE.TubeGeometry(curve, o.segments ?? 14, radius, 6, false);
  rig.add(bone, tube, o.mat ?? 'darkMetal', { mirror: o.mirror, tier: o.tier ?? TIER.GREEBLE });

  const collars = [];
  for (const end of [0, 1]) {
    const at = curve.getPoint(end);
    const tan = curve.getTangent(end);
    const g = latheProfile([
      { r: radius * 1.9, y: -0.012 }, { r: radius * 1.9, y: 0.006 },
      { r: radius * 1.45, y: 0.012 }, { r: radius * 1.45, y: 0.018 },
    ], 12);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, tan.multiplyScalar(end === 0 ? -1 : 1).normalize());
    g.applyMatrix4(new THREE.Matrix4().compose(at, q, new THREE.Vector3(1, 1, 1)));
    collars.push(g);
  }
  rig.add(bone, joinGeometries(collars), 'trim', { mirror: o.mirror, tier: o.tier ?? TIER.GREEBLE });
}

// ---------------------------------------------------------------------------
// Shoulder armour plan
//
// Shared between the arm builder, which emits it, and the head builder, which
// has to clear it. One description means a chassis cannot grow its pauldrons and
// silently bury its own head — which is exactly what used to happen.
// ---------------------------------------------------------------------------

/** Pauldron dimensions with the roster's `arms` multiplier already applied. */
function scaledPauldron(spec, m) {
  const s = spec.pauldron;
  return {
    w: s.w * m.armK, h: s.h * m.armK, d: s.d * m.armK,
    out: s.out * m.armS, up: s.up * m.armS,
    taper: s.taper, tilt: s.tilt, layers: s.layers,
  };
}

/**
 * Stacked curved lames for one shoulder, in clavicle-local terms.
 *
 * Each lame is a shell swept about the fore-aft axis: `R` is its radius from the
 * shoulder pivot, `[a0,a1]` the arc it covers measured from straight out (0)
 * through straight up (90 degrees), and `dy`/`dz` the step that clears the lame
 * above it. Overlapping shells with air between them is what reads as plate
 * armour; three nested boxes read as one block with grooves in it.
 */
function pauldronLames(pd) {
  const out = [];
  // `taper` sets how full the shells are: a brute's wrap most of the way around
  // the joint, an arcane frame's are shallow blades that barely touch it.
  const full = 0.78 + pd.taper * 0.34;
  for (let i = 0; i < pd.layers; i++) {
    out.push({
      R: pd.h * (0.86 - i * 0.11) * full,
      half: pd.d * (0.46 - i * 0.05),
      a0: (-56 - pd.taper * 22 + i * 10) * DEG,
      a1: (40 + pd.taper * 20 - i * 20) * DEG,
      dx: pd.w * (0.02 + i * 0.30),
      dy: pd.up - i * pd.h * 0.40,
      dz: -i * pd.d * 0.03,
      thick: pd.h * (0.17 - i * 0.025),
    });
  }
  return out;
}

/** Highest point of the shoulder armour in clavicle-local Y. */
function pauldronTop(pd) {
  let top = pd.up;
  for (const l of pauldronLames(pd)) {
    const s = l.a1 > Math.PI * 0.5 ? 1 : Math.sin(l.a1);
    top = Math.max(top, l.dy + l.R * s);
  }
  return top;
}

/** Top of the shoulder armour in chest-local Y — the line the head must clear. */
function shoulderLineY(rig, spec) {
  const m = rig.dim;
  const cl = rig.restPos.clavicle_L;
  const base = cl ? cl.y - rig.restPos.chest.y : 0.13 * m.armS;
  return base + pauldronTop(scaledPauldron(spec, m));
}

// ---------------------------------------------------------------------------
// Head
//
// A fighting-game character is read at the head: it is where the eye lands, it
// carries the identity, and it is the one shape that has to survive being forty
// pixels tall. Every skull below is therefore authored to three rules:
//
//   1. The jaw clears the shoulder line. Not "usually" — the clearance is solved
//      against the actual pauldron geometry, so it holds for any chassis and any
//      set of roster proportions.
//   2. There is a visible neck. A skull sitting straight on a torso reads as a
//      lump; a skull on an exposed dark column reads as a machine's head.
//   3. There is a bright optic under a dark overhang, wide enough to survive
//      being one pixel tall.
// ---------------------------------------------------------------------------

/** Head-local Y of the lowest point of every skull authored below. */
const HEAD_JAW = -0.05;

function buildHead(rig, spec, def) {
  const m = rig.dim;
  // Neck column: spans from inside the gorget up into the riser, so however far
  // the `torso` multiplier pushes the head there is never bare air at the collar.
  const nr = 0.048 * m.torsoK;
  rig.add('neck', latheProfile([
    { r: nr * 0.96, y: -m.collar * 0.22 }, { r: nr * 1.06, y: -m.collar * 0.06, smooth: true },
    { r: nr * 0.88, y: m.nape * 0.46 }, { r: nr * 1.02, y: m.nape * 0.70, smooth: true },
    { r: nr * 0.94, y: m.nape * 1.04 },
  ], 16), 'darkMetal', { tier: TIER.PRIMARY });
  rig.add('neck', bevelBox(0.10 * m.torsoK, 0.05, 0.09 * m.torsoK, 0.010, { topX: 0.8 }), 'armorSecondary',
    { p: [0, m.nape * 0.24, -FRONT * 0.012], tier: TIER.SECONDARY });

  // The head shapes are authored at reference size; `scaled` applies the
  // roster's head multiplier to their placement as well as their geometry, the
  // same way the bone hierarchy applies it to `head` and `headTop`.
  const k = m.headK * 1.16;

  // Clearance solve. `lift` is a distance in metres, not a proportion, so it is
  // applied unscaled — the head sits exactly far enough above the pauldrons for
  // the whole skull to be sky, whatever this character's arms multiplier did.
  const headAboveChest = rig.restPos.head.y - rig.restPos.chest.y;
  const want = shoulderLineY(rig, spec) - 0.014;
  // Capped: past about seven centimetres the riser stops reading as a neck and
  // starts reading as a giraffe, the pauldron cap has already fallen away toward
  // the spine by then, and the camera's headroom above `headTop` is finite.
  const lift = Math.min(0.075, Math.max(0, want - (headAboveChest + HEAD_JAW * k)));

  // Neck riser: the visible column the skull stands on. Authored in metres in
  // the head's own frame so it always reaches from the collar to the jaw, and
  // thickened with its own length so a tall one never reads as a drinking straw.
  const rr = (0.050 + lift * 0.16) * m.torsoK;
  const top = lift + HEAD_JAW * k + 0.012;
  rig.add('head', latheProfile([
    { r: rr * 0.80, y: -m.nape * 0.70 },
    { r: rr * 0.94, y: -m.nape * 0.34, smooth: true },
    { r: rr * 0.74, y: top - 0.052 },
    { r: rr * 0.74, y: top - 0.030 },
    { r: rr * 0.96, y: top - 0.020, smooth: true },
    { r: rr * 0.92, y: top },
  ], 16), 'darkMetal', { tier: TIER.PRIMARY });
  // spine of the riser, and a pair of guards that keep it from reading as a pipe
  for (const { sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: -m.nape * 0.5, w: 0.022, d: 0.052, round: 0.4 },
      { y: top - 0.020, w: 0.018, d: 0.040, round: 0.4 },
    ]), 'trim', { p: [sign * rr * 0.88, 0, -FRONT * 0.006], r: [0, 0, sign * -3 * DEG], mirror, tier: TIER.SECONDARY });
  }
  rig.glow('head', loftHull([
    { y: -m.nape * 0.3, w: 0.012, d: 0.010, round: 0.5 },
    { y: top - 0.030, w: 0.010, d: 0.008, round: 0.5 },
  ]), 'spine', { p: [0, 0, -FRONT * (rr * 0.78)] });

  rig.lifted(lift, () => rig.scaled(k, () => {
    switch (spec.head) {
      case 'slab': headSlab(rig, spec); break;
      case 'wedge': headWedge(rig, spec); break;
      case 'sunken': headSunken(rig, spec); break;
      case 'tower': headTower(rig, spec, def); break;
      default: headCrown(rig, spec); break;
    }
  }));
}

/**
 * Recessed optic band: a shadowed well, a lens with rounded ends sitting inside
 * it, a brow that overhangs far enough to keep the well dark under a top key,
 * and temple posts that stop the band running off the sides of the face.
 *
 * @param {Rig} rig
 * @param {{w:number, h:number, y:number, z:number, tilt?:number, group?:string,
 *   brow?:number, posts?:boolean}} o head-local placement in authoring units
 */
function addVisor(rig, o) {
  const { w, h, y, z, tilt = 0, group = 'visor', brow = 0.034, posts = true } = o;
  rig.add('head', channelStrip(w, h * 2.1, 0.026), 'darkMetal',
    { p: [0, y, z], r: [FACE_FRONT[0] + tilt, 0, 0], tier: TIER.SECONDARY });
  rig.glow('head', loftHull([
    { y: -h * 0.5, w: w * 0.74, d: 0.011, round: 0.5 },
    { y: -h * 0.18, w: w * 0.96, d: 0.015, round: 0.45, smooth: true },
    { y: h * 0.18, w: w * 0.96, d: 0.015, round: 0.45, smooth: true },
    { y: h * 0.5, w: w * 0.74, d: 0.011, round: 0.5 },
  ]), group, { p: [0, y, z + FRONT * 0.005], r: [tilt, 0, 0] });
  // brow: overhang plus a hard lower edge for the shadow to break on
  rig.add('head', loftHull([
    { y: 0, w: w * 1.10, d: brow, round: 0.28 },
    { y: 0.014, w: w * 1.06, d: brow * 0.80, round: 0.32, smooth: true },
    { y: 0.030, w: w * 0.90, d: brow * 0.40, round: 0.40 },
  ]), 'armorSecondary', {
    p: [0, y + h * 0.72, z + FRONT * (brow * 0.22)], r: [-14 * DEG + tilt, 0, 0], tier: TIER.PRIMARY,
  });
  if (posts) {
    for (const { sign, mirror } of SIDES) {
      rig.add('head', loftHull([
        { y: -h * 0.85, w: 0.017, d: 0.034, round: 0.4 },
        { y: h * 0.85, w: 0.021, d: 0.042, round: 0.4 },
      ]), 'trim', {
        p: [sign * w * 0.52, y, z - FRONT * 0.006], r: [tilt, 0, sign * -5 * DEG], mirror, tier: TIER.SECONDARY,
      });
    }
  }
}

function headSlab(rig) {
  // Bunker: a wide low vault over a raked face plate. The vault is a loft, not a
  // box, so the crown catches a moving highlight and the cheeks fall away into
  // shadow instead of stopping at a chamfer.
  rig.add('head', loftHull([
    { y: -0.050, w: 0.170, d: 0.170, round: 0.34 },
    { y: -0.008, w: 0.238, d: 0.212, round: 0.26, smooth: true },
    { y: 0.078, w: 0.252, d: 0.220, round: 0.24, smooth: true },
    { y: 0.140, w: 0.222, d: 0.192, round: 0.28, smooth: true },
    { y: 0.172, w: 0.146, d: 0.126, round: 0.42 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });

  // face plate, raked back from the jaw so the light breaks across three planes
  rig.add('head', loftHull([
    { y: -0.046, w: 0.132, d: 0.052, round: 0.36 },
    { y: 0.008, w: 0.196, d: 0.062, round: 0.26, smooth: true },
    { y: 0.086, w: 0.214, d: 0.058, round: 0.24 },
    { y: 0.122, w: 0.196, d: 0.044, round: 0.30 },
  ]), 'armorSecondary', { p: [0, 0, FRONT * 0.088], r: [-7 * DEG, 0, 0], tier: TIER.PRIMARY });

  addVisor(rig, { w: 0.176, h: 0.030, y: 0.062, z: FRONT * 0.122, tilt: -7 * DEG });

  // vocoder jaw under the visor
  rig.add('head', loftHull([
    { y: -0.052, w: 0.098, d: 0.052, z: FRONT * 0.020, round: 0.40 },
    { y: -0.014, w: 0.134, d: 0.062, z: FRONT * 0.006, round: 0.32, smooth: true },
    { y: 0.016, w: 0.142, d: 0.052, round: 0.30 },
  ]), 'darkMetal', { p: [0, 0, FRONT * 0.112], r: [11 * DEG, 0, 0], tier: TIER.PRIMARY });
  for (let i = 0; i < 3; i++) {
    rig.add('head', bevelBox(0.104 - i * 0.010, 0.006, 0.008, 0.002), 'trim',
      { p: [0, -0.028 + i * 0.015, FRONT * 0.132], r: [11 * DEG, 0, 0], tier: TIER.GREEBLE });
  }

  // ear housings: curved shells, not boxes, with intake louvres inside them
  for (const { sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: -0.056, w: 0.044, d: 0.098, round: 0.36 },
      { y: 0.004, w: 0.052, d: 0.128, round: 0.28, smooth: true },
      { y: 0.070, w: 0.048, d: 0.120, round: 0.30, smooth: true },
      { y: 0.104, w: 0.032, d: 0.078, round: 0.42 },
    ]), 'armorSecondary', {
      p: [sign * 0.122, 0.040, -FRONT * 0.004], r: [0, 0, sign * -7 * DEG], mirror, tier: TIER.PRIMARY,
    });
    addLouvres(rig, 'head', {
      p: [sign * 0.132, 0.048, -FRONT * 0.006], r: [0, sign * 90 * DEG, 0],
      w: 0.084, h: 0.052, n: 3, depth: 0.014, mirror, glow: 'joints',
    });
  }

  // Dorsal crest, swept back well past the nape. This is the whole profile read:
  // seen from the side a fighting-game character is a chin and a crest, and
  // without both the head is just the top of the torso.
  rig.add('head', loftHull([
    { y: 0.098, w: 0.032, d: 0.170, z: -FRONT * 0.020, round: 0.30 },
    { y: 0.158, w: 0.027, d: 0.212, z: -FRONT * 0.052, round: 0.26, smooth: true },
    { y: 0.206, w: 0.014, d: 0.150, z: -FRONT * 0.108, round: 0.40 },
  ]), 'armorAccent', { tier: TIER.PRIMARY });
  rig.glow('head', loftHull([
    { y: 0.116, w: 0.008, d: 0.128, z: -FRONT * 0.024, round: 0.5 },
    { y: 0.194, w: 0.006, d: 0.098, z: -FRONT * 0.100, round: 0.5 },
  ]), 'spine', { p: [0, 0, 0] });
  // nape armour, closing the back of the vault down onto the riser
  rig.add('head', loftHull([
    { y: -0.052, w: 0.140, d: 0.048, round: 0.36 },
    { y: 0.030, w: 0.186, d: 0.056, round: 0.30, smooth: true },
    { y: 0.104, w: 0.166, d: 0.048, round: 0.34 },
  ]), 'armorSecondary', { p: [0, 0, -FRONT * 0.096], r: [6 * DEG, 0, 0], tier: TIER.PRIMARY });
}

function headWedge(rig) {
  // Raptor: a forward-raked wedge with one big optic. The whole skull leans into
  // the strike, which is the read for a rushdown chassis.
  rig.add('head', loftHull([
    { y: -0.050, w: 0.106, d: 0.128, z: FRONT * 0.030, round: 0.42 },
    { y: 0.006, w: 0.152, d: 0.196, z: FRONT * 0.014, round: 0.30, smooth: true },
    { y: 0.084, w: 0.158, d: 0.214, z: -FRONT * 0.004, round: 0.26, smooth: true },
    { y: 0.146, w: 0.122, d: 0.170, z: -FRONT * 0.022, round: 0.34 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });

  // cheek mandibles, curved and swept forward
  for (const { sign, mirror } of SIDES) {
    rig.add('head', shellLathe([
      { r: 0.062, y: -0.050 }, { r: 0.070, y: -0.020, smooth: true },
      { r: 0.068, y: 0.028, smooth: true }, { r: 0.054, y: 0.052 },
    ], 0.016, 14, { arc: 128 * DEG, phase: -74 * DEG }), 'armorSecondary', {
      p: [sign * 0.062, 0.030, FRONT * 0.028], r: [-90 * DEG, sign * 12 * DEG, sign * -8 * DEG],
      order: 'YXZ', mirror, tier: TIER.PRIMARY,
    });
    rig.glow('head', loftHull([
      { y: -0.024, w: 0.010, d: 0.042, round: 0.5 },
      { y: 0.026, w: 0.010, d: 0.034, round: 0.5 },
    ]), 'joints', { p: [sign * 0.082, 0.028, FRONT * 0.040], r: [0, sign * 14 * DEG, 0], mirror });
  }

  // optic: a real housing with a lens set deep inside it
  rig.add('head', latheProfile([
    { r: 0.062, y: 0 }, { r: 0.062, y: 0.012 }, { r: 0.056, y: 0.024, smooth: true },
    { r: 0.040, y: 0.034 }, { r: 0.032, y: 0.034 }, { r: 0.032, y: 0 },
  ], 20), 'darkMetal', { p: [0, 0.058, FRONT * 0.096], r: [-90 * DEG * -FRONT, 0, 0], tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.034, y: 0 }, { r: 0.033, y: 0.011, smooth: true }, { r: 0, y: 0.019 },
  ], 20), 'visor', { p: [0, 0.058, FRONT * 0.108], r: [-90 * DEG * -FRONT, 0, 0] });
  rig.add('head', boltRing(6, 0.058, 0.006, 0.008), 'trim',
    { p: [0, 0.058, FRONT * 0.100], r: FACE_FRONT, tier: TIER.GREEBLE });

  // chin spike and the brow shelf over the optic
  rig.add('head', loftHull([
    { y: -0.062, w: 0.038, d: 0.052, round: 0.40 },
    { y: -0.014, w: 0.078, d: 0.076, round: 0.32 },
  ]), 'trim', { p: [0, 0, FRONT * 0.086], r: [16 * DEG, 0, 0], tier: TIER.PRIMARY });
  rig.add('head', loftHull([
    { y: 0, w: 0.150, d: 0.042, round: 0.28 },
    { y: 0.022, w: 0.120, d: 0.020, round: 0.40 },
  ]), 'armorSecondary', { p: [0, 0.092, FRONT * 0.086], r: [-24 * DEG, 0, 0], tier: TIER.PRIMARY });

  // twin crest blades sweeping back past the nape
  for (const { sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: 0, w: 0.026, d: 0.096, round: 0.30 },
      { y: 0.052, w: 0.022, d: 0.150, z: -FRONT * 0.048, round: 0.26, smooth: true },
      { y: 0.088, w: 0.010, d: 0.096, z: -FRONT * 0.118, round: 0.40 },
    ]), 'armorAccent', {
      p: [sign * 0.040, 0.116, -FRONT * 0.020], r: [18 * DEG, sign * -10 * DEG, sign * 14 * DEG],
      order: 'YXZ', mirror, tier: TIER.PRIMARY,
    });
    rig.add('head', latheProfile([
      { r: 0.007, y: 0 }, { r: 0.007, y: 0.05 }, { r: 0.0035, y: 0.053 }, { r: 0.0035, y: 0.15 }, { r: 0, y: 0.16 },
    ], 10), 'trim', {
      p: [sign * 0.052, 0.126, -FRONT * 0.020], r: [-20 * DEG, 0, sign * 16 * DEG], mirror, tier: TIER.GREEBLE,
    });
  }
}

function headSunken(rig) {
  // Bulldog: broad, low, and thrust forward on a heavy jaw. It never gets tall,
  // so it earns its silhouette by being wider than the neck and hanging out over
  // the chest with a caged furnace face.
  rig.add('head', loftHull([
    { y: -0.056, w: 0.144, d: 0.150, round: 0.40 },
    { y: -0.004, w: 0.196, d: 0.190, round: 0.30, smooth: true },
    { y: 0.062, w: 0.204, d: 0.196, round: 0.28, smooth: true },
    { y: 0.116, w: 0.168, d: 0.164, round: 0.34, smooth: true },
    { y: 0.146, w: 0.112, d: 0.112, round: 0.44 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });

  // brow shelf, heavy enough to throw the whole face into shadow
  rig.add('head', loftHull([
    { y: 0, w: 0.210, d: 0.062, round: 0.24 },
    { y: 0.026, w: 0.190, d: 0.040, round: 0.32 },
  ]), 'armorSecondary', { p: [0, 0.086, FRONT * 0.070], r: [-20 * DEG, 0, 0], tier: TIER.PRIMARY });

  // jaw, jutting forward and down
  rig.add('head', loftHull([
    { y: -0.062, w: 0.132, d: 0.078, z: FRONT * 0.020, round: 0.34 },
    { y: -0.020, w: 0.176, d: 0.096, z: FRONT * 0.006, round: 0.28, smooth: true },
    { y: 0.026, w: 0.184, d: 0.088, round: 0.28 },
  ]), 'armorSecondary', { p: [0, 0, FRONT * 0.060], r: [8 * DEG, 0, 0], tier: TIER.PRIMARY });

  // face cage over the furnace
  for (let i = -2; i <= 2; i++) {
    rig.add('head', loftHull([
      { y: -0.052, w: 0.013, d: 0.026, round: 0.4 },
      { y: 0.052, w: 0.011, d: 0.024, round: 0.4 },
    ]), 'darkMetal', {
      p: [i * 0.026, 0.020, FRONT * (0.108 - Math.abs(i) * 0.009)], r: [0, i * -9 * DEG, 0], tier: TIER.PRIMARY,
    });
  }
  rig.add('head', loftHull([
    { y: 0, w: 0.170, d: 0.030, round: 0.35 },
    { y: 0.014, w: 0.158, d: 0.022, round: 0.4 },
  ]), 'trim', { p: [0, 0.070, FRONT * 0.096], r: [-14 * DEG, 0, 0], tier: TIER.SECONDARY });
  rig.add('head', loftHull([
    { y: 0, w: 0.156, d: 0.028, round: 0.35 },
    { y: 0.014, w: 0.148, d: 0.020, round: 0.4 },
  ]), 'trim', { p: [0, -0.030, FRONT * 0.098], r: [16 * DEG, 0, 0], tier: TIER.SECONDARY });
  for (let i = -1; i <= 1; i++) {
    rig.glow('head', latheProfile([
      { r: 0, y: 0 }, { r: 0.019 - Math.abs(i) * 0.005, y: 0 },
      { r: 0.016 - Math.abs(i) * 0.005, y: 0.009 }, { r: 0, y: 0.012 },
    ], 14), 'visor', { p: [i * 0.040, 0.026, FRONT * 0.084], r: [-90 * DEG * -FRONT, 0, 0] });
  }

  // riveted skull cap and a pair of exhaust nubs
  rig.add('head', shellLathe([
    { r: 0.096, y: -0.062 }, { r: 0.104, y: -0.024, smooth: true },
    { r: 0.104, y: 0.024, smooth: true }, { r: 0.088, y: 0.060 },
  ], 0.022, 18, { arc: 190 * DEG, phase: -5 * DEG }), 'armorSecondary', {
    p: [0, 0.086, -FRONT * 0.014], r: [-90 * DEG, 0, 0], tier: TIER.PRIMARY,
  });
  rig.add('head', boltRing(7, 0.086, 0.008, 0.010), 'trim',
    { p: [0, 0.148, -FRONT * 0.014], tier: TIER.GREEBLE });
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0.022, y: 0 }, { r: 0.022, y: 0.058 }, { r: 0.027, y: 0.063, smooth: true },
      { r: 0.017, y: 0.072 }, { r: 0, y: 0.072 },
    ], 14), 'darkMetal', {
      p: [sign * 0.062, 0.126, -FRONT * 0.058], r: [-26 * DEG, 0, sign * 12 * DEG], mirror, tier: TIER.PRIMARY,
    });
    rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.013, y: 0 }, { r: 0, y: 0.008 }], 14), 'vents',
      { p: [sign * 0.085, 0.190, -FRONT * 0.090], r: [-26 * DEG, 0, sign * 12 * DEG], mirror });
  }
}

function headTower(rig, spec, def) {
  // Sentry: narrow, tall, sensor-dense. The mast is the silhouette — you should
  // be able to name this chassis from the top eighth of the frame alone.
  rig.add('head', loftHull([
    { y: -0.050, w: 0.104, d: 0.122, round: 0.40 },
    { y: 0.004, w: 0.138, d: 0.176, round: 0.28, smooth: true },
    { y: 0.096, w: 0.142, d: 0.186, round: 0.26, smooth: true },
    { y: 0.158, w: 0.112, d: 0.146, round: 0.34 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });
  rig.add('head', loftHull([
    { y: -0.040, w: 0.092, d: 0.040, round: 0.38 },
    { y: 0.028, w: 0.132, d: 0.050, round: 0.28, smooth: true },
    { y: 0.106, w: 0.136, d: 0.044, round: 0.28 },
  ]), 'armorSecondary', { p: [0, 0, FRONT * 0.078], r: [-5 * DEG, 0, 0], tier: TIER.PRIMARY });

  addVisor(rig, { w: 0.116, h: 0.024, y: 0.070, z: FRONT * 0.104, tilt: -5 * DEG, brow: 0.028 });

  // targeting monocle on a swing arm, deliberately asymmetric
  rig.add('head', loftHull([
    { y: -0.020, w: 0.034, d: 0.070, round: 0.35 },
    { y: 0.020, w: 0.040, d: 0.082, round: 0.32 },
  ]), 'darkMetal', { p: [0.076, 0.088, FRONT * 0.040], r: [0, 12 * DEG, 9 * DEG], tier: TIER.SECONDARY });
  rig.add('head', latheProfile([
    { r: 0.028, y: 0 }, { r: 0.028, y: 0.020 }, { r: 0.022, y: 0.030 }, { r: 0.017, y: 0.030 }, { r: 0.017, y: 0 },
  ], 16), 'trim', { p: [0.084, 0.088, FRONT * 0.086], r: [-90 * DEG * -FRONT, 0, 0], tier: TIER.SECONDARY });
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.016, y: 0 }, { r: 0, y: 0.009 }], 16), 'visor',
    { p: [0.084, 0.088, FRONT * 0.100], r: [-90 * DEG * -FRONT, 0, 0] });

  // sensor drum on the other side
  rig.add('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.036, y: 0 }, { r: 0.040, y: 0.011, smooth: true }, { r: 0.040, y: 0.038 },
    { r: 0.030, y: 0.046 }, { r: 0, y: 0.046 },
  ], 20), 'darkMetal', { p: [-0.070, 0.066, 0], r: [0, 0, 90 * DEG], tier: TIER.SECONDARY });
  rig.decal('head', DECAL.GAUGE, 0.058, 0.058, { p: [-0.118, 0.066, 0], r: [0, -90 * DEG, 0], tier: TIER.GREEBLE });

  // mast: a tapered tower, not a stick
  rig.add('head', loftHull([
    { y: 0.130, w: 0.058, d: 0.070, round: 0.30 },
    { y: 0.214, w: 0.046, d: 0.058, z: -FRONT * 0.010, round: 0.32, smooth: true },
    { y: 0.268, w: 0.024, d: 0.030, z: -FRONT * 0.018, round: 0.42 },
  ]), 'armorSecondary', { p: [0, 0, -FRONT * 0.030], r: [-7 * DEG, 0, 0], tier: TIER.PRIMARY });
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0.006, y: 0 }, { r: 0.006, y: 0.10 }, { r: 0.003, y: 0.105 }, { r: 0.003, y: 0.24 }, { r: 0, y: 0.25 },
    ], 12), 'trim', { p: [sign * 0.026, 0.272, -FRONT * 0.044], r: [-12 * DEG, 0, sign * 10 * DEG], mirror, tier: TIER.SECONDARY });
  }
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.011, y: 0 }, { r: 0, y: 0.014 }], 12), 'joints',
    { p: [0, 0.276, -FRONT * 0.046] });
  if (def) rig.decal('head', DECAL.BARCODE, 0.062, 0.030, { p: [0, 0.016, -FRONT * 0.098], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE });
}

function headCrown(rig) {
  // Hierarch: a smooth ceremonial helm, a veiled face and four flared horns. The
  // only skull in the cast with no hard corner on it, which is the point.
  rig.add('head', latheProfile([
    { r: 0.042, y: -0.050 }, { r: 0.078, y: -0.008, smooth: true }, { r: 0.094, y: 0.048, smooth: true },
    { r: 0.088, y: 0.110, smooth: true }, { r: 0.052, y: 0.158, smooth: true }, { r: 0, y: 0.176 },
  ], 24), 'armorPrimary', { s: [1, 1, 1.12], tier: TIER.PRIMARY });
  // veil
  rig.add('head', loftHull([
    { y: -0.052, w: 0.072, d: 0.048, round: 0.44 },
    { y: 0.010, w: 0.116, d: 0.060, round: 0.34, smooth: true },
    { y: 0.078, w: 0.126, d: 0.056, round: 0.30, smooth: true },
    { y: 0.116, w: 0.104, d: 0.044, round: 0.38 },
  ]), 'trim', { p: [0, 0, FRONT * 0.062], r: [-4 * DEG, 0, 0], tier: TIER.PRIMARY });

  addVisor(rig, { w: 0.098, h: 0.022, y: 0.070, z: FRONT * 0.090, brow: 0.026, posts: false });

  // forehead crystal
  rig.glow('head', latheProfile([
    { r: 0, y: -0.032 }, { r: 0.022, y: -0.008 }, { r: 0.024, y: 0.005 }, { r: 0, y: 0.038 },
  ], 6, { faceted: true, phase: Math.PI / 6 }), 'core',
  { p: [0, 0.124, FRONT * 0.062], r: [-70 * DEG * -FRONT, 0, 0] });

  // horns
  for (const { sign, mirror } of SIDES) {
    for (let j = 0; j < 2; j++) {
      const len = j === 0 ? 0.23 : 0.16;
      rig.add('head', loftHull([
        { y: 0, w: 0.028, d: 0.036, round: 0.34 },
        { y: len * 0.58, w: 0.020, d: 0.026, z: -FRONT * len * 0.16, round: 0.36, smooth: true },
        { y: len, w: 0.007, d: 0.009, z: -FRONT * len * 0.34, round: 0.45 },
      ]), 'armorAccent', {
        p: [sign * (0.056 + j * 0.026), 0.108 + j * 0.012, -FRONT * (0.012 + j * 0.036)],
        r: [(26 + j * 14) * DEG, 0, sign * (24 + j * 16) * DEG],
        mirror, tier: TIER.PRIMARY,
      });
    }
    rig.glow('head', loftHull([
      { y: 0, w: 0.007, d: 0.007, round: 0.5 },
      { y: 0.125, w: 0.005, d: 0.005, round: 0.5 },
    ]), 'spine', { p: [sign * 0.060, 0.152, -FRONT * 0.036], r: [26 * DEG, 0, sign * 24 * DEG], mirror });
  }

  // circlet
  const circlet = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const g = bevelBox(0.020, 0.022, 0.015, 0.004);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * 0.090, 0, Math.sin(a) * 0.100),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, 0)),
      new THREE.Vector3(1, 1, 1),
    ));
    circlet.push(g);
  }
  rig.add('head', joinGeometries(circlet), 'trim', { p: [0, 0.046, 0], tier: TIER.SECONDARY });
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

function buildArm(rig, spec, side, sign, mirror, opts = {}) {
  const a = spec.arms;
  const m = rig.dim;
  const pdSrc = spec.pauldron;
  // Pauldron geometry rides on the clavicle, which roster.js scales with the
  // `arms` group — so its offsets have to be scaled the same way or the shoulder
  // armour drifts off the joint it is supposed to cap.
  const pd = scaledPauldron(spec, m);
  const S = side;
  const gaunt = opts.gauntlet ?? a.gauntlet;
  const upper = a.upper * m.armK * (opts.scale ?? 1);
  const fore = a.fore * m.armK * (opts.scale ?? 1);
  // Segment lengths come off the live bones, never from a literal.
  const uLen = m.upper;
  const fLen = m.fore;

  // --- pauldron, on the clavicle so big shoulder armour does not spin with the
  // arm. Each lame is a swept shell with an inner face and a rim, stepped clear
  // of the one above it; the air between the layers is the whole read.
  const lameSeg = rig.maxTier >= 2 ? 18 : 11;
  const lames = pauldronLames(pd);
  // Centre the shells on the shoulder ball, not on the collarbone: an arc struck
  // from the wrong pivot hovers over the torso like a handle instead of capping
  // the joint it is supposed to protect.
  const ballX = Math.abs((rig.restPos[`shoulder_${S}`]?.x ?? 0.155 * m.armS)
    - (rig.restPos[`clavicle_${S}`]?.x ?? 0)) * 0.58;
  lames.forEach((l, i) => {
    const at = [sign * (ballX + l.dx), l.dy, l.dz];
    rig.add(`clavicle_${S}`, shellLathe([
      { r: l.R * 0.93, y: -l.half },
      { r: l.R, y: -l.half * 0.62, smooth: true },
      { r: l.R, y: l.half * 0.62, smooth: true },
      { r: l.R * 0.93, y: l.half },
    ], l.thick, lameSeg, { arc: l.a1 - l.a0, phase: l.a0 }),
    i === 0 ? 'armorPrimary' : 'armorSecondary', {
      // the lathe sweeps about +Y; -90 about X lays that sweep into the frontal
      // plane so the arc runs from under the arm up over the top of the shoulder
      p: at, r: [-90 * DEG, 0, 0], mirror, tier: TIER.PRIMARY,
    });
    // Rolled edge along the leading rim of each lame: a thin band standing proud
    // of the plate right where a real one would be ground bright, and the only
    // thing on the shoulder that reliably catches the rim light.
    const mid = (l.a0 + l.a1) * 0.5;
    rig.add(`clavicle_${S}`, shellLathe([
      { r: l.R * 1.03, y: -l.half * 0.99 }, { r: l.R * 1.05, y: -l.half * 0.86, smooth: true },
      { r: l.R * 1.05, y: l.half * 0.86, smooth: true }, { r: l.R * 1.03, y: l.half * 0.99 },
    ], l.thick * 0.55, Math.max(6, Math.round(lameSeg * 0.45)),
    { arc: (l.a1 - l.a0) * 0.42, phase: mid - (l.a1 - l.a0) * 0.21 }),
    'trim', { p: at, r: [-90 * DEG, 0, 0], mirror, tier: TIER.SECONDARY });
  });

  // shoulder cap: the block the lames hang off, closing the gap to the neck
  const cap = lames[0];
  rig.add(`clavicle_${S}`, loftHull([
    { y: -pd.h * 0.40, w: pd.w * 0.70, d: pd.d * 0.80, round: 0.36 },
    { y: pd.up + pd.h * 0.06, w: pd.w * 0.92, d: pd.d * 0.86, round: 0.30, smooth: true },
    { y: pd.up + pd.h * 0.40, w: pd.w * 0.58, d: pd.d * 0.62, round: 0.40 },
  ]), 'armorSecondary', {
    p: [sign * (ballX * 0.55), 0, -FRONT * pd.d * 0.02],
    r: [0, 0, sign * -pd.tilt * 0.5 * DEG], mirror, tier: TIER.PRIMARY,
  });

  addPanelDetail(rig, `clavicle_${S}`, {
    p: [sign * (ballX + cap.dx + cap.R * 0.30), cap.dy + cap.R * 0.58, FRONT * (cap.half + 0.006)],
    r: [0, YAW_FRONT, sign * -34 * DEG],
    w: pd.w * 0.46, h: pd.h * 0.42, bolts: 3, splitsY: [0.22], splitsX: [-0.18], mirror,
  });
  rig.add(`clavicle_${S}`, boltRing(5, pd.w * 0.22, 0.008, 0.010), 'trim', {
    p: [sign * (ballX + cap.dx), cap.dy, FRONT * (cap.half + 0.008)],
    r: FACE_FRONT, mirror, tier: TIER.GREEBLE,
  });

  // --- rotary shoulder housing, world-aligned so its axis is horizontal
  rig.add(`shoulder_${S}`, latheProfile([
    { r: 0, y: -upper * 0.30 }, { r: upper * 0.74, y: -upper * 0.30 }, { r: upper * 0.84, y: -upper * 0.16, smooth: true },
    { r: upper * 0.84, y: upper * 0.16 }, { r: upper * 0.66, y: upper * 0.28 }, { r: 0, y: upper * 0.28 },
  ], 22), 'darkMetal', { world: true, p: [sign * 0.012, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`shoulder_${S}`, boltRing(6, upper * 0.52, 0.008, 0.010), 'trim',
    { world: true, p: [sign * 0.056, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.GREEBLE });
  rig.glow(`shoulder_${S}`, latheProfile([
    { r: 0, y: 0 }, { r: upper * 0.115, y: 0 }, { r: upper * 0.10, y: 0.008 }, { r: 0, y: 0.010 },
  ], 14), 'joints', { world: true, p: [sign * 0.062, 0, 0], r: [0, 0, sign * -90 * DEG], mirror });

  // --- upper arm: one section running from inside the shoulder housing down to
  // just short of the elbow pivot, sized at each end to match its neighbour
  const elbowW = fore * 1.52;

  // Deltoid shell, on the shoulder so it swings with the arm. The pauldron
  // hanging above needs something to overlap; without it the shoulder armour
  // stops in mid-air and the arm reads as a separate object bolted on nearby.
  rig.add(`shoulder_${S}`, shellLathe([
    { r: upper * 0.80, y: -uLen * 0.66 },
    { r: upper * 0.90, y: -uLen * 0.46, smooth: true },
    { r: upper * 0.94, y: -uLen * 0.08, smooth: true },
    { r: upper * 0.86, y: upper * 0.24 },
  ], upper * 0.17, rig.maxTier >= 2 ? 16 : 10, { arc: 186 * DEG, phase: -93 * DEG }),
  'armorSecondary', { mirror, tier: TIER.PRIMARY });
  rig.plated(`shoulder_${S}`, {
    y0: -uLen * 0.90, y1: upper * 0.40,
    w0: elbowW * 0.94, w1: upper * 1.52,
    d0: elbowW * 0.96, d1: upper * 1.56,
    mat: 'armorPrimary', gap: 0.013, inset: 0.88, round: 0.36, swell: 0.05, mirror,
  });
  rig.add(`shoulder_${S}`, bevelBox(upper * 1.1, uLen * 0.40, upper * 0.5, 0.008, { topX: 0.9, botX: 0.7 }), 'armorSecondary',
    { p: [0, -uLen * 0.52, FRONT * upper * 0.82], r: [0, 0, 0], mirror, tier: TIER.SECONDARY });
  rig.add(`shoulder_${S}`, channelStrip(upper * 0.42, uLen * 0.56, 0.009), 'darkMetal',
    { p: [0, -uLen * 0.44, -FRONT * upper * 0.78], r: FACE_BACK, mirror, tier: TIER.SECONDARY });
  rig.add(`shoulder_${S}`, latheProfile([
    { r: upper * 0.55, y: 0 }, { r: upper * 0.62, y: 0.012, smooth: true }, { r: upper * 0.62, y: 0.03 },
    { r: upper * 0.55, y: 0.042 },
  ], 20), 'trim', { p: [0, -uLen * 0.80, 0], mirror, tier: TIER.SECONDARY });

  // --- elbow: rotary housing + floating cap. The housing radius is deliberately
  // larger than half the arm width, so the barrel of the joint is what the eye
  // sees at the seam no matter how far the elbow is flexed.
  const elbowR = Math.max(fore, upper) * 0.80;
  rig.add(`elbow_${S}`, latheProfile([
    { r: 0, y: -elbowW * 0.34 }, { r: elbowR * 0.90, y: -elbowW * 0.34 }, { r: elbowR, y: -elbowW * 0.24, smooth: true },
    { r: elbowR, y: elbowW * 0.24 }, { r: elbowR * 0.82, y: elbowW * 0.34 }, { r: 0, y: elbowW * 0.34 },
  ], 22), 'darkMetal', { world: true, p: [0, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`elbow_${S}`, bevelBox(fore * 1.35, fore * 1.1, fore * 0.75, 0.010, { topX: 0.85, botX: 0.9 }), 'armorSecondary',
    { p: [0, -fore * 0.10, -FRONT * fore * 0.85], r: [10 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });

  // --- forearm: from inside the elbow barrel down to the wrist cuff
  const cuffW = fore * 1.36 * (1 + gaunt * 0.18);
  rig.plated(`elbow_${S}`, {
    y0: -fLen * 0.90, y1: fore * 0.34,
    w0: cuffW, w1: fore * 1.55,
    d0: cuffW * 0.98, d1: fore * 1.55,
    mat: 'armorPrimary', gap: 0.012, inset: 0.88, round: 0.34, swell: 0.04, mirror,
  });
  // forearm panel with fasteners
  rig.add(`elbow_${S}`, bevelBox(fore * 1.0, fLen * 0.44, 0.012, 0.005), 'carbon',
    { p: [0, -fLen * 0.44, FRONT * fore * 0.82], mirror, tier: TIER.SECONDARY });
  rig.add(`elbow_${S}`, boltRing(4, fore * 0.42, 0.007, 0.009), 'trim',
    { p: [0, -fLen * 0.44, FRONT * (fore * 0.84)], r: FACE_FRONT, mirror, tier: TIER.GREEBLE });
  addPanelDetail(rig, `elbow_${S}`, {
    p: [0, -fLen * 0.44, FRONT * (fore * 0.82 + 0.004)], r: [0, YAW_FRONT, 0],
    w: fore * 1.10, h: fLen * 0.56, bolts: 3, splitsY: [0.20], splitsX: [], mirror,
  });
  addPipeRun(rig, `elbow_${S}`, [
    [sign * fore * 0.70, -0.03, -FRONT * fore * 0.55],
    [sign * fore * 0.86, -0.13, -FRONT * fore * 0.40],
    [sign * fore * 0.76, -0.23, -FRONT * fore * 0.20],
  ], { radius: 0.008, mirror });
  rig.decal(`elbow_${S}`, DECAL.SERIAL, fore * 1.1, fore * 1.1, {
    p: [sign * fore * 0.86, -fLen * 0.45, 0], r: [0, sign * 90 * DEG, 0], mirror, tier: TIER.GREEBLE,
  });

  // --- wrist cuff: sleeves the forearm bottom and the back of the fist
  rig.add(`wrist_${S}`, latheProfile([
    { r: cuffW * 0.50, y: m.palm * 0.34 }, { r: cuffW * 0.56, y: m.palm * 0.14, smooth: true },
    { r: cuffW * 0.56, y: -m.palm * 0.28 }, { r: cuffW * 0.46, y: -m.palm * 0.44 },
  ], 20), 'darkMetal', { mirror, tier: TIER.PRIMARY });
  rig.glow(`wrist_${S}`, latheProfile([
    { r: cuffW * 0.51, y: 0 }, { r: cuffW * 0.54, y: 0.003 }, { r: cuffW * 0.54, y: 0.009 }, { r: cuffW * 0.51, y: 0.012 },
  ], 20), 'joints', { p: [0, -0.006, 0], mirror });

  // --- hand: fist block, knuckle plates, thumb. The block reaches back up to
  // the cuff so the wrist never shows daylight.
  const hw = fore * (1.55 + gaunt * 0.85);
  rig.section(`hand_${S}`, {
    y0: -m.grip * 0.34, y1: m.palm * 0.62,
    w0: hw * 0.64, w1: hw * 0.72, d0: hw * 0.86, d1: hw * 0.95,
    mat: 'armorPrimary', mirror,
  });
  rig.section(`fingers_${S}`, {
    y0: -m.grip * 0.58, y1: m.grip * 0.42,
    w0: hw * 0.58, w1: hw * 0.70, d0: hw * 0.76, d1: hw * 0.90,
    mat: 'armorSecondary', mirror,
  });
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
    // Siege gauntlet: a flared cuff shell over the wrist. Width is capped well
    // short of `gaunt` scaling linearly, or a brute ends up swinging a billboard.
    const gw = fore * (1.30 + gaunt * 0.42);
    rig.add(`elbow_${S}`, bevelBox(gw, fLen * 0.56, gw * 0.94, 0.016,
      { topX: 0.74, topZ: 0.78, botX: 0.96, botZ: 0.96 }), 'armorAccent',
    { p: [0, -fLen * 0.74, 0], mirror, tier: TIER.PRIMARY });
    addPanelDetail(rig, `elbow_${S}`, {
      p: [0, -fLen * 0.74, FRONT * (gw * 0.48 + 0.004)], r: [0, YAW_FRONT, 0],
      w: gw * 0.72, h: fLen * 0.40, bolts: 3, splitsY: [0.2], splitsX: [], mirror,
    });
    addPanelDetail(rig, `elbow_${S}`, {
      p: [sign * (gw * 0.48 + 0.004), -fLen * 0.74, 0], r: [0, sign * 90 * DEG, 0],
      w: gw * 0.72, h: fLen * 0.40, bolts: 3, splitsY: [0.2], splitsX: [], mirror,
    });
    rig.add(`elbow_${S}`, boltRing(8, gw * 0.40, 0.009, 0.011), 'trim',
      { p: [0, -fLen * 1.02, 0], r: [180 * DEG, 0, 0], mirror, tier: TIER.GREEBLE });
    // knuckle-duster ridge along the striking face
    for (let i = -1; i <= 1; i++) {
      rig.add(`elbow_${S}`, bevelBox(gw * 0.20, 0.05, gw * 0.22, 0.006, { topX: 0.5, topZ: 0.5 }), 'trim',
        { p: [i * gw * 0.28, -fLen * 0.52, FRONT * gw * 0.50], r: [-14 * DEG, 0, 0], mirror, tier: TIER.SECONDARY });
    }
    rig.glow(`elbow_${S}`, bevelBox(gw * 0.62, 0.014, 0.012, 0.004), 'vents',
      { p: [0, -fLen * 0.62, FRONT * (gw * 0.50 + 0.004)], mirror });
  }
}

/** Folded forearm blade — agile chassis signature hardware. */
function addForearmBlade(rig, spec, side, sign, mirror) {
  const m = rig.dim;
  const fore = spec.arms.fore * m.armK;
  const len = m.fore * 1.10;
  const S = side;
  rig.add(`elbow_${S}`, bevelBox(0.028, len, 0.055, 0.006, { topX: 0.35, topZ: 0.42, botX: 0.8 }), 'trim',
    { p: [sign * fore * 0.95, -len * 0.50, -FRONT * fore * 0.30], r: [-6 * DEG, 0, sign * -4 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`elbow_${S}`, bevelBox(0.040, 0.075, 0.070, 0.008), 'darkMetal',
    { p: [sign * fore * 0.95, m.fore * 0.07, -FRONT * fore * 0.30], mirror, tier: TIER.SECONDARY });
  rig.glow(`elbow_${S}`, bevelBox(0.010, len * 0.73, 0.010, 0.003), 'spine',
    { p: [sign * fore * 1.02, -len * 0.43, -FRONT * fore * 0.30], mirror });
  rig.emitter('blade', `elbow_${S}`, [sign * fore * 0.95, -len, -FRONT * fore * 0.30], [0, -1, 0], 0.03);
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
    p: [sign * (pd.out + pd.w * 1.05), pd.up - 0.02, 0],
    r: [0, sign * 22 * DEG, sign * -18 * DEG], mirror, tier: TIER.PRIMARY,
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    rig.glow(`clavicle_${S}`, bevelBox(0.036, 0.012, 0.012, 0.003), 'spine', {
      p: [sign * (pd.out + pd.w * 1.05) + Math.cos(a) * R * 0.94, pd.up - 0.02 + Math.sin(a) * R * 0.94, 0],
      r: [0, sign * 22 * DEG, a + Math.PI / 2], mirror,
    });
  }
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

function buildLeg(rig, spec, side, sign, mirror) {
  const Lsrc = spec.legs;
  const m = rig.dim;
  const S = side;
  const digi = Lsrc.plan === 'digitigrade';
  const splay = Lsrc.plan === 'splayed';

  // Segment lengths off the bones; cross-sections scaled to match and then
  // capped against the space actually available between the two leg chains.
  // Uncapped, a heavy's thigh armour is wider than the gap between its hips and
  // both legs fuse into a single column at any distance.
  const tLen = m.thigh;
  const sLen = m.shin;
  const L = {
    ...Lsrc,
    thigh: Lsrc.thigh * m.legK,
    shin: Lsrc.shin * m.legK,
    foot: Lsrc.foot * m.legS,
    footW: Math.min(Lsrc.footW * m.legK, m.hipSep * 0.86),
  };
  // Thighs may just touch at the top — that is what a heavy is supposed to look
  // like — but the knee has to come back inside the hip spacing or the two lower
  // legs fuse into one column and the stance stops reading.
  const thighW = Math.min(L.thigh * 1.40, m.hipSep * 1.12);
  const kneeW = Math.min(L.shin * 1.30, m.hipSep * 0.82);
  const ankleW = kneeW * 0.78;

  // --- thigh: one section from inside the hip ball down to the knee barrel
  rig.plated(`hip_${S}`, {
    y0: -tLen * 0.90, y1: L.thigh * 0.42,
    w0: kneeW * 0.96, w1: thighW,
    d0: kneeW * 1.00, d1: thighW * 1.03,
    mat: 'armorPrimary', gap: 0.017, inset: 0.86, round: 0.36, swell: 0.07, swellAt: 0.62,
    r: [0, 0, sign * (splay ? 4 : 2) * DEG], mirror,
  });
  // outer thigh panel + channel
  rig.add(`hip_${S}`, bevelBox(0.026, tLen * 0.52, L.thigh * 1.0, 0.006, { topX: 0.8 }), 'carbon',
    { p: [sign * L.thigh * 0.76, -tLen * 0.42, 0], mirror, tier: TIER.SECONDARY });
  rig.add(`hip_${S}`, channelStrip(L.thigh * 0.30, tLen * 0.60, 0.011), 'darkMetal',
    { p: [0, -tLen * 0.40, FRONT * L.thigh * 0.78], r: FACE_FRONT, mirror, tier: TIER.SECONDARY });
  addPanelDetail(rig, `hip_${S}`, {
    p: [sign * (L.thigh * 0.76), -tLen * 0.40, 0], r: [0, sign * 90 * DEG, 0],
    w: L.thigh * 1.05, h: tLen * 0.58, bolts: 4, mirror,
  });
  rig.decal(`hip_${S}`, DECAL.ARROW, L.thigh * 0.7, L.thigh * 0.7, {
    p: [sign * L.thigh * 0.80, -tLen * 0.6, 0], r: [0, sign * 90 * DEG, 0], mirror, tier: TIER.GREEBLE,
  });
  // hip collar
  rig.add(`hip_${S}`, latheProfile([
    { r: thighW * 0.50, y: L.thigh * 0.20 }, { r: thighW * 0.56, y: 0.0, smooth: true },
    { r: thighW * 0.56, y: -L.thigh * 0.20 }, { r: thighW * 0.48, y: -L.thigh * 0.32 },
  ], 20), 'darkMetal', { mirror, tier: TIER.PRIMARY });

  // --- knee assembly (knee_L is the SHIN bone; the cap rides with the shin).
  // The barrel is wider than either plate it joins, so the seam always reads as
  // a hinge rather than a hole, through the whole flexion range.
  const kneeR = Math.max(thighW, kneeW) * 0.60;
  rig.add(`knee_${S}`, latheProfile([
    { r: 0, y: -kneeW * 0.36 }, { r: kneeR * 0.90, y: -kneeW * 0.36 }, { r: kneeR, y: -kneeW * 0.24, smooth: true },
    { r: kneeR, y: kneeW * 0.24 }, { r: kneeR * 0.80, y: kneeW * 0.36 }, { r: 0, y: kneeW * 0.36 },
  ], 22), 'darkMetal', { world: true, p: [0, 0, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });
  rig.add(`knee_${S}`, bevelBox(L.shin * 1.35, L.shin * 1.25, L.shin * 0.85, 0.012,
    { topX: 0.86, botX: 0.72, shearZ: FRONT * 0.02 }), 'armorAccent',
  { p: [0, -L.shin * 0.14, FRONT * L.shin * 0.85], r: [-8 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });
  rig.glow(`knee_${S}`, bevelBox(L.shin * 0.55, 0.012, 0.010, 0.003), 'joints',
    { p: [0, -L.shin * 0.40, FRONT * L.shin * 1.05], mirror });

  // --- shin
  if (digi) {
    // digitigrade read: the shin flares backwards at the top into a hock, then
    // sweeps forward into a slim lower leg
    rig.section(`knee_${S}`, {
      y0: -sLen * 0.50, y1: L.shin * 0.40,
      w0: kneeW * 0.80, w1: kneeW,
      d0: kneeW * 1.05, d1: kneeW * 1.55,
      mat: 'armorPrimary', z: -FRONT * L.shin * 0.30,
      shearZ: -FRONT * 0.05, mirror,
    });
    rig.section(`knee_${S}`, {
      y0: -sLen * 0.94, y1: -sLen * 0.44,
      w0: ankleW, w1: kneeW * 0.82,
      d0: ankleW * 1.02, d1: kneeW * 0.94,
      mat: 'armorPrimary', z: -FRONT * L.shin * 0.05,
      shearZ: FRONT * 0.045, mirror,
    });
    // calf thruster
    rig.add(`knee_${S}`, latheProfile([
      { r: L.shin * 0.30, y: 0 }, { r: L.shin * 0.30, y: 0.05 }, { r: L.shin * 0.42, y: 0.085, smooth: true },
      { r: L.shin * 0.26, y: 0.09 }, { r: L.shin * 0.22, y: 0.05 }, { r: L.shin * 0.22, y: 0 },
    ], 16), 'darkMetal', { p: [0, -sLen * 0.30, -FRONT * L.shin * 0.95], r: [(160 * DEG) * -FRONT, 0, 0], mirror, tier: TIER.SECONDARY });
    rig.glow(`knee_${S}`, latheProfile([{ r: 0, y: 0 }, { r: L.shin * 0.22, y: 0 }, { r: 0, y: 0.008 }], 16), 'vents',
      { p: [0, -sLen * 0.38, -FRONT * L.shin * 1.02], r: [(160 * DEG) * -FRONT, 0, 0], mirror });
    rig.emitter('thruster', `knee_${S}`, [0, -sLen * 0.40, -FRONT * L.shin * 1.05], [0, -0.4, -FRONT], 0.04);
  } else {
    rig.plated(`knee_${S}`, {
      y0: -sLen * 0.92, y1: L.shin * 0.44,
      w0: ankleW, w1: kneeW,
      d0: ankleW * 1.04, d1: kneeW * 1.06,
      mat: 'armorPrimary', gap: 0.016, inset: 0.86, round: 0.34, swell: 0.08, swellAt: 0.66, mirror,
    });
    // calf vent stack
    addLouvres(rig, `knee_${S}`, {
      p: [0, -sLen * 0.42, -FRONT * (L.shin * 0.78)], r: [0, YAW_BACK, 0],
      w: L.shin * 0.9, h: sLen * 0.36, n: 4, depth: 0.016, mirror, glow: 'vents',
    });
    rig.add(`knee_${S}`, bevelBox(0.024, sLen * 0.5, L.shin * 0.9, 0.006, { topX: 0.8 }), 'carbon',
      { p: [sign * L.shin * 0.76, -sLen * 0.42, 0], mirror, tier: TIER.SECONDARY });
  }
  addPanelDetail(rig, `knee_${S}`, {
    p: [0, -sLen * 0.46, FRONT * (L.shin * 0.76 + 0.004)], r: [0, YAW_FRONT, 0],
    w: L.shin * 1.08, h: sLen * 0.46, bolts: 4, splitsY: [0.24], splitsX: [], mirror,
  });
  rig.decal(`knee_${S}`, DECAL.RIVETS, L.shin * 1.1, L.shin * 0.28, {
    p: [0, -sLen * 0.16, FRONT * (L.shin * 0.80)], r: [0, YAW_FRONT, 0], mirror, tier: TIER.GREEBLE,
  });

  // --- ankle
  // Radius stays under the ankle's height above the floor plane, or the joint
  // housing would clip through the ground on a flat-footed stance.
  const ankleR = Math.min(ankleW * 0.44, m.ankle * 0.62);
  rig.add(`ankle_${S}`, latheProfile([
    { r: 0, y: -ankleW * 0.24 }, { r: ankleR * 0.88, y: -ankleW * 0.24 }, { r: ankleR, y: -ankleW * 0.14, smooth: true },
    { r: ankleR, y: ankleW * 0.14 }, { r: ankleR * 0.78, y: ankleW * 0.24 }, { r: 0, y: ankleW * 0.24 },
  ], 20), 'darkMetal', { world: true, p: [0, 0.006, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY });

  // --- foot
  const fw = L.footW, fl = L.foot;
  if (digi) {
    // slim pad + long toe + rearward heel spur
    rig.add(`foot_${S}`, bevelBox(fw * 1.05, 0.075, fl * 0.62, 0.010,
      { topX: 1.05, botX: 0.86, botZ: 0.9 }), 'armorPrimary',
    { p: [0, 0.020, FRONT * fl * 0.04], mirror, tier: TIER.PRIMARY });
    rig.add(`foot_${S}`, bevelBox(fw * 0.55, 0.05, fl * 0.42, 0.008, { topX: 0.9, botZ: 0.6, shearZ: -FRONT * 0.05 }), 'armorSecondary',
      { p: [0, 0.055, -FRONT * fl * 0.34], r: [-30 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`toe_${S}`, bevelBox(fw * 0.95, 0.055, fl * 0.55, 0.008,
      { topX: 0.85, botX: 0.62, botZ: 0.55, shearZ: FRONT * 0.03 }), 'armorPrimary',
    { p: [0, 0.047, FRONT * fl * 0.10], mirror, tier: TIER.PRIMARY });
    for (let i = -1; i <= 1; i++) {
      rig.add(`toe_${S}`, bevelBox(fw * 0.20, 0.030, fl * 0.24, 0.005, { topX: 0.4, topZ: 0.3, shearZ: FRONT * 0.02 }), 'trim',
        { p: [i * fw * 0.30, 0.029, FRONT * fl * 0.34], r: [8 * DEG, 0, 0], mirror, tier: TIER.SECONDARY });
    }
    rig.add(`foot_${S}`, bevelBox(fw * 0.95, 0.020, fl * 0.55, 0.005), 'rubber',
      { p: [0, -0.020, FRONT * fl * 0.04], mirror, tier: TIER.SECONDARY });
  } else {
    // heavy boot: sole, toe cap, ankle collar, cleats
    rig.add(`foot_${S}`, bevelBox(fw * 1.25, 0.11, fl * 0.86, 0.012,
      { topX: 0.90, topZ: 0.86, botX: 1.0, botZ: 1.0, shearZ: FRONT * 0.012 }), 'armorPrimary',
    { p: [0, 0.036, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`foot_${S}`, bevelBox(fw * 1.28, 0.030, fl * 0.90, 0.006), 'rubber',
      { p: [0, -0.015, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`toe_${S}`, bevelBox(fw * 1.1, 0.085, fl * 0.42, 0.010,
      { topX: 0.82, topZ: 0.7, botZ: 0.9, shearZ: FRONT * 0.02 }), 'armorAccent',
    { p: [0, 0.060, FRONT * fl * 0.06], r: [-6 * DEG, 0, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`toe_${S}`, bevelBox(fw * 1.12, 0.022, fl * 0.44, 0.005), 'rubber',
      { p: [0, 0.026, FRONT * fl * 0.06], mirror, tier: TIER.SECONDARY });
    // heel block
    rig.add(`foot_${S}`, bevelBox(fw * 0.9, 0.09, fl * 0.26, 0.008, { topX: 0.85, shearZ: -FRONT * 0.02 }), 'armorSecondary',
      { p: [0, 0.048, -FRONT * fl * 0.40], mirror, tier: TIER.PRIMARY });
    // cleats
    for (let i = 0; i < 3; i++) {
      rig.add(`foot_${S}`, bevelBox(fw * 1.1, 0.012, 0.022, 0.004), 'darkMetal',
        { p: [0, -0.026, FRONT * (fl * 0.26 - i * fl * 0.26)], mirror, tier: TIER.GREEBLE });
    }
    if (splay) {
      for (const o of [-1, 1]) {
        rig.add(`foot_${S}`, bevelBox(fw * 0.34, 0.06, fl * 0.5, 0.007, { topX: 0.6, botZ: 0.9 }), 'armorSecondary',
          { p: [o * fw * 0.72, 0.040, -FRONT * fl * 0.05], r: [0, 0, o * 14 * DEG], mirror, tier: TIER.SECONDARY });
      }
    }
  }
  rig.add(`ankle_${S}`, latheProfile([
    { r: ankleW * 0.44, y: 0.02 }, { r: ankleW * 0.50, y: 0.0, smooth: true }, { r: ankleW * 0.50, y: -0.028 },
    { r: ankleW * 0.41, y: -0.044 },
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

/**
 * Per-character variation.
 *
 * The roster reuses each chassis across several fighters, so palette alone is
 * not enough separation — two heavies must not be the same model in different
 * paint. This adds a handful of seeded hardware choices on top of the chassis
 * plan. The seed comes from `def.id`, so both players' copies of a character
 * are always identical and nothing here touches the simulation.
 */
function buildVariation(rig, spec, def) {
  const seed = hashId(def?.id ?? def?.name ?? 'kb');
  const rng = new Rng(seed);
  const t = spec.torso;
  const pd = spec.pauldron;
  const back = -FRONT;

  const scaled = scaledPauldron(spec, rig.dim);
  const lame = pauldronLames(scaled)[0];

  // 1. shoulder crest blades — 0, 1 or 2 per side, swept back over the pauldron
  const blades = rng.int(3);
  for (let i = 0; i < blades; i++) {
    const len = 0.16 + rng.range(0, 0.12);
    for (const { s, sign, mirror } of SIDES) {
      const ballX = Math.abs((rig.restPos[`shoulder_${s}`]?.x ?? 0.155)
        - (rig.restPos[`clavicle_${s}`]?.x ?? 0)) * 0.58;
      rig.add(`clavicle_${s}`, loftHull([
        { y: 0, w: 0.024, d: 0.052, round: 0.32 },
        { y: len * 0.55, w: 0.019, d: 0.062, z: back * len * 0.14, round: 0.30, smooth: true },
        { y: len, w: 0.007, d: 0.026, z: back * len * 0.34, round: 0.42 },
      ]), 'armorAccent', {
        p: [sign * (ballX + lame.dx + lame.R * (0.22 + i * 0.26)),
          lame.dy + lame.R * (0.86 - i * 0.10), back * lame.half * 0.30],
        r: [(-20 - i * 10) * DEG, 0, sign * -(40 + i * 14) * DEG],
        mirror, tier: TIER.PRIMARY,
      });
    }
  }

  // 1b. asymmetric shoulder markings.
  //
  // Real hardware is not stencilled symmetrically: the unit roundel goes on one
  // side, the tally chevrons on the other, and that single asymmetry is worth
  // more to the read than another twenty greebles. Materials.js exports no
  // marking atlas as of this writing — if it ever does, swap `DECAL` for it and
  // keep these placements. Until then the flat quad reserves the UV space: each
  // sits on its own atlas cell with a 0.002 edge trim, and the surface under it
  // is left clear of panel strips so a larger marking can grow into it.
  const numberSide = rng.sign();
  for (const { s, sign, mirror } of SIDES) {
    const ballX = Math.abs((rig.restPos[`shoulder_${s}`]?.x ?? 0.155)
      - (rig.restPos[`clavicle_${s}`]?.x ?? 0)) * 0.58;
    const marked = sign === numberSide;
    rig.decal(`clavicle_${s}`, marked ? DECAL.ROUNDEL : DECAL.CHEVRON,
      lame.R * 0.62, lame.R * 0.62, {
        p: [sign * (ballX + lame.dx + lame.R * 0.34), lame.dy + lame.R * 0.30,
          FRONT * (lame.half + 0.008)],
        r: [0, YAW_FRONT, sign * (marked ? -14 : 8) * DEG], mirror, tier: TIER.GREEBLE,
      });
  }
  rig.decal(`clavicle_${numberSide > 0 ? 'R' : 'L'}`, DECAL.HAZARD, scaled.d * 0.44, 0.034, {
    p: [-numberSide * (scaled.out + scaled.w * 0.30), lame.dy + lame.R * 0.70, 0],
    r: [-72 * DEG, 0, numberSide * 18 * DEG], mirror: numberSide > 0, tier: TIER.GREEBLE,
  });

  // 2. hip stowage: an ammo drum or a utility block on one side
  const stow = rng.int(3);
  if (stow > 0) {
    const sign = rng.sign();
    const mirror = sign < 0;
    if (stow === 1) {
      rig.add('hips', latheProfile([
        { r: 0, y: -0.055 }, { r: 0.052, y: -0.055 }, { r: 0.058, y: -0.042, smooth: true },
        { r: 0.058, y: 0.042, smooth: true }, { r: 0.052, y: 0.055 }, { r: 0, y: 0.055 },
      ], 16), 'darkMetal', {
        p: [sign * t.pelvisW * 0.56, -0.04, back * t.waistD * 0.30],
        r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY,
      });
      rig.add('hips', boltRing(6, 0.038, 0.008, 0.010), 'trim', {
        p: [sign * (t.pelvisW * 0.56 + 0.056), -0.04, back * t.waistD * 0.30],
        r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.GREEBLE,
      });
    } else {
      rig.add('hips', bevelBox(0.075, 0.15, 0.11, 0.010, { topX: 0.82, topZ: 0.86 }), 'armorSecondary', {
        p: [sign * t.pelvisW * 0.58, -0.05, back * t.waistD * 0.22],
        r: [0, 0, sign * -8 * DEG], mirror, tier: TIER.PRIMARY,
      });
      rig.decal('hips', DECAL.BARCODE, 0.06, 0.03, {
        p: [sign * (t.pelvisW * 0.58 + 0.040), -0.05, back * t.waistD * 0.22],
        r: [0, sign * 90 * DEG, 0], mirror, tier: TIER.GREEBLE,
      });
    }
  }

  // 3. dorsal antenna mast — height and count vary
  const masts = rng.int(3);
  for (let i = 0; i < masts; i++) {
    const sx = i === 0 ? 0 : (i === 1 ? 1 : -1);
    const len = 0.16 + rng.range(0, 0.22);
    rig.add('chest', latheProfile([
      { r: 0.009, y: 0 }, { r: 0.009, y: len * 0.30 }, { r: 0.0045, y: len * 0.33 },
      { r: 0.0045, y: len }, { r: 0, y: len + 0.012 },
    ], 10), 'trim', {
      p: [sx * t.chestW * 0.22, 0.20, back * (t.chestD * 0.5 + 0.03)],
      r: [-(10 + i * 6) * DEG, 0, sx * 9 * DEG], tier: TIER.SECONDARY,
    });
    rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.009, y: 0 }, { r: 0, y: 0.011 }], 8), 'joints', {
      p: [sx * t.chestW * 0.22, 0.20 + len * 0.98, back * (t.chestD * 0.5 + 0.03) + len * 0.16 * FRONT],
    });
  }

  // 4. torso insignia plate, placed off-centre and rotated per character
  const cell = rng.pick([DECAL.ROUNDEL, DECAL.TRIANGLE, DECAL.CHEVRON, DECAL.GAUGE, DECAL.CAUTION]);
  rig.decal('spine02', cell, 0.075, 0.075, {
    p: [rng.sign() * t.waistW * 0.44, 0.02, back * (t.waistD * 0.60)],
    r: [0, YAW_BACK, rng.range(-0.2, 0.2)], tier: TIER.GREEBLE,
  });

  // 5. an extra armour rib across the abdomen, or a bare segmented gap
  if (rng.next() < 0.55) {
    const ribs = 2 + rng.int(2);
    for (let i = 0; i < ribs; i++) {
      rig.add('spine01', bevelBox(t.waistW * (0.52 + i * 0.10), 0.020, 0.026, 0.005), 'trim', {
        p: [0, 0.010 + i * 0.036, FRONT * (t.waistD * 0.5 + 0.016)],
        r: [(8 - i * 6) * DEG, 0, 0], tier: TIER.GREEBLE,
      });
    }
  }
}

/** Stable 32-bit hash of a character id, so a seed never depends on load order. */
function hashId(id) {
  let h = 0x811c9dc5;
  const str = String(id);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

// ---------------------------------------------------------------------------
// Joint mechanism: actuators + cable looms
// ---------------------------------------------------------------------------

function buildMechanism(rig, spec) {
  const t = spec.torso;
  const m = rig.dim;
  const a = { upper: spec.arms.upper * m.armK, fore: spec.arms.fore * m.armK };
  const L = {
    thigh: Math.min(spec.legs.thigh * m.legK, m.hipSep * 0.92),
    shin: Math.min(spec.legs.shin * m.legK, m.hipSep * 0.80),
    foot: spec.legs.foot * m.legS,
    footW: Math.min(spec.legs.footW * m.legK, m.hipSep * 0.80),
  };
  const back = -FRONT; // +1 toward the robot's back in local Z terms
  const k = spec.bulk; // a brute's hydraulics are visibly fatter than a scout's

  // Every anchor below is a fraction of a measured segment, never a literal
  // metre value — a ram that does not follow its bone is a ram that floats.

  // waist actuators (twin, either side of the spine)
  for (const { sign } of SIDES) {
    rig.actuator('hips', [sign * t.waistW * 0.42, m.lumbar * 0.42, back * t.waistD * 0.42],
      'spine02', [sign * t.waistW * 0.44, m.thorax * 0.30, back * t.waistD * 0.46], { radius: 0.022 * k });
  }
  // neck actuator
  rig.actuator('chest', [0, m.collar * 0.72, back * 0.075], 'head', [0, m.skull * 0.10, back * 0.075],
    { radius: 0.014 * k, rodRatio: 0.55 });

  for (const { s, sign } of SIDES) {
    // shoulder — anchored on the clavicle just above and behind the ball joint,
    // so the ram sweeps with the arm instead of collapsing across the pivot
    rig.actuator(`clavicle_${s}`, [sign * 0.155 * m.armS, 0.105 * m.armS, back * 0.10],
      `shoulder_${s}`, [0, -m.upper * 0.55, back * a.upper * 1.0], { radius: 0.020 * k });
    // elbow
    rig.actuator(`shoulder_${s}`, [sign * a.upper * 0.40, -m.upper * 0.69, back * a.upper * 0.80],
      `elbow_${s}`, [sign * a.fore * 0.40, -m.fore * 0.31, back * a.fore * 0.80], { radius: 0.018 * k });
    // wrist
    rig.actuator(`elbow_${s}`, [sign * a.fore * 0.55, -m.fore * 0.63, back * a.fore * 0.60],
      `wrist_${s}`, [sign * a.fore * 0.42, 0.0, back * a.fore * 0.55], { radius: 0.012 * k, rodRatio: 0.5 });
    // hip
    rig.actuator('hips', [sign * t.pelvisW * 0.50, m.lumbar * 0.14, back * t.waistD * 0.44],
      `hip_${s}`, [sign * L.thigh * 0.78, -m.thigh * 0.34, back * L.thigh * 0.62], { radius: 0.022 * k });
    // knee
    // front-mounted so flexion EXTENDS it: the knee folds backwards, so a rear
    // ram would collapse into its own housing
    rig.actuator(`hip_${s}`, [sign * L.thigh * 0.80, -m.thigh * 0.57, -back * L.thigh * 0.60],
      `knee_${s}`, [sign * L.shin * 0.80, -m.shin * 0.31, -back * L.shin * 0.62], { radius: 0.022 * k });
    // ankle
    rig.actuator(`knee_${s}`, [sign * L.shin * 0.60, -m.shin * 0.64, back * L.shin * 0.74],
      `foot_${s}`, [sign * L.footW * 0.52, 0.04, back * L.foot * 0.34], { radius: 0.016 * k, rodRatio: 0.5 });
  }

  // --- cable looms -------------------------------------------------------
  rig.cable('hips', [0, m.lumbar * 0.70, back * t.waistD * 0.62], 'chest', [0, -m.thorax * 0.24, back * t.chestD * 0.52],
    { sag: 0.031, radius: 0.0079 * k, strands: 3, twists: 2.0 });

  for (const { s, sign } of SIDES) {
    rig.cable('chest', [sign * t.chestW * 0.26, m.collar * 0.10, back * t.chestD * 0.44],
      `shoulder_${s}`, [0, -m.upper * 0.48, back * a.upper * 0.55], { sag: 0.020, radius: 0.0072 * k });
    rig.cable(`shoulder_${s}`, [sign * a.upper * 0.5, -m.upper * 0.76, back * a.upper * 0.7],
      `elbow_${s}`, [sign * a.fore * 0.5, -m.fore * 0.22, back * a.fore * 0.7], { sag: 0.022, radius: 0.0065 * k });
    rig.cable('hips', [sign * t.pelvisW * 0.34, -0.02, back * t.waistD * 0.55],
      `hip_${s}`, [sign * L.thigh * 0.5, -m.thigh * 0.41, back * L.thigh * 0.85], { sag: 0.025, radius: 0.0072 * k });
    rig.cable(`hip_${s}`, [sign * L.thigh * 0.55, -m.thigh * 0.68, back * L.thigh * 0.9],
      `knee_${s}`, [sign * L.shin * 0.55, -m.shin * 0.24, back * L.shin * 0.9], { sag: 0.022, radius: 0.0065 * k });
    rig.cable(`knee_${s}`, [sign * L.shin * 0.45, -m.shin * 0.79, back * L.shin * 0.75],
      `foot_${s}`, [sign * L.footW * 0.40, 0.03, back * L.foot * 0.25], { sag: 0.015, radius: 0.0058 * k, strands: 2 });
    // neck loom
    rig.cable('chest', [sign * 0.045, m.collar * 0.84, back * 0.06], 'head', [sign * 0.04, m.skull * 0.05, back * 0.07],
      { sag: 0.011, radius: 0.0050 * k, strands: 2, twists: 1.2 });
  }

  // soft boot shroud: a lathed sleeve spanning ankle to foot, smooth-skinned so
  // it creases instead of shearing when the foot rolls
  const shroud = L.shin * 1.06;
  for (const { s } of SIDES) {
    const g = latheProfile([
      { r: shroud * 0.57, y: 0.0 }, { r: shroud * 0.62, y: -0.022, smooth: true },
      { r: shroud * 0.68, y: -0.050, smooth: true }, { r: shroud * 0.64, y: -0.075 },
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
  buildVariation(rig, spec, def);

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
      // Shadow-caster budget. Every mesh here is one more draw call per cascade,
      // and the emissive strips and decal quads are recessed millimetres-thin
      // surfaces that cannot throw a shadow anyone will ever see — so they stay
      // out of the depth pass entirely. That is ten draw calls per fighter.
      mesh.castShadow = matName !== 'decal' && !matName.startsWith('glow_');
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
  const actuatorRig = new ActuatorRig(rig.actuators, actGeo, mats);
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
