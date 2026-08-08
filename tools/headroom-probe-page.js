/*
 * Page-side frame-time probe. Loaded as raw text and eval'd in the page, so it
 * may use template literals freely. NOTE: no backtick may appear inside any
 * comment in this file.
 *
 * Three instruments, deliberately independent:
 *   1. rAF interval        -- what the browser actually delivers.
 *   2. CPU time in render  -- wall clock inside RenderPipeline#render.
 *   3. GPU TIME_ELAPSED    -- EXT_disjoint_timer_query_webgl2 around the whole
 *                             composer, one query per frame.
 * Ablations are FRAME-ALTERNATING: the thing under test is toggled on odd
 * frames and off on even ones, so both populations are drawn from the same
 * seconds of the same fight and content variance cancels.
 */
(() => {
  const KB = window.KB;
  const THREE = KB.THREE;
  const rp = KB.renderer;
  const P = {};
  window.__kbProbe = P;

  P.info = {};
  P._frameNo = 0;
  P._rec = new Map();
  P._pending = [];
  P._alt = null;
  P._gpuMode = 'off';

  /* ------------------------------------------------- composer instrument */

  const hookComposer = () => {
    const composer = rp.composer;
    if (!composer || composer.__kbHooked) return;
    composer.__kbHooked = true;
    const orig = composer.render.bind(composer);
    composer.render = (dt) => {
      P._frameNo++;
      const n = P._frameNo;
      const parity = n & 1;
      if (P._alt) P._alt(parity);
      P._drain();
      const rec = { parity, cpuMs: 0, gpuMs: null };
      P._rec.set(n, rec);
      // Keep the map bounded.
      if (P._rec.size > 4000) P._rec.delete(n - 4000);
      let q = null;
      if (P._gpuMode === 'frame' && P._ext) {
        q = P._getQuery();
        P._gl.beginQuery(P._ext.TIME_ELAPSED_EXT, q);
      }
      const t0 = performance.now();
      orig(dt);
      rec.cpuMs = performance.now() - t0;
      if (q) {
        P._gl.endQuery(P._ext.TIME_ELAPSED_EXT);
        P._pending.push({ q, n });
      }
    };
  };

  P._pool = [];
  P._getQuery = () => (P._pool.pop() || P._gl.createQuery());
  P._drain = () => {
    const gl = P._gl, ext = P._ext;
    if (!gl || !ext) return;
    const keep = [];
    for (const e of P._pending) {
      if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) { keep.push(e); continue; }
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(e.q, gl.QUERY_RESULT);
      const rec = P._rec.get(e.n);
      if (rec) rec.gpuMs = disjoint ? null : ns / 1e6;
      P._pool.push(e.q);
    }
    P._pending = keep;
  };


  /* ---------------------------------------------------------------- setup */

  P.setup = (level) => {
    const CPUClass = KB.cpu && KB.cpu[1] ? KB.cpu[1].constructor : null;
    if (!CPUClass) throw new Error('no CPU class');
    if (!P._cpu0) {
      P._cpu0 = new CPUClass(KB.fighters[0], KB.fighters[1], { level: level || 7 });
      const orig = KB.input.commandsFor.bind(KB.input);
      KB.input.commandsFor = (i, f) => (i === 0 ? P._cpu0.think(KB.tick) : orig(i, f));
    }
    KB.cpu[1].setLevel(level || 7);

    if (KB.menus && KB.menus.show) KB.menus.show(null);
    KB.paused = false;
    KB.startMatch(0, 1);
    KB.setPhase('fight');
    KB.fightCamera.cinematic('fight');

    if (!P._sustain) {
      P._sustain = true;
      const pump = () => {
        if (KB.phase !== 'fight') KB.setPhase('fight');
        KB.roundTimer = 99 * 60;
        for (const f of KB.fighters) if (f.health < 70) f.health = 180;
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
    }

    rp.effects.adaptiveResolution = false;

    if (!P._wrapped) {
      P._wrapped = true;
      const origRender = rp.render.bind(rp);
      rp.render = (scene, cam, dt) => {
        const t0 = performance.now();
        origRender(scene, cam, dt);
        P._lastCpuMs = performance.now() - t0;
      };
      hookComposer();
    }

    const gl = rp.renderer.getContext();
    P._gl = gl;
    P._ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    P.info.timerExt = !!P._ext;
    P.info.webgl2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    P.info.dpr = window.devicePixelRatio;
    P.info.tier = rp.quality;
    P.info.tierScale = rp.tier ? rp.tier.renderScale : null;
    P.info.passes = Object.keys(rp._passes || {});
    P.info.chain = rp.composer.passes.map((p) => p.constructor.name);
    return P.info;
  };

  P.gpu = (mode) => { P._gpuMode = mode; return P._gpuMode; };

  /* ------------------------------------------------------------ sampling */

  P.setScale = (s) => {
    rp.effects.adaptiveResolution = false;
    rp.renderScale = s;
    rp._targetScale = s;
    rp.resize();
    hookComposer();
    const b = rp.composer && rp.composer.readBuffer;
    if (P._stub) P._stub.setSize(b.width, b.height);
    return { scale: rp.renderScale, pixels: b ? b.width + 'x' + b.height : null };
  };

  P.state = () => {
    const b = rp.composer && rp.composer.readBuffer;
    return {
      scale: +rp.renderScale.toFixed(3),
      pixels: b ? b.width + 'x' + b.height : null,
      adaptive: rp.effects.adaptiveResolution,
      phase: KB.phase,
      hp: KB.fighters.map((f) => Math.round(f.health)),
      drawCalls: rp.stats.drawCalls,
      triangles: rp.stats.triangles,
      programs: rp.stats.programs,
    };
  };

  /**
   * Times a window of real frames. Returns per-frame rAF intervals plus the
   * per-frame CPU and GPU records, tagged with the alternation parity.
   */
  P.sample = (ms, discardMs) => new Promise((res) => {
    const dts = [];
    const marks = [];
    let last = performance.now();
    let t0 = null;
    let startFrame = null;
    const tick = (now) => {
      const dt = now - last; last = now;
      if (t0 === null) { t0 = now; requestAnimationFrame(tick); return; }
      const el = now - t0;
      if (el >= (discardMs || 0)) {
        if (startFrame === null) startFrame = P._frameNo;
        dts.push(dt);
        marks.push(P._frameNo);
      }
      if (el < (discardMs || 0) + ms) requestAnimationFrame(tick);
      else {
        const endFrame = P._frameNo;
        const wall = el - (discardMs || 0);
        // Let the last GPU queries land.
        setTimeout(() => {
          P._drain();
          const frames = [];
          for (let n = startFrame; n <= endFrame; n++) {
            const r = P._rec.get(n);
            if (r) frames.push({ n, p: r.parity, c: +r.cpuMs.toFixed(3), g: r.gpuMs === null ? null : +r.gpuMs.toFixed(3) });
          }
          res({ dts, wall, frameCount: endFrame - startFrame, frames, state: P.state() });
        }, 250);
      }
    };
    requestAnimationFrame(tick);
  });

  /* ------------------------------------------------------------ ablation */

  P.passList = () => rp.composer.passes.map((p, i) => ({ i, ctor: p.constructor.name,
    name: Object.keys(rp._passes).find((k) => rp._passes[k] === p) || (p._kbStub ? 'taaStub' : '?'),
    enabled: p.enabled !== false }));

  /** Enable or disable a named pipeline pass for a whole block. */
  P.setPass = (name, on) => {
    const p = rp._passes[name];
    if (!p) return false;
    p.enabled = !!on;
    return true;
  };
  P.allOn = () => { for (const k of Object.keys(rp._passes)) rp._passes[k].enabled = true; return true; };

  /** Toggle a named pipeline pass on odd frames only. */
  P.altPass = (name) => {
    const p = name ? rp._passes[name] : null;
    if (name && !p) return false;
    P._alt = p ? ((parity) => { p.enabled = parity === 1; }) : null;
    if (!name) for (const k of Object.keys(rp._passes)) rp._passes[k].enabled = true;
    return true;
  };

  /** Toggle the inserted temporal stand-in on odd frames only. */
  P.altStub = () => {
    if (!P._stub) return false;
    const s = P._stub;
    P._alt = (parity) => { s.enabled = parity === 1; };
    return true;
  };

  /** Null control: alternate a pass between enabled and enabled. */
  P.altNull = () => { P._alt = () => {}; return true; };
  P.altOff = () => { P._alt = null; if (P._stub) P._stub.enabled = true;
    for (const k of Object.keys(rp._passes)) rp._passes[k].enabled = true; return true; };

  /* ------------------------------------------------- temporal stand-in pass */

  function makeStub(mode, store) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

    const VS = 'precision highp float;\nin vec3 position;\nin vec2 uv;\nout vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    const FS = 'precision highp float;\nprecision highp sampler2D;\nin vec2 vUv;\nout vec4 outColor;\nuniform sampler2D tDiffuse;\nuniform sampler2D tHistory;\nuniform vec2 uTexel;\nuniform float uBlend;\nuniform int uMode;\nvoid main(){ vec4 cur = texture(tDiffuse, vUv); vec4 hist = texture(tHistory, vUv); if (uMode == 1) { vec3 lo = cur.rgb; vec3 hi = cur.rgb; for (int y = -1; y <= 1; y++) { for (int x = -1; x <= 1; x++) { vec3 c = texture(tDiffuse, vUv + vec2(float(x), float(y)) * uTexel).rgb; lo = min(lo, c); hi = max(hi, c); } } hist.rgb = clamp(hist.rgb, lo, hi); } outColor = vec4(mix(cur.rgb, hist.rgb, uBlend), cur.a); }';
    const CS = 'precision highp float;\nprecision highp sampler2D;\nin vec2 vUv;\nout vec4 outColor;\nuniform sampler2D tDiffuse;\nvoid main(){ outColor = texture(tDiffuse, vUv); }';

    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tDiffuse: { value: null }, tHistory: { value: null },
        uTexel: { value: new THREE.Vector2(1 / 1632, 1 / 918) },
        uBlend: { value: 0.9 }, uMode: { value: mode },
      },
      vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false,
    });
    const copyMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tDiffuse: { value: null } },
      vertexShader: VS, fragmentShader: CS, depthTest: false, depthWrite: false,
    });
    const scene = new THREE.Scene();
    const cam = new THREE.Camera();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);

    const mkRT = (w, h) => new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    const hist = [mkRT(2, 2), mkRT(2, 2)];
    let flip = 0;

    return {
      enabled: true, needsSwap: true, renderToScreen: false, clear: false,
      isPass: true, _kbStub: true,
      setSize(w, h) {
        hist[0].setSize(w, h); hist[1].setSize(w, h);
        mat.uniforms.uTexel.value.set(1 / w, 1 / h);
      },
      render(renderer, writeBuffer, readBuffer) {
        mat.uniforms.tDiffuse.value = readBuffer.texture;
        mat.uniforms.tHistory.value = hist[flip].texture;
        mesh.material = mat;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        renderer.render(scene, cam);
        if (store) {
          copyMat.uniforms.tDiffuse.value = this.renderToScreen ? readBuffer.texture : writeBuffer.texture;
          mesh.material = copyMat;
          renderer.setRenderTarget(hist[1 - flip]);
          renderer.render(scene, cam);
        }
        flip = 1 - flip;
      },
      dispose() { hist[0].dispose(); hist[1].dispose(); geo.dispose(); mat.dispose(); copyMat.dispose(); },
    };
  }

  P.addStub = (mode, store) => {
    P.removeStub();
    const stub = makeStub(mode, store);
    const passes = rp.composer.passes;
    let idx = passes.indexOf(rp._passes.grade);
    if (idx < 0) idx = passes.length;
    const b = rp.composer.readBuffer;
    stub.setSize(b.width, b.height);
    passes.splice(idx, 0, stub);
    P._stub = stub;
    return { index: idx, total: passes.length, size: b.width + 'x' + b.height };
  };

  P.removeStub = () => {
    if (!P._stub) return false;
    const passes = rp.composer.passes;
    const i = passes.indexOf(P._stub);
    if (i >= 0) passes.splice(i, 1);
    P._stub.dispose();
    P._stub = null;
    return true;
  };

  return P.info;
})();
