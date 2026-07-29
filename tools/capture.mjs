/**
 * Knockbots — headless visual capture harness.
 *
 * Boots the built game in Chromium with a real GPU backend (ANGLE/Metal on
 * macOS), drives it into scripted poses via `window.KB`, and writes PNGs to
 * shots/. The visual-critic agents read those PNGs.
 *
 *   node tools/capture.mjs                      # default shot list
 *   node tools/capture.mjs --shots idle,combo   # subset
 *   node tools/capture.mjs --out shots/round3   # destination
 *   node tools/capture.mjs --width 1920 --height 1080
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT = resolve(ROOT, arg('out', 'shots'));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const ONLY = arg('shots', '').split(',').filter(Boolean);
const KEEP = argv.includes('--keep');

/**
 * A shot is a named camera/pose setup evaluated in the page. Each `setup` runs
 * inside the browser with `KB` (the Game) in scope, then we wait `settle` ms and
 * grab the canvas.
 */
const SHOTS = [
  {
    name: '01-hero-idle',
    note: 'Default fight framing, both fighters idle. The baseline look.',
    setup: `KB.debug.freecam=false; KB.setPhase('fight');`,
    settle: 1600,
  },
  {
    name: '02-closeup-face',
    note: 'Head/chest closeup — material, panel, and emissive detail.',
    setup: `KB.fightCamera.cinematic('closeup', { target: KB.fighters[0], bone: 'head', dist: 1.15 });`,
    settle: 1200,
  },
  {
    name: '03-full-body',
    note: 'Full-body three-quarter — silhouette and proportion read.',
    setup: `KB.fightCamera.cinematic('portrait', { target: KB.fighters[0], dist: 4.2, yaw: 0.6 });`,
    settle: 1200,
  },
  {
    name: '04-impact',
    note: 'Mid-combo impact frame — FX, hitstop, camera punch.',
    setup: `KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    settle: 700,
  },
  {
    name: '05-juggle',
    note: 'Airborne juggle — pose readability off the ground.',
    setup: `KB.testHarness.forceJuggle({ attacker: 0, hits: 3 });`,
    settle: 1400,
  },
  {
    name: '06-stage-wide',
    note: 'Wide arena — environment, lighting, and depth cues.',
    setup: `KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 });`,
    settle: 1200,
  },
  {
    name: '07-super',
    note: 'Overdrive/super cinematic — the money shot.',
    setup: `KB.testHarness.forceSuper({ attacker: 0 });`,
    settle: 1500,
  },
  {
    name: '08-hud',
    note: 'Full frame with HUD — the actual play-view composition.',
    setup: `KB.setPhase('fight'); KB.fighters[1].health = 62; KB.fighters[0].meter = 84;`,
    settle: 900,
  },
  {
    name: '09-roster',
    note: 'All characters lined up — silhouette variety across the cast.',
    setup: `KB.testHarness.rosterLineup();`,
    settle: 1600,
  },
  {
    name: '10-ko',
    note: 'KO slow-motion moment — the dramatic beat.',
    setup: `KB.testHarness.forceKO({ loser: 1 });`,
    settle: 1800,
  },
];

async function main() {
  if (!KEEP && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const server = await createServer({
    root: ROOT,
    server: { port: 5199, host: '127.0.0.1' },
    logLevel: 'error',
  });
  await server.listen();
  const url = 'http://127.0.0.1:5199/';

  const browser = await chromium.launch({
    args: [
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--disable-frame-rate-limit',
      '--force-device-scale-factor=1',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`[capture] loading ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  try {
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  } catch {
    const png = await page.screenshot({ path: resolve(OUT, '00-BOOT-FAILURE.png') });
    console.error('[capture] game never became ready. Console errors:');
    for (const e of errors.slice(0, 20)) console.error('  ', e);
    await browser.close();
    await server.close();
    process.exit(1);
  }

  // Let shader compilation and the first frames settle.
  await page.waitForTimeout(2500);

  const list = ONLY.length ? SHOTS.filter((s) => ONLY.some((o) => s.name.includes(o))) : SHOTS;
  const manifest = [];

  for (const shot of list) {
    try {
      await page.evaluate(`(() => { try { ${shot.setup} } catch (e) { console.error('shot setup', e); } })()`);
    } catch (e) {
      console.warn(`[capture] setup failed for ${shot.name}: ${e.message}`);
    }
    await page.waitForTimeout(shot.settle);
    const file = resolve(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file });
    manifest.push({ name: shot.name, note: shot.note, file });
    console.log(`[capture] ${shot.name}`);
  }

  const fps = await page.evaluate(`window.KB?.renderer?.stats?.fps ?? null`);
  const info = await page.evaluate(`(() => {
    const r = window.KB?.renderer?.renderer; if (!r) return null;
    return { calls: r.info.render.calls, triangles: r.info.render.triangles,
             programs: r.info.programs?.length ?? 0, textures: r.info.memory.textures,
             geometries: r.info.memory.geometries };
  })()`);

  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify({ shots: manifest, fps, info, errors: errors.slice(0, 40) }, null, 2));

  if (errors.length) {
    console.warn(`[capture] ${errors.length} console error(s):`);
    for (const e of errors.slice(0, 10)) console.warn('  ', e);
  }
  console.log(`[capture] wrote ${manifest.length} shots to ${OUT}`);
  if (info) console.log(`[capture] draw calls ${info.calls}, tris ${info.triangles}, fps ${fps ?? '?'}`);

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
