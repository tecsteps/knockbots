/**
 * Does anything in the arena stand between the lens and a fighter?
 *
 *     node scratchpad/occluders.mjs cistern
 *     node scratchpad/occluders.mjs sublevel09 --poses=wide
 *     node scratchpad/occluders.mjs skydeck --top=6
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `docs/PROFILING.md` carries an open defect titled "a black pole through the
 * fighter in 06-stage-wide". It survived twenty-three rounds of magnified
 * review and was finally caught by a critic reduced to looking at a whole frame
 * at 1x, because nothing in the harness measures that class of defect at all.
 * Set geometry crossing the subject has only ever been found by someone
 * happening to look at the right frame.
 *
 * The argument for an instrument, in one line: of the four occluders this found
 * in `StageVault`, **three were invisible in the captures** — they appear only
 * in poses that are legal for the fight solver but were never photographed. A
 * capture shows you one pose. This shows you every pose.
 *
 * The four, for calibration of what it catches:
 *   - a catenary cable sagging to y 0.55 through the fighters' shins,
 *   - a 2.95m penstock gate at x 6.9, INSIDE the +/-9 play bound,
 *   - marker posts at x -7.8 / +8.6, also inside it,
 *   - a tank wall the camera could get PAST and graze end-on, because the room
 *     stopped at z 9.4 and the fight camera reaches z 13.
 * The middle two were objects a fighter could have walked through, so this is a
 * gameplay audit as much as a visual one.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT RENDER, AND THAT IS THE WHOLE DESIGN
 *
 * Read this before assuming it solved a problem it did not. Two in-page
 * versions of this instrument were built and abandoned: the first masked the
 * subject by colour difference (which cannot separate subject from background,
 * and reported 62-72% on every arena including the pit), and the second
 * repainted the fighters in an unlit key colour — the right idea — but was
 * defeated by the planar mirror drawing them a SECOND time in that same key
 * colour, so the reflection cancelled the occlusion it was being counted
 * against and the cistern came back at -13%. `reflector.enabled = false` does
 * not help, because the floor samples whatever texture the last armed pass left
 * in it.
 *
 * This version does not solve that. It has no mirror because it has no
 * renderer. It builds the arena's modules directly, projects their triangles
 * through a camera matrix on the CPU, and compares depths against analytic
 * capsule proxies for the two fighters. There is no GL context, no lock, no GPU
 * contention, no post chain, no transparency sorting and no second draw of
 * anything. That is why it can sweep 29 framings in a few seconds and why its
 * numbers are stable to the bit.
 *
 * What it therefore CANNOT see, stated plainly so nobody trusts it too far:
 *   - shading. A brightly lit pipe across the subject scores the same as a dead
 *     black one, and the black one is far worse. This answers "is it in the
 *     way", never "does it look wrong".
 *   - anything that moves geometry in a vertex shader (the crowd's sway, the
 *     fan, the drones' per-frame matrices are read at their built pose only).
 *   - alpha cutouts are counted as SOLID. Bar grating and chain-link are mostly
 *     holes; a hit on those is flagged `[cutout]` and should be read as an
 *     upper bound rather than a coverage figure.
 *   - the real fighter meshes. The subject is a capsule of radius 0.42 (from
 *     `FIGHTER_RADIUS`) rather than the 0.55 half-width `FightCamera` composes
 *     against, so it under-reports slightly by construction. Deliberate: a
 *     false negative wastes nobody's time, a false positive burns a round.
 *
 * ---------------------------------------------------------------------------
 * FOUR BUGS THAT MAKE THIS KIND OF AUDIT WORSE THAN NO AUDIT
 *
 * All four were in working versions of this and all four produce confident
 * wrong numbers, which is the failure mode to fear in an instrument — a tool
 * that is merely silent wastes an afternoon; a tool that is confidently wrong
 * sends someone to fix a set that was never broken. Anyone building one of
 * these will hit all four. Three of them were only exposed by running the tool
 * against an arena OTHER than the one it was written for, which is its own
 * lesson about instruments.
 *
 * 1. **A triangle with any vertex at or behind the lens projects to garbage.**
 *    The perspective divide flips sign behind the eye, so a wall the camera is
 *    standing next to comes back as a screen-space smear across the whole
 *    frame. The first run reported 100% occlusion for every wall in every
 *    arena. There is no cheap fix that is also correct — proper near-plane
 *    clipping means splitting triangles — so this rejects any triangle with a
 *    vertex nearer than 0.15m in VIEW space. That under-reports geometry the
 *    camera is literally inside, which is a different defect and a visible one.
 *
 * 2. **Fill the triangle, not its bounding box.** Box-filling is a harmless
 *    approximation for the thousands of small triangles a set is made of, and
 *    it is catastrophic for the few large ones: `StageFloor`'s apron is a 160m
 *    plane drawn as TWO triangles, so its screen bounding box is the whole
 *    frame and every fighter came back 85% occluded by the ground he was
 *    standing on. Depth has to be interpolated perspective-correctly across the
 *    triangle too — interpolating distance linearly in screen space is wrong by
 *    metres on a plane seen at a grazing angle, which is exactly how a floor is
 *    always seen.
 *
 * 3. **Apply each mesh's own object transform.** Almost all arena geometry is
 *    built with world coordinates baked into the vertices and left at the
 *    origin, so ignoring `matrixWorld` costs nothing — for almost everything.
 *    `StageStructure`'s extract fan is positioned rather than baked, and was
 *    tested at the middle of the pit, where it appeared to hide 36% of a
 *    fighter it stands thirteen metres behind. Several arena meshes set
 *    `matrixAutoUpdate = false`, so the matrix must be forced with
 *    `updateMatrixWorld(true)` and not merely read.
 *
 * 4. **The subject must be the fighters' own projected footprints.** The first
 *    version used a fixed screen box (middle third, lower two thirds) as a
 *    proxy for "where the fighters are". That calls a wall BESIDE a cornered
 *    fighter an occluder, because when the pair is pinned to x = 8 the camera
 *    follows them and the wall fills the middle of the frame without ever being
 *    between the lens and a body. Rasterising the capsules and asking only
 *    about the cells they actually cover is the difference between a number
 *    that means something and a number that is merely large.
 *
 * ---------------------------------------------------------------------------
 * A TRAP THIS FOUND THAT IS NOT ABOUT CAMERAS
 *
 * The cistern's cable was authored as `catenary(a, b, sag)` with both endpoints
 * comfortably clear of the play volume, and nobody checked the middle. **A
 * catenary is sited by its EXTENT, not by its endpoints.** A 0.35 sag on a 6.2m
 * span drops the low point nearly two metres below the lower anchor: that cable
 * hung at y 0.55, with 45.2% of its vertices inside the play volume and reaching
 * z -3.13. On rendered frames it read as an unlit black line across the subject
 * at both framings.
 *
 * `GeoKit.catenary` is used in several places and this is a general trap for all
 * of them. In particular **`StageStructure#hangingCable` uses the same primitive
 * with a 0.4 sag over a ~6m span and has never been audited** — run this against
 * `sublevel09` before touching it, and check `#pipework`'s slack cable bundles
 * and `#foreground`'s rope line while you are there.
 *
 * ---------------------------------------------------------------------------
 * READING THE OUTPUT
 *
 * `worst` is the largest fraction of the fighters' combined silhouette hidden
 * by that mesh over every pose swept. Under about 5% is floor furniture — kerbs,
 * debris, a low rail — and is fine. Anything in double figures is a wall and
 * should be moved. The `wide` column is the same figure at the establishing
 * framing, which is the one the stage axis is scored on, and it should be 0.
 *
 * For the top offender it also prints the world-space bounding box of the
 * offending triangles, which is what identifies the culprit inside a merged
 * mesh. That box is how the tank wall was found: `x 11.04..12.10` said "the
 * right wall", and the only question left was why the camera was ever in front
 * of it.
 */

import * as THREE from 'three';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// --- a DOM shim, as scratchpad/setcount.mjs uses --------------------------
globalThis.window ??= globalThis;
globalThis.self ??= globalThis;
globalThis.navigator ??= { userAgent: 'node', getGamepads: () => [] };
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(0), 16);
const el = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, children: [], appendChild(c) { this.children.push(c); return c; }, removeChild() {}, setAttribute() {}, getAttribute: () => null, addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {}, getContext: () => null, width: 1024, height: 1024, insertAdjacentHTML() {}, getBoundingClientRect: () => ({ width: 1920, height: 1080, left: 0, top: 0 }) });
globalThis.document ??= { createElement: el, createElementNS: el, body: el(), documentElement: el(), getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, head: el() };

const ROOT = '/Users/wesner/Workspace/knockbots';
const imp = (p) => import(pathToFileURL(resolve(ROOT, p)).href);

const argv = process.argv.slice(2);
const flag = (n, d) => { const a = argv.find((s) => s.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const arenaArg = argv.find((s) => !s.startsWith('--'));
const TOP = Number(flag('top', 12));
const ONLY = flag('poses', 'all');           // all | wide | fight

const { makeArenaMaterials } = await imp('src/arena/StageMaterials.js');
const { mergeAll } = await imp('src/arena/GeoKit.js');
const { StageFloor } = await imp('src/arena/StageFloor.js');
const { StageWalls } = await imp('src/arena/StageWalls.js');
const { arenaDef, ARENA_IDS } = await imp('src/arena/Arenas.js');
const C = await imp('src/core/Constants.js');

const def = arenaDef(arenaArg ?? 'sublevel09');
if (arenaArg && !ARENA_IDS.includes(arenaArg)) {
  console.log(`unknown arena "${arenaArg}" — known: ${ARENA_IDS.join(', ')}\n`);
}

// ---------------------------------------------------------------------------
// Build the arena, headless
// ---------------------------------------------------------------------------

const lib = makeArenaMaterials({ quality: 'high' });
const bins = { dark: [], steel: [], concrete: [], hazard: [], grate: [], chain: [], container: [], plate: [], banner: [] };

/**
 * Mirrors `Stage#commitBins`. Duplicated rather than imported because `Stage`
 * needs a renderer, a scene and a reflector to construct; if that spec changes,
 * change it here too. Only the material matters to this tool, and only for
 * deciding whether a bin can occlude at all.
 */
const BIN_MATERIAL = {
  concrete: 'concrete', hazard: 'hazard', steel: 'steel', dark: 'darkMetal',
  container: 'container', grate: 'grating', chain: 'chainLink',
  plate: 'warningPlate', banner: 'barrierBanner',
};

// The floor needs a reflector; nothing here renders, so a stub is enough.
const reflector = { texture: null, textureMatrix: new THREE.Matrix4(), render() {}, exclude() {} };
const floor = new StageFloor({
  reflector, materials: lib.materials, textures: lib.textures, bins,
  quality: 'medium', surface: def.surface,
});
const walls = new StageWalls({ materials: lib.materials, textures: lib.textures, bins, barrier: def.barrier });
const set = new def.Set({
  environment: { quality: 'high', params: null },
  materials: lib.materials, textures: lib.textures, bins, quality: 'high',
});

/** @type {{name:string, geo:THREE.BufferGeometry, inst:?THREE.InstancedMesh, cutout:boolean}[]} */
const meshes = [];
const canOcclude = (m) => {
  if (!m) return true;
  // Additive pools, multiplicative washes, decals and contact shadows tint the
  // fighter; they do not hide him.
  if (m.transparent || m.depthWrite === false) return false;
  return true;
};
for (const group of [set.group, floor.group, walls.group]) {
  // Most arena geometry is built with world coordinates baked into the vertices
  // and sits at the origin, which is why ignoring the object transform went
  // unnoticed — until `StageStructure`'s extract fan, which IS positioned
  // (-6.2, 6.3, -13.4) and was therefore being tested at the middle of the pit,
  // where it "occluded" 36% of a fighter it is thirteen metres behind. Several
  // of these meshes set `matrixAutoUpdate = false`, so the world matrix has to
  // be forced rather than assumed.
  group?.updateMatrixWorld(true);
  group?.traverse((o) => {
    if (!o.geometry || o.visible === false) return;
    if (!canOcclude(o.material)) return;
    meshes.push({
      name: o.name || o.type, geo: o.geometry,
      inst: o.isInstancedMesh ? o : null,
      world: o.matrixWorld.clone(),
      cutout: (o.material?.alphaTest ?? 0) > 0,
    });
  });
}
for (const [k, list] of Object.entries(bins)) {
  if (!list?.length) continue;
  const mat = lib.materials[BIN_MATERIAL[k]];
  if (!canOcclude(mat)) continue;
  meshes.push({ name: `bin:${k}`, geo: mergeAll(list), inst: null, world: new THREE.Matrix4(), cutout: (mat?.alphaTest ?? 0) > 0 });
}

// ---------------------------------------------------------------------------
// Cameras
//
// A REIMPLEMENTATION of `FightCamera#framingFight` and `#framingWide`, not a
// call into them — driving the real solver needs two rigged fighters with live
// skeletons. It is deliberately swept WIDER than the shipped solver produces
// (more separations, more depths, both fov extremes) so the audit is
// conservative: the point is to cover poses no capture will ever contain, not
// to reproduce one camera to the centimetre.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const ASPECT = 16 / 9;
const MARGIN = { top: 0.32, bottom: 0.34, side: 0.36 };
const BODY_HALF_WIDTH = 0.55;

function fightCamera(mx, mz, sep) {
  const t = THREE.MathUtils.clamp((sep - 0.9) / (C.MAX_PAIR_DISTANCE - 0.9), 0, 1);
  const fov = THREE.MathUtils.lerp(31, 43, Math.pow(t, 0.7));
  const top = C.FIGHTER_HEIGHT + MARGIN.top;
  const bottom = -MARGIN.bottom;
  const focus = new THREE.Vector3(mx, (top + bottom) * 0.5, mz);
  const halfH = (top - bottom) * 0.5;
  const halfW = sep * 0.5 + BODY_HALF_WIDTH + MARGIN.side;
  const tanH = Math.tan(fov * 0.5 * DEG);
  const dist = THREE.MathUtils.clamp(Math.max(halfH / tanH, halfW / (tanH * ASPECT)), 3.4, 16);
  const yaw = THREE.MathUtils.clamp(-mx * 0.02, -0.14, 0.14);
  const pitch = THREE.MathUtils.lerp(5, 9, t) * DEG;
  const horiz = Math.cos(pitch) * dist;
  const pos = new THREE.Vector3(
    focus.x + Math.sin(yaw) * horiz,
    Math.max(focus.y + Math.sin(pitch) * dist, C.GROUND_Y + 1.0),
    focus.z + Math.cos(yaw) * horiz,
  );
  return mk(pos, focus, fov);
}
function wideCamera(mx, mz, sep) {
  const fov = 34;
  const top = C.FIGHTER_HEIGHT + 1.35;
  const bottom = -0.9;
  const focus = new THREE.Vector3(mx * 0.6, (top + bottom) * 0.5, mz * 0.5);
  const yaw = 0.16;
  const dist = Math.max(14, (top - bottom) * 0.5 / Math.tan(fov * 0.5 * DEG));
  return mk(new THREE.Vector3(focus.x + Math.sin(yaw) * dist, C.GROUND_Y + 4.5, focus.z + Math.cos(yaw) * dist), focus, fov);
}
function mk(pos, look, fov) {
  const c = new THREE.PerspectiveCamera(fov, ASPECT, 0.1, 400);
  c.position.copy(pos);
  c.lookAt(look);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

/** Legal poses only: a fighter cannot leave the play bound. */
const REACH = C.ARENA_HALF_WIDTH - 0.4;
const cases = [];
for (const mz of [0, -4, 4, -5.5, 5.5]) {
  for (const mx of [-8, -4, 0, 4, 8]) {
    for (const sep of [2.5, 5, 8]) {
      const a = THREE.MathUtils.clamp(mx - sep / 2, -REACH, REACH);
      const b = THREE.MathUtils.clamp(mx + sep / 2, -REACH, REACH);
      const f = [{ x: a, z: mz }, { x: b, z: mz }];
      // Solve the camera from the pose that SURVIVED the clamp, not from the
      // one that was asked for. Clamping the fighters to the play bound without
      // re-deriving the midpoint and separation places the lens for a pair that
      // is not there — it sits metres too far back, and every wall in the room
      // then appears to occlude. That is a harness defect that reads exactly
      // like a set defect, which is the worst kind.
      const emx = (a + b) * 0.5;
      const esep = Math.abs(b - a);
      if (esep < 0.6) continue;
      const label = `x${emx.toFixed(1)} z${mz >= 0 ? '+' : ''}${mz} sep${esep.toFixed(1)}`;
      if (ONLY !== 'wide') cases.push({ n: `fight ${label}`, c: fightCamera(emx, mz, esep), f, wide: false });
      if (ONLY !== 'fight' && mx === 0 && sep === 2.5) cases.push({ n: `wide ${label}`, c: wideCamera(emx, mz, esep), f, wide: true });
    }
  }
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

const GW = 160, GH = 90;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _m = new THREE.Matrix4(), _w = new THREE.Matrix4();
const NEAR_EPS = 0.15;

/** View-space first: see bug 1 in the header. */
function project(o, cam) {
  const d = o.distanceTo(cam.position);
  o.applyMatrix4(cam.matrixWorldInverse);
  const vz = o.z;
  o.applyMatrix4(cam.projectionMatrix);
  return [(o.x * 0.5 + 0.5) * GW, (1 - (o.y * 0.5 + 0.5)) * GH, vz, d];
}

/** Screen mask of the two fighters, carrying the nearest depth per cell. */
function subjectMask(cam, fighters) {
  const mask = new Float32Array(GW * GH).fill(Infinity);
  let n = 0;
  for (const f of fighters) {
    for (let s = 0; s <= 10; s++) {
      for (let a = 0; a < 14; a++) {
        const th = (a / 14) * Math.PI * 2;
        // From 0.25m, not from the soles. The bottom of a fighter's silhouette
        // is where his feet meet the deck, and a floor plane seen nearly
        // edge-on from a low camera always has triangles a metre in front of
        // that contact point projecting onto the same cell — so including the
        // feet reports the FLOOR as occluding the fighter standing on it. It is
        // also not a part of the silhouette any critic reads.
        _t.set(f.x + Math.cos(th) * C.FIGHTER_RADIUS, 0.25 + (s / 10) * (C.FIGHTER_HEIGHT - 0.3), f.z + Math.sin(th) * C.FIGHTER_RADIUS);
        const q = project(_t, cam);
        if (q[2] > -NEAR_EPS) continue;
        const X = Math.round(q[0]), Y = Math.round(q[1]);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = X + dx, y = Y + dy;
            if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
            const k = y * GW + x;
            if (mask[k] === Infinity) n++;
            if (q[3] < mask[k]) mask[k] = q[3];
          }
        }
      }
    }
  }
  return { mask, n };
}

/**
 * @returns {{frac:number, box:?THREE.Box3}} fraction of the subject hidden, and
 *   the world bounds of the triangles that hid it.
 */
function occlusion(entry, cam, sub, wantBox) {
  if (!sub.n) return { frac: 0, box: null };
  const p = entry.geo.attributes.position;
  const count = entry.inst ? entry.inst.count : 1;
  const hit = new Uint8Array(GW * GH);
  const box = wantBox ? new THREE.Box3() : null;
  for (let inst = 0; inst < count; inst++) {
    // Object transform, then the instance transform on top of it.
    if (entry.inst) { entry.inst.getMatrixAt(inst, _m); _w.multiplyMatrices(entry.world, _m); }
    else _w.copy(entry.world);
    for (let i = 0; i < p.count; i += 3) {
      _a.fromBufferAttribute(p, i); _b.fromBufferAttribute(p, i + 1); _c.fromBufferAttribute(p, i + 2);
      _a.applyMatrix4(_w); _b.applyMatrix4(_w); _c.applyMatrix4(_w);
      const wa = wantBox ? _a.clone() : null, wb = wantBox ? _b.clone() : null, wc = wantBox ? _c.clone() : null;
      const A = project(_a, cam), B = project(_b, cam), C2 = project(_c, cam);
      if (A[2] > -NEAR_EPS || B[2] > -NEAR_EPS || C2[2] > -NEAR_EPS) continue;   // bug 1
      const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C2[0]))), x1 = Math.min(GW - 1, Math.ceil(Math.max(A[0], B[0], C2[0])));
      const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C2[1]))), y1 = Math.min(GH - 1, Math.ceil(Math.max(A[1], B[1], C2[1])));
      if (x1 < x0 || y1 < y0) continue;
      // Edge functions, so the TRIANGLE is filled rather than its bounding box.
      // See bug 3 in the header: the floor apron is a 160m plane drawn as two
      // triangles, and box-filling it marks every cell on screen as covered by
      // the ground the fighter is standing on.
      const area = (B[0] - A[0]) * (C2[1] - A[1]) - (C2[0] - A[0]) * (B[1] - A[1]);
      if (Math.abs(area) < 1e-9) continue;
      const inv = 1 / area;
      // Perspective-correct depth: the reciprocal is what interpolates linearly
      // in screen space. Interpolating distance directly across a plane seen at
      // a grazing angle is wrong by metres.
      const ra = 1 / A[3], rb = 1 / B[3], rc = 1 / C2[3];
      let touched = false;
      for (let y = y0; y <= y1; y++) {
        const py = y + 0.5;
        for (let x = x0; x <= x1; x++) {
          const k = y * GW + x;
          if (sub.mask[k] === Infinity) continue;
          const px = x + 0.5;
          let w0 = ((B[0] - A[0]) * (py - A[1]) - (px - A[0]) * (B[1] - A[1])) * inv;
          let w1 = ((px - A[0]) * (C2[1] - A[1]) - (C2[0] - A[0]) * (py - A[1])) * inv;
          if (w0 < -0.02 || w1 < -0.02 || w0 + w1 > 1.02) continue;
          const u = 1 - w0 - w1;
          const d = 1 / (u * ra + w1 * rb + w0 * rc);
          // 0.30m of slack so geometry a fighter is standing against is not
          // counted as standing in front of him.
          if (d < sub.mask[k] - 0.30) { hit[k] = 1; touched = true; }
        }
      }
      if (touched && box) { box.expandByPoint(wa); box.expandByPoint(wb); box.expandByPoint(wc); }
    }
  }
  let h = 0;
  for (let k = 0; k < GW * GH; k++) if (hit[k]) h++;
  return { frac: h / sub.n, box };
}

// ---------------------------------------------------------------------------

const t0 = Date.now();
const subs = cases.map((k) => subjectMask(k.c, k.f));
const rows = [];
for (const e of meshes) {
  let worst = 0, worstIdx = -1, wide = 0;
  for (let i = 0; i < cases.length; i++) {
    const r = occlusion(e, cases[i].c, subs[i], false).frac;
    if (cases[i].wide) wide = Math.max(wide, r);
    if (r > worst) { worst = r; worstIdx = i; }
  }
  if (worst > 0.001) rows.push({ name: e.name, worst, wide, idx: worstIdx, cutout: e.cutout, entry: e });
}
rows.sort((a, b) => b.worst - a.worst);

const fmt = (v) => `${(v * 100).toFixed(1)}%`.padStart(6);
console.log(`\n  ${def.id} — ${def.name}`);
console.log(`  ${cases.length} framings swept, ${GW}x${GH} raster, ${meshes.length} occluding meshes, ${Date.now() - t0}ms\n`);
console.log(`  ${'MESH'.padEnd(34)}${'WORST'.padStart(6)}  ${'WIDE'.padStart(6)}   POSE`);
if (!rows.length) console.log('  nothing in the set occludes a fighter at any framing swept');
for (const r of rows.slice(0, TOP)) {
  console.log(`  ${(r.name + (r.cutout ? ' [cutout]' : '')).padEnd(34)}${fmt(r.worst)}  ${fmt(r.wide)}   ${cases[r.idx].n}`);
}

// The diagnostic that identifies a culprit inside a merged mesh.
const top = rows[0];
if (top && top.worst > 0.02) {
  const k = cases[top.idx];
  const { box } = occlusion(top.entry, k.c, subs[top.idx], true);
  if (box && !box.isEmpty()) {
    const f = (v) => v.toArray().map((n) => n.toFixed(2)).join(', ');
    console.log(`\n  worst offender "${top.name}" at ${k.n}`);
    console.log(`  camera        ${f(k.c.position)}   fov ${k.c.fov.toFixed(1)}`);
    console.log(`  fighters      ${k.f.map((p) => `(${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).join('  ')}`);
    console.log(`  offending triangles occupy  min(${f(box.min)})  max(${f(box.max)})`);
  }
}

const verdict = !rows.length ? 'clean'
  : rows[0].worst < 0.05 ? `clean — worst is ${fmt(rows[0].worst).trim()}, floor-furniture scale`
  : rows[0].worst < 0.12 ? `MARGINAL — "${rows[0].name}" hides ${fmt(rows[0].worst).trim()} of a fighter`
  : `FAIL — "${rows[0].name}" hides ${fmt(rows[0].worst).trim()} of a fighter; that is a wall`;
console.log(`\n  verdict: ${verdict}`);
if (rows.some((r) => r.wide > 0.02)) console.log('  NOTE: something occludes at the WIDE framing, which is the scored one.');
console.log('');

set.dispose?.();
floor.dispose?.();
walls.dispose?.();
lib.dispose?.();
