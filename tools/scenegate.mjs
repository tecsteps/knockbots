/*
 * scenegate -- prices the scene pass's DRAW CALLS and TRIANGLES, then A/Bs the
 * candidate that follows from the price.
 *
 * Same discipline as tools/passbudget.mjs and for the same recorded reasons:
 * timer queries are unusable under ANGLE/Metal, the noise is contention on a
 * shared box, so everything is ABBA quads of ~1.3s blocks inside ONE session on
 * a LIVE fight with rounds prevented from ending, condition order shuffled per
 * round, quad-paired estimator with a bootstrap CI.
 *
 * CONTROLS
 *   NULL      'null-full' is config-identical to the baseline arm.
 *   POSITIVE  'pos-scale070' must be FASTER (documented -3.60 ms p95).
 *   SETUP     armed pass list asserted before AND after every block; a block
 *             also voids if the program cache moves (a compile landed inside
 *             it), the scale moves, adaptive comes on, or the phase leaves
 *             'fight'.
 *   LINEARITY the two draw arms and the two triangle arms are 1x and ~2.5x of
 *             each other. If the deltas are not roughly proportional the slope
 *             is not a slope and the whole calibration is void.
 *
 *   node tools/scenegate.mjs [--rounds 4] [--only a,b] [--out path]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'scenegate-page.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5244));
const BLOCK = Number(arg('block', 1300));
const SETTLE = Number(arg('settle', 1200));
const ROUNDS = Number(arg('rounds', 4));
const WARM = Number(arg('warm', 45000));
const SEED = Number(arg('seed', 20260808));
const OUT = arg('out', resolve(REPO, 'scratchpad/scenegate.json'));
const ONLY = arg('only', '');
const SET = arg('set', 'calib');

const log = (...a) => console.log('[scenegate]', ...a);

/* ------------------------------------------------------------ statistics */
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
    n: s.length, p50: +pct(s, 0.5).toFixed(3), p25: +pct(s, 0.25).toFixed(3), p75: +pct(s, 0.75).toFixed(3),
    p90: +pct(s, 0.90).toFixed(3), p95: +pct(s, 0.95).toFixed(3), p99: +pct(s, 0.99).toFixed(3),
    mean: +(s.reduce((t, v) => t + v, 0) / s.length).toFixed(3),
    over: +(100 * s.filter((v) => v > 16.67).length / s.length).toFixed(1),
  };
}
const pairSeries = (a) => a.slice(0, -1).map((v, i) => (v + a[i + 1]) / 2);
function slide(a, k) {
  const out = []; if (a.length < k) return out;
  let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= k) s -= a[i - k]; if (i >= k - 1) out.push(s / k); }
  return out;
}
const series = (a) => ({ raw: stat(a), pair: stat(pairSeries(a)), slide12: stat(slide(a, 12)) });
const med = (a) => (a.length ? pct([...a].sort((x, y) => x - y), 0.5) : NaN);

function mulberry(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/** Quad-paired bootstrap over quads: mean(B) - mean(A) within each quad. */
function bootstrap(quads, k, iters = 4000, seed = 7) {
  if (!quads.length) return null;
  const d = quads.map((q) => q.B[k] - q.A[k]);
  const point = d.reduce((s, v) => s + v, 0) / d.length;
  const rnd = mulberry(seed);
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < d.length; j++) s += d[Math.floor(rnd() * d.length)];
    means.push(s / d.length);
  }
  means.sort((a, b) => a - b);
  return {
    point: +point.toFixed(3),
    lo: +pct(means, 0.025).toFixed(3), hi: +pct(means, 0.975).toFixed(3),
    n: d.length, negFrac: +(d.filter((v) => v < 0).length / d.length).toFixed(2),
  };
}

/* ------------------------------------------------------------ conditions */

const BASE = { key: 'full', scale: 0.85, nDraw: 0, nTri: 0, ablate: null };
const C = (key, over, note) => Object.assign({ key, scale: 0.85, nDraw: 0, nTri: 0, ablate: null, note }, over);

const SETS = {
  calib: [
    C('null-full', {}, 'NULL CONTROL: config-identical to the baseline arm'),
    C('pos-scale070', { scale: 0.70 }, 'POSITIVE CONTROL: 1344x756, must be faster'),
    C('cal-draw120', { nDraw: 120 }, 'PRICE A DRAW CALL: +120 zero-area draws with real materials'),
    C('cal-draw300', { nDraw: 300 }, 'PRICE A DRAW CALL: +300, the linearity check on the above'),
    C('cal-tri6', { nTri: 6 }, 'PRICE A TRIANGLE: +6 clones of arena.set.dark, zero area (+315k tris, +6 draws)'),
    C('cal-tri16', { nTri: 16 }, 'PRICE A TRIANGLE: +16 clones (+840k tris, +16 draws), linearity check'),
    C('abl-crowd', { ablate: 'crowd' }, 'HEADROOM: hide the 12 crowd InstancedMesh (121k tris, 12 draws). Changes the image; not a shipping state'),
    C('abl-arenacast', { ablate: 'arenacast' }, 'HEADROOM: arena.* stop casting into the 2560 dir shadow map'),
    C('abl-midground', { ablate: 'midground' }, 'HEADROOM: hide the 6 env.midground InstancedMesh (+12 draws when it landed)'),
  ],
  candidate: [
    C('null-full', {}, 'NULL CONTROL'),
    C('pos-scale070', { scale: 0.70 }, 'POSITIVE CONTROL'),
    C('cand-on', { casterMinR: Number(arg('minr', 0.06)) }, 'CANDIDATE: shadow-caster screen-size cull ON'),
  ],
};

const CONDITIONS = (SETS[SET] || SETS.calib).filter((c) => !ONLY || ONLY.split(',').includes(c.key));

/* ------------------------------------------------------------------ boot */
const server = await createServer({
  root: REPO, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy',
    '--disable-frame-rate-limit', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });
await page.waitForTimeout(4000);
await page.evaluate(readFileSync(PAGE, 'utf8'));
const info = await page.evaluate('window.__sg.setup({ level: 7, maxDraws: 320, maxTri: 16 })');
log('setup', JSON.stringify({ quality: info.quality, gpu: info.gpu, candidate: info.candidate }));
log('armed :', info.armed.join(' '));
log('calib rig:', JSON.stringify(info.built));

await page.evaluate(`window.__sg.apply(${JSON.stringify(BASE)})`);
log(`warming ${WARM / 1000}s (calibration rig visible during warm-up so it compiles here) ...`);
// show everything once so any variant compiles now, then hide
await page.evaluate('window.__sg.setCalib(320, 16)');
await page.waitForTimeout(6000);
await page.evaluate('window.__sg.setCalib(0, 0)');
await page.waitForTimeout(WARM - 6000);

/* -------------------------------------------------------------- blocks */
const blocks = [];
const t0 = Date.now();

async function runBlock(cfg, label, meta) {
  await page.evaluate(`window.__sg.apply(${JSON.stringify(cfg)})`);
  await page.waitForTimeout(SETTLE);
  const expected = await page.evaluate('window.__sg.expect()');
  const pre = await page.evaluate('window.__sg.snapshot()');
  const load0 = os.loadavg()[0];
  const r = await page.evaluate(`window.__sg.sample(${BLOCK})`);
  const post = await page.evaluate('window.__sg.snapshot()');
  const load1 = os.loadavg()[0];

  const voids = [];
  const ex = expected.join(' ');
  if (pre.armed.join(' ') !== ex) voids.push('armed-pre != expected [' + pre.armed.join(' ') + ']');
  if (post.armed.join(' ') !== ex) voids.push('armed-post != expected');
  if (Math.abs(pre.scale - cfg.scale) > 1e-3) voids.push('scale ' + pre.scale);
  if (pre.pixels !== post.pixels) voids.push('resolution changed mid-block');
  if (pre.adaptive || post.adaptive) voids.push('adaptive ON');
  if (!pre.shadowMapOn) voids.push('shadowMap off');
  if (!pre.split || pre.passSplit !== true) voids.push('split ' + pre.split + '/' + pre.passSplit);
  if (pre.programs !== post.programs) voids.push('programs ' + pre.programs + '->' + post.programs);
  if (pre.quality !== 'high') voids.push('tier ' + pre.quality);
  if (pre.phase !== 'fight' || post.phase !== 'fight') voids.push('phase');
  if (r.forcedPhase > 0) voids.push('phase forced mid-block');
  if (r.ivals.length < 30) voids.push('only ' + r.ivals.length + ' frames');

  const row = {
    label, ...meta, cfgKey: cfg.key, scale: cfg.scale, nDraw: cfg.nDraw, nTri: cfg.nTri, ablate: cfg.ablate,
    t: Math.round((Date.now() - t0) / 1000),
    pixels: pre.pixels, frames: r.ivals.length, wall: +r.wall.toFixed(0),
    load: [+load0.toFixed(2), +load1.toFixed(2)],
    drawCalls: pre.drawCalls, sceneDrawCalls: pre.sceneDrawCalls,
    triangles: pre.triangles, sceneTriangles: pre.sceneTriangles, programs: pre.programs,
    sep: pre.sep, voids, ok: voids.length === 0,
    ivals: r.ivals.map((v) => +v.toFixed(3)), cpu: stat(r.cpu),
  };
  row.stats = series(r.ivals);
  blocks.push(row);
  const s = row.stats.pair;
  log(`${label.padEnd(26)} ${row.ok ? ' ' : 'X'} n=${String(row.frames).padStart(3)} `
    + `p50 ${s ? s.p50.toFixed(2) : '  -  '} p95 ${s ? s.p95.toFixed(2) : '  -  '} `
    + `>16.67 ${s ? String(Math.round(s.over)).padStart(3) : ' -'}% | dc ${String(row.drawCalls).padStart(4)} `
    + `sdc ${String(row.sceneDrawCalls).padStart(4)} tri ${String(Math.round(row.sceneTriangles / 1000)).padStart(5)}k `
    + `| load ${row.load[1].toFixed(2)}${row.ok ? '' : ' | VOID: ' + voids.join('; ')}`);
  return row;
}

for (let round = 0; round < ROUNDS; round++) {
  const order = shuffled(CONDITIONS, mulberry(SEED + round * 7919));
  log(`--- round ${round}: ${order.map((c) => c.key).join(', ')}`);
  for (const cond of order) {
    await runBlock(BASE, `r${round}.${cond.key}.A1`, { round, cond: cond.key, arm: 'A', slot: 0 });
    await runBlock(cond, `r${round}.${cond.key}.B1`, { round, cond: cond.key, arm: 'B', slot: 1 });
    await runBlock(cond, `r${round}.${cond.key}.B2`, { round, cond: cond.key, arm: 'B', slot: 2 });
    await runBlock(BASE, `r${round}.${cond.key}.A2`, { round, cond: cond.key, arm: 'A', slot: 3 });
  }
}
await page.evaluate(`window.__sg.apply(${JSON.stringify(BASE)})`);

/* ------------------------------------------------------------- analyse */
const good = blocks.filter((b) => b.ok);
const pool = (rows) => rows.flatMap((r) => r.ivals);
const report = { conditions: [] };

for (const cond of CONDITIONS) {
  const qa = good.filter((b) => b.cond === cond.key && b.arm === 'A');
  const qb = good.filter((b) => b.cond === cond.key && b.arm === 'B');
  if (qa.length < 2 || qb.length < 2) { report.conditions.push({ key: cond.key, note: cond.note, voided: true }); continue; }
  const A = series(pool(qa)), B = series(pool(qb));

  // quad-paired: per quad, mean of the two B blocks minus mean of the two A blocks
  const quads = [];
  for (let r = 0; r < ROUNDS; r++) {
    const a = good.filter((b) => b.cond === cond.key && b.arm === 'A' && b.round === r);
    const b = good.filter((x) => x.cond === cond.key && x.arm === 'B' && x.round === r);
    if (a.length !== 2 || b.length !== 2) continue;
    const m = (rows, k) => rows.reduce((s, x) => s + x.stats.pair[k], 0) / rows.length;
    const mo = (rows) => rows.reduce((s, x) => s + x.stats.pair.over, 0) / rows.length;
    const dc = (rows) => rows.reduce((s, x) => s + x.drawCalls, 0) / rows.length;
    const tr = (rows) => rows.reduce((s, x) => s + x.sceneTriangles, 0) / rows.length;
    quads.push({
      round: r,
      A: { p50: m(a, 'p50'), p95: m(a, 'p95'), over: mo(a), dc: dc(a), tri: tr(a) },
      B: { p50: m(b, 'p50'), p95: m(b, 'p95'), over: mo(b), dc: dc(b), tri: tr(b) },
    });
  }
  report.conditions.push({
    key: cond.key, note: cond.note, blocksA: qa.length, blocksB: qb.length,
    loadA: +(qa.reduce((s, x) => s + x.load[1], 0) / qa.length).toFixed(2),
    loadB: +(qb.reduce((s, x) => s + x.load[1], 0) / qb.length).toFixed(2),
    A, B,
    dDrawCalls: +(quads.reduce((s, q) => s + (q.B.dc - q.A.dc), 0) / Math.max(1, quads.length)).toFixed(1),
    dTriangles: Math.round(quads.reduce((s, q) => s + (q.B.tri - q.A.tri), 0) / Math.max(1, quads.length)),
    boot: { p50: bootstrap(quads, 'p50'), p95: bootstrap(quads, 'p95'), over: bootstrap(quads, 'over') },
    perQuadP95: quads.map((q) => +(q.B.p95 - q.A.p95).toFixed(2)),
    quads,
  });
}

const a1a2 = [];
for (const b of good.filter((x) => x.arm === 'A' && x.slot === 0)) {
  const a2 = good.find((x) => x.cond === b.cond && x.round === b.round && x.slot === 3);
  if (!a2) continue;
  a1a2.push({ dP50: a2.stats.pair.p50 - b.stats.pair.p50, dP95: a2.stats.pair.p95 - b.stats.pair.p95 });
}
report.noiseFloor = {
  n: a1a2.length,
  absP50: { med: +med(a1a2.map((x) => Math.abs(x.dP50))).toFixed(2), p90: +pct(a1a2.map((x) => Math.abs(x.dP50)).sort((p, q) => p - q), 0.9).toFixed(2) },
  absP95: { med: +med(a1a2.map((x) => Math.abs(x.dP95))).toFixed(2), p90: +pct(a1a2.map((x) => Math.abs(x.dP95)).sort((p, q) => p - q), 0.9).toFixed(2) },
  slotBias: +(a1a2.reduce((s, x) => s + x.dP95, 0) / Math.max(1, a1a2.length)).toFixed(2),
};
const allA = good.filter((b) => b.arm === 'A');
report.baseline = allA.length ? series(pool(allA)) : null;
report.blocksTotal = blocks.length;
report.blocksVoid = blocks.length - good.length;
report.voidReasons = blocks.filter((b) => !b.ok).map((b) => ({ label: b.label, voids: b.voids }));
report.loadavg = { mean: +(blocks.reduce((s, b) => s + b.load[1], 0) / blocks.length).toFixed(2), min: Math.min(...blocks.map((b) => b.load[1])), max: Math.max(...blocks.map((b) => b.load[1])) };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ info, params: { BLOCK, SETTLE, ROUNDS, WARM, SEED, SET }, report, blocks: blocks.map((b) => ({ ...b, ivals: undefined })) }, null, 2));
writeFileSync(OUT.replace(/\.json$/, '-frames.json'), JSON.stringify(blocks.map((b) => ({ label: b.label, cond: b.cond, arm: b.arm, round: b.round, slot: b.slot, ok: b.ok, load: b.load, ivals: b.ivals }))));

/* --------------------------------------------------------------- print */
if (report.baseline) {
  console.log('\n============ BASELINE (all full-chain A blocks pooled) ============');
  for (const k of ['raw', 'pair', 'slide12']) {
    const s = report.baseline[k];
    if (s) console.log(`${k.padEnd(9)} n=${String(s.n).padStart(5)}  p50 ${s.p50.toFixed(2)}  IQR ${s.p25.toFixed(2)}-${s.p75.toFixed(2)}  p95 ${s.p95.toFixed(2)}  >16.67 ${s.over.toFixed(1)}%`);
  }
}
console.log(`loadavg mean ${report.loadavg.mean} (${report.loadavg.min}-${report.loadavg.max}) | blocks ${report.blocksTotal} void ${report.blocksVoid}`);
console.log(`NOISE FLOOR ${report.noiseFloor.n} A1-A2 pairs: |dp50| med ${report.noiseFloor.absP50.med} p90 ${report.noiseFloor.absP50.p90} | |dp95| med ${report.noiseFloor.absP95.med} p90 ${report.noiseFloor.absP95.p90} | slot bias ${report.noiseFloor.slotBias}`);
console.log('\n============ QUAD-PAIRED DELTAS (B - A), pair-series, ms ============');
console.log('condition        loadA loadB   ddraws     dtris     dP50    dP95 [95% CI]              d%>16.7   per-quad dP95');
for (const c of report.conditions.filter((x) => !x.voided).sort((x, y) => x.boot.p95.point - y.boot.p95.point)) {
  const b = c.boot;
  console.log(`${c.key.padEnd(15)} ${String(c.loadA).padStart(5)} ${String(c.loadB).padStart(5)} `
    + `${String(c.dDrawCalls).padStart(8)} ${String(c.dTriangles).padStart(9)} `
    + `${b.p50.point.toFixed(2).padStart(8)} ${b.p95.point.toFixed(2).padStart(7)} [${b.p95.lo.toFixed(2)}, ${b.p95.hi.toFixed(2)}]`.padEnd(60)
    + ` ${b.over.point.toFixed(1).padStart(7)}   [${c.perQuadP95.join(', ')}]`);
}
for (const c of report.conditions.filter((x) => x.voided)) console.log(`${c.key.padEnd(15)} VOIDED`);
log('wrote', OUT);

await browser.close();
await server.close();
