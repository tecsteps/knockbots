/*
 * Page side of tools/aogate.mjs -- A/B of the GTAO normal source on a LIVE fight.
 *
 * Loaded as raw text and eval'd in the page. No backtick appears anywhere in
 * this file, so the driver may embed it in a template literal.
 *
 * This is tools/passbudget-page.js with one thing added and one thing changed.
 *
 *  1. WHAT IS BEING A/B'd IS INVISIBLE IN THE ARMED PASS LIST. Both arms run
 *     'scene ao bloom dof motionBlur grade smaa output overlay'. The difference
 *     is which code path the GTAO and Poisson-denoise fragment shaders take for
 *     getViewNormal:
 *       depth  -- NORMAL_VECTOR_TYPE 0, computeNormalFromDepth inlined at every
 *                 call site: 9 texelFetch + 3 unprojections, ONCE in the GTAO
 *                 shader and ONCE PER POISSON TAP in the denoise (13 of them).
 *       shared -- NORMAL_VECTOR_TYPE 1, one textureLod of a half-res packed
 *                 normal buffer that HalfResGtaoPass renders once per frame.
 *     So the armed-pass assertion is necessary and NOT sufficient here, and the
 *     probe asserts the DEFINES on both materials plus the identity of the
 *     normal texture, before and after every block.
 *
 *  2. AND IT HAS ITS OWN CONFIG HAZARD, of exactly the shape the composer one
 *     has. GTAOPass.normalTexture is a plain field; only setGBuffer() moves the
 *     defines with it. Assigning rp._passes.ao.normalTexture = tex sets the
 *     field, leaves NORMAL_VECTOR_TYPE at 0 -- so both shaders keep
 *     reconstructing -- and, because HalfResGtaoPass.render keys off exactly
 *     that field, ALSO switches the normal prepass on. That state pays for the
 *     buffer and then does not read it: it is strictly the worst arm available
 *     and it looks correct from the pass list. hazard() reproduces it and shows
 *     the assertion firing on it.
 *
 *  3. SETUP CONTROL ON THE ABLATION ITSELF. The normal prepass is counted by
 *     wrapping the pass's own quad render. A 'shared' block must show one
 *     normal render per frame and a 'depth' block must show zero -- measured,
 *     not inferred from a define.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const P = {};
  window.__ao = P;

  P.EFFECTS = ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa'];
  P.MANAGED = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output', 'overlay'];
  P._ivals = [];
  P._cpu = [];
  P._last = null;
  P._collect = false;
  P._forcedPhase = 0;
  P._rebuilds = 0;
  P._forceOff = [];
  P._normalRenders = 0;
  P._frames = 0;
  P._chopHook = null;
  P._aoRepeat = 1;

  /* ------------------------------------------------------------ chain names */

  const PREF = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output'];

  const nameOf = (pass) => {
    const keys = Object.keys(rp._passes).filter((k) => rp._passes[k] === pass);
    for (const p of PREF) if (keys.indexOf(p) >= 0) return p;
    if (keys.length) return keys[0];
    if (pass.constructor.name === 'OverlayPass') return 'overlay';
    return '?' + pass.constructor.name;
  };

  P.armed = () => rp.composer.passes.map((p) => nameOf(p) + (p.enabled === false ? ':OFF' : ''));

  P.expect = (cfg) => {
    const t = rp.tier;
    const e = cfg.effects;
    const off = cfg.off || [];
    const wantsDepth = !!(t.depth && (e.ao || e.dof || e.motionBlur));
    const list = [];
    list.push(wantsDepth ? 'scene' : 'render');
    if (t.ao && e.ao && wantsDepth) list.push('ao');
    if (t.bloom && e.bloom) list.push('bloom');
    if (t.dof && e.dof && wantsDepth) list.push('dof');
    if (t.motionBlur && e.motionBlur && wantsDepth) list.push('motionBlur');
    if (t.grade && e.grade) list.push('grade');
    if (t.smaa && e.smaa) list.push('smaa');
    list.push('output');
    list.push('overlay');
    return list.map((n) => (off.indexOf(n) >= 0 ? n + ':OFF' : n));
  };

  /* --------------------------------------------------------- the AO knobs */

  const aoPass = () => rp._passes.ao || null;
  const sceneDepth = () => (rp._passes.scene ? rp._passes.scene.liveDepth : null);

  /**
   * Sets the normal source. setGBuffer is the ONLY entry point that moves
   * NORMAL_VECTOR_TYPE on both materials, which is what makes the ablation
   * real; assigning normalTexture would not (see hazard()).
   *   'shared' -- the pass's own half-res packed normal buffer  (the change)
   *   'depth'  -- no normal texture, both shaders reconstruct   (as shipped)
   */
  P.setNormalMode = (mode) => {
    const ao = aoPass();
    if (!ao) return null;
    const d = sceneDepth();
    if (mode === 'depth') ao.setGBuffer(d, undefined);
    else ao.setGBuffer(d, ao.viewNormals.texture);
    P.instrumentAo();
    return P.aoState();
  };

  /** Poisson denoise tap count, for the secondary arms. */
  P.setPdSamples = (n) => {
    const ao = aoPass();
    if (ao) ao.updatePdMaterial({ samples: n });
  };

  /**
   * GTAO trace sample count. Also a pure define flip, so it can be chopped at
   * the same rate as the normal source. three derives DIRECTIONS = 3 and
   * STEPS = ceil(SAMPLES/3) from it, and each step costs two depth taps, so
   * 11 -> 3 takes the trace from 3x4x2 = 24 taps to 3x1x2 = 6.
   */
  P.setGtaoSamples = (n) => {
    const ao = aoPass();
    if (ao) ao.updateGtaoMaterial({ samples: n });
  };

  /**
   * Counts the normal prepass, and installs the AMPLIFIER. Re-applied after
   * every composer rebuild because a rebuild makes a brand new pass object.
   */
  P.instrumentAo = () => {
    const ao = aoPass();
    if (!ao) return;
    if (ao._normalQuad && !ao._normalQuad.__aoWrapped) {
      const q = ao._normalQuad;
      const orig = q.render.bind(q);
      q.render = (r) => { P._normalRenders++; return orig(r); };
      q.__aoWrapped = true;
    }
    if (!ao.__aoRepWrapped) {
      const orig = ao.render.bind(ao);
      ao.render = (r, wb, rb, dt, ma) => {
        const n = P._aoRepeat | 0;
        if (n > 1) {
          // GTAOPass.OUTPUT.Off is -1: the pass renders the normal prepass, the
          // GTAO trace and the Poisson denoise, and then writes NOTHING. So K-1
          // extra invocations multiply exactly the cost under test and leave the
          // delivered image bit-identical to K = 1.
          const saved = ao.output;
          ao.output = -1;
          for (let i = 1; i < n; i++) orig(r, wb, rb, dt, ma);
          ao.output = saved;
        }
        return orig(r, wb, rb, dt, ma);
      };
      ao.__aoRepWrapped = true;
    }
  };

  /**
   * COST AMPLIFIER. On a box this contended the per-frame difference under test
   * is ~1 ms against a noise floor several times that. Running the AO trace and
   * its denoise K times per frame multiplies the SIGNAL by K and leaves the
   * NOISE where it is.
   *
   * What it measures is the MARGINAL cost of a repeat, with the depth texture
   * and the noise textures already hot in cache. That is not identical to the
   * cost of the first execution, so an amplified estimate is a statement about
   * K executions divided by K, and it is cross-checked against the unamplified
   * arms rather than replacing them.
   */
  P.setAoRepeat = (k) => { P._aoRepeat = k | 0; P.instrumentAo(); };

  P.aoState = () => {
    const ao = aoPass();
    if (!ao) return { present: false };
    return {
      present: true,
      gtaoNVT: ao.gtaoMaterial.defines.NORMAL_VECTOR_TYPE,
      pdNVT: ao.pdMaterial.defines.NORMAL_VECTOR_TYPE,
      wired: ao.normalTexture === ao.viewNormals.texture,
      hasNormalTexture: !!ao.normalTexture,
      aoSize: ao.width + 'x' + ao.height,
      normalSize: ao.viewNormals.width + 'x' + ao.viewNormals.height,
      gtaoSamples: ao.gtaoMaterial.defines.SAMPLES,
      pdSamples: ao.pdSamples,
      blendIntensity: +ao.blendIntensity.toFixed(3),
      aoRepeat: P._aoRepeat | 0,
      amplifierInstalled: !!ao.__aoRepWrapped,
      radius: +ao.gtaoMaterial.uniforms.radius.value.toFixed(3),
      instrumented: !!(ao._normalQuad && ao._normalQuad.__aoWrapped),
    };
  };

  /** The (gtaoNVT, pdNVT, wired) triple a mode must produce. */
  P.expectAo = (cfg) => {
    if (!cfg.effects.ao) return null;
    const shared = cfg.normals !== 'depth';
    return { gtaoNVT: shared ? 1 : 0, pdNVT: shared ? 1 : 0, wired: shared, pdSamples: cfg.pdSamples || 12 };
  };

  /* ------------------------------------------------------------------ setup */

  P.setup = (opts) => {
    const o = opts || {};
    const level = o.level || 7;

    if (!P._cpu0) {
      const CPUClass = KB.cpu && KB.cpu[1] ? KB.cpu[1].constructor : null;
      if (!CPUClass) throw new Error('no CPU class on KB.cpu[1]');
      P._cpu0 = new CPUClass(KB.fighters[0], KB.fighters[1], { level });
      const orig = KB.input.commandsFor.bind(KB.input);
      KB.input.commandsFor = (i, f) => (i === 0 ? P._cpu0.think(KB.tick) : orig(i, f));
    }
    KB.cpu[1].setLevel(level);

    if (KB.menus && KB.menus.show) KB.menus.show(null);
    if (KB.debug) KB.debug.freecam = false;
    KB.paused = false;
    KB.timeScale = 1;
    KB.startMatch(0, 1);
    KB.setPhase('fight');
    if (KB.fightCamera && KB.fightCamera.cinematic) KB.fightCamera.cinematic('fight');

    KB.training = true;

    if (!P._pump) {
      P._pump = true;
      const pump = () => {
        if (KB.phase !== 'fight') { KB.setPhase('fight'); P._forcedPhase++; }
        KB.training = true;
        for (const f of KB.fighters) if (f.health < 140) f.health = 180;
        const passes = rp.composer ? rp.composer.passes : [];
        for (const p of passes) {
          const n = nameOf(p);
          if (P.MANAGED.indexOf(n) < 0) continue;
          const want = P._forceOff.indexOf(n) < 0;
          if (p.enabled !== want) p.enabled = want;
        }
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
    }

    rp.setEffect('adaptiveResolution', false);
    if (rp.quality !== 'high') rp.setQuality('high');

    if (!P._hooked) {
      P._hooked = true;
      const origRender = rp.render.bind(rp);
      rp.render = (scene, cam, dt) => {
        const t = performance.now();
        P._frames++;
        if (P._chopHook) P._chopHook(t);
        if (P._collect) {
          if (P._last !== null) P._ivals.push(t - P._last);
          P._last = t;
        }
        origRender(scene, cam, dt);
        if (P._collect) P._cpu.push(performance.now() - t);
      };
      const origSet = rp.setEffect.bind(rp);
      rp.setEffect = (n, v) => { P._rebuilds++; return origSet(n, v); };
    }

    P.instrumentAo();

    const gl = rp.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      quality: rp.quality,
      tier: JSON.parse(JSON.stringify(rp.tier)),
      dpr: window.devicePixelRatio,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      armed: P.armed(),
      ao: P.aoState(),
      effects: JSON.parse(JSON.stringify(rp.effects)),
    };
  };

  /* --------------------------------------------------------------- snapshot */

  P.snapshot = () => {
    const b = rp.composer && rp.composer.readBuffer;
    return {
      armed: P.armed(),
      ao: P.aoState(),
      scale: +rp.renderScale.toFixed(4),
      pixels: b ? b.width + 'x' + b.height : null,
      adaptive: !!rp.effects.adaptiveResolution,
      shadowMapOn: !!rp.renderer.shadowMap.enabled,
      split: !!rp.effects.splitLighting,
      passSplit: rp._passes.scene ? !!rp._passes.scene.splitLighting : null,
      quality: rp.quality,
      phase: KB.phase,
      tick: KB.tick,
      drawCalls: rp.stats.drawCalls,
      triangles: rp.stats.triangles,
      sceneDrawCalls: rp.stats.sceneDrawCalls,
      programs: rp.stats.programs,
      hp: KB.fighters.map((f) => Math.round(f.health)),
      sep: +Math.abs(KB.fighters[0].position.x - KB.fighters[1].position.x).toFixed(2),
      camDist: +KB.camera.position.distanceTo(KB.fighters[0].position).toFixed(2),
      forcedPhase: P._forcedPhase,
      rebuilds: P._rebuilds,
      normalRenders: P._normalRenders,
      frames: P._frames,
    };
  };

  /* ------------------------------------------------------------------ apply */

  /**
   * cfg = { effects:{...}, scale, normals:'shared'|'depth', pdSamples, off:[] }
   *
   * Exactly one composer rebuild is issued even when nothing changed, so every
   * block is preceded by the same allocation event. The normal mode is applied
   * AFTER the rebuild, because a rebuild produces a new pass with the shipped
   * default (shared) already wired.
   */
  P.apply = (cfg) => {
    const before = P._rebuilds;

    if (typeof cfg.scale === 'number' && Math.abs(rp.renderScale - cfg.scale) > 1e-6) {
      rp.setEffect('adaptiveResolution', false);
      rp.renderScale = cfg.scale;
      rp._targetScale = cfg.scale;
      rp.resize();
    }

    const changed = [];
    for (const k of P.EFFECTS) {
      const want = !!cfg.effects[k];
      if (!!rp.effects[k] !== want) { rp.setEffect(k, want); changed.push(k); }
    }
    if (changed.length === 0) {
      rp.setEffect('bloom', !!rp.effects.bloom);
      changed.push('(no-op rebuild)');
    }

    P.instrumentAo();
    P.setNormalMode(cfg.normals === 'depth' ? 'depth' : 'shared');
    P.setPdSamples(cfg.pdSamples || 12);

    P._forceOff = (cfg.off || []).slice();
    rp.setEffect('adaptiveResolution', false);
    return { changed, rebuilds: P._rebuilds - before, forceOff: P._forceOff, armed: P.armed(), ao: P.aoState() };
  };

  /* --------------------------------------------------------------- sampling */

  P.sample = (ms) => new Promise((res) => {
    P._ivals = [];
    P._cpu = [];
    P._last = null;
    const forced0 = P._forcedPhase;
    const nr0 = P._normalRenders;
    const fr0 = P._frames;
    const t0 = performance.now();
    P._collect = true;
    setTimeout(() => {
      P._collect = false;
      const wall = performance.now() - t0;
      res({
        ivals: P._ivals.slice(),
        cpu: P._cpu.slice(),
        wall,
        forcedPhase: P._forcedPhase - forced0,
        normalRenders: P._normalRenders - nr0,
        renderCalls: P._frames - fr0,
      });
    }, ms);
  });

  /* ------------------------------------------------------------------- chop */

  /**
   * FAST ALTERNATION. The ABBA-quad rig pairs blocks ~3 s apart; on a box where
   * four sibling headless Chromiums are fighting for the GPU, the load moves
   * inside that gap and the pairing does not cancel it -- measured, in the first
   * session run with this file: the NULL arm came back +2.85 ms on p50 with a
   * CI that excluded zero. So this pairs at ~0.7 s instead.
   *
   * It is only possible for THIS comparison, and that is the point: setGBuffer
   * moves a #define on two materials and nothing else. There is no composer
   * rebuild, no reallocation, no pass construction -- and once both variants are
   * in three's program cache the flip is a cache hit. So the two arms can be
   * interleaved at a rate the contention cannot follow. DROP frames after each
   * flip are discarded so that a cache miss, if it happens, is never measured.
   *
   * Returns per-segment interval arrays. Consecutive segments are the pair.
   */
  P.chop = (opt) => new Promise((res) => {
    const modes = opt.modes;
    const segMs = opt.segMs || 700;
    const nSeg = opt.segs || 200;
    const drop = opt.drop === undefined ? 6 : opt.drop;
    const pd = opt.pdSamples || null;      // parallel per-mode pdSamples, or null
    const rep = opt.repeat || null;        // parallel per-slot AO repeat count
    const gs = opt.gtaoSamples || null;    // parallel per-slot GTAO trace samples
    const out = [];
    let seg = -1;
    let cur = null;
    let dropLeft = 0;

    P._chopHook = (t) => {
      if (!cur) return;
      if (dropLeft > 0) { dropLeft--; cur.last = t; return; }
      if (cur.last !== null) cur.ivals.push(t - cur.last);
      cur.last = t;
    };

    const next = () => {
      if (cur) {
        out.push({
          i: seg, mode: cur.mode, ivals: cur.ivals,
          normalRenders: P._normalRenders - cur.nr0,
          frames: P._frames - cur.fr0,
          state: P.aoState(),
        });
      }
      seg++;
      if (seg >= nSeg) { cur = null; P._chopHook = null; return res({ segs: out }); }
      const mode = modes[seg % modes.length];
      P.setNormalMode(mode);
      if (pd) P.setPdSamples(pd[seg % pd.length]);
      if (rep) P.setAoRepeat(rep[seg % rep.length]);
      if (gs) P.setGtaoSamples(gs[seg % gs.length]);
      cur = { mode, ivals: [], last: null, nr0: P._normalRenders, fr0: P._frames };
      dropLeft = drop;
      setTimeout(next, segMs);
    };
    next();
  });

  /* --------------------------------------------------- setup control: hazard */

  /**
   * The trap this probe is built to avoid, reproduced on purpose, plus a
   * POSITIVE CONTROL ON THE ASSERTION: it produces a state expectAo() must
   * reject, which proves the assertion is capable of failing.
   */
  P.hazard = () => {
    const out = {};
    const full = { effects: { ao: 1, bloom: 1, dof: 1, motionBlur: 1, grade: 1, smaa: 1 }, scale: 0.85, normals: 'shared' };
    P.apply(full);
    out.shared = P.aoState();

    P.setNormalMode('depth');
    out.depth = P.aoState();

    // The trap: move the field without moving the defines.
    const ao = aoPass();
    ao.normalTexture = ao.viewNormals.texture;
    out.afterDirectAssign = P.aoState();
    out.assertionWouldFlag = out.afterDirectAssign.gtaoNVT !== 1 || out.afterDirectAssign.pdNVT !== 1;
    out.trapPaysAndDoesNotRead =
      out.afterDirectAssign.wired === true && out.afterDirectAssign.pdNVT === 0;

    P.setNormalMode('shared');
    out.restored = P.aoState();
    out.restoredMatchesShared =
      out.restored.gtaoNVT === out.shared.gtaoNVT &&
      out.restored.pdNVT === out.shared.pdNVT &&
      out.restored.wired === out.shared.wired;
    return out;
  };

  return { ok: true };
})();
