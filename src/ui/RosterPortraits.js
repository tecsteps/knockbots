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

/** Scratch for saving the renderer's clear colour across a portrait pass. */
const _clear = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const SIZE = 256;           // square target; the tile crops to its own aspect
const FOV = 30;

/**
 * The frame is derived from the rig, not from a constant.
 *
 * Two constants were tried and both failed, for opposite reasons, and the
 * measurements are worth keeping because they are what settled it.
 *
 *  - `BUST_HEIGHT = 1.15` with distance `max(BUST_HEIGHT, bboxWidth) * 1.55`.
 *    An idle machine's X extent (arms out, shoulder cannon, wing plates) is
 *    1.4-1.9 m, so the width term always won and pulled the lens back until
 *    the frame was ~1.6 m tall. Measured over eight captured portraits, the
 *    subject occupied 91.8-98.8% of the frame HEIGHT and its bottom edge was
 *    at 99.6% on every single one. A shrunken full body — the exact failure
 *    the hand-drawn mannequins had and the reason this file exists.
 *  - A flat 0.92 m frame aimed 0.22 m under the `head` bone. Better on the
 *    slim chassis, catastrophic on the wide ones: Anvil and Bastion came back
 *    as a wall of shoulder plate with no head in the picture at all, and Nyx
 *    and Volta lost the head off the top edge. A brute's head sits lower
 *    relative to its shoulders and its whole rig is scaled by
 *    `def.proportions`, so no absolute number can frame ten machines.
 *
 * The skeleton already carries the two landmarks that make this scale-free:
 * `headTop` and `chest` (see Skeleton.js). Their separation IS the machine's
 * own head-and-neck unit, in its own units, and the frame is built from it.
 */

/**
 * Frame height as a multiple of the headTop..chest span.
 *
 * Also measured. At 1.75 spans (~0.83 m) the frame is filled by shoulder: the
 * cast's shoulder-to-shoulder width is 0.89-1.45 m against a head roughly
 * 0.30 m across, so a frame wide enough to hold the shoulders makes the head a
 * fifth of the picture — which looked, at 63 px, exactly like the full-body
 * render it replaced. 1.30 spans crops the shoulders at the frame edge, which
 * is what a portrait is supposed to do, and puts the head across the upper
 * 23-61% of the frame.
 */
const FRAME_SPANS = 1.30;

/** Headroom above `headTop`, as a multiple of that same span. Armour, crests
 *  and antennae live above the bone, so this is deliberately generous. */
const HEADROOM_SPANS = 0.30;

/** Floor for the span, so a degenerate rig cannot put the lens inside the mesh. */
const MIN_SPAN = 0.22;

/** Fallback drop below the bounding-box crown when a robot has no rig at all. */
const CROWN_DROP = 0.30;

/**
 * Unit view direction, normalised. A three-quarter angle: straight-on flattens
 * a hard-surface subject, this shows a front plane and a side plane so the
 * chamfers read. Kept as a direction rather than folded into the position, so
 * distance is free to be derived from the framing instead of guessed.
 */
const DIR = (() => {
  // 19 degrees off axis, not 38. At the wider angle the near shoulder pauldron
  // sits between the lens and the head on every wide chassis — Anvil, Bastion
  // and Volta came back as a wall of shoulder plate with no head visible at
  // all, three runs in a row, while the slim machines framed correctly. The
  // shoulders are 0.89-1.45 m apart and the head is set back between them, so
  // the occlusion is geometric and no amount of zoom fixes it. Swinging the
  // lens toward the centre line clears the pauldron and still shows two planes.
  //
  // Elevation was raised to 0.45 (26 degrees) to look OVER the pauldrons, and
  // measured worse on the whole cast: at that angle Anvil and Nyx are the top
  // of a bald dome, Axiom loses its face entirely, and Bastion's shields still
  // occlude because they are raised in FRONT of the chest rather than beside
  // it. Reverted to 8.6 degrees. Bastion, Volta and Anvil still photograph
  // their armour rather than their heads; `frames` records that the head bone
  // projects to (0.50, 0.51) on all three, so this is occlusion by the rest
  // pose, not a framing error, and no camera placement in this file can fix
  // it — it needs a portrait pose from the animation side.
  const v = new THREE.Vector3(0.33, 0.15, 0.94);
  return v.normalize();
})();

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
    /** @type {Map<string,object>} character id -> what the framing resolved to */
    this.frames = new Map();
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
      // The portrait is cut out against transparency now, so its silhouette is
      // a hard alpha edge displayed at 63.5 CSS px. Unresolved, that edge is a
      // visible staircase on every barrel and shoulder plate. This pass runs
      // ten times in idle time and never again.
      samples: 4,
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

    this._camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 20);
    this._aim = new THREE.Vector3();
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
    this.renderer.getClearColor(_clear);
    const prevClearAlpha = this.renderer.getClearAlpha();

    try {
      this._scene.add(group);
      group.updateMatrixWorld(true);

      // Frame off the RIG, not the bounding box.
      //
      // The crown of the box is not the top of the head on half this cast:
      // Vulkan's is the tip of a shoulder cannon, Kestrel's a backpack fin,
      // Volta's a shield disc. A frame hung off the crown put a barrel in the
      // middle of the picture and the face somewhere below it, which is a
      // large part of why the machines were not tellable apart from the tiles.
      const bones = robot.parts?.byName;
      const headTop = bones?.headTop ?? bones?.head;
      const chest = bones?.chest ?? bones?.spine02;
      let frameH;
      if (headTop && chest) {
        headTop.getWorldPosition(_a);
        chest.getWorldPosition(_b);
        const span = Math.max(_a.y - _b.y, MIN_SPAN);
        frameH = span * FRAME_SPANS;
        // The head sits in the upper band of the frame, the way a portrait
        // photographer would place it, rather than dead centre.
        this._aim.set(_a.x, _a.y + span * HEADROOM_SPANS - frameH * 0.5, _a.z);
      } else {
        const box = new THREE.Box3().setFromObject(group);
        box.getCenter(this._aim);
        this._aim.y = box.max.y - CROWN_DROP;
        frameH = Math.max(box.max.y - box.min.y, 1) * 0.42;
      }

      // Distance derived from the framing rather than guessed: at this FOV the
      // vertical extent of the frame at the aim point is exactly `frameH`.
      const dist = (frameH * 0.5) / Math.tan(THREE.MathUtils.degToRad(FOV) * 0.5);
      this._camera.position.copy(this._aim).addScaledVector(DIR, dist);
      this._camera.lookAt(this._aim);
      this._camera.updateProjectionMatrix();
      this._camera.updateMatrixWorld(true);

      // Say, in numbers, where the head landed.
      //
      // Three separate framings looked plausible in the source and put the
      // head off the picture in the render, and each one cost a full capture
      // pass to find out. Projecting the head bone through the same camera is
      // two matrix multiplies and turns "the portrait looks wrong" into a
      // coordinate a harness can assert on. `headUV` is [0,1] from the top-left
      // of the frame; anything outside 0.2-0.8 is not a portrait.
      const headBone = bones?.head ?? headTop;
      let headUV = null;
      if (headBone) {
        headBone.getWorldPosition(_a).project(this._camera);
        headUV = { x: +((_a.x * 0.5 + 0.5)).toFixed(3), y: +((-_a.y * 0.5 + 0.5)).toFixed(3) };
      }
      this.frames.set(id, {
        frameH: +frameH.toFixed(3), dist: +dist.toFixed(3), rigged: !!(headTop && chest), headUV,
      });

      // Transparent background.
      //
      // This used to inherit the game's opaque clear colour and clear only
      // colour+depth, so every portrait came back a fully opaque 256x256 tile —
      // measured alpha coverage 100.0% on all ten. That silently deleted two
      // pieces of design that are still in the stylesheets: `.kbs-por`'s radial
      // wash in the machine's own accent colour, and `.portrait-chip`'s brushed
      // metal plate with its bevel highlight. Both were being painted and then
      // covered by a black square. Cutting the machine out restores them and
      // gives the chip somewhere to put a floor shadow.
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setRenderTarget(this._rt);
      this.renderer.clear(true, true, true);
      this.renderer.render(this._scene, this._camera);
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(_clear, prevClearAlpha);

      await rAsync.call(this.renderer, this._rt, 0, 0, SIZE, SIZE, this._buf);

      // WebGL reads bottom-up; flip while blitting into the 2D canvas.
      const img = this._ctx.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) {
        const src = (SIZE - 1 - y) * SIZE * 4;
        img.data.set(this._buf.subarray(src, src + SIZE * 4), y * SIZE * 4);
      }
      this._ctx.clearRect(0, 0, SIZE, SIZE);
      this._ctx.putImageData(img, 0, 0);
      // PNG, not lossy WebP. The image is now a cut-out and its whole value is
      // a clean silhouette against the tile's own backdrop; lossy compression
      // rings that alpha edge, which at a 63.5 px chip is the only edge there
      // is. Ten 256px images live in memory for the session — no network.
      const url = this._canvas.toDataURL('image/png');
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
      this.renderer.setClearColor(_clear, prevClearAlpha);
      this._busy = false;
    }
  }

  dispose() {
    this._rt?.dispose();
    this._rt = null;
    this._scene = null;
    this.cache.clear();
    this.frames.clear();
  }
}
