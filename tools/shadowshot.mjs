/*
 * shadowshot -- one screenshot per shadow configuration, through the SHIPPED
 * code path, so a perf arm can be checked against what it actually draws.
 *
 * Exists because tools/shadowquality.mjs scored the hardware-PCF arm at RMSE
 * 66 on shadow pixels -- worse than deleting the shadows outright (28) -- and
 * returned bit-identical images for three different shadow radii. Numbers that
 * shape mean the arm is broken, not that the filter is bad, and the only way to
 * tell a broken arm from a bad filter is to look at the frame.
 *
 * Every switch here goes through setQuality(), which is the only entry point
 * that reads tier.pcss (see the hazard demo in tools/shadowgate.mjs: writing
 * rp.tier.pcss alone changes nothing at all). So this is the shipped path, not
 * the probe's runtime path, and the two can be compared.
 *
 *   node tools/shadowshot.mjs --out scratchpad/shot
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5281));
const OUT = resolve(ROOT, arg('out', 'scratchpad/shot'));
const PIN = Number(arg('pin', 150));

const server = await createServer({ root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });
await page.evaluate(`(() => { const KB = window.KB; KB.startMatch(0,1); KB.setPhase('fight'); if (KB.menus && KB.menus.show) KB.menus.show(null); KB.clock.getDelta = () => 1/60; })()`);
await page.waitForFunction(`window.KB.tick >= ${PIN}`, null, { timeout: 90000 });
await page.evaluate(`(() => {
  const KB = window.KB, cam = KB.camera;
  KB.paused = true;
  KB.clock.getDelta = () => 0;
  const pos = cam.position.clone(), quat = cam.quaternion.clone();
  KB.fightCamera.render = () => { cam.position.copy(pos); cam.quaternion.copy(quat); cam.updateMatrixWorld(true); };
  KB.fightCamera.simulate = () => {};
  KB.renderer.effects.adaptiveResolution = false;
  if (KB.renderer.setGrade) KB.renderer.setGrade({ grain: 0, chroma: 0 });
})()`);

const state = `(() => {
  const rp = window.KB.renderer, gl = rp.renderer.getContext();
  const progs = rp.renderer.info.programs || [];
  let pcf = 0, pcss = 0, none = 0;
  for (const p of progs) {
    let s = null; try { s = gl.getShaderSource(p.fragmentShader); } catch (e) { s = null; }
    if (!s || s.indexOf('#define USE_SHADOWMAP') < 0) { none++; continue; }
    if (s.indexOf('#define SHADOWMAP_TYPE_PCF') >= 0) pcf++; else pcss++;
  }
  const lights = [];
  (rp._lastScene || window.KB.scene).traverse((o) => {
    if (o.isLight && o.shadow && o.castShadow) lights.push((o.isDirectionalLight ? 'dir' : 'spot') + ':' + o.shadow.mapSize.x + ':r' + (+o.shadow.radius.toFixed(2)) + ':b' + o.shadow.bias + ':map' + (o.shadow.map ? 'yes' : 'NULL'));
  });
  return { tierPcss: rp.tier.pcss, pcssActive: !!rp._pcssActive, type: rp.renderer.shadowMap.type, enabled: rp.renderer.shadowMap.enabled, programs: progs.length, pcf, pcss, lights };
})()`;

mkdirSync(OUT, { recursive: true });
const shots = [
  ['a-shipped-pcss', `(() => { window.KB.renderer.tier.pcss = true; window.KB.renderer.setQuality('high'); })()`],
  ['b-pcss-false', `(() => { window.KB.renderer.tier.pcss = false; window.KB.renderer.setQuality('high'); })()`],
  ['c-back-to-pcss', `(() => { window.KB.renderer.tier.pcss = true; window.KB.renderer.setQuality('high'); })()`],
];
for (const [name, js] of shots) {
  await page.evaluate(js);
  await page.waitForTimeout(4000);
  const st = await page.evaluate(state);
  console.log(name.padEnd(18), JSON.stringify(st));
  writeFileSync(resolve(OUT, name + '.png'), await page.screenshot({ type: 'png' }));
}
console.log('wrote', OUT);
await browser.close();
await server.close();
