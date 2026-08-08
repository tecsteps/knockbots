/*
 * shadowgate -- what the SHADOW SYSTEM costs at p95, on a LIVE fight.
 *
 * The 'high' tier ships shadowMapSize 2560 with pcss:true, and PCSS is a 28-tap
 * filter (12 blocker + 16 Vogel PCF) evaluated per shadow-casting light per
 * shaded fragment. Three lights cast: the directional key at 2560 and two
 * per-fighter spot keys at 1024. That was never ablated by name.
 *
 * Method is tools/passbudget.mjs's, unchanged where it is not shadow-specific:
 * one browser session, 1920x1080, 'high', adaptive OFF, live CPU-vs-CPU fight
 * whose rounds cannot end, ABBA quads of ~1.3 s blocks, condition order
 * seed-shuffled per round, quad-paired estimator with a bootstrap CI. Absolute
 * numbers are not comparable across sessions; the paired deltas are the result.
 *
 * WHAT IS DIFFERENT, AND WHY
 *
 *  - Three of these arms change a shader DEFINE and therefore recompile every
 *    material in the scene. That is a 100-300 ms hitch. Those arms get a much
 *    longer settle, and BOTH arms of such a quad get it, so the pairing is not
 *    comparing a settled block against an unsettled one.
 *  - The block guard hashes live program IDs rather than counting them: swapping
 *    one program for another leaves the count identical.
 *  - Every block asserts the compiled FRAGMENT SOURCE on the GPU
 *    (gl.getShaderSource over renderer.info.programs) carries the tap count and
 *    the filter the arm asked for. Flags are not evidence; this is.
 *
 *   node tools/shadowgate.mjs [--rounds 5] [--block 1300] [--settle 1200]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'shadowgate-page.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5243));
const BLOCK = Number(arg('block', 2600));
const SETTLE = Number(arg('settle', 1200));
const RSETTLE = Number(arg('rsettle', 5000));   // settle for arms that recompile
const ROUNDS = Number(arg('rounds', 6));
const MINFRAMES = Number(arg('minframes', 40));
const WARM = Number(arg('warm', 45000));
const SEED = Number(arg('seed', 20260808));
const OUT = arg('out', resolve(REPO, 'scratchpad/shadowgate.json'));
const ONLY = arg('only', '');

const log = (...a) => console.log('[shadowgate]', ...a);

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

/** Bootstrap CI over QUADS: resample whole quads, average their paired deltas. */
function bootstrapCI(deltas, iters = 4000, seed = 12345) {
  if (deltas.length < 2) return { lo: null, hi: null };
  const rnd = mulberry(seed);
  const out = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < deltas.length; j++) s += deltas[Math.floor(rnd() * deltas.length)];
    out.push(s / deltas.length);
  }
  out.sort((a, b) => a - b);
  return { lo: +pct(out, 0.025).toFixed(3), hi: +pct(out, 0.975).toFixed(3) };
}

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

const E = () => ({ ao: 1, bloom: 1, dof: 1, motionBlur: 1, grade: 1, smaa: 1 });
const BASE = {
  key: 'full', effects: E(), scale: 0.85, shadows: true, split: true, off: [],
  pcss: true, taps: null, mapSize: 2560, spotShadows: true,
};
const C = (key, over, note) => Object.assign({}, BASE, { key, note }, over);

// `recompiles` marks arms whose apply() moves a program define, so both arms of
// the quad need the long settle.
const CONDITIONS = [
  C('sg-pcf', { pcss: false }, 'PCSS 28 taps -> three hardware PCF, 5 Vogel taps on a sampler2DShadow. THE HEADLINE ARM.'),
  C('sg-taps-6-8', { taps: [6, 8] }, 'PCSS kept, 28 taps -> 14 (6 blocker + 8 filter)'),
  C('sg-taps-4-6', { taps: [4, 6] }, 'PCSS kept, 28 taps -> 10 (4 blocker + 6 filter)'),
  // THE DECISIVE ARM. Still BasicShadowMap, still a plain sampler2D over the
  // depth texture, still the PCSS code path -- but 2 taps instead of 28. If the
  // cost of PCSS is its TAP COUNT this lands on top of sg-pcf. If it lands on
  // top of the baseline instead, the tap count is not the cost and the sampler
  // mode is, which is a completely different shipped change.
  C('sg-taps-1-1', { taps: [1, 1] }, 'PCSS code path, 28 taps -> 2. Unshippable; it is a BOUND, not a candidate'),
  // Shadows off is already the ceiling; this arm asks whether the shadow-map
  // TYPE still matters once nothing samples a shadow. It must not.
  C('sg-off-pcf', { shadows: false, pcss: false }, 'CONTROL: shadows off AND type PCF. Must equal sg-off'),
  C('sg-map-1024', { mapSize: 1024 }, 'directional key 2560 -> 1024. No recompile: mapSize is a uniform'),
  C('sg-map-1536', { mapSize: 1536 }, 'directional key 2560 -> 1536'),
  C('sg-spot-off', { spotShadows: false }, 'the two per-fighter key spots stop casting: removes 2 maps AND their PCSS taps'),
  C('sg-off', { shadows: false }, 'renderer.shadowMap.enabled = false. The whole shadow system, both halves. CEILING'),
  C('sg-null', {}, 'NULL CONTROL: identical config to the baseline arm'),
  C('sg-pos-070', { scale: 0.70 }, 'POSITIVE CONTROL: 1344x756, must be FASTER by roughly 3.5 ms at p95'),
].filter((c) => !ONLY || ONLY.split(',').includes(c.key));

const RECOMPILE_ARMS = new Set(['sg-pcf', 'sg-taps-6-8', 'sg-taps-4-6', 'sg-taps-1-1', 'sg-spot-off', 'sg-off', 'sg-off-pcf']);
const settleFor = (key) => (RECOMPILE_ARMS.has(key) ? RSETTLE : SETTLE);

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
await page.waitForTimeout(4000);
await page.evaluate(readFileSync(PAGE, 'utf8'));

const info = await page.evaluate('window.__sg.setup({ level: 7 })');
log('setup', JSON.stringify({ quality: info.quality, gpu: info.gpu, dpr: info.dpr }));
log('armed at boot  :', info.armed.join(' '));
log('shadowMap.type :', info.shadowMapType, '(0 = Basic/PCSS, 1 = PCF)   pcssActive:', info.pcssActive);
log('chunk taps     :', JSON.stringify(info.chunkTaps));
log('shadow casters :', JSON.stringify(info.shadowLights));

/* SETUP CONTROLS: prove the two shadow config hazards are real */
const hz = await page.evaluate('window.__sg.hazards()');
log('HAZARD tier.pcss=false changed nothing:', hz.tierPcssFlag.changedNothing, JSON.stringify(hz.tierPcssFlag));
await page.waitForTimeout(3000);
const hzAudit = await page.evaluate('window.__sg.hazardAudit()');
log('HAZARD chunk-edit-without-cache-key-move: chunk said', JSON.stringify(hz.chunkOnly.chunkTaps),
  'but after 3 s of frames the GPU still had', JSON.stringify(hzAudit.pcss));
log('HAZARD restored chunk:', JSON.stringify(await page.evaluate('window.__sg.hazardRestore()')));
const auditBoot = await page.evaluate('window.__sg.shaderAudit()');
log('GPU audit at boot:', JSON.stringify({ total: auditBoot.total, withShadow: auditBoot.withShadow, pcss: auditBoot.pcss, pcf: auditBoot.pcf }));

await page.evaluate(`window.__sg.apply(${JSON.stringify(BASE)})`);
log(`warming ${WARM / 1000}s ...`);
await page.waitForTimeout(WARM);
const auditBase = await page.evaluate('window.__sg.shaderAudit()');
log('GPU audit on the baseline arm:', JSON.stringify({ total: auditBase.total, withShadow: auditBase.withShadow, pcss: auditBase.pcss, pcf: auditBase.pcf, armTags: auditBase.armTags }));
// Programs are released only on material dispose, so an arm switch that does not
// dispose leaks a whole program set. 1.5x the settled baseline is generous and
// still catches the failure that voided the first smoke run (1320 -> 2192).
const PROGRAM_CEILING = Math.round(auditBase.total * 1.5);
log('program-cache ceiling for the run:', PROGRAM_CEILING);

/* ------------------------------------------------------------- the blocks */

const blocks = [];
const t0 = Date.now();

async function runBlock(cfg, label, meta, settle) {
  const applied = await page.evaluate(`window.__sg.apply(${JSON.stringify(cfg)})`);
  await page.waitForTimeout(settle);

  const expectedPasses = await page.evaluate(`window.__sg.expect(${JSON.stringify(cfg)})`);
  const expectedShadow = await page.evaluate(`window.__sg.expectShadow(${JSON.stringify(cfg)})`);
  const audit = await page.evaluate('window.__sg.shaderAudit()');
  const pre = await page.evaluate('window.__sg.snapshot()');
  const load0 = os.loadavg()[0];
  const r = await page.evaluate(`window.__sg.sample(${BLOCK})`);
  const post = await page.evaluate('window.__sg.snapshot()');
  const load1 = os.loadavg()[0];

  const voids = [];
  const ex = expectedPasses.join(' ');
  if (pre.armed.join(' ') !== ex) voids.push('armed-pre != expected [' + pre.armed.join(' ') + ']');
  if (post.armed.join(' ') !== ex) voids.push('armed-post != expected [' + post.armed.join(' ') + ']');
  if (Math.abs(pre.scale - cfg.scale) > 1e-3) voids.push('scale ' + pre.scale);
  if (pre.pixels !== post.pixels) voids.push('resolution changed mid-block');
  if (pre.adaptive || post.adaptive) voids.push('adaptive resolution ON');

  // -- shadow assertions, on state AND on the compiled GLSL ----------------
  const es = expectedShadow;
  if (pre.shadowMapOn !== es.shadowMapOn) voids.push('shadowMap.enabled ' + pre.shadowMapOn);
  if (post.shadowMapOn !== es.shadowMapOn) voids.push('shadowMap.enabled moved mid-block');
  if (pre.shadowMapType !== es.shadowMapType) voids.push('shadowMap.type ' + pre.shadowMapType + ' want ' + es.shadowMapType);
  if (pre.pcssActive !== es.pcssActive) voids.push('_pcssActive ' + pre.pcssActive);
  if (pre.chunkTaps.blocker !== es.chunkBlocker || pre.chunkTaps.filter !== es.chunkFilter) {
    voids.push('chunk taps ' + pre.chunkTaps.blocker + '+' + pre.chunkTaps.filter + ' want ' + es.chunkBlocker + '+' + es.chunkFilter);
  }
  if (pre.chunkTaps.filter !== pre.chunkTaps.divisor) voids.push('chunk filter/divisor disagree (partial rewrite)');
  if (pre.tierMapSize !== es.tierMapSize) voids.push('tier.shadowMapSize ' + pre.tierMapSize);

  const dirs = pre.shadowLights.filter((l) => l.kind === 'dir');
  const spots = pre.shadowLights.filter((l) => l.kind === 'spot');
  if (es.shadowMapOn && dirs.length && dirs.some((l) => l.map !== es.dirMapSize)) {
    voids.push('directional map ' + dirs.map((l) => l.map).join(',') + ' want ' + es.dirMapSize);
  }
  if (spots.length !== es.spotCasters) voids.push('spot casters ' + spots.length + ' want ' + es.spotCasters);

  // THE assertion: what the GPU compiled, not what a flag says.
  const pcssKeys = Object.keys(audit.pcss);
  if (es.shadowMapOn) {
    if (es.gpuPcssKey) {
      if (audit.pcf > 0) voids.push('GPU has ' + audit.pcf + ' hardware-PCF shadow programs on a PCSS arm');
      if (pcssKeys.length !== 1 || pcssKeys[0] !== es.gpuPcssKey) {
        voids.push('GPU pcss taps ' + JSON.stringify(audit.pcss) + ' want ' + es.gpuPcssKey);
      }
    } else {
      if (pcssKeys.length) voids.push('GPU still has PCSS programs ' + JSON.stringify(audit.pcss) + ' on the PCF arm');
      if (audit.pcf === 0) voids.push('GPU has no hardware-PCF shadow program on the PCF arm');
    }
  } else if (audit.withShadow > 0) {
    voids.push('GPU still has ' + audit.withShadow + ' shadow-sampling programs on the shadows-off arm');
  }
  if (Object.keys(audit.armTags).length > 1) voids.push('mixed arm tags on the GPU ' + JSON.stringify(audit.armTags));
  // A program leak destroyed the first smoke run of this tool. Guard it.
  if (audit.total > PROGRAM_CEILING) voids.push('program cache grew to ' + audit.total + ' (ceiling ' + PROGRAM_CEILING + ')');

  if (pre.progSig !== post.progSig) voids.push('program set moved mid-block ' + pre.progSig + '->' + post.progSig);
  if (pre.split !== true || pre.passSplit !== true) voids.push('split lighting off');
  if (pre.quality !== 'high' || post.quality !== 'high') voids.push('tier != high');
  if (pre.phase !== 'fight' || post.phase !== 'fight') voids.push('phase ' + pre.phase + '/' + post.phase);
  if (r.forcedPhase > 0) voids.push('phase forced ' + r.forcedPhase + 'x mid-block');
  if (r.ivals.length < MINFRAMES) voids.push('only ' + r.ivals.length + ' frames');

  const row = {
    label, ...meta, cfgKey: cfg.key, scale: cfg.scale,
    t: Math.round((Date.now() - t0) / 1000),
    expectedPasses, armedPre: pre.armed, expectedShadow: es,
    gpuPcss: audit.pcss, gpuPcf: audit.pcf, gpuPrograms: audit.total, gpuArmTags: audit.armTags,
    applied: applied.changed, tag: applied.tag, recompiledMaterials: applied.recompiledMaterials,
    shadowLights: pre.shadowLights,
    pixels: pre.pixels, wall: +r.wall.toFixed(0), frames: r.ivals.length,
    throughput: +(r.wall / Math.max(1, r.ivals.length + 1)).toFixed(3),
    load: [+load0.toFixed(2), +load1.toFixed(2)],
    drawCalls: pre.drawCalls, sceneDrawCalls: pre.sceneDrawCalls,
    triangles: pre.triangles, programs: pre.programs, progSig: pre.progSig,
    voids, ok: voids.length === 0,
    ivals: r.ivals.map((v) => +v.toFixed(3)),
  };
  row.stats = series(r.ivals);
  blocks.push(row);

  const s = row.stats.pair;
  log(`${label.padEnd(26)} ${row.ok ? ' ' : 'X'} ${String(row.pixels).padEnd(10)}`
    + `n=${String(row.frames).padStart(3)} p50 ${s ? s.p50.toFixed(2) : '  -  '} `
    + `p95 ${s ? s.p95.toFixed(2) : '-'} >16.67 ${s ? String(Math.round(s.over)).padStart(3) : ' -'}% `
    + `| load ${row.load[1].toFixed(2)} | dc ${String(row.drawCalls).padStart(4)} `
    + `| gpu ${JSON.stringify(row.gpuPcss)}/pcf${row.gpuPcf}`
    + `${row.ok ? '' : '\n     VOID: ' + voids.join('; ')}`);
  return row;
}

for (let round = 0; round < ROUNDS; round++) {
  const order = shuffled(CONDITIONS, mulberry(SEED + round * 7919));
  log(`--- round ${round} order: ${order.map((c) => c.key).join(', ')}`);
  for (const cond of order) {
    const st = settleFor(cond.key);
    await runBlock(BASE, `r${round}.${cond.key}.A1`, { round, cond: cond.key, arm: 'A', slot: 0 }, st);
    await runBlock(cond, `r${round}.${cond.key}.B1`, { round, cond: cond.key, arm: 'B', slot: 1 }, st);
    await runBlock(cond, `r${round}.${cond.key}.B2`, { round, cond: cond.key, arm: 'B', slot: 2 }, st);
    await runBlock(BASE, `r${round}.${cond.key}.A2`, { round, cond: cond.key, arm: 'A', slot: 3 }, st);
  }
}

await page.evaluate(`window.__sg.apply(${JSON.stringify(BASE)})`);

/* ---------------------------------------------------------------- analyse */

const good = blocks.filter((b) => b.ok);
const pool = (rows) => rows.flatMap((r) => r.ivals);
const allA = good.filter((b) => b.arm === 'A');
const report = { conditions: [] };

for (const cond of CONDITIONS) {
  const rows = good.filter((b) => b.cond === cond.key);
  const qa = rows.filter((b) => b.arm === 'A');
  const qb = rows.filter((b) => b.arm === 'B');
  if (qa.length < 2 || qb.length < 2) {
    report.conditions.push({ key: cond.key, note: cond.note, voided: true, blocksA: qa.length, blocksB: qb.length });
    continue;
  }
  const A = series(pool(qa));
  const B = series(pool(qb));
  const dPooled = (k, s) => (A[s] && B[s] ? +(B[s][k] - A[s][k]).toFixed(3) : null);

  // QUAD-PAIRED estimator: per quad, mean(B blocks) - mean(A blocks).
  const quadD = { p50: [], p95: [], sl95: [], over: [] };
  for (let r = 0; r < ROUNDS; r++) {
    const a = rows.filter((b) => b.arm === 'A' && b.round === r);
    const b = rows.filter((x) => x.arm === 'B' && x.round === r);
    if (a.length < 2 || b.length < 2) continue;
    const ok = (x) => x.stats.pair && x.stats.slide12;
    if (!a.every(ok) || !b.every(ok)) continue;
    quadD.p50.push(mean(b.map((x) => x.stats.pair.p50)) - mean(a.map((x) => x.stats.pair.p50)));
    quadD.p95.push(mean(b.map((x) => x.stats.pair.p95)) - mean(a.map((x) => x.stats.pair.p95)));
    quadD.sl95.push(mean(b.map((x) => x.stats.slide12.p95)) - mean(a.map((x) => x.stats.slide12.p95)));
    quadD.over.push(mean(b.map((x) => x.stats.pair.over)) - mean(a.map((x) => x.stats.pair.over)));
  }
  const est = (arr, seed) => ({
    mean: +mean(arr).toFixed(3), med: +med(arr).toFixed(3),
    ci: bootstrapCI(arr, 4000, seed), n: arr.length,
    negative: arr.filter((v) => v < 0).length,
  });

  report.conditions.push({
    key: cond.key, note: cond.note,
    blocksA: qa.length, blocksB: qb.length, framesA: A.raw.n, framesB: B.raw.n,
    loadA: +mean(qa.map((x) => x.load[1])).toFixed(2), loadB: +mean(qb.map((x) => x.load[1])).toFixed(2),
    A, B,
    pooled: {
      pairP50: dPooled('p50', 'pair'), pairP95: dPooled('p95', 'pair'), pairOver: dPooled('over', 'pair'),
      slideP95: dPooled('p95', 'slide12'), rawP95: dPooled('p95', 'raw'),
    },
    quad: {
      p50: est(quadD.p50, 11), p95: est(quadD.p95, 22),
      slide95: est(quadD.sl95, 33), over: est(quadD.over, 44),
      perQuadP95: quadD.p95.map((v) => +v.toFixed(2)),
    },
    gpuB: qb[0] ? { pcss: qb[0].gpuPcss, pcf: qb[0].gpuPcf } : null,
    drawCallsA: qa[0] ? qa[0].drawCalls : null, drawCallsB: qb[0] ? qb[0].drawCalls : null,
  });
}

/* NOISE FLOOR: every quad donates an A1-vs-A2 pair on an unchanged config. */
const a1a2 = [];
for (const b of good.filter((x) => x.arm === 'A' && x.slot === 0)) {
  const a2 = good.find((x) => x.cond === b.cond && x.round === b.round && x.slot === 3);
  if (!a2 || !b.stats.pair || !a2.stats.pair) continue;
  a1a2.push({ dP50: a2.stats.pair.p50 - b.stats.pair.p50, dP95: a2.stats.pair.p95 - b.stats.pair.p95 });
}
report.noiseFloor = {
  n: a1a2.length,
  absDeltaP50: { med: +med(a1a2.map((x) => Math.abs(x.dP50))).toFixed(3) },
  absDeltaP95: { med: +med(a1a2.map((x) => Math.abs(x.dP95))).toFixed(3), p90: +pct(a1a2.map((x) => Math.abs(x.dP95)).sort((p, q) => p - q), 0.9).toFixed(3) },
  slotBiasP95: +mean(a1a2.map((x) => x.dP95)).toFixed(3),
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
writeFileSync(OUT, JSON.stringify({
  info, hazards: hz, hazardAudit: hzAudit, auditBoot, auditBase,
  params: { BLOCK, SETTLE, RSETTLE, ROUNDS, WARM, SEED }, report,
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
}
console.log(`loadavg over run: mean ${report.loadavg?.mean} min ${report.loadavg?.min} max ${report.loadavg?.max}`);
console.log(`blocks ${report.blocksTotal}, void ${report.blocksVoid}`);
console.log(`NOISE FLOOR from ${report.noiseFloor.n} A1-vs-A2 pairs: |dp95| med ${report.noiseFloor.absDeltaP95.med} p90 ${report.noiseFloor.absDeltaP95.p90}; slot bias ${report.noiseFloor.slotBiasP95}`);

console.log('\n============ QUAD-PAIRED DELTAS (B - A), ms. negative = the arm is FASTER ============');
console.log('condition        quads  loadA loadB     dP50     dP95   [95% CI]            dsl95   d%>16.7  perquad dP95');
const sortedC = [...report.conditions].filter((c) => !c.voided).sort((x, y) => x.quad.p95.mean - y.quad.p95.mean);
for (const c of sortedC) {
  const q = c.quad;
  console.log(`${c.key.padEnd(15)} ${String(q.p95.n).padStart(5)} ${String(c.loadA).padStart(6)} ${String(c.loadB).padStart(5)} `
    + `${q.p50.mean.toFixed(2).padStart(8)} ${q.p95.mean.toFixed(2).padStart(8)}  `
    + `[${q.p95.ci.lo === null ? '  -  ' : q.p95.ci.lo.toFixed(2)}, ${q.p95.ci.hi === null ? '  -  ' : q.p95.ci.hi.toFixed(2)}]`.padEnd(20)
    + `${q.slide95.mean.toFixed(2).padStart(7)} ${q.over.mean.toFixed(1).padStart(8)}   [${q.perQuadP95.join(', ')}]`);
}
for (const c of report.conditions.filter((x) => x.voided)) console.log(`${c.key.padEnd(15)} VOIDED (A:${c.blocksA} B:${c.blocksB})`);
log('wrote', OUT);

await browser.close();
await server.close();
