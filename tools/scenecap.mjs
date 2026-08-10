/**
 * Knockbots — roster-wide scene capture, for judging the CAST.
 *
 * `capture.mjs` is the shot list the charter is scored on: twenty-odd named
 * frames, one fighter pair, taken through `page.screenshot()` so the browser
 * composites exactly what a player would see. It is the right instrument for
 * "does the game look right" and the wrong one for "does every fighter look
 * right", for two reasons.
 *
 *   1. It photographs VULKAN and KESTREL. The other eight are never in frame,
 *      so a change that fixes two fighters and breaks eight scores clean.
 *   2. `page.screenshot()` goes through the compositor. On a GPU that costs
 *      milliseconds; on a software rasteriser it costs half a minute a frame,
 *      which puts a full-cast pass out of reach of any iteration loop.
 *
 * So this tool walks the whole roster in one boot, drives each pair into a real
 * fight — the actual game scene, in the actual arena, under the actual lights,
 * never a model viewer — and reads the frame back through
 * `RenderPipeline.screenshot()`, which renders and reads in one task and never
 * touches the compositor. That is roughly an order of magnitude faster per
 * frame and it is the same pixels: the read happens after the post chain.
 *
 *   node tools/scenecap.mjs                       # all five pairs
 *   node tools/scenecap.mjs --pairs 0,1           # a subset
 *   node tools/scenecap.mjs --out shots/round-N
 *   node tools/scenecap.mjs --width 1600 --height 900
 *
 * Env: KB_CHROMIUM pins the browser binary, KB_ANGLE the GL backend — same
 * overrides capture.mjs takes, for the same reason.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT = resolve(ROOT, arg('out', 'shots/roster'));
const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 900));
const PORT = Number(arg('port', 5207));
const ONLY = arg('pairs', '').split(',').filter(Boolean).map(Number);

/**
 * Which fighters share a screen.
 *
 * Adjacent roster indices on purpose: the select screen orders the cast so
 * neighbours are the ones most likely to be confused for each other, and a
 * silhouette failure is only visible when the two fighters that share it are
 * in the same frame.
 */
const PAIRS = [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` in the page until it returns truthy, or give up and say so. */
async function until(page, expr, ms = 120000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}

/**
 * Render one frame and write it.
 *
 * The read goes through the pipeline's own `screenshot()` rather than through
 * Playwright so that it is the post-processed frame, not the compositor's idea
 * of one, and so that it costs a render rather than a round trip.
 */
async function grab(page, file) {
  const url = await page.evaluate(() => window.KB.renderer.screenshot());
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return url.length;
}

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const server = await createServer({
    root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error',
  });
  await server.listen();

  const browser = await chromium.launch({
    ...(process.env.KB_CHROMIUM ? { executablePath: process.env.KB_CHROMIUM } : {}),
    args: [`--use-angle=${process.env.KB_ANGLE || 'metal'}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(Number(process.env.KB_TIMEOUT || 120000));

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  const booted = await until(page, '!!(window.KB && window.KB.fighters && window.KB.renderer)', 240000, 2000);
  if (!booted) {
    writeFileSync(resolve(OUT, 'BOOT-FAILURE.txt'), errors.join('\n') || 'no error text');
    throw new Error('game did not boot');
  }

  const roster = await page.evaluate(() => window.KB.fighters.map((f) => f.def.id));
  console.log('[scenecap] booted; live pair', roster.join(' vs '));

  const manifest = { complete: false, width: WIDTH, height: HEIGHT, frames: [] };
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (let pi = 0; pi < PAIRS.length; pi++) {
    if (ONLY.length && !ONLY.includes(pi)) continue;
    const [a, b] = PAIRS[pi];

    const ids = await page.evaluate(([p1, p2]) => {
      window.KB.startMatch(p1, p2);
      return window.KB.fighters.map((f) => f.def.id);
    }, [a, b]);

    // Skip the intro/READY/FIGHT ladder outright. Those phases replay an
    // announcement banner across the middle of the frame, and a shot of a
    // fighter with FIGHT written over its chest is not a shot of the fighter.
    await page.evaluate(() => {
      window.KB.debug.freecam = false;
      window.KB.setPhase('fight');
    });
    await until(page, `(() => {
      const el = document.querySelector('.announce-layer');
      const vis = el && getComputedStyle(el).opacity > 0.02 && el.textContent.trim();
      return !window.KB.hud?.announceBusy && !vis;
    })()`, 60000, 1000);
    await sleep(1500);

    console.log(`[scenecap] pair ${pi}: ${ids.join(' vs ')}`);

    // The fight framing first: the only shot taken with the camera the player
    // actually has, and where a silhouette collision between the two shows up.
    //
    // Walk them to striking range before grabbing it. A round starts with the
    // pair three and a half metres apart and the tracking rig frames the PAIR,
    // so the default is a wide shot of an empty floor with two fighters on its
    // edges -- both under a tenth of frame height, which is not a frame anyone
    // can judge a character in.
    await page.evaluate(() => {
      const KB = window.KB;
      const [a, b] = KB.fighters;
      const mid = (a.position.x + b.position.x) * 0.5;
      const s = Math.sign(a.position.x - b.position.x) || 1;
      a.position.x = mid + s * 1.05;
      b.position.x = mid - s * 1.05;
    });
    await sleep(1600);
    let f = resolve(OUT, `pair${pi}-${ids[0]}-vs-${ids[1]}-fight.png`);
    await grab(page, f); manifest.frames.push({ file: f, kind: 'fight', ids });

    for (let s = 0; s < 2; s++) {
      // Portrait and closeup are the rig's OWN framings and they are used with
      // their own distance solving. Passing an explicit `dist` overrides the
      // fit, which is how the first run of this tool photographed a fighter at
      // a third of frame height; and passing a negative `yaw` for the
      // right-hand fighter swung the lens round behind it, because yaw is
      // already measured off that fighter's facing.
      await page.evaluate((side) => {
        window.KB.fightCamera.cinematic('portrait', { target: window.KB.fighters[side] });
        const hud = document.getElementById('ui');
        if (hud) hud.style.visibility = 'hidden';
      }, s);
      // Wait for the spring to arrive rather than guessing: it starts wherever
      // the last shot left it and can have metres to travel.
      await until(page, `(() => {
        const KB = window.KB, THREE = KB.THREE, f = KB.fighters[${s}], cam = KB.camera;
        const box = new THREE.Box3().setFromObject(f.robot.group);
        const c = box.getCenter(new THREE.Vector3());
        const top = new THREE.Vector3(c.x, box.max.y, c.z).project(cam);
        const bot = new THREE.Vector3(c.x, box.min.y, c.z).project(cam);
        return Math.abs(top.y - bot.y) / 2 > 0.55;
      })()`, 30000, 600);
      await sleep(900);
      f = resolve(OUT, `pair${pi}-${ids[s]}-body.png`);
      await grab(page, f); manifest.frames.push({ file: f, kind: 'body', id: ids[s] });

      // Head and chest: where surfacing, panel scale, visor and the neck gap
      // are actually legible. The rig solves the lens so the head fills frame
      // and keeps the depth-of-field plane on it, which hand-parking the camera
      // did not -- the first run's closeups were focused past the subject.
      await page.evaluate((side) => {
        window.KB.fightCamera.cinematic('closeup', { target: window.KB.fighters[side], bone: 'head' });
      }, s);
      await sleep(2200);
      f = resolve(OUT, `pair${pi}-${ids[s]}-head.png`);
      await grab(page, f); manifest.frames.push({ file: f, kind: 'head', id: ids[s] });
    }

    await page.evaluate(() => {
      window.KB.fightCamera.cinematic('fight');
      const hud = document.getElementById('ui');
      if (hud) hud.style.visibility = '';
    });
  }

  manifest.complete = true;
  manifest.errors = errors.slice(0, 40);
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[scenecap] wrote ${manifest.frames.length} frames to ${OUT}`);
  if (errors.length) console.log(`[scenecap] ${errors.length} page error(s):\n  ${errors.slice(0, 8).join('\n  ')}`);

  await browser.close();
  await server.close();
};

main().catch((e) => { console.error(e); process.exit(1); });
