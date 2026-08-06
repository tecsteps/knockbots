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

const SIZE = 256;           // square portrait; the tile crops to its own aspect

/**
 * The whole roster is photographed onto ONE render target, and read back once.
 *
 * The render is not the cost and has not been for two rounds. With the
 * shader-program anchor in `MenuSystem#warmRoster` the draw is ~20 ms and
 * `compileAsync` is 0.7-1.1 ms; profiling the real warm loop on the real select
 * screen, wrapping the two renderer entry points and summing:
 *
 *     compileAsync                 7 calls    6 ms total   max   1 ms
 *     readRenderTargetPixelsAsync  6 calls  5132 ms total  max 2793 ms
 *
 * One call. The readback is 320-565 ms steady state and 2793 ms on the first,
 * against a 262 KB transfer — so it is latency, not bandwidth: a fence that
 * cannot signal until the queue ahead of it (a 1080p frame with fifteen lights
 * and a post chain, plus the select screen's own live 3D preview) has drained,
 * polled from a main thread that is itself busy. Ten of those is the entire
 * remaining fill time and no amount of scheduling removes it, because it is not
 * scheduling.
 *
 * So the portraits are rendered into tiles of one atlas as each robot passes
 * through, and a single readback lifts the whole sheet. The render stays
 * synchronous, which also means a caller may dispose its robot the moment
 * `capture` returns instead of holding it across a half-second fence.
 *
 * 4x3 at 256 px is 1024x768 — one render target, replacing the 256x256 one, so
 * the charter's eight-target budget is unchanged.
 */
const COLS = 4;
const ROWS = 3;
const ATLAS_W = COLS * SIZE;
const ATLAS_H = ROWS * SIZE;

/**
 * How long a rendered tile may sit unread before the sheet is lifted.
 *
 * The batch is only worth having if it actually batches, and it is only worth
 * batching what arrives close together: at ~60 ms a machine, 250 ms collects
 * four or five. The queue also calls `flush()` explicitly when it drains, so
 * this is the bound on a queue that stops early — not the normal path.
 */
const FLUSH_MS = 250;

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

/*
 * DISPROVED — ANVIL AND BASTION ARE NOT A LENS PROBLEM. STOP SWEEPING.
 *
 * Three of the ten tiles read as abstract hardware rather than a machine, and
 * every note above this line is a previous round moving the camera to fix it.
 * Swept properly this time, through `this.tune` so one page session covers the
 * whole grid against one set of compiled programs:
 *
 *   - **Direction.** Anvil, Bastion and Volta at azimuth {0, 20, 40, 60} x
 *     elevation {-14, -4, 6, 18, 30, 42} — 24 frames each, 72 total. Anvil has
 *     no head in ANY of the 24: its C-shaped shoulder collar closes over the
 *     head module from every angle, and looking under it at -14 degrees gets
 *     the underside of the collar rather than a face. Bastion has none either;
 *     what fills the frame at every direction is the pair of pauldrons, with a
 *     gap between them where a head would be. Volta's head is present at all 24
 *     and is largest at low elevation.
 *   - **Scale.** The full cast at bulkGain {0, 1.6, 3.2} x frameSpans
 *     {1.25, 1.4, 1.62} x elevation {2, 17.8}, judged through the tile's own
 *     `object-fit: cover` crop rather than the raw square. No combination puts a
 *     head on Anvil or Bastion. Tightening the frame makes their existing
 *     hardware bigger, which is the same picture at a larger scale.
 *
 * The frame is already aimed correctly and says so: `headUV.y` is 0.29-0.54 on
 * all ten, well inside the 0.2-0.8 band this file asserts. The camera is
 * pointed at the head bone. The head bone is behind armour.
 *
 * Confirmed against `09-roster`, which photographs the cast in the arena at
 * full size: Anvil's head is a recessed module inside its collar and Bastion's
 * sits between two plates most of its own height. Neither reads as a head at
 * full size in a lit line-up, so neither can read as one at 88x138 CSS px.
 *
 * Whatever is left here is `RobotBuilder`/`roster` work — give those two
 * chassis a head that survives a bust crop — and no constant in this file
 * reaches it. The seven machines that do have a readable head are framed
 * correctly and should not be disturbed to chase the two that do not.
 */

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
    /**
     * Called with `(id, dataUrl)` as each portrait finishes developing. The
     * pixels now exist a batch after the render that produced them, so a
     * caller cannot learn the URL from `capture`'s return value any more.
     * @type {?(id: string, url: string) => void}
     */
    this.onPortrait = null;
    /** @type {Map<string,number>} character id -> atlas slot, once rendered. */
    this._slots = new Map();
    /** Slots rendered but not yet read back. @type {Set<number>} */
    this._dirty = new Set();
    this._reading = false;
    this._drawing = false;
    this._flushTimer = 0;
    this._rt = null;
    this._scene = null;
    this._camera = null;
    this._canvas = null;
    this._buf = null;
    /**
     * Per-machine cost breakdown, in ms, in capture order.
     *
     * Kept because every round that tried to shorten this loop argued from a
     * single aggregate number ("230-755 ms per machine") that nobody could
     * attribute, and the three candidate causes — program link, texture upload,
     * readback — want completely different fixes. `{ setup, compile, draw }`
     * says which one it is.
     * @type {Array<{id: string, setup: number, compile: number, draw: number, total: number}>}
     */
    this.timings = [];
    /**
     * Framing overrides, for sweeping the lens without rebuilding the module.
     *
     * Every constant above was settled by rendering the cast through a range of
     * values and looking at the contact sheet, and each of those sweeps had to
     * edit this file and reload the game — which is why two of them only ever
     * covered two elevations. Reading the numbers off an instance field instead
     * lets one page session render the whole grid against ONE set of compiled
     * programs and ONE set of uploaded textures, so a sweep is seconds rather
     * than minutes and the arms differ by nothing but the camera.
     *
     * `null` in shipping. Nothing in the game writes it.
     * @type {?{dir?: THREE.Vector3, frameSpans?: number, headroom?: number,
     *          bulkBase?: number, bulkGain?: number, pose?: Record<string, number[]>}}
     */
    this.tune = null;
  }

  #ensure() {
    if (this._rt) return;
    this._rt = new THREE.WebGLRenderTarget(ATLAS_W, ATLAS_H, {
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
    this._buf = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  }

  /**
   * True once this machine has been PHOTOGRAPHED — which is a slice earlier
   * than when its picture is available, and deliberately so. The warm-up asks
   * this to decide whether a machine still needs work, and a machine whose
   * pixels are sitting in the atlas waiting on the batch does not.
   */
  has(id) { return this.cache.has(id) || this._slots.has(id); }
  get(id) { return this.cache.get(id) ?? null; }

  /**
   * Photograph an already-built robot. Call this while you still hold it and
   * before disposing it — the caller owns the robot's lifetime, not us.
   *
   * The picture is NOT ready when this resolves — the sheet is read back in one
   * batch (see the atlas note above) and each portrait is announced on
   * `onPortrait` when it develops. What this resolving means is that the robot
   * is free: the draw is synchronous, so the caller can dispose immediately
   * rather than holding a whole rig across a half-second fence.
   *
   * @param {string} id character id
   * @param {{ group: THREE.Object3D }} robot the result of `buildRobot`
   * @returns {Promise<boolean>} whether the machine was photographed
   */
  async capture(id, robot) {
    if (this.has(id) || !robot?.group) return this.has(id);
    if (typeof this.renderer.readRenderTargetPixelsAsync !== 'function') return false;
    if (this._slots.size >= COLS * ROWS) return false;   // sheet full
    // The readback no longer blocks this method, but `compileAsync` still
    // awaits with the robot parented into the shared portrait scene. Two
    // captures overlapping there would photograph both machines into one tile.
    // The caller serialises, so this never fires; it exists so that staying
    // true is not the caller's job.
    if (this._drawing) return false;
    this._drawing = true;

    const _t0 = performance.now();
    let _t1 = _t0, _t2 = _t0;

    this.#ensure();
    const slot = this._slots.size;

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
      const t = this.tune;
      const dir = t?.dir ?? DIR;
      const bulkBase = t?.bulkBase ?? BULK_BASE;
      const bulkGain = t?.bulkGain ?? BULK_GAIN;
      const frameSpans = t?.frameSpans ?? FRAME_SPANS;
      const headroomSpans = t?.headroom ?? HEADROOM_SPANS;
      const bulk = 1 + bulkGain * Math.max(0,
        (box.max.x - box.min.x) / Math.max(box.max.y - box.min.y, 1e-3) - bulkBase);
      let frameH;
      if (headTop && chest) {
        headTop.getWorldPosition(_a);
        chest.getWorldPosition(_b);
        const span = Math.max(_a.y - _b.y, MIN_SPAN);
        frameH = span * frameSpans * bulk;
        // The head sits in the upper band of the frame, the way a portrait
        // photographer would place it, rather than dead centre. Measured from
        // `headTop` and not from the frame, so opening the frame for a bulky
        // machine drops the extra room BELOW the head rather than around it —
        // which is where its hardware actually is.
        this._aim.set(_a.x, _a.y + span * headroomSpans - frameH * 0.5, _a.z);
      } else {
        box.getCenter(this._aim);
        this._aim.y = box.max.y - CROWN_DROP;
        frameH = Math.max(box.max.y - box.min.y, 1) * 0.42;
      }

      // Distance derived from the framing rather than guessed: at this FOV the
      // vertical extent of the frame at the aim point is exactly `frameH`.
      const dist = (frameH * 0.5) / Math.tan(THREE.MathUtils.degToRad(FOV) * 0.5);
      this._camera.position.copy(this._aim).addScaledVector(dir, dist);
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
      _t1 = performance.now();
      if (typeof this.renderer.compileAsync === 'function') {
        await this.renderer.compileAsync(this._scene, this._camera).catch(() => {});
      }
      _t2 = performance.now();

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
      //
      // Scissored to this machine's tile so the nine already on the sheet
      // survive the clear. Both are needed: the viewport places the projection
      // inside the tile, the scissor keeps the clear inside it.
      //
      // Set on the RENDER TARGET, not with `renderer.setViewport`. The renderer
      // methods are in CSS pixels and multiply by `pixelRatio` on the way to
      // GL; the target's own `viewport`/`scissor` are copied through verbatim by
      // `setRenderTarget`. The quality tiers run `renderScale` at 0.85 and 0.7,
      // so the renderer path put every portrait into a 218x218 box at 85% of
      // the tile's offset — the whole sheet came back with each machine shoved
      // down-left and cropped, and it looked like a framing bug rather than a
      // unit bug. Using the target's fields also means the previous viewport
      // comes back on its own when `prevTarget` is restored.
      const { x, y } = this.#rect(slot);
      this._rt.viewport.set(x, y, SIZE, SIZE);
      this._rt.scissor.set(x, y, SIZE, SIZE);
      this._rt.scissorTest = true;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.setRenderTarget(this._rt);
      this.renderer.clear(true, true, true);
      this.renderer.render(this._scene, this._camera);
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(_clear, prevClearAlpha);

      const _t3 = performance.now();
      this.timings.push({
        id,
        setup: +(_t1 - _t0).toFixed(1),
        compile: +(_t2 - _t1).toFixed(1),
        draw: +(_t3 - _t2).toFixed(1),
        total: +(_t3 - _t0).toFixed(1),
      });

      this._slots.set(id, slot);
      this._dirty.add(slot);
      if (!this._flushTimer) this._flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
      return true;
    } catch {
      return false;
    } finally {
      // Always hand the robot back exactly as we found it, or the caller's
      // dispose() runs against a group we have reparented.
      if (posed) for (const r of posed) r.bone.rotation.set(r.x, r.y, r.z);
      if (prevParent) prevParent.add(group);
      else this._scene.remove(group);
      // The readback wants the whole sheet, so the tile scissor must not
      // outlive the draw that needed it.
      if (this._rt) {
        this._rt.scissorTest = false;
        this._rt.viewport.set(0, 0, ATLAS_W, ATLAS_H);
        this._rt.scissor.set(0, 0, ATLAS_W, ATLAS_H);
      }
      this.renderer.setRenderTarget(prevTarget);
      this.renderer.setClearColor(_clear, prevClearAlpha);
      this._drawing = false;
    }
  }

  /** Bottom-left origin of a slot's tile, in atlas pixels. WebGL is Y-up. */
  #rect(slot) {
    return { x: (slot % COLS) * SIZE, y: ATLAS_H - SIZE - Math.floor(slot / COLS) * SIZE };
  }

  /**
   * Lift the sheet: one readback for every tile drawn since the last one.
   *
   * Safe to call at any time and from anywhere — it is a no-op with nothing
   * pending, and if a readback is already in flight it lets that one finish and
   * re-arms, because the tiles it has not covered are still marked dirty.
   *
   * @returns {Promise<number>} how many portraits developed
   */
  async flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = 0; }
    if (this._reading || !this._dirty.size || !this._rt) return 0;
    const rAsync = this.renderer.readRenderTargetPixelsAsync;
    if (typeof rAsync !== 'function') return 0;

    this._reading = true;
    const taking = [...this._dirty];
    this._dirty.clear();
    let developed = 0;
    try {
      // The whole sheet in one call. Reading only the rows that are dirty was
      // tried in the arithmetic and is not worth the bookkeeping: this is a
      // latency cost, not a bandwidth one (262 KB took 320-565 ms), so the
      // number that matters is one rather than ten.
      await rAsync.call(this.renderer, this._rt, 0, 0, ATLAS_W, ATLAS_H, this._buf);
      const bySlot = new Map();
      for (const [id, slot] of this._slots) bySlot.set(slot, id);
      for (const slot of taking) {
        const id = bySlot.get(slot);
        if (!id || this.cache.has(id)) continue;
        const url = this.#develop(slot);
        if (!url) continue;
        this.cache.set(id, url);
        developed++;
        try { this.onPortrait?.(id, url); } catch { /* a listener never breaks the sheet */ }
      }
    } catch {
      // Put them back so the next flush retries rather than losing the tile.
      for (const s of taking) this._dirty.add(s);
    } finally {
      this._reading = false;
      if (this._dirty.size && !this._flushTimer) {
        this._flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
      }
    }
    return developed;
  }

  /** Cut one tile out of the read-back sheet and encode it. */
  #develop(slot) {
    const { x, y } = this.#rect(slot);
    // WebGL reads bottom-up; flip while blitting into the 2D canvas.
    const img = this._ctx.createImageData(SIZE, SIZE);
    for (let row = 0; row < SIZE; row++) {
      const src = ((y + SIZE - 1 - row) * ATLAS_W + x) * 4;
      img.data.set(this._buf.subarray(src, src + SIZE * 4), row * SIZE * 4);
    }
    this._ctx.clearRect(0, 0, SIZE, SIZE);
    this._ctx.putImageData(img, 0, 0);
    // LOSSLESS, and lossless is the whole requirement — not the container.
      //
      // The rule this line used to state was "PNG, not lossy WebP", and it is
      // right about the lossy half: the image is a cut-out whose entire value
      // is a clean silhouette against the tile's own backdrop, and a lossy
      // codec rings that alpha edge, which at a 63.5 px chip is the only edge
      // there is. But `toDataURL('image/webp', 1)` is Chromium's LOSSLESS webp
      // path, not its quality-100 lossy one, and it is a straight win here.
      //
      // Round-tripped through an `Image` and re-read with `getImageData`, on a
      // 256px noise field cut out by a hard-edged circular alpha mask — the
      // worst case a codec can be handed:
      //
      //     image/png            6802 B   max channel error 0   channels wrong 0
      //     image/webp q=1      13327 B   max channel error 0   channels wrong 0
      //     image/webp q=0.92   10763 B   max channel error 176 channels wrong 69472
      //
      // Bit-exact, and q=0.92 is shown to prove the test can tell the
      // difference. The reason to move is the encoder cost, which is paid on
      // the main thread once per machine while the player is looking at the
      // grid: 26.7 ms for PNG against 1.1 ms for lossless webp, averaged over
      // ten encodes. That is 255 ms of the roster's fill time, for nothing.
      // The extra 6.5 KB never touches the network — these live in memory for
      // the session.
      //
      // `toDataURL` returns a `data:image/png` URL when it does not know the
      // type, so the fallback is a string check rather than a feature test.
    let url = this._canvas.toDataURL('image/webp', 1);
    if (!url.startsWith('data:image/webp')) url = this._canvas.toDataURL('image/png');
    return url;
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
    for (const [name, [rx, ry, rz]] of Object.entries(this.tune?.pose ?? POSE)) {
      const bone = bones[name];
      if (!bone?.rotation) continue;
      const { x, y, z } = bone.rotation;
      restored.push({ bone, x, y, z });
      bone.rotation.set(x + rx * D, y + ry * D, z + rz * D);
    }
    return restored.length ? restored : null;
  }

  dispose() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = 0; }
    this._rt?.dispose();
    this._rt = null;
    this._scene = null;
    this.onPortrait = null;
    this.cache.clear();
    this.frames.clear();
    this._slots.clear();
    this._dirty.clear();
  }
}
