/*
 * Page side of tools/shadowgate.mjs -- SHADOW-SYSTEM frame-budget attribution by
 * ABLATION on a LIVE fight.
 *
 * Derived from tools/passbudget-page.js (same session discipline: CPU-vs-CPU,
 * rounds that cannot end, interval sampled at RenderPipeline#render entry,
 * ABBA quads). Everything below the "SHADOW ARMS" banner is new.
 *
 * Loaded as raw text and eval'd in the page. No backtick appears anywhere in
 * this file -- not in code, not in a comment -- so the driver may embed it in a
 * template literal and so no shader-adjacent text can be terminated early.
 *
 * THE FOUR CONFIG HAZARDS THIS FILE IS BUILT AROUND
 *
 *  1. RenderPipeline.effects is a plain object and only setEffect() rebuilds the
 *     composer. Inherited from passbudget: every post ablation goes through
 *     setEffect and the armed pass list is asserted before AND after each block.
 *
 *  2. tier.pcss IS READ EXACTLY ONCE, IN setQuality(). Writing rp.tier.pcss =
 *     false changes NOTHING: the shader chunk is still the PCSS one, the shadow
 *     map is still BasicShadowMap, every fragment still takes 28 taps. This is
 *     the shadow-flavoured twin of hazard 1 and hazardPcss() demonstrates it.
 *
 *  3. THREE.ShaderChunk IS NOT IN THE PROGRAM CACHE KEY. Rewriting
 *     shadowmap_pars_fragment and setting material.needsUpdate = true gets you a
 *     cache HIT on the program compiled from the OLD chunk -- the tap count on
 *     the GPU does not move. Every arm therefore also writes a define
 *     (KB_SHADOW_ARM) whose value is the arm tag, which is in the cache key, so
 *     the recompile is real.
 *
 *  4. A COUNT OF PROGRAMS IS NOT A PROOF ABOUT PROGRAMS. Releasing one program
 *     and compiling another leaves renderer.info.programs.length unchanged. The
 *     block guard therefore hashes program IDs, not the length.
 *
 * And the assertion that closes all of them: shaderAudit() pulls the ACTUAL
 * fragment source off the GPU with gl.getShaderSource() for every live program
 * and counts, per program, which shadow filter it compiled and with how many
 * taps. No arm is trusted on the strength of a JS flag.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const THREE = KB.THREE;
  const P = {};
  window.__sg = P;

  // three's shadow-map type constants, spelled out so this file does not depend
  // on the module namespace exposing them under any particular name.
  const BASIC_SHADOW_MAP = 0;
  const PCF_SHADOW_MAP = 1;

  P.EFFECTS = ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa'];
  P.MANAGED = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output', 'overlay'];
  P._ivals = [];
  P._cpu = [];
  P._last = null;
  P._collect = false;
  P._forcedPhase = 0;
  P._rebuilds = 0;
  P._recompiles = 0;
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

  /* =========================================================================
   * SHADOW ARMS
   * ====================================================================== */

  const CHUNK_KEY = 'shadowmap_pars_fragment';

  /** Tap counts read back OUT of a chunk string. Never assumed, always parsed. */
  const tapsOf = (src) => {
    const b = /vogelDiskSample\( i, (\d+), phi \) \* searchRadius/.exec(src);
    const f = /vogelDiskSample\( i, (\d+), phi \) \* filterRadius/.exec(src);
    const d = /shadow \/= float\( (\d+) \);/.exec(src);
    return {
      blocker: b ? +b[1] : null,
      filter: f ? +f[1] : null,
      divisor: d ? +d[1] : null,
      pcss: src.indexOf('searchRadius') >= 0,
    };
  };
  P._tapsOf = tapsOf;

  /**
   * Rewrites the PCSS loop bounds in a chunk. Both loops AND the averaging
   * divisor move together; the divisor is parsed back and compared to the
   * filter count by the driver, so a partial rewrite cannot pass silently.
   */
  const chunkWithTaps = (src, blocker, filter) => {
    let s = src;
    s = s.replace(
      /for \( int i = 0; i < \d+; i \+\+ \) \{(\s*)vec2 offset = vogelDiskSample\( i, \d+, phi \) \* searchRadius;/,
      'for ( int i = 0; i < ' + blocker + '; i ++ ) {$1vec2 offset = vogelDiskSample( i, ' + blocker + ', phi ) * searchRadius;',
    );
    s = s.replace(
      /for \( int i = 0; i < \d+; i \+\+ \) \{(\s*)vec2 offset = vogelDiskSample\( i, \d+, phi \) \* filterRadius;/,
      'for ( int i = 0; i < ' + filter + '; i ++ ) {$1vec2 offset = vogelDiskSample( i, ' + filter + ', phi ) * filterRadius;',
    );
    s = s.replace(/shadow \/= float\( \d+ \);/, 'shadow /= float( ' + filter + ' );');
    return s;
  };

  /**
   * Forces a genuine recompile of every scene material, WITHOUT leaking the old
   * program set.
   *
   * Two independent facts about three r185 make this three lines instead of one,
   * and the first smoke run of this tool voided all 36 of its blocks on them:
   *
   *   a) needsUpdate alone is NOT enough when only the chunk text changed.
   *      THREE.ShaderChunk is not in the program cache key, so three re-derives
   *      the same key, finds the program compiled from the OLD chunk, and hands
   *      it straight back. The arm tag goes into material.defines, which IS in
   *      the key, so the rebuild is real.
   *   b) material.defines alone LEAKS. materialProperties.programs is a Map
   *      keyed by cache key and programs are released only from
   *      onMaterialDispose, so every arm a material has ever seen stays resident
   *      forever. The smoke run walked 1320 -> 2192 live programs across nine
   *      arms and the frame time went with it, 15 ms p50 to 63 ms. Every number
   *      it produced was garbage, and the GPU audit is what said so.
   *
   * material.dispose() only dispatches the 'dispose' event: the renderer
   * releases that material's programs and forgets its properties, and the next
   * getProgram rebuilds them and re-registers the listener. The material stays
   * usable. Doing (a) and (b) together means one arm's worth of programs is live
   * at a time, which the per-block armTags assertion then verifies.
   */
  const recompileAll = (tag) => {
    const seen = new Set();
    let n = 0;
    const sweep = (scene) => {
      if (!scene || !scene.traverse) return;
      scene.traverse((obj) => {
        const m = obj.material;
        if (!m) return;
        for (const mat of (Array.isArray(m) ? m : [m])) {
          if (!mat || seen.has(mat)) continue;
          seen.add(mat);
          if (!mat.defines) mat.defines = {};
          if (mat.defines.KB_SHADOW_ARM === tag) continue;
          mat.defines.KB_SHADOW_ARM = tag;
          mat.dispose();          // release the previous arm's programs
          mat.needsUpdate = true; // and compile this arm's from the live chunk
          n++;
        }
      });
    };
    sweep(rp._lastScene);
    if (rp.scene !== rp._lastScene) sweep(rp.scene);
    if (KB.scene !== rp._lastScene) sweep(KB.scene);
    P._recompiles++;
    return n;
  };

  /**
   * THE SETUP CONTROL THAT MATTERS. Reads the fragment source of every live
   * program off the GPU and classifies the shadow filter each one actually
   * compiled. A JS flag is not evidence that the GPU is running the arm.
   *
   * CLASSIFY ON THE DEFINE, NOT ON THE BODY. getShaderSource returns the
   * UNPREPROCESSED string, so both the PCF branch and the PCSS branch of the
   * chunk are present in every shadow program's text. The first version of this
   * grepped for 'searchRadius' and reported zero PCF programs on the PCF arm --
   * which was true of the text and false of the GPU. What decides is the
   * '#define SHADOWMAP_TYPE_*' three prepends, so that is what is read.
   *
   * Memoised by program id: a fragment source is ~60 KB and there are >300 live
   * programs, so re-reading them all twice a block is itself a measurable cost.
   */
  const _auditCache = new Map();
  P.shaderAudit = () => {
    const gl = rp.renderer.getContext();
    const progs = rp.renderer.info.programs || [];
    const out = { total: progs.length, withShadow: 0, pcss: {}, pcf: 0, vsm: 0, none: 0, armTags: {} };
    const live = new Set();
    for (const p of progs) {
      live.add(p.id);
      let c = _auditCache.get(p.id);
      if (!c) {
        let src = null;
        try { src = gl.getShaderSource(p.fragmentShader); } catch (e) { src = null; }
        if (!src) continue;
        const tag = /#define KB_SHADOW_ARM (\S+)/.exec(src);
        c = { tag: tag ? tag[1] : null, kind: 'none', taps: null };
        if (src.indexOf('#define USE_SHADOWMAP') >= 0 && src.indexOf('float getShadow(') >= 0) {
          if (src.indexOf('#define SHADOWMAP_TYPE_PCF') >= 0) c.kind = 'pcf';
          else if (src.indexOf('#define SHADOWMAP_TYPE_VSM') >= 0) c.kind = 'vsm';
          else if (src.indexOf('#define SHADOWMAP_TYPE_BASIC') >= 0) {
            const t = tapsOf(src);
            c.kind = 'pcss';
            c.taps = t.blocker + '+' + t.filter + (t.filter === t.divisor ? '' : '!div' + t.divisor);
          }
        }
        _auditCache.set(p.id, c);
      }
      if (c.tag) out.armTags[c.tag] = (out.armTags[c.tag] || 0) + 1;
      if (c.kind === 'none') { out.none++; continue; }
      out.withShadow++;
      if (c.kind === 'pcss') out.pcss[c.taps] = (out.pcss[c.taps] || 0) + 1;
      else if (c.kind === 'pcf') out.pcf++;
      else out.vsm++;
    }
    for (const id of Array.from(_auditCache.keys())) if (!live.has(id)) _auditCache.delete(id);
    return out;
  };

  /** Signature of the live program set. Length alone would miss a swap. */
  const progSig = () => {
    const progs = rp.renderer.info.programs || [];
    let s = 0;
    for (const p of progs) s = (s + p.id) % 2147483647;
    return progs.length + ':' + s;
  };

  /** Every shadow-casting light in the scene, as the GPU will see it. */
  const shadowLights = () => {
    const scene = rp._lastScene || KB.scene;
    const out = [];
    scene.traverse((o) => {
      if (!o.isLight || !o.shadow || !o.castShadow) return;
      out.push({
        kind: o.isDirectionalLight ? 'dir' : (o.isSpotLight ? 'spot' : (o.isPointLight ? 'point' : '?')),
        name: o.name || '',
        map: o.shadow.mapSize.x + 'x' + o.shadow.mapSize.y,
        radius: +o.shadow.radius.toFixed(2),
        bias: +o.shadow.bias.toFixed(6),
        visible: !!o.visible,
      });
    });
    out.sort((a, b) => (a.kind + a.name + a.map).localeCompare(b.kind + b.name + b.map));
    return out;
  };
  P.shadowLights = shadowLights;

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

    // Pristine chunk + pristine tier values, captured before anything is armed.
    P._chunk0 = THREE.ShaderChunk[CHUNK_KEY];
    P._taps0 = tapsOf(P._chunk0);
    P._mapSize0 = rp.tier.shadowMapSize;
    P._pcss0 = !!rp._pcssActive;
    // Which lights cast at boot -- the set the "spot shadows off" arm removes.
    const scene = rp._lastScene || KB.scene;
    P._spotCasters = [];
    P._dirCasters = [];
    scene.traverse((l) => {
      if (!l.isLight || !l.shadow || !l.castShadow) return;
      if (l.isSpotLight) P._spotCasters.push(l);
      if (l.isDirectionalLight) P._dirCasters.push(l);
    });
    P._wantSpotShadows = true;

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
        // Environment re-asserts rig.key.castShadow from its own tier on any
        // setQuality; hold the arm every frame so it cannot be undone silently.
        for (const l of P._spotCasters) {
          if (l.castShadow !== P._wantSpotShadows) l.castShadow = P._wantSpotShadows;
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
      rp.render = (scn, cam, dt) => {
        const t = performance.now();
        if (P._collect) {
          if (P._last !== null) P._ivals.push(t - P._last);
          P._last = t;
        }
        origRender(scn, cam, dt);
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
      effects: JSON.parse(JSON.stringify(rp.effects)),
      shadowMapType: rp.renderer.shadowMap.type,
      pcssActive: !!rp._pcssActive,
      chunkTaps: P._taps0,
      shadowLights: shadowLights(),
      spotCasters: P._spotCasters.length,
      dirCasters: P._dirCasters.length,
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
      shadowMapType: rp.renderer.shadowMap.type,
      pcssActive: !!rp._pcssActive,
      chunkTaps: tapsOf(THREE.ShaderChunk[CHUNK_KEY]),
      tierMapSize: rp.tier.shadowMapSize,
      shadowLights: shadowLights(),
      split: !!rp.effects.splitLighting,
      passSplit: rp._passes.scene ? !!rp._passes.scene.splitLighting : null,
      quality: rp.quality,
      phase: KB.phase,
      tick: KB.tick,
      drawCalls: rp.stats.drawCalls,
      triangles: rp.stats.triangles,
      sceneDrawCalls: rp.stats.sceneDrawCalls,
      programs: rp.stats.programs,
      progSig: progSig(),
      hp: KB.fighters.map((f) => Math.round(f.health)),
      sep: +Math.abs(KB.fighters[0].position.x - KB.fighters[1].position.x).toFixed(2),
      forcedPhase: P._forcedPhase,
      rebuilds: P._rebuilds,
      recompiles: P._recompiles,
    };
  };

  /* ------------------------------------------------------------------ apply */

  /**
   * cfg = { key, effects:{...}, scale, shadows, split, off:[],
   *         pcss:bool, taps:[blocker,filter]|null, mapSize:number,
   *         spotShadows:bool }
   *
   * `taps` null means the shipped chunk verbatim. `mapSize` drives the
   * DIRECTIONAL key only: #fitShadows re-reads rp.tier.shadowMapSize every frame
   * and resizes, and the per-fighter spot keys are sized by Environment's own
   * tier table, which this does not touch.
   */
  P.apply = (cfg) => {
    const before = P._rebuilds;
    const rec0 = P._recompiles;

    if (typeof cfg.scale === 'number' && Math.abs(rp.renderScale - cfg.scale) > 1e-6) {
      rp.setEffect('adaptiveResolution', false);
      rp.renderScale = cfg.scale;
      rp._targetScale = cfg.scale;
      rp.resize();
    }

    const wantShadows = cfg.shadows === undefined ? true : !!cfg.shadows;
    if (!!rp.effects.shadows !== wantShadows) rp.setEffect('shadows', wantShadows);

    const wantSplit = cfg.split === undefined ? true : !!cfg.split;
    if (!!rp.effects.splitLighting !== wantSplit) rp.setEffect('splitLighting', wantSplit);

    // ---- shadow map resolution (no recompile: mapSize is a uniform) --------
    const wantMap = cfg.mapSize || P._mapSize0;
    rp.tier.shadowMapSize = wantMap;

    // ---- which lights cast (held by the pump as well) ---------------------
    P._wantSpotShadows = cfg.spotShadows === undefined ? true : !!cfg.spotShadows;
    for (const l of P._spotCasters) l.castShadow = P._wantSpotShadows;

    // ---- filter: PCSS at N taps, or hardware PCF --------------------------
    const wantPcss = cfg.pcss === undefined ? true : !!cfg.pcss;
    const taps = cfg.taps || [P._taps0.blocker, P._taps0.filter];
    const tag = (wantPcss ? 'pcss' : 'pcf') + '_' + taps[0] + '_' + taps[1]
      + '_' + (wantShadows ? 'on' : 'off');

    const wantChunk = wantPcss ? chunkWithTaps(P._chunk0, taps[0], taps[1]) : P._chunk0;
    let chunkChanged = false;
    if (THREE.ShaderChunk[CHUNK_KEY] !== wantChunk) {
      THREE.ShaderChunk[CHUNK_KEY] = wantChunk;
      chunkChanged = true;
    }
    const wantType = wantPcss ? BASIC_SHADOW_MAP : PCF_SHADOW_MAP;
    rp._pcssActive = wantPcss && wantShadows;
    if (rp.renderer.shadowMap.type !== wantType) rp.renderer.shadowMap.type = wantType;

    const recompiled = recompileAll(tag);

    // ---- post chain -------------------------------------------------------
    const changed = [];
    for (const k of P.EFFECTS) {
      const want = !!cfg.effects[k];
      if (!!rp.effects[k] !== want) { rp.setEffect(k, want); changed.push(k); }
    }
    if (changed.length === 0) {
      rp.setEffect('bloom', !!rp.effects.bloom);
      changed.push('(no-op rebuild)');
    }

    P._forceOff = (cfg.off || []).slice();
    rp.setEffect('adaptiveResolution', false);

    return {
      changed, rebuilds: P._rebuilds - before, recompiles: P._recompiles - rec0,
      chunkChanged, recompiledMaterials: recompiled, tag,
      chunkTaps: tapsOf(THREE.ShaderChunk[CHUNK_KEY]),
      armed: P.armed(),
    };
  };

  /** What the shadow state SHOULD be for cfg. Compared to snapshot() per block. */
  P.expectShadow = (cfg) => {
    const wantShadows = cfg.shadows === undefined ? true : !!cfg.shadows;
    const wantPcss = cfg.pcss === undefined ? true : !!cfg.pcss;
    const taps = cfg.taps || [P._taps0.blocker, P._taps0.filter];
    return {
      shadowMapOn: wantShadows,
      shadowMapType: wantPcss ? BASIC_SHADOW_MAP : PCF_SHADOW_MAP,
      pcssActive: wantPcss && wantShadows,
      chunkBlocker: wantPcss ? taps[0] : P._taps0.blocker,
      chunkFilter: wantPcss ? taps[1] : P._taps0.filter,
      chunkIsPcss: true,
      tierMapSize: cfg.mapSize || P._mapSize0,
      dirMapSize: (cfg.mapSize || P._mapSize0) + 'x' + (cfg.mapSize || P._mapSize0),
      spotCasters: (cfg.spotShadows === undefined ? true : !!cfg.spotShadows) ? P._spotCasters.length : 0,
      // On the GPU: the tap signature every shadow-sampling program must carry.
      gpuPcssKey: wantPcss ? (taps[0] + '+' + taps[1]) : null,
    };
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

  /* -------------------------------------------- setup control: the hazards */

  /**
   * HAZARD 2, demonstrated on purpose and reported: rp.tier.pcss = false sets a
   * flag that nothing reads outside setQuality. The shadow map type, the chunk
   * and the compiled programs do not move. Doubles as a POSITIVE CONTROL ON THE
   * ASSERTION: it produces a state expectShadow() must flag.
   *
   * HAZARD 3: rewriting the chunk and setting needsUpdate WITHOUT the cache-key
   * define leaves the GPU running the old tap count. Also demonstrated, by
   * auditing the compiled fragment source before and after.
   */
  P.hazards = () => {
    const out = {};
    const scene = rp._lastScene || KB.scene;

    // -- hazard 2: the flag nobody reads ---------------------------------
    const t0 = rp.renderer.shadowMap.type;
    rp.tier.pcss = false;
    out.tierPcssFlag = {
      typeBefore: t0,
      typeAfter: rp.renderer.shadowMap.type,
      pcssActive: !!rp._pcssActive,
      chunkStillPcss: tapsOf(THREE.ShaderChunk[CHUNK_KEY]).pcss,
      changedNothing: t0 === rp.renderer.shadowMap.type && !!rp._pcssActive
        && tapsOf(THREE.ShaderChunk[CHUNK_KEY]).pcss,
    };
    rp.tier.pcss = true;

    // -- hazard 3: chunk edit without a cache-key move -------------------
    // Installed and LEFT installed; the driver settles, calls hazardAudit(), and
    // then hazardRestore(). Auditing before the renderer has had frames to act
    // on needsUpdate would prove nothing either way.
    out.auditBefore = P.shaderAudit();
    P._hazSaved = THREE.ShaderChunk[CHUNK_KEY];
    THREE.ShaderChunk[CHUNK_KEY] = chunkWithTaps(P._hazSaved, 3, 3);
    scene.traverse((obj) => {
      const m = obj.material;
      if (!m) return;
      for (const mat of (Array.isArray(m) ? m : [m])) if (mat) mat.needsUpdate = true;
    });
    out.chunkOnly = { chunkTaps: tapsOf(THREE.ShaderChunk[CHUNK_KEY]) };
    return out;
  };

  /** Second half of hazard 3, called by the driver after a settle + frames. */
  P.hazardAudit = () => P.shaderAudit();

  /** Puts the pristine chunk back after the hazard demo. */
  P.hazardRestore = () => {
    THREE.ShaderChunk[CHUNK_KEY] = P._hazSaved;
    return tapsOf(THREE.ShaderChunk[CHUNK_KEY]);
  };

  return { ok: true };
})();
