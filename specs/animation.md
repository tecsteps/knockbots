# The Three.js Character Animation Cookbook

## TL;DR
- Three.js ships a complete animation mixing desk (AnimationMixer, AnimationClip, AnimationAction) plus example addons (CCDIKSolver, SkeletonUtils, VAT) that cover most character-animation needs; quality problems are almost always in the workflow (Mixamo/Blender export, retargeting, foot sliding, delta-time handling) rather than missing features.
- The highest-leverage upgrades for perceived quality are: additive/layered blending for aim and breathing, matching playback speed to actual velocity to kill foot sliding, foot IK for terrain, secondary spring-bone motion, and frame-rate-independent (delta-time correct) updates with camera damping.
- For scale, use animation LOD (skip or throttle mixer updates for distant/off-screen characters) and, for crowds, vertex animation textures (VAT) or WebGPU instanced skinning; blended per-bone skeletal animation does not scale to hundreds of characters.

## Key Findings
- The core API (AnimationMixer + clipAction + crossFadeTo/fadeIn/fadeOut + setEffectiveWeight/setEffectiveTimeScale) has been stable since the r73/r74 rewrite. Additive blending (AnimationUtils.makeClipAdditive + AdditiveAnimationBlendMode) and subclip are the tools for layered aim/lean/breathing.
- Mixamo is the fastest path to a rigged, animated character, but its rigs use non-standard bone names (mixamorig...), animations bake motion into the hips (no root-motion bone), and glTF is not a direct export, so a Blender round-trip is standard. Retargeting between different proportions with SkeletonUtils.retarget/retargetClip is fragile and has known bugs.
- Foot sliding has two independent causes: playback speed not matching ground velocity, and blends/retargets that desync gait phase. Fixes: drive timeScale from measured velocity, phase-align clips before blending, and apply foot IK.
- IK options: CCDIKSolver (built into examples, iterative CCD), three-ik (FABRIK, unmaintained), and hand-rolled two-bone analytic IK (best for legs/arms). Foot IK plus look-at head aim plus spring bones are the three procedural layers that most improve realism.
- Performance ceiling for classic skinned meshes is low. VAT and WebGPU compute/instanced skinning are the crowd techniques; morph targets and bone counts both cost.

## Details

Everything below assumes a recent Three.js (r150+). Where an API is version-sensitive it is flagged. Import paths use the `three/addons/` convention (r148+); older code uses `three/examples/jsm/`.

---

## Section 1: Skeletal Animation Fundamentals

### Recipe 1.1: Load a rigged glTF and play a clip
**Problem:** You have a GLB with animations and want it moving.
**Approach:** GLTFLoader returns `gltf.scene` and `gltf.animations`. Create one AnimationMixer per character, get an action per clip, call `mixer.update(delta)` every frame.

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const clock = new THREE.Clock();
let mixer, actions = {};

new GLTFLoader().load('character.glb', (gltf) => {
  const model = gltf.scene;
  scene.add(model);
  mixer = new THREE.AnimationMixer(model);
  for (const clip of gltf.animations) {
    actions[clip.name] = mixer.clipAction(clip);
  }
  actions['Idle'].play();
});

function animate() {
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);   // REQUIRED every frame
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);
```

**Gotchas:** One mixer per independently animated character. `mixer.update()` moves the global mixer time; skipping it freezes animation. Use `renderer.setAnimationLoop` rather than a bare `requestAnimationFrame` so XR works.
**Performance:** Each `mixer.update()` has a cost proportional to active tracks. Share one AnimationClip across many mixers (clips are stateless data; actions hold state).

### Recipe 1.2: Understand the object model
**Problem:** You need to know what to reach for.
**Approach:**
- `AnimationClip`: reusable keyframe data (a named set of KeyframeTracks). Stateless.
- `KeyframeTrack` subtypes: `VectorKeyframeTrack` (position/scale), `QuaternionKeyframeTrack` (rotation, spherically interpolated), `NumberKeyframeTrack` (morph influences, material props), `ColorKeyframeTrack`, `BooleanKeyframeTrack`, `StringKeyframeTrack`.
- `AnimationMixer`: the player, bound to one root Object3D.
- `AnimationAction`: the stateful controller (play/pause/weight/timeScale/loop/fade).
- `SkinnedMesh` + `Skeleton` + `Bone`: the deformable geometry, the ordered bone array, and the transform nodes.

**Gotcha:** Rotation tracks must be quaternion tracks to interpolate correctly; Euler tracks gimbal-flip. glTF always exports quaternions.

### Recipe 1.3: Clean up clips
**Problem:** Exported clips have redundant keyframes or wrong duration.
**Approach:** `clip.optimize()` removes redundant keyframes; `clip.resetDuration()` recomputes duration from tracks; `THREE.AnimationClip.findByName(clips, 'Walk')` locates by name.
**Tradeoff:** `optimize()` can slightly change curves; call it once at load, not per frame.

---

## Section 2: Blending and Transitions

### Recipe 2.1: Crossfade between states
**Problem:** Snapping from idle to walk looks robotic.
**Approach:** Play both actions, then crossfade. `crossFadeTo(target, duration, warp)` fades this action out and the target in over `duration` seconds.

```js
function fadeToAction(name, duration = 0.3) {
  const next = actions[name];
  if (next === current) return;
  next.reset().setEffectiveWeight(1).play();
  current.crossFadeTo(next, duration, false);
  current = next;
}
```

**Gotcha (important):** A common bug is that `crossFadeTo` appears to fade to a T-pose. That happens when the target action was never `play()`-ed or its weight is zero. Always `reset().play()` the incoming action first. This is a frequently reported issue on the Three.js forum (see discourse thread 63467, "AnimationAction.crossFadeTo not working?").
**Warp:** the third parameter time-warps the two clips so their playback speeds converge during the fade. Use `true` for walk/run where durations differ, `false` for same-length clips.

### Recipe 2.2: Manual weighted blend (blend space)
**Problem:** You want a continuous idle to walk to run blend driven by speed, not discrete states.
**Approach:** Keep all three actions playing and set weights from a normalized speed parameter. This is a 1D blend space.

```js
function setLocomotionBlend(speed) { // speed 0..1
  const idleW = Math.max(0, 1 - speed * 2);
  const walkW = 1 - Math.abs(speed - 0.5) * 2;
  const runW  = Math.max(0, speed * 2 - 1);
  idleAction.setEffectiveWeight(Math.max(0, idleW));
  walkAction.setEffectiveWeight(Math.max(0, walkW));
  runAction.setEffectiveWeight(Math.max(0, runW));
}
```

**Gotcha:** The official `webgl_animation_skinning_blending` example notes crossfades are just weights of (1,0,0),(0,1,0),(0,0,1); a blend space is the continuous generalization. Weights should sum to 1 for predictable results.
**2D blend space:** for directional strafing (forward/back x left/right), bilinearly interpolate weights across four or eight directional clips using a 2D input vector.

### Recipe 2.3: Additive blending for aim, lean, and breathing
**Problem:** You want to layer a "look up" or "breathing" pose on top of any locomotion clip without authoring a combinatorial explosion of clips.
**Approach:** Convert a clip to additive with `AnimationUtils.makeClipAdditive(clip)`, set the action's `blendMode` to `THREE.AdditiveAnimationBlendMode`, and play it alongside the base. Additive actions add their delta-from-reference-pose on top of the base pose.

```js
THREE.AnimationUtils.makeClipAdditive(aimClip); // in place, uses frame 0 as reference
const aim = mixer.clipAction(aimClip);
aim.blendMode = THREE.AdditiveAnimationBlendMode;
aim.setEffectiveWeight(1).play();
// subclip a single pose frame from a longer clip:
const posePart = THREE.AnimationUtils.subclip(clip, clip.name, 2, 3, 30);
```

**Gotchas:** Base and additive clips should share the same skeleton. The official `webgl_animation_skinning_additive_blending` example is the reference (it calls `makeClipAdditive(clip)` and, for `_pose`-suffixed clips, `subclip(clip, clip.name, 2, 3, 30)`). Additive requires the reference frame (frame 0) to be a neutral pose; a bad reference frame produces drift.
**When to use:** aim offsets, weapon sway, breathing, damage flinches, head turns. Cheap and very high value.

### Recipe 2.4: Synchronize gait phase before blending
**Problem:** Blending walk and run makes feet stutter because the two clips are at different points in their stride.
**Approach:** Phase-align. Both clips represent one full gait cycle. Scale each clip's time so a chosen event (left foot strike) lines up, and set the effective time scale so the blended playback stays in phase. Conceptually: pick per-clip phase offsets `o_walk`, `o_run` (the normalized time each clip's left foot hits the ground), and drive both actions from a shared normalized phase `t` so `action.time = (t + offset) * clip.duration`. This mirrors the established game-dev rule that if a foot touches the floor at 50 percent time in the run sequence, it must also touch at 50 percent time in the walk sequence for a clean blend.
**Tradeoff:** Requires knowing the foot-strike times per clip (author them or detect them). Without phase sync, `crossFadeTo(..., true)` warping helps but does not fully fix stutter.

### Recipe 2.5: fadeIn / fadeOut / halt
**Problem:** Start or stop a one-shot (jump, attack) cleanly.
**Approach:** `action.reset().setLoop(THREE.LoopOnce).fadeIn(0.2).play(); action.clampWhenFinished = true;` Listen for the mixer `'finished'` event to return to locomotion. `action.halt(duration)` gradually slows an action to a stop by ramping its time scale.

```js
mixer.addEventListener('finished', (e) => {
  if (e.action === attackAction) fadeToAction('Idle', 0.2);
});
```

---

## Section 3: Locomotion Realism

### Recipe 3.1: Root motion vs in-place
**Problem:** Should the animation move the character, or should code?
**Approach:** Two philosophies.
- **In-place:** the clip walks in place (no hip translation), code translates the Object3D. Simplest, easy to steer, most Three.js controllers do this. Foot sliding is your responsibility.
- **Root motion:** the animation includes forward translation on a root bone; you read that per-frame displacement and apply it to the character, then subtract it from the bone so the mesh does not drift. This gives authored, precise foot placement (great for attacks, turns) but is harder to steer.

Mixamo does NOT export a separate root-motion bone; the translation is baked into the hips (confirmed in Three.js forum thread 5116, "Looping skinned mesh animation with root motion"). To get root motion you must either use the "In Place" export option and translate in code, or add a root bone in Blender and re-export.

**Extract root motion (sketch):**
```js
// track the hip/root bone world position each frame,
// apply the per-frame delta to the character container,
// and zero out the horizontal component on the bone.
const hip = model.getObjectByName('mixamorigHips');
const prev = new THREE.Vector3();
function applyRootMotion() {
  const cur = new THREE.Vector3();
  hip.getWorldPosition(cur);
  const delta = cur.clone().sub(prev);
  characterContainer.position.x += delta.x;
  characterContainer.position.z += delta.z;
  hip.position.x = 0; hip.position.z = 0; // keep mesh centered
  prev.copy(cur);
}
```

### Recipe 3.2: Match playback speed to velocity (kill foot sliding)
**Problem:** Feet slide because animation stride speed does not equal ground speed.
**Approach:** The animation was authored for a nominal speed (say the walk clip covers 1.5 m/s). Set `action.setEffectiveTimeScale(actualSpeed / nominalSpeed)` so the stride matches the real velocity. This is the same idea as Unity's community "AnimationSpeedController" pattern: compute the factor of real speed over nominal authored speed each frame and feed it to the animator.

```js
const NOMINAL_WALK = 1.5; // m/s the clip was authored at
walkAction.setEffectiveTimeScale(THREE.MathUtils.clamp(currentSpeed / NOMINAL_WALK, 0.5, 1.8));
```

**Gotcha:** Clamp the ratio; extreme time scales look wrong. Beyond the clamp range, switch to a faster clip (walk to run) rather than overspeeding. This velocity-to-timeScale coupling is the single most effective foot-slide fix for in-place animation.
**Tradeoff:** Very slow speeds need a separate slow clip; do not just scale a walk to a crawl.

### Recipe 3.3: Acceleration, deceleration, and input smoothing
**Problem:** Instant velocity changes look twitchy.
**Approach:** Smooth the input/velocity, not just the animation. A common pattern damps velocity toward a target:

```js
// frame-rate-independent smoothing:
const t = 1 - Math.exp(-accelRate * delta);
velocity += (targetVelocity - velocity) * t;
```

Do NOT use a fixed lerp factor like `velocity += (target - velocity) * 0.3` (as seen in several popular third-person controller tutorials) because it is frame-rate dependent (see Recipe 5.1). Drive both the blend weight and the timeScale from the smoothed velocity.

### Recipe 3.4: Turn-in-place and stop transitions
**Problem:** Character pivots by sliding or pops when stopping.
**Approach:** Add dedicated turn-in-place clips triggered when heading error exceeds a threshold while speed is near zero. For stops, use a short "walk-to-stop" or "run-to-stop" plant clip rather than crossfading straight to idle; this is where authored root motion shines. A state machine formalizes this.

### Recipe 3.5: A minimal locomotion state machine
**Problem:** Ad hoc `if` chains for animation states become unmaintainable.
**Approach:** A tiny finite state machine with per-state enter/update/exit that owns the crossfades.

```js
class AnimStateMachine {
  constructor(actions) { this.actions = actions; this.state = null; }
  set(name, fade = 0.25) {
    if (this.state === name) return;
    const next = this.actions[name];
    next.reset().play();
    if (this.state) this.actions[this.state].crossFadeTo(next, fade, name === 'run' || name === 'walk');
    this.state = name;
  }
}
```

Decide transitions from smoothed speed and grounded/jumping flags each frame. For AAA-grade results this is where motion matching (Section 7) replaces the hand-built graph.

---

## Section 4: Procedural and Physics-Assisted Layers

### Recipe 4.1: Foot IK on uneven terrain with CCDIKSolver
**Problem:** Feet float above or sink into sloped ground and stairs.
**Approach:** Three.js ships `CCDIKSolver` in `three/addons/animation/CCDIKSolver.js`. It solves an IK chain toward a target bone using the Cyclic Coordinate Descent algorithm. It was originally written for MMDLoader but works with any SkinnedMesh; the official docs now contain a generic example that grew out of forum thread 9571 ("Example of how to use CCDIkSolver with a generic SkinnedMesh?") and GitHub issue #17452, merged via PR #23449.

**Key configuration:** The constructor is `new CCDIKSolver(mesh, iks)` where each entry of the `iks` array uses INTEGER INDICES into `mesh.skeleton.bones`, not bone objects. The properties are:
- `target`: index of the target bone (the goal the chain reaches for)
- `effector`: index of the end bone (the foot)
- `links`: array of `{ index, rotationMin, rotationMax, limitation, enabled }` for the intermediate bones, listed from effector-adjacent outward toward the root
- optional `iteration` (default 1; higher is more precise, slower), `minAngle`, `maxAngle`, and `blendFactor`

Generic rigs have no IK target bone, so you create one, add it to the hierarchy, and push it into the bones array so it gets an index (this is exactly the pattern in the official docs code example):

```js
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';

// create a target bone at the foot goal and register it:
const targetBone = new THREE.Bone();
skeleton.bones[0].add(targetBone);
skeleton.bones.push(targetBone);           // now has an index
const targetIdx = skeleton.bones.length - 1;

const footIdx  = boneIndex('mixamorigLeftFoot');
const shinIdx  = boneIndex('mixamorigLeftLeg');
const thighIdx = boneIndex('mixamorigLeftUpLeg');

const iks = [{
  target: targetIdx,
  effector: footIdx,
  links: [ { index: shinIdx }, { index: thighIdx } ],
  iteration: 10,
  blendFactor: 1
}];
const ikSolver = new CCDIKSolver(mesh, iks);

function animate() {
  mixer.update(delta);
  // raycast down from each foot to find ground, set targetBone.position
  ikSolver.update();      // MUST run AFTER mixer.update
  renderer.render(scene, camera);
}
```

**Gotchas:** Call `ikSolver.update()` after `mixer.update()`; the mixer sets the base pose, then IK overrides the chain. Use `CCDIKHelper` to visualize. Constrain the knee with `rotationMin`/`rotationMax` (Vector3 Euler limits) and `limitation` (a rotation axis) so it does not hyperextend. Note the official docs type table mislabels `maxAngle` as "Minimum rotation angle"; it is the maximum step angle.
**blendFactor (recent, added by contributor anishwij in PR #30406, early 2025):** `update(globalBlendFactor = 1.0)` and `updateOne(ik, overrideBlend = 1.0)` let you blend the IK-solved pose against the animated pose; a per-chain `ik.blendFactor` takes precedence over the value passed to `update()`, and the default of 1.0 maintains backward compatibility. Use this to fade foot IK in only when grounded. On older versions there is no blendFactor and IK is always full strength.

### Recipe 4.2: Two-bone analytic IK (legs and arms)
**Problem:** CCD is iterative and can wobble; a leg or arm is exactly two bones, which has a closed-form solution.
**Approach:** Two-bone IK uses the law of cosines to solve the knee/elbow angle directly, then aims the whole limb at the target and rotates it around the limb axis by a pole vector. It is faster and more stable than CCD for 2-bone chains. This is what most game engines use for feet. There is no built-in two-bone solver in Three.js core, so either hand-roll it or use CCDIKSolver with a 2-link chain and `iteration` raised.
**Tradeoff:** Hand-rolled two-bone IK needs careful handling of the pole vector (knee direction) and bone roll; budget time for debugging axis alignment.

### Recipe 4.3: three-ik (FABRIK) and other libraries
**Problem:** You want multi-chain FABRIK with constraints.
**Approach:** `three-ik` (jsantell) provides a FABRIK solver with IKChain, IKJoint, and IKBallConstraint. FABRIK works in two passes (forward then backward reaching) and handles longer chains (spines, tails) well.

```js
import { IK, IKChain, IKJoint, IKBallConstraint } from 'three-ik';
const ik = new IK();
const chain = new IKChain();
bones.forEach((bone, i) =>
  chain.add(new IKJoint(bone, { constraints: [new IKBallConstraint(90)] }),
            { target: i === bones.length - 1 ? movingTarget : null }));
ik.add(chain);
function animate(){ ik.solve(); }
```

**Gotcha:** `three-ik` is explicitly described by its own README as a work in progress with open issues on axis alignment, new constraints, and API changes, and it is effectively unmaintained. Vet it before shipping. For 2-bone limbs prefer analytic IK; for MMD-style rigs prefer CCDIKSolver. `ikts` (a dependency-free FABRIK port) is an alternative that does not depend on Three.js.

### Recipe 4.4: Look-at head and eye tracking
**Problem:** Character should track a point of interest with head and eyes.
**Approach:** After `mixer.update()`, additively rotate the head (and eye) bones toward the target, clamped to a believable cone, and damped over time. Because you write bone rotations after the mixer, you are layering procedural motion on the animated pose.

```js
function aimHead(headBone, targetWorld, delta) {
  const local = headBone.parent.worldToLocal(targetWorld.clone());
  const desired = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0,0,1), local.normalize());
  // clamp desired to a cone here, then damp:
  const t = 1 - Math.exp(-10 * delta);
  headBone.quaternion.slerp(desired, t);
}
```

**Gotcha:** Clamp before you damp, or the head can spin. Split the aim across neck plus head plus eyes (spine aim offset) for natural motion rather than snapping the head alone.

### Recipe 4.5: Spine and torso aim offsets
**Problem:** Aiming a weapon needs the whole upper body to rotate, not just the arms.
**Approach:** Distribute an additive "aim" rotation across several spine bones (e.g. 20 percent spine, 30 percent chest, 50 percent head) so the offset accumulates up the chain. Combine with an additive aim-pose clip (Recipe 2.3) for authored quality plus procedural precision.

### Recipe 4.6: Hand IK for grabbing and weapon holding
**Problem:** The off hand should stick to a weapon's foregrip, or a hand should reach a doorknob.
**Approach:** Parent the weapon to the dominant hand bone, then use a two-bone IK chain on the off arm with its target set to an empty attached to the weapon. For grabbing world objects, set the IK target to the object and blend IK weight in as the hand approaches (this is a natural use of the `blendFactor` from Recipe 4.1).
**Tradeoff:** Fingers usually stay in an authored grip pose; full finger IK is rarely worth the cost.

### Recipe 4.7: Secondary motion with spring bones (hair, cloth, accessories)
**Problem:** Hair, tails, and ornaments feel stiff because they only follow the skeleton rigidly.
**Approach:** Spring bones (also called jiggle or wiggle bones) apply damped-spring physics to bone rotations so they lag and overshoot the parent motion. Options:
- **Wiggle Bones for Three.js** (`wiggle.three.tools`): a dedicated library for parametric spring-bone motion on rigged models, described as a performant real-time technique.
- **three-vrm springbone** (`@pixiv/three-vrm`): implements the VRMC_springBone spec using Verlet integration with collider groups (sphere and capsule) for collision, and auto-configures from VRM extension data via its loader plugin.
- **ZboingZboing** (`WebAR-rocks/threeZboingZboing`): applies a spring-damper system to bone joints of any SkinnedMesh; you pass per-bone damper/spring params.

```js
import { ZboingZboingPhysics } from './ZboingZboingPhysics.js';
const physics = new ZboingZboingPhysics(scene, skinnedMesh, {
  DEFAULT: { damperRange: [0.001, 0.005], springRange: [0.000001, 0.000005] },
  'hairBone': { damper: 0.0008, spring: 0.000004 }
}, { simuStepsCount: 3 });
// update physics after mixer.update each frame
```

**Gotchas:** Spring bones run after skeletal animation. Tune damping per accessory; randomize frequency across bones so they do not wobble in sync. Add colliders for hair so it does not pass through the body (three-vrm supports sphere and capsule colliders).
**Performance:** cheap per bone but scales with bone count; budget it and disable on distant LODs.

### Recipe 4.8: Ragdoll and physics handoff
**Problem:** On death or impact you want the body to go limp under physics, then optionally recover.
**Approach:** Build a set of rigid bodies (one per major bone) linked by joints in a physics engine, then each frame copy physics-body transforms back onto the corresponding bones.
- **Rapier** (`@dimforge/rapier3d-compat`): Rust compiled to WebAssembly, fast, and deterministic by default (same conditions produce the same animation across devices, per the Rapier docs). The `mattvb91/rapierjs-ragdoll` project maps GLTF bones to spherical-jointed rigid bodies and is the reference implementation, syncing each physics body's position/rotation onto its bone every frame.
- **cannon-es**: pure JS, simpler, good enough for a few ragdolls; `bandinopla/threejs-cannones-rigger` (a Blender addon) lets you define colliders in Blender and set them up automatically.
- **ammo.js**: Bullet port, powerful but heavier and harder to use.

**Active ragdoll / blending:** to blend from animation into ragdoll, drive the physics bodies toward the animated pose with motors, then reduce motor strength on impact. This is an advanced technique with limited turnkey Three.js examples (see forum thread 67247, "Active Ragdoll Physics").
**Gotcha:** Bone naming must match the ragdoll's expected mapping. Physics runs on a fixed timestep (Section 5) independent of render.

---

## Section 5: Timing and Feel

### Recipe 5.1: Frame-rate-independent smoothing
**Problem:** `x += (target - x) * 0.1` moves at a different real-world rate at 30, 60, and 144 fps, making everything feel sluggish or twitchy depending on the monitor.
**Approach:** Use exponential damping with delta time. The correct formula produces identical behavior at any frame rate:

```js
// lambda: higher = snappier. dt in seconds.
x += (target - x) * (1 - Math.exp(-lambda * dt));
```

Use this for camera follow, velocity smoothing, head aim, and any lerp toward a moving target. This is the single most common feel bug in Three.js character code.

### Recipe 5.2: Fixed timestep for physics, variable for render
**Problem:** Physics (ragdoll, spring bones) explodes or behaves differently at different frame rates.
**Approach:** Accumulate real delta time and step the simulation in fixed increments, then interpolate the render pose by the leftover fraction. This is the standard loop from Glenn Fiedler's "Fix Your Timestep!"

```js
const FIXED = 1 / 60;
let acc = 0;
function animate() {
  acc += clock.getDelta();
  while (acc >= FIXED) { stepPhysics(FIXED); acc -= FIXED; }
  const alpha = acc / FIXED;         // interpolation factor for rendering
  renderPose(alpha);
  renderer.render(scene, camera);
}
```

**Gotcha:** Guard against the "spiral of death" (simulation falling permanently behind) by clamping the number of substeps per frame. The AnimationMixer itself is fine with variable delta; reserve fixed timestep for physics-driven layers.
**Tradeoff:** Interpolation adds one frame of latency; for singleplayer it is usually invisible and worth the stability.

### Recipe 5.3: Camera damping and how it shapes perceived motion
**Problem:** A camera rigidly glued to the character makes motion feel harsh; an over-smoothed one feels floaty and laggy.
**Approach:** Lerp the camera toward a goal behind the character using exponential damping (Recipe 5.1), not a fixed factor. A two-object rig (a "tail" pinned behind the character and a "follower" that damps toward it, with the camera on the follower) keeps a stable distance while smoothing rotation.

```js
const t = 1 - Math.exp(-cameraDamping * delta);
camera.position.lerp(desiredPosition, t);
controls.target.lerp(characterHead, t);
```

**Gotcha:** A small amount of camera lag is what reads as "smooth"; zero lag feels robotic. Keep lerp-equivalent factors modest; values above roughly 0.3 per 60fps frame feel jittery. Add a sphere-cast so the camera does not clip through walls.

### Recipe 5.4: Anticipation, follow-through, easing
**Problem:** Motion feels mechanical.
**Approach:** These are authored in the clips (anticipation before an action, follow-through and overlapping action after), but you reinforce them in code with easing on transitions (ease-in-out crossfades), additive settle poses after a stop, and spring bones for follow-through on accessories. Edit curves in Blender/your DCC; Three.js interpolates linearly (or SLERP for quaternions) between keys, so bake easing into keyframes or use `tween.js` for property animation (sbcode's "Using tween.js with the AnimationMixer" tutorial shows the pattern).

---

## Section 6: Performance

### Recipe 6.1: Animation LOD (throttle distant mixers)
**Problem:** Hundreds of `mixer.update()` calls dominate the frame.
**Approach:** Update mixers at a rate proportional to importance: full rate when near/on-screen, quarter rate or paused when far or frustum-culled.

```js
character.mixerUpdateInterval = distance < 20 ? 0 : distance < 50 ? 1/15 : 1/4;
// accumulate delta per character and only call mixer.update when the interval elapses
if ((character.acc += delta) >= character.mixerUpdateInterval) {
  character.mixer.update(character.acc);
  character.acc = 0;
}
```

**Also:** stop mixer updates entirely for invisible objects (check frustum or a visibility flag), swap to simpler rigs (fewer bones) at distance, and limit the number of simultaneously active mixers. These are the standard Three.js animation performance levers: disable off-screen, use simpler rigs at distance, and cap active mixers because each `mixer.update()` has a cost.
**Gotcha:** Recompute the SkinnedMesh bounding sphere/box per frame only if you rely on accurate culling of animated meshes; it is not automatic (the docs note the bounding box must be recomputed per frame to reflect the current animation state).

### Recipe 6.2: Bone count, GPU skinning, morph target cost
**Problem:** Skinning and morphs are not free.
**Approach:** Three.js does GPU skinning in the vertex shader via a bone texture, but cost still scales with bone count (uniform/texture size) and vertex count. Reduce bones for background characters. Morph targets add a vertex attribute per active target and cost memory and bandwidth; keep the number of simultaneously active morphs low, especially for facial rigs with many blendshapes.
**Gotcha:** `clip.optimize()` and removing unused tracks reduces per-frame track evaluation on the CPU side.

### Recipe 6.3: Vertex Animation Textures (VAT) for crowds
**Problem:** You need hundreds or thousands of animated characters and skeletal skinning will not scale.
**Approach:** VAT (also called morphing animation) bakes each frame's vertex positions (and normals) into textures, then a vertex shader reads them per instance. The mesh becomes a static MeshRenderer-style object with no CPU skinning, so you can use InstancedMesh and drive each instance's animation frame/time via an instanced attribute or uniform.

There is a Blender VAT addon (`extensions.blender.org/add-ons/vat/`) that outputs a mesh with a `vertex_anim` UV set plus `positions` and `normals` textures. Note the axis swap: Blender is Z-up, so sample the position texture with `.xzy` in GLSL for Three.js's Y-up.

**Tradeoffs:** No runtime blending between animations (you play a baked clip start to finish), and memory grows with frames x vertices. Luiz Otavio Vasconcelos of the Wildlife Studios tech blog reports the technique running "more than 2000 instances... Each one has 800 vertices... no frame drop even with many other systems running" on a low-end Samsung S6, used for the moving stadium crowds in Tennis Clash. Ideal when you need many characters, do not need blending, and can tolerate synchronized or per-instance-offset playback.

### Recipe 6.4: Instanced skinning and WebGPU compute skinning
**Problem:** You want real skeletal skinning on many instances, with blending, beyond what VAT allows.
**Approach:**
- **WebGL:** there is no built-in instanced SkinnedMesh; community approaches (see forum thread 41958, "Animated Instanced Skinned Meshes") modify the skinning shader chunks to read per-instance bone matrices from a texture. This is advanced and manual.
- **WebGPU (recent Three.js):** `WebGPURenderer` with the node system (TSL) supports compute-based and instanced skinning. Official examples `webgpu_skinning.html` and `webgpu_skinning_instancing.html` demonstrate skinned characters under WebGPU. TSL (Three Shading Language) is a JS-based node shader language that compiles to both WGSL and GLSL and exposes compute shaders.
**Gotcha:** WebGPURenderer and TSL are current but still maturing and, as Codrops and others note, not universally production-ready; keep a WebGL fallback. `BatchedMesh` reduces draw calls for many static-geometry meshes but is not a skinning solution by itself.

### Recipe 6.5: Reduce draw calls
**Problem:** Each mesh part is a draw call.
**Approach:** Merge a character's separate material meshes where possible, use texture atlases, and use `BatchedMesh` for many non-skinned props. For skinned crowds, VAT plus InstancedMesh collapses to very few draw calls.

---

## Section 7: Modern and Advanced Approaches

### Recipe 7.1: Motion matching (concept)
**Problem:** Hand-built state machines and blend trees become unmaintainable and never quite match player intent.
**Approach:** Motion matching is a data-driven technique: instead of a graph, you keep a large unstructured motion-capture database and, several times a second, search for the pose whose features (foot positions/velocities, hip velocity, future trajectory) best match the current character state and desired trajectory, then blend to it (often via inertialization). It was introduced by Michael Buttner and Simon Clavet ("Motion Matching – The Road to Next Gen Animation," Nucl.ai 2015) and presented in depth by Clavet at GDC 2016 ("Motion Matching and The Road to Next-Gen Animation") using Ubisoft's For Honor as the use case; it has since been used in titles including The Last of Us Part II and Half-Life: Alyx. There is no turnkey Three.js motion-matching library, so this is a build-it-yourself endeavor on the web, but the concepts (feature vectors, nearest-neighbor search, inertialized blending) port directly.
**Learned Motion Matching** (Holden, Kanoun, Perepichka and Popa, "Learned Motion Matching," ACM Transactions on Graphics 39(4), SIGGRAPH 2020, Ubisoft La Forge) replaces the database with three specialized neural networks, keeping much smaller memory usage that stays small as data grows. Overkill for most web projects; know it exists.
**Tradeoff:** Needs lots of clean mocap and nontrivial engineering. For most Three.js projects, a good blend space plus additive layers plus foot IK gets you most of the perceived quality.

### Recipe 7.2: Inertialization for transitions
**Problem:** Crossfades over a fixed duration can still pop or feel laggy.
**Approach:** Inertialization records the pose difference at transition start and decays it to zero over a short time using a polynomial/spring, so you blend on top of whatever the new clip does without holding two clips active. It is the standard modern replacement for crossfades in motion-matching systems; the canonical references are David Bollo's "Inertialization: High-Performance Animation Transitions in Gears of War" (GDC 2018) and the related SIGGRAPH 2017 talk. Implement as a per-bone offset that eases out.

### Recipe 7.3: Animation compression
**Problem:** Many clips inflate file size.
**Approach:** Use glTF with Draco/meshopt for geometry; for animation, drop redundant keyframes (`clip.optimize()`), quantize, and reduce sample rate on low-frequency tracks. Share clips across characters. Retarget one animation library onto many characters rather than shipping per-character clips.

---

## Section 8: Facial Animation and Lipsync

### Recipe 8.1: Morph target (blendshape) facial expressions
**Problem:** You need expressions and visemes on a face.
**Approach:** Faces use morph targets (blendshapes): named vertex-position deltas blended by influence 0..1. In Three.js, drive `mesh.morphTargetInfluences[i]`, resolved by name via `mesh.morphTargetDictionary`. glTF imports these automatically. NumberKeyframeTracks can animate them through the mixer, or you set them directly.

```js
function setMorph(mesh, name, value) {
  const i = mesh.morphTargetDictionary[name];
  if (i !== undefined) mesh.morphTargetInfluences[i] =
    THREE.MathUtils.lerp(mesh.morphTargetInfluences[i], value, 0.3);
}
```

**Gotcha:** Ready Player Me and ARKit rigs expose standardized blendshape names (e.g. `viseme_aa`, `mouthSmile`), which makes mapping straightforward. Keep the number of simultaneously active morphs modest for performance (Recipe 6.2).

### Recipe 8.2: Audio-driven lipsync
**Problem:** Make the mouth move in sync with speech.
**Approach:** Two common web approaches:
- **Phoneme/viseme from text (TTS):** with the Web Speech API `SpeechSynthesisUtterance`, map phonemes to visemes and lerp the corresponding morph targets, resetting to neutral when speech ends. The Wawa Sensei React Three Fiber lipsync tutorial is a widely used reference; it drives Ready Player Me viseme morphs and teaches the MorphTargets/visemes concept.
- **Real-time from audio (WebAudio):** use an `AnalyserNode` FFT on the audio stream (speech energy roughly 85 to 255 Hz), map frequency/energy patterns to ARKit visemes (aa, E, I, O, U, PP, FF, etc.), and update morph influences each frame. Smooth transitions with exponential lerp to avoid jitter. Agora (with ConvoAI/Ready Player Me) and Gabber document this flow for real-time AI avatars at 60 fps.

```js
// exponential smoothing of a viseme influence toward its target:
influence = THREE.MathUtils.lerp(influence, target, 1 - Math.exp(-smoothSpeed * dt));
```

**Gotcha:** Always smooth viseme transitions; raw per-frame switching looks buzzy. For VRM avatars use `expressionManager.setValue(VRMExpressionPresetName.Aa, ...)` instead of raw morphs. Precomputed viseme timelines (e.g. Rhubarb Lip Sync offline) give better quality than live FFT when you control the audio ahead of time.

---

## Recommendations

**Stage 1 (foundation, do first):** Get the Mixamo to Blender to glTF pipeline solid (the donmccurdy workflow is canonical: export FBX T-pose plus per-animation FBX without skin, combine in Blender, export glTF) (Recipe 1.1, 3.1). Convert all lerps and camera follow to exponential damping with delta time (Recipe 5.1, 5.3). Build a small state machine with proper crossfades and clean up clips (Recipe 2.1, 2.5, 3.5, 1.3). This alone removes the most common "amateur" tells: frame-rate-dependent jitter and T-pose crossfade bugs.

**Stage 2 (locomotion quality):** Couple timeScale to velocity (Recipe 3.2), add a 1D or 2D blend space (Recipe 2.2), phase-align walk/run (Recipe 2.4), and add additive aim/breathing layers (Recipe 2.3). Add stop and turn-in-place clips (Recipe 3.4). Benchmark: feet should not slide on a textured ground plane at any speed within the clamp range.

**Stage 3 (procedural polish):** Add foot IK with CCDIKSolver (Recipe 4.1) gated by a grounded blendFactor, look-at head aim (Recipe 4.4), and spring bones for hair/cloth (Recipe 4.7). Add ragdoll only if your game needs it (Recipe 4.8), using Rapier.

**Stage 4 (scale, only if needed):** Add animation LOD (Recipe 6.1) as soon as you have more than a handful of characters. If you need crowds (dozens+), move them to VAT (Recipe 6.3) or evaluate WebGPU instanced skinning (Recipe 6.4). Do not build motion matching (Section 7) unless you have a mocap budget and the hand-built approach has demonstrably hit its ceiling.

**Thresholds that change the plan:**
- More than ~10 characters on screen: add animation LOD now.
- More than ~50 characters: VAT or WebGPU, not skeletal blending.
- Targeting mobile/low-end: cut bone counts, cap active morphs, throttle spring bones, prefer WebGL with fallback.
- Need deterministic physics or many ragdolls: use Rapier over cannon-es.
- Facial/AI-avatar product: invest in blendshape mapping and smoothed viseme lipsync early (Section 8).

## Caveats
- **Version sensitivity:** `three/addons/` import paths are r148+; older code uses `three/examples/jsm/`. `CCDIKSolver` `blendFactor` was added in early 2025 (PR #30406, by contributor anishwij); earlier versions apply IK at full strength only. `WebGPURenderer` and TSL are current but still maturing, not universally production-ready, and need a WebGL fallback. The core mixer API has been stable since the r73/r74 rewrite.
- **Retargeting is fragile:** `SkeletonUtils.retarget`/`retargetClip` have documented, open bugs (an off-by-one frame in `retargetClip`, per issue #25288; parameter/type confusion with SkeletonHelper params in issue #25751) and are not exercised by official examples. Different body proportions produce inverted feet or backward hands (forum thread 54892). Prefer sharing one skeleton, or use purpose-built retargeters (e.g. the community `retargeting-threejs` from UPF-GTI, or VRM-specific tools like `vrm-mixamo-retargeter`) and validate visually.
- **Mixamo specifics:** no separate root-motion bone (motion baked into hips), non-standard `mixamorig` bone names, no direct glTF export (Blender round-trip needed), and FBX-vs-GLB skeleton mismatches produce "No target node found for track" errors on the Three.js forum (thread 59981). The donmccurdy Blender workflow is the canonical fix.
- **three-ik is unmaintained** and marked work-in-progress in its own README with open axis-alignment issues; do not depend on it for shipping without vetting.
- **Speculative/aspirational claims flagged:** motion-matching quality figures and Learned Motion Matching benefits come from vendor (Ubisoft) and engine (O3DE) write-ups, not independent web benchmarks; treat performance claims as author-reported. The Wildlife Studios VAT crowd numbers are self-reported from their tech blog.
- **No single "blend tree" or "motion matching" primitive exists in Three.js.** Everything above the mixer (blend spaces, state machines, motion matching, inertialization) you build yourself or pull from community libraries of varying maturity.