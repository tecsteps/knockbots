/**
 * Knockbots — geometry construction kit for the arena.
 *
 * Two things separate a set that reads as a real place from one that reads as
 * primitives:
 *
 *   1. **Nothing has a sharp 90 degree edge.** A chamfer one to three
 *      centimetres wide is invisible as a shape but it is a specular highlight
 *      running the length of every beam, and it is the single cheapest way to
 *      make rim light describe an object. `bevelBox` is therefore the default
 *      box in this stage, not `THREE.BoxGeometry`.
 *   2. **Texture scale is world scale.** Architecture is merged into a handful
 *      of draw calls, so per-primitive UV layouts are impossible; instead every
 *      merged part is UV'd by dominant-axis planar projection at a fixed metres
 *      per tile. Rust on a 6m girder and rust on a 40cm bracket then share one
 *      texture at the same physical grain.
 *
 * Everything here returns plain `BufferGeometry` in local space so the caller
 * can position it with `place()` and hand a whole pile to `mergeAll()`.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Applies a transform to a geometry in place.
 * @param {THREE.BufferGeometry} geo
 * @param {{pos?:number[], rot?:number[], scale?:number|number[]}} t
 * @returns {THREE.BufferGeometry} the same geometry
 */
export function place(geo, t = {}) {
  const p = t.pos || [0, 0, 0];
  const r = t.rot || [0, 0, 0];
  const sc = t.scale ?? 1;
  _v.set(p[0], p[1], p[2]);
  _e.set(r[0], r[1], r[2]);
  _q.setFromEuler(_e);
  if (Array.isArray(sc)) _s.set(sc[0], sc[1], sc[2]);
  else _s.set(sc, sc, sc);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

/**
 * Chamfered box. 24 verts, 6 faces + 12 edge chamfers + 8 corner chamfers.
 * The chamfer normals are their own, so the highlight is a hard specular line
 * rather than a smoothed-over rounding.
 * @param {number} w
 * @param {number} h
 * @param {number} d
 * @param {number} [b=0.02] chamfer width in metres
 */
export function bevelBox(w, h, d, b = 0.02) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const bev = Math.min(b, hx * 0.49, hy * 0.49, hz * 0.49);
  const half = [hx, hy, hz];

  // vert[cornerIndex][axis]: corner pushed inward on both axes except `axis`.
  const verts = [];
  const corners = [];
  for (let c = 0; c < 8; c++) {
    const s = [(c & 1) ? 1 : -1, (c & 2) ? 1 : -1, (c & 4) ? 1 : -1];
    corners.push(s);
    const trio = [];
    for (let a = 0; a < 3; a++) {
      trio.push([
        s[0] * (half[0] - (a === 0 ? 0 : bev)),
        s[1] * (half[1] - (a === 1 ? 0 : bev)),
        s[2] * (half[2] - (a === 2 ? 0 : bev)),
      ]);
    }
    verts.push(trio);
  }

  const pos = [];
  const nrm = [];

  const tri = (p0, p1, p2, n) => {
    // Fix winding against the intended outward normal.
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const a = p0, bb = flip ? p2 : p1, cq = flip ? p1 : p2;
    pos.push(a[0], a[1], a[2], bb[0], bb[1], bb[2], cq[0], cq[1], cq[2]);
    for (let i = 0; i < 3; i++) nrm.push(n[0], n[1], n[2]);
  };
  const quad = (p0, p1, p2, p3, n) => { tri(p0, p1, p2, n); tri(p0, p2, p3, n); };

  // Six faces.
  for (let a = 0; a < 3; a++) {
    for (const sgn of [-1, 1]) {
      const n = [0, 0, 0];
      n[a] = sgn;
      const ring = corners
        .map((s, ci) => ({ s, ci }))
        .filter(({ s }) => s[a] === sgn);
      const a1 = (a + 1) % 3, a2 = (a + 2) % 3;
      // Order the four corners into a ring around the face.
      const order = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const pts = order.map(([u, v]) => {
        const found = ring.find(({ s }) => s[a1] === (sgn > 0 ? u : -u) && s[a2] === v);
        return verts[found.ci][a];
      });
      quad(pts[0], pts[1], pts[2], pts[3], n);
    }
  }

  // Twelve edge chamfers, one per pair of adjacent faces.
  for (let a = 0; a < 3; a++) {
    const a1 = (a + 1) % 3, a2 = (a + 2) % 3;
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        const cLo = corners.findIndex((s) => s[a] === -1 && s[a1] === s1 && s[a2] === s2);
        const cHi = corners.findIndex((s) => s[a] === 1 && s[a1] === s1 && s[a2] === s2);
        const n = [0, 0, 0];
        n[a1] = s1; n[a2] = s2;
        const inv = 1 / Math.SQRT2;
        n[a1] *= inv; n[a2] *= inv;
        quad(verts[cLo][a1], verts[cLo][a2], verts[cHi][a2], verts[cHi][a1], n);
      }
    }
  }

  // Eight corner chamfers.
  for (let c = 0; c < 8; c++) {
    const s = corners[c];
    const inv = 1 / Math.sqrt(3);
    tri(verts[c][0], verts[c][1], verts[c][2], [s[0] * inv, s[1] * inv, s[2] * inv]);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return geo;
}

/**
 * Dominant-axis planar UVs at a fixed world scale. Run this after `place()` so
 * the projection uses final world coordinates and merged parts agree.
 * @param {THREE.BufferGeometry} geo
 * @param {number} metresPerTile
 * @param {number} [rotate=0] radians, rotates the projected UVs
 */
export function worldUv(geo, metresPerTile = 2, rotate = 0) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const count = p.count;
  const uv = new Float32Array(count * 2);
  const inv = 1 / metresPerTile;
  const cr = Math.cos(rotate), sr = Math.sin(rotate);
  for (let i = 0; i < count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = (u * cr - v * sr) * inv;
    uv[i * 2 + 1] = (u * sr + v * cr) * inv;
  }
  const attr = new THREE.Float32BufferAttribute(uv, 2);
  geo.setAttribute('uv', attr);
  // aoMap and lightMap read uv1; giving them the same layout means a tiling
  // detail-AO map lines up with the albedo it was derived from.
  geo.setAttribute('uv1', attr.clone());
  return geo;
}

/**
 * Merges a pile of geometries into one, normalising index and attribute sets
 * first so primitives from different generators can be mixed freely.
 * @param {THREE.BufferGeometry[]} geos
 * @returns {THREE.BufferGeometry}
 */
export function mergeAll(geos) {
  const list = geos.filter(Boolean);
  if (!list.length) return new THREE.BufferGeometry();
  const flat = list.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    // Keep exactly position/normal/uv/uv1 so the merge never trips on a stray
    // attribute a primitive generator added.
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', ng.attributes.position);
    out.setAttribute('normal', ng.attributes.normal);
    out.setAttribute('uv', ng.attributes.uv ?? new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
    out.setAttribute('uv1', ng.attributes.uv1 ?? out.attributes.uv);
    return out;
  });
  const merged = mergeGeometries(flat, false);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * A tube through a list of points. Used for pipe runs, cabling and handrails.
 * @param {THREE.Vector3[]|number[][]} points
 * @param {number} radius
 * @param {number} [radialSegments=8]
 * @param {number} [tubularSegments]
 */
export function tube(points, radius, radialSegments = 8, tubularSegments = null) {
  const pts = points.map((p) => (Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : p));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.15);
  const seg = tubularSegments ?? Math.max(6, Math.min(96, pts.length * 6));
  return new THREE.TubeGeometry(curve, seg, radius, radialSegments, false);
}

/**
 * Points along a catenary between two anchors. A hanging cable drawn as a
 * parabola looks wrong at the ends; the real curve is cosh, and the difference
 * is visible on a 6m span.
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} sag extra length as a fraction of the span
 * @param {number} [n=16]
 * @returns {THREE.Vector3[]}
 */
export function catenary(a, b, sag = 0.15, n = 16) {
  const A = new THREE.Vector3(a[0], a[1], a[2]);
  const B = new THREE.Vector3(b[0], b[1], b[2]);
  const span = Math.hypot(B.x - A.x, B.z - A.z) || 1e-3;
  // Solve sinh(x)/x = 1 + sag for the shape parameter by bisection.
  const targetRatio = 1 + Math.max(1e-4, sag);
  let lo = 1e-3, hi = 12;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) * 0.5;
    if (Math.sinh(mid) / mid > targetRatio) hi = mid; else lo = mid;
  }
  const k = (lo + hi) * 0.5;
  const c = span / (2 * k);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = (t - 0.5) * span;
    const dip = c * (Math.cosh(u / c) - Math.cosh(span / (2 * c)));
    out.push(new THREE.Vector3(
      A.x + (B.x - A.x) * t,
      A.y + (B.y - A.y) * t + dip,
      A.z + (B.z - A.z) * t,
    ));
  }
  return out;
}

/**
 * Industrial handrail: two horizontal tubes, a toe board and posts on a
 * spacing. Built along +X, origin at the centre of the run, base at y=0.
 * @param {number} length
 * @param {object} [opts]
 */
export function railing(length, opts = {}) {
  const height = opts.height ?? 1.05;
  const spacing = opts.spacing ?? 1.6;
  const r = opts.radius ?? 0.024;
  const posts = Math.max(2, Math.round(length / spacing) + 1);
  const parts = [];

  for (const y of [height, height * 0.55]) {
    parts.push(place(new THREE.CylinderGeometry(r, r, length, 7, 1), { pos: [0, y, 0], rot: [0, 0, Math.PI / 2] }));
  }
  for (let i = 0; i < posts; i++) {
    const x = -length / 2 + (i * length) / (posts - 1);
    parts.push(place(new THREE.CylinderGeometry(r * 1.25, r * 1.25, height, 7, 1), { pos: [x, height / 2, 0] }));
  }
  if (opts.toeBoard !== false) {
    parts.push(place(bevelBox(length, 0.11, 0.02, 0.008), { pos: [0, 0.06, 0] }));
  }
  return mergeAll(parts);
}

/**
 * Ladder-type cable tray along +X, origin at the centre of the run, tray floor
 * at y=0.
 *
 * Every industrial interior has one and it is the most useful single object in
 * the kit for a long wall, because it is the only piece of infrastructure that
 * is *legible as a repeat*: the rungs are a fixed pitch, so a tray running away
 * from the lens gives the eye a ruler for the whole depth of the room. It is
 * also mostly holes, so a twenty-six metre run costs about the same as one
 * girder.
 *
 * @param {number} length
 * @param {number} width rail centre to rail centre
 * @param {object} [opts]
 */
export function cableTray(length, width, opts = {}) {
  const rungPitch = opts.rungPitch ?? 0.3;
  const depth = opts.depth ?? 0.1;
  const t = opts.thickness ?? 0.018;
  const parts = [];

  for (const s of [-1, 1]) {
    parts.push(place(bevelBox(length, depth, t, t * 0.35), { pos: [0, depth / 2, s * width / 2] }));
    // Return lip folded in along the top of each rail. It is one centimetre of
    // geometry and it is what puts a continuous specular line down the run.
    parts.push(place(bevelBox(length, t, 0.032, t * 0.3), { pos: [0, depth - t / 2, s * (width / 2 - 0.016)] }));
  }
  const rungs = Math.max(2, Math.round(length / rungPitch));
  for (let i = 0; i <= rungs; i++) {
    parts.push(place(bevelBox(0.03, t, width, t * 0.3), {
      pos: [-length / 2 + (i * length) / rungs, t / 2, 0],
    }));
  }
  const cables = opts.cables ?? 3;
  for (let i = 0; i < cables; i++) {
    const r = 0.015 + (i % 3) * 0.008;
    parts.push(place(new THREE.CylinderGeometry(r, r, length, 6, 1), {
      pos: [0, t + r, -width / 2 + width * ((i + 0.5) / cables)], rot: [0, 0, Math.PI / 2],
    }));
  }
  return mergeAll(parts);
}

/**
 * Open lattice girder along +X: two chords, verticals and alternating
 * diagonals. This is the single most recognisable industrial silhouette, and
 * because it is mostly holes it costs very little against the triangle budget.
 * @param {number} length
 * @param {number} depth vertical separation of the chords
 * @param {object} [opts]
 */
export function truss(length, depth, opts = {}) {
  const bays = opts.bays ?? Math.max(2, Math.round(length / (depth * 1.1)));
  const t = opts.thickness ?? 0.055;
  const width = opts.width ?? t;
  const gap = opts.chordGap ?? depth * 0.6;
  const parts = [];
  const bay = length / bays;

  for (const y of [0, depth]) {
    for (const z of opts.doubleChord ? [-gap / 2, gap / 2] : [0]) {
      parts.push(place(bevelBox(length, t * 1.6, width * 1.6, t * 0.28), { pos: [0, y, z] }));
    }
  }
  for (let i = 0; i <= bays; i++) {
    const x = -length / 2 + i * bay;
    parts.push(place(bevelBox(t, depth, width, t * 0.25), { pos: [x, depth / 2, 0] }));
  }
  const diag = Math.hypot(bay, depth);
  const ang = Math.atan2(depth, bay);
  for (let i = 0; i < bays; i++) {
    const x = -length / 2 + i * bay + bay / 2;
    parts.push(place(bevelBox(diag, t * 0.85, width * 0.85, t * 0.22), {
      pos: [x, depth / 2, 0],
      rot: [0, 0, i % 2 === 0 ? ang : -ang],
    }));
  }
  return mergeAll(parts);
}

/**
 * Portal crane: two braced legs, a box girder, a cantilevered boom and the
 * machinery house between them.
 *
 * Distance in a stage is read from *known* objects, not from small ones. A
 * crane has a size everybody already has a number for, so a crane a third the
 * height of the last one is unarguably three times as far away — which is why
 * this shape is worth having as a primitive rather than as a box.
 *
 * @param {number} span leg centre to leg centre
 * @param {number} height rail to girder top
 * @param {object} [opts]
 * @param {number} [opts.boom=0] cantilever beyond the +X leg; 0 for none
 * @param {number} [opts.member] member width; defaults to a fraction of height
 * @returns {THREE.BufferGeometry} origin at rail level, centred on the span
 */
export function portalCrane(span, height, opts = {}) {
  const m = opts.member ?? Math.max(0.28, height * 0.035);
  const boom = opts.boom ?? 0;
  const parts = [];

  for (const s of [-1, 1]) {
    const x = s * span / 2;
    // Legs splay outward at the base: a vertical post reads as a pole, a
    // splayed A-frame reads as something built to carry a load.
    for (const d of [-1, 1]) {
      const foot = [x + s * d * 0, 0, d * span * 0.06];
      const top = [x, height - m, d * span * 0.02];
      parts.push(segment(foot, top, m * 0.62, m * 0.5, 4));
    }
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * height;
      parts.push(place(bevelBox(m * 0.7, m * 0.5, span * 0.13, m * 0.1), { pos: [x, y, 0] }));
    }
    // End truck straddling the rail.
    parts.push(place(bevelBox(m * 2.2, m * 0.9, span * 0.2, m * 0.15), { pos: [x, m * 0.45, 0] }));
  }

  const girder = span + boom;
  const gx = boom / 2;
  parts.push(place(bevelBox(girder, m * 1.5, m * 1.2, m * 0.2), { pos: [gx, height - m * 0.75, 0] }));
  parts.push(place(bevelBox(girder, m * 0.4, m * 2.4, m * 0.12), { pos: [gx, height + 0.05, 0] }));
  if (boom > 0) {
    // Tie back to the far leg head, the detail that says cantilever.
    const tie = spanX([span / 2 + boom - m, height + m * 1.4, 0], [-span / 2 + m, height + m * 3.2, 0]);
    parts.push(place(bevelBox(tie.length, m * 0.4, m * 0.4, m * 0.1), { pos: tie.pos, rot: tie.rot }));
    parts.push(place(bevelBox(m * 0.6, m * 3.4, m * 0.6, m * 0.12), { pos: [-span / 2 + m, height + m * 1.7, 0] }));
  }
  // Trolley and machinery house.
  parts.push(place(bevelBox(m * 3.4, m * 2.0, m * 2.6, m * 0.2), { pos: [-span * 0.18, height - m * 2.5, 0] }));
  parts.push(place(bevelBox(m * 2.2, m * 1.2, m * 2.0, m * 0.2), { pos: [span * 0.24, height - m * 2.0, 0] }));
  return mergeAll(parts);
}

/**
 * Tapered industrial stack with reinforcing bands and a flared cap. Extends
 * along +Y from the origin.
 * @param {number} height
 * @param {number} radius at the base; the top is 60% of it
 * @param {number} [bands=4]
 */
export function chimney(height, radius, bands = 4) {
  const parts = [place(new THREE.CylinderGeometry(radius * 0.6, radius, height, 14, 1), { pos: [0, height / 2, 0] })];
  for (let i = 1; i <= bands; i++) {
    const t = i / (bands + 1);
    const r = radius * (1 - 0.4 * t) * 1.08;
    parts.push(place(new THREE.CylinderGeometry(r, r, height * 0.012 + 0.06, 14, 1), { pos: [0, t * height, 0] }));
  }
  parts.push(place(new THREE.CylinderGeometry(radius * 0.72, radius * 0.58, height * 0.03 + 0.2, 14, 1), { pos: [0, height, 0] }));
  return mergeAll(parts);
}

/**
 * A pipe run with flanges at each joint. The flanges are what stop a tube from
 * reading as a bent cylinder.
 */
export function pipeRun(points, radius, opts = {}) {
  const parts = [tube(points, radius, opts.radialSegments ?? 9)];
  const flangeEvery = opts.flangeEvery ?? 1;
  for (let i = 0; i < points.length; i++) {
    if (i % flangeEvery !== 0) continue;
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dir = new THREE.Vector3().subVectors(
      b instanceof THREE.Vector3 ? b : new THREE.Vector3(...b),
      a instanceof THREE.Vector3 ? a : new THREE.Vector3(...a),
    );
    if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
    dir.normalize();
    const g = new THREE.CylinderGeometry(radius * 1.42, radius * 1.42, radius * 0.55, 12, 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const pv = p instanceof THREE.Vector3 ? p : new THREE.Vector3(...p);
    _m.compose(pv, q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(_m);
    parts.push(g);
  }
  return mergeAll(parts);
}

/**
 * A tapered capsule spanning two points. Limbs are authored as endpoints rather
 * than as a position plus two Euler angles because a pose is easier to reason
 * about — and easier to keep anatomically sane — as "the hand is here".
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} r0 radius at `a`
 * @param {number} [r1=r0] radius at `b`
 * @param {number} [radial=6]
 */
export function segment(a, b, r0, r1 = r0, radial = 6) {
  _v.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _v.length() || 1e-4;
  const geo = new THREE.CylinderGeometry(r1, r0, len, radial, 1, false);
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v.divideScalar(len));
  _m.compose(
    _v.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
    _q,
    _s.set(1, 1, 1),
  );
  geo.applyMatrix4(_m);
  return geo;
}

/**
 * Transform that carries a geometry built along +X and centred on the origin
 * onto the span from `a` to `b`. Beams, jib arms and runway rails are far
 * easier to place — and far harder to get subtly wrong — when they are authored
 * by their two ends rather than by a position and a pair of Euler angles.
 *
 * The rotation is `[0, yaw, pitch]` because three's default XYZ order applies Z
 * first, so the pitch happens in the beam's own frame and the yaw then swings
 * the whole thing round.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {{length:number, pos:number[], rot:number[]}}
 */
export function spanX(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const flat = Math.hypot(dx, dz);
  return {
    length: Math.hypot(flat, dy),
    pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
    rot: [0, Math.atan2(-dz, dx), Math.atan2(dy, flat)],
  };
}

/** Number of distinct body archetypes `crowdFigure` can build. */
export const CROWD_ARCHETYPES = 6;

/**
 * Low-poly onlooker, read only as a silhouette against the practicals.
 *
 * A crowd fails on repetition long before it fails on polygon count, and a
 * capsule with no arms repeats worse than anything: every instance shares one
 * outline no matter how it is scaled or turned. So the figure is posed from
 * endpoints — six archetypes covering the postures a barrier crowd actually
 * holds — and the arms are always built, because the gap between an arm and the
 * ribcage is the one hole that tells the eye it is looking at a person.
 *
 * Clothing is separated into an `aTone` vertex mask rather than left to one flat
 * tint, and the mask has five bands rather than three. A crowd where the heads
 * share the value of the coats is a row of bollards — but a crowd of *bare*
 * heads is worse, because at twelve metres a skull is one bright oval per person
 * and forty identical ovals in a line read as a shelf of shop mannequins. Hair
 * cuts that oval down to a face and gives the head a third value.
 *
 * The jacket/trousers split is the same argument one step down the figure. An
 * earlier pass drew it in the shader off a height threshold, which cannot work:
 * the threshold is one number in the figure's local space and the figures are
 * scaled per instance, so the waistline slid up and down the body and on the
 * short ones landed above the hips. Cut here, it lands on the actual garment
 * every time, and shoes and headwear come out as a fifth value — the two places
 * on a person that are reliably darker than anything they are wearing.
 *
 * @param {number} [seed] varies proportion, stance, hair and headwear within an
 *   archetype
 * @param {number} [archetype] 0 stand, 1 cheer, 2 lean on rail, 3 arms folded,
 *   4 filming, 5 hunched with hands pocketed
 * @returns {THREE.BufferGeometry} origin at the feet, facing -Z, carrying a
 *   float `aTone` attribute: 0 jacket, 1 bare skin, 2 hair, 3 trousers,
 *   4 shoes/headwear/bag
 */
export function crowdFigure(seed = 0, archetype = 0) {
  const r = (n) => {
    const s = Math.sin(seed * 12.9898 + n * 78.233 + archetype * 31.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const k = archetype % CROWD_ARCHETYPES;
  const tall = 0.94 + r(1) * 0.16;
  const bulk = (k === 3 ? 1.16 : 0.86 + r(2) * 0.34) * (0.94 + r(9) * 0.14);
  // A forward pitch off the hips: the difference between a queue and a crowd
  // pressed on a barrier is that half of them are leaning on it.
  const pitch = k === 2 ? 0.34 + r(3) * 0.16 : k === 5 ? 0.16 : r(4) * 0.09;

  const hipY = 0.9 * tall;
  const chestY = 1.32 * tall;
  const shoulderY = 1.44 * tall;
  // Wide enough that the arm clears the ribcage. The hole between arm and body
  // is the only part of this figure that carries any information at twenty
  // metres — close that gap and it collapses straight back into a capsule.
  const shoulderX = 0.26 * bulk;
  // Five tone runs, kept as separate piles so the mask is filled from four
  // vertex offsets instead of tagged primitive by primitive.
  const parts = [];   // jacket
  const trews = [];   // trousers
  const kit = [];     // shoes, headwear, bag, the camera in archetype 4
  const skin = [];
  const hair = [];

  // Everything above the waist is rotated about the hip pivot, so a lean moves
  // the shoulders, the head and both hands together instead of shearing them.
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const at = (x, y, z = 0) => {
    const dy = y - hipY;
    return [x, hipY + dy * cp + z * sp, z * cp - dy * sp];
  };

  // Legs: a stance width and a knee that is never dead straight.
  const stance = k === 2 || k === 3 ? 0.15 : 0.1;
  for (const s of [-1, 1]) {
    const foot = [s * (stance + r(10 + s) * 0.05), 0, (r(12 + s) - 0.5) * 0.14];
    const knee = [s * (stance + 0.02), hipY * 0.5, foot[2] * 0.4 + 0.03];
    const hip = [s * 0.085 * bulk, hipY, 0];
    trews.push(segment(hip, knee, 0.078 * bulk, 0.062 * bulk));
    trews.push(segment(knee, foot, 0.06 * bulk, 0.048 * bulk));
    kit.push(place(new THREE.BoxGeometry(0.09, 0.05, 0.2), { pos: [foot[0], 0.025, foot[2] - 0.03] }));
  }

  // Torso: hips, ribcage, shoulder yoke.
  parts.push(segment(at(0, hipY - 0.04), at(0, chestY), 0.14 * bulk, 0.15 * bulk, 7));
  parts.push(place(new THREE.CapsuleGeometry(0.16 * bulk, 0.14 * tall, 3, 7), {
    pos: at(0, chestY + 0.03), rot: [-pitch, 0, 0], scale: [1.08, 1, 0.76],
  }));
  const shL = at(-shoulderX, shoulderY);
  const shR = at(shoulderX, shoulderY);
  parts.push(segment(shL, shR, 0.075 * bulk, 0.075 * bulk));

  // Head, neck, hair and one of four hat silhouettes.
  const neck = at(0, shoulderY + 0.02);
  const head = at(0, shoulderY + 0.19 * tall, 0.02);
  const headR = 0.098 * tall;
  skin.push(segment(neck, head, 0.05, 0.054));
  // Narrower than it is deep. A head modelled on a round sphere reads wide from
  // the front, and a row of wide heads is the mannequin look again.
  skin.push(place(new THREE.SphereGeometry(headR, 8, 6), { pos: head, scale: [0.88, 1.1, 0.98] }));
  const hat = (r(5) * 4) | 0;

  // Hair, in three states: a full head bare, a cropped cap under a hat, and a
  // shaved minority. The figure faces -Z, so the mass is offset toward +Z and
  // the face stays clear of it.
  if (r(7) > 0.15) {
    const capped = hat !== 3;
    hair.push(place(new THREE.SphereGeometry(
      headR * 1.06, 8, 5, 0, Math.PI * 2, capped ? Math.PI * 0.24 : 0, Math.PI * (capped ? 0.4 : 0.6),
    ), {
      pos: [head[0], head[1] - (capped ? headR * 0.12 : 0), head[2] + headR * 0.11],
      scale: [0.93, 1.05, 1.0],
    }));
    // Long hair on a third of them. The mass down the neck is a silhouette no
    // cropped head in the rank next to it can produce, and it survives being
    // three pixels tall better than any amount of detail on the face does.
    if (r(8) > 0.68) {
      hair.push(place(new THREE.CapsuleGeometry(headR * 0.66, headR * 1.2, 3, 7), {
        pos: [head[0], head[1] - headR * 1.2, head[2] + headR * 0.7],
        scale: [1.06, 1, 0.58],
      }));
    }
  }
  if (hat === 0) {
    kit.push(place(new THREE.CylinderGeometry(0.108 * tall, 0.104 * tall, 0.08, 9), { pos: [head[0], head[1] + 0.07, head[2]] }));
    kit.push(place(bevelBox(0.2, 0.02, 0.13, 0.008), { pos: [head[0], head[1] + 0.035, head[2] - 0.12], rot: [0.12, 0, 0] }));
  } else if (hat === 1) {
    kit.push(place(new THREE.SphereGeometry(0.113 * tall, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), { pos: [head[0], head[1] + 0.01, head[2]] }));
  } else if (hat === 2) {
    // Hood: a shell behind the head that widens the silhouette at the shoulders.
    // It stays on the jacket run — a hood is part of the coat, and giving it the
    // headwear value put a dark cap on a light coat that read as a second head.
    parts.push(place(new THREE.SphereGeometry(0.145 * tall, 9, 7), { pos: [head[0], head[1] - 0.02, head[2] + 0.06], scale: [1, 1.05, 0.85] }));
  }
  if (r(6) > 0.72) {
    kit.push(place(bevelBox(0.26 * bulk, 0.34 * tall, 0.16, 0.03), { pos: at(0, chestY + 0.02, 0.22 * bulk) }));
  }

  // Arms. Every archetype places the elbow and the hand explicitly; the wrong
  // elbow height is what makes a posed figure read as a mannequin.
  const armR = 0.052 * bulk;
  for (const s of [-1, 1]) {
    const sh = s < 0 ? shL : shR;
    let elbow, hand;
    if (k === 1) {
      elbow = at(s * (shoulderX + 0.13), shoulderY + 0.2 * tall, -0.02);
      hand = at(s * (shoulderX + 0.08), shoulderY + 0.42 * tall, -0.08);
    } else if (k === 2) {
      elbow = at(s * (shoulderX + 0.06), shoulderY - 0.28 * tall, -0.1);
      hand = at(s * (shoulderX - 0.02), shoulderY - 0.3 * tall, -0.34);
    } else if (k === 3) {
      elbow = at(s * (shoulderX + 0.11), shoulderY - 0.3 * tall, 0.02);
      hand = at(-s * 0.09, shoulderY - 0.24 * tall, -0.19 * bulk);
    } else if (k === 4 && s > 0) {
      elbow = at(s * (shoulderX + 0.11), shoulderY - 0.12 * tall, -0.08);
      hand = at(s * 0.13, shoulderY + 0.16 * tall, -0.22);
      kit.push(place(bevelBox(0.075, 0.14, 0.014, 0.005), { pos: [hand[0], hand[1] + 0.06, hand[2] - 0.02], rot: [0.2, 0, 0.1] }));
    } else if (k === 5) {
      elbow = at(s * (shoulderX + 0.15), shoulderY - 0.32 * tall, 0.04);
      hand = at(s * 0.12, hipY + 0.02, -0.13);
    } else {
      const swing = (r(20 + s) - 0.5) * 0.4;
      elbow = at(s * (shoulderX + 0.05), shoulderY - 0.3 * tall, -0.02 + swing * 0.2);
      hand = at(s * (shoulderX + 0.02), shoulderY - 0.6 * tall, swing * 0.3);
    }
    // The sleeve runs to the wrist and only the fist is bare. A hand modelled
    // as a ball the width of the forearm puts a second bright dot beside every
    // face, which is twice the number of light spots a crowd should have.
    parts.push(segment(sh, elbow, armR * 1.15, armR));
    parts.push(segment(elbow, hand, armR, armR * 0.82));
    skin.push(place(new THREE.SphereGeometry(armR * 0.95, 6, 4), { pos: hand }));
  }

  // Five contiguous runs in mask order, so the whole attribute is four `fill`
  // calls over one array rather than a tag on every primitive.
  const runs = [[parts, 0], [skin, 1], [hair, 2], [trews, 3], [kit, 4]]
    .filter(([list]) => list.length)
    .map(([list, tone]) => {
      const g = mergeAll(list);
      return { g, tone, n: g.attributes.position.count };
    });
  const geo = mergeAll(runs.map((r) => r.g));
  const mask = new Float32Array(geo.attributes.position.count);
  let off = 0;
  for (const r of runs) {
    if (r.tone) mask.fill(r.tone, off, off + r.n);
    off += r.n;
  }
  geo.setAttribute('aTone', new THREE.Float32BufferAttribute(mask, 1));
  return geo;
}

/**
 * A shallow inset panel: a frame plus a recessed face. Used everywhere on
 * walls and machinery to break up flat surfaces with real, shadow-catching
 * depth instead of a painted line.
 */
export function insetPanel(w, h, depth = 0.06, frame = 0.07) {
  const parts = [];
  parts.push(place(bevelBox(w, h, depth * 0.5, 0.012), { pos: [0, 0, -depth * 0.75] }));
  parts.push(place(bevelBox(w, frame, depth, 0.012), { pos: [0, h / 2 - frame / 2, 0] }));
  parts.push(place(bevelBox(w, frame, depth, 0.012), { pos: [0, -h / 2 + frame / 2, 0] }));
  parts.push(place(bevelBox(frame, h - frame * 2, depth, 0.012), { pos: [-w / 2 + frame / 2, 0, 0] }));
  parts.push(place(bevelBox(frame, h - frame * 2, depth, 0.012), { pos: [w / 2 - frame / 2, 0, 0] }));
  return mergeAll(parts);
}

/** Ring of bolt heads on the XY plane, facing +Z. */
export function boltRing(radius, count, boltRadius = 0.03, height = 0.02) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    parts.push(place(new THREE.CylinderGeometry(boltRadius, boltRadius * 0.9, height, 6), {
      pos: [Math.cos(a) * radius, Math.sin(a) * radius, height / 2],
      rot: [Math.PI / 2, 0, 0],
    }));
  }
  return mergeAll(parts);
}

/** Row of bolt heads along +X, facing +Z. */
export function boltRow(length, count, boltRadius = 0.028, height = 0.018) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const x = count === 1 ? 0 : -length / 2 + (i * length) / (count - 1);
    parts.push(place(new THREE.CylinderGeometry(boltRadius, boltRadius * 0.85, height, 6), {
      pos: [x, 0, height / 2],
      rot: [Math.PI / 2, 0, 0],
    }));
  }
  return mergeAll(parts);
}

/**
 * Hydraulic ram: barrel, polished rod, gland nut and a feed hose stub. Extends
 * along +Y from the origin.
 */
export function hydraulicRam(barrelLength, rodLength, radius) {
  const parts = [];
  parts.push(place(new THREE.CylinderGeometry(radius, radius, barrelLength, 14, 1), { pos: [0, barrelLength / 2, 0] }));
  parts.push(place(new THREE.CylinderGeometry(radius * 1.2, radius * 1.2, radius * 0.5, 14, 1), { pos: [0, barrelLength - radius * 0.3, 0] }));
  parts.push(place(new THREE.CylinderGeometry(radius * 1.25, radius * 1.25, radius * 0.6, 14, 1), { pos: [0, radius * 0.3, 0] }));
  parts.push(place(new THREE.CylinderGeometry(radius * 0.44, radius * 0.44, rodLength, 12, 1), { pos: [0, barrelLength + rodLength / 2 - 0.02, 0] }));
  parts.push(place(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, radius * 0.4, 12, 1), { pos: [0, barrelLength + rodLength - 0.05, 0] }));
  parts.push(place(new THREE.TorusGeometry(radius * 1.05, radius * 0.16, 6, 12), { pos: [0, barrelLength * 0.22, 0], rot: [Math.PI / 2, 0, 0] }));
  return mergeAll(parts);
}

/** Total triangles in a geometry, for budget accounting. */
export function triCount(geo) {
  if (!geo) return 0;
  return (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
}
