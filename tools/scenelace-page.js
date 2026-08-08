/*
 * Page side of tools/scenelace.mjs -- FRAME-INTERLEAVED A/B.
 *
 * WHY THIS EXISTS. tools/passbudget.mjs measures a condition as ABBA quads of
 * 1.3 s blocks, because a composer rebuild needs a settle. That works, and its
 * own noise floor says what it costs: |dp95| median 2.42 ms, p90 6.25 ms
 * between two blocks of an UNCHANGED configuration. On a box that four other
 * headless Chromiums are sharing, that floor rises until it swallows everything
 * -- a run of tools/scenegate.mjs at loadavg 9.9 returned a NULL control of
 * +4.43 ms p95 and a noise floor of 7.72 ms, i.e. it could not have detected any
 * of the effects it was looking for.
 *
 * Every condition this file tests is a PER-FRAME TOGGLE: object.visible,
 * object.castShadow, pass.enabled. None of them allocates, rebuilds the
 * composer or resizes a target, so none of them needs a settle measured in
 * seconds. That makes it possible to swap arms every SIXTEEN FRAMES instead of
 * every 1.3 s, which puts the two arms about 0.3 s apart instead of 3 s apart
 * and leaves contention almost no room to differ between them.
 *
 * The switch happens INSIDE the RenderPipeline.render wrapper, before the
 * original render is called, so the configuration is applied to exactly the
 * frame it is credited to -- a separate rAF pump would have undefined ordering
 * against the game's own render and would smear one frame across the boundary.
 * The first `discard` frames of every slot are dropped anyway.
 *
 * Slots run ABBA within a superblock, so a linear drift across the superblock
 * cancels, and superblocks are dealt round-robin over the conditions in a
 * seeded shuffle so no condition owns a particular part of the fight.
 *
 * No backtick appears in this file, so the driver may embed it in a template
 * literal.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const THREE = KB.THREE;
  const P = {};
  window.__sl = P;

  const scene = () => rp._lastScene || rp.scene || KB.scene;

  /* --------------------------------------------------------- armed chain -- */
  const PREF = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output'];
  const nameOf = (pass) => {
    const keys = Object.keys(rp._passes).filter((k) => rp._passes[k] === pass);
    for (const p of PREF) if (keys.indexOf(p) >= 0) return p;
    if (keys.length) return keys[0];
    if (pass.constructor.name === 'OverlayPass') return 'overlay';
    return '?' + pass.constructor.name;
  };
  P.armed = () => rp.composer.passes.map((p) => nameOf(p) + (p.enabled === false ? ':OFF' : ''));

  /* ---------------------------------------------------------- calib rig --- */

  P.build = (maxDraws, maxTri) => {
    if (P._built) return P._built;
    const S = scene();
    const donors = [];
    S.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || !o.geometry) return;
      if (!o.name || o.name.indexOf('calib') === 0) return;
      const m = o.material;
      if (!m || Array.isArray(m) || m.transparent || m.alphaTest > 0) return;
      const idx = o.geometry.index, pos = o.geometry.attributes.position;
      const tri = (idx ? idx.count : (pos ? pos.count : 0)) / 3;
      if (tri > 0 && tri <= 400) donors.push(o);
    });
    const seen = new Set();
    const pick = donors.filter((o) => { const k = o.material.uuid; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);

    const gDraw = new THREE.Group(); gDraw.name = 'calib.draw';
    for (let i = 0; i < maxDraws; i++) {
      const d = pick[i % pick.length];
      const m = new THREE.Mesh(d.geometry, d.material);
      m.name = 'calib.draw.' + i;
      m.scale.setScalar(1e-6);
      m.position.copy(d.getWorldPosition(new THREE.Vector3()));
      m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
      gDraw.add(m);
    }
    S.add(gDraw);

    let heavy = null;
    S.traverse((o) => { if (!heavy && o.name === 'arena.set.dark') heavy = o; });
    const gTri = new THREE.Group(); gTri.name = 'calib.tri';
    if (heavy) {
      for (let i = 0; i < maxTri; i++) {
        const m = new THREE.Mesh(heavy.geometry, heavy.material);
        m.name = 'calib.tri.' + i;
        m.scale.setScalar(1e-6);
        m.position.copy(heavy.getWorldPosition(new THREE.Vector3()));
        m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
        gTri.add(m);
      }
    }
    S.add(gTri);
    const idx = heavy && heavy.geometry.index, pos = heavy && heavy.geometry.attributes.position;
    P._gDraw = gDraw; P._gTri = gTri;
    P._built = { donors: pick.map((o) => o.name), draws: maxDraws, tris: maxTri, triEach: heavy ? (idx ? idx.count : pos.count) / 3 : 0 };
    return P._built;
  };

  /* ---------------------------------------------------------- ablations --- */

  P._ablHidden = [];
  const setAblation = (kind) => {
    for (const o of P._ablHidden) { if (o.w === 'v') o.o.visible = true; else o.o.castShadow = true; }
    P._ablHidden = [];
    if (!kind) return;
    const S = scene();
    if (kind === 'crowd') {
      S.traverse((o) => { if (o.isMesh && o.name && o.name.indexOf('arena.structure.crowd') === 0 && o.visible) { o.visible = false; P._ablHidden.push({ o, w: 'v' }); } });
    } else if (kind === 'arenacast') {
      S.traverse((o) => { if (o.isMesh && o.castShadow && o.name && o.name.indexOf('arena.') === 0) { o.castShadow = false; P._ablHidden.push({ o, w: 'c' }); } });
    } else if (kind === 'midground') {
      S.traverse((o) => { if (o.isMesh && o.name && o.name.indexOf('env.midground.') === 0 && o.visible) { o.visible = false; P._ablHidden.push({ o, w: 'v' }); } });
    } else if (kind === 'fightercast') {
      S.traverse((o) => { if (o.isMesh && o.castShadow && o.name && o.name.indexOf('lod0:') === 0) { o.castShadow = false; P._ablHidden.push({ o, w: 'c' }); } });
    }
  };

  /* ------------------------------------------------------------- config --- */

  P._cur = null;
  /** Applies one arm's configuration. Everything here is a plain property
   *  write or a short traverse; nothing allocates and nothing rebuilds. */
  const applyCfg = (c) => {
    const nD = c.nDraw || 0, nT = c.nTri || 0;
    for (let i = 0; i < P._gDraw.children.length; i++) P._gDraw.children[i].visible = i < nD;
    for (let i = 0; i < P._gTri.children.length; i++) P._gTri.children[i].visible = i < nT;
    if ((c.ablate || null) !== (P._curAbl || null)) { setAblation(c.ablate || null); P._curAbl = c.ablate || null; }
    P._offPasses = c.off || [];
    // ScenePass knobs. Both are plain own properties read once per frame by the
    // pass itself, so writing them is free and needs no settle -- which is the
    // whole reason this rig can interleave them at all.
    if (rp._passes.scene) {
      const sp = rp._passes.scene;
      if (typeof c.prepassMinR === 'number') sp.prepassMinScreenRadius = c.prepassMinR;
      else if (P._prepassDefault !== undefined) sp.prepassMinScreenRadius = P._prepassDefault;
      if (typeof c.prepassSplitMinR === 'number' && 'prepassSplitMinScreenRadius' in sp) sp.prepassSplitMinScreenRadius = c.prepassSplitMinR;
      else if (P._splitDefault !== undefined && 'prepassSplitMinScreenRadius' in sp) sp.prepassSplitMinScreenRadius = P._splitDefault;
      if (typeof c.casterMinR === 'number' && 'shadowCasterMinScreenRadius' in sp) sp.shadowCasterMinScreenRadius = c.casterMinR;
      else if (P._casterDefault !== undefined && 'shadowCasterMinScreenRadius' in sp) sp.shadowCasterMinScreenRadius = P._casterDefault;
    }
    P._cur = c;
  };
  /** Re-asserted every frame: EffectsDirector rebuilds passes on any composer
   *  identity change, so a one-shot pass.enabled would be silently undone. */
  const holdPasses = () => {
    const off = P._offPasses || [];
    for (const p of rp.composer.passes) {
      const n = nameOf(p);
      const want = off.indexOf(n) < 0;
      if (p.enabled !== want) p.enabled = want;
    }
  };

  /* -------------------------------------------------------------- setup --- */

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
    KB.paused = false; KB.timeScale = 1;
    KB.startMatch(0, 1);
    KB.setPhase('fight');
    if (KB.fightCamera && KB.fightCamera.cinematic) KB.fightCamera.cinematic('fight');
    KB.training = true;
    if (!P._pump) {
      P._pump = true;
      const pump = () => {
        if (KB.phase !== 'fight') { KB.setPhase('fight'); P._forcedPhase = (P._forcedPhase || 0) + 1; }
        KB.training = true;
        for (const f of KB.fighters) if (f.health < 140) f.health = 180;
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
    }
    rp.setEffect('adaptiveResolution', false);
    if (rp.quality !== 'high') rp.setQuality('high');
    if (Math.abs(rp.renderScale - 0.85) > 1e-6) { rp.renderScale = 0.85; rp._targetScale = 0.85; rp.resize(); }

    P.build(o.maxDraws || 320, o.maxTri || 16);
    if (rp._passes.scene) {
      P._prepassDefault = rp._passes.scene.prepassMinScreenRadius;
      P._casterDefault = rp._passes.scene.shadowCasterMinScreenRadius;
      P._splitDefault = rp._passes.scene.prepassSplitMinScreenRadius;
    }

    if (!P._hooked) {
      P._hooked = true;
      const origRender = rp.render.bind(rp);
      P._last = null;
      rp.render = (s, c, dt) => {
        const t = performance.now();
        const dt_ = P._last === null ? null : t - P._last;
        P._last = t;
        if (P._run) P.tick(dt_);
        holdPasses();
        origRender(s, c, dt);
        if (P._run && P._pending) {
          P._pending.dc = rp.stats.drawCalls;
          P._pending.tri = rp.stats.sceneTriangles;
          P._pending = null;
        }
      };
    }
    applyCfg({});
    const gl = rp.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      quality: rp.quality, scale: rp.renderScale, armed: P.armed(),
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      built: P._built,
      pixels: rp.composer && rp.composer.readBuffer ? rp.composer.readBuffer.width + 'x' + rp.composer.readBuffer.height : null,
      hasCandidate: !!(rp._passes.scene && 'shadowCasterMinScreenRadius' in rp._passes.scene),
    };
  };

  /* ------------------------------------------------------------ the run --- */

  /**
   * schedule: [{cond, arm, cfg}] -- one entry per SLOT, dealt by the driver.
   * Every slot is `framesPerSlot` frames; the first `discard` are not recorded.
   */
  P.start = (schedule, framesPerSlot, discard) => {
    P._sched = schedule;
    P._fps = framesPerSlot;
    P._discard = discard;
    P._i = 0;
    P._samples = [];
    P._armedSeen = {};
    P._done = false;
    P._pending = null;
    P._run = true;
    return { slots: schedule.length, frames: schedule.length * framesPerSlot };
  };

  P.tick = (dt) => {
    const slot = Math.floor(P._i / P._fps);
    if (slot >= P._sched.length) { P._run = false; P._done = true; return; }
    const e = P._sched[slot];
    const posInSlot = P._i % P._fps;
    if (posInSlot === 0) {
      applyCfg(e.cfg);
      const a = P.armed().join(' ');
      P._armedSeen[a] = (P._armedSeen[a] || 0) + 1;
      e.armed = a;
    }
    if (dt !== null && posInSlot >= P._discard) {
      const s = { s: slot, c: e.cond, a: e.arm, d: +dt.toFixed(3), dc: 0, tri: 0 };
      P._samples.push(s);
      P._pending = s;
    }
    P._i++;
  };

  P.status = () => ({
    done: P._done, i: P._i, slots: P._sched ? P._sched.length : 0,
    samples: P._samples ? P._samples.length : 0,
    phase: KB.phase, forcedPhase: P._forcedPhase || 0,
    scale: +rp.renderScale.toFixed(4), adaptive: !!rp.effects.adaptiveResolution,
    programs: rp.stats.programs, quality: rp.quality,
    split: !!rp.effects.splitLighting,
    passSplit: rp._passes.scene ? !!rp._passes.scene.splitLighting : null,
    armedSeen: P._armedSeen,
  });

  P.drain = () => {
    const out = P._samples;
    P._samples = [];
    return out;
  };

  return { ok: true };
})();
