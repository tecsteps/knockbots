/*
 * scenelace -- frame-interleaved A/B on the scene pass, on a live fight.
 *
 * Answers, for the 'high' tier at 1920x1080 with adaptive resolution off:
 *
 *   1. what does a DRAW CALL cost here?          (cal-draw*, by ADDING draws)
 *   2. what does a TRIANGLE cost here?           (cal-tri*,  by ADDING triangles)
 *   3. how much headroom do the usual structural moves have?  (abl-*)
 *   4. does the candidate change move p95?       (cand-*)
 *
 * The answers are what decides whether instancing / merging / LOD / caster
 * culling in the scene pass can pay at all. They are measured by ADDING work
 * rather than removing it, because a removed draw also removes its pixels and
 * this frame is documented fill-bound -- an addition of zero-area geometry
 * isolates the per-draw and per-vertex cost with nothing else moving.
 *
 * METHOD. Arms swap every 16 frames inside one session (see the header of
 * tools/scenelace-page.js for why that is legitimate here and why passbudget
 * could not do it). Slots run ABBA inside a superblock; superblocks are dealt
 * round-robin over the conditions in a seeded shuffle. The estimator is a
 * block bootstrap over superblocks on the POOLED per-arm statistic, so the CI
 * accounts for the fact that frames inside a superblock are not independent.
 *
 * CONTROLS
 *   NULL      'null' is config-identical in both arms.
 *   POSITIVE  'pos-noao' disables the AO pass, measured by passbudget at
 *             -2.24 ms p95 [0.94, 3.45], replicated across two sessions.
 *   SETUP     the armed pass list is read off composer.passes at every slot
 *             boundary and reported; the run asserts the program count, the
 *             render scale, the split flag and the phase did not move.
 *   LINEARITY cal-draw120 vs cal-draw300 and cal-tri6 vs cal-tri16 are ~2.5x
 *             each other. A slope that is not proportional is not a slope.
 *
 *   node tools/scenelace.mjs [--minutes 14] [--set calib] [--only a,b]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'scenelace-page.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5245));
const SLOT = Number(arg('slot', 16));
const DISCARD = Number(arg('discard', 4));
const SUPER = Number(arg('super', 26));     // superblocks per condition
const WARM = Number(arg('warm', 40000));
const SEED = Number(arg('seed', 20260808));
const OUT = arg('out', resolve(REPO, 'scratchpad/scenelace.json'));
const ONLY = arg('only', '');
const SET = arg('set', 'calib');

const log = (...a) => console.log('[scenelace]', ...a);

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
    p90: +pct(s, 0.90).toFixed(3), p95: +pct(s, 0.95).toFixed(3),
    mean: +(s.reduce((t, v) => t + v, 0) / s.length).toFixed(3),
    over: +(100 * s.filter((v) => v > 16.67).length / s.length).toFixed(1),
  };
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
/** 2-frame average, computed WITHIN a contiguous same-arm run only. */
function pairWithin(groups) {
  const out = [];
  for (const g of groups) for (let i = 1; i < g.length; i++) out.push((g[i] + g[i - 1]) / 2);
  return out;
}
/**
 * Block bootstrap over superblocks. Resamples whole superblocks with
 * replacement and recomputes the POOLED statistic difference each time, so the
 * CI carries the within-superblock correlation that a per-frame bootstrap would
 * throw away.
 */
function blockBoot(byBlock, key, iters = 3000, seed = 11) {
  const ids = Object.keys(byBlock);
  if (ids.length < 4) return null;
  const point = (() => {
    const A = [], B = [];
    for (const id of ids) { A.push(...byBlock[id].A); B.push(...byBlock[id].B); }
    const sa = stat(A), sb = stat(B);
    return sa && sb ? sb[key] - sa[key] : NaN;
  })();
  const rnd = mulberry(seed);
  const draws = [];
  for (let it = 0; it < iters; it++) {
    const A = [], B = [];
    for (let k = 0; k < ids.length; k++) {
      const id = ids[Math.floor(rnd() * ids.length)];
      A.push(...byBlock[id].A); B.push(...byBlock[id].B);
    }
    const sa = stat(A), sb = stat(B);
    if (sa && sb) draws.push(sb[key] - sa[key]);
  }
  draws.sort((x, y) => x - y);
  return { point: +point.toFixed(3), lo: +pct(draws, 0.025).toFixed(3), hi: +pct(draws, 0.975).toFixed(3), blocks: ids.length };
}

/* ------------------------------------------------------------ conditions */
const A_CFG = { nDraw: 0, nTri: 0, ablate: null, off: [] };
const C = (key, cfg, note) => ({ key, cfg: Object.assign({}, A_CFG, cfg), note });

const SETS = {
  calib: [
    C('null', {}, 'NULL CONTROL: arm B identical to arm A'),
    C('pos-noao', { off: ['ao'] }, 'POSITIVE CONTROL: AO pass off. passbudget: -2.24 ms p95 [0.94, 3.45], replicated'),
    C('cal-draw120', { nDraw: 120 }, '+120 zero-area draws, real materials and programs'),
    C('cal-draw300', { nDraw: 300 }, '+300 zero-area draws (linearity check on the above)'),
    C('cal-tri6', { nTri: 6 }, '+6 clones of arena.set.dark: +315k triangles, +6 draws, zero area'),
    C('cal-tri16', { nTri: 16 }, '+16 clones: +840k triangles, +16 draws (linearity check)'),
    C('abl-crowd', { ablate: 'crowd' }, 'HEADROOM: hide 12 crowd InstancedMesh (121k tris, 12 draws). Not a shipping state'),
    C('abl-arenacast', { ablate: 'arenacast' }, 'HEADROOM: arena.* stop casting into the 2560 directional map'),
  ],
  // The depth prepass's screen-radius knee is the one knob in RenderPipeline.js
  // whose measured table (in the doc comment on prepassMinScreenRadius) was
  // taken at renderScale 1.00, with the SIM PAUSED, and BEFORE the split beauty
  // pass existed -- all three of which changed what the prepass is doing. It is
  // a plain property read per frame, so it interleaves for free.
  prepass: [
    C('null', {}, 'NULL CONTROL'),
    C('pos-noao', { off: ['ao'] }, 'POSITIVE CONTROL: -2.24 ms p95 per passbudget'),
    C('prepass-0', { prepassMinR: 0 }, 'prepass takes every eligible mesh (the knee at 0)'),
    C('prepass-2', { prepassMinR: 2 }, 'documented table: 164 draws, 26.2 ms vs 24.4 at 1'),
    C('prepass-4', { prepassMinR: 4 }, 'documented table: 155 draws, 26.8 ms'),
    C('prepass-1e9', { prepassMinR: 1e9 }, 'prepass draws only the split geometry (fighters); the arena lays no depth'),
  ],
  // The draw-call PRICE, as a four-point ladder plus a null. The first calib
  // run gave two points that disagreed by 2x on the implied per-draw cost
  // (26 us from +180 draws, 12 us from +450), which is not a slope. A ladder
  // with a null under it is what turns it into one -- and the ladder doubles as
  // the positive control, because every rung MUST be slower than the one below.
  ladder: [
    C('null', {}, 'NULL CONTROL: arm B identical to arm A'),
    C('pos-noao', { off: ['ao'] }, 'POSITIVE CONTROL: AO pass off. passbudget: -2.24 ms p95, -1.68 p50'),
    C('cal-draw60', { nDraw: 60 }, 'draw ladder rung 1'),
    C('cal-draw120', { nDraw: 120 }, 'draw ladder rung 2'),
    C('cal-draw240', { nDraw: 240 }, 'draw ladder rung 3'),
    C('cal-draw480', { nDraw: 480 }, 'draw ladder rung 4'),
    C('cal-tri32', { nTri: 32 }, 'TRIANGLE ceiling: +32 clones of arena.set.dark, ~1.7M extra triangles, zero area'),
    C('cand-split1', { prepassSplitMinR: 1.0 }, 'CANDIDATE: put the fighters back under the prepass screen-radius knee (~16 fewer prepass draws)'),
  ],
  cand: [
    C('null', {}, 'NULL CONTROL'),
    C('pos-noao', { off: ['ao'] }, 'POSITIVE CONTROL'),
    C('cand', { casterMinR: Number(arg('minr', 0.05)) }, 'CANDIDATE, whatever the working tree exposes'),
  ],
};
const CONDS = (SETS[SET] || SETS.calib).filter((c) => !ONLY || ONLY.split(',').includes(c.key));

/* ------------------------------------------------------------------ boot */
const server = await createServer({ root: REPO, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
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
const info = await page.evaluate('window.__sl.setup({ level: 7, maxDraws: 320, maxTri: 16 })');
log('setup', JSON.stringify({ quality: info.quality, scale: info.scale, pixels: info.pixels, gpu: info.gpu, hasCandidate: info.hasCandidate }));
log('armed :', info.armed.join(' '));
log('calib :', JSON.stringify(info.built));

/* warm-up with every calibration variant visible once, so nothing compiles later */
const maxCfg = { nDraw: 320, nTri: 16, ablate: null, off: [] };
await page.evaluate(`window.__sl.start([{cond:'warm',arm:'B',cfg:${JSON.stringify(maxCfg)}}], 600, 0)`);
await page.waitForTimeout(8000);
await page.evaluate('window.__sl._run = false');
await page.evaluate(`window.__sl.start([{cond:'warm',arm:'A',cfg:${JSON.stringify(A_CFG)}}], 6000, 0)`);
log(`warming ${WARM / 1000}s ...`);
await page.waitForTimeout(WARM);
await page.evaluate('window.__sl._run = false');

/* ---------------------------------------------------------- the schedule */
// One superblock = ABBA over 4 slots for ONE condition. Superblocks are dealt
// round-robin over the conditions, reshuffled each cycle.
const schedule = [];
for (let cyc = 0; cyc < SUPER; cyc++) {
  for (const c of shuffled(CONDS, mulberry(SEED + cyc * 7919))) {
    const id = c.key + '#' + cyc;
    schedule.push({ cond: c.key, arm: 'A', block: id, cfg: A_CFG });
    schedule.push({ cond: c.key, arm: 'B', block: id, cfg: c.cfg });
    schedule.push({ cond: c.key, arm: 'B', block: id, cfg: c.cfg });
    schedule.push({ cond: c.key, arm: 'A', block: id, cfg: A_CFG });
  }
}
const started = await page.evaluate(`window.__sl.start(${JSON.stringify(schedule)}, ${SLOT}, ${DISCARD})`);
log(`schedule: ${started.slots} slots x ${SLOT} frames = ${started.frames} frames, ${CONDS.length} conditions x ${SUPER} superblocks`);

const samples = [];
const loadTrace = [];
let lastStatus = null;
const t0 = Date.now();
for (;;) {
  await page.waitForTimeout(5000);
  const st = await page.evaluate('window.__sl.status()');
  const batch = await page.evaluate('window.__sl.drain()');
  samples.push(...batch);
  loadTrace.push({ t: Math.round((Date.now() - t0) / 1000), load: +os.loadavg()[0].toFixed(2), i: st.i });
  lastStatus = st;
  if (st.i % (SLOT * CONDS.length * 4) < SLOT * CONDS.length) {
    log(`${Math.round((Date.now() - t0) / 1000)}s  slot ${Math.floor(st.i / SLOT)}/${started.slots}  frames ${st.i}  samples ${samples.length}  load ${os.loadavg()[0].toFixed(2)}`);
  }
  if (st.done) break;
  if (Date.now() - t0 > 60 * 60 * 1000) { log('TIMEOUT'); break; }
}
samples.push(...(await page.evaluate('window.__sl.drain()')));
const finalStatus = await page.evaluate('window.__sl.status()');
log('final status', JSON.stringify({ done: finalStatus.done, programs: finalStatus.programs, scale: finalStatus.scale, adaptive: finalStatus.adaptive, split: finalStatus.split, passSplit: finalStatus.passSplit, phase: finalStatus.phase, forcedPhase: finalStatus.forcedPhase }));
log('armed lists seen:', JSON.stringify(finalStatus.armedSeen));

/* ---------------------------------------------------------------- analyse */
const slotOf = new Map();
for (const s of schedule.keys()) slotOf.set(s, schedule[s]);

const report = { conditions: [] };
for (const c of CONDS) {
  const mine = samples.filter((s) => s.c === c.key);
  // group by superblock and arm, keeping contiguous slot runs for the pair series
  const byBlockRaw = {}, byBlockPair = {};
  const slotGroups = new Map();
  for (const s of mine) {
    const k = s.s;
    if (!slotGroups.has(k)) slotGroups.set(k, []);
    slotGroups.get(k).push(s);
  }
  for (const [slotIdx, arr] of slotGroups) {
    const e = schedule[slotIdx];
    if (!e) continue;
    const id = e.block, arm = e.arm;
    byBlockRaw[id] = byBlockRaw[id] || { A: [], B: [] };
    byBlockPair[id] = byBlockPair[id] || { A: [], B: [] };
    const d = arr.map((x) => x.d);
    byBlockRaw[id][arm].push(...d);
    byBlockPair[id][arm].push(...pairWithin([d]));
  }
  for (const id of Object.keys(byBlockRaw)) {
    if (byBlockRaw[id].A.length < 8 || byBlockRaw[id].B.length < 8) { delete byBlockRaw[id]; delete byBlockPair[id]; }
  }
  const allA = [], allB = [], dcA = [], dcB = [], triA = [], triB = [];
  for (const s of mine) {
    const e = schedule[s.s];
    if (!e) continue;
    (e.arm === 'A' ? allA : allB).push(s.d);
    (e.arm === 'A' ? dcA : dcB).push(s.dc);
    (e.arm === 'A' ? triA : triB).push(s.tri);
  }
  const pairA = [], pairB = [];
  for (const id of Object.keys(byBlockPair)) { pairA.push(...byBlockPair[id].A); pairB.push(...byBlockPair[id].B); }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  report.conditions.push({
    key: c.key, note: c.note,
    A: { raw: stat(allA), pair: stat(pairA) },
    B: { raw: stat(allB), pair: stat(pairB) },
    dDrawCalls: +(mean(dcB) - mean(dcA)).toFixed(1),
    dTriangles: Math.round(mean(triB) - mean(triA)),
    superblocks: Object.keys(byBlockRaw).length,
    boot: {
      pairP50: blockBoot(byBlockPair, 'p50'),
      pairP95: blockBoot(byBlockPair, 'p95'),
      pairOver: blockBoot(byBlockPair, 'over'),
      rawP95: blockBoot(byBlockRaw, 'p95'),
    },
  });
}
report.loadavg = { mean: +(loadTrace.reduce((s, x) => s + x.load, 0) / loadTrace.length).toFixed(2), min: Math.min(...loadTrace.map((x) => x.load)), max: Math.max(...loadTrace.map((x) => x.load)) };
report.samples = samples.length;
report.status = finalStatus;
report.setupOk = Object.keys(finalStatus.armedSeen).length <= CONDS.length + 1;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ info, params: { SLOT, DISCARD, SUPER, SEED, SET }, report, loadTrace }, null, 2));
writeFileSync(OUT.replace(/\.json$/, '-frames.json'), JSON.stringify(samples));

/* ------------------------------------------------------------------ print */
console.log('\n================= BASELINE (arm A of every condition, pooled) =================');
const baseA = [];
for (const c of report.conditions) if (c.A.pair) baseA.push(c);
{
  const all = samples.filter((s) => { const e = schedule[s.s]; return e && e.arm === 'A'; }).map((s) => s.d);
  const s = stat(all);
  if (s) console.log(`raw   n=${s.n}  p50 ${s.p50.toFixed(2)}  IQR ${s.p25.toFixed(2)}-${s.p75.toFixed(2)}  p95 ${s.p95.toFixed(2)}  >16.67 ${s.over.toFixed(1)}%`);
}
console.log(`loadavg mean ${report.loadavg.mean} (${report.loadavg.min}-${report.loadavg.max}) | samples ${report.samples}`);
console.log('\n================= INTERLEAVED DELTAS (B - A), pair series, ms =================');
console.log('condition        sb   Adraws  ddraws     dtris     A_p50   A_p95     dP50            dP95 [95% CI]');
for (const c of [...report.conditions].sort((x, y) => (x.boot.pairP95 ? x.boot.pairP95.point : 0) - (y.boot.pairP95 ? y.boot.pairP95.point : 0))) {
  const b = c.boot;
  if (!b.pairP95) { console.log(`${c.key.padEnd(15)} INSUFFICIENT`); continue; }
  console.log(`${c.key.padEnd(15)} ${String(c.superblocks).padStart(3)} ${String(Math.round(c.A.raw ? 0 : 0)).padStart(7)} `
    + `${String(c.dDrawCalls).padStart(7)} ${String(c.dTriangles).padStart(9)}  `
    + `${c.A.pair.p50.toFixed(2).padStart(7)} ${c.A.pair.p95.toFixed(2).padStart(7)}  `
    + `${b.pairP50.point.toFixed(2).padStart(6)} [${b.pairP50.lo.toFixed(2)}, ${b.pairP50.hi.toFixed(2)}]`.padEnd(26)
    + `  ${b.pairP95.point.toFixed(2).padStart(6)} [${b.pairP95.lo.toFixed(2)}, ${b.pairP95.hi.toFixed(2)}]`);
}
log('wrote', OUT);
await browser.close();
await server.close();
