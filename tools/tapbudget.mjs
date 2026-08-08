/*
 * tapbudget -- is there any p95 in the DOF / motion-blur TAP LOOPS?
 *
 * The candidate: dofTaps 14 and mbTaps 8 at 'high' are constants, so a pixel
 * whose circle of confusion resolves to 2 px pays the same 14 gathers as one at
 * 10 px, and a 2 px motion streak pays the same 8 as an 18 px one. Making the
 * count follow the blur should make cheap pixels cheap.
 *
 * Method is tools/passbudget.mjs's, unchanged where it does not need to change:
 * one browser session, 1920x1080, 'high', adaptive resolution OFF, live CPU-vs-
 * CPU fight, rounds prevented from ending, ABBA quads of ~1.3 s blocks with the
 * condition order seed-shuffled per round, armed pass list asserted before and
 * after every block, quad-paired estimator with a bootstrap CI over quads.
 * EXT_disjoint_timer_query_webgl2 is not used; it reads 2.2x wall clock here.
 *
 * WHAT IS DIFFERENT, and why
 *
 *  1. THE #DEFINES ARE ASSERTED STATE. This experiment changes a compiled
 *     constant, not a pass's presence, so DOF_TAPS / MB_TAPS / DOF_ADAPTIVE /
 *     MB_ADAPTIVE are read off the live ShaderMaterial before and after every
 *     block and any disagreement with the condition VOIDS it. The recorded
 *     failure this guards against is the one already in this project's notes:
 *     a flag set, nothing rebuilt, a whole round of work voided.
 *
 *  2. NESTED BOUNDS instead of one A/B. The arms bracket the candidate:
 *
 *       adaptive     the change under test (count follows blur)
 *       taps-floor   dofTaps 14->4 and mbTaps 8->2 unconditionally. This is
 *                    UNSHIPPABLE, and that is the point -- it is strictly more
 *                    aggressive than any adaptive scheme can be, so it is an
 *                    upper bound on the whole candidate.
 *       no-dofmb     both passes gone. Upper bound on the upper bound.
 *
 *     A candidate that cannot be distinguished from the baseline is only
 *     interesting if its CEILING can be. Measuring the ceiling costs one extra
 *     arm and converts "I found nothing" into "there is nothing there".
 *
 *  3. THE OPTIMISATION IS PROVEN TO FIRE, by reading back a debug render of the
 *     live materials that writes each pixel's chosen tap count (--taps). Without
 *     it, a null result is ambiguous between "the scheme saves nothing" and "the
 *     scheme saves a lot and it is still not worth measuring".
 *
 *   node tools/tapbudget.mjs [--rounds 6] [--block 1300] [--settle 1200]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'tapbudget-page.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const PORT = Number(arg('port', 5243));
const BLOCK = Number(arg('block', 2200));
const SETTLE = Number(arg('settle', 1200));
const ROUNDS = Number(arg('rounds', 6));
const WARM = Number(arg('warm', 45000));
const SEED = Number(arg('seed', 20260808));
const BOOT = Number(arg('boot', 4000));
const OUT = arg('out', resolve(REPO, 'scratchpad/tapbudget.json'));
const ONLY = arg('only', '');

const log = (...a) => console.log('[tapbudget]', ...a);

/* ------------------------------------------------------------- statistics */

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
function stat(a) {
  if (!a || a.length < 8) return null;
  const s = [...a].sort((x, y) => x - y);
  return {
    n: s.length,
    p50: +pct(s, 0.5).toFixed(3), p25: +pct(s, 0.25).toFixed(3), p75: +pct(s, 0.75).toFixed(3),
    p90: +pct(s, 0.90).toFixed(3), p95: +pct(s, 0.95).toFixed(3), p99: +pct(s, 0.99).toFixed(3),
    mean: +(s.reduce((t, v) => t + v, 0) / s.length).toFixed(3),
    over: +(100 * s.filter((v) => v > 16.67).length / s.length).toFixed(1),
  };
}
const pairSeries = (a) => a.slice(0, -1).map((v, i) => (v + a[i + 1]) / 2);
function slide(a, k) {
  const out = [];
  if (a.length < k) return out;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= k) s -= a[i - k];
    if (i >= k - 1) out.push(s / k);
  }
  return out;
}
const series = (a) => ({ raw: stat(a), pair: stat(pairSeries(a)), slide12: stat(slide(a, 12)) });
const med = (a) => (a.length ? pct([...a].sort((x, y) => x - y), 0.5) : NaN);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

function mulberry(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Quad-paired bootstrap. The QUAD is the unit of resampling, because that is the
 * unit inside which the machine's load is roughly constant -- resampling frames
 * would treat 1300 correlated intervals as 1300 independent facts and shrink
 * every interval to nothing.
 */
function bootstrapQuads(quadDeltas, iters = 4000, seed = 12345) {
  if (quadDeltas.length < 2) return null;
  const rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < quadDeltas.length; i++) s += quadDeltas[Math.floor(rnd() * quadDeltas.length)];
    out.push(s / quadDeltas.length);
  }
  out.sort((a, b) => a - b);
  return { est: +mean(quadDeltas).toFixed(3), lo: +pct(out, 0.025).toFixed(3), hi: +pct(out, 0.975).toFixed(3), n: quadDeltas.length };
}

/* ------------------------------------------------------------ conditions */

const AMP = Number(arg('amp', 16));

const E = (o = {}) => Object.assign({ ao: 1, bloom: 1, dof: 1, motionBlur: 1, grade: 1, smaa: 1 }, o);
const BASE = { key: 'full', effects: E(), scale: 0.85, adaptiveTaps: false, amp: 0, off: [] };
// The amplified baseline: the shipped tap counts, with each tap-loop pass drawn
// AMP extra times into a scratch target. Its arms differ from it only in the
// shader, so a delta divided by (AMP + 1) is a per-frame per-pass cost.
const BASE_AMP = { key: 'full-amp', effects: E(), scale: 0.85, adaptiveTaps: false, amp: AMP, off: [] };
const C = (key, over, note) => Object.assign({ key, effects: E(), scale: 0.85, adaptiveTaps: false, amp: 0, base: BASE, off: [], note }, over);

const CONDITIONS = [
  /* ---- direct arms: the verdict, on the metric the constraint is stated in */
  C('adaptive', { adaptiveTaps: true },
    'THE CANDIDATE: DOF taps = 14*(r/rMax)^2 clamped to [4,14]; MB taps = ceil(streakPx/2.25) clamped to [2,8]. Both hold the tap SPACING the widest blur already gets.'),
  C('taps-floor', { tapsDof: 4, tapsMb: 2 },
    'UPPER BOUND ON THE CANDIDATE: dofTaps 4, mbTaps 2 unconditionally. Not shippable. Strictly cheaper than any adaptive scheme, so if this is inside the noise the candidate is closed.'),
  C('no-dofmb', { effects: E({ dof: 0, motionBlur: 0 }) },
    'UPPER BOUND ON THE UPPER BOUND: both tap-loop passes removed entirely.'),
  C('null-full', {},
    'NULL CONTROL: identical config to the baseline arm. Its |dp95| is the tolerance.'),
  C('pos-scale070', { scale: 0.70 },
    'POSITIVE CONTROL: 1344x756, must be faster by ~3.6 ms p95.'),

  /* ---- amplified arms: attribution with a resolvable signal on a busy box */
  C('amp-adaptive', { amp: AMP, adaptiveTaps: true, base: BASE_AMP },
    `AMPLIFIED CANDIDATE: both passes drawn ${AMP + 1}x. delta / ${AMP + 1} = the per-frame saving the candidate makes.`),
  C('amp-floor', { amp: AMP, tapsDof: 4, tapsMb: 2, base: BASE_AMP },
    `AMPLIFIED UPPER BOUND: dofTaps 4 / mbTaps 2, ${AMP + 1}x. delta / ${AMP + 1} = the most any tap-count scheme can save.`),
  C('amp-off', { amp: 0, base: BASE_AMP },
    `POSITIVE CONTROL ON THE AMPLIFIER: the ${AMP} extra copies removed. -delta / ${AMP} must recover the per-frame cost of dof+motionBlur that tools/passbudget.mjs measured by ablation (0.59 and -0.07 ms p95), by a different method.`),
  C('null-amp', { amp: AMP, base: BASE_AMP },
    'NULL CONTROL on the amplified baseline: identical config to its own A arm.'),
].filter((c) => !ONLY || ONLY.split(',').includes(c.key));

/* ------------------------------------------------------------------ boot */

const server = await createServer({
  root: REPO,
  server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  args: [
    '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-zero-copy', '--disable-frame-rate-limit', '--force-device-scale-factor=1',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });
await page.waitForTimeout(BOOT);
await page.evaluate(readFileSync(PAGE, 'utf8'));

const info = await page.evaluate('window.__tb.setup({ level: 7 })');
log('setup', JSON.stringify({ quality: info.quality, gpu: info.gpu, dpr: info.dpr }));

// THE CANDIDATE WAS MEASURED AND REVERTED, so the src-side switch these arms
// drive is not in the tree. Fail here with the reason rather than silently
// voiding 96 blocks on a #define assertion that can never pass. Re-apply
// DOF_ADAPTIVE / MB_ADAPTIVE / RenderPipeline#adaptiveTaps (the patch is
// described in the long note above BokehDofPass#render) to run these again;
// every other arm -- taps-floor, no-dofmb, amp-off, amp-floor and the controls --
// needs nothing, because it only moves tier.dofTaps / tier.mbTaps.
if (info.defines.dofAdaptive === undefined || info.defines.mbAdaptive === undefined) {
  const adaptiveArms = CONDITIONS.filter((c) => c.adaptiveTaps).map((c) => c.key);
  if (adaptiveArms.length) {
    console.error(`[tapbudget] the DOF_ADAPTIVE / MB_ADAPTIVE switch is not in src/engine/RenderPipeline.js.\n`
      + `            Arms that need it: ${adaptiveArms.join(', ')}.\n`
      + `            Re-apply the switch, or run the rest with --only `
      + CONDITIONS.filter((c) => !c.adaptiveTaps).map((c) => c.key).join(','));
    await browser.close(); await server.close();
    process.exit(2);
  }
}
log('armed at boot :', info.armed.join(' '));
log('defines at boot:', JSON.stringify(info.defines));

/* SETUP CONTROLS */
const hazard = await page.evaluate('window.__tb.hazard()');
log('HAZARD armed after rp.effects.bloom=false :', hazard.afterDirectAssign.join(' '));
log('HAZARD assertion flags direct assignment  :', hazard.assertionWouldFlagArmed);
log('HAZARD flag set / no frame -> DOF_ADAPTIVE:', hazard.flagSetNoFrame.dofAdaptive,
  '| after one frame:', hazard.afterOneFrame.dofAdaptive, '| follows flag:', hazard.defineFollowsFlag);
log('HAZARD right after rebuild -> DOF_ADAPTIVE:', hazard.rightAfterRebuild.dofAdaptive,
  '| after one frame:', hazard.rebuildThenFrame.dofAdaptive, '| re-assert works:', hazard.reassertWorks);

await page.evaluate(`window.__tb.apply(${JSON.stringify(BASE)})`);
log(`warming ${WARM / 1000}s ...`);
await page.waitForTimeout(WARM);

/* Does the optimisation fire? Read back the chosen tap count per pixel. */
let taps = null;
if (!has('no-taps')) {
  taps = await page.evaluate('window.__tb.tapReport(["fixed","adaptive"])');
  if (taps.error) log('TAP REPORT unavailable:', taps.error);
  else {
    for (const arm of ['fixed', 'adaptive']) {
      const d = taps[arm].dof, m = taps[arm].mb;
      log(`TAP REPORT ${arm.padEnd(8)} DOF active ${(d.activeFrac * 100).toFixed(1)}% meanTaps/px ${d.meanTapsOverFrame.toFixed(2)}/${d.maxTaps} (saved ${(d.savedFrac * 100).toFixed(1)}%)`
        + ` | MB active ${(m.activeFrac * 100).toFixed(1)}% meanTaps/px ${m.meanTapsOverFrame.toFixed(2)}/${m.maxTaps} (saved ${(m.savedFrac * 100).toFixed(1)}%)`);
    }
    log('TAP REPORT defines restored:', JSON.stringify(taps.restoredDefines));
  }
  await page.waitForTimeout(3000);
}

/* ------------------------------------------------------------- the blocks */

const blocks = [];
const t0 = Date.now();

async function runBlock(cfg, label, meta) {
  const applied = await page.evaluate(`window.__tb.apply(${JSON.stringify(cfg)})`);
  await page.waitForTimeout(SETTLE);

  const expected = await page.evaluate(`window.__tb.expect(${JSON.stringify(cfg)})`);
  const pre = await page.evaluate('window.__tb.snapshot()');
  const load0 = os.loadavg()[0];
  const r = await page.evaluate(`window.__tb.sample(${BLOCK})`);
  const post = await page.evaluate('window.__tb.snapshot()');
  const load1 = os.loadavg()[0];

  const voids = [];
  const ex = expected.join(' ');
  if (pre.armed.join(' ') !== ex) voids.push('armed-pre != expected [' + pre.armed.join(' ') + ']');
  if (post.armed.join(' ') !== ex) voids.push('armed-post != expected [' + post.armed.join(' ') + ']');

  // The #define assertion. This is the whole point of this probe.
  const wantAd = cfg.adaptiveTaps ? 1 : 0;
  const wantDof = cfg.tapsDof === undefined ? info.tier.dofTaps : cfg.tapsDof;
  const wantMb = cfg.tapsMb === undefined ? info.tier.mbTaps : cfg.tapsMb;
  const dofArmed = pre.armed.some((n) => n === 'dof');
  const mbArmed = pre.armed.some((n) => n === 'motionBlur');
  for (const [when, s] of [['pre', pre], ['post', post]]) {
    if (dofArmed) {
      if (s.defines.dofAdaptive !== wantAd) voids.push(`DOF_ADAPTIVE ${when} ${s.defines.dofAdaptive} want ${wantAd}`);
      if (s.defines.dofTaps !== wantDof) voids.push(`DOF_TAPS ${when} ${s.defines.dofTaps} want ${wantDof}`);
    }
    if (mbArmed) {
      if (s.defines.mbAdaptive !== wantAd) voids.push(`MB_ADAPTIVE ${when} ${s.defines.mbAdaptive} want ${wantAd}`);
      if (s.defines.mbTaps !== wantMb) voids.push(`MB_TAPS ${when} ${s.defines.mbTaps} want ${wantMb}`);
    }
    if (!!s.defines.flag !== !!cfg.adaptiveTaps) voids.push(`rp.adaptiveTaps ${when} ${s.defines.flag}`);
  }

  // SETUP CONTROL on the amplifier: the extra copies must be exactly what the
  // condition asked for, and both passes must actually carry the wrapper.
  const wantAmp = cfg.amp || 0;
  for (const [when, s] of [['pre', pre], ['post', post]]) {
    if (s.amp.amp !== wantAmp) voids.push(`amp ${when} ${s.amp.amp} want ${wantAmp}`);
    if (wantAmp > 0) {
      if (dofArmed && s.amp.wrapped.indexOf('dof') < 0) voids.push(`amp ${when}: dof not wrapped`);
      if (mbArmed && s.amp.wrapped.indexOf('motionBlur') < 0) voids.push(`amp ${when}: motionBlur not wrapped`);
      if (s.amp.scratch !== s.amp.buffer) voids.push(`amp ${when}: scratch ${s.amp.scratch} != buffer ${s.amp.buffer}`);
    }
  }

  if (Math.abs(pre.scale - cfg.scale) > 1e-3) voids.push('scale ' + pre.scale);
  if (pre.pixels !== post.pixels) voids.push('resolution changed mid-block');
  if (pre.adaptive || post.adaptive) voids.push('adaptive resolution ON');
  if (!pre.shadowMapOn || !post.shadowMapOn) voids.push('shadowMap off');
  if (!pre.split || pre.passSplit === false) voids.push('splitLighting ' + pre.split + '/' + pre.passSplit);
  if (pre.programs !== post.programs) voids.push('programs ' + pre.programs + '->' + post.programs + ' (compile inside block)');
  if (pre.quality !== 'high' || post.quality !== 'high') voids.push('tier != high');
  if (pre.phase !== 'fight' || post.phase !== 'fight') voids.push('phase ' + pre.phase + '/' + post.phase);
  if (r.forcedPhase > 0) voids.push('phase forced ' + r.forcedPhase + 'x mid-block');
  if (r.ivals.length < 25) voids.push('only ' + r.ivals.length + ' frames');

  const row = {
    label, ...meta, cfgKey: cfg.key, scale: cfg.scale, amp: pre.amp.amp,
    t: Math.round((Date.now() - t0) / 1000),
    expected, armedPre: pre.armed, armedPost: post.armed,
    definesPre: pre.defines, definesPost: post.defines,
    applied: applied.changed, rebuilds: applied.rebuilds,
    pixels: pre.pixels, wall: +r.wall.toFixed(0), frames: r.ivals.length,
    throughput: +(r.wall / Math.max(1, r.ivals.length + 1)).toFixed(3),
    load: [+load0.toFixed(2), +load1.toFixed(2)],
    drawCalls: pre.drawCalls, triangles: pre.triangles, programs: pre.programs,
    sep: pre.sep, camDist: pre.camDist, hp: pre.hp, tick: pre.tick,
    voids, ok: voids.length === 0,
    ivals: r.ivals.map((v) => +v.toFixed(3)),
    cpu: stat(r.cpu),
  };
  row.stats = series(r.ivals);
  blocks.push(row);

  const s = row.stats.pair;
  log(`${label.padEnd(26)} ${row.ok ? ' ' : 'X'} ${String(row.pixels).padEnd(10)}`
    + `n=${String(row.frames).padStart(3)} p50 ${s ? s.p50.toFixed(2) : '  -  '} `
    + `p95 ${s ? s.p95.toFixed(2) : '-'} >16.67 ${s ? String(Math.round(s.over)).padStart(3) : ' -'}% `
    + `| thru ${row.throughput.toFixed(2)} | load ${row.load[1].toFixed(2)} `
    + `| d${row.definesPre.dofTaps}/a${row.definesPre.dofAdaptive} m${row.definesPre.mbTaps}/a${row.definesPre.mbAdaptive}`
    + `${row.ok ? '' : ' | VOID: ' + voids.join('; ')}`);
  return row;
}

for (let round = 0; round < ROUNDS; round++) {
  const order = shuffled(CONDITIONS, mulberry(SEED + round * 7919));
  log(`--- round ${round} order: ${order.map((c) => c.key).join(', ')}`);
  for (const cond of order) {
    // Each condition carries its own A arm. The amplified conditions are paired
    // against the AMPLIFIED baseline, so their delta isolates the shader and not
    // the amplifier.
    const base = cond.base || BASE;
    const meta = { round, cond: cond.key, arm: 'A', base: base.key };
    await runBlock(base, `r${round}.${cond.key}.A1`, { ...meta, slot: 0 });
    await runBlock(cond, `r${round}.${cond.key}.B1`, { ...meta, arm: 'B', slot: 1 });
    await runBlock(cond, `r${round}.${cond.key}.B2`, { ...meta, arm: 'B', slot: 2 });
    await runBlock(base, `r${round}.${cond.key}.A2`, { ...meta, slot: 3 });
  }
}

await page.evaluate(`window.__tb.apply(${JSON.stringify(BASE)})`);

/* ---------------------------------------------------------------- analyse */

const good = blocks.filter((b) => b.ok);
const pool = (rows) => rows.flatMap((r) => r.ivals);
// Only the unamplified baseline arms describe the shipped frame.
const allA = good.filter((b) => b.arm === 'A' && b.base === 'full');
const report = { conditions: [] };

for (const cond of CONDITIONS) {
  const qa = good.filter((b) => b.cond === cond.key && b.arm === 'A');
  const qb = good.filter((b) => b.cond === cond.key && b.arm === 'B');
  if (qa.length < 2 || qb.length < 2) { report.conditions.push({ key: cond.key, note: cond.note, voided: true, blocksA: qa.length, blocksB: qb.length }); continue; }
  const A = series(pool(qa)), B = series(pool(qb));

  // Quad-paired: within a quad, mean over its B blocks minus mean over its A
  // blocks, per statistic. Quads with a voided block are dropped whole.
  const quads = [];
  for (let r = 0; r < ROUNDS; r++) {
    const a = good.filter((b) => b.cond === cond.key && b.arm === 'A' && b.round === r);
    const b = good.filter((x) => x.cond === cond.key && x.arm === 'B' && x.round === r);
    if (a.length !== 2 || b.length !== 2) continue;
    const g = (rows, k, st) => mean(rows.map((x) => x.stats[st] && x.stats[st][k]).filter((v) => v !== null && v !== undefined));
    quads.push({
      round: r,
      dP50: +(g(b, 'p50', 'pair') - g(a, 'p50', 'pair')).toFixed(3),
      dP95: +(g(b, 'p95', 'pair') - g(a, 'p95', 'pair')).toFixed(3),
      dSl95: +(g(b, 'p95', 'slide12') - g(a, 'p95', 'slide12')).toFixed(3),
      dOver: +(g(b, 'over', 'pair') - g(a, 'over', 'pair')).toFixed(3),
      dThru: +(mean(b.map((x) => x.throughput)) - mean(a.map((x) => x.throughput))).toFixed(3),
    });
  }
  report.conditions.push({
    key: cond.key, note: cond.note,
    blocksA: qa.length, blocksB: qb.length, framesA: A.raw.n, framesB: B.raw.n,
    loadA: +mean(qa.map((x) => x.load[1])).toFixed(2), loadB: +mean(qb.map((x) => x.load[1])).toFixed(2),
    A, B,
    pooled: {
      pairP50: +(B.pair.p50 - A.pair.p50).toFixed(3),
      pairP95: +(B.pair.p95 - A.pair.p95).toFixed(3),
      pairOver: +(B.pair.over - A.pair.over).toFixed(3),
      slideP95: +(B.slide12.p95 - A.slide12.p95).toFixed(3),
      rawP95: +(B.raw.p95 - A.raw.p95).toFixed(3),
      rawOver: +(B.raw.over - A.raw.over).toFixed(3),
    },
    quadPaired: {
      dP50: bootstrapQuads(quads.map((q) => q.dP50), 4000, SEED + 1),
      dP95: bootstrapQuads(quads.map((q) => q.dP95), 4000, SEED + 2),
      dSl95: bootstrapQuads(quads.map((q) => q.dSl95), 4000, SEED + 3),
      dOver: bootstrapQuads(quads.map((q) => q.dOver), 4000, SEED + 4),
      dThru: bootstrapQuads(quads.map((q) => q.dThru), 4000, SEED + 5),
      quadsFasterP95: quads.filter((q) => q.dP95 < 0).length,
    },
    quads,
  });

  // The amplified arms convert to a per-frame number by dividing out the copy
  // count. amp-off removed AMP copies of a pass that also runs once for real, so
  // its divisor is AMP; the shader-swap arms changed all AMP+1 copies.
  const row = report.conditions[report.conditions.length - 1];
  if (cond.key.startsWith('amp-') || cond.key === 'null-amp') {
    const div = cond.key === 'amp-off' ? -AMP : (AMP + 1);
    const perFrame = (b) => (b ? { est: +(b.est / div).toFixed(4), lo: +(Math.min(b.lo, b.hi) / div).toFixed(4), hi: +(Math.max(b.lo, b.hi) / div).toFixed(4) } : null);
    row.perFrameMs = {
      divisor: div,
      note: cond.key === 'amp-off'
        ? 'positive control: this is the per-frame cost of dof+motionBlur, recovered by amplification'
        : 'per-frame saving this shader change makes (negative = saves time)',
      dP50: perFrame(row.quadPaired.dP50), dP95: perFrame(row.quadPaired.dP95),
      dMean: perFrame(bootstrapQuads(quads.map((q) => q.dThru), 4000, SEED + 6)),
    };
  }
}

const a1a2 = [];
for (const b of good.filter((x) => x.arm === 'A' && x.slot === 0 && x.base === 'full')) {
  const a2 = good.find((x) => x.cond === b.cond && x.round === b.round && x.slot === 3);
  if (!a2 || !b.stats.pair || !a2.stats.pair) continue;
  a1a2.push({ cond: b.cond, round: b.round, dP50: +(a2.stats.pair.p50 - b.stats.pair.p50).toFixed(3), dP95: +(a2.stats.pair.p95 - b.stats.pair.p95).toFixed(3) });
}
report.noiseFloor = {
  n: a1a2.length,
  absDeltaP50: { med: +med(a1a2.map((x) => Math.abs(x.dP50))).toFixed(3), p90: +pct(a1a2.map((x) => Math.abs(x.dP50)).sort((p, q) => p - q), 0.9).toFixed(3) },
  absDeltaP95: { med: +med(a1a2.map((x) => Math.abs(x.dP95))).toFixed(3), p90: +pct(a1a2.map((x) => Math.abs(x.dP95)).sort((p, q) => p - q), 0.9).toFixed(3) },
  meanSlotBias: +mean(a1a2.map((x) => x.dP95)).toFixed(3),
};
report.baseline = allA.length ? series(pool(allA)) : null;
report.blocksTotal = blocks.length;
report.blocksVoid = blocks.length - good.length;
report.voidReasons = blocks.filter((b) => !b.ok).map((b) => ({ label: b.label, voids: b.voids }));
report.loadavg = blocks.length ? {
  min: Math.min(...blocks.map((b) => b.load[1])), max: Math.max(...blocks.map((b) => b.load[1])),
  mean: +mean(blocks.map((b) => b.load[1])).toFixed(2),
} : null;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ info, hazard, taps, params: { BLOCK, SETTLE, ROUNDS, WARM, SEED }, report, blocks: blocks.map((b) => ({ ...b, ivals: undefined })) }, null, 2));
writeFileSync(OUT.replace(/\.json$/, '-frames.json'), JSON.stringify(blocks.map((b) => ({ label: b.label, cond: b.cond, arm: b.arm, round: b.round, slot: b.slot, ok: b.ok, load: b.load, ivals: b.ivals }))));

/* ----------------------------------------------------------------- print */

if (report.baseline) {
  console.log('\n================ BASELINE (all full-chain A blocks pooled) ================');
  for (const k of ['raw', 'pair', 'slide12']) {
    const s = report.baseline[k];
    if (s) console.log(`${k.padEnd(9)} n=${String(s.n).padStart(5)}  p50 ${s.p50.toFixed(2)}  IQR ${s.p25.toFixed(2)}-${s.p75.toFixed(2)}  p95 ${s.p95.toFixed(2)}  >16.67 ${s.over.toFixed(1)}%`);
  }
}
console.log(`loadavg over run: mean ${report.loadavg?.mean} min ${report.loadavg?.min} max ${report.loadavg?.max}`);
console.log(`blocks ${report.blocksTotal}, void ${report.blocksVoid}`);
for (const v of report.voidReasons) console.log('  VOID', v.label, JSON.stringify(v.voids));
console.log(`NOISE FLOOR from ${report.noiseFloor.n} A1-vs-A2 pairs on unchanged config: `
  + `|dp50| med ${report.noiseFloor.absDeltaP50.med} p90 ${report.noiseFloor.absDeltaP50.p90} | `
  + `|dp95| med ${report.noiseFloor.absDeltaP95.med} p90 ${report.noiseFloor.absDeltaP95.p90} | slot bias ${report.noiseFloor.meanSlotBias}`);

console.log('\n============ QUAD-PAIRED DELTAS (B - A), ms, bootstrap 95% CI ============');
console.log('condition       q  loadA loadB   dP50 [ci]                 dP95pair [ci]             dP95sl12         d%>16.7   faster');
for (const c of report.conditions.filter((x) => !x.voided)) {
  const q = c.quadPaired;
  const f = (b) => (b ? `${b.est.toFixed(2).padStart(6)} [${b.lo.toFixed(2)},${b.hi.toFixed(2)}]`.padEnd(24) : '  -  ');
  console.log(`${c.key.padEnd(14)} ${String(q.dP95 ? q.dP95.n : 0).padStart(2)} ${String(c.loadA).padStart(6)} ${String(c.loadB).padStart(5)}  `
    + `${f(q.dP50)}  ${f(q.dP95)}  ${q.dSl95 ? q.dSl95.est.toFixed(2).padStart(7) : '  -  '}  `
    + `${q.dOver ? q.dOver.est.toFixed(1).padStart(7) : '  -  '}  ${q.quadsFasterP95}/${q.dP95 ? q.dP95.n : 0}`);
}
const ampRows = report.conditions.filter((c) => c.perFrameMs);
if (ampRows.length) {
  console.log(`\n=========== AMPLIFIED ARMS, divided back to ONE frame (${AMP} extra copies) ===========`);
  console.log('condition       per-frame dMean [ci]        per-frame dP50 [ci]          what it means');
  for (const c of ampRows) {
    const f = (b) => (b ? `${b.est.toFixed(3).padStart(7)} [${b.lo.toFixed(3)},${b.hi.toFixed(3)}]`.padEnd(26) : '  -  ');
    console.log(`${c.key.padEnd(14)}  ${f(c.perFrameMs.dMean)} ${f(c.perFrameMs.dP50)} ${c.perFrameMs.note}`);
  }
}

console.log('\npooled-frame cross-check (B - A):');
for (const c of report.conditions.filter((x) => !x.voided)) {
  console.log(`  ${c.key.padEnd(14)} pairP50 ${c.pooled.pairP50.toFixed(2).padStart(6)}  pairP95 ${c.pooled.pairP95.toFixed(2).padStart(6)}  rawP95 ${c.pooled.rawP95.toFixed(2).padStart(6)}  d%>16.67 ${c.pooled.pairOver.toFixed(1).padStart(6)}`);
}
log('wrote', OUT);

await browser.close();
await server.close();
