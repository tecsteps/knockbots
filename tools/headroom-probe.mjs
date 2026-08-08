/*
 * Frame-time headroom probe for the 'high' tier at 1920x1080.
 *
 * Real Chromium, real GPU (ANGLE/Metal), a live two-AI fight, adaptive
 * resolution OFF, frame-rate limiter OFF so the browser reports the true cost
 * of a frame rather than a vsync-clamped 16.67.
 *
 * INSTRUMENT NOTES (both of these were tried and REJECTED, see the report):
 *   - EXT_disjoint_timer_query_webgl2 is exposed under ANGLE/Metal but reports
 *     ~2.7x the wall-clock frame time and fails a null control. Not used.
 *   - Frame-alternating ablation (toggle a pass on odd frames) perturbs the
 *     EffectComposer buffer-swap parity and costs more than the pass under
 *     test. Not used. Ablation is done as whole blocks instead.
 *
 * The surviving instrument is the rAF interval, 2-frame box averaged (the
 * browser delivers rAF in fast/slow pairs with the limiter off), cross-checked
 * against raw throughput = wall clock / frames. Those two agree to ~0.2 ms.
 *
 *   node tools/headroom-probe.mjs [--block 6000] [--reps 5] [--port 5231]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE_PROBE = process.env.KB_PAGE_PROBE || resolve(HERE, 'headroom-probe-page.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes('--' + n);
const PORT = Number(arg('port', 5231));
const BLOCK = Number(arg('block', 6000));
const DISCARD = Number(arg('discard', 1500));
const REPS = Number(arg('reps', 5));
const PHASES = arg('phases', '1234');
const OUT = arg('out', resolve(REPO, 'scratchpad/headroom.json'));

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * s.length)))]; };
const stat = (a) => (a.length ? {
  n: a.length,
  median: +q(a, 0.5).toFixed(3),
  p25: +q(a, 0.25).toFixed(3),
  p75: +q(a, 0.75).toFixed(3),
  p90: +q(a, 0.90).toFixed(3),
  p95: +q(a, 0.95).toFixed(3),
  p99: +q(a, 0.99).toFixed(3),
  max: +Math.max(...a).toFixed(3),
  mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3),
  over1667: +(100 * a.filter((v) => v > 16.67).length / a.length).toFixed(1),
} : null);
const pairAvg = (a) => a.slice(0, -1).map((v, i) => (v + a[i + 1]) / 2);

const log = (...a) => console.log('[headroom]', ...a);

const server = await createServer({
  root: REPO,
  server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  logLevel: 'error',
});
await server.listen();
const url = `http://127.0.0.1:${PORT}/`;

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

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 60000 });
await page.waitForTimeout(4000);

await page.evaluate(readFileSync(PAGE_PROBE, 'utf8'));
const info = await page.evaluate('window.__kbProbe.setup(8)');
const gpuName = await page.evaluate(`(() => {
  const gl = window.KB.renderer.renderer.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
})()`);
log('probe', JSON.stringify({ ...info, gpu: gpuName }));

await page.evaluate('window.__kbProbe.setScale(0.85)');
await page.waitForTimeout(10000);      // shader compiles, arena settle, AI engaged

const results = [];
const t0 = Date.now();
let curScale = 0.85;

async function block(label, scale, opts = {}) {
  if (opts.pre) await page.evaluate(opts.pre);
  let px = null;
  if (scale !== curScale) {
    px = await page.evaluate(`window.__kbProbe.setScale(${scale})`);
    curScale = scale;
    await page.waitForTimeout(600);
  } else {
    px = await page.evaluate('window.__kbProbe.state()');
  }
  const load0 = os.loadavg()[0];
  const r = await page.evaluate(`window.__kbProbe.sample(${opts.ms || BLOCK}, ${DISCARD})`);
  const row = {
    label, scale, px: px.pixels, t: Math.round((Date.now() - t0) / 1000),
    wall: +r.wall.toFixed(0), frameCount: r.frameCount,
    throughputMs: +(r.wall / Math.max(1, r.frameCount)).toFixed(3),
    raf: stat(r.dts), rafPair: stat(pairAvg(r.dts)),
    cpu: stat(r.frames.map((f) => f.c)),
    load: [load0, os.loadavg()[0]],
    state: r.state,
  };
  results.push(row);
  const p = row.rafPair;
  log(`${label.padEnd(20)} ${String(px.pixels).padEnd(10)} t=${String(row.t).padStart(3)}s `
    + `thru ${row.throughputMs.toFixed(2)} | med ${p.median.toFixed(2)} IQR[${p.p25.toFixed(2)},${p.p75.toFixed(2)}] `
    + `p95 ${p.p95.toFixed(2)} p99 ${p.p99.toFixed(2)} | cpu ${row.cpu.median.toFixed(2)} `
    + `| dc ${row.state.drawCalls} | load ${row.load[1].toFixed(1)} | n=${row.raf.n}`);
  return row;
}

/* ---- Phase 1: interleaved scale sweep, with controls -------------------- */
if (PHASES.includes('1')) {
  for (let i = 0; i < REPS; i++) {
    await block(`s085.r${i}`, 0.85);
    await block(`s100.r${i}`, 1.00);
  }
  await block('s070.pos-ctrl', 0.70);   // positive control: MUST be faster
  await block('s085.null-ctrl', 0.85);  // null control: MUST match s085.r*
  await block('s090.mid', 0.90);
  await block('s085.null2', 0.85);
}

/* ---- Phase 2: per-pass cost by whole-block ablation --------------------- */
if (PHASES.includes('2')) {
  const chain = await page.evaluate('window.__kbProbe.passList()');
  log('chain', JSON.stringify(chain.map((c) => c.name + ':' + c.ctor)));
  const list = ['ao', 'bloom', 'dof', 'motionBlur', 'smaa', 'grade'];
  for (let rep = 0; rep < 2; rep++) {
    await block(`abl.base.${rep}`, 0.85, { pre: 'window.__kbProbe.allOn()' });
    for (const name of list) {
      await block(`abl.no-${name}.${rep}`, 0.85, { pre: `window.__kbProbe.allOn(); window.__kbProbe.setPass('${name}', false)` });
      await block(`abl.base-${name}.${rep}`, 0.85, { pre: 'window.__kbProbe.allOn()' });
    }
  }
}

/* ---- Phase 3: temporal-accumulation stand-in, whole blocks -------------- */
if (PHASES.includes('3')) {
  const variants = [
    ['resolve-only', 0, false],
    ['clamp9', 1, false],
    ['clamp9+store', 1, true],
  ];
  for (const scale of [0.85, 1.00]) {
    for (let rep = 0; rep < 2; rep++) {
      await block(`taa.base.${scale}.${rep}`, scale, { pre: 'window.__kbProbe.removeStub()' });
      for (const [name, mode, store] of variants) {
        await block(`taa.${name}.${scale}.${rep}`, scale,
          { pre: `window.__kbProbe.removeStub(); window.__kbProbe.addStub(${mode}, ${store})` });
        await block(`taa.base-${name}.${scale}.${rep}`, scale, { pre: 'window.__kbProbe.removeStub()' });
      }
    }
  }
  await page.evaluate('window.__kbProbe.removeStub()');
}

/* ---- Phase 4: drift check ---------------------------------------------- */
if (PHASES.includes('4')) {
  await page.evaluate('window.__kbProbe.allOn(); window.__kbProbe.removeStub()');
  await block('s085.end', 0.85);
  await block('s100.end', 1.00);
  await block('s085.end2', 0.85);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ info: { ...info, gpu: gpuName }, results }, null, 2));
log('wrote', OUT);

await browser.close();
await server.close();
