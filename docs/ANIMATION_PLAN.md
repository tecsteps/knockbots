# Animation — ranked plan

Derived from `specs/animation.md` (a Three.js animation cookbook) translated onto our
engine, which uses none of `THREE.AnimationMixer`, `AnimationClip` or glTF — clips are
hand-authored Euler-degree keyframes over the rest pose, sampled by `AnimationFormat.js`.

Animation is the lowest-scoring axis (43/100, ship bar 80). The critic called it "authoring
debt, not an engine gap". That is only about a fifth right: the largest defect is a runtime
constant, not the clips.

## Verified before planning

Three problems on the earlier fix list were already resolved and must not be re-fixed:

- `clipImpactFrame()` no longer guesses contact and globally time-warps. `Fighter.retimeFor()`
  reads clip-declared `impact:{tick,bone}` and builds a two-anchor map for
  `Animator.retimeClip()`. Segments are linear, so authored easing survives. 32 clips declare
  `impact`.
- Strike clips *do* author `ankle_*` and `wrist_*`; all 12 kicks author `foot_*` and `toe_*`.
- `#footIk` now does pre-IK sole-intent contact detection, latched plant weight and heel/ball
  roll. It still lacks X/Z lock and a pelvis solve.

## 1. The walk stride is 6× short of the walk speed — do this first

Measured by sampling clips through the real rig:

| clip | authored | sim drives | ratio |
|---|---|---|---|
| `loco.walkFwd` | 0.46 m/s | 2.75 | **6.00×** |
| `loco.walkBack` | 0.41 m/s | 2.25 | 5.54× |
| `loco.crouchWalk` | 0.27 m/s | 1.25 | 4.66× |
| `loco.runFwd` | 2.69 m/s | never played | 1.02× |

`Fighter.js:745` plays `loco.walkFwd`; `loco.runFwd` is referenced only by its own export map
and `clipIds.js`. The right foot never plants at all in the walk cycle.

No IK, inertialization or easing work will register while the fighter skates at 6× its stride.

**Change** — `Fighter.js` WALK branch and `locomotion.js`: `WALK_FWD` 2.75 → ~1.35,
`WALK_BACK` → ~1.15, `CROUCH_WALK` → ~0.5; roughly double the authored hip swing (~17.8° →
~36°) to widen the stride; add a speed tier promoting to the already-correct `loco.runFwd`.
`loco.stopShort` is likewise authored and unused, and is the stop-plant clip.

Recipe 3.2's own fix (scale playback speed) does *not* apply — its clamp is 0.5–1.8× and we
need 6.0×. The recipe says switch clips instead, which is exactly the answer here.

**Verify:** every locomotion ratio lands 0.9–1.15.

## 2. Inertialization instead of the crossfade

`#startMove` uses a 2–4 tick crossfade; 2 ticks is 33ms, a near-snap. It is positional only —
`#composeLayers` blends poses, never velocities — so every transition has a corner in the
curve, and that corner is the pop.

It maps cleanly onto our engine: `Pose.rot[bone]` is already a rest-relative quaternion delta,
so an inertialization offset is another delta composed by pre-multiplication; `this.prev` and
`this.cur` are already one tick apart, which *is* the outgoing angular velocity, free; and
`quatToVec`/`vecToQuat` already do rotation-vector conversion.

Implement Bollo's quintic decay on the per-bone angle offset, armed on `play({inertia})` with
`blend = 0`, evaluated in `simulate()` after `#composeLayers`, cleared in `reset()`.
Deterministic: a pure function of stored scalars advanced at fixed `TICK_DT`.

It also removes an existing artefact — a bone authored by the outgoing clip but not the
incoming one currently has accumulated weight < 1 and is scaled back toward *rest*, not toward
the pose it was in.

Runtime-only, 89 clips benefit, zero re-authoring.

## 3. Per-bone easing in `makeClip`

`sampleTrack` already reads `ease` per key per track — full per-bone easing exists in the
runtime. But `makeClip` stamps one `ease` onto every bone of a segment, so the striking arm
cannot snap while the hips ride a sine.

Across ~6300 authored ease declarations: sine 3335, quad 1226, linear 874, quart 776, cubic
52, **snap 30, expo 18**. Under 1% are the fast-release curves. That is the mechanical cause
of "no snap", not authoring taste.

Add per-key `easeBy: { shoulder_R: 'snap' }`. Ten lines, no runtime change. Land before item 4
so the authoring pass is done once.

## 4. Follow-through on the 32 impact clips

Overshoot past the impact-frame value on the driving bone:

- **none at all:** `p.jabAlt`, `p.duckingStraight`, `k.roundhouse`, `k.sideKick`, `k.spinKick`,
  `sp.rocketPunch`, `sp.chargeShoulder`, `t.grabAttempt`
- **2–8°** on 21 clips — present in the data, invisible on screen
- **real:** `p.hook` +78°, `p.backfist` +66°, `sp.overdriveStart` +157° — use as reference

No punch clip authors a single `foot_*` or `toe_*` key, so a straight right rotates the hips
and the planted rear foot's ball never breaks.

Author it; do not add a runtime settle spring, which would fight the authored recovery and
desync from the retime map.

## 5. Procedural idle coverage below the waist

`#applyBreathing` writes 8 bones — chest, spine01/02, clavicles, neck, head, hips. Nothing
procedural touches anything below the hips or beyond the clavicles. There are 987 flat spans
of ≥8 ticks across 26 clips on uncovered bones.

Extend with a slow weight-shift into the legs and micro-drift on the arms, scaled by the
existing `idleness` so it vanishes when a move starts, using the existing deterministic
`noise1()` with new seeds. ~20 lines, covers all 26 clips at once.

## 6. Foot IK: X/Z lock and pelvis solve

`st.target` copies the live ankle and edits only `.y`. Latch world X/Z on contact rise, feed
the latched point while contact holds, release on fall. When a latched foot exceeds
`legLength * 0.94`, lower the pelvis by the deficit via `pose.rootPos` from a `stage:'pre'`
layer instead of handing weight back to the clip.

**Strictly after item 1** — with a 6× stride mismatch there is no correct horizontal position
to lock to.

Reject Recipe 4.1's `CCDIKSolver`: we have analytic two-bone IK with pole vector and reach
clamping, and the cookbook itself says analytic beats CCD for limbs.

## 7. Two cheap wins

`Animator.addSpringBone()` is fully implemented and called from nowhere — there are no
antenna, cable or vent-flap bones to hang it on. `BONES` is documented as safe to extend; add
2–4 non-hurtbox leaf bones per chassis and skin existing hardware to them. Randomise spring
constants per bone or they wobble in unison and read as cloth.

`Fighter.render` has the one frame-rate-dependent lerp on this axis:
`visualYaw += delta * Math.min(1, dt * 14)` should be `delta * (1 - Math.exp(-14 * dt))`.
Everything inside `simulate()` correctly uses fixed factors and must not be touched.

## Rejected from the cookbook

glTF loading, the mixer object model and `clip.optimize()` (inapplicable by construction — no
loader, no external assets); blend spaces (locomotion is discrete states, no analog input);
gait phase sync (we never blend two gait clips); root motion (ours is already better —
per-entry, weight-normalised, unwrapped across loops); input smoothing (complicates
determinism for no visual gain); the state-machine sketch (ours is more rigorous);
`CCDIKSolver` and FABRIK (worse than our analytic solver for 2-link chains); look-at and spine
aim (already implemented, and already clamping before damping as the recipe advises); hand IK
(narrow — only throws); ragdoll (external dep, breaks single-file, non-deterministic);
fixed timestep (we already do this); animation LOD (two fighters; the cookbook's own threshold
is >10); bone counts, VAT, WebGPU skinning (34 bones × 2, nowhere near budget); motion
matching (no mocap, and the cookbook says not until the hand-built approach hits its ceiling);
compression (the flat-span data says we want more keys, not fewer); morph targets and lipsync
(no faces).

## Order

1. Walk stride vs speed — nothing else registers until this is true
2. Per-bone ease in `makeClip` — enabler, must precede 4
3. Inertialization — independent, can run parallel to the authoring pass
4. Procedural idle coverage
5. Follow-through authoring pass
6. Foot X/Z lock and pelvis solve — strictly after 1
7. Spring bones and the `visualYaw` fix

---

## Pending: spring-bone defects (apply immediately after round 6)

Eight spring leaf bones were added to `Skeleton.js` in round 6 — structurally correct (no
`region`, so they stay out of `HURTBOX_BONES`; appended last, so no bone index moves; parents
are all heads of the animator's ripple chains, so they inherit impact motion for free). Four
defects remain. `Skeleton.js` was being edited concurrently, so these are queued rather than
applied.

**1. The forward axis in the rig header was wrong, and it caused a real defect.**
`+Z is FORWARD`. Verified from data, not comments: `loco.dashFwd`'s root track ends at
z = +0.94 and `loco.dashBack` at z = −1.08; `toe_L` sits at z = +0.14 from the foot.
`AnimationFormat.js` has been corrected. **`Skeleton.js:9` still claims "−Z is the direction
the fighter FACES" and must be fixed** — `animations/idle.js` had it right all along.

Consequently `pack_L/R` (z = +0.158) and `cable_L/R` (z = +0.148) are mounted on the fighter's
chest rather than its back. Negate both. `antenna_*` and `skirt_*` are fine.

**2. The `spring` field names are dead data.** `Spring3` reads exactly `k`, `c`, `driveRot`,
`driveAcc`, `limit`. The bones author `stiffness`, `damping`, `drag`, `limit`, so only `limit`
lands. Rename in `Skeleton.js` (`stiffness→k`, `damping→c`, `drag→driveRot`) rather than
translating at the call site — `addSpringBone` already spreads over defaults so partial blocks
work.

`driveAcc` is missing entirely and matters most for `pack_*`: it responds to body acceleration
rather than parent rotation, which is what makes a reactor pack lag a *dash* rather than a head
turn. Suggested: antenna 0.30, pack 0.45, cable 0.35, skirt 0.22.

The authored stiffness/damping ratios are well judged and should be kept once renamed —
antenna at k26/c3.2 is a damping ratio of ~0.31 (rings), pack at k62/c11 is ~0.70 (settles in
one swing). That contrast is right. But L and R are identical on all four pairs, which makes
both sides wobble in phase and read as cloth; split `k` by ~10% per side.

**3. Nothing is wired up.** Export `SPRING_BONES` from `Skeleton.js` parallel to
`HURTBOX_BONES`, and loop it at rig build calling `Animator.addSpringBone(name, def.spring)`.
`addSpringBone` is fully implemented and still called from nowhere.

**4. `scaleFor` does not scale the new bones.** None of the four prefixes match its branches,
so on a chassis with `torso: 1.1` the chest grows and the pack/cable offsets do not — the
hardware detaches. Add `pack_|cable_` to the torso branch, `antenna_` to head, `skirt_` to
hips/height.

**Not a defect, but required for the feature to read:** a leaf spring bone only shows if the
skinned geometry extends *away* from the bone origin. The bone is a hinge; geometry centred on
the origin rotates in place and does nothing visible.
