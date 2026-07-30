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
 * the fighter FACES +Z. So "front of the chest" is at positive Z.
 *
 * That last line was wrong until round 8 and it was not a documentation bug. The
 * rig header claimed -Z was forward, this file was written from it, and the
 * result was measurable on the built mesh: the visor centroid sat 0.127m behind
 * the head origin along the facing axis while `toe_*` sat 0.14m in front of the
 * foot. Every fighter's face pointed away from its opponent, every chest core at
 * its own spine, and `02-closeup-face` photographed a nape for seven rounds. The
 * fix is the sign below plus the rake and yaw literals that were authored
 * against it; nothing about the rig changed.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BONES } from './Skeleton.js';
import { LAYER } from '../core/Constants.js';
import { Rng } from '../core/Rng.js';
import { makeMaterialLibrary, makeMarkingAtlas, MARKINGS } from './Materials.js';

const DEG = Math.PI / 180;
const FRONT = 1; // multiply a "forward" offset by this to get world Z

const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Texture density in tiles per metre, shared by every primitive here.
 *
 * Materials.js lays its armour panels out inside the unit tile, so this number
 * is really "how big is a panel". Too high and a fighter at full-body framing
 * wears brickwork — a uniform grid of small rectangles that reads as a texture
 * rather than as designed plating. One tile per metre puts the smallest panel
 * around 6cm and the structural ones around 20cm, which is the proportion the
 * reference uses.
 */
const UV_DENSITY = 1.0;

/**
 * Chamfer width below which a rolled edge cannot resolve, in metres. A 4mm
 * chamfer is under two pixels at full-body framing; subdividing it buys nothing
 * and costs triangles on exactly the greebles there are hundreds of.
 */
const ROLL_MIN = 0.005;

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

  /** Triangle with per-vertex normals, auto-oriented so its winding agrees. */
  triN(a, b, c, na, nb, nc, ua, ub, uc) {
    const ref = [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]];
    if (dot(faceNormal(a, b, c), ref) < 0) this.tri(a, c, b, na, nc, nb, ua, uc, ub);
    else this.tri(a, b, c, na, nb, nc, ua, ub, uc);
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

/** Great-circle interpolation between two unit directions. */
function slerpDir(a, c, t) {
  const om = Math.acos(Math.min(1, Math.max(-1, dot(a, c))));
  const si = Math.sin(om);
  if (si < 1e-6) return [a[0], a[1], a[2]];
  const s0 = Math.sin((1 - t) * om) / si;
  const s1 = Math.sin(t * om) / si;
  return [a[0] * s0 + c[0] * s1, a[1] * s0 + c[1] * s1, a[2] * s0 + c[2] * s1];
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
 * Rolled-chamfer box: six flat faces joined by arced, smooth-shaded edge bands
 * and matching spherical corner patches. `taper` values scale the top/bottom
 * cross-section so one call produces trapezoidal pauldrons and tapering limb
 * armour, and it is the only primitive here allowed to define a primary mass.
 *
 * Why an arc and not one flat facet. A single chamfer quad catches the key light
 * as one hard specular line that snaps on and off as the part turns — the exact
 * tell of a procedural model. A rolled edge carries a highlight that *travels*
 * along the arc as the surface rotates, and that travelling highlight is what
 * the eye reads as machined metal. The band is shaded smoothly across its rings,
 * so even a single-facet roll is a graded ramp between the two face normals
 * rather than a flat quad, and below `ROLL_MIN` the arc is too narrow to resolve
 * at fighting-game distance and stays at one facet for free.
 *
 * Construction is a sphere-swept box: the solid is inset by the chamfer on all
 * three axes, and every surface point is a corner of that core pushed out by the
 * chamfer along a unit direction. Faces, bands and corners therefore share exact
 * vertices and the shell is watertight at any roll count.
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
 * @param {number} [opts.roll] chamfer facets; defaults to 2 above `ROLL_MIN`, else 1
 * @param {number} [opts.uv] UV density in tiles per metre
 * @returns {THREE.BufferGeometry}
 */
export function bevelBox(w, h, d, bevel = 0.012, opts = {}) {
  const { topX = 1, topZ = null, botX = 1, botZ = null, shearX = 0, shearZ = 0, uv = UV_DENSITY } = opts;
  const hx = w * 0.5, hy = h * 0.5, hz = d * 0.5;
  const tX = topX, tZ = topZ ?? topX, bX = botX, bZ = botZ ?? botX;
  const minHalf = Math.min(hx * Math.min(tX, bX), hy, hz * Math.min(tZ, bZ));
  const b = Math.max(1e-4, Math.min(bevel, minHalf * 0.42));
  const R = Math.max(1, Math.round(opts.roll ?? (b >= ROLL_MIN ? 2 : 1)));

  /** A corner of the core box: the solid inset by the chamfer on every axis. */
  const core = (sx, sy, sz) => {
    const kx = hx * (sy > 0 ? tX : bX) - b;
    const kz = hz * (sy > 0 ? tZ : bZ) - b;
    const y = sy * (hy - b);
    const f = y / (hy || 1);
    return [sx * kx + shearX * f, y, sz * kz + shearZ * f];
  };
  /** Surface point: a core corner pushed out along a unit direction. */
  const at = (sx, sy, sz, n) => {
    const c = core(sx, sy, sz);
    return [c[0] + n[0] * b, c[1] + n[1] * b, c[2] + n[2] * b];
  };

  const s = new Surf();
  const S = [-1, 1];
  const AX = (v) => [v, 0, 0];
  const AY = (v) => [0, v, 0];
  const AZ = (v) => [0, 0, v];

  // six flat faces
  for (const sx of S) {
    const n = AX(sx);
    s.flatPoly([at(sx, 1, 1, n), at(sx, 1, -1, n), at(sx, -1, -1, n), at(sx, -1, 1, n)], n, uv);
  }
  for (const sy of S) {
    const n = AY(sy);
    s.flatPoly([at(1, sy, 1, n), at(1, sy, -1, n), at(-1, sy, -1, n), at(-1, sy, 1, n)], n, uv);
  }
  for (const sz of S) {
    const n = AZ(sz);
    s.flatPoly([at(1, 1, sz, n), at(1, -1, sz, n), at(-1, -1, sz, n), at(-1, 1, sz, n)], n, uv);
  }

  // twelve rolled edge bands, swept between the two face normals they join
  const band = (n0, n1, endA, endB) => {
    const ref = [n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]];
    for (let i = 0; i < R; i++) {
      const a = slerpDir(n0, n1, i / R);
      const c = slerpDir(n0, n1, (i + 1) / R);
      const A = at(endA[0], endA[1], endA[2], a);
      const B = at(endB[0], endB[1], endB[2], a);
      const C = at(endB[0], endB[1], endB[2], c);
      const D = at(endA[0], endA[1], endA[2], c);
      s.quad(A, B, C, D, a, a, c, c,
        boxUv(A, ref, uv), boxUv(B, ref, uv), boxUv(C, ref, uv), boxUv(D, ref, uv));
    }
  };
  for (const sx of S) for (const sy of S) band(AX(sx), AY(sy), [sx, sy, -1], [sx, sy, 1]);
  for (const sy of S) for (const sz of S) band(AY(sy), AZ(sz), [-1, sy, sz], [1, sy, sz]);
  for (const sz of S) for (const sx of S) band(AZ(sz), AX(sx), [sx, -1, sz], [sx, 1, sz]);

  // eight corner patches. Each boundary arc is the same equal-angle subdivision
  // the adjoining band uses, so no crack can open between them.
  for (const sx of S) for (const sy of S) for (const sz of S) {
    const ref = [sx, sy, sz];
    const rows = [];
    for (let i = 0; i <= R; i++) {
      const p0 = slerpDir(AX(sx), AY(sy), i / R);
      const p1 = slerpDir(AX(sx), AZ(sz), i / R);
      const row = [];
      for (let k = 0; k <= i; k++) row.push(i === 0 ? p0 : slerpDir(p0, p1, k / i));
      rows.push(row);
    }
    const P = (n) => at(sx, sy, sz, n);
    const U = (n) => boxUv(P(n), ref, uv);
    for (let i = 1; i <= R; i++) {
      const lo = rows[i - 1], hi = rows[i];
      for (let k = 0; k < i; k++) {
        s.triN(P(lo[k]), P(hi[k]), P(hi[k + 1]), lo[k], hi[k], hi[k + 1], U(lo[k]), U(hi[k]), U(hi[k + 1]));
        if (k < i - 1) {
          s.triN(P(lo[k]), P(hi[k + 1]), P(lo[k + 1]), lo[k], hi[k + 1], lo[k + 1], U(lo[k]), U(hi[k + 1]), U(lo[k + 1]));
        }
      }
    }
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
 * @param {number} [opts.uvV] V tiling per metre of profile arc length
 * @returns {THREE.BufferGeometry}
 */
export function latheProfile(profile, segments = 22, opts = {}) {
  const { faceted = false, arc = Math.PI * 2, phase = 0, uvU = 1, uvV = UV_DENSITY } = opts;
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
  const { perQuad = 3, capBottom = true, capTop = true, uv = UV_DENSITY } = opts;
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
// Markings
//
// Warning stripes, stencil codes and roundels belong in a texture, not in
// geometry. Materials.js rasterises the 4x4 stencil atlas — sprayed edges, grit
// breaking up the coverage, ink tinted from the character palette — and the
// builder places paper-thin quads UV'd into one cell each.
// ---------------------------------------------------------------------------

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
function resolveMaterials(environment, palette) {
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

  // Markings are sprayed paint sitting on top of a plate, not a second plate:
  // alphaTest is low because the atlas deliberately thins its own coverage with
  // grit, and clipping that away is what turns a stencil back into a sticker.
  const atlas = markingAtlas(environment, palette);
  if (atlas) {
    mats.decal = new THREE.MeshStandardMaterial({
      map: atlas,
      transparent: true,
      alphaTest: 0.34,
      roughness: 0.62,
      metalness: 0.1,
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

/**
 * The stencil marking atlas for this palette, or null if it cannot be built.
 *
 * Materials.js keys its cache on numeric colours, so the palette's hex strings
 * are converted before they are handed over — passing the strings straight
 * through collapses every character onto one cache entry and every robot ends up
 * wearing the first one's ink.
 */
function markingAtlas(environment, palette) {
  const renderer = environment?.renderer ?? environment?.pmremRenderer ?? null;
  try {
    return makeMarkingAtlas(renderer, {
      accent: new THREE.Color(palette.accent).getHex(),
      trim: new THREE.Color(palette.trim).getHex(),
    });
  } catch {
    return null;
  }
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
   * @param {number} [greeble=1] fraction of tertiary detail to keep, 0..1
   * @param {string} [plating='layered'] key into PLATING_STYLES
   */
  constructor(bones, restWorld, mats, maxTier, greeble = 1, plating = 'layered') {
    this.bones = bones;
    this.byName = Object.create(null);
    this.index = Object.create(null);
    bones.forEach((b, i) => { this.byName[b.name] = b; this.index[b.name] = i; });
    this.restWorld = restWorld;
    this.restPos = Object.create(null);
    for (const [n, m] of Object.entries(restWorld)) this.restPos[n] = new THREE.Vector3().setFromMatrixPosition(m);
    this.mats = mats;
    this.maxTier = maxTier;
    /**
     * Tertiary-detail budget, 0..1. A courier chassis and a foundry chassis do
     * not carry the same amount of bolted-on hardware, and thinning the greeble
     * layer is what separates "sleek" from "crusty" at silhouette distance.
     */
    this.greeble = clamp(greeble, 0, 1);
    /** Panel pitch, gap and fastener policy for this character's plating. */
    this.panel = PLATING_STYLES[plating] ?? PLATING_STYLES.layered;
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
   * Whether a tertiary part should be dropped for this character's greeble
   * budget. The decision is a hash of the plate counter rather than a die roll,
   * so a chassis thins out in the same places every build and both players'
   * copies of a fighter are identical down to the bolt.
   */
  overGreebleBudget(tier) {
    if (tier < TIER.GREEBLE || this.greeble >= 1) return false;
    return plateHash(this.plateCount * 7 + 3)[0] > 0.35 + 0.65 * this.greeble;
  }

  /**
   * Rigid plate: geometry authored in `bone`'s local rest frame (or, with
   * `world: true`, a world-axis-aligned frame anchored at that bone) bound
   * 100% to that bone.
   *
   * `sprung` binds the finished plate to a different bone without moving it.
   * That works because a rigid plate is baked into bind space and skinning
   * multiplies it by `boneWorld * boneRestWorld^-1`, which is the identity at
   * rest for *any* bone: the plate stays exactly where it was authored and
   * simply follows a different hinge. So a reactor pack keeps being placed
   * against the chest in chest coordinates, the way it has to be to line up
   * with the plates around it, and still trails off `pack_L`.
   */
  add(bone, geo, mat, o = {}) {
    if (!geo) return this;
    const tier = o.tier ?? TIER.SECONDARY;
    if (tier > this.maxTier || !this.byName[bone] || this.overGreebleBudget(tier)) {
      geo.dispose?.();
      return this;
    }
    const m = this.frame(bone, o);
    if (!m) { geo.dispose?.(); return this; }
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    // Tile placement and plate bounds are both authored in the primitive's own
    // frame — that is the only space in which "the face this vertex is on" and
    // "how far along it" mean anything — so they are taken before the plate is
    // moved into bind space. A decal keeps its UVs: they index one cell of a
    // clamped atlas and moving them would fetch the neighbouring marking.
    tagPlateSurface(g, this.plateCount, m.getMaxScaleOnAxis(), mat !== 'decal');
    tagPlateLayout(g, this.panelPlan(mat, tier, o.role));
    g.applyMatrix4(m);
    if (m.determinant() < 0) flipWinding(g);
    bindRigid(g, this.index[o.sprung != null && this.byName[o.sprung] ? o.sprung : bone]);
    tagPlate(g, this.plateCount++, o.wear ?? WEAR_BY_MAT[mat] ?? 0.6, tier);
    this.parts.push({ geo: g, mat, tier });
    return this;
  }

  /**
   * The panel plan for one plate: how its own face should be divided, how wide
   * the gap is, and whether its perimeter reads as a butted joint or an exposed
   * rolled lip.
   *
   * This is the metadata half of the surfacing fix. `buildPlateDetail()` bakes
   * ONE panel atlas for the whole roster, so a groove in it lands wherever the
   * tile happened to fall: a chest plate and a wrist bracket wear the same cell
   * at the same pitch and forty of them read as patterned sheet rather than as
   * parts somebody laid out. The shader can put a groove on the plate's real
   * boundary because `plateFrame` gives it the bounds — but it cannot know what
   * the plate IS. A structural frame member has no panels on it at all, a
   * pauldron lame is one pressing with a bright ground rim, and a chest deck is
   * three panels bolted to a subframe. Only the builder knows which, so it says.
   *
   * @param {string} mat material key the plate will be batched under
   * @param {number} tier detail tier
   * @param {string} [role] explicit role; inferred from `mat`/`tier` when absent
   */
  panelPlan(mat, tier, role) {
    if (mat === 'decal') return null;
    const key = role ?? (tier >= TIER.GREEBLE ? 'bracket'
      : NO_PANEL_MATS.has(mat) ? 'frame' : 'shell');
    const r = PLATE_ROLES[key] ?? PLATE_ROLES.shell;
    return {
      pitch: r.pitch * this.panel.pitch,
      gap: r.gap * this.panel.gap,
      rim: r.rim,
      bolts: r.bolts && this.panel.bolts,
    };
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
    const geo = loftHull(this.stations(o, cy), { perQuad: o.perQuad ?? 3 });
    return this.add(bone, geo, o.mat, {
      p: [o.x ?? 0, cy, o.z ?? 0],
      r: o.r, mirror: o.mirror, tier: o.tier ?? TIER.PRIMARY, wear: o.wear,
      role: o.role,
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
   * With `bands: 2` the painted run is split again part-way along, so the limb
   * wears two overlapping lames with a shadowed channel of frame between them
   * instead of one continuous painted tube. That channel is the negative space
   * the reference gets from layered plate, and each band's end cap is a real
   * plate edge the rim light can catch.
   *
   * @param {string} bone
   * @param {Object} o same shape as `section`, plus:
   *   `gap` metres of frame left exposed at each end and between bands, `inset`
   *   frame cross-section as a fraction of the armour's, `bands` painted
   *   sections along the run.
   */
  plated(bone, o) {
    const gap = o.gap ?? 0.016;
    const inset = o.inset ?? 0.86;
    const span = o.y1 - o.y0;
    const dir = Math.sign(span) || 1;
    const over = gap * 0.7 * dir;
    this.section(bone, {
      ...o,
      y0: o.y0 - over, y1: o.y1 + over,
      w0: o.w0 * inset, w1: o.w1 * inset,
      d0: (o.d0 ?? o.w0) * inset, d1: (o.d1 ?? o.w1) * inset,
      mat: 'darkMetal', round: 0.5, perQuad: 2, swell: 0,
      tier: TIER.PRIMARY, role: 'frame',
    });

    const cut = Math.abs(gap / span);
    // A band shorter than the gap that made it is a rib, not a plate: fall back
    // to one continuous run rather than shredding a short bone into slivers.
    let bands = Math.max(1, Math.round(o.bands ?? 1));
    while (bands > 1 && (1 - cut * (bands + 1)) / bands < cut * 1.6) bands--;
    const step = (1 - cut * (bands + 1)) / bands;
    const swell = (o.swell ?? 0) / bands;

    const lerp = (a, b, t) => a + (b - a) * t;
    const d0 = o.d0 ?? o.w0, d1 = o.d1 ?? o.w1;
    for (let i = 0; i < bands; i++) {
      const a = cut + i * (step + cut);
      const b = a + step;
      // A band in a run butts its neighbour at both ends, which is different
      // information from a free-standing plate and has to be said out loud: the
      // shader cannot see that the plate above this one exists.
      this.section(bone, {
        ...o, swell, role: 'band',
        y0: lerp(o.y0, o.y1, a), y1: lerp(o.y0, o.y1, b),
        w0: lerp(o.w0, o.w1, a), w1: lerp(o.w0, o.w1, b),
        d0: lerp(d0, d1, a), d1: lerp(d0, d1, b),
      });
    }
    return this;
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
    // A cable is a tube, not a plate: it has no face to bound and no border to
    // bed into anything, so it opts out of the seam rather than growing one
    // around an arbitrary projection of itself. It still has to carry the layout
    // attribute — see `tagPlateLayout` — because it shares a merge batch with
    // rigid parts of the same material.
    tagNoFrame(g);
    tagPlateLayout(g, null);
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

/**
 * Materials that are turned, extruded or moulded rather than pressed from
 * sheet. A hydraulic rod has no panel gaps on it; neither does a rubber boot or
 * a structural frame member, and putting them there is how a procedural robot
 * ends up looking like it was wrapped in wallpaper.
 */
const NO_PANEL_MATS = new Set(['darkMetal', 'piston', 'rubber', 'carbon', 'glass']);

/**
 * Panel plans by plate role, as multipliers on the character's plating style.
 *
 *   pitch  panel pitch as a multiple of the style's; 0 means no panels at all
 *   gap    gap width multiplier
 *   rim    how much of the perimeter reads as an exposed, ground, BRIGHT lip
 *          rather than as a butted joint holding shadow. This is the piece of
 *          adjacency information the shader has no way to derive: it can see
 *          where the plate ends, not whether something is sitting against it.
 *   bolts  whether a fastener row marches along the panel gaps
 */
const PLATE_ROLES = {
  band: { pitch: 1.00, gap: 1.00, rim: 0.12, bolts: true },
  shell: { pitch: 0.86, gap: 0.92, rim: 0.82, bolts: true },
  deck: { pitch: 1.20, gap: 1.10, rim: 0.42, bolts: true },
  lame: { pitch: 0.66, gap: 0.78, rim: 1.00, bolts: false },
  boot: { pitch: 1.35, gap: 1.20, rim: 0.58, bolts: false },
  frame: { pitch: 0, gap: 0, rim: 0.24, bolts: false },
  bracket: { pitch: 0, gap: 0, rim: 1.00, bolts: false },
};

/**
 * Plating styles from the roster's `silhouette.plating`, which until now was
 * documentation only. It is what makes the surfacing per-character rather than
 * per-atlas: a slab-armoured foundry unit is made of a few enormous pressings
 * with wide gaps and visible fasteners, and a filigree ceramic shell is made of
 * many small ones with hairline joints and no fastener on show anywhere.
 */
const PLATING_STYLES = {
  slab: { pitch: 0.27, gap: 0.0062, bolts: true },
  layered: { pitch: 0.185, gap: 0.0045, bolts: true },
  segmented: { pitch: 0.125, gap: 0.0055, bolts: true },
  filigree: { pitch: 0.155, gap: 0.0026, bolts: false },
  skeletal: { pitch: 0.225, gap: 0.0032, bolts: false },
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
/**
 * Metres of perimeter shading around a plate face. A real panel gap on a
 * machine this size is 3-8mm wide and the occlusion out of it reaches perhaps
 * twice that, so the ramp is authored at 13mm and then clamped to a third of
 * the face's own half-extent — a 4cm greeble must not be swallowed whole by the
 * shading meant to bed a 40cm chest plate into its frame.
 */
const SEAM_WIDTH = 0.013;

/** Half-extent scale of the `plateFrame` attribute, in metres. */
const FRAME_RANGE = 1.0;

/**
 * Per-plate surface authoring, applied while the geometry is still in its own
 * local frame. Two things the fragment shader has no way to work out for
 * itself, and one of them is the single most artificial thing about a
 * procedural robot.
 *
 * **Tile placement.** `boxUv` projects about the primitive's own origin, and
 * every primitive here is authored centred, so without this every plate on
 * every character samples the *same* patch of the shared panel atlas. Forty
 * plates then wear one repeated sheet of panelling — the grid reads as a
 * texture printed over the machine rather than as plates that were laid out.
 * A per-plate translation and quarter turn of the tile is what breaks that.
 * Quarter turns only: the atlas panels are axis-aligned, and any other angle
 * shears them across the plate's own edges. The tangent frame three derives
 * from the UV gradient turns with them, so the normal map, the anisotropy axis
 * and the brushed grain all follow — which is correct, since a real part is cut
 * from stock in whatever orientation the nesting gave it.
 *
 * **Plate bounds.** `plateFrame` carries, per vertex, the in-plane coordinate
 * of that vertex on its own face and the face's half-extents, both in metres.
 * It is what lets the shader put a seam on the plate's *actual* boundary
 * instead of wherever the atlas happened to draw one. It has to be a frame
 * rather than a precomputed distance because a chamfered box face is a single
 * quad whose four corners all sit on the border: any per-vertex distance is
 * constant across the whole face and interpolates to nothing.
 *
 * @param {THREE.BufferGeometry} geo non-indexed, in the primitive's local frame
 * @param {number} index monotonic plate counter
 * @param {number} scale uniform world scale the frame matrix will apply
 * @param {boolean} retile whether the tile may be moved; false for atlas decals
 */
function tagPlateSurface(geo, index, scale, retile) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = geo.getAttribute('uv');
  const n = pos ? pos.count : 0;
  if (!n) return;
  const [ha, hb] = plateHash(index * 3 + 1);

  if (retile && uv) {
    const q = (hb * 4) | 0;
    const c = q === 1 ? 0 : q === 2 ? -1 : q === 3 ? 0 : 1;
    const s = q === 1 ? 1 : q === 2 ? 0 : q === 3 ? -1 : 0;
    for (let i = 0; i < n; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      uv.setXY(i, u * c - v * s + ha, u * s + v * c + hb);
    }
    uv.needsUpdate = true;
  }

  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cy = (bb.min.y + bb.max.y) * 0.5;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  const hxe = (bb.max.x - bb.min.x) * 0.5 * scale;
  const hye = (bb.max.y - bb.min.y) * 0.5 * scale;
  const hze = (bb.max.z - bb.min.z) * 0.5 * scale;
  const K = 1 / FRAME_RANGE;
  const frame = new Int16Array(n * 4);
  const put = (o, u, v, hu, hv) => {
    frame[o] = clamp(u * K, -1, 1) * 32767;
    frame[o + 1] = clamp(v * K, -1, 1) * 32767;
    frame[o + 2] = clamp(hu * K, 0, 1) * 32767;
    frame[o + 3] = clamp(hv * K, 0, 1) * 32767;
  };
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(nrm ? nrm.getX(i) : 0);
    const ay = Math.abs(nrm ? nrm.getY(i) : 1);
    const az = Math.abs(nrm ? nrm.getZ(i) : 0);
    const o = i * 4;
    // The same dominant-axis rule `boxUv` projects with, so the frame and the
    // tile agree about which two axes lie in the face.
    if (ax >= ay && ax >= az) put(o, (pos.getZ(i) - cz) * scale, (pos.getY(i) - cy) * scale, hze, hye);
    else if (ay >= az) put(o, (pos.getX(i) - cx) * scale, (pos.getZ(i) - cz) * scale, hxe, hze);
    else put(o, (pos.getX(i) - cx) * scale, (pos.getY(i) - cy) * scale, hxe, hye);
  }
  geo.setAttribute('plateFrame', new THREE.Int16BufferAttribute(frame, 4, true));
}

/**
 * Write the plate's panel plan onto its vertices.
 *
 *   attribute vec4 plateLayout;  // Uint8, NOT normalised — read as 0..255
 *     .x  panel pitch in centimetres; 0 means this plate has no panels
 *     .y  panel gap width in tenths of a millimetre
 *     .z  exposed-rim fraction * 255; 0 = butted joint, 255 = free ground edge
 *     .w  flags; bit 0 = march a fastener row along the panel gaps
 *
 * A null plan writes `(0, 0, 0, 0)` — "no panels, butted, no fasteners" — rather
 * than skipping the attribute. Skipping it is not free: `mergeGeometries` refuses
 * any batch whose members disagree about which attributes exist, and it refuses
 * the *whole* batch, so one untagged cable in the rubber batch deleted every
 * rubber part on every fighter in the roster. Uniform attribute sets are a
 * correctness requirement here, not a tidiness one.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {?{pitch:number, gap:number, rim:number, bolts:boolean}} plan
 */
function tagPlateLayout(geo, plan) {
  const n = geo.getAttribute('position')?.count ?? 0;
  if (!n) return;
  const px = plan ? Math.min(255, Math.round(plan.pitch * 100)) : 0;
  const gp = plan ? Math.min(255, Math.round(plan.gap * 10000)) : 0;
  const rm = plan ? Math.round(clamp(plan.rim, 0, 1) * 255) : 0;
  const fl = plan && plan.bolts ? 1 : 0;
  const a = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    a[i * 4] = px; a[i * 4 + 1] = gp; a[i * 4 + 2] = rm; a[i * 4 + 3] = fl;
  }
  geo.setAttribute('plateLayout', new THREE.Uint8BufferAttribute(a, 4, false));
}

/** A plate frame that asks for no seam at all, for parts with no faces to bound. */
function tagNoFrame(geo) {
  const n = geo.getAttribute('position')?.count ?? 0;
  if (!n) return;
  geo.setAttribute('plateFrame', new THREE.Int16BufferAttribute(new Int16Array(n * 4), 4, true));
}

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
// The chassis sets the *engineering* — plate thickness, joint hardware, how much
// actuator is on show, how fat the hydraulics are. It deliberately does NOT set
// the shape any more. Five chassis serve ten fighters, so as long as the chassis
// chose the head, the torso mass and the back unit, two fighters were always the
// same model in different paint, and the roster read as one product family.
// Those four decisions now come from `def.build` (see roster.js) and the chassis
// only supplies a fallback for a character that has not named one.
// ---------------------------------------------------------------------------

const CHASSIS = {
  heavy: {
    bulk: 1.00,
    torso: { chestW: 0.52, chestD: 0.32, chestH: 0.30, waistW: 0.30, waistD: 0.25, pelvisW: 0.40 },
    pauldron: { w: 0.235, h: 0.215, d: 0.26, taper: 0.62, out: 0.055, up: 0.05, tilt: 20, layers: 3 },
    arms: { upper: 0.155, fore: 0.145, gauntlet: 1.0 },
    legs: { plan: 'plantigrade', thigh: 0.19, shin: 0.165, foot: 0.30, footW: 0.19 },
    head: 'furnace',
    plan: 'barrel',
    core: 'hex',
    back: 'reactor',
    mark: 'stacks',
    skirt: true,
  },
  agile: {
    bulk: 0.80,
    torso: { chestW: 0.40, chestD: 0.26, chestH: 0.29, waistW: 0.23, waistD: 0.19, pelvisW: 0.31 },
    pauldron: { w: 0.145, h: 0.17, d: 0.20, taper: 0.5, out: 0.03, up: 0.035, tilt: 32, layers: 2 },
    arms: { upper: 0.108, fore: 0.10, gauntlet: 0.45 },
    legs: { plan: 'digitigrade', thigh: 0.125, shin: 0.105, foot: 0.30, footW: 0.125 },
    head: 'swept',
    plan: 'keel',
    core: 'slit',
    back: 'thrusters',
    mark: 'canards',
    skirt: false,
  },
  brute: {
    bulk: 1.15,
    torso: { chestW: 0.58, chestD: 0.37, chestH: 0.27, waistW: 0.32, waistD: 0.27, pelvisW: 0.44 },
    pauldron: { w: 0.265, h: 0.245, d: 0.30, taper: 0.78, out: 0.065, up: 0.075, tilt: 12, layers: 3 },
    arms: { upper: 0.185, fore: 0.175, gauntlet: 1.35 },
    legs: { plan: 'splayed', thigh: 0.215, shin: 0.19, foot: 0.32, footW: 0.225 },
    head: 'turret',
    plan: 'hump',
    core: 'cage',
    back: 'drum',
    mark: 'hook',
    skirt: false,
  },
  precision: {
    bulk: 0.88,
    torso: { chestW: 0.43, chestD: 0.28, chestH: 0.31, waistW: 0.25, waistD: 0.21, pelvisW: 0.33 },
    pauldron: { w: 0.165, h: 0.19, d: 0.215, taper: 0.55, out: 0.035, up: 0.045, tilt: 26, layers: 2 },
    arms: { upper: 0.118, fore: 0.112, gauntlet: 0.6 },
    legs: { plan: 'plantigrade', thigh: 0.145, shin: 0.125, foot: 0.29, footW: 0.145 },
    head: 'mono',
    plan: 'reference',
    core: 'column',
    back: 'none',
    mark: 'yoke',
    skirt: false,
  },
  arcane: {
    bulk: 0.92,
    torso: { chestW: 0.45, chestD: 0.29, chestH: 0.32, waistW: 0.24, waistD: 0.20, pelvisW: 0.34 },
    pauldron: { w: 0.18, h: 0.205, d: 0.235, taper: 0.45, out: 0.05, up: 0.075, tilt: 34, layers: 2 },
    arms: { upper: 0.125, fore: 0.118, gauntlet: 0.7 },
    legs: { plan: 'digitigrade', thigh: 0.15, shin: 0.128, foot: 0.29, footW: 0.135 },
    head: 'crown',
    plan: 'column',
    core: 'crystal',
    back: 'wings',
    mark: 'fan',
    skirt: true,
  },
};

const SIDES = [
  { s: 'L', sign: 1, mirror: false },
  { s: 'R', sign: -1, mirror: true },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const LEG_PLANS = ['plantigrade', 'digitigrade', 'splayed', 'piston'];

/**
 * The ten body masses.
 *
 * Every entry is a `[width, depth]` multiplier on the shared torso column at
 * each of its six stations, plus how the column is *shaped* rather than merely
 * scaled. This table is the single biggest lever on the requirement it exists
 * for: the torso is 40% of the silhouette's area, so two fighters whose torso
 * profiles differ cannot read as one another however similar their limbs are.
 *
 *   round   corner radius of the cross-section, as a fraction of the smaller
 *           half-extent. 0.10 is a machined box, 0.95 is a cylinder. Nothing
 *           else here changes the read as cheaply.
 *   rake    degrees the whole thorax leans forward over the hips. A hunched
 *           insect and an upright guardsman differ mostly in this one number.
 *   hunch   how far the shoulder deck climbs and retreats behind the collar,
 *           in metres, which is what buries a head or exposes it.
 *   gap     panel-gap width on the torso bands, in metres. A lacquered cuirass
 *           has almost none and a salvage-welded brute has a lot.
 *   pauldron  multipliers on the chassis's shoulder armour, plus `layers` and
 *           `taper` overrides and a `slab` flag. Measured: the stacked lames
 *           were the same three shells at the same height on all ten fighters
 *           and the upper third of the silhouette overlapped 0.65 on average
 *           because of it. Shoulder mass belongs to the body mass — the fighter
 *           whose identity is its belly should not have the same pauldrons as
 *           the one whose identity is its shoulders.
 */
const TORSO_PLANS = {
  barrel: {
    pelvis: [1.14, 1.30], waistLo: [1.38, 1.48], waistHi: [1.34, 1.46],
    ribs: [1.02, 1.14], chest: [0.88, 1.00], yoke: [0.80, 0.90],
    round: 0.48, rake: -3, hunch: 0, gap: 0.024,
    pauldron: { w: 0.86, h: 0.90, d: 0.94, layers: 2 },
  },
  // A keel is a bird's breastbone: narrow across, very deep front-to-back, and
  // carried high. Measured: at [0.86, 1.28] the chest was only a sixth deeper
  // than it was wide and KESTREL's profile was a rectangle the same as ANVIL's
  // — the one view the fight camera actually frames. Taking the width down and
  // the depth up turns it into a wedge pointing where the fighter is going.
  keel: {
    pelvis: [0.86, 0.98], waistLo: [0.72, 1.02], waistHi: [0.74, 1.18],
    ribs: [0.76, 1.42], chest: [0.74, 1.56], yoke: [0.78, 1.20],
    round: 0.34, rake: -11, hunch: 0.004, gap: 0.014,
    pauldron: { w: 0.74, h: 0.80, d: 0.90, layers: 2 },
  },
  hump: {
    pelvis: [1.00, 1.02], waistLo: [0.98, 1.06], waistHi: [1.06, 1.16],
    ribs: [1.16, 1.26], chest: [1.18, 1.32], yoke: [1.18, 1.36],
    round: 0.42, rake: 6, hunch: 0.072, gap: 0.030,
    pauldron: { w: 1.24, h: 1.22, d: 1.26, layers: 3, taper: 0.96 },
  },
  column: {
    pelvis: [0.84, 0.86], waistLo: [0.76, 0.80], waistHi: [0.78, 0.84],
    ribs: [0.82, 0.86], chest: [0.84, 0.88], yoke: [0.92, 0.92],
    round: 0.40, rake: -2, hunch: 0.014, gap: 0.012,
    pauldron: { w: 0.90, h: 1.34, d: 0.74, layers: 3, taper: 0.26 },
  },
  // Lacquered plate armour: a broad flat breast over a cinched waist, leaning
  // very slightly back so the chest is presented. The negative rake is what
  // separates RONIN from MANTIS, whose thorax is thrown as far the other way.
  cuirass: {
    pelvis: [1.04, 0.98], waistLo: [0.76, 0.86], waistHi: [0.84, 0.92],
    ribs: [1.02, 0.92], chest: [1.10, 0.90], yoke: [1.26, 0.92],
    round: 0.22, rake: -7, hunch: 0.020, gap: 0.010,
    pauldron: { w: 1.24, h: 1.06, d: 1.20, layers: 2, taper: 0.72 },
  },
  // The only fighter whose thorax is not roughly vertical. A 19-degree rake was
  // still legible as "standing up straight" at 100 pixels and MANTIS measured
  // 0.095 against KESTREL on its most-alike view; at 36 the chest is genuinely
  // out over the toes and the profile is a horizontal mass, which is the one
  // shape no other body plan in the cast can make.
  carapace: {
    pelvis: [0.94, 1.18], waistLo: [0.82, 1.26], waistHi: [0.84, 1.40],
    ribs: [0.90, 1.52], chest: [0.92, 1.58], yoke: [0.84, 1.30],
    round: 0.56, rake: 36, hunch: 0.088, gap: 0.018,
    pauldron: { w: 0.56, h: 0.62, d: 0.72, layers: 1 },
  },
  // Skeletal means the frame shows. The waist is the narrowest in the cast by a
  // wide margin, which is what lets NYX's oversized lantern head read as a head
  // on a stalk rather than as one more helmet.
  skeletal: {
    pelvis: [0.86, 0.90], waistLo: [0.54, 0.62], waistHi: [0.58, 0.68],
    ribs: [0.84, 0.92], chest: [0.92, 1.00], yoke: [1.04, 0.98],
    round: 0.38, rake: 2, hunch: 0.006, gap: 0.020,
    pauldron: { w: 0.84, h: 0.90, d: 0.82, layers: 1 },
  },
  wall: {
    pelvis: [1.16, 1.00], waistLo: [1.22, 1.02], waistHi: [1.28, 1.04],
    ribs: [1.26, 1.04], chest: [1.24, 1.06], yoke: [1.22, 1.06],
    round: 0.10, rake: 0, hunch: 0.008, gap: 0.022,
    pauldron: { w: 1.22, h: 1.14, d: 1.12, layers: 1, slab: true },
  },
  // AXIOM is the only fighter with nothing bolted to it, so its read has to be
  // the shape itself: one continuous ovoid from hip to collar, the highest
  // corner radius on any armoured plan in the cast, and no shoulder deck step.
  // Left at literal unity it was simply the smallest generic humanoid and it
  // measured 0.085 against RONIN — the closest pair on the sheet.
  reference: {
    pelvis: [0.98, 0.98], waistLo: [0.90, 0.92], waistHi: [1.02, 1.04],
    ribs: [1.08, 1.08], chest: [1.04, 1.04], yoke: [0.82, 0.84],
    round: 0.74, rake: 0, hunch: 0.002, gap: 0.009,
    pauldron: { w: 0.94, h: 0.92, d: 1.00, layers: 2 },
  },
  // VOLTA's can carries its mass at the RIBS, where VULKAN's barrel carries it
  // at the waist. Measured: with both peaking at the waist the two silhouettes
  // overlapped 0.796, which for two fighters on different chassis is a failure.
  drum: {
    pelvis: [0.96, 1.02], waistLo: [1.02, 1.14], waistHi: [1.16, 1.30],
    ribs: [1.30, 1.42], chest: [1.24, 1.38], yoke: [0.88, 0.98],
    round: 0.92, rake: 0, hunch: 0.004, gap: 0.020,
    pauldron: { w: 0.70, h: 0.76, d: 0.80, layers: 1 },
  },
};

/**
 * The dorsal units `buildBackHardware` can grow. Kept as a lookup rather than
 * read off the switch so `chassisFor` can reject a name nothing builds instead
 * of silently handing every unknown value the `none` case.
 */
const DORSAL_UNITS = Object.freeze({
  reactor: 1, thrusters: 1, drum: 1, wings: 1, spine: 1,
  elytra: 1, coil: 1, tank: 1, ladder: 1, none: 1,
});

/** Chest-core style per body mass, so a plan cannot inherit a chassis-mate's. */
const PLAN_CORE = {
  barrel: 'hex', keel: 'slit', hump: 'cage', column: 'crystal', cuirass: 'column',
  carapace: 'slit', skeletal: 'crystal', wall: 'hex', reference: 'column', drum: 'cage',
};

/**
 * The chassis plan, resolved against the roster's `build` and `silhouette`.
 *
 * `build` names hero forms and is taken literally — it is a choice, not a
 * measurement. `silhouette`'s scalars are *impressions* (`shoulders: 1.5` means
 * "reads broad", not "is 50% wider") and are applied at reduced strength, or a
 * heavy's pauldrons go through its own head. The counts — cables, spikes, vents
 * — are taken at face value, because counting hardware is what they are for.
 *
 * @param {Object} def CharacterDef
 * @returns {Object} a CHASSIS entry, resolved, plus `plan`, `plating` and the
 *   hardware counts
 */
function chassisFor(def) {
  const base = CHASSIS[def?.chassis] || CHASSIS.heavy;
  const sil = def?.silhouette || {};
  const b = def?.build || {};
  const num = (v, dflt, lo, hi) => clamp(Number.isFinite(v) ? v : dflt, lo, hi);
  const pick = (v, table, dflt) => (v && Object.prototype.hasOwnProperty.call(table, v) ? v : dflt);
  const sh = num(sil.shoulders, 1, 0.7, 1.6);
  const cd = num(sil.chestDepth, 1, 0.7, 1.4);
  const wa = num(sil.waist, 1, 0.55, 1.25);
  const shK = 0.55 + 0.45 * sh;
  const planId = pick(b.torso, TORSO_PLANS, base.plan);
  const legPlan = b.legs ?? sil.legs;

  return {
    ...base,
    head: pick(b.head, HEAD_BUILDERS, base.head),
    back: pick(b.dorsal, DORSAL_UNITS, base.back),
    mark: pick(b.mark, MARK_BUILDERS, base.mark),
    planId,
    plan: TORSO_PLANS[planId],
    core: PLAN_CORE[planId] ?? base.core,
    plating: sil.plating ?? 'layered',
    torso: {
      ...base.torso,
      chestW: base.torso.chestW * (0.72 + 0.28 * sh),
      chestD: base.torso.chestD * (0.5 + 0.5 * cd),
      waistW: base.torso.waistW * (0.35 + 0.65 * wa),
      waistD: base.torso.waistD * (0.45 + 0.55 * wa),
    },
    pauldron: (() => {
      const o = TORSO_PLANS[planId].pauldron ?? {};
      return {
        ...base.pauldron,
        w: base.pauldron.w * shK * (o.w ?? 1),
        h: base.pauldron.h * (0.7 + 0.3 * sh) * (o.h ?? 1),
        d: base.pauldron.d * shK * (o.d ?? 1),
        out: base.pauldron.out * shK * (o.w ?? 1),
        layers: o.layers ?? base.pauldron.layers,
        taper: o.taper ?? base.pauldron.taper,
        slab: !!o.slab,
      };
    })(),
    legs: {
      ...base.legs,
      plan: LEG_PLANS.includes(legPlan) ? legPlan : base.legs.plan,
    },
    // A skirt of hanging plates is a silhouette decision, not a chassis one, and
    // it belongs to exactly one fighter. Keyed off the chassis it landed on five
    // of the ten — the same seven-plate girdle at the same height on half the
    // cast, measurably the largest shared outline element below the shoulders.
    // RONIN's kusazuri is authored by its own body mass and is a different
    // construction, so it does not want this one as well.
    skirt: planId === 'barrel',
    greeble: num(sil.greeble, 0.7, 0, 1),
    cables: Math.round(num(sil.cables, 4, 0, 8)),
    spikes: Math.round(num(sil.spikes, 2, 0, 6)),
    vents: Math.round(num(sil.vents, 5, 2, 10)),
  };
}

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

/**
 * Cross-section of the torso column at each bone station.
 *
 * Neighbouring plates read the SAME entry where they meet, so the column tapers
 * continuously from pelvis to collar instead of stepping between four boxes of
 * unrelated width. Every station is a width/depth pair in metres, and the body
 * mass named in `def.build.torso` multiplies each one independently — which is
 * what lets a barrel put its mass at the waist and a hunch put the same mass on
 * the shoulder deck without either becoming merely a bigger version of the
 * other.
 */
function torsoStations(spec) {
  const t = spec.torso;
  const p = spec.plan ?? TORSO_PLANS.reference;
  const at = (key, w, d) => ({ w: w * p[key][0], d: d * p[key][1] });
  return {
    pelvis: at('pelvis', t.pelvisW * 0.98, t.waistD * 1.12),
    waistLo: at('waistLo', t.waistW * 1.16, t.waistD * 1.04),
    waistHi: at('waistHi', t.waistW * 1.34, t.waistD * 1.14),
    ribs: at('ribs', t.chestW * 0.80, t.chestD * 0.86),
    chest: at('chest', t.chestW, t.chestD),
    yoke: at('yoke', t.chestW * 0.84, t.chestD * 0.86),
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
      const ang = Math.atan2(pl.x, pl.z * FRONT);
      // The flanking plates hang off the belt and should still be settling when
      // the hips have stopped; the front plate is bolted through the crotch
      // guard and does not move, so it stays on `hips`.
      rig.add('hips', bevelBox(pl.w, drop, 0.035, 0.010, { botX: 0.74 }), 'armorAccent', {
        p: [pl.x * w * 0.50, floor + drop * 0.34, pl.z * d * 0.60 * FRONT],
        r: [pl.rot * DEG, ang, 0],
        order: 'YXZ',
        tier: TIER.PRIMARY,
        sprung: pl.x === 0 ? null : `skirt_${pl.x > 0 ? 'L' : 'R'}`,
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

  rig.decal('hips', MARKINGS.HAZARD, w * 0.42, 0.05, {
    p: [0, floor + 0.05, FRONT * (d * 0.5 + 0.052)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
}

function buildTorso(rig, spec, def) {
  const t = spec.torso;
  const m = rig.dim;
  const P = torsoStations(spec);
  const plan = spec.plan;
  // Every loft in the column reads its corner radius and its panel-gap width
  // from the body mass, so a lacquered cuirass is a hard-cornered box with no
  // visible seams and a transformer can is a fluted cylinder. Shading alone
  // never makes those two read as different machines; the cross-section does.
  const rnd = plan.round;
  const gap = plan.gap;

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
    mat: 'armorPrimary', gap, inset: 0.82, round: rnd, swell: -0.06,
    perQuad: rnd > 0.7 ? 5 : 3,
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
    mat: 'armorPrimary', gap: gap * 0.9, inset: 0.84, round: rnd, swell: 0.03,
    perQuad: rnd > 0.7 ? 5 : 3,
  });

  // dorsal spine strip — the reactor line running up the back
  rig.add('spine02', channelStrip(0.05, m.thorax * 0.9, 0.016), 'darkMetal',
    { p: [0, m.thorax * 0.18, -FRONT * (P.waistHi.d * 0.54)], r: FACE_BACK, tier: TIER.SECONDARY });
  for (let i = 0; i < 3; i++) {
    rig.glow('spine02', bevelBox(0.026, 0.03, 0.010, 0.004), 'spine',
      { p: [0, -m.mid * 0.22 + i * m.thorax * 0.30, -FRONT * (P.waistHi.d * 0.54 + 0.004)] });
  }

  rig.decal('spine02', MARKINGS.SERIAL, 0.11, 0.11, {
    p: [P.waistHi.w * 0.34, m.thorax * 0.24, -FRONT * (P.waistHi.d * 0.56)], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE,
  });

  // --- chest --------------------------------------------------------------
  // Read off the resolved stations, not off the raw chassis numbers, or the
  // front planes and the pectorals stay on the chassis's cross-section while
  // the ribcage around them follows the body mass and the two come apart.
  const cw = P.chest.w, cd = P.chest.d, ch = t.chestH;

  // Rake: how far forward the whole thorax leans over the hips, as a Z shift
  // that grows with height. It cannot be a rotation of the chest bone — that is
  // the animator's channel — so it is a shear applied to every plate the column
  // carries. An 19-degree rake is the difference between a hunched insect and an
  // upright guardsman, and it is the single cheapest read in this function.
  const rake = Math.tan(plan.rake * DEG) * FRONT;
  const rz = (y) => rake * y;
  const hunch = plan.hunch;

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
    shearZ: rake * m.thorax * 0.7,
  });

  // Ribcage: one continuous lofted volume rather than two stacked boxes. It
  // flares off the mid-spine handover, swells at the pectoral line and necks
  // back in toward the gorget, and the whole run reads as one machined part.
  const perQ = rnd > 0.7 ? 5 : 3;
  rig.add('chest', loftHull([
    { y: -m.thorax * 0.42, w: P.ribs.w * 0.98, d: P.ribs.d * 0.98, z: rz(-m.thorax * 0.42), round: rnd },
    { y: -m.thorax * 0.04, w: P.chest.w * 0.93, d: P.chest.d * 0.95, z: rz(-m.thorax * 0.04), round: rnd * 0.86, smooth: true },
    { y: m.collar * 0.22, w: P.chest.w, d: P.chest.d, z: rz(m.collar * 0.22), round: rnd * 0.76, smooth: true },
    { y: m.collar * 0.48, w: P.chest.w * 0.94, d: P.chest.d * 0.92, z: rz(m.collar * 0.48), round: rnd * 0.82 },
  ], { perQuad: perQ }), 'armorPrimary', { tier: TIER.PRIMARY });
  // Shoulder deck, lifted clear of the ribcage so the seam holds a shadow, and
  // pushed up and back by `hunch`. That last step is what decides whether the
  // head sits proud of the shoulders or is swallowed by them, and it is the
  // whole difference between a sentry and a hunched carapace.
  rig.add('chest', loftHull([
    { y: m.collar * 0.52, w: P.chest.w * 0.90, d: P.chest.d * 0.90, z: rz(m.collar * 0.52), round: rnd * 0.88 },
    { y: m.collar * 0.72 + hunch * 0.5, w: P.chest.w * 0.88, d: P.chest.d * 0.86 + hunch * 0.9, z: rz(m.collar * 0.72) - FRONT * hunch * 0.7, round: rnd * 0.9, smooth: true },
    { y: m.collar * 0.90 + hunch, w: P.yoke.w, d: P.yoke.d + hunch * 1.2, z: rz(m.collar * 0.90) - FRONT * hunch * 1.5, round: Math.max(rnd, 0.34) },
  ], { perQuad: perQ }), 'armorPrimary', { tier: TIER.PRIMARY });

  // Front planes. Two facets at different rakes with a shadowed split between
  // them: the deck catches the key light square on, the sternum sits in half
  // shade, and the chest finally reads as a form instead of the face of a box.
  rig.add('chest', loftHull([
    { y: -m.thorax * 0.26, w: cw * 0.52, d: 0.034, round: 0.32 },
    { y: 0, w: cw * 0.62, d: 0.044, round: 0.26, smooth: true },
    { y: m.collar * 0.22, w: cw * 0.58, d: 0.040, round: 0.30 },
  ]), 'armorSecondary', {
    p: [0, 0, FRONT * (cd * 0.48)], r: [(9 + plan.rake) * DEG, 0, 0], tier: TIER.PRIMARY,
  });
  rig.add('chest', loftHull([
    { y: m.collar * 0.28, w: cw * 0.66, d: 0.036, round: 0.28 },
    { y: m.collar * 0.56, w: cw * 0.62, d: 0.030, round: 0.30, smooth: true },
    { y: m.collar * 0.82, w: cw * 0.44, d: 0.024, round: 0.36 },
  ]), 'armorSecondary', {
    p: [0, 0, FRONT * (cd * 0.44) + rz(m.collar * 0.5)], r: [(-19 + plan.rake) * DEG, 0, 0], tier: TIER.PRIMARY,
  });
  rig.add('chest', channelStrip(cw * 0.60, 0.020, 0.014), 'darkMetal', {
    p: [0, m.collar * 0.25, FRONT * (cd * 0.50) + rz(m.collar * 0.25)], r: FACE_FRONT, tier: TIER.SECONDARY,
  });

  // pectoral plates, floated off the ribcage on a standoff so the gap reads
  for (const { sign, mirror } of SIDES) {
    rig.add('chest', loftHull([
      { y: -ch * 0.34, w: cw * 0.30, d: cd * 0.26, round: 0.34 },
      { y: 0, w: cw * 0.38, d: cd * 0.34, round: 0.26, smooth: true },
      { y: ch * 0.34, w: cw * 0.33, d: cd * 0.28, round: 0.32 },
    ]), 'armorPrimary', {
      p: [sign * cw * 0.28, m.collar * 0.20, FRONT * cd * 0.44 + rz(m.collar * 0.20)],
      r: [(-6 + plan.rake) * DEG, sign * 14 * DEG, sign * -8 * DEG],
      mirror, tier: TIER.PRIMARY,
    });
    // intake louvres on the upper chest flank
    addLouvres(rig, 'chest', {
      p: [sign * cw * 0.40, m.collar * 0.42, FRONT * cd * 0.22 + rz(m.collar * 0.42)],
      r: [0, sign * 118 * DEG, 0],
      w: cd * 0.30, h: 0.062, n: ventFins(spec, 0.55), depth: 0.020, mirror, glow: 'vents',
    });
  }

  // gorget / collar ring — bridges the deck to the neck column
  const gr = P.yoke.w * 0.26;
  rig.add('chest', latheProfile([
    { r: gr * 0.86, y: 0.0 }, { r: gr, y: 0.018, smooth: true }, { r: gr, y: m.collar * 0.26 },
    { r: gr * 0.86, y: m.collar * 0.33 }, { r: gr * 0.74, y: m.collar * 0.33 }, { r: gr * 0.74, y: 0.0 },
  ], 20), 'darkMetal', { p: [0, m.collar * 0.62, 0.005 + rz(m.collar * 0.62)], tier: TIER.PRIMARY });

  // clavicle yokes
  for (const { s, sign, mirror } of SIDES) {
    const cp = rig.restPos[`clavicle_${s}`];
    const local = cp ? cp.clone().sub(rig.restPos.chest) : new THREE.Vector3(sign * 0.055, 0.13, 0.01);
    rig.add('chest', bevelBox(0.16 * m.armK, 0.075, 0.13 * m.armK, 0.012, { topX: 0.7, topZ: 0.8 }), 'armorSecondary', {
      p: [local.x + sign * 0.055 * m.armS, local.y - 0.005, local.z + rz(local.y)],
      r: [0, 0, sign * -14 * DEG], mirror, tier: TIER.PRIMARY,
    });
  }

  // back plate + shoulder-blade panels. The back is the largest single face on
  // the machine and the one the fight camera sees most of, so it is described as
  // what it is: a bolted access deck over the spine, butted to the plates around
  // it on three sides.
  const bz = -FRONT * cd * 0.42 + rz(m.collar * 0.18);
  rig.add('chest', bevelBox(cw * 0.94, ch * 0.98, cd * 0.30, 0.016, { topX: 0.96, botX: 0.78 }), 'armorSecondary',
    { p: [0, m.collar * 0.18, bz], r: [plan.rake * DEG, 0, 0], tier: TIER.PRIMARY, role: 'deck' });
  for (const { sign, mirror } of SIDES) {
    rig.add('chest', bevelBox(cw * 0.30, ch * 0.60, 0.03, 0.010, { topX: 0.88 }), 'carbon', {
      p: [sign * cw * 0.26, m.collar * 0.30, bz - FRONT * cd * 0.16],
      r: [plan.rake * DEG, sign * -10 * DEG, 0], mirror, tier: TIER.SECONDARY,
    });
  }

  addPanelDetail(rig, 'chest', {
    p: [0, m.collar * 0.18, bz - FRONT * (cd * 0.15 + 0.004)], r: [0, YAW_BACK, 0],
    w: cw * 0.80, h: ch * 0.82, bolts: 5,
  });
  for (const { sign, mirror } of SIDES) {
    addPanelDetail(rig, 'chest', {
      p: [sign * (cw * 0.52), m.collar * 0.18, rz(m.collar * 0.18)], r: [0, sign * 90 * DEG, 0],
      w: cd * 0.68, h: ch * 0.62, bolts: 3, splitsY: [0.22], splitsX: [-0.2], mirror,
    });
    addPipeRun(rig, 'chest', [
      [sign * cw * 0.18, -m.thorax * 0.36, -FRONT * cd * 0.46 + rz(-m.thorax * 0.36)],
      [sign * cw * 0.34, m.collar * 0.06, -FRONT * cd * 0.48 + rz(m.collar * 0.06)],
      [sign * cw * 0.40, m.collar * 0.44, -FRONT * cd * 0.36 + rz(m.collar * 0.44)],
    ], { radius: 0.011, mirror });
  }

  buildChestCore(rig, spec, cw, cd, ch, cy, rz(cy));
  buildTorsoMass(rig, spec, P, rz);
  buildBackHardware(rig, spec, cy, rz);

  rig.decal('chest', MARKINGS.ROUNDEL, 0.10, 0.10, {
    p: [-cw * 0.30, m.collar * 0.34, FRONT * (cd * 0.5 + 0.03) + rz(m.collar * 0.34)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
  rig.decal('chest', MARKINGS.NAMEPLATE, 0.15, 0.062, {
    p: [0, -m.thorax * 0.32, FRONT * (cd * 0.5 + 0.01) + rz(-m.thorax * 0.32)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
  if (def?.archetype) {
    rig.decal('chest', MARKINGS.CHEVRON, 0.07, 0.07, {
      p: [cw * 0.32, -m.thorax * 0.10, FRONT * (cd * 0.5 + 0.02) + rz(-m.thorax * 0.10)], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
    });
  }
}

function buildChestCore(rig, spec, cw, cd, ch, cy, dz = 0) {
  const zf = FRONT * (cd * 0.5 + 0.008) + dz;
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
        rig.decal('chest', MARKINGS.GAUGE, 0.05, 0.05, {
          p: [Math.cos(i * 2.1) * 0.11, cy + Math.sin(i * 2.1) * 0.09, zf + FRONT * 0.006],
          r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
        });
      }
      break;
    }
  }
}

/**
 * The ten dorsal units.
 *
 * The back unit is the second-largest silhouette decision after the torso mass,
 * and the cheapest one to make unmistakable: it sits outside the body outline,
 * so it costs nothing in occlusion and everything in read. There is exactly one
 * per fighter and no two are the same construction — the previous table keyed
 * this off the chassis, which meant three precision fighters wore the same
 * sensor wings and the roster came out looking like one product line.
 *
 * Everything hangs from `cy` dropped clear of the collar: a reactor pack level
 * with the head is a reactor pack in FRONT of the head from three quarters of
 * the angles the fight camera ever chooses. Anything that should still be
 * settling after the body has stopped is `sprung` to `pack_L` / `pack_R`.
 *
 * @param {Rig} rig
 * @param {Object} spec resolved chassis plan
 * @param {number} cyIn chest-local Y of the chest mass centre
 * @param {(y:number)=>number} rz rake shift of the column at a height
 */
function buildBackHardware(rig, spec, cyIn, rz = () => 0) {
  const t = spec.torso;
  const back = -FRONT;
  const cy = cyIn - 0.055;
  const zb = back * (t.chestD * 0.5 + 0.03) + rz(cy);

  switch (spec.back) {
    case 'reactor': {
      // Foundry: twin finned radiator stacks either side of a central breech.
      for (const { s: side, sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.26;
        const pack = `pack_${side}`;
        rig.add('chest', loftHull([
          { y: -0.130, w: 0.126, d: 0.104, round: 0.30 },
          { y: 0.020, w: 0.134, d: 0.112, round: 0.26, smooth: true },
          { y: 0.128, w: 0.106, d: 0.084, round: 0.34 },
        ]), 'armorSecondary',
        { p: [x, cy + 0.02, zb + back * 0.05], r: [-14 * DEG, 0, sign * -5 * DEG], mirror, tier: TIER.PRIMARY, sprung: pack });
        for (let i = 0; i < 6; i++) {
          rig.add('chest', bevelBox(0.145, 0.012, 0.115, 0.004), 'darkMetal', {
            p: [x, cy - 0.086 + i * 0.040, zb + back * (0.05 + (0.10 - i * 0.028) * 0.14)],
            r: [-14 * DEG, 0, 0], mirror, tier: TIER.SECONDARY, sprung: pack,
          });
        }
        rig.glow('chest', bevelBox(0.10, 0.21, 0.012, 0.004), 'vents',
          { p: [x, cy + 0.02, zb + back * 0.115], r: [-14 * DEG, 0, 0], mirror, sprung: pack });
        rig.emitter('exhaust', 'chest', [x, cy + 0.15, zb + back * 0.05], [0, 0.4, back], 0.05);
      }
      rig.add('chest', bevelBox(t.chestW * 0.46, 0.14, 0.12, 0.014, { topX: 0.8 }), 'armorPrimary',
        { p: [0, cy - 0.08, zb + back * 0.03], tier: TIER.PRIMARY });
      break;
    }
    case 'thrusters': {
      // Courier: two bell nozzles cantilevered off a carbon spine.
      for (const { s: side, sign, mirror } of SIDES) {
        const x = sign * t.chestW * 0.30;
        const pack = `pack_${side}`;
        rig.add('chest', bevelBox(0.11, 0.20, 0.14, 0.012, { topX: 0.8, topZ: 0.7 }), 'armorPrimary',
          { p: [x, cy + 0.04, zb], r: [10 * DEG, 0, sign * -6 * DEG], mirror, tier: TIER.PRIMARY, sprung: pack });
        const nozzle = latheProfile([
          { r: 0.030, y: 0 }, { r: 0.030, y: 0.05 }, { r: 0.044, y: 0.075, smooth: true },
          { r: 0.062, y: 0.115 }, { r: 0.056, y: 0.118 }, { r: 0.040, y: 0.082, smooth: true },
          { r: 0.026, y: 0.05 }, { r: 0.026, y: 0 },
        ], 22);
        rig.add('chest', nozzle, 'darkMetal',
          { p: [x, cy - 0.04, zb + back * 0.02], r: [(90 + 28) * DEG * back, 0, 0], mirror, tier: TIER.PRIMARY, sprung: pack });
        rig.glow('chest', latheProfile([{ r: 0, y: 0 }, { r: 0.040, y: 0 }, { r: 0.040, y: 0.008 }, { r: 0, y: 0.008 }], 22), 'vents',
          { p: [x, cy - 0.08, zb + back * 0.10], r: [(90 + 28) * DEG * back, 0, 0], mirror, sprung: pack });
        rig.emitter('thruster', 'chest', [x, cy - 0.09, zb + back * 0.12], [0, -0.35, back], 0.055);
      }
      rig.add('chest', bevelBox(t.chestW * 0.4, 0.22, 0.09, 0.012, { topX: 0.7, botX: 0.86 }), 'carbon',
        { p: [0, cy + 0.03, zb - back * 0.01], tier: TIER.PRIMARY });
      break;
    }
    case 'drum': {
      // Dockyard: a cable winch lying across the back on its own axis, wider
      // than the shoulders and unmistakable end-on. Nothing else in the cast
      // has a horizontal cylinder on it.
      const R = 0.115, half = t.chestW * 0.56;
      rig.add('chest', latheProfile([
        { r: R * 0.62, y: -half }, { r: R * 0.94, y: -half + 0.012, smooth: true },
        { r: R, y: -half + 0.030 }, { r: R * 0.86, y: -half * 0.72 },
        { r: R * 0.86, y: half * 0.72 }, { r: R, y: half - 0.030 },
        { r: R * 0.94, y: half - 0.012, smooth: true }, { r: R * 0.62, y: half },
      ], 22), 'darkMetal', {
        p: [0, cy + 0.05, zb + back * 0.055], r: [0, 0, 90 * DEG], tier: TIER.PRIMARY,
      });
      // wound cable: hoops along the barrel, which is what says "drum" and not
      // "pipe" at silhouette distance
      for (let i = -4; i <= 4; i++) {
        rig.add('chest', latheProfile([
          { r: R * 0.88, y: 0 }, { r: R * 0.96, y: 0.007, smooth: true }, { r: R * 0.88, y: 0.014 },
        ], 20), 'rubber', {
          p: [i * half * 0.16, cy + 0.05, zb + back * 0.055], r: [0, 0, 90 * DEG], tier: TIER.SECONDARY,
        });
      }
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', loftHull([
          { y: -0.10, w: 0.038, d: 0.14, round: 0.30 },
          { y: 0.10, w: 0.030, d: 0.11, round: 0.34 },
        ]), 'armorSecondary', {
          p: [sign * (half + 0.030), cy + 0.02, zb + back * 0.035], mirror, tier: TIER.PRIMARY,
        });
      }
      rig.glow('chest', bevelBox(0.05, 0.016, 0.012, 0.004), 'joints',
        { p: [half * 0.86, cy + 0.16, zb + back * 0.05] });
      break;
    }
    case 'wings': {
      // Reliquary: two tall thin sensor sails standing well clear of the body
      // and raked back. They are the only vertical elements in the cast that
      // reach above the head line without being part of the head.
      for (const { s: side, sign, mirror } of SIDES) {
        const pack = `pack_${side}`;
        rig.add('chest', loftHull([
          { y: -0.05, w: 0.048, d: 0.030, round: 0.30 },
          { y: 0.16, w: 0.150, d: 0.020, z: back * 0.035, round: 0.20, smooth: true },
          { y: 0.34, w: 0.106, d: 0.014, z: back * 0.085, round: 0.26 },
        ]), 'armorPrimary', {
          p: [sign * t.chestW * 0.20, cy + 0.05, zb + back * 0.02],
          r: [-14 * DEG, sign * 30 * DEG, sign * -26 * DEG], order: 'YXZ',
          mirror, tier: TIER.PRIMARY, sprung: pack,
        });
        rig.glow('chest', loftHull([
          { y: -0.02, w: 0.012, d: 0.010, round: 0.5 },
          { y: 0.30, w: 0.008, d: 0.008, round: 0.5 },
        ]), 'spine', {
          p: [sign * (t.chestW * 0.20 + 0.024), cy + 0.05, zb + back * 0.03],
          r: [-14 * DEG, sign * 30 * DEG, sign * -26 * DEG], order: 'YXZ', mirror, sprung: pack,
        });
      }
      rig.add('chest', loftHull([
        { y: -0.12, w: t.chestW * 0.30, d: 0.09, round: 0.40 },
        { y: 0.10, w: t.chestW * 0.24, d: 0.07, round: 0.44 },
      ]), 'armorSecondary', { p: [0, cy + 0.02, zb], tier: TIER.PRIMARY });
      break;
    }
    case 'spine': {
      // Bodyguard: a row of vertebral fins standing off the backplate, each one
      // shorter than the last. It reads as a sawtooth ridge in profile, which is
      // exactly the angle a fighting-game camera favours.
      for (let i = 0; i < 6; i++) {
        const f = 1 - i * 0.11;
        rig.add('chest', loftHull([
          { y: 0, w: 0.030 * f, d: 0.020, round: 0.24 },
          { y: 0.038 * f, w: 0.024 * f, d: 0.056 * f, z: back * 0.024 * f, round: 0.22, smooth: true },
          { y: 0.062 * f, w: 0.010 * f, d: 0.030 * f, z: back * 0.052 * f, round: 0.34 },
        ]), 'trim', {
          p: [0, cy - 0.12 + i * 0.058, zb + back * 0.012], r: [-16 * DEG, 0, 0], tier: TIER.PRIMARY,
        });
      }
      rig.add('chest', loftHull([
        { y: -0.15, w: t.chestW * 0.24, d: 0.056, round: 0.16 },
        { y: 0.19, w: t.chestW * 0.18, d: 0.044, round: 0.18 },
      ]), 'armorSecondary', { p: [0, cy + 0.02, zb], tier: TIER.PRIMARY });
      rig.glow('chest', bevelBox(0.014, 0.30, 0.010, 0.003), 'spine',
        { p: [0, cy + 0.02, zb + back * 0.030] });
      break;
    }
    case 'elytra': {
      // Pest control: two hinged wing cases, cracked open along the spine so a
      // wedge of dark shows between them. Broad and low, the opposite read to
      // SERAPH's tall sails, and the only dorsal unit that is wider than tall.
      for (const { s: side, sign, mirror } of SIDES) {
        const pack = `pack_${side}`;
        rig.add('chest', loftHull([
          { y: -0.155, w: 0.062, d: 0.070, round: 0.48 },
          { y: -0.020, w: 0.156, d: 0.096, round: 0.44, smooth: true },
          { y: 0.115, w: 0.128, d: 0.078, round: 0.46 },
        ]), 'armorPrimary', {
          p: [sign * t.chestW * 0.22, cy + 0.01, zb + back * 0.03],
          r: [-8 * DEG, sign * 16 * DEG, sign * -16 * DEG], order: 'YXZ',
          mirror, tier: TIER.PRIMARY, sprung: pack,
        });
        rig.add('chest', loftHull([
          { y: -0.13, w: 0.024, d: 0.040, round: 0.44 },
          { y: 0.10, w: 0.018, d: 0.030, round: 0.46 },
        ]), 'trim', {
          p: [sign * (t.chestW * 0.22 + 0.062), cy + 0.01, zb + back * 0.055],
          r: [-8 * DEG, sign * 16 * DEG, sign * -16 * DEG], order: 'YXZ', mirror, tier: TIER.SECONDARY, sprung: pack,
        });
        // folded flight membrane showing in the crack
        rig.glow('chest', bevelBox(0.020, 0.20, 0.010, 0.003), 'vents', {
          p: [sign * 0.026, cy + 0.01, zb + back * 0.008], r: [-8 * DEG, 0, sign * -6 * DEG], mirror,
        });
      }
      break;
    }
    case 'coil': {
      // Casino security: three toroidal windings stacked flat against the back
      // at reducing radius. Segmented blocks rather than a lathed torus, so the
      // facets catch the rim light and it reads as forged rather than as a donut.
      for (let k = 0; k < 3; k++) {
        const R = 0.215 - k * 0.045;
        const SEGS = 16 - k * 2;
        const blocks = [];
        for (let i = 0; i < SEGS; i++) {
          const a = (i / SEGS) * Math.PI * 2;
          const g = bevelBox(0.030, 0.026, (2 * Math.PI * R) / SEGS * 0.92, 0.005);
          g.applyMatrix4(new THREE.Matrix4().compose(
            new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2)),
            new THREE.Vector3(1, 1, 1),
          ));
          blocks.push(g);
        }
        rig.add('chest', joinGeometries(blocks), k === 1 ? 'trim' : 'armorAccent', {
          p: [0, cy + 0.05, zb + back * (0.02 + k * 0.032)], r: [12 * DEG, 0, k * 0.22], tier: TIER.PRIMARY,
        });
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + 0.4;
        rig.glow('chest', bevelBox(0.044, 0.016, 0.010, 0.004), 'core', {
          p: [Math.cos(a) * 0.215, cy + 0.05 + Math.sin(a) * 0.215, zb + back * 0.036],
          r: [12 * DEG, 0, a + Math.PI / 2],
        });
      }
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.052, y: 0 }, { r: 0.058, y: 0.016, smooth: true },
        { r: 0.044, y: 0.048 }, { r: 0, y: 0.052 },
      ], 20), 'darkMetal', { p: [0, cy + 0.05, zb + back * 0.03], r: [-90 * DEG * back, 0, 0], tier: TIER.PRIMARY });
      break;
    }
    case 'tank': {
      // Corridor guard: two vertical pressure cylinders under one wide flat
      // deck plate. Square, capped, and the same width as the shoulders, so it
      // extends the wall rather than breaking it.
      for (const { s: side, sign, mirror } of SIDES) {
        const pack = `pack_${side}`;
        rig.add('chest', latheProfile([
          { r: 0, y: -0.150 }, { r: 0.052, y: -0.150 }, { r: 0.060, y: -0.132, smooth: true },
          { r: 0.060, y: 0.132, smooth: true }, { r: 0.052, y: 0.150 }, { r: 0, y: 0.150 },
        ], 22), 'armorSecondary', {
          p: [sign * t.chestW * 0.28, cy + 0.02, zb + back * 0.045], mirror, tier: TIER.PRIMARY, sprung: pack,
        });
        for (const dy of [-0.10, 0.10]) {
          rig.add('chest', latheProfile([
            { r: 0.062, y: 0 }, { r: 0.070, y: 0.012, smooth: true }, { r: 0.070, y: 0.030 }, { r: 0.062, y: 0.042 },
          ], 22), 'trim', {
            p: [sign * t.chestW * 0.28, cy + 0.02 + dy, zb + back * 0.045], mirror, tier: TIER.SECONDARY, sprung: pack,
          });
        }
        rig.glow('chest', bevelBox(0.016, 0.16, 0.010, 0.003), 'vents',
          { p: [sign * t.chestW * 0.28, cy + 0.02, zb + back * 0.108], mirror, sprung: pack });
      }
      rig.add('chest', bevelBox(t.chestW * 0.92, 0.042, 0.14, 0.010), 'armorPrimary',
        { p: [0, cy + 0.20, zb + back * 0.045], tier: TIER.PRIMARY });
      rig.add('chest', bevelBox(t.chestW * 0.36, 0.24, 0.09, 0.012, { topX: 0.9 }), 'darkMetal',
        { p: [0, cy + 0.02, zb], tier: TIER.PRIMARY });
      break;
    }
    case 'ladder': {
      // Substation: a spark gap. Two bronze horns rising from the shoulders in a
      // V with the arc climbing between them. It is the one dorsal unit whose
      // silhouette is mostly empty space, which is what makes it legible against
      // a bright background where a solid pack goes to black.
      for (const { s: side, sign, mirror } of SIDES) {
        const pack = `pack_${side}`;
        rig.add('chest', loftHull([
          { y: 0, w: 0.030, d: 0.034, round: 0.42 },
          { y: 0.17, w: 0.022, d: 0.026, round: 0.44, smooth: true },
          { y: 0.34, w: 0.014, d: 0.018, round: 0.46 },
        ]), 'trim', {
          p: [sign * t.chestW * 0.20, cy + 0.02, zb + back * 0.02],
          r: [-6 * DEG, 0, sign * -19 * DEG], mirror, tier: TIER.PRIMARY, sprung: pack,
        });
        rig.add('chest', latheProfile([
          { r: 0, y: 0 }, { r: 0.032, y: 0 }, { r: 0.036, y: 0.014, smooth: true },
          { r: 0.036, y: 0.040 }, { r: 0.028, y: 0.052 }, { r: 0, y: 0.052 },
        ], 20), 'rubber', {
          p: [sign * t.chestW * 0.20, cy - 0.01, zb + back * 0.02], mirror, tier: TIER.SECONDARY, sprung: pack,
        });
        rig.emitter('arc', 'chest', [sign * (t.chestW * 0.20 + 0.11), cy + 0.36, zb + back * 0.02], [sign * -1, 0.3, 0], 0.03);
      }
      for (let i = 0; i < 4; i++) {
        const f = i / 3;
        rig.glow('chest', bevelBox(0.09 + f * 0.10, 0.012, 0.010, 0.003), 'core', {
          p: [0, cy + 0.10 + f * 0.24, zb + back * 0.026], r: [0, 0, (i % 2 ? 1 : -1) * 6 * DEG],
        });
      }
      rig.add('chest', bevelBox(t.chestW * 0.44, 0.15, 0.10, 0.012, { topX: 0.8 }), 'armorSecondary',
        { p: [0, cy - 0.02, zb], tier: TIER.PRIMARY });
      break;
    }
    default: {
      // `none`: the reference chassis carries nothing on its back but a flush
      // service hatch. Its identity is the clean outline, and hanging a pack on
      // it to fill the space would be the one change that destroys it.
      rig.add('chest', loftHull([
        { y: -0.14, w: t.chestW * 0.44, d: 0.030, round: 0.22 },
        { y: 0.16, w: t.chestW * 0.38, d: 0.026, round: 0.24 },
      ]), 'armorSecondary', { p: [0, cy + 0.04, zb + back * 0.004], tier: TIER.PRIMARY });
      rig.glow('chest', bevelBox(0.026, 0.026, 0.008, 0.003), 'spine',
        { p: [0, cy + 0.15, zb + back * 0.020] });
      rig.decal('chest', MARKINGS.BARCODE, t.chestW * 0.30, 0.05, {
        p: [0, cy - 0.04, zb + back * 0.022], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE,
      });
      break;
    }
  }
}

/**
 * The one feature that makes each body mass unmistakable.
 *
 * `TORSO_PLANS` reshapes the shared column, which separates the ten fighters by
 * proportion. That is necessary and it is not sufficient: at 100 pixels a
 * proportion difference of 20% reads as the same machine seen from further away.
 * What actually names a character is a *form* the others do not have — a furnace
 * door, a sternum keel, a dorsal dome that rises above the head line, a skirt of
 * hanging lames. One each, all of it primary tier, none of it greeble.
 *
 * Every one is authored against the resolved stations rather than a literal, so
 * it stays welded to the column whatever the roster's proportions did.
 *
 * @param {Rig} rig
 * @param {Object} spec resolved chassis plan
 * @param {Object} P station table from `torsoStations`
 * @param {(y:number)=>number} rz rake shift of the column at a height
 */
function buildTorsoMass(rig, spec, P, rz) {
  const m = rig.dim;
  const t = spec.torso;
  const back = -FRONT;

  switch (spec.planId) {
    case 'barrel': {
      // Foundry: a hinged fire door across the belly, with two hoop bands
      // shrunk on above and below it. The door is the widest thing on the
      // fighter and it sits at waist height, which is what stops this reading
      // as another broad-shouldered heavy.
      const r = P.waistHi.w * 0.52;
      const zf = FRONT * (P.waistHi.d * 0.5) + rz(0);
      rig.add('spine01', latheProfile([
        { r: 0, y: 0 }, { r: r * 0.94, y: 0 }, { r, y: 0.018, smooth: true },
        { r, y: 0.040 }, { r: r * 0.86, y: 0.052 }, { r: 0, y: 0.052 },
      ], 22), 'armorSecondary', { p: [0, m.mid * 0.16, zf], r: FACE_FRONT, tier: TIER.PRIMARY });
      rig.add('spine01', boltRing(9, r * 0.82, 0.010, 0.013), 'trim',
        { p: [0, m.mid * 0.16, zf + FRONT * 0.052], r: FACE_BACK, tier: TIER.GREEBLE });
      for (let i = 0; i < 4; i++) {
        rig.glow('spine01', bevelBox(r * (1.02 - i * 0.16), 0.014, 0.010, 0.003), 'core',
          { p: [0, m.mid * 0.16 - 0.036 + i * 0.024, zf + FRONT * 0.050] });
      }
      for (const dy of [-0.5, 0.62]) {
        rig.add('spine01', latheProfile([
          { r: P.waistHi.w * 0.55, y: 0 }, { r: P.waistHi.w * 0.60, y: 0.012, smooth: true },
          { r: P.waistHi.w * 0.60, y: 0.036 }, { r: P.waistHi.w * 0.55, y: 0.048 },
        ], 24), 'trim', {
          p: [0, m.mid * dy, rz(m.mid * dy)],
          s: [1, 1, P.waistHi.d / P.waistHi.w], tier: TIER.PRIMARY,
        });
      }
      break;
    }
    case 'keel': {
      // Courier: a thin vertical sternum blade standing out of a narrow chest.
      // Seen head-on the fighter is barely there; seen in profile it has a
      // knife edge, which is the read the fight camera spends most of a round on.
      rig.add('chest', loftHull([
        { y: -m.thorax * 0.44, w: 0.030, d: P.chest.d * 0.34, round: 0.42 },
        { y: -m.thorax * 0.02, w: 0.026, d: P.chest.d * 0.52, round: 0.34, smooth: true },
        { y: m.collar * 0.34, w: 0.020, d: P.chest.d * 0.40, round: 0.40 },
      ]), 'armorAccent', {
        p: [0, 0, FRONT * (P.chest.d * 0.42) + rz(0)], r: [(-4 + spec.plan.rake) * DEG, 0, 0], tier: TIER.PRIMARY,
      });
      rig.glow('chest', loftHull([
        { y: -m.thorax * 0.34, w: 0.008, d: 0.010, round: 0.5 },
        { y: m.collar * 0.26, w: 0.006, d: 0.008, round: 0.5 },
      ]), 'spine', { p: [0, 0, FRONT * (P.chest.d * 0.42 + P.chest.d * 0.27)] });
      // wasp-waist collar ring, exposing the frame above the hips
      rig.add('spine01', latheProfile([
        { r: P.waistLo.w * 0.44, y: -0.010 }, { r: P.waistLo.w * 0.52, y: 0.004, smooth: true },
        { r: P.waistLo.w * 0.44, y: 0.020 },
      ], 20), 'trim', { p: [0, m.mid * 0.30, 0], s: [1, 1, 1.3], tier: TIER.SECONDARY });
      break;
    }
    case 'hump': {
      // Dockyard: an enormous rounded upper back that climbs past the head line.
      // Nothing else in the cast has mass above its own shoulders, so this is
      // the whole silhouette from any angle.
      const w = P.yoke.w * 1.34;
      rig.add('chest', loftHull([
        { y: m.collar * 0.30, w: w * 0.80, d: P.chest.d * 1.02, round: 0.46 },
        { y: m.collar * 0.86, w, d: P.chest.d * 1.16, round: 0.44, smooth: true },
        { y: m.collar * 1.36, w: w * 0.92, d: P.chest.d * 1.02, round: 0.46, smooth: true },
        { y: m.collar * 1.66, w: w * 0.52, d: P.chest.d * 0.60, round: 0.5 },
      ]), 'armorPrimary', {
        p: [0, 0, back * P.chest.d * 0.30 + rz(m.collar)], r: [-10 * DEG, 0, 0], tier: TIER.PRIMARY,
      });
      for (let i = 0; i < 5; i++) {
        rig.add('chest', latheProfile([
          { r: w * (0.42 - i * 0.03), y: 0 }, { r: w * (0.46 - i * 0.03), y: 0.010, smooth: true },
          { r: w * (0.46 - i * 0.03), y: 0.028 }, { r: w * (0.42 - i * 0.03), y: 0.038 },
        ], 20), 'trim', {
          p: [0, m.collar * (0.44 + i * 0.24), back * P.chest.d * (0.30 - i * 0.02) + rz(m.collar)],
          r: [-10 * DEG, 0, 0], s: [1, 1, 1.16], tier: TIER.SECONDARY,
        });
      }
      break;
    }
    case 'column': {
      // Reliquary: fluted pilasters running the whole height of the torso and a
      // raised chorister's collar. The mass is vertical, not lateral, and the
      // flutes are what make a narrow body still catch a rim light.
      for (let i = -3; i <= 3; i++) {
        if (i === 0) continue;
        const a = i * 26 * DEG;
        rig.add('spine02', loftHull([
          { y: -m.mid * 0.40, w: 0.022, d: 0.034, round: 0.44 },
          { y: m.thorax * 0.30, w: 0.019, d: 0.040, round: 0.42, smooth: true },
          { y: m.thorax * 0.86, w: 0.014, d: 0.030, round: 0.46 },
        ]), 'trim', {
          p: [Math.sin(a) * P.ribs.w * 0.50, 0, FRONT * Math.cos(a) * P.ribs.d * 0.52],
          r: [0, a, 0], tier: TIER.SECONDARY,
        });
      }
      const gr = P.yoke.w * 0.62;
      rig.add('chest', shellLathe([
        { r: gr * 0.86, y: 0 }, { r: gr, y: 0.06, smooth: true }, { r: gr * 0.80, y: 0.135 },
      ], 0.014, 22, { arc: 232 * DEG, phase: 154 * DEG }), 'armorSecondary', {
        p: [0, m.collar * 0.62, back * 0.010], r: [-8 * DEG, 0, 0], tier: TIER.PRIMARY,
      });
      break;
    }
    case 'cuirass': {
      // Bodyguard: a hard-cornered lacquered do with a kusazuri — five hanging
      // lames at the waist that break the leg line and give the fighter a
      // distinct waist edge nothing else in the cast has.
      const drop = 0.20 * m.legS;
      for (let i = -2; i <= 2; i++) {
        const a = i * 34 * DEG;
        rig.add('spine01', loftHull([
          { y: 0, w: P.waistLo.w * 0.44, d: 0.024, round: 0.16 },
          { y: -drop * 0.55, w: P.waistLo.w * 0.42, d: 0.026, round: 0.16, smooth: true },
          { y: -drop, w: P.waistLo.w * 0.34, d: 0.022, round: 0.20 },
        ]), 'armorAccent', {
          p: [Math.sin(a) * P.waistLo.w * 0.46, -m.lumbar * 0.30,
            FRONT * Math.cos(a) * P.waistLo.d * 0.56],
          r: [10 * DEG, a, 0], order: 'YXZ', tier: TIER.PRIMARY,
          sprung: i === 0 ? null : `skirt_${i > 0 ? 'L' : 'R'}`,
        });
      }
      // chest cords: two crossed lacing runs, the one detail an armourer adds
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', bevelBox(0.014, m.thorax * 1.10, 0.016, 0.004), 'armorAccent', {
          p: [sign * P.chest.w * 0.20, -m.thorax * 0.06, FRONT * (P.chest.d * 0.50) + rz(0)],
          r: [spec.plan.rake * DEG, 0, sign * 16 * DEG], mirror, tier: TIER.SECONDARY,
        });
      }
      break;
    }
    case 'carapace': {
      // Pest control: a segmented abdomen slung low and behind the hips. With
      // the thorax already raked 19 degrees forward, the abdomen is the
      // counterweight that completes the insect read at any size.
      let z = back * (t.waistD * 0.42);
      let y = -0.05;
      for (let i = 0; i < 5; i++) {
        const f = 1 - i * 0.13;
        rig.add('hips', loftHull([
          { y: -0.036 * f, w: 0.115 * f, d: 0.075 * f, round: 0.48 },
          { y: 0.008 * f, w: 0.128 * f, d: 0.086 * f, round: 0.46, smooth: true },
          { y: 0.040 * f, w: 0.104 * f, d: 0.066 * f, round: 0.50 },
        ]), 'armorPrimary', {
          p: [0, y, z], r: [-(16 + i * 7) * DEG * FRONT, 0, 0],
          tier: TIER.PRIMARY, sprung: i >= 2 ? (i % 2 ? 'skirt_L' : 'skirt_R') : null,
        });
        z += back * 0.082 * f;
        y -= 0.030 + i * 0.010;
      }
      rig.glow('hips', loftHull([
        { y: 0, w: 0.030, d: 0.026, round: 0.5 },
        { y: 0.030, w: 0.018, d: 0.016, round: 0.5 },
      ]), 'vents', { p: [0, y + 0.03, z], r: [-52 * DEG * FRONT, 0, 0], sprung: 'skirt_L' });
      break;
    }
    case 'skeletal': {
      // Casino security: an open ribcage you can see the room through. The
      // negative space between the hoops is the identity, so the hoops are hard
      // primary geometry and the space between them is left empty.
      for (let i = 0; i < 5; i++) {
        const f = 1 - Math.abs(i - 2) * 0.10;
        const rr = P.ribs.w * 0.52 * f;
        rig.add('chest', shellLathe([
          { r: rr * 0.94, y: -0.014 }, { r: rr, y: 0, smooth: true }, { r: rr * 0.94, y: 0.014 },
        ], 0.012, 20, { arc: 212 * DEG, phase: -16 * DEG }), 'trim', {
          p: [0, -m.thorax * 0.44 + i * m.thorax * 0.30, rz(-m.thorax * 0.44 + i * m.thorax * 0.30)],
          r: [-90 * DEG, 0, 0], s: [1, 1, P.ribs.d / P.ribs.w * 1.06], tier: TIER.PRIMARY,
        });
      }
      // sternum spar the hoops hang off, so the cage has a visible spine
      rig.add('chest', loftHull([
        { y: -m.thorax * 0.52, w: 0.036, d: 0.040, round: 0.44 },
        { y: m.collar * 0.40, w: 0.030, d: 0.034, round: 0.44 },
      ]), 'darkMetal', { p: [0, 0, FRONT * P.ribs.d * 0.40 + rz(0)], tier: TIER.PRIMARY });
      break;
    }
    case 'wall': {
      // Corridor guard: one flat frontal slab wider than the body carrying it,
      // with a raised boss dead centre. It is a door, and it is meant to read
      // as a door rather than as a torso.
      const w = P.chest.w * 1.10;
      rig.add('chest', loftHull([
        { y: -m.thorax * 0.56, w: w * 0.94, d: 0.050, round: 0.08 },
        { y: 0, w, d: 0.058, round: 0.06, smooth: true },
        { y: m.collar * 0.66, w: w * 0.96, d: 0.052, round: 0.08 },
      ]), 'armorPrimary', {
        p: [0, 0, FRONT * (P.chest.d * 0.50) + rz(0)], tier: TIER.PRIMARY,
      });
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: 0.086, y: 0 }, { r: 0.092, y: 0.020, smooth: true },
        { r: 0.070, y: 0.052 }, { r: 0, y: 0.058 },
      ], 22), 'trim', {
        p: [0, m.collar * 0.06, FRONT * (P.chest.d * 0.50 + 0.028) + rz(0)], r: FACE_FRONT, tier: TIER.PRIMARY,
      });
      for (const sy of [-1, 1]) {
        rig.add('chest', bevelBox(w * 1.02, 0.030, 0.070, 0.007), 'trim', {
          p: [0, sy * m.thorax * 0.58, FRONT * (P.chest.d * 0.50 + 0.006) + rz(0)], tier: TIER.SECONDARY,
        });
      }
      break;
    }
    case 'drum': {
      // Substation: vertical cooling fins right around the torso. It turns a
      // cylinder into a fluted can, and a fluted outline is legible at any size
      // in a way that a smooth one is not.
      //
      // Measured: at fourteen fins standing 3cm proud they did not survive the
      // 100-pixel test at all — VOLTA overlapped AXIOM 0.825 and MANTIS 0.822.
      // Nine fins standing 9cm proud, on the primary tier so they are never
      // thinned away, put a real sawtooth on the outline.
      // The reach has to be measured against the WIDEST station the fighter has,
      // not against the one the fins are bolted to. Sized off `ribs` they came
      // out 2cm proud of a chest 6cm wider than the ribs and vanished; the
      // fluting only exists if it is outboard of the pectoral line.
      const fins = 9;
      const reach = Math.max(P.chest.w, P.chest.d) * 0.5 + 0.030;
      for (let i = 0; i < fins; i++) {
        const a = (i / fins) * Math.PI * 2;
        rig.add('spine02', loftHull([
          { y: -m.mid * 0.44, w: 0.026, d: 0.086, round: 0.26 },
          { y: m.thorax * 0.24, w: 0.023, d: 0.150, round: 0.16, smooth: true },
          { y: m.thorax * 0.86, w: 0.016, d: 0.092, round: 0.28 },
        ]), 'trim', {
          p: [Math.sin(a) * (reach - 0.056), 0, FRONT * Math.cos(a) * (reach - 0.056)],
          r: [0, a, 0], tier: TIER.PRIMARY,
        });
      }
      for (const dy of [-0.36, 0.78]) {
        rig.add('spine02', latheProfile([
          { r: P.ribs.w * 0.53, y: 0 }, { r: P.ribs.w * 0.58, y: 0.014, smooth: true },
          { r: P.ribs.w * 0.58, y: 0.040 }, { r: P.ribs.w * 0.53, y: 0.054 },
        ], 26), 'darkMetal', {
          p: [0, m.thorax * dy, 0], s: [1, 1, P.ribs.d / P.ribs.w], tier: TIER.PRIMARY,
        });
      }
      break;
    }
    default:
      // `reference`: nothing. The textbook chassis is the one machine in the
      // cast with no bolted-on mass at all, and that absence is its identity.
      break;
  }
}

/**
 * Fin count for one louvre stack, from the roster's `vents` budget. `share` is
 * how much of that budget this particular stack is entitled to — a chest intake
 * is the character's headline vent, a shin outlet is not.
 */
function ventFins(spec, share) {
  return Math.round(clamp(spec.vents * share, 3, 7));
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
    taper: s.taper, tilt: s.tilt, layers: s.layers, slab: !!s.slab,
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
  // A slab pauldron is one plate, not an arc, so solving its top off the lame
  // radii would under-report it by a third of its own height and the head
  // clearance solve would seat the skull inside the shoulder.
  if (pd.slab) return pauldronLames(pd)[0].dy + pd.h * 1.04;
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
    (HEAD_BUILDERS[spec.head] ?? headFurnace)(rig, spec, def);
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

/**
 * Wide flat disc, for brims, insulator sheds and collar rings. Radius `r`,
 * thickness `h`, seated on y = 0 and lathed so the rim carries a real edge for
 * the rim light rather than a chamfer that vanishes at distance.
 */
function discShed(r, h, segments = 24) {
  return latheProfile([
    { r: 0, y: 0 },
    { r: r * 0.96, y: 0 },
    { r, y: h * 0.34, smooth: true },
    { r: r * 0.92, y: h },
    { r: 0, y: h },
  ], segments);
}

function headFurnace(rig) {
  // VULKAN. Bulldog: broad, low, thrust forward on a heavy jaw, with a caged
  // furnace where a face would be. It never gets tall, so it earns its
  // silhouette by being wider than the neck and hanging out over the chest.
  rig.add('head', loftHull([
    { y: -0.056, w: 0.150, d: 0.152, round: 0.40 },
    { y: -0.004, w: 0.204, d: 0.192, round: 0.30, smooth: true },
    { y: 0.062, w: 0.212, d: 0.198, round: 0.28, smooth: true },
    { y: 0.116, w: 0.172, d: 0.164, round: 0.34, smooth: true },
    { y: 0.146, w: 0.114, d: 0.112, round: 0.44 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });

  // brow shelf, heavy enough to throw the whole face into shadow
  rig.add('head', loftHull([
    { y: 0, w: 0.218, d: 0.062, round: 0.24 },
    { y: 0.026, w: 0.196, d: 0.040, round: 0.32 },
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

  // riveted skull cap and a pair of flue nubs on the whip leaves
  rig.add('head', shellLathe([
    { r: 0.098, y: -0.062 }, { r: 0.106, y: -0.024, smooth: true },
    { r: 0.106, y: 0.024, smooth: true }, { r: 0.090, y: 0.060 },
  ], 0.022, 18, { arc: 190 * DEG, phase: -5 * DEG }), 'armorSecondary', {
    p: [0, 0.086, -FRONT * 0.014], r: [-90 * DEG, 0, 0], tier: TIER.PRIMARY,
  });
  rig.add('head', boltRing(7, 0.086, 0.008, 0.010), 'trim',
    { p: [0, 0.148, -FRONT * 0.014], tier: TIER.GREEBLE });
  for (const { s: side, sign, mirror } of SIDES) {
    const stack = `antenna_${side}`;
    rig.add('head', latheProfile([
      { r: 0.022, y: 0 }, { r: 0.022, y: 0.058 }, { r: 0.027, y: 0.063, smooth: true },
      { r: 0.017, y: 0.072 }, { r: 0, y: 0.072 },
    ], 14), 'darkMetal', {
      p: [sign * 0.062, 0.126, -FRONT * 0.058], r: [-26 * DEG, 0, sign * 12 * DEG], mirror, tier: TIER.PRIMARY,
      sprung: stack,
    });
    rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.013, y: 0 }, { r: 0, y: 0.008 }], 14), 'vents',
      { p: [sign * 0.085, 0.190, -FRONT * 0.090], r: [-26 * DEG, 0, sign * 12 * DEG], mirror, sprung: stack });
  }
}

function headSwept(rig) {
  // KESTREL. A cycle helmet: one continuous ovoid shell with a single tall fin
  // running the length of the crown and overhanging the nape, and a wraparound
  // band low across the face. The only skull in the cast with no separate ear,
  // jaw or cheek part, so the outline is one unbroken curve interrupted once.
  rig.add('head', loftHull([
    { y: -0.052, w: 0.104, d: 0.146, z: FRONT * 0.020, round: 0.46 },
    { y: 0.004, w: 0.142, d: 0.206, z: FRONT * 0.010, round: 0.40, smooth: true },
    { y: 0.078, w: 0.138, d: 0.214, z: -FRONT * 0.006, round: 0.38, smooth: true },
    { y: 0.132, w: 0.098, d: 0.162, z: -FRONT * 0.024, round: 0.46 },
  ], { perQuad: 4 }), 'armorPrimary', { tier: TIER.PRIMARY });

  addVisor(rig, { w: 0.132, h: 0.026, y: 0.038, z: FRONT * 0.100, tilt: -12 * DEG, brow: 0.022, posts: false });

  // The fin. It starts forward of the brow and runs past the nape, so the head
  // reads as pointing somewhere even as a black shape at forty pixels.
  rig.add('head', loftHull([
    { y: 0.062, w: 0.026, d: 0.062, z: FRONT * 0.086, round: 0.32 },
    { y: 0.122, w: 0.022, d: 0.196, z: FRONT * 0.010, round: 0.24, smooth: true },
    { y: 0.166, w: 0.017, d: 0.190, z: -FRONT * 0.070, round: 0.24, smooth: true },
    { y: 0.184, w: 0.008, d: 0.104, z: -FRONT * 0.146, round: 0.40 },
  ]), 'armorAccent', { tier: TIER.PRIMARY });
  rig.glow('head', loftHull([
    { y: 0.106, w: 0.008, d: 0.150, z: FRONT * 0.020, round: 0.5 },
    { y: 0.172, w: 0.006, d: 0.110, z: -FRONT * 0.116, round: 0.5 },
  ]), 'spine', { tier: TIER.PRIMARY });

  // chin intake, the one recess on an otherwise sealed shell
  addLouvres(rig, 'head', {
    p: [0, -0.026, FRONT * 0.104], r: [(-24) * DEG, YAW_FRONT, 0],
    w: 0.074, h: 0.034, n: 3, depth: 0.014, glow: 'vents',
  });
  for (const { sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: -0.010, w: 0.016, d: 0.070, round: 0.42 },
      { y: 0.058, w: 0.013, d: 0.056, round: 0.44 },
    ]), 'trim', { p: [sign * 0.070, 0.020, -FRONT * 0.030], r: [0, 0, sign * -6 * DEG], mirror, tier: TIER.SECONDARY });
  }
}

function headTurret(rig) {
  // ANVIL. Barely a head at all: a squat dome sunk inside a collar ring wider
  // than the skull, with one deep cyclops slit and two lifting eyes on the
  // crown. It is the only fighter in the cast whose head does not clear its own
  // collar, which is exactly the read a dockyard lifting rig wants.
  rig.add('head', latheProfile([
    { r: 0.052, y: -0.056 }, { r: 0.100, y: -0.030, smooth: true },
    { r: 0.116, y: 0.006, smooth: true }, { r: 0.112, y: 0.046, smooth: true },
    { r: 0.076, y: 0.082, smooth: true }, { r: 0, y: 0.096 },
  ], 24), 'armorPrimary', { s: [1, 1, 1.10], tier: TIER.PRIMARY });

  // collar ring: a wide flat shed the dome sits down inside
  rig.add('head', discShed(0.158, 0.030, 26), 'armorSecondary', { p: [0, -0.056, 0], tier: TIER.PRIMARY });
  rig.add('head', boltRing(10, 0.132, 0.009, 0.011), 'trim', { p: [0, -0.026, 0], tier: TIER.GREEBLE });

  // one slit, cut deep so the brow above it holds a hard shadow
  rig.add('head', channelStrip(0.152, 0.040, 0.030), 'darkMetal',
    { p: [0, 0.014, FRONT * 0.092], r: FACE_FRONT, tier: TIER.SECONDARY });
  rig.glow('head', loftHull([
    { y: -0.008, w: 0.108, d: 0.012, round: 0.5 },
    { y: 0.008, w: 0.116, d: 0.014, round: 0.5 },
  ]), 'visor', { p: [0, 0.014, FRONT * 0.098] });
  rig.add('head', loftHull([
    { y: 0, w: 0.150, d: 0.048, round: 0.24 },
    { y: 0.020, w: 0.126, d: 0.026, round: 0.34 },
  ]), 'armorSecondary', { p: [0, 0.042, FRONT * 0.086], r: [-26 * DEG, 0, 0], tier: TIER.PRIMARY });

  // lifting eyes — two closed loops on the crown, the one silhouette break
  for (const { sign, mirror } of SIDES) {
    const ring = [];
    const R = 0.026;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const g = bevelBox(0.014, 0.013, (2 * Math.PI * R) / 10 * 0.94, 0.003);
      g.applyMatrix4(new THREE.Matrix4().compose(
        new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2)),
        new THREE.Vector3(1, 1, 1),
      ));
      ring.push(g);
    }
    rig.add('head', joinGeometries(ring), 'trim', {
      p: [sign * 0.050, 0.116, -FRONT * 0.010], r: [0, sign * 22 * DEG, 0], mirror, tier: TIER.PRIMARY,
    });
  }
}

function headKabuto(rig) {
  // RONIN-07. A helm bowl with a flared layered neck guard and a crescent crest
  // sweeping up and forward off the brow. The crescent alone names the character
  // at any size, and the shikoro gives the head a wider base than the neck,
  // which no other skull here does.
  rig.add('head', latheProfile([
    { r: 0.062, y: -0.046 }, { r: 0.096, y: -0.014, smooth: true },
    { r: 0.104, y: 0.036, smooth: true }, { r: 0.086, y: 0.092, smooth: true },
    { r: 0.038, y: 0.128, smooth: true }, { r: 0, y: 0.140 },
  ], 24), 'armorPrimary', { s: [1, 1, 1.14], tier: TIER.PRIMARY });

  // shikoro: three flared lames stepping out and down over the shoulders
  for (let i = 0; i < 3; i++) {
    const R = 0.116 + i * 0.030;
    rig.add('head', shellLathe([
      { r: R * 0.86, y: 0 }, { r: R, y: 0.020, smooth: true }, { r: R * 0.92, y: 0.044 },
    ], 0.011, 22, { arc: 250 * DEG, phase: 145 * DEG }), i === 1 ? 'armorAccent' : 'armorSecondary', {
      p: [0, -0.006 - i * 0.030, -FRONT * 0.006], r: [(-22 - i * 9) * DEG, 0, 0], tier: TIER.PRIMARY,
    });
  }

  // menpo: a face mask with a horizontal grille and a pointed chin
  rig.add('head', loftHull([
    { y: -0.058, w: 0.070, d: 0.048, z: FRONT * 0.014, round: 0.34 },
    { y: -0.010, w: 0.124, d: 0.062, round: 0.26, smooth: true },
    { y: 0.048, w: 0.132, d: 0.056, round: 0.26 },
  ]), 'trim', { p: [0, 0, FRONT * 0.072], r: [4 * DEG, 0, 0], tier: TIER.PRIMARY });
  for (let i = 0; i < 3; i++) {
    rig.add('head', bevelBox(0.096 - i * 0.014, 0.006, 0.008, 0.002), 'darkMetal',
      { p: [0, -0.040 + i * 0.016, FRONT * 0.106], r: [10 * DEG, 0, 0], tier: TIER.GREEBLE });
  }
  addVisor(rig, { w: 0.116, h: 0.022, y: 0.052, z: FRONT * 0.092, tilt: -6 * DEG, brow: 0.030, posts: false });

  // maedate: the crescent. Two blades springing from one boss, curving up and
  // forward, on the whip leaves so they keep ringing after a head turn.
  //
  // A real maedate is a broad flat pressing, and that is not decoration — it is
  // the reason the crest survives being small on screen. At 24mm across, these
  // were horns: a hairline at fighting range, and RONIN measured 0.134 against
  // AXIOM in profile, the closest pair on the sheet. Broad and thin, they read
  // as one crescent from the front and as a long curved blade from the side,
  // which is the only view the fight camera gives.
  for (const { s: side, sign, mirror } of SIDES) {
    const whip = `antenna_${side}`;
    rig.add('head', loftHull([
      { y: 0, w: 0.052, d: 0.030, round: 0.30 },
      { y: 0.118, w: 0.104, d: 0.020, z: FRONT * 0.052, round: 0.16, smooth: true },
      { y: 0.216, w: 0.086, d: 0.013, z: FRONT * 0.140, round: 0.18, smooth: true },
      { y: 0.276, w: 0.030, d: 0.009, z: FRONT * 0.206, round: 0.34 },
    ]), 'trim', {
      p: [sign * 0.024, 0.102, FRONT * 0.026],
      r: [-14 * DEG, 0, sign * 21 * DEG], mirror, tier: TIER.PRIMARY, sprung: whip,
    });
    // A crimson cord line down the blade's spine, the character's accent colour
    // on the one part of it that is never in shadow.
    rig.add('head', loftHull([
      { y: 0.010, w: 0.014, d: 0.008, round: 0.5 },
      { y: 0.230, w: 0.010, d: 0.006, z: FRONT * 0.150, round: 0.5 },
    ]), 'armorAccent', {
      p: [sign * 0.024, 0.102, FRONT * 0.036],
      r: [-14 * DEG, 0, sign * 21 * DEG], mirror, tier: TIER.SECONDARY, sprung: whip,
    });
  }
  rig.add('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.032, y: 0 }, { r: 0.036, y: 0.010, smooth: true },
    { r: 0.026, y: 0.028 }, { r: 0, y: 0.030 },
  ], 20), 'armorAccent', { p: [0, 0.098, FRONT * 0.048], r: [-70 * DEG * -FRONT, 0, 0], tier: TIER.PRIMARY });
}

function headMandible(rig) {
  // MANTIS. A narrow triangular head thrust forward on the raked thorax, with
  // wide-set compound optics instead of a centred band and two palps curling in
  // under the jaw. Nothing else in the cast has its eyes off the centre line.
  rig.add('head', loftHull([
    { y: -0.050, w: 0.088, d: 0.140, z: FRONT * 0.052, round: 0.44 },
    { y: 0.006, w: 0.146, d: 0.206, z: FRONT * 0.030, round: 0.32, smooth: true },
    { y: 0.084, w: 0.150, d: 0.212, z: FRONT * 0.008, round: 0.28, smooth: true },
    { y: 0.142, w: 0.104, d: 0.150, z: -FRONT * 0.018, round: 0.36 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });

  // compound optics: two domes set out on the temples, framed by a dark socket
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0, y: 0 }, { r: 0.048, y: 0 }, { r: 0.050, y: 0.010, smooth: true },
      { r: 0.036, y: 0.026 }, { r: 0.028, y: 0.026 }, { r: 0.028, y: 0 },
    ], 18), 'darkMetal', {
      p: [sign * 0.062, 0.052, FRONT * 0.070], r: [-8 * DEG, sign * 34 * DEG, 0], mirror, tier: TIER.PRIMARY,
    });
    rig.glow('head', latheProfile([
      { r: 0, y: 0 }, { r: 0.033, y: 0 }, { r: 0.031, y: 0.012, smooth: true }, { r: 0, y: 0.022 },
    ], 18), 'visor', {
      p: [sign * 0.070, 0.052, FRONT * 0.086], r: [-8 * DEG, sign * 34 * DEG, 0], mirror,
    });
  }

  // palps, curling forward and inward under the face
  for (const { sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: 0, w: 0.026, d: 0.038, round: 0.40 },
      { y: -0.048, w: 0.020, d: 0.044, z: FRONT * 0.036, round: 0.38, smooth: true },
      { y: -0.082, w: 0.009, d: 0.024, z: FRONT * 0.070, round: 0.46 },
    ]), 'trim', {
      p: [sign * 0.044, -0.014, FRONT * 0.100], r: [0, sign * -14 * DEG, sign * 20 * DEG], mirror, tier: TIER.PRIMARY,
    });
  }
  rig.add('head', loftHull([
    { y: 0, w: 0.096, d: 0.040, round: 0.30 },
    { y: 0.020, w: 0.070, d: 0.020, round: 0.42 },
  ]), 'armorSecondary', { p: [0, 0.098, FRONT * 0.096], r: [-30 * DEG, 0, 0], tier: TIER.PRIMARY });

  // twin antennae, swept back well past the nape
  for (const { s: side, sign, mirror } of SIDES) {
    const whip = `antenna_${side}`;
    rig.add('head', loftHull([
      { y: 0, w: 0.020, d: 0.084, round: 0.30 },
      { y: 0.062, w: 0.016, d: 0.140, z: -FRONT * 0.056, round: 0.26, smooth: true },
      { y: 0.104, w: 0.006, d: 0.082, z: -FRONT * 0.132, round: 0.40 },
    ]), 'armorAccent', {
      p: [sign * 0.038, 0.112, -FRONT * 0.014], r: [20 * DEG, sign * -12 * DEG, sign * 18 * DEG],
      order: 'YXZ', mirror, tier: TIER.PRIMARY, sprung: whip,
    });
    rig.add('head', latheProfile([
      { r: 0.006, y: 0 }, { r: 0.006, y: 0.05 }, { r: 0.003, y: 0.054 }, { r: 0.003, y: 0.17 }, { r: 0, y: 0.18 },
    ], 10), 'trim', {
      p: [sign * 0.050, 0.124, -FRONT * 0.022], r: [-22 * DEG, 0, sign * 20 * DEG], mirror, tier: TIER.GREEBLE, sprung: whip,
    });
  }
}

function headLantern(rig) {
  // NYX. A wide flat brim over an open lantern cage with the light floating
  // inside it. At a hundred pixels this is a horizontal line with a bright dot
  // under it, which is the most legible head shape in the cast and the only one
  // whose widest point is a single thin plane.
  rig.add('head', loftHull([
    { y: -0.048, w: 0.078, d: 0.076, round: 0.40 },
    { y: 0.012, w: 0.098, d: 0.096, round: 0.34, smooth: true },
    { y: 0.086, w: 0.092, d: 0.090, round: 0.36, smooth: true },
    { y: 0.128, w: 0.048, d: 0.048, round: 0.46 },
  ]), 'darkMetal', { tier: TIER.PRIMARY });

  // the brim
  rig.add('head', discShed(0.164, 0.018, 26), 'armorPrimary', { p: [0, 0.052, 0], s: [1, 1, 0.86], tier: TIER.PRIMARY });
  rig.add('head', latheProfile([
    { r: 0.156, y: 0 }, { r: 0.166, y: 0.008, smooth: true }, { r: 0.156, y: 0.017 },
  ], 26), 'trim', { p: [0, 0.052, 0], s: [1, 1, 0.86], tier: TIER.SECONDARY });

  // cage: four corner posts with the core hanging between them, so the skull
  // has a hole in it and the glow reads through from both sides
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      rig.add('head', loftHull([
        { y: -0.040, w: 0.014, d: 0.014, round: 0.44 },
        { y: 0.046, w: 0.011, d: 0.011, round: 0.46 },
      ]), 'trim', { p: [sx * 0.044, 0, sz * FRONT * 0.042], tier: TIER.PRIMARY });
    }
  }
  rig.glow('head', latheProfile([
    { r: 0, y: -0.030 }, { r: 0.030, y: -0.010 }, { r: 0.032, y: 0.004 }, { r: 0, y: 0.034 },
  ], 6, { faceted: true, phase: Math.PI / 6 }), 'core', { p: [0, 0.006, 0] });
  addVisor(rig, { w: 0.082, h: 0.018, y: 0.022, z: FRONT * 0.052, brow: 0.018, posts: false, group: 'visor' });

  // finial
  rig.add('head', latheProfile([
    { r: 0.026, y: 0 }, { r: 0.020, y: 0.018 }, { r: 0.010, y: 0.024 },
    { r: 0.010, y: 0.056 }, { r: 0, y: 0.072 },
  ], 14), 'armorAccent', { p: [0, 0.124, 0], tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.013, y: 0 }, { r: 0, y: 0.016 }], 12), 'spine',
    { p: [0, 0.192, 0] });
}

function headBunker(rig) {
  // BASTION. A wide low vault with a slit cut deep under a riot brow, and cheek
  // wings that drop outward onto the shoulders. There is no crest and no
  // antenna: the head is part of the wall, and anything sticking out of it would
  // break the one read this character has.
  rig.add('head', loftHull([
    { y: -0.048, w: 0.196, d: 0.156, round: 0.16 },
    { y: 0.004, w: 0.244, d: 0.196, round: 0.12, smooth: true },
    { y: 0.062, w: 0.250, d: 0.200, round: 0.12, smooth: true },
    { y: 0.104, w: 0.212, d: 0.168, round: 0.18 },
  ]), 'armorPrimary', { tier: TIER.PRIMARY });

  // face plate, near vertical, with the slit set well back inside it
  rig.add('head', loftHull([
    { y: -0.044, w: 0.176, d: 0.044, round: 0.14 },
    { y: 0.010, w: 0.222, d: 0.050, round: 0.10, smooth: true },
    { y: 0.076, w: 0.226, d: 0.044, round: 0.12 },
  ]), 'armorSecondary', { p: [0, 0, FRONT * 0.094], r: [-3 * DEG, 0, 0], tier: TIER.PRIMARY });
  addVisor(rig, { w: 0.192, h: 0.020, y: 0.036, z: FRONT * 0.118, tilt: -3 * DEG, brow: 0.046 });

  // riot brow: one heavy horizontal lip standing proud of the face plate
  rig.add('head', bevelBox(0.256, 0.024, 0.052, 0.006), 'trim',
    { p: [0, 0.078, FRONT * 0.108], r: [-8 * DEG, 0, 0], tier: TIER.PRIMARY });

  // cheek wings, dropping outward so the head is wider at the jaw than the crown
  for (const { sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: 0.048, w: 0.034, d: 0.126, round: 0.20 },
      { y: -0.010, w: 0.040, d: 0.144, round: 0.16, smooth: true },
      { y: -0.074, w: 0.030, d: 0.108, round: 0.24 },
    ]), 'armorSecondary', {
      p: [sign * 0.128, 0.012, -FRONT * 0.004], r: [0, 0, sign * 13 * DEG], mirror, tier: TIER.PRIMARY,
    });
    addLouvres(rig, 'head', {
      p: [sign * 0.146, 0.030, -FRONT * 0.010], r: [0, sign * 90 * DEG, 0],
      w: 0.090, h: 0.048, n: 3, depth: 0.012, mirror, glow: 'joints',
    });
  }

  // nape armour, closing the back of the vault down onto the riser
  rig.add('head', loftHull([
    { y: -0.048, w: 0.166, d: 0.044, round: 0.16 },
    { y: 0.026, w: 0.204, d: 0.050, round: 0.14, smooth: true },
    { y: 0.094, w: 0.184, d: 0.042, round: 0.18 },
  ]), 'armorSecondary', { p: [0, 0, -FRONT * 0.092], r: [4 * DEG, 0, 0], tier: TIER.PRIMARY });
}

function headMono(rig) {
  // AXIOM. One smooth ovoid, one narrow band, one equator seam, and nothing
  // else at all. It is the only head in the cast with no protrusion of any
  // kind, and that is deliberately its identity — at silhouette size the
  // absence of a crest reads as loudly as a crest does.
  rig.add('head', latheProfile([
    { r: 0.040, y: -0.050 }, { r: 0.082, y: -0.020, smooth: true },
    { r: 0.098, y: 0.026, smooth: true }, { r: 0.096, y: 0.086, smooth: true },
    { r: 0.062, y: 0.144, smooth: true }, { r: 0, y: 0.168 },
  ], 26), 'armorPrimary', { s: [1, 1, 1.16], tier: TIER.PRIMARY });

  addVisor(rig, { w: 0.126, h: 0.020, y: 0.058, z: FRONT * 0.098, brow: 0.020, posts: false });

  // equator seam: the whole panel story on this skull, and enough of it. A
  // machined split with a rolled lip either side of it is what says the helmet
  // opens, which is all the incident a clean form is allowed.
  rig.add('head', latheProfile([
    { r: 0.100, y: 0 }, { r: 0.104, y: 0.006, smooth: true }, { r: 0.104, y: 0.014 }, { r: 0.100, y: 0.020 },
  ], 26), 'trim', { p: [0, 0.028, 0], s: [1, 1, 1.16], tier: TIER.SECONDARY });
  rig.add('head', channelStrip(0.040, 0.150, 0.010), 'darkMetal',
    { p: [0, 0.052, -FRONT * 0.100], r: FACE_BACK, s: [1, 1, 1], tier: TIER.SECONDARY });
  rig.decal('head', MARKINGS.BARCODE, 0.064, 0.030, { p: [0, 0.014, -FRONT * 0.104], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE });
}

function headInsulator(rig) {
  // VOLTA. A squat cylindrical skull under a stack of three ceramic sheds,
  // reducing in radius, with the arc gap at the top. A bushing column is a
  // shape nothing organic makes, and stacked discs stay legible at any size
  // because each one draws its own horizontal line.
  rig.add('head', latheProfile([
    { r: 0.058, y: -0.050 }, { r: 0.090, y: -0.032, smooth: true },
    { r: 0.096, y: 0.038, smooth: true }, { r: 0.086, y: 0.058 },
    { r: 0.060, y: 0.062 },
  ], 24), 'armorPrimary', { s: [1, 1, 1.08], tier: TIER.PRIMARY });

  addVisor(rig, { w: 0.116, h: 0.024, y: 0.010, z: FRONT * 0.088, brow: 0.026 });

  for (let i = 0; i < 3; i++) {
    const r = 0.104 - i * 0.020;
    rig.add('head', discShed(r, 0.024, 22), i % 2 ? 'trim' : 'armorSecondary',
      { p: [0, 0.062 + i * 0.040, 0], tier: TIER.PRIMARY });
    rig.add('head', latheProfile([
      { r: r * 0.44, y: 0 }, { r: r * 0.44, y: 0.018 },
    ], 18), 'darkMetal', { p: [0, 0.086 + i * 0.040, 0], tier: TIER.SECONDARY });
  }
  // arc terminal
  rig.add('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.030, y: 0 }, { r: 0.032, y: 0.012, smooth: true },
    { r: 0.022, y: 0.030 }, { r: 0, y: 0.034 },
  ], 20), 'trim', { p: [0, 0.182, 0], tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.017, y: 0 }, { r: 0, y: 0.020 }], 14), 'core',
    { p: [0, 0.214, 0] });
  rig.emitter('arc', 'head', [0, 0.222, 0], [0, 1, 0], 0.03);

  // cheek bushings, so the profile is not merely a column
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0, y: 0 }, { r: 0.032, y: 0 }, { r: 0.036, y: 0.010, smooth: true },
      { r: 0.036, y: 0.032 }, { r: 0.026, y: 0.040 }, { r: 0, y: 0.040 },
    ], 18), 'darkMetal', {
      p: [sign * 0.086, 0.006, -FRONT * 0.014], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY,
    });
  }
}

function headCrown(rig) {
  // SERAPH. A ceremonial helm with a veiled face, four flared horns and a halo
  // standing off the nape. The only skull in the cast with no hard corner on
  // it, and the only one with a detached element, which is what an arcane
  // chassis is for.
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
  for (const { s: side, sign, mirror } of SIDES) {
    const whip = `antenna_${side}`;
    for (let j = 0; j < 2; j++) {
      const len = j === 0 ? 0.23 : 0.16;
      rig.add('head', loftHull([
        { y: 0, w: 0.028, d: 0.036, round: 0.34 },
        { y: len * 0.58, w: 0.020, d: 0.026, z: -FRONT * len * 0.16, round: 0.36, smooth: true },
        { y: len, w: 0.007, d: 0.009, z: -FRONT * len * 0.34, round: 0.45 },
      ]), 'armorAccent', {
        p: [sign * (0.056 + j * 0.026), 0.108 + j * 0.012, -FRONT * (0.012 + j * 0.036)],
        r: [(26 + j * 14) * DEG, 0, sign * (24 + j * 16) * DEG],
        mirror, tier: TIER.PRIMARY, sprung: whip,
      });
    }
    rig.glow('head', loftHull([
      { y: 0, w: 0.007, d: 0.007, round: 0.5 },
      { y: 0.125, w: 0.005, d: 0.005, round: 0.5 },
    ]), 'spine', { p: [sign * 0.060, 0.152, -FRONT * 0.036], r: [26 * DEG, 0, sign * 24 * DEG], mirror, sprung: whip });
  }

  // halo: a segmented ring standing off the nape, tilted so it reads as a disc
  // from the front and as a line in profile
  const halo = [];
  const R = 0.148;
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const g = bevelBox(0.020, 0.017, (2 * Math.PI * R) / 20 * 0.9, 0.004);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2)),
      new THREE.Vector3(1, 1, 1),
    ));
    halo.push(g);
  }
  rig.add('head', joinGeometries(halo), 'trim',
    { p: [0, 0.104, -FRONT * 0.106], r: [16 * DEG, 0, 0], tier: TIER.PRIMARY });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.5;
    rig.glow('head', bevelBox(0.034, 0.011, 0.009, 0.003), 'spine', {
      p: [Math.cos(a) * R, 0.104 + Math.sin(a) * R, -FRONT * 0.096], r: [16 * DEG, 0, a + Math.PI / 2],
    });
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

/**
 * Skull form by `def.build.head`. Ten entries, one per fighter — the table is
 * the contract, and `chassisFor` falls back to the chassis's own only when a
 * character has not named one.
 */
const HEAD_BUILDERS = {
  furnace: headFurnace,
  swept: headSwept,
  turret: headTurret,
  crown: headCrown,
  kabuto: headKabuto,
  mandible: headMandible,
  lantern: headLantern,
  bunker: headBunker,
  mono: headMono,
  insulator: headInsulator,
};

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
  // A slab shoulder is not a stack of lames with the count turned down — a
  // corridor guard's pauldron is one square plate with a hard rolled rim, and
  // the difference between "curved shells" and "flat plate" is most of what
  // separates BASTION's outline from every other heavy in the cast.
  if (pd.slab) {
    const l0 = lames[0];
    const sw = pd.w * 1.30, sh = pd.h * 1.85, sd = pd.d * 1.24;
    const at = [sign * (ballX + pd.w * 0.34), l0.dy + pd.h * 0.10, 0];
    rig.add(`clavicle_${S}`, loftHull([
      { y: -sh * 0.5, w: sw * 0.92, d: sd * 0.92, round: 0.08 },
      { y: 0, w: sw, d: sd, round: 0.06, smooth: true },
      { y: sh * 0.5, w: sw * 0.96, d: sd * 0.94, round: 0.08 },
    ]), 'armorPrimary', {
      p: at, r: [0, 0, sign * -pd.tilt * 0.35 * DEG], mirror, tier: TIER.PRIMARY,
      // The one square plate a corridor guard's shoulder is: a bolted deck, not
      // a pressing, so it takes the wide pitch and the fastener row.
      role: 'deck',
    });
    for (const sy of [-1, 1]) {
      rig.add(`clavicle_${S}`, bevelBox(sw * 1.04, 0.026, sd * 1.04, 0.006), 'trim', {
        p: [at[0], at[1] + sy * sh * 0.49, at[2]], r: [0, 0, sign * -pd.tilt * 0.35 * DEG], mirror, tier: TIER.PRIMARY,
      });
    }
    rig.add(`clavicle_${S}`, bevelBox(0.026, sh * 1.02, sd * 1.04, 0.006), 'trim', {
      p: [at[0] + sign * sw * 0.49, at[1], at[2]], r: [0, 0, sign * -pd.tilt * 0.35 * DEG], mirror, tier: TIER.PRIMARY,
    });
    addPanelDetail(rig, `clavicle_${S}`, {
      p: [at[0], at[1], FRONT * (sd * 0.5 + 0.005)], r: [0, YAW_FRONT, 0],
      w: sw * 0.74, h: sh * 0.70, bolts: 4, splitsY: [-0.24, 0.26], splitsX: [0.16], mirror,
    });
    rig.glow(`clavicle_${S}`, bevelBox(sw * 0.56, 0.014, 0.012, 0.004), 'joints',
      { p: [at[0], at[1] - sh * 0.30, FRONT * (sd * 0.5 + 0.008)], mirror });
  }
  if (!pd.slab) {
    lames.forEach((l, i) => {
      const at = [sign * (ballX + l.dx), l.dy, l.dz];
      rig.add(`clavicle_${S}`, shellLathe([
        { r: l.R * 0.93, y: -l.half },
        { r: l.R, y: -l.half * 0.62, smooth: true },
        { r: l.R, y: l.half * 0.62, smooth: true },
        { r: l.R * 0.93, y: l.half },
      ], l.thick, lameSeg, { arc: l.a1 - l.a0, phase: l.a0 }),
      i === 0 ? 'armorPrimary' : 'armorSecondary', {
        // the lathe sweeps about +Y; -90 about X lays that sweep into the
        // frontal plane so the arc runs from under the arm up over the shoulder
        p: at, r: [-90 * DEG, 0, 0], mirror, tier: TIER.PRIMARY,
        // A lame is one pressing with a free ground rim all the way round and
        // no fasteners on show. Saying so is what stops the surfacing shading
        // its leading edge as a butted joint holding shadow, which is what made
        // a stack of five read as one quilted lump.
        role: 'lame',
      });
      // Rolled edge along the leading rim of each lame: a thin band standing
      // proud of the plate right where a real one would be ground bright, and
      // the only thing on the shoulder that reliably catches the rim light.
      const mid = (l.a0 + l.a1) * 0.5;
      rig.add(`clavicle_${S}`, shellLathe([
        { r: l.R * 1.03, y: -l.half * 0.99 }, { r: l.R * 1.05, y: -l.half * 0.86, smooth: true },
        { r: l.R * 1.05, y: l.half * 0.86, smooth: true }, { r: l.R * 1.03, y: l.half * 0.99 },
      ], l.thick * 0.55, Math.max(6, Math.round(lameSeg * 0.45)),
      { arc: (l.a1 - l.a0) * 0.42, phase: mid - (l.a1 - l.a0) * 0.21 }),
      'trim', { p: at, r: [-90 * DEG, 0, 0], mirror, tier: TIER.SECONDARY });
    });
  }

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
    mat: 'armorPrimary', gap: 0.015, inset: 0.86, round: 0.36, swell: 0.05, bands: 2, mirror,
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
    mat: 'armorPrimary', gap: 0.014, inset: 0.86, round: 0.34, swell: 0.04, bands: 2, mirror,
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
  rig.decal(`elbow_${S}`, MARKINGS.SERIAL, fore * 1.1, fore * 1.1, {
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

// ---------------------------------------------------------------------------
// Landmark elements
//
// One per fighter, named by `def.build.mark`. This used to be keyed off the
// chassis, which gave three precision fighters the same shoulder cannon and two
// agile fighters the same forearm blade — so the piece of hardware that was
// supposed to name a character was the piece that proved they were the same
// product. Every entry below belongs to exactly one fighter.
//
// They are all authored to the same two rules. First, the element reaches
// OUTSIDE the body outline: an addition tucked inside the silhouette costs
// triangles and buys nothing, which is the mistake the greeble layer already
// makes twice over. Second, several of them are deliberately asymmetric, because
// a mirrored pair reads as chassis and a single unit reads as a character.
// ---------------------------------------------------------------------------

/**
 * Ring of chamfered blocks in the local XY plane, centred on the origin.
 *
 * A lathed torus reads as a smooth donut under a hard key; a ring of faceted
 * blocks catches the rim light on each facet and reads as forged. Four places
 * wanted the same construction, so it lives here once.
 *
 * @param {number} R ring radius
 * @param {number} w block extent along the radius
 * @param {number} h block extent along the ring axis
 * @param {number} segs block count
 * @param {number} [bevel]
 */
function segmentRing(R, w, h, segs, bevel = 0.005) {
  const blocks = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const g = bevelBox(w, h, (2 * Math.PI * R) / segs * 0.92, bevel);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a + Math.PI / 2)),
      new THREE.Vector3(1, 1, 1),
    ));
    blocks.push(g);
  }
  return joinGeometries(blocks);
}

/** Shoulder-ball X offset in clavicle-local terms, as the pauldron uses. */
function ballOffset(rig, side) {
  return Math.abs((rig.restPos[`shoulder_${side}`]?.x ?? 0.155)
    - (rig.restPos[`clavicle_${side}`]?.x ?? 0)) * 0.58;
}

/**
 * VULKAN — twin flue stacks off one shoulder, and a pour lip on the other arm.
 *
 * Height is the whole point of a flue. At 0.40m the taller stack topped out
 * level with the helmet and disappeared into the head's own outline; the
 * fighter whose identity is a lit furnace read as a plain rectangle. They now
 * clear the crown, which also puts the exhaust glow above the shoulder line
 * where the bloom pass can separate it from the body.
 */
function markStacks(rig, spec) {
  const pd = scaledPauldron(spec, rig.dim);
  const bx = ballOffset(rig, 'R');
  for (let i = 0; i < 2; i++) {
    const h = 0.66 - i * 0.17;
    const x = -(bx + pd.w * (0.30 + i * 0.42));
    rig.add('clavicle_R', latheProfile([
      { r: 0.046, y: 0 }, { r: 0.046, y: h * 0.80 }, { r: 0.058, y: h * 0.86, smooth: true },
      { r: 0.058, y: h * 0.95 }, { r: 0.040, y: h }, { r: 0.034, y: h },
      { r: 0.034, y: h * 0.86 }, { r: 0.034, y: 0 },
    ], 20), 'darkMetal', {
      p: [x, pd.up + pd.h * 0.30, -FRONT * 0.030],
      r: [-9 * DEG, 0, -(7 + i * 9) * DEG], mirror: true, tier: TIER.PRIMARY, sprung: 'pack_R',
    });
    rig.add('clavicle_R', latheProfile([
      { r: 0.050, y: 0 }, { r: 0.062, y: 0.012, smooth: true }, { r: 0.062, y: 0.032 }, { r: 0.050, y: 0.044 },
    ], 20), 'trim', {
      p: [x, pd.up + pd.h * 0.30 + h * 0.34, -FRONT * 0.030],
      r: [-9 * DEG, 0, -(7 + i * 9) * DEG], mirror: true, tier: TIER.SECONDARY, sprung: 'pack_R',
    });
    rig.glow('clavicle_R', latheProfile([{ r: 0, y: 0 }, { r: 0.032, y: 0 }, { r: 0, y: 0.010 }], 18), 'vents', {
      p: [x - (0.11 - i * 0.02), pd.up + pd.h * 0.30 + h, -FRONT * 0.030],
      r: [-9 * DEG, 0, -(7 + i * 9) * DEG], mirror: true, sprung: 'pack_R',
    });
    rig.emitter('exhaust', 'clavicle_R', [x, pd.up + pd.h * 0.30 + h, -FRONT * 0.030], [0, 1, -0.2 * FRONT], 0.05);
  }
  // pour lip: a ladle spout clamped to the other forearm, so the two arms are
  // never the same object even before the brute gauntlet is applied
  const fore = spec.arms.fore * rig.dim.armK;
  rig.add('elbow_L', loftHull([
    { y: 0, w: fore * 1.10, d: fore * 0.60, round: 0.34 },
    { y: -0.11, w: fore * 0.86, d: fore * 0.44, z: FRONT * fore * 0.50, round: 0.30, smooth: true },
    { y: -0.17, w: fore * 0.40, d: fore * 0.20, z: FRONT * fore * 0.92, round: 0.44 },
  ]), 'trim', {
    p: [fore * 0.30, -rig.dim.fore * 0.74, FRONT * fore * 0.70], r: [0, 0, 16 * DEG], tier: TIER.PRIMARY,
  });
  rig.glow('elbow_L', bevelBox(fore * 0.34, 0.012, 0.012, 0.003), 'core',
    { p: [fore * 0.30, -rig.dim.fore * 0.92, FRONT * fore * 1.30] });
}

/**
 * KESTREL — long canards swept up and back off both shoulders.
 *
 * They used to lie almost flat, which put a horizontal bar across the shoulder
 * line — the same shape MANTIS's raptorial elbows make, and the two measured
 * 0.095 against each other. Raked up they close into a V above the shoulders
 * instead, which nothing else in the cast does, and the swept-back half gives
 * the profile a tail the fight camera can actually see.
 */
function markCanards(rig, spec) {
  const pd = scaledPauldron(spec, rig.dim);
  // Roll (Z) lifts the blade above the shoulder; yaw (Y) sweeps it aft. Both
  // are shared by every piece of the fin so the assembly stays one object.
  const roll = -46 * DEG;
  const yaw = 30 * DEG;
  for (const { s, sign, mirror } of SIDES) {
    const bx = ballOffset(rig, s);
    const at = [sign * (bx + pd.w * 0.46), pd.up + pd.h * 0.20, -FRONT * 0.010];
    const rot = [0, sign * yaw, sign * roll];
    rig.add(`clavicle_${s}`, loftHull([
      { y: 0, w: 0.036, d: 0.094, round: 0.30 },
      { y: 0.150, w: 0.026, d: 0.300, z: -FRONT * 0.120, round: 0.20, smooth: true },
      { y: 0.330, w: 0.013, d: 0.215, z: -FRONT * 0.300, round: 0.24 },
    ]), 'armorPrimary', {
      p: at, r: rot, order: 'YXZ', mirror, tier: TIER.PRIMARY, sprung: `pack_${s}`,
    });
    // Winglet at the tip, cranked the other way: it breaks the fin's own line so
    // the pair does not read as two plain triangles.
    rig.add(`clavicle_${s}`, loftHull([
      { y: 0, w: 0.020, d: 0.110, round: 0.28 },
      { y: 0.100, w: 0.011, d: 0.056, z: FRONT * 0.044, round: 0.38 },
    ]), 'armorAccent', {
      p: [at[0] + sign * 0.230, at[1] + 0.220, at[2] - FRONT * 0.250],
      r: [0, sign * yaw, sign * (roll + 30 * DEG)], order: 'YXZ',
      mirror, tier: TIER.PRIMARY, sprung: `pack_${s}`,
    });
    rig.glow(`clavicle_${s}`, loftHull([
      { y: 0.030, w: 0.008, d: 0.200, round: 0.5 },
      { y: 0.290, w: 0.006, d: 0.130, z: -FRONT * 0.150, round: 0.5 },
    ]), 'spine', {
      p: [at[0], at[1], at[2] - FRONT * 0.014], r: rot, order: 'YXZ', mirror, sprung: `pack_${s}`,
    });
    rig.emitter('thruster', `clavicle_${s}`,
      [at[0] + sign * 0.200, at[1] + 0.200, at[2] - FRONT * 0.260], [0, 0.3, -FRONT], 0.035);
  }
}

/** ANVIL — a lifting hook slung from a short boom on one shoulder. */
function markHook(rig, spec) {
  const pd = scaledPauldron(spec, rig.dim);
  const bx = ballOffset(rig, 'R');
  const x = -(bx + pd.w * 0.72);
  // boom
  rig.add('clavicle_R', loftHull([
    { y: 0, w: 0.062, d: 0.070, round: 0.28 },
    { y: 0.130, w: 0.048, d: 0.056, z: -FRONT * 0.030, round: 0.30, smooth: true },
    { y: 0.196, w: 0.034, d: 0.040, z: -FRONT * 0.076, round: 0.34 },
  ]), 'armorSecondary', {
    p: [x, pd.up + pd.h * 0.20, 0], r: [-12 * DEG, 0, -14 * DEG], mirror: true, tier: TIER.PRIMARY,
  });
  // shackle: a closed ring hanging off the boom head
  rig.add('clavicle_R', segmentRing(0.038, 0.019, 0.017, 12, 0.004), 'trim', {
    p: [x - 0.058, pd.up + pd.h * 0.20 + 0.170, -FRONT * 0.062], r: [0, 26 * DEG, 0], mirror: true, tier: TIER.PRIMARY,
  });
  // the hook itself, a swept tapering claw
  rig.add('clavicle_R', loftHull([
    { y: 0, w: 0.052, d: 0.058, round: 0.36 },
    { y: -0.110, w: 0.044, d: 0.050, z: FRONT * 0.026, round: 0.34, smooth: true },
    { y: -0.176, w: 0.034, d: 0.040, z: FRONT * 0.104, round: 0.38, smooth: true },
    { y: -0.150, w: 0.020, d: 0.024, z: FRONT * 0.176, round: 0.44 },
  ]), 'trim', {
    p: [x - 0.058, pd.up + pd.h * 0.20 + 0.126, -FRONT * 0.062],
    r: [0, 26 * DEG, -8 * DEG], mirror: true, tier: TIER.PRIMARY, sprung: 'pack_R',
  });
  // chain: three links running back up to the boom, so the hook is carried
  for (let i = 0; i < 3; i++) {
    rig.add('clavicle_R', segmentRing(0.017, 0.010, 0.009, 8, 0.002), 'darkMetal', {
      p: [x - 0.058, pd.up + pd.h * 0.20 + 0.144 - i * 0.028, -FRONT * 0.062],
      r: [0, 26 * DEG, i % 2 ? 90 * DEG : 0], mirror: true, tier: TIER.SECONDARY, sprung: 'pack_R',
    });
  }
  rig.decal('clavicle_R', MARKINGS.CAUTION, 0.10, 0.05, {
    p: [x - 0.036, pd.up + pd.h * 0.20 + 0.06, 0], r: [0, -90 * DEG, 90 * DEG], mirror: true, tier: TIER.GREEBLE,
  });
}

/** SERAPH — a fan of six blades radiating from the upper back. */
function markFan(rig, spec) {
  const t = spec.torso;
  const zb = -FRONT * (t.chestD * 0.5 + 0.06);
  // Wide, not tall. MANTIS's antennae also rise off the shoulders, and while
  // SERAPH's blades pointed up the two measured 0.817 overlap. Spread from 28-88
  // degrees rather than 28-88 vertical, and each blade three times as wide as it
  // was, so the fan reads as one continuous disc rather than as a bundle of
  // spikes — which is the one shape the insect chassis cannot make.
  for (const { s, sign, mirror } of SIDES) {
    for (let i = 0; i < 3; i++) {
      const spread = (34 + i * 27) * DEG;
      const len = 0.60 - i * 0.06;
      rig.add('chest', loftHull([
        { y: 0, w: 0.044, d: 0.026, round: 0.30 },
        { y: len * 0.52, w: 0.128, d: 0.017, z: -FRONT * 0.030, round: 0.16, smooth: true },
        { y: len, w: 0.086, d: 0.010, z: -FRONT * 0.072, round: 0.22 },
      ]), i === 1 ? 'armorAccent' : 'trim', {
        p: [sign * t.chestW * 0.14, 0.02, zb],
        r: [-16 * DEG, 0, sign * spread], mirror, tier: TIER.PRIMARY, sprung: `pack_${s}`,
      });
      rig.glow('chest', loftHull([
        { y: 0.06, w: 0.010, d: 0.008, round: 0.5 },
        { y: len * 0.92, w: 0.006, d: 0.006, round: 0.5 },
      ]), 'spine', {
        p: [sign * t.chestW * 0.14, 0.02, zb - FRONT * 0.014],
        r: [-16 * DEG, 0, sign * spread], mirror, sprung: `pack_${s}`,
      });
    }
  }
  // the boss the fan springs from, so the blades have a visible root
  rig.add('chest', latheProfile([
    { r: 0, y: 0 }, { r: 0.070, y: 0 }, { r: 0.076, y: 0.016, smooth: true },
    { r: 0.058, y: 0.046 }, { r: 0, y: 0.052 },
  ], 22), 'armorSecondary', { p: [0, 0.02, zb], r: [90 * DEG * FRONT, 0, 0], tier: TIER.PRIMARY });
}

/** RONIN-07 — two sheathed blades crossed at the small of the back. */
function markScabbards(rig, spec) {
  const t = spec.torso;
  for (const { s, sign, mirror } of SIDES) {
    const len = 0.86 * rig.dim.torsoS;
    const at = [sign * t.pelvisW * 0.30, 0.02, -FRONT * (t.waistD * 0.52)];
    // sheath: a long slightly curved lacquered tube
    rig.add('hips', loftHull([
      { y: -len * 0.5, w: 0.030, d: 0.052, z: -FRONT * 0.014, round: 0.30 },
      { y: 0, w: 0.036, d: 0.062, round: 0.26, smooth: true },
      { y: len * 0.5, w: 0.030, d: 0.050, z: FRONT * 0.012, round: 0.32 },
    ]), 'armorSecondary', {
      p: at, r: [8 * DEG, sign * 8 * DEG, sign * -58 * DEG], order: 'YXZ',
      mirror, tier: TIER.PRIMARY, sprung: `cable_${s}`,
    });
    // tsuba and grip wrap at the hilt end, pointing up over the shoulder
    const hx = sign * (t.pelvisW * 0.30 + Math.sin(58 * DEG) * len * 0.5);
    const hy = 0.02 + Math.cos(58 * DEG) * len * 0.5;
    rig.add('hips', latheProfile([
      { r: 0, y: 0 }, { r: 0.044, y: 0 }, { r: 0.044, y: 0.010 }, { r: 0.030, y: 0.014 }, { r: 0, y: 0.014 },
    ], 20), 'trim', {
      p: [hx, hy, -FRONT * (t.waistD * 0.52) + FRONT * 0.012],
      r: [8 * DEG, sign * 8 * DEG, sign * -58 * DEG], order: 'YXZ',
      mirror, tier: TIER.PRIMARY, sprung: `cable_${s}`,
    });
    rig.add('hips', loftHull([
      { y: 0, w: 0.024, d: 0.030, round: 0.40 },
      { y: 0.150, w: 0.021, d: 0.026, round: 0.42 },
    ]), 'rubber', {
      p: [hx, hy + 0.010, -FRONT * (t.waistD * 0.52) + FRONT * 0.012],
      r: [8 * DEG, sign * 8 * DEG, sign * -58 * DEG], order: 'YXZ',
      mirror, tier: TIER.PRIMARY, sprung: `cable_${s}`,
    });
    rig.glow('hips', bevelBox(0.010, 0.11, 0.010, 0.003), 'spine', {
      p: [hx * 0.92, hy - 0.10, -FRONT * (t.waistD * 0.52) - FRONT * 0.020],
      r: [8 * DEG, 0, sign * -58 * DEG], mirror, sprung: `cable_${s}`,
    });
  }
  // belt frog the two sheaths pass through
  rig.add('hips', bevelBox(t.pelvisW * 0.86, 0.046, 0.058, 0.008), 'trim',
    { p: [0, 0.010, -FRONT * (t.waistD * 0.50)], tier: TIER.PRIMARY });
}

/** MANTIS — oversized raptorial forearms with a serrated inner edge. */
function markRaptor(rig, spec) {
  const m = rig.dim;
  const fore = spec.arms.fore * m.armK;
  const len = m.fore * 1.26;
  for (const { s, sign, mirror } of SIDES) {
    // enlarged elbow cowl: the mass a folded raptorial limb carries at the joint
    rig.add(`elbow_${s}`, loftHull([
      { y: fore * 0.50, w: fore * 1.70, d: fore * 1.30, round: 0.36 },
      { y: -m.fore * 0.24, w: fore * 2.00, d: fore * 1.62, round: 0.30, smooth: true },
      { y: -m.fore * 0.56, w: fore * 1.40, d: fore * 1.10, round: 0.38 },
    ]), 'armorSecondary', {
      p: [0, 0, -FRONT * fore * 0.20], r: [-6 * DEG, 0, sign * 4 * DEG], mirror, tier: TIER.PRIMARY,
    });
    // the blade, running the whole outer edge of the forearm and past the fist
    rig.add(`elbow_${s}`, loftHull([
      { y: fore * 0.30, w: 0.024, d: fore * 0.90, round: 0.24 },
      { y: -len * 0.46, w: 0.020, d: fore * 1.20, round: 0.16, smooth: true },
      { y: -len * 0.94, w: 0.014, d: fore * 0.86, z: FRONT * fore * 0.30, round: 0.20, smooth: true },
      { y: -len * 1.14, w: 0.007, d: fore * 0.30, z: FRONT * fore * 0.62, round: 0.36 },
    ]), 'trim', {
      p: [sign * fore * 0.98, 0, -FRONT * fore * 0.12],
      r: [0, 0, sign * -5 * DEG], mirror, tier: TIER.PRIMARY,
    });
    // serration: five teeth along the inner edge, which is what says raptorial
    for (let i = 0; i < 5; i++) {
      rig.add(`elbow_${s}`, loftHull([
        { y: 0, w: 0.014, d: 0.036, round: 0.24 },
        { y: -0.030, w: 0.008, d: 0.014, z: -FRONT * 0.024, round: 0.36 },
      ]), 'trim', {
        p: [sign * fore * 0.86, -len * (0.14 + i * 0.19), -FRONT * fore * 0.62],
        r: [0, 0, sign * -22 * DEG], mirror, tier: TIER.SECONDARY,
      });
    }
    rig.glow(`elbow_${s}`, bevelBox(0.010, len * 0.80, 0.010, 0.003), 'spine',
      { p: [sign * fore * 1.06, -len * 0.42, -FRONT * fore * 0.12], mirror });
    rig.emitter('blade', `elbow_${s}`, [sign * fore * 0.98, -len * 1.14, FRONT * fore * 0.50], [0, -1, FRONT * 0.4], 0.03);
  }
}

/** NYX — rings that hold position without touching anything. */
function markRings(rig, spec) {
  const m = rig.dim;
  const pd = scaledPauldron(spec, m);
  const fore = spec.arms.fore * m.armK;
  for (const { s, sign, mirror } of SIDES) {
    // shoulder ring, standing clear outboard of the pauldron
    const R = 0.150;
    rig.add(`clavicle_${s}`, segmentRing(R, 0.030, 0.026, 12), 'armorAccent', {
      p: [sign * (pd.out + pd.w * 1.05), pd.up - 0.02, 0],
      r: [0, sign * 22 * DEG, sign * -18 * DEG], mirror, tier: TIER.PRIMARY,
    });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      rig.glow(`clavicle_${s}`, bevelBox(0.036, 0.012, 0.012, 0.003), 'core', {
        p: [sign * (pd.out + pd.w * 1.05) + Math.cos(a) * R * 0.94, pd.up - 0.02 + Math.sin(a) * R * 0.94, 0],
        r: [0, sign * 22 * DEG, a + Math.PI / 2], mirror,
      });
    }
    // forearm ring, floating off the wrist with a visible gap all round
    rig.add(`elbow_${s}`, segmentRing(fore * 1.70, 0.024, 0.020, 10), 'trim', {
      p: [0, -m.fore * 0.72, 0], r: [(90 + 12) * DEG, 0, sign * 8 * DEG], mirror, tier: TIER.PRIMARY,
    });
    rig.glow(`elbow_${s}`, segmentRing(fore * 1.44, 0.010, 0.009, 8), 'spine', {
      p: [0, -m.fore * 0.72, 0], r: [(90 + 12) * DEG, 0, sign * 8 * DEG], mirror,
    });
  }
  // waist ring, canted so it is never parallel to anything else on the body
  rig.add('hips', segmentRing(spec.torso.pelvisW * 0.92, 0.028, 0.022, 16), 'armorAccent',
    { p: [0, 0.02, 0], r: [(90 + 9) * DEG, 0, 6 * DEG], tier: TIER.PRIMARY });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    rig.glow('hips', bevelBox(0.030, 0.011, 0.011, 0.003), 'core', {
      p: [Math.cos(a) * spec.torso.pelvisW * 0.90, 0.02 + Math.sin(a) * 0.02, Math.sin(a) * spec.torso.pelvisW * 0.90],
      r: [0, -a, 0],
    });
  }
}

/** BASTION — a tower shield on one forearm, taller than the torso. */
function markTowerShield(rig, spec) {
  const m = rig.dim;
  const fore = spec.arms.fore * m.armK;
  const h = (m.upper + m.fore) * 1.34;
  const w = spec.torso.chestW * 0.86;
  const at = [fore * 1.55, -m.fore * 0.42, FRONT * fore * 0.30];
  rig.add('elbow_L', loftHull([
    { y: -h * 0.5, w: w * 0.82, d: 0.052, round: 0.14 },
    { y: -h * 0.16, w, d: 0.062, round: 0.09, smooth: true },
    { y: h * 0.22, w, d: 0.062, round: 0.09, smooth: true },
    { y: h * 0.5, w: w * 0.72, d: 0.046, round: 0.16 },
  ]), 'armorPrimary', { p: at, r: [0, -8 * DEG, -5 * DEG], tier: TIER.PRIMARY });
  // rim: a rolled band right round the edge, the thing that catches the rim light
  for (const sy of [-1, 1]) {
    rig.add('elbow_L', bevelBox(w * 1.02, 0.030, 0.074, 0.007), 'trim',
      { p: [at[0], at[1] + sy * h * 0.49, at[2]], r: [0, -8 * DEG, -5 * DEG], tier: TIER.PRIMARY });
  }
  for (const sx of [-1, 1]) {
    rig.add('elbow_L', bevelBox(0.030, h * 0.98, 0.074, 0.007), 'trim',
      { p: [at[0] + sx * w * 0.49, at[1], at[2] + sx * 0.006], r: [0, -8 * DEG, -5 * DEG], tier: TIER.PRIMARY });
  }
  // central boss and two horizontal ribs
  rig.add('elbow_L', latheProfile([
    { r: 0, y: 0 }, { r: 0.082, y: 0 }, { r: 0.088, y: 0.020, smooth: true },
    { r: 0.062, y: 0.056 }, { r: 0, y: 0.062 },
  ], 22), 'trim', {
    p: [at[0], at[1], at[2] + FRONT * 0.032], r: [90 * DEG * FRONT, -8 * DEG, 0], order: 'ZYX', tier: TIER.PRIMARY,
  });
  for (const dy of [-0.30, 0.30]) {
    rig.add('elbow_L', bevelBox(w * 0.94, 0.024, 0.032, 0.006), 'armorSecondary',
      { p: [at[0], at[1] + h * dy, at[2] + FRONT * 0.020], r: [0, -8 * DEG, -5 * DEG], tier: TIER.SECONDARY });
  }
  rig.glow('elbow_L', bevelBox(w * 0.62, 0.014, 0.012, 0.004), 'core',
    { p: [at[0], at[1] + h * 0.10, at[2] + FRONT * 0.026], r: [0, -8 * DEG, -5 * DEG] });
  rig.decal('elbow_L', MARKINGS.HAZARD, w * 0.72, 0.05, {
    p: [at[0], at[1] - h * 0.40, at[2] + FRONT * 0.026], r: [0, YAW_FRONT, 0], tier: TIER.GREEBLE,
  });
  rig.add('elbow_L', boltRing(6, 0.100, 0.010, 0.012), 'trim',
    { p: [at[0], at[1], at[2] - FRONT * 0.030], r: [-90 * DEG * FRONT, 0, 0], tier: TIER.GREEBLE });
}

/**
 * AXIOM — a calibration hoop standing clear of the shoulders.
 *
 * It was a straight bar across the shoulders, and a bar has no depth: edge-on
 * it is two centimetres of nothing, so in the one view the fight camera
 * actually frames, the reference chassis had no landmark at all and measured
 * 0.085 against RONIN, the closest pair in the cast. A ring of the same span
 * subtends the same width from *every* horizontal direction, which is exactly
 * the property a landmark on this fighter needs — and a true circle floating
 * off a smooth ovoid body is also the one silhouette in the roster that no
 * amount of bolted-on hardware can imitate.
 */
function markYoke(rig, spec) {
  const m = rig.dim;
  const pd = scaledPauldron(spec, m);
  // Wide enough to clear the pauldrons by a clear margin at every bearing —
  // a hoop that grazes the shoulder line merges into it and is not a landmark.
  const shoulder = Math.abs(rig.restPos.shoulder_L?.x ?? 0.155);
  const R = Math.max(shoulder + pd.w * 0.95, pd.out + pd.w * 1.9);
  // Carried at head height, so the ring encircles the skull rather than sitting
  // on the collar where the pauldrons are already competing for the outline.
  const y = m.collar + m.nape + m.skull * 0.42;
  const at = [0, y, -FRONT * 0.010];
  rig.add('chest', segmentRing(R, 0.034, 0.052, 30, 0.007), 'armorSecondary',
    { p: at, r: [90 * DEG, 0, 0], tier: TIER.PRIMARY });
  // Three struts down to the shoulder deck. Without them the hoop reads as a
  // halo hovering unattached, which belongs to the arcane chassis, not this one.
  const drop = y - (m.collar * 0.86);
  for (const a of [0, 2.094, -2.094]) {
    rig.add('chest', loftHull([
      { y: 0, w: 0.034, d: 0.034, round: 0.34 },
      { y: -drop, w: 0.052, d: 0.046, round: 0.30 },
    ]), 'darkMetal', {
      p: [Math.sin(a) * R * 0.93, at[1], at[2] + Math.cos(a) * R * 0.93],
      r: [Math.cos(a) * 7 * DEG, 0, -Math.sin(a) * 7 * DEG], tier: TIER.PRIMARY,
    });
  }
  // Graduation ticks around the rim, the only marking on the cleanest chassis
  // in the cast, and the reason it reads as an instrument rather than a crown.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    rig.add('chest', bevelBox(0.007, 0.030, 0.011, 0.0015), 'trim', {
      p: [Math.sin(a) * R, at[1] + 0.028, at[2] + Math.cos(a) * R],
      r: [0, a, 0], tier: TIER.GREEBLE,
    });
  }
  for (const { sign, mirror } of SIDES) {
    rig.glow('chest', bevelBox(0.018, 0.016, 0.014, 0.003), 'joints',
      { p: [sign * R, at[1] + 0.018, at[2]], mirror });
  }
  rig.glow('chest', segmentRing(R * 0.995, 0.009, 0.011, 26, 0.002), 'spine',
    { p: [at[0], at[1] + 0.024, at[2]], r: [90 * DEG, 0, 0] });
}

/** VOLTA — copper windings around both upper arms. */
function markCoils(rig, spec) {
  const m = rig.dim;
  const upper = spec.arms.upper * m.armK;
  for (const { s, sign, mirror } of SIDES) {
    // Wound well proud of the arm. Measured: at 1.7x the upper-arm radius the
    // coils sat 2cm outside a 19cm limb and did not survive the 100-pixel test,
    // and with the torso hidden behind the arms in every stance the game
    // actually uses, the arm IS this fighter's outline.
    const turns = 8;
    for (let i = 0; i < turns; i++) {
      const f = i / (turns - 1);
      const r = upper * (2.35 + Math.sin(f * Math.PI) * 0.52);
      rig.add(`shoulder_${s}`, latheProfile([
        { r: r - 0.013, y: 0 }, { r, y: 0.008, smooth: true }, { r: r - 0.013, y: 0.017 },
      ], 20), 'trim', {
        p: [0, -m.upper * (0.16 + f * 0.62), 0], r: [0, 0, sign * (f - 0.5) * 5 * DEG],
        mirror, tier: TIER.PRIMARY,
      });
    }
    // terminal caps top and bottom of the winding, with the tap between them
    for (const dy of [0.10, 0.84]) {
      rig.add(`shoulder_${s}`, latheProfile([
        { r: 0, y: 0 }, { r: upper * 2.24, y: 0 }, { r: upper * 2.34, y: 0.016, smooth: true },
        { r: upper * 1.96, y: 0.040 }, { r: 0, y: 0.040 },
      ], 22), 'darkMetal', { p: [0, -m.upper * dy, 0], mirror, tier: TIER.PRIMARY });
    }
    addPipeRun(rig, `shoulder_${s}`, [
      [sign * upper * 2.40, -m.upper * 0.12, -FRONT * upper * 0.50],
      [sign * upper * 3.00, -m.upper * 0.50, -FRONT * upper * 0.95],
      [sign * upper * 2.50, -m.upper * 0.86, -FRONT * upper * 0.50],
    ], { radius: 0.013, mirror, mat: 'trim', tier: TIER.SECONDARY });
    rig.glow(`shoulder_${s}`, bevelBox(0.016, m.upper * 0.66, 0.016, 0.004), 'core',
      { p: [sign * upper * 2.86, -m.upper * 0.48, 0], mirror });
    rig.emitter('arc', `shoulder_${s}`, [sign * upper * 3.00, -m.upper * 0.50, 0], [sign, 0, 0], 0.035);
  }
}

/**
 * Landmark element by `def.build.mark`. Ten entries, one per fighter.
 */
const MARK_BUILDERS = {
  stacks: markStacks,
  canards: markCanards,
  hook: markHook,
  fan: markFan,
  scabbards: markScabbards,
  raptor: markRaptor,
  rings: markRings,
  towershield: markTowerShield,
  yoke: markYoke,
  coils: markCoils,
};

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

function buildLeg(rig, spec, side, sign, mirror) {
  const Lsrc = spec.legs;
  const m = rig.dim;
  const S = side;
  const digi = Lsrc.plan === 'digitigrade';
  const splay = Lsrc.plan === 'splayed';
  const piston = Lsrc.plan === 'piston';

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
  //
  // Depth is not capped, and that is deliberate. A leg is limited sideways by
  // the width of the pelvis and by nothing at all fore-and-aft, so a real one is
  // markedly deeper than it is wide. Building it square is what leaves a fighter
  // with a huge torso standing on two sticks in every profile view, and the
  // fight camera spends most of a round somewhere near profile.
  // A piston leg is a short fat thigh on a bare telescoping column, so its
  // thigh runs wider and its knee narrower than any other plan; a digitigrade
  // leg is the opposite at the ankle, which is what makes the lower limb read as
  // a bird's rather than as a thinner version of a boot.
  const thighW = Math.min(L.thigh * (piston ? 1.62 : 1.40), m.hipSep * (piston ? 1.30 : 1.16));
  const kneeW = Math.min(L.shin * (piston ? 1.06 : 1.30), m.hipSep * 0.90);
  const ankleW = kneeW * (digi ? 0.62 : 0.78);
  const DEEP = 1.30;

  // --- thigh: one section from inside the hip ball down to the knee barrel
  rig.plated(`hip_${S}`, {
    y0: -tLen * (piston ? 0.72 : 0.90), y1: L.thigh * 0.42,
    w0: kneeW * (piston ? 1.30 : 0.96), w1: thighW,
    d0: kneeW * (piston ? 1.44 : 1.10), d1: thighW * DEEP,
    mat: 'armorPrimary', gap: 0.019, inset: 0.84, round: piston ? 0.48 : 0.36,
    swell: piston ? 0.13 : 0.07, swellAt: 0.62, bands: piston ? 1 : 2,
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
  rig.decal(`hip_${S}`, MARKINGS.ARROW, L.thigh * 0.7, L.thigh * 0.7, {
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
    // Digitigrade read. It only works if the two halves of the lower leg
    // genuinely disagree: a calf mass swept hard BACK at the top, and a slim
    // lower leg swept forward off it. The previous numbers put the hock 30% of a
    // shin width behind the bone with a 1.55 depth ratio, which at silhouette
    // size is a slightly bulgy plantigrade shin — the measured overlap against
    // the plantigrade fighters said so. These push it to 0.58 and 2.05.
    rig.section(`knee_${S}`, {
      y0: -sLen * 0.46, y1: L.shin * 0.42,
      w0: kneeW * 0.78, w1: kneeW * 1.04,
      d0: kneeW * 1.20, d1: kneeW * 2.05,
      mat: 'armorPrimary', z: -FRONT * L.shin * 0.58,
      shearZ: -FRONT * 0.085, round: 0.42, swell: 0.10, mirror,
    });
    rig.section(`knee_${S}`, {
      y0: -sLen * 0.96, y1: -sLen * 0.40,
      w0: ankleW * 0.88, w1: kneeW * 0.74,
      d0: ankleW * 1.10, d1: kneeW * 0.96,
      mat: 'armorPrimary', z: FRONT * L.shin * 0.06,
      shearZ: FRONT * 0.075, round: 0.44, mirror,
    });
    // Achilles tendon: a bare cable-and-frame run down the back of the slim
    // section, which is what tells the eye the mass above it is a calf.
    rig.add(`knee_${S}`, loftHull([
      { y: -sLen * 0.90, w: ankleW * 0.40, d: ankleW * 0.34, round: 0.46 },
      { y: -sLen * 0.44, w: ankleW * 0.46, d: ankleW * 0.40, round: 0.46 },
    ]), 'darkMetal', { p: [0, 0, -FRONT * L.shin * 0.34], mirror, tier: TIER.PRIMARY });
    // calf thruster
    rig.add(`knee_${S}`, latheProfile([
      { r: L.shin * 0.30, y: 0 }, { r: L.shin * 0.30, y: 0.05 }, { r: L.shin * 0.42, y: 0.085, smooth: true },
      { r: L.shin * 0.26, y: 0.09 }, { r: L.shin * 0.22, y: 0.05 }, { r: L.shin * 0.22, y: 0 },
    ], 16), 'darkMetal', { p: [0, -sLen * 0.26, -FRONT * L.shin * 1.35], r: [(160 * DEG) * -FRONT, 0, 0], mirror, tier: TIER.SECONDARY });
    rig.glow(`knee_${S}`, latheProfile([{ r: 0, y: 0 }, { r: L.shin * 0.22, y: 0 }, { r: 0, y: 0.008 }], 16), 'vents',
      { p: [0, -sLen * 0.34, -FRONT * L.shin * 1.42], r: [(160 * DEG) * -FRONT, 0, 0], mirror });
    rig.emitter('thruster', `knee_${S}`, [0, -sLen * 0.36, -FRONT * L.shin * 1.45], [0, -0.4, -FRONT], 0.04);
  } else if (piston) {
    // Piston leg: no shin armour at all below the knee cuff, just the bare
    // telescoping column with its gland nuts on show. A leg that is mostly
    // *absent* is as strong a silhouette cue as one that is oversized, and it
    // is the only lower limb in the cast that narrows to a straight cylinder.
    rig.section(`knee_${S}`, {
      y0: -sLen * 0.30, y1: L.shin * 0.46,
      w0: kneeW * 1.14, w1: kneeW * 1.30,
      d0: kneeW * 1.26, d1: kneeW * 1.44,
      mat: 'armorPrimary', round: 0.46, swell: 0.06, mirror,
    });
    const cr = kneeW * 0.52;
    rig.add(`knee_${S}`, latheProfile([
      { r: cr * 1.20, y: -sLen * 0.30 }, { r: cr, y: -sLen * 0.36, smooth: true },
      { r: cr, y: -sLen * 0.70 }, { r: cr * 0.78, y: -sLen * 0.74 },
      { r: cr * 0.78, y: -sLen * 0.98 }, { r: cr * 0.60, y: -sLen * 1.00 },
    ], 20), 'piston', { mirror, tier: TIER.PRIMARY });
    for (const f of [0.36, 0.70, 0.92]) {
      rig.add(`knee_${S}`, latheProfile([
        { r: cr * 1.02, y: 0 }, { r: cr * 1.22, y: 0.012, smooth: true },
        { r: cr * 1.22, y: 0.032 }, { r: cr * 1.02, y: 0.044 },
      ], 20), 'trim', { p: [0, -sLen * f, 0], mirror, tier: TIER.SECONDARY });
    }
    for (const { sign: sx } of SIDES) {
      addPipeRun(rig, `knee_${S}`, [
        [sx * cr * 1.1, -sLen * 0.34, -FRONT * cr * 0.5],
        [sx * cr * 1.5, -sLen * 0.62, -FRONT * cr * 0.9],
        [sx * cr * 1.2, -sLen * 0.92, -FRONT * cr * 0.4],
      ], { radius: 0.009, mirror, tier: TIER.SECONDARY });
    }
    rig.glow(`knee_${S}`, latheProfile([
      { r: cr * 0.84, y: 0 }, { r: cr * 0.90, y: 0.004 }, { r: cr * 0.90, y: 0.012 }, { r: cr * 0.84, y: 0.016 },
    ], 20), 'joints', { p: [0, -sLen * 0.52, 0], mirror });
  } else {
    rig.plated(`knee_${S}`, {
      y0: -sLen * 0.92, y1: L.shin * 0.44,
      w0: ankleW, w1: kneeW,
      d0: ankleW * 1.20, d1: kneeW * DEEP,
      mat: 'armorPrimary', gap: 0.018, inset: 0.84, round: 0.34, swell: 0.08, swellAt: 0.66, bands: 2, mirror,
    });
    // calf vent stack
    addLouvres(rig, `knee_${S}`, {
      p: [0, -sLen * 0.42, -FRONT * (L.shin * 0.78)], r: [0, YAW_BACK, 0],
      w: L.shin * 0.9, h: sLen * 0.36, n: ventFins(spec, 0.6), depth: 0.016, mirror, glow: 'vents',
    });
    rig.add(`knee_${S}`, bevelBox(0.024, sLen * 0.5, L.shin * 0.9, 0.006, { topX: 0.8 }), 'carbon',
      { p: [sign * L.shin * 0.76, -sLen * 0.42, 0], mirror, tier: TIER.SECONDARY });
  }
  // Panel breakup belongs on a shin that has a shin plate. On a piston leg the
  // same call would bolt a fastener row onto empty air beside the ram.
  if (!piston) {
    addPanelDetail(rig, `knee_${S}`, {
      p: [0, -sLen * 0.46, FRONT * (L.shin * 0.76 + 0.004)], r: [0, YAW_FRONT, 0],
      w: L.shin * 1.08, h: sLen * 0.46, bolts: 4, splitsY: [0.24], splitsX: [], mirror,
    });
  }
  rig.decal(`knee_${S}`, MARKINGS.RIVETS, L.shin * 1.1, L.shin * 0.28, {
    p: [0, -sLen * 0.16, FRONT * (L.shin * (piston ? 0.68 : 0.80))], r: [0, YAW_FRONT, 0], mirror, tier: TIER.GREEBLE,
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
  // A boot assembled from a sole box, a toe box and a heel box reads as three
  // boxes, and it reads that way from every angle the fight camera uses because
  // the feet are the one part of a fighter never occluded by anything. So each
  // mass below is a lofted volume that swells at the instep and sweeps back into
  // the ankle, and the only boxes left are the sole pads and the cleats.
  if (digi) {
    // Raptor foot: a slim pad thrown forward onto a long toe, with a tall heel
    // spur standing well behind and above it. The spur is the part that reads —
    // it puts a hard notch in the back of the ankle that a boot never has.
    rig.add(`foot_${S}`, loftHull([
      { y: -0.018, w: fw * 0.90, d: fl * 0.54, round: 0.42 },
      { y: 0.022, w: fw * 1.02, d: fl * 0.60, round: 0.32, smooth: true },
      { y: 0.056, w: fw * 0.86, d: fl * 0.48, z: -FRONT * fl * 0.04, round: 0.36 },
    ]), 'armorPrimary', { p: [0, 0, FRONT * fl * 0.10], mirror, tier: TIER.PRIMARY });
    rig.add(`foot_${S}`, loftHull([
      { y: -0.030, w: fw * 0.52, d: fl * 0.34, round: 0.38 },
      { y: 0.030, w: fw * 0.44, d: fl * 0.28, z: -FRONT * fl * 0.06, round: 0.34, smooth: true },
      { y: 0.092, w: fw * 0.24, d: fl * 0.15, z: -FRONT * fl * 0.15, round: 0.46 },
    ]), 'armorSecondary', {
      p: [0, 0.062, -FRONT * fl * 0.40], r: [-34 * DEG, 0, 0], mirror, tier: TIER.PRIMARY,
    });
    rig.add(`toe_${S}`, loftHull([
      { y: 0.020, w: fw * 0.80, d: fl * 0.62, round: 0.40 },
      { y: 0.050, w: fw * 0.84, d: fl * 0.58, z: FRONT * fl * 0.05, round: 0.32, smooth: true },
      { y: 0.078, w: fw * 0.54, d: fl * 0.36, z: FRONT * fl * 0.12, round: 0.44 },
    ]), 'armorPrimary', { p: [0, 0, FRONT * fl * 0.16], mirror, tier: TIER.PRIMARY });
    // three splayed claws, each its own toe rather than a shared cleat bar
    for (let i = -1; i <= 1; i++) {
      rig.add(`toe_${S}`, loftHull([
        { y: 0.030, w: fw * 0.22, d: fl * 0.30, round: 0.40 },
        { y: 0.012, w: fw * 0.15, d: fl * 0.20, z: FRONT * fl * 0.10, round: 0.44, smooth: true },
        { y: -0.008, w: fw * 0.06, d: fl * 0.08, z: FRONT * fl * 0.17, round: 0.48 },
      ]), 'trim', {
        p: [i * fw * 0.30, 0.020, FRONT * fl * 0.42], r: [0, i * -13 * DEG, 0], mirror, tier: TIER.PRIMARY,
      });
    }
    rig.add(`foot_${S}`, bevelBox(fw * 0.88, 0.020, fl * 0.50, 0.005), 'rubber',
      { p: [0, -0.020, FRONT * fl * 0.10], mirror, tier: TIER.SECONDARY });
  } else if (piston) {
    // Pad foot: one round plate on the end of the ram, no toe break at all.
    // A circular footprint is the only foot plan in the cast with no long axis,
    // and that is what makes a piston leg read as machinery on rails.
    const pr = fw * 0.86;
    rig.add(`foot_${S}`, latheProfile([
      { r: 0, y: -0.024 }, { r: pr * 0.86, y: -0.024 }, { r: pr, y: 0.004, smooth: true },
      { r: pr * 0.94, y: 0.046 }, { r: pr * 0.56, y: 0.072 }, { r: 0, y: 0.082 },
    ], 24), 'armorPrimary', { p: [0, 0, FRONT * fl * 0.06], mirror, tier: TIER.PRIMARY });
    rig.add(`foot_${S}`, latheProfile([
      { r: 0, y: 0 }, { r: pr * 1.02, y: 0 }, { r: pr * 1.02, y: 0.018 }, { r: 0, y: 0.018 },
    ], 24), 'rubber', { p: [0, -0.030, FRONT * fl * 0.06], mirror, tier: TIER.PRIMARY });
    rig.add(`foot_${S}`, boltRing(8, pr * 0.72, 0.010, 0.012), 'trim',
      { p: [0, 0.050, FRONT * fl * 0.06], mirror, tier: TIER.GREEBLE });
    // a stub toe plate so the foot can still roll without showing daylight
    rig.add(`toe_${S}`, loftHull([
      { y: 0.016, w: fw * 0.92, d: fl * 0.26, round: 0.48 },
      { y: 0.052, w: fw * 0.76, d: fl * 0.20, round: 0.5 },
    ]), 'armorSecondary', { p: [0, 0, FRONT * fl * 0.02], mirror, tier: TIER.PRIMARY });
    rig.glow(`foot_${S}`, bevelBox(pr * 1.0, 0.012, 0.012, 0.003), 'joints',
      { p: [0, 0.008, FRONT * (fl * 0.06 + pr * 0.92)], mirror });
  } else {
    // heavy boot: one swept shell from the sole up into the ankle collar
    rig.add(`foot_${S}`, loftHull([
      { y: -0.019, w: fw * 1.25, d: fl * 0.86, round: 0.30 },
      { y: 0.028, w: fw * 1.30, d: fl * 0.90, round: 0.24, smooth: true },
      { y: 0.066, w: fw * 1.14, d: fl * 0.78, z: -FRONT * fl * 0.03, round: 0.28, smooth: true },
      { y: 0.091, w: fw * 0.98, d: fl * 0.58, z: -FRONT * fl * 0.06, round: 0.38 },
      // A boot shell is one deep drawing: very few, very large panels and no
      // fastener anywhere a kerb could reach. It is also the part of the machine
      // that gets scuffed hardest, so its rim wants to read as ground metal.
    ]), 'armorPrimary', { mirror, tier: TIER.PRIMARY, role: 'boot' });
    rig.add(`foot_${S}`, bevelBox(fw * 1.28, 0.030, fl * 0.90, 0.006), 'rubber',
      { p: [0, -0.015, 0], mirror, tier: TIER.PRIMARY });
    rig.add(`toe_${S}`, loftHull([
      { y: 0.018, w: fw * 1.10, d: fl * 0.42, round: 0.32 },
      { y: 0.058, w: fw * 1.04, d: fl * 0.40, z: FRONT * fl * 0.02, round: 0.26, smooth: true },
      { y: 0.100, w: fw * 0.78, d: fl * 0.26, z: FRONT * fl * 0.05, round: 0.42 },
    ]), 'armorAccent', {
      p: [0, 0, FRONT * fl * 0.06], r: [-6 * DEG, 0, 0], mirror, tier: TIER.PRIMARY,
    });
    rig.add(`toe_${S}`, bevelBox(fw * 1.12, 0.022, fl * 0.44, 0.005), 'rubber',
      { p: [0, 0.026, FRONT * fl * 0.06], mirror, tier: TIER.SECONDARY });
    // heel counter, tapering up and back into the ankle joint
    rig.add(`foot_${S}`, loftHull([
      { y: 0.004, w: fw * 0.94, d: fl * 0.30, round: 0.34 },
      { y: 0.056, w: fw * 0.84, d: fl * 0.25, z: -FRONT * fl * 0.02, round: 0.30, smooth: true },
      { y: 0.096, w: fw * 0.58, d: fl * 0.16, z: -FRONT * fl * 0.04, round: 0.44 },
    ]), 'armorSecondary', { p: [0, 0, -FRONT * fl * 0.40], mirror, tier: TIER.PRIMARY });
    // cleats
    for (let i = 0; i < 3; i++) {
      rig.add(`foot_${S}`, bevelBox(fw * 1.1, 0.012, 0.022, 0.004), 'darkMetal',
        { p: [0, -0.026, FRONT * (fl * 0.26 - i * fl * 0.26)], mirror, tier: TIER.GREEBLE });
    }
    if (splay) {
      for (const o of [-1, 1]) {
        rig.add(`foot_${S}`, loftHull([
          { y: -0.014, w: fw * 0.34, d: fl * 0.50, round: 0.36 },
          { y: 0.020, w: fw * 0.30, d: fl * 0.44, round: 0.32, smooth: true },
          { y: 0.046, w: fw * 0.18, d: fl * 0.28, round: 0.44 },
        ]), 'armorSecondary', {
          p: [o * fw * 0.72, 0.040, -FRONT * fl * 0.05], r: [0, 0, o * 14 * DEG], mirror, tier: TIER.SECONDARY,
        });
      }
    }
  }
  rig.add(`ankle_${S}`, latheProfile([
    { r: ankleW * 0.44, y: 0.02 }, { r: ankleW * 0.50, y: 0.0, smooth: true }, { r: ankleW * 0.50, y: -0.028 },
    { r: ankleW * 0.41, y: -0.044 },
  ], 20), 'trim', { p: [0, -0.01, 0], mirror, tier: TIER.SECONDARY });
  rig.decal(`foot_${S}`, MARKINGS.HAZARD, fw * 0.9, 0.028, {
    p: [0, 0.045, FRONT * (fl * 0.44)], r: [0, YAW_FRONT, 0], mirror, tier: TIER.GREEBLE,
  });
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

  // 1. Shoulder crest blades used to be seeded here, up to three swept spikes
  // per side driven off `spikes`. They are gone, and their removal is measured:
  // six of the ten fighters qualified for them, they were the tallest thing in
  // the silhouette, and they were the SAME loft on all six — so the element
  // meant to distinguish characters was the strongest evidence that they were
  // one product line. SERAPH and MANTIS measured 0.837 silhouette overlap
  // largely because both wore a fan of them. Each fighter now carries a
  // landmark of its own instead (see MARK_BUILDERS). The budget is spent here
  // instead, on studs bedded into the pauldron's leading rim: hardware that
  // lives INSIDE the outline, where sharing a form across the cast costs the
  // silhouette nothing and still says the plate was made to take a hit.
  for (let i = 0; i < spec.spikes; i++) {
    const f = (i + 0.5) / spec.spikes;
    for (const { s, sign, mirror } of SIDES) {
      const ballX = Math.abs((rig.restPos[`shoulder_${s}`]?.x ?? 0.155)
        - (rig.restPos[`clavicle_${s}`]?.x ?? 0)) * 0.58;
      const a = lame.a0 + (lame.a1 - lame.a0) * f;
      rig.add(`clavicle_${s}`, hexBolt(0.011, 0.014), 'trim', {
        p: [sign * (ballX + lame.dx + Math.cos(a) * lame.R * 0.02),
          lame.dy + Math.sin(a) * lame.R * 1.02,
          FRONT * lame.half * 0.62 + Math.cos(a) * lame.R * 0.06],
        r: [-90 * DEG, 0, sign * a], order: 'ZXY', mirror, tier: TIER.GREEBLE,
      });
    }
  }

  // 1b. asymmetric markings.
  //
  // Real hardware is not stencilled symmetrically: the unit number goes on one
  // shoulder, tally chevrons on the other, servicing instructions wherever the
  // technician stands. That single asymmetry is worth more to the read than
  // another twenty greebles, and it is the cue that says a person maintained
  // this machine rather than that a generator extruded it.
  const numberSide = rng.sign();
  const unitCell = rng.pick([MARKINGS.UNIT, MARKINGS.ROUNDEL, MARKINGS.SERIAL]);
  for (const { s, sign, mirror } of SIDES) {
    const ballX = Math.abs((rig.restPos[`shoulder_${s}`]?.x ?? 0.155)
      - (rig.restPos[`clavicle_${s}`]?.x ?? 0)) * 0.58;
    const marked = sign === numberSide;
    rig.decal(`clavicle_${s}`, marked ? unitCell : MARKINGS.CHEVRON,
      lame.R * (marked ? 0.66 : 0.44), lame.R * (marked ? 0.66 : 0.44), {
        p: [sign * (ballX + lame.dx + lame.R * 0.34), lame.dy + lame.R * 0.30,
          FRONT * (lame.half + 0.008)],
        r: [0, YAW_FRONT, sign * (marked ? -14 : 8) * DEG], mirror, tier: TIER.GREEBLE,
      });
  }
  rig.decal(`clavicle_${numberSide > 0 ? 'R' : 'L'}`, MARKINGS.HAZARD, scaled.d * 0.44, 0.034, {
    p: [-numberSide * (scaled.out + scaled.w * 0.30), lame.dy + lame.R * 0.70, 0],
    r: [-72 * DEG, 0, numberSide * 18 * DEG], mirror: numberSide > 0, tier: TIER.GREEBLE,
  });
  // service stencils: a lifting point over one hip, a no-step warning on the
  // opposite shin, both on the side a crew chief would actually walk up to
  const lift = rng.sign();
  rig.decal('hips', MARKINGS.LIFT, 0.075, 0.038, {
    p: [lift * t.pelvisW * 0.40, 0.028, back * (t.waistD * 0.5 + 0.014)],
    r: [0, YAW_BACK, lift * 4 * DEG], tier: TIER.GREEBLE,
  });
  rig.decal(`knee_${lift > 0 ? 'R' : 'L'}`, MARKINGS.NOSTEP, spec.legs.shin * 1.5, spec.legs.shin * 0.62, {
    p: [0, -rig.dim.shin * 0.66, FRONT * (spec.legs.shin * rig.dim.legK * 0.72 + 0.006)],
    r: [0, YAW_FRONT, 0], mirror: lift < 0, tier: TIER.GREEBLE,
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
      rig.decal('hips', MARKINGS.BARCODE, 0.06, 0.03, {
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
  const cell = rng.pick([MARKINGS.ROUNDEL, MARKINGS.TRIANGLE, MARKINGS.CHEVRON, MARKINGS.GAUGE, MARKINGS.CAUTION]);
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
  // The roster's `cables` count is a loom budget, not decoration: a courier
  // chassis runs two thin bundles and a foundry chassis runs six fat ones, and
  // spending that budget on the spine and the big joints first is what keeps a
  // sleek fighter from ending up wrapped in the same spaghetti as a heavy.
  const loom = spec.cables;
  const braid = clamp(Math.round(loom * 0.5), 1, 3);
  const fat = 0.75 + loom * 0.06;

  rig.cable('hips', [0, m.lumbar * 0.70, back * t.waistD * 0.62], 'chest', [0, -m.thorax * 0.24, back * t.chestD * 0.52],
    { sag: 0.031, radius: 0.0079 * k * fat, strands: braid, twists: 2.0 });

  for (const { s, sign } of SIDES) {
    // Free tail. Every other loom in here is a run between two anchors and is
    // therefore fully determined by the pose; this one terminates on a spring
    // leaf, so it is the one length of cable on the machine that is still
    // moving after the fighter has stopped. Only chassis that carry enough of a
    // loom budget to have spare cable get one.
    if (loom >= 4) {
      rig.cable('spine02', [sign * t.waistD * 0.30, m.lumbar * 0.60, back * t.waistD * 0.56],
        `cable_${s}`, [0, -0.185, back * 0.055],
        { sag: 0.055, radius: 0.0068 * k * fat, strands: braid, twists: 2.4 });
    }
    rig.cable('chest', [sign * t.chestW * 0.26, m.collar * 0.10, back * t.chestD * 0.44],
      `shoulder_${s}`, [0, -m.upper * 0.48, back * a.upper * 0.55], { sag: 0.020, radius: 0.0072 * k * fat, strands: braid });
    rig.cable(`shoulder_${s}`, [sign * a.upper * 0.5, -m.upper * 0.76, back * a.upper * 0.7],
      `elbow_${s}`, [sign * a.fore * 0.5, -m.fore * 0.22, back * a.fore * 0.7], { sag: 0.022, radius: 0.0065 * k * fat, strands: braid });
    rig.cable('hips', [sign * t.pelvisW * 0.34, -0.02, back * t.waistD * 0.55],
      `hip_${s}`, [sign * L.thigh * 0.5, -m.thigh * 0.41, back * L.thigh * 0.85], { sag: 0.025, radius: 0.0072 * k * fat, strands: braid });
    if (loom >= 3) {
      rig.cable(`hip_${s}`, [sign * L.thigh * 0.55, -m.thigh * 0.68, back * L.thigh * 0.9],
        `knee_${s}`, [sign * L.shin * 0.55, -m.shin * 0.24, back * L.shin * 0.9], { sag: 0.022, radius: 0.0065 * k * fat, strands: braid });
    }
    if (loom >= 5) {
      rig.cable(`knee_${s}`, [sign * L.shin * 0.45, -m.shin * 0.79, back * L.shin * 0.75],
        `foot_${s}`, [sign * L.footW * 0.40, 0.03, back * L.foot * 0.25], { sag: 0.015, radius: 0.0058 * k, strands: 2 });
    }
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
  const spec = chassisFor(def);
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
  const { mats, emissiveConfig } = resolveMaterials(environment, palette);

  // ---- assemble ---------------------------------------------------------
  const rig = new Rig(bones, restWorld, mats, maxTier, spec.greeble, spec.plating);

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

  // The landmark. Keyed off the character, never off the chassis — that switch
  // is what put the same shoulder cannon on three precision fighters.
  (MARK_BUILDERS[spec.mark] ?? (() => {}))(rig, spec, def);
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
    // Batched by material AND by whether the part is allowed into the depth
    // pass. Shadow work is paid once per cascade, so a bolt head or a rivet row
    // that merges into the same buffer as a chest plate drags the whole plate's
    // worth of geometry through every cascade to cast a shadow measured in
    // fractions of a pixel. Splitting them costs one draw call in the colour
    // pass and saves that same draw call several times over in the depth passes.
    const batches = new Map();
    for (const part of rig.parts) {
      if (part.tier > tierCap) continue;
      const shadowed = part.tier < TIER.GREEBLE && part.mat !== 'decal' && !part.mat.startsWith('glow_');
      // The attribute signature is part of the key because `mergeGeometries`
      // rejects a batch whose members disagree about which attributes exist —
      // and it rejects the whole batch, returning null. One untagged cable in
      // the rubber batch silently deleted every rubber part on every fighter in
      // the roster for as long as that was possible. Splitting on the signature
      // degrades that failure to one extra draw call. It is zero extra calls
      // while the tagging is uniform, which it now is.
      const sig = Object.keys(part.geo.attributes).sort().join('+');
      const key = `${shadowed ? part.mat : `${part.mat}|flat`}#${sig}`;
      let entry = batches.get(key);
      if (!entry) {
        const label = shadowed ? part.mat : `${part.mat}|flat`;
        batches.set(key, (entry = { mat: part.mat, shadowed, label, list: [] }));
      }
      entry.list.push(part.geo);
    }
    let tris = 0;
    for (const batch of batches.values()) {
      const matName = batch.mat;
      const mat = mats[matName];
      if (!mat) continue;
      const merged = mergeGeometries(batch.list, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      if (merged.boundingSphere) merged.boundingSphere.radius *= 1.9;
      merged.computeBoundingBox();
      const mesh = new THREE.SkinnedMesh(merged, mat);
      mesh.name = `${suffix}:${batch.label.replace('|', ':')}`;
      mesh.castShadow = batch.shadowed;
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
  // Actuators share the frame material with the plates but are turned cylinders,
  // not panels; the empty frame is what tells the shader to leave them alone.
  tagNoFrame(actGeo.housing);
  tagNoFrame(actGeo.rod);
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
