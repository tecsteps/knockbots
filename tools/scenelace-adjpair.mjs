/*
 * ADJACENT-SLOT paired estimator for a scenelace frames file.
 *
 * The block bootstrap in the tool pools a whole superblock (4 slots, ~2 s) per
 * resample. On a box at loadavg 20 the contention moves inside that window, so
 * this estimator pairs each B slot with the A slot that is physically NEAREST
 * to it in the schedule -- ~0.3 s away -- and reports the distribution of those
 * paired differences. One number per pair, so the CI is a plain bootstrap over
 * pairs and the within-slot correlation cannot leak into it.
 *
 * Statistic per slot: the 20% trimmed mean of its frame intervals. An additive
 * per-frame cost shifts it; a contention spike mostly does not.
 */
import { readFileSync } from 'node:fs';
const S = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const slots = new Map();
for (const s of S) {
  if (!slots.has(s.s)) slots.set(s.s, { s: s.s, c: s.c, a: s.a, d: [], dc: [], tri: [] });
  const e = slots.get(s.s);
  e.d.push(s.d); e.dc.push(s.dc); e.tri.push(s.tri);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const trim = (a, f) => { const s = [...a].sort((x, y) => x - y); const k = Math.floor(s.length * f); return s.slice(k, s.length - k); };
const med = (a) => { const s = [...a].sort((x, y) => x - y); const h = (s.length - 1) / 2; return (s[Math.floor(h)] + s[Math.ceil(h)]) / 2; };
function mul(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = t; r = Math.imul(r ^ (r >>> 15), r | 1); r ^= r + Math.imul(r ^ (r >>> 7), r | 61); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }

const list = [...slots.values()].sort((a, b) => a.s - b.s);
for (const e of list) { e.m = mean(trim(e.d, 0.2)); e.mdc = mean(e.dc); e.mtri = mean(e.tri); }

// pair every B slot with the nearest A slot of the SAME condition
const byCond = {};
for (let i = 0; i < list.length; i++) {
  const e = list[i];
  if (e.a !== 'B') continue;
  let best = null;
  for (let j = Math.max(0, i - 3); j <= Math.min(list.length - 1, i + 3); j++) {
    const o = list[j];
    if (o.a !== 'A' || o.c !== e.c) continue;
    const dist = Math.abs(o.s - e.s);
    if (!best || dist < best.dist) best = { o, dist };
  }
  if (!best) continue;
  (byCond[e.c] = byCond[e.c] || []).push({ d: e.m - best.o.m, ddc: e.mdc - best.o.mdc, dtri: e.mtri - best.o.mtri, dist: best.dist });
}

console.log('cond            pairs   ddraws     dtris    medianD    meanD  [95% CI on meanD]   frac<0');
for (const k of Object.keys(byCond)) {
  const P = byCond[k];
  const d = P.map((x) => x.d);
  const rnd = mul(3);
  const bs = [];
  for (let i = 0; i < 5000; i++) { let s = 0; for (let j = 0; j < d.length; j++) s += d[Math.floor(rnd() * d.length)]; bs.push(s / d.length); }
  bs.sort((a, b) => a - b);
  console.log(k.padEnd(15), String(d.length).padStart(5),
    mean(P.map((x) => x.ddc)).toFixed(1).padStart(8), Math.round(mean(P.map((x) => x.dtri))).toString().padStart(9),
    med(d).toFixed(2).padStart(10), mean(d).toFixed(2).padStart(8),
    `  [${bs[125].toFixed(2)}, ${bs[4874].toFixed(2)}]`.padEnd(20),
    (d.filter((v) => v < 0).length / d.length).toFixed(2).padStart(6));
}
const allA = list.filter((e) => e.a === 'A').flatMap((e) => e.d);
const p = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * q)]; };
console.log(`\narm A pooled: n=${allA.length} p50 ${p(allA, 0.5).toFixed(2)} p95 ${p(allA, 0.95).toFixed(2)} >16.67 ${(100 * allA.filter((v) => v > 16.67).length / allA.length).toFixed(1)}%`);
