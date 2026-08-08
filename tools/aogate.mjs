/*
 * aogate -- is the GTAO normal source worth what it costs, on a LIVE fight?
 *
 * WHAT THIS IS FOR
 *
 * tools/passbudget.mjs ranked GTAO first in the p95 budget at 'high': 2.24 ms
 * [0.94, 3.45], replicated across two sessions. This tool asks where inside the
 * pass that goes, and A/Bs the one answer that does not cost image quality.
 *
 * The arithmetic that produced the hypothesis, from three r185's shaders:
 *   - the pipeline hands GTAOPass a depth texture and NO normal texture, so
 *     NORMAL_VECTOR_TYPE is 0 on BOTH materials and getViewNormal() expands to
 *     computeNormalFromDepth(): 9 texelFetch of the full-res depth buffer plus
 *     3 unprojections.
 *   - GTAOShader calls it once per pixel. That is fine.
 *   - PoissonDenoiseShader calls it once for the centre AND ONCE PER TAP, and
 *     the pipeline runs 12 taps. That is 13 reconstructions per pixel, ~117
 *     depth fetches and 39 unprojections, to compute a value that only varies
 *     over a few pixels.
 *   - the AO trace itself is 3 directions x 4 steps x 2 taps = 24.
 * So the denoise, not the occlusion, should be the larger half of the pass.
 *
 * THE CHANGE UNDER TEST (src/engine/RenderPipeline.js, HalfResGtaoPass):
 * render the reconstruction ONCE into a half-res packed RGBA8 buffer and hand
 * it to setGBuffer, so both shaders take the NORMAL_VECTOR_TYPE 1 path -- one
 * textureLod. Same reconstruction, same inputs, same code; different number of
 * times it runs. Cost added: one half-res fullscreen draw.
 *
 * METHOD -- inherited wholesale from tools/passbudget.mjs, and for its reasons:
 *  - EXT_disjoint_timer_query_webgl2 reports ~2.2x wall clock under ANGLE/Metal
 *    here. Not used. Attribution is by ablation delta on wall-clock interval.
 *  - The noise is CONTENTION, not heat. Every condition is ABBA quads of ~1.3 s
 *    blocks against the shipped-today arm, one session, order shuffled per
 *    round. Absolute numbers are not comparable across sessions.
 *  - Rounds never end (Game.training set directly + health pump), so no KO
 *    cinematic or round reset can land in a block.
 *  - frameMs in rp.stats is a 48-frame rolling MEAN and cannot give a
 *    percentile. Not used for anything.
 *
 * CONTROLS
 *   SETUP     The armed pass list is IDENTICAL in both arms of the headline
 *             comparison, so it is necessary and not sufficient. Every block
 *             also asserts NORMAL_VECTOR_TYPE on both materials, the identity
 *             of the normal texture, the AO/normal buffer sizes and the Poisson
 *             tap count -- before AND after -- and COUNTS the normal prepass:
 *             a 'shared' block must render it once per frame and a 'depth'
 *             block zero times. Plus a hazard demo (see aogate-page.js) that
 *             produces the misconfiguration this experiment could silently sit
 *             in, and shows the assertion rejecting it.
 *   NULL      'null' is config-identical to the baseline arm. Its delta is the
 *             tolerance every other delta has to beat. Separately every quad
 *             donates an A1-vs-A2 pair, which is the block-level noise floor.
 *   POSITIVE  'pos-scale070' must be FASTER by roughly the 3.6 ms already on
 *             record for that step, and 'no-ao' must be faster by roughly the
 *             2.24 ms already on record for the whole pass. The change cannot
 *             beat 'no-ao'; if it appears to, the rig is wrong, not the change.
 *
 *   node tools/aogate.mjs [--rounds 8] [--block 1300] [--settle 1500]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'aogate-page.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5243));
const BLOCK = Number(arg('block', 1300));
const SETTLE = Number(arg('settle', 1500));
const ROUNDS = Number(arg('rounds', 8));
const MINFRAMES = Number(arg('minframes', 30));
const WARM = Number(arg('warm', 40000));
const SEED = Number(arg('seed', 20260808));
const BOOT = Number(arg('boot', 4000));
const OUT = arg('out', resolve(REPO, 'scratchpad/aogate.json'));
const ONLY = arg('only', '');

const log = (...a) => console.log('[aogate]', ...a);

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
    p50: +pct(s, 0.5).toFixed(3),
    p25: +pct(s, 0.25).toFixed(3),
    p75: +pct(s, 0.75).toFixed(3),
    p90: +pct(s, 0.90).toFixed(3),
    p95: +pct(s, 0.95).toFixed(3),
    p99: +pct(s, 0.99).toFixed(3),
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
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const med = (a) => (a.length ? pct([...a].sort((x, y) => x - y), 0.5) : NaN);

/** Bootstrap CI of the mean of per-quad paired deltas. */
function boot(vals, iters = 4000, seed = 12345) {
  if (vals.length < 2) return { est: vals.length ? vals[0] : null, lo: null, hi: null, n: vals.length };
  const rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rnd() * vals.length)];
    out.push(s / vals.length);
  }
  out.sort((x, y) => x - y);
  return {
    est: +mean(vals).toFixed(3),
    lo: +pct(out, 0.025).toFixed(3),
    hi: +pct(out, 0.975).toFixed(3),
    n: vals.length,
    negFrac: +(vals.filter((v) => v < 0).length / vals.length).toFixed(2),
  };
}

/* ------------------------------------------------------- seeded shuffle */
function mulberry(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ------------------------------------------------------------ conditions */

const E = (o = {}) => Object.assign({ ao: 1, bloom: 1, dof: 1, motionBlur: 1, grade: 1, smaa: 1 }, o);
/**
 * THE BASELINE ARM IS THE PIPELINE AS SHIPPED BEFORE THIS CHANGE: AO on, no
 * normal texture, both shaders reconstructing. The working tree defaults to the
 * change, so the baseline is the one that has to be forced -- stated here
 * because getting it the wrong way round would invert every number below.
 */
const BASE = { key: 'base-depth-normals', effects: E(), scale: 0.85, normals: 'depth', pdSamples: 12 };
const C = (key, over, note) => Object.assign({ key, effects: E(), scale: 0.85, normals: 'depth', pdSamples: 12, off: [] }, over, { note });

const CONDITIONS = [
  C('shared-normals', { normals: 'shared' },
    'THE CHANGE: one half-res packed normal buffer, NORMAL_VECTOR_TYPE 1 on both materials'),
  C('shared-pd8', { normals: 'shared', pdSamples: 8 },
    'SECONDARY: shared normals AND 8 denoise taps instead of 12. Costs quality; measured to bound what is left'),
  C('depth-pd6', { normals: 'depth', pdSamples: 6 },
    'ATTRIBUTION: shipped normals, half the denoise taps. Isolates how much of AO is the denoise loop'),
  C('no-ao', { effects: E({ ao: 0 }) },
    'POSITIVE / CEILING: the whole pass removed. No AO variant can beat this'),
  C('null', {},
    'NULL CONTROL: identical config to the baseline arm'),
  C('pos-scale070', { scale: 0.70 },
    'POSITIVE CONTROL: 1344x756, must be faster by roughly the 3.6 ms on record'),
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
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-frame-rate-limit',
    '--force-device-scale-factor=1',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });
await page.waitForTimeout(BOOT);
await page.evaluate(readFileSync(PAGE, 'utf8'));

const info = await page.evaluate('window.__ao.setup({ level: 7 })');
log('setup', JSON.stringify({ quality: info.quality, gpu: info.gpu, dpr: info.dpr }));
log('armed at boot :', info.armed.join(' '));
log('AO at boot    :', JSON.stringify(info.ao));

/* SETUP CONTROL: the config hazard specific to THIS experiment */
const hazard = await page.evaluate('window.__ao.hazard()');
log('HAZARD shared        :', JSON.stringify(hazard.shared));
log('HAZARD depth         :', JSON.stringify(hazard.depth));
log('HAZARD direct-assign :', JSON.stringify(hazard.afterDirectAssign));
log('HAZARD assertion flags direct assignment:', hazard.assertionWouldFlag,
  '| that state pays for the buffer and never reads it:', hazard.trapPaysAndDoesNotRead,
  '| restored:', hazard.restoredMatchesShared);

/* Compile every variant BEFORE the warm period, so no shader compile can land
 * in a measured block. A define change on either material is a recompile. */
for (const c of [BASE, ...CONDITIONS]) {
  await page.evaluate(`window.__ao.apply(${JSON.stringify(c)})`);
  await page.waitForTimeout(1200);
}
await page.evaluate(`window.__ao.apply(${JSON.stringify(BASE)})`);
log(`priming done; warming ${WARM / 1000}s ...`);
await page.waitForTimeout(WARM);

/* ------------------------------------------------------------- the blocks */

const blocks = [];
const t0 = Date.now();

async function runBlock(cfg, label, meta) {
  await page.evaluate(`window.__ao.apply(${JSON.stringify(cfg)})`);
  await page.waitForTimeout(SETTLE);

  const expected = await page.evaluate(`window.__ao.expect(${JSON.stringify(cfg)})`);
  const expectAo = await page.evaluate(`window.__ao.expectAo(${JSON.stringify(cfg)})`);
  const pre = await page.evaluate('window.__ao.snapshot()');
  const load0 = os.loadavg()[0];
  const r = await page.evaluate(`window.__ao.sample(${BLOCK})`);
  const post = await page.evaluate('window.__ao.snapshot()');
  const load1 = os.loadavg()[0];

  const voids = [];
  const ex = expected.join(' ');
  if (pre.armed.join(' ') !== ex) voids.push('armed-pre != expected [' + pre.armed.join(' ') + ']');
  if (post.armed.join(' ') !== ex) voids.push('armed-post != expected [' + post.armed.join(' ') + ']');
  if (Math.abs(pre.scale - cfg.scale) > 1e-3) voids.push('scale ' + pre.scale);
  if (pre.pixels !== post.pixels) voids.push('resolution changed mid-block');
  if (pre.adaptive || post.adaptive) voids.push('adaptive resolution ON');
  if (!pre.shadowMapOn || !post.shadowMapOn) voids.push('shadowMap off');
  if (!pre.split || !post.split || pre.passSplit !== true) voids.push('split lighting disagreed');
  if (pre.programs !== post.programs) voids.push('programs ' + pre.programs + '->' + post.programs + ' (compile inside block)');
  if (pre.quality !== 'high' || post.quality !== 'high') voids.push('tier != high');
  if (pre.phase !== 'fight' || post.phase !== 'fight') voids.push('phase ' + pre.phase + '/' + post.phase);
  if (r.forcedPhase > 0) voids.push('phase forced ' + r.forcedPhase + 'x mid-block');
  // Sibling agents on this box push the frame to 40-50 ms, so a block that is
  // long enough at 60 fps is not long enough at 22. MINFRAMES is the floor on
  // what a percentile is allowed to be computed from; --block should be set so
  // the measured frame rate clears it comfortably.
  if (r.ivals.length < MINFRAMES) voids.push('only ' + r.ivals.length + ' frames');

  /* --- the assertion the armed pass list cannot make ---------------------- */
  for (const [tag, s] of [['pre', pre.ao], ['post', post.ao]]) {
    if (!expectAo) {
      if (s.present) voids.push(tag + ': AO pass present but the condition removed it');
      continue;
    }
    if (!s.present) { voids.push(tag + ': no AO pass'); continue; }
    if (s.gtaoNVT !== expectAo.gtaoNVT) voids.push(tag + ': gtao NORMAL_VECTOR_TYPE ' + s.gtaoNVT + ' != ' + expectAo.gtaoNVT);
    if (s.pdNVT !== expectAo.pdNVT) voids.push(tag + ': pd NORMAL_VECTOR_TYPE ' + s.pdNVT + ' != ' + expectAo.pdNVT);
    if (s.wired !== expectAo.wired) voids.push(tag + ': normal texture wired ' + s.wired + ' != ' + expectAo.wired);
    if (s.pdSamples !== expectAo.pdSamples) voids.push(tag + ': pdSamples ' + s.pdSamples + ' != ' + expectAo.pdSamples);
    if (!s.instrumented) voids.push(tag + ': normal prepass not instrumented');
    if (s.aoSize !== s.normalSize) voids.push(tag + ': AO buffer ' + s.aoSize + ' != normal buffer ' + s.normalSize);
  }
  // MEASURED, not inferred: did the normal prepass actually run this block?
  const wantNormalRenders = !!(expectAo && expectAo.wired);
  if (wantNormalRenders && r.normalRenders < r.renderCalls - 2) {
    voids.push('normal prepass ran ' + r.normalRenders + 'x in ' + r.renderCalls + ' frames');
  }
  if (!wantNormalRenders && r.normalRenders !== 0) {
    voids.push('normal prepass ran ' + r.normalRenders + 'x with the shipped normal path armed');
  }

  const row = {
    label, ...meta, cfgKey: cfg.key, scale: cfg.scale, normals: cfg.normals, pdSamples: cfg.pdSamples,
    t: Math.round((Date.now() - t0) / 1000),
    expected, armedPre: pre.armed, aoPre: pre.ao, aoPost: post.ao,
    pixels: pre.pixels, wall: +r.wall.toFixed(0), frames: r.ivals.length,
    renderCalls: r.renderCalls, normalRenders: r.normalRenders,
    throughput: +(r.wall / Math.max(1, r.ivals.length + 1)).toFixed(3),
    load: [+load0.toFixed(2), +load1.toFixed(2)],
    drawCalls: pre.drawCalls, sceneDrawCalls: pre.sceneDrawCalls,
    triangles: pre.triangles, programs: pre.programs,
    sep: pre.sep, camDist: pre.camDist, hp: pre.hp, tick: pre.tick,
    voids, ok: voids.length === 0,
    ivals: r.ivals.map((v) => +v.toFixed(3)),
    cpu: stat(r.cpu),
  };
  row.stats = series(r.ivals);
  blocks.push(row);

  const s = row.stats.pair;
  log(`${label.padEnd(30)} ${row.ok ? ' ' : 'X'} ${String(row.pixels).padEnd(10)}`
    + `n=${String(row.frames).padStart(3)} p50 ${s ? s.p50.toFixed(2) : '  -  '} `
    + `IQR[${s ? s.p25.toFixed(2) : '-'},${s ? s.p75.toFixed(2) : '-'}] p95 ${s ? s.p95.toFixed(2) : '-'} `
    + `>16.67 ${s ? String(Math.round(s.over)).padStart(3) : ' -'}% | nrm ${String(row.normalRenders).padStart(3)}/${row.renderCalls} `
    + `| load ${row.load[1].toFixed(2)}`
    + `${row.ok ? '' : ' | VOID: ' + voids.join('; ')}`);
  return row;
}

for (let round = 0; round < ROUNDS; round++) {
  const order = shuffled(CONDITIONS, mulberry(SEED + round * 7919));
  log(`--- round ${round} order: ${order.map((c) => c.key).join(', ')}`);
  for (const cond of order) {
    await runBlock(BASE, `r${round}.${cond.key}.A1`, { round, cond: cond.key, arm: 'A', slot: 0 });
    await runBlock(cond, `r${round}.${cond.key}.B1`, { round, cond: cond.key, arm: 'B', slot: 1 });
    await runBlock(cond, `r${round}.${cond.key}.B2`, { round, cond: cond.key, arm: 'B', slot: 2 });
    await runBlock(BASE, `r${round}.${cond.key}.A2`, { round, cond: cond.key, arm: 'A', slot: 3 });
  }
}

await page.evaluate(`window.__ao.apply(${JSON.stringify(BASE)})`);

/* ---------------------------------------------------------------- analyse */

const good = blocks.filter((b) => b.ok);
const pool = (rows) => rows.flatMap((r) => r.ivals);
const allA = good.filter((b) => b.arm === 'A');
const report = { conditions: [] };

const blockMetric = (b, k) => (b.stats.pair ? b.stats.pair[k] : null);

for (const cond of CONDITIONS) {
  const qa = good.filter((b) => b.cond === cond.key && b.arm === 'A');
  const qb = good.filter((b) => b.cond === cond.key && b.arm === 'B');
  if (qa.length < 2 || qb.length < 2) {
    report.conditions.push({ key: cond.key, note: cond.note, voided: true, blocksA: qa.length, blocksB: qb.length });
    continue;
  }
  const A = series(pool(qa));
  const B = series(pool(qb));
  const d = (k, s) => (A[s] && B[s] ? +(B[s][k] - A[s][k]).toFixed(3) : null);

  // QUAD-PAIRED estimator: per quad, mean over its 2 B blocks minus mean over
  // its 2 A blocks. Robust to the load drifting between quads, which it does.
  const quadDeltas = { p50: [], p95: [], over: [] };
  for (let r = 0; r < ROUNDS; r++) {
    const a = good.filter((b) => b.cond === cond.key && b.arm === 'A' && b.round === r);
    const b = good.filter((x) => x.cond === cond.key && x.arm === 'B' && x.round === r);
    if (a.length < 2 || b.length < 2) continue;
    for (const k of ['p50', 'p95', 'over']) {
      const va = a.map((x) => blockMetric(x, k)).filter((v) => v !== null);
      const vb = b.map((x) => blockMetric(x, k)).filter((v) => v !== null);
      if (va.length && vb.length) quadDeltas[k].push(mean(vb) - mean(va));
    }
  }

  report.conditions.push({
    key: cond.key, note: cond.note,
    blocksA: qa.length, blocksB: qb.length, framesA: A.raw.n, framesB: B.raw.n,
    loadA: +mean(qa.map((x) => x.load[1])).toFixed(2),
    loadB: +mean(qb.map((x) => x.load[1])).toFixed(2),
    A, B,
    pooledDelta: {
      pairP50: d('p50', 'pair'), pairP95: d('p95', 'pair'), pairOver: d('over', 'pair'),
      slideP95: d('p95', 'slide12'), rawP95: d('p95', 'raw'),
    },
    quadPaired: {
      p50: boot(quadDeltas.p50, 4000, 991),
      p95: boot(quadDeltas.p95, 4000, 992),
      over: boot(quadDeltas.over, 4000, 993),
    },
    perQuadP95: quadDeltas.p95.map((v) => +v.toFixed(2)),
  });
}

/* NOISE FLOOR: every quad donates an A1-vs-A2 pair on an unchanged config. */
const a1a2 = [];
for (const b of good.filter((x) => x.arm === 'A' && x.slot === 0)) {
  const a2 = good.find((x) => x.cond === b.cond && x.round === b.round && x.slot === 3);
  if (!a2 || !b.stats.pair || !a2.stats.pair) continue;
  a1a2.push({ cond: b.cond, round: b.round, dP50: a2.stats.pair.p50 - b.stats.pair.p50, dP95: a2.stats.pair.p95 - b.stats.pair.p95 });
}
report.noiseFloor = {
  n: a1a2.length,
  absDeltaP50: { med: +med(a1a2.map((x) => Math.abs(x.dP50))).toFixed(3), p90: +pct(a1a2.map((x) => Math.abs(x.dP50)).sort((p, q) => p - q), 0.9).toFixed(3) },
  absDeltaP95: { med: +med(a1a2.map((x) => Math.abs(x.dP95))).toFixed(3), p90: +pct(a1a2.map((x) => Math.abs(x.dP95)).sort((p, q) => p - q), 0.9).toFixed(3) },
  slotBiasP95: +mean(a1a2.map((x) => x.dP95)).toFixed(3),
  slotBiasP50: +mean(a1a2.map((x) => x.dP50)).toFixed(3),
};

report.baseline = allA.length ? series(pool(allA)) : null;
report.baselineHalves = allA.length > 3 ? (() => {
  const h = Math.floor(allA.length / 2);
  return { first: series(pool(allA.slice(0, h))), second: series(pool(allA.slice(h))) };
})() : null;
// The change, pooled, as an absolute pair of numbers rather than a delta.
const sharedB = good.filter((b) => b.cond === 'shared-normals' && b.arm === 'B');
report.shippedVsChange = {
  before: report.baseline,
  after: sharedB.length ? series(pool(sharedB)) : null,
};
report.blocksTotal = blocks.length;
report.blocksVoid = blocks.length - good.length;
report.voidReasons = blocks.filter((b) => !b.ok).map((b) => ({ label: b.label, voids: b.voids }));
report.loadavg = blocks.length ? {
  min: Math.min(...blocks.map((b) => b.load[1])), max: Math.max(...blocks.map((b) => b.load[1])),
  mean: +mean(blocks.map((b) => b.load[1])).toFixed(2),
} : null;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  info, hazard, params: { BLOCK, SETTLE, ROUNDS, WARM, SEED }, report,
  blocks: blocks.map((b) => ({ ...b, ivals: undefined })),
}, null, 2));
writeFileSync(OUT.replace(/\.json$/, '-frames.json'),
  JSON.stringify(blocks.map((b) => ({ label: b.label, cond: b.cond, arm: b.arm, round: b.round, slot: b.slot, ok: b.ok, load: b.load, ivals: b.ivals }))));

/* ----------------------------------------------------------------- print */

if (report.baseline) {
  console.log('\n============ BASELINE = AS SHIPPED (depth-reconstructed normals) ============');
  for (const k of ['raw', 'pair', 'slide12']) {
    const s = report.baseline[k];
    if (s) console.log(`${k.padEnd(9)} n=${String(s.n).padStart(5)}  p50 ${s.p50.toFixed(2)}  IQR ${s.p25.toFixed(2)}-${s.p75.toFixed(2)}  p95 ${s.p95.toFixed(2)}  >16.67 ${s.over.toFixed(1)}%`);
  }
  const af = report.shippedVsChange.after;
  if (af) {
    console.log('------------ WITH THE CHANGE (shared half-res normal buffer) ----------------');
    for (const k of ['raw', 'pair', 'slide12']) {
      const s = af[k];
      if (s) console.log(`${k.padEnd(9)} n=${String(s.n).padStart(5)}  p50 ${s.p50.toFixed(2)}  IQR ${s.p25.toFixed(2)}-${s.p75.toFixed(2)}  p95 ${s.p95.toFixed(2)}  >16.67 ${s.over.toFixed(1)}%`);
    }
  }
  if (report.baselineHalves && report.baselineHalves.first.pair) {
    console.log(`drift check (pair p95): first half ${report.baselineHalves.first.pair.p95.toFixed(2)}  second half ${report.baselineHalves.second.pair.p95.toFixed(2)}`);
  }
}
console.log(`loadavg over run: mean ${report.loadavg?.mean} min ${report.loadavg?.min} max ${report.loadavg?.max}`);
console.log(`blocks ${report.blocksTotal}, void ${report.blocksVoid}`);
console.log(`NOISE FLOOR from ${report.noiseFloor.n} A1-vs-A2 pairs on unchanged config: `
  + `|dp50| med ${report.noiseFloor.absDeltaP50.med} p90 ${report.noiseFloor.absDeltaP50.p90} | `
  + `|dp95| med ${report.noiseFloor.absDeltaP95.med} p90 ${report.noiseFloor.absDeltaP95.p90} | `
  + `slot bias dp95 ${report.noiseFloor.slotBiasP95}`);

console.log('\n===== QUAD-PAIRED DELTAS vs AS-SHIPPED (B - A), ms; negative = faster =====');
console.log('condition            quads  loadA loadB     dP50 [95% CI]              dP95 [95% CI]             d%>16.7   pooled dP95');
const sorted = [...report.conditions].filter((c) => !c.voided).sort((x, y) => x.quadPaired.p95.est - y.quadPaired.p95.est);
for (const c of sorted) {
  const q50 = c.quadPaired.p50, q95 = c.quadPaired.p95, qo = c.quadPaired.over;
  console.log(`${c.key.padEnd(20)} ${String(q95.n).padStart(5)} ${String(c.loadA).padStart(6)} ${String(c.loadB).padStart(5)} `
    + `${q50.est.toFixed(2).padStart(8)} [${String(q50.lo).padStart(6)},${String(q50.hi).padStart(6)}] `
    + `${q95.est.toFixed(2).padStart(8)} [${String(q95.lo).padStart(6)},${String(q95.hi).padStart(6)}] `
    + `${qo.est.toFixed(1).padStart(8)}   ${String(c.pooledDelta.pairP95).padStart(7)}`);
}
for (const c of report.conditions.filter((x) => x.voided)) console.log(`${c.key.padEnd(20)} VOIDED (A:${c.blocksA} B:${c.blocksB})`);
log('wrote', OUT);

await browser.close();
await server.close();
