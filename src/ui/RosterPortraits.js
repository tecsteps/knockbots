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
const _box = new THREE.Box3();

const SIZE = 256;           // square target; the tile crops to its own aspect

/**
 * A portrait lens, not a scene lens.
 *
 * This was 30 degrees, and because the distance is derived from the framing,
 * a wide angle also means a CLOSE camera: at 30 degrees the lens sat 1.11-1.27 m
 * from the head on the whole cast. Photographed at that range a machine's near
 * shoulder is roughly half as far from the lens as its far one, so it projects
 * about twice the size, and every capture came back as a wall of near-side
 * pauldron with the head peering out from behind it. The three the previous
 * round could not fix — Anvil, Bastion, Volta — were the three with the largest
 * pauldrons and the one with a tower shield, which is exactly the population a
 * perspective error of that shape would select.
 *
 * 20 degrees puts the same frame at 1.7-2.0 m, which is a short telephoto on a
 * head-and-shoulders subject and the reason portrait lenses are long: it
 * compresses the near-far ratio to about 1.2 and the shoulders stop competing
 * with the face for area.
 */
const FOV = 20;

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
 * Also measured. At 1.75 spans (~0.83 m) with the old 30-degree lens the frame
 * was filled by shoulder: the cast's shoulder-to-shoulder width is 0.89-1.45 m
 * against a head roughly 0.30 m across, so a frame wide enough to hold the
 * shoulders made the head a fifth of the picture. 1.30 spans fixed that and
 * introduced the opposite fault — on a contact sheet of all ten, every crest,
 * antenna and helmet crown was clipped by the top edge (Vulkan, Kestrel,
 * Ronin, Seraph and Nyx all lost the top of the head), because the headroom
 * budget is measured from the `headTop` BONE and the geometry hung above it is
 * not in the skeleton.
 *
 * 1.62 spans on the 20-degree lens is the setting that holds both: the long
 * lens keeps the shoulders from filling it and the extra height clears the
 * crown hardware. Note the tile crops this square to 3:4 and throws away 12.5%
 * of each side, so surplus WIDTH is free and only the height is being spent.
 */
const FRAME_SPANS = 1.62;

/** Headroom above `headTop`, as a multiple of that same span. Armour, crests
 *  and antennae live above the bone, so this is deliberately generous — it is
 *  the term that was too small when the contact sheet came back with five
 *  clipped crowns. */
const HEADROOM_SPANS = 0.46;

/**
 * Bulk correction: how much wider the frame gets on a squat machine.
 *
 * The head-and-neck span does not predict how much frame a machine needs,
 * because on some builds the head is not the thing you have to fit — the
 * hardware wrapped around it is. Rendered at 1x, 1.8x, 3.2x and 5x the
 * span-derived frame, the three that failed all failed the same way: Anvil's
 * head sits inside a C-shaped shoulder collar that arcs OVER it, Volta's inside
 * a horizontal coil disc at shoulder height, and Bastion's behind a slab that
 * is most of its upper body. At 1x you photograph the hardware; at 1.8x you
 * photograph a machine with a head in it.
 *
 * The measurable that separates them is squatness — bounding-box width over
 * height — not the shoulder multiplier and not width alone:
 *
 *     anvil 0.665  bastion 0.648  ronin 0.522  volta 0.485  kestrel 0.478
 *     seraph 0.393  axiom 0.393   nyx 0.377    vulkan 0.346  mantis 0.333
 *
 * The two that need the most correction are the top two by a clear margin, and
 * the seven that already frame correctly sit at or below 0.52. So the frame is
 * scaled by how far past `BULK_BASE` a machine is, which leaves the slim half of
 * the cast untouched (their term clamps to zero) and opens Anvil and Bastion by
 * about 1.75x. It is a continuous rule off measured geometry, not a table of
 * character names, so a new machine is framed without being special-cased.
 *
 * The box is `Box3.setFromObject`, which for a skinned mesh is the BIND pose
 * transformed by the world matrix — the pose applied below does not move it.
 * That is wanted here: this is a measure of how the machine is BUILT, and it
 * must not change with what the rig happens to be doing.
 */
const BULK_BASE = 0.42;
const BULK_GAIN = 3.2;

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
  // Elevation, 17 degrees, and it is the term that was wrong.
  //
  // 26 degrees was tried on the old 30-degree lens and measured worse on the
  // whole cast, so it went back to 8.6 — which is a camera at chest height on a
  // machine whose head is a small part of its mass, and on the three brutes it
  // photographed the chest. A seven-azimuth by two-elevation sweep of Anvil,
  // Bastion and Volta (rendered through this exact framing) settles it: across
  // the whole azimuth range from -55 to +55 degrees NOTHING changes at 4
  // degrees elevation — all seven frames are chest — while at 16 degrees Anvil
  // and Volta both show a complete head with clearance above it. Azimuth was
  // never the variable; the sweep is what proves it rather than asserting it.
  const v = new THREE.Vector3(0.33, 0.305, 0.90);
  return v.normalize();
})();

const D = Math.PI / 180;

/**
 * The portrait pose, in degrees added to each bone's REST rotation.
 *
 * The rest pose is a relaxed A-pose built for animation, not for a photograph:
 * `Skeleton.js` sets `shoulder_*` 50 degrees out from vertical, and
 * `RobotBuilder` hangs the pauldron off `clavicle_*` and the forearm armour off
 * `elbow_*`. On a wide chassis that puts a plate between the lens and the face
 * — Anvil, Bastion and Volta all came back as a wall of armour with the head
 * bone projecting to dead centre behind it.
 *
 * So the machine is posed the way a subject is posed for a portrait: shoulders
 * dropped and rolled back, arms brought in toward the body and swept behind the
 * torso plane, forearms hanging. That is four bones per side and it clears the
 * face on every chassis without touching the camera, which the other seven
 * machines were already framed correctly by.
 *
 * Signs, because they are not guessable from the numbers and one of them was
 * wrong for a whole revision. +X is the machine's left and +Z is its front
 * (`FRONT` in RobotBuilder). A rotation about +Z carries +X toward +Y, so a
 * NEGATIVE z drops the left shoulder and a POSITIVE z drops the right one, and
 * a POSITIVE z on `shoulder_L` rotates its 50-degree splay back toward
 * vertical. A rotation about +X carries +Y toward +Z — and the arm bones point
 * along -Y, so a POSITIVE x sweeps a limb BACKWARD and a negative one swings it
 * forward across the chest. The first version of this table had -26 on both
 * shoulders, which is the opposite of what its own comment claimed and threw
 * Bastion's shield across the frame it was written to clear.
 *
 * Applied additively and restored in `capture`'s `finally`, so a caller that
 * reuses the robot afterwards gets it back untouched.
 */
const POSE = {
  // Pauldrons down and rolled back, off the head's sight line. Anvil's is
  // 1.24x the cast's base width and three lames deep, and it is the single
  // largest occluder in the roster.
  clavicle_L: [-6, 0, -20],
  clavicle_R: [-6, 0, 20],
  // Upper arms in from the 50-degree rest splay to about 16 degrees off
  // vertical, and swept BEHIND the chest plane. Everything below the shoulder
  // is outside a head-and-shoulders frame, so there is no cost to dropping the
  // arms and a large benefit: `markTowerShield` hangs Bastion's shield off
  // `elbow_L` at 1.34x the whole arm's length, which keeps its top edge at head
  // height for as long as the arm is held out in front.
  shoulder_L: [26, 0, 34],
  shoulder_R: [26, 0, -34],
  // Forearms hanging back, which carries that shield down and behind the hip.
  elbow_L: [26, 0, 6],
  elbow_R: [26, 0, -6],
  // A touch of chin, so the visor faces the lens rather than the floor.
  head: [-5, 0, 0],
};

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
    /** @type {?Array<{bone: THREE.Object3D, x: number, y: number, z: number}>} */
    let posed = null;

    try {
      this._scene.add(group);
      posed = this.#pose(robot);
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
      const box = _box.setFromObject(group);
      const bulk = 1 + BULK_GAIN * Math.max(0,
        (box.max.x - box.min.x) / Math.max(box.max.y - box.min.y, 1e-3) - BULK_BASE);
      let frameH;
      if (headTop && chest) {
        headTop.getWorldPosition(_a);
        chest.getWorldPosition(_b);
        const span = Math.max(_a.y - _b.y, MIN_SPAN);
        frameH = span * FRAME_SPANS * bulk;
        // The head sits in the upper band of the frame, the way a portrait
        // photographer would place it, rather than dead centre. Measured from
        // `headTop` and not from the frame, so opening the frame for a bulky
        // machine drops the extra room BELOW the head rather than around it —
        // which is where its hardware actually is.
        this._aim.set(_a.x, _a.y + span * HEADROOM_SPANS - frameH * 0.5, _a.z);
      } else {
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
        frameH: +frameH.toFixed(3), dist: +dist.toFixed(3), bulk: +bulk.toFixed(2),
        rigged: !!(headTop && chest), headUV,
      });

      // Compile this machine's programs BEFORE drawing with them.
      //
      // This is the whole stall, and it was not the readback. Measured per
      // capture on a fresh boot, timing the synchronous span of this method
      // against the awaited one: sync 155-608 ms, total 230-755 ms. The
      // synchronous part is `renderer.render` below and nothing else of size —
      // a freshly built robot brings ~8 new materials and their procedural map
      // set, and the first draw with them pays `compileShader` + `linkProgram`
      // + the texture uploads on the main thread. Worst whole frame across the
      // sequence was 785 ms with 22 frames over 100 ms.
      //
      // `compileAsync` issues the same work and then resolves off
      // `KHR_parallel_shader_compile`, so the driver compiles on its own
      // threads and the main thread only picks the results up. It is awaited
      // here rather than fired and forgotten because the point is that
      // `render` finds every program already linked.
      //
      // Guarded: `compileAsync` is r152+, and a context without the parallel
      // extension resolves it by polling instead, which is slower but never
      // wrong. If it is missing entirely we simply draw and pay what we paid
      // before — a portrait is still not allowed to be a hard dependency.
      if (typeof this.renderer.compileAsync === 'function') {
        await this.renderer.compileAsync(this._scene, this._camera).catch(() => {});
      }

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
      if (posed) for (const r of posed) r.bone.rotation.set(r.x, r.y, r.z);
      if (prevParent) prevParent.add(group);
      else this._scene.remove(group);
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(_clear, prevClearAlpha);
      this._busy = false;
    }
  }

  /**
   * Applies `POSE` to the rig and returns what to put back.
   *
   * Nothing here forces a skinning update: `WebGLRenderer` calls
   * `Skeleton#update` itself once per skinned mesh per render, so moving the
   * bones and then rendering is enough. The armour plates are rigid single-bone
   * binds (see the charter's RobotBuilder entry), so they travel with the joint
   * exactly and there is no soft deformation to go wrong at a 28-degree swing.
   *
   * @param {{ parts?: { byName?: Record<string, THREE.Object3D> } }} robot
   * @returns {?Array<{bone: THREE.Object3D, x: number, y: number, z: number}>}
   */
  #pose(robot) {
    const bones = robot?.parts?.byName;
    if (!bones) return null;
    const restored = [];
    for (const [name, [rx, ry, rz]] of Object.entries(POSE)) {
      const bone = bones[name];
      if (!bone?.rotation) continue;
      const { x, y, z } = bone.rotation;
      restored.push({ bone, x, y, z });
      bone.rotation.set(x + rx * D, y + ry * D, z + rz * D);
    }
    return restored.length ? restored : null;
  }

  dispose() {
    this._rt?.dispose();
    this._rt = null;
    this._scene = null;
    this.cache.clear();
    this.frames.clear();
  }
}
