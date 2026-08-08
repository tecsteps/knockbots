/*
 * tapgate -- IMAGE QUALITY of a DOF / motion-blur TAP-COUNT change, on MOVING
 * frames.
 *
 * The gate: RMSE in 8-bit luma against the CONVERGED gather (DOF 128 taps, MB 64
 * taps -- same shader, same radii, same weights). Lower is better. Reported over
 * the whole frame, over ssgate's subject mask, and over the AT-RISK mask: the
 * pixels where the DOF gather or the motion-blur loop actually ran, which is the
 * only place a tap count can change anything at all.
 *
 * WHY NOT ssgate's 4x TRUTH -- and this is a real disagreement with the brief,
 * argued rather than assumed. ssgate and movegate score against a 4x-integrated
 * frame, which is the correct ground truth for a GEOMETRIC sampling question:
 * resolution, AA, temporal accumulation. A tap count is a different question.
 * Every length in BokehDofPass and MotionBlurPass is a fraction of frame height
 * (see BokehDofPass#setSize), so the 4x arm renders the identical fractional
 * blur with the identical tap count -- it is approximated exactly as badly as
 * the shipped arm and cannot referee between two tap counts. Worse, running
 * ssgate twice would move its own truth arm between the runs. The
 * zero-by-construction reference for a tap count is the converged gather, and
 * that is what this uses. ssgate's machinery that IS right for this -- the
 * subject mask, one session, null and positive controls -- is kept.
 *
 * WHY THE FRAMES MOVE. MotionBlurPass velocity is camera reprojection, so on a
 * frozen frame it early-outs on every pixel and a frozen measurement of a
 * motion-blur change certifies nothing. Each moment is taken off a live CPU-vs-
 * CPU fight and then pinned: sim stopped, camera pose and
 * MotionBlurPass._prevViewProjection restored before every arm, shutter pinned.
 * Every arm therefore integrates the identical non-zero velocity field, and the
 * camera's NDC speed at that moment is reported so "moving" is a measurement.
 *
 * ARMS, per moment, all at the shipped 1632x918 and compared 1:1 with no
 * resampling anywhere (a difference must not be able to hide inside a filter):
 *   conv      DOF 128 / MB 64, fixed        the reference, 0 by construction
 *   fixed     DOF 14 / MB 8, fixed          what ships today -- THE YARDSTICK
 *   adaptive  DOF <=14 / MB <=8, adaptive   the candidate
 *   floor     DOF 4 / MB 2, fixed           POSITIVE CONTROL, must be worse
 *   conv2     conv again, last              NULL CONTROL, must be ~0
 *
 * The verdict is a comparison of distances, not an absolute: the candidate is
 * clean if RMSE(adaptive, conv) is not materially worse than RMSE(fixed, conv),
 * because the shipped frame's own distance from converged is the error budget
 * this project has already accepted.
 *
 *   node tools/tapgate.mjs [--moments 6] [--png scratchpad/tg]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'tapgate-page.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5245));
const MOMENTS = Number(arg('moments', 6));
const GAP = Number(arg('gap', 2600));
const WARM = Number(arg('warm', 20000));
const CONV_DOF = Number(arg('convDof', 128));
const CONV_MB = Number(arg('convMb', 64));
const OUT = arg('out', resolve(REPO, 'scratchpad/tapgate.json'));
const PNG = arg('png', '');

const log = (...a) => console.log('[tapgate]', ...a);

const server = await createServer({
  root: REPO, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });
await page.waitForTimeout(4000);
await page.evaluate(readFileSync(PAGE, 'utf8'));

const info = await page.evaluate('window.__tg.setup({ level: 7 })');
log('setup', JSON.stringify({ gpu: info.gpu, buffer: info.buffer, tier: info.tier }));

// The candidate this scored was measured and reverted, so the switch is not in
// the tree. Say so instead of scoring an 'adaptive' arm that is silently
// identical to 'fixed'. See the note above BokehDofPass#render for the patch.
if (info.defines.dofAdaptive === undefined || info.defines.mbAdaptive === undefined) {
  console.error('[tapgate] DOF_ADAPTIVE / MB_ADAPTIVE are not in src/engine/RenderPipeline.js, so the\n'
    + '          adaptive arm cannot differ from the fixed one. Re-apply the switch to re-run.\n'
    + '          The fixed / floor / converged arms and every control would still work; this\n'
    + '          tool refuses anyway, because its headline number is the adaptive one.');
  await browser.close(); await server.close();
  process.exit(2);
}
log('armed at boot:', info.armed.join(' '));
if (PNG) await page.evaluate('window.__tg.keepPng(true)');

log(`warming ${WARM / 1000}s of live fight ...`);
await page.waitForTimeout(WARM);

const WARMARM = Number(arg('warmArm', 3));

const ARMS = [
  // conv0 is the ADJACENT null: the same configuration as conv, rendered
  // immediately before it with nothing in between. conv2 is the SEQUENCE null,
  // rendered after every other arm. Two nulls, because "two identical renders
  // differ" and "the frame drifts over a sequence of rebuilds" are different
  // defects with different fixes, and the first version of this tool could not
  // tell them apart.
  { label: 'conv0', cfg: { dof: CONV_DOF, mb: CONV_MB, adaptive: false }, note: 'ADJACENT NULL' },
  { label: 'conv', cfg: { dof: CONV_DOF, mb: CONV_MB, adaptive: false }, note: 'CONVERGED reference' },
  { label: 'fixed', cfg: { adaptive: false }, note: 'shipped 14/8' },
  { label: 'adaptive', cfg: { adaptive: true }, note: 'THE CANDIDATE' },
  { label: 'floor', cfg: { dof: 4, mb: 2, adaptive: false }, note: 'POSITIVE CONTROL, must be worse than fixed' },
  { label: 'conv2', cfg: { dof: CONV_DOF, mb: CONV_MB, adaptive: false }, note: 'NULL CONTROL, must be ~0 vs conv' },
];

const report = { info, moments: [], defects: [], loadavg: os.loadavg()[0] };
const pngs = {};

const MINSPEED = Number(arg('minSpeed', 0.0015));

for (let m = 0; m < MOMENTS; m++) {
  await page.waitForTimeout(GAP);
  // Wait for the camera to actually be moving. The fight camera is still for
  // long stretches, and a still camera means MotionBlurPass early-outs on every
  // pixel -- capturing there would score a motion-blur change on frames where
  // motion blur does not run. Polled live, then pinned.
  let seek = 0, sp = 0;
  for (; seek < 400; seek++) {
    sp = await page.evaluate('window.__tg.speed()');
    if (sp >= MINSPEED) break;
    await page.waitForTimeout(50);
  }
  const pin = await page.evaluate('window.__tg.pin()');
  pin.seekPolls = seek;
  const moment = { i: m, pin, arms: {}, compare: {}, taps: {}, defects: [] };
  log(`--- moment ${m}: tick ${pin.tick} camNdcSpeed ${pin.camNdcSpeed} (sought ${seek} polls, live ${sp}) mbIntensity ${pin.mbIntensity} focus ${pin.dofFocus} sep ${pin.sep}`);

  // ONE evaluate for the whole moment. Splitting it leaves an rAF frame between
  // two arms, the game loop's visual update runs in that gap even with the sim
  // paused, and the adjacent-null control measured the result at rmse 4.7-7.7 --
  // the size of the entire signal.
  const cap = await page.evaluate(`window.__tg.moment(${JSON.stringify(ARMS)}, ${WARMARM})`);
  moment.mask = cap.mask;
  moment.taps = cap.taps;
  moment.compare = cap.compare;
  log(`    mask: subject ${moment.mask.px} px (${moment.mask.pct}%) | at-risk ${moment.taps.fixed.unionPx} px (${(moment.taps.fixed.unionFrac * 100).toFixed(1)}%)`);
  log(`    taps  fixed: DOF ${moment.taps.fixed.dof.meanTapsWhenActive}/${moment.taps.fixed.dof.maxTaps} on ${(moment.taps.fixed.dof.activeFrac * 100).toFixed(1)}% px`
    + ` | MB ${moment.taps.fixed.mb.meanTapsWhenActive}/${moment.taps.fixed.mb.maxTaps} on ${(moment.taps.fixed.mb.activeFrac * 100).toFixed(1)}% px`);
  log(`    taps  adapt: DOF ${moment.taps.adaptive.dof.meanTapsWhenActive}/${moment.taps.adaptive.dof.maxTaps}`
    + ` | MB ${moment.taps.adaptive.mb.meanTapsWhenActive}/${moment.taps.adaptive.mb.maxTaps}`
    + ` | work removed: DOF ${(100 * (1 - moment.taps.adaptive.dof.meanTapsOverFrame / Math.max(1e-6, moment.taps.fixed.dof.meanTapsOverFrame))).toFixed(1)}%`
    + ` MB ${(100 * (1 - moment.taps.adaptive.mb.meanTapsOverFrame / Math.max(1e-6, moment.taps.fixed.mb.meanTapsOverFrame))).toFixed(1)}%`);

  for (const a of ARMS) {
    const r = cap.arms[a.label];
    moment.arms[a.label] = { meanLuma: r.meanLuma, armed: r.armed.join(' '), defines: r.defines, grain: r.grain, note: a.note };
    if (PNG && r.png) pngs[`m${m}-${a.label}`] = r.png;

    // SETUP CONTROL. The #define is the experiment; assert it, do not trust it.
    const wantDof = a.cfg.dof === undefined ? info.tier.dofTaps : a.cfg.dof;
    const wantMb = a.cfg.mb === undefined ? info.tier.mbTaps : a.cfg.mb;
    const wantAd = a.cfg.adaptive ? 1 : 0;
    if (r.defines.dofTaps !== wantDof) moment.defects.push(`${a.label}: DOF_TAPS ${r.defines.dofTaps} want ${wantDof}`);
    if (r.defines.mbTaps !== wantMb) moment.defects.push(`${a.label}: MB_TAPS ${r.defines.mbTaps} want ${wantMb}`);
    if (r.defines.dofAdaptive !== wantAd) moment.defects.push(`${a.label}: DOF_ADAPTIVE ${r.defines.dofAdaptive} want ${wantAd}`);
    if (r.defines.mbAdaptive !== wantAd) moment.defects.push(`${a.label}: MB_ADAPTIVE ${r.defines.mbAdaptive} want ${wantAd}`);
    // Armed-list assertion. Compared against the FIRST arm of this moment, not
    // against the boot list: the game loop is stopped while a moment is pinned,
    // so EffectsDirector never re-installs its OverlayPass after the rebuild and
    // the chain legitimately ends at 'output'. What has to hold is that every
    // arm sees the same chain and that both tap-loop passes are in it.
    const ref = moment.arms[ARMS[0].label].armed;
    if (r.armed.join(' ') !== ref) moment.defects.push(`${a.label}: armed ${r.armed.join(' ')} != ${ref}`);
    if (!r.armed.includes('dof') || !r.armed.includes('motionBlur')) moment.defects.push(`${a.label}: tap-loop pass missing from ${r.armed.join(' ')}`);
    if (r.grain !== 0) moment.defects.push(`${a.label}: grain ${r.grain} -- the frame is not deterministic`);
    // The shutter must be identical across arms or the blurs are different lengths.
    if (Math.abs(r.defines.mbIntensity - pin.mbIntensity) > 1e-4) moment.defects.push(`${a.label}: mbIntensity ${r.defines.mbIntensity} want ${pin.mbIntensity}`);
  }

  const c = moment.compare;
  log(`    RMSE vs conv   whole / subject / at-risk`);
  for (const l of ['conv0', 'fixed', 'adaptive', 'floor', 'conv2']) {
    log(`      ${l.padEnd(9)} ${String(c[l].all.rmse).padStart(8)} ${String(c[l].subject ? c[l].subject.rmse : '-').padStart(9)} ${String(c[l].blur ? c[l].blur.rmse : '-').padStart(9)}`);
  }
  log(`      adaptive-vs-fixed  all ${c['adaptive-vs-fixed'].all.rmse}  at-risk ${c['adaptive-vs-fixed'].blur ? c['adaptive-vs-fixed'].blur.rmse : '-'}`);

  // NULL TOLERANCE, measured rather than assumed. With every arm captured in one
  // task and the mirror pinned, both nulls sit at 0.44-0.45 rmse at every moment
  // and against every arm -- flat, so it is a floor and not a drift. It is not
  // zero: the readback goes through a canvas 2D drawImage of a WebGL surface and
  // rounds to 8 bits, and sub-LSB rounding is not required to land the same way
  // twice. 1.0 is that floor with headroom, and it is stated here so a reader can
  // see the signal (2.1-3.4 for the shipped arm) is clear of it by 5x.
  const NULLTOL = 1.0;
  if (c.conv0.all.rmse > NULLTOL) moment.defects.push(`ADJACENT NULL FAILED: two back-to-back identical renders differ by rmse ${c.conv0.all.rmse} (tolerance ${NULLTOL})`);
  if (c.conv2.all.rmse > NULLTOL) moment.defects.push(`SEQUENCE NULL FAILED: conv re-rendered after the other arms differs by rmse ${c.conv2.all.rmse} (tolerance ${NULLTOL})`);
  if (c.fixed.all.rmse <= c.conv0.all.rmse) moment.defects.push(`NO SIGNAL: the shipped arm's own distance from converged (${c.fixed.all.rmse}) is inside the null (${c.conv0.all.rmse})`);
  if (c.floor.all.rmse <= c.fixed.all.rmse) moment.defects.push(`POSITIVE CONTROL FAILED: floor ${c.floor.all.rmse} not worse than fixed ${c.fixed.all.rmse}`);
  if (pin.camNdcSpeed < 1e-4) moment.defects.push(`MOTION CONTROL: camera NDC speed ${pin.camNdcSpeed} -- this moment is not moving`);
  if (moment.taps.fixed.mb.activeFrac < 0.01) moment.defects.push(`MOTION CONTROL: the motion-blur loop ran on ${(100 * moment.taps.fixed.mb.activeFrac).toFixed(2)}% of pixels -- nothing to score`);
  for (const d of moment.defects) log('    DEFECT:', d);

  report.moments.push(moment);
  await page.evaluate('window.__tg.unpin()');
}

/* ------------------------------------------------------------------ roll-up */

const ok = report.moments.filter((m) => m.defects.length === 0);
const avg = (rows, f) => (rows.length ? +(rows.reduce((s, r) => s + f(r), 0) / rows.length).toFixed(4) : null);
report.summary = {
  moments: report.moments.length, clean: ok.length,
  camNdcSpeed: { min: Math.min(...report.moments.map((m) => m.pin.camNdcSpeed)), max: Math.max(...report.moments.map((m) => m.pin.camNdcSpeed)) },
};
for (const scope of ['all', 'subject', 'blur', 'dofOnly', 'mbOnly']) {
  report.summary[scope] = {};
  for (const l of ['conv0', 'fixed', 'adaptive', 'floor', 'conv2', 'adaptive-vs-fixed']) {
    const rows = report.moments.filter((m) => m.compare[l] && m.compare[l][scope]);
    report.summary[scope][l] = {
      rmse: avg(rows, (m) => m.compare[l][scope].rmse),
      mae: avg(rows, (m) => m.compare[l][scope].mae),
      maxErr: avg(rows, (m) => m.compare[l][scope].maxErr),
      offBy2Pct: avg(rows, (m) => m.compare[l][scope].offBy2Pct),
    };
  }
}
report.summary.workRemoved = {
  dofPct: avg(report.moments, (m) => 100 * (1 - m.taps.adaptive.dof.meanTapsOverFrame / Math.max(1e-6, m.taps.fixed.dof.meanTapsOverFrame))),
  mbPct: avg(report.moments, (m) => 100 * (1 - m.taps.adaptive.mb.meanTapsOverFrame / Math.max(1e-6, m.taps.fixed.mb.meanTapsOverFrame))),
  dofActivePct: avg(report.moments, (m) => 100 * m.taps.fixed.dof.activeFrac),
  mbActivePct: avg(report.moments, (m) => 100 * m.taps.fixed.mb.activeFrac),
};
report.defects = report.moments.flatMap((m) => m.defects.map((d) => `m${m.i}: ${d}`));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));
if (PNG) {
  mkdirSync(dirname(resolve(REPO, PNG)) , { recursive: true });
  for (const [k, v] of Object.entries(pngs)) {
    writeFileSync(resolve(REPO, `${PNG}-${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
  }
}

console.log('\n================ TAPGATE: RMSE vs the CONVERGED gather (lower is better) ================');
console.log(`moments ${report.summary.moments} (${report.summary.clean} clean), camera NDC speed ${report.summary.camNdcSpeed.min}..${report.summary.camNdcSpeed.max}, loadavg ${report.loadavg.toFixed(2)}`);
console.log(`work removed by the candidate: DOF ${report.summary.workRemoved.dofPct}% of tap fetches, MB ${report.summary.workRemoved.mbPct}%`);
console.log(`(DOF gather runs on ${report.summary.workRemoved.dofActivePct}% of pixels, MB loop on ${report.summary.workRemoved.mbActivePct}%)`);
console.log('\narm                whole-frame   subject    at-risk    dof-only    mb-only');
for (const l of ['conv0', 'fixed', 'adaptive', 'floor', 'conv2', 'adaptive-vs-fixed']) {
  const g = (s) => (report.summary[s][l].rmse === null ? '   -   ' : report.summary[s][l].rmse.toFixed(4).padStart(9));
  console.log(`${l.padEnd(18)} ${g('all')} ${g('subject')} ${g('blur')} ${g('dofOnly')} ${g('mbOnly')}`);
}
console.log(`\nDEFECTS: ${report.defects.length ? '' : 'none'}`);
for (const d of report.defects) console.log('  ' + d);
log('wrote', OUT);

await browser.close();
await server.close();
