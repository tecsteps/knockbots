/**
 * movegate -- THE PROJECT'S OWN GATE METRIC, ON A FRAME WHERE THE FIGHTERS MOVE.
 *
 * tools/taagate.mjs scores RMSE against the 4x-integrated frame over subject
 * pixels WITH THE SIM FROZEN. That is the right way to score anti-aliasing, it
 * is the metric this project decided on, and it is the only condition the
 * temporal pass has ever been scored under. A temporal pass is exactly the kind
 * of change whose cost does not exist until the scene moves.
 *
 * This runs THE SAME METRIC, on THE SAME scene state, under two histories:
 *
 *   A_moving   the temporal frame a player actually gets: history accumulated
 *              over a real moving sequence -- a launcher landing, its hitstop,
 *              its spark burst and the victim leaving the ground.
 *   A_static   the temporal frame taagate scores: sim frozen on that exact same
 *              state, history rebuilt from scratch over 56 still frames.
 *   B_bare     the same chain with no temporal pass.
 *   C_truth    the same state at 4x, box-integrated down. Zero by construction;
 *              aliasing counts as error, per the charter.
 *
 * A_static is the in-session reproduction of the shipped claim. If A_static
 * beats B_bare and A_moving does not, the gate was measured under the one
 * condition a fighting game is never in.
 *
 * ---------------------------------------------------------------------------
 * THE CAMERA IS PINNED, AND THAT IS WHAT MAKES THIS FAIR
 * ---------------------------------------------------------------------------
 * The chains are taagate's own: 'render,output' and 'render,taa,output'. They
 * hold a BIT-EXACT null at 0.85 and at 4x, which is why they are used -- the
 * chains with a ScenePass do not, and a reference arm that cannot reproduce
 * itself cannot score anything (measured: see the note at the bottom).
 *
 * Those chains have no depth texture, so the temporal pass gets no camera
 * reprojection. That would be a rigged fight against a MOVING camera. So the
 * camera does not move: its transform is restored from a snapshot before every
 * render for the whole run. With a static camera the correct reprojection of
 * any static point IS the identity, which is exactly what the pass does when
 * uHasDepth is 0. The pass is therefore given everything reprojection could
 * have given it, and what remains under test is the one thing it genuinely does
 * not have: PER-OBJECT VELOCITY. Which is the thing a fighting game is made of.
 *
 * The fighters, the FX and the sim all keep running at 60 Hz.
 *
 * ---------------------------------------------------------------------------
 * CONTROLS
 * ---------------------------------------------------------------------------
 *   SETUP-1  pass list read off composer.passes (never off the flags), asserted
 *            per arm, and only ever changed through setEffect.
 *   SETUP-2  drawing buffer size asserted per arm; an unscaled truth is a
 *            silent no-op.
 *   SETUP-3  the camera pin verified by measurement: max drift over the run,
 *            in metres and degrees, must be 0.
 *   NULL     C_truth rendered twice. Must be ~0.
 *   POSITIVE a 1px box blur of B_bare must score WORSE than B_bare. If a blur
 *            cannot move the metric, the metric cannot see the defect.
 *   MOTION   the share of subject pixels that changed between T-1 and T, so
 *            'moving' is a measurement and not a caption.
 *   CONVERGE A_static is also captured at half the warm count; the two must
 *            agree, or the frozen arm is a transient rather than a limit.
 *
 *   node tools/movegate.mjs --json scratchpad/movegate.json --png scratchpad/mg
 *
 * NOTE ON A DEAD END, KEPT BECAUSE IT COST TWO RUNS. The first version used the
 * SHIPPED chain and pinned MotionBlurPass._prevViewProjection so every arm
 * would carry the same camera blur. Its truth arm then failed its own null by
 * 32.99 rmse on subject pixels -- more than the whole signal -- and every
 * number it produced was void. The cause was the pin itself: taken before the
 * pass had ever been primed, it fed an identity matrix. Isolated by rendering
 * one frozen frame twice per chain:
 *     bare / +grade / +ao / +dof / +bloom        rmse 0.0000  (all scales)
 *     +motionBlur with the bad pin, 0.85         rmse 0.6351
 *     +motionBlur with the bad pin, 4x           rmse 20.8936
 *     +motionBlur, pin taken after one render    rmse 0.0000
 * The lesson is the project's own: assert the setup, not just the measurement.
 *
 * NOTE: page-side code is passed as FUNCTIONS, never as template strings. No
 * backtick may enter shader-adjacent text in this repo.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(arg('port', 5333));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const JSON_OUT = arg('json', '');
const PNG_OUT = arg('png', '');
const SCALE = Number(arg('scale', 0.85));
const TRUTH = Number(arg('truth', 4));
const WARM = Number(arg('warm', 60));
const AFTER = Number(arg('after', 16));
const WARM_TAA = Number(arg('warmtaa', 56));
const WARM_BARE = Number(arg('warmbare', 16));
const SCENARIO = arg('scenario', 'launcher');
const OFF_BY = Number(arg('offby', 8));

const CHAIN = arg('chain', 'iso');
/**
 * 'iso'     scale-invariant chain: render + taa + output. Holds a bit-exact
 *           null at 0.85 and at 4x. This is the one the verdict rests on.
 * 'shipped' the chain a player runs. ao/bloom/dof are resolution-dependent, so
 *           the 4x reference is NOT a clean truth for it and the absolute
 *           numbers are inflated for BOTH arms. Kept only to confirm that the
 *           defect the iso chain measures is visible in the shipped one too --
 *           the images are the point here, not the RMSE.
 */
const CHAINS = {
  iso: { base: { ao: false, bloom: false, dof: false, motionBlur: false, grade: false, smaa: false },
    taaKeys: 'render,taa,output', bareKeys: 'render,output' },
  shipped: { base: { ao: true, bloom: true, dof: true, motionBlur: true, grade: true, smaa: true },
    taaKeys: 'scene,gbuffer,ao,bloom,dof,motionBlur,taa,grade,output',
    bareKeys: 'scene,gbuffer,ao,bloom,dof,motionBlur,grade,smaa,output' },
};
const EXPECT_TAA = CHAINS[CHAIN].taaKeys;
const EXPECT_BARE = CHAINS[CHAIN].bareKeys;

/* =========================================================================
 * PAGE-SIDE
 * ====================================================================== */

function pageInstall() {
  const KB = window.KB, r = KB.renderer;

  window.__mgRead = (W, H, wantPng) => {
    const gl = r.canvas, sw = gl.width, sh = gl.height;
    const tmp = window.__mgTmp || (window.__mgTmp = document.createElement('canvas'));
    if (tmp.width !== sw || tmp.height !== sh) { tmp.width = sw; tmp.height = sh; }
    const t = tmp.getContext('2d', { willReadFrequently: true });
    t.imageSmoothingEnabled = false;
    t.globalCompositeOperation = 'source-over';
    t.fillStyle = '#000'; t.fillRect(0, 0, sw, sh);
    t.drawImage(gl, 0, 0);
    const plane = new Float32Array(W * H);
    const R = 0.2126, G = 0.7152, B = 0.0722;
    if (sw >= W && sw % W === 0 && sh % H === 0) {
      const k = sw / W;
      for (let oy = 0; oy < H; oy++) {
        const band = t.getImageData(0, oy * k, sw, k).data;
        const row = oy * W;
        for (let ox = 0; ox < W; ox++) {
          let acc = 0;
          for (let j = 0; j < k; j++) {
            let p = (j * sw + ox * k) * 4;
            for (let i = 0; i < k; i++, p += 4) acc += R * band[p] + G * band[p + 1] + B * band[p + 2];
          }
          plane[row + ox] = acc / (k * k);
        }
      }
    } else {
      const src = t.getImageData(0, 0, sw, sh).data;
      const sl = new Float32Array(sw * sh);
      for (let i = 0, p = 0; i < sl.length; i++, p += 4) sl[i] = R * src[p] + G * src[p + 1] + B * src[p + 2];
      const fx = sw / W, fy = sh / H;
      for (let oy = 0; oy < H; oy++) {
        const sy = Math.min(sh - 1, Math.max(0, (oy + 0.5) * fy - 0.5));
        const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), wy = sy - y0;
        for (let ox = 0; ox < W; ox++) {
          const sx = Math.min(sw - 1, Math.max(0, (ox + 0.5) * fx - 0.5));
          const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), wx = sx - x0;
          const a = sl[y0 * sw + x0], b = sl[y0 * sw + x1];
          const c = sl[y1 * sw + x0], d = sl[y1 * sw + x1];
          plane[oy * W + ox] = (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
        }
      }
    }
    return { plane, rendered: sw + 'x' + sh, png: wantPng ? tmp.toDataURL('image/png') : null };
  };

  window.__mgMask = (W, H) => {
    const THREE = KB.THREE, gl = r.renderer, scene = KB.scene, cam = KB.camera;
    const roots = KB.fighters.map((f) => f.robot && f.robot.group).filter(Boolean);
    if (roots.length !== KB.fighters.length) throw new Error('fighter roots not resolvable');
    const rootSet = new Set(roots);
    const keep = new Set();
    for (const rt of roots) { let o = rt.parent; while (o) { keep.add(o); o = o.parent; } }
    const hidden = [];
    const walk = (o) => {
      for (const c of o.children) {
        if (rootSet.has(c)) continue;
        if (keep.has(c)) { walk(c); continue; }
        if (c.visible) { hidden.push(c); c.visible = false; }
      }
    };
    walk(scene);
    const sOv = scene.overrideMaterial, sBg = scene.background, sEnv = scene.environment, sFog = scene.fog;
    const sSh = gl.shadowMap.enabled, sAuto = gl.autoClear, sLayers = cam.layers.mask;
    const sClear = new THREE.Color();
    gl.getClearColor(sClear);
    const sAlpha = gl.getClearAlpha(), sTgt = gl.getRenderTarget();
    const flat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false });
    scene.overrideMaterial = flat;
    scene.background = null; scene.environment = null; scene.fog = null;
    cam.layers.enableAll();
    gl.shadowMap.enabled = false; gl.autoClear = true;
    gl.setClearColor(0x000000, 1);
    gl.setRenderTarget(null);
    gl.render(scene, cam);
    const out = window.__mgRead(W, H, false);
    scene.overrideMaterial = sOv; scene.background = sBg; scene.environment = sEnv; scene.fog = sFog;
    gl.shadowMap.enabled = sSh; gl.autoClear = sAuto;
    cam.layers.mask = sLayers;   // MUST be restored: A_static is captured after the mask
    gl.setClearColor(sClear, sAlpha);
    gl.setRenderTarget(sTgt);
    flat.dispose();
    for (const o of hidden) o.visible = true;
    const cov = out.plane;
    const mask = new Uint8Array(cov.length);
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < cov.length; i++) {
      if (cov[i] > 0.255) {
        mask[i] = 1; n++;
        const x = i % W, y = (i / W) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    window.__mgCov = cov;
    return { mask, subjectPx: n, rendered: out.rendered, bbox: [x0, y0, x1, y1] };
  };

  window.__mgState = { planes: {}, meta: {} };
  return { ok: true };
}

function pageSetMode(want) {
  const r = window.KB.renderer;
  for (const k of Object.keys(want)) r.setEffect(k, !!want[k]);
  return {
    keys: Object.keys(r._passes).join(','),
    armed: r.composer.passes.map((p) => p.constructor.name).join(' '),
  };
}

/**
 * Run the fight with the camera pinned, then take every arm out of frame T.
 */
function pageRun(o) {
  const KB = window.KB, r = KB.renderer;
  const S = window.__mgState;
  const W = o.W, H = o.H;
  const THREE = KB.THREE;

  r.effects.adaptiveResolution = false;
  r.renderScale = o.scale; r._targetScale = o.scale; r.resize();
  if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });

  KB.menus.show(null);
  KB.debug.freecam = false;
  KB.paused = false;
  KB.startMatch(0, 1);
  KB.setPhase('fight');
  KB.timeScale = 1;
  if (!window.__mgDelta) window.__mgDelta = KB.clock.getDelta.bind(KB.clock);
  KB.clock.getDelta = () => 1 / 60;

  const taa = r._passes.taa;
  if (!taa) throw new Error('no taa pass');
  taa.invalidate();
  r._jitterIndex = 0;

  const orig = r.render.bind(r);
  const stage = KB.stage;
  const snap = () => ({
    keys: Object.keys(r._passes).join(','),
    armed: r.composer.passes.map((p) => p.constructor.name).join(' '),
    buffer: r.canvas.width + 'x' + r.canvas.height,
    renderScale: r.renderScale,
    jitterScale: r.taaJitterScale,
    taaPresent: !!r._passes.taa,
    hasDepth: r._passes.taa ? r._passes.taa.uniforms.uHasDepth.value : null,
    feedback: r._passes.taa ? r._passes.taa.uniforms.uFeedback.value : null,
  });

  return new Promise((done) => {
    let frames = 0, fired = false;
    let pin = null;
    let maxDrift = 0, maxTurn = 0;
    let prevBare = null;
    /** SETUP-3 proper: the matrix the RENDER actually saw, every frame. */
    const sigs = new Set();

    /** SETUP-3: hold the camera exactly still, and measure that it held. */
    const holdCamera = (cam) => {
      if (!pin) {
        pin = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov, zoom: cam.zoom };
        return;
      }
      const d = cam.position.distanceTo(pin.p);
      const a = 2 * Math.acos(Math.min(1, Math.abs(cam.quaternion.dot(pin.q)))) * 180 / Math.PI;
      if (d > maxDrift) maxDrift = d;
      if (a > maxTurn) maxTurn = a;
      cam.position.copy(pin.p);
      cam.quaternion.copy(pin.q);
      cam.fov = pin.fov; cam.zoom = pin.zoom;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
      sigs.add(cam.matrixWorld.elements.join(',') + '|' + cam.projectionMatrix.elements.join(','));
    };

    const step = () => {
      holdCamera(KB.camera);
      if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
      orig(KB.scene, KB.camera, 1 / 60);
    };
    const warm = (k) => {
      if (stage && stage.reflector && typeof stage.reflector.invalidate === 'function') stage.reflector.invalidate();
      for (let i = 0; i < k; i++) step();
    };

    r.render = (scene, cam, dt) => {
      holdCamera(cam);
      orig(scene, cam, dt);
      frames++;

      // Pin only from the frame the measurement window opens on, so the fight
      // is staged from a real camera and then frozen there.
      if (!fired && frames === o.warm) {
        if (o.scenario === 'launcher') KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });
        fired = true;
        pin = null;           // re-pin on the staged camera, once
        maxDrift = 0; maxTurn = 0; sigs.clear();   // measure the hold from there
        taa.invalidate();
        r._jitterIndex = 0;
      }

      const target = o.warm + o.after;
      if (frames === target - 1) {
        prevBare = null;      // filled below, from a bare render of T-1
        const we = taa.enabled, wj = r.taaJitterScale, wi = r._jitterIndex;
        taa.enabled = false; r.taaJitterScale = 0;
        step();
        prevBare = window.__mgRead(W, H, false).plane;
        taa.enabled = we; r.taaJitterScale = wj; r._jitterIndex = wi;
        return;
      }
      if (frames < target) return;

      // ---------------- frame T ----------------
      r.render = orig;
      KB.paused = true;
      // STOP THE LOOP, not just the sim. KB.paused only holds the fixed-step
      // accumulator: Game#render still advances the animators, the particle
      // systems and the camera spring every rAF. With the arms taken from
      // separate evaluate calls, that ran BETWEEN them -- and the truth arm
      // failed its own null by 5.93 rmse with the camera 0.56 m adrift. Cutting
      // the rAF is the only thing that actually freezes the frame.
      if (typeof KB.stop === 'function') KB.stop();

      const a1 = window.__mgRead(W, H, o.png);
      S.planes.A_moving = a1.plane;
      S.meta.A_moving = { ...snap(), rendered: a1.rendered };
      if (o.png) S.pngA = a1.png;
      S.planes.prevBare = prevBare;

      done({
        frames, tick: KB.tick, hitstop: KB.hitstopTicks | 0,
        states: KB.fighters.map((f) => f.state),
        y: KB.fighters.map((f) => +f.position.y.toFixed(3)),
        camDriftM: +maxDrift.toFixed(6), camDriftDeg: +maxTurn.toFixed(6),
        distinctRenderCameras: sigs.size,
        meta: S.meta,
        // hand the helpers to the driver for the frozen arms
        ready: true,
      });
      window.__mgStep = step;
      window.__mgWarm = warm;
      window.__mgSnap = snap;
    };
  });
}

/** Capture one frozen arm. Chain changes go through setEffect only. */
function pageArm(o) {
  const KB = window.KB, r = KB.renderer;
  const S = window.__mgState;
  for (const k of Object.keys(o.want)) r.setEffect(k, !!o.want[k]);
  const taa = r._passes.taa;
  if (taa) { taa.invalidate(); r._jitterIndex = 0; }
  r.taaJitterScale = 1;
  r.renderScale = o.scale; r._targetScale = o.scale; r.resize();
  window.__mgWarm(o.warm);
  const out = window.__mgRead(o.W, o.H, o.png);
  S.planes[o.label] = out.plane;
  S.meta[o.label] = { ...window.__mgSnap(), rendered: out.rendered, warm: o.warm };
  if (o.png) S['png_' + o.label] = out.png;
  return S.meta[o.label];
}

function pageMask(o) {
  const S = window.__mgState;
  const m = window.__mgMask(o.W, o.H);
  S.mask = m.mask;
  S.planes.MASK = window.__mgCov;
  return { subjectPx: m.subjectPx, rendered: m.rendered, bbox: m.bbox,
           pctOfFrame: +((100 * m.subjectPx) / (o.W * o.H)).toFixed(2) };
}

function pageCompare(a) {
  const S = window.__mgState;
  const X = S.planes[a.label], C = S.planes[a.ref], M = S.mask;
  if (!X || !C) throw new Error('missing plane ' + a.label);
  let sAll = 0, sSub = 0, n = 0, off = 0, maxE = 0, mae = 0;
  for (let i = 0; i < X.length; i++) {
    const d = X[i] - C[i];
    sAll += d * d;
    const ad = d < 0 ? -d : d;
    if (ad > maxE) maxE = ad;
    if (M[i]) { sSub += d * d; n++; mae += ad; if (ad > a.offBy) off++; }
  }
  return {
    rmseAll: +Math.sqrt(sAll / X.length).toFixed(4),
    rmseSubject: +Math.sqrt(sSub / Math.max(1, n)).toFixed(4),
    maeSubject: +(mae / Math.max(1, n)).toFixed(4),
    offBySubject: off, subjectPx: n, maxErr: +maxE.toFixed(3),
  };
}

function pageBlur(a) {
  const S = window.__mgState;
  const src = S.planes[a.from], W = a.W, H = a.H;
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          s += src[yy * W + xx]; c++;
        }
      }
      out[y * W + x] = s / c;
    }
  }
  S.planes[a.to] = out;
  return { ok: true };
}

function pageMotion(a) {
  const S = window.__mgState;
  const P = S.planes.prevBare, C = S.planes.B_bare, M = S.mask;
  let n = 0, moved = 0, sum = 0, fast = 0;
  for (let i = 0; i < C.length; i++) {
    if (!M[i]) continue;
    n++;
    const d = Math.abs(P[i] - C[i]);
    sum += d;
    if (d > a.thr) moved++;
    if (d > 48) fast++;
  }
  return {
    subjectPx: n, movedPx: moved, movedPct: +((100 * moved) / Math.max(1, n)).toFixed(2),
    fastPx: fast, meanChange: +(sum / Math.max(1, n)).toFixed(3),
  };
}

/** The 16x16 subject block where A_moving loses to B_bare by the most. */
function pageWorstBlock(a) {
  const S = window.__mgState;
  const A = S.planes.A_moving, B = S.planes.B_bare, C = S.planes.C_truth, M = S.mask;
  const W = a.W, H = a.H, bs = 16, bw = Math.ceil(W / bs);
  const eA = new Float64Array(bw * Math.ceil(H / bs)), eB = new Float64Array(bw * Math.ceil(H / bs));
  const cnt = new Float64Array(eA.length);
  for (let y = 0; y < H; y++) {
    const by = (y / bs) | 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!M[i]) continue;
      const b = by * bw + ((x / bs) | 0);
      eA[b] += (A[i] - C[i]) * (A[i] - C[i]);
      eB[b] += (B[i] - C[i]) * (B[i] - C[i]);
      cnt[b]++;
    }
  }
  const rows = [];
  for (let b = 0; b < eA.length; b++) {
    if (cnt[b] < bs * bs * 0.6) continue;
    rows.push({ b, d: Math.sqrt(eA[b] / cnt[b]) - Math.sqrt(eB[b] / cnt[b]), a: Math.sqrt(eA[b] / cnt[b]), bb: Math.sqrt(eB[b] / cnt[b]) });
  }
  rows.sort((p, q) => q.d - p.d);
  return rows.slice(0, 5).map((x) => ({
    x: (x.b % bw) * bs, y: ((x.b / bw) | 0) * bs,
    rmse_taa: +x.a.toFixed(2), rmse_bare: +x.bb.toFixed(2), worseBy: +x.d.toFixed(2),
  }));
}

/** |arm - truth| as a viewable plane, amplified, masked to the subject. */
function pageErrPlanes(a) {
  const S = window.__mgState;
  const C = S.planes.C_truth, M = S.mask;
  for (const L of ['A_moving', 'B_bare', 'A_static']) {
    const X = S.planes[L];
    const out = new Float32Array(X.length);
    for (let i = 0; i < X.length; i++) out[i] = M[i] ? Math.min(255, Math.abs(X[i] - C[i]) * a.amp) : 0;
    S.planes['ERR_' + L] = out;
  }
  return { ok: true };
}

/** The 96x72 subject window with the most TAA-vs-bare error excess. */
function pageWorstWindow(a) {
  const S = window.__mgState;
  const A = S.planes.A_moving, B = S.planes.B_bare, C = S.planes.C_truth, M = S.mask;
  const W = a.W, H = a.H, bs = 24, bw = Math.ceil(W / bs), bh = Math.ceil(H / bs);
  const d = new Float64Array(bw * bh);
  for (let y = 0; y < H; y++) {
    const by = (y / bs) | 0;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!M[i]) continue;
      d[by * bw + ((x / bs) | 0)] += Math.abs(A[i] - C[i]) - Math.abs(B[i] - C[i]);
    }
  }
  // 4x3 tile window sum
  let best = null;
  for (let by = 0; by + 3 <= bh; by++) {
    for (let bx = 0; bx + 4 <= bw; bx++) {
      let s = 0;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) s += d[(by + j) * bw + bx + i];
      if (!best || s > best.s) best = { s, x: bx * bs, y: by * bs };
    }
  }
  return best;
}

function pageCrops(a) {
  const S = window.__mgState;
  const W = a.W;
  const cv = document.createElement('canvas');
  const pad = 8, lab = 22;
  cv.width = a.cw * a.zoom * a.labels.length + pad * (a.labels.length + 1);
  cv.height = a.ch * a.zoom + pad * 2 + lab;
  const g = cv.getContext('2d');
  g.fillStyle = '#101014'; g.fillRect(0, 0, cv.width, cv.height);
  g.imageSmoothingEnabled = false;
  const tmp = document.createElement('canvas');
  tmp.width = a.cw; tmp.height = a.ch;
  const tg = tmp.getContext('2d');
  a.labels.forEach((L, k) => {
    const p = S.planes[L];
    const img = tg.createImageData(a.cw, a.ch);
    for (let y = 0; y < a.ch; y++) {
      for (let x = 0; x < a.cw; x++) {
        const v = Math.max(0, Math.min(255, p[(a.y + y) * W + (a.x + x)]));
        const d = (y * a.cw + x) * 4;
        img.data[d] = v; img.data[d + 1] = v; img.data[d + 2] = v; img.data[d + 3] = 255;
      }
    }
    tg.putImageData(img, 0, 0);
    g.drawImage(tmp, 0, 0, a.cw, a.ch, pad + k * (a.cw * a.zoom + pad), pad, a.cw * a.zoom, a.ch * a.zoom);
    g.fillStyle = '#e8e8ee'; g.font = '13px monospace';
    g.fillText(L, pad + k * (a.cw * a.zoom + pad), a.ch * a.zoom + pad + 16);
  });
  return cv.toDataURL('image/png');
}

function pageFraming() {
  const KB = window.KB, THREE = KB.THREE;
  const f0 = KB.fighters[0], f1 = KB.fighters[1];
  const mid = f0.robot.group.position.clone().add(f1.robot.group.position).multiplyScalar(0.5);
  const box = new THREE.Box3().setFromObject(f0.robot.group);
  const c = box.getCenter(new THREE.Vector3());
  const top = new THREE.Vector3(c.x, box.max.y, c.z).project(KB.camera);
  const bot = new THREE.Vector3(c.x, box.min.y, c.z).project(KB.camera);
  const h = Math.abs(top.y - bot.y) / 2 * window.innerHeight;
  return {
    dist: +KB.camera.position.distanceTo(mid).toFixed(3),
    fov: +KB.camera.fov.toFixed(2),
    pxPerM: +(h / Math.max(1e-6, box.max.y - box.min.y)).toFixed(1),
  };
}

/* =========================================================================
 * DRIVER
 * ====================================================================== */

async function main() {
  const server = await createServer({
    root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error',
  });
  await server.listen();
  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization', '--enable-zero-copy', '--disable-frame-rate-limit', '--force-device-scale-factor=1'],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  const report = {
    metric: 'RMSE vs the ' + TRUTH + 'x-integrated frame over SUBJECT PIXELS, 8-bit luma, lower is better',
    question: 'the shipped gate scores that metric with the sim FROZEN. This scores it on the SAME state with the fighters MOVING, camera pinned so the missing per-object velocity buffer is the only thing under test.',
    chains: { taa: EXPECT_TAA, bare: EXPECT_BARE },
    scenario: SCENARIO, renderScale: SCALE, warmTaa: WARM_TAA, warmBare: WARM_BARE,
    arms: {}, meta: {}, controls: {}, defects: [],
  };
  const pngs = {};
  const base = CHAINS[CHAIN].base;
  report.chain = CHAIN;

  try {
    await page.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
    await page.waitForTimeout(2500);
    await page.evaluate(pageInstall);

    const mode = await page.evaluate(pageSetMode, { ...base, taa: true });
    report.controls.setup_mode = mode;
    if (mode.keys !== EXPECT_TAA) report.defects.push('SETUP-1 FAILED: [' + mode.keys + '] != [' + EXPECT_TAA + ']');

    const run = await page.evaluate(pageRun, {
      W: WIDTH, H: HEIGHT, scale: SCALE, warm: WARM, after: AFTER, scenario: SCENARIO, png: !!PNG_OUT,
    });
    report.moment = { tick: run.tick, hitstop: run.hitstop, states: run.states, y: run.y };
    report.controls.camera_pin = {
      distinctRenderCameras: run.distinctRenderCameras,
      springPushedBy_m: run.camDriftM, springPushedBy_deg: run.camDriftDeg,
      note: 'distinctRenderCameras must be 1: every render in the window used a bit-identical view AND projection matrix. springPushedBy is how hard FightCamera fought the pin, i.e. evidence the pin was load-bearing rather than a no-op.',
    };
    if (run.distinctRenderCameras !== 1) {
      report.defects.push('SETUP-3 FAILED: ' + run.distinctRenderCameras + ' distinct render cameras in the window, expected 1');
    }
    report.framing = await page.evaluate(pageFraming);
    report.meta.A_moving = run.meta.A_moving;
    if (run.meta.A_moving.keys !== EXPECT_TAA) report.defects.push('A_moving chain [' + run.meta.A_moving.keys + ']');

    // frozen arms, all out of the same frozen state
    report.meta.B_bare = await page.evaluate(pageArm, { want: { ...base, taa: false }, scale: SCALE, warm: WARM_BARE, label: 'B_bare', W: WIDTH, H: HEIGHT, png: !!PNG_OUT });
    report.meta.C_truth = await page.evaluate(pageArm, { want: { ...base, taa: false }, scale: TRUTH, warm: WARM_BARE, label: 'C_truth', W: WIDTH, H: HEIGHT, png: !!PNG_OUT });
    report.meta.C_null = await page.evaluate(pageArm, { want: { ...base, taa: false }, scale: TRUTH, warm: WARM_BARE, label: 'C_null', W: WIDTH, H: HEIGHT, png: false });
    report.controls.mask = await page.evaluate(pageMask, { W: WIDTH, H: HEIGHT });
    report.meta.A_static = await page.evaluate(pageArm, { want: { ...base, taa: true }, scale: SCALE, warm: WARM_TAA, label: 'A_static', W: WIDTH, H: HEIGHT, png: !!PNG_OUT });
    report.meta.A_static_half = await page.evaluate(pageArm, { want: { ...base, taa: true }, scale: SCALE, warm: Math.round(WARM_TAA / 2), label: 'A_static_half', W: WIDTH, H: HEIGHT, png: false });

    for (const k of ['B_bare', 'A_static', 'A_static_half']) {
      const want = k === 'B_bare' ? EXPECT_BARE : EXPECT_TAA;
      if (report.meta[k].keys !== want) report.defects.push('SETUP-1 FAILED at ' + k + ': [' + report.meta[k].keys + '] != [' + want + ']');
    }
    const wantTruth = (WIDTH * TRUTH) + 'x' + (HEIGHT * TRUTH);
    if (report.meta.C_truth.rendered !== wantTruth) {
      report.defects.push('SETUP-2 FAILED: truth rendered ' + report.meta.C_truth.rendered + ', expected ' + wantTruth);
    }

    await page.evaluate(pageBlur, { from: 'B_bare', to: 'P_blur', W: WIDTH, H: HEIGHT });
    report.motion = await page.evaluate(pageMotion, { thr: 12 });

    for (const l of ['A_moving', 'A_static', 'A_static_half', 'B_bare', 'P_blur', 'C_null', 'C_truth']) {
      report.arms[l] = await page.evaluate(pageCompare, { label: l, ref: 'C_truth', offBy: OFF_BY });
    }

    const A = report.arms.A_moving, As = report.arms.A_static, B = report.arms.B_bare;
    const nul = report.arms.C_null, blur = report.arms.P_blur, half = report.arms.A_static_half;
    if (nul.rmseSubject > 0.02 * B.rmseSubject) report.defects.push('NULL FAILED: truth vs itself = ' + nul.rmseSubject);
    if (!(blur.rmseSubject > B.rmseSubject)) report.defects.push('POSITIVE CONTROL FAILED: 1px blur scores ' + blur.rmseSubject + ' vs bare ' + B.rmseSubject);
    if (Math.abs(half.rmseSubject - As.rmseSubject) > 0.02 * As.rmseSubject) {
      report.defects.push('CONVERGENCE: A_static at warm ' + Math.round(WARM_TAA / 2) + ' is ' + half.rmseSubject + ' vs ' + As.rmseSubject);
    }
    if (report.motion.movedPct < 20) report.defects.push('NOT MOVING: only ' + report.motion.movedPct + '% of subject pixels changed');

    report.worstBlocks = await page.evaluate(pageWorstBlock, { W: WIDTH, H: HEIGHT });

    report.verdict = {
      after: AFTER,
      MOVING_frame: { taa: A.rmseSubject, bare: B.rmseSubject, pct: +((100 * (A.rmseSubject - B.rmseSubject)) / B.rmseSubject).toFixed(2) },
      FROZEN_same_state: { taa: As.rmseSubject, bare: B.rmseSubject, pct: +((100 * (As.rmseSubject - B.rmseSubject)) / B.rmseSubject).toFixed(2) },
      offBy8_subject: { taa_moving: A.offBySubject, taa_frozen: As.offBySubject, bare: B.offBySubject },
      motion: report.motion,
      controls: {
        null_truth: nul.rmseSubject,
        positive_blur: blur.rmseSubject, bare: B.rmseSubject,
        converge_half_vs_full: [half.rmseSubject, As.rmseSubject],
        camera_pin: report.controls.camera_pin,
      },
      pass: report.defects.length === 0,
    };

    if (PNG_OUT) {
      await page.evaluate(pageErrPlanes, { amp: 4 });
      const win = await page.evaluate(pageWorstWindow, { W: WIDTH, H: HEIGHT });
      report.worstWindow = win;
      const cw = 96, ch = 72;
      const cx = Math.max(0, Math.min(WIDTH - cw, win.x));
      const cy = Math.max(0, Math.min(HEIGHT - ch, win.y));
      report.cropRect = { x: cx, y: cy, w: cw, h: ch };
      pngs.worst_zoom = await page.evaluate(pageCrops, {
        W: WIDTH, H: HEIGHT, x: cx, y: cy, cw, ch, zoom: 8,
        labels: ['C_truth', 'B_bare', 'A_moving', 'A_static'],
      });
      pngs.worst_error = await page.evaluate(pageCrops, {
        W: WIDTH, H: HEIGHT, x: cx, y: cy, cw, ch, zoom: 8,
        labels: ['ERR_B_bare', 'ERR_A_moving', 'ERR_A_static', 'MASK'],
      });
      const bb = report.controls.mask.bbox;
      const bw2 = bb[2] - bb[0], bh2 = bb[3] - bb[1];
      pngs.subject_error = await page.evaluate(pageCrops, {
        W: WIDTH, H: HEIGHT, x: bb[0], y: bb[1], cw: bw2, ch: bh2, zoom: 1,
        labels: ['B_bare', 'A_moving', 'ERR_B_bare', 'ERR_A_moving'],
      });
      const st = await page.evaluate(() => {
        const S = window.__mgState;
        return { A: S.pngA, B: S.png_B_bare, C: S.png_C_truth, As: S.png_A_static };
      });
      if (st.A) pngs.full_A_moving = st.A;
      if (st.B) pngs.full_B_bare = st.B;
      if (st.C) pngs.full_C_truth = st.C;
      if (st.As) pngs.full_A_static = st.As;
    }
  } finally {
    report.errors = errs.slice(0, 8);
    await browser.close();
    await server.close();
  }

  if (PNG_OUT) {
    mkdirSync(resolve(ROOT, PNG_OUT), { recursive: true });
    for (const [k, v] of Object.entries(pngs)) writeFileSync(resolve(ROOT, PNG_OUT, k + '.png'), Buffer.from(v.split(',')[1], 'base64'));
  }
  if (JSON_OUT) {
    mkdirSync(dirname(resolve(ROOT, JSON_OUT)), { recursive: true });
    writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(report, null, 2));
  }

  console.log('\n==================== movegate ====================');
  console.log('METRIC  RMSE vs the ' + TRUTH + 'x-integrated frame over subject pixels. LOWER IS BETTER.');
  console.log('MOMENT  ' + JSON.stringify(report.moment));
  console.log('FRAMING ' + JSON.stringify(report.framing));
  console.log('MOTION  ' + JSON.stringify(report.motion));
  console.log('CAMPIN  ' + JSON.stringify(report.controls.camera_pin));
  console.log('');
  console.log('  arm'.padEnd(18) + 'rmseAll'.padStart(10) + 'rmseSubj'.padStart(11) + 'maeSubj'.padStart(10) + ('px>' + OFF_BY).padStart(11) + '  chain');
  for (const [k, v] of Object.entries(report.arms)) {
    const m = report.meta[k];
    console.log('  ' + k.padEnd(16) + String(v.rmseAll).padStart(10) + String(v.rmseSubject).padStart(11) +
      String(v.maeSubject).padStart(10) + String(v.offBySubject).padStart(11) + '  ' + (m ? '[' + m.keys + '] ' + m.rendered : ''));
  }
  console.log('\n-- VERDICT --');
  console.log(JSON.stringify(report.verdict, null, 2));
  console.log('worst subject blocks (TAA-moving minus bare, RMSE):');
  for (const w of report.worstBlocks || []) console.log('   ' + JSON.stringify(w));
  if (report.defects.length) { console.log('DEFECTS:'); for (const d of report.defects) console.log('  ! ' + d); }
  if (report.errors && report.errors.length) console.log('page errors: ' + JSON.stringify(report.errors));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
