/**
 * Knockbots — the picture half of the scenario gate.
 *
 * `tools/simscene.mjs` runs the simulation in bare Node and produces numbers.
 * This boots a real page, drives the SAME scenario through `window.__GAME_TEST__`
 * — the same façade, the same `Scenarios.js` table, the same frame indices —
 * and photographs it. Two artefacts per scenario:
 *
 *   contact sheet   12-30 evenly spaced frames on one image, with every named
 *                   moment forced in and each cell stamped with its frame
 *                   number. One vision call over one image can then see a
 *                   position jump between adjacent cells, a limb that vanished,
 *                   geometry passing through geometry, a kick pointing away
 *                   from the opponent, or a camera that changed its mind
 *                   halfway through a move. None of those are visible in a
 *                   timeline, and all of them are obvious in a strip.
 *   named frames    full resolution, at beforeInput / anticipation /
 *                   maxExtension / impact / recovery / returnToIdle /
 *                   loopBoundary. The contact sheet says WHERE to look; these
 *                   are what you look at.
 *
 * IT ALSO CHECKS THE PREMISE OF THE WHOLE DESIGN. The page returns its own
 * trajectory digest, and it is compared against the one Node computed. Those
 * two processes share nothing but the source: different renderer, different
 * `Environment`, a real `Stage` with real arena bounds against `stage: null`,
 * a live `FightCamera`, and a JIT that has warmed on completely different code.
 * If the digests agree, "the frames the contact sheet is labelled with are the
 * frames the invariants were measured on" is a measurement rather than a
 * promise. If they disagree, the disagreement is the finding.
 *
 * WHY `RenderPipeline.screenshot()` AND NOT `page.screenshot()`. Same reason
 * `tools/scenecap.mjs` gives: the pipeline renders and reads in one task and
 * never touches the compositor, which is roughly an order of magnitude faster
 * per frame on a software rasteriser, and it is the same pixels because the
 * read happens after the post chain. A contact sheet is 20 frames; through the
 * compositor that is ten minutes a scenario.
 *
 * Driven from `tools/simscene.mjs --shots`; not run directly.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll an expression in the page until it is truthy, or give up and say so. */
async function until(page, expr, ms, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(expr).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}

/**
 * @param {{ROOT:string, results:Array, cells:number, out:string, seed:number,
 *          say:Function, width?:number, height?:number, port?:number}} o
 *   `results` are `simscene`'s own scenario results — the marks and the frame
 *   list come from there rather than being recomputed, which is the point.
 */
export async function captureShots(o) {
  const { ROOT, results, say } = o;
  const WIDTH = o.width ?? 1280;
  const HEIGHT = o.height ?? 720;
  const PORT = o.port ?? 5219;
  const OUT = resolve(ROOT, o.out || 'shots/sim');
  mkdirSync(OUT, { recursive: true });

  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();

  const browser = await chromium.launch({
    ...(process.env.KB_CHROMIUM ? { executablePath: process.env.KB_CHROMIUM } : {}),
    args: [`--use-angle=${process.env.KB_ANGLE || 'swiftshader'}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(Number(process.env.KB_TIMEOUT || 180000));

  /**
   * Console and page errors, kept for the manifest.
   *
   * A WebGL error or a thrown exception during a capture run is a defect the
   * numeric layer cannot see at all — it has no GL context to lose — so this is
   * the only place in the harness where it can be caught.
   */
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

  // `window.KB.THREE` is assigned LAST by the boot sequence, so it is the only
  // honest "the game is up" signal; polling for `window.KB` alone returns a
  // half-built object and every call against it is a race.
  const booted = await until(page, '!!(window.KB && window.KB.THREE && window.__GAME_TEST__)', 300000, 2000);
  if (!booted) {
    writeFileSync(join(OUT, 'BOOT-FAILURE.txt'), errors.join('\n') || 'no error text');
    say('[simshots] the game never booted — see BOOT-FAILURE.txt');
    await browser.close(); await server.close();
    return { ok: false };
  }
  say(`[simshots] booted at ${WIDTH}x${HEIGHT}`);

  // The HUD sits over the middle of the frame and none of it is under test
  // here; a cell with FIGHT written across the fighter is not a cell anyone can
  // judge a pose in.
  await page.evaluate(() => { const el = document.getElementById('ui'); if (el) el.style.visibility = 'hidden'; });

  const manifest = { width: WIDTH, height: HEIGHT, seed: o.seed, scenarios: [], errors: [] };

  for (const r of results) {
    // The frame list comes from `simscene`, which computed it with
    // `pickContactFrames` off the marks it derived from the timeline it
    // measured. Recomputing it here would be a second implementation of the
    // one thing that has to agree between the numbers and the pictures.
    const frames = r.contactFrames;
    say(`[simshots] ${r.name}: ${frames.length} cells, marks ${Object.entries(r.marks).map(([k, v]) => `${k}@${v}`).join(' ')}`);
    const t0 = Date.now();

    const shot = await page.evaluate(async ({ name, seed, frames: want, total, marks }) => {
      const GT = window.__GAME_TEST__;
      GT.loadScenario(name, { seed });
      const grabbed = [];
      let at = 0;
      for (const f of want) {
        /*
         * Two off-by-ones live on this line and both were made and fixed here.
         *
         * The frames are ABSOLUTE, so the argument to `step` is the difference;
         * passing `f` would run the scenario quadratically and photograph the
         * wrong moments from the second cell onward.
         *
         * And frame `f` has been SIMULATED once the counter reads `f + 1` —
         * `advance` records the row and then increments — so photographing
         * after `f` steps would put the whole sheet one frame early, with cell
         * "f0" showing the staged pose that no tick has touched.
         */
        GT.step(f + 1 - at);
        at = f + 1;
        grabbed.push({ frame: f, url: GT.captureFrame() });
      }
      // Finish the run so the trajectory covers the same frames Node's did;
      // otherwise the digest comparison is between two different lengths and
      // would report a disagreement that is entirely the harness's own doing.
      if (at < total) GT.step(total - at);
      return { frames: grabbed, digest: GT.digest(), metrics: GT.getMetrics(), marks };
    }, { name: r.name, seed: o.seed, frames, total: r.frames, marks: r.marks });

    // The premise check. Same source, two hosts, one number.
    const agree = shot.digest === r.digest;
    say(`[simshots] ${r.name}: browser digest ${shot.digest} vs node ${r.digest} — `
      + `${agree ? 'IDENTICAL' : 'DIFFERENT, the two hosts do not agree'}`);

    const byFrame = new Map();
    for (const [k, v] of Object.entries(r.marks)) {
      if (!byFrame.has(v)) byFrame.set(v, []);
      byFrame.get(v).push(k);
    }

    // Full-resolution frames at the named moments.
    const named = [];
    for (const g of shot.frames) {
      const labels = byFrame.get(g.frame);
      if (!labels || !g.url) continue;
      const file = join(OUT, `${r.name}-${String(g.frame).padStart(3, '0')}-${labels.join('+')}.png`);
      writeFileSync(file, Buffer.from(g.url.split(',')[1], 'base64'));
      named.push({ frame: g.frame, labels, file });
    }

    // The contact sheet, composited in the page because that is where the
    // pixels already are — pulling 20 PNGs across the CDP bridge to stitch them
    // in Node would cost more than rendering them did, and would need an image
    // library this project does not depend on.
    const sheetUrl = await page.evaluate(async ({ shots, labels, title }) => {
      const cols = Math.ceil(Math.sqrt(shots.length * 1.6));
      const rows = Math.ceil(shots.length / cols);
      const cw = 320; const ch = 180;
      const pad = 18;
      const c = document.createElement('canvas');
      c.width = cols * cw;
      c.height = rows * (ch + pad) + pad;
      const g = c.getContext('2d');
      g.fillStyle = '#101216';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#e8eaf0';
      g.font = '13px monospace';
      g.fillText(title, 6, 13);
      for (let i = 0; i < shots.length; i++) {
        const s = shots[i];
        if (!s.url) continue;
        const img = new Image();
        img.src = s.url;
        await img.decode();
        const x = (i % cols) * cw;
        const y = Math.floor(i / cols) * (ch + pad) + pad;
        g.drawImage(img, x, y, cw, ch);
        g.strokeStyle = '#2a2f3a';
        g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1);
        g.fillStyle = '#000';
        g.fillRect(x + 2, y + ch - 15, 150, 14);
        g.fillStyle = '#9ef';
        const tag = labels[s.frame] ? `f${s.frame} ${labels[s.frame].join('+')}` : `f${s.frame}`;
        g.fillText(tag.slice(0, 24), x + 5, y + ch - 4);
      }
      return c.toDataURL('image/png');
    }, {
      shots: shot.frames,
      labels: Object.fromEntries(byFrame),
      title: `${r.name}  seed ${o.seed}  digest ${shot.digest}  ${r.metrics.hits} hit / ${r.metrics.frozenFrames} frozen`,
    });

    const sheetFile = join(OUT, `${r.name}-contact.png`);
    writeFileSync(sheetFile, Buffer.from(sheetUrl.split(',')[1], 'base64'));

    manifest.scenarios.push({
      name: r.name, cells: frames.length, frames,
      nodeDigest: r.digest, browserDigest: shot.digest, hostsAgree: agree,
      contactSheet: sheetFile, named, seconds: +((Date.now() - t0) / 1000).toFixed(1),
    });
    say(`[simshots] ${r.name}: wrote ${sheetFile} and ${named.length} named frame(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  manifest.errors = errors.slice(0, 40);
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  if (errors.length) say(`[simshots] ${errors.length} page error(s): ${errors.slice(0, 4).join(' | ')}`);
  say(`[simshots] manifest at ${join(OUT, 'manifest.json')}`);

  await browser.close();
  await server.close();
  return { ok: manifest.scenarios.every((s) => s.hostsAgree), manifest };
}
