/*
 * Post-hoc re-analysis of a tools/tapbudget.mjs frames file.
 *
 * Exists for one reason. The session this was written for ran at loadavg 9-17
 * because sibling agents were hammering the machine, and at a 45 ms median the
 * p95 of a 1.3 s block is dominated by scheduler contention -- which is CPU, and
 * additive on top of, not proportional to, the GPU cost of a tap loop. A
 * constant GPU cost shifts the WHOLE distribution, including the frames that got
 * a clean slice, so the LOW percentiles are far more sensitive to it than p95 is
 * under contention.
 *
 * So this reports the quad-paired delta at p05 / p10 / p25 / p50 / p95 together.
 * p95 remains the verdict -- it is the project's constraint -- but if a change is
 * invisible at p05 as well, it is not hiding behind the noise, it is absent.
 *
 *   node tools/tapbudget-analyse.mjs scratchpad/tapbudget-frames.json
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = resolve(process.cwd(), process.argv[2] || 'scratchpad/tapbudget-frames.json');
const rows = JSON.parse(readFileSync(FILE, 'utf8'));

const pct = (s, p) => {
  if (!s.length) return NaN;
  const h = (s.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
};
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const pairSeries = (a) => a.slice(0, -1).map((v, i) => (v + a[i + 1]) / 2);

function mulberry(seed) {
  let t = seed >>> 0;
  return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function boot(d, seed) {
  if (d.length < 2) return null;
  const rnd = mulberry(seed), out = [];
  for (let b = 0; b < 4000; b++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rnd() * d.length)];
    out.push(s / d.length);
  }
  out.sort((a, b) => a - b);
  return { est: mean(d), lo: pct(out, 0.025), hi: pct(out, 0.975), n: d.length };
}

// A block's metric vector. Pair-smoothed intervals throughout, which is the
// statistic tapbudget/passbudget report; raw p95 is dominated by single stalls.
const Q = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95];
const QN = ['p05', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95'];
function metrics(ivals) {
  const s = pairSeries(ivals).sort((a, b) => a - b);
  const m = {};
  Q.forEach((q, i) => { m[QN[i]] = pct(s, q); });
  m.mean = mean(s);
  m.over = 100 * s.filter((v) => v > 16.67).length / s.length;
  return m;
}

const good = rows.filter((r) => r.ok && r.ivals.length >= 20);
const conds = [...new Set(good.map((r) => r.cond))];
const byQuad = {};
for (const r of good) (byQuad[r.cond + '#' + r.round] ||= []).push(r);

console.log(`blocks ${rows.length}, usable ${good.length}, loadavg mean ${mean(rows.map((r) => r.load[1])).toFixed(2)}`
  + ` (${Math.min(...rows.map((r) => r.load[1])).toFixed(1)}-${Math.max(...rows.map((r) => r.load[1])).toFixed(1)})`);

// NOISE FLOOR: A1 vs A2, unchanged configuration, same quad.
const nf = {};
for (const k of [...QN, 'mean']) nf[k] = [];
for (const q of Object.values(byQuad)) {
  const a1 = q.find((r) => r.slot === 0), a2 = q.find((r) => r.slot === 3);
  if (!a1 || !a2) continue;
  const m1 = metrics(a1.ivals), m2 = metrics(a2.ivals);
  for (const k of [...QN, 'mean']) nf[k].push(m2[k] - m1[k]);
}
console.log(`\nNOISE FLOOR, ${nf.p95.length} A1-vs-A2 pairs on an UNCHANGED configuration (this is what "no effect" looks like):`);
console.log('  stat   |med delta|   p90 |delta|   mean delta (slot bias)');
for (const k of [...QN, 'mean']) {
  const abs = nf[k].map(Math.abs).sort((a, b) => a - b);
  console.log(`  ${k.padEnd(6)} ${pct(abs, 0.5).toFixed(2).padStart(9)} ${pct(abs, 0.9).toFixed(2).padStart(11)} ${mean(nf[k]).toFixed(2).padStart(15)}`);
}

console.log('\nQUAD-PAIRED DELTA (B - A), ms, bootstrap 95% CI over quads. Negative = the condition is FASTER.');
for (const cond of conds) {
  if (cond === undefined) continue;
  const quads = Object.entries(byQuad).filter(([k]) => k.startsWith(cond + '#'))
    .map(([, q]) => q).filter((q) => q.filter((r) => r.arm === 'A').length === 2 && q.filter((r) => r.arm === 'B').length === 2);
  if (quads.length < 2) { console.log(`\n${cond}: only ${quads.length} complete quads`); continue; }
  const d = {};
  for (const k of [...QN, 'mean', 'over']) d[k] = [];
  for (const q of quads) {
    const A = q.filter((r) => r.arm === 'A').map((r) => metrics(r.ivals));
    const B = q.filter((r) => r.arm === 'B').map((r) => metrics(r.ivals));
    for (const k of [...QN, 'mean', 'over']) d[k].push(mean(B.map((m) => m[k])) - mean(A.map((m) => m[k])));
  }
  const loadA = mean(quads.flatMap((q) => q.filter((r) => r.arm === 'A').map((r) => r.load[1])));
  console.log(`\n${cond}  (${quads.length} quads, loadavg ${loadA.toFixed(1)})`);
  console.log('  stat     delta      95% CI            quads faster');
  for (const k of [...QN, 'mean', 'over']) {
    const b = boot(d[k], 7 + k.length);
    const faster = d[k].filter((v) => v < 0).length;
    console.log(`  ${k.padEnd(6)} ${b.est.toFixed(2).padStart(8)}   [${b.lo.toFixed(2).padStart(6)}, ${b.hi.toFixed(2).padStart(6)}]   ${faster}/${quads.length}`);
  }
}
