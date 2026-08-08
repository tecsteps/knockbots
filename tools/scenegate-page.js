/*
 * Page side of tools/scenegate.mjs -- PRICING the scene pass's draw calls and
 * triangles, and upper-bounding the structural wins available inside it.
 *
 * The pass-budget round stopped at "ScenePass". tools/scenebudget.mjs opened it
 * and found 294 draws / 1.08M triangles split across six renderer.render
 * invocations. This probe answers the question that decides whether any of the
 * usual structural moves (instancing, merging, LOD, caster culling) can pay:
 *
 *   what does ONE draw call cost here, and what do ONE MILLION triangles cost?
 *
 * It answers it by ADDING them, not by removing them, because adding is the
 * only version that is free of a confound: a removed draw also removes its
 * pixels, and this frame is documented fill-bound.
 *
 *   cal-draw   N clones of the scene's own smallest meshes, sharing their real
 *              materials so the program and uniform switches are real, scaled to
 *              1e-6 so they rasterise nothing. Cost is draw-call overhead alone.
 *   cal-tri    K clones of arena.set.dark (52,476 tris, a real MeshStandard
 *              vertex format with the real material), same 1e-6 scale. Cost is
 *              K draw calls plus K*52,476 triangles of vertex work; the draw
 *              part is priced by cal-draw and subtracted.
 *
 * Everything is created ONCE at setup and toggled with .visible, so no program
 * is ever compiled inside a measured block. The driver voids any block whose
 * program count moves.
 *
 * No backtick appears in this file, so the driver may embed it in a template
 * literal.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const THREE = KB.THREE;
  const P = {};
  window.__sg = P;

  P.EFFECTS = ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa'];
  P._ivals = [];
  P._cpu = [];
  P._last = null;
  P._collect = false;
  P._forcedPhase = 0;
  P._rebuilds = 0;

  /* ------------------------------------------------------- armed chain ---- */

  const PREF = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output'];
  const nameOf = (pass) => {
    const keys = Object.keys(rp._passes).filter((k) => rp._passes[k] === pass);
    for (const p of PREF) if (keys.indexOf(p) >= 0) return p;
    if (keys.length) return keys[0];
    if (pass.constructor.name === 'OverlayPass') return 'overlay';
    return '?' + pass.constructor.name;
  };
  P.armed = () => rp.composer.passes.map((p) => nameOf(p) + (p.enabled === false ? ':OFF' : ''));
  P.expect = () => {
    const t = rp.tier;
    const e = rp.effects;
    const wantsDepth = !!(t.depth && (e.ao || e.dof || e.motionBlur));
    const list = [wantsDepth ? 'scene' : 'render'];
    if (t.ao && e.ao && wantsDepth) list.push('ao');
    if (t.bloom && e.bloom) list.push('bloom');
    if (t.dof && e.dof && wantsDepth) list.push('dof');
    if (t.motionBlur && e.motionBlur && wantsDepth) list.push('motionBlur');
    if (t.grade && e.grade) list.push('grade');
    if (t.smaa && e.smaa) list.push('smaa');
    list.push('output');
    list.push('overlay');
    return list;
  };

  /* -------------------------------------------------------- calibration --- */

  const scene = () => rp._lastScene || rp.scene || KB.scene;

  const findByName = (n) => {
    let hit = null;
    scene().traverse((o) => { if (!hit && o.name === n) hit = o; });
    return hit;
  };

  /**
   * Builds the calibration geometry. Called once, before the warm-up, so every
   * program it needs is compiled long before the first measured block.
   *
   * DRAW rig: clones of the smallest opaque non-instanced meshes in the scene,
   * cycled so consecutive draws switch material and program exactly the way the
   * real chain does. Scaled to 1e-6 and frustumCulled off: the draw is issued,
   * the rasteriser gets nothing. The tiny world bounding sphere also puts them
   * under ScenePass.prepassMinScreenRadius, so the prepass drops them and the
   * count added is the beauty half only (plus the mirror on mirror frames) --
   * which is why the driver reads the REAL drawCalls delta rather than trusting
   * N.
   *
   * TRI rig: clones of arena.set.dark, the frame's largest single mesh, with its
   * own material and vertex format.
   */
  P.build = (maxDraws, maxTri) => {
    const S = scene();
    if (P._built) return P._built;

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
    // distinct materials only, so the cycle really does switch state
    const seen = new Set();
    const pick = donors.filter((o) => {
      const k = o.material.uuid;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    }).slice(0, 12);

    const gDraw = new THREE.Group();
    gDraw.name = 'calib.draw';
    for (let i = 0; i < maxDraws; i++) {
      const d = pick[i % pick.length];
      const m = new THREE.Mesh(d.geometry, d.material);
      m.name = 'calib.draw.' + i;
      m.scale.setScalar(1e-6);
      m.position.copy(d.getWorldPosition(new THREE.Vector3()));
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.visible = true;
      gDraw.add(m);
    }
    S.add(gDraw);

    const heavy = findByName('arena.set.dark');
    const gTri = new THREE.Group();
    gTri.name = 'calib.tri';
    if (heavy) {
      for (let i = 0; i < maxTri; i++) {
        const m = new THREE.Mesh(heavy.geometry, heavy.material);
        m.name = 'calib.tri.' + i;
        m.scale.setScalar(1e-6);
        m.position.copy(heavy.getWorldPosition(new THREE.Vector3()));
        m.frustumCulled = false;
        m.castShadow = false;
        m.receiveShadow = false;
        m.visible = true;
        gTri.add(m);
      }
    }
    S.add(gTri);

    const idx = heavy && heavy.geometry.index;
    const pos = heavy && heavy.geometry.attributes.position;
    P._built = {
      donors: pick.map((o) => o.name),
      draws: gDraw.children.length,
      tris: gTri.children.length,
      triEach: heavy ? (idx ? idx.count : pos.count) / 3 : 0,
    };
    P._gDraw = gDraw;
    P._gTri = gTri;
    return P._built;
  };

  P.setCalib = (nDraw, nTri) => {
    for (let i = 0; i < P._gDraw.children.length; i++) P._gDraw.children[i].visible = i < nDraw;
    for (let i = 0; i < P._gTri.children.length; i++) P._gTri.children[i].visible = i < nTri;
  };

  /* --------------------------------------------------------- ablations ---- */

  // Upper bounds on structural moves, by hiding real geometry. These change the
  // image and are NOT candidate shipping states; they exist to say how much
  // headroom a candidate could possibly reach before it is worth writing.
  P._hidden = [];
  P.setAblation = (kind) => {
    for (const o of P._hidden) { if (o.what === 'visible') o.obj.visible = true; else o.obj.castShadow = true; }
    P._hidden = [];
    if (!kind) return 0;
    const S = scene();
    let n = 0;
    if (kind === 'crowd') {
      S.traverse((o) => {
        if (o.isMesh && o.name && o.name.indexOf('arena.structure.crowd') === 0 && o.visible) {
          o.visible = false; P._hidden.push({ obj: o, what: 'visible' }); n++;
        }
      });
    } else if (kind === 'arenacast') {
      S.traverse((o) => {
        if (o.isMesh && o.castShadow && o.name && o.name.indexOf('arena.') === 0) {
          o.castShadow = false; P._hidden.push({ obj: o, what: 'cast' }); n++;
        }
      });
    } else if (kind === 'midground') {
      S.traverse((o) => {
        if (o.isMesh && o.name && o.name.indexOf('env.midground.') === 0 && o.visible) {
          o.visible = false; P._hidden.push({ obj: o, what: 'visible' }); n++;
        }
      });
    }
    return n;
  };

  /* ------------------------------------------------------------- setup ---- */

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
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
    }
    rp.setEffect('adaptiveResolution', false);
    if (rp.quality !== 'high') rp.setQuality('high');

    if (!P._hooked) {
      P._hooked = true;
      const origRender = rp.render.bind(rp);
      rp.render = (s, c, dt) => {
        const t = performance.now();
        if (P._collect) {
          if (P._last !== null) P._ivals.push(t - P._last);
          P._last = t;
        }
        origRender(s, c, dt);
        if (P._collect) P._cpu.push(performance.now() - t);
      };
      const origSet = rp.setEffect.bind(rp);
      rp.setEffect = (n, v) => { P._rebuilds++; return origSet(n, v); };
    }

    const built = P.build(o.maxDraws || 320, o.maxTri || 16);
    const gl = rp.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      quality: rp.quality, dpr: window.devicePixelRatio,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      armed: P.armed(), built,
      // candidate flags this build of RenderPipeline exposes, if any
      candidate: rp._passes.scene ? {
        shadowCasterMinScreenRadius: rp._passes.scene.shadowCasterMinScreenRadius,
        prepassMinScreenRadius: rp._passes.scene.prepassMinScreenRadius,
      } : null,
    };
  };

  /* ------------------------------------------------------------ apply ----- */

  P.apply = (cfg) => {
    const before = P._rebuilds;
    if (typeof cfg.scale === 'number' && Math.abs(rp.renderScale - cfg.scale) > 1e-6) {
      rp.setEffect('adaptiveResolution', false);
      rp.renderScale = cfg.scale;
      rp._targetScale = cfg.scale;
      rp.resize();
    }
    P.setCalib(cfg.nDraw || 0, cfg.nTri || 0);
    const abl = P.setAblation(cfg.ablate || null);
    // The candidate change under test, if the working tree has one. Reading and
    // writing an own property of ScenePass; no composer rebuild is involved.
    if (rp._passes.scene && typeof cfg.casterMinR === 'number') {
      rp._passes.scene.shadowCasterMinScreenRadius = cfg.casterMinR;
    }
    // Same no-op rebuild before every block, so all blocks share one allocation
    // and shader-cache event.
    rp.setEffect('bloom', !!rp.effects.bloom);
    rp.setEffect('adaptiveResolution', false);
    return { rebuilds: P._rebuilds - before, ablated: abl, armed: P.armed() };
  };

  P.snapshot = () => {
    const b = rp.composer && rp.composer.readBuffer;
    return {
      armed: P.armed(),
      scale: +rp.renderScale.toFixed(4),
      pixels: b ? b.width + 'x' + b.height : null,
      adaptive: !!rp.effects.adaptiveResolution,
      shadowMapOn: !!rp.renderer.shadowMap.enabled,
      split: !!rp.effects.splitLighting,
      passSplit: rp._passes.scene ? !!rp._passes.scene.splitLighting : null,
      quality: rp.quality, phase: KB.phase, tick: KB.tick,
      drawCalls: rp.stats.drawCalls, triangles: rp.stats.triangles,
      sceneDrawCalls: rp.stats.sceneDrawCalls, sceneTriangles: rp.stats.sceneTriangles,
      programs: rp.stats.programs,
      hp: KB.fighters.map((f) => Math.round(f.health)),
      sep: +Math.abs(KB.fighters[0].position.x - KB.fighters[1].position.x).toFixed(2),
      forcedPhase: P._forcedPhase,
    };
  };

  P.sample = (ms) => new Promise((res) => {
    P._ivals = []; P._cpu = []; P._last = null;
    const forced0 = P._forcedPhase;
    const t0 = performance.now();
    P._collect = true;
    setTimeout(() => {
      P._collect = false;
      res({ ivals: P._ivals.slice(), cpu: P._cpu.slice(), wall: performance.now() - t0, forcedPhase: P._forcedPhase - forced0 });
    }, ms);
  });

  return { ok: true };
})();
