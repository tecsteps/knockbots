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
