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
 * UVs are metre-based on both axes — U is arc length *around* the sweep at the
 * ring's own radius, V is arc length *along* the profile — which is the same
 * convention `loftHull` uses. It has to be. A normalized U (0..1 across the
 * sweep whatever the radius) makes texel density scale as 1/r, so a 0.046 m
 * strut got 15.7 tiles/m around against 4 tiles/m up. A grain texture squashed
 * 3.9x in one direction stops being grain and becomes stripes, and stripes
 * locked to the parameterization do not attenuate as the cylinder turns away —
 * which is precisely what read as wood on parts that should read as steel.
 *
 * @param {Array<{r:number,y:number,smooth?:boolean}>} profile bottom-to-top
 * @param {number} [segments=16] angular subdivisions
 * @param {Object} [opts]
 * @param {boolean} [opts.faceted=false] use per-quad flat normals instead of swept normals
 * @param {number} [opts.arc=Math.PI*2] sweep angle
 * @param {number} [opts.phase=0] starting angle
 * @param {number} [opts.uvV] V tiling per metre of profile arc length
 * @param {number} [opts.uvU=uvV] U tiling per metre around the sweep; tracks
 *   `uvV` by default so a site that retunes density stays square on both axes
 * @returns {THREE.BufferGeometry}
 */
export function latheProfile(profile, segments = 22, opts = {}) {
  const { faceted = false, arc = Math.PI * 2, phase = 0, uvV = UV_DENSITY, uvU = uvV } = opts;
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
      const a0 = (j / segments) * arc, a1 = ((j + 1) / segments) * arc;
      const t0 = phase + a0;
      const t1 = phase + a1;
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
      // U in metres around the sweep, taken at each ring's own radius, so a
      // taper unwraps like a cone rather than like a cylinder
      const u0a = a0 * p0.r * uvU, u1a = a1 * p0.r * uvU;
      const u0b = a0 * p1.r * uvU, u1b = a1 * p1.r * uvU;
      s.quad(A, B, C, D, nA, nB, nC, nD, [u0a, v0], [u1a, v0], [u1b, v1], [u0b, v1]);
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
  // Rim UVs are metres too — U along the profile, V across the plate thickness.
  // A normalized 0..1 quad here stretches one whole tile over a 4 mm rim.
  const along = [0];
  for (let i = 1; i < k; i++) {
    along.push(along[i - 1] + Math.hypot(profile[i].r - profile[i - 1].r, profile[i].y - profile[i - 1].y) * uvV);
  }
  const across = profile.map((q, i) => Math.hypot(q.r - inner[i].r, q.y - inner[i].y) * uvV);
  for (const [ang, dir] of [[phase, -1], [phase + arc, 1]]) {
    const c = Math.cos(ang), si = Math.sin(ang);
    const nrm = [-si * dir, 0, c * dir];
    const P = (q) => [q.r * c, q.y, q.r * si];
    for (let i = 0; i < k - 1; i++) {
      s.quad(P(profile[i]), P(profile[i + 1]), P(inner[i + 1]), P(inner[i]),
        nrm, nrm, nrm, nrm,
        [along[i], 0], [along[i + 1], 0], [along[i + 1], across[i + 1]], [along[i], across[i]]);
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
    gasket: { color: '#2b2f35', metalness: 0, roughness: 0.86, sheen: 0.6 },
    bezel: { color: '#0d1014', metalness: 0.35, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.035 },
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
    // The two zones that are not brushed metal. Both were carved out of
    // `darkMetal`, which is why they carry `kbControlOf`: it names the material
    // the batch used to be, so the split can be A/B'd on ONE frozen frame by
    // swapping each zone mesh back to its predecessor. That is the only way this
    // axis is measurable — a cross-run capture on this shot cannot resolve
    // anything smaller than ~15/255 (docs/PROFILING.md trap 5) and the in-page
    // toggle measures 0.000/255 between two grabs of an unchanged frame.
    gasket: pick('gasket').clone(),
    bezel: pick('bezel').clone(),
    carbon: pick('carbon').clone(),
    glass: pick('glass').clone(),
  };
  mats.gasket.userData = { ...mats.gasket.userData, kbControlOf: 'darkMetal' };
  mats.bezel.userData = { ...mats.bezel.userData, kbControlOf: 'darkMetal' };

  // Emissive groups get their own material so the Fighter can pulse each
  // independently against health / meter / hit reactions.
  const emissiveSrc = pick('emissive');
  const glowColor = new THREE.Color(palette.emissive || '#4fd8ff');
  const GLOWS = {
    // The eye is the focal point of every closeup in `ref/tekken8`, and what
    // makes a focal point is not output, it is *separation*: a small element
    // several stops above everything around it. At 5.2 a visor sits at roughly
    // the same value as a key-lit armour plate — on a warm palette like Vulkan's
    // it is the same hue as well — and the face reads as another panel. Measured
    // on a 200x220 face crop at the canonical closeup framing, 5.2 put that
    // region's 95th percentile at 155 against the head crop's 149 — the face was
    // no brighter than the shoulder behind it.
    //
    // Measured on the frozen closeup, that crop's p95 goes 155 -> 218 at 12 and
    // -> 227 at 18. 12 is where it lands: the eye clearly wins the frame, and
    // the streak bloom off a source this small stays inside what the reference
    // does rather than laying rays across the whole figure at fight framing.
    visor: { color: glowColor, intensity: 12 },
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
// Limb anatomy
//
// One table, read off the front-facing panels of the eight reference sheets.
// Every one of them is an anatomical humanoid whose limb segments change width
// along their length: a deltoid ball necking to a narrow elbow, a forearm that
// swells at the brachioradialis and necks hard to the wrist, a thigh widest
// just below the hip, a calf belly high on the shank over a thin ankle.
//
// Before this the four limb segments were authored as two literal widths each,
// and the two were within 12–23% of one another — on a gauntleted heavy the
// forearm was actually WIDER at the wrist than at the elbow. A constant-width
// prism is what `03-full-body.jpg` shows and no surfacing rescues it, so the
// numbers below are held to at least a 1.6:1 ratio between the widest and the
// narrowest station of every segment. That ratio is the whole point; it is
// cheaper to check than "does it look like an arm".
//
// `t` runs 0 at the DISTAL end of the segment (the end nearer the hand or the
// foot, which is where the section's `y0` sits) to 1 at the proximal end.
// `k` multiplies the segment's nominal width.
// ---------------------------------------------------------------------------

const LIMB_PROFILES = {
  //          elbow ......................................... shoulder
  upperArm: [[0, 0.62], [0.12, 0.71], [0.55, 0.92], [0.86, 1.10], [1, 0.98]],
  //          wrist ........................................... elbow
  forearm: [[0, 0.55], [0.14, 0.63], [0.68, 1.02], [0.90, 1.00], [1, 0.88]],
  //          knee ............................................ hip
  thigh: [[0, 0.60], [0.18, 0.72], [0.62, 0.96], [0.82, 1.06], [1, 0.94]],
  //          ankle ........................................... knee
  shank: [[0, 0.48], [0.14, 0.56], [0.66, 1.00], [0.88, 1.02], [1, 0.92]],
};

/**
 * Absolute cross-sections for one anatomical limb segment.
 *
 * `round` is deliberately near 1 rather than the 0.34 every limb used to pass.
 * `roundedRectRing` treats `round` as a corner radius fraction, so 0.34 leaves
 * four straight runs each shading as one plane — a machined box wearing small
 * fillets. At 0.90 the ring is an ellipse and the segment reads as a capsule,
 * which is what every reference sheet's limbs are.
 *
 * @param {keyof LIMB_PROFILES} kind
 * @param {number} w nominal width, hit at k = 1
 * @param {number} deep depth as a multiple of width — a limb is boxed in
 *   sideways by the pelvis or the ribcage and by nothing fore-and-aft, so a
 *   real one is markedly deeper than it is wide
 * @param {number} [round=0.90]
 */
function limbKnots(kind, w, deep, round = 0.90) {
  return LIMB_PROFILES[kind].map(([t, k]) => ({ t, w: w * k, d: w * k * deep, round }));
}

/** Piecewise-linear width multiplier of a limb profile at parameter `t`. */
function limbK(kind, t) {
  const p = LIMB_PROFILES[kind];
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i][0] || i === p.length - 1) {
      const [t0, k0] = p[i - 1], [t1, k1] = p[i];
      const f = t1 - t0 < 1e-6 ? 0 : (t - t0) / (t1 - t0);
      return k0 + (k1 - k0) * f;
    }
  }
  return 1;
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
   *
   * Three stations and one shared corner radius is as far as that model goes,
   * and it is not far enough for a limb. A three-station loft with `round` in
   * the 0.34 band is a machined box by construction — `roundedRectRing` returns
   * four straight runs each carrying one shared normal — and the ends of every
   * limb section in the cast were within 12–23% of each other, so the box did
   * not even taper. `knots` is the way out: an explicit list of absolute
   * cross-sections along the run, so one call can carry a deltoid ball, a mid
   * taper, a brachioradialis belly and a necked wrist, each with its own corner
   * radius. `limbKnots()` authors them by anatomy rather than by literal.
   */
  stations(o, cy = 0) {
    const sx = o.shearX ?? 0, sz = o.shearZ ?? 0;
    const round = o.round ?? 0.34;
    const at = (t, w, d, r, smooth) => ({
      y: o.y0 + (o.y1 - o.y0) * t - cy,
      w,
      d,
      x: sx * (t * 2 - 1),
      z: sz * (t * 2 - 1),
      round: r,
      smooth,
    });
    if (o.knots) {
      return o.knots.map((k) => at(k.t, k.w, k.d ?? k.w, k.round ?? round, k.smooth !== false));
    }
    const e0 = o.d0 ?? o.w0, e1 = o.d1 ?? o.w1;
    const lin = (t, extra = 1) => at(
      t,
      (o.w0 + (o.w1 - o.w0) * t) * extra,
      (e0 + (e1 - e0) * t) * extra,
      round, true,
    );
    const swell = o.swell ?? 0;
    if (Math.abs(swell) < 1e-4) return [lin(0), lin(0.5), lin(1)];
    return [lin(0), lin(o.swellAt ?? 0.42, 1 + swell), lin(1)];
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
      // ZONE 2. This is the under-structure that shows through every gap between
      // the armour bands laid over it. As anisotropic gunmetal it mirrored the
      // sky out of each gap, which is the single most effective way to stop
      // plates reading as plates: the recess was brighter than the plate. A
      // matte composite sleeve is both what a real machine has under its armour
      // and what makes the band above it read as a separate object.
      mat: 'gasket', round: 0.5, perQuad: 2, swell: 0,
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

  /**
   * Anatomical limb segment — the construction that replaces `plated()` on the
   * four limb bones.
   *
   * `plated()` builds a painted tube over a slightly smaller tube. That is a
   * closed column: it encloses the limb, so there is nothing to see between the
   * armour and the machine, and every one of the eight reference sheets is
   * built the opposite way round. There, armour is a set of SHELLS that wrap the
   * outer 200–260° of a segment and stop, and the inner face is left open onto
   * a dark ribbed core. The eye then reads armour, gap, mechanism at every
   * joint, which is the single biggest reason the sheets look like machines
   * rather than like painted suits.
   *
   * So this emits three things, all sharing one placement frame so that `r`
   * tilts the whole assembly about one pivot instead of bending it:
   *
   *   1. the CORE — an ovoid loft on the anatomy curve, at `coreK` of the
   *      armour's cross-section, in a dark matte material;
   *   2. the RIBS — short stacked rings on the core, sitting in the gaps the
   *      shells leave at the joints and at the mid-run break;
   *   3. the SHELLS — `bands` swept plates over the outer arc, each following
   *      the same anatomy curve, each with a real rim the light can catch.
   *
   * @param {string} bone
   * @param {Object} o
   *   `kind` key into LIMB_PROFILES; `w` nominal width (the k = 1 station);
   *   `deep` depth as a multiple of width; `y0`/`y1` span on the bone axis with
   *   `y0` at the distal end; `mat` shell material; `coreMat` core material;
   *   `arc`/`phase` shell wrap in radians; `bands`; `gap` exposed fraction of
   *   the run at each end and between bands; `ribAt` rib positions in t.
   */
  limb(bone, o) {
    const kind = o.kind;
    const deep = o.deep ?? 1;
    const coreK = o.coreK ?? 0.74;
    const knots = limbKnots(kind, o.w, deep, o.round ?? 0.95);
    const cy = (o.y0 + o.y1) * 0.5;
    const span = o.y1 - o.y0;
    const yAt = (t) => o.y0 + span * t - cy;
    const wAt = (t) => o.w * limbK(kind, t);
    // Every part of the limb is authored about the segment centre and placed
    // with the SAME p and r. `plated()` rotated each band about its own centre,
    // which at 2° of hip splay is invisible and at anything more would hinge
    // the limb rather than tilt it.
    const base = { p: [o.x ?? 0, cy, o.z ?? 0], r: o.r, mirror: o.mirror };
    const seg = this.maxTier >= 2 ? 16 : 10;

    this.add(bone, loftHull(knots.map((k) => ({
      y: yAt(k.t), w: k.w * coreK, d: k.d * coreK, round: k.round, smooth: true,
    })), { perQuad: 3 }), o.coreMat ?? 'gasket',
    { ...base, tier: TIER.PRIMARY, role: 'frame' });

    // The ribs are the underskin. They are cheap — four profile points on a
    // 14-gon — and they are the difference between a gap that reads as a gap
    // and a gap that reads as a hole, so they go wherever a shell ends.
    const ribs = o.ribAt ?? [0.07, 0.5, 0.93];
    const ribH = Math.abs(span) * 0.030;
    for (const t of ribs) {
      const rc = wAt(t) * coreK * 0.5;
      const g = latheProfile([
        { r: rc * 0.98, y: -ribH },
        { r: rc * 1.17, y: -ribH * 0.42, smooth: true },
        { r: rc * 1.17, y: ribH * 0.42 },
        { r: rc * 0.98, y: ribH },
      ], this.maxTier >= 2 ? 14 : 10);
      // The depth ratio is baked into the geometry rather than passed as a
      // placement scale: `add` derives the plate frame from a single
      // `getMaxScaleOnAxis`, so a non-uniform placement scale would report the
      // ring 26% wider than it is and put the rim band in the wrong place.
      g.translate(0, yAt(t), 0);
      g.scale(1, 1, deep);
      this.add(bone, g, o.ribMat ?? 'darkMetal',
        { ...base, tier: TIER.SECONDARY, role: 'frame' });
    }

    const bands = Math.max(1, Math.round(o.bands ?? 2));
    const gap = o.gap ?? 0.07;
    const step = (1 - gap * (bands + 1)) / bands;
    const arc = o.arc ?? 232 * DEG;
    const phase = (o.phase ?? 0) - arc * 0.5;
    for (let i = 0; i < bands; i++) {
      const a = gap + i * (step + gap);
      const b = a + step;
      // Four samples per band, drawn off the same anatomy curve as the core, so
      // the plate necks where the limb necks instead of sleeving a taper in a
      // constant-radius tube. The two end samples are pulled in slightly: that
      // is the rolled edge of a pressing, and it is the only part of a wrapped
      // shell that reliably catches a rim light.
      const prof = [0, 0.3, 0.7, 1].map((f, j) => {
        const t = a + (b - a) * f;
        const r = wAt(t) * 0.5;
        const end = j === 0 || j === 3;
        return { r: end ? r * 0.93 : r, y: yAt(t), smooth: !end };
      });
      const shell = shellLathe(prof, wAt((a + b) * 0.5) * 0.5 * 0.17, seg, { arc, phase });
      shell.scale(1, 1, deep);
      this.add(bone, shell, o.mat, {
        ...base, tier: TIER.PRIMARY,
        // A wrapped shell is one pressing with a free ground rim the whole way
        // round, not a band butted against the plate above it.
        role: 'lame',
      });
    }
    return this;
  }

  /**
   * Ribbed underskin stack on a bone axis, for the limb branches that keep
   * their own bespoke masses (digitigrade calf, piston column) and so cannot go
   * through `limb()`. Same rings, same reason.
   */
  ribStack(bone, o) {
    const n = Math.max(1, o.count ?? 3);
    const h = o.h ?? 0.018;
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : i / (n - 1);
      const r = o.r0 + (o.r1 - o.r0) * f;
      const g = latheProfile([
        { r: r * 0.98, y: -h },
        { r: r * 1.18, y: -h * 0.40, smooth: true },
        { r: r * 1.18, y: h * 0.40 },
        { r: r * 0.98, y: h },
      ], this.maxTier >= 2 ? 14 : 10);
      g.translate(0, o.y0 + (o.y1 - o.y0) * f, 0);
      if (o.deep) g.scale(1, 1, o.deep);
      this.add(bone, g, o.mat ?? 'darkMetal', {
        p: o.p, r: o.rot, mirror: o.mirror,
        tier: o.tier ?? TIER.SECONDARY, role: 'frame',
      });
    }
    return this;
  }

  /**
   * Rotary joint hardware on a hinge axis: the boot that fills the gap between
   * the two segments, a bezel ring standing proud of both of them, and a
   * recessed hub in the middle of it.
   *
   * §1.4 of the visual target: every major joint on every reference sheet
   * carries a visible disc on its pivot, and the disc is LARGER than half the
   * limb width so it is still the read at any flex angle. The build had four
   * ad-hoc lathe barrels — shoulder, elbow, knee, ankle — that were flush
   * gasket boots with a ring of bolt heads on them, no hip disc at all, and a
   * wrist cuff. Flush hardware disappears the moment the joint bends. One
   * construction, used six times a side, replaces all of it.
   *
   * Authored about +Y and rolled onto the hinge axis, world-aligned by default
   * so the barrel stays horizontal however the bone happens to be posed.
   *
   * `face` is the whole reason this takes four numbers instead of two. The
   * barrels it replaces put their end caps at ±0.30 of a segment width while
   * the segment itself was 0.77 wide, so the "joint hardware" was entirely
   * inside the limb and the seam read as a hole. Every call site now passes the
   * limb's own half-width at that joint, and the disc seats there.
   *
   * @param {string} bone
   * @param {Object} o
   *   `radius` disc radius — around 0.6 of the limb's half-width at that joint,
   *   which puts the disc DIAMETER comfortably past §1.4's "larger than half the
   *   limb width" while still reading as a hub set into the joint rather than as
   *   a hoop around it; `face` distance along the hinge axis to the disc's
   *   seating plane, which has to clear the OUTERMOST armour at that joint (the
   *   deltoid shell, the elbow cap, the knee cap), not just the segment;
   *   `boot` barrel radius, or false for joints that already have one; `half`
   *   boot half-length; `sign` side; `p` offset in the world-aligned frame.
   */
  bezel(bone, o) {
    const R = o.radius;
    const face = o.face ?? R;
    const sign = o.sign ?? 1;
    const seg = this.maxTier >= 2 ? 20 : 12;
    const put = (geo, mat, tier) => this.add(bone, geo, mat, {
      world: o.world !== false, p: o.p ?? [0, 0, 0],
      r: [0, 0, sign * -90 * DEG], mirror: o.mirror, tier, role: 'frame',
    });

    // The boot. A rotary barrel is a moulding, not a billet — it was the largest
    // single block of `darkMetal` in the scored frame and read as polished steel.
    // Its radius has to beat the segment's half-DEPTH, not its half-width, or it
    // vanishes the moment the limb becomes deeper than it is wide.
    if (o.boot) {
      const B = o.boot, half = o.half ?? B * 0.42;
      put(latheProfile([
        { r: 0, y: -half }, { r: B * 0.92, y: -half },
        { r: B, y: -half * 0.70, smooth: true },
        { r: B, y: half * 0.70 }, { r: B * 0.88, y: half },
        { r: 0, y: half },
      ], seg), 'gasket', TIER.PRIMARY);
    }

    // Outer face: the disc that has to survive the silhouette, so PRIMARY.
    // It is deliberately a THIN concentric assembly rather than a thick puck.
    // At R*0.21 proud it read as a road wheel bolted to the side of the leg,
    // which is not what any of the eight sheets has at a knee.
    put(latheProfile([
      { r: R * 0.46, y: face },
      { r: R * 1.00, y: face + R * 0.04, smooth: true },
      { r: R * 1.04, y: face + R * 0.11 },
      { r: R * 0.84, y: face + R * 0.15 },
      { r: R * 0.38, y: face + R * 0.12 },
    ], seg), 'trim', TIER.PRIMARY);
    // The hub has to be WIDER than the ring's bore (0.38–0.46 R), not narrower.
    // At 0.30 R it left an annular hole you could see the background through,
    // which on the shoulder disc read as a punched-out washer.
    put(latheProfile([
      { r: 0, y: face + R * 0.02 }, { r: R * 0.48, y: face + R * 0.02 },
      { r: R * 0.44, y: face + R * 0.13 }, { r: 0, y: face + R * 0.15 },
    ], Math.max(10, Math.round(seg * 0.6))), 'darkMetal', TIER.PRIMARY);

    // Inner face: the same ring, thinner and one tier down. It is only ever seen
    // through the gap between the limb and the body, but with nothing there the
    // joint reads as a plate that stops in mid-air from the far camera angle.
    const inner = o.faceIn ?? face * 0.86;
    put(latheProfile([
      { r: R * 0.40, y: -inner - R * 0.12 },
      { r: R * 0.90, y: -inner - R * 0.07, smooth: true },
      { r: R * 0.90, y: -inner + R * 0.02 },
      { r: R * 0.40, y: -inner + R * 0.07 },
    ], Math.max(10, Math.round(seg * 0.7))), 'trim', TIER.SECONDARY);
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

    // Clevis brackets, rigid to their own bone. They are boxes bedded onto what
    // is now a curved shell, so they are deliberately small: at the old 2.6x
    // radius the corners tented 8 mm clear of an ovoid limb and the bracket read
    // as a separate object floating beside the ram.
    const cw = radius * 2.0, ch = radius * 1.25, cd = radius * 1.6;
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
  // A joint boot is the most exposed soft part on the machine and an optic
  // bezel is wiped every time anyone services it.
  gasket: 0.72, bezel: 0.12,
};

/**
 * Materials that are turned, extruded or moulded rather than pressed from
 * sheet. A hydraulic rod has no panel gaps on it; neither does a rubber boot or
 * a structural frame member, and putting them there is how a procedural robot
 * ends up looking like it was wrapped in wallpaper.
 */
const NO_PANEL_MATS = new Set(['darkMetal', 'piston', 'rubber', 'gasket', 'bezel', 'carbon', 'glass']);

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
 * Footprint trim, by leg plan.
 *
 * The chassis table's `foot` and `footW` were authored against a boot assembled
 * from a sole box, a toe box and a heel box, and they were sized to make that
 * assembly look substantial. Measured on the build these replace, the finished
 * plantigrade footprint ran 0.39–0.47 of hip-to-ankle and up to 1.7 head
 * lengths, at 0.81 as wide as it was long — a ski, and one of the three things
 * §2 of the visual target names outright. A human foot is about a third of the
 * leg and a little over half as wide as it is long, and every reference sheet
 * agrees with that even on the two super-heavies.
 *
 * A raptor foot is genuinely long — it is a whole extra limb segment, not a
 * boot — so the digitigrade plan is trimmed less, and the piston plan's pad is
 * a circle whose width IS its length and so takes the length trim on both axes.
 *
 * They live here rather than inside `buildLeg` because `buildMechanism` anchors
 * the ankle ram and the ankle loom on the same two numbers, and a boot that
 * shrinks without its hydraulics leaves a ram hanging in clear air.
 */
const BOOT_TRIM = { plantigrade: 0.78, splayed: 0.78, piston: 0.82, digitigrade: 0.74 };
const BOOT_WIDTH_TRIM = 0.82;
const bootTrim = (plan) => BOOT_TRIM[plan] ?? BOOT_TRIM.plantigrade;

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
 * Frame class per body mass, taken from §3's sheet assignment.
 *
 * Keyed off the body mass rather than off the chassis because the chassis does
 * not agree with the sheets: BASTION and VULKAN share the `heavy` chassis but
 * are built to `paladin` (a mid frame) and `furnace` (a heavy one); VOLTA and
 * AXIOM share `precision` and are built to `aegis-01` (heavy) and `volt-monk`
 * (light). Ten body masses serve ten fighters one-to-one, so this is the only
 * per-fighter key the builder already has that carries the sheet's identity.
 */
const PLAN_FRAME = {
  barrel: 'heavy', keel: 'light', hump: 'superheavy', column: 'light',
  cuirass: 'mid', carapace: 'mid', skeletal: 'light', wall: 'mid',
  reference: 'light', drum: 'heavy',
};

/**
 * §1.2's waist column, as a band rather than a point.
 *
 * The contract gives one number per frame class — 0.75 of the chest on a light
 * frame, 0.95 on the super-heavy — and ten fighters cannot all sit on four
 * numbers or four pairs of them become the same torso. So each class is a band
 * about its number and the plan's OWN waist-to-chest ratio decides where inside
 * it the fighter lands, monotonically. That keeps the ordering the body-mass
 * table was measured to produce (a barrel's waist is still the widest in the
 * cast relative to its chest, a skeletal frame's still the narrowest) while
 * putting every one of them inside the contract instead of at 0.29–1.10, which
 * is where they were: five fighters wasp-waisted to half of what any sheet has,
 * and two — barrel and drum — with a waist WIDER than the chest above it.
 */
const FRAME_WAIST = {
  light: [0.71, 0.79], mid: [0.76, 0.84], heavy: [0.86, 0.94], superheavy: [0.92, 0.98],
};

/**
 * Waist width as a fraction of the pelvis girdle under it.
 *
 * The second half of the constraint, and the half the sheets cannot supply: a
 * pelvis is bounded by the LEGS, which on this skeleton are 0.19–0.24 m apart
 * whatever the sheet's figure does. A girdle authored purely from the waist
 * ratio came out 0.75 m wide on the super-heavy — a metre-and-a-half hoop the
 * thighs would swing straight through on any kick. So the waist target sets the
 * pelvis, the pelvis is clamped to what the legs will carry, and then the waist
 * is taken back down to what the clamped pelvis can hold up.
 */
const WAIST_OVER_PELVIS = { light: 0.86, mid: 0.90, heavy: 0.94, superheavy: 0.96 };
/** Raw waist/chest ratios the body-mass table produces, as a squash interval. */
const RAW_WAIST_SPAN = [0.30, 1.10];
/** Pelvis girdle bounds, as multiples of the chassis's own authored pelvis. */
const PELVIS_GIRDLE = [0.84, 1.34];
/**
 * How much breadth the chest may give up to let the waist reach its band.
 *
 * The chest station carries the roster's `shoulders` impression on top of the
 * body mass's own multiplier, so on the two broadest plans it came out wider
 * than the shoulder JOINTS are apart — 0.80 m across a chest whose sockets are
 * 0.48 m apart. That is shoulder span wearing a chest's name, and the pauldrons
 * deliver the span anyway because they hang off the shoulder bones. Capped at
 * 18% so a broad fighter stays broad.
 */
const CHEST_GIVE = 0.82;

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
  const S = {
    pelvis: at('pelvis', t.pelvisW * 0.98, t.waistD * 1.12),
    waistLo: at('waistLo', t.waistW * 1.16, t.waistD * 1.04),
    waistHi: at('waistHi', t.waistW * 1.34, t.waistD * 1.14),
    ribs: at('ribs', t.chestW * 0.80, t.chestD * 0.86),
    chest: at('chest', t.chestW, t.chestD),
    yoke: at('yoke', t.chestW * 0.84, t.chestD * 0.86),
  };

  // --- §1.2: the chest / waist / pelvis relationship ------------------------
  //
  // Everything above this line is the body mass's own opinion, and it is kept
  // as the RELATIVE ordering of the cast. Everything below is the contract,
  // which is absolute. Only the WIDTHS are touched: the depth column is where
  // half the identity in this table lives (a keel is 1.36 deep for every unit
  // across, a cuirass 0.48) and §1.2 says nothing about it.
  const frame = PLAN_FRAME[spec.planId] ?? 'mid';
  const [lo, hi] = FRAME_WAIST[frame];
  const wop = WAIST_OVER_PELVIS[frame];
  // Cross-sections are two-dimensional, so a width correction that leaves the
  // depth alone turns a column into a plank. The depth follows at the same
  // half strength the chassis applies to every other "impression" scalar.
  const soften = (k) => 1 + (k - 1) * 0.55;

  // 1. Where the plan wants its waist, squashed into the frame's band. The
  //    squash is monotone, so the cast's waist ordering survives the move.
  const rawRatio = S.waistLo.w / S.chest.w;
  const [rl, rh] = RAW_WAIST_SPAN;
  const want = (lo + (hi - lo) * clamp((rawRatio - rl) / (rh - rl), 0, 1)) * S.chest.w;

  // 2. The girdle that waist implies, clamped to what the legs will carry.
  const rawPelvis = S.pelvis.w;
  S.pelvis.w = clamp(want / wop, t.pelvisW * PELVIS_GIRDLE[0], t.pelvisW * PELVIS_GIRDLE[1]);
  S.pelvis.d *= soften(S.pelvis.w / rawPelvis);

  // 3. The waist that girdle can hold up.
  const rawWaistLo = S.waistLo.w, rawWaistHi = S.waistHi.w;
  let waist = Math.min(want, S.pelvis.w * wop);

  // 4. If the waist still cannot reach the band's floor, the chest gives.
  if (waist < S.chest.w * lo) {
    const c = Math.max(S.chest.w * CHEST_GIVE, waist / lo);
    // The yoke is the top of the same column and has to move with it, or the
    // shoulder deck stays at the old breadth and steps out over the ribcage.
    S.yoke.w *= c / S.chest.w;
    S.chest.w = c;
  }
  // The pelvis wins the last word. On the super-heavy the chest is so broad
  // that even after giving up its 18% the band still asks for a waist wider
  // than the widest girdle the legs will carry, and taking the band literally
  // there produced a mushroom: a 0.66 m waist sitting on a 0.59 m pelvis. A
  // fighter 5% outside §1.2 reads as a fighter; one wearing its waist over the
  // edge of its own hips does not.
  waist = Math.min(clamp(waist, S.chest.w * lo, S.chest.w * hi), S.pelvis.w * wop);

  // 5. The ribcage. At the shared 0.80 of the chest it was a pinch above the
  //    waist that no reference sheet has — the lats taper INTO the waist, they
  //    do not neck in and flare out again — so it is re-authored as a fraction
  //    of the chest that keeps the plan's relative ribcage bias, and floored
  //    above the waist so the column can never invert.
  S.ribs.w = Math.max(
    S.chest.w * clamp(0.86 * (p.ribs[0] / p.chest[0]), 0.80, 0.96),
    waist * 1.02,
  );

  // 6. The upper waist is no longer authored: it is where the belly sits on the
  //    run from the narrow point to the ribs. A plan that wanted a big gut asked
  //    for it as waistHi/waistLo and still gets it, as a position rather than as
  //    a licence to be wider than the chest.
  const belly = clamp((p.waistHi[0] / p.waistLo[0] - 0.90) * 2.2, 0.16, 0.72);
  S.waistLo.w = waist;
  S.waistHi.w = waist + (S.ribs.w - waist) * belly;
  S.waistLo.d *= soften(S.waistLo.w / rawWaistLo);
  S.waistHi.d *= soften(S.waistHi.w / rawWaistHi);
  return S;
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
  // Upper girdle — the belt, and the LOWER lip of the abdominal gap.
  //
  // It used to carry two thirds of the way up the lumbar bone and hand straight
  // over to the painted lower spine, which sleeved the whole abdomen in armour.
  // §1.3 names the segmented stack between chest and pelvis the most visible
  // underskin on the body — it is the one thing `volt-monk` and `ghostframe`
  // both put a whole detail tile on — and there was nowhere on this column for
  // it to be. The belt now stops at a quarter of the lumbar and necks IN as it
  // rises, so `buildAbdomen`'s stack comes out of a lip rather than out of a
  // butt joint, and the pelvis reads as a separate block below it.
  // The 0.45 and `buildTorso`'s matching -0.30 on the lower-lat shell are the
  // two ends of the exposed band, and they are set together: they leave about
  // two fifths of the hips-to-chest column showing dark. At the two thirds the
  // first pass left, the stack was the largest single element on the torso and
  // the fighter read as a machine wearing a corset.
  rig.section('hips', {
    y0: -0.004, y1: m.lumbar * 0.45,
    w0: P.pelvis.w, w1: P.pelvis.w * 0.90,
    d0: P.pelvis.d, d1: P.pelvis.d * 0.92,
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
    ], 20), 'gasket', { p: [hx, hipY, 0], r: [0, 0, 90 * DEG], mirror, tier: TIER.PRIMARY });

    rig.add('hips', boltRing(6, r * 0.76, 0.009, 0.011), 'trim',
      { p: [hx + sign * r * 0.79, hipY, 0], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.GREEBLE });

    // belt lamp
    rig.glow('hips', bevelBox(0.03, 0.012, 0.012, 0.004), 'joints',
      { p: [hx * 0.55, m.lumbar * 0.14, FRONT * d * 0.5], mirror });
  }

  // Waist power ring: recessed channel with a glow strip inside. It follows the
  // belt down — at half the lumbar it now stands in the open air the abdominal
  // stack occupies, and a channel with nothing behind it reads as a hole.
  const ringY = m.lumbar * 0.16;
  rig.add('hips', channelStrip(P.pelvis.w * 0.86, P.pelvis.d * 1.02, 0.018), 'darkMetal',
    { p: [0, ringY, 0], tier: TIER.SECONDARY });
  rig.glow('hips', bevelBox(P.pelvis.w * 0.62, 0.014, P.pelvis.d * 0.72, 0.004), 'spine',
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

/**
 * The abdominal stack — the dark second body between chest and pelvis.
 *
 * §1.3 lists seven places the underskin shows and calls this one "the most
 * visible": a segmented column of rings running from the belt to under the
 * ribcage, matte charcoal, with the painted shell overhanging it above and the
 * pelvis block below. `volt-monk` and `ghostframe` each spend a whole detail
 * tile on it; `atlas-7` builds its entire waist out of it and puts a coil
 * spring down the middle.
 *
 * What was here was the opposite construction: a painted `plated()` band over
 * the lumbar with three trim rings and three small floating plates on the front
 * of it. That is armour over armour — the torso ran from the girdle to the
 * collar as one continuous painted column, and the only dark showing anywhere
 * on the body was the few millimetres of frame the band gaps left. The stack
 * replaces the band outright rather than sitting under it, because the whole
 * point is that the eye reaches mechanism, not more paint.
 *
 * PRIMARY throughout. It is a silhouette element — it is where the body is
 * narrowest, so it is what makes the chest above it read as a chest — and a
 * stack that drops out at LOD1 takes the waist with it.
 *
 * @param {Rig} rig
 * @param {Object} spec resolved chassis plan
 * @param {Object} P station table from `torsoStations`
 */
function buildAbdomen(rig, spec, P) {
  const m = rig.dim;
  // Reaching down inside the belt and up under the lower-lat shell at both
  // ends. Overlap rather than abutment: `lumbar` and `mid` are per-character
  // bone spacings, so a stack authored to meet its neighbours exactly opens a
  // hole on whichever fighter's proportions round the other way.
  // The belt's top edge is at hips-local `lumbar * 0.45` and the lower-lat
  // shell's bottom at spine02-local `-mid * 0.30`; both are quoted here in
  // spine01-local metres and both are overshot, so the stack runs on well
  // inside each neighbour. Authored to meet them exactly, the first fighter
  // whose lumbar rounded the other way opened a band of sky at the belt.
  const y0 = -m.lumbar * 0.82;
  const y1 = m.mid * 0.86;
  const span = y1 - y0;
  // The core is well inside the ring diameter: the rings are the read, and a
  // core that comes out to meet them turns the stack back into a smooth tube
  // with grooves scratched in it.
  const core = 0.80, ring = 0.92;
  const dw = (P.waistLo.d / P.waistLo.w + P.waistHi.d / P.waistHi.w) * 0.5;

  // ZONE 2 (matte composite): the column the rings are stacked on. Near-round
  // and finely sampled — this is the one part of the torso with no paint on it
  // at all, so its shading is entirely silhouette and terminator, and at the
  // 0.34 corner radius the rest of the column uses it read as a dark box.
  rig.section('spine01', {
    y0, y1,
    w0: P.waistLo.w * core, w1: P.waistHi.w * core,
    d0: P.waistLo.d * core, d1: P.waistHi.d * core,
    mat: 'gasket', round: 0.92, perQuad: 4, swell: -0.04,
    tier: TIER.PRIMARY, role: 'frame',
  });

  // The segments. Count is driven by the run rather than fixed, so a 2.1 m
  // heavy does not wear the same four rings as a 1.8 m acrobat over half again
  // the distance and read as a coarser machine for it.
  const count = Math.round(clamp(span / (0.034 * m.torsoK), 4, 7));
  rig.ribStack('spine01', {
    count,
    r0: P.waistLo.w * 0.5 * ring, r1: P.waistHi.w * 0.5 * ring,
    y0: y0 + span * 0.10, y1: y1 - span * 0.12,
    h: 0.013 * m.torsoK, deep: dw, mat: 'darkMetal', tier: TIER.PRIMARY,
  });

  // The pair of conduits every sheet runs down the exposed side of the stack.
  // Rigid rather than the soft loom `buildMechanism` hangs off the spine: those
  // are SECONDARY and swing, these have to be present at every LOD because they
  // are half of what makes the gap read as mechanism rather than as a hole.
  for (const { sign, mirror } of SIDES) {
    const rr = 0.0095 * m.torsoK;
    rig.add('spine01', latheProfile([
      { r: rr * 0.86, y: y0 + span * 0.06 },
      { r: rr, y: y0 + span * 0.40, smooth: true },
      { r: rr * 0.92, y: y1 - span * 0.08 },
    ], rig.maxTier >= 2 ? 9 : 6), 'rubber', {
      p: [sign * P.waistLo.w * 0.40, 0, -FRONT * P.waistLo.d * 0.20],
      r: [0, 0, sign * -3 * DEG], mirror, tier: TIER.PRIMARY, role: 'frame',
    });
  }

  // §1.6: emissive lives in the narrow grooves between plates. Two hairlines in
  // the channel the stack opens, and nothing else — the belly is the largest
  // uninterrupted dark area on the machine and it is very easy to turn it into
  // a lamp.
  for (const { sign, mirror } of SIDES) {
    rig.glow('spine01', loftHull([
      { y: y0 + span * 0.18, w: 0.008, d: 0.007, round: 0.5 },
      { y: y1 - span * 0.20, w: 0.006, d: 0.006, round: 0.5 },
    ]), 'spine', {
      p: [sign * P.waistLo.w * 0.22, 0, FRONT * (P.waistLo.d * core * 0.5 + 0.004)], mirror,
    });
  }
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

  // --- lower spine: the exposed abdominal stack ---------------------------
  buildAbdomen(rig, spec, P);

  // --- mid spine ----------------------------------------------------------
  // The lower lats. It starts ABOVE the stack rather than at the spine02
  // origin, so its bottom edge is a free rim overhanging a narrower dark body
  // instead of a butt joint against another painted band — the "armour, gap,
  // mechanism" read §1.3 asks for, at the one place on the torso the fight
  // camera frames every round.
  rig.plated('spine02', {
    y0: -m.mid * 0.30, y1: m.thorax * 0.70,
    w0: P.waistHi.w * 1.06, w1: P.ribs.w,
    d0: P.waistHi.d * 1.06, d1: P.ribs.d,
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

  // --- sternum and pectorals ----------------------------------------------
  //
  // What this replaces was one slab front: two flat facets spanning 0.52–0.66
  // of the chest width, laid across the whole thorax at two rakes, with a pair
  // of small lofted lumps floated on top of them. From the front — the view a
  // fighting camera holds for most of a round — that is a billboard with two
  // bumps on it, and it is the single largest flat face on the machine.
  //
  // Every one of the eight sheets builds the chest the other way round: a
  // narrow dark sternum channel down the centre line, and TWO curved plates
  // meeting either side of it, each a section of a swept surface (§1.1) that
  // wraps from the centre line round to the armpit. `paladin`'s heraldic
  // breastplate, `aegis-01`'s riveted pectorals and `vesper`'s glossy shells
  // are the same construction at three different levels of decoration.

  // The centre line itself: recessed dark machine, and the seat the chest hero
  // element lands on. It is what the two shells stop against, so it is what
  // makes them read as two plates rather than as one interrupted one.
  rig.add('chest', loftHull([
    { y: -m.thorax * 0.38, w: cw * 0.11, d: cd * 0.30, round: 0.44 },
    { y: m.collar * 0.10, w: cw * 0.09, d: cd * 0.34, round: 0.46, smooth: true },
    { y: m.collar * 0.70, w: cw * 0.07, d: cd * 0.26, round: 0.48 },
  ]), 'darkMetal', {
    p: [0, 0, FRONT * (cd * 0.34) + rz(0)], r: [plan.rake * DEG, 0, 0], tier: TIER.PRIMARY, role: 'frame',
  });

  // The two shells. One geometry, mirrored: a lathe swept over 74° of arc,
  // stopping 9° short of the centre line on the inboard end so the sternum
  // shows as a hard vertical split, and running out past 80° so the outboard
  // rim disappears under the pauldron rather than ending in mid-air.
  //
  // The sweep is circular and then squashed on Z to the chest's own depth
  // ratio, which is how a lathe wraps a torso that is not round. `R` grows as
  // the plan's corner radius falls: on a hard-cornered cuirass an inscribed
  // ellipse would sit INSIDE the ribcage's corners for most of its arc and the
  // plate would only show at the front.
  const pecR = cw * 0.5 * (1.02 + (1 - rnd) * 0.10);
  const pecH = ch * 0.66;
  const pecY = m.collar * 0.08;
  const pecSeg = rig.maxTier >= 2 ? 12 : 7;
  for (const { sign, mirror } of SIDES) {
    const shell = shellLathe([
      { r: pecR * 0.90, y: -pecH * 0.50 },
      { r: pecR * 1.00, y: -pecH * 0.16, smooth: true },
      { r: pecR * 1.00, y: pecH * 0.20, smooth: true },
      { r: pecR * 0.86, y: pecH * 0.50 },
    ], cd * 0.055, pecSeg, { arc: 74 * DEG, phase: 7 * DEG });
    shell.scale(1, 1, cd / cw);
    rig.add('chest', shell, 'armorPrimary', {
      p: [0, pecY, rz(pecY)], r: [plan.rake * DEG, 0, 0],
      // A wrapped pressing with a free ground rim the whole way round, which is
      // what the light catches at the centre split and at the armpit.
      mirror, tier: TIER.PRIMARY, role: 'lame',
    });
    // intake louvres on the upper chest flank
    addLouvres(rig, 'chest', {
      p: [sign * cw * 0.40, m.collar * 0.42, FRONT * cd * 0.22 + rz(m.collar * 0.42)],
      r: [0, sign * 118 * DEG, 0],
      w: cd * 0.30, h: 0.062, n: ventFins(spec, 0.55), depth: 0.020, mirror, glow: 'vents',
    });
  }

  // gorget / collar ring — bridges the deck to the neck column, and stops at
  // `GORGET_TOP` so the ribbed column above it is visible rather than sleeved.
  // See the constant: this ring and the head's clearance solve are the two ends
  // of one gap and are authored against the same number.
  const gr = P.yoke.w * 0.26;
  const gh = m.collar * 0.30;
  rig.add('chest', latheProfile([
    { r: gr * 0.86, y: 0.0 }, { r: gr, y: 0.018, smooth: true }, { r: gr, y: gh * 0.78 },
    { r: gr * 0.84, y: gh }, { r: gr * 0.70, y: gh }, { r: gr * 0.70, y: 0.0 },
  ], 20), 'darkMetal', {
    p: [0, m.collar * GORGET_TOP - gh, 0.005 + rz(m.collar * GORGET_TOP - gh)], tier: TIER.PRIMARY,
  });

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
  // §1.6: emissive is thin and linear, and there is exactly ONE hero element
  // per fighter. What this replaces broke that on four of the five plans — the
  // column plan lit five separate boxes down the sternum, the cage plan a 14 cm
  // luminous dome, the crystal plan a 15 cm faceted lamp. At that size the core
  // stops being a light set into a chest and becomes the chest, which is the
  // "large glowing face" the contract rules out by name.
  //
  // Every style below is now the same three parts and differs only in the shape
  // of them: a DARK WELL, a THIN polished RIM around it, and ONE emissive at
  // the bottom of the well. Depth is what makes a core read; area is what makes
  // it read as a sticker.
  //
  // Sized off the chest rather than in absolute metres. The old literals put
  // the same 20 cm hex on a heavy's breastplate and on a keel chest 28 cm wide,
  // where it covered almost the whole front.
  const R = clamp(cw * 0.21, 0.042, 0.082);
  const seg = rig.maxTier >= 2 ? 20 : 12;

  switch (spec.core) {
    case 'hex': {
      // Foundry / corridor guard: a hexagonal furnace port. The rim is a
      // six-sided collar 0.16 R deep and the light is a ring at the bottom of
      // it, so from anywhere but dead-on the glow is half occluded by its own
      // wall — which is what a port is.
      rig.add('chest', latheProfile([
        { r: R * 0.62, y: 0 }, { r: R, y: 0 }, { r: R, y: R * 0.30 },
        { r: R * 0.86, y: R * 0.40 }, { r: R * 0.66, y: R * 0.40 }, { r: R * 0.62, y: R * 0.10 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'bezel',
      { p: [0, cy, zf], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY });
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: R * 0.66, y: 0 }, { r: R * 0.66, y: R * 0.08 }, { r: 0, y: R * 0.08 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'darkMetal',
      { p: [0, cy, zf - FRONT * R * 0.10], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY, role: 'frame' });
      rig.glow('chest', latheProfile([
        { r: R * 0.34, y: 0 }, { r: R * 0.54, y: 0 }, { r: R * 0.54, y: R * 0.06 }, { r: R * 0.34, y: R * 0.06 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'core',
      { p: [0, cy, zf - FRONT * R * 0.04], r: [90 * DEG, 0, 0] });
      rig.add('chest', boltRing(6, R * 0.90, R * 0.11, R * 0.13, 0), 'trim',
        { p: [0, cy, zf + FRONT * R * 0.30], r: [-90 * DEG, 0, 0], tier: TIER.GREEBLE });
      break;
    }
    case 'slit': {
      // Courier / pest control: a vertical firing slot. Already the thin linear
      // emissive §1.6 asks for, so it keeps its proportions and only loses the
      // pair of accent wings that were competing with it for the centre line.
      const h = ch * 0.60;
      rig.add('chest', bevelBox(R * 1.10, h, R * 0.60, 0.010, { topX: 0.6, botX: 0.6 }), 'darkMetal',
        { p: [0, cy, zf], tier: TIER.PRIMARY, role: 'frame' });
      rig.glow('chest', bevelBox(R * 0.34, h * 0.82, R * 0.24, 0.004), 'core',
        { p: [0, cy, zf + FRONT * R * 0.20] });
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', bevelBox(R * 0.16, h * 1.06, R * 0.34, 0.005), 'trim',
          { p: [sign * R * 0.62, cy, zf + FRONT * R * 0.10], mirror, tier: TIER.SECONDARY });
      }
      break;
    }
    case 'cage': {
      // Dockyard / substation: a caged lamp. The bars are the read and they are
      // dark; the light behind them is a third of the radius it was, so what
      // the eye gets is a bright sliver between each pair of bars rather than a
      // glowing dome with sticks laid over it.
      rig.add('chest', latheProfile([
        { r: 0, y: 0 }, { r: R * 0.92, y: 0 }, { r: R * 0.88, y: R * 0.16 }, { r: 0, y: R * 0.18 },
      ], seg), 'darkMetal',
      { p: [0, cy, zf - FRONT * R * 0.16], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY, role: 'frame' });
      rig.glow('chest', latheProfile([
        { r: 0, y: 0 }, { r: R * 0.46, y: 0 }, { r: R * 0.40, y: R * 0.10 }, { r: 0, y: R * 0.12 },
      ], seg), 'core', { p: [0, cy, zf - FRONT * R * 0.08], r: [90 * DEG, 0, 0] });
      for (let i = 0; i < 5; i++) {
        const a = (-0.34 + i * 0.17) * Math.PI;
        rig.add('chest', bevelBox(R * 0.16, R * 1.70, R * 0.30, 0.005, { topX: 0.55, botX: 0.55 }), 'darkMetal', {
          p: [Math.sin(a) * R * 0.62, cy, zf + FRONT * (R * 0.06 + Math.cos(a) * R * 0.26)],
          r: [0, -a * 0.6, 0], tier: TIER.PRIMARY,
        });
      }
      rig.add('chest', latheProfile([
        { r: R * 0.98, y: 0 }, { r: R * 1.10, y: R * 0.10, smooth: true }, { r: R * 1.10, y: R * 0.24 }, { r: R * 0.98, y: R * 0.32 },
      ], seg + 2), 'trim', { p: [0, cy, zf - FRONT * R * 0.30], r: [90 * DEG, 0, 0], tier: TIER.SECONDARY });
      break;
    }
    case 'column': {
      // Reliquary / reference chassis: a single sealed strip light down the
      // sternum, in a recessed channel, between two polished rails. One
      // element, and the thinnest in the cast — this is the plan whose whole
      // identity is that nothing is bolted to it.
      const h = ch * 0.84;
      rig.add('chest', channelStrip(R * 0.62, h, 0.018), 'darkMetal',
        { p: [0, cy, zf], r: FACE_FRONT, tier: TIER.PRIMARY, role: 'frame' });
      rig.glow('chest', bevelBox(R * 0.30, h * 0.80, 0.008, 0.003), 'core',
        { p: [0, cy, zf - FRONT * 0.005] });
      for (const { sign, mirror } of SIDES) {
        rig.add('chest', bevelBox(R * 0.20, h * 1.02, R * 0.28, 0.005), 'trim',
          { p: [sign * R * 0.44, cy, zf], mirror, tier: TIER.SECONDARY });
      }
      break;
    }
    default: { // crystal
      // Casino security / bodyguard: a gem in a claw setting. The stone is
      // small and stands well proud, so it catches the key light as a hard
      // specular point instead of washing the plate around it.
      const crystal = latheProfile([
        { r: 0, y: -R * 0.52 }, { r: R * 0.36, y: -R * 0.14 }, { r: R * 0.40, y: R * 0.04 }, { r: 0, y: R * 0.54 },
      ], 6, { faceted: true, phase: Math.PI / 6 });
      rig.glow('chest', crystal, 'core', { p: [0, cy, zf + FRONT * R * 0.34], r: [-90 * DEG * FRONT, 0, 0] });
      rig.add('chest', latheProfile([
        { r: R * 0.86, y: 0 }, { r: R * 0.96, y: R * 0.10, smooth: true }, { r: R * 0.62, y: R * 0.42 },
        { r: R * 0.50, y: R * 0.42 }, { r: R * 0.72, y: R * 0.08 }, { r: R * 0.70, y: 0 },
      ], 6, { faceted: true, phase: Math.PI / 6 }), 'trim',
      { p: [0, cy, zf], r: [90 * DEG, 0, 0], tier: TIER.PRIMARY });
      for (let i = 0; i < 3; i++) {
        rig.decal('chest', MARKINGS.GAUGE, R * 0.60, R * 0.60, {
          p: [Math.cos(i * 2.1) * R * 1.30, cy + Math.sin(i * 2.1) * R * 1.10, zf + FRONT * 0.006],
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
      // shrunk on above and below it. Nothing else in the cast has a stoke hole
      // on its front, which is what stops this reading as another
      // broad-shouldered heavy.
      //
      // It used to be a full circle at 0.52 of the upper waist, and it was
      // measurably the worst thing on the fighter: `docs/shots/03-full-body.jpg`
      // shows a 0.47 m manhole cover from crotch to sternum, covering the entire
      // abdomen. It has to be a door on a belly, not a shield — so it is now an
      // OVAL, wider than tall, sitting inside the exposed band with the ring
      // stack of §1.3 showing above and below it. The squash is baked into the
      // geometry rather than passed as a placement scale, because `add` derives
      // the plate frame from one `getMaxScaleOnAxis` and a non-uniform placement
      // would report the door a third taller than it is.
      const r = P.waistHi.w * 0.46;
      const zf = FRONT * (P.waistHi.d * 0.5) + rz(0);
      const door = latheProfile([
        { r: 0, y: 0 }, { r: r * 0.94, y: 0 }, { r, y: 0.018, smooth: true },
        { r, y: 0.040 }, { r: r * 0.86, y: 0.052 }, { r: 0, y: 0.052 },
      ], 22);
      door.scale(1, 1, 0.60);
      rig.add('spine01', door, 'armorSecondary',
        { p: [0, m.mid * 0.14, zf], r: FACE_FRONT, tier: TIER.PRIMARY });
      for (let i = 0; i < 4; i++) {
        rig.glow('spine01', bevelBox(r * (0.92 - i * 0.16), 0.012, 0.010, 0.003), 'core',
          { p: [0, m.mid * 0.14 - 0.026 + i * 0.017, zf + FRONT * 0.050] });
      }
      // The hoops hug the ring stack rather than standing off it: at 0.60 of the
      // upper waist they were a wider hoop than the chest above them.
      for (const dy of [-0.5, 0.62]) {
        rig.add('spine01', latheProfile([
          { r: P.waistHi.w * 0.50, y: 0 }, { r: P.waistHi.w * 0.545, y: 0.012, smooth: true },
          { r: P.waistHi.w * 0.545, y: 0.036 }, { r: P.waistHi.w * 0.50, y: 0.048 },
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
  // Radial count was 6 — a hexagonal cross-section — which is fine for a
  // silhouette-distance greeble but not for a hero closeup: on a rounded
  // dielectric surface (this defaults to ZONE 2 below) the specular highlight
  // is the whole read, and six facets break a highlight that should travel
  // smoothly around the tube into four or five flat bands, each catching the
  // key light at its own angle. 10 is enough to keep that highlight
  // continuous at the closeup framing (each facet subtends 36 degrees instead
  // of 60) while staying well short of the 20-32 used for barrels and collars
  // that actually get read end-on. Cost is +112 triangles per pipe run
  // instance (14 tubular segments unchanged * (10-6) radial * 2) — five call
  // sites, each TIER.GREEBLE so it culls at distance and drops at LOD1.
  const tube = new THREE.TubeGeometry(curve, o.segments ?? 14, radius, 10, false);
  // ZONE 2 by default: a pipe run is hose, and hose is the textbook case for the
  // matte composite. Callers that mean rigid conduit still pass `mat`.
  rig.add(bone, tube, o.mat ?? 'gasket', { mirror: o.mirror, tier: o.tier ?? TIER.GREEBLE });

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
/** Head-local Y of the crown of every skull authored below; crests go above. */
const HEAD_CROWN = 0.15;

/**
 * Top of the chest's gorget ring, as a fraction of the neck bone's length.
 *
 * Shared with `buildTorso`, which draws the ring, because the two ends of the
 * same gap cannot be authored independently. It used to stop at 0.95 — five
 * millimetres short of the neck joint — which meant the collar reached the jaw
 * and there was nothing between them to see. §1.7 makes the exposed neck a
 * defining element of all eight sheets, so the ring gives back a sixth of its
 * height and the head clearance solve holds the rest of the gap open.
 */
const GORGET_TOP = 0.86;
/** Column that must stay exposed above the gorget, in neck-bone lengths. */
const NECK_SHOW = 0.30;

/**
 * The canonical skull envelope, in authoring units before the head scale.
 *
 * Every one of the ten styles is authored inside this box. That is the whole
 * mechanism behind §1.2's "the head is small": a style cannot quietly grow by
 * writing bigger literals, because the literals it writes are fractions of
 * these three numbers.
 *
 * The proportions are read off the sheets rather than chosen: a head is TALLER
 * than it is wide and DEEPER than it is wide. Measured on the build before this
 * change, five of the ten were the other way round — bastion 0.348 wide against
 * 0.179 tall, ronin 0.396 against 0.222 — which is exactly why §2.4 calls the
 * heads cubes. w/h 0.69 and d/h 0.86 is an egg; 1.94 is a brick.
 */
const SKULL = { h: HEAD_CROWN - HEAD_JAW, w: 0.138, d: 0.172 };

/**
 * Body heights per head height, by chassis.
 *
 * §1.2 puts the reference cast between 5.5 and 8 heads and the head at "~1/6 of
 * total height even on the heavies". Measured on the built mesh before this
 * change, the cast ran 4.98 (nyx) to 7.75 (vulkan) body-heights per head's
 * LARGEST dimension — five fighters carrying a head bigger than a sixth of
 * themselves. Nothing here is allowed above 1/7 now, and the heavies sit at the
 * large end of the band because that is what reads as mass: a small head on a
 * wide chassis is the oldest trick there is for making a machine look big.
 */
const HEADS_TALL = { brute: 7.0, heavy: 7.3, precision: 7.5, agile: 7.9, arcane: 7.9 };

/**
 * Uniform author-space scale for the skull.
 *
 * Deliberately NOT `proportions.head * constant`, which is what it used to be.
 * That multiplier scales the head BONE CHAIN, and the roster's values run the
 * wrong way for stature — 1.12 on nyx, the tallest slim frame, against 0.9 on
 * vulkan at 2.02 m — so applying it raw made the smallest fighters wear the
 * biggest skulls. Sizing off `headTop`'s rest height instead makes the head a
 * fraction of the body, which is what a proportion is. The roster multiplier is
 * still in there: it moves `headTop` too, so a 1.12 head is about 2% larger
 * than a 0.9 one on the same frame instead of 24% larger.
 */
function headScale(rig, def) {
  const stature = rig.restPos.headTop?.y ?? 1.91;
  return stature / ((HEADS_TALL[def?.chassis] ?? HEADS_TALL.precision) * SKULL.h);
}

/**
 * The exposed neck: a dark ribbed column with a cable pair on it, standing in
 * clear air between the gorget and the jaw.
 *
 * §1.3 makes this the first item on the underskin list — "the neck: always
 * exposed, always ribbed or cabled, never covered" — and §1.7 makes it part of
 * the head plan. What was here was a smooth `gasket` cylinder with two blade
 * guards: a column, but a turned one, and at fighting distance a smooth dark
 * cylinder under a jaw reads as shadow rather than as mechanism. Rings read.
 * They draw their own horizontal lines, they survive being four pixels wide,
 * and they are what says the joint can pitch.
 *
 * Built in two halves because the head is LIFTED off its bone by the clearance
 * solve: the lower half is on `neck` and stays with the shoulders, the upper
 * half is on `head` and rises with the skull, and they overlap so no amount of
 * lift can open a hole between them.
 *
 * @param {Rig} rig
 * @param {number} lift metres the skull is raised by the clearance solve
 * @param {number} k skull author scale, for the jaw the riser has to reach
 */
function buildNeck(rig, lift, k) {
  const m = rig.dim;
  const seg = rig.maxTier >= 2 ? 18 : 12;
  // Slimmer than the 0.048 it replaces. The old column was thick enough to fill
  // the gorget bore, so shortening the gorget would have revealed nothing but
  // more of the same diameter; a neck has to be visibly narrower than the throat
  // it comes out of or the taper never registers.
  const nr = 0.042 * m.torsoK;

  // ZONE 2 (matte composite). The core the rings are stacked on. A mirror here
  // put a second bright brushed streak directly under the jaw and flattened the
  // whole head into the shoulder — see the zone note in Materials.js.
  const bot = -m.collar * 0.26;
  const top = m.nape * 1.04;
  rig.add('neck', latheProfile([
    { r: nr * 0.84, y: bot },
    { r: nr * 0.94, y: bot * 0.35, smooth: true },
    { r: nr * 0.90, y: top * 0.55, smooth: true },
    { r: nr * 0.82, y: top },
  ], seg), 'gasket', { tier: TIER.PRIMARY });
  // PRIMARY, not SECONDARY: the ribs are the silhouette of the neck, and a neck
  // that loses them at LOD1 goes back to being the smooth cylinder this replaces.
  rig.ribStack('neck', {
    count: 4, r0: nr * 0.97, r1: nr * 0.88,
    y0: bot + m.collar * 0.06, y1: top - m.nape * 0.14,
    h: 0.010 * m.torsoK, deep: 1.05, mat: 'darkMetal', tier: TIER.PRIMARY,
  });

  // Riser: the half of the column that follows the skull. Authored OUTSIDE the
  // lift (it is placed on the unlifted bone) but reaching UP TO the lifted jaw,
  // so its length absorbs the clearance solve instead of a gap doing it.
  const rr = (0.044 + lift * 0.14) * m.torsoK;
  // Where the riser has to reach: the jaw, but never below the shoulder of its
  // own profile. The clearance solve gives a fighter with low pauldrons about
  // fifteen millimetres of lift, and at that value the raw jaw height lands
  // UNDER the station beneath it — the lathe folds back through itself and the
  // ring stack bunches inside the gorget where nothing can see it. Overshooting
  // instead is free: the extra centimetre is inside the skull.
  const rise = Math.max(lift + HEAD_JAW * k + 0.012, -m.nape * 0.30 + 0.044);
  rig.add('head', latheProfile([
    { r: rr * 0.84, y: -m.nape * 0.72 },
    { r: rr * 0.92, y: -m.nape * 0.30, smooth: true },
    { r: rr * 0.80, y: rise - 0.030, smooth: true },
    { r: rr * 0.96, y: rise - 0.014, smooth: true },
    { r: rr * 0.90, y: rise },
  ], seg), 'gasket', { tier: TIER.PRIMARY });
  rig.ribStack('head', {
    count: 3, r0: rr * 0.96, r1: rr * 0.84,
    y0: -m.nape * 0.62, y1: rise - 0.012,
    h: 0.010 * m.torsoK, deep: 1.05, mat: 'darkMetal', tier: TIER.PRIMARY,
  });

  // The cable pair. Rigid conduits rather than the soft loom in
  // `buildMechanism`, because these two have to be there at every LOD and from
  // every angle: they are half of what "cabled neck" means in §1.7. They run up
  // the back quarters, which is where every sheet puts them and where a head
  // turn hides them least.
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0.0090, y: -m.nape * 0.62 },
      { r: 0.0105, y: -m.nape * 0.10, smooth: true },
      { r: 0.0085, y: rise - 0.006 },
    ], rig.maxTier >= 2 ? 9 : 6), 'rubber', {
      p: [sign * rr * 0.82, 0, -FRONT * rr * 0.62], r: [0, 0, sign * -4 * DEG],
      mirror, tier: TIER.PRIMARY, role: 'frame',
    });
  }
  rig.glow('head', loftHull([
    { y: -m.nape * 0.42, w: 0.011, d: 0.009, round: 0.5 },
    { y: rise - 0.022, w: 0.009, d: 0.007, round: 0.5 },
  ]), 'spine', { p: [0, 0, -FRONT * (rr * 0.86)] });
}

function buildHead(rig, spec, def) {
  const m = rig.dim;
  const k = headScale(rig, def);

  // Clearance solve. `lift` is a distance in metres, not a proportion, so it is
  // applied unscaled — the head sits exactly far enough above the pauldrons for
  // the whole skull to be sky, whatever this character's arms multiplier did.
  const headAboveChest = rig.restPos.head.y - rig.restPos.chest.y;
  const clear = shoulderLineY(rig, spec) - 0.014;
  // Second floor, new with the exposed neck: the jaw also has to stand clear of
  // the GORGET by `NECK_SHOW`, or the ribbed column is built and then buried.
  // Measured on the build before this change, the front collar came within
  // 8 mm of the chin on five fighters and 208 mm ABOVE it on bastion.
  const throat = (rig.restPos.chest.y - rig.restPos.head.y) + m.collar * GORGET_TOP + m.collar * NECK_SHOW;
  // Capped: past about nine centimetres the riser stops reading as a neck and
  // starts reading as a giraffe, and the camera's headroom above `headTop` is
  // finite. The cap is up from 0.075 because the skull it has to clear is now
  // roughly a third smaller and buys back the room.
  const lift = clamp(Math.max(clear - (headAboveChest + HEAD_JAW * k), throat - HEAD_JAW * k), 0, 0.095);

  buildNeck(rig, lift, k);

  rig.lifted(lift, () => rig.scaled(k, () => {
    (HEAD_BUILDERS[spec.head] ?? headFurnace)(rig, spec, def);
  }));
}

/**
 * The DOMED plan (§1.7): an egg. Widest at the temples, tapering to a rounded
 * chin with no jaw line and no mouth, deeper than it is wide, and smooth the
 * whole way round — the incident on a domed head is the optic and nothing else.
 *
 * One lathe, because a lathe is the only primitive here that produces a
 * genuinely continuous surface: the five styles built on this plan — mono,
 * swept, turret, lantern, crown — are the ones whose sheets (`volt-monk`,
 * `vesper`, `ghostframe`, `atlas-7`) have no seam on the crown at all.
 */
function domeSkull(rig, o = {}) {
  const w = o.w ?? SKULL.w, d = o.d ?? SKULL.d;
  const jaw = o.jaw ?? HEAD_JAW, crown = o.crown ?? HEAD_CROWN;
  const H = crown - jaw, r = w * 0.5;
  return rig.add('head', latheProfile([
    { r: r * 0.26, y: jaw },
    { r: r * 0.72, y: jaw + H * 0.16, smooth: true },
    { r: r * 0.97, y: jaw + H * 0.40, smooth: true },
    { r: r * 1.00, y: jaw + H * 0.58, smooth: true },
    { r: r * 0.87, y: jaw + H * 0.80, smooth: true },
    { r: r * 0.48, y: crown - H * 0.07, smooth: true },
    { r: 0, y: crown },
  ], rig.maxTier >= 2 ? 26 : 14), o.mat ?? 'armorPrimary', {
    s: [1, 1, d / w], p: [0, 0, o.z ?? 0], tier: TIER.PRIMARY,
  });
}

/**
 * The HELMETED plan (§1.7): a smooth bowl, a brow band standing proud across
 * the front of it, and a pair of cheek plates that stop short of meeting under
 * the chin. Three parts with air between them, which is the same armour-gap-
 * mechanism reading §1.3 asks for everywhere else, applied to a head.
 *
 * The bowl is a loft rather than a lathe so the five helmeted styles — furnace,
 * kabuto, mandible, bunker, insulator — can be asymmetric front-to-back (a
 * kabuto is deep at the nape, a bunker is deep at the brow) without any of them
 * going back to being a box: `round` is 0.90–0.94 at every station, where the
 * old heads sat at 0.10–0.34 and shaded as four planes and a fillet.
 */
function helmSkull(rig, o = {}) {
  const w = o.w ?? SKULL.w, d = o.d ?? SKULL.d;
  const jaw = o.jaw ?? HEAD_JAW, crown = o.crown ?? HEAD_CROWN;
  const H = crown - jaw;
  const nose = o.nose ?? 0;    // how far the face is pushed forward of the crown
  const band = o.band ?? 0.52; // brow height as a fraction of the skull
  rig.add('head', loftHull([
    { y: jaw, w: w * 0.60, d: d * 0.62, z: FRONT * nose * 0.6, round: 0.92 },
    { y: jaw + H * 0.22, w: w * 0.92, d: d * 0.94, z: FRONT * nose, round: 0.92, smooth: true },
    { y: jaw + H * 0.52, w: w * 1.00, d: d * 1.00, z: FRONT * nose * 0.7, round: 0.90, smooth: true },
    { y: jaw + H * 0.80, w: w * 0.90, d: d * 0.90, z: 0, round: 0.92, smooth: true },
    { y: crown, w: w * 0.52, d: d * 0.54, z: -FRONT * nose * 0.3, round: 0.94 },
  ], { perQuad: rig.maxTier >= 2 ? 5 : 3 }), o.mat ?? 'armorPrimary', { tier: TIER.PRIMARY });

  // Brow band: a swept shell across the front quarters, standing off the bowl so
  // the optic sits in its shadow. `shellLathe` and not a box — this is the part
  // that used to be a `bevelBox` riot lip 0.256 m wide on bastion.
  const by = jaw + H * band;
  // 0.53 rather than 0.50: three per cent proud of the bowl is four millimetres
  // at this scale, which is a shadow line under a top key and nothing more. At
  // half the depth as well it became a hoop standing off the head.
  const br = w * 0.53;
  rig.add('head', shellLathe([
    { r: br * 0.90, y: -H * 0.10 },
    { r: br * 1.00, y: 0, smooth: true },
    { r: br * 0.92, y: H * 0.09 },
  ], H * 0.055, rig.maxTier >= 2 ? 16 : 10, { arc: (o.bandArc ?? 168) * DEG, phase: (90 - (o.bandArc ?? 168) * 0.5) * DEG }),
  o.bandMat ?? 'armorSecondary', {
    p: [0, by, FRONT * nose * 0.6], s: [1, 1, d / w], r: [0, YAW_FRONT, 0], tier: TIER.PRIMARY,
  });

  // Cheek plates. They leave the underside of the skull open — that gap is where
  // the neck rings show from the side, and it is the only thing that stops a
  // helmet reading as a bucket.
  if (o.cheeks !== false) {
    for (const { sign, mirror } of SIDES) {
      rig.add('head', loftHull([
        { y: jaw + H * 0.46, w: w * 0.20, d: d * 0.62, round: 0.60 },
        { y: jaw + H * 0.20, w: w * 0.22, d: d * 0.66, round: 0.55, smooth: true },
        // Stops AT the jaw line, not below it. HEAD_JAW is the number the
        // clearance solve stands the whole skull on, so a cheek plate hanging
        // twenty millimetres under it spends the neck's exposure on itself.
        { y: jaw + H * 0.02, w: w * 0.14, d: d * 0.44, round: 0.62 },
      ]), o.cheekMat ?? 'armorSecondary', {
        p: [sign * w * 0.44, 0, FRONT * nose * 0.35], r: [0, 0, sign * 9 * DEG], mirror, tier: TIER.PRIMARY,
      });
    }
  }
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
  // ZONE 3 (dark anodised). The well the lens sits in is the bezel, and it is
  // the only place on the fighter that gets a mirror-tight coat: a 0.035-rough
  // lobe next to the plate's ~0.28 coat is a hard small highlight against a
  // broad one, which is the whole reason a face reads as an instrument.
  // The well is now three times the slit's height rather than twice it, and the
  // slit itself is a THIRD of the emissive area it was. §1.6: "emissive is thin
  // and linear ... it is never a large glowing face." Photographed at closeup
  // framing, the old band was a solid white lozenge a fifth of the head wide
  // and, after bloom, the brightest object in the frame by a wide margin — the
  // exact "big glowing face" the contract rules out. A slit reading as a line
  // with dark either side of it is what every one of the eight sheets has.
  rig.add('head', channelStrip(w, h * 3.0, 0.026), 'bezel',
    { p: [0, y, z], r: [FACE_FRONT[0] + tilt, 0, 0], tier: TIER.SECONDARY });
  rig.glow('head', loftHull([
    { y: -h * 0.5, w: w * 0.70, d: 0.008, round: 0.5 },
    { y: -h * 0.16, w: w * 0.94, d: 0.011, round: 0.45, smooth: true },
    { y: h * 0.16, w: w * 0.94, d: 0.011, round: 0.45, smooth: true },
    { y: h * 0.5, w: w * 0.70, d: 0.008, round: 0.5 },
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

/**
 * Small recessed lens: a dark socket with a bright pupil sitting inside it.
 *
 * §1.6 — "emissive is thin and linear ... it is never a large glowing face."
 * Every optic on a domed head is one of these or a pair of them, at sixteen to
 * twenty-one millimetres of socket, which is two or three pixels at fighting
 * range and a hard specular point at close range. That is the whole budget a
 * face gets, and it is why the plans in §1.7 can afford to have no other
 * feature on them at all.
 *
 * `yaw` turns the lens outward around the skull and has to be applied OUTSIDE
 * the pitch that stands it up — hence the YXZ order. In XYZ the yaw multiplies
 * in before the 90-degree pitch and vanishes entirely, which put both of
 * MANTIS's compound eyes flat on top of its head.
 */
function addLens(rig, o) {
  const r = o.r ?? 0.016;
  const seg = rig.maxTier >= 2 ? 14 : 8;
  const place = {
    p: o.p, r: [FACE_FRONT[0] + (o.tilt ?? 0), o.yaw ?? 0, 0], order: 'YXZ', mirror: o.mirror,
  };
  // Ring, then a dark well, then a small pupil. The well is the reason the ring
  // is not a solid disc of light: with the emissive filling the socket, ANVIL
  // and MANTIS photographed as a pair of cartoon eyes — two saturated circles a
  // fifth of the head across each. The pupil is 0.52 of the socket, so what
  // reads at distance is a dark eye with a highlight in it.
  rig.add('head', latheProfile([
    { r: r * 0.98, y: 0 },
    { r: r * 1.34, y: r * 0.10, smooth: true }, { r: r * 1.30, y: r * 0.46 },
    { r: r * 0.96, y: r * 0.62 },
  ], seg), o.ring ?? 'bezel', { ...place, tier: TIER.PRIMARY });
  rig.add('head', latheProfile([
    { r: 0, y: 0 }, { r: r * 1.02, y: 0 }, { r: r * 1.02, y: r * 0.26 },
  ], seg), 'bezel', { ...place, tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([
    { r: 0, y: r * 0.30 }, { r: r * 0.52, y: r * 0.30 },
    { r: r * 0.44, y: r * 0.50, smooth: true }, { r: 0, y: r * 0.60 },
  ], seg), o.group ?? 'visor', place);
}

function headFurnace(rig) {
  // VULKAN — the `furnace` sheet. A squat riveted helm with one wide slot for a
  // face, a full-width brow strap in bare trim metal, and a riveted band running
  // the crown from brow to nape. Broadest brow band in the cast, which is what
  // makes it read as pressed and bolted plate rather than as a casting.
  //
  // What was here was a bulldog: a jutting jaw, a five-bar face cage and three
  // furnace discs behind it. §1.7 gives a helmeted head a brow band, a cheek
  // plate, a visor slit and a crest, and nothing else — on a skull now a third
  // smaller than it was, a five-bar cage is three pixels of noise. One lit slot
  // replaces all of it and stays legible at every distance the fight camera
  // uses.
  helmSkull(rig, {
    w: SKULL.w * 1.05, d: SKULL.d * 0.93, nose: 0.008, band: 0.54, bandArc: 208, bandMat: 'trim',
  });
  addVisor(rig, { w: 0.104, h: 0.012, y: 0.022, z: FRONT * 0.080, brow: 0.014, posts: false });

  // Riveted crown strap. Swept ear to ear (the lathe axis is rolled onto -Z, so
  // 90 degrees of arc is straight up) on a radius that clears the bowl by about
  // five millimetres — enough for a shadow line, not enough to read as a hoop.
  rig.add('head', shellLathe([
    { r: 0.070, y: -0.030 }, { r: 0.077, y: 0, smooth: true }, { r: 0.070, y: 0.030 },
  ], 0.009, rig.maxTier >= 2 ? 15 : 9, { arc: 150 * DEG, phase: 15 * DEG }), 'armorSecondary', {
    p: [0, 0.074, 0], r: [-90 * DEG, 0, 0], tier: TIER.PRIMARY,
  });
  rig.add('head', boltRing(6, 0.044, 0.006, 0.007), 'trim', { p: [0, 0.126, 0], tier: TIER.GREEBLE });

  // Two short flue stubs on the whip leaves. Stubs, not the 0.07 m stacks they
  // replace: a helmeted head is allowed to break its outline, but §1.2 measures
  // the head's bounding box and a pair of chimneys puts half the skull's own
  // height back into it.
  for (const { s: side, sign, mirror } of SIDES) {
    const stack = `antenna_${side}`;
    rig.add('head', latheProfile([
      { r: 0.014, y: 0 }, { r: 0.014, y: 0.026 }, { r: 0.018, y: 0.030, smooth: true },
      { r: 0.011, y: 0.036 }, { r: 0, y: 0.036 },
    ], 10), 'darkMetal', {
      p: [sign * 0.050, 0.086, -FRONT * 0.042], r: [-22 * DEG, 0, sign * 10 * DEG], mirror,
      tier: TIER.PRIMARY, sprung: stack,
    });
    rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.008, y: 0 }, { r: 0, y: 0.006 }], 10), 'vents',
      { p: [sign * 0.063, 0.118, -FRONT * 0.055], r: [-22 * DEG, 0, sign * 10 * DEG], mirror, sprung: stack });
  }
}

function headSwept(rig) {
  // KESTREL — derived from `ghostframe`'s frame with `volt-monk`'s surfacing, so
  // it is on the domed plan: one continuous egg drawn out fore and aft into a
  // teardrop, with a low blade of a crest along the crown to the nape.
  //
  // That crest used to be a 0.19 m fin standing 0.05 m clear of the shell — a
  // third of a head-height of pure bounding box. It is now a raised spine ON the
  // shell: the same "this head is pointing somewhere" read at forty pixels, none
  // of the volume.
  domeSkull(rig, { w: SKULL.w * 0.94, d: SKULL.d * 1.10, z: -FRONT * 0.006 });
  addVisor(rig, { w: 0.100, h: 0.011, y: 0.034, z: FRONT * 0.082, tilt: -12 * DEG, brow: 0.014, posts: false });

  // The crest is swept on the egg's OWN curve rather than lofted across it. A
  // straight loft over a curved crown is buried at both ends and proud only in
  // the middle — authored as a box-shaped fin it disappeared completely into the
  // shell, which is what the first pass of this head did. A circular blade
  // centred just under the temples clears the surface by eight to ten
  // millimetres for its whole length.
  const fin = { p: [0, 0.056, 0], r: [0, 0, 90 * DEG], tier: TIER.PRIMARY };
  rig.add('head', shellLathe([
    { r: 0.100, y: -0.009 }, { r: 0.104, y: 0, smooth: true }, { r: 0.100, y: 0.009 },
  ], 0.014, rig.maxTier >= 2 ? 16 : 10, { arc: 142 * DEG, phase: -62 * DEG }), 'armorAccent', fin);
  rig.glow('head', shellLathe([
    { r: 0.1055, y: -0.0028 }, { r: 0.1065, y: 0, smooth: true }, { r: 0.1055, y: 0.0028 },
  ], 0.005, rig.maxTier >= 2 ? 14 : 9, { arc: 122 * DEG, phase: -52 * DEG }), 'spine', fin);

  // the one recess on an otherwise sealed shell
  addLouvres(rig, 'head', {
    p: [0, -0.018, FRONT * 0.074], r: [(-26) * DEG, YAW_FRONT, 0],
    w: 0.054, h: 0.024, n: 3, depth: 0.010, glow: 'vents',
  });
  for (const { sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: -0.004, w: 0.012, d: 0.054, round: 0.46 },
      { y: 0.046, w: 0.010, d: 0.040, round: 0.48 },
    ]), 'trim', { p: [sign * 0.056, 0.016, -FRONT * 0.020], r: [0, 0, sign * -6 * DEG], mirror, tier: TIER.SECONDARY });
  }
}

function headTurret(rig) {
  // ANVIL — the `atlas-7` sheet. A riveted diving bell: near spherical, a pair
  // of brass goggle lenses set wide on the face with a breather grille sunk
  // between them, and two lifting eyes on the crown. Domed plan — no jaw, no
  // brow band, no visor.
  //
  // The collar shed this dome used to sit down inside measured 0.316 m across on
  // a 0.215 m skull: the widest head on the roster, and the reason ANVIL came in
  // at 5.88 body-heights per head. The bell now clears its own collar, and the
  // ring that is left is a rivet band on the shell rather than a hat brim.
  domeSkull(rig, { w: SKULL.w * 1.02, d: SKULL.d * 0.86, crown: HEAD_CROWN - 0.012 });
  rig.add('head', latheProfile([
    { r: 0.0625, y: 0.002 }, { r: 0.0675, y: 0.011, smooth: true }, { r: 0.0625, y: 0.020 },
  ], rig.maxTier >= 2 ? 22 : 12), 'trim', { s: [1, 1, 1.05], tier: TIER.PRIMARY });
  rig.add('head', boltRing(8, 0.038, 0.006, 0.007), 'trim', { p: [0, 0.104, 0], tier: TIER.GREEBLE });

  for (const { sign, mirror } of SIDES) {
    addLens(rig, {
      p: [sign * 0.036, 0.038, FRONT * 0.058], tilt: -12 * DEG, yaw: sign * 24 * DEG,
      r: 0.020, ring: 'trim', mirror,
    });
  }
  // breather grille, the one dark incident between the two lenses
  rig.add('head', channelStrip(0.030, 0.036, 0.014), 'bezel',
    { p: [0, -0.008, FRONT * 0.056], r: [FACE_FRONT[0] + 14 * DEG, 0, 0], tier: TIER.SECONDARY });

  // lifting eyes — two closed loops on the crown, the one silhouette break
  for (const { sign, mirror } of SIDES) {
    rig.add('head', segmentRing(0.019, 0.010, 0.009, 8, 0.002), 'trim', {
      p: [sign * 0.034, 0.110, -FRONT * 0.006], r: [0, sign * 24 * DEG, 0], mirror, tier: TIER.PRIMARY,
    });
  }
}

function headKabuto(rig) {
  // RONIN-07 — the `neon-ronin` sheet. A helm bowl deeper at the nape than at
  // the brow, a three-lame shikoro stepping down over the neck, and a crescent
  // maedate springing off a boss on the brow. The crescent alone names the
  // character at any size.
  //
  // Everything here is between half and two thirds of what it was. The old
  // shikoro was a 0.30 m disc: measured on the built mesh, RONIN's head came out
  // 0.396 m wide against 0.222 m tall — a w/h of 1.78 where a head wants 0.7,
  // and 5.00 body-heights per head, the worst number on the roster.
  helmSkull(rig, {
    w: SKULL.w * 0.92, d: SKULL.d * 1.02, nose: -0.006, band: 0.58, bandArc: 176, cheekMat: 'trim',
  });
  addVisor(rig, { w: 0.092, h: 0.011, y: 0.040, z: FRONT * 0.078, tilt: -6 * DEG, brow: 0.018, posts: false });

  // shikoro: three flared lames stepping out and down over the shoulders,
  // centred on the nape (270 degrees is -Z in the lathe's own frame)
  for (let i = 0; i < 3; i++) {
    const R = 0.076 + i * 0.015;
    rig.add('head', shellLathe([
      { r: R * 0.88, y: 0 }, { r: R, y: 0.013, smooth: true }, { r: R * 0.92, y: 0.028 },
    ], 0.008, rig.maxTier >= 2 ? 18 : 11, { arc: 244 * DEG, phase: 148 * DEG }),
    i === 1 ? 'armorAccent' : 'armorSecondary', {
      p: [0, -0.004 - i * 0.019, -FRONT * 0.004], r: [(-20 - i * 8) * DEG, 0, 0], tier: TIER.PRIMARY,
    });
  }

  // menpo grille under the visor — three thin bars, this plan's one nod to a
  // mouth on a head that does not have one
  for (let i = 0; i < 3; i++) {
    rig.add('head', bevelBox(0.058 - i * 0.010, 0.005, 0.006, 0.0015), 'bezel',
      { p: [0, -0.026 + i * 0.013, FRONT * 0.070], r: [10 * DEG, 0, 0], tier: TIER.GREEBLE });
  }

  // maedate: the crescent. Two broad flat blades springing from one boss, on the
  // whip leaves so they keep ringing after a head turn. Broad and thin is not
  // decoration — it is why the crest survives being small on screen. At 24 mm
  // across an earlier pass these were horns, and a horn is a hairline at
  // fighting range.
  for (const { s: side, sign, mirror } of SIDES) {
    const whip = `antenna_${side}`;
    rig.add('head', loftHull([
      { y: 0, w: 0.036, d: 0.022, round: 0.34 },
      { y: 0.078, w: 0.072, d: 0.014, z: FRONT * 0.034, round: 0.18, smooth: true },
      { y: 0.142, w: 0.058, d: 0.009, z: FRONT * 0.092, round: 0.20, smooth: true },
      { y: 0.182, w: 0.021, d: 0.006, z: FRONT * 0.136, round: 0.36 },
    ]), 'trim', {
      p: [sign * 0.019, 0.086, FRONT * 0.018],
      r: [-14 * DEG, 0, sign * 21 * DEG], mirror, tier: TIER.PRIMARY, sprung: whip,
    });
    // a crimson cord line down the blade's spine, the character's accent colour
    // on the one part of it that is never in shadow
    rig.add('head', loftHull([
      { y: 0.008, w: 0.010, d: 0.006, round: 0.5 },
      { y: 0.152, w: 0.007, d: 0.004, z: FRONT * 0.100, round: 0.5 },
    ]), 'armorAccent', {
      p: [sign * 0.019, 0.086, FRONT * 0.025],
      r: [-14 * DEG, 0, sign * 21 * DEG], mirror, tier: TIER.SECONDARY, sprung: whip,
    });
  }
  rig.add('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.022, y: 0 }, { r: 0.025, y: 0.008, smooth: true },
    { r: 0.017, y: 0.020 }, { r: 0, y: 0.022 },
  ], 16), 'armorAccent', { p: [0, 0.084, FRONT * 0.034], r: [-70 * DEG * -FRONT, 0, 0], tier: TIER.PRIMARY });
}

function headMandible(rig) {
  // MANTIS — derived in the `neon-ronin` language. A narrow wedge of a helm
  // thrust forward on the raked thorax, with wide-set compound optics instead of
  // a centred band and a palp curling in under each of them. Nothing else in the
  // cast has its eyes off the centre line, and that survives at silhouette size.
  helmSkull(rig, {
    w: SKULL.w * 0.86, d: SKULL.d * 1.06, nose: 0.020, band: 0.64, bandArc: 148,
    bandMat: 'armorAccent', cheeks: false,
  });

  for (const { s: side, sign, mirror } of SIDES) {
    addLens(rig, {
      p: [sign * 0.046, 0.038, FRONT * 0.058], tilt: -10 * DEG, yaw: sign * 34 * DEG, r: 0.021, mirror,
    });
    // palp, curling forward and inward under the optic
    rig.add('head', loftHull([
      { y: 0, w: 0.019, d: 0.028, round: 0.42 },
      { y: -0.038, w: 0.014, d: 0.032, z: FRONT * 0.026, round: 0.40, smooth: true },
      { y: -0.062, w: 0.007, d: 0.017, z: FRONT * 0.052, round: 0.46 },
    ]), 'trim', {
      p: [sign * 0.032, -0.010, FRONT * 0.072], r: [0, sign * -14 * DEG, sign * 20 * DEG], mirror, tier: TIER.PRIMARY,
    });
    // antenna, swept back past the nape, on the whip leaf
    rig.add('head', loftHull([
      { y: 0, w: 0.015, d: 0.058, round: 0.34 },
      { y: 0.044, w: 0.011, d: 0.094, z: -FRONT * 0.038, round: 0.30, smooth: true },
      { y: 0.072, w: 0.005, d: 0.054, z: -FRONT * 0.088, round: 0.42 },
    ]), 'armorAccent', {
      p: [sign * 0.028, 0.090, -FRONT * 0.012], r: [20 * DEG, sign * -12 * DEG, sign * 18 * DEG],
      order: 'YXZ', mirror, tier: TIER.PRIMARY, sprung: `antenna_${side}`,
    });
  }
}

function headLantern(rig) {
  // NYX — the `vesper` sheet plus the lantern lens the roster asks for. A glossy
  // black egg with one gold ring at the brow and a single tall lens burning
  // through a slot in the face. At a hundred pixels this is a dark oval with a
  // bright vertical bar in it, which is the most legible face in the cast.
  //
  // The wide flat brim that used to define this head measured 0.328 m across on
  // a 0.343 m skull — NYX carried the largest head on the roster at 4.98
  // body-heights. The brim is now a ring ON the head, and the read it carried
  // (one hard horizontal line under a top key) survives as the ring's own
  // shadow.
  domeSkull(rig, { w: SKULL.w * 0.96, d: SKULL.d * 0.96 });
  rig.add('head', latheProfile([
    { r: 0.0660, y: 0 }, { r: 0.0705, y: 0.008, smooth: true }, { r: 0.0660, y: 0.016 },
  ], rig.maxTier >= 2 ? 24 : 13), 'trim', {
    p: [0, 0.046, 0], s: [1, 1, SKULL.d / SKULL.w], tier: TIER.PRIMARY,
  });

  // the lantern: a dark well sunk into the face with the core floating in it
  rig.add('head', channelStrip(0.030, 0.082, 0.020), 'bezel',
    { p: [0, 0.024, FRONT * 0.076], r: [FACE_FRONT[0] - 4 * DEG, 0, 0], tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([
    { r: 0, y: -0.030 }, { r: 0.014, y: -0.016 }, { r: 0.015, y: 0.014 }, { r: 0, y: 0.032 },
  ], 6, { faceted: true, phase: Math.PI / 6 }), 'core', { p: [0, 0.024, FRONT * 0.072] });
  for (const { sign, mirror } of SIDES) {
    rig.glow('head', loftHull([
      { y: -0.022, w: 0.006, d: 0.005, round: 0.5 },
      { y: 0.038, w: 0.005, d: 0.004, round: 0.5 },
    ]), 'visor', { p: [sign * 0.026, 0.018, FRONT * 0.068], r: [0, 0, sign * -10 * DEG], mirror });
  }

  // finial
  rig.add('head', latheProfile([
    { r: 0.018, y: 0 }, { r: 0.013, y: 0.012 }, { r: 0.007, y: 0.016 },
    { r: 0.007, y: 0.034 }, { r: 0, y: 0.044 },
  ], 12), 'armorAccent', { p: [0, 0.120, 0], tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.009, y: 0 }, { r: 0, y: 0.011 }], 10), 'spine',
    { p: [0, 0.158, 0] });
}

function headBunker(rig) {
  // BASTION — the `paladin` sheet. A tall narrow knight's helm with one upright
  // fin crest running brow to nape, a narrow slit under a heavy brow, and cheek
  // plates dropping to the jaw line. The fin is the whole silhouette: it is what
  // stops a smooth helm reading as a thumb.
  //
  // What this replaces was a wide low vault — 0.348 m across against 0.179 m
  // tall, a w/h of 1.94 where a head wants about 0.7. It measured 10.95
  // body-heights on HEIGHT while reading as a brick from every angle the fight
  // camera actually uses, which is exactly the trap §2.4 is describing.
  helmSkull(rig, {
    w: SKULL.w * 0.90, d: SKULL.d * 1.00, nose: 0.012, band: 0.56, bandArc: 156, bandMat: 'trim',
  });
  addVisor(rig, { w: 0.086, h: 0.011, y: 0.030, z: FRONT * 0.090, tilt: -3 * DEG, brow: 0.020, posts: false });

  // The crest: a standing blade swept on the helm's own curve, so it clears the
  // shell by a centimetre and a half along its whole length instead of only at
  // the tip. Authored as a straight loft it sat inside the bowl for two thirds
  // of its run and BASTION photographed with no crest at all.
  const crest = { p: [0, 0.058, 0], r: [0, 0, 90 * DEG], tier: TIER.PRIMARY };
  rig.add('head', shellLathe([
    { r: 0.104, y: -0.010 }, { r: 0.110, y: 0, smooth: true }, { r: 0.104, y: 0.010 },
  ], 0.016, rig.maxTier >= 2 ? 16 : 10, { arc: 128 * DEG, phase: -56 * DEG }), 'armorAccent', crest);
  rig.glow('head', shellLathe([
    { r: 0.1115, y: -0.0030 }, { r: 0.1125, y: 0, smooth: true }, { r: 0.1115, y: 0.0030 },
  ], 0.005, rig.maxTier >= 2 ? 14 : 9, { arc: 108 * DEG, phase: -46 * DEG }), 'spine',
  { ...crest, tier: TIER.SECONDARY });

  // nape guard, closing the back of the helm down onto the riser. 270 degrees is
  // -Z in the lathe's frame, so the arc is centred on the back of the head.
  rig.add('head', shellLathe([
    { r: 0.056, y: -0.034 }, { r: 0.064, y: -0.004, smooth: true }, { r: 0.055, y: 0.028 },
  ], 0.009, rig.maxTier >= 2 ? 14 : 9, { arc: 132 * DEG, phase: 204 * DEG }), 'armorSecondary', {
    p: [0, 0.010, 0], s: [1, 1, SKULL.d / SKULL.w], tier: TIER.PRIMARY,
  });
}

function headMono(rig) {
  // AXIOM — the `volt-monk` sheet. One smooth ovoid, one equator seam, one
  // temple lens and a column of three indicator dots on the brow. It is the only
  // head in the cast with no protrusion of any kind, and at silhouette size the
  // absence of a crest reads as loudly as a crest does.
  domeSkull(rig, { w: SKULL.w * 0.94, d: SKULL.d * 1.00 });

  // equator seam: the whole panel story on this skull, and enough of it. A
  // machined split with a rolled lip either side is what says the helmet opens,
  // which is all the incident a clean form is allowed.
  rig.add('head', latheProfile([
    { r: 0.0645, y: 0 }, { r: 0.0675, y: 0.005, smooth: true },
    { r: 0.0675, y: 0.012 }, { r: 0.0645, y: 0.017 },
  ], rig.maxTier >= 2 ? 24 : 13), 'trim', {
    p: [0, 0.026, 0], s: [1, 1, SKULL.d / (SKULL.w * 0.94)], tier: TIER.SECONDARY,
  });

  // the temple lens — off centre, which is what makes this head a face rather
  // than an egg, and the single most copied feature on the sheet
  addLens(rig, { p: [0.052, 0.048, FRONT * 0.048], tilt: -6 * DEG, yaw: 62 * DEG, r: 0.017, ring: 'trim' });
  for (let i = 0; i < 3; i++) {
    rig.glow('head', latheProfile([
      { r: 0, y: 0 }, { r: 0.0055, y: 0 }, { r: 0, y: 0.005 },
    ], 8), 'visor', { p: [-0.020, 0.070 - i * 0.016, FRONT * 0.078], r: FACE_FRONT });
  }
  rig.decal('head', MARKINGS.BARCODE, 0.048, 0.022,
    { p: [0, 0.010, -FRONT * 0.082], r: [0, YAW_BACK, 0], tier: TIER.GREEBLE });
}

function headInsulator(rig) {
  // VOLTA — the `aegis-01` sheet. A rounded helm with a broad accent strip
  // across the brow, a narrow arc-white slit, and a cylindrical bushing over
  // each ear; the sheet's head is a helmet with a hub on the side of it. The two
  // ceramic sheds on the crown are what keeps VOLTA's own insulator identity on
  // top of that.
  //
  // The stack used to be three sheds up to 0.104 m in radius standing clear
  // above the skull. A bushing column is a good shape, but that was a hat: it
  // put the head's widest and its highest geometry somewhere a head has neither.
  // A crown 40 mm lower than the canon: the sheds have to stand ON the helm,
  // and at the full height they were four millimetres proud of a bowl that was
  // still widening under them — invisible from every angle.
  helmSkull(rig, {
    w: SKULL.w * 0.98, d: SKULL.d * 0.94, crown: HEAD_CROWN - 0.040, band: 0.50,
    bandArc: 184, bandMat: 'armorAccent',
  });
  addVisor(rig, { w: 0.098, h: 0.012, y: 0.014, z: FRONT * 0.074, brow: 0.016, posts: false });

  for (let i = 0; i < 2; i++) {
    const r = 0.056 - i * 0.014;
    rig.add('head', discShed(r, 0.015, rig.maxTier >= 2 ? 20 : 12), i % 2 ? 'trim' : 'armorSecondary',
      { p: [0, 0.112 + i * 0.022, 0], tier: TIER.PRIMARY });
    rig.add('head', latheProfile([
      { r: r * 0.42, y: 0 }, { r: r * 0.42, y: 0.011 },
    ], 12), 'darkMetal', { p: [0, 0.127 + i * 0.022, 0], tier: TIER.SECONDARY });
  }
  // arc terminal
  rig.add('head', latheProfile([
    { r: 0, y: 0 }, { r: 0.017, y: 0 }, { r: 0.019, y: 0.007, smooth: true },
    { r: 0.013, y: 0.018 }, { r: 0, y: 0.020 },
  ], 14), 'trim', { p: [0, 0.152, 0], tier: TIER.PRIMARY });
  rig.glow('head', latheProfile([{ r: 0, y: 0 }, { r: 0.010, y: 0 }, { r: 0, y: 0.012 }], 10), 'core',
    { p: [0, 0.170, 0] });
  rig.emitter('arc', 'head', [0, 0.178, 0], [0, 1, 0], 0.03);

  // ear bushings, so the profile is not merely a helm
  for (const { sign, mirror } of SIDES) {
    rig.add('head', latheProfile([
      { r: 0, y: 0 }, { r: 0.023, y: 0 }, { r: 0.026, y: 0.007, smooth: true },
      { r: 0.026, y: 0.020 }, { r: 0.018, y: 0.026 }, { r: 0, y: 0.026 },
    ], rig.maxTier >= 2 ? 16 : 10), 'darkMetal', {
      p: [sign * 0.060, 0.020, -FRONT * 0.008], r: [0, 0, sign * -90 * DEG], mirror, tier: TIER.PRIMARY,
    });
  }
}

function headCrown(rig) {
  // SERAPH — the `ghostframe` sheet. A smooth pearl egg with a veil shell down
  // the face and a segmented halo standing off the nape. Domed plan: the sheet's
  // head has no jaw, no brow band and no horn, and the halo carries the whole
  // silhouette by itself.
  //
  // The four flared horns that used to sit on this crown ran to 0.23 m — longer
  // than the skull was tall, and the single biggest contributor to SERAPH's 6.06
  // body-heights per head. Two short crown points remain, kept because an arcane
  // frame with nothing at all on its head reads as AXIOM.
  domeSkull(rig, { w: SKULL.w * 0.92, d: SKULL.d * 0.98 });

  // veil: a shallow trim shell over the face. Scaled in Z by the egg's own
  // width-to-depth ratio, which is what makes a swept arc follow an ovoid rather
  // than cut into it at the temples and float at the nose.
  rig.add('head', shellLathe([
    { r: 0.020, y: -0.048 }, { r: 0.056, y: 0.004, smooth: true },
    { r: 0.066, y: 0.056, smooth: true }, { r: 0.061, y: 0.094 },
  ], 0.007, rig.maxTier >= 2 ? 16 : 10, { arc: 128 * DEG, phase: 26 * DEG }), 'trim', {
    s: [1, 1, (SKULL.d * 0.98) / (SKULL.w * 0.92)], tier: TIER.PRIMARY,
  });
  addVisor(rig, { w: 0.078, h: 0.011, y: 0.044, z: FRONT * 0.082, brow: 0.016, posts: false });

  // forehead crystal
  rig.glow('head', latheProfile([
    { r: 0, y: -0.022 }, { r: 0.014, y: -0.006 }, { r: 0.015, y: 0.004 }, { r: 0, y: 0.026 },
  ], 6, { faceted: true, phase: Math.PI / 6 }), 'core',
  { p: [0, 0.090, FRONT * 0.052], r: [-70 * DEG * -FRONT, 0, 0] });

  // crown points
  for (const { s: side, sign, mirror } of SIDES) {
    rig.add('head', loftHull([
      { y: 0, w: 0.018, d: 0.024, round: 0.36 },
      { y: 0.042, w: 0.012, d: 0.016, z: -FRONT * 0.012, round: 0.40, smooth: true },
      { y: 0.074, w: 0.005, d: 0.007, z: -FRONT * 0.028, round: 0.46 },
    ]), 'armorAccent', {
      p: [sign * 0.036, 0.094, -FRONT * 0.012], r: [26 * DEG, 0, sign * 26 * DEG],
      mirror, tier: TIER.PRIMARY, sprung: `antenna_${side}`,
    });
  }

  // halo: a segmented ring standing off the nape, tilted so it reads as a disc
  // from the front and as a line in profile
  const R = 0.092;
  rig.add('head', segmentRing(R, 0.015, 0.012, rig.maxTier >= 2 ? 16 : 10, 0.003), 'trim',
    { p: [0, 0.062, -FRONT * 0.080], r: [16 * DEG, 0, 0], tier: TIER.PRIMARY });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.5;
    rig.glow('head', bevelBox(0.024, 0.008, 0.007, 0.002), 'spine', {
      p: [Math.cos(a) * R, 0.062 + Math.sin(a) * R, -FRONT * 0.072], r: [16 * DEG, 0, a + Math.PI / 2],
    });
  }
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

/**
 * One articulated digit: a chain of tapered capsules with a dark hinge barrel in
 * the gap between them, the whole chain rigid to a SINGLE bone.
 *
 * The skeleton has one `fingers_*` bone per hand and one `thumb_*`, not fifteen,
 * and that is not negotiable — every clip in the game is authored against the
 * current bone list, so adding phalanges would invalidate all of them. It is
 * also much less of a limitation than it sounds. A hand curls its four fingers
 * as a unit; four rigid chains posed in a half-fist on the one bone read exactly
 * as a fist reads, and what the reference's hand tiles are actually selling —
 * three visible segments per finger, a dark joint between them, and daylight
 * between the fingers — survives being rigid intact.
 *
 * The chain is WALKED rather than authored: each segment is placed at a running
 * cursor, rotated onto a running curl angle, and the cursor advanced along that
 * segment's own axis. So `segs` and `curl` describe an anatomy, and changing one
 * number does not require re-deriving the offsets of everything after it — which
 * is exactly the mistake the four hand-placed knuckle studs this replaces made.
 *
 * @param {Rig} rig
 * @param {string} bone the one bone the whole digit binds to
 * @param {Object} o
 *   `base` chain origin in bone-local metres, x already multiplied by `sign`;
 *   `segs` segment lengths, proximal first; `curl` per-segment turn toward the
 *   fighter's front, in radians, applied cumulatively; `r0`/`r1` segment
 *   half-width at the base and at the tip; `splay` fan angle about the bone's Z,
 *   already multiplied by `sign`; `deep` depth as a multiple of width; `gap`
 *   fraction of each segment given over to the hinge; `mat` shell material.
 */
function digit(rig, bone, o) {
  const segs = o.segs;
  const n = segs.length;
  const splay = o.splay ?? 0;
  const deep = o.deep ?? 0.94;
  const gap = o.gap ?? 0.17;
  const cs = Math.cos(splay), ss = Math.sin(splay);
  const hingeSeg = rig.maxTier >= 2 ? 10 : 8;
  let [px, py, pz] = o.base;
  let ang = 0;
  for (let i = 0; i < n; i++) {
    ang += o.curl[i];
    const L = segs[i];
    // `frame()` composes Rx * Ry * Rz, so a part placed with
    // r = [PI - curl, 0, splay] carries its own +Y onto
    // (-sin splay, -cos splay * cos curl, cos splay * sin curl): straight down
    // the hand at curl 0, swinging toward the fighter's front as the hand
    // closes. Both the splay and the base x arrive pre-signed, which is what
    // makes the right hand come out as the left hand's mirror rather than as a
    // copy of it — `add`'s MIRROR_X reflects the geometry, not the placement.
    const rot = [Math.PI - ang * FRONT, 0, splay];
    const dx = -ss, dy = -cs * Math.cos(ang), dz = cs * Math.sin(ang) * FRONT;
    const rA = o.r0 + (o.r1 - o.r0) * (i / n);
    const rB = o.r0 + (o.r1 - o.r0) * ((i + 1) / n);
    const body = L * (1 - gap);
    rig.add(bone, loftHull([
      { y: 0, w: rA * 2, d: rA * 2 * deep, round: 0.94 },
      { y: body * 0.44, w: rA + rB, d: (rA + rB) * deep, round: 0.96, smooth: true },
      { y: body, w: rB * 2, d: rB * 2 * deep, round: 0.94 },
    ], { perQuad: rig.maxTier >= 2 ? 3 : 2 }), o.mat, {
      p: [px, py, pz], r: rot, mirror: o.mirror, tier: TIER.PRIMARY,
      // A phalanx is one pressing with a free rim all the way round. Calling it
      // a band would butt it against its neighbour and fill the very gap the
      // digit exists to show.
      role: 'lame',
    });
    // The hinge is PRIMARY, not decoration: it is the structure that stops the
    // gap between two capsules being a hole you can see the background through
    // at LOD1, and it is the dark knuckle break §1.3 asks for. Authored about
    // its own Y and rolled a quarter turn so the barrel lies across the digit.
    if (i < n - 1) {
      const rh = rB * 0.66, hh = rB * deep * 0.94;
      const h = latheProfile([
        { r: 0, y: -hh }, { r: rh, y: -hh }, { r: rh, y: hh }, { r: 0, y: hh },
      ], hingeSeg);
      h.rotateZ(Math.PI * 0.5);
      h.translate(0, body + L * gap * 0.5, 0);
      rig.add(bone, h, o.hingeMat ?? 'darkMetal',
        { p: [px, py, pz], r: rot, mirror: o.mirror, tier: TIER.PRIMARY, role: 'frame' });
    }
    px += dx * L; py += dy * L; pz += dz * L;
  }
  return rig;
}

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

  const shellSeg = rig.maxTier >= 2 ? 16 : 10;

  // Nominal (k = 1) cross-sections. Everything below is a multiple of these
  // through LIMB_PROFILES rather than a pair of end literals, which is what
  // stops the arm being a constant-width prism: the elbow comes out at 0.62 of
  // the deltoid and the wrist at 0.55 of the brachioradialis.
  const upperW = upper * 1.46;
  const foreW = fore * 1.50;

  // --- shoulder: boot, bezel disc and pilot light on the hinge axis. The disc
  // seats at 0.80 of the upper arm's nominal width — i.e. on the OUTER SURFACE
  // of the deltoid, not 0.30 of the way in where the old barrel's end cap was
  // and where nothing is ever visible.
  rig.bezel(`shoulder_${S}`, {
    radius: upper * 0.48, face: upper * 1.00, boot: upper * 0.86, half: upper * 0.30,
    sign, mirror, p: [sign * 0.012, 0, 0],
  });
  rig.glow(`shoulder_${S}`, latheProfile([
    { r: 0, y: 0 }, { r: upper * 0.10, y: 0 }, { r: upper * 0.086, y: 0.008 }, { r: 0, y: 0.010 },
  ], 14), 'joints', {
    world: true, p: [sign * (0.012 + upper * 1.078), 0, 0], r: [0, 0, sign * -90 * DEG], mirror,
  });

  // Deltoid shell, on the shoulder so it swings with the arm. It wraps 232° and
  // sits proud of the upper-arm shells below it rather than running their whole
  // length: on every reference sheet the deltoid cap floats CLEAR of the armpit
  // and the dark core shows in the gap it leaves.
  rig.add(`shoulder_${S}`, shellLathe([
    { r: upper * 0.80, y: -uLen * 0.34 },
    { r: upper * 0.94, y: -uLen * 0.12, smooth: true },
    { r: upper * 0.96, y: upper * 0.06, smooth: true },
    { r: upper * 0.84, y: upper * 0.30 },
  ], upper * 0.17, shellSeg, { arc: 232 * DEG, phase: -116 * DEG }),
  'armorSecondary', { mirror, tier: TIER.PRIMARY });

  // --- upper arm: deltoid ball at the top, necking to a narrow elbow, with the
  // painted shells covering the outer arc only.
  rig.limb(`shoulder_${S}`, {
    kind: 'upperArm', w: upperW, deep: 1.02,
    y0: -uLen * 0.90, y1: upper * 0.40,
    mat: 'armorPrimary', bands: 2, gap: 0.075,
    // Gap centred on 174°, i.e. just forward of straight medial: that is where
    // the inner-elbow crease opens and where the underskin most needs to show.
    arc: 228 * DEG, phase: -6 * DEG, mirror,
  });
  // Collar ring where the upper arm necks into the elbow barrel. It reads as the
  // clamp holding the two shells on, and it is the only trim on the segment.
  rig.add(`shoulder_${S}`, latheProfile([
    { r: upper * 0.52, y: 0 }, { r: upper * 0.60, y: 0.012, smooth: true }, { r: upper * 0.60, y: 0.03 },
    { r: upper * 0.52, y: 0.042 },
  ], 20), 'trim', { p: [0, -uLen * 0.80, 0], mirror, tier: TIER.SECONDARY });

  // --- elbow: bezel on the hinge axis plus a floating cap plate that overlaps
  // the segment ABOVE it (§1.4). The old cap was a bevelBox and it was one of
  // the four boxes that made the arm read as orthogonal from every angle.
  const elbowR = Math.max(fore, upper) * 0.80;
  // The forearm's own half-width at the elbow station is 0.44 of `foreW`; the
  // disc seats just outside it and the boot barrel beats the half-DEPTH.
  rig.bezel(`elbow_${S}`, {
    radius: elbowR * 0.42, face: elbowR * 1.26, boot: elbowR, half: elbowR * 0.44,
    sign, mirror,
  });
  rig.add(`elbow_${S}`, shellLathe([
    { r: elbowR * 0.80, y: -fore * 0.62 },
    { r: elbowR * 1.10, y: -fore * 0.24, smooth: true },
    { r: elbowR * 1.06, y: fore * 0.30, smooth: true },
    { r: elbowR * 0.74, y: fore * 0.62 },
    // Centred on the back of the joint (-Z is 270°), which is where an olecranon
    // guard belongs and where elbow flexion carries it clear of the upper arm.
  ], elbowR * 0.15, shellSeg, { arc: 140 * DEG, phase: -160 * DEG }),
  'armorSecondary', { mirror, tier: TIER.PRIMARY });

  // --- forearm: widest a third of the way down from the elbow, necking hard to
  // the wrist. The old authoring had `w0` (the cuff end) EXCEED `w1` (the elbow
  // end) as soon as `gauntlet` passed ~0.15, so every heavy in the cast had a
  // forearm that grew toward the hand.
  rig.limb(`elbow_${S}`, {
    kind: 'forearm', w: foreW, deep: 1.12,
    y0: -fLen * 0.90, y1: fore * 0.34,
    mat: 'armorPrimary', bands: 2, gap: 0.07,
    arc: 236 * DEG, phase: 8 * DEG, mirror,
  });
  // forearm panel with fasteners, bedded onto the front of the outer shell
  rig.add(`elbow_${S}`, bevelBox(fore * 0.66, fLen * 0.42, 0.012, 0.005), 'carbon',
    { p: [0, -fLen * 0.44, FRONT * fore * 0.72], mirror, tier: TIER.SECONDARY });
  rig.add(`elbow_${S}`, boltRing(4, fore * 0.42, 0.007, 0.009), 'trim',
    { p: [0, -fLen * 0.44, FRONT * (fore * 0.74)], r: FACE_FRONT, mirror, tier: TIER.GREEBLE });
  addPanelDetail(rig, `elbow_${S}`, {
    p: [0, -fLen * 0.44, FRONT * (fore * 0.72 + 0.004)], r: [0, YAW_FRONT, 0],
    w: fore * 0.72, h: fLen * 0.52, bolts: 3, splitsY: [0.20], splitsX: [], mirror,
  });
  addPipeRun(rig, `elbow_${S}`, [
    [sign * fore * 0.64, -0.03, -FRONT * fore * 0.50],
    [sign * fore * 0.78, -0.13, -FRONT * fore * 0.36],
    [sign * fore * 0.68, -0.23, -FRONT * fore * 0.18],
  ], { radius: 0.008, mirror });
  rig.decal(`elbow_${S}`, MARKINGS.SERIAL, fore * 1.1, fore * 1.1, {
    p: [sign * fore * 0.68, -fLen * 0.45, 0], r: [0, sign * 90 * DEG, 0], mirror, tier: TIER.GREEBLE,
  });

  // --- wrist: the cuff boot over the necked wrist, and the polished bracelet
  // that is this joint's share of §1.4. Every hand close-up in the reference has
  // one and it is always wider than the wrist inside it.
  const wristW = foreW * LIMB_PROFILES.forearm[0][1];
  const cuffW = wristW * (1.10 + gaunt * 0.20);
  rig.add(`wrist_${S}`, latheProfile([
    { r: cuffW * 0.50, y: m.palm * 0.34 }, { r: cuffW * 0.56, y: m.palm * 0.14, smooth: true },
    { r: cuffW * 0.56, y: -m.palm * 0.28 }, { r: cuffW * 0.46, y: -m.palm * 0.44 },
  ], 20), 'gasket', { mirror, tier: TIER.PRIMARY });
  rig.add(`wrist_${S}`, latheProfile([
    { r: cuffW * 0.52, y: m.palm * 0.30 }, { r: cuffW * 0.70, y: m.palm * 0.22, smooth: true },
    { r: cuffW * 0.70, y: m.palm * 0.02 }, { r: cuffW * 0.52, y: -m.palm * 0.06 },
  ], 20), 'trim', { mirror, tier: TIER.PRIMARY });
  rig.glow(`wrist_${S}`, latheProfile([
    { r: cuffW * 0.51, y: 0 }, { r: cuffW * 0.54, y: 0.003 }, { r: cuffW * 0.54, y: 0.009 }, { r: cuffW * 0.51, y: 0.012 },
  ], 20), 'joints', { p: [0, -0.006, 0], mirror });

  // --- hand: a palm, a bright knuckle bar, four three-segment fingers and an
  // opposed thumb. What was here was two lofted blocks and four stud caps — a
  // mitten, and the single most obvious tell in `03-full-body.jpg` that these
  // are procedural robots rather than characters. Five of the eight reference
  // sheets give the hand a whole close-up tile; it is a hero element.
  //
  // `hw` is the palm width and everything else is a fraction of it. The old
  // factor put the finished hand at 0.57–1.39 head widths against a contract
  // that asks for about one, and the heavies were the worst of it because
  // `gauntlet` scaled the block twice as hard as the forearm it hangs off.
  // 1.02 + 0.30 gaunt keeps a brute's fist visibly heavier without letting it
  // become a boxing glove on the end of a wrist that now necks to 0.55.
  const hw = fore * (1.02 + gaunt * 0.30);
  // Palm: widest at the knuckle line and thinner front-to-back than it is
  // across, because that is the one proportion that separates a hand from a
  // mitten before any finger is drawn. It reaches up to `m.palm * 0.60` so the
  // wrist cuff above still overlaps it and no daylight opens at the joint.
  rig.add(`hand_${S}`, loftHull([
    { y: m.palm * 0.60, w: hw * 0.74, d: hw * 0.58, round: 0.62 },
    { y: -m.grip * 0.08, w: hw * 1.00, d: hw * 0.70, round: 0.58, smooth: true },
    { y: -m.grip * 0.60, w: hw * 0.94, d: hw * 0.64, round: 0.54 },
  ]), 'armorPrimary', { mirror, tier: TIER.PRIMARY, role: 'shell' });
  // Knuckle bar. §1.5: "the knuckle row is a hard bright edge" — so it is trim,
  // it spans the full palm width, and it sits on `hand_*` rather than on
  // `fingers_*` because the metacarpal heads are the PIVOT the fingers turn
  // about, not part of what turns.
  rig.add(`hand_${S}`, loftHull([
    { y: -m.grip * 0.66, w: hw * 0.98, d: hw * 0.60, round: 0.66 },
    { y: -m.grip * 0.90, w: hw * 1.02, d: hw * 0.66, round: 0.78, smooth: true },
    { y: -m.grip * 1.06, w: hw * 0.92, d: hw * 0.58, round: 0.80 },
  ]), 'trim', { mirror, tier: TIER.PRIMARY, role: 'shell' });
  // Four fingers on the one `fingers_*` bone, curled 95° in total across three
  // segments. A tighter curl reads as a fist from the front and as nothing at
  // all from the side; 95° leaves every segment break visible in profile, which
  // is where the fight camera spends most of a round.
  //
  // The four are deliberately NOT identical: the outer two are shorter and fan
  // outward. A row of four matched sticks reads as a comb, and the reference's
  // hands never do.
  const fl = m.grip * 1.15;
  const FINGERS = [
    { x: 0.352, len: 0.98, splay: -6 },
    { x: 0.117, len: 1.06, splay: -2 },
    { x: -0.117, len: 1.00, splay: 2 },
    { x: -0.352, len: 0.86, splay: 6 },
  ];
  for (const f of FINGERS) {
    const L = fl * f.len;
    digit(rig, `fingers_${S}`, {
      base: [sign * hw * f.x, m.grip * 0.06, FRONT * hw * 0.06],
      segs: [L * 0.42, L * 0.33, L * 0.25],
      curl: [30 * DEG, 38 * DEG, 27 * DEG],
      r0: hw * 0.114, r1: hw * 0.086,
      splay: sign * f.splay * DEG,
      mat: 'armorSecondary', mirror,
    });
  }
  // Opposed thumb on its own bone, two segments, swung out of the palm plane by
  // 38° so it reads as opposed from every angle instead of as a fifth finger.
  digit(rig, `thumb_${S}`, {
    base: [0, 0, 0],
    segs: [fl * 0.52, fl * 0.40],
    curl: [26 * DEG, 40 * DEG],
    r0: hw * 0.118, r1: hw * 0.086,
    splay: sign * -24 * DEG,
    mat: 'armorSecondary', mirror,
  });

  if (gaunt > 0.9) {
    // Siege gauntlet: a flared cuff shell over the wrist. It used to be a
    // bevelBox, which put a rectangular prism back onto the one arm in the cast
    // that most needed to read as heavy rather than as boxy — so it is now the
    // same wrapped shell as the segment it sits on, just flared toward the fist
    // and left open on the inner face like everything else. Width is capped well
    // short of `gaunt` scaling linearly, or a brute swings a billboard.
    const gw = fore * (1.22 + gaunt * 0.40);
    rig.add(`elbow_${S}`, shellLathe([
      { r: gw * 0.52, y: -fLen * 1.02 },
      { r: gw * 0.64, y: -fLen * 0.90, smooth: true },
      { r: gw * 0.62, y: -fLen * 0.64, smooth: true },
      { r: gw * 0.44, y: -fLen * 0.46 },
    ], gw * 0.11, shellSeg, { arc: 236 * DEG, phase: -118 * DEG }), 'armorAccent',
    { mirror, tier: TIER.PRIMARY });
    addPanelDetail(rig, `elbow_${S}`, {
      p: [0, -fLen * 0.78, FRONT * (gw * 0.58 + 0.004)], r: [0, YAW_FRONT, 0],
      w: gw * 0.62, h: fLen * 0.34, bolts: 3, splitsY: [0.2], splitsX: [], mirror,
    });
    addPanelDetail(rig, `elbow_${S}`, {
      p: [sign * (gw * 0.58 + 0.004), -fLen * 0.78, 0], r: [0, sign * 90 * DEG, 0],
      w: gw * 0.62, h: fLen * 0.34, bolts: 3, splitsY: [0.2], splitsX: [], mirror,
    });
    rig.add(`elbow_${S}`, boltRing(8, gw * 0.46, 0.009, 0.011), 'trim',
      { p: [0, -fLen * 1.00, 0], r: [180 * DEG, 0, 0], mirror, tier: TIER.GREEBLE });
    // knuckle-duster ridge along the striking face, following the flare
    for (let i = -1; i <= 1; i++) {
      rig.add(`elbow_${S}`, bevelBox(gw * 0.20, 0.05, gw * 0.22, 0.006, { topX: 0.5, topZ: 0.5 }), 'trim',
        { p: [i * gw * 0.26, -fLen * 0.60, FRONT * gw * 0.56], r: [-14 * DEG, 0, 0], mirror, tier: TIER.SECONDARY });
    }
    rig.glow(`elbow_${S}`, bevelBox(gw * 0.58, 0.014, 0.012, 0.004), 'vents',
      { p: [0, -fLen * 0.70, FRONT * (gw * 0.58 + 0.004)], mirror });
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
  // belt frog the two sheaths pass through — a real one is thick moulded
  // leather, not polished steel like the tsuba and lacquered sheath either
  // side of it; ZONE 2 (matte composite) is what keeps it from taking the
  // same mirror highlight as the hardware it is holding.
  rig.add('hips', bevelBox(t.pelvisW * 0.86, 0.046, 0.058, 0.008), 'gasket',
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
    // See BOOT_TRIM: the chassis numbers were authored for a three-box boot and
    // produced a footprint half the length of the leg it hangs off.
    foot: Lsrc.foot * m.legS * bootTrim(Lsrc.plan),
    footW: Math.min(Lsrc.footW * m.legK, m.hipSep * 0.86) * BOOT_WIDTH_TRIM,
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
  const shellSeg = rig.maxTier >= 2 ? 16 : 10;
  const thighW = Math.min(L.thigh * (piston ? 1.62 : 1.40), m.hipSep * (piston ? 1.30 : 1.16));
  const kneeW = Math.min(L.shin * (piston ? 1.06 : 1.30), m.hipSep * 0.90);
  // Nominal shank width, chosen so the anatomy curve's knee station (k = 0.92)
  // lands exactly on `kneeW` and the two lower-leg plans still meet the same
  // knee barrel.
  const shankW = kneeW / 0.92;
  // The ankle used to be a flat 0.78 of the knee, which is a tube, not an
  // ankle. The contract puts it at 0.35–0.55 of a head against a 0.9–1.5 head
  // thigh; sizing it off the shank's own narrowest station gets there and keeps
  // the boot collar sleeving the shin rather than floating around it.
  const ankleW = digi ? kneeW * 0.62 : shankW * 0.60;

  // --- thigh: the widest mass on the body, belly just below the hip, necking to
  // a knee narrow enough that the barrel reads as a hinge.
  rig.limb(`hip_${S}`, {
    kind: 'thigh', w: thighW, deep: 1.26,
    y0: -tLen * (piston ? 0.72 : 0.90), y1: L.thigh * 0.42,
    mat: 'armorPrimary', bands: piston ? 1 : 2, gap: 0.075,
    // Wrap centred between outer and front, so the gap opens on the back-inner
    // quadrant — the inner thigh and the back of the knee, which is exactly
    // where §1.3 puts the underskin.
    arc: 226 * DEG, phase: 30 * DEG,
    r: [0, 0, sign * (splay ? 4 : 2) * DEG], mirror,
  });
  // The outer thigh used to carry a 26 mm carbon slab standing off a flat face.
  // On an ovoid its corners lift 17 mm clear of the shell and it reads as a
  // plate hovering beside the leg, so it is gone: the shell's own curvature and
  // the panel strips below do the breakup, and the triangles pay for the ribs.
  rig.add(`hip_${S}`, channelStrip(L.thigh * 0.24, tLen * 0.56, 0.011), 'darkMetal',
    { p: [0, -tLen * 0.40, FRONT * L.thigh * 0.66], r: FACE_FRONT, mirror, tier: TIER.SECONDARY });
  addPanelDetail(rig, `hip_${S}`, {
    p: [sign * (L.thigh * 0.50), -tLen * 0.40, 0], r: [0, sign * 90 * DEG, 0],
    w: L.thigh * 0.54, h: tLen * 0.48, bolts: 4, mirror,
  });
  rig.decal(`hip_${S}`, MARKINGS.ARROW, L.thigh * 0.7, L.thigh * 0.7, {
    p: [sign * L.thigh * 0.54, -tLen * 0.6, 0], r: [0, sign * 90 * DEG, 0], mirror, tier: TIER.GREEBLE,
  });
  // hip collar — the boot the bezel below sits on, so the bezel brings only the
  // disc and the hub
  rig.add(`hip_${S}`, latheProfile([
    { r: thighW * 0.50, y: L.thigh * 0.20 }, { r: thighW * 0.56, y: 0.0, smooth: true },
    { r: thighW * 0.56, y: -L.thigh * 0.20 }, { r: thighW * 0.48, y: -L.thigh * 0.32 },
  ], 20), 'gasket', { mirror, tier: TIER.PRIMARY });
  // The hip is the one major joint that had no disc at all — only the gasket
  // collar, which stays and serves as its boot. Seating face is the thigh's own
  // half-width at the hip station (0.94 of `thighW`, halved).
  rig.bezel(`hip_${S}`, {
    radius: thighW * 0.30, face: thighW * 0.62, sign, mirror,
  });

  // --- knee assembly (knee_L is the SHIN bone; the cap rides with the shin).
  // The barrel is wider than either plate it joins, so the seam always reads as
  // a hinge rather than a hole, through the whole flexion range.
  const kneeR = Math.max(thighW, kneeW) * 0.60;
  rig.bezel(`knee_${S}`, {
    radius: kneeW * 0.32, face: kneeW * 0.70, boot: kneeR, half: kneeW * 0.34,
    sign, mirror,
  });
  // Floating knee cap. This was a bevelBox and it was the single most visible
  // flat facet on the lower body; §1.4 asks for a cap plate that OVERLAPS the
  // segment above, which a box bolted to the shin cannot do.
  //
  // Its radius is sized off the SHIN, not off `kneeR` (which follows the thigh):
  // a cap struck at thigh radius wraps 1.75 shin half-widths around the joint
  // and swallows the bezel disc from every three-quarter angle, which the
  // proud/buried census caught.
  const capR = kneeW * 0.63;
  rig.add(`knee_${S}`, shellLathe([
    { r: capR * 0.80, y: -L.shin * 0.72 },
    { r: capR * 1.14, y: -L.shin * 0.28, smooth: true },
    { r: capR * 1.10, y: L.shin * 0.34, smooth: true },
    { r: capR * 0.76, y: L.shin * 0.72 },
  ], capR * 0.17, shellSeg, { arc: 124 * DEG, phase: 28 * DEG }), 'armorAccent',
  { mirror, tier: TIER.PRIMARY });
  rig.glow(`knee_${S}`, bevelBox(L.shin * 0.55, 0.012, 0.010, 0.003), 'joints',
    { p: [0, -L.shin * 0.40, FRONT * (capR * 1.14 + 0.006)], mirror });

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
      // `round` was 0.42 here and 0.44 below, which is still four straight runs
      // with fillets. The two masses are already the right shapes; what they
      // were missing was an elliptical cross-section to swing them on.
      shearZ: -FRONT * 0.085, round: 0.74, swell: 0.10, mirror,
    });
    rig.section(`knee_${S}`, {
      y0: -sLen * 0.96, y1: -sLen * 0.40,
      w0: ankleW * 0.88, w1: kneeW * 0.74,
      d0: ankleW * 1.10, d1: kneeW * 0.96,
      mat: 'armorPrimary', z: FRONT * L.shin * 0.06,
      shearZ: FRONT * 0.075, round: 0.76, mirror,
    });
    // Achilles tendon: a bare cable-and-frame run down the back of the slim
    // section, which is what tells the eye the mass above it is a calf. The
    // rings on it are this leg plan's share of the §1.3 underskin — a smooth
    // dark bar reads as a strut, a ribbed one reads as mechanism.
    rig.add(`knee_${S}`, loftHull([
      { y: -sLen * 0.90, w: ankleW * 0.40, d: ankleW * 0.34, round: 0.80 },
      { y: -sLen * 0.44, w: ankleW * 0.46, d: ankleW * 0.40, round: 0.80 },
    ]), 'darkMetal', { p: [0, 0, -FRONT * L.shin * 0.34], mirror, tier: TIER.PRIMARY });
    rig.ribStack(`knee_${S}`, {
      count: 4, r0: ankleW * 0.24, r1: ankleW * 0.27,
      y0: -sLen * 0.84, y1: -sLen * 0.50, h: sLen * 0.018,
      p: [0, 0, -FRONT * L.shin * 0.34], deep: 0.86, mirror,
    });
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
      mat: 'armorPrimary', round: 0.78, swell: 0.06, mirror,
    });
    const cr = kneeW * 0.52;
    // The column's own underskin, in the free run between the first gland nut
    // (0.36) and the second (0.70).
    rig.ribStack(`knee_${S}`, {
      count: 3, r0: cr * 1.06, r1: cr * 1.04,
      y0: -sLen * 0.44, y1: -sLen * 0.58, h: sLen * 0.014, mirror,
    });
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
    // Calf belly high on the shank over a genuinely thin ankle. The old pair of
    // literals ran the ankle at 0.78 of the knee with a 0.08 swell — a slightly
    // dented tube, and the reason every plantigrade fighter stood on posts.
    rig.limb(`knee_${S}`, {
      kind: 'shank', w: shankW, deep: 1.20,
      y0: -sLen * 0.92, y1: L.shin * 0.44,
      mat: 'armorPrimary', bands: 2, gap: 0.07,
      arc: 232 * DEG, phase: 22 * DEG, mirror,
    });
    // calf vent stack, sitting on the shell rather than the old slab face
    addLouvres(rig, `knee_${S}`, {
      p: [0, -sLen * 0.42, -FRONT * (L.shin * 0.62)], r: [0, YAW_BACK, 0],
      w: L.shin * 0.66, h: sLen * 0.34, n: ventFins(spec, 0.6), depth: 0.016, mirror, glow: 'vents',
    });
    // The matching shin slab is gone for the same reason as the thigh's.
  }
  // Panel breakup belongs on a shin that has a shin plate. On a piston leg the
  // same call would bolt a fastener row onto empty air beside the ram.
  if (!piston) {
    addPanelDetail(rig, `knee_${S}`, {
      p: [0, -sLen * 0.46, FRONT * (L.shin * (digi ? 0.76 : 0.62) + 0.004)], r: [0, YAW_FRONT, 0],
      w: L.shin * 0.70, h: sLen * 0.44, bolts: 4, splitsY: [0.24], splitsX: [], mirror,
    });
  }
  rig.decal(`knee_${S}`, MARKINGS.RIVETS, L.shin * 1.1, L.shin * 0.28, {
    p: [0, -sLen * 0.16, FRONT * (L.shin * (piston ? 0.68 : 0.72))], r: [0, YAW_FRONT, 0], mirror, tier: TIER.GREEBLE,
  });

  // --- ankle
  // Radius stays under the ankle's height above the floor plane, or the joint
  // housing would clip through the ground on a flat-footed stance. It also has
  // to clear half the shank, or the bezel disappears inside the leg it is
  // supposed to hinge — which is what the old 0.44 factor did once the shank
  // stopped being a tube.
  const ankleR = Math.min(ankleW * 0.58, m.ankle * 0.78);
  rig.bezel(`ankle_${S}`, {
    radius: ankleW * 0.26, face: ankleW * 0.58, boot: ankleR, half: ankleW * 0.22,
    sign, mirror, p: [0, 0.006, 0],
  });

  // --- foot
  const fw = L.footW, fl = L.foot;
  // The boot plan's sole plane, in foot-bone-local metres. It is the depth the
  // rubber pad has always sat at, and it is quoted here rather than spelled out
  // per part because every mass in the boot branch below now bottoms out ON it,
  // with only the cleats going 2 mm under — exactly as before. That matters more
  // than it looks: `Fighter.#measureSole` learns how thick a boot is by taking
  // the lowest point of the BUILT mesh, so a boot rebuilt at a different depth
  // silently raises or lowers every stance in the game by the difference.
  // Measured across the roster after this rewrite, the largest move is 2.3 mm.
  // (The raptor and pad plans stand on their claws and their disc respectively,
  // both of which keep their own authored depths for the same reason.)
  const SOLE = -0.030;
  // The toe bone hangs `0.045 * legs` below the foot bone and sits `0.14 * legs`
  // ahead of it — both scaled by the roster, neither available as a literal. A
  // toe plate authored at a fixed local Y therefore lands on a different plane
  // for every fighter whose `legs` multiplier is not 1, and an instep authored
  // at a fixed depth leaves a slot you can see the floor through. Measure both
  // off the rest pose instead of assuming them.
  const toeDrop = (rig.restPos[`foot_${S}`]?.y ?? 0) - (rig.restPos[`toe_${S}`]?.y ?? 0);
  const toeFwd = Math.abs((rig.restPos[`toe_${S}`]?.z ?? 0) - (rig.restPos[`foot_${S}`]?.z ?? 0));
  const toeSole = SOLE + toeDrop;
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
    // Boot, in three parts: a heel block, an instep plate and separate toe
    // plates. That is the break §1.5 asks for, and it is precisely what the
    // single swept shell it replaces could not give — that shell was one deep
    // drawing running from the sole up into the ankle collar, and with a rubber
    // slab under it and a 1.28 width multiplier on top of an already generous
    // chassis number it read as a ski. Measured: 0.39–0.47 of hip-to-ankle,
    // 0.81 as wide as it was long.
    //
    // The instep's DEPTH is not a free number. The toe bone sits `toeFwd` ahead
    // of the foot bone whatever the boot does, so the instep has to reach it or
    // a slot opens between the two; `toeFwd + fl * 0.04` is that reach plus the
    // overlap the toe plates need to hide their own back edges.
    const instepD = toeFwd + fl * 0.04;
    const instepZ = FRONT * (toeFwd - fl * 0.36) * 0.5;
    rig.add(`foot_${S}`, loftHull([
      { y: SOLE, w: fw * 0.96, d: instepD * 0.92, round: 0.36 },
      { y: SOLE + 0.046, w: fw * 1.00, d: instepD, round: 0.42, smooth: true },
      { y: SOLE + 0.094, w: fw * 0.84, d: instepD * 0.80, z: -FRONT * fl * 0.05, round: 0.48, smooth: true },
      { y: SOLE + 0.126, w: fw * 0.62, d: instepD * 0.54, z: -FRONT * fl * 0.10, round: 0.52 },
      // A boot shell is one deep drawing: very few, very large panels and no
      // fastener anywhere a kerb could reach. It is also the part of the machine
      // that gets scuffed hardest, so its rim wants to read as ground metal.
    ]), 'armorPrimary', { p: [0, 0, instepZ], mirror, tier: TIER.PRIMARY, role: 'boot' });
    rig.add(`foot_${S}`, bevelBox(fw * 0.94, 0.016, instepD * 0.90, 0.005), 'rubber',
      { p: [0, SOLE + 0.008, instepZ], mirror, tier: TIER.PRIMARY });
    // Heel block, standing behind and above the instep and sweeping up into the
    // ankle. It is the counter of a boot, not a wedge under one, so it carries
    // its own sole pad and its own top surface.
    rig.add(`foot_${S}`, loftHull([
      { y: SOLE, w: fw * 0.86, d: fl * 0.40, round: 0.38 },
      { y: SOLE + 0.054, w: fw * 0.90, d: fl * 0.44, z: -FRONT * fl * 0.02, round: 0.44, smooth: true },
      { y: SOLE + 0.116, w: fw * 0.60, d: fl * 0.28, z: -FRONT * fl * 0.06, round: 0.52 },
    ]), 'armorSecondary', {
      p: [0, 0, -FRONT * fl * 0.34], mirror, tier: TIER.PRIMARY, role: 'boot',
    });
    rig.add(`foot_${S}`, bevelBox(fw * 0.84, 0.016, fl * 0.38, 0.005), 'rubber',
      { p: [0, SOLE + 0.008, -FRONT * fl * 0.34], mirror, tier: TIER.SECONDARY });
    // Three toe plates with real gaps between them, each with its own pad, so
    // the splits run all the way to the floor. This is the cheapest separation
    // anywhere on the model — three small lofts in place of one big one — and it
    // is the whole difference between a boot and a slipper at silhouette size.
    // The middle plate takes the accent so the break reads even in shadow.
    for (let i = -1; i <= 1; i++) {
      rig.add(`toe_${S}`, loftHull([
        { y: toeSole, w: fw * 0.26, d: fl * 0.50, round: 0.44 },
        { y: toeSole + 0.034, w: fw * 0.28, d: fl * 0.52, z: FRONT * fl * 0.01, round: 0.48, smooth: true },
        { y: toeSole + 0.062, w: fw * 0.19, d: fl * 0.34, z: FRONT * fl * 0.05, round: 0.54 },
      ]), i === 0 ? 'armorAccent' : 'armorPrimary', {
        p: [i * fw * 0.33, 0, FRONT * fl * 0.02], r: [0, i * -7 * DEG, 0], mirror,
        tier: TIER.PRIMARY, role: 'boot',
      });
      rig.add(`toe_${S}`, bevelBox(fw * 0.26, 0.014, fl * 0.48, 0.004), 'rubber',
        { p: [i * fw * 0.33, toeSole + 0.007, FRONT * fl * 0.02], mirror, tier: TIER.SECONDARY });
    }
    // Cleats, at the depth they have always been: 2 mm under the sole plane, so
    // the lowest point of the built mesh — which is what the runtime grounds the
    // fighter on — is exactly where it was before the boot was rebuilt.
    for (let i = 0; i < 2; i++) {
      rig.add(`foot_${S}`, bevelBox(fw * 0.86, 0.012, 0.020, 0.004), 'darkMetal',
        { p: [0, SOLE + 0.004, instepZ - FRONT * (instepD * 0.24 - i * instepD * 0.48)], mirror, tier: TIER.GREEBLE });
    }
    if (splay) {
      // Outriggers, one either side of the instep. 0.60 rather than the old
      // 0.72: the inboard one is thrown toward the fighter's centreline, and at
      // 0.72 of a boot width it crossed x = 0 in the rest pose — two of them,
      // one per foot, 14 mm apart and closing on any stance narrower than the
      // hip spacing.
      for (const o of [-1, 1]) {
        rig.add(`foot_${S}`, loftHull([
          { y: SOLE + 0.012, w: fw * 0.32, d: fl * 0.44, round: 0.38 },
          { y: SOLE + 0.046, w: fw * 0.28, d: fl * 0.40, round: 0.34, smooth: true },
          { y: SOLE + 0.072, w: fw * 0.17, d: fl * 0.25, round: 0.46 },
        ]), 'armorSecondary', {
          p: [o * fw * 0.60, 0, instepZ], r: [0, 0, o * 14 * DEG], mirror, tier: TIER.SECONDARY,
        });
      }
    }
  }
  rig.add(`ankle_${S}`, latheProfile([
    { r: ankleW * 0.44, y: 0.02 }, { r: ankleW * 0.50, y: 0.0, smooth: true }, { r: ankleW * 0.50, y: -0.028 },
    { r: ankleW * 0.41, y: -0.044 },
  ], 20), 'trim', { p: [0, -0.01, 0], mirror, tier: TIER.SECONDARY });
  rig.decal(`foot_${S}`, MARKINGS.HAZARD, fw * 0.8, 0.026, {
    p: [0, SOLE + 0.070, FRONT * (fl * 0.30 + toeFwd * 0.30)], r: [0, YAW_FRONT, 0], mirror, tier: TIER.GREEBLE,
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
  // Against the girdle's own station, not the raw chassis waist: the pelvis is
  // banded to what the legs will carry now (§1.2) and the two numbers no longer
  // agree, so a stencil placed on the old one lands inside the plate.
  rig.decal('hips', MARKINGS.LIFT, 0.075, 0.038, {
    p: [lift * t.pelvisW * 0.40, 0.028, back * (torsoStations(spec).pelvis.d * 0.5 + 0.008)],
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

  // 5. a partial belly guard over the abdominal stack, or a bare one
  //
  // These used to be trim ribs laid across a PAINTED abdomen at a literal
  // depth. The abdomen is now the exposed ring stack of §1.3 and it is a good
  // deal narrower than the raw chassis waist, so ribs authored against
  // `t.waistD` would hang in clear air in front of it. Read off the station and
  // turned into a stack of short cover lames instead: the fighters that draw
  // them show armour over mechanism at the waist, the ones that do not show all
  // mechanism, and both are readings the sheets contain.
  if (rng.next() < 0.55) {
    const V = torsoStations(spec);
    const lames = 2 + rng.int(2);
    for (let i = 0; i < lames; i++) {
      const f = i / Math.max(1, lames - 1);
      const w = V.waistLo.w + (V.waistHi.w - V.waistLo.w) * f;
      const d = V.waistLo.d + (V.waistHi.d - V.waistLo.d) * f;
      rig.add('spine01', loftHull([
        { y: -0.014, w: w * 0.50, d: 0.022, round: 0.42 },
        { y: 0.014, w: w * 0.54, d: 0.026, round: 0.38 },
      ]), 'armorSecondary', {
        p: [0, rig.dim.mid * (0.06 + i * 0.30), FRONT * (d * 0.40 + 0.012)],
        r: [(8 - i * 6) * DEG, 0, 0], tier: TIER.SECONDARY, role: 'lame',
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
    // Same trim as `buildLeg` applies, and for the same reason it lives at
    // module scope: the ankle ram and the ankle loom both anchor on the boot.
    foot: spec.legs.foot * m.legS * bootTrim(spec.legs.plan),
    footW: Math.min(spec.legs.footW * m.legK, m.hipSep * 0.80) * BOOT_WIDTH_TRIM,
  };
  const back = -FRONT; // +1 toward the robot's back in local Z terms
  const k = spec.bulk; // a brute's hydraulics are visibly fatter than a scout's

  // Every anchor below is a fraction of a measured segment, never a literal
  // metre value — a ram that does not follow its bone is a ram that floats.
  //
  // The limb-side fractions were tuned against constant-width prisms whose
  // surface sat at ~0.75 of the segment dimension everywhere. The limbs are now
  // anatomical ovoids that neck to 0.48–0.62 near the joints, so an anchor that
  // used to sit just proud of the armour ends up 4 cm out in clear air with its
  // clevis bracket hanging off nothing. Each one below has been re-solved
  // against the station the anchor's own y lands on.

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
      `shoulder_${s}`, [0, -m.upper * 0.55, back * a.upper * 0.74], { radius: 0.020 * k });
    // elbow
    rig.actuator(`shoulder_${s}`, [sign * a.upper * 0.34, -m.upper * 0.69, back * a.upper * 0.56],
      `elbow_${s}`, [sign * a.fore * 0.34, -m.fore * 0.31, back * a.fore * 0.62], { radius: 0.018 * k });
    // wrist
    rig.actuator(`elbow_${s}`, [sign * a.fore * 0.40, -m.fore * 0.63, back * a.fore * 0.46],
      `wrist_${s}`, [sign * a.fore * 0.34, 0.0, back * a.fore * 0.44], { radius: 0.012 * k, rodRatio: 0.5 });
    // hip
    rig.actuator('hips', [sign * t.pelvisW * 0.50, m.lumbar * 0.14, back * t.waistD * 0.44],
      `hip_${s}`, [sign * L.thigh * 0.64, -m.thigh * 0.34, back * L.thigh * 0.62], { radius: 0.022 * k });
    // knee
    // front-mounted so flexion EXTENDS it: the knee folds backwards, so a rear
    // ram would collapse into its own housing
    rig.actuator(`hip_${s}`, [sign * L.thigh * 0.60, -m.thigh * 0.57, -back * L.thigh * 0.60],
      `knee_${s}`, [sign * L.shin * 0.62, -m.shin * 0.31, -back * L.shin * 0.62], { radius: 0.022 * k });
    // ankle
    rig.actuator(`knee_${s}`, [sign * L.shin * 0.46, -m.shin * 0.64, back * L.shin * 0.56],
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
    rig.cable(`shoulder_${s}`, [sign * a.upper * 0.42, -m.upper * 0.76, back * a.upper * 0.50],
      `elbow_${s}`, [sign * a.fore * 0.5, -m.fore * 0.22, back * a.fore * 0.7], { sag: 0.022, radius: 0.0065 * k * fat, strands: braid });
    rig.cable('hips', [sign * t.pelvisW * 0.34, -0.02, back * t.waistD * 0.55],
      `hip_${s}`, [sign * L.thigh * 0.5, -m.thigh * 0.41, back * L.thigh * 0.72], { sag: 0.025, radius: 0.0072 * k * fat, strands: braid });
    if (loom >= 3) {
      rig.cable(`hip_${s}`, [sign * L.thigh * 0.48, -m.thigh * 0.68, back * L.thigh * 0.62],
        `knee_${s}`, [sign * L.shin * 0.50, -m.shin * 0.24, back * L.shin * 0.74], { sag: 0.022, radius: 0.0065 * k * fat, strands: braid });
    }
    if (loom >= 5) {
      rig.cable(`knee_${s}`, [sign * L.shin * 0.32, -m.shin * 0.79, back * L.shin * 0.40],
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
// Surface hardware
//
// WHY THIS EXISTS AND WHY IT DID NOT BEFORE. Two comments in Materials.js said
// a modelled alternative was "ruled out" because "the roster is already over
// the 900,000-triangle ceiling". That reading was wrong and it cost six rounds:
// the charter lists 900k as a STANDING BUDGET beside the draw-call budget and
// says, in the same section, that **frames are bought by shading fewer pixels
// or fewer lights, not by fewer draws and not by fewer triangles.** The real
// gate is 60fps at 1920x1080, the frame is fill-bound, and dense opaque
// midground geometry is close to free in a fill-bound frame. Both comments are
// corrected where they stand.
//
// WHAT IT FIXES. The character axis is scored at magnification and the measured
// deficit is fine-scale micro-contrast -- 100 * RMS(L - box4 L) / mean(L) on
// sRGB luma. On the frozen closeup rig (bind pose, native 1080p, adaptive off,
// grain off, film-grade untouched; cross-run null-to-null +-0.11% median) the
// deficit is not in the post chain, which was ablated term by term:
//
//     DOF off      +0.00%      the closeup is NOT defocused
//     bloom off    +2.25%
//     GTAO off     -2.85%      AO is already helping
//     grade off   -18.60%      the grade is already helping
//     SMAA off     +9.75%      the only post headroom, and not optional
//
// So the missing detail has to come from the surface, and the texture route is
// exhausted: `GRAIN.height` is documented as reverted from 0.013 to 0.006
// because at the higher amplitude the plates read as hammered leather, and the
// roughness octave sweep moved the image by nothing at 3x. A texture octave
// cannot buy this. Geometry can, because a modelled fastener changes which way
// the surface points and therefore which part of the environment it sees.
//
// WHAT IT DOES. After every builder has run, walk the plates that already
// exist, find their large OUTWARD regions, march a row of big fasteners around
// the inside of each region's own boundary and fill its field with a lattice of
// small ones. Hardware follows the panel it holds down, and a riveted field is
// what armour skin actually is.
//
// WHAT IT COSTS. Everything here is TIER.GREEBLE, so it is excluded from the
// depth pass by construction (`shadowed = part.tier < TIER.GREEBLE`) and
// dropped entirely by the LOD1 level: colour-pass triangles at close range and
// nothing at all past 13m. It merges into batches that already exist, so it
// adds NO draw call -- 302 whole-frame before, 302 after. About 46k triangles
// per fighter (vulkan 51k -> 103k, anvil 52k -> 147k). Alternated inside one
// page load at the fight framing by hiding the batch it owns, seven pairs each
// against the mean of its two neighbours: **median +0.3ms, interval -7.5 to
// +14.2 ms**, against an OFF arm whose own median wandered between 23 and 60ms
// during the same run because several agents were driving Chromium on this box.
// Not resolvable, and said so rather than claimed as free.
//
// WHAT IT DOES NOT DO -- AND THIS IS THE ROUND'S REAL RESULT. It does not close
// the gate, and the reason is coverage, not quality. Per-surface, on the frozen
// closeup, taken by hiding one batch at a time and measuring the pixels that
// changed:
//
//     surface                    % of subject pixels   its micro-contrast
//     armorPrimary                     46.4                  9.46
//     armorSecondary                   28.4                 11.17
//     darkMetal / piston / carbon      18.9                  8.06
//     gasket / rubber                   7.6                  7.09
//     THIS PASS                         1.6                 18.23
//
// The hardware measures 18.23 -- inside the reference band (min 11.52, median
// 18.57, max 24.91 over the six closeup references, 96px tiles) -- while the
// painted armour it sits on measures 9.46. The detail is the right quality. It
// covers 1.6% of the frame, so the median tile does not move: paired on
// identical tiles, +0.11% median, +3.35% mean, +9.80% at the top decile.
//
// And density is SATURATED, which is the useful half. Taking the lattice from
// 2,106 to 5,036 pieces per fighter at 1.5x the head size measured 8.804
// against 8.791 -- nothing. More fasteners land in regions that already have
// them. The binding constraint is that most of the armour never qualifies for a
// region at all.
//
// The next attempt has a number to hit rather than a hunch: mixing an 18.2
// surface into an 8.2 one in RMS, reaching the reference minimum of 11.52 needs
// **about 25% pixel coverage** of band-grade detail, against today's 1.6%. That
// is fifteen times, which no fastener can be scaled to; it has to be a relief
// that covers a whole plate. Straps were the obvious candidate and they are
// disproved below.
//
// --- ROUND 36: THE TARGET IT WAS AIMING AT DOES NOT RE-DERIVE ---------------
//
// "min 11.52, median 18.57, max 24.91 over the six closeup references" is the
// number four rounds of work on this axis have been steered by, and it is not
// the same statistic as the 8.2 it is compared against. Re-derived here from
// the reference JPEGs and shots/02-closeup-face.png with ONE instrument applied
// identically to both sides -- 96px non-overlapping tiles, mc = 100 * RMS(L -
// box4 L) / mean(L) on Rec.709 luma of the stored sRGB bytes, tiles declared by
// rects listed in the tool, null re-run bit-identical, positive controls a
// sigma-1 blur (7.51 -> 4.40) and an 80% unsharp (7.51 -> 12.19):
//
//     statistic over on-subject tiles      ours    reference: min / median / max
//     mean                                 8.18        7.75 / 13.79 / 24.03
//     median                               7.51        6.41 / 12.90 / 23.30
//     75th percentile                     10.24       10.27 / 20.05 / 29.66
//
// Our value reproduces: 8.18 against the reported 8.22, 0.5%. **The reference
// band does not.** The reported 11.52 / 18.57 / 24.91 is nowhere near the mean
// or median rows and sits right on the p75 row. So the deficit was computed
// with our surface at its mean and the reference at its busiest quarter. On a
// matched statistic we are at 59% of the reference median, not 44%, and we are
// ABOVE the reference minimum rather than below it -- tekken8_03 measures 7.75
// and tekken8_09 measures 9.35 on the same instrument.
//
// Two more things the same instrument says, and they matter more than the
// halved gap:
//
//   1. The metric is a feature-DENSITY measure, not a material measure. Resample
//      any image in the set by 1.45x and it falls 30-35% -- ours and every
//      reference alike, monotone from 0.60x to 1.75x. A framing difference of
//      the same size as the reported deficit produces the reported deficit.
//   2. The SAME BUILD is at or above the reference median at both framings the
//      game actually plays at. Mean over on-subject tiles: 01-hero-idle 27.30
//      and 16.10 for the two fighters, 03-full-body 14.58, against the median
//      of the six reference means, 13.79. Only the 2003 px/m parked closeup is
//      below it.
//
// None of that says the surfaces are finished -- the axis is 66 because a critic
// looked at them. It says the specific arithmetic this pass was tuned against
// -- "reach 11.52, therefore 25% coverage, therefore a whole-plate relief" --
// rests on an unmatched comparison, and the coverage target derived from it
// should be re-derived before anyone spends another round of geometry on it.
// Matched, the same mixing formula needs 8.18 -> 13.79 against an 18.2 surface,
// which is 47% coverage, not 25%: the honest number is WORSE, and that is the
// clearest argument yet that coverage is the wrong lever and the 9.46 of the
// armour itself is the only one that can move this.
//
// (Also unreconciled and left as found: this pass is quoted at 18.23 here and
// at 18.79 sixty lines further down, for the same measurement.)
// ---------------------------------------------------------------------------

/**
 * Tuning for {@link addSurfaceHardware}, in metres.
 *
 * `pitch` and `field` are set by the metric's own arithmetic. A 96px tile at the
 * closeup framing (~2000 px/m) is 4.8cm of surface and the metric is an RMS over
 * that tile, so hardware covering a fraction `f` of it at `k` times the plate's
 * own high-pass amplitude moves it by `sqrt(1 - f + f k^2)`. A 14mm head is
 * ~29px across, f ~ 0.05, and the measured k here is about 2 (18.2 against 9.5),
 * so one head per tile is worth roughly +9% and that is the whole ceiling of
 * this lever at this density. A field pitch far above 5cm puts most tiles
 * between fasteners; far below it reads as acne rather than as assembly, and it
 * was measured NOT to help anyway -- see the saturation result above.
 */
const HW = {
  areaMin: 0.0030,   // smallest region worth bolting, m^2 (a 5.5cm square)
  margin: 0.017,     // inset from the region boundary to the fastener centre
  pitch: 0.046,      // spacing along an inset row
  head: 0.0072,      // fastener head radius; 14mm across flats, 29px at closeup
  rise: 0.0032,      // how far it stands off the plate
  maxPieces: 4200,   // hard cap per robot, largest regions first
  riveted: 0.62,     // field-rivet radius as a fraction of `head`
  field: 0.032,      // rivet-lattice pitch; 64px at closeup, ~2 per measured tile
};

/** Cached canonical fastener geometries, built +Y up about the origin. */
const HW_GEO = new Map();

/**
 * One fastener, authored +Y up with its seating face on y = 0.
 *
 * Three kinds, because a machine that uses one fastener everywhere reads as a
 * texture of dots. Triangle counts are 30 / 54 / 24 — the degenerate ring at
 * r = 0 collapses to a fan, which `Surf.quad` already handles.
 *
 * @param {number} kind 0 hex head on a washer, 1 socket cap in a counterbore,
 *   2 domed rivet
 */
function fastenerGeo(kind) {
  let g = HW_GEO.get(kind);
  if (g) return g;
  const r = HW.head, h = HW.rise;
  if (kind === 0) {
    g = latheProfile([
      { r: 0, y: h },
      { r: r * 0.86, y: h },
      { r, y: h * 0.48 },
      { r: r * 1.24, y: 0 },
    ], 6, { faceted: true, phase: Math.PI / 6, uvV: 8 });
  } else if (kind === 1) {
    g = latheProfile([
      { r: 0, y: h * 0.42 },
      { r: r * 0.46, y: h * 0.42 },
      { r: r * 0.52, y: h },
      { r: r * 0.94, y: h },
      { r: r * 1.02, y: h * 0.40 },
      { r: r * 1.34, y: 0 },
    ], 6, { uvV: 8 });
  } else if (kind === 2) {
    g = latheProfile([
      { r: 0, y: h * 0.95, smooth: true },
      { r: r * 0.64, y: h * 0.80, smooth: true },
      { r: r * 0.92, y: 0 },
    ], 8, { uvV: 8 });
  } else {
    // Field rivet: the small one the lattice is made of. Domed and smooth-shaded
    // so it carries a travelling highlight rather than a hard facet, and small
    // enough that a 32mm grid of them reads as skin rather than as studding.
    //
    // A PAN HEAD WAS TRIED AND REVERTED. On a plate turned steeply away from the
    // camera a raised head renders as a bright crescent -- its side wall takes
    // the rim light while its top stays dark -- and the fix looked like a flat
    // top face that would take broad light at any angle. Built at 8 segments
    // with a chamfer and a flange: +16k triangles per fighter, micro-contrast
    // +0.24% median against the dome's +0.11% (inside the +-0.2% null-to-null
    // band, i.e. no change), and at 1.5x on the frozen closeup the crescents are
    // pixel-for-pixel the same. The crescent is the grazing-angle specular of
    // the plate it sits on, not the shape of the head, so a better head cannot
    // answer it. Reverted rather than shipped: triangles that buy nothing
    // measured and nothing visible are the thing this round exists to stop
    // spending on the wrong lever.
    const rr = r * HW.riveted, hh = h * 0.72;
    g = latheProfile([
      { r: 0, y: hh, smooth: true },
      { r: rr * 0.60, y: hh * 0.82, smooth: true },
      { r: rr, y: 0 },
    ], 7, { uvV: 8 });
  }
  HW_GEO.set(kind, g);
  return g;
}

/**
 * Group a bind-space plate's triangles into shallow, near-planar REGIONS.
 *
 * The first version of this bucketed on an exact plane — quantised normal plus
 * quantised plane offset — and it found almost nothing, because almost nothing
 * on this roster is flat. The big surfaces are `loftHull` sections and
 * `latheProfile` shells: a pauldron, an upper-arm barrel, a chest mass. Their
 * triangles turn a degree or two apiece, so an exact-plane bucket shattered
 * every one of them into fragments below `areaMin` and the pass emitted 42k
 * triangles of hardware that measured **+0.0%** on the frozen closeup. That
 * null result is the useful half of this note: the placement rule, not the
 * fastener, was the thing that had to change.
 *
 * So the bucket is deliberately coarse — a ~14-degree cone of direction and a
 * 5cm slab of offset — and a region is then treated as a curved strip, not as a
 * plane. Candidate positions are laid out on the strip's mean plane, but every
 * one that survives is projected BACK onto the triangle it actually landed in,
 * by barycentric coordinates, and oriented by that triangle's own normal. A
 * bolt on a barrel therefore sits on the barrel and leans with it.
 *
 * @param {THREE.BufferGeometry} geo non-indexed, positions in bind space
 * @returns {Array<{n:number[], area:number, tris:Float64Array[]}>}
 */
function surfaceRegions(geo) {
  const pos = geo.getAttribute('position');
  if (!pos) return [];
  const p = pos.array;
  const map = new Map();
  for (let i = 0; i < pos.count; i += 3) {
    const o = i * 3;
    const ax = p[o], ay = p[o + 1], az = p[o + 2];
    const bx = p[o + 3], by = p[o + 4], bz = p[o + 5];
    const cx = p[o + 6], cy = p[o + 7], cz = p[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const area = len * 0.5;
    nx /= len; ny /= len; nz /= len;
    const d = nx * ax + ny * ay + nz * az;
    const key = `${Math.round(nx * 8)},${Math.round(ny * 8)},${Math.round(nz * 8)},${Math.round(d * 20)}`;
    let f = map.get(key);
    if (!f) map.set(key, (f = { n: [0, 0, 0], area: 0, tris: [] }));
    f.area += area;
    f.n[0] += nx * area; f.n[1] += ny * area; f.n[2] += nz * area;
    f.tris.push([ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz]);
  }
  const out = [];
  for (const f of map.values()) {
    const l = Math.hypot(f.n[0], f.n[1], f.n[2]);
    if (l < 1e-9) continue;
    f.n[0] /= l; f.n[1] /= l; f.n[2] /= l;
    out.push(f);
  }
  return out;
}

/**
 * Which triangle of a projected region contains (u,v), and where.
 *
 * Returns the FRONTMOST hit — largest offset along the region normal — because
 * a 5cm offset slab can hold two overlapping plates and a bolt belongs on the
 * one you can see.
 *
 * @param {Float64Array} poly 6 floats per triangle: u0,v0,u1,v1,u2,v2
 * @param {Float64Array} off one plane offset per triangle
 * @returns {?{i:number, a:number, b:number, c:number}} barycentric weights
 */
function locateInRegion(poly, off, u, v) {
  let best = null, bestOff = -Infinity;
  for (let i = 0, t = 0; i < poly.length; i += 6, t++) {
    const ax = poly[i], ay = poly[i + 1];
    const bx = poly[i + 2], by = poly[i + 3];
    const cx = poly[i + 4], cy = poly[i + 5];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-14) continue;
    const wa = ((by - cy) * (u - cx) + (cx - bx) * (v - cy)) / den;
    const wb = ((cy - ay) * (u - cx) + (ax - cx) * (v - cy)) / den;
    const wc = 1 - wa - wb;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
    if (off[t] > bestOff) { bestOff = off[t]; best = { i: t, a: wa, b: wb, c: wc }; }
  }
  return best;
}

/**
 * Coarse occupancy grid over everything the rig has built so far.
 *
 * THIS IS THE PASS. Without it the hardware went almost entirely INSIDE the
 * robot, and the measurement is what caught it — 58k triangles of fasteners
 * bought +0.15% on the frozen closeup, so the diagnostic was run and the
 * regions that had eaten the whole budget were, in order of area:
 *
 *     spine01 armorPrimary 0.249 m^2  normal (0, 1, 0)
 *     spine02 armorPrimary 0.235 m^2  normal (0,-1, 0)
 *     hips    armorPrimary 0.217 m^2  normal (0, 1, 0)
 *
 * — the top and bottom END CAPS of the torso loft sections, each buried under
 * the next section up. They are the largest faces on the machine and not one
 * pixel of them is ever seen. Both of the geometric "outward" tests pass them
 * honestly: a cap does point away from its own part's centre and away from its
 * bone. Outward is not the same as visible on a body made of stacked shells,
 * and nothing short of asking the rest of the geometry can tell them apart.
 *
 * Triangles are rasterised into 2cm cells by barycentric sampling at a density
 * set by their own area, so a single 20cm quad fills its cells instead of
 * marking four corners. A point is then buried if the grid is occupied 3, 5 or
 * 7cm out along the surface normal.
 */
function occupancyGrid(rig, cell = 0.02) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const part of rig.parts) {
    if (!part.geo.boundingBox) part.geo.computeBoundingBox();
    box.union(part.geo.boundingBox);
  }
  if (box.isEmpty()) return null;
  box.expandByScalar(cell * 2);
  const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / cell));
  const ny = Math.max(1, Math.ceil((box.max.y - box.min.y) / cell));
  const nz = Math.max(1, Math.ceil((box.max.z - box.min.z) / cell));
  const g = new Uint8Array(nx * ny * nz);
  const mark = (x, y, z) => {
    const i = ((x - box.min.x) / cell) | 0;
    const j = ((y - box.min.y) / cell) | 0;
    const k = ((z - box.min.z) / cell) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    g[(k * ny + j) * nx + i] = 1;
  };
  for (const part of rig.parts) {
    const p = part.geo.getAttribute('position').array;
    for (let o = 0; o + 8 < p.length; o += 9) {
      const ax = p[o], ay = p[o + 1], az = p[o + 2];
      const bx = p[o + 3], by = p[o + 4], bz = p[o + 5];
      const cx = p[o + 6], cy = p[o + 7], cz = p[o + 8];
      const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az),
        Math.hypot(cx - ax, cy - ay, cz - az), Math.hypot(cx - bx, cy - by, cz - bz));
      const s = Math.min(12, Math.max(1, Math.ceil(e / (cell * 0.7))));
      for (let i = 0; i <= s; i++) {
        for (let j = 0; i + j <= s; j++) {
          const wa = i / s, wb = j / s, wc = 1 - wa - wb;
          mark(ax * wa + bx * wb + cx * wc, ay * wa + by * wb + cy * wc, az * wa + bz * wb + cz * wc);
        }
      }
    }
  }
  const at = (x, y, z) => {
    const i = ((x - box.min.x) / cell) | 0;
    const j = ((y - box.min.y) / cell) | 0;
    const k = ((z - box.min.z) / cell) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    return g[(k * ny + j) * nx + i];
  };
  /** True when something else stands in front of this point along `n`. */
  return (px, py, pz, nx2, ny2, nz2) => {
    for (const d of [cell * 1.4, cell * 2.3]) {
      if (at(px + nx2 * d, py + ny2 * d, pz + nz2 * d)) return true;
    }
    return false;
  };
}

/**
 * Bolt down every plate big enough to look moulded without it.
 *
 * Runs over `rig.parts` after the builders, so it needs no cooperation from the
 * fifty-odd recipe functions and it picks up whatever a new chassis adds. The
 * geometry it reads is already in bind space and rigid-bound to one bone, so a
 * fastener placed on a plate inherits that plate's bone by copying its
 * `skinIndex` — no frame maths, and it can never come adrift from what it holds.
 *
 * A region qualifies when it is large and OUTWARD by two independent tests:
 * pointing away from its own part's centre (which rejects the inner skin of a
 * shell) and away from the bone it is bound to (which rejects the back face of
 * a thin plate lying against the body). Both are needed; either alone passes
 * surfaces that are never seen and would be pure cost.
 *
 * Two rows, not a lattice. The outer row sits `margin` inside the region's own
 * boundary and reads as the fasteners holding the plate to its frame; the inner
 * row, only on regions wide enough to carry it, reads as a sub-panel bolted
 * inside that. Real hardware follows edges and joints. A lattice of bolts across
 * an open panel would move the metric just as well and would read as acne.
 */
function addSurfaceHardware(rig) {
  if (rig.maxTier < TIER.GREEBLE) return 0;
  const HW_MATS = new Set(['armorPrimary', 'armorSecondary', 'armorAccent', 'trim', 'carbon']);
  const buried = occupancyGrid(rig);
  if (!buried) return 0;
  const _v = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const cand = [];

  for (const part of rig.parts) {
    if (part.tier > TIER.SECONDARY || !HW_MATS.has(part.mat)) continue;
    const geo = part.geo;
    const si = geo.getAttribute('skinIndex');
    if (!si) continue;
    const boneIndex = si.getX(0);
    const bone = rig.bones[boneIndex];
    const bp = bone ? rig.restPos[bone.name] : null;
    if (!geo.boundingBox) geo.computeBoundingBox();
    geo.boundingBox.getCenter(_v);
    const px = _v.x, py = _v.y, pz = _v.z;

    for (const f of surfaceRegions(geo)) {
      if (f.area < HW.areaMin) continue;
      const [nx, ny, nz] = f.n;
      let cx = 0, cy = 0, cz = 0;
      for (const t of f.tris) {
        cx += (t[0] + t[3] + t[6]) / 3;
        cy += (t[1] + t[4] + t[7]) / 3;
        cz += (t[2] + t[5] + t[8]) / 3;
      }
      cx /= f.tris.length; cy /= f.tris.length; cz /= f.tris.length;
      if (nx * (cx - px) + ny * (cy - py) + nz * (cz - pz) <= 0.0005) continue;
      if (bp && nx * (cx - bp.x) + ny * (cy - bp.y) + nz * (cz - bp.z) <= 0.004) continue;
      // Early visibility reject: sample a few triangles of the region and drop
      // it if almost every one of them has geometry standing in front of it.
      let open = 0, seen = 0;
      for (let s = 0; s < f.tris.length; s += Math.max(1, (f.tris.length / 8) | 0)) {
        const t = f.tris[s];
        const mx = (t[0] + t[3] + t[6]) / 3, my = (t[1] + t[4] + t[7]) / 3, mz = (t[2] + t[5] + t[8]) / 3;
        seen++;
        if (!buried(mx, my, mz, t[9], t[10], t[11])) open++;
      }
      if (open / Math.max(1, seen) < 0.2) continue;
      cand.push({ f, boneIndex, wear: part.tier === TIER.PRIMARY ? 0.9 : 0.75 });
    }
  }

  // Largest regions first, so the cap spends its budget where the eye is.
  cand.sort((a, b) => b.f.area - a.f.area);

  let placed = 0;
  for (const c of cand) {
    if (placed >= HW.maxPieces) break;
    const n = c.f.n;
    // in-plane basis
    let ux, uy, uz;
    if (Math.abs(n[1]) < 0.9) { ux = -n[2]; uy = 0; uz = n[0]; } else { ux = 1; uy = 0; uz = 0; }
    const l = Math.hypot(ux, uy, uz) || 1;
    ux /= l; uy /= l; uz /= l;
    const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;

    const tris = c.f.tris;
    const ox = tris[0][0], oy = tris[0][1], oz = tris[0][2];
    const poly = new Float64Array(tris.length * 6);
    const off = new Float64Array(tris.length);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      let w = 0;
      for (let k = 0; k < 3; k++) {
        const dx = t[k * 3] - ox, dy = t[k * 3 + 1] - oy, dz = t[k * 3 + 2] - oz;
        const u = dx * ux + dy * uy + dz * uz;
        const v = dx * vx + dy * vy + dz * vz;
        w += dx * n[0] + dy * n[1] + dz * n[2];
        poly[i * 6 + k * 2] = u; poly[i * 6 + k * 2 + 1] = v;
        if (u < u0) u0 = u; if (u > u1) u1 = u;
        if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      off[i] = w / 3;
    }

    /**
     * Surface point and normal at a projected (u,v), or null off the region.
     * `out` receives x,y,z,nx,ny,nz.
     */
    const surfaceAt = (u, v, out) => {
      const hit = locateInRegion(poly, off, u, v);
      if (!hit) return false;
      const t = tris[hit.i];
      out[0] = t[0] * hit.a + t[3] * hit.b + t[6] * hit.c;
      out[1] = t[1] * hit.a + t[4] * hit.b + t[7] * hit.c;
      out[2] = t[2] * hit.a + t[5] * hit.b + t[8] * hit.c;
      out[3] = t[9]; out[4] = t[10]; out[5] = t[11];
      return true;
    };

    // ---- straps: BUILT, MEASURED, AND REMOVED -------------------------
    //
    // The obvious answer to the coverage problem below was a band bolted
    // across each region -- two long modelled edges for eighty triangles,
    // instead of a fastener's one small disc. It was built, and it fails on
    // both counts.
    //
    // It could not reach coverage: the plates on this roster fragment into 352
    // regions averaging an 8cm square, so a strap is 4-8cm long before it runs
    // off the end of its own region, and 230 of them covered **0.46% of subject
    // pixels** against the fasteners' 1.63%.
    //
    // And it left a hard artefact: where a curved region's projection folds,
    // the ribbon closes across the fold and renders as a black shard floating
    // clear of the jaw plate, plainly visible at 1:1 on the frozen closeup and
    // confirmed by hiding the strap batch alone. A whole-body relief that shows
    // one black sliver on one character is not shippable, and there is no
    // version of "clip the fold" that is cheaper than the parameterisation this
    // pass deliberately does not have.
    //
    // Kept as a note rather than as dead code because the next attempt at this
    // axis will reach for exactly the same idea, and the number that matters --
    // 0.46% -- is the reason not to.
    // Candidate stops, as `[u, v, small]`.
    //
    // TWO POPULATIONS, AND THE SECOND ONE IS THE MEASUREMENT. A row of bolts
    // around a plate's border is the right DESIGN -- hardware follows the joint
    // it closes -- and on its own it moved the frozen closeup by +0.1%, because
    // the metric is a median over 4.8cm tiles and a border row leaves the
    // middle of a 20cm plate exactly as empty as it was. So the border keeps
    // the big hex and socket heads, and the field of the plate carries a
    // regular lattice of small dome rivets at the same pitch.
    //
    // A rivet field is not a concession to the metric. Aircraft skin, tank
    // glacis, ship superstructure and pressure vessels are all riveted or
    // bolted on a 20-50mm grid over their whole area, and it is the single
    // most recognisable "this was fabricated from sheet" cue there is. It is
    // laid on the region's own axes so the rows run straight and parallel to
    // the border row, which is what separates a fastener pattern from acne.
    const stops = [];
    const ring = (m, small) => {
      const au = u0 + m, bu = u1 - m, av = v0 + m, bv = v1 - m;
      if (bu <= au || bv <= av) return;
      const ku = Math.max(1, Math.round((bu - au) / HW.pitch));
      const kv = Math.max(1, Math.round((bv - av) / HW.pitch));
      for (let i = 0; i <= ku; i++) {
        const u = au + ((bu - au) * i) / ku;
        stops.push([u, av, small], [u, bv, small]);
      }
      for (let j = 1; j < kv; j++) {
        const v = av + ((bv - av) * j) / kv;
        stops.push([au, v, small], [bu, v, small]);
      }
    };
    ring(HW.margin, false);
    const inner = HW.margin + HW.field * 0.9;
    const au = u0 + inner, bu = u1 - inner, av = v0 + inner, bv = v1 - inner;
    if (bu > au && bv > av) {
      const ku = Math.max(1, Math.round((bu - au) / HW.field));
      const kv = Math.max(1, Math.round((bv - av) / HW.field));
      for (let i = 0; i <= ku; i++) {
        for (let j = 0; j <= kv; j++) {
          stops.push([au + ((bu - au) * i) / ku, av + ((bv - av) * j) / kv, true]);
        }
      }
    }

    const parts = [];
    const seed = rig.plateCount * 31 + placed;
    for (const [u, v, small] of stops) {
      const probe = (small ? HW.head * HW.riveted : HW.head) * 1.08;
      if (placed >= HW.maxPieces) break;
      const hit = locateInRegion(poly, off, u, v);
      if (!hit) continue;
      // The whole head has to be on the surface, not just its centre.
      if (!locateInRegion(poly, off, u + probe, v) || !locateInRegion(poly, off, u - probe, v)
        || !locateInRegion(poly, off, u, v + probe) || !locateInRegion(poly, off, u, v - probe)) continue;
      // Back onto the real surface: barycentric on the triangle that was hit,
      // and that triangle's own normal, so a bolt on a barrel leans with it.
      const t = tris[hit.i];
      const wx = t[0] * hit.a + t[3] * hit.b + t[6] * hit.c;
      const wy = t[1] * hit.a + t[4] * hit.b + t[7] * hit.c;
      const wz = t[2] * hit.a + t[5] * hit.b + t[8] * hit.c;
      if (buried(wx, wy, wz, t[9], t[10], t[11])) continue;
      _n.set(t[9], t[10], t[11]);
      const [ha, hb] = plateHash(seed + parts.length * 17);
      const kind = small ? 2 : ha < 0.68 ? 0 : 1;
      const g = fastenerGeo(small ? 3 : kind).clone();
      const q = new THREE.Quaternion().setFromUnitVectors(UP, _n);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(UP, hb * Math.PI * 2));
      // Seat the head a hair below the surface so no washer rim floats.
      _v.set(wx - _n.x * 0.0005, wy - _n.y * 0.0005, wz - _n.z * 0.0005);
      g.applyMatrix4(new THREE.Matrix4().compose(_v, q, new THREE.Vector3(1, 1, 1)));
      parts.push(g);
      placed++;
    }
    if (!parts.length) continue;
    if (rig.overGreebleBudget(TIER.GREEBLE)) {
      rig.plateCount++;
      for (const g of parts) g.dispose();
      continue;
    }
    // `trim`, not the plate's own material: the hardware is bare steel against
    // paint, and that value break is half of what the pass buys. Measured on
    // the frozen closeup, the pixels this pass owns carry a micro-contrast of
    // 18.79 against the painted armour's 9.46 — inside the reference band
    // (11.52 / 18.57 / 24.91) where the plates it sits on are at 51% of it.
    const merged = joinGeometries(parts);
    if (!merged) continue;
    tagPlateSurface(merged, rig.plateCount, 1, true);
    tagNoFrame(merged);
    tagPlateLayout(merged, null);
    bindRigid(merged, c.boneIndex);
    tagPlate(merged, rig.plateCount++, c.wear, TIER.GREEBLE);
    rig.parts.push({ geo: merged, mat: 'trim', tier: TIER.GREEBLE });
  }
  return placed;
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

  // Last, because it reads the plates every other builder produced.
  const hardware = addSurfaceHardware(rig);

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
    hardware,
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
