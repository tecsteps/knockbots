/*
 * Page side of tools/tapbudget.mjs -- does cutting DOF / motion-blur TAPS buy
 * any p95 at all?
 *
 * Loaded as raw text and eval'd in the page. No backtick appears inside any
 * comment here, so the driver may embed this file in a template literal.
 *
 * Inherits every load-bearing rule from tools/passbudget-page.js (config only
 * through setEffect, armed-list assertion per block, frame interval sampled at
 * RenderPipeline#render entry, round never allowed to end). Three things are
 * added, and all three exist because this experiment is about a #define rather
 * than about a pass being present:
 *
 *  A. THE DEFINES ARE PART OF THE ASSERTED STATE. DOF_ADAPTIVE, MB_ADAPTIVE,
 *     DOF_TAPS and MB_TAPS are read off the live ShaderMaterial before AND after
 *     every block and compared with what the condition asked for. A #define that
 *     did not take is exactly the class of failure that voided a previous round
 *     of work on this file -- a flag set, nothing rebuilt.
 *
 *  B. NESTED BOUNDS, not a single A/B. Three arms bracket the candidate:
 *       adaptive    the change under test
 *       taps-floor  dofTaps 14->4, mbTaps 8->2, an unconditional cut that is
 *                   strictly more aggressive than any adaptive scheme can be
 *       no-dofmb    both passes gone
 *     If taps-floor cannot be told from the baseline, no tap-count scheme can,
 *     and the candidate is closed by arithmetic rather than by opinion.
 *
 *  C. THE OPTIMISATION IS PROVEN TO FIRE. tapReport() re-renders the live DOF and
 *     motion-blur materials into a private LDR target with a debug #define that
 *     writes the tap count the pixel chose, and reads it back. That turns "no
 *     win" into either "no win because nothing was saved" or "no win despite
 *     saving N% of the taps", which are completely different findings.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const P = {};
  window.__tb = P;

  P.EFFECTS = ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa'];
  P.MANAGED = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output', 'overlay'];
  P._ivals = [];
  P._cpu = [];
  P._last = null;
  P._collect = false;
  P._forcedPhase = 0;
  P._rebuilds = 0;
  P._forceOff = [];

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

  /** The #defines actually compiled into the two tap-loop materials. */
  P.defines = () => {
    const d = rp._passes.dof, m = rp._passes.motionBlur;
    return {
      dofTaps: d ? d.material.defines.DOF_TAPS : null,
      dofAdaptive: d ? d.material.defines.DOF_ADAPTIVE : null,
      mbTaps: m ? m.material.defines.MB_TAPS : null,
      mbAdaptive: m ? m.material.defines.MB_ADAPTIVE : null,
      flag: !!rp.adaptiveTaps,
      tierDofTaps: rp.tier.dofTaps,
      tierMbTaps: rp.tier.mbTaps,
    };
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

    P._tierDof0 = rp.tier.dofTaps;
    P._tierMb0 = rp.tier.mbTaps;

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

    const gl = rp.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      quality: rp.quality,
      tier: JSON.parse(JSON.stringify(rp.tier)),
      dpr: window.devicePixelRatio,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      armed: P.armed(),
      defines: P.defines(),
      effects: JSON.parse(JSON.stringify(rp.effects)),
    };
  };

  /* --------------------------------------------------------------- snapshot */

  P.snapshot = () => {
    const b = rp.composer && rp.composer.readBuffer;
    return {
      armed: P.armed(),
      defines: P.defines(),
      scale: +rp.renderScale.toFixed(4),
      pixels: b ? b.width + 'x' + b.height : null,
      adaptive: !!rp.effects.adaptiveResolution,
      shadows: !!rp.effects.shadows,
      shadowMapOn: !!rp.renderer.shadowMap.enabled,
      split: !!rp.effects.splitLighting,
      passSplit: rp._passes.scene ? !!rp._passes.scene.splitLighting : null,
      amp: P.ampState(),
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
    };
  };

  /* ------------------------------------------------------------------ apply */

  /**
   * cfg = { effects:{...}, scale, tapsDof, tapsMb, adaptiveTaps, off:[] }
   *
   * Order matters. rp.adaptiveTaps and rp.tier.* are read at composer BUILD time
   * for the tap counts and every frame by #syncPasses for the adaptive define,
   * so both are set BEFORE the rebuild and the rebuild is unconditional, which
   * keeps every block preceded by the same allocation event.
   */
  P.apply = (cfg) => {
    const before = P._rebuilds;

    if (typeof cfg.scale === 'number' && Math.abs(rp.renderScale - cfg.scale) > 1e-6) {
      rp.setEffect('adaptiveResolution', false);
      rp.renderScale = cfg.scale;
      rp._targetScale = cfg.scale;
      rp.resize();
    }

    rp.adaptiveTaps = !!cfg.adaptiveTaps;
    rp.tier.dofTaps = cfg.tapsDof === undefined ? P._tierDof0 : cfg.tapsDof;
    rp.tier.mbTaps = cfg.tapsMb === undefined ? P._tierMb0 : cfg.tapsMb;

    const changed = [];
    for (const k of P.EFFECTS) {
      const want = !!cfg.effects[k];
      if (!!rp.effects[k] !== want) { rp.setEffect(k, want); changed.push(k); }
    }
    // Always exactly one more rebuild, so the tap-count #defines above are
    // guaranteed to be picked up and every block sees the same event.
    rp.setEffect('bloom', !!rp.effects.bloom);
    changed.push('(forced rebuild)');

    P._forceOff = (cfg.off || []).slice();
    // After the rebuild, never before: a rebuild throws the pass objects away
    // and the wrapper would go with them.
    P._amp = cfg.amp || 0;
    P.wrapAmp();

    rp.setEffect('adaptiveResolution', false);
    return { changed, rebuilds: P._rebuilds - before, forceOff: P._forceOff, armed: P.armed(), defines: P.defines(), amp: P.ampState() };
  };

  /* ------------------------------------------------------------- amplifier */

  /**
   * THE AMPLIFIER, and it exists because the machine this runs on is shared.
   *
   * A tap loop costs a fraction of a millisecond. At loadavg 10 the frame
   * interval's p95 is 50 ms and is set by scheduler contention, which is CPU and
   * ADDITIVE on top of -- not proportional to -- the GPU cost of a fullscreen
   * gather. A direct A/B of a 0.3 ms saving against that is not underpowered, it
   * is unresolvable.
   *
   * So: after the pass has done its real work, its fullscreen quad is re-rendered
   * K more times into a scratch target of the SAME size, with the SAME uniforms
   * the real render just bound. The visible frame is untouched (the extra draws
   * go nowhere), and the pass's per-frame GPU cost appears in the frame interval
   * multiplied by (K+1). A saving of 0.3 ms becomes 7.2 ms at K = 24.
   *
   * WHAT THIS CAN AND CANNOT SAY, stated up front rather than in a footnote:
   *   - It measures the pass's MARGINAL GPU cost, and it assumes that cost is
   *     linear in the number of invocations. Twenty-five back-to-back copies
   *     will find tDiffuse and tDepth hot in cache, so if anything this
   *     UNDERSTATES a bandwidth-bound pass -- which is the safe direction for a
   *     claim of the form "there is nothing here".
   *   - It does not see CPU-side or state-change cost. For a fullscreen quad
   *     with pre-bound uniforms that is a fair simplification; for a pass that
   *     rebuilds a scene it would not be.
   *   - It is therefore an ATTRIBUTION instrument. The verdict on p95 stays with
   *     the direct A/B. This is here to say, with a resolvable signal, HOW BIG
   *     the thing being argued about is.
   * The 'amp-off' arm is its positive control: K copies removed entirely must
   * recover (K+1)x the ablation cost that tools/passbudget.mjs measured for
   * these same two passes by a completely different method.
   */
  P._amp = 0;
  P._ampWrapped = new WeakSet();

  const ensureScratch = () => {
    const THREE = KB.THREE;
    const b = rp.composer && rp.composer.readBuffer;
    if (!b) return null;
    if (!P._scratch || P._scratch.width !== b.width || P._scratch.height !== b.height) {
      P._scratch?.dispose();
      P._scratch = new THREE.WebGLRenderTarget(b.width, b.height, {
        type: b.texture.type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      });
    }
    return P._scratch;
  };

  /** Wraps the tap-loop passes. Must be re-run after every composer rebuild,
   *  because a rebuild throws the pass objects away. */
  P.wrapAmp = () => {
    for (const key of ['dof', 'motionBlur']) {
      const pass = rp._passes[key];
      if (!pass || P._ampWrapped.has(pass)) continue;
      P._ampWrapped.add(pass);
      const orig = pass.render.bind(pass);
      pass.render = (renderer, writeBuffer, readBuffer, dt, mask) => {
        orig(renderer, writeBuffer, readBuffer, dt, mask);
        if (P._amp <= 0) return;
        const s = ensureScratch();
        if (!s) return;
        renderer.setRenderTarget(s);
        for (let i = 0; i < P._amp; i++) pass._fsQuad.render(renderer);
      };
    }
  };

  P.ampState = () => ({
    amp: P._amp,
    wrapped: ['dof', 'motionBlur'].filter((k) => rp._passes[k] && P._ampWrapped.has(rp._passes[k])),
    scratch: P._scratch ? P._scratch.width + 'x' + P._scratch.height : null,
    buffer: rp.composer && rp.composer.readBuffer ? rp.composer.readBuffer.width + 'x' + rp.composer.readBuffer.height : null,
  });

  /* --------------------------------------------------------------- sampling */

  P.sample = (ms) => new Promise((res) => {
    P._ivals = [];
    P._cpu = [];
    P._last = null;
    const forced0 = P._forcedPhase;
    const t0 = performance.now();
    P._collect = true;
    setTimeout(() => {
      P._collect = false;
      const wall = performance.now() - t0;
      res({ ivals: P._ivals.slice(), cpu: P._cpu.slice(), wall, forcedPhase: P._forcedPhase - forced0 });
    }, ms);
  });

  /* ------------------------------------------- setup control: does it fire? */

  /**
   * Renders the live DOF and MotionBlur materials once more, into a private
   * 8-bit target, with DOF_DEBUG_TAPS / MB_DEBUG_TAPS set so red carries the tap
   * count the pixel chose and green carries whether the pixel took the loop at
   * all. Reads it back and returns the distribution.
   *
   * It re-uses the pass's own material and uniforms, so the depth, focus,
   * resolution and velocity state are exactly the ones the real frame just ran
   * with. tDiffuse is irrelevant to the tap count and is left as-is.
   *
   * Restores every #define it touched and forces a recompile back, so the block
   * that follows is running the shader it says it is.
   */
  P.tapReport = (samples) => {
    const THREE = KB.THREE;
    if (!THREE) return { error: 'THREE not exposed on window.KB' };
    const out = {};
    const W = 320, H = 180;
    if (!P._dbgRT) {
      P._dbgRT = new THREE.WebGLRenderTarget(W, H, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      });
    }
    const buf = new Uint8Array(W * H * 4);
    const renderer = rp.renderer;
    const prevRT = renderer.getRenderTarget();

    const probe = (pass, dbgKey, tapKey) => {
      if (!pass) return null;
      const maxTaps = pass.material.defines[tapKey];
      pass.material.defines[dbgKey] = 1;
      pass.material.needsUpdate = true;
      renderer.setRenderTarget(P._dbgRT);
      pass._fsQuad.render(renderer);
      renderer.readRenderTargetPixels(P._dbgRT, 0, 0, W, H, buf);
      pass.material.defines[dbgKey] = 0;
      pass.material.needsUpdate = true;

      let taps = 0, active = 0, n = W * H;
      const hist = new Array(maxTaps + 1).fill(0);
      for (let i = 0; i < n; i++) {
        const t = Math.round((buf[i * 4] / 255) * maxTaps);
        const a = buf[i * 4 + 1] > 127;
        if (a) { active++; taps += t; hist[Math.min(t, maxTaps)]++; }
        else hist[0]++;
      }
      return {
        maxTaps,
        activeFrac: +(active / n).toFixed(4),
        meanTapsOverFrame: +(taps / n).toFixed(3),
        meanTapsWhenActive: active ? +(taps / active).toFixed(3) : 0,
        // What fraction of the fixed-count work an adaptive scheme removes.
        savedFrac: +(1 - taps / (n * maxTaps)).toFixed(4),
        hist,
      };
    };

    for (const s of samples || ['fixed', 'adaptive']) {
      const want = s === 'adaptive';
      rp._passes.dof?.setAdaptiveTaps(want);
      rp._passes.motionBlur?.setAdaptiveTaps(want);
      // One real frame so the pass uniforms (focus, velocity) are current and the
      // recompile is done before the probe render.
      out[s] = {
        dof: probe(rp._passes.dof, 'DOF_DEBUG_TAPS', 'DOF_TAPS'),
        mb: probe(rp._passes.motionBlur, 'MB_DEBUG_TAPS', 'MB_TAPS'),
      };
    }

    rp._passes.dof?.setAdaptiveTaps(!!rp.adaptiveTaps);
    rp._passes.motionBlur?.setAdaptiveTaps(!!rp.adaptiveTaps);
    renderer.setRenderTarget(prevRT);
    out.restoredDefines = P.defines();
    return out;
  };

  /* --------------------------------------------------- setup control: hazard */

  /**
   * Two traps demonstrated on purpose, so the report can show they are real and
   * that this probe's assertion is capable of failing:
   *   1. rp.effects.dof = false leaves the pass armed (passbudget's finding).
   *   2. rp.adaptiveTaps = true does NOT change the compiled #define until a
   *      frame runs #syncPasses -- and a composer rebuild throws the pass away
   *      and brings back a fresh one at the default. Both are why the define is
   *      asserted off the live material rather than off the flag.
   */
  P.hazard = async () => {
    const out = {};
    const full = { effects: { ao: 1, bloom: 1, dof: 1, motionBlur: 1, grade: 1, smaa: 1 }, scale: 0.85, adaptiveTaps: false };
    P.apply(full);
    out.boot = P.armed();
    out.bootDefines = P.defines();

    rp.effects.bloom = false;
    out.afterDirectAssign = P.armed();
    out.assertionWouldFlagArmed = out.afterDirectAssign.join(' ')
      !== P.expect({ effects: { ao: 1, bloom: 0, dof: 1, motionBlur: 1, grade: 1, smaa: 1 } }).join(' ');
    rp.effects.bloom = true;

    // Flag flipped, no frame yet: the compiled define must still read 0.
    rp.adaptiveTaps = true;
    out.flagSetNoFrame = P.defines();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.afterOneFrame = P.defines();
    out.defineFollowsFlag = out.flagSetNoFrame.dofAdaptive === 0 && out.afterOneFrame.dofAdaptive === 1;

    // Rebuild with the flag still true: the fresh pass boots at 0 and only
    // #syncPasses puts it back. This is the re-assert path, exercised.
    rp.setEffect('bloom', false); rp.setEffect('bloom', true);
    out.rightAfterRebuild = P.defines();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.rebuildThenFrame = P.defines();
    out.reassertWorks = out.rightAfterRebuild.dofAdaptive === 0 && out.rebuildThenFrame.dofAdaptive === 1;

    rp.adaptiveTaps = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.restoredDefines = P.defines();
    return out;
  };

  return { ok: true };
})();
