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
