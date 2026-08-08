/*
 * Page side of tools/tapgate.mjs -- image quality of a TAP-COUNT change.
 *
 * Loaded as raw text and eval'd in the page. No backtick appears inside any
 * comment here, so the driver may embed this file in a template literal.
 *
 * WHY THE TRUTH ARM IS NOT ssgate's 4x FRAME
 *
 * ssgate/movegate score RMSE against a 4x-integrated frame, which is the right
 * ground truth for a question about GEOMETRIC sampling -- resolution, AA,
 * temporal accumulation. A tap count is not that question. Both the shipped
 * 14/8 taps and the candidate are estimators of the SAME integral (the bokeh
 * gather, the shutter integral), and every length in both passes is a fraction
 * of frame height, so rendering at 4x reproduces the identical fractional blur
 * with the identical tap count -- the 4x arm is approximated exactly as badly as
 * the 0.85 arm and cannot referee between them.
 *
 * The correct zero-by-construction reference for a tap count is the CONVERGED
 * gather: the same shader, same radii, same weights, at 128 / 64 taps. That is
 * what 'conv' is. RMSE to it is then interpretable in one line: the shipped
 * frame's own distance from converged is the yardstick the candidate has to stay
 * inside.
 *
 * WHY THE FRAME MOVES
 *
 * MotionBlurPass velocity comes from CAMERA reprojection. On a frozen frame the
 * velocity is zero, the pass early-outs on every pixel, and a frozen quality
 * measurement of a motion-blur change certifies nothing -- this project has
 * already reverted a feature that won frozen and lost moving. So each moment is
 * captured off a LIVE fight and then pinned: the sim stops, and the camera pose
 * plus MotionBlurPass._prevViewProjection are restored before every arm, so all
 * arms integrate the identical non-zero velocity field. setShutter is pinned
 * too, because it reads wall-clock frame time and would otherwise hand each arm
 * a different shutter.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const THREE = KB.THREE;
  const P = {};
  window.__tg = P;

  P.EFFECTS = ['ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa'];
  P.planes = {};
  P.masks = {};

  const PREF = ['scene', 'render', 'ao', 'bloom', 'dof', 'motionBlur', 'grade', 'smaa', 'output'];
  const nameOf = (pass) => {
    const keys = Object.keys(rp._passes).filter((k) => rp._passes[k] === pass);
    for (const p of PREF) if (keys.indexOf(p) >= 0) return p;
    if (keys.length) return keys[0];
    if (pass.constructor.name === 'OverlayPass') return 'overlay';
    return '?' + pass.constructor.name;
  };
  P.armed = () => rp.composer.passes.map((p) => nameOf(p) + (p.enabled === false ? ':OFF' : ''));
  P.defines = () => {
    const d = rp._passes.dof, m = rp._passes.motionBlur;
    return {
      dofTaps: d ? d.material.defines.DOF_TAPS : null,
      dofAdaptive: d ? d.material.defines.DOF_ADAPTIVE : null,
      mbTaps: m ? m.material.defines.MB_TAPS : null,
      mbAdaptive: m ? m.material.defines.MB_ADAPTIVE : null,
      flag: !!rp.adaptiveTaps,
      mbIntensity: m ? +m.uniforms.uIntensity.value.toFixed(5) : null,
    };
  };

  /* ------------------------------------------------------------------ setup */

  P.setup = (opts) => {
    const o = opts || {};
    if (!P._cpu0) {
      const CPUClass = KB.cpu && KB.cpu[1] ? KB.cpu[1].constructor : null;
      if (!CPUClass) throw new Error('no CPU class on KB.cpu[1]');
      P._cpu0 = new CPUClass(KB.fighters[0], KB.fighters[1], { level: o.level || 7 });
      const orig = KB.input.commandsFor.bind(KB.input);
      KB.input.commandsFor = (i, f) => (i === 0 ? P._cpu0.think(KB.tick) : orig(i, f));
    }
    KB.cpu[1].setLevel(o.level || 7);
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
        if (!P._frozen) {
          if (KB.phase !== 'fight') KB.setPhase('fight');
          KB.training = true;
          for (const f of KB.fighters) if (f.health < 140) f.health = 180;
        }
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
    }

    rp.setEffect('adaptiveResolution', false);
    if (rp.quality !== 'high') rp.setQuality('high');
    P._tierDof0 = rp.tier.dofTaps;
    P._tierMb0 = rp.tier.mbTaps;

    // The game loop must stop drawing once a moment is pinned, or its own frames
    // would advance the reprojection history and the planar-reflection cache
    // between two arms of the same comparison.
    if (!P._hooked) {
      P._hooked = true;
      P._origRender = rp.render.bind(rp);
      rp.render = (scene, cam, dt) => { if (!P._frozen) P._origRender(scene, cam, dt); };
    }

    const gl = rp.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      quality: rp.quality, dpr: window.devicePixelRatio,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      buffer: rp.canvas.width + 'x' + rp.canvas.height,
      armed: P.armed(), defines: P.defines(),
      tier: { dofTaps: rp.tier.dofTaps, mbTaps: rp.tier.mbTaps },
    };
  };

  /* ------------------------------------------------------------------ pin */

  /**
   * WHICH MATRIX IS "PREVIOUS", and the first version of this tool got it wrong
   * in a way its own control caught.
   *
   * MotionBlurPass#advance() runs AFTER the frame, so once frame N has finished
   * `_prevViewProjection` already holds VP(N), not VP(N-1). Pinning that field
   * and restoring it hands every arm a zero velocity field -- which is exactly
   * what the motion control reported: camera NDC speed 0 at all six moments, and
   * the motion-blur loop running on 0% of pixels. The matrix that still holds
   * VP(N-1) after frame N is the UNIFORM the pass bound, `uPrevViewProjection`,
   * because nothing writes it again until the next captureCamera().
   */
  const ndcSpeed = (prevVP) => {
    const cam = KB.camera;
    if (!prevVP) return 0;
    cam.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    let acc = 0, n = 0;
    for (const z of [0.9, 0.99]) {
      for (const x of [-0.6, 0, 0.6]) {
        for (const y of [-0.4, 0, 0.4]) {
          const w = new THREE.Vector4(x, y, z * 2 - 1, 1).applyMatrix4(inv);
          w.divideScalar(w.w);
          const p = new THREE.Vector4(w.x, w.y, w.z, 1).applyMatrix4(prevVP);
          if (p.w <= 0) continue;
          acc += Math.hypot(p.x / p.w - x, p.y / p.w - y); n++;
        }
      }
    }
    return n ? acc / n : 0;
  };

  /** Live camera speed, so the driver can WAIT for a moving moment instead of
   *  taking whatever it lands on and calling it moving. */
  P.speed = () => {
    const mb = rp._passes.motionBlur;
    if (!mb) return 0;
    return +ndcSpeed(mb.uniforms.uPrevViewProjection.value).toFixed(6);
  };

  /**
   * Stops the sim on the frame the fight is currently on and records everything
   * an arm has to be handed back to reproduce it: camera transform, the previous
   * frame's view-projection, and the shutter.
   */
  P.pin = () => {
    P._frozen = true;
    KB.paused = true;
    const cam = KB.camera;
    cam.updateMatrixWorld(true);
    P._pin = {
      pos: cam.position.clone(), quat: cam.quaternion.clone(),
      fov: cam.fov, near: cam.near, far: cam.far, aspect: cam.aspect,
      proj: cam.projectionMatrix.clone(),
    };
    const mb = rp._passes.motionBlur;
    P._pinPrevVP = mb ? mb.uniforms.uPrevViewProjection.value.clone() : null;
    P._pinIntensity = mb ? mb.uniforms.uIntensity.value : 0;

    // DETERMINISM. GradePass advances uTime every render and modulates the frame
    // by an animated hash; two renders of an identical scene therefore differ,
    // and the null control measured that difference at rmse 4.6-9.0 -- larger
    // than the whole signal. Grain off for the run. ssgate does the same thing
    // for the same reason, and says so.
    if (P._grain0 === undefined) P._grain0 = rp.look.grain;
    rp.look.grain = 0;
    return {
      tick: KB.tick, phase: KB.phase,
      camPos: [+cam.position.x.toFixed(3), +cam.position.y.toFixed(3), +cam.position.z.toFixed(3)],
      camNdcSpeed: +ndcSpeed(P._pinPrevVP).toFixed(6),
      mbIntensity: +P._pinIntensity.toFixed(5),
      grain: rp.look.grain,
      sep: +Math.abs(KB.fighters[0].position.x - KB.fighters[1].position.x).toFixed(2),
      hp: KB.fighters.map((f) => Math.round(f.health)),
      dofFocus: +rp.dofFocus.distance.toFixed(3),
    };
  };

  P.unpin = () => { P._frozen = false; KB.paused = false; };

  /* -------------------------------------------------------------- readback */

  /** The drawing buffer, 1:1, as an 8-bit Rec.709 luma plane. No resampling of
   *  any kind: an arm difference must not be able to hide inside a filter. */
  const readPlane = () => {
    const gl = rp.canvas;
    const sw = gl.width, sh = gl.height;
    const tmp = P._tmp || (P._tmp = document.createElement('canvas'));
    if (tmp.width !== sw || tmp.height !== sh) { tmp.width = sw; tmp.height = sh; }
    const c = tmp.getContext('2d', { willReadFrequently: true });
    c.imageSmoothingEnabled = false;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#000';
    c.fillRect(0, 0, sw, sh);
    c.drawImage(gl, 0, 0);
    const src = c.getImageData(0, 0, sw, sh).data;
    const plane = new Float32Array(sw * sh);
    for (let i = 0, p = 0; i < plane.length; i++, p += 4) {
      plane[i] = 0.2126 * src[p] + 0.7152 * src[p + 1] + 0.0722 * src[p + 2];
    }
    return { plane, w: sw, h: sh, png: P._keepPng ? tmp.toDataURL('image/png') : null };
  };
  P._readPlane = readPlane;

  /* ------------------------------------------------------------------ arms */

  /**
   * Applies a tap configuration and renders the pinned moment once, retaining
   * its luma plane. cfg = { taps:'fixed'|'adaptive'|number pair, dof, mb, adaptive }
   *
   * Order is load-bearing: tier taps and rp.adaptiveTaps are read at composer
   * BUILD time and every frame respectively, so both are set before an
   * unconditional rebuild, and the reprojection state is restored AFTER the
   * rebuild (a rebuild creates a fresh, unprimed MotionBlurPass).
   */
  P.arm = (label, cfg, warm) => {
    rp.look.grain = 0;                          // survives the rebuild below
    rp.adaptiveTaps = !!cfg.adaptive;
    rp.tier.dofTaps = cfg.dof === undefined ? P._tierDof0 : cfg.dof;
    rp.tier.mbTaps = cfg.mb === undefined ? P._tierMb0 : cfg.mb;
    rp.setEffect('bloom', !!rp.effects.bloom);   // unconditional rebuild

    const restore = () => {
      const cam = KB.camera;
      cam.position.copy(P._pin.pos);
      cam.quaternion.copy(P._pin.quat);
      cam.fov = P._pin.fov; cam.near = P._pin.near; cam.far = P._pin.far; cam.aspect = P._pin.aspect;
      cam.projectionMatrix.copy(P._pin.proj);
      cam.projectionMatrixInverse.copy(P._pin.proj).invert();
      cam.updateMatrixWorld(true);
      const mb = rp._passes.motionBlur;
      if (mb && P._pinPrevVP) {
        // Prime it by hand: captureCamera() would otherwise copy the CURRENT
        // matrix into the history on a fresh pass and hand this arm a zero
        // velocity field, which is the frozen measurement this tool exists to
        // avoid.
        mb._primed = true;
        mb._prevViewProjection.copy(P._pinPrevVP);
        // setShutter reads wall-clock frame time. Pinned, or every arm gets a
        // different shutter and the comparison is between two blurs of
        // different length.
        mb.setShutter = () => {};
        mb.uniforms.uIntensity.value = P._pinIntensity;
      }
    };

    // THE MIRROR IS A TEMPORAL CACHE, and it is why the first two runs of this
    // tool had an ADJACENT NULL of rmse 6-8 -- two back-to-back renders of an
    // identical configuration differing by as much as the whole signal.
    // PlanarReflector refreshes every 2nd ARMED frame and is armed only by
    // Stage.update, which the game loop calls and this tool does not. So whether
    // an arm caught a refresh depended on nothing in particular. Fix, which is
    // ssgate's for the same defect: invalidate once per arm so the first frame
    // must refresh, and call Stage.update at dt 0 alongside every render so the
    // mirror is armed on THIS tool's frames and every arm lands on the same
    // point in the refresh cycle. dt 0 means Stage._time does not advance, so
    // nothing animates -- the call is there for arm(), not for animation.
    const stage = KB.stage;
    stage?.reflector?.invalidate?.();
    const step = () => {
      restore();
      if (stage && typeof stage.update === 'function') stage.update(0, KB.tick);
      restore();
      P._origRender(KB.scene, KB.camera, 1 / 60);
    };
    for (let i = 0; i < (warm || 2); i++) step();
    step();

    const out = readPlane();
    P.planes[label] = out.plane;
    let mean = 0;
    for (let i = 0; i < out.plane.length; i++) mean += out.plane[i];
    const g = rp._passes.grade;
    return {
      label, w: out.w, h: out.h, png: out.png,
      meanLuma: +(mean / out.plane.length).toFixed(4),
      armed: P.armed(), defines: P.defines(),
      grain: g ? g.uniforms.uGrain.value : null,
    };
  };

  /* ----------------------------------------------------------------- masks */

  /** Coverage render of the two fighter hierarchies, 1:1, straight to the
   *  default framebuffer with the raw renderer -- so the mask cannot depend on
   *  which post passes happen to be armed. Adapted from tools/ssgate.mjs. */
  P.subjectMask = () => {
    const r = rp, gl = rp.renderer, scene = KB.scene, cam = KB.camera;
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
    for (const o of keep) if (o !== scene && !o.visible) { forced.push(o); o.visible = true; }
    for (const o of rootSet) if (!o.visible) { forced.push(o); o.visible = true; }

    const sOverride = scene.overrideMaterial, sBg = scene.background, sEnv = scene.environment, sFog = scene.fog;
    const sLayers = cam.layers.mask, sShadow = gl.shadowMap.enabled, sAuto = gl.autoClear;
    const sClear = new THREE.Color(); gl.getClearColor(sClear);
    const sAlpha = gl.getClearAlpha(), sTarget = gl.getRenderTarget();

    const flat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, toneMapped: false });
    scene.overrideMaterial = flat; scene.background = null; scene.environment = null; scene.fog = null;
    cam.layers.enableAll();
    gl.shadowMap.enabled = false; gl.autoClear = true;
    gl.setClearColor(0x000000, 1); gl.setRenderTarget(null);
    gl.render(scene, cam);
    const out = readPlane();

    scene.overrideMaterial = sOverride; scene.background = sBg; scene.environment = sEnv; scene.fog = sFog;
    cam.layers.mask = sLayers; gl.shadowMap.enabled = sShadow; gl.autoClear = sAuto;
    gl.setClearColor(sClear, sAlpha); gl.setRenderTarget(sTarget);
    flat.dispose();
    for (const o of hidden) o.visible = true;
    for (const o of forced) o.visible = false;

    const m = new Uint8Array(out.plane.length);
    let n = 0;
    for (let i = 0; i < out.plane.length; i++) if (out.plane[i] > 0.25) { m[i] = 1; n++; }
    P.masks.subject = m;
    return { px: n, pct: +((100 * n) / m.length).toFixed(3), rendered: out.w + 'x' + out.h, roots: roots.length };
  };

  /**
   * The AT-RISK mask: pixels where the DOF gather or the motion-blur loop
   * actually runs. A tap-count change literally cannot alter any other pixel,
   * so this is where the whole effect lives and a whole-frame RMSE dilutes it by
   * however much of the frame happens to be in focus and still.
   *
   * Also returns the tap histogram, which is what proves the optimisation fires.
   */
  P.blurMask = (adaptive) => {
    rp._passes.dof?.setAdaptiveTaps(!!adaptive);
    rp._passes.motionBlur?.setAdaptiveTaps(!!adaptive);
    const gl = rp.renderer;
    const sTarget = gl.getRenderTarget();
    const res = {};
    const probe = (pass, key, dbgKey, tapKey) => {
      if (!pass) return null;
      const maxTaps = pass.material.defines[tapKey];
      pass.material.defines[dbgKey] = 1;
      pass.material.needsUpdate = true;
      gl.setRenderTarget(null);
      pass._fsQuad.render(gl);
      // Green != 0 marks "took the loop"; red carries the count. Read through
      // the same 1:1 canvas path the arms use, so mask and arms are registered
      // to each other by construction.
      const c = P._tmp || (P._tmp = document.createElement('canvas'));
      const cv = rp.canvas;
      if (c.width !== cv.width || c.height !== cv.height) { c.width = cv.width; c.height = cv.height; }
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(cv, 0, 0);
      const src = ctx.getImageData(0, 0, c.width, c.height).data;
      pass.material.defines[dbgKey] = 0;
      pass.material.needsUpdate = true;

      const n = c.width * c.height;
      const m = new Uint8Array(n);
      const hist = new Array(maxTaps + 1).fill(0);
      let active = 0, taps = 0;
      for (let i = 0; i < n; i++) {
        const t = Math.round((src[i * 4] / 255) * maxTaps);
        if (src[i * 4 + 1] > 127) { m[i] = 1; active++; taps += t; hist[Math.min(t, maxTaps)]++; }
        else hist[0]++;
      }
      P.masks[key] = m;
      return {
        maxTaps, activePx: active, activeFrac: +(active / n).toFixed(4),
        meanTapsOverFrame: +(taps / n).toFixed(3),
        meanTapsWhenActive: active ? +(taps / active).toFixed(3) : 0,
        savedFrac: +(1 - taps / (n * maxTaps)).toFixed(4), hist,
      };
    };
    res.dof = probe(rp._passes.dof, 'dof', 'DOF_DEBUG_TAPS', 'DOF_TAPS');
    res.mb = probe(rp._passes.motionBlur, 'mb', 'MB_DEBUG_TAPS', 'MB_TAPS');
    // Union: any pixel either pass touched.
    const a = P.masks.dof, b = P.masks.mb;
    if (a && b) {
      const u = new Uint8Array(a.length);
      let n = 0;
      for (let i = 0; i < a.length; i++) if (a[i] || b[i]) { u[i] = 1; n++; }
      P.masks.blur = u;
      res.unionPx = n;
      res.unionFrac = +(n / a.length).toFixed(4);
    }
    gl.setRenderTarget(sTarget);
    rp._passes.dof?.setAdaptiveTaps(!!rp.adaptiveTaps);
    rp._passes.motionBlur?.setAdaptiveTaps(!!rp.adaptiveTaps);
    return res;
  };

  /* ---------------------------------------------------------------- metric */

  /** RMSE in 8-bit luma units, over the whole frame and over each named mask. */
  P.compare = (label, refLabel) => {
    const a = P.planes[label], t = P.planes[refLabel];
    if (!a) throw new Error('no plane ' + label);
    if (!t) throw new Error('no plane ' + refLabel);
    const out = { label, ref: refLabel };
    const over = (m) => {
      let s2 = 0, n = 0, mx = 0, sa = 0, off = 0;
      for (let i = 0; i < a.length; i++) {
        if (m && !m[i]) continue;
        const d = a[i] - t[i], ad = d < 0 ? -d : d;
        s2 += d * d; sa += ad; n++;
        if (ad > mx) mx = ad;
        if (ad > 2) off++;
      }
      if (!n) return null;
      return {
        n, rmse: +Math.sqrt(s2 / n).toFixed(4), mae: +(sa / n).toFixed(4),
        maxErr: +mx.toFixed(2), offBy2Pct: +((100 * off) / n).toFixed(3),
      };
    };
    out.all = over(null);
    out.subject = over(P.masks.subject);
    out.blur = over(P.masks.blur);
    out.dofOnly = over(P.masks.dof);
    out.mbOnly = over(P.masks.mb);
    return out;
  };

  /* ------------------------------------------------------- one task, or void */

  /**
   * EVERY arm of a moment, plus its masks and its comparisons, inside ONE
   * synchronous task.
   *
   * This is not a convenience. Capturing arm-by-arm from the driver leaves an
   * rAF frame's worth of real time between two arms, and the game loop is still
   * running its own update in that gap even with KB.paused set -- only the
   * SIM stops, the visual systems do not. The tool's adjacent-null control
   * measured that as rmse 4.7-7.7 between two renders of an identical
   * configuration, which is the size of the entire signal. Nothing can be
   * concluded from arms captured across tasks; ssgate reached the same
   * conclusion about the same renderer and says so in its header.
   *
   * Requires: pin() already called. Returns everything the driver needs, so the
   * driver makes exactly one evaluate() per moment.
   */
  P.moment = (armSpecs, warm) => {
    const out = { arms: {}, taps: {}, compare: {} };
    // Masks first, off the shipped configuration, so every arm is scored over
    // the same pixel sets.
    P.arm('__mask', { adaptive: false }, warm);
    out.mask = P.subjectMask();
    out.taps.fixed = P.blurMask(false);
    out.taps.adaptive = P.blurMask(true);
    // blurMask(true) left masks.blur from the ADAPTIVE arm. Re-run fixed so the
    // at-risk mask is the union the SHIPPED chain touches; a tap-count change
    // can only shrink that set, never grow it, so the shipped union is the
    // conservative choice.
    P.blurMask(false);

    for (const a of armSpecs) out.arms[a.label] = P.arm(a.label, a.cfg, warm);
    for (const l of Object.keys(out.arms)) {
      if (l === 'conv') continue;
      out.compare[l] = P.compare(l, 'conv');
    }
    out.compare['adaptive-vs-fixed'] = P.compare('adaptive', 'fixed');
    return out;
  };

  P.keepPng = (v) => { P._keepPng = !!v; };
  return { ok: true };
})();
