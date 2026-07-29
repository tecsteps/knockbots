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
import { MOVES } from '../src/combat/Moves.js';

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

/**
 * The frame data for a clip, if a move references it. Loaded from source so the
 * tool knows where a strike's active window actually is.
 * @returns {?{startup:number, active:Array<{from:number,to:number}>, total:number}}
 */
function moveFor(clipId) {
  for (const set of Object.values(MOVES)) {
    for (const mv of Object.values(set)) {
      if (mv.clip === clipId) return mv;
    }
  }
  return null;
}

/**
 * Pick which ticks to sample. A strike is judged on three frames — the startup
 * extreme just before release, the contact frame, and the settle — so those are
 * pinned first and the remaining budget is spread across the rest.
 * @returns {number[]} ascending, de-duplicated ticks
 */
function pickTicks(duration, move, count) {
  const must = [0];
  if (move && move.active?.length) {
    const first = Math.min(...move.active.map((a) => a.from));
    const last = Math.max(...move.active.map((a) => a.to));
    if (first > 1) must.push(first - 1); // last frame of wind-up
    must.push(first);                    // contact
    if (last > first) must.push(last);
    must.push(Math.min(duration, last + 3)); // early recovery
  }
  const out = new Set(must.filter((t) => t >= 0 && t <= duration));
  // Fill the remainder evenly across the clip.
  for (let i = 1; out.size < count && i <= count * 3; i++) {
    out.add(Math.round((duration * i) / (count + 1)));
  }
  return [...out].sort((a, b) => a - b).slice(0, count);
}

/**
 * Runs in the page. Projects every hurtbox bone of fighter 0 to screen space and
 * returns a padded, aspect-locked crop rectangle covering the whole body.
 * Returns null if the fighter is off-screen or the rig is not ready.
 */
function projectFighterBounds() {
  const f = window.KB.fighters[0];
  const bundle = f.skeletonBundle;
  if (!bundle) return null;
  const cam = window.KB.camera;
  const cv = window.KB.renderer.renderer.domElement;
  const W = cv.clientWidth, H = cv.clientHeight;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const bone of bundle.bones) {
    bone.updateMatrixWorld(true);
    const e = bone.matrixWorld.elements;
    const v = { x: e[12], y: e[13], z: e[14] };
    // world -> clip, using the camera's own matrices
    const m = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    const vx = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12];
    const vy = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13];
    const vz = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14];
    const cw = -vz;
    if (cw <= 0.01) continue;
    const cx = (p[0] * vx + p[8] * vz) / cw;
    const cy = (p[5] * vy + p[9] * vz) / cw;
    const sx = (cx * 0.5 + 0.5) * W;
    const sy = (-cy * 0.5 + 0.5) * H;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  if (!isFinite(minX) || maxX - minX < 4) return null;

  // Pad generously so a full extension never clips out of the crop.
  const padX = (maxX - minX) * 0.55 + 24;
  const padY = (maxY - minY) * 0.16 + 24;
  let x0 = minX - padX, x1 = maxX + padX, y0 = minY - padY, y1 = maxY + padY;

  // Lock to the cell aspect so every sheet cell composites identically.
  const aspect = W / H;
  let w = x1 - x0, h = y1 - y0;
  if (w / h > aspect) { const nh = w / aspect; const cym = (y0 + y1) / 2; y0 = cym - nh / 2; y1 = cym + nh / 2; }
  else { const nw = h * aspect; const cxm = (x0 + x1) / 2; x0 = cxm - nw / 2; x1 = cxm + nw / 2; }

  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  w = Math.min(W - x0, Math.ceil(x1 - x0)); h = Math.min(H - y0, Math.ceil(y1 - y0));
  if (w < 8 || h < 8) return null;
  return { x: x0, y: y0, width: w, height: h };
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

  // Frame a single fighter side-on — the angle an animator reviews a strike
  // from — with the interface hidden. A contact sheet is for judging motion, so
  // anything that is not the fighter is noise: the HUD, the opponent, and the
  // round-start announcement all have to go.
  await page.evaluate(`(() => {
    window.KB.menus.show(null);
    window.KB.startMatch(${CHAR}, 1);
    window.KB.setPhase('fight');
    window.KB.fighters[1].group.visible = false;
    window.KB.cpu[1] = null;  // the opponent must not interrupt the clip under review
    document.getElementById('ui').style.display = 'none';
    window.KB.fightCamera.cinematic('closeup', { target: window.KB.fighters[0], bone: 'chest', dist: 2.35, yaw: 0.85, height: 0.9 });
    // A 36-tick move finishes in 600ms — far faster than a screenshot round
    // trip — so the sim is slowed for capture. The tick counter is unaffected,
    // only the wall-clock rate at which ticks are consumed.
    window.KB.timeScale = 0.07;
  })()`);

  // Wait for the round-start beat to finish so no announcement bleeds in and the
  // fighter is actually live rather than in its intro pose.
  await page.waitForFunction("window.KB.phase === 'fight' && window.KB.phaseTicks > 40", null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(700);

  for (const clip of clips) {
    const info = await page.evaluate(`(() => {
      const c = window.KB.fighters[0].animator?.clips?.['${clip}'];
      return c ? { duration: c.duration, loop: !!c.loop } : null;
    })()`);

    if (!info) { console.warn(`[anim] clip "${clip}" not found on the animator, skipping`); continue; }

    // Choose the sample ticks deliberately rather than by even division. The
    // frames that decide whether a strike reads are the startup extreme, the
    // contact frame and the first recovery frame — an even split routinely
    // misses all three. Where a move backs the clip, its active window drives
    // the choice; otherwise fall back to an even spread.
    const targets = pickTicks(info.duration, moveFor(clip), FRAMES);
    const cells = [];

    // Execute the real move where one exists: the Fighter state machine
    // re-asserts its own clip every tick, so animator.play() alone is
    // overwritten by the idle state within a frame. Non-move clips (idle,
    // locomotion, reactions) are left alone by the state machine.
    await page.evaluate(`(() => {
      window.KB.paused = false;
      const f = window.KB.fighters[0];
      const set = f.def?.moveSet ?? 'standard';
      const mv = Object.values(window.KB.MOVES?.[set] ?? {}).find(m => m.clip === '${clip}');
      if (mv && f.startMove) { f.startMove(mv); return; }
      f.animator.play('${clip}', { blend: 0, loop: ${info.loop} });
    })()`);

    for (const target of targets) {
      // Poll the engine's own clock instead of sleeping. Wall-clock waits drift
      // against the 60Hz tick and produce the ragged frame numbers that made
      // earlier sheets unreadable.
      await page.waitForFunction(
        `window.KB.fighters[0].animator.time >= ${target}`,
        null, { timeout: 20000 },
      ).catch(() => {});
      const t = await page.evaluate('Math.round(window.KB.fighters[0].animator.time)');
      // Crop to the fighter's projected bounds rather than trying to dolly the
      // camera in. FightCamera re-solves its framing every tick and pulls back
      // to the gameplay shot, so a requested cinematic distance does not hold;
      // cropping is stable and gives the critic the fighter at a readable size.
      const box = await page.evaluate(projectFighterBounds);
      const buf = box ? await page.screenshot({ clip: box }) : await page.screenshot();
      cells.push({ t, b64: buf.toString('base64') });
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
      // Crops vary in pixel size frame to frame, so normalise to the largest.
      const w = Math.max(...imgs.map((i) => i.width));
      const h = Math.max(...imgs.map((i) => i.height));
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
        g.drawImage(im, x + (w - im.width) / 2, y + (h - im.height) / 2, im.width, im.height);
        g.fillStyle = 'rgba(0,0,0,.65)';
        g.fillRect(x, y, 62, 22);
        g.fillStyle = '#4fd8e8';
        g.font = '600 13px ui-monospace, monospace';
        g.fillText('f' + cells[i].t, x + 7, y + 16);
        g.strokeStyle = 'rgba(255,255,255,.07)';
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      });
      return cv.toDataURL('image/jpeg', 0.82);
    }, { cells, cols: COLS, label: `${clip}  \u00b7  ${info.duration} ticks  \u00b7  ticks ${targets.join(", ")}` });

    const file = resolve(OUT, `${clip.replace(/\./g, '_')}.jpg`);
    writeFileSync(file, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`[anim] ${clip} -> ${file}`);
  }

  if (errors.length) { console.warn(`[anim] ${errors.length} page error(s):`); errors.slice(0, 5).forEach((e) => console.warn('  ', e)); }
  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
