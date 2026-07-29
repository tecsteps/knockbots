/**
 * Knockbots — animation contact-sheet capture.
 *
 * Animation cannot be judged from a single frame, which is exactly the axis
 * most likely to fail against Tekken. This drives one clip tick by tick and
 * composites the frames into a single contact sheet PNG, so a critic can read
 * timing, anticipation, follow-through and silhouette from one image.
 *
 * Moves are driven through `Fighter.startMove()` so the strip shows exactly
 * what a player sees. Poking `Animator.play()` directly does not work: the
 * fighter state machine re-asserts its own clip on the very next tick.
 *
 *   node tools/animstrip.mjs --clip p.straight
 *   node tools/animstrip.mjs --clip k.roundhouse --frames 12 --cols 6
 *   node tools/animstrip.mjs --all-attacks
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT = resolve(ROOT, arg('out', 'shots/anim'));
const FRAMES = Number(arg('frames', 10));
const COLS = Number(arg('cols', 5));
const CELL_W = Number(arg('cell', 420));
const PORT = Number(arg('port', 5230));
const CHAR = Number(arg('char', 0));

const DEFAULT_CLIPS = [
  'p.straight', 'p.uppercut', 'p.pistonRush', 'p.launcherPunch',
  'k.roundhouse', 'k.axeKick', 'k.sweep', 'k.spinKick',
  'sp.rocketPunch', 'sp.chargeShoulder',
  'r.launch', 'r.knockdownBack', 'r.wallSplat',
  'idle.fight', 'loco.dashFwd',
];

const clips = argv.includes('--all-attacks')
  ? DEFAULT_CLIPS
  : arg('clip', '').split(',').filter(Boolean);

if (!clips.length) {
  console.error('usage: node tools/animstrip.mjs --clip <id>[,<id>...] | --all-attacks');
  process.exit(1);
}

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const server = await createServer({ root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
  await server.listen();

  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: CELL_W, height: Math.round(CELL_W * 1.15) }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(2500);

  // Freeze the game and frame a single fighter side-on, which is the angle an
  // animator reviews a strike from.
  await page.evaluate(`(() => {
    window.KB.menus.show(null);
    window.KB.startMatch(${CHAR}, 1);
    window.KB.setPhase('fight');
    window.KB.fighters[1].group.visible = false;
    window.KB.cpu[1] = null;  // the opponent must not interrupt the clip under review
    window.KB.fightCamera.cinematic('portrait', { target: window.KB.fighters[0], dist: 4.4, yaw: 0.85, height: 1.1 });
  })()`);
  await page.waitForTimeout(900);

  for (const clip of clips) {
    const info = await page.evaluate(`(() => {
      const c = window.KB.fighters[0].animator?.clips?.['${clip}'];
      return c ? { duration: c.duration, loop: !!c.loop } : null;
    })()`);

    if (!info) { console.warn(`[anim] clip "${clip}" not found on the animator, skipping`); continue; }

    // Sample the clip as the real game plays it. Driving Animator.simulate()
    // by hand desynchronises its internal pose snapshots and yields a frozen
    // pose — the engine must own the stepping, so we play once and sample.
    const step = Math.max(1, Math.floor(info.duration / (FRAMES - 1)));
    const cells = [];

    // Prefer executing the real move: the Fighter state machine re-asserts its
    // own clip every tick, so simply calling animator.play() is overwritten by
    // the idle state within a frame. Driving startMove() shows what a player
    // actually sees. Fall back to a raw clip play for non-move clips (idle,
    // locomotion, reactions), which the state machine leaves alone.
    await page.evaluate(`(() => {
      window.KB.paused = false;
      const f = window.KB.fighters[0];
      const set = f.def?.moveSet ?? 'standard';
      const mv = Object.values(window.KB.MOVES?.[set] ?? {}).find(m => m.clip === '${clip}');
      if (mv && f.startMove) { f.startMove(mv); return; }
      f.animator.play('${clip}', { blend: 0, loop: ${info.loop} });
    })()`);

    for (let i = 0; i < FRAMES; i++) {
      const t = await page.evaluate('Math.round(window.KB.fighters[0].animator.time)');
      const buf = await page.screenshot();
      cells.push({ t, b64: buf.toString('base64') });
      // step ticks at 60Hz, plus a little slack for the render to land.
      if (i < FRAMES - 1) await page.waitForTimeout((step / 60) * 1000 + 20);
    }

    // Composite in the page: a canvas contact sheet with a frame-number stamp
    // on each cell, which is what makes timing legible at a glance.
    // Playwright only forwards arguments when the page function is a real
    // function, not a source string \u2014 hence the function form here.
    const sheet = await page.evaluate(async ({ cells, cols, label }) => {
      const imgs = await Promise.all(cells.map((c) => new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.src = 'data:image/png;base64,' + c.b64;
      })));
      const w = imgs[0].width, h = imgs[0].height;
      const rows = Math.ceil(imgs.length / cols);
      const cv = document.createElement('canvas');
      cv.width = w * cols;
      cv.height = h * rows + 34;
      const g = cv.getContext('2d');
      g.fillStyle = '#0a0d13';
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = '#ff9e2c';
      g.font = '600 20px ui-monospace, monospace';
      g.fillText(label, 12, 23);
      imgs.forEach((im, i) => {
        const x = (i % cols) * w, y = Math.floor(i / cols) * h + 34;
        g.drawImage(im, x, y);
        g.fillStyle = 'rgba(0,0,0,.65)';
        g.fillRect(x, y, 62, 22);
        g.fillStyle = '#4fd8e8';
        g.font = '600 13px ui-monospace, monospace';
        g.fillText('f' + cells[i].t, x + 7, y + 16);
        g.strokeStyle = 'rgba(255,255,255,.07)';
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      });
      return cv.toDataURL('image/jpeg', 0.82);
    }, { cells, cols: COLS, label: `${clip}  \u00b7  ${info.duration} ticks  \u00b7  every ${step}` });

    const file = resolve(OUT, `${clip.replace(/\./g, '_')}.jpg`);
    writeFileSync(file, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`[anim] ${clip} -> ${file}`);
  }

  if (errors.length) { console.warn(`[anim] ${errors.length} page error(s):`); errors.slice(0, 5).forEach((e) => console.warn('  ', e)); }
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
