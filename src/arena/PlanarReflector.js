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
 * What the pass actually costs, measured at 1080p on an M4 with the shipping
 * lighting rig: 51 draw calls and 4.1ms of a 41.8ms frame. Almost none of that
 * is the mirror's own geometry — deleting every merged stage mesh and the whole
 * hangar structure from it removes 27 of those draw calls and returns 1.2ms.
 * The cost is that a second set of fragments is shaded through the scene's
 * twenty-three real-time lights, eight of which are `RectAreaLight`s running
 * three's LTC integral. With those eight removed the entire reflection stack —
 * this pass plus the floor's gather — costs 0.6ms of a 16.4ms frame. The mirror
 * is not expensive; the shading it repeats is, and most of that repetition is
 * per-draw rather than per-pixel — rendering the same materials under a second
 * camera makes three refresh every material's uniforms, and with twenty-three
 * lights in the block that is not a small refresh. Hence `setSize` is not worth
 * tuning, and the only lever left here is the object list, which belongs to
 * whoever calls `exclude`.
 *
 * The pass is driven from the floor mesh's `onBeforeRender`, exactly as
 * three's stock `Reflector` does, so it always sees the final camera transform
 * for the frame and never runs when the floor is culled. The RenderPipeline
 * renders the scene more than once per frame (main pass, then a normal/depth
 * prepass with `scene.overrideMaterial` set); a frame token from `Stage.update`
 * makes sure the reflection is built exactly once, during the main pass.
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

export class PlanarReflector {
  /**
   * @param {THREE.Scene} scene
   * @param {object} [opts]
   * @param {number} [opts.planeY=0] world height of the mirror plane
   * @param {number} [opts.width=1024] render target width
   * @param {number} [opts.height=512] render target height
   * @param {number} [opts.clipBias=0.004]
   * @param {boolean} [opts.coarseLod=true] draw LOD objects at their far level
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.planeY = opts.planeY ?? 0;
    this.clipBias = opts.clipBias ?? 0.004;
    this.enabled = true;
    /** Demote every `THREE.LOD` to its last level for the mirror pass. */
    this.coarseLod = opts.coarseLod !== false;

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
   * Do not spend effort here. A cap was tried and reverted: at 1080p, taking
   * the buffer from 540 lines down to 360 returned 0.04ms, and taking it all
   * the way down to 120 — a twentieth of the pixels — returned 1.19ms of a
   * 40.5ms frame, while switching the pass off entirely returned 6.42ms. Five
   * of those six milliseconds are therefore fixed per-frame cost, not fill, and
   * shrinking the buffer only trades reflection sharpness for nothing.
   */
  setSize(width, height) {
    const w = Math.max(64, Math.round(width));
    const h = Math.max(64, Math.round(height));
    if (this.target.width === w && this.target.height === h) return;
    this.target.setSize(w, h);
  }

  /** Called once per game frame; arms the pass for the next scene render. */
  arm(token) {
    this._token = token;
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
    this._busy = true;

    _camPos.setFromMatrixPosition(camera.matrixWorld);
    // A camera at or below the plane has nothing to mirror; keeping the last
    // frame's buffer is far less noticeable than a black flash.
    if (_camPos.y <= this.planeY + 0.02) { this._busy = false; return; }

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

    // Shadow maps were built by the main pass a moment ago and are valid for
    // any camera; rebuilding them for the mirror would double the cost of the
    // most expensive pass in the frame for no visible gain.
    renderer.shadowMap.autoUpdate = false;
    renderer.xr.enabled = false;
    this.scene.overrideMaterial = null;

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
