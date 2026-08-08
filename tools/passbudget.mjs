/*
 * passbudget -- per-pass frame-budget attribution by ABLATION, on a LIVE fight.
 *
 * Answers "where does the p95 go" for the 'high' tier at 1920x1080 with
 * adaptive resolution OFF. One browser session, one fight, ABBA quads.
 *
 * WHY IT IS SHAPED LIKE THIS (all of it is a response to a recorded failure in
 * docs/PROFILING.md):
 *
 *  - EXT_disjoint_timer_query_webgl2 is exposed here and reports ~2.2-2.7x the
 *    wall clock under ANGLE/Metal. Not used. Attribution is by ablation delta
 *    on wall-clock frame interval.
 *  - RenderPipeline.effects is a plain object; only setEffect() rebuilds the
 *    chain. Every config change goes through setEffect, and the armed pass list
 *    is asserted before AND after every block. Any mismatch VOIDS the block.
 *  - The noise here is CONTENTION, not heat, and it moves on a timescale of
 *    seconds. So every condition is measured as ABBA quads of ~1.3 s blocks
 *    against the full chain, inside one session, repeated over several rounds
 *    with the condition order shuffled per round. Absolute numbers are not
 *    comparable across sessions; the paired deltas are the result.
 *  - A live match is a moving baseline. Rounds are prevented from ending at all
 *    (Game.training set directly + health pump), so no KO cinematic, no round
 *    reset and no camera reframe can land inside a block.
 *  - frameMs in rp.stats is a 48-frame rolling MEAN and cannot give a
 *    percentile. It is not used for anything.
 *
 * CONTROLS
 *   NULL      'null-full' is identical in config to the baseline arm; its delta
 *             must sit inside the tolerance. Separately, every quad contributes
 *             an A1-vs-A2 pair on an unchanged configuration -- that pooled
 *             distribution IS the instrument's noise floor and is reported.
 *   POSITIVE  'pos-scale100' must be SLOWER and 'pos-scale070' FASTER, by
 *             roughly the magnitudes already documented for renderScale.
 *   SETUP     armed pass list asserted per block against a recomputation of
 *             #buildComposer's own logic; plus a hazard demo that proves direct
 *             assignment does not disarm a pass and that the assertion sees it.
 *   METHOD    'meth-ao-enabled' ablates AO by pass.enabled instead of setEffect.
 *             PROFILING.md warns that setEffect smears its composer rebuild into
 *             the sample; with a ~1.2 s settle it should not, and this arm is
 *             what checks that rather than assuming it.
 *
 *   node tools/passbudget.mjs [--rounds 4] [--block 1300] [--settle 1200]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'passbudget-page.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5241));
const BLOCK = Number(arg('block', 1300));
const SETTLE = Number(arg('settle', 1200));
const ROUNDS = Number(arg('rounds', 4));
const WARM = Number(arg('warm', 45000));
const SEED = Number(arg('seed', 20260808));
const OUT = arg('out', resolve(REPO, 'scratchpad/passbudget.json'));
const ONLY = arg('only', '');

const log = (...a) => console.log('[passbudget]', ...a);

/* ------------------------------------------------------------- statistics */

// Linear-interpolated order statistic (the usual "type 7" quantile).
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
const med = (a) => (a.length ? pct([...a].sort((x, y) => x - y), 0.5) : NaN);

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
const BASE = { key: 'full', effects: E(), scale: 0.85, shadows: true, split: true, off: [] };
const C = (key, over, note) => Object.assign({ key, effects: E(), scale: 0.85, shadows: true, split: true, off: [], note }, over);

const CONDITIONS = [
  C('no-ao', { effects: E({ ao: 0 }) }, 'GTAO half-res + poisson denoise removed'),
  C('no-bloom', { effects: E({ bloom: 0 }) }, 'HighlightBloom mip chain removed'),
  C('no-dof', { effects: E({ dof: 0 }) }, 'BokehDof, 14 taps, removed'),
  C('no-motionBlur', { effects: E({ motionBlur: 0 }) }, 'MotionBlur, 8 taps, removed'),
  C('no-smaa', { effects: E({ smaa: 0 }) }, 'SMAA removed'),
  C('no-grade', { effects: E({ grade: 0 }) }, 'GradePass removed; OutputPass takes AgX back, so this is a MOVE not a delete'),
  C('no-overlay', { off: ['overlay'] }, 'EffectsDirector OverlayPass: not a RenderPipeline effect, ablated by pass.enabled'),
  C('no-output', { off: ['output'] }, 'OutputPass: not shippable (no sRGB transfer). Calibrates what one fullscreen blit costs'),
  C('no-shadows', { shadows: false }, 'renderer.shadowMap.enabled=false: scene-side, one 2560 shadow draw per frame'),
  C('no-split', { split: false }, 'split beauty pass off, ScenePass intact: separates the split from the post chain'),
  C('post-off', { effects: E({ ao: 0, bloom: 0, dof: 0, motionBlur: 0, grade: 0, smaa: 0 }) }, 'CONFOUNDED: dropping every depth consumer swaps ScenePass for RenderPass and calls restoreSplitLayers, so this also un-splits the scene'),
  C('only-mb', { effects: E({ ao: 0, bloom: 0, dof: 0, motionBlur: 1, grade: 0, smaa: 0 }) }, 'ScenePass + MotionBlur + Output + overlay: keeps the split, so full - this = cost of ao+bloom+dof+grade+smaa together'),
  C('null-full', {}, 'NULL CONTROL: identical config to the baseline arm'),
  C('pos-scale100', { scale: 1.00 }, 'POSITIVE CONTROL: 1920x1080, must be slower'),
  C('pos-scale070', { scale: 0.70 }, 'POSITIVE CONTROL: 1344x756, must be faster'),
  C('meth-ao-enabled', { off: ['ao'] }, 'METHOD CONTROL: AO off by pass.enabled instead of setEffect'),
].filter((c) => !ONLY || ONLY.split(',').includes(c.key));

// Toggling renderer.shadowMap.enabled changes a program define on every
// material in the scene, so both arms of that quad need a much longer settle.
// The smoke run leaked a 101 ms compile hitch into a 2.6 s-settled block.
// no-split moves every material's light count for the same reason, and leaked a
// 137 ms compile hitch at 1.2 s.
const settleFor = (key) => (key === 'no-shadows' || key === 'no-split' ? 6000 : SETTLE);

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
await page.waitForTimeout(4000);
await page.evaluate(readFileSync(PAGE, 'utf8'));

const info = await page.evaluate('window.__pb.setup({ level: 7 })');
log('setup', JSON.stringify({ quality: info.quality, gpu: info.gpu, dpr: info.dpr }));
log('armed at boot :', info.armed.join(' '));

/* SETUP CONTROL: prove the config hazard is real and that the assertion sees it */
const hazard = await page.evaluate('window.__pb.hazard()');
log('HAZARD boot            :', hazard.boot.join(' '));
log('HAZARD direct-assign   :', hazard.afterDirectAssign.join(' '));
log('HAZARD setEffect(false):', hazard.afterSetEffect.join(' '));
log('HAZARD assertion flags direct assignment:', hazard.assertionWouldFlag, '| restored == boot:', hazard.restoredMatchesBoot);

await page.evaluate(`window.__pb.apply(${JSON.stringify(BASE)})`);
log(`warming ${WARM / 1000}s ...`);
await page.waitForTimeout(WARM);

/* ------------------------------------------------------------- the blocks */

const blocks = [];
const t0 = Date.now();

async function runBlock(cfg, label, meta, settle) {
  const applied = await page.evaluate(`window.__pb.apply(${JSON.stringify(cfg)})`);
  await page.waitForTimeout(settle);

  const expected = await page.evaluate(`window.__pb.expect(${JSON.stringify(cfg)})`);
  const pre = await page.evaluate('window.__pb.snapshot()');
  const load0 = os.loadavg()[0];
  const r = await page.evaluate(`window.__pb.sample(${BLOCK})`);
  const post = await page.evaluate('window.__pb.snapshot()');
  const load1 = os.loadavg()[0];

  const voids = [];
  const ex = expected.join(' ');
  if (pre.armed.join(' ') !== ex) voids.push('armed-pre != expected [' + pre.armed.join(' ') + ']');
  if (post.armed.join(' ') !== ex) voids.push('armed-post != expected [' + post.armed.join(' ') + ']');
  if (Math.abs(pre.scale - cfg.scale) > 1e-3) voids.push('scale ' + pre.scale);
  if (pre.pixels !== post.pixels) voids.push('resolution changed mid-block');
  if (pre.adaptive || post.adaptive) voids.push('adaptive resolution ON');
  if (pre.shadowMapOn !== (cfg.shadows !== false)) voids.push('shadowMap ' + pre.shadowMapOn);
  if (post.shadowMapOn !== (cfg.shadows !== false)) voids.push('shadowMap changed mid-block');
  if (pre.split !== (cfg.split !== false)) voids.push('splitLighting flag ' + pre.split);
  if (pre.passSplit !== null && pre.passSplit !== (cfg.split !== false)) voids.push('ScenePass.splitLighting ' + pre.passSplit);
  // A program-cache move inside the block means something compiled inside the
  // block, and a compile hitch is not the configuration under test.
  if (pre.programs !== post.programs) voids.push('programs ' + pre.programs + '->' + post.programs + ' (compile inside block)');
  if (pre.quality !== 'high' || post.quality !== 'high') voids.push('tier != high');
  if (pre.phase !== 'fight' || post.phase !== 'fight') voids.push('phase ' + pre.phase + '/' + post.phase);
  if (r.forcedPhase > 0) voids.push('phase forced ' + r.forcedPhase + 'x mid-block');
  if (r.ivals.length < 30) voids.push('only ' + r.ivals.length + ' frames');

  const row = {
    label, ...meta, cfgKey: cfg.key, scale: cfg.scale,
    t: Math.round((Date.now() - t0) / 1000),
    expected, armedPre: pre.armed, armedPost: post.armed,
    applied: applied.changed, rebuilds: applied.rebuilds, forceOff: applied.forceOff,
    pixels: pre.pixels, wall: +r.wall.toFixed(0), frames: r.ivals.length,
    throughput: +(r.wall / Math.max(1, r.ivals.length + 1)).toFixed(3),
    load: [+load0.toFixed(2), +load1.toFixed(2)],
    drawCalls: pre.drawCalls, sceneDrawCalls: pre.sceneDrawCalls,
    triangles: pre.triangles, programs: pre.programs,
    sep: pre.sep, camDist: pre.camDist, hp: pre.hp, tick: pre.tick,
    split: pre.split, passSplit: pre.passSplit, shadowMapOn: pre.shadowMapOn,
    voids, ok: voids.length === 0,
    ivals: r.ivals.map((v) => +v.toFixed(3)),
    cpu: stat(r.cpu),
  };
  row.stats = series(r.ivals);
  blocks.push(row);

  const s = row.stats.pair;
  log(`${label.padEnd(28)} ${row.ok ? ' ' : 'X'} ${String(row.pixels).padEnd(10)}`
    + `n=${String(row.frames).padStart(3)} p50 ${s ? s.p50.toFixed(2) : '  -  '} `
    + `IQR[${s ? s.p25.toFixed(2) : '-'},${s ? s.p75.toFixed(2) : '-'}] p95 ${s ? s.p95.toFixed(2) : '-'} `
    + `>16.67 ${s ? String(Math.round(s.over)).padStart(3) : ' -'}% | thru ${row.throughput.toFixed(2)} `
    + `| load ${row.load[1].toFixed(2)} | dc ${String(row.drawCalls).padStart(4)}`
    + `${row.ok ? '' : ' | VOID: ' + voids.join('; ')}`);
  return row;
}

for (let round = 0; round < ROUNDS; round++) {
  const order = shuffled(CONDITIONS, mulberry(SEED + round * 7919));
  log(`--- round ${round} order: ${order.map((c) => c.key).join(', ')}`);
  for (const cond of order) {
    const st = settleFor(cond.key);
    // ABBA: baseline, condition, condition, baseline.
    await runBlock(BASE, `r${round}.${cond.key}.A1`, { round, cond: cond.key, arm: 'A', slot: 0 }, st);
    await runBlock(cond, `r${round}.${cond.key}.B1`, { round, cond: cond.key, arm: 'B', slot: 1 }, st);
    await runBlock(cond, `r${round}.${cond.key}.B2`, { round, cond: cond.key, arm: 'B', slot: 2 }, st);
    await runBlock(BASE, `r${round}.${cond.key}.A2`, { round, cond: cond.key, arm: 'A', slot: 3 }, st);
  }
}

await page.evaluate(`window.__pb.apply(${JSON.stringify(BASE)})`);

/* ---------------------------------------------------------------- analyse */

const good = blocks.filter((b) => b.ok);
const pool = (rows) => rows.flatMap((r) => r.ivals);
const allA = good.filter((b) => b.arm === 'A');
const report = { conditions: [] };

for (const cond of CONDITIONS) {
  const qa = good.filter((b) => b.cond === cond.key && b.arm === 'A');
  const qb = good.filter((b) => b.cond === cond.key && b.arm === 'B');
  if (qa.length < 2 || qb.length < 2) { report.conditions.push({ key: cond.key, note: cond.note, voided: true, blocksA: qa.length, blocksB: qb.length }); continue; }
  const A = series(pool(qa));
  const B = series(pool(qb));
  const d = (k, s) => (A[s] && B[s] ? +(B[s][k] - A[s][k]).toFixed(3) : null);

  const perRound = [];
  for (let r = 0; r < ROUNDS; r++) {
    const a = good.filter((b) => b.cond === cond.key && b.arm === 'A' && b.round === r);
    const b = good.filter((x) => x.cond === cond.key && x.arm === 'B' && x.round === r);
    if (a.length && b.length) {
      const sa = series(pool(a)), sb = series(pool(b));
      if (sa.pair && sb.pair) {
        perRound.push({
          round: r,
          dP50: +(sb.pair.p50 - sa.pair.p50).toFixed(3),
          dP95: +(sb.pair.p95 - sa.pair.p95).toFixed(3),
          dSlideP95: sa.slide12 && sb.slide12 ? +(sb.slide12.p95 - sa.slide12.p95).toFixed(3) : null,
        });
      }
    }
  }
  report.conditions.push({
    key: cond.key, note: cond.note,
    blocksA: qa.length, blocksB: qb.length, framesA: A.raw.n, framesB: B.raw.n,
    loadA: +(qa.reduce((s, x) => s + x.load[1], 0) / qa.length).toFixed(2),
    loadB: +(qb.reduce((s, x) => s + x.load[1], 0) / qb.length).toFixed(2),
    A, B,
    delta: {
      rawP50: d('p50', 'raw'), rawP95: d('p95', 'raw'),
      pairP50: d('p50', 'pair'), pairP95: d('p95', 'pair'), pairOver: d('over', 'pair'),
      slideP50: d('p50', 'slide12'), slideP95: d('p95', 'slide12'), slideOver: d('over', 'slide12'),
    },
    perRoundDeltaP95: perRound.map((p) => p.dP95),
    perRoundDeltaP50: perRound.map((p) => p.dP50),
    perRound,
  });
}

/* NOISE FLOOR: every quad donates an A1-vs-A2 pair on an unchanged config. */
const a1a2 = [];
for (const b of good.filter((x) => x.arm === 'A' && x.slot === 0)) {
  const a2 = good.find((x) => x.cond === b.cond && x.round === b.round && x.slot === 3);
  if (!a2 || !b.stats.pair || !a2.stats.pair) continue;
  a1a2.push({
    cond: b.cond, round: b.round,
    dP50: +(a2.stats.pair.p50 - b.stats.pair.p50).toFixed(3),
    dP95: +(a2.stats.pair.p95 - b.stats.pair.p95).toFixed(3),
  });
}
report.noiseFloor = {
  n: a1a2.length,
  absDeltaP50: { med: +med(a1a2.map((x) => Math.abs(x.dP50))).toFixed(3), p90: +pct(a1a2.map((x) => Math.abs(x.dP50)).sort((p, q) => p - q), 0.9).toFixed(3) },
  absDeltaP95: { med: +med(a1a2.map((x) => Math.abs(x.dP95))).toFixed(3), p90: +pct(a1a2.map((x) => Math.abs(x.dP95)).sort((p, q) => p - q), 0.9).toFixed(3) },
  pairs: a1a2,
};

report.baseline = allA.length ? series(pool(allA)) : null;
report.baselineHalves = allA.length > 3 ? (() => {
  const h = Math.floor(allA.length / 2);
  return { first: series(pool(allA.slice(0, h))), second: series(pool(allA.slice(h))) };
})() : null;
report.blocksTotal = blocks.length;
report.blocksVoid = blocks.length - good.length;
report.voidReasons = blocks.filter((b) => !b.ok).map((b) => ({ label: b.label, voids: b.voids }));
report.loadavg = blocks.length ? {
  min: Math.min(...blocks.map((b) => b.load[1])), max: Math.max(...blocks.map((b) => b.load[1])),
  mean: +(blocks.reduce((s, b) => s + b.load[1], 0) / blocks.length).toFixed(2),
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
  console.log('\n================ BASELINE (all full-chain A blocks pooled) ================');
  for (const k of ['raw', 'pair', 'slide12']) {
    const s = report.baseline[k];
    if (s) console.log(`${k.padEnd(9)} n=${String(s.n).padStart(5)}  p50 ${s.p50.toFixed(2)}  IQR ${s.p25.toFixed(2)}-${s.p75.toFixed(2)}  p95 ${s.p95.toFixed(2)}  >16.67 ${s.over.toFixed(1)}%`);
  }
  if (report.baselineHalves && report.baselineHalves.first.pair) {
    console.log(`drift check (pair p95): first half ${report.baselineHalves.first.pair.p95.toFixed(2)}  second half ${report.baselineHalves.second.pair.p95.toFixed(2)}`);
  }
}
console.log(`loadavg over run: mean ${report.loadavg?.mean} min ${report.loadavg?.min} max ${report.loadavg?.max}`);
console.log(`blocks ${report.blocksTotal}, void ${report.blocksVoid}`);
console.log(`NOISE FLOOR from ${report.noiseFloor.n} A1-vs-A2 pairs on unchanged config: `
  + `|dp50| med ${report.noiseFloor.absDeltaP50.med} p90 ${report.noiseFloor.absDeltaP50.p90} | `
  + `|dp95| med ${report.noiseFloor.absDeltaP95.med} p90 ${report.noiseFloor.absDeltaP95.p90}`);

console.log('\n================ PER-CONDITION PAIRED DELTAS (B - A), ms ================');
console.log('condition             nB   loadA loadB    dP50   dP95pair  dP95sl12   d%>16.7   per-round dP95');
const sorted = [...report.conditions].filter((c) => !c.voided).sort((x, y) => x.delta.pairP95 - y.delta.pairP95);
for (const c of sorted) {
  console.log(`${c.key.padEnd(20)} ${String(c.framesB).padStart(5)} ${String(c.loadA).padStart(6)} ${String(c.loadB).padStart(5)} `
    + `${c.delta.pairP50.toFixed(2).padStart(8)} ${c.delta.pairP95.toFixed(2).padStart(9)} ${String(c.delta.slideP95).padStart(9)} `
    + `${c.delta.pairOver.toFixed(1).padStart(9)}   [${c.perRoundDeltaP95.map((p) => p.toFixed(1)).join(', ')}]`);
}
for (const c of report.conditions.filter((x) => x.voided)) console.log(`${c.key.padEnd(20)} VOIDED (A:${c.blocksA} B:${c.blocksB})`);
log('wrote', OUT);

await browser.close();
await server.close();
