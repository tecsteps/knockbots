/**
 * shadowquality -- what a cheaper shadow filter COSTS, on the project's metric.
 *
 * Companion to tools/shadowgate.mjs, which prices shadow configurations in
 * milliseconds. This one prices them in image error, so a perf win that eats
 * more picture than it is worth can be identified as one.
 *
 * THE METRIC IS ssgate's, AND THE REFERENCE IS DELIBERATELY NOT EACH ARM'S OWN.
 *
 * ssgate scores RMSE against THE SAME CONFIG rendered at 4x and box-integrated,
 * because the question there is aliasing. That framing is wrong here: it would
 * ask "does hardware PCF resolve hardware PCF well", which it does, trivially,
 * because a 5-tap filter has less high-frequency content to alias. Scored that
 * way every cheaper filter wins, which is the same wrong-signed trap ssgate's
 * own header retracts a round for.
 *
 * So the truth plane here is fixed: THE SHIPPED CONFIG (PCSS 12+16, 2560) AT 4x,
 * box-integrated to 1080p. Every arm is scored as its distance from that one
 * image. An arm that changes nothing scores ~0 above the shipped arm's own
 * aliasing floor; an arm that removes the shadows scores enormously. Both are
 * measured here as controls rather than asserted.
 *
 * Each arm is ALSO scored against its own 4x integration, and both numbers are
 * reported, because they answer different questions and confusing them is how
 * the wrong-signed metric got in last time:
 *     vsShipTruth  -- how far the delivered frame is from the agreed picture
 *     vsOwnTruth   -- how well the config resolves itself (aliasing only)
 *
 * THREE MASKS, because a shadow filter does not live where the subject does.
 *     subject  -- ssgate's: coverage render of the two fighter hierarchies at
 *                 truth resolution. This is what the project gates on.
 *     shadow   -- pixels the shadow system is RESPONSIBLE FOR: where the 4x
 *                 shipped frame and a 4x shadows-off frame differ by more than
 *                 1.0 luma. Measured, not drawn. A subject-only score badly
 *                 understates a shadow change because most cast shadow is on
 *                 the deck, which is not subject.
 *     all      -- whole frame, for context.
 *
 * CONTROLS
 *   SETUP-1  the compiled FRAGMENT SOURCE of every live program is read off the
 *            GPU per arm (gl.getShaderSource) and asserted to carry the filter
 *            and tap count the arm asked for. Three shadow config hazards make
 *            this necessary and tools/shadowgate.mjs demonstrates all three:
 *            tier.pcss is read only by setQuality; THREE.ShaderChunk is not in
 *            the program cache key; and programs are released only on material
 *            dispose, so a naive arm switch leaks a program set per arm.
 *   SETUP-2  armed pass list and drawing-buffer size recorded per arm.
 *   SETUP-3  camera pin verified by measurement; drift must be 0.
 *   NULL     the shipped arm is captured twice, separated by every other arm.
 *            RMSE between the two must be ~0.
 *   POSITIVE 'noshadow' must score far WORSE on the shadow mask than any filter
 *            change. If it does not, the mask is not looking at the shadows.
 *
 * TEMPORAL. A frozen frame cannot see the one thing fewer taps actually costs in
 * motion: the Vogel disk is rotated by interleavedGradientNoise(gl_FragCoord),
 * a SCREEN-SPACE dither, so a penumbra that is noisy at 16 taps crawls when the
 * subject slides through the pattern. That is measured directly, per arm, by
 * rendering the frame twice with the camera translated by exactly one output
 * pixel of parallax and differencing the second against the first shifted back
 * by one pixel. A filter with no screen-space dither scores near zero; a noisy
 * one scores its crawl amplitude. Deterministic, and identical in construction
 * for every arm, which a live-fight capture cannot be.
 *
 *   node tools/shadowquality.mjs --json scratchpad/shadowquality.json
 *   node tools/shadowquality.mjs --png scratchpad/sq --truth 4 --pin 150
 *
 * NOTE: page-side code is written into template literals. A backtick anywhere
 * below, including inside a comment inside a literal, silently ends the string.
 * There are none. Keep it that way.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const PORT = Number(arg('port', 5271));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const TRUTH = Number(arg('truth', 4));
const SHIP = Number(arg('scale', 0.85));
const PIN = Number(arg('pin', 150));
const WARM = Number(arg('warm', 12));
const OFF_BY = Number(arg('offby', 8));
const JSON_OUT = arg('json', '');
const KEEP_PNG = arg('png', '');
const log = (...a) => console.log('[shadowquality]', ...a);

/* ------------------------------------------------------------------ arms */

// pcss:null means "shadows off". taps null means the shipped 12+16.
const ARMS = [
  { key: 'ship', pcss: true, taps: null, map: 2560, note: 'SHIPPED: PCSS 12 blocker + 16 filter, directional key 2560' },
  { key: 'pcf', pcss: false, taps: null, map: 2560, note: 'three hardware PCF, 5 Vogel taps, shadow.radius as shipped' },
  // Softness is FREE on the PCF path: the tap count is fixed at 5 whatever the
  // radius is. If PCF ships, the radius it ships at is a real choice, so it is
  // measured rather than left at the value the PCSS path never used.
  { key: 'pcf-r8', pcss: false, taps: null, map: 2560, radius: 8, note: 'hardware PCF, shadow.radius 8 texels' },
  { key: 'pcf-r16', pcss: false, taps: null, map: 2560, radius: 16, note: 'hardware PCF, shadow.radius 16 texels' },
  { key: 'taps-6-8', pcss: true, taps: [6, 8], map: 2560, note: 'PCSS at half the taps' },
  { key: 'taps-1-1', pcss: true, taps: [1, 1], map: 2560, note: 'PCSS code path at 2 taps. A BOUND, not a candidate' },
  { key: 'map-1024', pcss: true, taps: null, map: 1024, note: 'PCSS unchanged, directional key 2560 -> 1024' },
  { key: 'map-1536', pcss: true, taps: null, map: 1536, note: 'PCSS unchanged, directional key 2560 -> 1536' },
  { key: 'noshadow', pcss: true, taps: null, map: 2560, shadows: false, note: 'POSITIVE CONTROL: no shadows at all' },
];
const ONLY = arg('only', '');
const RUN = ARMS.filter((a) => !ONLY || ONLY.split(',').includes(a.key));

/* ------------------------------------------------------- page-side code */

/* ssgate's PIN_CLOCK, verbatim in behaviour. */
const PIN_CLOCK = `
  if (!window.__kbClock) window.__kbClock = window.KB.clock.getDelta.bind(window.KB.clock);
  window.KB.timeScale = 1;
  window.KB.clock.getDelta = () => 1 / 60;
`;

/* ssgate's FREEZE, verbatim in behaviour: sim, clock, camera rig, grain, adaptive. */
const FREEZE = `(() => {
  const KB = window.KB, THREE = KB.THREE, cam = KB.camera;
  KB.paused = true;
  KB.clock.getDelta = () => 0;
  const pos = cam.position.clone();
  const quat = cam.quaternion.clone();
  const fov = cam.fov;
  window.__sqPin = { pos, quat, fov, shift: 0 };
  const park = () => {
    cam.position.copy(pos);
    if (window.__sqPin.shift) cam.position.addScaledVector(window.__sqRight, window.__sqPin.shift);
    cam.quaternion.copy(quat);
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld(true);
  };
  window.__sqPark = park;
  window.__sqRight = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
  KB.fightCamera.render = park;
  KB.fightCamera.simulate = () => {};
  park();

  const r = KB.renderer;
  r.effects.adaptiveResolution = false;
  if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });

  const f0 = KB.fighters[0], f1 = KB.fighters[1];
  const mid = f0.robot.group.position.clone().add(f1.robot.group.position).multiplyScalar(0.5);
  const box = new THREE.Box3().setFromObject(f0.robot.group);
  const c = box.getCenter(new THREE.Vector3());
  const top = new THREE.Vector3(c.x, box.max.y, c.z).project(cam);
  const bot = new THREE.Vector3(c.x, box.min.y, c.z).project(cam);
  const h = Math.abs(top.y - bot.y) / 2 * window.innerHeight;
  return {
    dist: +cam.position.distanceTo(mid).toFixed(3),
    fov: +cam.fov.toFixed(2),
    pxPerM: +(h / Math.max(1e-6, box.max.y - box.min.y)).toFixed(1),
    tick: KB.tick,
  };
})()`;

/**
 * SHADOW ARM CONTROL. The same three hazards tools/shadowgate.mjs demonstrates,
 * handled the same way: chunk rewrite + a cache-key define + material.dispose()
 * so the old program set is released rather than leaked.
 */
const SHADOW_JS = `(() => {
  const KB = window.KB, THREE = KB.THREE, rp = KB.renderer;
  const CHUNK = 'shadowmap_pars_fragment';
  const S = {};
  window.__sq = S;
  S.chunk0 = THREE.ShaderChunk[CHUNK];
  S.map0 = rp.tier.shadowMapSize;

  const tapsOf = (src) => {
    const b = /vogelDiskSample\\( i, (\\d+), phi \\) \\* searchRadius/.exec(src);
    const f = /vogelDiskSample\\( i, (\\d+), phi \\) \\* filterRadius/.exec(src);
    const d = /shadow \\/= float\\( (\\d+) \\);/.exec(src);
    return { blocker: b ? +b[1] : null, filter: f ? +f[1] : null, divisor: d ? +d[1] : null };
  };
  S.tapsOf = tapsOf;
  S.taps0 = tapsOf(S.chunk0);

  const chunkWithTaps = (src, blocker, filter) => src
    .replace(/for \\( int i = 0; i < \\d+; i \\+\\+ \\) \\{(\\s*)vec2 offset = vogelDiskSample\\( i, \\d+, phi \\) \\* searchRadius;/,
      'for ( int i = 0; i < ' + blocker + '; i ++ ) {$1vec2 offset = vogelDiskSample( i, ' + blocker + ', phi ) * searchRadius;')
    .replace(/for \\( int i = 0; i < \\d+; i \\+\\+ \\) \\{(\\s*)vec2 offset = vogelDiskSample\\( i, \\d+, phi \\) \\* filterRadius;/,
      'for ( int i = 0; i < ' + filter + '; i ++ ) {$1vec2 offset = vogelDiskSample( i, ' + filter + ', phi ) * filterRadius;')
    .replace(/shadow \\/= float\\( \\d+ \\);/, 'shadow /= float( ' + filter + ' );');

  S.apply = (cfg) => {
    const wantShadows = cfg.shadows === undefined ? true : !!cfg.shadows;
    const wantPcss = cfg.pcss === undefined ? true : !!cfg.pcss;
    const taps = cfg.taps || [S.taps0.blocker, S.taps0.filter];
    const tag = (wantPcss ? 'pcss' : 'pcf') + '_' + taps[0] + '_' + taps[1] + '_' + (wantShadows ? 'on' : 'off');

    rp.tier.shadowMapSize = cfg.map || S.map0;

    // shadow.radius is written every frame by RenderPipeline#fitShadows, so an
    // assignment here would be undone before the next draw. Redefining the
    // property makes fitShadows' write a no-op and pins the value; passing no
    // radius restores the real field so the shipped path is measured, not a
    // frozen copy of it.
    (rp._lastScene || KB.scene).traverse((o) => {
      if (!o.isLight || !o.shadow) return;
      if (cfg.radius === undefined) {
        if (S.pinned && S.pinned.has(o.shadow)) {
          const v = o.shadow.radius;
          delete o.shadow.radius;
          Object.defineProperty(o.shadow, 'radius', { value: v, writable: true, configurable: true, enumerable: true });
          S.pinned.delete(o.shadow);
        }
        return;
      }
      S.pinned = S.pinned || new Set();
      const v = cfg.radius;
      Object.defineProperty(o.shadow, 'radius', { get: () => v, set: () => {}, configurable: true, enumerable: true });
      S.pinned.add(o.shadow);
    });
    if (!!rp.effects.shadows !== wantShadows) rp.setEffect('shadows', wantShadows);
    const chunk = wantPcss ? chunkWithTaps(S.chunk0, taps[0], taps[1]) : S.chunk0;
    if (THREE.ShaderChunk[CHUNK] !== chunk) THREE.ShaderChunk[CHUNK] = chunk;
    rp._pcssActive = wantPcss && wantShadows;
    const type = wantPcss ? 0 : 1;               // BasicShadowMap / PCFShadowMap
    if (rp.renderer.shadowMap.type !== type) rp.renderer.shadowMap.type = type;

    const seen = new Set();
    let n = 0;
    const sweep = (sc) => {
      if (!sc || !sc.traverse) return;
      sc.traverse((o) => {
        const m = o.material;
        if (!m) return;
        for (const mat of (Array.isArray(m) ? m : [m])) {
          if (!mat || seen.has(mat)) continue;
          seen.add(mat);
          if (!mat.defines) mat.defines = {};
          if (mat.defines.KB_SHADOW_ARM === tag) continue;
          mat.defines.KB_SHADOW_ARM = tag;
          mat.dispose();
          mat.needsUpdate = true;
          n++;
        }
      });
    };
    sweep(rp._lastScene); sweep(rp.scene); sweep(KB.scene);
    rp.renderer.shadowMap.needsUpdate = true;
    return { tag, recompiled: n, chunkTaps: tapsOf(THREE.ShaderChunk[CHUNK]) };
  };

  S.audit = () => {
    const gl = rp.renderer.getContext();
    const progs = rp.renderer.info.programs || [];
    const out = { total: progs.length, withShadow: 0, pcss: {}, pcf: 0, none: 0, armTags: {} };
    for (const p of progs) {
      let src = null;
      try { src = gl.getShaderSource(p.fragmentShader); } catch (e) { src = null; }
      if (!src) continue;
      const t = /#define KB_SHADOW_ARM (\\S+)/.exec(src);
      if (t) out.armTags[t[1]] = (out.armTags[t[1]] || 0) + 1;
      if (src.indexOf('#define USE_SHADOWMAP') < 0 || src.indexOf('float getShadow(') < 0) { out.none++; continue; }
      out.withShadow++;
      if (src.indexOf('#define SHADOWMAP_TYPE_PCF') >= 0) { out.pcf++; continue; }
      const k = tapsOf(src);
      const key = k.blocker + '+' + k.filter;
      out.pcss[key] = (out.pcss[key] || 0) + 1;
    }
    return out;
  };

  S.shadowLights = () => {
    const out = [];
    (rp._lastScene || KB.scene).traverse((o) => {
      if (!o.isLight || !o.shadow || !o.castShadow) return;
      out.push((o.isDirectionalLight ? 'dir' : 'spot') + ':' + o.shadow.mapSize.x + ':r' + (+o.shadow.radius.toFixed(2)));
    });
    return out.sort();
  };
  return { ok: true };
})()`;

/* ssgate's MASK_JS and BOXDOWN_JS, behaviourally verbatim. */
const BOXDOWN_JS = `((k, isMask) => {
  const W = ${WIDTH}, H = ${HEIGHT};
  const gl = window.KB.renderer.canvas;
  const sw = gl.width, sh = gl.height;
  const tmp = window.__sqTmp || (window.__sqTmp = document.createElement('canvas'));
  if (tmp.width !== sw || tmp.height !== sh) { tmp.width = sw; tmp.height = sh; }
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.imageSmoothingEnabled = false;
  tctx.globalCompositeOperation = 'source-over';
  tctx.fillStyle = '#000';
  tctx.fillRect(0, 0, sw, sh);
  tctx.drawImage(gl, 0, 0);
  const plane = new Float32Array(W * H);
  const R = 0.2126, G = 0.7152, B = 0.0722;
  if (sw >= W && sw % W === 0 && sh % H === 0) {
    const kk = sw / W;
    for (let oy = 0; oy < H; oy++) {
      const band = tctx.getImageData(0, oy * kk, sw, kk).data;
      const row = oy * W;
      for (let ox = 0; ox < W; ox++) {
        let acc = 0;
        for (let j = 0; j < kk; j++) {
          let p = (j * sw + ox * kk) * 4;
          for (let i = 0; i < kk; i++, p += 4) acc += R * band[p] + G * band[p + 1] + B * band[p + 2];
        }
        plane[row + ox] = acc / (kk * kk);
      }
    }
  } else {
    const src = tctx.getImageData(0, 0, sw, sh).data;
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
  return { plane, rendered: sw + 'x' + sh, png: (!isMask && window.__sqKeepPng) ? tmp.toDataURL('image/png') : null };
})`;

const MASK_JS = `((k) => {
  const KB = window.KB, THREE = KB.THREE;
  const r = KB.renderer, gl = r.renderer, scene = KB.scene, cam = KB.camera;
  const roots = KB.fighters.map((f) => f.robot && f.robot.group).filter(Boolean);
  if (roots.length !== KB.fighters.length) throw new Error('could not resolve every fighter robot group');
  const rootSet = new Set(roots);
  const keep = new Set();
  for (const rt of roots) { let o = rt.parent; while (o) { keep.add(o); o = o.parent; } }
  if (!keep.has(scene)) throw new Error('fighter roots are not under KB.scene');
  const hidden = [];
  const walk = (o) => {
    for (const c of o.children) {
      if (rootSet.has(c)) continue;
      if (keep.has(c)) { walk(c); continue; }
      if (c.visible) { hidden.push(c); c.visible = false; }
    }
  };
  walk(scene);
  const forced = [];
  for (const o of keep) { if (o !== scene && !o.visible) { forced.push(o); o.visible = true; } }
  for (const o of rootSet) { if (!o.visible) { forced.push(o); o.visible = true; } }
  const savedOverride = scene.overrideMaterial, savedBg = scene.background;
  const savedEnv = scene.environment, savedFog = scene.fog;
  const savedLayers = cam.layers.mask, savedShadow = gl.shadowMap.enabled;
  const savedAutoClear = gl.autoClear;
  const savedClear = new THREE.Color();
  gl.getClearColor(savedClear);
  const savedAlpha = gl.getClearAlpha(), savedTarget = gl.getRenderTarget();
  const flat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false });
  scene.overrideMaterial = flat;
  scene.background = null; scene.environment = null; scene.fog = null;
  cam.layers.enableAll();
  gl.shadowMap.enabled = false;
  gl.autoClear = true;
  gl.setClearColor(0x000000, 1);
  gl.setRenderTarget(null);
  gl.render(scene, cam);
  const out = window.__sqBoxDown(k, true);
  scene.overrideMaterial = savedOverride; scene.background = savedBg;
  scene.environment = savedEnv; scene.fog = savedFog;
  cam.layers.mask = savedLayers; gl.shadowMap.enabled = savedShadow;
  gl.autoClear = savedAutoClear; gl.setClearColor(savedClear, savedAlpha);
  gl.setRenderTarget(savedTarget);
  flat.dispose();
  for (const o of hidden) o.visible = true;
  for (const o of forced) o.visible = false;
  const cov = out.plane;
  const mask = new Uint8Array(cov.length);
  let n = 0;
  for (let i = 0; i < cov.length; i++) if (cov[i] / 255 > 0.001) { mask[i] = 1; n++; }
  window.__sqMasks = window.__sqMasks || {};
  window.__sqMasks.subject = mask;
  return { subjectPx: n, subjectPct: +((100 * n) / cov.length).toFixed(3), roots: roots.length };
})`;

/**
 * Render one arm and retain its 1920x1080 luma plane.
 * Same warm/reflector discipline as ssgate: the planar reflection is a temporal
 * cache refreshed on ARMED frames, so it is armed on this tool's frames and
 * invalidated after every resize, or an arm's floor carries the previous arm's
 * mirror at the previous arm's resolution.
 */
const MEASURE_JS = `((scale, warm, label) => {
  const KB = window.KB, r = KB.renderer;
  r.renderScale = scale;
  r._targetScale = scale;
  if (typeof r.resize === 'function') r.resize();
  const stage = KB.stage;
  if (stage && stage.reflector && typeof stage.reflector.invalidate === 'function') stage.reflector.invalidate();
  const step = () => {
    window.__sqPark();
    if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
    r.renderer.shadowMap.needsUpdate = true;
    r.render(KB.scene, KB.camera, 1 / 60);
  };
  for (let i = 0; i < warm; i++) step();
  step();
  const out = window.__sqBoxDown(scale, false);
  window.__sqPlanes[label] = out.plane;
  let mean = 0;
  for (let i = 0; i < out.plane.length; i++) mean += out.plane[i];
  return {
    label, renderScale: scale, rendered: out.rendered,
    meanLuma: +(mean / out.plane.length).toFixed(3),
    passKeys: Object.keys(r._passes || {}).join(','),
    passArmed: (r.composer ? r.composer.passes : []).map((p) => p.constructor.name).join(' '),
    png: out.png,
  };
})`;

/** Builds the SHADOW mask from two truth planes: shipped, and shadows off. */
const SHADOW_MASK_JS = `((a, b, thr) => {
  const P = window.__sqPlanes;
  const x = P[a], y = P[b];
  if (!x || !y) throw new Error('missing plane for the shadow mask');
  const m = new Uint8Array(x.length);
  let n = 0;
  for (let i = 0; i < x.length; i++) { if (Math.abs(x[i] - y[i]) > thr) { m[i] = 1; n++; } }
  window.__sqMasks.shadow = m;
  return { shadowPx: n, shadowPct: +((100 * n) / x.length).toFixed(3) };
})`;

/** RMSE of one plane against another over each mask. Lower is better. */
const COMPARE_JS = `((label, truthLabel, thr) => {
  const P = window.__sqPlanes, M = window.__sqMasks;
  const a = P[label], t = P[truthLabel];
  if (!a) throw new Error('no plane ' + label);
  if (!t) throw new Error('no truth plane ' + truthLabel);
  const out = {};
  for (const name of ['all', 'subject', 'shadow']) {
    const m = name === 'all' ? null : M[name];
    let s2 = 0, n = 0, off = 0, mx = 0, tl = 0, sa = 0;
    for (let i = 0; i < a.length; i++) {
      if (m && !m[i]) continue;
      const d = a[i] - t[i], ad = d < 0 ? -d : d;
      s2 += d * d; sa += ad; n++; tl += t[i];
      if (ad > thr) off++;
      if (ad > mx) mx = ad;
    }
    const rmse = Math.sqrt(s2 / Math.max(1, n));
    out[name] = {
      rmse: +rmse.toFixed(4), mae: +(sa / Math.max(1, n)).toFixed(4),
      px: n, offBy: off, offByPct: +((100 * off) / Math.max(1, n)).toFixed(2),
      maxErr: +mx.toFixed(2),
      nrmsePct: +((100 * rmse) / Math.max(1e-6, tl / Math.max(1, n))).toFixed(2),
    };
  }
  return out;
})`;

/**
 * TEMPORAL STABILITY. Render at the shipped scale, translate the camera by
 * exactly one output pixel of parallax at the subject distance, render again,
 * and difference the second against the first shifted back by one pixel. What
 * survives is content that did NOT move with the scene -- which is exactly what
 * a screen-space dither is. Reported over the shadow mask.
 */
const CRAWL_JS = `((scale, warm, metresPerPixel) => {
  const KB = window.KB, r = KB.renderer;
  const W = ${WIDTH}, H = ${HEIGHT};
  r.renderScale = scale; r._targetScale = scale;
  if (typeof r.resize === 'function') r.resize();
  const stage = KB.stage;
  if (stage && stage.reflector && typeof stage.reflector.invalidate === 'function') stage.reflector.invalidate();
  const step = () => {
    window.__sqPark();
    if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
    r.renderer.shadowMap.needsUpdate = true;
    r.render(KB.scene, KB.camera, 1 / 60);
  };
  window.__sqPin.shift = 0;
  for (let i = 0; i < warm; i++) step();
  step();
  const A = window.__sqBoxDown(scale, true).plane;
  window.__sqPin.shift = metresPerPixel;
  for (let i = 0; i < 3; i++) step();
  step();
  const B = window.__sqBoxDown(scale, true).plane;
  window.__sqPin.shift = 0;
  step();
  // B is the frame one pixel to the right; shifting it back registers the scene.
  const M = window.__sqMasks;
  const out = {};
  for (const name of ['subject', 'shadow']) {
    const m = M[name];
    let s2 = 0, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 1; x < W; x++) {
        const i = y * W + x;
        if (!m[i]) continue;
        const d = B[i - 1] - A[i];
        s2 += d * d; n++;
      }
    }
    out[name] = { crawlRmse: +Math.sqrt(s2 / Math.max(1, n)).toFixed(4), px: n };
  }
  return out;
})`;

/* --------------------------------------------------------------- driver */

const server = await createServer({
  root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-zero-copy', '--disable-frame-rate-limit', '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });

await page.evaluate(PIN_CLOCK);
await page.evaluate(`(() => { const KB = window.KB; KB.startMatch(0, 1); KB.setPhase('fight'); if (KB.menus && KB.menus.show) KB.menus.show(null); })()`);
await page.waitForFunction(`window.KB.tick >= ${PIN}`, null, { timeout: 90000 });
const framing = await page.evaluate(FREEZE);
log('framing', JSON.stringify(framing));

await page.evaluate(`window.__sqBoxDown = ${BOXDOWN_JS};`);
await page.evaluate(`window.__sqPlanes = {};`);
await page.evaluate(`window.__sqKeepPng = ${KEEP_PNG ? 'true' : 'false'};`);
await page.evaluate(SHADOW_JS);
log('shadow casters at boot:', JSON.stringify(await page.evaluate('window.__sq.shadowLights()')));

/* SETUP: the subject mask, at truth resolution. */
await page.evaluate(`window.KB.renderer.renderScale = ${TRUTH}; window.KB.renderer._targetScale = ${TRUTH}; window.KB.renderer.resize();`);
const maskInfo = await page.evaluate(`(${MASK_JS})(${TRUTH})`);
log('subject mask:', JSON.stringify(maskInfo));

const results = [];
const audits = {};
const pngs = {};

async function armSetup(a) {
  const applied = await page.evaluate(`window.__sq.apply(${JSON.stringify(a)})`);
  // Two settle renders at the working scale so the recompile lands before the
  // measured warm loop starts.
  await page.evaluate(`(${MEASURE_JS})(${SHIP}, 4, '__settle')`);
  const audit = await page.evaluate('window.__sq.audit()');
  audits[a.key] = audit;
  return { applied, audit };
}

function auditOk(a, audit) {
  const keys = Object.keys(audit.pcss);
  if (a.shadows === false) return audit.withShadow === 0;
  if (!a.pcss) return audit.pcf > 0 && keys.length === 0;
  const want = (a.taps ? a.taps[0] : 12) + '+' + (a.taps ? a.taps[1] : 16);
  return audit.pcf === 0 && keys.length === 1 && keys[0] === want;
}

/* ---- truth planes ------------------------------------------------------ */
for (const a of RUN) {
  const { applied, audit } = await armSetup(a);
  const ok = auditOk(a, audit);
  const m = await page.evaluate(`(${MEASURE_JS})(${TRUTH}, ${WARM}, 'truth-${a.key}')`);
  if (m.png) pngs['truth-' + a.key] = m.png;
  log(`truth-${a.key.padEnd(10)} ${m.rendered} lights ${JSON.stringify(await page.evaluate('window.__sq.shadowLights()'))} `
    + `gpu ${JSON.stringify(audit.pcss)}/pcf${audit.pcf} ${ok ? 'OK' : 'SETUP-FAIL'} tag ${applied.tag}`);
  results.push({ key: a.key, phase: 'truth', auditOk: ok, audit, rendered: m.rendered, meanLuma: m.meanLuma, passArmed: m.passArmed });
}

/* ---- the shadow mask, from the two truth planes ------------------------ */
let shadowMaskInfo = null;
if (RUN.find((a) => a.key === 'ship') && RUN.find((a) => a.key === 'noshadow')) {
  shadowMaskInfo = await page.evaluate(`(${SHADOW_MASK_JS})('truth-ship', 'truth-noshadow', 1.0)`);
  log('shadow mask:', JSON.stringify(shadowMaskInfo));
} else {
  throw new Error('the shadow mask needs both the ship and noshadow arms');
}

/* ---- delivered planes at the shipped scale ----------------------------- */
for (const a of RUN) {
  const { applied, audit } = await armSetup(a);
  const ok = auditOk(a, audit);
  const m = await page.evaluate(`(${MEASURE_JS})(${SHIP}, ${WARM}, 'ship-${a.key}')`);
  if (m.png) pngs['ship-' + a.key] = m.png;
  // One output pixel of lateral parallax AT THE SUBJECT DISTANCE. pxPerM is
  // measured on the fighter, so 1/pxPerM metres of camera translation moves the
  // subject by exactly one 1080p pixel.
  const crawl = await page.evaluate(`(${CRAWL_JS})(${SHIP}, 6, ${(1 / framing.pxPerM).toFixed(8)})`);
  results.push({ key: a.key, phase: 'ship', auditOk: ok, audit, rendered: m.rendered, meanLuma: m.meanLuma, passArmed: m.passArmed, crawl, tag: applied.tag });
  log(`ship-${a.key.padEnd(11)} ${m.rendered} ${ok ? 'OK' : 'SETUP-FAIL'} crawl(shadow) ${crawl.shadow.crawlRmse}`);
}

/* ---- NULL CONTROL: the shipped arm again, last --------------------------- */
{
  const a = RUN[0].key === 'ship' ? RUN[0] : { key: 'ship', pcss: true, taps: null, map: 2560 };
  await armSetup(a);
  await page.evaluate(`(${MEASURE_JS})(${SHIP}, ${WARM}, 'null-ship')`);
}

/* ---- score ------------------------------------------------------------- */
const rows = [];
for (const a of RUN) {
  const vsShip = await page.evaluate(`(${COMPARE_JS})('ship-${a.key}', 'truth-ship', ${OFF_BY})`);
  const vsOwn = await page.evaluate(`(${COMPARE_JS})('ship-${a.key}', 'truth-${a.key}', ${OFF_BY})`);
  const truthVsShip = await page.evaluate(`(${COMPARE_JS})('truth-${a.key}', 'truth-ship', ${OFF_BY})`);
  const r = results.find((x) => x.key === a.key && x.phase === 'ship');
  rows.push({ key: a.key, note: a.note, auditOk: r.auditOk, audit: r.audit, crawl: r.crawl, vsShipTruth: vsShip, vsOwnTruth: vsOwn, truthVsShipTruth: truthVsShip });
}
const nullCmp = await page.evaluate(`(${COMPARE_JS})('null-ship', 'ship-ship', ${OFF_BY})`);
const pinDrift = await page.evaluate(`(() => {
  const c = window.KB.camera, p = window.__sqPin;
  return { m: +c.position.distanceTo(p.pos).toFixed(6), deg: +(2 * Math.acos(Math.min(1, Math.abs(c.quaternion.dot(p.quat)))) * 180 / Math.PI).toFixed(6) };
})()`);

/* ----------------------------------------------------------------- print */
console.log('\n===================== SETUP CONTROLS =====================');
console.log(`camera pin drift            ${pinDrift.m} m / ${pinDrift.deg} deg   (must be 0)`);
console.log(`NULL  ship captured twice   rmse all ${nullCmp.all.rmse}  subject ${nullCmp.subject.rmse}  shadow ${nullCmp.shadow.rmse}   (must be ~0)`);
console.log(`subject mask ${maskInfo.subjectPx} px (${maskInfo.subjectPct}%)   shadow mask ${shadowMaskInfo.shadowPx} px (${shadowMaskInfo.shadowPct}%)`);
for (const r of rows) if (!r.auditOk) console.log(`GPU AUDIT FAILED for ${r.key}: ${JSON.stringify(r.audit)}`);

console.log('\n===== RMSE vs the SHIPPED 4x-integrated frame (lower is better) =====');
console.log('arm           shadowRMSE  subjRMSE   allRMSE   shadow%off  crawl(shadow)  crawl(subj)');
for (const r of rows) {
  console.log(`${r.key.padEnd(12)} ${r.vsShipTruth.shadow.rmse.toFixed(3).padStart(10)} `
    + `${r.vsShipTruth.subject.rmse.toFixed(3).padStart(9)} ${r.vsShipTruth.all.rmse.toFixed(3).padStart(9)} `
    + `${r.vsShipTruth.shadow.offByPct.toFixed(2).padStart(11)} `
    + `${r.crawl.shadow.crawlRmse.toFixed(3).padStart(14)} ${r.crawl.subject.crawlRmse.toFixed(3).padStart(12)}`);
}
console.log('\n===== each arm vs its OWN 4x integration (aliasing only; NOT the gate) =====');
for (const r of rows) {
  console.log(`${r.key.padEnd(12)} shadow ${r.vsOwnTruth.shadow.rmse.toFixed(3).padStart(8)}   subject ${r.vsOwnTruth.subject.rmse.toFixed(3).padStart(8)}`);
}
console.log('\n===== the CONFIG itself, resolution removed: truth(arm) vs truth(ship) =====');
for (const r of rows) {
  console.log(`${r.key.padEnd(12)} shadow ${r.truthVsShipTruth.shadow.rmse.toFixed(3).padStart(8)}   subject ${r.truthVsShipTruth.subject.rmse.toFixed(3).padStart(8)}`);
}

if (JSON_OUT) {
  mkdirSync(dirname(resolve(ROOT, JSON_OUT)), { recursive: true });
  writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify({
    framing, maskInfo, shadowMaskInfo, pinDrift, nullControl: nullCmp, rows, params: { TRUTH, SHIP, PIN, WARM, OFF_BY },
  }, null, 2));
  log('wrote', JSON_OUT);
}
if (KEEP_PNG) {
  mkdirSync(resolve(ROOT, KEEP_PNG), { recursive: true });
  for (const [k, v] of Object.entries(pngs)) {
    writeFileSync(resolve(ROOT, KEEP_PNG, k + '.png'), Buffer.from(v.split(',')[1], 'base64'));
  }
  log('wrote pngs to', KEEP_PNG);
}

await browser.close();
await server.close();
