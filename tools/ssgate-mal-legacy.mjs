/**
 * ============================ RETRACTED. DO NOT RUN. =========================
 * This is the PREVIOUS round's ssgate, kept only as a record of how it was
 * built. Its headline metric is mean absolute Laplacian (MAL), and MAL IS
 * WRONG-SIGNED for this question: a 4x integration cannot add high-frequency
 * content a 1080p grid can represent, it can only remove ALIASING, and aliasing
 * is high-frequency energy. So the CORRECT frame scores LOWER on MAL, and a
 * gate built on it marks correct anti-aliasing as a regression. Measured here:
 * bare-1x subject MAL 43.62 -> bare-4x 39.24, i.e. -10.0%.
 *
 * The live gate is tools/ssgate.mjs and its metric is RMSE against the
 * 4x-integrated frame over subject pixels, lower is better. Use that one.
 * =============================================================================
 *
 * ssgate — the SUPERSAMPLING GATE.
 *
 * Pins the ground-truth target that temporal supersampling has to close.
 *
 * ONE browser process, ONE pinned frame, three renders of it:
 *
 *   A  shipped   renderScale 0.85  ->  1632x918  -> bilinear up to 1920x1080
 *   B  native    renderScale 1.00  ->  1920x1080 (identity)
 *   C  truth     renderScale 4.00  ->  7680x4320 -> 4x4 box average to 1920x1080
 *
 * All three arms END at 1920x1080, so the difference between them is NOT
 * resolution. It is how many geometric samples paid for each final pixel.
 *
 * WHY ONE PROCESS. docs/PROFILING.md: two page loads of an IDENTICAL scene tree
 * differ by ~197,000 pixels, the same magnitude as a real change. Anything
 * captured across processes is reading its own noise floor. So every arm here,
 * including the null control, is a re-render of the SAME frozen frame inside the
 * SAME page — no reload, no restart, no second Chromium.
 *
 * THE METRIC: mean absolute Laplacian of luma (MAL), in 0..255 luma units,
 * over the final 1920x1080 image. Justification in the header comment on
 * MEASURE_JS below.
 *
 * CONTROLS (both run by default, both are the point of the tool):
 *   null      — arm A is captured twice, once first and once LAST, with B, C
 *               and the positive control rendered in between. The metric must
 *               move by far less than the A->C gap. This is deliberately a
 *               harsher null than a back-to-back double grab: it also proves
 *               the renderScale round-trip leaves no residue.
 *   positive  — two of them:
 *               P1 (image space) box-blur the A image 2x down / 2x up. MUST fall.
 *               P2 (render path) renderScale 0.50 -> 960x540 -> up. MUST fall
 *                  below A, and by more than the null moves.
 *
 *   node tools/ssgate.mjs
 *   node tools/ssgate.mjs --truth 4 --pin 150 --port 5211
 *   node tools/ssgate.mjs --json out.json
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(arg('port', 5211));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
/** Supersample factor for the truth arm. Must be an integer so the box filter
 *  is an exact k x k average with no resampling error of its own. */
const TRUTH = Number(arg('truth', 4));
/** Sim tick the frame is frozen on. Same mechanism as capture.mjs pinTicks. */
const PIN = Number(arg('pin', 150));
const JSON_OUT = arg('json', '');
const KEEP_PNG = arg('png', '');
/** Warm renders before the measured one. See the note in MEASURE_JS -- this is
 *  the number that decides whether the instrument has a null control at all. */
const WARM = Number(arg('warm', 16));
/** 'on'  = the shipped post chain, i.e. what a player actually sees.
 *  'off' = every optional pass turned off THROUGH setEffect(), so the number is
 *          pure geometric sampling with no AO/bloom/DOF/motion-blur/grade/SMAA
 *          in it. See the CONFIG HAZARD note on POST_JS. */
const POST = String(arg('post', 'on'));
/** Also run an SMAA-only arm. Only meaningful with --post off, where it answers
 *  "how much of the geometric gap does the cheap edge pass actually recover".
 *  The previously reported -0.3% figure was RETRACTED because SMAA was never
 *  toggled; this arm toggles it and asserts the pass list moved. */
const WANT_SMAA_ARM = argv.includes('--smaa-arm');
if (WANT_SMAA_ARM && POST !== 'off') {
  console.error('--smaa-arm requires --post off (with post on, SMAA is already armed and the arm is a no-op)');
  process.exit(1);
}

/** The established fight framing, from docs. Asserted, not assumed. */
const FRAMING_REF = { dist: 4.59, fov: 35.5, pxPerM: 367 };

/* ---------------------------------------------------------------------------
 * PAGE-SIDE CODE
 *
 * Everything below runs inside the browser. Note the hard rule this file lives
 * under: no backtick may appear inside any of these template literals, not even
 * in a comment, or the string ends early and the build breaks silently.
 * ------------------------------------------------------------------------ */

/** capture.mjs PIN_CLOCK, verbatim in behaviour: one rendered frame = one tick. */
const PIN_CLOCK = `
  if (!window.__kbClock) window.__kbClock = window.KB.clock.getDelta.bind(window.KB.clock);
  window.KB.timeScale = 1;
  window.KB.clock.getDelta = () => 1 / 60;
`;

/**
 * Freeze the frame.
 *
 * Three separate things have to stop moving, and capture.mjs learned each of
 * them the hard way (docs/PROFILING.md trap 5):
 *   1. the SIM            -> KB.paused
 *   2. the CLOCK          -> getDelta() = 0, because the settle window is
 *                            wall-clock and springs integrate per RENDER frame
 *   3. the CAMERA RIG     -> FightCamera.render integrates off the render loop
 *                            and KB.paused does not stop it. Park it by closure
 *                            over the pose it had at the pin tick. This one is
 *                            load-bearing HERE in a way it is not in capture:
 *                            three arms are compared against each other, so a
 *                            camera that drifts 2mm between them turns the whole
 *                            measurement into a parallax reading.
 *   4. FILM GRAIN + CHROMA -> the grade hashes on gl_FragCoord PLUS uTime, so it
 *                            re-rolls every RENDERED frame even at dt 0. A
 *                            per-pixel dither is exactly what a Laplacian
 *                            metric measures, so leaving it on would drown the
 *                            signal in white noise. Killed, as pinTicks does.
 *   5. ADAPTIVE RESOLUTION -> it would fight every renderScale this tool sets.
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
  window.__ssRestore = { render: KB.fightCamera.render, simulate: KB.fightCamera.simulate };
  KB.fightCamera.render = park;
  KB.fightCamera.simulate = () => {};
  park();

  const r = KB.renderer;
  window.__ssTier = { adaptive: r.effects ? r.effects.adaptiveResolution : null,
                      renderScale: r.renderScale };
  if (r.effects) r.effects.adaptiveResolution = false;
  if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });

  // Framing certificate. Every arm must report these identically or the
  // comparison is not about sampling.
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
  };
})()`;

/**
 * SETUP CONTROL -- the armed pass list.
 *
 * THE CONFIG HAZARD, stated so nobody repeats it. RenderPipeline.effects is a
 * PLAIN OBJECT and the composer is only rebuilt inside setEffect(). Writing
 *     pipeline.effects.bloom = false
 * sets a flag and REBUILDS NOTHING; the full chain keeps rendering. A previous
 * round measured a whole supersample study with AO, bloom, DOF, motion blur,
 * AgX grade and SMAA all still armed while its notes said post was off.
 *
 * So this tool never trusts a flag. It reads composer.passes -- the actual
 * array the renderer walks every frame -- and asserts on it. Every arm dumps
 * it, and the run fails if the list is not the list the mode asked for.
 *
 * The one exception setEffect documents: adaptiveResolution, depthPrepass and
 * splitLighting own no pass, so they take effect by flag alone. adaptive IS
 * read per frame and IS turned off, by flag, in FREEZE.
 */
const PASSES_JS = `(() => {
  const r = window.KB.renderer;
  return {
    armed: (r.composer ? r.composer.passes : []).map((p) => p.constructor.name),
    keys: Object.keys(r._passes || {}),
    flags: Object.assign({}, r.effects),
    renderScale: r.renderScale,
    drawingBuffer: r.canvas.width + 'x' + r.canvas.height,
  };
})()`;

/**
 * Turn the optional post chain off THROUGH setEffect so the composer is really
 * rebuilt. Returns the pass list before and after so the caller can assert the
 * list actually changed -- the flag moving is not evidence.
 *
 * 'shadows' stays ON. Shadows are geometry-rate, not a post pass, and removing
 * them would change what edges exist rather than how they are sampled.
 */
const POST_OFF_JS = `((keepSmaa) => {
  const r = window.KB.renderer;
  const before = (r.composer ? r.composer.passes : []).map((p) => p.constructor.name);
  for (const name of ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa']) {
    r.setEffect(name, name === 'smaa' ? !!keepSmaa : false);
  }
  const after = (r.composer ? r.composer.passes : []).map((p) => p.constructor.name);
  return { before, after, changed: before.join() !== after.join() };
})`;

/**
 * Render one frame at a given renderScale and reduce it to a 1920x1080 luma
 * image, then score it.
 *
 * THE METRIC — mean absolute Laplacian of luma (MAL).
 *
 * Kernel [[0,1,0],[1,-4,1],[0,1,0]] on Rec.709 luma of the display-encoded
 * 8-bit frame, mean of the absolute response over interior pixels, reported in
 * luma units of 255.
 *
 * Chosen over the between-material tangent-slope spread for four reasons:
 *   1. IT IS THE THING BEING BOUGHT. The established finding is that the
 *      deficit is geometric aliasing at edges. A Laplacian is a second
 *      derivative: it is near zero on flat shading and on smooth gradients, and
 *      it peaks exactly on plate boundaries, greeble rows, rib stacks and bolt
 *      heads — the features named as the entire 3x difference. Tangent-slope
 *      spread is a MATERIALS statistic and the same finding says this is not a
 *      materials job.
 *   2. IT IS BLIND TO EXPOSURE. The kernel sums to zero, so any constant offset
 *      cancels. Arms that differ slightly in mean brightness are not rewarded.
 *   3. IT IS A SINGLE SCALAR AT A FIXED RESOLUTION. All three arms are scored
 *      at exactly 1920x1080, so the pixel grid, and therefore the frequency the
 *      kernel is sensitive to, is identical between arms. Nothing about the
 *      comparison depends on the intermediate resolution.
 *   4. IT IS MONOTONE IN THE THING WE WANT. More geometric samples per final
 *      pixel resolve MORE distinct edges into the 1080p grid, so MAL goes UP.
 *      Fewer samples smear them together, so MAL goes DOWN. That gives the
 *      positive control an unambiguous expected direction.
 *
 * The known weakness, stated rather than hidden: MAL also goes up for white
 * noise. That is why grain and chroma are forced to zero before any arm is
 * rendered, and why the null control is run last rather than first.
 *
 * RESAMPLING. Downscale (the truth arm) is an exact integer k x k box average —
 * no filter choice, no ringing, no vendor behaviour. Upscale (the shipped arm)
 * is bilinear, which is the model of what the browser compositor does with a
 * 1632x918 drawing buffer in a 1920x1080 CSS box. Both are done in this
 * function in plain JS: drawImage is used ONLY at 1:1, never to resample, so no
 * part of the number depends on Chrome's smoothing quality.
 *
 * The 1:1 drawImage and the render happen in the SAME synchronous task, which
 * is what makes the read legal without preserveDrawingBuffer.
 */
const MEASURE_JS = `(scale, warm, label) => {
  const KB = window.KB, r = KB.renderer;
  const W = ${WIDTH}, H = ${HEIGHT};

  r.renderScale = scale;
  r._targetScale = scale;
  if (typeof r.resize === 'function') r.resize();

  // WARM FRAMES, AND THE NUMBER IS MEASURED, NOT GUESSED.
  //
  // Two renders of this frozen frame inside ONE task are bit-identical: mae
  // 0.0000 over 2,073,600 pixels, 0 differing pixels, at both 1920x1080 and
  // 7680x4320, once grain and chroma are zeroed. The renderer is deterministic.
  //
  // But the game's own rAF loop keeps calling Game.frame between two driver
  // round-trips, and those frames knock the pipeline off that fixed point.
  // Measured, camera provably identical to six decimals and uGrain provably 0:
  //     2 rAF frames in between, 4 warm renders   -> mae 2.81, 771,748 px differ
  //     3 rAF frames in between, 3 warm renders   -> mae 3.08, 12,523,456 px
  //     2 rAF frames in between, 10 warm renders  -> mae 0.0000, 0 px
  // So the state converges, and 3-4 renders is simply not far enough back. The
  // first version of this tool used 3 and its truth arm failed its own null
  // control by 6.3% -- larger than the whole B->C gap it was built to measure.
  //
  // WHAT WAS ACTUALLY DRIFTING, once the convergence story above was measured
  // and found NOT to be the cause (within one task the trajectory after a
  // resize is flat from frame 2 onwards: mal 8.0893 at frames 2..48, 0 pixels
  // differing). It is THE PLANAR REFLECTION, and it is a temporal cache:
  //   - PlanarReflector refreshes every 2nd ARMED frame (opts.interval = 2)
  //   - it is armed by Stage.update -> this.reflector.arm(++this._frame)
  //   - Stage.update is called ONLY by Game.#render, i.e. only by the rAF loop
  // A manual renderer.render therefore draws the floor with whatever reflection
  // the last rAF frame left in the buffer -- at the last rAF frame's
  // RESOLUTION, because Stage rebinds the reflection target size from the
  // drawing buffer in the floor's onBeforeRender. So after switching to 4x, the
  // first arm's worth of frames reflected a stale 1920x1080-era buffer, and
  // whether an arm caught the refresh depended on how many rAF frames happened
  // to fall in the driver round-trip. That is what made the truth arm fail its
  // own null by 6.1% -- three times the entire B->C gap.
  //
  // Fix: drive Stage.update at dt 0 alongside every render, so the mirror is
  // armed on this tool's frames rather than on the game loop's, and invalidate
  // the cache once after the resize so the first armed frame must refresh.
  const stage = KB.stage;
  if (stage && stage.reflector && typeof stage.reflector.invalidate === 'function') stage.reflector.invalidate();
  const step = () => {
    // dt 0: Stage._time does not advance, so nothing in the stage animates.
    // The call is here for arm(), not for animation.
    if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
    r.render(KB.scene, KB.camera, 1 / 60);
  };
  for (let i = 0; i < warm; i++) step();

  // MEASURED FRAME + READBACK, one task.
  step();
  const gl = r.canvas;
  const sw = gl.width, sh = gl.height;

  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingEnabled = false;
  // Black backing first: the WebGL canvas may carry alpha, and compositing it
  // over an undefined surface would make the readback depend on the browser.
  tctx.fillStyle = '#000'; tctx.fillRect(0, 0, sw, sh);
  tctx.drawImage(gl, 0, 0);          // 1:1 only. Never a resample.

  const luma = new Float32Array(W * H);
  const R = 0.2126, G = 0.7152, B = 0.0722;

  if (sw >= W && sw % W === 0 && sh % H === 0) {
    // -- exact integer box downscale (k = 1 is the identity) ----------------
    const k = sw / W;
    for (let oy = 0; oy < H; oy++) {
      const band = tctx.getImageData(0, oy * k, sw, k).data;
      const row = oy * W;
      for (let ox = 0; ox < W; ox++) {
        let acc = 0;
        for (let j = 0; j < k; j++) {
          let p = (j * sw + ox * k) * 4;
          for (let i = 0; i < k; i++, p += 4) {
            acc += R * band[p] + G * band[p + 1] + B * band[p + 2];
          }
        }
        luma[row + ox] = acc / (k * k);
      }
    }
  } else {
    // -- bilinear upscale (the shipped arm, and the 0.50 positive control) --
    const src = tctx.getImageData(0, 0, sw, sh).data;
    const sl = new Float32Array(sw * sh);
    for (let i = 0, p = 0; i < sl.length; i++, p += 4) {
      sl[i] = R * src[p] + G * src[p + 1] + B * src[p + 2];
    }
    const fx = sw / W, fy = sh / H;
    for (let oy = 0; oy < H; oy++) {
      const sy = Math.min(sh - 1, Math.max(0, (oy + 0.5) * fy - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), wy = sy - y0;
      for (let ox = 0; ox < W; ox++) {
        const sx = Math.min(sw - 1, Math.max(0, (ox + 0.5) * fx - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), wx = sx - x0;
        const a = sl[y0 * sw + x0], b = sl[y0 * sw + x1];
        const c = sl[y1 * sw + x0], d = sl[y1 * sw + x1];
        luma[oy * W + ox] = (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
      }
    }
  }

  const out = window.__ssScore(luma, W, H);
  out.rendered = sw + 'x' + sh;
  out.renderScale = scale;
  if (window.__ssKeepPng) out.png = tmp.toDataURL('image/png');
  // Retain the luma plane. Two things need it: the image-space positive
  // control, which must operate on the SAME pixels arm A was scored on rather
  // than on a second render of them; and the error-to-truth secondary, which
  // needs every arm alongside the truth arm at the end of the run.
  window.__ssLastLuma = luma;
  window.__ssPlanes[label] = luma;
  return out;
}`;

/**
 * Scorer, installed once so every arm and every control goes through the same
 * code path. Returns the metric plus enough context to catch a dead frame.
 */
const SCORER_JS = `(luma, W, H) => {
  let sum = 0, n = 0, mean = 0, mx = 0;
  for (let i = 0; i < luma.length; i++) mean += luma[i];
  mean /= luma.length;
  for (let y = 1; y < H - 1; y++) {
    const r0 = (y - 1) * W, r1 = y * W, r2 = (y + 1) * W;
    for (let x = 1; x < W - 1; x++) {
      const v = Math.abs(luma[r0 + x] + luma[r2 + x] + luma[r1 + x - 1] + luma[r1 + x + 1] - 4 * luma[r1 + x]);
      sum += v; n++;
      if (v > mx) mx = v;
    }
  }
  return { mal: +(sum / n).toFixed(5), meanLuma: +mean.toFixed(3), maxLap: +mx.toFixed(2) };
}`;

/**
 * IMAGE-SPACE POSITIVE CONTROL. Takes the luma plane arm A was scored on, box
 * averages it 2x2 down and bilinear-doubles it back to 1920x1080, and rescores.
 * This destroys exactly one octave of high frequency and nothing else, so a
 * high-frequency metric that does not fall here is not a high-frequency metric.
 */
const BLUR_CONTROL_JS = `(() => {
  const W = ${WIDTH}, H = ${HEIGHT}, src = window.__ssLastLuma;
  if (!src) throw new Error('no luma plane retained');
  const hw = W >> 1, hh = H >> 1;
  const half = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const p = 2 * y * W + 2 * x;
      half[y * hw + x] = (src[p] + src[p + 1] + src[p + W] + src[p + W + 1]) / 4;
    }
  }
  const up = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(hh - 1, Math.max(0, (y + 0.5) * 0.5 - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(hh - 1, y0 + 1), wy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(hw - 1, Math.max(0, (x + 0.5) * 0.5 - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(hw - 1, x0 + 1), wx = sx - x0;
      const a = half[y0 * hw + x0], b = half[y0 * hw + x1];
      const c = half[y1 * hw + x0], d = half[y1 * hw + x1];
      up[y * W + x] = (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
    }
  }
  return window.__ssScore(up, W, H);
})()`;

/**
 * SECONDARY, AND THE ONE THAT IS ACTUALLY THE TARGET: distance to truth.
 *
 * MAL answers "how much high-frequency energy does this arm carry", and it has
 * one honest weakness — ALIASING IS ALSO HIGH FREQUENCY. A staircased edge and
 * a resolved edge both light up a Laplacian, so MAL cannot by itself tell the
 * two apart, and B->C therefore reads much smaller on MAL than the +23.6%
 * between-material spread already on record for the same pair.
 *
 * Mean absolute luma error against the boxed 4x plane has no such ambiguity:
 * the truth arm is zero by construction, aliasing counts AGAINST an arm rather
 * than for it, and the number is exactly the quantity temporal accumulation is
 * supposed to drive down. So MAL is the reported metric because it is a
 * per-arm scalar with clean controls; MAE-to-truth is the number the work is
 * graded on.
 *
 * MAE(C2, C) is the instrument's own floor: two renders of the identical frozen
 * frame at the identical scale, so anything at or below it is not a signal.
 */
const ERR_JS = `(() => {
  const P = window.__ssPlanes, T = P.C;
  if (!T) throw new Error('no truth plane');
  const out = {};
  for (const k of Object.keys(P)) {
    if (k === 'C') continue;
    const a = P[k];
    let s = 0, mx = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - T[i]);
      s += d; if (d > mx) mx = d; if (d > 1) n++;
    }
    out[k] = { mae: +(s / a.length).toFixed(4), max: +mx.toFixed(1),
               pxOver1: n, pxOver1Pct: +((100 * n) / a.length).toFixed(2) };
  }
  return out;
})()`;

/* ------------------------------------------------------------------------ */

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
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--disable-frame-rate-limit',
      '--force-device-scale-factor=1',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  const report = { framing: null, arms: {}, controls: {}, errors: [] };

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
    await page.waitForTimeout(2500);   // shader compilation

    // -- stage the fight framing, exactly as 01-hero-idle does --------------
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
    if (pinned !== PIN) report.errors.push(`pose pin landed on tick ${pinned}, wanted ${PIN}`);

    report.framing = await page.evaluate(FREEZE);

    // -- SETUP CONTROL 1: is this actually the fight framing? ---------------
    // A metric taken at the wrong crop is not wrong-ish, it is a different
    // measurement. px/m is the quantity that decides what the Laplacian sees,
    // so it carries the tight tolerance; dist and fov are reported for the
    // record. The closeup framing is 2003 px/m, so this catches the real
    // failure mode by a factor of five.
    const fr = report.framing;
    report.framingRef = FRAMING_REF;
    report.framingDelta = {
      dist_pct: +(((fr.dist - FRAMING_REF.dist) / FRAMING_REF.dist) * 100).toFixed(2),
      fov_pct: +(((fr.fov - FRAMING_REF.fov) / FRAMING_REF.fov) * 100).toFixed(2),
      pxPerM_pct: +(((fr.pxPerM - FRAMING_REF.pxPerM) / FRAMING_REF.pxPerM) * 100).toFixed(2),
    };
    if (Math.abs(report.framingDelta.pxPerM_pct) > 8) {
      report.errors.push(`framing is not fight framing: ${fr.pxPerM} px/m vs reference ${FRAMING_REF.pxPerM} (${report.framingDelta.pxPerM_pct}%)`);
    }

    // -- SETUP CONTROL 2: what is actually armed? ---------------------------
    report.passesAsShipped = await page.evaluate(PASSES_JS);
    if (POST === 'off') {
      const toggle = await page.evaluate(`(${POST_OFF_JS})(${WANT_SMAA_ARM ? 'false' : 'false'})`);
      report.postToggle = toggle;
      report.passesAfterToggle = await page.evaluate(PASSES_JS);
      // THE ASSERTION THAT THE PREVIOUS ROUND DID NOT MAKE. A flag flipping is
      // not evidence; the composer rebuilding is.
      if (!toggle.changed) {
        report.errors.push(`setEffect did not rebuild the chain: pass list unchanged [${toggle.after.join(' ')}]`);
      }
      const banned = ['AOPass', 'BloomPass', 'DOFPass', 'MotionBlurPass', 'GradePass', 'SMAAPass'];
      const still = report.passesAfterToggle.armed.filter((n) => banned.some((b) => n.includes(b.replace('Pass', ''))));
      if (still.length) report.errors.push(`post claimed off but still armed: ${still.join(' ')}`);
    }

    await page.evaluate(`window.__ssScore = ${SCORER_JS}; window.__ssMeasure = ${MEASURE_JS};
      window.__ssPlanes = {};
      window.__ssKeepPng = ${KEEP_PNG ? 'true' : 'false'};`);

    const run = (scale, label, warm = WARM) => page.evaluate(`window.__ssMeasure(${scale}, ${warm}, '${label}')`);

    // ORDER MATTERS. A first, then B, then C, then the render-path positive
    // control, then A AGAIN. The trailing A is the null control and it is the
    // last thing measured on purpose: if any arm leaves residue in the
    // pipeline — a stale render target, a shadow atlas at the wrong size, a
    // history buffer — the null is where it shows up.
    console.log('[ssgate] A shipped 0.85 ...');
    const A = await run(0.85, 'A');
    console.log('[ssgate] P1 image-space blur control ...');
    const P1 = await page.evaluate(BLUR_CONTROL_JS);   // operates on A's pixels
    console.log('[ssgate] B native 1.00 ...');
    const B = await run(1.0, 'B');
    console.log(`[ssgate] C truth ${TRUTH}x ...`);
    const C = await run(TRUTH, 'C');
    console.log(`[ssgate] C2 truth ${TRUTH}x null re-run ...`);
    const C2 = await run(TRUTH, 'C2');
    console.log('[ssgate] P2 render-path 0.50 control ...');
    const P2 = await run(0.5, 'P2');
    console.log('[ssgate] A2 null control ...');
    const A2 = await run(0.85, 'A2');

    // -- SMAA ARM -----------------------------------------------------------
    // Same session, same frozen frame, same everything, with SMAA armed back
    // on THROUGH setEffect and the pass list asserted to prove it. This is the
    // arm the retracted -0.3% claim needed and never had.
    let smaa = null;
    if (WANT_SMAA_ARM) {
      console.log('[ssgate] SMAA arm: re-arming SMAA via setEffect ...');
      const on = await page.evaluate(`(() => {
        const r = window.KB.renderer;
        const before = (r.composer ? r.composer.passes : []).map((p) => p.constructor.name);
        r.setEffect('smaa', true);
        const after = (r.composer ? r.composer.passes : []).map((p) => p.constructor.name);
        return { before, after, changed: before.join() !== after.join(),
                 hasSmaa: after.some((n) => n.indexOf('SMAA') >= 0) };
      })()`);
      if (!on.changed || !on.hasSmaa) {
        report.errors.push(`SMAA arm did not arm: [${on.after.join(' ')}]`);
      }
      const As = await run(0.85, 'A_smaa');
      const Bs = await run(1.0, 'B_smaa');
      smaa = { toggle: on, A_smaa: As, B_smaa: Bs };
    }

    const err = await page.evaluate(ERR_JS);
    report.smaa = smaa;
    report.passesAtEnd = await page.evaluate(PASSES_JS);

    const framing2 = await page.evaluate(`(() => {
      const KB = window.KB, cam = KB.camera;
      return { dist: +cam.position.distanceTo(KB.fighters[0].robot.group.position
        .clone().add(KB.fighters[1].robot.group.position).multiplyScalar(0.5)).toFixed(3),
        fov: +cam.fov.toFixed(2), phaseTicks: KB.phaseTicks };
    })()`);

    report.arms = { A, B, C };
    report.controls = { P1_blur: P1, P2_half: P2, A2_null: A2, C2_null: C2 };
    report.errToTruth = err;
    report.framingAfter = framing2;

    // Dead-frame guard: an all-black or all-flat arm scores a very low MAL and
    // would look like a beautiful result. Refuse to certify it.
    for (const [k, v] of Object.entries({ A, B, C, P2 })) {
      if (!v || v.meanLuma < 2 || v.maxLap < 1) report.errors.push(`arm ${k} looks dead (meanLuma ${v?.meanLuma}, maxLap ${v?.maxLap})`);
    }
    if (C.rendered !== `${WIDTH * TRUTH}x${HEIGHT * TRUTH}`) {
      report.errors.push(`truth arm rendered ${C.rendered}, expected ${WIDTH * TRUTH}x${HEIGHT * TRUTH} — supersample did not take`);
    }
    if (framing2.dist !== report.framing.dist || framing2.fov !== report.framing.fov) {
      report.errors.push(`camera moved during the run: ${report.framing.dist}/${report.framing.fov} -> ${framing2.dist}/${framing2.fov}`);
    }

    const gapAC = ((C.mal - A.mal) / A.mal) * 100;
    const nullDrift = ((A2.mal - A.mal) / A.mal) * 100;
    report.summary = {
      A_shipped: A.mal, B_native: B.mal, C_truth: C.mal,
      gap_A_to_C_pct: +gapAC.toFixed(2),
      gap_A_to_B_pct: +(((B.mal - A.mal) / A.mal) * 100).toFixed(2),
      gap_B_to_C_pct: +(((C.mal - B.mal) / B.mal) * 100).toFixed(2),
      null_drift_pct: +nullDrift.toFixed(3),
      null_over_gap: +(Math.abs(nullDrift) / Math.abs(gapAC)).toFixed(4),
      pos_blur_pct: +(((P1.mal - A.mal) / A.mal) * 100).toFixed(2),
      pos_half_pct: +(((P2.mal - A.mal) / A.mal) * 100).toFixed(2),
      null_truth_drift_pct: +((((C2.mal - C.mal) / C.mal) * 100)).toFixed(3),
      mae_A_to_truth: err.A?.mae, mae_B_to_truth: err.B?.mae,
      mae_floor_C2_to_truth: err.C2?.mae,
      mae_A_over_floor: +(err.A.mae / Math.max(1e-9, err.C2.mae)).toFixed(1),
      mae_B_over_floor: +(err.B.mae / Math.max(1e-9, err.C2.mae)).toFixed(1),
      nullPass: Math.abs(nullDrift) < Math.abs(gapAC) / 10,
      posPass: P1.mal < A.mal && P2.mal < A.mal,
      post: POST,
      armed: report.passesAtEnd?.armed.join(' '),
    };

    // SMAA is scored on the number the work is graded on -- MAE to truth --
    // because MAL cannot tell a resolved edge from a staircased one and SMAA
    // changes exactly that. 'recovered' is the fraction of arm A's distance to
    // truth that the pass actually buys back.
    if (smaa && err.A_smaa) {
      const base = err.A.mae, floor = err.C2.mae;
      report.summary.smaa_mae_A = err.A_smaa.mae;
      report.summary.smaa_mae_B = err.B_smaa?.mae;
      report.summary.smaa_recovered_pct_of_A =
        +((100 * (base - err.A_smaa.mae)) / Math.max(1e-9, base - floor)).toFixed(2);
      report.summary.smaa_mal_A = smaa.A_smaa.mal;
    }

    if (KEEP_PNG) {
      mkdirSync(resolve(ROOT, KEEP_PNG), { recursive: true });
      for (const [k, v] of Object.entries({ A, B, C })) {
        if (v.png) writeFileSync(resolve(ROOT, KEEP_PNG, `${k}.png`), Buffer.from(v.png.split(',')[1], 'base64'));
        delete v.png;
      }
    }
    for (const v of Object.values({ ...report.arms, ...report.controls })) delete v.png;
  } finally {
    report.consoleErrors = errors.slice(0, 10);
    await browser.close();
    await server.close();
  }

  const s = report.summary || {};
  console.log('\n=== ssgate ===');
  console.log(`framing        ${JSON.stringify(report.framing)}`);
  console.log(`framing vs ref ${JSON.stringify(report.framingDelta)}  (ref ${JSON.stringify(FRAMING_REF)})`);
  console.log(`post mode      ${POST}`);
  console.log(`armed AS SHIPPED  ${report.passesAsShipped?.armed.join(' ')}`);
  if (report.passesAfterToggle) console.log(`armed AFTER setEffect ${report.passesAfterToggle.armed.join(' ')}   changed=${report.postToggle?.changed}`);
  console.log(`armed AT END      ${report.passesAtEnd?.armed.join(' ')}`);
  console.log(`A shipped 0.85 MAL ${report.arms.A?.mal}   (${report.arms.A?.rendered})`);
  console.log(`B native  1.00 MAL ${report.arms.B?.mal}   (${report.arms.B?.rendered})`);
  console.log(`C truth   ${TRUTH}.00x MAL ${report.arms.C?.mal}   (${report.arms.C?.rendered})`);
  console.log(`A -> C gap     ${s.gap_A_to_C_pct}%   (A->B ${s.gap_A_to_B_pct}%, B->C ${s.gap_B_to_C_pct}%)`);
  console.log(`NULL   A2      MAL ${report.controls.A2_null?.mal}  drift ${s.null_drift_pct}%  (${(s.null_over_gap * 100).toFixed(2)}% of the gap)  ${s.nullPass ? 'PASS' : 'FAIL'}`);
  console.log(`POS P1 blur    MAL ${report.controls.P1_blur?.mal}  ${s.pos_blur_pct}%`);
  console.log(`POS P2 rs0.50  MAL ${report.controls.P2_half?.mal}  ${s.pos_half_pct}%   ${s.posPass ? 'PASS' : 'FAIL'}`);
  console.log(`NULL   C2      MAL ${report.controls.C2_null?.mal}  drift ${s.null_truth_drift_pct}%`);
  console.log(`MAE to truth   A ${s.mae_A_to_truth}  B ${s.mae_B_to_truth}  floor(C2) ${s.mae_floor_C2_to_truth}`
    + `   -> A is ${s.mae_A_over_floor}x the floor, B is ${s.mae_B_over_floor}x`);
  if (report.smaa) {
    console.log(`SMAA   A+smaa  MAL ${report.smaa.A_smaa?.mal}   MAE to truth ${s.smaa_mae_A}`
      + `   -> recovers ${s.smaa_recovered_pct_of_A}% of A's distance to truth`);
  }
  if (report.errors.length) console.log(`DEFECTS: ${JSON.stringify(report.errors)}`);

  if (JSON_OUT) writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
  else console.log('\n' + JSON.stringify(report.summary, null, 2));

  process.exit(report.errors.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
