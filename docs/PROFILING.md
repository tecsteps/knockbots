# Knockbots — how to measure the frame, and how not to

Round 7 spent most of its budget discovering that three obvious ways to profile
this game all return numbers that look plausible and are wrong. This file exists
so the next person spends their budget on the frame instead of on the profiler.

The rule underneath all of it is the one already written in `docs/CRITIC.md` for
visual scores, and it applies unchanged to performance: **a number is only as
trustworthy as the procedure that produced it.** Before believing a frame time,
confirm the measurement could have seen the thing it claims to have measured.

---

## Three methods that do not work here

### 1. `EXT_disjoint_timer_query_webgl2` — available, and unusable

The extension *is* exposed under headless Chromium with `--use-angle=metal`.
`gl.getExtension('EXT_disjoint_timer_query_webgl2')` returns an object, queries
create and resolve, and no disjoint is ever signalled. It still cannot be used.

Bracketing each composer pass with `beginQuery`/`endQuery` (one probe armed per
frame, rotating, so no two queries are ever in flight) returned, against a real
42ms frame:

| probe | median |
|---|---|
| FRAME TOTAL | 284ms |
| ScenePass | 146ms |
| GTAO | 62.8ms |
| bloom | 66.3ms |
| DOF | 62.7ms |
| motion blur | 63.6ms |
| grade | 65.5ms |
| SMAA | 64.2ms |
| OutputPass | 68.5ms |

Every pass reports roughly the whole frame, and the total reports seven times
it. ANGLE's Metal backend appears to resolve `TIME_ELAPSED_EXT` against the
enclosing command buffer rather than the bracketed range, so every probe returns
approximately the same number regardless of what it encloses. The tell is that
the sub-passes do not sum to the total — they each *equal* it.

If a future run wants to try again, the diagnostic is cheap: time two passes you
know differ by an order of magnitude. If they come back within 10% of each
other, the extension is measuring the command buffer.

### 2. `gl.finish()` bracketing — defeated by the async command buffer

The obvious fallback is to drain the GPU, start a timer, run the pass, drain
again. In Chromium this does not measure what it looks like it measures, because
WebGL calls are forwarded to a separate GPU process and execute asynchronously.
The first `finish()` in a frame absorbs the entire queued backlog, and every
subsequent one has almost nothing left to wait for. Result:

| probe | median |
|---|---|
| ScenePass | 115.4ms |
| GTAO | 0.1ms |
| bloom | 0.1ms |
| DOF | 0.0ms |
| motion blur | 0.0ms |
| grade | 0.0ms |
| SMAA | 0.0ms |

A 1080p full-screen bokeh gather with 20 taps does not cost 0.0ms. The whole
frame's cost has been attributed to whichever pass happened to sync first.

### 3. Unpaired before/after on frame time — swamped by drift

Measuring a baseline, changing one thing, and measuring again is only valid if
the machine is stationary between the two samples. On a shared dev box running
several agents it is not. A single unpaired run, same page, same camera, nothing
changed between samples, produced this baseline sequence:

```
80.1 → 43.0 → 43.2 → 84.8 → 59.3 → 35.0 → 28.6 → 37.1 → 37.8 → 35.7 → 35.3 ms
```

A 2.8x spread on an unchanged configuration. Any "this pass costs N ms" derived
from a before/after straddling that is noise. Two separate causes were
identified, and both matter:

- **Other agents' benchmarks.** Several headless Chromium instances doing GPU
  work at once. Check `ps aux | grep chrome-headless` and the load average
  before trusting anything, and serialise benchmark runs across agents.
- **Page warm-up.** Even alone on the machine, a freshly loaded page decays from
  ~95ms to ~42ms over roughly the first 40 seconds as shaders compile, textures
  upload and GPU memory settles. A configuration measured early looks expensive
  purely because it went first. Warm up for 40s before the first sample, and
  re-measure the first configuration last as a check.

---

## The method that does work

Alternate the two configurations in **short blocks, many times**, and report the
paired difference. Anything drifting more slowly than one block pair is common
to both sides and cancels.

Specifics that turned out to be load-bearing:

- **Hook `RenderPipeline.render` itself**, so a sample is the interval between
  two consecutive frame submissions and nothing else. Do not use a separate
  `requestAnimationFrame` loop — its callback ordering relative to the game's
  own render is not guaranteed.
- **K = 8 frames per block, first 3 discarded.** WebGL is pipelined two to three
  frames deep, so immediately after a toggle the interval still reflects the
  previous configuration's GPU work. Without the discard the two sides smear
  together and every difference shrinks toward zero.
- **Toggle `pass.enabled`, never `setEffect`.** `RenderPipeline.setEffect`
  rebuilds the entire composer: two full-resolution half-float targets
  reallocated and every pass shader recompiled. Measured through `setEffect`,
  the individual passes summed to 26ms while disabling all of them together
  saved 7.6ms — the difference is the rebuild, not the passes. `pass.enabled` is
  allocation-free and `EffectComposer` already recomputes which pass renders to
  screen.
- **Pause the simulation.** A live round swings the frame between 33ms and 76ms
  on its own — an impact burst, a juggle or a camera dolly changes what is on
  screen far more than any post pass does, and it does so on a timescale that
  outlasts a measurement block. `KB.paused = true` freezes the geometry and lets
  the effects drain; the render loop keeps running.
- **Report the interval, not just the median.** The per-block differences are
  the sample. A median with an inter-quartile range that straddles zero is a
  result that says "too small to see", and that is a useful thing to report.

### The one exception: lights

Fast alternation is **wrong** for lights. `light.visible = false` changes
`NUM_RECT_AREA_LIGHTS`, which makes three recompile every material in the scene.
Toggling that every eight frames measures shader compilation. Lights have to be
alternated slowly — toggle once, settle several seconds, measure a few hundred
frames — and repeated, with the per-configuration medians reported as a sequence
so the warm-up decay stays visible instead of being hidden inside a difference.

The two designs disagreed by a factor of nearly three on the same knob before
this was understood, which is how it was found.

---

## Harness notes

- `tools/capture.mjs` pins `KB.clock.getDelta` to `1/60` for the hit-freeze and
  tick-strip shots. Anything timed through those code paths measures a synthetic
  clock, not real frame pacing. Use the plain shots or a separate driver.
- `renderer.info.autoReset` is `false`; `RenderPipeline.render` resets it once
  per frame. A profiler that resets it again will zero the stats other code
  reads.
- Headless Chromium with `--disable-frame-rate-limit` runs `requestAnimationFrame`
  uncapped, so the frame interval is throughput rather than a vsync-quantised
  number. That is what makes interval timing meaningful here, and it also means
  these numbers are not directly comparable to a real browser.

## What these numbers are, and are not

Every figure produced by this method is a **headless Chromium / ANGLE-Metal
number on one shared laptop**. It is a good instrument for ranking costs against
each other and for detecting regressions run-to-run. It is not a claim about
what the game does in a real browser on an idle machine, which has no headless
compositor in the path and quantises to vsync. Quote it as a ratio or a ranking;
be careful quoting it as an absolute frame rate, and never quote it without
saying which machine and which method produced it.

## A capture is not a measurement until you know what it captured

Three separate numbers on this project were wrong in the same way: taken from a capture without
checking what the capture was of.

1. Impact scores for four rounds were read off frames photographed 700ms after contact, while
   the effects they were judging lived 160-300ms.
2. Framerate was quoted from unpaired A/B runs while a dozen headless browsers competed for the
   GPU. An unchanged configuration measured 28.6ms to 84.8ms — a 2.8x spread.
3. "475 draw calls / 1.12M triangles" was briefed to an agent as the shipping frame and used to
   scope a round of work. The manifest for that run reports **geometries: 259** against **131**
   in every other capture of the same build — it had photographed a scene still holding the
   character-select preview robots. The real figure is 198 calls / 635k triangles, which puts
   triangles *inside* budget and leaves draw calls as the only overage.

The manifest carries `geometries`, `textures` and `programs` alongside `calls` and `triangles`
precisely so this is checkable. **Compare those counts against a known-good capture before
believing a number**, and if they differ, the scene is not the one you think you measured.

## Four ways a timing method lies

All found the hard way on this project. Any of them will silently invalidate a per-pass table.

**Short measurement blocks understate large changes.** The K=8-frames-with-3-discarded method
reported hiding the entire arena as costing **0.75ms**. A 2.5-second hold on the same
configuration reports **13.4ms**. Eight frames measures the GPU queue draining, not the new
configuration reaching steady state. The block method is adequate for small deltas and wrong for
large ones — which is the opposite of what intuition suggests, and it means any earlier per-pass
table produced with it may have understated its biggest items.

**Cross-session before/after captures cannot resolve a change of this size.** Two runs of an
identical build at an identical simulation tick differ by **7.1/255 mean pixel difference**,
because the camera spring integrates on render dt and converges differently each run. Any visual
A/B has to happen *inside one page session*, with film grain and motion blur disabled, which
brings the noise floor down to about **1.08/255**. A change measured at 2.0/255 against that
floor is real; the same change measured across sessions is invisible.

**Pairing does not save you if the scene is moving. Never A/B against a live match.** Pairing
defends against a drifting *machine*, because both arms of a pair drift together. It defends
against nothing when the thing drifting is the *content*. Six alternations with 5-second holds
against a running fight gave baselines of `37.4 → 37.9 → 37.2 → 37.4 → 38.3 → 21.7ms` with no
configuration change at all — rounds end, the KO cinematic fires, the camera reframes. Paused,
the same harness holds 24.9-25.1ms. Worked through in full under *A live match is a moving
baseline* below; it is the most expensive measurement error recorded here.

**A fix that relocates work rather than removing it will still read as a success on the
instrument that motivated it.** The HUD's portrait readback was moved to
`readRenderTargetPixelsAsync` to stop it stalling the frame. Measured by the `hud.update` timer
that had identified the problem, the fix worked perfectly: **0.1ms**. Measured on whole-frame
intervals, the frame still stalled **1433ms**. Going async moved the cost out of `hud.update` and
into the GL sync point, where that timer cannot see it — `getBufferSubData` still blocks, and it
now blocks somewhere the instrument was not looking.

The general form: **a timer scoped to a call site measures the call site, not the work.** Any fix
that makes work asynchronous, defers it, batches it or hands it to the driver has moved it
somewhere that timer does not cover, so the timer's approval is close to meaningless. Verify
against whole-frame intervals — worst frame and the count of frames over a threshold, which is
what the user actually experiences — and only then go back to the scoped timer to attribute it.

## What the frame is actually made of

Measured at the hero framing, 1920x1080, headless ANGLE/Metal, adaptive resolution pinned:

    renderScale 1.0  ->  28.6 ms
    renderScale 0.7  ->  17.0 ms
    renderScale 0.5  ->  15.3 ms

That is roughly **6ms fixed and 23ms proportional to shaded pixels** — the frame is pixel-bound,
not draw-call-bound. The scene carries 15 analytic lights (4 directional, 4 spot, 4 point,
3 RectArea) plus a hemisphere, and the arena covers ~85% of the screen through several layers of
overdraw: hiding arena subsystems one at a time sums to ~17ms, while hiding the whole arena
returns 27ms, because removing one layer only exposes the next.

Draw calls at the same framing: reflection 47, shadow 25, arena main 46, crowd 13, fighters 34,
remainder 6 — 171 scene, 198 whole-frame, against a 120 budget. Real, but not the bottleneck.

**Consequence for anyone optimising here: reducing draw calls will not reach 60fps. Reducing
shaded pixels or light count will.**

## A draw call costs about 1.2 microseconds here

Measured, not assumed. 120 sub-pixel triangles were injected into the live scene — inside the
frustum so they are drawn, well under a pixel so they shade nothing — and alternated on/off in
2.5-second holds, 7 pairs, resolution pinned, adaptive resolution off, simulation paused. Two
variants, because they are different costs: all sharing one material, and each with its own
material clone (which forces a re-upload of the 23-light uniform block per draw).

    +240 draws, one shared material :  -0.45 ms   IQR [-2.10, +0.10]
    +240 draws, unique materials    :  +0.20 ms   IQR [-0.20, +0.65]

(240 rather than 120 because the mirror draws them again.) Both intervals straddle zero. The
clean repetitions give +0.1 to +0.3ms for 240 draws — about **1.2us each**.

**Consequence: the 120-draw-call charter budget is a compliance metric, not a performance one.**
An arena prune that took scene draws 171 -> 154 and triangles 635k -> 602k measured **-0.38ms,
IQR [-9.80, +19.90]** — straddling zero, exactly as the per-draw cost predicts. It was kept
because it is free and regression-tested, not because it bought frames.

Where the draws actually are, after that prune: two robots **64** (32 main, 17 mirror at LOD1,
15 shadow), post chain **27**, arena **72**, remainder 18. Deleting the entire arena would still
leave 109.

## Suspect: the "whole post chain is 5.8ms" figure

That number was produced by toggling `pass.enabled`, which does **not** remove the composer's
render-target allocations or its blits — so it measures the passes' shading and not the chain's
fixed cost. An almost-empty scene (arena and fighters hidden, 7 draws, 6k triangles) still
measures **13-14ms at 1080p**, which is far more than 5.8ms of post plus a trivial scene.

Until that is re-measured properly, **treat 5.8ms as a lower bound on the post chain, not its
cost**, and do not repeat it as settled. The reflection pass, measured the same careful way, is
**4.3ms with a tight IQR [3.80, 5.25]** — a second scene render through the same 23-light block,
and one of the largest single items in the frame.

## Corrected frame decomposition, and two probes that were lying

Measured at 1080p, adaptive resolution off, renderScale pinned to 1, simulation paused,
30 paired blocks of K=8 with 3 discarded. Baseline 28.2ms.

    all post        6.40 ms   IQR [ 6.10,  6.90]
      ao            2.27 ms   IQR [ 2.10,  2.90]    (re-measured as a drift check: 2.57)
      dof           1.85 ms   IQR [-0.85,  3.95]
      smaa          1.45 ms   IQR [ 0.70,  2.25]
      motion blur   1.15 ms   IQR [ 0.05,  4.45]
      bloom         0.98 ms   IQR [ 0.50,  1.90]
      grade         0.42 ms   IQR [-0.05,  0.80]
    shadows         2.25 ms   IQR [ 1.55,  2.65]
    reflection      1.27 ms   IQR [ 0.75,  1.70]

Post at 6.4ms is close enough to the earlier 5.8ms that the figure stands after all. Shadows are
2.25ms, not the 1.5ms previously on record. **GTAO is 2.27ms and is the largest single post item
— the earlier claim that it "measured negative, is half-res and free" does not reproduce and has
been removed from the charter.**

Subtracting all three leaves the **main scene pass at roughly 18ms of the 28.2ms frame**.

**`_passes.gbuffer` is an alias for `_passes.scene`** (RenderPipeline.js:1716). Toggling it
disables the scene render and collapses the frame to 0.2ms. Any per-pass table containing a
"gbuffer" row is reporting an artifact.

**Unresolved:** the reflection pass measures 1.27ms by short blocks and 4.3ms by long holds — a
3x disagreement. The long-hold run had drifted to a ~51ms baseline, which argues for the short
number, but neither is settled.

## An overdraw probe that was measuring the sky

`scratchpad/arenaperf/overdraw.mjs` reported "144 fragments per pixel", "40x opaque overdraw" and
a "97% ceiling on a depth prepass". All three are false by roughly 16x. `scene.overrideMaterial`
**does not apply to `scene.background`**, so the procedural HDRI painted the frame with its own
colours and the readback summed those bytes as though they were fragment counts. Its 8-bit
counter also saturated at 255 without saying so.

The catch was a calibration the original lacked: render **one flat quad and nothing else**, which
must read exactly 1.00 fragment per covered pixel. The original read **32.4**. With
`scene.background` nulled for the duration it reads **1.00, max 1**.

Corrected figures, hero framing at 1080p:

    fragments rasterised per screen pixel   all 18.02   opaque only 9.89
    fragments surviving the depth test      all  3.11   opaque only 2.45
    calibration (floor slab alone)          1.00, max 1

Front-to-back sorting and early-Z already discard 75% of rasterised fragments, but the opaque
pass still shades every screen pixel **2.45 times**. A perfect depth prepass takes that to 1.0,
so the ceiling is **59% of opaque scene shading — not 97%**. Against an 18ms scene pass that is
worth single-digit milliseconds, which is the right order for a 20ms target. It costs a
depth-only pass over the same geometry, and the alpha-tested materials (chain-link fence,
grating) must be carried into it with their alpha test intact or they punch holes in the depth
buffer.

**Any probe that counts fragments needs a calibration case with a known answer.** Without one,
this probe was wrong by 16x and nobody would have known.

## What a dark analytic light actually costs

Three figures were produced for the arena's near-permanently-dark point lights, spanning an order
of magnitude. All are reported here because the disagreement is the lesson.

    three lights removed, loaded machine (baseline 56.7ms)   -9.7 ms   (-6.1 / -7.6 / -13.9)
    one light toggled, quiet machine, 5 paired alternations  -1.10 ms  (22.6 -> 21.5)
    1/2/3 lights, paused, 6 paired alternations each         -1.55 / -2.92 / -4.37 ms

**Use ~1.5ms per analytic light at 1080p**, from the third row — it is the best-supported of the
three: three points establishing linearity, ±0.1ms intervals, and the single-light figure
reproduced in a second session. The 1.10ms row is the same experiment with one point and a
shorter run and does not contradict it so much as under-resolve it. The 9.7ms row is retracted;
it was taken on a loaded box *during a live match*, which inflates every proportional cost, and
is kept only as an example of what that looks like.

The point stands either way, and it is the useful part: **an analytic light is evaluated per
pixel over the whole frame whether or not its intensity is zero.** A light that is dark for 99%
of a match is not free, it is only invisible. Two wall-flash lights became one repositioned light
for exactly this reason, with no visual change, because only one barrier is ever struck at a time.

**Caveat on the instrument.** Toggling `light.visible` to A/B a light changes `numPointLights`
and recompiles every material — the first sample of the run above read **4380ms** for that
reason. The median survives it, but `.visible` is not a free measurement instrument, and any
probe using it must discard its first samples or measure something else.

## A live match is a moving baseline

The most expensive measurement error on this project so far, and the least obvious.

A figure of "~9.7ms for the arena's three dark point lights" circulated, was used to justify a
code change, and reached a committed comment. It was wrong by 2.2x. Re-measured paired with the
**simulation paused**, six alternations per point, against a pristine HEAD copy:

    1 point light removed   1.55 ms   IQR [1.3, 1.7]   (reproduced separately at 1.53)
    2 point lights removed  2.92 ms   IQR [2.9, 3.0]
    3 point lights removed  4.37 ms   IQR [4.2, 4.5]

Flat ~1.5ms per shadowless point light, linear in the count (3 x 1.46 = 4.37), intervals of
±0.1ms. Baselines across that run: 24.9 / 25.0 / 25.0 / 24.9 / 25.0 / 25.1 — no drift at all.

The original came from unpaired repetitions taken during **live combat**. Over a multi-minute run
the match itself progresses: rounds end, the KO cinematic fires, the camera reframes, effects
fire and decay. Baselines drifted **37ms to 21ms within a single run**. Machine load contributed;
the match contributed more.

**Rule: any A/B lasting more than about a minute of live match time is measuring the match, not
the change.** Pause the simulation, pin the render scale, alternate in short holds, and report
the interval. The same harness that produced a 2.2x error unpaused is rock steady paused.

A second, cheaper check that would have caught it: the implied ratio. A shadowless point light is
a normalize, an attenuation and a dot product; it cannot plausibly cost 70% of a RectAreaLight
running the full LTC integral. The corrected ratio is about 1:3, which is believable. **When a
number implies an implausible ratio between two known-different costs, re-measure before
publishing it.**

Still loosely held, flagged by both agents who quoted it: the ~4.6ms-per-RectAreaLight figure is
loosely measured on both sides, and two loose measurements agreeing is weaker than it looks. It
needs redoing properly before anyone targets area lights again.

## The last stall is not attributable to application code

After the portrait readback was routed to the menu-time cache and the impact lights were made
count-invariant, a stall of 200-580ms still appears a handful of times in ~15s of driven combat.
It is worth recording that it has been chased and what was ruled out, so the next person does not
re-derive it.

Instrumented across every frame over 150ms, entering a match through character select:

    new shader programs   0        (program count flat at 119)
    geometries            131      unchanged across the stall
    textures              118      unchanged across the stall
    draw calls            212-217  stable
    portraits cached      9        so the HUD readback never fires
    phase                 fight

Nothing in the application's state changes across the stall. Shader compilation, resource
allocation, the portrait readback and a draw-call spike are all excluded by that table. Combined
with the separately measured **0.75ms mean main-thread cost** (the whole simulation, both
fighters, stage, effects, camera and HUD, with the render stubbed), there is no JavaScript
candidate left.

What remains is the headless environment itself — a shared machine that has run at load average
4-9 for this entire session, through a software-backed ANGLE/Metal path with a compositor in
front of it. The four traps above all describe ways this box lies about timing.

**Do not spend another round on this without first reproducing it on a quiet machine, or better,
in a real browser.** A stall that leaves no trace in program count, resource count or draw count
is far more likely to be the measurement environment than the game.

---

# Trap 5: the captures are not reproducible, and the noise is larger than the work

Added round 16, after **three independent agents hit it in the same round from three different
directions**. This is the most expensive measurement defect the project has found, because unlike
the four above it does not corrupt timing — it corrupts the *image comparisons that decide every
score*.

Two runs of an **unchanged tree**, identical shot list, no code between them:

| shot | mean absolute delta | pixels ≥ 8/255 |
|---|---|---|
| `02-closeup-face` | **24.3 / 255** | **57 %** |
| `09-roster` | 3.5 / 255 | 8 % |
| `06-stage-wide` floor band | — | **29 %** |

Every material change measured on the closeup across four rounds is *smaller than that spread*.
So those measurements were substantially comparing poses, not materials, and the flat character
score across four rounds of real work is consistent with that.

**Causes, as far as they are understood.** A shot that pauses inside its own `setup` pauses
wherever wall-clock left the idle cycle, because `setup` runs after a fixed delay — the head moves
tens of pixels and rotates between runs. On top of that, `paused` gates the **accumulator, not the
render**: `Game.#render` runs unconditionally on wall-clock dt, so spring bones, breathing, FX and
TAA keep advancing in a "paused" shot. Adaptive resolution is also live and moves the delivered
resolution on its own. And the wide shot adds sub-pixel camera drift over a highly detailed deck.

**Three fixes were tried and ALL THREE MEASURED WORSE than doing nothing.** Recorded so nobody
repeats them:

1. Wait for `KB.tick >= t0 + 150`, then pause — **42.2 / 255**. `t0` is sampled at shot start and
   varies run to run, so a fixed *offset* lands at a different phase of a cyclic pose every time.
   A relative origin cannot pin a cycle.
2. Absolute origin — force `startMatch` + `setPhase('fight')`, wait on `phaseTicks` — **39.2**.
3. Same, plus freezing the render clock (`clock.getDelta = () => 0`) — **33.1**.

Baseline is 24.3. All three were reverted; `tools/capture.mjs` is unchanged on this point.

## Round 16 follow-up: what it is NOT

Three further fixes were tried and measured. None improved on the 24.3 baseline, but together they
localise the fault, which is worth more than another failed patch:

4. Pin the sim clock to 1/60 for the whole warm-up (so one rendered frame is exactly one tick and
   springs, FX and TAA all advance deterministically), absolute origin via `startMatch`, then pause
   — **19–31 / 255**.
5. Same, but with the wait and the pause in a SINGLE page-side callback, because polling from the
   driver returns when Playwright *observes* the condition and more ticks run during the round trip
   — the pin then lands on the exact requested tick, every run — **17–30 / 255**.

**What that rules out.** Camera is identical (`dist` 1.268 to three decimals across runs). Exposure
is identical (median luma within 1%). The driver round-trip is eliminated. The sim clock is
deterministic. And the pin provably lands on the same tick.

**What remains, and it is the answer to look for.** At an identical `phaseTick`, with an identical
camera, the bones are still **13–30 mm apart between runs**. At this framing (~2000 px/m) 30 mm is
about fifty pixels, which is most of the whole-frame difference. So the pose is not a function of
the tick — there is per-tick state that `startMatch` does not reset. The two candidates are the
animator's blend/inertialization history and the eight spring leaves, which integrate with damping
and carry history from before the restart.

`02-closeup-face` now records a **pose signature** (six bone world positions) in its `verified`
block. That is measurement only and changes no behaviour, but it means the next attempt can tell
in a single run whether it fixed the pose or merely moved it.

**It is solvable.** A bespoke probe built by the character workstream reaches **1.65 / 255** on the
same framing. Whatever that probe does about animator or spring state is the missing piece.

**Until it is, two rules.** A full-harness A/B across runs cannot resolve anything smaller than
these numbers — toggle **in-page**, on one frozen frame, so nothing else moves between the pair.
And treat any cross-round still comparison on the character axis as unproven.


## Round 16 resolution: partly fixed, and the shape of the residual

**Shipped, and it measures better.** `02-closeup-face` pairwise deltas fell from a 24–29 / 255
baseline to **6.1 / 18.7 / 19.4 (mean 14.7)** — about a 43 % reduction. Two clock states are
needed and both matter:

- **1/60 through the warm-up**, so one rendered frame is exactly one tick and the pose is a
  function of the tick count rather than of wall-clock.
- **0 once paused**, because the settle window is wall-clock: anything that advances per *render*
  frame accumulates a different amount depending on machine load, and the number of frames in a
  2.5 s settle is not fixed.

Plus: the wait and the pause must happen in **one page-side callback**. Polling from the driver
returns when Playwright *observes* the tick, and more ticks pass during the round trip — "pause at
150" was pausing at 152, 157, 163.

**Not applied to `09-roster`, on evidence.** The same pin made that shot WORSE, 3.2 → 8.6–13.4,
because `rosterLineup` builds its own animators and warms each by a fixed tick count, so the
lineup was already deterministic; the pin's `startMatch` resets the fighters, not the lineup, and
added variance instead of removing it. It is left unpinned and sits at 2.6–4.9.

**The residual is still real.** 14.7 / 255 is far from the 1.65 a bespoke probe reaches, and it is
still the same order as the material changes being measured on that frame. Treat a single-pair
closeup comparison as unproven; use three runs a side and compare medians, or toggle in-page on
one frozen frame.
## Round 17: the closeup is now reproducible when the pose matches, and you can tell

Two further causes found, the second by the character workstream:

6. **The film grain re-rolls every rendered frame.** The grade pass hashes `uGrain` on
   `gl_FragCoord` **plus `uTime`**, so it is a fresh per-pixel dither on every frame even with the
   sim clock at zero. No amount of pose pinning touches it. `setGrade({ grain: 0, chroma: 0 })` at
   the freeze removes it.

7. **The pose still diverges intermittently, and the pose signature detects it exactly.** Three
   runs, pairwise:

   | pair | worst bone delta | frame delta |
   |---|---|---|
   | 53 vs 55 | **0.0000 m** | **0.235 / 255** |
   | 53 vs 54 | 0.0060 m | 15.78 / 255 |
   | 54 vs 55 | 0.0060 m | 15.78 / 255 |

   When the pose matches the frame matches — 0.235/255 against a 24–29 baseline is a **hundredfold
   improvement**, and it is bit-near-identical. When it is 6 mm out (about twelve pixels at this
   framing) the frame is 15.8/255 out. Roughly one run in three diverges, cause not yet found.

**So the working method is: capture three times, read `verified["02-closeup-face"].pose` from each
manifest, and only difference frames whose signatures match.** That turns a frame nobody could
measure on into one that is exact when it is valid and self-declaring when it is not. Do not
average across runs with different signatures — you will be averaging poses.

---

# CLOSED defect: kicks never connect (fixed rounds 20-22)

Reported by a player ("n and m make him kick but I never hit the opponent, even when that close").
Reproduced and partly characterised; **not yet root-caused**. Recorded here so the next attempt does
not repeat the two dead ends.

**Reproduction.** Force each move through the test harness at a staged distance and listen on the
bus. Punches land at every distance; kicks miss at every distance:

| move | 0.9 m | 1.02 m | 1.2 m | 1.5 m |
|---|---|---|---|---|
| `jab` (p.jab) | hit | hit | hit | hit |
| `jabLow` | hit | hit | hit | hit |
| `midKick` (k.midKick) | — | **whiff** | — | — |
| `jab3` (k.midKick) | miss | miss | miss | miss |

**What is ruled out.** The event emitted is `whiff`, not `block`, with the defender `idle` and
`isBlocking = false` — so this is a genuine capsule miss, not a guard interaction. Hitboxes *are*
being created: two of them, on `foot_R` and `ankle_R`, radius 0.27 and 0.23, present through the
active window. The defender has 22 hurtboxes. The move reaches its active frames.

**A dead end, with its numbers.** The forward-lead table gives feet the largest lead of any limb
(0.31 against 0.24 for hands). That looks inverted — a lead compensates for an anchor bone sitting
behind the striking surface, which is true of a fist inside a glove and false of a foot at the end
of an extended leg. Cutting it to 0.13 changed nothing: kicks still whiffed at all four distances.
Reverted. The reasoning may still be sound; it is not the cause.

**A measurement error worth not repeating.** An earlier pass reported the kick capsule "overshooting
by 6 cm", computed as centre-to-centre distance minus the summed radii. `CombatSystem#findConnection`
uses `segSegDistSq` — **segment to segment**, not centre to centre — so that figure overstates the
gap for a capsule of any length and does not localise the miss. Re-measure with the same segment
test the engine uses before drawing any conclusion about where the capsules are.

**Where to look next.** The X and Y extents overlap generously on the numbers taken so far, which
leaves Z, the sampling tick, or `attacker.connected` suppressing the window. Sample inside the sim
tick rather than from a `setInterval`, and print `segSegDistSq` itself for every hitbox/hurtbox pair
on the frame the move is active.


## Resolution

**Root cause: an extracted body pivot.** A clip's root track may author `ry`. The Animator extracts
it rather than baking it into the bones, so the only place it is ever applied is `Fighter.animYaw`
on the group -- which turns the striking limb along with the whole chassis. `k.midKick` authored
`ry: -58` at exactly its contact tick: the fighter turned 58 degrees away on the frame the blow
landed and the foot left along the rotated axis, 67 mm short **in Z**. That is why every attempt to
reason about horizontal reach came up empty.

The pivot is innocent by itself -- `k.spinKick` pivots 249 degrees and connects every time, because
its leg track comes round with the spin. The discriminator is **aim error**, not yaw: within 25
degrees, 409/432 connect; beyond it, 186/296.

Fixed with `strikeAim()`, a static per-move solve on the clip's own FK at its declared contact tick,
negated and folded into `animYaw`. **744 moves probed: 611 -> 717 connecting, 8 dead moves -> 0.**

**A third dead end, and the subtlest:** the active window is NOT the free variable when a clip
declares a contact tick. `retimeFor` pins that tick onto the window's first frame, so re-authoring
the window drags the clip with it. `sp.risingFang` survived every other fix for this reason -- its
fist sat 1.2 m above the head and receding on every active frame, while the clip crossed the strike
zone at clip frames 6-11. Fixed with a per-move `contact` override expressed in CLIP frames.

**And one for anyone building an offline capsule tool:** a hand-rolled rig sample reported
`k.midKick` *overlapping* the defender by 14 cm while the shipping game whiffed it at every range.
The difference is the extracted root yaw, which only exists once `Fighter` applies it. Do not
reconstruct the pose outside the Fighter -- step the real one.

---

# Open defect: a black pole through the fighter in 06-stage-wide

Found by the stage critic at **1x**, during the disk-full round when magnification was impossible —
which is worth noting on its own: it had survived 23 rounds of magnified review and was caught by a
critic reduced to looking at the whole frame.

A dead-black vertical member runs from the top of frame to the floor at x≈1180 (1920-wide),
**passing through Kestrel's torso**. It has one collar box at y≈560, no luminaire at the top, no
base flange, and no shadow where it meets the floor. It is the only one of its kind in frame — no
rhythm of stanchions for it to belong to.

The damning part is the shading, not the placement: **it stands directly in front of the blown-out
LED strip and receives ZERO rim.** An unlit black bar in front of the brightest object in the scene
is a shading failure on stage geometry, in the one shot this axis is scored on.

Almost certainly one leg of a rigging mast in `StageStructure.js#foreground()` — the pair at
x = -3.6 and x = 4.45 — seen close to edge-on, so the cross-arm and lamps are cropped above the
frame and the base is out of view, leaving a bare 0.075 m leg. That would explain "the only one of
its kind": the rest of the mast simply is not in shot.

**Not present at 01-hero-idle framing**, which is why it has gone unreported.

**Not fixed, deliberately.** The obvious move — give the foreground occluders a rim response — is an
unmeasured art change, and this project's own rule is that a fix without a measurement does not
count. Whoever takes it should: confirm which member it is by hiding
`arena.structure.foreground` and re-shooting; check whether the mast is cropped rather than
misplaced, because *moving* it may beat *lighting* it; and measure the edge/background ratio on that
member before and after, the same way the lighting axis measures silhouette separation.

---

# The texture-unit ceiling: what it is, and what it is not

The lighting axis cannot get the thing it has been asking for since round 18 — a shadow-casting
per-fighter key — because `kb.armor` already fails to compile with one added:
`FRAGMENT shader texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)`.

**CORRECTED — I had this backwards, and the correction is the whole answer.** I wrote that ORM
packing was already done and therefore spent, because `aoMap`, `roughnessMap` and `metalnessMap`
all point at the same `shared.plateOrmPainted` texture. **Sharing the texture does not share the
sampler.** They are three separate `uniform sampler2D` declarations and they cost three units, not
one. Measured: nulling `aoMap` and `metalnessMap` while leaving `roughnessMap` bound to the *same*
texture takes `kb.armor` from 17 samplers to 15 — two free units from a texture that is still bound
and still sampled. The avenue I called spent is the cheapest one on the board.

**So the pressure is the material's feature set, not its texture packing.** The armour binds, on top
of ORM: base colour, normal, emissive, clearcoat, clearcoat roughness, clearcoat normal, anisotropy,
one custom `kbGrungeMap`, the environment map, and one unit per shadow-casting light. A second
shadowed light costs two more units — one per fighter — and that is the straw.

**Which makes this a design trade, not a mechanical optimisation.** Freeing units means dropping a
material feature. The candidates, in the order I would test them:

1. **Anisotropy** (`anisotropyMap`). Four materials use it. It was added for the machining lay, and
   the lay is also carried by the detail normal — so measure whether the map earns its unit
   independently, or whether the normal already delivers it.
2. **Clearcoat's three maps.** A previous round measured the coat lobe at 4% and found retiling its
   normal did nothing (`clearcoat` retiling 3 -> 9, no effect). If a constant clearcoat reads the
   same as a mapped one, that is two units for free.
3. **`kbGrungeMap`** could fold into an unused ORM channel — the ORM's alpha is documented as sheen
   roughness and may be spare.

Each is a one-line ablation with the frozen-frame A/B this project already has: toggle through a
uniform branch on the same compiled program, difference one frozen frame, and see whether the image
moves at all. **Do that before anyone builds the light** — three of these could be worth nothing,
and the answer decides whether the lighting the axis wants is reachable at all.


## Measured answer (compile-tested against the real app, MAX_TEXTURE_IMAGE_UNITS = 16)

**The gap is ONE unit, not two.** `kb.armor` sits at 15 fragment samplers today with the single
shadowed directional; adding two shadowed spots takes it to 17, because `spotShadowMap` is declared
as a `[2]` array and costs 2 while the directional stays at 1.

| candidate | compiles with 2 spots | units freed |
|---|---|---|
| `anisotropyMap` | **no** | 0 — *it does not exist on this material* |
| clearcoat's three maps | yes | 3 |
| `kbGrungeMap` | yes | 1 (lands exactly on 16) |
| `clearcoatNormalMap` alone | yes | 1 — cheapest verified |

Note the first row: `kb.armor` sets scalar `anisotropy`/`anisotropyRotation` and no map at all — the
`anisotropyMap` lives on `kb.metal*`. My first candidate did not exist on the material that is over
budget.

**THE FIX THAT COSTS NOTHING VISUALLY:** fold AO and metalness into the roughness texel inside the
`StoryPhysicalMaterial` fragment patch, which already rewrites all three channels. Two units, no
material feature dropped, visually neutral by construction. Do this before considering any ablation.

**`kb.armor` is not the only blocker.** `arena.floorWet` sits at 16 today and 17 with two spots, and
fails identically. Freeing a unit on the armour alone still leaves the floor failing; freeing one on
each gives **0 failing programs across all 69 in the scene**. Next in line: `kb.carbon` 15,
`kb.darkMetal` 14, `kb.piston` 14 — a *third* shadowed light breaks all of them.

**And one shadowed spot needs no ablation at all.** With a single shared key rather than one per
fighter, `kb.armor` and `arena.floorWet` both land exactly on 16 and nothing fails. If the lighting
axis can accept one key for the pair, the light it has wanted since round 18 is reachable today.

### Do not spend the clearcoat normal — measured

Ablated through a pure uniform (`clearcoatNormalScale` -> 0 on kb.armor and kb.trim, 8 instances) so
the compiled program is literally identical between grabs. Noise floor **0.0000/255, max 0**, and
restoring the uniform reproduced the first grab at 0.0000 — the toggle is clean and reversible.

| | whole frame | head crop |
|---|---|---|
| clearcoatNormalMap off | **1.117 / 255**, max 138 | 1.796 / 255 |
| story/grunge layer off (reference scale) | 27.804 / 255 | — |

It is 25x smaller than the story layer, and it is still the wrong unit to spend. **The pixels it
moves are concentrated exactly where a broad key specular lands on a large flat plate** — with the
map on, the highlight breaks into a fine orange-peel; with it off, the same plate reads as an
unbroken sheet of glass. That is the shot the lighting axis is trying to improve, so dropping it to
buy a shadowed key would take back part of what the key is being added for.

**Spend the ORM redundancy instead** — `aoMap` and `metalnessMap` are separate sampler uniforms
pointing at the texture `roughnessMap` already binds, and the fragment patch already rewrites all
three from that texel. Two free units, one more than the light needs, and bit-identical output by
construction.

## The ORM fold, shipped and measured: "bit-identical by construction" is 3 pixels

The two units are freed. `Materials.js` drops the `aoMap` and `metalnessMap` bindings on every
`StoryPhysicalMaterial` whose ORM texture they shared with `roughnessMap`, and `StageFloor.js` does
the same for `arena.floorWet`; both read the occlusion and metalness channels out of
`texelRoughness` in the fragment patch that was already rewriting all three values.

| | kb.armor | arena.floorWet |
|---|---|---|
| before, in the fight scene | 15 | 15 |
| after | **13** | **13** |

**"By construction" was worth checking, and it is very nearly literal.** One page session, one frozen
frame, sim clock zero, `setGrade({grain: 0, chroma: 0})`, pixels read straight off the drawing
buffer with `gl.readPixels` so nothing is resampled or re-encoded on the way out. The shader is
toggled between the folded build and a control arm that puts the bindings back and suppresses the
folded reads — the material exactly as it was — and the pose cannot move because the frame never
unfreezes. Grabs A / B / A':

| | mean | pixels differing by >= 1, of 2,073,600 | max |
|---|---|---|---|
| 02-closeup-face, fold vs control | 0.00001 / 255 | **3** | 4.3 |
| 01-hero-idle, fold vs control | 0.00028 / 255 | **89** | 62.3 |
| either shot, fold vs fold | **0.0000 / 255** | 0 | 0 |

The same-arm floor is *exactly* zero, so those handful of pixels are real and not session noise.
They are isolated 2-6 pixel clumps sitting on specular highlights, and their count varies run to run
(89 and 118 on two hero runs) — the signature of a last-bit difference in a varying slot or a fused
multiply-add landing on a knife-edge highlight, not of a shading change. For scale, the best
frame-to-frame reproducibility this harness has ever reached on a matched pose is 0.235/255; this is
three orders of magnitude under it.

**Method note worth reusing: toggle in ONE session rather than comparing two runs.** The pose lottery
of round 17 cannot enter, and the noise floor is zero rather than 0.235.

**Two corrections to the round brief.**

1. **`arena.floorWet` was never the second blocker it looked like.** It fails only against a shadowed
   light that reaches the arena — which is how it was first measured, with probe spots on the default
   layer. The keys that actually shipped live on `SPLIT_LIGHT_LAYER`, and the split beauty pass masks
   that layer out of the arena half, so no arena program ever compiles a spot shadow sampler. Its
   fold is headroom, not a prerequisite. Freeing a unit on a material is only worth anything if the
   light can reach it.
2. **The units were the cheap half.** Two shadowed spot keys fit comfortably (`kb.armor` 15 of 16,
   0 of 184 programs over) and three still fit (16 of 16, exactly). The frame does not. On
   01-hero-idle, three runs a side:

   | | median | fps | draws | tris |
   |---|---|---|---|---|
   | fold only, keys off | 13.8 / 14.0 / 14.1 ms | 71-73 | 275 | 936k |
   | fold + two shadowed keys | 15.3 / 16.7 ms | 60-65 | 327 | 1316k |

   The fold itself is free — slightly faster than the 14.4 ms baseline, which is what two fewer
   texture fetches per fragment should do. The keys are not: +52 draws and +380k triangles for the
   two extra shadow passes, and one run of the pair landed on **59.9 fps**, under the constraint.
   (Several agents were driving browsers on this machine, so read these as an upper bound on cost.)
   A third shadowed light is reachable in samplers and should be assumed unaffordable in milliseconds
   until someone measures it.

---

# The occluder sweep: the tool that would have found the pole 23 rounds earlier

Built by the vault workstream while siting its own set. It rasterises every stage mesh against the
fighters' **real projected footprints** across a sweep of **legal fight-camera poses**, and reports
the fraction of the subject each mesh covers.

It found four occluders in a brand-new arena, **three of which were invisible in every capture that
had been taken of it** — they only appear in legal-but-unphotographed poses. That is precisely the
class of defect the pit arena carried for twenty-three rounds: a black rigging leg through a
fighter's torso, present in `06-stage-wide` and absent from `01-hero-idle`, found eventually by a
critic who happened to be looking at the right frame.

**Two corrections it needed before it generalised, both worth inheriting.** Triangles straddling the
lens smear across the frame, so rejection has to happen in view space. And the subject must be the
fighters' actual projected footprints, not a fixed screen box — otherwise a wall *beside* a cornered
fighter is scored as an occluder.

**Three findings that are really one rule.** A curve is not sited by its endpoints, it is sited by
its extent: a cable authored as two clear anchors plus a 0.35 sag fraction dipped to y 0.55, nearly
two metres below its lower anchor, putting 45.2% of its vertices inside the play volume. Two more
pieces of set sat *inside* the ±9 play bound where a fighter could walk through them. And a tank
wall grazed the lens at 0.2 m because `TANK_FRONT` was 9.4 while the fight camera reaches z 13 —
**the room stopped before the camera did**, which is the same repair `StageStructure#outerShell`
already documents.

**Run this against the pit.** It is the highest-value unclaimed job on the stage axis: the pole is
known, but nothing has ever swept that arena for the other three-quarters of the class, and by
construction those defects are the ones no existing shot can see.

## The sweep's verdict on all three arenas

`scratchpad/occluders.mjs` — 80 framings per arena, 0.6–2.7 s each. It builds the arena's modules
directly and projects triangles on the CPU against capsule proxies; **it has no renderer**, so it
answers *"is it in the way"* and never *"does it look wrong"*.

```
cistern      clean    worst  1.5%
skydeck      FAIL     worst 15.5%   arena.rooftop.foreground
sublevel09   FAIL     worst  100%   arena.structure.foreground, 4.8% at WIDE
```

**The pit hides a fighter completely at a legal corner pose.** Pre-existing, in the arena every
score in this project has been measured on, and worse than the pole that was found by luck. No shot
in the list poses the fighters there, which is exactly why twenty-four rounds never saw it.

**Four bugs in the tool itself, three of which only surfaced when it was run against arenas it was
not written for** — the argument for running a harness somewhere new before trusting it:
fill the triangle rather than its bounding box (the floor apron is a 160 m plane drawn as *two*
triangles, so every fighter came back 85% occluded by the ground he stands on); interpolate depth
perspective-correctly, since linear is wrong by metres on a plane seen at a grazing angle, which is
how a floor is always seen; apply each mesh's object transform, or a fan positioned 13 m behind the
pit is tested at its centre; and re-derive midpoint and separation after clamping fighters to the
play bound, or the lens is placed for a pair that is not there — which reads exactly like a set
defect.

## A multiplicative wash cannot light a surface that is at zero

The vault's soffit uplighters measured as doing nothing, and the cause was the operator, not the
drive: `dst = dst * src` models *more incident light on something already lit*. **Three times
nothing is nothing.** The measurement showing no movement was the correct output of a term that
could not work.

Converted to additive, with better physics than it was pretending to: the biggest, brightest surface
in that room is standing water with strips raking across it, and **the first bounce off water goes
up**. The ceiling now carries the moving caustic of the water below — which is the signature image
of a flooded cistern, and it ties that band to a fourth hue bin because the deposit is blue-green.


### The pit's occluder, with the geometry to fix it

`node tools/occluders.mjs sublevel09` — the harness now lives in `tools/`, not a scratch directory,
because it is the only thing that can see this class of defect and it was one `rm` from being lost.

```
worst offender  arena.structure.foreground   100.0% worst, 4.8% at WIDE
pose            fight  x -7.7  z +5.5  sep 1.8
camera          -7.09, 1.31, 9.64   fov 33.3
fighters        (-8.6, 5.5)  (-6.8, 5.5)
offending tris  min(-7.69, 0.00, 7.06)  max(-6.11, 1.49, 9.08)
```

The stanchion-and-rope run sits at **z 7.06–9.08 with the camera at z 9.64 and the fighters at
z 5.5** — directly between lens and subject — and spans **x −7.69 to −6.11**, which is inside the
±9 play bound. A fighter driven into that corner stands behind it.

The rule the vault workstream derived applies exactly: **outboard beats forward.** An object at
lateral offset L leaves frame when L > 0.70·D, so moving it outboard of the play bound makes it
*safer* as the camera closes, whereas pulling it back in z does nothing at a corner pose. The vault
moved its own piers to ±10.9/11.2 for this reason.

Not fixed here: moving set geometry changes the composition of `06-stage-wide`, which is the frame
the highest-scoring axis is judged on, so it wants a before/after capture rather than a blind edit.
The measurement above is everything needed to make it a small change.

## Triangle budget: blown, and by how much

Measured after the arena work landed, single-shot run with no arena swap involved:

```
before the arenas   ~939,000 tris   274 draw calls
after               1,317,810       326 draw calls
charter ceiling       900,000
```

**+378,000 triangles, 46% over the ceiling.** This is not the swap leaking — a run that never
changes arena reads the same, so the geometry is in the base scene. Frame time still holds at 15.0 ms
median / 66.7 fps, so the 60fps constraint is met and this is a budget breach rather than a
performance one.

Worth stating plainly because the number has now crept **three times without anyone owning it**:
901k, then 939k, now 1.32M. Each increase was individually defensible and nobody was tracking the
sum. Either the ceiling is wrong and should be raised deliberately with a stated reason, or the
arenas need a decimation pass — but drifting past it a fourth time is how a constraint stops meaning
anything.

---

# The new arenas scored WORSE than the pit. My theory was wrong.

Two critics, blind, each re-scoring the original pit **in the same pass** as a control:

```
skydeck   70    pit re-scored 72
cistern   61    pit re-scored 74
```

The theory behind building them was that eight rounds of plateau were the *venue* — a closed box
lit from above, judged against references that ship varied venues — rather than the tuning. **It is
not.** Both new arenas lose to the one we have been tuning, one of them by thirteen points.

The control is what makes this trustworthy. Both critics marked the pit DOWN, from 76 to 72 and 74,
so they were harsher across the board — and the new venues still lost. Without re-scoring the pit
in the same pass, a 70 would have looked like a near miss instead of a defeat.

**What the gap actually is, stated better than any round has managed:**

> The reference's LEAST detailed ninth of frame (0.0836) is more detailed than Knockbots' MOST
> detailed ninth (0.0764). Neither venue comes within 2.4x of the reference in any band.

Every other finding is downstream of that. Hue concentration, layer count, missing reflections,
haze — all symptoms of *not enough differentiated material at every distance*. The reference earns
depth by putting individually-varied stuff at each depth; we earn it by putting blur on flat
coloured boxes. That is a content-density problem, and no lighting, tuning or venue change reaches
it.

**Each new venue does own exactly one thing the pit structurally cannot**, and both are currently
squandered. Skydeck has real atmospheric perspective — far/near luminance-std 0.76 against the
reference's 0.71, where the pit manages 0.92 and never could, because a closed box has no horizon.
Having bought that horizon it then puts nothing on it: no cloud, no sun position, no skyline
warmth, untextured solid-fill slabs where the city should be. Cistern has a continuous specular
plane at grazing incidence across ~45% of frame — a full-frame mirror a dry plate deck cannot
produce at any tuning — and does not use it to reflect the fighters.

**And a real defect, found only at magnification:** a hard-edged translucent quad lies across the
centre of the skydeck fighting plane, x777–1208, a 2.2x luminance step with flat plateaus either
side whose edges cut across plate seams at angles no floor geometry follows. At 1x it reads as a
vague smear. No score above 80 is available while it renders.

---

# Round 25: I sent a round after a number that came from one image

The block above states the gap as "the reference's LEAST detailed ninth (0.0836) is more detailed
than Knockbots' MOST detailed ninth (0.0764)" and calls it *the* finding, with every other symptom
downstream of it. Two agents then spent a round attacking it.

**It reproduces against one reference out of ten.** Recomputed independently, mean |grad| on luma,
all images resampled to 1920x1080, thirds-of-frame:

```
                    least ninth   median ninth   most ninth
tekken8_07             0.0834        0.1376        0.1596     <- the source of 0.0836
tekken8_01             0.0457        0.0630        0.1092
tekken8_10             0.0373        0.0812        0.1157
tekken8_08             0.0316        0.0605        0.0968
tekken8_02             0.0289        0.0554        0.0757
tekken8_04             0.0151        0.0620        0.1177
tekken8_03             0.0133        0.0305        0.0663
tekken8_05             0.0128        0.0239        0.0778
tekken8_06             0.0104        0.0298        0.0665
tekken8_09             0.0015        0.0160        0.0626
reference median       0.0220
Knockbots 06-wide      0.0296        0.0425        0.0796
```

Our floor is **above** the reference median floor. One of ten references beats our ceiling with its
floor, and that one is a 2.1x outlier over the whole set — a midday outdoor farm shot, the densest
image in the folder by a wide margin. "The reference" was one frame.

This is the round-4 impact-timing failure repeating in a different subsystem, and it is the third
time on this project that a confident number has sent work in a direction the evidence did not
support. The lesson is not "measure" — the round did measure. It is **that a statistic over a
reference SET must be reported as a distribution, and a claim that names "the reference" singular
is a claim that has not looked at the spread.**

The density work still shipped and still helped, because the weaker true version of the finding is
real: our *ceiling* is short. At 32px block granularity — which resolves hot spots that a 640x360
ninth averages flat — our p90 block gradient is 12.70 against 21.81 and 24.12 for two references.
We are now evenly mediocre rather than patchily mediocre. A uniform procedural octave raises the
whole histogram and by construction cannot produce a hot spot.

## The manifest could certify a run it never looked at

`--shots 01-hero-idle` overwrote `shots/manifest.json` with `complete: true`, `defects: []` and one
entry, next to 19 stale PNGs from an earlier run. Both stage critics scored 06-stage-wide,
18-skydeck-wide and 19-cistern-wide against a manifest that vouched for them and had never opened
them. `complete` was written as the literal `true` and the short-run warning was explicitly
suppressed whenever `--shots` was passed.

Third defect of this class (c562242: two runs sharing a directory; 965f3c7: a crashed run leaving a
successful-looking manifest). The common root, now fixed: **`complete` was an assertion the writer
made about itself rather than a fact derived from the run.** It is now derived from the shot list,
records `only` and `missing`, and cannot be asserted.

## 48.1 fps in the manifest, 65.8 fps in the game

The full 20-shot pass reported 20.8ms median / 48.1 fps — below the charter's 60fps floor. It is
not a rendering regression:

```
single shot, current build        15.2ms  65.8 fps
single shot, repeat               15.3ms  65.4 fps
three wides, two arena switches    14.7ms  68.0 fps    (rules out arena accumulation)
single shot immediately after      15.4ms  64.9 fps    (rules out thermal throttling)
07-super + impacts + hud           14.9ms  67.1 fps    (rules out the heavy-effect shots)
full 20-shot pass                  20.8ms  48.1 fps
```

No individual shot or pair reproduces it; it is cumulative. Renderer resources across the same
comparison: geometries flat at 168, programs 163 -> 164, **textures 125 -> 137**. Twelve leaked
textures should not cost 17ms a frame on their own, which points at the leak pushing a shader past
the texture-unit ceiling documented earlier in this file rather than at the memory itself.

**This is player-facing, not just harness-facing.** A player who runs twenty matches in a session
walks the same path the capture harness does. The perf number the dossier has been quoting all
along is the end-of-run number, so every fps figure in the project history is a twenty-match figure,
not a fresh-load one.

---

# Round 26: I was wrong about the frame time, and about what was eating the shadows

Two claims in the section above are retracted, both mine.

**"Textures 125 -> 137 ... points at the leak pushing a shader past the texture-unit ceiling."**
Wrong, and disproved four independent ways. 300 deliberately orphaned bone-shaped textures — 25x
the observed leak — measured 18.00ms against 17.60ms for the disposed arm, with `programs` at 163 in
*both*, so there is no recompile and no driver fallback. Closing the leak left the full run at
20.7ms, unchanged. `renderScale = 1` alone reproduces 21.8ms in a page that has run no shots at all.
And mechanically it never could have been true: an orphaned bone texture belongs to a `Skeleton`
that is in no render list, so it is never bound to a sampler unit, and sampler counts are fixed when
the program links. One state-walk reached **155 textures at 14.4ms** — eighteen more textures than
the "failing" run and six milliseconds faster.

**"Every fps figure in this project's history is a twenty-match figure, not a fresh-load one."**
Also wrong, and wrong in a more interesting way. It is not cumulative at all. `tools/capture.mjs`'s
`pinTicks` block set `renderScale = 1`, `adaptiveResolution = false` and zeroed the grade's grain,
and **restored none of it**. `02-closeup-face` is the only shot with `pinTicks` and it is shot
number *two*, so from that point the whole run — and the end-of-run perf probe — rendered at native
1920x1080 instead of the high tier's 1632x918. Per-shot trace: `fresh 0.81 -> 01-hero-idle 0.81 ->
02-closeup-face 1 -> 1 for all seventeen remaining shots`. A step change at shot 2, which is exactly
why no subset I tried reproduced it: none of them included `02`.

```
renderScale 1.00 (what the harness left behind)   21.80ms   45.9 fps
renderScale 0.85 (tier max, what ships)           16.80ms   59.5 fps
renderScale 0.81 (fresh equilibrium)              16.00ms   62.5 fps
renderScale 0.72 (tier floor)                     13.80ms   72.5 fps
```

The pipeline's own published curve says 1.00 -> 20.4ms and 0.80 -> 15.4ms. The manifest's 20.8 and
the fresh 15.2 land on those two rows. **The whole 5.8ms gap was resolution.** I also reported that
gap as "17ms" in the section above; it was never more than 5.8. The full pass now reports 60.2 fps,
and the manifest records `renderScale` and `pixels` beside the number, because an fps figure without
the resolution it was taken at is not a measurement.

The leak is real, and it is innocent. `THREE.Skeleton` lazily allocates a 16x16 RGBA float bone
texture the first frame a rig is drawn, freed by `Skeleton.dispose()` and by nothing else — not by
`robot.dispose()`, not by removal from the scene, and nothing in the repo had ever called it. Ten
from the roster lineup, two per character change, nine once per page load from the menu warm-up.
Fixed as a correctness matter with the measured frame-time benefit — zero — written into each
comment so nobody re-derives it as a performance win. A real twenty-match player session, driven by
synthetic keyboard events rather than by the harness, held textures flat at 127 throughout and never
reproduced the collapse.

## What was actually eating the shadows

8.30% of the wide frame at or below linear 3e-4, against a reference range of 0.000–1.633% across
all ten images. Every candidate in the brief was eliminated by measurement, one knob per arm on a
frozen frame:

```
SPLIT/ARENA layer masking   not it   fillLight is on GLOBAL_LIGHT_LAYER; both halves see it
GTAO zeroing ambient        not it   blendIntensity 0.92 -> 0 moved the metric the WRONG way
scene.environmentIntensity  not it   zeroing it: 3.9% -> 4.1%
hemisphere fill strength    not it   fill x10: 3.89% -> 3.74%. No leverage at any strength.
grade LUT toe               THIS     LUT bypassed: 3.2% -> 0.002%, darkMed 0.0057 -> 0.0180
```

The grade LUT's shadow segment is a straight line `pivot + (v - pivot) * contrast` clamped at zero.
With `pivot 0.42, contrast 1.45` it reaches zero at display **0.1303** — thirteen percent of the
range, where the file's own comment claimed the bottom two percent. Modelled through the whole pass,
**every scene-linear radiance below 1.94e-2 left as exactly (0,0,0)**: 127,051 pure-black pixels in
06-stage-wide against 645 in the blackest reference. The hemisphere fill delivers about 1e-3 — a
factor of twenty *below* the clip — which is the complete explanation for why adding light did
nothing, and why five rounds of lighting work never moved this number.

**The lesson generalises past this bug.** Four rounds treated a black frame as a lighting problem
because black looks like missing light. It was an output-transform problem, and no amount of work
upstream of a clamp can be seen through it. Before attributing a tonal complaint to the lighting
model, check what the transform does to the range in question — the check is cheap and it would have
saved four rounds.

`environmentIntensity x2` does reach the reference median darkMed of 0.01407, and was **rejected on
measurement**: it drops figure/ground 3.4 -> 2.343, a 31% loss, and lifts the frame median 61%. That
is the recorded answer to "why not just add ambient".

## Gate 4 was a badly-posed gate, and the disproof is worth more than the fix

The brief demanded the wall band 14–42px below the strip light show 2.5x top-to-bottom falloff, up
from 1.16x, as proof an emissive quad had become a light. It was not met, and should not have been
asked for. Raycasting the band shows **every pixel in it hits `arena.motes`, a volumetric sheet
~2m in front of the wall**, or an emissive wash card at z -8.28. Two `RectAreaLight`s hugging the
back wall moved the ratio 2.151 -> 2.118, and at thirty times strength -> 2.044: they raise top and
bottom together, because the motes sit between the wall and the lens. Adding light cannot move this
ratio.

Worse, the metric is framing-fragile: the identical scene reads **1.04** on `06-stage-wide` (strip at
row 402) and **2.15** on the frozen probe (strip at row 416). A fourteen-pixel shift doubles it,
because the band contains structural panels rather than a falloff. Under this round's own rule, the
1.16 baseline was a single-frame reading of a quantity with 2x spread from framing alone. **A gate
has to be robust to the framing before it can be a gate.**

## The gate I quoted was measuring the HUD

Both critics found this independently, and I confirmed it. The round-26 commit reports
`% <= linear 3e-4: 8.300 -> 0.072`. That 0.072% is 1,494 pixels, it is **identical to four decimals
across every shipped fight shot**, and all of them lie on a single scanline: `y = 72, x 83..1820`, a
1px black rule inside the HUD nameplate bar.

```
06-stage-wide    full 0.0720%   rows containing black: [72]   scene rows 175-960: 0.0000%
01-hero-idle     full 0.0720%   rows containing black: [72]   scene rows 175-960: 0.0000%
18-skydeck-wide  full 0.0720%   rows containing black: [72]   scene rows 175-960: 0.0000%
19-cistern-wide  full 0.0720%   rows containing black: [72]   scene rows 175-960: 0.0000%
03-full-body     full 0.0720%   rows containing black: [72]   scene rows 175-960: 0.0000%
```

Two consequences, in opposite directions. The fix is **better** than it was reported: the scene's
own figure is 0.000%, not 0.072%. And the gate is **dead as an instrument** — it has a hard floor
set by a UI element the renderer cannot influence, so any future round that "improves" it below
0.072 will have changed the HUD, and comparing 0.072 against the reference median of 0.121 compares
a HUD rule against reference scene content. Crop to rows 175-960 before computing anything in this
class, or retire the gate.

This is the same failure as the fps figure earlier in the round: **a number that nobody had checked
was measuring what it claimed.** Twice in one round, in two different subsystems.

## What the toe cost, which the lighting axis did not see and the stage axis did

The toe fix moved lighting 74 -> 77 and stage 74 -> 74, and the stage critic found why: it traded a
clipped shadow for a **plateaued** one. On frozen-frame pairs with a bit-identical null arm,
HUD-cropped:

```
dark-quartile local contrast, wide   3.168 -> 2.274   -28%
dark-quartile local contrast, hero   3.442 -> 2.414   -30%
whole-frame local contrast, wide     4.117 -> 3.754    -9%
the 8-48 code band the toe rewrote   3.443 -> 2.495   -28%
share of that band locally flat      2.61% -> 11.36%
```

Independently reproduced here at coarser precision (unmatched poses, JPEG before): `lc_dark` 18.571
-> 12.102 on the wide and 15.331 -> 13.093 on the hero. Same direction, same order.

Both wide-frame figures crossed a boundary: before the change `lc_dark` 3.168 and `lc_all` 4.117 sat
just **inside** the matched-framing reference floor (3.133 and 4.037); after, both are outside it.
The 81,119 recovered pixels now sit at display luma mean 13.88 with sd 1.85 and local contrast 1.264
codes against 3.338 for the whole frame. **The black was not hiding stage geometry. It was hiding an
unlit flat.** An area that read as "the renderer gave up" now reads as "unlit floor" — worth
something, and correctly not worth a point on stage detail.

## The reference set is wrong for the stage axis, which is round 25 wearing different clothes

Of the ten references, only **three** (02, 06, 07) are wide or full-body in-match framings. Six are
character closeups where the stage is a deliberately defocused backdrop, and one (10) is the Fight
Lounge hub, not a fight stage at all. Every "we sit inside the reference range" claim on a detail or
dark-quartile metric has been carried by those defocused members:

```
lc_dark floor, full ten references        2.500   (tekken8_09 -- a bokeh ruin behind a fur collar)
lc_dark floor, matched framings only      3.133
our five shots                            2.104 - 3.074
```

We pass against the first floor and fail against the second. Round 25's lesson was "report the
distribution, not one member". The sharper form: **the distribution has to be over a comparable
subset.** Averaging a defocused closeup backdrop into a stage-detail reference is the same error as
quoting one outlier, and it flatters us by about a point of floor.

## Both critics now name the same mechanism, from different axes

Lighting: only **12.79%** of the arena floor's illumination comes from a source that can cast a
shadow. Environment/PMREM, the hemisphere fill, the emissive washes and the mirror are all
shadowless by construction, so a cast shadow is bounded at ~13% contrast before anyone authors one,
and lands at 8.68% over 1.48% of the floor. The fighters are not standing in the arena's light, they
are composited onto it.

Stage: the shadow band has level but no **modulation** — a uniform fill adds level, not local
variation, which is exactly why multiplying the hemisphere by ten moved nothing.

These are one finding seen twice: the arena's light is overwhelmingly shadowless, so neither contact
darkening nor grazing modulation can exist at any tuning. That is the first time two axes have
converged on a single mechanism, and it is a stronger signal than either score.

# Round 27: a wall-falloff gate the framing cannot move

Round 26 retired gate 4 with the right verdict — *"a gate has to be robust to the framing before it
can be a gate"* — and left the replacement unbuilt. This is the replacement, and the measurement
that it is one.

## Definition

1. **The samples are fixed world points on the barrier face**, not a pixel rectangle: a
   0.10 m x 0.012 m grid over `x` +/-8.4, `y` 0.32-1.24 at `z` -8.60, 13,013 points, projected
   through whatever camera the shot happens to have. The old gate averaged rows 14-42 px below the
   brightest row, which is why fourteen pixels of camera move doubled it.
2. **Linear Rec.709 luminance, median per world-height bin** — 18 bins across the 0.9 m below the
   tube. The barrier is not one material (a full-width hoarding runs from `y` 0.42 to 0.90), so the
   median makes each bin one material instead of averaging concrete with vinyl.
3. **Least-squares fit of `ln(median)` against world height**, reported as `exp(slope * 0.9)` — the
   fitted top-to-bottom ratio over that 0.9 m — together with the fit's `r2`. A falloff is a *trend*;
   `r2` is what tells you whether the band you are quoting a ratio for has one.
4. **The gate is that reading divided by the same reading with the wash switched off**, on/off inside
   one frozen frame. That is the discipline the rest of this round already uses, and here it also
   divides out the wall's own albedo steps and its view-dependent shading.

## Framing robustness, measured

One frozen session, fighters hidden, the camera moved around the point it is looking at, null control
between two untouched grabs **0.0/255**. The strip light's own row moves from 279 to 544 — a 265-pixel
range, nineteen times the fourteen-pixel shift that broke the old gate:

```
framing     strip row   OLD gate   world-anchored  r2      pass-off   GATE (on/off)
ref             416       2.713        2.307      0.445     0.980        2.353
near            411       2.467        2.441      0.443     1.059        2.304
far             420       2.862        2.320      0.439     1.010        2.297
low             544       2.685        2.733      0.452     1.147        2.383
high            279       2.848        2.045      0.337     0.870        2.352
near-low        523       1.820        2.285      0.337     0.918        2.488
far-high        281       2.642        2.005      0.350     0.891        2.250

OLD screen-space gate        1.820 .. 2.862    spread x1.57
world-anchored, raw          2.005 .. 2.733    spread x1.36
world-anchored, on/off       2.250 .. 2.488    spread x1.11
```

**World-anchoring alone is not enough, and the pass-off column says why.** The unlit wall's own
vertical trend runs 0.870 at the high camera to 1.147 at the low one: a third of the raw metric's
spread is real view-dependent shading of the concrete, not instrument noise. Dividing by it takes the
spread from x1.36 to x1.11 — and the residual x1.11 is over camera moves far larger than any shot
list would contain. Across the three arms that only change distance, the gate reads 2.297-2.353,
x1.02.

## It also has to discriminate, or it is just a stable number

Same rig, one framing, sweeping the wash card's near-field parameter live on its uniform (null control
0.0/255 again):

```
  k       falloff   r2      gate (on/off)
  1.00    1.503    0.118       1.316      <- the plateau this round replaced
  0.60    1.682    0.178       1.473
  0.45    1.800    0.220       1.577
  0.35    1.876    0.243       1.642      <- shipped
  0.28    1.905    0.245       1.668
  0.20    1.893    0.226       1.658
  0.12    1.743    0.164       1.527
```

The gate separates the shipped profile from the one it replaced by 25%, and it turns back down at both
ends — the flat lift above `k` 0.6 and the collapse-into-the-first-ten-centimetres below `k` 0.2. Its
optimum is a broad plateau from 0.20 to 0.35; the shipped 0.35 is within 1.6% of the peak, and a third
instrument (evaluating the profile analytically, no renderer involved) puts the same optimum at 0.28-0.35.
Three routes, one answer, is the reason to believe it.

## What this gate still cannot do

- `r2` on the **pass-off** arm is 0.000-0.013. The gate is a ratio of two mean trends, and only the
  numerator's trend is well explained; the denominator is a mean slope through a band whose variance
  is dominated by material steps. It is a sound correction, not a fitted model.
- It is one arena, one mood, one wall. Nothing here says the same construction transfers to the
  cistern or the skydeck without re-picking the world band.
- `r2` should be quoted with every reading and treated as the validity flag. Below about 0.15 the band
  has no trend to have a ratio of, which is the state the old gate was in when it was being quoted.

## Three ways this rig lied before it told the truth

Worth recording, because each failure produced a *plausible* number.

1. **Seven framings, seven bit-identical rows.** `cinematic()` sets targets that the camera's own
   `simulate`/`render` integrate — and the freeze stubs both, so every reframe was a no-op and the
   rig reported the old gate as perfectly framing-stable. **A robustness test that returns identical
   numbers is far more likely broken than perfect.** The fix is to move `camera.position` directly.
2. **54,281 of 54,281 raycast hits landed on `arena.practicals.wash`** — the multiply card hanging
   34 cm in front of the barrier. The first sampling pass measured the uniform it was trying to
   evaluate. Excluding transparent, non-depth-writing surfaces fixes it.
3. **Then every hit landed on `arena.structure.backdrop`, 100 m behind the wall.** The set is merged
   one mesh per material, so the barrier's concrete belongs to an object whose bounding box spans the
   whole arena; a bounding-box filter cannot find it and silently selects the scenery behind it.

Raycasting is also not free here: against the merged set meshes it costs roughly **24 ms per ray**, so
a 25,000-ray sampling pass is a ten-minute stall. The shipped rig raycasts nothing — a world grid on a
known plane is what "attached to the wall" means, and it costs milliseconds.

---

# Round 28: twenty-eight rounds of scores, computed against frames that no longer exist

Animation 63 -> 67, stage 72 -> 73, character 70 -> 69, impact 69 -> 66.

## The structural defect, found by the character critic

`.gitignore` line 5 was `shots/`. That pattern matches `docs/shots/` as well as `shots/`, so **not
one capture from any round in this project's history survives in git.** Every question of the form
"did this axis fall because the work got worse, or because the frame it is scored on changed?" has
been unanswerable by construction for twenty-eight rounds, and would have stayed unanswerable.

Fixed to `/shots/`, so only the working capture directory is ignored. `docs/shots/` is now tracked
and carries an `ARCHIVE.json` recording rev, base commit, resolution and per-frame byte counts.

## The archive was also the wrong resolution, which faked a catastrophe

`docs/shots/` was exported at 1280x720 while `shots/` delivers 1920x1080. Run naively on identical
crop coordinates, the stage critic's nine deck crops read:

```
-68.9%  -56.0%  -59.8%  -55.9%  -85.3%  -56.9%
```

Scale-matched, the same crops read **+5.7% / +1.3% / -0.0%**. A critic quoting the first table would
have led with the total destruction of the floor detail, and it does not exist. The impact critic hit
the same thing from the other side: a pixel-coordinate ROI landed on background in one of the two
resolutions and returned `ink=0.000, N=0` on both flagship frames.

The archive is now exported at the delivered resolution. **A baseline at a different resolution from
the capture is not a baseline**, and this project has been computing four rounds of deltas against
one.

## The impact gate could never have been passed or failed by anyone

The handover gate was "discrete particle count 11-29 -> 35-152, size p90 under 35px, ink ladder
1.81x". It had no committed measurement script; "ink", "particle" and the ROI were all undefined; and
the stated before-figure of 11-29 **does not reproduce under any mask, threshold or ROI** the critic
could construct -- the same baseline measures 106-206. I passed that gate through into a briefing
without re-deriving it, which is rule 4 of my own preamble, three rounds after writing it.

The fine-particle population is REVERTED. It regressed the metric it was built to raise: discrete
component count fell on all three impact frames (-20%, -15%, -7%) and effect ink fell 10-13%, with
the fine end taking the worst of it at -47% on the flagship. The critic controlled for the resolution
trap by round-tripping through 720p and found the resampler's bias runs the *same* direction, so the
true drop is larger than quoted. Charter rule: ship the measurement, not the feature.

## What the animation diagnosis found, and why it is the round's real result

The rubric's own 90+ text for this axis is "the hips lead, the head lags. A strike drives from the
floor up." That is a claim about ORDERING, and it was measured directly through the offline rig
sampler across all 34 clips that declare an impact:

```
hips-peak -> tip-peak lag        median 0 ticks    20/34 tip peaks at or BEFORE the hips
chain concordance                median 0.50       pure chance; 17/34 below 0.5
hips speed at contact / own peak median 1.00       17/34 at >=90%
```

Nine clips peak **every link -- hips, spine01, spine02, chest, shoulder, elbow, wrist -- on a single
tick**. The pelvis is at its own top speed on the exact frame the fist lands, which is the opposite
of how a strike transfers momentum. There was no kinetic chain; the body was rigid.

The cause was localised in the data rather than guessed: round 11's re-key put "one key per tick from
the coil onward, on a t^p ramp whose exponent is solved per span so ~38% of the travel always lands
on the contact tick" -- solved per span and applied to every driving bone, so they all arrive
together. It bought the contact-frame speed it was written for and flattened the chain doing it. And
the existing `whip()` operator structurally cannot fix it: its taper is `d * (1 - k.t / T)`, which is
**zero at the pivot**, so it can separate two bones mid-startup and never at contact, for any W.

The new `lead()` operator advances the proximal chain and holds the authored contact value, so the
contact pose is bit-identical by construction. Verified across all 92 clips: **0 bones drifted,
0.000000 mm**, and no move's startup, active or recovery count changed.

```
chain concordance                0.50 -> 0.74
hips->tip lag                       0 -> 4 ticks
hips speed at contact            1.00 -> 0.00
chain runs backwards/simultaneous  17 -> 2
hips at >=90% of peak at contact   17 -> 0
contact-frame ratio / follow-through      held
```

## The gate set was incomplete, and one clip paid for it

`p.siegeSlam` took a 10-tick budget and its acceleration sign reversals along the approach went 2 ->
12 -- a 6x increase in velocity sawtooth on a 48-tick approach, accounting for +10 of the +6 net
across all 34 attacks. The declared gates were contact-frame ratio, follow-through and hurtbox
travel; **approach smoothness was not among them**, so the operator bought chain ordering by spending
the exact quantity the rubric down-scores as "linear interpolation". Disabled for that clip pending a
re-sweep with smoothness gated; the other 27 keep their gains.

## The axis is scored on one clip out of ninety-two

`17-anim-strip` drives `forceHit({move:'launcher'})`, which resolves to `p.uppercut` -- and so do
`04-impact`, `05-juggle` and `07-super`. Ninety-two clips were diagnosed, twenty-eight changed, and
every capture in the project photographs the same one. Worse, `p.uppercut` received the *smallest*
fix in the file: a reduced two-bone chain on a 0.5-tick budget, +1 tick of head lag against a +4
median. **The round's median gain is invisible in all four evidence frames.** That is why the axis
moved 4 points and not 10, and it is a harness limit rather than an art limit.

Also: I briefed `11-anim-roundhouse` as evidence and **it has never existed in the shot list** --
`git log -S` returns nothing. The only copy on disk is a one-off from `tools/animstrip.mjs` dated
before every animation edit this round, so judging on it would have judged round-20 animation. And
the manifest cannot catch this: `complete` validates the list against *itself*, so a shot that was
never registered can never be reported missing. That is the round-27 defect in a new dress --
certification can detect a corrupt present entry, never an absent one.

---

# Round 29: the evidence instrument had been degraded to protect the perf instrument

Animation 67 -> 66, impact 66 -> 67, character 69 -> 69, stage 73 -> 73. Flat. The findings are not.

**First, a correction of mine.** I committed a29's fix work with a message saying "the critics never
ran" because the workflow's output file was 0 bytes when I looked. It filled later; all four critics
ran and scored. The scores above are theirs. Nothing was invented, but I asserted a negative from a
single observation of a file that was still being written -- the same single-sample error this
project keeps paying for, made about my own tooling.

## Twenty of twenty-five frames were rendered sub-native and scored against native references

Per-shot `res`, measured across a full pass:

```
distinct renderScales   0.72 0.76 0.77 0.80 0.81 0.84 0.85 1.00     (a 1.39x span)
adaptive live           17 of 18 shots
03-full-body            renderScale 0.81   rendered 1555x874
19-cistern-wide         renderScale 0.72   rendered 1382x777
```

Every one written to disk as 1920x1080 by the viewport screenshot, then scored against native-1080p
Tekken references. And because the adaptive controller was live, the scale was set by whatever the
machine's frame timing happened to be -- so it is not reproducible between two runs of the same
build. Three critics found it independently; one had two of its three assigned shots at 58-66% of
the pixels they claimed.

**The cause was mine, in round 26.** I made the `pinTicks` teardown hand the renderer settings back,
because one frozen shot was leaving the whole run at native and corrupting the end-of-run fps probe.
That fixed the perf instrument and silently degraded the evidence instrument for every other shot.
It is the same shape as five other findings here: **a change that protects one measurement while
quietly breaking another, with nothing gating the second.**

Fixed by pinning native with the controller off before every shot, re-asserted per shot rather than
once at startup because a tier change or a pinTicks teardown silently lapses a single pin. The perf
probe re-pins to the TIER scale afterwards -- the two instruments want different resolutions, and
each now records which it used.

## The chain metric awarded its maximum to the failure it exists to catch

`peaks[i].c <= peaks[j].c` counted two links peaking on the SAME tick as correctly ordered. So a move
whose every link peaks simultaneously -- the purest possible pose-to-pose robotic motion, and exactly
what the metric was built to detect -- scored a perfect 1.00. Verified on jab2 (clip `p.straight`):
1.00 under the tie rule with all ten pairs tied, 0.00 under a strict one. Across 211 moves, tie rule
median 0.70 against strict median 0.10. **Essentially the entire round-28 "improvement" lived in the
tie rule.**

Ties now score nothing and are reported separately as `tiedPairs`, because "0.4 with 60% ties" and
"0.4 with everything strictly ordered but half backwards" are different animation problems that one
number cannot distinguish.

Related and also mine to own: round 28's headline "median hips->tip lag 0 -> 4 ticks" does not
reproduce. The true median over 211 moves is 0, with 150 at or below 0; **4 is near the top of the
distribution, not the middle.** A maximum was reported as a median. That is the fourth consecutive
round launched on a figure that did not survive re-derivation.

## The frame archive: two rounds of fixes, neither of which took

Round 28 correctly diagnosed `.gitignore: shots/` matching `docs/shots/` too, and fixed the pattern.
But the archive was still exported BY HAND afterwards, so by the next round it was certifying
`baseCommit 7ac3fb2` against frames produced by a commit ninety minutes newer, holding 18 shots where
the run had 25, and recording every frame as 1920x1080 when they had rendered as low as 1382x778 --
the same error one level down from the one it was created to fix. One critic stated plainly that its
"no regression" finding was an assumption rather than a measurement, because no before-frame existed
in git at all.

**A hand-exported archive drifts by construction.** It is now written by the capture run itself, from
the same frames, with the commit READ (`git rev-parse HEAD`) rather than declared, plus a `dirty`
flag so a certification can never again name a commit that did not produce the pixels. It records the
size each frame was RENDERED at, not the size it was written at. Only complete runs archive.

First run of it archived 18 of 25 and the seven it dropped were the per-clip animation strips --
precisely the new evidence the animation axis is now scored on -- because they are written as JPEG
and the loop only re-encoded PNGs. Fixed.

## The impact gate was measuring armour

Round 28's gate defined effect ink as `luma > 0.90`. Scored against a per-pixel ground truth (the
same frozen frame rendered with FX visible and hidden):

```
16-impact-heavy   precision 0.375   recall 0.191
04-impact         precision 0.261   recall 0.151
04b-impact-decay  precision 0.045   recall 0.043
15-impact-light   precision 0.019   recall 0.077
```

Five pixels in eight it counted were not effect, and it missed four fifths of what was. The mask was
landing on Kestrel's near-white armour plates, panel-edge speculars, the damage badge and the ring
decal. Round 27's number did not reproduce; round 28's reproduces exactly and measures the wrong
object, which is worse. Every figure this axis carried is withdrawn -- including the deltas that
justified reverting the round-28 particle work, which sit an order of magnitude inside the
run-to-run spread.
