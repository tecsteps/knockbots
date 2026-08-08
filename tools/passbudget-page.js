/*
 * Page side of tools/passbudget.mjs -- per-pass frame-budget attribution by
 * ABLATION on a LIVE fight.
 *
 * Loaded as raw text and eval'd in the page. No backtick appears inside any
 * comment here, so the driver may embed this file in a template literal.
 *
 * Design notes that are load-bearing:
 *
 *  1. CONFIG. Every RenderPipeline ablation goes through setEffect, which is the
 *     only entry point that rebuilds the composer. Writing rp.effects.x directly
 *     sets a flag and rebuilds nothing -- see hazard() below, which demonstrates
 *     that on purpose so the report can show the trap is real and that this
 *     probe does not fall into it.
 *
 *  2. SETUP CONTROL. expect(cfg) recomputes the pass chain that #buildComposer
 *     would produce for a config, from the live tier flags, PLUS the OverlayPass
 *     that EffectsDirector re-installs at the end of the chain every frame.
 *     snapshot() reads the chain that is actually armed. The driver compares
 *     them before AND after every measured block and voids the block on any
 *     mismatch.
 *
 *  3. TWO PASSES ARE NOT RenderPipeline EFFECTS. OverlayPass is owned by
 *     EffectsDirector and re-installed on every composer rebuild; OutputPass is
 *     unconditional. Neither has a setEffect key, so both are ablated by
 *     pass.enabled, re-asserted every frame from the pump so the director cannot
 *     silently re-arm them. The meth-* arms exist to show that pass.enabled and
 *     setEffect give the same delta on a pass where both are available.
 *
 *  4. INTERVAL. Frame interval is measured at RenderPipeline#render entry, so a
 *     sample is the wall-clock gap between two consecutive frame submissions.
 *     A separate rAF loop would have undefined ordering against the game's own
 *     render; this cannot.
 *
 *  5. The fight is kept alive without a round ever ending: Game.training is set
 *     directly (NOT via setTraining, which nulls cpu[1]) so the round timer is
 *     refreshed by the sim itself, and health is topped up from a pump. A round
 *     end / KO cinematic inside a block is the single largest content
 *     confounder there is, and this removes it rather than averaging over it.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const P = {};
  window.__pb = P;

  P.EFFECTS = ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa'];
  // Passes this probe is allowed to force on/off through pass.enabled.
  P.MANAGED = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output', 'overlay'];
  P._ivals = [];
  P._cpu = [];
  P._last = null;
  P._collect = false;
  P._forcedPhase = 0;
  P._rebuilds = 0;
  P._forceOff = [];

  /* ------------------------------------------------------------ chain names */

  // Preference order when several keys of rp._passes point at the same pass
  // object (scene and gbuffer are deliberately the same object).
  const PREF = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output'];

  const nameOf = (pass) => {
    const keys = Object.keys(rp._passes).filter((k) => rp._passes[k] === pass);
    for (const p of PREF) if (keys.indexOf(p) >= 0) return p;
    if (keys.length) return keys[0];
    if (pass.constructor.name === 'OverlayPass') return 'overlay';
    return '?' + pass.constructor.name;
  };
  P._nameOf = nameOf;

  const findPass = (name) => {
    if (rp._passes[name]) return rp._passes[name];
    return rp.composer.passes.find((p) => nameOf(p) === name) || null;
  };

  /** The pass chain that is ACTUALLY armed, in order, with :OFF on any pass
   *  present in the composer but skipped by EffectComposer. */
  P.armed = () => rp.composer.passes.map((p) => nameOf(p) + (p.enabled === false ? ':OFF' : ''));

  /** The pass chain #buildComposer WOULD produce for cfg, from the live tier,
   *  plus the OverlayPass EffectsDirector re-installs at the tail. */
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

  /* ------------------------------------------------------------------ setup */

  P.setup = (opts) => {
    const o = opts || {};
    const level = o.level || 7;

    // Second CPU driving player 0, so the fight is CPU vs CPU.
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

    // Round never ends: the sim's own training branch refreshes roundTimer.
    // Set the field, NOT setTraining(), which would null out cpu[1].
    KB.training = true;

    if (!P._pump) {
      P._pump = true;
      const pump = () => {
        if (KB.phase !== 'fight') { KB.setPhase('fight'); P._forcedPhase++; }
        KB.training = true;
        for (const f of KB.fighters) if (f.health < 140) f.health = 180;
        // Re-assert the pass.enabled ablation every frame. EffectsDirector
        // rebuilds its OverlayPass whenever the composer identity changes, so a
        // one-shot assignment would be silently undone.
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

    // Adaptive resolution off. This flag is read per frame and owns no pass, so
    // setEffect deliberately does not rebuild for it.
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
      // Count setEffect calls so the driver can report rebuilds per block.
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
      effects: JSON.parse(JSON.stringify(rp.effects)),
    };
  };

  /* --------------------------------------------------------------- snapshot */

  P.snapshot = () => {
    const b = rp.composer && rp.composer.readBuffer;
    return {
      armed: P.armed(),
      scale: +rp.renderScale.toFixed(4),
      pixels: b ? b.width + 'x' + b.height : null,
      adaptive: !!rp.effects.adaptiveResolution,
      shadows: !!rp.effects.shadows,
      shadowMapOn: !!rp.renderer.shadowMap.enabled,
      split: !!rp.effects.splitLighting,
      prepass: !!rp.effects.depthPrepass,
      // What ScenePass is actually doing this frame, read off the pass itself
      // rather than off the flag that is supposed to drive it.
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
    };
  };

  /* ------------------------------------------------------------------ apply */

  /**
   * Applies a configuration.
   *   cfg = { effects:{ao,bloom,dof,motionBlur,grade,smaa}, scale, shadows, off:[] }
   *
   * EXACTLY ONE composer rebuild is issued when the effect flags already match,
   * so that every block in the experiment is preceded by the same allocation and
   * shader-cache event. post-off / only-mb differ in more than one flag and
   * therefore rebuild more than once; the driver records the count per block.
   */
  P.apply = (cfg) => {
    const before = P._rebuilds;

    if (typeof cfg.scale === 'number' && Math.abs(rp.renderScale - cfg.scale) > 1e-6) {
      rp.setEffect('adaptiveResolution', false);
      rp.renderScale = cfg.scale;
      rp._targetScale = cfg.scale;
      rp.resize();
    }

    const wantShadows = cfg.shadows === undefined ? true : !!cfg.shadows;
    if (!!rp.effects.shadows !== wantShadows) rp.setEffect('shadows', wantShadows);

    // splitLighting owns no pass, so setEffect sets the flag and returns; the
    // flag is read into ScenePass every frame by #syncPasses. That makes it an
    // allocation-free ablation of the split beauty pass with ScenePass intact,
    // which is the only way to separate the split from the post chain.
    const wantSplit = cfg.split === undefined ? true : !!cfg.split;
    if (!!rp.effects.splitLighting !== wantSplit) rp.setEffect('splitLighting', wantSplit);

    const changed = [];
    for (const k of P.EFFECTS) {
      const want = !!cfg.effects[k];
      if (!!rp.effects[k] !== want) { rp.setEffect(k, want); changed.push(k); }
    }
    if (changed.length === 0) {
      // Force one rebuild anyway, so every block is preceded by the same event.
      rp.setEffect('bloom', !!rp.effects.bloom);
      changed.push('(no-op rebuild)');
    }

    // pass.enabled ablation. Held by the pump, not by this call, because
    // EffectsDirector reinstalls its OverlayPass after every rebuild.
    P._forceOff = (cfg.off || []).slice();

    rp.setEffect('adaptiveResolution', false);
    return { changed, rebuilds: P._rebuilds - before, forceOff: P._forceOff, armed: P.armed() };
  };

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
      res({
        ivals: P._ivals.slice(),
        cpu: P._cpu.slice(),
        wall,
        forcedPhase: P._forcedPhase - forced0,
      });
    }, ms);
  });

  /* --------------------------------------------------- setup control: hazard */

  /**
   * Demonstrates, in the report, the trap this probe is built to avoid:
   * assigning rp.effects.X directly leaves the pass armed. Doubles as a POSITIVE
   * CONTROL ON THE ASSERTION -- it produces a state expect() must flag as a
   * mismatch, proving the assertion is capable of failing.
   */
  P.hazard = () => {
    const out = {};
    const full = { effects: { ao: 1, bloom: 1, dof: 1, motionBlur: 1, grade: 1, smaa: 1 }, scale: 0.85 };
    P.apply(full);
    out.boot = P.armed();

    rp.effects.bloom = false;              // the trap, on purpose
    out.afterDirectAssign = P.armed();
    out.expectedIfItHadWorked = P.expect({ effects: { ao: 1, bloom: 0, dof: 1, motionBlur: 1, grade: 1, smaa: 1 } });
    out.assertionWouldFlag = out.afterDirectAssign.join(' ') !== out.expectedIfItHadWorked.join(' ');
    rp.effects.bloom = true;               // undo the flag

    rp.setEffect('bloom', false);
    out.afterSetEffect = P.armed();
    rp.setEffect('bloom', true);
    out.restored = P.armed();
    out.restoredMatchesBoot = out.restored.join(' ') === out.boot.join(' ');
    return out;
  };

  return { ok: true };
})();
