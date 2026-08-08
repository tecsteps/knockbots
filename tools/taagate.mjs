/**
 * taagate -- the TEMPORAL SUPERSAMPLING GATE.
 *
 * Same metric, same rig, same controls as tools/ssgate.mjs, with the temporal
 * arms added. ssgate is left untouched and still runs; this file exists because
 * adding arms to the tool that pinned the ground truth would make it impossible
 * to re-run the ground truth without the thing being tested in the chain.
 *
 *     THE METRIC: RMSE against the 4x-integrated frame, over SUBJECT PIXELS,
 *     8-bit luma. LOWER IS BETTER. It is not a micro-contrast metric and it is
 *     not up for renegotiation -- see the long note at the top of ssgate.mjs
 *     for why every sharpness-shaped metric is wrong-signed here.
 *
 * ONE browser process, ONE pinned frame ('01-hero-idle' framing, tick 96, sim
 * paused, clock at dt 0, camera parked), rendered many ways. The cross-session
 * pixel noise floor is ~197,000 differing pixels on an identical scene tree, so
 * before and after MUST be captured in the same page. They are.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TEMPORAL ARMS ARE, AND WHAT A PARKED CAMERA CAN AND CANNOT PROVE
 * ---------------------------------------------------------------------------
 * The frame is frozen, so these arms measure the CONVERGED, STATIC case: eight
 * Halton offsets accumulated over ~50 frames with nothing moving. That is the
 * best case for temporal accumulation and it is stated as such. The rig cannot
 * see ghosting, because nothing ghosts when nothing moves. What it CAN prove is
 * the thing the brief asks for -- that jittered accumulation recovers the edge
 * detail only a 4x supersample currently has -- and it proves it against a
 * reference that counts aliasing as error.
 *
 * Ghosting is argued separately and NOT by this tool: by the 3x3 neighbourhood
 * clamp in the pass, and by the frame-time and visual work outside it.
 *
 * ---------------------------------------------------------------------------
 * CONTROLS. Four kinds. The SETUP ones matter most, and two of them are new.
 * ---------------------------------------------------------------------------
 *   SETUP-1  Every arm records the ARMED PASS LIST at the moment it renders and
 *            is asserted against the list its mode requires. Mismatch = VOID.
 *            Only setEffect() is ever called; flags are never written directly.
 *            (RenderPipeline.effects is a plain object and writing it rebuilds
 *            NOTHING -- that hazard silently voided an earlier round.)
 *   SETUP-2  FEEDBACK ZERO. The temporal pass is armed, in the chain, asserted
 *            in the pass list -- and its history weight is set to 0. It must
 *            then reproduce the bare arm to within float noise. If it does not,
 *            the pass is changing the frame for some reason other than
 *            accumulation and every number after it is worthless.
 *   SETUP-3  JITTER ZERO. Pass armed, feedback at its shipped 0.90, projection
 *            jitter forced to zero. On a frozen frame every accumulated sample
 *            is then IDENTICAL, so the converged history is the current frame
 *            and the arm must again reproduce the bare arm. This isolates the
 *            sub-pixel jitter as the mechanism: anything the temporal arm gains
 *            over this one was bought by sampling, not by blurring.
 *   NULL     The same arm captured twice, separated by every other arm.
 *            Including a TEMPORAL null: the jitter index and the history are
 *            reset per arm, so an accumulation is reproducible and its null
 *            must be bit-exact like everyone else's.
 *   POSITIVE renderScale 0.50 must land FURTHER from truth than the shipped
 *            arm. The SIGN is the assertion.
 *   WARM     A bare arm captured at two different warm-frame counts must be
 *            bit-identical (the non-temporal path is deterministic), and a
 *            temporal arm captured at three warm counts must have CONVERGED --
 *            if it is still moving at the measured frame, the number is a
 *            transient rather than a result.
 *
 *   node tools/taagate.mjs
 *   node tools/taagate.mjs --json scratchpad/taagate.json --png scratchpad/taagate-png
 *   node tools/taagate.mjs --shipped-block          (adds the full chain, slow)
 *
 * NOTE ON THIS FILE: it writes GLSL-adjacent JS inside template literals. A
 * backtick anywhere below, even inside a comment inside a literal, silently
 * ends the string. There are none. Keep it that way.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(arg('port', 5262));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const TRUTH = Number(arg('truth', 4));
const PIN = Number(arg('pin', 96));
const JSON_OUT = arg('json', '');
const KEEP_PNG = arg('png', '');
/** Warm renders before the measured one, for the non-temporal arms. */
const WARM = Number(arg('warm', 16));
/**
 * Warm renders for the temporal arms. 56, and the number is arithmetic rather
 * than taste: with a history weight of 0.90 the very first frame of an
 * accumulation still carries 0.90^n of the result, so n=16 leaves 18.5% of the
 * pixel sitting on one arbitrary jitter phase and n=56 leaves 0.3%. The
 * convergence control below measures the residual instead of assuming it.
 */
const WARM_TAA = Number(arg('warmtaa', 56));
const WANT_SHIPPED = argv.includes('--shipped-block');
const OFF_BY = Number(arg('offby', 8));

/** The established fight framing. Asserted, not assumed. */
const FRAMING_REF = { dist: 4.59, fov: 35.5, pxPerM: 367 };
/** The pass lists each mode must produce, as _passes keys. Asserted per arm. */
const EXPECT_PASSES = {
  bare: 'render,output',
  taa: 'render,taa,output',
  smaa: 'render,smaa,output',
  shipped: 'scene,gbuffer,ao,bloom,dof,motionBlur,taa,grade,output',
  shippedSmaa: 'scene,gbuffer,ao,bloom,dof,motionBlur,grade,smaa,output',
};

/* ---------------------------------------------------------------------------
 * PAGE-SIDE CODE. Everything below runs inside the browser.
 * ------------------------------------------------------------------------ */

const PIN_CLOCK = `
  if (!window.__kbClock) window.__kbClock = window.KB.clock.getDelta.bind(window.KB.clock);
  window.KB.timeScale = 1;
  window.KB.clock.getDelta = () => 1 / 60;
`;

/**
 * Freeze the frame. Same five things ssgate learned to stop: the sim, the
 * clock, the camera rig, the grade's per-frame grain/chroma, and adaptive
 * resolution.
 */
const FREEZE = `(() => {
  const KB = window.KB, THREE = KB.THREE, cam = KB.camera;
  KB.paused = true;
  KB.clock.getDelta = () => 0;

  const pos = cam.position.clone();
  const quat = cam.quaternion.clone();
  const fov = cam.fov;
  const park = () => {
    cam.position.copy(pos);
    cam.quaternion.copy(quat);
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld(true);
  };
  KB.fightCamera.render = park;
  KB.fightCamera.simulate = () => {};
  park();

  const r = KB.renderer;
  r.effects.adaptiveResolution = false;
  if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });

  const f0 = KB.fighters[0], f1 = KB.fighters[1];
  const mid = f0.robot.group.position.clone().add(f1.robot.group.position).multiplyScalar(0.5);
  const box = new THREE.Box3().setFromObject(f0.robot.group);
  const c = box.getCenter(new THREE.Vector3());
  const top = new THREE.Vector3(c.x, box.max.y, c.z).project(cam);
  const bot = new THREE.Vector3(c.x, box.min.y, c.z).project(cam);
  const h = Math.abs(top.y - bot.y) / 2 * window.innerHeight;
  return {
    dist: +cam.position.distanceTo(mid).toFixed(3),
    fov: +cam.fov.toFixed(2),
    pxPerM: +(h / Math.max(1e-6, box.max.y - box.min.y)).toFixed(1),
    phaseTicks: KB.phaseTicks,
    tick: KB.tick,
    adaptive: r.effects.adaptiveResolution,
  };
})()`;

/** SETUP CONTROL. Read the composer's ACTUAL pass array, not the flags. */
const PASSES_JS = `(() => {
  const r = window.KB.renderer;
  return {
    keys: Object.keys(r._passes || {}).join(','),
    armed: (r.composer ? r.composer.passes : []).map((p) => p.constructor.name).join(' '),
    flags: Object.assign({}, r.effects),
    renderScale: r.renderScale,
    drawingBuffer: r.canvas.width + 'x' + r.canvas.height,
  };
})()`;

/**
 * setEffect, and ONLY setEffect. Returns the pass list before and after so the
 * caller can assert the composer was really rebuilt -- a flag moving is not
 * evidence.
 */
const SET_MODE_JS = `((want) => {
  const r = window.KB.renderer;
  const keysOf = () => Object.keys(r._passes || {}).join(',');
  const armedOf = () => (r.composer ? r.composer.passes : []).map((p) => p.constructor.name).join(' ');
  const before = { keys: keysOf(), armed: armedOf() };
  for (const name of ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'taa']) {
    if (name in want) r.setEffect(name, !!want[name]);
  }
  const after = { keys: keysOf(), armed: armedOf() };
  return { before, after, changed: before.keys !== after.keys || before.armed !== after.armed };
})`;

/** THE SUBJECT MASK. Coverage render of the two fighter hierarchies, verbatim
 *  from ssgate so the mask is the same object the ground truth was scored on. */
const MASK_JS = `((k) => {
  const KB = window.KB, THREE = KB.THREE;
  const r = KB.renderer, gl = r.renderer, scene = KB.scene, cam = KB.camera;

  const roots = KB.fighters.map((f) => f.robot && f.robot.group).filter(Boolean);
  if (roots.length !== KB.fighters.length) throw new Error('could not resolve every fighter robot group');

  const rootSet = new Set(roots);
  const keep = new Set();
  for (const rt of roots) {
    let o = rt.parent;
    while (o) { keep.add(o); o = o.parent; }
  }
  if (!keep.has(scene)) throw new Error('fighter roots are not under KB.scene');

  const hidden = [];
  const walk = (o) => {
    for (const c of o.children) {
      if (rootSet.has(c)) continue;
      if (keep.has(c)) { walk(c); continue; }
      if (c.visible) { hidden.push(c); c.visible = false; }
    }
  };
  walk(scene);
  const forced = [];
  for (const o of keep) { if (o !== scene && !o.visible) { forced.push(o); o.visible = true; } }
  for (const o of rootSet) { if (!o.visible) { forced.push(o); o.visible = true; } }

  const savedOverride = scene.overrideMaterial;
  const savedBg = scene.background;
  const savedEnv = scene.environment;
  const savedFog = scene.fog;
  const savedLayers = cam.layers.mask;
  const savedShadow = gl.shadowMap.enabled;
  const savedAutoClear = gl.autoClear;
  const savedClear = new THREE.Color();
  gl.getClearColor(savedClear);
  const savedAlpha = gl.getClearAlpha();
  const savedTarget = gl.getRenderTarget();

  const flat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false });
  scene.overrideMaterial = flat;
  scene.background = null;
  scene.environment = null;
  scene.fog = null;
  cam.layers.enableAll();
  gl.shadowMap.enabled = false;
  gl.autoClear = true;
  gl.setClearColor(0x000000, 1);
  gl.setRenderTarget(null);
  gl.render(scene, cam);

  const out = window.__ssBoxDown(k, true);

  scene.overrideMaterial = savedOverride;
  scene.background = savedBg;
  scene.environment = savedEnv;
  scene.fog = savedFog;
  cam.layers.mask = savedLayers;
  gl.shadowMap.enabled = savedShadow;
  gl.autoClear = savedAutoClear;
  gl.setClearColor(savedClear, savedAlpha);
  gl.setRenderTarget(savedTarget);
  flat.dispose();

  for (const o of hidden) o.visible = true;
  for (const o of forced) o.visible = false;

  const cov = out.plane;
  const mask = new Uint8Array(cov.length);
  let n = 0, nFull = 0;
  for (let i = 0; i < cov.length; i++) {
    const c = cov[i] / 255;
    if (c > 0.001) { mask[i] = 1; n++; }
    if (c > 0.999) nFull++;
  }
  window.__ssMask = mask;
  let png = null;
  if (window.__ssKeepPng) {
    const W = ${WIDTH}, H = ${HEIGHT};
    const mc = document.createElement('canvas');
    mc.width = W; mc.height = H;
    const mctx = mc.getContext('2d');
    const img = mctx.createImageData(W, H);
    for (let i = 0; i < cov.length; i++) {
      const v = Math.round(cov[i]);
      img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    mctx.putImageData(img, 0, 0);
    png = mc.toDataURL('image/png');
  }
  return {
    png,
    rendered: out.rendered,
    subjectPx: n,
    subjectPct: +((100 * n) / cov.length).toFixed(3),
    interiorPx: nFull,
    edgePx: n - nFull,
    roots: roots.length,
    hiddenBranches: hidden.length,
  };
})`;

/** Shared readback, verbatim from ssgate: exact k x k box down when the source
 *  is an integer multiple of 1920x1080, bilinear upscale otherwise. */
const BOXDOWN_JS = `((k, isMask) => {
  const W = ${WIDTH}, H = ${HEIGHT};
  const gl = window.KB.renderer.canvas;
  const sw = gl.width, sh = gl.height;
  const tmp = window.__ssTmp || (window.__ssTmp = document.createElement('canvas'));
  if (tmp.width !== sw || tmp.height !== sh) { tmp.width = sw; tmp.height = sh; }
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingEnabled = false;
  tctx.globalCompositeOperation = 'source-over';
  tctx.fillStyle = '#000';
  tctx.fillRect(0, 0, sw, sh);
  tctx.drawImage(gl, 0, 0);

  const plane = new Float32Array(W * H);
  const R = 0.2126, G = 0.7152, B = 0.0722;

  if (sw >= W && sw % W === 0 && sh % H === 0) {
    const kk = sw / W;
    for (let oy = 0; oy < H; oy++) {
      const band = tctx.getImageData(0, oy * kk, sw, kk).data;
      const row = oy * W;
      for (let ox = 0; ox < W; ox++) {
        let acc = 0;
        for (let j = 0; j < kk; j++) {
          let p = (j * sw + ox * kk) * 4;
          for (let i = 0; i < kk; i++, p += 4) acc += R * band[p] + G * band[p + 1] + B * band[p + 2];
        }
        plane[row + ox] = acc / (kk * kk);
      }
    }
  } else {
    const src = tctx.getImageData(0, 0, sw, sh).data;
    const sl = new Float32Array(sw * sh);
    for (let i = 0, p = 0; i < sl.length; i++, p += 4) sl[i] = R * src[p] + G * src[p + 1] + B * src[p + 2];
    const fx = sw / W, fy = sh / H;
    for (let oy = 0; oy < H; oy++) {
      const sy = Math.min(sh - 1, Math.max(0, (oy + 0.5) * fy - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), wy = sy - y0;
      for (let ox = 0; ox < W; ox++) {
        const sx = Math.min(sw - 1, Math.max(0, (ox + 0.5) * fx - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), wx = sx - x0;
        const a = sl[y0 * sw + x0], b = sl[y0 * sw + x1];
        const c = sl[y1 * sw + x0], d = sl[y1 * sw + x1];
        plane[oy * W + ox] = (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
      }
    }
  }
  return { plane, rendered: sw + 'x' + sh, png: (!isMask && window.__ssKeepPng) ? tmp.toDataURL('image/png') : null };
})`;

/**
 * Render one arm and retain its 1920x1080 luma plane.
 *
 * WARM FRAMES. Stage.update is called at dt 0 alongside every render because
 * the planar floor reflector is a temporal cache armed only from the game loop;
 * without this the mirror's contents depend on how many rAF frames fell inside
 * a driver round trip, and that cost an earlier truth arm its own null control.
 *
 * TEMPORAL DETERMINISM. An accumulation is only reproducible if it starts from
 * a known state, so this resets BOTH the history and the jitter phase before
 * warming. That is a measurement reset, not a configuration change: the null
 * control below is what proves it worked, and if the reset were wrong the null
 * would not come back at 0.
 *
 * opts: { feedback, jitter, tonemapWeight } -- each optional, each restored
 * afterwards, each recorded in the returned row so no arm can silently be
 * something other than what it claims.
 */
const MEASURE_JS = `((scale, warm, label, opts) => {
  const KB = window.KB, r = KB.renderer;
  const o = opts || {};
  r.renderScale = scale;
  r._targetScale = scale;
  if (typeof r.resize === 'function') r.resize();

  const taa = r._passes.taa || null;
  const saved = {};
  if (taa) {
    saved.feedback = taa.uniforms.uFeedback.value;
    saved.tonemapWeight = taa.uniforms.uTonemapWeight.value;
    saved.clamp = taa.uniforms.uClamp.value;
    if (typeof o.feedback === 'number') taa.uniforms.uFeedback.value = o.feedback;
    if (typeof o.tonemapWeight === 'number') taa.uniforms.uTonemapWeight.value = o.tonemapWeight;
    if (typeof o.clamp === 'number') taa.uniforms.uClamp.value = o.clamp;
    taa.invalidate();
    r._jitterIndex = 0;
  }
  // Jitter suppression for SETUP-3. The pass still runs, still clamps, still
  // stores history; the ONLY thing removed is the sub-pixel offset.
  const savedJitterScale = r.taaJitterScale;
  if (o.jitter === false) r.taaJitterScale = 0;

  const stage = KB.stage;
  if (stage && stage.reflector && typeof stage.reflector.invalidate === 'function') stage.reflector.invalidate();
  const step = () => {
    if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
    r.render(KB.scene, KB.camera, 1 / 60);
  };
  for (let i = 0; i < warm; i++) step();

  step();
  const out = window.__ssBoxDown(scale, false);
  window.__ssPlanes[label] = out.plane;

  const passes = {
    keys: Object.keys(r._passes || {}).join(','),
    armed: (r.composer ? r.composer.passes : []).map((p) => p.constructor.name).join(' '),
  };
  const taaState = taa ? {
    feedback: taa.uniforms.uFeedback.value,
    tonemapWeight: taa.uniforms.uTonemapWeight.value,
    clamp: taa.uniforms.uClamp.value,
    hasDepth: taa.uniforms.uHasDepth.value,
    historyValid: taa.uniforms.uHistoryValid.value,
    historySize: taa._history[0].width + 'x' + taa._history[0].height,
    lastJitter: [+r._jitterX.toFixed(4), +r._jitterY.toFixed(4)],
    jitterScale: r.taaJitterScale,
  } : null;

  if (taa) {
    taa.uniforms.uFeedback.value = saved.feedback;
    taa.uniforms.uTonemapWeight.value = saved.tonemapWeight;
    taa.uniforms.uClamp.value = saved.clamp;
  }
  r.taaJitterScale = savedJitterScale;

  let mean = 0;
  for (let i = 0; i < out.plane.length; i++) mean += out.plane[i];
  return {
    label, renderScale: scale, warm, rendered: out.rendered,
    meanLuma: +(mean / out.plane.length).toFixed(3),
    passKeys: passes.keys, passArmed: passes.armed,
    taa: taaState,
    png: out.png,
  };
})`;

/** THE METRIC. */
const COMPARE_JS = `((label, truthLabel, thr) => {
  const P = window.__ssPlanes, a = P[label], t = P[truthLabel], m = window.__ssMask;
  if (!a) throw new Error('no plane ' + label);
  if (!t) throw new Error('no truth plane ' + truthLabel);
  if (!m) throw new Error('no subject mask');
  let s2 = 0, ss2 = 0, ns = 0, off = 0, offAll = 0, mx = 0, mxs = 0, sa = 0, ssa = 0, tl = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - t[i], ad = d < 0 ? -d : d;
    s2 += d * d; sa += ad;
    if (ad > mx) mx = ad;
    if (ad > thr) offAll++;
    if (m[i]) {
      ss2 += d * d; ssa += ad; ns++; tl += t[i];
      if (ad > thr) off++;
      if (ad > mxs) mxs = ad;
    }
  }
  const rs = Math.sqrt(ss2 / Math.max(1, ns));
  const meanT = tl / Math.max(1, ns);
  return {
    rmseAll: +Math.sqrt(s2 / a.length).toFixed(4),
    rmseSubject: +rs.toFixed(4),
    truthMeanSubjectLuma: +meanT.toFixed(3),
    nrmseSubjectPct: +((100 * rs) / Math.max(1e-6, meanT)).toFixed(2),
    offBySubject: off,
    offByAll: offAll,
    subjectPx: ns,
    offBySubjectPct: +((100 * off) / Math.max(1, ns)).toFixed(2),
    maeAll: +(sa / a.length).toFixed(4),
    maeSubject: +(ssa / Math.max(1, ns)).toFixed(4),
    maxErrAll: +mx.toFixed(2),
    maxErrSubject: +mxs.toFixed(2),
  };
})`;

/** MICRO-CONTRAST, REPORTED AND EXPLICITLY NOT GATED ON. */
const MAL_JS = `((label, subjectOnly) => {
  const W = ${WIDTH}, H = ${HEIGHT};
  const a = window.__ssPlanes[label], m = window.__ssMask;
  let sum = 0, n = 0;
  for (let y = 1; y < H - 1; y++) {
    const r0 = (y - 1) * W, r1 = y * W, r2 = (y + 1) * W;
    for (let x = 1; x < W - 1; x++) {
      if (subjectOnly && !m[r1 + x]) continue;
      sum += Math.abs(a[r0 + x] + a[r2 + x] + a[r1 + x - 1] + a[r1 + x + 1] - 4 * a[r1 + x]);
      n++;
    }
  }
  return +(sum / Math.max(1, n)).toFixed(5);
})`;

/**
 * SETUP CONTROL on the jitter itself: does the projection matrix come back
 * exactly as it was found? The sim, the raycasts and the hitboxes all read it
 * outside the composer call, so "exactly" is the requirement, not "close".
 */
const JITTER_LEAK_JS = `(() => {
  const KB = window.KB, r = KB.renderer, cam = KB.camera;
  const before = cam.projectionMatrix.elements.slice();
  const beforeInv = cam.projectionMatrixInverse.elements.slice();
  const seen = [];
  const taa = r._passes.taa;
  let hooked = null;
  if (taa) {
    const orig = taa.render.bind(taa);
    hooked = orig;
    taa.render = (renderer, w, rb) => {
      seen.push([cam.projectionMatrix.elements[8], cam.projectionMatrix.elements[9]]);
      orig(renderer, w, rb);
    };
  }
  for (let i = 0; i < 4; i++) {
    if (KB.stage) KB.stage.update(0, KB.tick);
    r.render(KB.scene, KB.camera, 1 / 60);
  }
  if (taa && hooked) taa.render = hooked;
  const after = cam.projectionMatrix.elements.slice();
  const afterInv = cam.projectionMatrixInverse.elements.slice();
  let maxDelta = 0, maxDeltaInv = 0;
  for (let i = 0; i < 16; i++) {
    maxDelta = Math.max(maxDelta, Math.abs(after[i] - before[i]));
    maxDeltaInv = Math.max(maxDeltaInv, Math.abs(afterInv[i] - beforeInv[i]));
  }
  // Distinct in-flight shears prove the jitter was actually applied during the
  // composer call -- a leak test that passes because nothing ever moved is not
  // a control, it is a tautology.
  const uniq = new Set(seen.map((s) => s[0].toFixed(9) + ',' + s[1].toFixed(9)));
  return {
    restoredExactly: maxDelta === 0 && maxDeltaInv === 0,
    maxDelta, maxDeltaInv,
    inFlightShears: seen.map((s) => [+s[0].toFixed(7), +s[1].toFixed(7)]),
    distinctShears: uniq.size,
    restingShear: [+before[8].toFixed(9), +before[9].toFixed(9)],
  };
})()`;

/* ------------------------------------------------------------------------ */

const pct = (v) => (v === null || v === undefined || !isFinite(v) ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

async function main() {
  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/`;

  const browser = await chromium.launch({
    args: [
      '--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--enable-zero-copy',
      '--disable-frame-rate-limit', '--force-device-scale-factor=1',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const report = {
    metric: 'RMSE vs the 4x-integrated frame over subject pixels, 8-bit luma units, lower is better',
    framing: null, mask: null, arms: {}, compare: {}, controls: {}, microContrast: {},
    defects: [], secondaryDefects: [], void: [],
  };
  const pngs = {};

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
    await page.waitForTimeout(2500);

    await page.evaluate(`(() => { ${PIN_CLOCK} })()`);
    await page.evaluate(`(() => {
      window.KB.menus.show(null);
      window.KB.debug.freecam = false;
      window.KB.paused = false;
      window.KB.startMatch(0, 1);
      window.KB.setPhase('fight');
    })()`);
    const pinned = await page.evaluate(`(() => new Promise((res) => {
      const KB = window.KB, target = ${PIN};
      const step = () => {
        if (KB.phaseTicks >= target) { KB.paused = true; res(KB.phaseTicks); }
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }))()`);
    if (pinned !== PIN) report.defects.push(`pose pin landed on tick ${pinned}, wanted ${PIN}`);

    report.framing = await page.evaluate(FREEZE);

    const fr = report.framing;
    report.framingRef = FRAMING_REF;
    report.framingDelta = {
      dist_pct: +(((fr.dist - FRAMING_REF.dist) / FRAMING_REF.dist) * 100).toFixed(2),
      fov_pct: +(((fr.fov - FRAMING_REF.fov) / FRAMING_REF.fov) * 100).toFixed(2),
      pxPerM_pct: +(((fr.pxPerM - FRAMING_REF.pxPerM) / FRAMING_REF.pxPerM) * 100).toFixed(2),
    };
    if (Math.abs(report.framingDelta.pxPerM_pct) > 8) {
      report.defects.push(`NOT fight framing: ${fr.pxPerM} px/m vs ref ${FRAMING_REF.pxPerM} (${report.framingDelta.pxPerM_pct}%)`);
    }

    await page.evaluate(`
      window.__ssBoxDown = ${BOXDOWN_JS};
      window.__ssMeasure = ${MEASURE_JS};
      window.__ssCompare = ${COMPARE_JS};
      window.__ssMal = ${MAL_JS};
      window.__ssMakeMask = ${MASK_JS};
      window.__ssSetMode = ${SET_MODE_JS};
      window.__ssPlanes = {};
      window.__ssKeepPng = ${KEEP_PNG ? 'true' : 'false'};
    `);

    report.passesAsShipped = await page.evaluate(PASSES_JS);
    if (report.passesAsShipped.keys !== EXPECT_PASSES.shipped) {
      report.defects.push(`as-shipped pass list is [${report.passesAsShipped.keys}], expected [${EXPECT_PASSES.shipped}]`);
    }

    const setMode = async (mode) => {
      const want = mode === 'bare'
        ? { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: false, taa: false }
        : mode === 'taa'
          ? { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: false, taa: true }
          : mode === 'smaa'
            ? { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: true, taa: false }
            : mode === 'shippedSmaa'
              ? { ao: true, bloom: true, dof: true, motionBlur: true, grade: true, smaa: true, taa: false }
              : { ao: true, bloom: true, dof: true, motionBlur: true, grade: true, smaa: true, taa: true };
      const t = await page.evaluate(`window.__ssSetMode(${JSON.stringify(want)})`);
      report.controls[`setEffect_${mode}`] = t;
      if (t.after.keys !== EXPECT_PASSES[mode]) {
        report.defects.push(`setEffect('${mode}') produced [${t.after.keys}], expected [${EXPECT_PASSES[mode]}]`);
      }
      return t;
    };

    const run = async (scale, label, expectMode, warm, opts = {}) => {
      const w = warm === undefined ? (expectMode === 'taa' || expectMode === 'shipped' ? WARM_TAA : WARM) : warm;
      const a = await page.evaluate(`window.__ssMeasure(${scale}, ${w}, '${label}', ${JSON.stringify(opts)})`);
      if (a.png) { pngs[label] = a.png; }
      delete a.png;
      a.expectMode = expectMode;
      a.opts = opts;
      if (a.passKeys !== EXPECT_PASSES[expectMode]) {
        report.void.push(label);
        report.defects.push(`VOID ARM ${label}: rendered with [${a.passKeys}], mode '${expectMode}' requires [${EXPECT_PASSES[expectMode]}]`);
      }
      if (a.meanLuma < 2) report.defects.push(`arm ${label} looks dead (meanLuma ${a.meanLuma})`);
      report.arms[label] = a;
      console.log(`[taagate] ${label.padEnd(16)} rs=${String(scale).padEnd(5)} warm=${String(w).padEnd(3)} ${a.rendered.padEnd(9)} mean=${String(a.meanLuma).padEnd(7)} passes=[${a.passKeys}]`);
      return a;
    };

    // -- SUBJECT MASK, built once at truth resolution ------------------------
    console.log('[taagate] building subject mask at truth resolution ...');
    await setMode('bare');
    await page.evaluate(`(() => {
      const r = window.KB.renderer;
      r.renderScale = ${TRUTH}; r._targetScale = ${TRUTH}; r.resize();
    })()`);
    await page.evaluate(`(() => {
      const KB = window.KB, r = KB.renderer;
      for (let i = 0; i < 4; i++) { if (KB.stage) KB.stage.update(0, KB.tick); r.render(KB.scene, KB.camera, 1 / 60); }
    })()`);
    report.mask = await page.evaluate(`window.__ssMakeMask(${TRUTH})`);
    if (report.mask.png) { pngs.MASK = report.mask.png; delete report.mask.png; }
    console.log(`[taagate] mask: ${report.mask.subjectPx} subject px (${report.mask.subjectPct}% of frame), ` +
      `${report.mask.interiorPx} interior + ${report.mask.edgePx} partial-coverage edge, from ${report.mask.rendered}`);
    if (report.mask.rendered !== `${WIDTH * TRUTH}x${HEIGHT * TRUTH}`) {
      report.defects.push(`mask rendered at ${report.mask.rendered}, expected ${WIDTH * TRUTH}x${HEIGHT * TRUTH}`);
    }
    if (report.mask.subjectPx < 20000 || report.mask.subjectPct > 40) {
      report.defects.push(`subject mask is implausible: ${report.mask.subjectPx} px (${report.mask.subjectPct}%)`);
    }

    // =====================================================================
    // BARE BLOCK -- the gate. With post off there is no DOF, so the ONLY
    // thing differing between arms is how many geometric samples paid for
    // each delivered pixel. That is exactly what this change is about.
    // =====================================================================
    console.log('\n[taagate] --- BARE BLOCK (render output) : BEFORE ---');
    await run(0.85, 'A_bare', 'bare');
    await run(1.0, 'B_bare', 'bare');
    await run(TRUTH, 'C_truth', 'bare');
    await run(TRUTH, 'C_truth_null', 'bare');
    await run(0.5, 'P_half', 'bare');
    await run(0.85, 'A_bare_warm56', 'bare', WARM_TAA);   // warm-count null

    // -- SMAA arms, for the record -------------------------------------------
    await setMode('smaa');
    await run(1.0, 'B_smaa', 'smaa');
    await run(0.85, 'A_smaa', 'smaa');

    // =====================================================================
    // TEMPORAL BLOCK -- 'render taa output'. AFTER.
    // =====================================================================
    console.log('\n[taagate] --- TEMPORAL BLOCK (render taa output) : AFTER ---');
    await setMode('taa');
    report.controls.jitterLeak = await page.evaluate(JITTER_LEAK_JS);

    await run(0.85, 'T_taa_085', 'taa');
    await run(0.80, 'T_taa_080', 'taa');
    await run(0.72, 'T_taa_072', 'taa');
    await run(0.90, 'T_taa_090', 'taa');
    await run(1.00, 'T_taa_100', 'taa');
    // convergence controls: same arm, three warm counts
    await run(0.85, 'T_taa_085_w16', 'taa', 16);
    await run(0.85, 'T_taa_085_w112', 'taa', WARM_TAA * 2);
    // the weighting-space A/B
    await run(0.85, 'T_taa_085_linear', 'taa', undefined, { tonemapWeight: 0 });
    // FEEDBACK SWEEP. With 8 jitter phases and feedback f, the converged pixel
    // weights the phases as (1-f)f^k: f=0.90 is a 2.1:1 spread over the eight,
    // f=0.94 is 1.6:1, f=0.97 is 1.24:1. A flatter spread is a better box
    // filter and therefore a better approximation of the reference -- and a
    // longer memory, which is what a moving limb has to be protected from.
    await run(0.85, 'T_taa_085_fb094', 'taa', undefined, { feedback: 0.94 });
    await run(0.85, 'T_taa_085_fb097', 'taa', undefined, { feedback: 0.97 });
    await run(0.85, 'T_taa_085_fb085', 'taa', undefined, { feedback: 0.85 });
    await run(0.85, 'T_taa_085_fb080', 'taa', undefined, { feedback: 0.80 });
    // DIAGNOSTIC: what is the anti-ghosting clamp costing on a frame where
    // nothing moves? It should be costing nothing, and if it is not, the clamp
    // is biting on static content and would be softening the converged image
    // for no reason.
    await run(0.85, 'T_taa_085_noclamp', 'taa', undefined, { clamp: 0 });
    // SETUP-2: pass armed, accumulation off AND jitter off -> must be a no-op.
    await run(0.85, 'T_fb0_nojit', 'taa', undefined, { feedback: 0, jitter: false });
    // POSITIVE-2: pass armed, accumulation off, jitter ON -> must NOT be a
    // no-op. This is a raw sub-pixel-shifted frame, and it is the proof that
    // the projection shear reached the geometry at all.
    await run(0.85, 'T_fb0_jit', 'taa', undefined, { feedback: 0 });
    // SETUP-3: accumulation ON at the shipping feedback, jitter off -> every
    // accumulated sample is identical, so this must also be a no-op.
    await run(0.85, 'T_nojitter', 'taa', undefined, { jitter: false });
    // NULL controls, late on purpose
    await run(0.85, 'T_taa_085_null', 'taa');
    await setMode('bare');
    await run(0.85, 'A_bare_null', 'bare');

    if (report.arms.C_truth && report.arms.C_truth.rendered !== `${WIDTH * TRUTH}x${HEIGHT * TRUTH}`) {
      report.defects.push(`truth arm rendered ${report.arms.C_truth.rendered} -- the supersample did not take`);
    }

    const cmp = async (label, truth) => {
      const c = await page.evaluate(`window.__ssCompare('${label}', '${truth}', ${OFF_BY})`);
      report.compare[label] = { ...c, vs: truth };
      return c;
    };
    const GATED = ['A_bare', 'B_bare', 'C_truth_null', 'P_half', 'A_bare_null', 'A_bare_warm56',
      'B_smaa', 'A_smaa', 'T_taa_085', 'T_taa_080', 'T_taa_072', 'T_taa_090', 'T_taa_100',
      'T_taa_085_w16', 'T_taa_085_w112', 'T_taa_085_linear', 'T_taa_085_fb094', 'T_taa_085_fb097',
      'T_taa_085_fb085', 'T_taa_085_fb080',
      'T_taa_085_noclamp', 'T_fb0_nojit', 'T_fb0_jit', 'T_nojitter', 'T_taa_085_null'];
    for (const l of GATED) await cmp(l, 'C_truth');

    // -- CONTROLS -----------------------------------------------------------
    report.controls.null_A = await page.evaluate(`window.__ssCompare('A_bare_null', 'A_bare', ${OFF_BY})`);
    report.controls.null_C = await page.evaluate(`window.__ssCompare('C_truth_null', 'C_truth', ${OFF_BY})`);
    report.controls.null_T = await page.evaluate(`window.__ssCompare('T_taa_085_null', 'T_taa_085', ${OFF_BY})`);
    report.controls.null_warm = await page.evaluate(`window.__ssCompare('A_bare_warm56', 'A_bare', ${OFF_BY})`);
    report.controls.setup_feedback0 = await page.evaluate(`window.__ssCompare('T_fb0_nojit', 'A_bare', ${OFF_BY})`);
    report.controls.positive_jitter_moves = await page.evaluate(`window.__ssCompare('T_fb0_jit', 'A_bare', ${OFF_BY})`);
    report.controls.setup_nojitter = await page.evaluate(`window.__ssCompare('T_nojitter', 'A_bare', ${OFF_BY})`);
    report.controls.clamp_cost_static = await page.evaluate(`window.__ssCompare('T_taa_085_noclamp', 'T_taa_085', ${OFF_BY})`);
    report.controls.converge_w16_w56 = await page.evaluate(`window.__ssCompare('T_taa_085_w16', 'T_taa_085', ${OFF_BY})`);
    report.controls.converge_w56_w112 = await page.evaluate(`window.__ssCompare('T_taa_085_w112', 'T_taa_085', ${OFF_BY})`);

    // -- MICRO-CONTRAST SANITY (reported, never gated on) --------------------
    for (const l of ['A_bare', 'B_bare', 'C_truth', 'T_taa_085', 'T_taa_080']) {
      report.microContrast[l] = {
        subject: await page.evaluate(`window.__ssMal('${l}', true)`),
        frame: await page.evaluate(`window.__ssMal('${l}', false)`),
      };
    }

    // =====================================================================
    // SHIPPED BLOCK -- optional, slow, and its whole-frame null is known
    // dirty (the planar reflector is a temporal cache). RMSE-subject is the
    // usable column here; RMSE-all is not.
    // =====================================================================
    if (WANT_SHIPPED) {
      console.log('\n[taagate] --- SHIPPED BLOCK (full chain) ---');
      await setMode('shippedSmaa');
      await page.evaluate('window.KB.renderer.setGrade({ grain: 0, chroma: 0 });');
      await run(0.85, 'A_ship_smaa', 'shippedSmaa', WARM);
      await setMode('shipped');
      await page.evaluate('window.KB.renderer.setGrade({ grain: 0, chroma: 0 });');
      await run(0.85, 'A_ship_taa', 'shipped');
      await run(0.80, 'A_ship_taa_080', 'shipped');
      await run(TRUTH, 'C_ship_truth', 'shipped', WARM);
      await run(0.85, 'A_ship_taa_null', 'shipped');
      for (const l of ['A_ship_smaa', 'A_ship_taa', 'A_ship_taa_080', 'A_ship_taa_null']) await cmp(l, 'C_ship_truth');
      report.controls.null_A_ship = await page.evaluate(`window.__ssCompare('A_ship_taa_null', 'A_ship_taa', ${OFF_BY})`);
      const ns = report.controls.null_A_ship;
      if (!(ns.rmseAll < 0.05)) {
        report.secondaryDefects.push(
          `SHIPPED-BLOCK WHOLE-FRAME NULL: two captures differ by rmseAll ${ns.rmseAll} (${ns.offByAll} px over ` +
          `${OFF_BY}/255) while rmseSubject is ${ns.rmseSubject} with ${ns.offBySubject} px over threshold. ` +
          `Known and documented in ssgate: the instability is outside the subject mask and is consistent with the ` +
          `planar floor reflector's temporal cache. RMSE-subject is usable here, RMSE-all is not.`);
      }
      await setMode('taa');
    }

    // -- did anything drift over the whole run? ------------------------------
    report.framingAfter = await page.evaluate(`(() => {
      const KB = window.KB, cam = KB.camera;
      const mid = KB.fighters[0].robot.group.position.clone()
        .add(KB.fighters[1].robot.group.position).multiplyScalar(0.5);
      return { dist: +cam.position.distanceTo(mid).toFixed(3), fov: +cam.fov.toFixed(2), phaseTicks: KB.phaseTicks };
    })()`);
    if (report.framingAfter.dist !== report.framing.dist || report.framingAfter.fov !== report.framing.fov) {
      report.defects.push(`camera moved during the run: ${report.framing.dist}/${report.framing.fov} -> ${report.framingAfter.dist}/${report.framingAfter.fov}`);
    }
    report.passesAtEnd = await page.evaluate(PASSES_JS);

    // ---- verdicts ----------------------------------------------------------
    const A = report.compare.A_bare, B = report.compare.B_bare, P = report.compare.P_half;
    const T85 = report.compare.T_taa_085, T80 = report.compare.T_taa_080;
    const nA = report.controls.null_A, nC = report.controls.null_C, nT = report.controls.null_T;

    const nullBar = A.rmseSubject * 0.005;
    const nullPass = nA.rmseSubject < nullBar && nC.rmseSubject < nullBar && nT.rmseSubject < nullBar &&
                     nA.offBySubject === 0 && nC.offBySubject === 0 && nT.offBySubject === 0;
    const posSign = P.rmseSubject > A.rmseSubject && P.rmseAll > A.rmseAll;

    // SETUP-2 / SETUP-3. The bar is 1% of the signal: a pass that is a genuine
    // no-op reproduces the bare arm to float noise, and 1% of 16.7 luma units
    // is far below anything the accumulation itself moves.
    const setupBar = A.rmseSubject * 0.01;
    const fb0Pass = report.controls.setup_feedback0.rmseSubject < setupBar;
    const njPass = report.controls.setup_nojitter.rmseSubject < setupBar;
    // POSITIVE-2. A jittered frame with no accumulation is a sub-pixel-shifted
    // frame and MUST differ from the unjittered one. The bar is the same one
    // the no-op controls have to stay under, asserted in the other direction.
    const jitterMoves = report.controls.positive_jitter_moves.rmseSubject > setupBar * 10;
    const leak = report.controls.jitterLeak;
    const leakPass = !!leak.restoredExactly && leak.distinctShears >= 2;

    // CONVERGENCE. The measured temporal arm must not still be moving: doubling
    // the warm count must move it by less than 1% of its own error.
    const convBar = Math.max(0.05, T85.rmseSubject * 0.01);
    const convPass = report.controls.converge_w56_w112.rmseSubject < convBar;

    const mcB = report.microContrast.B_bare.subject, mcC = report.microContrast.C_truth.subject;
    const mcInvert = mcC < mcB;
    report.microContrastInversion = {
      pair: 'B_bare (bare-1x) vs C_truth (bare-4x), subject pixels',
      bare1x: mcB, bare4x: mcC,
      delta_pct: +((100 * (mcC - mcB)) / mcB).toFixed(2),
      reproduced: mcInvert,
      note: 'on record: -13.3%. The correct frame scores LOWER. This is why micro-contrast is not the gate.',
    };

    if (!nullPass) report.defects.push(`NULL CONTROL FAILED: A ${nA.rmseSubject}/${nA.offBySubject}px, C ${nC.rmseSubject}/${nC.offBySubject}px, T ${nT.rmseSubject}/${nT.offBySubject}px (bar ${nullBar.toFixed(4)} and 0 px)`);
    if (!posSign) report.defects.push(`POSITIVE CONTROL WRONG-SIGNED: half-res rmseSubject ${P.rmseSubject} is not worse than shipped ${A.rmseSubject}`);
    if (!fb0Pass) report.defects.push(`SETUP-2 FAILED: TAA at feedback 0 with jitter off differs from the bare arm by rmseSubject ${report.controls.setup_feedback0.rmseSubject} (bar ${setupBar.toFixed(4)}) -- the pass is changing the frame for a reason other than accumulation`);
    if (!jitterMoves) report.defects.push(`POSITIVE-2 FAILED: a jittered frame with no accumulation is indistinguishable from an unjittered one (rmseSubject ${report.controls.positive_jitter_moves.rmseSubject}) -- the projection shear never reached the geometry`);
    if (!njPass) report.defects.push(`SETUP-3 FAILED: TAA with zero jitter differs from the bare arm by rmseSubject ${report.controls.setup_nojitter.rmseSubject} (bar ${setupBar.toFixed(4)}) -- the accumulation is doing something other than integrating sub-pixel samples`);
    if (!leakPass) report.defects.push(`JITTER LEAK CONTROL FAILED: restoredExactly=${leak.restoredExactly} maxDelta=${leak.maxDelta} distinctShears=${leak.distinctShears} -- the projection jitter is either visible outside the composer call or was never applied`);
    if (!convPass) report.defects.push(`CONVERGENCE CONTROL FAILED: doubling the warm count moves the temporal arm by ${report.controls.converge_w56_w112.rmseSubject} (bar ${convBar.toFixed(4)}) -- the measured frame is a transient`);
    if (!mcInvert) report.defects.push(`micro-contrast inversion NOT reproduced: bare-4x ${mcC} >= bare-1x ${mcB}`);

    const closes = (c) => +((100 * (A.rmseSubject - c.rmseSubject)) / A.rmseSubject).toFixed(2);
    report.verdict = {
      metric: 'rmseSubject vs C_truth (lower is better)',
      BEFORE_A_shipped_085: A.rmseSubject,
      AFTER_taa_085: T85.rmseSubject,
      AFTER_taa_080: T80.rmseSubject,
      B_native_100: B.rmseSubject,
      closes_pct_of_A: {
        taa_085: closes(T85),
        taa_080: closes(T80),
        taa_072: closes(report.compare.T_taa_072),
        taa_090: closes(report.compare.T_taa_090),
        taa_100: closes(report.compare.T_taa_100),
        taa_085_linear_weighting: closes(report.compare.T_taa_085_linear),
        taa_085_feedback_094: closes(report.compare.T_taa_085_fb094),
        taa_085_feedback_097: closes(report.compare.T_taa_085_fb097),
        taa_085_feedback_085: closes(report.compare.T_taa_085_fb085),
        taa_085_feedback_080: closes(report.compare.T_taa_085_fb080),
        taa_085_noclamp: closes(report.compare.T_taa_085_noclamp),
        native_100: closes(B),
        smaa_100: closes(report.compare.B_smaa),
        smaa_085: closes(report.compare.A_smaa),
      },
      // What the change actually does to the SHIPPING anti-aliasing, which is
      // SMAA and not nothing. TAA replaces SMAA in the chain, so this is the
      // before/after a player gets.
      vs_shipping_smaa_085: {
        before_smaa_085: report.compare.A_smaa.rmseSubject,
        after_taa_085: T85.rmseSubject,
        after_taa_080: T80.rmseSubject,
        taa085_closes_pct_of_smaa: +((100 * (report.compare.A_smaa.rmseSubject - T85.rmseSubject)) / report.compare.A_smaa.rmseSubject).toFixed(2),
        taa080_closes_pct_of_smaa: +((100 * (report.compare.A_smaa.rmseSubject - T80.rmseSubject)) / report.compare.A_smaa.rmseSubject).toFixed(2),
      },
      subject_px_off_by_8: {
        before: A.offBySubject,
        taa_085: T85.offBySubject,
        taa_080: T80.offBySubject,
      },
      nrmse_pct_of_subject_mean_luma: { before: A.nrmseSubjectPct, taa_085: T85.nrmseSubjectPct, taa_080: T80.nrmseSubjectPct },
      controls: {
        null_pass: nullPass,
        null_max_rmse_subject: Math.max(nA.rmseSubject, nC.rmseSubject, nT.rmseSubject),
        positive_sign_correct: posSign,
        positive_delta_pct: +((100 * (P.rmseSubject - A.rmseSubject)) / A.rmseSubject).toFixed(2),
        setup_feedback0_vs_bare_rmse: report.controls.setup_feedback0.rmseSubject,
        setup_feedback0_pass: fb0Pass,
        positive_jitter_moves_rmse: report.controls.positive_jitter_moves.rmseSubject,
        positive_jitter_moves_pass: jitterMoves,
        clamp_cost_on_static_frame_rmse: report.controls.clamp_cost_static.rmseSubject,
        setup_nojitter_vs_bare_rmse: report.controls.setup_nojitter.rmseSubject,
        setup_nojitter_pass: njPass,
        jitter_restored_exactly: leak.restoredExactly,
        jitter_distinct_shears: leak.distinctShears,
        jitter_leak_pass: leakPass,
        warm_count_null_rmse: report.controls.null_warm.rmseSubject,
        converge_w16_to_w56: report.controls.converge_w16_w56.rmseSubject,
        converge_w56_to_w112: report.controls.converge_w56_w112.rmseSubject,
        converge_pass: convPass,
        microcontrast_inversion_reproduced: mcInvert,
        voidArms: report.void,
      },
      pass: report.defects.length === 0,
      secondary_defects: report.secondaryDefects.length,
    };
  } finally {
    report.consoleErrors = consoleErrors.slice(0, 10);
    await browser.close();
    await server.close();
  }

  /* ------------------------------- output -------------------------------- */
  const R = (l) => report.compare[l] || {};
  const row = (name, l) => {
    const c = R(l), a = report.arms[l] || {};
    const base = report.compare.A_bare?.rmseSubject;
    const d = (base && c.rmseSubject !== undefined) ? ((c.rmseSubject - base) / base) * 100 : null;
    return `  ${name.padEnd(20)} ${String(c.rmseAll ?? '-').padStart(8)} ${String(c.rmseSubject ?? '-').padStart(10)} ` +
           `${String(c.offBySubject ?? '-').padStart(12)} ${(d === null ? '-' : pct(d)).padStart(9)} ${String(a.rendered ?? '-').padStart(10)}  [${a.passKeys ?? '-'}]`;
  };

  console.log('\n==================== taagate ====================');
  console.log(`METRIC   RMSE vs the ${TRUTH}x-integrated frame, over SUBJECT PIXELS, 8-bit luma. LOWER IS BETTER.`);
  console.log(`FRAMING  ${JSON.stringify(report.framing)}`);
  console.log(`         vs ref ${JSON.stringify(report.framingRef)} -> ${JSON.stringify(report.framingDelta)}`);
  console.log(`MASK     ${report.mask?.subjectPx} subject px (${report.mask?.subjectPct}% of frame) = ` +
    `${report.mask?.interiorPx} interior + ${report.mask?.edgePx} partial-coverage edge`);
  console.log(`SETUP    as-shipped pass list [${report.passesAsShipped?.keys}]`);

  console.log('\n-- THE GATE (bare block) ------------------------------------------------------');
  console.log(`  ${'arm'.padEnd(20)} ${'RMSE all'.padStart(8)} ${'RMSE subj'.padStart(10)} ${`subj >${OFF_BY}/255`.padStart(12)} ${'vs A'.padStart(9)} ${'rendered'.padStart(10)}  [passes]`);
  console.log(row('A BEFORE 0.85', 'A_bare'));
  console.log(row('B native 1.00', 'B_bare'));
  console.log(`  ${'C truth 4x'.padEnd(20)} ${'0.0000'.padStart(8)} ${'0.0000'.padStart(10)} ${'0'.padStart(12)} ${'-100.00%'.padStart(9)} ${String(report.arms.C_truth?.rendered).padStart(10)}  [${report.arms.C_truth?.passKeys}]`);
  console.log(row('SMAA 1.00', 'B_smaa'));
  console.log(row('SMAA 0.85', 'A_smaa'));
  console.log(row('TAA AFTER 0.85', 'T_taa_085'));
  console.log(row('TAA AFTER 0.80', 'T_taa_080'));
  console.log(row('TAA 0.72', 'T_taa_072'));
  console.log(row('TAA 0.90', 'T_taa_090'));
  console.log(row('TAA 1.00', 'T_taa_100'));
  console.log(row('TAA 0.85 linear wt', 'T_taa_085_linear'));
  console.log(row('TAA 0.85 fb 0.94', 'T_taa_085_fb094'));
  console.log(row('TAA 0.85 fb 0.97', 'T_taa_085_fb097'));
  console.log(row('TAA 0.85 fb 0.85', 'T_taa_085_fb085'));
  console.log(row('TAA 0.85 fb 0.80', 'T_taa_085_fb080'));
  console.log(row('TAA 0.85 no clamp', 'T_taa_085_noclamp'));

  console.log('\n-- CONTROLS -------------------------------------------------------------------');
  const c = report.controls;
  console.log(`  NULL   A_bare   twice : rmseAll ${c.null_A?.rmseAll}  rmseSubject ${c.null_A?.rmseSubject}  px>${OFF_BY} ${c.null_A?.offBySubject}  maxErr ${c.null_A?.maxErrAll}`);
  console.log(`  NULL   C_truth  twice : rmseAll ${c.null_C?.rmseAll}  rmseSubject ${c.null_C?.rmseSubject}  px>${OFF_BY} ${c.null_C?.offBySubject}  maxErr ${c.null_C?.maxErrAll}`);
  console.log(`  NULL   T_taa    twice : rmseAll ${c.null_T?.rmseAll}  rmseSubject ${c.null_T?.rmseSubject}  px>${OFF_BY} ${c.null_T?.offBySubject}  maxErr ${c.null_T?.maxErrAll}`);
  console.log(`  NULL   warm 16 vs 56  : rmseAll ${c.null_warm?.rmseAll}  rmseSubject ${c.null_warm?.rmseSubject}   (a non-temporal render must not care)`);
  console.log(row('POS  half 0.50', 'P_half'));
  console.log(`  POS    sign: half-res ${R('P_half').rmseSubject} vs A ${R('A_bare').rmseSubject} -> ` +
    `${pct(report.verdict?.controls?.positive_delta_pct)}  ${report.verdict?.controls?.positive_sign_correct ? 'CORRECT (worse, as required)' : 'WRONG SIGN'}`);
  console.log(`  SETUP-2 fb 0 + no jitter vs A_bare : rmseSubject ${c.setup_feedback0?.rmseSubject}  ${report.verdict?.controls?.setup_feedback0_pass ? 'PASS (pass is a no-op without accumulation)' : 'FAIL'}`);
  console.log(`  POS-2   fb 0 + JITTER vs A_bare    : rmseSubject ${c.positive_jitter_moves?.rmseSubject}  ${report.verdict?.controls?.positive_jitter_moves_pass ? 'PASS (the shear reached the geometry)' : 'FAIL'}`);
  console.log(`  DIAG    clamp on/off, static frame  : rmseSubject ${c.clamp_cost_static?.rmseSubject}  (should be ~0: nothing moves, so nothing should be clamped)`);
  console.log(`  SETUP-3 zero jitter vs A_bare: rmseSubject ${c.setup_nojitter?.rmseSubject}  ${report.verdict?.controls?.setup_nojitter_pass ? 'PASS (the gain is sampling, not blur)' : 'FAIL'}`);
  console.log(`  SETUP-4 jitter leak   : restoredExactly=${c.jitterLeak?.restoredExactly} maxDelta=${c.jitterLeak?.maxDelta} maxDeltaInv=${c.jitterLeak?.maxDeltaInv} distinctShears=${c.jitterLeak?.distinctShears}`);
  console.log(`          in-flight shears ${JSON.stringify(c.jitterLeak?.inFlightShears)} resting ${JSON.stringify(c.jitterLeak?.restingShear)}`);
  console.log(`  CONVERGE w16->w56 ${c.converge_w16_w56?.rmseSubject}   w56->w112 ${c.converge_w56_w112?.rmseSubject}  ${report.verdict?.controls?.converge_pass ? 'CONVERGED' : 'STILL MOVING'}`);
  console.log(`  SETUP  void arms: ${report.void.length ? report.void.join(' ') : 'none'}`);

  console.log('\n-- MICRO-CONTRAST: reported, NOT gated on --------------------------------------');
  console.log('   (the correct frame must score LOWER here; that is why it is not the metric)');
  for (const [k, v] of Object.entries(report.microContrast)) {
    console.log(`  ${k.padEnd(16)} subject MAL ${String(v.subject).padStart(9)}   frame MAL ${String(v.frame).padStart(9)}`);
  }
  const mci = report.microContrastInversion || {};
  console.log(`  INVERSION CHECK (bare-1x vs bare-4x): ${mci.bare1x} -> ${mci.bare4x} = ${pct(mci.delta_pct)}   ${mci.reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'}`);

  if (WANT_SHIPPED) {
    console.log('\n-- SHIPPED BLOCK (full chain) -- secondary, DOF confound, dirty whole-frame null --');
    console.log(row('shipped + SMAA', 'A_ship_smaa'));
    console.log(row('shipped + TAA 0.85', 'A_ship_taa'));
    console.log(row('shipped + TAA 0.80', 'A_ship_taa_080'));
  }

  console.log('\n-- VERDICT --------------------------------------------------------------------');
  console.log(JSON.stringify(report.verdict, null, 2));
  if (report.defects.length) {
    console.log('\nGATE DEFECTS (these fail the run):');
    for (const d of report.defects) console.log(`  ! ${d}`);
  }
  if (report.secondaryDefects.length) {
    console.log('\nSECONDARY DEFECTS (reported, not worked around):');
    for (const d of report.secondaryDefects) console.log(`  ~ ${d}`);
  }
  if (report.consoleErrors.length) console.log(`\nconsole errors: ${JSON.stringify(report.consoleErrors)}`);

  if (KEEP_PNG) {
    mkdirSync(resolve(ROOT, KEEP_PNG), { recursive: true });
    for (const [k, v] of Object.entries(pngs)) {
      writeFileSync(resolve(ROOT, KEEP_PNG, `${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
    }
    console.log(`\nPNGs -> ${KEEP_PNG}`);
  }
  if (JSON_OUT) {
    mkdirSync(dirname(resolve(ROOT, JSON_OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
    console.log(`report -> ${JSON_OUT}`);
  }

  process.exit(report.defects.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
