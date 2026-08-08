/**
 * aoquality -- does sharing the GTAO normal buffer change the picture?
 *
 * Companion to tools/aogate.mjs, which measures what the change buys in frame
 * time. This measures what it costs in image, ON THE PROJECT'S OWN METRIC:
 *
 *     RMSE against the 4x-integrated frame, over SUBJECT PIXELS, 8-bit luma.
 *     Lower is better.
 *
 * The mask construction, the box-down/readback path, the freeze and the RMSE
 * are LIFTED VERBATIM from tools/ssgate.mjs, including its comments where they
 * explain a trap. That is deliberate: a new quality metric invented for the
 * change it is meant to judge is not evidence. Read ssgate.mjs for why each of
 * those pieces is shaped the way it is -- especially why micro-contrast and
 * sharpness are wrong-signed here and are not used.
 *
 * WHY NOT JUST RUN ssgate.mjs TWICE, WITH AND WITHOUT THE CHANGE
 * ssgate itself says it: two page loads of an identical scene tree differ by
 * ~197,000 pixels, the same magnitude as a real change, so anything captured
 * across processes reads its own noise floor. Both arms here are re-renders of
 * the SAME frozen frame inside the SAME page, switched with GTAOPass.setGBuffer
 * -- which is the only call that moves NORMAL_VECTOR_TYPE on both materials.
 *
 * WHY NOT movegate.mjs FOR THE MOVING HALF
 * movegate scores the chains 'render,output' and 'render,taa,output'. Neither
 * arms the AO pass at all, so it cannot see this change. It is also aimed at a
 * TEMPORAL pass, and the thing under test here holds no history: the normal
 * buffer is rebuilt from scratch every frame from that frame's depth. What
 * motion CAN expose is different -- bilinear taps into a half-resolution buffer
 * where the shipped code re-derived the value at full-resolution texel centres,
 * i.e. edge crawl. So the moving half of this tool is a MOTION block: a
 * deterministic camera orbit, replayed identically in both arms, scored on
 * frame-to-frame instability over subject pixels.
 *
 * ARMS (shipped chain, grain and chroma zeroed, one frozen pose)
 *   A_depth        0.85, NORMAL_VECTOR_TYPE 0 -- as shipped before the change
 *   A_shared       0.85, NORMAL_VECTOR_TYPE 1 -- the change
 *   A_aooff        0.85, AO removed           -- the YARDSTICK
 *   C_depth        4.00, NORMAL_VECTOR_TYPE 0 -- truth for A_depth
 *   C_shared       4.00, NORMAL_VECTOR_TYPE 1 -- truth for A_shared
 *   *_null         each 0.85 arm captured again, late, after every other arm
 *
 * CONTROLS
 *   SETUP     armed pass list AND the AO defines recorded at the moment of each
 *             render and asserted against what the arm asked for; drawing
 *             buffer size asserted (an unscaled truth arm is a silent no-op).
 *   NULL      the same arm twice, separated by every other arm. Must be 0.
 *   POSITIVE  A_aooff must differ from A_depth by far more than the null. If
 *             removing the whole pass cannot move this metric, the metric
 *             cannot see AO at this framing -- which would itself be the
 *             finding, and is reported as one rather than assumed away.
 *   SCALE     every delta is reported as a fraction of that yardstick, because
 *             'is 0.4 RMSE a lot' has no answer without one.
 *
 *   node tools/aoquality.mjs --json scratchpad/aoquality.json
 *   node tools/aoquality.mjs --pin 260 --json scratchpad/aoquality-t260.json
 *
 * NOTE ON THIS FILE: page-side code lives in template literals. A backtick
 * anywhere below, even in a comment inside a literal, silently ends the string.
 * There are none. Keep it that way.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(arg('port', 5251));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const TRUTH = Number(arg('truth', 4));
const PIN = Number(arg('pin', 96));
const WARM = Number(arg('warm', 16));
const JSON_OUT = arg('json', '');
const KEEP_PNG = arg('png', '');
const OFF_BY = Number(arg('offby', 8));
/** Frames in the motion block, and the per-frame orbit in radians. 0.0012 rad
 *  at this framing moves the subject about 2 px per frame, i.e. a slow pan --
 *  fast enough to crawl, slow enough that a difference is not just resampling. */
const MOTION_FRAMES = Number(arg('motionframes', 24));
const MOTION_STEP = Number(arg('motionstep', 0.0012));

/** The established fight framing. Asserted, not assumed. */
const FRAMING_REF = { dist: 4.59, fov: 35.5, pxPerM: 367 };
const EXPECT_PASSES = 'scene,gbuffer,ao,bloom,dof,motionBlur,grade,smaa,output';
const EXPECT_PASSES_NOAO = 'scene,gbuffer,bloom,dof,motionBlur,grade,smaa,output';

/* ---------------------------------------------------------------------------
 * PAGE-SIDE CODE. Everything below runs inside the browser.
 * ------------------------------------------------------------------------ */

/** ssgate PIN_CLOCK, verbatim: one rendered frame = one tick. */
const PIN_CLOCK = `
  if (!window.__kbClock) window.__kbClock = window.KB.clock.getDelta.bind(window.KB.clock);
  window.KB.timeScale = 1;
  window.KB.clock.getDelta = () => 1 / 60;
`;

/**
 * ssgate FREEZE, with the camera park made addressable so the motion block can
 * drive it. Five things have to stop moving and ssgate learned each the hard
 * way: the sim, the clock, the camera rig (FightCamera.render runs off the
 * render loop and KB.paused does not stop it), the grade's per-frame grain and
 * chroma hashes, and adaptive resolution.
 */
const FREEZE = `(() => {
  const KB = window.KB, THREE = KB.THREE, cam = KB.camera;
  KB.paused = true;
  KB.clock.getDelta = () => 0;

  const basePos = cam.position.clone();
  const baseQuat = cam.quaternion.clone();
  const fov = cam.fov;
  const mid = KB.fighters[0].robot.group.getWorldPosition(new THREE.Vector3())
    .add(KB.fighters[1].robot.group.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);

  const state = { theta: 0 };
  const park = () => {
    if (state.theta === 0) {
      cam.position.copy(basePos);
      cam.quaternion.copy(baseQuat);
    } else {
      // Orbit about world Y through the subject midpoint. A rigid rotation of
      // the whole camera, so the framing is preserved exactly and the only
      // thing that changes is which way the frame is looking from.
      const off = basePos.clone().sub(mid).applyAxisAngle(new THREE.Vector3(0, 1, 0), state.theta);
      cam.position.copy(mid).add(off);
      cam.quaternion.copy(baseQuat).premultiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), state.theta));
    }
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld(true);
  };
  KB.fightCamera.render = park;
  KB.fightCamera.simulate = () => {};
  window.__aoOrbit = (theta) => { state.theta = theta; park(); };
  park();

  const r = KB.renderer;
  r.effects.adaptiveResolution = false;
  if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });

  const box = new THREE.Box3().setFromObject(KB.fighters[0].robot.group);
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

/** SETUP CONTROL. The composer's ACTUAL pass array plus the AO define state. */
const STATE_JS = `(() => {
  const r = window.KB.renderer;
  const ao = r._passes.ao || null;
  return {
    keys: Object.keys(r._passes || {}).join(','),
    armed: (r.composer ? r.composer.passes : []).map((p) => p.constructor.name).join(' '),
    renderScale: r.renderScale,
    drawingBuffer: r.canvas.width + 'x' + r.canvas.height,
    ao: ao ? {
      gtaoNVT: ao.gtaoMaterial.defines.NORMAL_VECTOR_TYPE,
      pdNVT: ao.pdMaterial.defines.NORMAL_VECTOR_TYPE,
      wired: ao.normalTexture === ao.viewNormals.texture,
      aoSize: ao.width + 'x' + ao.height,
      normalSize: ao.viewNormals.width + 'x' + ao.viewNormals.height,
      pdSamples: ao.pdSamples,
      gtaoSamples: ao.gtaoMaterial.defines.SAMPLES,
    } : null,
  };
})()`;

/**
 * Arms the chain. setEffect, and ONLY setEffect, for the pass list; setGBuffer,
 * and ONLY setGBuffer, for the normal source -- assigning normalTexture would
 * move the field without the defines and leave both shaders reconstructing (see
 * the hazard demo in tools/aogate-page.js).
 */
const SET_MODE_JS = `((mode) => {
  const r = window.KB.renderer;
  const wantAo = mode !== 'aooff';
  for (const name of ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'taa']) {
    r.setEffect(name, name === 'taa' ? false : (name === 'ao' ? wantAo : true));
  }
  const ao = r._passes.ao;
  if (ao) {
    const depth = r._passes.scene ? r._passes.scene.liveDepth : null;
    if (mode === 'depth') ao.setGBuffer(depth, undefined);
    else ao.setGBuffer(depth, ao.viewNormals.texture);
  }
  r.setGrade({ grain: 0, chroma: 0 });
  return mode;
})`;

/** ssgate MASK_JS, verbatim. Coverage render of the two fighter hierarchies at
 *  TRUTH resolution, boxed down with the same integer filter as the truth arm,
 *  drawn with the raw renderer so the mask does not depend on which post passes
 *  are armed. Everything touched is saved and restored. */
const MASK_JS = `((k) => {
  const KB = window.KB, THREE = KB.THREE;
  const r = KB.renderer, gl = r.renderer, scene = KB.scene, cam = KB.camera;

  const roots = KB.fighters.map((f) => f.robot && f.robot.group).filter(Boolean);
  if (roots.length !== KB.fighters.length) throw new Error('could not resolve every fighter robot group');

  const rootSet = new Set(roots);
  const keep = new Set();
  for (const rt of roots) { let o = rt.parent; while (o) { keep.add(o); o = o.parent; } }
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

  const savedOverride = scene.overrideMaterial, savedBg = scene.background;
  const savedEnv = scene.environment, savedFog = scene.fog;
  const savedLayers = cam.layers.mask, savedShadow = gl.shadowMap.enabled;
  const savedAutoClear = gl.autoClear;
  const savedClear = new THREE.Color();
  gl.getClearColor(savedClear);
  const savedAlpha = gl.getClearAlpha(), savedTarget = gl.getRenderTarget();

  const flat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false });
  scene.overrideMaterial = flat;
  scene.background = null; scene.environment = null; scene.fog = null;
  cam.layers.enableAll();
  gl.shadowMap.enabled = false;
  gl.autoClear = true;
  gl.setClearColor(0x000000, 1);
  gl.setRenderTarget(null);
  gl.render(scene, cam);

  const out = window.__aoBoxDown(k, true);

  scene.overrideMaterial = savedOverride; scene.background = savedBg;
  scene.environment = savedEnv; scene.fog = savedFog;
  cam.layers.mask = savedLayers; gl.shadowMap.enabled = savedShadow;
  gl.autoClear = savedAutoClear; gl.setClearColor(savedClear, savedAlpha);
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
  window.__aoMask = mask;
  return {
    rendered: out.rendered, subjectPx: n,
    subjectPct: +((100 * n) / cov.length).toFixed(3),
    interiorPx: nFull, edgePx: n - nFull, roots: roots.length,
  };
})`;

/** ssgate BOXDOWN_JS, verbatim. drawImage is used ONLY at 1:1, so no number
 *  depends on Chrome's smoothing quality. */
const BOXDOWN_JS = `((k, isMask) => {
  const W = ${WIDTH}, H = ${HEIGHT};
  const gl = window.KB.renderer.canvas;
  const sw = gl.width, sh = gl.height;
  const tmp = window.__aoTmp || (window.__aoTmp = document.createElement('canvas'));
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
  return { plane, rendered: sw + 'x' + sh, png: (!isMask && window.__aoKeepPng) ? tmp.toDataURL('image/png') : null };
})`;

/**
 * ssgate MEASURE_JS. The Stage.update(0, tick) call alongside every render is
 * load-bearing and ssgate paid for it: PlanarReflector refreshes every 2nd
 * ARMED frame, is armed only from the game's rAF loop, and rebinds its target
 * size from the drawing buffer -- so after a resize, whether an arm caught the
 * refresh depended on driver timing. Arming it on THIS tool's frames and
 * invalidating once per resize makes the first warm frame refresh it.
 */
const MEASURE_JS = `((scale, warm, label) => {
  const KB = window.KB, r = KB.renderer;
  r.renderScale = scale;
  r._targetScale = scale;
  if (typeof r.resize === 'function') r.resize();

  const stage = KB.stage;
  if (stage && stage.reflector && typeof stage.reflector.invalidate === 'function') stage.reflector.invalidate();
  const step = () => {
    if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
    r.render(KB.scene, KB.camera, 1 / 60);
  };
  for (let i = 0; i < warm; i++) step();
  step();
  const out = window.__aoBoxDown(scale, false);
  window.__aoPlanes[label] = out.plane;

  const ao = r._passes.ao || null;
  let mean = 0;
  for (let i = 0; i < out.plane.length; i++) mean += out.plane[i];
  return {
    label, renderScale: scale, rendered: out.rendered,
    meanLuma: +(mean / out.plane.length).toFixed(3),
    passKeys: Object.keys(r._passes || {}).join(','),
    aoState: ao ? {
      gtaoNVT: ao.gtaoMaterial.defines.NORMAL_VECTOR_TYPE,
      pdNVT: ao.pdMaterial.defines.NORMAL_VECTOR_TYPE,
      wired: ao.normalTexture === ao.viewNormals.texture,
      aoSize: ao.width + 'x' + ao.height,
      normalSize: ao.viewNormals.width + 'x' + ao.viewNormals.height,
    } : null,
    png: out.png,
  };
})`;

/** ssgate COMPARE_JS, verbatim. RMSE in 8-bit luma units; the subject-masked
 *  column is the gate. */
const COMPARE_JS = `((label, refLabel, thr) => {
  const P = window.__aoPlanes, a = P[label], t = P[refLabel], m = window.__aoMask;
  if (!a) throw new Error('no plane ' + label);
  if (!t) throw new Error('no plane ' + refLabel);
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
    nrmseSubjectPct: +((100 * rs) / Math.max(1e-6, meanT)).toFixed(3),
    offBySubject: off, offByAll: offAll, subjectPx: ns,
    maeSubject: +(ssa / Math.max(1, ns)).toFixed(4),
    maxErrSubject: +mxs.toFixed(2),
    maxErrAll: +mx.toFixed(2),
  };
})`;

/**
 * MOTION BLOCK. Orbits the camera along a fixed path and keeps every frame, so
 * two arms can be compared frame-for-frame on an IDENTICAL path. Returns
 * frame-to-frame RMSE over subject pixels -- the quantity that goes up when a
 * screen-space term crawls.
 */
const MOTION_JS = `((scale, frames, stepRad, warm, tag) => {
  const KB = window.KB, r = KB.renderer;
  r.renderScale = scale;
  r._targetScale = scale;
  if (typeof r.resize === 'function') r.resize();
  const stage = KB.stage;
  if (stage && stage.reflector && typeof stage.reflector.invalidate === 'function') stage.reflector.invalidate();
  const step = () => {
    if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
    r.render(KB.scene, KB.camera, 1 / 60);
  };
  window.__aoOrbit(0);
  for (let i = 0; i < warm; i++) step();

  const planes = [];
  for (let i = 0; i < frames; i++) {
    window.__aoOrbit(i * stepRad);
    // Two renders per pose: the first settles the planar reflector at this
    // camera, the second is the one that is read. Without it the sequence
    // measures the mirror's refresh cadence instead of the AO.
    step();
    step();
    planes.push(window.__aoBoxDown(scale, false).plane);
  }
  window.__aoOrbit(0);
  window.__aoMotion[tag] = planes;
  return { frames: planes.length, rendered: r.canvas.width + 'x' + r.canvas.height };
})`;

const MOTION_SCORE_JS = `((tag, thr) => {
  const planes = window.__aoMotion[tag], m = window.__aoMask;
  const out = [];
  for (let k = 1; k < planes.length; k++) {
    const a = planes[k], b = planes[k - 1];
    let ss = 0, ns = 0, off = 0;
    for (let i = 0; i < a.length; i++) {
      if (!m[i]) continue;
      const d = a[i] - b[i];
      ss += d * d; ns++;
      if (Math.abs(d) > thr) off++;
    }
    out.push({ rmse: +Math.sqrt(ss / Math.max(1, ns)).toFixed(4), offPct: +((100 * off) / Math.max(1, ns)).toFixed(3) });
  }
  const rm = out.map((o) => o.rmse).sort((x, y) => x - y);
  const mean = out.reduce((s, o) => s + o.rmse, 0) / Math.max(1, out.length);
  return {
    steps: out.length,
    meanRmse: +mean.toFixed(4),
    medRmse: +rm[Math.floor(rm.length / 2)].toFixed(4),
    maxRmse: +rm[rm.length - 1].toFixed(4),
    perStep: out.map((o) => o.rmse),
  };
})`;

/** Frame-for-frame difference between two motion sequences on the same path. */
const MOTION_DIFF_JS = `((tagA, tagB) => {
  const A = window.__aoMotion[tagA], B = window.__aoMotion[tagB], m = window.__aoMask;
  const out = [];
  for (let k = 0; k < Math.min(A.length, B.length); k++) {
    let ss = 0, ns = 0;
    for (let i = 0; i < A[k].length; i++) {
      if (!m[i]) continue;
      const d = A[k][i] - B[k][i];
      ss += d * d; ns++;
    }
    out.push(+Math.sqrt(ss / Math.max(1, ns)).toFixed(4));
  }
  const s = [...out].sort((x, y) => x - y);
  return {
    frames: out.length,
    meanRmse: +(out.reduce((t, v) => t + v, 0) / Math.max(1, out.length)).toFixed(4),
    medRmse: +s[Math.floor(s.length / 2)].toFixed(4),
    maxRmse: +s[s.length - 1].toFixed(4),
    perFrame: out,
  };
})`;

/* ---------------------------------------------------------------------- run */

const server = await createServer({
  root: ROOT,
  server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

const report = {
  metric: 'RMSE vs the 4x-integrated frame over subject pixels, 8-bit luma units, lower is better',
  pin: PIN, framing: null, mask: null, arms: {}, compare: {}, controls: {}, motion: {},
  defects: [], notes: [],
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(3000);

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
  report.framingRef = FRAMING_REF;
  const pxDelta = ((report.framing.pxPerM - FRAMING_REF.pxPerM) / FRAMING_REF.pxPerM) * 100;
  report.framingDeltaPct = +pxDelta.toFixed(2);
  if (Math.abs(pxDelta) > 8) {
    report.defects.push(`NOT fight framing: ${report.framing.pxPerM} px/m vs ref ${FRAMING_REF.pxPerM}`);
  }

  await page.evaluate(`
    window.__aoBoxDown = ${BOXDOWN_JS};
    window.__aoMeasure = ${MEASURE_JS};
    window.__aoCompare = ${COMPARE_JS};
    window.__aoMakeMask = ${MASK_JS};
    window.__aoSetMode = ${SET_MODE_JS};
    window.__aoMotionRun = ${MOTION_JS};
    window.__aoMotionScore = ${MOTION_SCORE_JS};
    window.__aoMotionDiff = ${MOTION_DIFF_JS};
    window.__aoPlanes = {};
    window.__aoMotion = {};
    window.__aoKeepPng = ${KEEP_PNG ? 'true' : 'false'};
  `);

  report.stateAsShipped = await page.evaluate(STATE_JS);

  const setMode = async (mode) => {
    await page.evaluate(`window.__aoSetMode('${mode}')`);
    const st = await page.evaluate(STATE_JS);
    report.controls[`setMode_${mode}`] = st;
    const wantKeys = mode === 'aooff' ? EXPECT_PASSES_NOAO : EXPECT_PASSES;
    if (st.keys !== wantKeys) report.defects.push(`setMode('${mode}') produced [${st.keys}], expected [${wantKeys}]`);
    if (mode === 'depth' && st.ao && (st.ao.gtaoNVT !== 0 || st.ao.pdNVT !== 0 || st.ao.wired)) {
      report.defects.push(`setMode('depth') left the AO on the shared-normal path: ${JSON.stringify(st.ao)}`);
    }
    if (mode === 'shared' && st.ao && (st.ao.gtaoNVT !== 1 || st.ao.pdNVT !== 1 || !st.ao.wired)) {
      report.defects.push(`setMode('shared') did not arm the shared normal buffer: ${JSON.stringify(st.ao)}`);
    }
    return st;
  };

  const run = async (scale, label, mode, warm = WARM) => {
    const a = await page.evaluate(`window.__aoMeasure(${scale}, ${warm}, '${label}')`);
    delete a.png;
    a.mode = mode;
    const wantKeys = mode === 'aooff' ? EXPECT_PASSES_NOAO : EXPECT_PASSES;
    if (a.passKeys !== wantKeys) report.defects.push(`VOID ARM ${label}: rendered with [${a.passKeys}], mode '${mode}' requires [${wantKeys}]`);
    if (mode === 'depth' && a.aoState && (a.aoState.gtaoNVT !== 0 || a.aoState.pdNVT !== 0)) report.defects.push(`VOID ARM ${label}: AO defines ${JSON.stringify(a.aoState)} are not the shipped path`);
    if (mode === 'shared' && a.aoState && (a.aoState.gtaoNVT !== 1 || a.aoState.pdNVT !== 1)) report.defects.push(`VOID ARM ${label}: AO defines ${JSON.stringify(a.aoState)} are not the shared path`);
    if (mode !== 'aooff' && a.aoState && a.aoState.aoSize !== a.aoState.normalSize) report.defects.push(`VOID ARM ${label}: AO buffer ${a.aoState.aoSize} != normal buffer ${a.aoState.normalSize}`);
    const wantBuf = `${Math.round(WIDTH * scale)}x${Math.round(HEIGHT * scale)}`;
    if (a.rendered !== wantBuf) report.notes.push(`${label} drawing buffer ${a.rendered}, nominal ${wantBuf}`);
    if (a.meanLuma < 2) report.defects.push(`arm ${label} looks dead (meanLuma ${a.meanLuma})`);
    report.arms[label] = a;
    console.log(`[aoquality] ${label.padEnd(16)} rs=${String(scale).padEnd(5)} ${a.rendered.padEnd(10)} mean=${String(a.meanLuma).padEnd(8)} ao=${a.aoState ? a.aoState.gtaoNVT + '/' + a.aoState.pdNVT : 'off'}`);
    return a;
  };

  /* -- SUBJECT MASK, built once at truth resolution ----------------------- */
  await setMode('depth');
  await page.evaluate(`(() => {
    const r = window.KB.renderer;
    r.renderScale = ${TRUTH}; r._targetScale = ${TRUTH}; r.resize();
  })()`);
  await page.evaluate(`(() => {
    const KB = window.KB, r = KB.renderer;
    for (let i = 0; i < 4; i++) { if (KB.stage) KB.stage.update(0, KB.tick); r.render(KB.scene, KB.camera, 1 / 60); }
  })()`);
  report.mask = await page.evaluate(`window.__aoMakeMask(${TRUTH})`);
  console.log(`[aoquality] mask: ${report.mask.subjectPx} subject px (${report.mask.subjectPct}%), ${report.mask.edgePx} edge, from ${report.mask.rendered}`);
  if (report.mask.rendered !== `${WIDTH * TRUTH}x${HEIGHT * TRUTH}`) report.defects.push(`mask rendered at ${report.mask.rendered}`);
  if (report.mask.subjectPx < 20000 || report.mask.subjectPct > 40) report.defects.push(`subject mask implausible: ${report.mask.subjectPx} px`);

  /* -- ARMS --------------------------------------------------------------- */
  console.log('\n[aoquality] --- STATIC BLOCK ---');
  await setMode('depth');
  await run(0.85, 'A_depth', 'depth');
  await run(TRUTH, 'C_depth', 'depth');

  await setMode('shared');
  await run(0.85, 'A_shared', 'shared');
  await run(TRUTH, 'C_shared', 'shared');

  await setMode('aooff');
  await run(0.85, 'A_aooff', 'aooff');

  // NULLs late on purpose: residue left by another arm shows up here.
  await setMode('depth');
  await run(0.85, 'A_depth_null', 'depth');
  await setMode('shared');
  await run(0.85, 'A_shared_null', 'shared');

  const cmp = async (label, ref, key) => {
    const c = await page.evaluate(`window.__aoCompare('${label}', '${ref}', ${OFF_BY})`);
    report.compare[key || `${label}_vs_${ref}`] = { ...c, a: label, ref };
    return c;
  };

  // Each shipped-resolution arm against its OWN correctly-integrated frame:
  // that is the ssgate question, asked once per configuration.
  const gDepth = await cmp('A_depth', 'C_depth');
  const gShared = await cmp('A_shared', 'C_shared');
  // And the change against the SHIPPED ground truth, which is the stricter read.
  const xShared = await cmp('A_shared', 'C_depth');
  const yardstick = await cmp('A_aooff', 'C_depth');
  const dChange = await cmp('A_shared', 'A_depth');
  const dAo = await cmp('A_aooff', 'A_depth');
  const nDepth = await cmp('A_depth_null', 'A_depth');
  const nShared = await cmp('A_shared_null', 'A_shared');
  const cTruth = await cmp('C_shared', 'C_depth');

  report.controls.null_depth = nDepth;
  report.controls.null_shared = nShared;

  /* -- MOTION BLOCK -------------------------------------------------------- */
  console.log('\n[aoquality] --- MOTION BLOCK (camera orbit, identical path per arm) ---');
  await setMode('depth');
  const mD = await page.evaluate(`window.__aoMotionRun(0.85, ${MOTION_FRAMES}, ${MOTION_STEP}, ${WARM}, 'depth')`);
  await setMode('shared');
  const mS = await page.evaluate(`window.__aoMotionRun(0.85, ${MOTION_FRAMES}, ${MOTION_STEP}, ${WARM}, 'shared')`);
  await setMode('aooff');
  const mO = await page.evaluate(`window.__aoMotionRun(0.85, ${MOTION_FRAMES}, ${MOTION_STEP}, ${WARM}, 'aooff')`);
  report.motion.runs = { depth: mD, shared: mS, aooff: mO };
  report.motion.stability = {
    depth: await page.evaluate(`window.__aoMotionScore('depth', ${OFF_BY})`),
    shared: await page.evaluate(`window.__aoMotionScore('shared', ${OFF_BY})`),
    aooff: await page.evaluate(`window.__aoMotionScore('aooff', ${OFF_BY})`),
  };
  report.motion.armDiff = {
    shared_vs_depth: await page.evaluate(`window.__aoMotionDiff('shared', 'depth')`),
    aooff_vs_depth: await page.evaluate(`window.__aoMotionDiff('aooff', 'depth')`),
  };

  await setMode('shared');
  report.stateAtEnd = await page.evaluate(STATE_JS);
  report.consoleErrors = consoleErrors.slice(0, 10);

  /* -- VERDICTS ------------------------------------------------------------ */
  const nullMax = Math.max(nDepth.rmseSubject, nShared.rmseSubject);
  // POSITIVE CONTROL: can this metric see AO at all at fight framing?
  const metricSeesAo = dAo.rmseSubject > Math.max(0.05, 10 * Math.max(nullMax, 1e-3));
  report.verdict = {
    nullSubjectRmse: { depth: nDepth.rmseSubject, shared: nShared.rmseSubject },
    nullPass: nullMax < 0.02 && nDepth.offBySubject === 0 && nShared.offBySubject === 0,
    yardstick_aoOff_vs_shipped_subjectRmse: dAo.rmseSubject,
    metricSeesAo,
    change_vs_shipped_subjectRmse: dChange.rmseSubject,
    changeAsFractionOfAo: +(dChange.rmseSubject / Math.max(1e-6, dAo.rmseSubject)).toFixed(4),
    distanceToOwnTruth: { shipped: gDepth.rmseSubject, change: gShared.rmseSubject,
      delta: +(gShared.rmseSubject - gDepth.rmseSubject).toFixed(4) },
    distanceToShippedTruth: { shipped: gDepth.rmseSubject, change: xShared.rmseSubject,
      delta: +(xShared.rmseSubject - gDepth.rmseSubject).toFixed(4) },
    truth4x_change_vs_shipped_subjectRmse: cTruth.rmseSubject,
    motion: {
      stabilityMeanRmse: {
        shipped: report.motion.stability.depth.meanRmse,
        change: report.motion.stability.shared.meanRmse,
        aoOff: report.motion.stability.aooff.meanRmse,
      },
      changeMinusShipped: +(report.motion.stability.shared.meanRmse - report.motion.stability.depth.meanRmse).toFixed(4),
      armDiffUnderMotionMeanRmse: report.motion.armDiff.shared_vs_depth.meanRmse,
      aoOffDiffUnderMotionMeanRmse: report.motion.armDiff.aooff_vs_depth.meanRmse,
    },
  };
  if (!report.verdict.nullPass) report.defects.push(`NULL CONTROL FAILED: ${nDepth.rmseSubject} / ${nShared.rmseSubject} subject RMSE between two captures of the same arm`);
  if (!metricSeesAo) report.defects.push(`POSITIVE CONTROL FAILED: removing AO entirely moves subject RMSE by only ${dAo.rmseSubject}; this metric cannot see AO at this framing`);

  console.log('\n================ QUALITY ================');
  console.log(`null control (same arm twice)        subject RMSE  depth ${nDepth.rmseSubject}  shared ${nShared.rmseSubject}`);
  console.log(`YARDSTICK: AO removed vs shipped     subject RMSE  ${dAo.rmseSubject}   (max err ${dAo.maxErrSubject}, ${dAo.offBySubject} px over ${OFF_BY})`);
  console.log(`THE CHANGE vs shipped                subject RMSE  ${dChange.rmseSubject}   = ${(100 * report.verdict.changeAsFractionOfAo).toFixed(1)}% of the yardstick`);
  console.log(`distance to own 4x truth             shipped ${gDepth.rmseSubject}   change ${gShared.rmseSubject}   delta ${report.verdict.distanceToOwnTruth.delta}`);
  console.log(`distance to the SHIPPED 4x truth     shipped ${gDepth.rmseSubject}   change ${xShared.rmseSubject}   delta ${report.verdict.distanceToShippedTruth.delta}`);
  console.log(`4x truth: change vs shipped          subject RMSE  ${cTruth.rmseSubject}`);
  console.log('---- motion (camera orbit, identical path) ----');
  console.log(`frame-to-frame stability  shipped ${report.motion.stability.depth.meanRmse}  change ${report.motion.stability.shared.meanRmse}  ao-off ${report.motion.stability.aooff.meanRmse}`);
  console.log(`arm difference per frame  change-vs-shipped ${report.motion.armDiff.shared_vs_depth.meanRmse}  ao-off-vs-shipped ${report.motion.armDiff.aooff_vs_depth.meanRmse}`);
  console.log(`\ndefects: ${report.defects.length ? '\n  - ' + report.defects.join('\n  - ') : 'none'}`);
} catch (e) {
  report.defects.push('THREW: ' + String(e && e.stack ? e.stack.split('\n')[0] : e));
  console.error(e);
} finally {
  if (JSON_OUT) {
    const p = resolve(ROOT, JSON_OUT);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(report, null, 2));
    console.log('[aoquality] wrote', p);
  }
  await browser.close();
  await server.close();
  process.exit(report.defects.length ? 2 : 0);
}
