/**
 * Knockbots — horizontal planar reflection for the arena floor.
 *
 * The floor is the surface the fighters are standing on, so it is the surface
 * that carries their reflection, and a screen-space approximation cannot do
 * that job: the thing being reflected is the *underside* of the fighters, which
 * by definition is not on screen. So the scene is rendered a second time from a
 * camera mirrored through the floor plane.
 *
 * Two details do most of the work:
 *
 *   - **Oblique near-plane clipping.** The mirrored camera's near plane is
 *     skewed onto the floor plane itself, so nothing below the floor — the
 *     underside of the set, the mirrored copies of the walls' foundations —
 *     can leak into the reflection. Without this the reflection of a wall
 *     appears to start below the floor line and the illusion dies instantly.
 *   - **A stencil layer.** Anything on `LAYER.NO_REFLECT` is skipped, which is
 *     how the floor excludes itself (infinite recursion) and how additive
 *     volumetrics stay out of a buffer they would double-count in.
 *
 * The pass is a second full scene render and therefore the single largest block
 * of draw calls in the frame, so what it is allowed to draw matters as much as
 * how it is projected. Two things keep it down. The crowd, the skyline and the
 * light shafts are already on `LAYER.NO_REFLECT`, so the mirror never sees the
 * far half of the set. What is left is dominated by the fighters, and they are
 * the one thing that cannot be dropped — so instead every `THREE.LOD` in the
 * scene is demoted to its coarsest level for the duration of the pass. A
 * reflection off damp concrete is gathered over a roughness-proportional radius
 * and mixed in at a fraction of its own radiance; it is the last place in the
 * frame where a decimated silhouette is legible as decimated, and the far level
 * is a level the game already considers acceptable at thirteen metres.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PASS COSTS. Read this before touching anything, because three
 * separate figures for it have been published here and two of them are dead.
 *
 * RETRACTED, both of them, and the retractions are the useful part:
 *
 *   - **"51 draws, ~5ms of it fixed, so `setSize` is not worth tuning."** This
 *     docstring used to carry a sweep — 540 lines to 360 returned 0.04ms, 540 to
 *     120 returned 1.19ms, the pass switched off returned 6.42ms — and concluded
 *     that five of six milliseconds were fixed per-frame cost. That triple is
 *     **internally inconsistent and needs no external number to reject it.** If
 *     OFF returns 6.42ms and dropping to 4.9% of the pixels returns only 1.19ms,
 *     the pixel-proportional part is ~1.25ms and the fixed part ~5.2ms; but then
 *     dropping to 44% of the pixels must return ~0.7ms, and it read 0.04ms.
 *     Every reading was a single one, taken on a 40.5ms frame, i.e. a machine
 *     state 1.8x slower than a quiet one today. Nothing in it survives.
 *   - **"~1.50ms, derived from the charter decomposition."** That derivation
 *     took a FIXED cost of ~11ms from the charter's 28.2ms-baseline curve and
 *     subtracted it from a TOTAL of 17.0ms measured on a different machine
 *     state, leaving "6.0ms of fill" and a rate of 4.00 ns/px. **A fixed cost
 *     and a total from two different states cannot be differenced.** Fit a line
 *     to each resolution sweep this project has recorded instead — the SLOPE is
 *     what a resolution delta measures, and it reproduces where the intercept
 *     does not:
 *
 *         dataset                                    F (ms)   k (ns/px)  max resid
 *         charter decomposition, 28.2ms state, 3 pts   9.56     8.93       1.63
 *         RenderPipeline sweep, 20.4ms state, 4 pts    6.68     6.64       0.09
 *         round-37, quiet, native + tier, 2 pts        3.96     8.72       0.00
 *
 *     k lands in 6.6-8.9 ns/px across three unrelated sessions. F lands in
 *     4.0-9.6ms and is an extrapolation to zero pixels. The 4.00 ns/px the
 *     1.50ms figure was built on is low by 1.7-2.2x.
 *
 * WHAT THE PASS COSTS, RE-DERIVED, AND STILL NOT MEASURED AT NATIVE. The mirror
 * is 25.0% of the main pass's pixel count at every renderScale, because both
 * are struck from the same drawing buffer (`Stage.REFLECT_SCALE` 0.5 at `high`):
 *
 *     NATIVE  renderScale 1.00   main 1920x1080 = 2,073,600   mirror 960x540 = 518,400
 *     tier    renderScale 0.85   main 1632x918  = 1,498,176   mirror 816x459 = 374,544
 *
 * **Every figure ever published for this pass was taken at the tier.** At native
 * the mirror shades 518,400 px, 38% more than the number the round-32 derivation
 * used. Priced at the whole-frame slope that is 3.4-4.6ms — an upper bound,
 * because the whole-frame slope includes a post chain the mirror does not run.
 * Net of post's 26% share of the resolution-scaling work, main-pass per-pixel
 * parity puts it at **2.5-3.4ms at native**.
 *
 * AND IT IS NOT AT PARITY — IT IS ABOVE IT. This is the mechanism the 1.50ms
 * derivation explicitly ruled out ("5.4ms would need the mirror's pixels to be
 * four times more expensive than the main pass's, and nothing about it suggests
 * they are"). Something does. `RenderPipeline` splits the beauty pass in two so
 * the arena is not lit by the per-fighter rig; **this camera is `enableAll` and
 * gets neither half, it gets the union.** Counted offline from the live rig at
 * the `high` tier:
 *
 *     main pass, arena half     4 lights, 1 shadow map
 *     main pass, fighter half  15 lights, 3 shadow maps
 *     THIS PASS                15 lights, 3 shadow maps  <- on every fragment
 *
 * Re-count the arena half before quoting it: it read 5/10 earlier in this same
 * round and 4/11 an hour later, because `Environment` moved `bounceLight` onto
 * `SPLIT_LIGHT_LAYER` while this was being written. **15 and 3 are the stable
 * numbers**, because the mirror gets the union and the union does not care where
 * the boundary sits. The ratio to the arena half is the volatile part.
 *
 * So the mirror's arena fragments — the great majority of them — carry 3x the
 * lights and 3x the PCSS lookups of the main-pass fragments they are mirroring.
 * That is also a correctness wrinkle: the reflected walls and set are lit by two
 * lights aimed at the robots, and the real ones are not.
 *
 * THE LIGHT COUNT ITSELF WAS WRONG EVERYWHERE IT WAS QUOTED. "Twenty-three
 * lights, eight of them RectArea" was this docstring's; PROFILING.md says 22/8.
 * Both are the **constructed** count. `WebGLRenderer.projectObject` early-returns
 * on `object.visible === false`, so an invisible light never enters the render
 * state. Counted at `high`: 20 constructed (8 RectArea), **15 visible (3
 * RectArea, 3 shadowed)** — which is the charter's own "fifteen analytic lights",
 * unread for thirty-odd rounds. The LTC integral runs three times, not eight.
 *
 * WHAT IS NOT THE LEVER. The object list. The mirror draws 23 of the arena's 41
 * drawables (140,588 of 267,047 tris); dropping the three merged stage meshes
 * removes 3 draws, and the charter prices a draw at 1.2 microseconds. That is
 * 0.004ms. Triangles are not the lever either and never were.
 *
 * ---------------------------------------------------------------------------
 * The pass is driven from the floor mesh's `onBeforeRender`, exactly as
 * three's stock `Reflector` does, so it always sees the final camera transform
 * for the frame and never runs when the floor is culled. The RenderPipeline
 * renders the scene more than once per frame (a normal/depth prepass with
 * `scene.overrideMaterial` set, then the two halves of the beauty pass); a frame
 * token from `Stage.update` makes sure the reflection is built exactly once.
 */

import * as THREE from 'three';
import { LAYER } from '../core/Constants.js';

const _normal = new THREE.Vector3(0, 1, 0);
const _plane = new THREE.Plane();
const _clipPlane = new THREE.Vector4();
const _q = new THREE.Vector4();
const _camPos = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _target = new THREE.Vector3();
const _view = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _origin = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class PlanarReflector {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   * @param {number} [opts.planeY=0] world height of the mirror plane
   * @param {number} [opts.width=1024] render target width
   * @param {number} [opts.height=512] render target height
   * @param {number} [opts.clipBias=0.004]
   * @param {boolean} [opts.coarseLod=true] draw LOD objects at their far level
   * @param {number} [opts.interval=2] refresh every Nth frame; see {@link interval}
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.planeY = opts.planeY ?? 0;
    this.clipBias = opts.clipBias ?? 0.004;
    this.enabled = true;
    /** Demote every `THREE.LOD` to its last level for the mirror pass. */
    this.coarseLod = opts.coarseLod !== false;

    /**
     * Refresh the buffer every Nth frame. 1 is every frame, 2 is every other.
     *
     * **THIS SHIPS AT 2 AND ITS FRAME COST IS UNMEASURED.** It is a lever rather
     * than a tuning: it is the only one that is robust to the contradiction the
     * class docstring is a monument to. Half resolution only pays if the pass is
     * fill-bound; trimming the object list only pays if it is draw-bound; the
     * two published figures disagree about which. Skipping the whole pass halves
     * whichever it is, in the same proportion, without needing to know.
     *
     * WHAT IT BUYS AND WHAT IT DOES NOT, because the two are different
     * statistics and this project has been burned by conflating them. Amortised
     * over two frames it removes half the pass's cost from the **mean** frame
     * time, which is the statistic every performance figure in `docs/PROFILING.md`
     * is quoted as. It removes **nothing** from the worst case: the frame that
     * does refresh costs exactly what it always did. A strict reading of the
     * charter's "60fps at 1920x1080" is a per-frame deadline, and against that
     * reading this change is worth zero until enough else is cut that the
     * refreshing frame also fits in 16.667ms. Both numbers, always.
     *
     * WHY IT IS VISUALLY AFFORDABLE. The buffer is 25% of the main pass's pixel
     * count, gathered by `StageFloor` over a five-tap roughness-proportional
     * cross, and mixed in at a Fresnel-weighted fraction that measures ~0.11 at
     * the wide framing. A one-frame-stale sample of that is a sub-pixel
     * reprojection error on a signal that is already blurred. `textureMatrix` is
     * deliberately NOT updated on a skipped frame — buffer and projection stay
     * paired, so a stale reflection is a coherent reflection of a stale eye
     * rather than a correct buffer sampled through the wrong matrix.
     *
     * WHAT IT WOULD BREAK IF UNGUARDED: a camera cut. A KO swing or a cinematic
     * hands the floor a mirror of the previous shot for one frame. {@link cutEye}
     * and {@link cutDot} force a refresh through the parity when the eye jumps,
     * so the artefact is bounded to camera motion that is smooth enough for the
     * reflection to be smooth too.
     * @type {number}
     */
    this.interval = Math.max(1, Math.round(opts.interval ?? 2));
    /**
     * Force a refresh when the eye moves further than this in one frame, in
     * metres. 0.35m at 60Hz is 21 m/s — a cut, not a dolly. The fight camera's
     * spring-damper does not reach it under its own steam.
     *
     * IT DOES REACH IT ON A HEAVY HIT, and that is deliberate rather than an
     * oversight. `FightCamera.SHAKE` is lateral 0.22 / vertical 0.16 / dolly
     * 0.10 metres at full trauma, on a noise clock advancing 0.43 per frame, so
     * a peak-trauma frame can displace the eye by ~0.5m and this guard fires
     * through the whole decay. The pass therefore refreshes every frame for the
     * few tenths of a second after a super or a launcher — the moment when the
     * saving would be worth most and when a stale mirror would smear worst.
     * Erring toward correct is the direction that cannot look wrong. If the perf
     * arm wants the skip held through shake as well, raise this to 0.7; nothing
     * else needs to change.
     * @type {number}
     */
    this.cutEye = opts.cutEye ?? 0.35;
    /**
     * Force a refresh when the view direction turns further than this in one
     * frame, as a cosine. 0.9945 is ~6 degrees, i.e. 360 deg/s.
     * @type {number}
     */
    this.cutDot = opts.cutDot ?? 0.9945;
    /**
     * Refreshes and skips since construction. Not decoration: an A/B on
     * `interval` needs a control that proves the arm is armed, and these are it.
     * `skips` must stay 0 at `interval = 1` and must climb at 2.
     */
    this.refreshes = 0;
    this.skips = 0;

    this._lastEye = new THREE.Vector3();
    this._lastFwd = new THREE.Vector3(0, 0, -1);
    /** Frames skipped since the last refresh; primed so the first frame draws. */
    this._sinceRefresh = Infinity;

    this.target = new THREE.WebGLRenderTarget(opts.width ?? 1024, opts.height ?? 512, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      samples: opts.samples ?? 0,
    });
    this.target.texture.name = 'arena.reflection';

    /** Sampled by the floor material. */
    this.texture = this.target.texture;
    /** Projects world position into reflection UV; uploaded as a uniform. */
    this.textureMatrix = new THREE.Matrix4();

    this.camera = new THREE.PerspectiveCamera();
    this.camera.layers.enableAll();
    this.camera.layers.disable(LAYER.NO_REFLECT);

    this._token = -1;
    this._busy = false;
    this._hidden = [];
    /** Parallel to `_hidden`: what each object's `visible` was before the pass. */
    this._hiddenWas = [];
    /** Reused across frames; entries are `{ lod, autoUpdate, visible: [] }`. */
    this._lodState = [];
    this._lodCount = 0;
    this._collectLod = (o) => { if (o.isLOD && o.levels.length > 1) this.#demote(o); };
  }

  /**
   * Resizes the reflection buffer. Half the drawing buffer is enough: the
   * result is blurred by the floor's roughness anyway, and the saving buys the
   * second scene render.
   *
   * **The "do not spend effort here" that used to sit in this docstring is
   * withdrawn.** It rested on a sweep — 540 lines to 360 returning 0.04ms while
   * the pass switched off returned 6.42ms — that cannot be true of the same
   * pass; see the class docstring for the arithmetic. Whether resolution is the
   * lever here is now an OPEN question and the arm to settle it is half and
   * quarter of the shipped size, at native, interleaved and null-bracketed.
   *
   * A resize leaves the buffer's contents undefined, so it also drops the
   * temporal cache: the next frame refreshes whatever {@link interval} says.
   */
  setSize(width, height) {
    const w = Math.max(64, Math.round(width));
    const h = Math.max(64, Math.round(height));
    if (this.target.width === w && this.target.height === h) return;
    this.target.setSize(w, h);
    this.invalidate();
  }

  /**
   * Drops the temporal cache: the next armed frame refreshes regardless of
   * {@link interval}. Call after anything that makes the held buffer wrong —
   * a resize, a re-enable, an arena swap, a camera cut the guards cannot see.
   */
  invalidate() {
    this._sinceRefresh = Infinity;
  }

  /** Called once per game frame; arms the pass for the next scene render. */
  arm(token) {
    this._token = token;
  }

  /**
   * Is this armed frame one that refreshes the buffer?
   *
   * Counts skips rather than testing the token's parity, so the answer does not
   * depend on where the frame counter happened to start and a forced refresh
   * re-phases the sequence instead of colliding with it.
   *
   * `_camPos` is already the eye position; `_fwd` is filled here because the
   * caller needs it either way to record the pose that was captured.
   * @param {THREE.Camera} camera
   */
  #due(camera) {
    const e = camera.matrixWorld.elements;
    _fwd.set(-e[8], -e[9], -e[10]).normalize();
    if (this.interval <= 1) return true;
    if (this._sinceRefresh >= this.interval - 1) return true;
    if (_camPos.distanceToSquared(this._lastEye) > this.cutEye * this.cutEye) return true;
    return _fwd.dot(this._lastFwd) < this.cutDot;
  }

  /**
   * Renders the mirrored view. Safe to call from `onBeforeRender`; it no-ops
   * unless armed, which keeps it out of the pipeline's depth/normal prepass.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera the camera the scene is being drawn with
   * @param {THREE.Object3D} self the floor mesh, hidden during the pass
   */
  render(renderer, camera, self) {
    if (!this.enabled || this._busy || this._token < 0) return;
    if (!camera.isPerspectiveCamera) return;
    this._token = -1;

    _camPos.setFromMatrixPosition(camera.matrixWorld);
    // A camera at or below the plane has nothing to mirror; keeping the last
    // frame's buffer is far less noticeable than a black flash.
    if (_camPos.y <= this.planeY + 0.02) return;

    // The temporal gate. Everything above is cheap and everything below is the
    // pass, so this is where the frame is either spent or not. On a skip the
    // buffer AND `textureMatrix` are both left alone — see `interval`.
    if (!this.#due(camera)) { this._sinceRefresh++; this.skips++; return; }
    this._sinceRefresh = 0;
    this.refreshes++;
    this._lastEye.copy(_camPos);
    this._lastFwd.copy(_fwd);
    this._busy = true;

    _origin.set(0, this.planeY, 0);

    // Mirror the eye point.
    _view.subVectors(_origin, _camPos).reflect(_normal).negate().add(_origin);

    // Mirror the look-at point through the same plane.
    _rot.extractRotation(camera.matrixWorld);
    _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
    _target.subVectors(_origin, _lookAt).reflect(_normal).negate().add(_origin);

    const cam = this.camera;
    cam.position.copy(_view);
    cam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
    cam.lookAt(_target);
    cam.near = camera.near;
    cam.far = camera.far;
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.zoom = camera.zoom;
    cam.filmOffset = camera.filmOffset;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    // World -> reflection UV, with the perspective divide left to the shader.
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    // Skew the near plane onto the mirror plane (Lengyel's oblique frustum).
    _plane.setFromNormalAndCoplanarPoint(_normal, _origin);
    _plane.applyMatrix4(cam.matrixWorldInverse);
    _clipPlane.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const p = cam.projectionMatrix;
    _q.x = (Math.sign(_clipPlane.x) + p.elements[8]) / p.elements[0];
    _q.y = (Math.sign(_clipPlane.y) + p.elements[9]) / p.elements[5];
    _q.z = -1.0;
    _q.w = (1.0 + p.elements[10]) / p.elements[14];
    _clipPlane.multiplyScalar(2.0 / _clipPlane.dot(_q));
    p.elements[2] = _clipPlane.x;
    p.elements[6] = _clipPlane.y;
    p.elements[10] = _clipPlane.z + 1.0 - this.clipBias;
    p.elements[14] = _clipPlane.w;

    // --- render -------------------------------------------------------------
    const prevTarget = renderer.getRenderTarget();
    const prevActiveCube = renderer.getActiveCubeFace();
    const prevActiveMip = renderer.getActiveMipmapLevel();
    const prevXr = renderer.xr.enabled;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevOverride = this.scene.overrideMaterial;
    const prevAutoClear = renderer.autoClear;
    const prevMatrixAuto = this.scene.matrixWorldAutoUpdate;

    // Shadow maps were built by the main pass a moment ago and are valid for
    // any camera; rebuilding them for the mirror would double the cost of the
    // most expensive pass in the frame for no visible gain.
    renderer.shadowMap.autoUpdate = false;
    renderer.xr.enabled = false;
    this.scene.overrideMaterial = null;
    // Same argument, for the same reason, one line further out.
    // `WebGLRenderer.render` opens with `if ( scene.matrixWorldAutoUpdate )
    // scene.updateMatrixWorld()`. This call is nested INSIDE the outer render's
    // object loop — `onBeforeRender` cannot be reached any other way — so that
    // walk has already run this frame and nothing between then and here can have
    // moved a node. The saving is one full scene-graph traversal per frame and
    // it is microseconds, not milliseconds: the arena graph is 45 nodes, and
    // even with both robots and their skeletons the whole scene is order 10^3.
    // It is here because it is provably redundant, not because it is large.
    this.scene.matrixWorldAutoUpdate = false;

    const selfVisible = self ? self.visible : false;
    if (self) self.visible = false;
    // Save/restore rather than assign true. The old form unconditionally set
    // `visible = true` on the way out, which quietly made every excluded object
    // permanently visible: anything on this list could never be hidden by
    // anyone, because the mirror ran once a frame and put it back. That cost a
    // full round of measurement on the contact shadows, whose A/B toggled
    // `visible` and got the identical frame both ways.
    for (let i = 0; i < this._hidden.length; i++) {
      const o = this._hidden[i];
      this._hiddenWas[i] = o.visible;
      o.visible = false;
    }
    if (this.coarseLod) this.scene.traverse(this._collectLod);

    // The composer leaves autoClear off between passes; the mirror buffer must
    // clear itself or it accumulates last frame's image.
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, cam);

    this.#restoreLods();
    for (let i = 0; i < this._hidden.length; i++) this._hidden[i].visible = this._hiddenWas[i];
    if (self) self.visible = selfVisible;

    renderer.autoClear = prevAutoClear;
    this.scene.matrixWorldAutoUpdate = prevMatrixAuto;
    this.scene.overrideMaterial = prevOverride;
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.setRenderTarget(prevTarget, prevActiveCube, prevActiveMip);

    this._busy = false;
  }

  /**
   * Pins one LOD to its coarsest level and records what to put back.
   *
   * `autoUpdate` has to go with it: three re-selects a level inside
   * `projectObject`, from the distance to whichever camera is drawing, so
   * without this the mirror camera — which sits at roughly the same distance as
   * the real one — would immediately choose level 0 again.
   * @param {THREE.LOD} lod
   */
  #demote(lod) {
    let entry = this._lodState[this._lodCount];
    if (!entry) {
      entry = { lod: null, autoUpdate: true, visible: [] };
      this._lodState[this._lodCount] = entry;
    }
    entry.lod = lod;
    entry.autoUpdate = lod.autoUpdate;
    entry.visible.length = 0;
    const last = lod.levels.length - 1;
    for (let i = 0; i <= last; i++) {
      entry.visible.push(lod.levels[i].object.visible);
      lod.levels[i].object.visible = i === last;
    }
    lod.autoUpdate = false;
    this._lodCount++;
  }

  /** Restores every level's visibility exactly as the main pass left it. */
  #restoreLods() {
    for (let i = 0; i < this._lodCount; i++) {
      const entry = this._lodState[i];
      const levels = entry.lod.levels;
      for (let j = 0; j < levels.length; j++) levels[j].object.visible = entry.visible[j];
      entry.lod.autoUpdate = entry.autoUpdate;
      entry.lod = null;
    }
    this._lodCount = 0;
  }

  /**
   * Objects hidden for the duration of the reflection pass. Use for anything
   * whose reflection would be wrong rather than merely expensive — ground fog
   * cards, the floor decals, sprites that face the main camera.
   * @param {THREE.Object3D[]} objects
   */
  exclude(objects) {
    for (const o of objects) if (o && !this._hidden.includes(o)) this._hidden.push(o);
  }

  dispose() {
    this.target.dispose();
  }
}
