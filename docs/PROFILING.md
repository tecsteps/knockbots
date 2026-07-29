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
