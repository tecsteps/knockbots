/*
 * Page side of tools/scenebudget.mjs -- an INVENTORY of the scene pass.
 *
 * The pass-budget round attributed the frame down to "ScenePass" and stopped.
 * This one opens it: every draw the frame issues is intercepted at
 * WebGLRenderer.renderBufferDirect and tagged with the renderer.render
 * invocation it came from, so the 316 draws can be split into shadow maps,
 * depth prepass, planar reflector, arena beauty half and fighter beauty half,
 * and each of those into named objects with triangle counts.
 *
 * No backtick appears in this file, so the driver may embed it in a template
 * literal.
 *
 * Notes that are load-bearing:
 *  - renderer.info.autoReset is false here (RenderPipeline sets it), so the
 *    counters accumulate over the whole frame and a nested render does not
 *    clobber them. Deltas across a render are therefore meaningful.
 *  - ScenePass issues up to four renderer.render calls per frame and the arena
 *    floor issues a fifth from inside its onBeforeRender (the planar mirror),
 *    so stages are tracked with a depth counter, not a flag.
 *  - shadowMap.render runs INSIDE renderer.render, before the scene, so it is
 *    hooked separately or its draws would be billed to the enclosing stage.
 */
(() => {
  const KB = window.KB;
  const rp = KB.renderer;
  const R = rp.renderer;
  const P = {};
  window.__sb = P;

  P._rec = false;
  P._rows = [];
  P._stage = 'none';
  P._depth = 0;
  P._top = 0;
  P._frame = 0;
  P._stageRows = [];

  /* ------------------------------------------------------- fight, live ---- */

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
        if (KB.phase !== 'fight') KB.setPhase('fight');
        KB.training = true;
        for (const f of KB.fighters) if (f.health < 140) f.health = 180;
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
    }
    rp.setEffect('adaptiveResolution', false);
    if (rp.quality !== 'high') rp.setQuality('high');
    P.hook();
    const gl = R.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      quality: rp.quality, dpr: window.devicePixelRatio,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      scale: rp.renderScale,
      pixels: rp.composer && rp.composer.readBuffer
        ? rp.composer.readBuffer.width + 'x' + rp.composer.readBuffer.height : null,
      passes: rp.composer ? rp.composer.passes.length : 0,
    };
  };

  /* ------------------------------------------------------------- hooks ---- */

  const triOf = (geometry, object, group) => {
    const idx = geometry.index;
    const pos = geometry.attributes && geometry.attributes.position;
    let n = group && group.count !== Infinity && group.count !== undefined
      ? group.count : (idx ? idx.count : (pos ? pos.count : 0));
    if (!isFinite(n)) n = idx ? idx.count : (pos ? pos.count : 0);
    let t = n / 3;
    if (object.isInstancedMesh) t *= object.count;
    return t;
  };

  P.hook = () => {
    if (P._hooked) return;
    P._hooked = true;

    const origRBD = R.renderBufferDirect.bind(R);
    R.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      if (P._rec) {
        P._rows.push({
          f: P._frame,
          stage: P._stage,
          name: object.name || '',
          type: object.type,
          mat: (material && (material.name || material.type)) || '',
          tri: triOf(geometry, object, group),
          inst: object.isInstancedMesh ? object.count : 1,
          uuid: object.uuid,
          fc: object.frustumCulled !== false,
        });
      }
      return origRBD(camera, scene, geometry, material, object, group);
    };

    const origRender = R.render.bind(R);
    R.render = (scene, cam) => {
      P._depth++;
      const prev = P._stage;
      let tag;
      if (P._depth === 1) {
        tag = 't' + P._top;
        P._top++;
        if (scene.overrideMaterial) tag += '.prepass';
        else if (rp._passes.scene && cam === rp._passes.scene._shadowOnlyCamera) tag += '.splitshadowcam';
        else tag += '.beauty';
      } else {
        tag = prev + '>nested' + P._depth;
      }
      P._stage = tag;
      const c0 = R.info.render.calls, r0 = R.info.render.triangles;
      try {
        origRender(scene, cam);
      } finally {
        if (P._rec) {
          P._stageRows.push({
            f: P._frame, stage: tag, depth: P._depth,
            calls: R.info.render.calls - c0, tri: R.info.render.triangles - r0,
          });
        }
        P._stage = prev;
        P._depth--;
      }
    };

    const sm = R.shadowMap;
    const origSM = sm.render.bind(sm);
    sm.render = (lights, scene, cam) => {
      const prev = P._stage;
      P._stage = prev + '|shadow';
      const c0 = R.info.render.calls, r0 = R.info.render.triangles;
      try {
        origSM(lights, scene, cam);
      } finally {
        if (P._rec && (R.info.render.calls - c0) > 0) {
          P._stageRows.push({
            f: P._frame, stage: P._stage, depth: -1,
            calls: R.info.render.calls - c0, tri: R.info.render.triangles - r0,
            lights: lights.length,
          });
        }
        P._stage = prev;
      }
    };

    const origPipe = rp.render.bind(rp);
    rp.render = (scene, cam, dt) => {
      P._top = 0;
      P._frame++;
      origPipe(scene, cam, dt);
    };
  };

  /* --------------------------------------------------------- inventory ---- */

  /** Records every draw for `frames` consecutive frames. */
  P.capture = (frames) => new Promise((res) => {
    P._rows = [];
    P._stageRows = [];
    const f0 = P._frame;
    P._rec = true;
    const wait = () => {
      if (P._frame - f0 >= frames) {
        P._rec = false;
        res({ rows: P._rows.slice(), stages: P._stageRows.slice(), frames: P._frame - f0 });
      } else requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  });

  /* ---- scene-graph census: what is renderable, how big is it on screen --- */

  /**
   * Every renderable in the scene with its screen-space radius at the live
   * camera, whether the camera frustum contains it, and how many triangles it
   * carries. This is what says whether culling has anything left to take.
   */
  P.census = () => {
    const THREE = KB.THREE;
    const scene = rp._lastScene || rp.scene || KB.scene;
    const cam = rp._lastCamera || KB.camera;
    cam.updateMatrixWorld();
    const proj = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(proj);
    const sph = new THREE.Sphere();
    const tanHalf = cam.isPerspectiveCamera ? Math.tan(cam.fov * Math.PI / 360) : 1;
    const eye = cam.position;
    const out = [];
    scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      const g = o.geometry;
      if (!g) return;
      if (g.boundingSphere === null) g.computeBoundingSphere();
      const bs = g.boundingSphere;
      let sr = null, inFrustum = null, dist = null;
      if (bs) {
        sph.copy(bs).applyMatrix4(o.matrixWorld);
        dist = sph.center.distanceTo(eye);
        sr = sph.radius / Math.max(1e-3, dist * tanHalf);
        inFrustum = frustum.intersectsSphere(sph);
      }
      const idx = g.index, pos = g.attributes && g.attributes.position;
      let tri = (idx ? idx.count : (pos ? pos.count : 0)) / 3;
      if (o.isInstancedMesh) tri *= o.count;
      const m = o.material;
      const mats = Array.isArray(m) ? m : [m];
      out.push({
        name: o.name || '', type: o.type,
        visible: o.visible, vparent: (() => { let p = o.parent, v = true; while (p) { if (!p.visible) v = false; p = p.parent; } return v; })(),
        layers: o.layers.mask,
        frustumCulled: o.frustumCulled !== false,
        instanced: !!o.isInstancedMesh, count: o.isInstancedMesh ? o.count : 1,
        groups: g.groups ? g.groups.length : 0,
        tri, radius: bs ? bs.radius : null, dist, screenR: sr, inFrustum,
        mats: mats.map((x) => (x ? (x.name || x.type) : 'null')),
        transparent: mats.some((x) => x && x.transparent),
        alphaTest: mats.some((x) => x && x.alphaTest > 0),
        depthWrite: mats.every((x) => !x || x.depthWrite !== false),
        castShadow: o.castShadow, receiveShadow: o.receiveShadow,
        onBeforeRender: o.onBeforeRender !== Object.getPrototypeOf(Object.getPrototypeOf(o)).constructor.prototype.onBeforeRender
          && String(o.onBeforeRender).length > 40,
        path: (() => { const p = []; let n = o; while (n && n !== scene) { p.unshift(n.name || n.type); n = n.parent; } return p.join('/'); })(),
      });
    });
    // lights, because the shadow draws are driven by them
    const lights = [];
    scene.traverse((o) => {
      if (!o.isLight) return;
      lights.push({
        name: o.name || '', type: o.type, visible: o.visible,
        castShadow: !!o.castShadow, layers: o.layers.mask,
        mapSize: o.shadow ? (o.shadow.mapSize.x + 'x' + o.shadow.mapSize.y) : null,
      });
    });
    return { objects: out, lights, camFov: cam.fov, camPos: cam.position.toArray().map((v) => +v.toFixed(2)) };
  };

  return { ok: true };
})();
