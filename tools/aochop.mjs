/*
 * aochop -- the same A/B as tools/aogate.mjs, paired ten times faster.
 *
 * WHY THIS EXISTS. aogate ran 216 ABBA blocks on a box carrying four sibling
 * headless Chromiums. It produced a clean SETUP control and correctly-signed
 * positive controls, and it produced an UNUSABLE verdict, because its NULL arm
 * -- a config-identical B arm -- came back at
 *
 *     dP50 +2.85 ms [+0.21, +5.67],  dP95 +1.66 ms [-5.23, +9.55]
 *
 * with a block-level noise floor of |dP95| median 8.2 ms. The contention on
 * this box moves inside the ~3 s that separates the A and B blocks of a quad,
 * so the pairing does not cancel it. A tolerance of 9 ms cannot decide a 2 ms
 * question. That is a property of the instrument in this regime, not of the
 * change, and the fix is to pair closer together rather than to average longer.
 *
 * WHAT MAKES CLOSER PAIRING POSSIBLE HERE. The comparison is a #define on two
 * ShaderMaterials and nothing else -- GTAOPass.setGBuffer sets
 * NORMAL_VECTOR_TYPE and the tNormal uniform. No composer rebuild, no pass
 * construction, no reallocation. Once both variants are in three's program
 * cache the flip is a cache hit. So the arms are interleaved in ~0.7 s
 * segments, hundreds of times, and consecutive segments are the pair. The first
 * DROP frames after every flip are discarded, so a cache miss can never land in
 * a sample.
 *
 * This does NOT replace aogate: fast alternation cannot measure a condition
 * that needs a composer rebuild (no-ao) or a resize (renderScale). Those stay
 * in aogate. What this measures is the one comparison that is a define flip.
 *
 * ESTIMATOR. Per adjacent (A,B) segment pair, the difference of segment MEAN
 * frame interval -- a segment holds ~15 frames on this box, which is too few
 * for a percentile but plenty for a mean. Bootstrap over pairs. Percentiles are
 * reported POOLED (all A frames vs all B frames), which is unpaired and
 * therefore only trustworthy because the null chop below says the pooling is
 * unbiased at this alternation rate.
 *
 * CONTROLS
 *   NULL       'null-depth' and 'null-shared' alternate a mode WITH ITSELF, so
 *              every flip, every drop and every pairing happens exactly as in
 *              the live arm and the only thing missing is the change. Their
 *              deltas are the tolerance.
 *   POSITIVE   'pd12-vs-pd2' flips the Poisson denoise between 12 taps and 2 --
 *              the same kind of define flip, with a cost that must be large and
 *              negative. If the rig cannot see that, it cannot see anything.
 *   SETUP      the define state and the normal-buffer identity are read back
 *              per SEGMENT and asserted; the normal prepass is COUNTED per
 *              segment (shared segments must run it once per frame, depth
 *              segments zero times); the armed pass list is asserted per arm.
 *
 *   node tools/aochop.mjs [--segs 240] [--segms 700] [--drop 6]
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
const PORT = Number(arg('port', 5245));
const SEGS = Number(arg('segs', 240));
const SEGMS = Number(arg('segms', 700));
const DROP = Number(arg('drop', 6));
const WARM = Number(arg('warm', 30000));
const BOOT = Number(arg('boot', 4000));
const OUT = arg('out', resolve(REPO, 'scratchpad/aochop.json'));
const ONLY = arg('only', '');

const log = (...a) => console.log('[aochop]', ...a);

const pct = (s, p) => {
  if (!s.length) return NaN;
  const h = (s.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
function stat(a) {
  if (!a || a.length < 8) return null;
  const s = [...a].sort((x, y) => x - y);
  return {
    n: s.length, p50: +pct(s, 0.5).toFixed(3), p25: +pct(s, 0.25).toFixed(3),
    p75: +pct(s, 0.75).toFixed(3), p90: +pct(s, 0.9).toFixed(3), p95: +pct(s, 0.95).toFixed(3),
    mean: +mean(s).toFixed(3), over: +(100 * s.filter((v) => v > 16.67).length / s.length).toFixed(1),
  };
}
function mulberry(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function boot(vals, iters = 6000, seed = 7) {
  if (vals.length < 2) return { est: null, lo: null, hi: null, n: vals.length };
  const rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < vals.length; i++) s += vals[Math.floor(rnd() * vals.length)];
    out.push(s / vals.length);
  }
  out.sort((x, y) => x - y);
  return {
    est: +mean(vals).toFixed(3), lo: +pct(out, 0.025).toFixed(3), hi: +pct(out, 0.975).toFixed(3),
    n: vals.length, fracNeg: +(vals.filter((v) => v < 0).length / vals.length).toFixed(3),
  };
}
/** Bootstrap CI for the difference of pooled percentiles, resampling SEGMENTS. */
function bootPooledPct(segsA, segsB, p, iters = 2000, seed = 11) {
  const rnd = mulberry(seed);
  const out = [];
  for (let b = 0; b < iters; b++) {
    const a = [], bb = [];
    for (let i = 0; i < segsA.length; i++) a.push(...segsA[Math.floor(rnd() * segsA.length)]);
    for (let i = 0; i < segsB.length; i++) bb.push(...segsB[Math.floor(rnd() * segsB.length)]);
    a.sort((x, y) => x - y); bb.sort((x, y) => x - y);
    out.push(pct(bb, p) - pct(a, p));
  }
  out.sort((x, y) => x - y);
  return { lo: +pct(out, 0.025).toFixed(3), hi: +pct(out, 0.975).toFixed(3) };
}

/* ------------------------------------------------------------ conditions */

const K = Number(arg('k', 6));

const ARMS = [
  { key: 'x-shared-vs-depth', modes: ['depth', 'shared'], pd: null, rep: [K, K],
    note: 'THE CHANGE, AMPLIFIED: the AO trace and denoise run K times per frame in BOTH arms, so the difference is K times the per-frame difference and the contention noise is unchanged. Divide by K' },
  { key: 'x-null-depth', modes: ['depth', 'depth'], pd: null, rep: [K, K],
    note: 'NULL for the amplified arm: the shipped mode alternated with itself, same K, same flips, same drops' },
  { key: 'shared-vs-depth', modes: ['depth', 'shared'], pd: null, rep: [1, 1],
    note: 'THE CHANGE, unamplified. A = as shipped (both shaders reconstruct), B = shared half-res normal buffer' },
  { key: 'null-depth', modes: ['depth', 'depth'], pd: null, rep: [1, 1],
    note: 'NULL: the shipped mode alternated with itself. Every flip and drop happens; only the change is missing' },
  { key: 'pos-pd12-vs-pd2', modes: ['depth', 'depth'], pd: [12, 2], rep: [1, 1],
    note: 'POSITIVE: same kind of define flip, Poisson denoise 12 taps vs 2. Must be large and negative' },
  { key: 'attr-gtao11-vs-3', modes: ['depth', 'depth'], pd: null, rep: [1, 1], gs: [11, 3],
    note: 'ATTRIBUTION: the GTAO TRACE at 11 samples vs 3, i.e. 24 depth taps per pixel vs 6. Where the denoise arm says the cost is not, this arm asks whether it is here' },
  { key: 'x-attr-gtao11-vs-3', modes: ['depth', 'depth'], pd: null, rep: [K, K], gs: [11, 3],
    note: 'ATTRIBUTION, AMPLIFIED: the same trace flip with the pass run K times per frame' },
].filter((a) => !ONLY || ONLY.split(',').includes(a.key));

/* ------------------------------------------------------------------ boot */

const server = await createServer({
  root: REPO, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-zero-copy', '--disable-frame-rate-limit', '--force-device-scale-factor=1'],
});
const BASE = { effects: { ao: 1, bloom: 1, dof: 1, motionBlur: 1, grade: 1, smaa: 1 }, scale: 0.85, normals: 'depth', pdSamples: 12 };
const PAGE_SRC = readFileSync(PAGE, 'utf8');

let page = null;
let info = null;
let hazard = null;
let sessions = 0;

/**
 * The first attempt at this run lost its page mid-arm ('Execution context was
 * destroyed'). A renderer that dies takes the whole run with it unless the run
 * can stand back up, so it does -- and every restart is COUNTED and reported,
 * because a restart splits the session and the arms either side of one are no
 * longer paired against the same process.
 */
async function newSession(warmMs) {
  if (page) { try { await page.close(); } catch { /* already gone */ } }
  sessions++;
  page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));
  page.on('crash', () => console.warn('[page-crash]'));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(BOOT);
  await page.evaluate(PAGE_SRC);
  info = await page.evaluate('window.__ao.setup({ level: 7 })');
  if (sessions === 1) {
    log('setup', JSON.stringify({ quality: info.quality, gpu: info.gpu }));
    log('armed at boot :', info.armed.join(' '));
    hazard = await page.evaluate('window.__ao.hazard()');
    log('HAZARD assertion flags direct assignment:', hazard.assertionWouldFlag,
      '| the trap pays for the buffer and never reads it:', hazard.trapPaysAndDoesNotRead);
  }
  await page.evaluate(`window.__ao.apply(${JSON.stringify(BASE)})`);
  // Prime every program variant BEFORE warming, so no compile can land in a chop.
  for (const m of ['shared', 'depth', 'shared', 'depth']) {
    await page.evaluate(`window.__ao.setNormalMode('${m}')`);
    await page.waitForTimeout(600);
  }
  for (const n of [2, 8, 12]) {
    await page.evaluate(`window.__ao.setPdSamples(${n})`);
    await page.waitForTimeout(600);
  }
  for (const n of [3, 11]) {
    await page.evaluate(`window.__ao.setGtaoSamples(${n})`);
    await page.waitForTimeout(600);
  }
  await page.evaluate(`window.__ao.apply(${JSON.stringify(BASE)})`);
  log(`session ${sessions}: priming done; warming ${warmMs / 1000}s ...`);
  await page.waitForTimeout(warmMs);
}

await newSession(WARM);

/* ------------------------------------------------------------- the chops */

const report = { arms: [], params: { SEGS, SEGMS, DROP }, defects: [] };
const raw = {};

for (const armDef of ARMS) {
 for (let attempt = 0; attempt < 2; attempt++) {
  const sessionAtStart = sessions;
  try {
  await page.evaluate(`window.__ao.apply(${JSON.stringify(BASE)})`);
  await page.waitForTimeout(1200);
  const armedPre = await page.evaluate('window.__ao.armed()');
  const load0 = os.loadavg()[0];
  const opt = { modes: armDef.modes, segMs: SEGMS, segs: SEGS, drop: DROP, pdSamples: armDef.pd, repeat: armDef.rep || [1, 1], gtaoSamples: armDef.gs || null };
  const r = await page.evaluate(`window.__ao.chop(${JSON.stringify(opt)})`);
  const load1 = os.loadavg()[0];
  const armedPost = await page.evaluate('window.__ao.armed()');
  await page.evaluate('window.__ao.setPdSamples(12)');
  await page.evaluate('window.__ao.setAoRepeat(1)');
  await page.evaluate('window.__ao.setGtaoSamples(11)');

  /* --- SETUP CONTROL, per segment ---------------------------------------- */
  const defects = [];
  if (armedPre.join(' ') !== armedPost.join(' ')) defects.push('armed list moved during the chop');
  const segs = r.segs;
  for (const s of segs) {
    const wantShared = s.mode === 'shared';
    if (s.state.gtaoNVT !== (wantShared ? 1 : 0) || s.state.pdNVT !== (wantShared ? 1 : 0)) {
      defects.push(`seg ${s.i} (${s.mode}) defines ${s.state.gtaoNVT}/${s.state.pdNVT}`);
    }
    if (s.state.wired !== wantShared) defects.push(`seg ${s.i} (${s.mode}) wired ${s.state.wired}`);
    if (wantShared && s.normalRenders < s.frames - 1) defects.push(`seg ${s.i} shared but normal prepass ran ${s.normalRenders}/${s.frames}`);
    if (!wantShared && s.normalRenders !== 0) defects.push(`seg ${s.i} depth but normal prepass ran ${s.normalRenders}x`);
    if (armDef.pd) {
      const wantPd = armDef.pd[s.i % armDef.pd.length];
      if (s.state.pdSamples !== wantPd) defects.push(`seg ${s.i} pdSamples ${s.state.pdSamples} != ${wantPd}`);
    }
    if (armDef.gs) {
      const wantGs = armDef.gs[s.i % armDef.gs.length];
      if (s.state.gtaoSamples !== wantGs) defects.push(`seg ${s.i} gtaoSamples ${s.state.gtaoSamples} != ${wantGs}`);
    }
    const wantRep = (armDef.rep || [1, 1])[s.i % 2];
    if (s.state.aoRepeat !== wantRep) defects.push(`seg ${s.i} aoRepeat ${s.state.aoRepeat} != ${wantRep}`);
    if (!s.state.amplifierInstalled) defects.push(`seg ${s.i} amplifier not installed`);
  }

  /* --- estimator ---------------------------------------------------------- */
  // Slot 0 is the A arm, slot 1 the B arm. For the pd arm both are 'depth' and
  // the label is the tap count instead.
  const tag = armDef.pd ? 'pd' : (armDef.gs ? 'gtao' : null);
  const arr = armDef.pd || armDef.gs;
  const labelA = tag ? tag + arr[0] : armDef.modes[0];
  const labelB = tag ? tag + arr[1] : armDef.modes[1];

  const usable = segs.filter((s) => s.ivals.length >= 4);
  const pairs = [];
  for (let i = 0; i + 1 < segs.length; i += 2) {
    const a = segs[i], b = segs[i + 1];
    if (a.ivals.length < 4 || b.ivals.length < 4) continue;
    pairs.push(mean(b.ivals) - mean(a.ivals));
  }
  const segA = usable.filter((s, ) => s.i % 2 === 0).map((s) => s.ivals);
  const segB = usable.filter((s) => s.i % 2 === 1).map((s) => s.ivals);
  const framesA = segA.flat(), framesB = segB.flat();
  const A = stat(framesA), B = stat(framesB);

  const row = {
    key: armDef.key, note: armDef.note, labelA, labelB,
    repeat: (armDef.rep || [1, 1])[0],
    segsTotal: segs.length, segsUsable: usable.length,
    framesA: framesA.length, framesB: framesB.length,
    framesPerSeg: +mean(usable.map((s) => s.ivals.length)).toFixed(1),
    load: [+load0.toFixed(2), +load1.toFixed(2)],
    A, B,
    pairedMeanDelta: boot(pairs, 6000, 31),
    pooledDelta: A && B ? {
      mean: +(B.mean - A.mean).toFixed(3), p50: +(B.p50 - A.p50).toFixed(3),
      p90: +(B.p90 - A.p90).toFixed(3), p95: +(B.p95 - A.p95).toFixed(3),
      over: +(B.over - A.over).toFixed(1),
    } : null,
    pooledP95CI: segA.length > 3 && segB.length > 3 ? bootPooledPct(segA, segB, 0.95) : null,
    pooledP50CI: segA.length > 3 && segB.length > 3 ? bootPooledPct(segA, segB, 0.50, 2000, 12) : null,
    // The amplified arms measure K executions; the per-frame figure is that
    // divided by K. Reported for both so the two can be compared directly.
    perFrameMean: (() => {
      const k = (armDef.rep || [1, 1])[0] || 1;
      const b2 = boot(pairs.map((v) => v / k), 6000, 31);
      return { k, est: b2.est, lo: b2.lo, hi: b2.hi };
    })(),
    defects: defects.slice(0, 8),
    defectCount: defects.length,
  };
  report.arms.push(row);
  raw[armDef.key] = segs.map((s) => ({ i: s.i, mode: s.mode, n: s.ivals.length, nr: s.normalRenders, ivals: s.ivals }));
  if (defects.length) report.defects.push(`${armDef.key}: ${defects.length} segment defects, first: ${defects[0]}`);

  log(`${armDef.key.padEnd(18)} segs ${row.segsUsable}/${row.segsTotal} (${row.framesPerSeg} f/seg) `
    + `load ${row.load[1].toFixed(2)} | ${labelA} p50 ${A ? A.p50.toFixed(2) : '-'} p95 ${A ? A.p95.toFixed(2) : '-'} `
    + `| ${labelB} p50 ${B ? B.p50.toFixed(2) : '-'} p95 ${B ? B.p95.toFixed(2) : '-'} `
    + `| PAIRED dmean ${row.pairedMeanDelta.est} [${row.pairedMeanDelta.lo}, ${row.pairedMeanDelta.hi}] over ${row.pairedMeanDelta.n} pairs`
    + `${defects.length ? ' | DEFECTS ' + defects.length : ''}`);
  // Written after EVERY arm, so a lost page costs one arm rather than the run.
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ info, hazard, sessions, report }, null, 2));
  writeFileSync(OUT.replace(/\.json$/, '-segments.json'), JSON.stringify(raw));
  break;
  } catch (e) {
    console.warn(`[aochop] arm ${armDef.key} lost its page (${String(e).split('\n')[0]}); restarting session`);
    report.defects.push(`${armDef.key}: session lost on attempt ${attempt + 1}`);
    if (attempt === 1) break;
    await newSession(Math.min(WARM, 15000));
    if (sessions === sessionAtStart) break;
  }
 }
}

try { await page.evaluate(`window.__ao.apply(${JSON.stringify(BASE)})`); } catch { /* page already gone */ }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ info, hazard, sessions, report }, null, 2));
writeFileSync(OUT.replace(/\.json$/, '-segments.json'), JSON.stringify(raw));

console.log('\n================ FAST-ALTERNATION A/B (B - A), ms ================');
console.log('arm                 K  pairs   paired dMEAN [95% CI]        PER FRAME (/K) [CI]        pooled dP95 [CI]');
for (const r of report.arms) {
  const pm = r.pairedMeanDelta, p50 = r.pooledP50CI, p95 = r.pooledP95CI;
  const pf = r.perFrameMean;
  console.log(`${r.key.padEnd(19)} ${String(r.repeat).padStart(2)} ${String(pm.n).padStart(5)} `
    + `${String(pm.est).padStart(8)} [${String(pm.lo).padStart(7)},${String(pm.hi).padStart(7)}] `
    + `${String(pf.est).padStart(8)} [${String(pf.lo).padStart(7)},${String(pf.hi).padStart(7)}] `
    + `${String(r.pooledDelta.p95).padStart(8)} [${String(p95 ? p95.lo : '-').padStart(7)},${String(p95 ? p95.hi : '-').padStart(7)}]`);
}
console.log(`\nsetup defects: ${report.defects.length ? report.defects.join(' | ') : 'none'}`);
log('wrote', OUT);

await browser.close();
await server.close();
