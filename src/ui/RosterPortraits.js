/**
 * Knockbots — rendered roster portraits.
 *
 * The select screen used to draw each machine as a hand-authored flat SVG
 * mannequin: ten near-identical grey humanoids differing only in an accent
 * colour and a chest shape. The game renders ten genuinely distinct robots and
 * none of that reached the screen, so a player could not tell the cast apart
 * from the tiles.
 *
 * This renders the real thing. The expensive part is free: `MenuSystem`
 * already builds every robot once in idle time to warm RobotBuilder's
 * per-palette material caches, and then throws each one away. We photograph it
 * on the way to the bin.
 *
 * Three constraints this project has already paid for in stalls, all obeyed here:
 *
 *   - **No second `WebGLRenderer`.** One was measured at 184-511ms to create
 *     the context and 892-1273ms on first render, because it shares no compiled
 *     programs and none of the ~32 procedural material maps. We borrow the
 *     game's renderer and restore its state.
 *   - **No synchronous `readRenderTargetPixels`.** That flushes the GL queue and
 *     blocks the main thread 316-1382ms per call; it was the multi-second freeze
 *     players hit at the start of a match. Async only, one readback in flight.
 *   - **One capture per idle slice.** Ten robots built in one loop measured
 *     2.236s.
 *
 * A portrait that is not ready yet is not a gap: the tile shows the machine's
 * initial in its own accent colour until the image arrives, so nothing moves.
 */

import * as THREE from 'three';

const SIZE = 256;           // square target; the tile crops to its own aspect
const BUST_HEIGHT = 1.15;   // metres of the machine to frame, from the crown down

export class RosterPortraits {
  /**
   * @param {THREE.WebGLRenderer} renderer the game's renderer, borrowed
   * @param {{ envMap?: THREE.Texture }} environment for consistent lighting
   */
  constructor(renderer, environment) {
    this.renderer = renderer;
    this.environment = environment;
    /** @type {Map<string,string>} character id -> data URL */
    this.cache = new Map();
    this._busy = false;
    this._rt = null;
    this._scene = null;
    this._camera = null;
    this._canvas = null;
    this._buf = null;
  }

  #ensure() {
    if (this._rt) return;
    this._rt = new THREE.WebGLRenderTarget(SIZE, SIZE, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: true,
    });

    this._scene = new THREE.Scene();
    // The env map alone would leave a mechanical subject mushy, so there is a
    // key and a rim here for the same reason the fight rig has them — but as
    // cheap directionals, because a portrait is a still and needs no area
    // source, and RectAreaLights cost ~3ms each in the main scene.
    const key = new THREE.DirectionalLight(0xffe6c2, 2.6);
    key.position.set(1.1, 1.5, 2.2);
    const rim = new THREE.DirectionalLight(0x7fd4ff, 3.4);
    rim.position.set(-1.6, 0.7, -1.9);
    const fill = new THREE.HemisphereLight(0x2c3a4c, 0x0a0d13, 0.55);
    this._scene.add(key, rim, fill);
    if (this.environment?.envMap) this._scene.environment = this.environment.envMap;

    this._camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
    this._canvas = document.createElement('canvas');
    this._canvas.width = SIZE;
    this._canvas.height = SIZE;
    this._ctx = this._canvas.getContext('2d');
    this._buf = new Uint8Array(SIZE * SIZE * 4);
  }

  /** True once a portrait exists for this character. */
  has(id) { return this.cache.has(id); }
  get(id) { return this.cache.get(id) ?? null; }

  /**
   * Photograph an already-built robot. Call this while you still hold it and
   * before disposing it — the caller owns the robot's lifetime, not us.
   *
   * @param {string} id character id
   * @param {{ group: THREE.Object3D }} robot the result of `buildRobot`
   * @returns {Promise<?string>} data URL, or null if it could not be captured
   */
  async capture(id, robot) {
    if (this.cache.has(id) || this._busy || !robot?.group) return this.cache.get(id) ?? null;
    const rAsync = this.renderer.readRenderTargetPixelsAsync;
    if (typeof rAsync !== 'function') return null;   // never fall back to the sync path

    this._busy = true;
    this.#ensure();

    const prevTarget = this.renderer.getRenderTarget();
    const group = robot.group;
    const prevParent = group.parent;

    try {
      this._scene.add(group);
      group.updateMatrixWorld(true);

      // Frame the top of the machine rather than its centre: a bust reads as a
      // portrait, a full body at this size reads as a small grey figure — which
      // is the problem the mannequins had.
      const box = new THREE.Box3().setFromObject(group);
      const crown = box.max.y;
      const centreY = crown - BUST_HEIGHT * 0.42;
      const width = Math.max(box.max.x - box.min.x, 0.6);
      const dist = Math.max(BUST_HEIGHT, width) * 1.55;

      // Three-quarter view. Straight-on flattens a hard-surface subject; this
      // angle shows a front plane and a side plane so the chamfers read.
      this._camera.position.set(dist * 0.62, centreY + BUST_HEIGHT * 0.20, dist * 0.86);
      this._camera.lookAt(0, centreY, 0);
      this._camera.updateProjectionMatrix();

      this.renderer.setRenderTarget(this._rt);
      this.renderer.clear(true, true, false);
      this.renderer.render(this._scene, this._camera);
      this.renderer.setRenderTarget(prevTarget);

      await rAsync.call(this.renderer, this._rt, 0, 0, SIZE, SIZE, this._buf);

      // WebGL reads bottom-up; flip while blitting into the 2D canvas.
      const img = this._ctx.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) {
        const src = (SIZE - 1 - y) * SIZE * 4;
        img.data.set(this._buf.subarray(src, src + SIZE * 4), y * SIZE * 4);
      }
      this._ctx.putImageData(img, 0, 0);
      const url = this._canvas.toDataURL('image/webp', 0.86);
      this.cache.set(id, url);
      return url;
    } catch {
      return null;
    } finally {
      // Always hand the robot back exactly as we found it, or the caller's
      // dispose() runs against a group we have reparented.
      if (prevParent) prevParent.add(group);
      else this._scene.remove(group);
      this.renderer.setRenderTarget(prevTarget);
      this._busy = false;
    }
  }

  dispose() {
    this._rt?.dispose();
    this._rt = null;
    this._scene = null;
    this.cache.clear();
  }
}
