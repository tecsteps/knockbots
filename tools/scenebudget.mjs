/*
 * scenebudget -- what the 316 scene draw calls actually ARE.
 *
 * Diagnostic only; it changes nothing and measures no delta. It captures every
 * draw the frame issues, tagged with the renderer.render invocation that issued
 * it, on a live fight at 1920x1080 / high / adaptive off, and prints:
 *
 *   - draws and triangles per stage (shadow maps, depth prepass, planar
 *     mirror, arena beauty half, fighter beauty half)
 *   - the top objects by draw count and by triangles inside each stage
 *   - a scene-graph census: screen radius and frustum membership of every
 *     renderable at the live fight framing, which is what says whether there is
 *     any culling left to take
 *
 *   node tools/scenebudget.mjs [--frames 12]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'scenebudget-page.js');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5243));
const FRAMES = Number(arg('frames', 12));
const OUT = arg('out', resolve(REPO, 'scratchpad/scenebudget.json'));

const log = (...a) => console.log('[scenebudget]', ...a);

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
const info = await page.evaluate('window.__sb.setup({ level: 7 })');
log('setup', JSON.stringify(info));
await page.waitForTimeout(20000);

const cap = await page.evaluate(`window.__sb.capture(${FRAMES})`);
const census = await page.evaluate('window.__sb.census()');
log(`captured ${cap.frames} frames, ${cap.rows.length} draws`);

/* ------------------------------------------------------------- aggregate */

const F = cap.frames;
const per = (v) => +(v / F).toFixed(1);

// stage totals (only depth-1 rows plus shadow rows are non-overlapping; nested
// mirror draws are INSIDE their parent, so report both and say so)
const byStage = new Map();
for (const r of cap.stages) {
  const k = r.stage;
  if (!byStage.has(k)) byStage.set(k, { stage: k, depth: r.depth, calls: 0, tri: 0, n: 0 });
  const e = byStage.get(k); e.calls += r.calls; e.tri += r.tri; e.n++;
}
console.log('\n=========== renderer.render / shadowMap.render STAGES (per frame) ===========');
console.log('stage                                   depth   calls    triangles');
for (const e of [...byStage.values()].sort((a, b) => b.calls - a.calls)) {
  console.log(`${e.stage.padEnd(40)} ${String(e.depth).padStart(4)} ${String(per(e.calls)).padStart(7)} ${String(Math.round(e.tri / F)).padStart(12)}`);
}

// draw-level attribution
const drawByStage = new Map();
for (const r of cap.rows) {
  if (!drawByStage.has(r.stage)) drawByStage.set(r.stage, []);
  drawByStage.get(r.stage).push(r);
}
console.log('\n=========== DRAWS BY STAGE (renderBufferDirect, per frame) ===========');
let totalCalls = 0, totalTri = 0;
const stageSummary = [];
for (const [k, rows] of [...drawByStage.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const tri = rows.reduce((s, r) => s + r.tri, 0);
  totalCalls += rows.length; totalTri += tri;
  stageSummary.push({ stage: k, calls: per(rows.length), tri: Math.round(tri / F) });
  console.log(`${k.padEnd(40)} ${String(per(rows.length)).padStart(7)} draws ${String(Math.round(tri / F)).padStart(10)} tris`);
}
console.log(`${'TOTAL'.padEnd(40)} ${String(per(totalCalls)).padStart(7)} draws ${String(Math.round(totalTri / F)).padStart(10)} tris`);

// per-object inside each stage
console.log('\n=========== TOP OBJECTS PER STAGE ===========');
const objDump = {};
for (const [k, rows] of [...drawByStage.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const m = new Map();
  for (const r of rows) {
    const key = (r.name || r.type) + ' [' + r.mat + ']';
    if (!m.has(key)) m.set(key, { key, n: 0, tri: 0, inst: r.inst, uuids: new Set() });
    const e = m.get(key); e.n++; e.tri += r.tri; e.uuids.add(r.uuid);
  }
  const list = [...m.values()].sort((a, b) => b.n - a.n || b.tri - a.tri);
  objDump[k] = list.map((e) => ({ key: e.key, drawsPerFrame: per(e.n), triPerFrame: Math.round(e.tri / F), objects: e.uuids.size, inst: e.inst }));
  console.log(`\n--- ${k}  (${per(rows.length)} draws/frame)`);
  for (const e of list.slice(0, 24)) {
    console.log(`   ${String(per(e.n)).padStart(6)} draws ${String(Math.round(e.tri / F)).padStart(9)} tris  x${String(e.uuids.size).padStart(3)} obj  ${e.key.slice(0, 72)}`);
  }
  if (list.length > 24) console.log(`   ... ${list.length - 24} more kinds`);
}

/* ---------------------------------------------------------------- census */

const objs = census.objects;
const live = objs.filter((o) => o.visible && o.vparent);
console.log('\n=========== SCENE CENSUS (live camera) ===========');
console.log(`renderables in graph: ${objs.length}, visible (incl. parents): ${live.length}`);
console.log(`in camera frustum: ${live.filter((o) => o.inFrustum).length}, OUT of frustum: ${live.filter((o) => o.inFrustum === false).length}`);
console.log(`frustumCulled=false: ${live.filter((o) => !o.frustumCulled).length}`);
console.log(`instanced: ${live.filter((o) => o.instanced).length}, multi-material groups>1: ${live.filter((o) => o.groups > 1).length}`);
const triAll = live.reduce((s, o) => s + o.tri, 0);
console.log(`triangles in visible graph: ${Math.round(triAll)}`);
const big = [...live].sort((a, b) => b.tri - a.tri).slice(0, 20);
console.log('\ntop 20 by triangles:');
console.log('   tris    screenR  inFrus  grp inst  path');
for (const o of big) {
  console.log(`${String(Math.round(o.tri)).padStart(8)} ${(o.screenR === null ? '-' : o.screenR.toFixed(2)).padStart(9)} ${String(o.inFrustum).padStart(6)} ${String(o.groups).padStart(4)} ${String(o.count).padStart(4)}  ${o.path.slice(0, 70)}`);
}
const outF = live.filter((o) => o.inFrustum === false).sort((a, b) => b.tri - a.tri);
console.log(`\nOUT-of-frustum visible renderables (${outF.length}), top 20 by triangles:`);
for (const o of outF.slice(0, 20)) {
  console.log(`${String(Math.round(o.tri)).padStart(8)} ${(o.screenR === null ? '-' : o.screenR.toFixed(2)).padStart(9)} grp${String(o.groups).padStart(3)}  ${o.path.slice(0, 70)}`);
}
const tiny = live.filter((o) => o.inFrustum && o.screenR !== null && o.screenR < 0.02).sort((a, b) => b.tri - a.tri);
console.log(`\nIN-frustum but screen radius < 2% of half-height (${tiny.length}), top 15:`);
for (const o of tiny.slice(0, 15)) {
  console.log(`${String(Math.round(o.tri)).padStart(8)} ${o.screenR.toFixed(4).padStart(9)}  ${o.path.slice(0, 70)}`);
}
console.log('\nlights:');
for (const l of census.lights) console.log(`   ${l.type.padEnd(20)} vis=${String(l.visible).padEnd(5)} shadow=${String(l.castShadow).padEnd(5)} map=${l.mapSize} layers=0x${l.layers.toString(16)} ${l.name}`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ info, frames: F, stageSummary, objDump, census }, null, 2));
log('wrote', OUT);

await browser.close();
await server.close();
