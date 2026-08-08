/**
 * ghosthunt -- INDEPENDENT adversarial probe for temporal smearing.
 *
 * Written to REFUTE the TAA change, not to confirm it. It does not reuse
 * tools/taaghost.mjs: same family of idea (one fight, an extra no-TAA render of
 * the SAME frame in the SAME task), different questions.
 *
 * WHAT taaghost DOES NOT ANSWER, AND THIS DOES
 *   1. It reports ONE aggregate ghost fraction over every pixel that moved by
 *      more than 12/255. A limb crossing eight pixels and a shadow drifting by
 *      one are in the same average. Here the pixels are BINNED BY SPEED, so
 *      "does it smear a FAST limb" is a number instead of an inference.
 *   2. It does not separate the two signs. A trail behind a limb (the limb has
 *      LEFT a pixel, and old brightness survives) and an eroded leading edge
 *      (the limb has ARRIVED, and old background survives) are different
 *      defects with different visibility. Split here.
 *   3. It reports a dimensionless coefficient. A player sees luma. Here the
 *      residual is also reported in 8-bit luma units and as a count of pixels
 *      wrong by more than 8 and 16 of them.
 *   4. It samples one arbitrary tick of a CPU fight. This also drives a forced
 *      LAUNCHER -- the impact camera cut, the hitstop, the spark burst and the
 *      victim leaving the ground -- and scores EVERY frame of a 22-frame window
 *      so the worst frame is found rather than assumed.
 *   5. It produces no image. This crops the worst block at fight framing and
 *      writes bare / TAA / amplified-difference montages.
 *
 * THE REFERENCE, and why it is the honest one: the no-TAA arm is the SHIPPED
 * CHAIN with the temporal pass skipped -- AO, bloom, DOF, CAMERA MOTION BLUR and
 * the grade all still running. So every number here is what TAA adds ON TOP of
 * the motion blur the game already ships. No credit is taken for blur that was
 * already there, and none is charged.
 *
 * CONTROLS (all three kinds, because this project keeps finding instrument bugs)
 *   SETUP     armed pass list read off composer.passes per arm, asserted; the
 *             pass object's own enabled/feedback/clamp read back at capture.
 *   NULL      two back-to-back no-TAA renders of the SAME frame must be
 *             bit-identical, and the estimator run on that pair must return
 *             exactly 0 on every one of its outputs.
 *   POSITIVE  an arm with the clamp removed and feedback 0.97 MUST make every
 *             trail number worse. If it does not, the instrument is blind.
 *   FLOOR     feedback 0 (jitter only, no accumulation): the residue that is
 *             sub-pixel shift rather than history.
 *
 *   node tools/ghosthunt.mjs --json scratchpad/ghosthunt.json --png scratchpad/ghosthunt
 *
 * NOTE: page-side code is passed as FUNCTIONS to page.evaluate, not as strings,
 * specifically so no GLSL-adjacent template literal is involved. Keep it that
 * way; the backtick trap in this repo is real.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(arg('port', 5311));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const JSON_OUT = arg('json', '');
const PNG_OUT = arg('png', '');
const SCALE = Number(arg('scale', 0.85));
const COUNT = Number(arg('count', 22));
const WARM = Number(arg('warm', 110));
const ONLY = arg('only', '');

/** Expected armed pass list for the shipped chain with TAA. */
const EXPECT_SHIPPED = 'scene,gbuffer,ao,bloom,dof,motionBlur,taa,grade,output';

/* =========================================================================
 * PAGE-SIDE: capture
 * ====================================================================== */

async function pageCapture(o) {
  const KB = window.KB;
  const r = KB.renderer;

  r.effects.adaptiveResolution = false;
  r.renderScale = o.scale;
  r._targetScale = o.scale;
  r.resize();
  // Grain is a per-frame hash applied AFTER the temporal pass. It is not
  // averaged by it, it is pure noise on both arms, and it makes the null
  // control impossible. Off for the measurement; noted in the report.
  if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });

  const taa = r._passes.taa || null;
  const savedFb = taa ? taa.uniforms.uFeedback.value : null;
  const savedCl = taa ? taa.uniforms.uClamp.value : null;
  if (taa) {
    if (typeof o.feedback === 'number') taa.uniforms.uFeedback.value = o.feedback;
    if (typeof o.clamp === 'number') taa.uniforms.uClamp.value = o.clamp;
    taa.invalidate();
    r._jitterIndex = 0;
  }

  KB.menus.show(null);
  KB.debug.freecam = false;
  KB.paused = false;
  KB.startMatch(0, 1);
  KB.setPhase('fight');
  KB.timeScale = 1;
  if (!window.__ghOrigDelta) window.__ghOrigDelta = KB.clock.getDelta.bind(KB.clock);
  KB.clock.getDelta = () => 1 / 60;

  const cv = document.createElement('canvas');
  let ctx = null;
  const grab = () => {
    const c = r.canvas;
    if (cv.width !== c.width || cv.height !== c.height) {
      cv.width = c.width; cv.height = c.height;
      ctx = cv.getContext('2d', { willReadFrequently: true });
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(c, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  };

  const orig = r.render.bind(r);
  const bare = () => {
    const wasEnabled = taa ? taa.enabled : true;
    const wasJs = r.taaJitterScale;
    const wasIdx = r._jitterIndex;
    if (taa) taa.enabled = false;
    r.taaJitterScale = 0;
    orig(KB.scene, KB.camera, 1 / 60);
    const px = grab();
    if (taa) taa.enabled = wasEnabled;
    r.taaJitterScale = wasJs;
    r._jitterIndex = wasIdx;
    return px;
  };

  const S = { G: [], N: [], meta: [], nullPair: null, w: 0, h: 0 };
  window.__gh = S;

  return await new Promise((resolve) => {
    let frames = 0;
    let fired = false;
    r.render = (scene, cam, dt) => {
      orig(scene, cam, dt);
      frames++;

      if (o.scenario === 'launcher' && !fired && frames === o.warm) {
        KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });
        fired = true;
      }

      if (frames >= o.warm + 1 && frames <= o.warm + o.count) {
        const g = grab();
        const n = bare();
        if (S.G.length === 0) { S.w = r.canvas.width; S.h = r.canvas.height; }
        if (S.G.length === 1) {
          // NULL control, taken on the SECOND captured frame so the estimator
          // has a previous frame to project onto. A THIRD back-to-back no-TAA
          // render of this same frame: it must be bit-identical to the second,
          // and running the ghost estimator with it standing in for the TAA arm
          // must return exactly 0. Anything the estimator reports on THAT pair
          // is instrument, not signal.
          S.nullIdx = 1;
          S.nullPair = [n, bare()];
        }
        S.G.push(g);
        S.N.push(n);
        const f0 = KB.fighters[0], f1 = KB.fighters[1];
        S.meta.push({
          tick: KB.tick,
          camPos: [+cam.position.x.toFixed(4), +cam.position.y.toFixed(4), +cam.position.z.toFixed(4)],
          fov: +cam.fov.toFixed(3),
          hitstop: KB.hitstopTicks | 0,
          st: [f0.state, f1.state],
          y: [+f0.position.y.toFixed(3), +f1.position.y.toFixed(3)],
          taaValid: taa ? !!taa._valid : null,
        });
      }

      if (frames >= o.warm + o.count) {
        r.render = orig;
        KB.paused = true;
        const armed = r.composer.passes.map((p) => p.constructor.name).join(' ');
        const out = {
          w: S.w, h: S.h, frames: S.G.length,
          passKeys: Object.keys(r._passes).join(','),
          armedClasses: armed,
          taa: taa ? {
            enabled: taa.enabled,
            feedback: taa.uniforms.uFeedback.value,
            clamp: taa.uniforms.uClamp.value,
            hasDepth: taa.uniforms.uHasDepth.value,
            tonemapWeight: taa.uniforms.uTonemapWeight.value,
          } : null,
          jitterScale: r.taaJitterScale,
          renderScale: r.renderScale,
          meta: S.meta,
        };
        if (taa) { taa.uniforms.uFeedback.value = savedFb; taa.uniforms.uClamp.value = savedCl; }
        resolve(out);
      }
    };
  });
}

/* =========================================================================
 * PAGE-SIDE: analysis
 * ====================================================================== */

/**
 * Per-frame ghost analysis over the captured window.
 *
 * ghost = SUM((G-C).(P-C)) / SUM((P-C)^2) over a pixel set, where C is the
 * no-TAA render of this frame and P the no-TAA render of the previous one. It
 * is a least-squares share of the previous frame surviving, so it has no
 * threshold to tune the answer with.
 *
 * The sets:
 *   all       every pixel whose luma moved by more than thr
 *   speed bins by |P-C| -- the fast bin is the punch
 *   trail     P > C + thr : something BRIGHT left this pixel. Positive ghost
 *             here is a luminous trail behind the limb, the visible defect.
 *   lead      P < C - thr : something bright ARRIVED. Positive ghost here is an
 *             eroded, dimmed leading edge.
 */
function pageAnalyse(a) {
  const S = window.__gh;
  const w = S.w, h = S.h, n = w * h;
  const thr = a.thr;

  const luma = (px) => {
    const out = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = 0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2];
    return out;
  };

  const bins = a.bins;
  const bs = 16;
  const bw = Math.ceil(w / bs);

  /**
   * One frame's statistics. `armPx` is the arm being scored (the TAA frame, or
   * the null control's third bare render), `curPx` the no-TAA render of the
   * same frame and `prevL` the no-TAA luma of the previous frame.
   */
  const score = (armPx, curPx, prevL) => {
    const C = luma(curPx);
    const G = luma(armPx);
    const P = prevL;
    const acc = () => ({ num: 0, den: 0, npx: 0, sumE: 0, sumAbsE: 0, gt8: 0, gt16: 0, sumAbsD: 0 });
    const all = acc(), trail = acc(), lead = acc();
    const speed = bins.map(() => acc());
    const blkNum = new Float64Array(bw * Math.ceil(h / bs));
    const blkDen = new Float64Array(bw * Math.ceil(h / bs));

    for (let y = 0; y < h; y++) {
      const row = y * w;
      const by = (y / bs) | 0;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const d = P[i] - C[i];
        const ad = d < 0 ? -d : d;
        if (ad <= thr) continue;
        const e = G[i] - C[i];
        const ae = e < 0 ? -e : e;
        const bi = by * bw + ((x / bs) | 0);
        blkNum[bi] += e * d;
        blkDen[bi] += d * d;
        const put = (o) => {
          o.num += e * d; o.den += d * d; o.npx++; o.sumE += e; o.sumAbsE += ae; o.sumAbsD += ad;
          if (ae > 8) o.gt8++;
          if (ae > 16) o.gt16++;
        };
        put(all);
        put(d > 0 ? trail : lead);
        for (let b = 0; b < bins.length; b++) { if (ad <= bins[b]) { put(speed[b]); break; } }
      }
    }

    const fin = (o) => ({
      ghost: o.den > 0 ? +(o.num / o.den).toFixed(4) : null,
      px: o.npx,
      meanErr: +(o.sumE / Math.max(1, o.npx)).toFixed(3),
      meanAbsErr: +(o.sumAbsE / Math.max(1, o.npx)).toFixed(3),
      meanMotion: +(o.sumAbsD / Math.max(1, o.npx)).toFixed(3),
      gt8: o.gt8, gt16: o.gt16,
    });

    // WORST BLOCK = the 16x16 tile with the highest LOCAL ghost coefficient,
    // not the highest raw difference. Raw |G-C| is dominated by legitimate
    // anti-aliasing; the local least-squares projection is dominated by stale
    // history, which is the thing being hunted. A minimum motion energy keeps
    // near-static tiles out (a tiny denominator makes any ratio look big).
    let best = -1, bestV = -1e9, bestDen = 0;
    const minDen = 256 * 40 * 40;
    for (let b = 0; b < blkNum.length; b++) {
      if (blkDen[b] < minDen) continue;
      const v = blkNum[b] / blkDen[b];
      if (v > bestV) { bestV = v; best = b; bestDen = blkDen[b]; }
    }
    return {
      all: fin(all), trail: fin(trail), lead: fin(lead),
      speed: speed.map((o, k) => ({ upTo: bins[k], ...fin(o) })),
      worstBlock: best >= 0
        ? { x: (best % bw) * bs, y: ((best / bw) | 0) * bs, ghost: +bestV.toFixed(4), motionRms: +Math.sqrt(bestDen / (bs * bs)).toFixed(2) }
        : { x: 0, y: 0, ghost: null, motionRms: 0 },
      curLuma: C,
    };
  };

  const frames = [];
  let prevL = null;
  let nullResult = null;
  for (let f = 0; f < S.G.length; f++) {
    const r = score(S.G[f], S.N[f], prevL || luma(S.N[f]));
    if (prevL !== null) {
      frames.push({ idx: f, meta: S.meta[f], all: r.all, trail: r.trail, lead: r.lead, speed: r.speed, worstBlock: r.worstBlock });
      if (S.nullIdx === f && S.nullPair) {
        // Same estimator, same previous frame, but the arm is a re-render of the
        // no-TAA frame. Every output must be ~0.
        const nr = score(S.nullPair[1], S.nullPair[0], prevL);
        nullResult = { frame: f, all: nr.all, trail: nr.trail, worstBlockGhost: nr.worstBlock.ghost };
      }
    }
    prevL = r.curLuma;
  }
  return { w, h, frames, estimatorNull: nullResult };
}

/** NULL control: two back-to-back no-TAA renders of the same frame. */
function pageNull() {
  const S = window.__gh;
  const [a, b] = S.nullPair;
  let diff = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 0) diff++;
    if (d > max) max = d;
  }
  return { differingBytes: diff, totalBytes: a.length, maxDelta: max, identical: diff === 0 };
}

/** Montage: bare | TAA | amplified signed difference, zoomed, at fight framing. */
function pageMontage(a) {
  const S = window.__gh;
  const w = S.w, h = S.h;
  const { f, x, y, cw, ch, zoom, amp } = a;
  const cv = document.createElement('canvas');
  const pad = 8, labelH = 22;
  cv.width = cw * zoom * 3 + pad * 4;
  cv.height = ch * zoom + pad * 2 + labelH;
  const g = cv.getContext('2d');
  g.fillStyle = '#101014';
  g.fillRect(0, 0, cv.width, cv.height);
  g.imageSmoothingEnabled = false;

  const src = [S.N[f], S.G[f]];
  const tmp = document.createElement('canvas');
  tmp.width = cw; tmp.height = ch;
  const tg = tmp.getContext('2d');

  const draw = (px, col, transform) => {
    const img = tg.createImageData(cw, ch);
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const si = ((y + yy) * w + (x + xx)) * 4;
        const di = (yy * cw + xx) * 4;
        transform(px, si, img.data, di);
      }
    }
    tg.putImageData(img, 0, 0);
    g.drawImage(tmp, 0, 0, cw, ch, pad + col * (cw * zoom + pad), pad, cw * zoom, ch * zoom);
  };

  draw(src[0], 0, (p, si, o, di) => { o[di] = p[si]; o[di + 1] = p[si + 1]; o[di + 2] = p[si + 2]; o[di + 3] = 255; });
  draw(src[1], 1, (p, si, o, di) => { o[di] = p[si]; o[di + 1] = p[si + 1]; o[di + 2] = p[si + 2]; o[di + 3] = 255; });
  // signed difference TAA - bare, amplified: red = TAA brighter (stale light
  // surviving = trail), blue = TAA darker (erosion).
  {
    const img = tg.createImageData(cw, ch);
    const A = S.N[f], B = S.G[f];
    for (let yy = 0; yy < ch; yy++) {
      for (let xx = 0; xx < cw; xx++) {
        const si = ((y + yy) * w + (x + xx)) * 4;
        const di = (yy * cw + xx) * 4;
        const la = 0.2126 * A[si] + 0.7152 * A[si + 1] + 0.0722 * A[si + 2];
        const lb = 0.2126 * B[si] + 0.7152 * B[si + 1] + 0.0722 * B[si + 2];
        const d = (lb - la) * amp;
        img.data[di] = Math.max(0, Math.min(255, 16 + Math.max(0, d)));
        img.data[di + 1] = 16;
        img.data[di + 2] = Math.max(0, Math.min(255, 16 + Math.max(0, -d)));
        img.data[di + 3] = 255;
      }
    }
    tg.putImageData(img, 0, 0);
    g.drawImage(tmp, 0, 0, cw, ch, pad + 2 * (cw * zoom + pad), pad, cw * zoom, ch * zoom);
  }

  g.fillStyle = '#e8e8ee';
  g.font = '13px monospace';
  const ty = ch * zoom + pad + 16;
  g.fillText('NO TAA (shipped chain, pass skipped)', pad, ty);
  g.fillText('TAA (shipped)', pad + (cw * zoom + pad), ty);
  g.fillText('TAA - noTAA, x' + amp + '  red=stale light  blue=erosion', pad + 2 * (cw * zoom + pad), ty);
  return cv.toDataURL('image/png');
}

/** Whole frame as PNG, upscaled to the presentation size. */
function pageFull(a) {
  const S = window.__gh;
  const px = a.arm === 'G' ? S.G[a.f] : S.N[a.f];
  const tmp = document.createElement('canvas');
  tmp.width = S.w; tmp.height = S.h;
  const tg = tmp.getContext('2d');
  const img = tg.createImageData(S.w, S.h);
  img.data.set(px);
  tg.putImageData(img, 0, 0);
  const out = document.createElement('canvas');
  out.width = a.outW; out.height = a.outH;
  const og = out.getContext('2d');
  og.drawImage(tmp, 0, 0, a.outW, a.outH);
  return out.toDataURL('image/png');
}

/** Fight-framing check: screen pixels per metre on the subject. */
function pageFraming() {
  const KB = window.KB, THREE = KB.THREE;
  const f = KB.fighters[0];
  const box = new THREE.Box3().setFromObject(f.robot.group);
  const c = box.getCenter(new THREE.Vector3());
  const top = new THREE.Vector3(c.x, c.y + 0.5, c.z).project(KB.camera);
  const bot = new THREE.Vector3(c.x, c.y - 0.5, c.z).project(KB.camera);
  const cssH = KB.renderer._cssHeight || window.innerHeight;
  return {
    dist: +KB.camera.position.distanceTo(c).toFixed(3),
    fov: +KB.camera.fov.toFixed(2),
    pxPerMetreCss: +(Math.abs(top.y - bot.y) * 0.5 * cssH).toFixed(1),
    canvas: [KB.renderer.canvas.width, KB.renderer.canvas.height],
    css: [KB.renderer._cssWidth, KB.renderer._cssHeight],
  };
}

function pageSetMode(want) {
  const r = window.KB.renderer;
  for (const k of Object.keys(want)) r.setEffect(k, !!want[k]);
  return {
    keys: Object.keys(r._passes).join(','),
    armed: r.composer.passes.map((p) => p.constructor.name).join(' '),
  };
}

function pageFree() { window.__gh = null; }

/* =========================================================================
 * DRIVER
 * ====================================================================== */

async function main() {
  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();
  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--enable-zero-copy', '--disable-frame-rate-limit',
      '--force-device-scale-factor=1', '--js-flags=--max-old-space-size=6144'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  const report = {
    what: 'ghost/smear hunt on the temporal pass, shipped chain, fight framing',
    reference: 'no-TAA arm is the SHIPPED chain with only the temporal pass skipped -- AO, bloom, DOF, CAMERA MOTION BLUR and grade all still on. Every number is what TAA adds ON TOP of the motion blur already shipping.',
    renderScale: SCALE, windowFrames: COUNT, grain: 'disabled for measurement',
    arms: {}, controls: {}, defects: [], framing: null,
  };
  const pngs = {};

  try {
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
    await page.waitForTimeout(2500);

    const setup = await page.evaluate(pageSetMode, {
      ao: true, bloom: true, dof: true, motionBlur: true, grade: true, smaa: true, taa: true,
    });
    report.controls.setup_shipped = setup;
    if (setup.keys !== EXPECT_SHIPPED) {
      report.defects.push('SETUP CONTROL FAILED: armed pass list [' + setup.keys + '] != [' + EXPECT_SHIPPED + ']');
    }

    const BINS = [24, 48, 96, 1e9];

    const arms = [
      { id: 'launcher_shipped', scenario: 'launcher', opts: {} },
      { id: 'launcher_noclamp', scenario: 'launcher', opts: { clamp: 0, feedback: 0.97 } },   // POSITIVE
      { id: 'launcher_fb0', scenario: 'launcher', opts: { feedback: 0 } },                    // FLOOR
      { id: 'fight_shipped', scenario: 'fight', opts: {} },
      { id: 'fight_noclamp', scenario: 'fight', opts: { clamp: 0, feedback: 0.97 } },
    ].filter((a) => !ONLY || ONLY.split(',').includes(a.id));

    for (const armSpec of arms) {
      const cap = await page.evaluate(pageCapture, {
        scale: SCALE, warm: WARM, count: COUNT, scenario: armSpec.scenario, ...armSpec.opts,
      });
      if (cap.passKeys !== EXPECT_SHIPPED) {
        report.defects.push('VOID ARM ' + armSpec.id + ': [' + cap.passKeys + '] != [' + EXPECT_SHIPPED + ']');
      }
      if (cap.taa && cap.taa.enabled !== true) {
        report.defects.push('VOID ARM ' + armSpec.id + ': taa.enabled was left false at capture');
      }
      const nul = await page.evaluate(pageNull);
      const an = await page.evaluate(pageAnalyse, { thr: 12, bins: BINS });
      if (!report.framing) report.framing = await page.evaluate(pageFraming);

      // worst frame by the worst LOCAL ghost block -- the actual smear
      let worst = null;
      for (const fr of an.frames) {
        const s = fr.worstBlock.ghost === null ? -9 : fr.worstBlock.ghost;
        if (!worst || s > worst.score) worst = { score: s, fr };
      }
      // and the frame with the most fast-moving pixels -- the punch
      let fastest = null;
      for (const fr of an.frames) {
        const fast = fr.speed[fr.speed.length - 1].px + fr.speed[fr.speed.length - 2].px;
        if (!fastest || fast > fastest.fast) fastest = { fast, fr };
      }

      report.arms[armSpec.id] = {
        capture: { w: cap.w, h: cap.h, frames: cap.frames, renderScale: cap.renderScale, taa: cap.taa, jitterScale: cap.jitterScale },
        nullControl: nul,
        estimatorNull: an.estimatorNull,
        frames: an.frames,
        worstGhostFrame: worst.fr.idx,
        fastestFrame: fastest.fr.idx,
      };
      if (!nul.identical) {
        report.defects.push('NULL CONTROL (' + armSpec.id + '): two back-to-back no-TAA renders differ on ' +
          nul.differingBytes + '/' + nul.totalBytes + ' bytes, max ' + nul.maxDelta + ' (planar reflector cache is a known source; see ssgate)');
      }
      const en = an.estimatorNull;
      console.log('   NULL estimator on a re-render of the no-TAA frame: all g=' + en.all.ghost +
        ' trail g=' + en.trail.ghost + ' |e|=' + en.all.meanAbsErr + ' >8=' + en.all.gt8 + ' worstBlock g=' + en.worstBlockGhost);
      if (Math.abs(en.all.ghost) > 0.01) {
        report.defects.push('ESTIMATOR NULL FAILED (' + armSpec.id + '): ' + en.all.ghost + ' on a no-TAA re-render, expected ~0');
      }

      console.log('[ghosthunt] ' + armSpec.id.padEnd(18) + ' ' + cap.w + 'x' + cap.h +
        ' taa=' + JSON.stringify(cap.taa) + ' null=' + (nul.identical ? 'EXACT' : nul.differingBytes + 'B'));
      for (const fr of an.frames) {
        console.log('   f' + String(fr.idx).padStart(2) + ' tick' + String(fr.meta.tick).padStart(5) +
          ' hs' + String(fr.meta.hitstop).padStart(2) +
          ' | all g=' + String(fr.all.ghost).padStart(7) + ' n=' + String(fr.all.px).padStart(7) +
          ' |e|=' + String(fr.all.meanAbsErr).padStart(6) + ' >8=' + String(fr.all.gt8).padStart(6) +
          ' | trail g=' + String(fr.trail.ghost).padStart(7) + ' me=' + String(fr.trail.meanErr).padStart(7) +
          ' | fast(>96) g=' + String(fr.speed[3].ghost).padStart(7) + ' n=' + String(fr.speed[3].px).padStart(6) +
          ' | blk g=' + String(fr.worstBlock.ghost).padStart(7) + ' @' + fr.worstBlock.x + ',' + fr.worstBlock.y);
      }

      if (PNG_OUT) {
        for (const [tag, idx] of [['worst', worst.fr.idx], ['fast', fastest.fr.idx]]) {
          const fr = an.frames.find((x) => x.idx === idx);
          const bx = Math.max(0, Math.min(an.w - 200, fr.worstBlock.x - 92));
          const by = Math.max(0, Math.min(an.h - 160, fr.worstBlock.y - 72));
          pngs[armSpec.id + '_' + tag + '_f' + idx + '_zoom'] =
            await page.evaluate(pageMontage, { f: idx, x: bx, y: by, cw: 200, ch: 160, zoom: 4, amp: 6 });
          pngs[armSpec.id + '_' + tag + '_f' + idx + '_taa'] =
            await page.evaluate(pageFull, { f: idx, arm: 'G', outW: WIDTH, outH: HEIGHT });
          pngs[armSpec.id + '_' + tag + '_f' + idx + '_bare'] =
            await page.evaluate(pageFull, { f: idx, arm: 'N', outW: WIDTH, outH: HEIGHT });
        }
      }
      await page.evaluate(pageFree);
    }
  } finally {
    report.errors = errs.slice(0, 8);
    await browser.close();
    await server.close();
  }

  if (PNG_OUT) {
    mkdirSync(resolve(ROOT, PNG_OUT), { recursive: true });
    for (const [k, v] of Object.entries(pngs)) {
      writeFileSync(resolve(ROOT, PNG_OUT, k + '.png'), Buffer.from(v.split(',')[1], 'base64'));
    }
    console.log('PNGs -> ' + PNG_OUT);
  }
  if (JSON_OUT) {
    mkdirSync(dirname(resolve(ROOT, JSON_OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
    console.log('report -> ' + JSON_OUT);
  }
  console.log('\nframing: ' + JSON.stringify(report.framing));
  if (report.defects.length) { console.log('DEFECTS:'); for (const d of report.defects) console.log('  ! ' + d); }
  if (report.errors && report.errors.length) console.log('page errors: ' + JSON.stringify(report.errors));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
