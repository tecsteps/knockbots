/**
 * ssgate -- the SUPERSAMPLING GATE.
 *
 * Pins the ground-truth target that temporal supersampling has to close, and
 * scores it on the metric that has already been decided:
 *
 *     RMSE against the 4x-integrated frame, over SUBJECT PIXELS. Lower is better.
 *
 * ONE browser process, ONE pinned frame ('01-hero-idle' framing, tick 150, sim
 * paused, clock at dt 0, camera parked), rendered many ways:
 *
 *   A  shipped   renderScale 0.85  ->  1632x918   -> bilinear up to 1920x1080
 *   B  native    renderScale 1.00  ->  1920x1080  (identity)
 *   C  truth     renderScale 4.00  ->  7680x4320  -> exact 4x4 box down to 1080p
 *
 * All arms END at 1920x1080, so what differs between them is not resolution, it
 * is how many geometric samples paid for each delivered pixel. C is therefore
 * the correctly integrated image and the target A has to close on.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT MICRO-CONTRAST / SHARPNESS / LAPLACIAN / BETWEEN-MATERIAL SPREAD
 * ---------------------------------------------------------------------------
 * Those are WRONG-SIGNED here and a previous round was retracted for using one.
 * A 4x integration cannot ADD high-frequency content that a 1080p grid can
 * represent; it can only REMOVE aliasing, and aliasing IS spurious
 * high-frequency energy. So the correct frame measures LOWER micro-contrast
 * than the shipped one, and any gate built on sharpness scores correct
 * anti-aliasing as a regression. This tool reproduces that inversion on purpose
 * (see the MAL sanity check) as evidence the rig sees the same thing -- but it
 * does not gate on it.
 *
 * RMSE-to-truth has no such ambiguity: the truth arm is zero by construction,
 * aliasing counts AGAINST an arm instead of for it, and the quantity is exactly
 * what temporal accumulation is supposed to drive down.
 *
 * ---------------------------------------------------------------------------
 * WHY SUBJECT PIXELS
 * ---------------------------------------------------------------------------
 * The robots are 6-8% of the frame. A whole-frame RMSE is dominated by the
 * arena, the crowd and the sky, none of which a player is reading during a
 * fight. The subject mask is not hand-drawn: it is a coverage render of the two
 * fighter hierarchies (unlit white, everything else hidden) taken at TRUTH
 * resolution and boxed down with the same integer filter as arm C, so a pixel
 * counts as subject if any of its 16 truth samples landed on a robot. Edge
 * pixels -- where the aliasing actually lives -- are therefore in the mask.
 *
 * ---------------------------------------------------------------------------
 * CONTROLS. All three kinds, and the SETUP one is the one that matters most.
 * ---------------------------------------------------------------------------
 *   SETUP    Every arm records the ARMED PASS LIST at the moment it renders --
 *            the actual composer.passes array plus the _passes keys -- and the
 *            run asserts it against what the mode asked for. An arm whose list
 *            is not the intended list is VOID and is reported as a defect.
 *            The config hazard this exists for: RenderPipeline.effects is a
 *            plain object and only setEffect() rebuilds the composer. Writing
 *            the flags directly sets them and REBUILDS NOTHING, which silently
 *            voided an earlier round -- every "post off" frame still went
 *            through AO, bloom, DOF, motion blur, AgX grade and SMAA. This tool
 *            never writes a flag; it only calls setEffect, and then it checks.
 *   NULL     The same arm is captured twice, separated by every other arm in
 *            the run. RMSE between the two must be ~0.00. Run late on purpose:
 *            residue left by another arm shows up here.
 *   POSITIVE renderScale 0.50 must score WORSE (HIGHER RMSE-to-truth) than the
 *            shipped arm. The SIGN is asserted, not just the magnitude -- a
 *            wrong-signed metric is the exact failure mode this brief is about.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE PROCESS
 * ---------------------------------------------------------------------------
 * Two page loads of an IDENTICAL scene tree differ by ~197,000 pixels, the same
 * magnitude as a real change. Anything captured across processes is reading its
 * own noise floor. Every arm here, including both null controls, is a re-render
 * of the SAME frozen frame inside the SAME page -- no reload, no restart.
 *
 *   node tools/ssgate.mjs
 *   node tools/ssgate.mjs --json scratchpad/ssgate.json
 *   node tools/ssgate.mjs --truth 4 --pin 150 --warm 16 --port 5212
 *   node tools/ssgate.mjs --no-shipped-block      (bare arms only, ~2x faster)
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

const PORT = Number(arg('port', 5212));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
/** Supersample factor for the truth arm. Integer so the box filter is an exact
 *  k x k average with no resampling error of its own. */
const TRUTH = Number(arg('truth', 4));
/**
 * Sim tick the frame is frozen on. Same mechanism as capture.mjs pinTicks.
 * 96 because capture.mjs stages 01-hero-idle with a 1600 ms settle and a clock
 * pinned at 1/60, which is ~96 ticks -- so this lands on the same part of the
 * idle cycle the reference shot does. Measured over ticks 30..300, px/m never
 * leaves 371.8..379.1, so the choice is not load-bearing for the metric; it is
 * load-bearing for REPRODUCIBILITY, which is why it is a tick and not a timer.
 */
const PIN = Number(arg('pin', 96));
const JSON_OUT = arg('json', '');
const KEEP_PNG = arg('png', '');
/** Warm renders before the measured one. Measured, not guessed -- see the long
 *  note on the planar reflector in MEASURE_JS. 3 was not enough and cost a
 *  previous version its null control. */
const WARM = Number(arg('warm', 16));
/** The shipped-post block costs ~2 minutes (4x through the full chain). It is a
 *  secondary read: with post armed, DOF at 4x is a much smaller blur relative to
 *  the image, so the A->C difference there is part sampling and part defocus. */
const WANT_SHIPPED = !argv.includes('--no-shipped-block');
/** Pixels differing by more than this many 8-bit luma units are counted. */
const OFF_BY = Number(arg('offby', 8));

/** The established fight framing. Asserted, not assumed. */
const FRAMING_REF = { dist: 4.59, fov: 35.5, pxPerM: 367 };
/**
 * The pass lists each mode must produce, as _passes keys. Asserted per arm.
 *
 * NOTE, added when temporal supersampling shipped: the SHIPPED chain changed.
 * TemporalAAPass took SMAA's slot (SMAA measured WORSE than doing nothing on
 * this very metric -- 18.19 against 16.71 at 0.85 -- so it was not giving
 * anything up), and the list is now
 *     scene,gbuffer,ao,bloom,dof,motionBlur,taa,grade,output
 * Both spellings are accepted here so this tool keeps running and keeps
 * reporting the ground truth it was built to pin, rather than failing its own
 * setup control on a change it is supposed to be measuring. The BARE and SMAA
 * modes are untouched: setMode('bare') turns taa off along with everything
 * else, so the gate block is byte-for-byte the same experiment it always was.
 * The temporal arms live in tools/taagate.mjs.
 */
const EXPECT_PASSES = {
  bare: 'render,output',
  smaa: 'render,smaa,output',
  shipped: 'scene,gbuffer,ao,bloom,dof,motionBlur,grade,smaa,output',
  shippedTaa: 'scene,gbuffer,ao,bloom,dof,motionBlur,taa,grade,output',
};
const EXPECT_ALTS = { shipped: ['shipped', 'shippedTaa'] };
const passListOk = (mode, got) =>
  (EXPECT_ALTS[mode] || [mode]).some((k) => EXPECT_PASSES[k] === got);

/* ---------------------------------------------------------------------------
 * PAGE-SIDE CODE. Everything below runs inside the browser.
 * ------------------------------------------------------------------------ */

/** capture.mjs PIN_CLOCK, verbatim in behaviour: one rendered frame = one tick. */
const PIN_CLOCK = `
  if (!window.__kbClock) window.__kbClock = window.KB.clock.getDelta.bind(window.KB.clock);
  window.KB.timeScale = 1;
  window.KB.clock.getDelta = () => 1 / 60;
`;

/**
 * Freeze the frame. Five things have to stop moving, and capture.mjs learned
 * each of them the hard way:
 *   1. the SIM             -> KB.paused
 *   2. the CLOCK           -> getDelta() = 0; springs integrate per RENDER frame
 *   3. the CAMERA RIG      -> FightCamera.render runs off the render loop and
 *                             KB.paused does not stop it. Park it by closure.
 *                             Load-bearing here in a way it is not in capture:
 *                             arms are differenced against each other, so a
 *                             camera drifting 2 mm turns the measurement into a
 *                             parallax reading.
 *   4. GRAIN + CHROMA      -> the grade hashes on gl_FragCoord PLUS uTime, so it
 *                             re-rolls every RENDERED frame even at dt 0. A
 *                             per-pixel dither would land straight in the RMSE.
 *   5. ADAPTIVE RESOLUTION -> it is read per frame and would fight every
 *                             renderScale this tool sets. (This one genuinely
 *                             does take effect by flag; it owns no pass.)
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

/**
 * SETUP CONTROL. Read the composer's ACTUAL pass array, not the flags.
 * 'keys' is the list the brief quotes ("scene gbuffer ao bloom dof motionBlur
 * grade smaa output" vs "render output"); 'armed' is the constructor names of
 * the passes the renderer really walks. Both are recorded for every arm.
 */
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
 * evidence. 'shadows' is never touched: shadows are geometry-rate, not a post
 * pass, and removing them would change which edges exist rather than how they
 * are sampled.
 */
const SET_MODE_JS = `((want) => {
  const r = window.KB.renderer;
  const keysOf = () => Object.keys(r._passes || {}).join(',');
  const armedOf = () => (r.composer ? r.composer.passes : []).map((p) => p.constructor.name).join(' ');
  const before = { keys: keysOf(), armed: armedOf() };
  // 'taa' joined this list when temporal supersampling shipped. It must be
  // here: the bare block's whole point is that only 'render' and 'output' are
  // armed, and a flag left at its default would put a temporal pass inside the
  // arm that defines the ground truth.
  for (const name of ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'taa']) {
    r.setEffect(name, !!want[name]);
  }
  const after = { keys: keysOf(), armed: armedOf() };
  return { before, after, changed: before.keys !== after.keys || before.armed !== after.armed };
})`;

/**
 * THE SUBJECT MASK.
 *
 * Coverage render of the two fighter hierarchies at TRUTH resolution, boxed
 * down with the same integer filter as arm C. Method:
 *   - hide every branch of the scene that is not on a path to a fighter root
 *   - scene.overrideMaterial = unlit white, no fog, no background
 *   - camera.layers.enableAll() so the split-lighting layer shuffle cannot hide
 *     the subject from the mask camera
 *   - draw straight to the DEFAULT framebuffer with the raw WebGLRenderer,
 *     bypassing the composer entirely, so the mask does not depend on which
 *     post passes happen to be armed
 *   - read it back through the SAME canvas / box-down path the arms use, so the
 *     mask is registered to the arms by construction rather than by argument
 *
 * The default framebuffer has no MSAA, so every truth-resolution sample is
 * exactly 0 or 255 and the box average is exactly the coverage fraction.
 * Everything touched is saved and restored.
 */
const MASK_JS = `((k) => {
  const KB = window.KB, THREE = KB.THREE;
  const r = KB.renderer, gl = r.renderer, scene = KB.scene, cam = KB.camera;

  const roots = KB.fighters.map((f) => f.robot && f.robot.group).filter(Boolean);
  if (roots.length !== KB.fighters.length) throw new Error('could not resolve every fighter robot group');

  // Two sets, and keeping them apart is the whole trick:
  //   rootSet -- the subject subtrees. NEVER descended into, so a robot keeps
  //              its own internal visibility exactly as the beauty pass sees it
  //              (a hidden hand stays hidden, because it is not drawn either).
  //   keep    -- the ancestors between the scene and those roots. Descended
  //              into, so their OTHER children get hidden.
  // Descending into the roots as well is a real bug and it produced a mask of
  // zero pixels on the first run of this tool.
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
      if (rootSet.has(c)) continue;              // subject: leave the subtree alone
      if (keep.has(c)) { walk(c); continue; }    // ancestor: descend
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

  // coverage in 0..1; subject = any truth sample landed on a robot
  const cov = out.plane;
  const mask = new Uint8Array(cov.length);
  let n = 0, nFull = 0;
  for (let i = 0; i < cov.length; i++) {
    const c = cov[i] / 255;
    if (c > 0.001) { mask[i] = 1; n++; }
    if (c > 0.999) nFull++;
  }
  window.__ssMask = mask;
  // Visual setup control: the mask itself, as a PNG, so a human can confirm the
  // gate is scoring the robots and not, say, the crowd or an empty frame.
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

/**
 * Shared readback. Pulls the CURRENT default framebuffer into a 1920x1080
 * plane. Two paths, and drawImage is used ONLY at 1:1 so no part of any number
 * depends on Chrome's smoothing quality:
 *   - sw is an integer multiple of W  -> exact k x k box average (k = 1 is the
 *     identity). This is the truth arm and the mask.
 *   - otherwise -> bilinear upscale, which is the model of what the compositor
 *     does with a 1632x918 drawing buffer in a 1920x1080 CSS box. This is the
 *     shipped arm and the 0.50 positive control.
 * 'lumaOnly' returns green-channel-free Rec.709 luma; the mask uses the same
 * path (white is luma 255, black is 0) so mask and arms share one filter.
 */
const BOXDOWN_JS = `((k, isMask) => {
  const W = ${WIDTH}, H = ${HEIGHT};
  const gl = window.KB.renderer.canvas;
  const sw = gl.width, sh = gl.height;
  const tmp = window.__ssTmp || (window.__ssTmp = document.createElement('canvas'));
  if (tmp.width !== sw || tmp.height !== sh) { tmp.width = sw; tmp.height = sh; }
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingEnabled = false;
  // Black backing FIRST, then source-over. The WebGL canvas may carry alpha,
  // and copying it into an undefined surface would make the readback depend on
  // how the browser stores unpremultiplied zero-alpha pixels.
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
 * Render one arm at a given renderScale and retain its 1920x1080 luma plane.
 *
 * WARM FRAMES, AND THE NUMBER IS MEASURED, NOT GUESSED.
 *
 * Two renders of this frozen frame inside ONE task are bit-identical once grain
 * and chroma are zeroed -- the renderer is deterministic. What is NOT
 * deterministic across a resize is THE PLANAR REFLECTION, and it is a temporal
 * cache:
 *   - PlanarReflector refreshes every 2nd ARMED frame (opts.interval = 2)
 *   - it is armed by Stage.update -> reflector.arm(++this._frame)
 *   - Stage.update is called ONLY by Game.#render, i.e. only by the rAF loop
 * A manual renderer.render therefore draws the floor with whatever reflection
 * the last rAF frame left in the buffer, at THAT frame's resolution, because
 * Stage rebinds the reflection target size from the drawing buffer in the
 * floor's onBeforeRender. After switching to 4x, whether an arm caught the
 * refresh depended on how many rAF frames fell inside the driver round-trip.
 * That made an earlier truth arm fail its own null control by 6.1%.
 *
 * Fix, and it is why this loop calls Stage.update at dt 0 alongside every
 * render: the mirror is armed on THIS tool's frames rather than on the game
 * loop's, and the cache is invalidated once after each resize so the first
 * armed frame must refresh. dt 0 means Stage._time does not advance, so
 * nothing in the stage animates -- the call is there for arm(), not animation.
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

  // measured frame + readback, ONE synchronous task -- which is what makes the
  // read legal without preserveDrawingBuffer
  step();
  const out = window.__ssBoxDown(scale, false);
  window.__ssPlanes[label] = out.plane;

  // SETUP CONTROL, recorded at the moment of the render rather than around it
  const passes = {
    keys: Object.keys(r._passes || {}).join(','),
    armed: (r.composer ? r.composer.passes : []).map((p) => p.constructor.name).join(' '),
  };
  let mean = 0;
  for (let i = 0; i < out.plane.length; i++) mean += out.plane[i];
  return {
    label, renderScale: scale, rendered: out.rendered,
    meanLuma: +(mean / out.plane.length).toFixed(3),
    passKeys: passes.keys, passArmed: passes.armed,
    png: out.png,
  };
})`;

/**
 * THE METRIC. RMSE against a named truth plane, in 8-bit luma units.
 *   rmseAll     -- over all 2,073,600 pixels
 *   rmseSubject -- over the subject mask only. THIS is the gate.
 *   offBy       -- subject pixels whose absolute error exceeds the threshold
 * maxErr and mae are reported for context, not for gating.
 */
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

/**
 * MICRO-CONTRAST, REPORTED AND EXPLICITLY NOT GATED ON.
 *
 * Mean absolute Laplacian of luma over the subject mask. Present for exactly
 * one reason: to reproduce, inside this rig, the fact that the CORRECT frame
 * (arm C) scores LOWER than the shipped one (arm A). If a rig cannot reproduce
 * that inversion it is not measuring what the retraction measured. Nothing in
 * the gate reads this number.
 */
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
    // 'defects' fails the run (exit 2). 'secondaryDefects' are real control
    // failures scoped to the shipped-post block, which is a documented
    // secondary read -- they are printed just as loudly but do not fail the
    // gate, because the gate is the bare block.
    defects: [], secondaryDefects: [], void: [],
  };
  const pngs = {};

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
    await page.waitForTimeout(2500);   // shader compilation

    // -- stage the fight framing, exactly as 01-hero-idle does ---------------
    await page.evaluate(`(() => { ${PIN_CLOCK} })()`);
    await page.evaluate(`(() => {
      window.KB.menus.show(null);
      window.KB.debug.freecam = false;
      window.KB.paused = false;
      window.KB.startMatch(0, 1);
      window.KB.setPhase('fight');
    })()`);
    // Pin the pose. Wait and pause in ONE page-side callback: polling from the
    // driver returns only when Playwright OBSERVES the tick, and more ticks run
    // during the round trip.
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

    // -- SETUP CONTROL 1: is this the fight framing? -------------------------
    // A metric taken at the wrong crop is not wrong-ish, it is a different
    // measurement. The closeup framing is 2003 px/m, so an 8% tolerance on
    // px/m catches the real failure mode by a factor of five.
    //
    // px/m IS THE GATE; dist and fov are recorded but NOT gated, and here is
    // why. FightCamera is a dolly-zoom rig: measured across ticks 30..300 it
    // walks dist 4.93 -> 5.37 while fov walks 34.94 -> 33.24, and px/m stays
    // inside 371.8..379.1 the whole way. dist and fov are two points on one
    // curve; the thing that decides what a pixel subtends -- and therefore what
    // the metric can see -- is the product, which is px/m. Note also that
    // robot.group.position is a LOCAL position (the two fighters read a
    // separation of 0.000 from it), so 'dist' here is camera-to-origin and is
    // not directly comparable to a distance measured to a different anchor.
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

    // -- install page-side machinery ----------------------------------------
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
    if (!passListOk('shipped', report.passesAsShipped.keys)) {
      report.defects.push(`as-shipped pass list is [${report.passesAsShipped.keys}], expected [${EXPECT_PASSES.shipped}] or [${EXPECT_PASSES.shippedTaa}]`);
    }

    const setMode = async (mode) => {
      const want = mode === 'bare'
        ? { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: false }
        : mode === 'smaa'
          ? { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: true }
          : { ao: true, bloom: true, dof: true, motionBlur: true, grade: true, smaa: true };
      const t = await page.evaluate(`window.__ssSetMode(${JSON.stringify(want)})`);
      report.controls[`setEffect_${mode}`] = t;
      if (!passListOk(mode, t.after.keys)) {
        report.defects.push(`setEffect('${mode}') produced [${t.after.keys}], expected [${EXPECT_PASSES[mode]}]`);
      }
      return t;
    };

    const run = async (scale, label, expectMode, warm = WARM) => {
      const a = await page.evaluate(`window.__ssMeasure(${scale}, ${warm}, '${label}')`);
      if (a.png) { pngs[label] = a.png; }
      delete a.png;
      a.expectMode = expectMode;
      // SETUP CONTROL, per arm. An arm whose pass list is not the intended list
      // is VOID -- this is the exact check whose absence voided a prior round.
      if (!passListOk(expectMode, a.passKeys)) {
        report.void.push(label);
        report.defects.push(`VOID ARM ${label}: rendered with [${a.passKeys}], mode '${expectMode}' requires [${EXPECT_PASSES[expectMode]}]`);
      }
      if (a.meanLuma < 2) report.defects.push(`arm ${label} looks dead (meanLuma ${a.meanLuma})`);
      report.arms[label] = a;
      console.log(`[ssgate] ${label.padEnd(12)} rs=${String(scale).padEnd(5)} ${a.rendered.padEnd(9)} mean=${String(a.meanLuma).padEnd(7)} passes=[${a.passKeys}]`);
      return a;
    };

    // -- SUBJECT MASK, built once at truth resolution ------------------------
    console.log('[ssgate] building subject mask at truth resolution ...');
    await setMode('bare');
    await page.evaluate(`(() => {
      const r = window.KB.renderer;
      r.renderScale = ${TRUTH}; r._targetScale = ${TRUTH}; r.resize();
    })()`);
    // one real frame first so shadow/reflection state matches the arms
    await page.evaluate(`(() => {
      const KB = window.KB, r = KB.renderer;
      for (let i = 0; i < 4; i++) { if (KB.stage) KB.stage.update(0, KB.tick); r.render(KB.scene, KB.camera, 1 / 60); }
    })()`);
    report.mask = await page.evaluate(`window.__ssMakeMask(${TRUTH})`);
    if (report.mask.png) { pngs.MASK = report.mask.png; delete report.mask.png; }
    console.log(`[ssgate] mask: ${report.mask.subjectPx} subject px (${report.mask.subjectPct}% of frame), ` +
      `${report.mask.interiorPx} interior + ${report.mask.edgePx} partial-coverage edge, from ${report.mask.rendered}`);
    if (report.mask.rendered !== `${WIDTH * TRUTH}x${HEIGHT * TRUTH}`) {
      report.defects.push(`mask rendered at ${report.mask.rendered}, expected ${WIDTH * TRUTH}x${HEIGHT * TRUTH}`);
    }
    if (report.mask.subjectPx < 20000 || report.mask.subjectPct > 40) {
      report.defects.push(`subject mask is implausible: ${report.mask.subjectPx} px (${report.mask.subjectPct}%)`);
    }

    // =====================================================================
    // BARE BLOCK -- 'render output'. This is where the standing numbers live.
    // With post off there is no DOF, so the ONLY thing differing between arms
    // is how many geometric samples paid for each pixel. That is the point.
    // =====================================================================
    console.log('\n[ssgate] --- BARE BLOCK (render output) ---');
    await run(0.85, 'A_bare', 'bare');
    await run(1.0, 'B_bare', 'bare');
    await run(TRUTH, 'C_truth', 'bare');
    await run(TRUTH, 'C_truth_null', 'bare');       // instrument floor
    await run(0.5, 'P_half', 'bare');               // POSITIVE control
    await run(0.85, 'A_bare_null', 'bare');         // NULL control, late on purpose

    // -- SMAA arm, armed THROUGH setEffect and asserted ----------------------
    await setMode('smaa');
    await run(1.0, 'B_smaa', 'smaa');
    await run(0.85, 'A_smaa', 'smaa');
    await setMode('bare');

    if (report.arms.C_truth && report.arms.C_truth.rendered !== `${WIDTH * TRUTH}x${HEIGHT * TRUTH}`) {
      report.defects.push(`truth arm rendered ${report.arms.C_truth.rendered} -- the supersample did not take`);
    }

    const cmp = async (label, truth) => {
      const c = await page.evaluate(`window.__ssCompare('${label}', '${truth}', ${OFF_BY})`);
      report.compare[label] = { ...c, vs: truth };
      return c;
    };
    for (const l of ['A_bare', 'B_bare', 'C_truth_null', 'P_half', 'A_bare_null', 'B_smaa', 'A_smaa']) {
      await cmp(l, 'C_truth');
    }

    // -- NULL CONTROLS: same arm twice, must be ~0.00 ------------------------
    report.controls.null_A = await page.evaluate(`window.__ssCompare('A_bare_null', 'A_bare', ${OFF_BY})`);
    report.controls.null_C = await page.evaluate(`window.__ssCompare('C_truth_null', 'C_truth', ${OFF_BY})`);

    // -- MICRO-CONTRAST SANITY (reported, never gated on) --------------------
    for (const l of ['A_bare', 'B_bare', 'C_truth']) {
      report.microContrast[l] = {
        subject: await page.evaluate(`window.__ssMal('${l}', true)`),
        frame: await page.evaluate(`window.__ssMal('${l}', false)`),
      };
    }

    // =====================================================================
    // SHIPPED BLOCK -- the full chain, i.e. what a player actually sees.
    // Secondary: with post armed, DOF at 4x is a much smaller blur relative to
    // the image, so this A->C difference is part sampling and part defocus.
    // Reported with that caveat; the gate is the bare block.
    // =====================================================================
    if (WANT_SHIPPED) {
      console.log('\n[ssgate] --- SHIPPED BLOCK (full chain) ---');
      await setMode('shipped');
      await page.evaluate(`window.KB.renderer.setGrade({ grain: 0, chroma: 0 });`);
      await run(0.85, 'A_ship', 'shipped');
      await run(1.0, 'B_ship', 'shipped');
      await run(TRUTH, 'C_ship_truth', 'shipped');
      await run(0.85, 'A_ship_null', 'shipped');
      for (const l of ['A_ship', 'B_ship', 'A_ship_null']) await cmp(l, 'C_ship_truth');
      report.controls.null_A_ship = await page.evaluate(`window.__ssCompare('A_ship_null', 'A_ship', ${OFF_BY})`);
      // NULL CONTROL FOR THE SHIPPED BLOCK, reported rather than worked around.
      // This one does NOT come back clean on the whole frame and the failure is
      // recorded here instead of being tuned away.
      const ns = report.controls.null_A_ship;
      report.shippedNullVerdict = {
        rmseSubject: ns.rmseSubject, rmseAll: ns.rmseAll,
        maxErrAll: ns.maxErrAll, pxOverThrAll: ns.offByAll, pxOverThrSubject: ns.offBySubject,
        subjectClean: ns.rmseSubject === 0 && ns.offBySubject === 0,
        frameClean: ns.rmseAll < 0.05,
      };
      if (!report.shippedNullVerdict.frameClean) {
        report.secondaryDefects.push(
          `SHIPPED-BLOCK WHOLE-FRAME NULL FAILED: two captures of A_ship differ by rmseAll ${ns.rmseAll} ` +
          `(${ns.offByAll} px over ${OFF_BY}/255, max ${ns.maxErrAll}) while rmseSubject is ${ns.rmseSubject} with ` +
          `${ns.offBySubject} px over threshold. The instability is ENTIRELY OUTSIDE the subject mask, so the ` +
          `shipped block's RMSE-all column is not trustworthy and its RMSE-subject column is. Consistent with the ` +
          `planar floor reflection, which is a temporal cache refreshed every 2nd armed frame and covers most of ` +
          `the non-subject frame -- stated as consistent-with, not as proven.`);
      }
      report.microContrast.A_ship = {
        subject: await page.evaluate(`window.__ssMal('A_ship', true)`),
        frame: await page.evaluate(`window.__ssMal('A_ship', false)`),
      };
      report.microContrast.C_ship_truth = {
        subject: await page.evaluate(`window.__ssMal('C_ship_truth', true)`),
        frame: await page.evaluate(`window.__ssMal('C_ship_truth', false)`),
      };
    }

    // -- did anything drift over the whole run? ------------------------------
    report.framingAfter = await page.evaluate(`(() => {
      const KB = window.KB, cam = KB.camera, THREE = KB.THREE;
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
    const nA = report.controls.null_A, nC = report.controls.null_C;

    // NULL CONTROL. The bar is stated relative to the signal rather than as a
    // bare epsilon: a null is a failure when it is big enough to be mistaken
    // for a result. 0.5% of the quantity being measured, and ZERO pixels past
    // the reporting threshold, is that bar.
    const nullBar = A.rmseSubject * 0.005;
    const nullPass = nA.rmseSubject < nullBar && nC.rmseSubject < nullBar &&
                     nA.offBySubject === 0 && nC.offBySubject === 0;

    // POSITIVE CONTROL. THE SIGN IS THE ASSERTION, not the magnitude -- a
    // wrong-signed metric is the exact failure this whole brief exists to
    // prevent. Half resolution must land FURTHER from truth on both readings.
    const posSign = P.rmseSubject > A.rmseSubject && P.rmseAll > A.rmseAll;

    // MICRO-CONTRAST INVERSION, reproduced against the RIGHT PAIR.
    // The comparison on record is bare-1x vs bare-4x, i.e. B vs C. Both are
    // scored on the native 1920x1080 grid with no resampling of their own, so
    // the only difference between them is integration. Comparing C against A
    // instead would be meaningless: A is bilinear-upscaled from 1632x918, so it
    // is blurred by the upscale and scores low for a reason that has nothing to
    // do with supersampling. That confound is exactly the shape of the mistake
    // the retraction was about, so it is called out rather than left implicit.
    const mcB = report.microContrast.B_bare.subject, mcC = report.microContrast.C_truth.subject;
    const mcInvert = mcC < mcB;
    report.microContrastInversion = {
      pair: 'B_bare (bare-1x) vs C_truth (bare-4x), subject pixels',
      bare1x: mcB, bare4x: mcC,
      delta_pct: +((100 * (mcC - mcB)) / mcB).toFixed(2),
      reproduced: mcInvert,
      note: 'on record: -13.3%. Supersampling REMOVES aliasing, and aliasing is high-frequency energy, so the correct frame scores LOWER. This is why micro-contrast is not the gate.',
    };

    if (!nullPass) report.defects.push(`NULL CONTROL FAILED: A-null rmseSubject ${nA.rmseSubject} / ${nA.offBySubject}px, C-null ${nC.rmseSubject} / ${nC.offBySubject}px (bar ${nullBar.toFixed(4)} and 0 px)`);
    if (!posSign) report.defects.push(`POSITIVE CONTROL WRONG-SIGNED: half-res rmseSubject ${P.rmseSubject} is not worse than shipped ${A.rmseSubject}`);
    if (!mcInvert) report.defects.push(`micro-contrast inversion NOT reproduced: bare-4x ${mcC} >= bare-1x ${mcB} -- the rig disagrees with the established retraction`);

    report.verdict = {
      metric: 'rmseSubject vs C_truth (lower is better)',
      A_shipped_085: A.rmseSubject,
      B_native_100: B.rmseSubject,
      C_truth_4x: 0,
      // C is zero BY CONSTRUCTION -- it is the reference. So the A->C gap is
      // the whole of A's RMSE: 100% of it is there to be closed. The number
      // that is actually a percentage of something physical is the normalised
      // RMSE, i.e. A's error as a fraction of the subject's own mean luma.
      A_to_C_gap_pct: 100,
      A_to_C_gap_nrmse_pct: A.nrmseSubjectPct,
      B_to_C_gap_nrmse_pct: B.nrmseSubjectPct,
      B_closes_pct_of_A: +((100 * (A.rmseSubject - B.rmseSubject)) / A.rmseSubject).toFixed(2),
      null_control_rmse_subject: Math.max(nA.rmseSubject, nC.rmseSubject),
      null_control_rmse_all: Math.max(nA.rmseAll, nC.rmseAll),
      null_control_px_over_thr: Math.max(nA.offBySubject, nC.offBySubject),
      null_pass: nullPass,
      positive_control_rmse: P.rmseSubject,
      positive_control_delta_pct: +((100 * (P.rmseSubject - A.rmseSubject)) / A.rmseSubject).toFixed(2),
      positive_sign_correct: posSign,
      microcontrast_inversion_reproduced: mcInvert,
      voidArms: report.void,
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
    return `  ${name.padEnd(16)} ${String(c.rmseAll ?? '-').padStart(8)} ${String(c.rmseSubject ?? '-').padStart(10)} ` +
           `${String(c.offBySubject ?? '-').padStart(12)} ${String(a.rendered ?? '-').padStart(10)}  [${a.passKeys ?? '-'}]`;
  };

  console.log('\n==================== ssgate ====================');
  console.log(`METRIC   RMSE vs the ${TRUTH}x-integrated frame, over SUBJECT PIXELS, 8-bit luma. LOWER IS BETTER.`);
  console.log(`FRAMING  ${JSON.stringify(report.framing)}`);
  console.log(`         vs ref ${JSON.stringify(report.framingRef)} -> ${JSON.stringify(report.framingDelta)}`);
  console.log(`MASK     ${report.mask?.subjectPx} subject px (${report.mask?.subjectPct}% of frame) = ` +
    `${report.mask?.interiorPx} interior + ${report.mask?.edgePx} partial-coverage edge`);
  console.log(`SETUP    as-shipped pass list [${report.passesAsShipped?.keys}]`);
  console.log(`         at end             [${report.passesAtEnd?.keys}]`);

  console.log('\n-- BARE BLOCK (render output) -- the gate ------------------------------------');
  console.log(`  ${'arm'.padEnd(16)} ${'RMSE all'.padStart(8)} ${'RMSE subj'.padStart(10)} ${`subj >${OFF_BY}/255`.padStart(12)} ${'rendered'.padStart(10)}  [passes]`);
  console.log(row('A shipped 0.85', 'A_bare'));
  console.log(row('B native 1.00', 'B_bare'));
  console.log(`  ${'C truth 4x'.padEnd(16)} ${'0.0000'.padStart(8)} ${'0.0000'.padStart(10)} ${'0'.padStart(12)} ${String(report.arms.C_truth?.rendered).padStart(10)}  [${report.arms.C_truth?.passKeys}]`);
  console.log(row('SMAA 1.00', 'B_smaa'));
  console.log(row('SMAA 0.85', 'A_smaa'));

  console.log('\n-- CONTROLS -----------------------------------------------------------------');
  console.log(`  NULL   A_bare captured twice, 6 arms apart : rmseAll ${report.controls.null_A?.rmseAll}  rmseSubject ${report.controls.null_A?.rmseSubject}  px>${OFF_BY} ${report.controls.null_A?.offBySubject}  maxErr ${report.controls.null_A?.maxErrAll}`);
  console.log(`  NULL   C_truth captured twice             : rmseAll ${report.controls.null_C?.rmseAll}  rmseSubject ${report.controls.null_C?.rmseSubject}  px>${OFF_BY} ${report.controls.null_C?.offBySubject}  maxErr ${report.controls.null_C?.maxErrAll}`);
  console.log(row('POS half 0.50', 'P_half'));
  console.log(`  POS    sign: half-res ${R('P_half').rmseSubject} vs shipped ${R('A_bare').rmseSubject} -> ` +
    `${pct(report.verdict?.positive_control_delta_pct)}  ${report.verdict?.positive_sign_correct ? 'CORRECT (worse, as required)' : 'WRONG SIGN'}`);
  console.log(`  SETUP  void arms: ${report.void.length ? report.void.join(' ') : 'none'}`);

  console.log('\n-- MICRO-CONTRAST: reported, NOT gated on ------------------------------------');
  console.log('   (the correct frame must score LOWER here; that is why it is not the metric)');
  for (const [k, v] of Object.entries(report.microContrast)) {
    console.log(`  ${k.padEnd(16)} subject MAL ${String(v.subject).padStart(9)}   frame MAL ${String(v.frame).padStart(9)}`);
  }
  const mci = report.microContrastInversion || {};
  console.log(`  INVERSION CHECK (bare-1x vs bare-4x, the pair on record): ${mci.bare1x} -> ${mci.bare4x} = ${pct(mci.delta_pct)}` +
    `   ${mci.reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'}   (on record: -13.3%)`);
  console.log('  A_bare scores lowest of all three because it is bilinear-upscaled from 1632x918,');
  console.log('  which is a resampling blur, not integration -- do not read A vs C as the inversion.');

  if (WANT_SHIPPED) {
    console.log('\n-- SHIPPED BLOCK (full chain) -- secondary, DOF confound ---------------------');
    console.log('   With post armed the 4x truth is also LESS DEFOCUSED (DOF radius is in');
    console.log('   pixels of the render target), so this gap is part sampling, part blur.');
    console.log(row('A shipped 0.85', 'A_ship'));
    console.log(row('B native 1.00', 'B_ship'));
    const sv = report.shippedNullVerdict || {};
    console.log(`  NULL   A_ship twice: rmseSubject ${sv.rmseSubject} / ${sv.pxOverThrSubject} px  ${sv.subjectClean ? 'CLEAN' : 'DIRTY'}` +
      `   |   rmseAll ${sv.rmseAll} / ${sv.pxOverThrAll} px  ${sv.frameClean ? 'CLEAN' : 'DIRTY'}`);
    if (!sv.frameClean) {
      console.log('         ^ the shipped block does not hold a whole-frame null. The instability is entirely');
      console.log('           outside the subject mask, so RMSE-subject is usable here and RMSE-all is not.');
    }
  }

  console.log('\n-- VERDICT ------------------------------------------------------------------');
  console.log(JSON.stringify(report.verdict, null, 2));
  if (report.defects.length) {
    console.log('\nGATE DEFECTS (these fail the run):');
    for (const d of report.defects) console.log(`  ! ${d}`);
  }
  if (report.secondaryDefects.length) {
    console.log('\nSECONDARY DEFECTS (shipped-post block only; reported, not worked around):');
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
