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
 * Low-poly onlooker. Read only as a silhouette against the practicals, so it is
 * built from the shapes a human reads as at 20 metres: shoulders wider than
 * hips, a neck, and arms that break the torso outline.
 * @returns {THREE.BufferGeometry} origin at the feet, facing -Z
 */
export function crowdFigure(seed = 0) {
  const r = (n) => {
    const s = Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  const scale = 0.92 + r(1) * 0.2;
  const bulk = 0.85 + r(2) * 0.4;
  const parts = [];

  const hipY = 0.92 * scale;
  const chestY = 1.34 * scale;
  parts.push(place(new THREE.CapsuleGeometry(0.15 * bulk, 0.34 * scale, 3, 7), { pos: [0, (hipY + chestY) / 2, 0] }));
  parts.push(place(new THREE.CapsuleGeometry(0.19 * bulk, 0.16 * scale, 3, 7), { pos: [0, chestY + 0.1 * scale, 0], scale: [1.25, 1, 0.8] }));
  parts.push(place(new THREE.SphereGeometry(0.105 * scale, 9, 7), { pos: [0, chestY + 0.34 * scale, 0.01] }));
  parts.push(place(new THREE.CylinderGeometry(0.05, 0.055, 0.1 * scale, 6), { pos: [0, chestY + 0.23 * scale, 0] }));

  for (const s of [-1, 1]) {
    const swing = (r(3 + s) - 0.5) * 0.5;
    parts.push(place(new THREE.CapsuleGeometry(0.055 * bulk, 0.5 * scale, 3, 6), {
      pos: [s * 0.22 * bulk, chestY - 0.13 * scale, 0.02],
      rot: [swing, 0, -s * 0.13],
    }));
    parts.push(place(new THREE.CapsuleGeometry(0.078 * bulk, 0.62 * scale, 3, 6), {
      pos: [s * 0.1, hipY - 0.42 * scale, 0],
      rot: [(r(7 + s) - 0.5) * 0.25, 0, 0],
    }));
  }
  return mergeAll(parts);
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
