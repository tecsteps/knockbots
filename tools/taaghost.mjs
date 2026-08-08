/**
 * taaghost -- does the temporal pass SMEAR A MOVING LIMB?
 *
 * tools/taagate.mjs scores image correctness on a FROZEN frame. That is the
 * right way to score anti-aliasing and it is completely blind to the one thing
 * that can make temporal accumulation unshippable in a fighting game: history
 * that does not belong to this frame surviving into it. Nothing ghosts when
 * nothing moves. So this tool moves things.
 *
 * ---------------------------------------------------------------------------
 * THE METRIC: GHOST FRACTION
 * ---------------------------------------------------------------------------
 * Render the same sim tick T three ways in one page session:
 *
 *     N(T)    no TAA, tick T          -- what this frame should look like
 *     N(T-1)  no TAA, tick T-1        -- what the PREVIOUS frame looked like
 *     G(T)    TAA on,  tick T         -- what the temporal pass delivers
 *
 * If the pass is ghosting, G(T) has been pulled toward N(T-1). Project the
 * error onto that direction and read off the coefficient:
 *
 *     ghost = SUM( (G - N) . (P - N) ) / SUM( (P - N)^2 ),  P = N(T-1)
 *
 * 0.00 means none of the previous frame survived. 1.00 means the frame IS the
 * previous frame. It is a least-squares fit, not a threshold, so it has no
 * tuning knob to accidentally choose the answer with.
 *
 * It is evaluated over MOVING pixels only -- pixels where |N(T) - N(T-1)|
 * exceeds a threshold -- because those are the only pixels where the question
 * has meaning, and they are exactly where a punch is.
 *
 * A ghost fraction is not zero for a correct implementation and should not be.
 * An eight-frame accumulation on a pixel that changed one frame ago legitimately
 * still holds some of the old value; the clamp bounds how much. What matters is
 * the ORDER: single-digit percent is a temporal filter working, and the numbers
 * below are read against controls that bracket it.
 *
 * ---------------------------------------------------------------------------
 * CONTROLS
 * ---------------------------------------------------------------------------
 *   NULL     N(T) is captured TWICE, back to back, inside the same animation
 *            frame. The two must be BIT-IDENTICAL, and the estimator run on
 *            that pair must return exactly 0. This is what replaced a broken
 *            control -- see the retraction below.
 *   SETUP    Armed pass list asserted per arm, via setEffect only, recorded at
 *            the moment of the capture.
 *   NULL     Ghost fraction of the no-TAA arm against itself: exactly 0 by
 *            construction, printed anyway so the estimator is seen to return 0
 *            when there is nothing to find.
 *   POSITIVE Two of them, bracketing the shipped configuration:
 *              - clamp OFF, feedback 0.97: the pass with its safety removed.
 *                MUST ghost harder than the shipped setting, or the clamp is
 *                not doing anything and the metric is not sensitive to it.
 *              - feedback 0: no accumulation at all. MUST be ~0.
 *
 * ---------------------------------------------------------------------------
 * RETRACTED FIRST DESIGN, KEPT BECAUSE IT IS THE REASON THIS ONE EXISTS
 * ---------------------------------------------------------------------------
 * The first version of this tool got N(T), N(T-1) and G(T) by REPLAYING the
 * same tick sequence three times from a fresh startMatch, on the argument that
 * the sim is deterministic and the CPU AI runs off a seeded Rng. It is not that
 * simple: KB.tick is not reset by startMatch and the AI reads it, so two
 * replays of "150 ticks of fight" are two different fights. Its own determinism
 * control caught it -- two no-TAA replays differed on 1,461,081 of 1,498,176
 * pixels, i.e. almost the entire frame -- and the whole run was reported VOID
 * rather than patched around. Every ghost number it produced (shipped 0.399,
 * clamp-off 0.479, no-accumulation 0.368) is meaningless: the 0.368 on an arm
 * that CANNOT ghost is the trajectory divergence itself, and it sets the floor
 * that the other two were sitting on.
 *
 * This version never replays. It runs ONE fight, and takes all three frames out
 * of it by wrapping RenderPipeline.render: the wrapper fires immediately after
 * the game's own render for a tick, in the same task, so the extra no-TAA
 * render it does sees the IDENTICAL sim state, the identical camera and the
 * identical reflection cache. The temporal pass is skipped for those extra
 * renders via its 'enabled' flag -- not by rebuilding the chain, which would
 * dispose the history -- and the jitter index is saved and restored around
 * them, so the accumulation the shipped path is building is not perturbed by
 * being measured.
 *
 *   node tools/taaghost.mjs --json scratchpad/taaghost.json --png scratchpad/taaghost-png
 *
 * NOTE ON THIS FILE: GLSL-adjacent JS inside template literals. No backticks in
 * any comment inside a literal. Keep it that way.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(arg('port', 5264));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const JSON_OUT = arg('json', '');
const KEEP_PNG = arg('png', '');
/**
 * Rendered frames of fight before the measured pair. Long enough that the CPU
 * has engaged and something is actually swinging, and long enough that the
 * accumulation is converged (0.90^150 is nothing). The run reports how much of
 * the frame moved between T-1 and T, so a frame with no motion cannot be
 * mistaken for a clean result.
 */
const TICKS = Number(arg('ticks', 150));
/** 8-bit luma units of frame-to-frame change that make a pixel 'moving'. */
const MOVE_THR = Number(arg('movethr', 12));
const SCALE = Number(arg('scale', 0.85));

const EXPECT = {
  bare: 'render,output',
  taa: 'render,taa,output',
  shipped: 'scene,gbuffer,ao,bloom,dof,motionBlur,taa,grade,output',
};

/* -------------------------------------------------------------------------
 * PAGE-SIDE
 * ---------------------------------------------------------------------- */

/**
 * ONE fight, all three frames taken out of it.
 *
 * RenderPipeline.render is wrapped for the duration of the run. The wrapper
 * fires immediately after the game has rendered a frame, in the same task, so
 * the sim state, the camera, the shadow map and the planar reflection cache are
 * all exactly what that frame was drawn with. At the two frames of interest it
 * takes an EXTRA render with the temporal pass skipped -- via pass.enabled,
 * because rebuilding the chain would dispose the history it is measuring -- and
 * grabs that as the no-TAA reference.
 *
 * Three things are saved and restored around every extra render, and each of
 * them is a way the instrument could have changed what it was measuring:
 *   - pass.enabled      so the history is neither read nor written
 *   - taaJitterScale    so the reference frame is NOT sub-pixel shifted
 *   - _jitterIndex      so the shipped accumulation keeps its Halton phase
 * The sim is untouched: RenderPipeline.render does not step it.
 */
const RUN_JS = `((n, label, opts) => new Promise((resolve) => {
  const KB = window.KB, r = KB.renderer;
  const o = opts || {};

  r.renderScale = ${SCALE};
  r._targetScale = ${SCALE};
  r.effects.adaptiveResolution = false;
  r.resize();
  if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });

  const taa = r._passes.taa || null;
  const saved = {};
  if (taa) {
    saved.feedback = taa.uniforms.uFeedback.value;
    saved.clamp = taa.uniforms.uClamp.value;
    if (typeof o.feedback === 'number') taa.uniforms.uFeedback.value = o.feedback;
    if (typeof o.clamp === 'number') taa.uniforms.uClamp.value = o.clamp;
    taa.invalidate();
    r._jitterIndex = 0;
  }

  KB.menus.show(null);
  KB.debug.freecam = false;
  KB.paused = false;
  KB.startMatch(0, 1);
  KB.setPhase('fight');
  KB.timeScale = 1;
  if (!window.__kbClock) window.__kbClock = KB.clock.getDelta.bind(KB.clock);
  KB.clock.getDelta = () => 1 / 60;

  const grab = () => {
    const c = r.canvas;
    const tmp = window.__ghTmp || (window.__ghTmp = document.createElement('canvas'));
    if (tmp.width !== c.width || tmp.height !== c.height) { tmp.width = c.width; tmp.height = c.height; }
    const g = tmp.getContext('2d', { willReadFrequently: true });
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const plane = new Float32Array(c.width * c.height);
    for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
      plane[i] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    }
    return { plane, w: c.width, h: c.height, png: window.__ghKeepPng ? tmp.toDataURL('image/png') : null };
  };

  const orig = r.render.bind(r);
  let frames = 0;
  let rendered = null;

  const bare = () => {
    const wasEnabled = taa ? taa.enabled : true;
    const wasScale = r.taaJitterScale;
    const wasIdx = r._jitterIndex;
    if (taa) taa.enabled = false;
    r.taaJitterScale = 0;
    orig(KB.scene, KB.camera, 1 / 60);
    const g = grab();
    if (taa) taa.enabled = wasEnabled;
    r.taaJitterScale = wasScale;
    r._jitterIndex = wasIdx;
    return g;
  };

  const store = (key, g) => {
    window.__ghPlanes[key] = g.plane;
    if (g.png) window.__ghPngs[key] = g.png;
    rendered = g.w + 'x' + g.h;
  };

  r.render = (scene, cam, dt) => {
    orig(scene, cam, dt);
    frames++;
    if (frames === n - 1) {
      store(label + '_prev', bare());
    } else if (frames >= n) {
      // Order matters: the TAA frame is on the canvas RIGHT NOW, before any
      // extra render overwrites it.
      store(label, grab());
      store(label + '_N', bare());
      store(label + '_N2', bare());     // NULL control, back to back
      r.render = orig;
      KB.paused = true;
      resolve({
        rendered,
        passKeys: Object.keys(r._passes).join(','),
        passArmed: r.composer.passes.map((p) => p.constructor.name).join(' '),
        frames, tick: KB.tick, phaseTicks: KB.phaseTicks,
        hp: KB.fighters.map((f) => Math.round(f.health)),
        taa: taa ? { feedback: taa.uniforms.uFeedback.value, clamp: taa.uniforms.uClamp.value,
                     hasDepth: taa.uniforms.uHasDepth.value, enabled: taa.enabled } : null,
        jitterScale: r.taaJitterScale,
      });
      if (taa) { taa.uniforms.uFeedback.value = saved.feedback; taa.uniforms.uClamp.value = saved.clamp; }
    }
  };
}))`;

/**
 * GHOST FRACTION. Least-squares projection of (arm - current) onto
 * (previous - current), over pixels that actually moved.
 */
const GHOST_JS = `((armLabel, refLabel, thr) => {
  const P = window.__ghPlanes;
  const G = P[armLabel], N = P[refLabel], Q = P[refLabel.replace(/_N2?$/, '') + '_prev'];
  if (!G || !N || !Q) throw new Error('missing plane for ' + armLabel + ' / ' + refLabel);
  if (G.length !== N.length) throw new Error('plane size mismatch');
  let num = 0, den = 0, nMove = 0, sse = 0, sMove = 0;
  for (let i = 0; i < G.length; i++) {
    const d = Q[i] - N[i];
    const ad = d < 0 ? -d : d;
    if (ad <= thr) continue;
    nMove++;
    const e = G[i] - N[i];
    num += e * d;
    den += d * d;
    sse += e * e;
    sMove += ad;
  }
  return {
    ghost: den > 0 ? +(num / den).toFixed(5) : null,
    movingPx: nMove,
    movingPct: +((100 * nMove) / G.length).toFixed(3),
    meanMotionLuma: +(sMove / Math.max(1, nMove)).toFixed(3),
    rmseOnMoving: +Math.sqrt(sse / Math.max(1, nMove)).toFixed(4),
  };
})`;

/** Bit-exactness between two captured planes. The null control. */
const IDENTICAL_JS = `((a, b) => {
  const P = window.__ghPlanes, x = P[a], y = P[b];
  if (!x || !y) throw new Error('missing plane');
  let diff = 0, max = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(x[i] - y[i]);
    if (d > 0) diff++;
    if (d > max) max = d;
  }
  return { differingPx: diff, maxDelta: +max.toFixed(4), identical: diff === 0 };
})`;

const SET_MODE_JS = `((want) => {
  const r = window.KB.renderer;
  for (const name of ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'taa']) {
    if (name in want) r.setEffect(name, !!want[name]);
  }
  return { keys: Object.keys(r._passes).join(','),
           armed: r.composer.passes.map((p) => p.constructor.name).join(' ') };
})`;

/* ---------------------------------------------------------------------- */

async function main() {
  const server = await createServer({
    root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error',
  });
  await server.listen();
  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--enable-zero-copy', '--disable-frame-rate-limit', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  const report = { metric: 'ghost fraction: least-squares share of the PREVIOUS frame surviving into this one, over moving pixels',
    ticks: TICKS, moveThreshold: MOVE_THR, renderScale: SCALE, arms: {}, ghost: {}, controls: {}, defects: [] };
  const pngs = {};

  try {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
    await page.waitForTimeout(2500);
    await page.evaluate(`
      window.__ghRun = ${RUN_JS};
      window.__ghGhost = ${GHOST_JS};
      window.__ghIdentical = ${IDENTICAL_JS};
      window.__ghSetMode = ${SET_MODE_JS};
      window.__ghPlanes = {};
      window.__ghPngs = {};
      window.__ghKeepPng = ${KEEP_PNG ? 'true' : 'false'};
    `);

    const setMode = async (mode) => {
      const want = mode === 'bare'
        ? { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: false, taa: false }
        : mode === 'shipped'
          ? { ao: true, bloom: true, dof: true, motionBlur: true, grade: true, smaa: true, taa: true }
          : { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: false, taa: true };
      const got = await page.evaluate(`window.__ghSetMode(${JSON.stringify(want)})`);
      if (got.keys !== EXPECT[mode]) report.defects.push(`setEffect('${mode}') produced [${got.keys}], expected [${EXPECT[mode]}]`);
      report.controls[`setMode_${mode}`] = got;
      return got;
    };

    const run = async (label, mode, opts = {}) => {
      await setMode(mode);
      const out = await page.evaluate(`window.__ghRun(${TICKS}, '${label}', ${JSON.stringify(opts)})`);
      out.expectMode = mode;
      out.opts = opts;
      if (out.passKeys !== EXPECT[mode]) report.defects.push(`VOID ARM ${label}: [${out.passKeys}] != [${EXPECT[mode]}]`);
      report.arms[label] = out;
      console.log(`[taaghost] ${label.padEnd(14)} frames=${out.frames} tick=${out.tick} hp=${JSON.stringify(out.hp)} ${out.rendered} [${out.passKeys}] taa=${JSON.stringify(out.taa)}`);
      return out;
    };

    // Every arm is ONE fight and is scored against its OWN reference pair, so
    // the arms do not have to be the same fight -- which is exactly the
    // assumption that voided the first version of this tool.
    // S* = the SHIPPED chain, which owns a ScenePass and therefore a depth
    // texture, so the history is reprojected with the camera matrices. This is
    // the configuration a player runs and it is the primary arm.
    await run('S', 'shipped');
    await run('S_noclamp', 'shipped', { clamp: 0, feedback: 0.97 });   // POSITIVE
    await run('S_fb0', 'shipped', { feedback: 0 });                    // jitter floor
    // Feedback sweep. Shorter memory is less ghost; the gate says it is not
    // less quality (0.90 / 0.94 / 0.97 all land on 15.83), so the question this
    // arm answers is whether going the OTHER way is free ghost reduction.
    await run('S_fb080', 'shipped', { feedback: 0.80 });
    await run('S_fb085', 'shipped', { feedback: 0.85 });
    // G* = the BARE chain. No ScenePass means no depth means NO REPROJECTION,
    // so the history is sampled at the pixel it was written to regardless of
    // where the camera went. Kept deliberately: S against G is what the depth
    // reprojection is worth, measured rather than asserted.
    await run('G', 'taa');
    await run('G_noclamp', 'taa', { clamp: 0, feedback: 0.97 });
    await run('G_fb0', 'taa', { feedback: 0 });

    report.controls.null_bitexact = await page.evaluate(`window.__ghIdentical('S_N', 'S_N2')`);
    report.controls.null_bitexact_bare = await page.evaluate(`window.__ghIdentical('G_N', 'G_N2')`);

    for (const l of ['S', 'S_noclamp', 'S_fb0', 'S_fb080', 'S_fb085', 'G', 'G_noclamp', 'G_fb0']) {
      report.ghost[l] = await page.evaluate(`window.__ghGhost('${l}', '${l}_N', ${MOVE_THR})`);
    }
    // NULL: the estimator on the reference against itself. Must be exactly 0.
    report.ghost.NULL = await page.evaluate(`window.__ghGhost('S_N2', 'S_N', ${MOVE_THR})`);

    if (KEEP_PNG) Object.assign(pngs, await page.evaluate('window.__ghPngs'));

    // NULL CONTROL, and the bar is stated relative to the signal rather than as
    // bit-exactness, because the SHIPPED chain provably cannot hold a
    // bit-exact whole-frame null: the planar floor reflector is a temporal
    // cache refreshed every 2nd armed frame, which ssgate already documented
    // and reported rather than worked around. So: the BARE chain must be
    // bit-exact (it has no such cache), and the shipped chain's residue must be
    // under 1% of the quantity being measured, with the estimator still
    // returning exactly 0 on it.
    const nb = report.controls.null_bitexact;
    const nbb = report.controls.null_bitexact_bare;
    const nullResidue = report.ghost.NULL.rmseOnMoving;
    const nullBar = report.ghost.S.rmseOnMoving * 0.01;
    if (!nbb.identical) {
      report.defects.push(`NULL CONTROL FAILED ON THE BARE CHAIN: two back-to-back no-TAA renders of the SAME frame differ on ${nbb.differingPx} px (max ${nbb.maxDelta}). ` +
        `The bare chain has no temporal cache in it, so this must be exact.`);
    }
    if (!(nullResidue < nullBar)) {
      report.defects.push(`NULL CONTROL FAILED ON THE SHIPPED CHAIN: residue between two back-to-back renders is ${nullResidue} rms on moving pixels, ` +
        `against a bar of ${nullBar.toFixed(4)} (1% of the ${report.ghost.S.rmseOnMoving} the arm itself moves). ` +
        `${nb.differingPx} px differ, max ${nb.maxDelta}.`);
    }
    const g = report.ghost;
    if (g.S.movingPx < 5000) {
      report.defects.push(`NOTHING MOVED between frame ${TICKS - 1} and ${TICKS}: only ${g.S.movingPx} px over ${MOVE_THR}/255. A ghost metric on a still frame is not a control, it is a tautology.`);
    }
    if (g.NULL.ghost !== 0) report.defects.push(`NULL CONTROL: the estimator returned ${g.NULL.ghost} on the reference against itself, expected exactly 0`);
    if (!(g.S_noclamp.ghost > g.S.ghost)) {
      report.defects.push(`POSITIVE CONTROL FAILED: removing the clamp gives ghost ${g.S_noclamp.ghost} against the shipped ${g.S.ghost}. ` +
        `If the safety can be removed without the metric moving, the metric is not measuring the safety.`);
    }
    // THE JITTER FLOOR, and it is not zero. With feedback 0 there is no
    // accumulation at all, so nothing of the previous frame can survive -- but
    // the frame is still drawn through a sub-pixel-shifted projection, and a
    // half-pixel shift toward where a limb came FROM correlates with the
    // previous frame by construction. Measured at 0.05, and every ghost number
    // here should be read against that floor rather than against zero. The bar
    // is 0.12: high enough to admit the floor, low enough that real
    // accumulation (0.36 unreprojected) could not hide under it.
    if (!(Math.abs(g.S_fb0.ghost) < 0.12)) {
      report.defects.push(`JITTER FLOOR CONTROL FAILED: with accumulation off the ghost fraction is ${g.S_fb0.ghost}, which is too large to be the sub-pixel shift alone`);
    }

    report.verdict = {
      moving_px: g.S.movingPx, moving_pct_of_frame: g.S.movingPct, mean_motion_luma: g.S.meanMotionLuma,
      SHIPPED_CHAIN_reprojected: {
        ghost: g.S.ghost,
        ghost_clamp_removed_fb097: g.S_noclamp.ghost,
        jitter_floor_no_accumulation: g.S_fb0.ghost,
        clamp_removes_pct_of_ghost: +((100 * (g.S_noclamp.ghost - g.S.ghost)) / Math.max(1e-6, g.S_noclamp.ghost)).toFixed(1),
        ghost_above_floor: +(g.S.ghost - g.S_fb0.ghost).toFixed(4),
        rmse_on_moving: g.S.rmseOnMoving,
      },
      BARE_CHAIN_no_reprojection: {
        ghost: g.G.ghost,
        ghost_clamp_removed_fb097: g.G_noclamp.ghost,
        jitter_floor_no_accumulation: g.G_fb0.ghost,
        rmse_on_moving: g.G.rmseOnMoving,
      },
      feedback_sweep_ghost: { fb080: g.S_fb080.ghost, fb085: g.S_fb085.ghost, fb090_shipped: g.S.ghost },
      reprojection_removes_pct_of_ghost: +((100 * (g.G.ghost - g.S.ghost)) / Math.max(1e-6, g.G.ghost)).toFixed(1),
      ghost_null: g.NULL.ghost,
      null_bit_exact_bare: nbb.identical,
      null_residue_shipped_rms: nullResidue,
      null_bar: +nullBar.toFixed(4),
      pass: report.defects.length === 0,
    };
  } finally {
    report.errors = errs.slice(0, 8);
    await browser.close();
    await server.close();
  }

  console.log('\n==================== taaghost ====================');
  console.log(`METRIC  ghost fraction = least-squares share of frame T-1 surviving into frame T, over moving pixels.`);
  console.log(`        0 = none of the previous frame. 1 = the frame IS the previous frame.`);
  console.log(`MOTION  ${report.verdict?.moving_px} px moved between rendered frame ${TICKS - 1} and ${TICKS} ` +
    `(${report.verdict?.moving_pct_of_frame}% of frame, mean change ${report.verdict?.mean_motion_luma} luma)`);
  console.log('');
  for (const [k, v] of Object.entries(report.ghost)) {
    console.log(`  ${k.padEnd(12)} ghost ${String(v.ghost).padStart(9)}   rmse-on-moving ${String(v.rmseOnMoving).padStart(8)}   n=${v.movingPx}`);
  }
  console.log('\n-- CONTROLS -------------------------------------------------------------------');
  console.log(`  NULL bare    two back-to-back no-TAA renders: ${report.controls.null_bitexact_bare?.identical ? 'BIT-IDENTICAL' : 'DIFFER'} ` +
    `(${report.controls.null_bitexact_bare?.differingPx} px, max ${report.controls.null_bitexact_bare?.maxDelta})`);
  console.log(`  NULL shipped same, full chain: ${report.controls.null_bitexact?.differingPx} px differ, max ${report.controls.null_bitexact?.maxDelta}, ` +
    `residue ${report.ghost?.NULL?.rmseOnMoving} rms vs the ${report.ghost?.S?.rmseOnMoving} the arm moves (planar reflector cache; documented in ssgate)`);
  console.log(`  NULL      estimator on the reference vs itself: ${report.ghost?.NULL?.ghost}`);
  console.log(`  FLOOR     accumulation off, jitter still on -> ${report.ghost?.S_fb0?.ghost}   <-- read every number against THIS, not against 0`);
  console.log(`  POSITIVE  clamp off, fb 0.97 -> ${report.ghost?.S_noclamp?.ghost}  vs shipped ${report.ghost?.S?.ghost}`);
  console.log(`            the 3x3 neighbourhood clamp removes ${report.verdict?.SHIPPED_CHAIN_reprojected?.clamp_removes_pct_of_ghost}% of the ghost it would otherwise have`);
  console.log(`  CONTRAST  no depth = no reprojection (bare chain) -> ${report.ghost?.G?.ghost}; reprojection removes ${report.verdict?.reprojection_removes_pct_of_ghost}% of that`);
  console.log('\n-- VERDICT --------------------------------------------------------------------');
  console.log(JSON.stringify(report.verdict, null, 2));
  if (report.defects.length) {
    console.log('\nDEFECTS:');
    for (const d of report.defects) console.log(`  ! ${d}`);
  }
  if (report.errors?.length) console.log(`page errors: ${JSON.stringify(report.errors)}`);

  if (KEEP_PNG) {
    mkdirSync(resolve(ROOT, KEEP_PNG), { recursive: true });
    for (const [k, v] of Object.entries(pngs)) {
      writeFileSync(resolve(ROOT, KEEP_PNG, `${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
    }
    console.log(`PNGs -> ${KEEP_PNG}`);
  }
  if (JSON_OUT) {
    mkdirSync(dirname(resolve(ROOT, JSON_OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
    console.log(`report -> ${JSON_OUT}`);
  }
  process.exit(report.defects.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
