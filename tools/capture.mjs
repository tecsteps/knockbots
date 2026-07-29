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
const PORT = Number(arg('port', 5199));

/**
 * A shot is a named camera/pose setup evaluated in the page. Each `setup` runs
 * inside the browser with `KB` (the Game) in scope, then we wait `settle` ms and
 * grab the canvas.
 */
const SHOTS = [
  {
    name: '01-hero-idle',
    note: 'Default fight framing, both fighters idle. The baseline look.',
    setup: `window.KB.debug.freecam=false; window.KB.setPhase('fight');`,
    settle: 1600,
  },
  {
    name: '02-closeup-face',
    note: 'Head/chest closeup — material, panel, and emissive detail.',
    setup: `window.KB.fightCamera.cinematic('closeup', { target: window.KB.fighters[0], bone: 'head', dist: 1.15 });`,
    settle: 1200,
  },
  {
    name: '03-full-body',
    note: 'Full-body three-quarter — silhouette and proportion read.',
    setup: `window.KB.fightCamera.cinematic('portrait', { target: window.KB.fighters[0], dist: 4.2, yaw: 0.6 });`,
    settle: 1200,
  },
  {
    name: '04-impact',
    note: 'The contact frame itself — sparks, flash, hitstop, camera punch.',
    // Impact FX live 160-300ms. A fixed settle delay photographs the aftermath,
    // not the impact, so this shot arms a bus listener and freezes the frame the
    // hit actually lands. `impactOffset` then steps a precise number of ticks
    // past contact. See docs/CRITIC.md — earlier impact scores were measured on
    // frames taken after every spark had already died.
    setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    freezeOnHit: true,
    impactOffset: 1,
    settle: 0,
  },
  {
    name: '04b-impact-decay',
    note: 'Eight ticks past contact — spark travel, ember fall, debris arc.',
    setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    freezeOnHit: true,
    impactOffset: 8,
    settle: 0,
  },
  {
    name: '05-juggle',
    note: 'Airborne juggle — pose readability off the ground.',
    setup: `window.KB.testHarness.forceJuggle({ attacker: 0, hits: 3 });`,
    settle: 1400,
  },
  {
    name: '06-stage-wide',
    note: 'Wide arena — environment, lighting, and depth cues.',
    setup: `window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 });`,
    settle: 1200,
  },
  {
    name: '07-super',
    note: 'Overdrive/super cinematic — the money shot.',
    setup: `window.KB.testHarness.forceSuper({ attacker: 0 });`,
    settle: 1500,
  },
  {
    name: '08-hud',
    note: 'Full frame with HUD — the actual play-view composition.',
    setup: `window.KB.setPhase('fight'); window.KB.fighters[1].health = 62; window.KB.fighters[0].meter = 84;`,
    settle: 900,
  },
  {
    name: '08b-hud-motion',
    note: 'HUD easing across 20 ticks after damage lands — bar drain, chip layer, combo slam.',
    // The same failure the impact shot had: a still cannot show easing, so any
    // claim about the drain layer or the combo counter's entry is unmeasured.
    // This tiles the ticks where the motion actually happens.
    setup: `window.KB.setPhase('fight'); window.KB.fighters[0].meter = 84;
            window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    tickStrip: [1, 4, 10, 20, 34],
    settle: 0,
  },
  {
    name: '09-roster',
    note: 'All characters lined up — silhouette variety across the cast.',
    setup: `window.KB.testHarness.rosterLineup();`,
    settle: 1600,
  },
  {
    name: '10-ko',
    note: 'KO slow-motion moment — the dramatic beat.',
    setup: `window.KB.testHarness.forceKO({ loser: 1 });`,
    settle: 1800,
  },
];

async function main() {
  if (!KEEP && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/`;

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

  // `--eval "<js>"` runs once before the shot list, for A/B diagnosis of a
  // single effect without editing the shot table.
  const pre = arg('eval', '');
  if (pre) {
    await page.evaluate(`(() => { try { ${pre} } catch (e) { console.error('eval', e); } })()`);
    await page.waitForTimeout(600);
  }

  const list = ONLY.length ? SHOTS.filter((s) => ONLY.some((o) => s.name.includes(o))) : SHOTS;
  const manifest = [];

  // Every shot is taken from inside a live round with the menus dismissed.
  // Without this the camera framings composite over the title screen.
  const ENTER_MATCH = `
    window.KB.menus.show(null);
    window.KB.paused = false;
    if (window.KB.phase !== 'fight') { window.KB.startMatch(0, 1); window.KB.setPhase('fight'); }
  `;

  // Arms a one-shot bus listener that records the tick a hit lands on and
  // freezes the simulation `offset` ticks later. This is the only way to
  // photograph an impact whose effects live a fifth of a second.
  const ARM_HIT_FREEZE = (offset) => `(() => {
    window.__kbHit = null;
    window.KB.timeScale = 0.05;
    const off = ${offset};
    const stop = window.KB.bus.on('hit', (e) => {
      window.__kbHit = { tick: window.KB.tick };
      stop();
      const wait = () => {
        if (window.KB.tick - window.__kbHit.tick >= off) { window.KB.paused = true; window.__kbHit.frozen = true; }
        else requestAnimationFrame(wait);
      };
      wait();
    });
  })()`;

  for (const shot of list) {
    try {
      await page.evaluate(`(() => { try { ${ENTER_MATCH} } catch (e) { console.error('enter', e); } })()`);
      await page.waitForTimeout(500);
      if (shot.freezeOnHit) {
        // A frozen shot has no settle window by construction, so the framing
        // that is live at contact is the framing that gets photographed — and
        // `KB.paused` stops the simulation but NOT the camera rig, which keeps
        // integrating off the render loop. Both failures therefore have to be
        // headed off *before* the hit rather than waited out after it: waiting
        // after the freeze does not help, because the FX advance on render dt
        // and drain away while the camera is still whipping.
        //
        // Restarting the match puts the fighters back on their neutral marks
        // and the rig back on the pair, so by the time `forceHit` fires the
        // camera is already where it wants to be and is barely moving. The
        // freeze then catches a near-static camera: correctly framed, and with
        // almost no reprojection velocity for motion blur to smear.
        await page.evaluate(`window.KB.startMatch(0, 1); window.KB.setPhase('fight'); window.KB.fightCamera.cinematic('fight');`);
        await page.waitForFunction('window.KB.phaseTicks > 60', null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(900);
        await page.evaluate(ARM_HIT_FREEZE(shot.impactOffset ?? 0));
      }
      await page.evaluate(`(() => { try { ${shot.setup} } catch (e) { console.error('shot setup', e); } })()`);
      if (shot.freezeOnHit) {
        await page.waitForFunction('window.__kbHit && window.__kbHit.frozen', null, { timeout: 15000 })
          .catch(() => console.warn(`[capture] ${shot.name}: no hit landed, frame is not a contact frame`));
      }
    } catch (e) {
      console.warn(`[capture] setup failed for ${shot.name}: ${e.message}`);
    }
    if (shot.settle) await page.waitForTimeout(shot.settle);
    const file = resolve(OUT, `${shot.name}.png`);

    if (shot.tickStrip) {
      // Sample on the sim's own tick counter and tile the frames, so motion that
      // lives in a few ticks can actually be reviewed. Same reasoning as the
      // contact-frame freeze: a still cannot show easing.
      const frames = [];
      const base = await page.evaluate('window.KB.tick');
      for (const off of shot.tickStrip) {
        await page.waitForFunction(`window.KB.tick >= ${base + off}`, null, { timeout: 15000 }).catch(() => {});
        frames.push({ t: off, b64: (await page.screenshot()).toString('base64') });
      }
      const sheet = await page.evaluate(async ({ cells, label }) => {
        const imgs = await Promise.all(cells.map((c) => new Promise((res) => {
          const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + c.b64;
        })));
        const w = imgs[0].width, h = Math.round(imgs[0].height * 0.34); // HUD lives in the top third
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h * imgs.length + 30;
        const g = cv.getContext('2d');
        g.fillStyle = '#0a0d13'; g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = '#ff9e2c'; g.font = '600 19px ui-monospace, monospace';
        g.fillText(label, 12, 21);
        imgs.forEach((im, i) => {
          g.drawImage(im, 0, 0, w, h, 0, i * h + 30, w, h);
          g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(0, i * h + 30, 78, 22);
          g.fillStyle = '#4fd8e8'; g.font = '600 13px ui-monospace, monospace';
          g.fillText('+' + cells[i].t + 't', 8, i * h + 46);
        });
        return cv.toDataURL('image/jpeg', 0.86);
      }, { cells: frames, label: `${shot.name}  ·  ticks after damage` });
      writeFileSync(file.replace(/\.png$/, '.jpg'), Buffer.from(sheet.split(',')[1], 'base64'));
      await page.evaluate('window.KB.timeScale = 1;');
      manifest.push({ name: shot.name, note: shot.note, file: file.replace(/\.png$/, '.jpg') });
      console.log(`[capture] ${shot.name} (tick strip)`);
      continue;
    }

    await page.screenshot({ path: file });
    if (shot.freezeOnHit) {
      await page.evaluate('window.KB.paused = false; window.KB.timeScale = 1;');
    }
    manifest.push({ name: shot.name, note: shot.note, file });
    console.log(`[capture] ${shot.name}${shot.freezeOnHit ? ' (frozen at contact)' : ''}`);
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
