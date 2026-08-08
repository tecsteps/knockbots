/*
 * Re-analyses a tools/shadowgate.mjs run from its saved per-block frame series.
 *
 * WHY IT EXISTS, and both reasons are corrections to how the run itself
 * reported:
 *
 * 1. THE QUAD RULE. The in-run estimator needs 2 clean A blocks and 2 clean B
 *    blocks. Under contention the first B block of a recompiling arm is often
 *    voided (the compile landed after the settle), which throws away a quad
 *    whose other three blocks are clean. The obvious relaxation -- accept any
 *    quad with at least one clean block per arm -- IS WRONG AND WAS TRIED: it
 *    admits quads that kept both Bs but lost A2, and a quad missing one end of
 *    its ABBA no longer cancels drift. On this data that produced a +22.5 ms
 *    "cost" for an arm whose four blocks were simply drifting upward in a
 *    straight line. The rule used here is therefore: BOTH A blocks clean (so
 *    the B blocks are still bracketed) plus at least one clean B.
 *
 * 2. THE ESTIMATOR IS A RATIO. This session's baseline sits near 45 ms rather
 *    than the ~15 ms of an idle machine, because three sibling agents were
 *    running their own headless-Chromium perf rigs throughout and the GPU was
 *    time-sliced between four Chromium instances. Under time-slicing an
 *    absolute millisecond delta is inflated by roughly the reciprocal of this
 *    process's share, and it is NOT transferable to an idle machine. A ratio
 *    is the part of the result with a chance of transferring. Both are printed;
 *    the ratio is the one to quote.
 *
 *   node tools/shadowgate-reanalyse.mjs scratchpad/shadowgate.json
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = process.argv[2] || 'scratchpad/shadowgate.json';
const main = JSON.parse(readFileSync(resolve(src), 'utf8'));
const frames = JSON.parse(readFileSync(resolve(src.replace(/\.json$/, '-frames.json')), 'utf8'));

const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  const h = (s.length - 1) * p, l = Math.floor(h), i = Math.ceil(h);
  return s[l] + (h - l) * (s[i] - s[l]);
};
const pair = (a) => a.slice(0, -1).map((v, i) => (v + a[i + 1]) / 2);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const over = (a) => (100 * a.filter((v) => v > 16.67).length) / a.length;
function mul(s) { let t = s >>> 0; return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function boot(d, seed) {
  if (d.length < 2) return [NaN, NaN];
  const r = mul(seed), o = [];
  for (let i = 0; i < 8000; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(r() * d.length)]; o.push(s / d.length); }
  o.sort((a, b) => a - b);
  return [q(o, 0.025), q(o, 0.975)];
}

const MIN = Number(process.argv[3] || 40);
for (const b of frames) {
  if (!b.ok || !b.ivals || b.ivals.length < MIN) continue;
  const p = pair(b.ivals);
  b.m = { p50: q(p, 0.5), p95: q(p, 0.95), over: over(p), fps: 1000 / mean(b.ivals) };
}

const conds = [...new Set(frames.map((x) => x.cond))];
const rounds = [...new Set(frames.map((x) => x.round))];
const clean = frames.filter((x) => x.m);
const allA = clean.filter((x) => x.arm === 'A');
const pooled = pair(allA.flatMap((x) => x.ivals));

console.log(`source ${src}   blocks ${frames.length}, usable ${clean.length}`);
console.log(`BASELINE, ${allA.length} full-chain A blocks pooled: pair p50 ${q(pooled, 0.5).toFixed(2)}  p95 ${q(pooled, 0.95).toFixed(2)}  >16.67 ${over(pooled).toFixed(1)}%`);
console.log(`loadavg mean ${mean(clean.map((x) => x.load[1])).toFixed(2)} min ${Math.min(...clean.map((x) => x.load[1]))} max ${Math.max(...clean.map((x) => x.load[1]))}`);

const rows = [];
for (const c of conds) {
  const D = { p50: [], p95: [], r95: [], r50: [], rfps: [], over: [] };
  for (const r of rounds) {
    const a1 = frames.find((x) => x.cond === c && x.round === r && x.slot === 0 && x.m);
    const a2 = frames.find((x) => x.cond === c && x.round === r && x.slot === 3 && x.m);
    const bs = frames.filter((x) => x.cond === c && x.round === r && (x.slot === 1 || x.slot === 2) && x.m);
    if (!a1 || !a2 || !bs.length) continue;
    const A = { p50: (a1.m.p50 + a2.m.p50) / 2, p95: (a1.m.p95 + a2.m.p95) / 2, over: (a1.m.over + a2.m.over) / 2, fps: (a1.m.fps + a2.m.fps) / 2 };
    const B = { p50: mean(bs.map((x) => x.m.p50)), p95: mean(bs.map((x) => x.m.p95)), over: mean(bs.map((x) => x.m.over)), fps: mean(bs.map((x) => x.m.fps)) };
    D.p50.push(B.p50 - A.p50); D.p95.push(B.p95 - A.p95); D.over.push(B.over - A.over);
    D.r95.push(B.p95 / A.p95); D.r50.push(B.p50 / A.p50); D.rfps.push(B.fps / A.fps);
  }
  if (!D.p95.length) { rows.push({ c, n: 0 }); continue; }
  rows.push({
    c, n: D.p95.length, dp50: mean(D.p50), dp95: mean(D.p95),
    r95: mean(D.r95), ci95: boot(D.r95, 9), r50: mean(D.r50), ci50: boot(D.r50, 11),
    rfps: mean(D.rfps), cifps: boot(D.rfps, 13), dover: mean(D.over),
    neg: D.p95.filter((v) => v < 0).length, per: D.r95.map((v) => +v.toFixed(2)),
  });
}
rows.sort((a, b) => (a.r95 ?? 9) - (b.r95 ?? 9));

console.log('\nSTRICT ABBA (both A blocks clean + >=1 B). B/A: BELOW 1 MEANS THE ARM IS FASTER.');
console.log('condition        n     dP50     dP95   p95 ratio [95% CI]      p50 ratio [95% CI]      fps ratio [95% CI]     faster  per-quad p95 ratio');
for (const r of rows) {
  if (!r.n) { console.log(`${r.c.padEnd(15)} no quad had both A blocks clean`); continue; }
  console.log(`${r.c.padEnd(15)}${String(r.n).padStart(3)}${r.dp50.toFixed(2).padStart(9)}${r.dp95.toFixed(2).padStart(9)}   `
    + `${r.r95.toFixed(3)} [${r.ci95[0].toFixed(3)}, ${r.ci95[1].toFixed(3)}]`.padEnd(24)
    + `${r.r50.toFixed(3)} [${r.ci50[0].toFixed(3)}, ${r.ci50[1].toFixed(3)}]`.padEnd(24)
    + `${r.rfps.toFixed(3)} [${r.cifps[0].toFixed(3)}, ${r.cifps[1].toFixed(3)}]`.padEnd(23)
    + `${r.neg}/${r.n}`.padStart(6) + `  [${r.per.join(', ')}]`);
}

const nf = [];
for (const f of clean.filter((x) => x.slot === 0)) {
  const a2 = frames.find((x) => x.cond === f.cond && x.round === f.round && x.slot === 3 && x.m);
  if (a2) nf.push(a2.m.p95 / f.m.p95);
}
if (nf.length) {
  const dev = nf.map((v) => Math.abs(v - 1));
  console.log(`\nNOISE FLOOR, ${nf.length} A1-vs-A2 pairs on an UNCHANGED config: |p95 ratio - 1| med ${(q(dev, 0.5) * 100).toFixed(1)}%  p90 ${(q(dev, 0.9) * 100).toFixed(1)}%   slot bias mean ${((mean(nf) - 1) * 100).toFixed(1)}%`);
}
const vr = {};
for (const v of main.report.voidReasons) { const k = v.voids[0].split(' ').slice(0, 2).join(' '); vr[k] = (vr[k] || 0) + 1; }
console.log(`voids: ${JSON.stringify(vr)}`);
