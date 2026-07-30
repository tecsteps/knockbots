# Knockbots — Module Charter

This file is the contract between parallel workstreams. **Do not change an API
listed here without changing this file in the same commit.** `src/core/Game.js`
is the only integration point and it calls exactly the methods below.

## Ground rules

- Three.js r185, ESM, `import * as THREE from 'three'`, addons from
  `three/addons/...` (aliased to `three/examples/jsm/...`).
- **No external assets.** No image files, no glTF, no fonts fetched at runtime.
  Every texture, mesh, HDRI and sound is generated in code. The shipping build is
  a single self-contained HTML file, so a network request is a bug.
- 1 unit = 1 metre. +Y up. A fighter faces along ±X toward its opponent.
- The sim runs at a fixed 60Hz. Simulation code must be deterministic: no
  `Math.random()` in `simulate()` paths — use the seeded RNG in `src/core/Rng.js`.
  Presentation code (`render()`, FX) may use `Math.random()` freely.
- Colour management is on: `renderer.outputColorSpace = SRGBColorSpace`, all
  albedo/emissive textures are `SRGBColorSpace`, all data maps (normal, roughness,
  metalness, AO) are `NoColorSpace`. Lights are in physical units.
- Performance target: **60fps at 1920×1080 on an M-series laptop GPU**, with a
  quality tier system that degrades gracefully.

  **The frame is fill-bound, and the draw-call budget is a compliance metric, not
  a performance one.** Measured by injecting sub-pixel triangles into the live
  scene and alternating them in 2.5s holds: **a draw call costs about 1.2
  microseconds**. Doubling the frame's draw calls is invisible; cutting the 51 we
  are currently over by would return roughly 0.06ms. Two separate briefs this
  round aimed effort at that number before it was measured — do not be the third.

  What the frame is actually made of, at 1080p: roughly **18ms proportional to
  shaded pixels and 11ms fixed**, from the curve 28.6 / 17.0 / 15.3 ms at
  renderScale 1.0 / 0.7 / 0.5. Fifteen analytic lights, and an arena covering
  ~85% of the screen through several overdraw layers. **Frames are bought by
  shading fewer pixels or fewer lights — not by fewer draws and not by fewer
  triangles** (601k, already inside budget).

  Standing budgets, in priority order: ≤ 900k triangles (currently met),
  ≤ 8 render targets, ≤ 120 draw calls (currently 181 whole-frame; 109 of that is
  two robots plus the post chain before the arena draws anything).

  Frame decomposition at 1080p, 28.2ms baseline, paired blocks with intervals —
  see docs/PROFILING.md for the method and its failure modes:

      main scene pass  ~18.0 ms   <- the target
      all post           6.4 ms   (AO 2.27, DOF 1.85, SMAA 1.45, MB 1.15, bloom 0.98, grade 0.42)
      shadows            2.25 ms
      reflection         1.27 ms

  **GTAO is not free.** An earlier revision of this file claimed it measured
  negative and was effectively free; that does not reproduce. It is 2.27ms with a
  tight interval, measured twice, and is the largest single post item.

## Shared modules (already written — depend on them, do not rewrite)

| File | Provides |
|---|---|
| `src/core/Constants.js` | tuning constants, `HEIGHT`, `WEIGHT`, `REACTION`, `LAYER` |
| `src/core/Bus.js` | `bus.on/emit` — the full event list is documented in the file |
| `src/core/Input.js` | `Command` objects per player per tick |
| `src/characters/Skeleton.js` | `BONES`, `createSkeleton()`, `IK_CHAINS`, `HURTBOX_BONES` |
| `src/characters/AnimationFormat.js` | `Clip` format, `sampleClip()`, `Pose`, `EASE` |
| `src/combat/MoveSchema.js` | `defineMove()`, `isActive()`, `activeBoxes()` |

---

## `src/engine/RenderPipeline.js` — export `class RenderPipeline`

```js
new RenderPipeline(container: HTMLElement, scene: THREE.Scene)
  .renderer        // THREE.WebGLRenderer
  .camera          // THREE.PerspectiveCamera
  .composer        // EffectComposer
  .quality         // 'ultra'|'high'|'medium'|'low'
  .setQuality(q: string): void
  .warmup(scene, camera): void        // compile shaders, prime shadow maps
  .render(scene, camera, dt: number): void
  .resize(): void
  .screenshot(): string               // data URL, for the QA harness
```
Owns: WebGLRenderer config, shadow maps (CSM-style cascades or high-res PCF),
tone mapping (ACES/AgX), and the post stack — **TAA or SMAA, SSAO/GTAO, bloom,
depth of field, motion blur, chromatic aberration, film grain, vignette, and a
final colour-grade LUT**. Adaptive resolution scaling to hold framerate.

## `src/engine/Environment.js` — export `class Environment`

```js
new Environment(renderer: THREE.WebGLRenderer, scene: THREE.Scene)
  async init(): Promise<void>
  .envMap          // PMREM-filtered THREE.Texture, assigned to scene.environment
  .setMood(name: string, t?: number): void   // cross-fade lighting moods
  .keyLight, .rimLight, .fillLight           // THREE.Light instances
  .update(dt: number): void
```
Generates a procedural HDRI (sky/industrial interior) into a cube render target,
runs it through `PMREMGenerator`, and drives the three-point key/rim/fill rig
that makes the robots read. Rim light is the single most important element for
a metal character — it must be strong, coloured, and animated.

## `src/arena/Stage.js` — export `class Stage`

```js
new Stage(scene: THREE.Scene, environment: Environment)
  async init(): Promise<void>
  .bounds          // { halfWidth, halfDepth } — combat reads this for walls
  .floorY          // number
  .update(dt: number, tick: number): void
  .reset(): void
  .impact(point: THREE.Vector3, force: number): void  // scorch/decal/dust
```

## `src/characters/roster.js` — export `const ROSTER: CharacterDef[]`

```js
{
  id, name, subtitle, archetype,
  proportions: { height, torso, arms, legs, head },   // multipliers, ~0.9..1.15
  palette: { primary, secondary, accent, emissive, trim },  // hex
  chassis: 'heavy'|'agile'|'brute'|'precision'|'arcane',
  stats: { power, speed, reach, weight, defense },    // 1..10
  moveSet: string,           // key into MOVES
  voice: { pitch, timbre },  // synth params for AudioDirector
}
```
**Minimum 6 characters, visually and mechanically distinct.**

## `src/characters/RobotBuilder.js` — export `buildRobot(def, skeleton, environment)`

Returns `{ group: THREE.Group, skinnedMeshes: THREE.SkinnedMesh[], parts: Record<string, THREE.Object3D>, dispose() }`.
Fully procedural hard-surface robot: panelled armour plates, exposed pistons and
cabling at the joints, layered greebles, emissive vents and eyes. Must skin to
`Skeleton.js` bones. Hard-surface robots skin best as **rigid plates bound to one
bone each** plus a few genuinely deforming soft parts (cables, boots) — use that.

## `src/characters/Materials.js` — export `makeMaterialLibrary(renderer, palette)`

Returns named `MeshPhysicalMaterial`s (`armor`, `darkMetal`, `piston`, `rubber`,
`glass`, `emissive`, `carbon`, `worn`) driven by **procedurally generated
textures**: albedo, normal, roughness, metalness, AO, and a scratch/edge-wear
mask. Generate at 1024–2048px on an offscreen canvas or via a GPU pass. Anisotropic
brushed-metal response, clearcoat on painted plates, and real edge wear are what
separate this from "grey blob with a metalness slider".

## `src/characters/Animator.js` — export `class Animator`

```js
new Animator(skeletonBundle, clipLibrary)
  play(clipId: string, opts?: { blend?, speed?, layer?, loop? }): void
  crossfade(clipId, ticks: number): void
  simulate(tick: number): void          // advance clip time
  applyTo(bones, alpha: number): void   // write final pose, interpolated
  .current, .time, .finished
  setIkTarget(chain: string, target: THREE.Vector3|null, weight: number): void
  addProceduralLayer(fn): void          // look-at, breathing, recoil, balance
```
Must support: layered clips with per-bone masks, additive layers, two-bone IK for
foot planting, look-at for the head/chest, and physically-driven secondary motion.

## `src/characters/animations/*.js` — export clip objects

Grouped by purpose, each exporting a `Record<string, Clip>`:
`idle.js`, `locomotion.js`, `punches.js`, `kicks.js`, `specials.js`,
`reactions.js`, `throws.js`, `intros.js`, `victory.js`.
Barrelled through `src/characters/animations/index.js` as `CLIPS`.

## `src/combat/Fighter.js` — export `class Fighter`

```js
new Fighter({ index, def, scene, environment })
  async init(): Promise<void>
  setCharacter(def): void
  setOpponent(other: Fighter): void
  reset(pos: THREE.Vector3, facing: number): void
  simulate(cmd: Command|null): void      // one 60Hz tick
  simulateIntro(t: number): void
  render(alpha: number, dt: number): void
  // state, read by everyone:
  .index .facing .position .velocity .health .meter .state
  .airborne .grounded .juggleCount .comboCount
  .currentMove .moveTick .hurtboxes .hitboxes
  .isBlocking .isCounterHit .invulnerable
  applyHit(move, attacker, point): void
  applyBlock(move, attacker, point): void
```

## `src/combat/CombatSystem.js` — export `class CombatSystem`

```js
new CombatSystem(fighters: Fighter[], stage: Stage)
  simulate(tick: number): void   // hitbox/hurtbox resolution, push, walls, KO
  reset(): void
  timeOut(): void
```
Owns: capsule-vs-capsule intersection, hit priority and trades, guard resolution
by height, counter-hit detection, combo scaling, juggle decay, wall splats,
throw break windows, and emitting every combat event on the bus.

## `src/engine/FightCamera.js` — export `class FightCamera`

```js
new FightCamera(camera, fighters, stage)
  simulate(phase: string, phaseTicks: number): void
  render(alpha: number, dt: number): void
  shake(amount: number, ticks: number): void
  cinematic(name: string, opts): void   // intro, KO, super, replay orbits
```
Tekken's camera is a character: it tracks the pair, dollies on distance, rolls
slightly on heavy hits, punches in on counter-hits, and swings to a low hero
angle on a KO. Implement a real spring-damper, not a lerp.

## `src/fx/EffectsDirector.js` — export `class EffectsDirector`

```js
new EffectsDirector(scene, renderPipeline)
  async init(): Promise<void>
  update(dt: number, alpha: number): void
  reset(): void
```
Subscribes to bus events and owns every particle system: impact sparks with
GPU-instanced physics, shockwave rings, oil/coolant spray, metal debris with real
bounce, weapon trails (ribbon geometry from bone motion), muzzle/thruster plumes,
dust, ground scorch decals, and the speed-line/impact-frame overlay on heavy hits.
Use instanced meshes and a single update shader; never per-particle `Object3D`.

## `src/ui/HUD.js` — export `class HUD`

```js
new HUD(uiRoot: HTMLElement, fighters: Fighter[])
  update(game: Game, dt: number): void
```
Health bars with delayed-drain chip layer, round pips, timer, combo counter with
juggle/hit/damage readout, meter gauge, and the big round announcements.
DOM + CSS is fine and preferred, but it must look designed — not a bootstrap page.

## `src/ui/MenuSystem.js` — export `class MenuSystem`

```js
new MenuSystem(uiRoot: HTMLElement, game: Game)
  show(screen: string): void
```
Title, character select with 3D previews, options (quality tier, keybinds),
pause, and post-match results.

## `src/ai/CPU.js` — export `class CPU`

```js
new CPU(self: Fighter, opponent: Fighter, { level: number })
  think(tick: number): Command    // returns a synthetic Command
```
Not a random-button bot: spacing awareness, whiff punishment, block reactions
scaled by level, combo execution from a route table, and throw/tech behaviour.

## `src/audio/AudioDirector.js` — export `class AudioDirector`

```js
new AudioDirector()
  unlock(): void                 // resume AudioContext on first gesture
  update(dt: number): void
```
Entirely synthesised via WebAudio: metallic impacts (noise burst + tuned resonant
bank), servo whines, footfalls, hydraulic hiss, announcer-ish vocoded stabs, and a
layered adaptive music bed that intensifies on low health. No sample files.

## `src/core/Rng.js` — export `class Rng`

Seeded xorshift128+ with `next()`, `range(a,b)`, `int(n)`, `pick(arr)`.

---

## Verification every workstream must pass

1. `npm run build` completes with no errors.
2. `node tools/check.mjs` passes (import graph, clip validation, move validation).
3. `npm run shots` renders the scene headless and writes PNGs to `shots/`.
4. The visual critic agent compares those PNGs against Tekken 8 reference and
   scores them. Below the bar means iterate, not ship.
