# Knockbots — queued work

Directives from the user, in the order they were given. Round 7 is in flight; everything below
it is queued.

## Round 7 — in flight

Driven by the user playing the deployed build.

- **The UI hang.** "It puts pressure on the CPU and also hangs for some seconds." A
  multi-second stall is a defect, not a polish item. Strong candidates already located: four
  `void el.offsetWidth` animation-restart idioms in `HUD.js`, each forcing a synchronous
  document reflow, firing on hit flashes and combo counters; a `getBoundingClientRect()` in the
  damage-callout path; 38 `createElement` calls. None of those explain a *multi-second* freeze
  on their own, so the agent is instrumented to find the real stall rather than fix the
  suspects and declare victory.
- **Character select.** "Too poor." `MenuSystem.js` contains no `WebGLRenderTarget` and no 3D
  rendering at all, though the charter specifies 3D previews. Ten characters with distinct
  palettes, chassis and stats, almost none of which reaches the screen.
- **Render profiling.** Per-pass millisecond table, not a verdict. Framerate has fallen 74 -> 20
  since project start.
- **Animation**, still the lowest axis, plus the queued spring-bone fixes.

## Round 8 — asset-authoring push (user: "Yes, not accepted")

Character rendering (60) and stage detail (74) both returned honest plateau calls: the
remaining gap needs content, not tuning. The user has asked for that content rather than
accepting the ceiling.

**Character** — the critic's named requirements: per-character hero geometry rather than ten
recolours of one product family (one unmistakable head, one dominant torso mass, one landmark
silhouette element, character-specific limb topology), judged on a designed 100-pixel
silhouette. Plus geometry-aware surfacing: the plate detail atlas is currently universal and
shared across the whole roster, so grooves bear no relation to actual plate boundaries.

**Stage** — clothed skinned crowd meshes with pose and costume variation, replacing the
instanced proxies; a prop kit with real fabrication detail (bolts, welds, brackets, conduit,
floor drains, legible signage); two or three receding silhouette layers behind the crowd.

## Round 8 — mobile gameplay (user request)

**This is gated on the performance work and it would be dishonest to pretend otherwise.** The
game currently runs at ~20fps at 1080p in headless capture on an M-series laptop. Mobile GPUs
are far weaker. Shipping touch controls onto the current renderer would produce something
unplayable, so the profiling round has to land first.

What mobile needs, beyond the frame budget:

- **Touch controls.** A fighting game cannot use a generic virtual d-pad — the move list is
  authored in Tekken notation with four limb buttons, motion inputs and string continuations.
  Either a four-button layout with a movement stick and gesture-recognised motions, or a
  redesigned simplified input scheme. This is a design decision, not a port.
- **A real mobile quality tier.** Auto-detected, aggressive: reduced shadow resolution, most of
  the post stack off, lower particle budgets, reduced render scale.
- **Layout.** Landscape orientation handling, safe-area insets for notches, HUD scaled for a
  small screen at arm's length rather than a monitor.
- **Input latency.** Touch adds latency that a frame-data-driven game feels immediately.

## Standing instructions

- Deploy to Vercel after every iteration and surface the link on the artifact.
- Maintain the artifact as a living dossier: decisions, progress over time, screenshots.
- Codex (GPT-5.6 Sol) is available as an independent second opinion and as a second blind
  judge. It sees images genuinely and scores 10-25 points harsher than the in-family critics.
  Never give it a leading prompt — it invents a plausible specific when told a defect exists.

## Known gap in the loop

Critic findings live only in workflow journals under `~/.claude`, so each round's agents cannot
read the previous round's reasoning and partially re-derive it. Persist verdicts into the repo.

---

## Performance: the actual causes (Codex GPT-5.6 Sol review, verified)

An independent review by a second model, run directly rather than through a wrapper, and
spot-checked against the code. It corrected my own hypothesis: I had blamed forced layout
reflows in the HUD, and those turn out to be cheap.

**The steady frame cost is lighting, not geometry.** Eight live `RectAreaLight`s expand every
forward material shader. Removing them takes the measured frame from **41.8 ms to 16.1 ms** —
about 3.2 ms per light, 25.7 ms total. Adding them back in pairs measured 16.1, 22.2, 27.4,
32.9, 41.8. That single change is the difference between ~24 fps and inside 60 fps, with no
change to geometry. Verified: `Environment.js` constructs them from three call sites.

Not worth pursuing, per the same review: halving the 4096 shadow map produced no measurable
gain, the shadow pass is under 1 ms, planar-reflection downsampling saved almost nothing until
visibly poor, particles are already instanced, and 411–558k triangles sits well under the 900k
budget. **The game is light-shader-bound, not triangle-bound.**

**The multi-second freeze is a synchronous GPU readback disguised as UI work.**
`HUD.#capturePortrait()` calls `readRenderTargetPixels()` twice during the first HUD render of a
match. The readback flushes the whole GL queue: **316–1382 ms each, so 632–2764 ms for two.**
That matches the reported symptom exactly. The rendering itself is 0.4–0.9 ms. An async path
now exists but the synchronous fallback remains. Verified at `HUD.js:664`.

**A real configuration defect.** `MenuSystem.#setQuality()` calls only
`game.renderer.setQuality()`. `Environment.setQuality()` and `Stage.setQuality()` both exist and
are never called, so selecting "low" still runs all eight area lights and the reflection.
Wiring the existing tiers is worth ~19 ms on low and ~6.4 ms on medium. Verified.

**Wasted work.** `Fighter.setCharacter()` has no equality check, so `startMatch()` rebuilds both
robots even when the same characters are already selected — 96–135 ms per fighter. Verified.
`TestHarness.rosterLineup()` builds all ten robots in one loop, measured at 2.236 s, which
contaminates headless captures.

**Why the fps figures were erratic.** `RenderPipeline.#recordFrame()` reports a rolling average
of the last 48 wall-clock intervals between render calls — not GPU timing — and the capture
script interleaves match restarts, roster builds, forced combat states and Playwright
screenshots, giving some shots only 1.8 s to settle (fewer frames than the reporting window).
Those numbers were never comparable steady-state measurements. For a trustworthy figure: hold
one fixed fight state for 120+ frames after warm-up, take no screenshots in the interval, and
report CPU frame time and GPU timer queries separately as median and p95.

### Order of work

1. Cut or replace the six non-fighter area lights (~19 ms), keeping the two fighter softboxes.
2. Drop the synchronous portrait readback fallback; keep async, or cache portraits.
3. Wire `setQuality` through to `Environment` and `Stage`.
4. Equality check in `setCharacter`; cache or incrementally build in `rosterLineup`.
5. Replace the three zero-intensity `PointLight`s (~3 ms) with emissive sprites.
6. PCSS → PCF on lower tiers (1.8 ms).

---

## Select screen is not responsive (user-reported, mobile)

Diagnosed but NOT fixed here — `src/ui/MenuSystem.js` is owned by the character-select
workstream, which is mid-rebuild. Handing over rather than editing underneath it.

`.kbs-screen` is a fixed three-column grid:

```
grid-template-columns: clamp(18em, 29vw, 37em) minmax(0, 1fr) clamp(17em, 19vw, 26em);
grid-template-areas: "head head head" / "rack stage doss" / "foot foot foot";
```

The two flanks have hard `em` minimums — 18em + 17em = **35em before the centre column gets a
single pixel**. At the screen's own `font-size: clamp(13px, 1.12vw, 34px)` that is roughly
455px, so any phone narrower than that in portrait overflows, and the 3D preview column is
squeezed to nothing well before it.

There are only two `@media` queries in the whole file and **neither is width-based** — one is
`max-height: 840px` (hides tile frames) and one is `prefers-reduced-motion`.

What it needs:

- A width breakpoint that collapses the three columns to a single stacked column: roster,
  then preview, then dossier. Around 720px is the natural place given the 35em floor.
- `GRID_COLS` is hard-coded to 2 for the roster tiles; on a narrow portrait screen that wants
  to become a horizontally scrollable strip or a 3-4 column compact grid, since 2 columns of
  ten characters is a very long scroll on a phone.
- Landscape phones are the more important case for a fighting game (the fight itself is
  landscape) — 844x390 has plenty of width but only 390px of height, and `grid-template-rows:
  auto minmax(0,1fr) auto` with 1.8em padding leaves very little for the preview.
- Safe-area insets: the screen currently pads in `em` only, so on a notched device the rack
  column can sit under the notch in landscape.
