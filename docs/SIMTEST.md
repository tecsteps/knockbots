# Simulation testing

**How to verify gameplay without watching it.**

An agent cannot watch a fighting game. It can hold the simulation still, press a
button on frame 10, ask what frame 23 looked like, and require that the same
seed and the same input log produce the same answer every time. This document is
about the machinery that makes that possible, what each layer of it can prove,
and — at the end, at length — what it cannot prove and still needs a human for.

```
  node tools/simscene.mjs --determinism     the numbers          ~4 s, no browser
  node tools/simfuzz.mjs                    200 random runs      ~18 s, no browser
  node tools/simscene.mjs --shots           the pictures         ~8 min/scenario
```

---

## The layers

| Layer | Instrument | Cost | Catches |
|---|---|---|---|
| Static | `tools/check.mjs` | 3 s | broken imports, clips that do not validate, hitboxes on the wrong limb |
| Input | `tools/simgate.mjs` | 40 s | a keystroke that produces the wrong move |
| **Trajectory** | **`tools/simscene.mjs`** | **4 s** | **what the move then does: teleports, missed reactions, hits that land twice, loops that do not close** |
| **Exploration** | **`tools/simfuzz.mjs`** | **18 s** | **the same properties, over inputs nobody thought of** |
| **Vision** | **`tools/simscene.mjs --shots`** | **8 min** | **position jumps, missing limbs, clipping, a kick aimed backwards, a camera that changed its mind** |
| Human | a person, playing | — | everything below the "What this cannot verify" heading |

The three bold rows are what this document is about. The first two are described
in `docs/TESTPLAN.md` and in the header of each tool.

---

## The façade: `window.__GAME_TEST__`

Built by `makeGameTest` in `src/combat/TestHarness.js`, attached to `window` by
`Game.init`, and available in bare Node by handing `makeGameTest` a stub game.
QA-only: nothing on the gameplay path holds a reference or calls into it.

```js
__GAME_TEST__.reset({ seed, dist, cpu })   // known state, seeded, game loop paused
__GAME_TEST__.loadScenario('juggle')       // cast + spacing + seed + the whole script
__GAME_TEST__.input({ frame: 10, key: '2', action: 'down' })
__GAME_TEST__.step(90)                     // 90 fixed 60 Hz ticks, no clock read
__GAME_TEST__.stepUntil('hit')             // or 'state:d:hitstun'
__GAME_TEST__.getState()                   // serializable, both fighters
__GAME_TEST__.getMetrics()                 // aggregates over the run
__GAME_TEST__.getTimeline() / getEvents() / getInputLog() / digest()
__GAME_TEST__.saveState() / loadState(s)
__GAME_TEST__.captureFrame()               // PNG data URL — the ONLY call that renders
__GAME_TEST__.release()                    // hand the game back its own loop
```

Three properties are worth stating explicitly, because each of them is the
reason something else works.

**Inputs are filed under a FRAME, never a millisecond.** A test that says "press
punch after 200 ms" has an answer that depends on how fast the machine is. A
test that says "press punch on frame 12" has one answer.

**Synthetic input goes THROUGH `Input`, not around it.** The façade owns a
synthetic keyboard — a bare `EventTarget` plus a two-field `Event` subclass,
which is a complete keyboard as far as `Input` is concerned — and drives
`commandsFor` with it. Every direction flip, buffer entry and motion recognition
is produced by the code a real keystroke runs through. `tools/simgate.mjs` exists
because the last time this project tested the matcher instead of the input stack,
it reported 12/12 on a defect a player found in ten minutes.

**Rendering is opt-in.** Nothing above `captureFrame` touches the renderer, so a
run that never calls it never allocates a GL context. That is why the numeric
suite is four seconds and the picture suite is eight minutes a scenario, and why
you can afford to run the first one on every change.

### One code path, two hosts — and it is measured

The same `SCENARIOS` table drives both bare Node and a real browser page. The
browser run returns its own trajectory digest and `simshots` compares it against
the one Node computed. Those two processes share nothing but the source: a real
`RenderPipeline` and `Environment` against none, a real `Stage` with real arena
bounds against `stage: null`, a live `FightCamera`, and a JIT warmed on
completely different code.

Measured on `strike-connects`, seed 20260812:

```
[simshots] strike-connects: browser digest ef55cf48 vs node ef55cf48 — IDENTICAL
```

That is what makes "the frames the contact sheet is labelled with are the frames
the invariants were measured on" a measurement rather than a promise.

---

## Determinism

**It holds today, and here is how that is known.**

The doc comment on `src/core/Rng.js` has always said the simulation must be
deterministic. That is a requirement, not evidence, so it was tested rather than
believed. `simscene --determinism` runs three arms per scenario and diffs the
FULL trajectory — position to nine places, velocity, state, state clocks,
health, meter, current move, move tick, active hitbox count, current clip, both
fighters' generator states, and a root-relative pose signature — row by row,
reporting the first divergence field by field.

```
[simscene] PASS  determinism strike-connects   digest ef55cf48 x3 + interleaved + cold process ef55cf48, all identical
[simscene] PASS  determinism juggle            digest 027d1ab3 x3 + interleaved + cold process 027d1ab3, all identical
[simscene] PASS  determinism idle-loop         digest bd8f2917 x3 + interleaved + cold process bd8f2917, all identical
   ... 7 of 7 scenarios
```

- **x3** — three consecutive runs, including the FIRST. `tools/simgate.mjs`
  discards its first run, on the strength of a first-run divergence it traced to
  `Fighter#play`'s early return skipping the animator rewind in `reset()`. That
  has since been fixed in `Fighter#reset`, which now calls `Animator.reset()`,
  zeroes the animator clock and clears `currentClip` before rewinding. The rule
  is no longer needed here, and keeping it would hide a regression of exactly
  the defect it was written for.
- **interleaved** — every other scenario runs in between, then this one repeats.
  Both state leaks found while building this were cross-scenario; neither shows
  up when a scenario only ever follows itself.
- **cold process** — a child process is asked for the same seed and scenario and
  has to return the same digest. Rules out module load order and anything else
  settled before the first scenario runs.

No `Math.random`, `Date.now` or `performance.now` appears anywhere in a
`simulate()` path. Grepped across `src/combat`, `src/ai`, `src/core` and
`src/characters`: the only hits are the string "Math.random" inside two doc
comments, `Telemetry` (which is analytics, outside the sim), and `main.js`'s boot
clock. All randomness goes through `Rng`; `Fighter#reset` reseeds, `CPU`
reseeds off `roundStart`, and `CombatSystem` holds its own.

### Three leaks the harness found and closed on its own side

Each was found by running the same scenario four times in one process and
diffing field by field. Each is closed in `makeGameTest.reset()`, and none of
them required touching a file this workstream does not own.

1. **Meter carries across `reset()`.** `Fighter#reset` does
   `meter = min(meter, METER_MAX * 0.25)` on purpose — a fighter carries up to a
   quarter bar between the rounds of a match. Correct for a match, wrong for a
   test: a scenario that lands a blow banks meter and the next one starts with
   it, climbing 7.128 a run until it saturates at 25 four runs later. Every
   trajectory in between is a different trajectory, and a meter-gated move would
   start in one and refuse in another.
2. **`footState[side].y` is never reset.** It holds the previous tick's sole
   height, is initialised to 1 in the constructor, and enters a new round
   holding the last frame of the old one. `#trackFootfalls` emits `footstep` on
   a falling edge of `h - s.y`, so the first tick after a reset compares against
   a stale height.
3. **`Input`'s direction history is never pruned after a frame-counter reset.**
   `Input` prunes with `this.tick - hist[0].tick > INPUT_BUFFER_TICKS`; a reset
   puts the counter back to zero, that expression goes deeply negative, and the
   tail of the previous scenario sits inside the motion window of the next one
   forever. Measured: run 3 of `roundhouse-loop` turned a held BACK into a `bb`
   and started a **backdash on frame 0** — velocity -6.88 against -1.6, clip
   `loco.dashBack` against `loco.runBack` — and every invariant still passed.
   The harness now builds a fresh keyboard and a fresh `Input` per reset, which
   is the rule `simgate` already states for itself.

(1) and (2) are reported below as product findings. (3) is a property of reusing
one `Input` across resets and does not arise in the game, where the tick counter
only ever goes forward.

### Save states

`saveState()` captures every sim-visible field plus all three generator states.
That is a complete description of the SIMULATION but not of the POSE — the
animator carries springs, inertia, blend stacks, IK hold quaternions and a ripple
queue, none of it serialisable without reaching into `Animator`'s privates.

So the honest split, measured by `simscene --savestate`:

```
[simscene] savestate strike-connects   frame-0 reload EXACT   mid-run reload: 0.002183 m root, 0.9220 pose, state same
[simscene] savestate juggle            frame-0 reload EXACT   mid-run reload: 0.111338 m root, 0.0000 pose, state same
[simscene] savestate throw             frame-0 reload EXACT   mid-run reload: 0.069904 m root, 14.4470 pose, state same
   ... 7 of 7 EXACT at frame 0
```

**A frame-0 save state plus an input log is a byte-exact replay.** That is the
case a fuzzer repro bundle stores, and it is the one that matters. A mid-run
reload is a resume, not a rewind: the sim state is exact, the pose is rebuilt
from the clip, and the run drifts by the numbers above. Use it to jump to an
interesting moment; do not use it as the basis of a determinism claim.

---

## Scenarios, timelines, marks and invariants

`src/core/Scenarios.js` holds the whole table. Seven scenarios today:

| Scenario | What it is for |
|---|---|
| `strike-connects` | the baseline: one hit, one reaction, both back to idle |
| `strike-whiffs` | the control — proves the hit above came from the geometry |
| `juggle` | gravity, juggle decay, combo scaling, the airborne hurtbox |
| `throw` | the only path where damage lands with no `hit` event |
| `idle-loop` | four seconds of nothing, which catches the most per second spent |
| `dash` | added after the fuzzer found the largest root step in the game is a dash |
| `roundhouse-loop` | the longest startup, the largest excursion, a whole-body rotation |

### The timeline

One row per frame, written in the shape the request asked for — flat and
readable at the top level, complete underneath:

```json
{"frame":0,"state":"idle","x":-0.525}
{"frame":10,"state":"attack","x":-0.506,"move":"launcherPunch","moveTick":0}
{"frame":26,"state":"attack","x":-0.32,"move":"launcherPunch","moveTick":16,
 "active":2,"hit":true,"ev":["launch","hit","hitstop"],"dState":"launched"}
{"frame":62,"state":"idle","x":-0.491,"dState":"launched"}
```

`--json=docs/sim` writes both a compact form (only frames where something
changed, plus every frame carrying an event) and the full one, per scenario.

**Frozen frames.** Hitstop is not "the sim runs slower", it is "the sim does not
run" — `Game#frame` gates the accumulator on it. The façade reproduces the same
gate, so a run's frame count and its simulated-tick count are not the same
number and rows carry `frozen`. A `strike-connects` is 90 frames of which 5 are
frozen. Any invariant that compares adjacent frames skips across a freeze;
comparing over one would report every hit in the game as a teleport.

### Named moments

Every mark is DERIVED FROM THE TIMELINE, never hardcoded. A mark written as
"impact is frame 15" points at the wrong picture the moment a startup value
changes, and the picture is then evidence for a claim it does not support.

```
marks: start=0 beforeInput=9 press=10 moveStart=10 anticipation=16 impact=23
       maxExtension=29 recovery=31 moveEnd=40 returnToIdle=41 loopBoundary=89
```

`maxExtension` is the frame on which the strike capsule reaches furthest from
the attacker's own root — a measurement, which is why it is also the frame a
"the kick points the wrong way" defect is most visible on.

### Invariants

Fifteen checks, run per scenario, each reporting `measured` and `limit` whether
it passed or failed — a gate that only prints on failure gives you no way to see
a number drifting toward its limit until the day it goes red.

```
ok   rootStep               0.1102 m                              limit 0.35 m   a at frame 25
ok   facingSane             0 frame(s) facing away                limit 0
ok   defenderLaunched       2.025 m peak over 91 airborne frames  limit > 0.3 m
ok   footContact            0.0176 m above the deck over 48 planted frames  limit 0.08 m
ok   loopCloses             0.0314 of the pose spread             limit 0.35
```

The full list: `finite`, `inArena`, `scaleStable`, `rootStep`, `facingSane`,
`footContact`, `expectedHits`, `reactionWithinOneFrame`, `defenderUntouched`,
`defenderLaunched`, `defenderThrown`, `validStates`, `settles`, `noDrift`,
`loopCloses`.

**Every limit was measured before it was written down.** The measurement is
quoted in the comment next to it. Two of them are worth reading before changing
anything, because they encode a real property of the engine:

- `rootStep` skips frozen frames and is set per scenario from that scenario's own
  measured worst frame, at roughly 2.5-3.5x. It is a TELEPORT detector, not a
  speed limit; a limit tight enough to also catch tuning changes would fire on
  every balance edit.
- `loopCloses` does **not** compare the pose one loop period apart, which was
  the first version and is wrong. `idle.fight` is 108 ticks and does loop, but
  the pose is the clip PLUS a procedural stack (breathing, look-at, springs)
  that `Animator.simulate` drives off the absolute sim tick as a noise phase,
  and that stack has no period. Measured over 240 idle frames, the pose
  signature 48, 96 and 108 frames apart differs by 53.8, 55.7 and 47.5 against a
  total range of 67.6 — the "period" comparison measures the breathing. What a
  broken loop actually looks like is a RATCHET, so the test is the mean of the
  first half of the idle frames against the second, as a fraction of the run's
  own spread. Measured across the suite: 0.003 to 0.170; a real ratchet lands
  near 1. It is a coarse instrument and will not catch a two-millimetre mismatch
  at the seam — that one needs the contact sheet.

---

## The contact sheet

```
KB_CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  node tools/simscene.mjs --scenario=strike-connects --shots --cells=24
```

Writes to `shots/sim/`:

- `<scenario>-contact.png` — 12 to 30 cells, evenly spaced with every named
  moment forced in, each stamped with its frame number and mark. Even spacing
  alone misses the impact frame nearly always (a 90-frame scenario sampled 20
  ways steps 4.7 frames; the active window is two), and a contact sheet without
  the impact frame cannot answer the question it is being asked.
- `<scenario>-<frame>-<marks>.png` — full resolution at each named moment.
- `manifest.json` — the frame list, both digests, and every console/WebGL error
  the page emitted. That last one is the only place in the harness where a
  shader failure or a lost context can be seen at all; the numeric layer has no
  GL context to lose.

Frames are read through `RenderPipeline.screenshot()` rather than
`page.screenshot()`, for the reason `tools/scenecap.mjs` gives: the pipeline
renders and reads in one task and never touches the compositor, which is roughly
an order of magnitude faster on a software rasteriser and is the same pixels,
because the read happens after the post chain. Measured on this machine, under
swiftshader with other work running: **446 s for 24 cells at 1280x720**, i.e.
about 18 s a frame. That is the entire justification for keeping the numeric
layer renderer-free.

---

## The fuzzer

```
node tools/simfuzz.mjs                     # 200 runs x 300 frames, ~18 s
node tools/simfuzz.mjs --runs=600 --frames=600 --cpu=8
```

Random seeded input logs, judged only on the properties that must hold no matter
what a player does: `finite`, `inArena`, `scaleStable`, `rootStep`,
`validStates`, plus two watchdogs (`noStuck`, `noConsoleNoise`). A random input
log has no intent, so "the hit lands exactly once" is not a property of it.

The generator is **not uniform noise**. Noise that flips every key every frame
starts almost no moves — the matcher wants a direction held for a few frames and
a button pressed on a fresh edge. The model holds a direction for a burst, taps
a button with a real down/up edge, occasionally holds guard, and occasionally
does nothing. Coverage is reported every run, so a fuzzer that has stopped
reaching the game is distinguishable from a healthy green:

```
[simfuzz] coverage: 3158 distinct move(s) started across the run set, 1028 hit(s) landed
[simfuzz] GREEN — 600/600 runs clean in 105.0s
```

### Turning a fuzzer failure into a regression test

A red run writes `shots/fuzz/s-<seed>/`:

```
repro.json     seed, dist, cast, cpu level, root-step limit, the recorded
               digest, the input log as PHYSICAL key edges, and the frame-0
               save state
report.json    every invariant with its measurement, plus anything thrown
timeline.json  the full state trajectory
events.json    the named event log
console.txt    console warnings and errors, and the stack if it threw
REPRO.md       these instructions, pre-filled with the seed
```

**Step 1 — confirm it is a real, reproducible failure.**

```
$ node tools/simfuzz.mjs --repro=shots/fuzz/s-11
[simfuzz] replaying seed 11, 300 frames, 66 key edges, rootStep limit 0.3 m as recorded
[simfuzz] digest a596419f vs recorded a596419f — IDENTICAL
          FAIL rootStep           0.3907 m                          limit 0.3 m
[simfuzz] STILL FAILS — the bundle is a live regression test
```

The digest line is the important one. `IDENTICAL` means this is the recorded
run, not a similar one. If the digest moved, the replay is not faithful and
nothing below it can be trusted — check the seed and the cast first.

Exit code 0 means it still fails; **2 means it has stopped failing**, which is
news either way: either it was fixed, or the replay stopped being faithful.

**Step 2 — make it permanent.** Copy `inputLog` from `repro.json` into a new
entry in `SCENARIOS` (`src/core/Scenarios.js`) with the same `dist` and `frames`:

```js
'regression-s11': {
  what: 'Found by the fuzzer: a backdash covers 0.391 m in one frame. …',
  p1: 0, p2: 1, dist: 3.421, frames: 300,
  script: [ /* inputLog, verbatim */ ],
  expect: {}, move: null,
  invariants: ['finite', 'inArena', 'scaleStable', 'rootStep', 'validStates'],
  tune: { rootStep: 0.3 },
},
```

The physical key codes replay as-is — `physicalFor` passes an unrecognised token
straight through, which is exactly why the log stores codes rather than the
facing-relative tokens that produced them. Then:

```
node tools/simscene.mjs --scenario=regression-s11
```

It is now part of the four-second suite, with a name, a `what` that says which
defect it is about, and a limit that goes red if the defect comes back.

---

## Findings

Four things this harness found in the engine while it was being built. None are
fixed here — three live in `src/combat/Fighter.js` and one in the animation
data, and this workstream does not own either.

**1. A dash is a lurch, not a slide.** Measured on a clean double-tap from a
standing start, per-frame root travel:

```
backdash  0.114 0.089 0.042 0.391 0.197 0.093 0.045 0.026 0.019 ...
forward   0.099 0.078 0.059 0.026 0.303 0.130 0.052 0.025 0.017 ...
velocity  -6.88 -5.50 -4.40 -3.52 -2.82 -2.25 -1.80 -1.44 -1.15   (backdash)
```

Velocity decays cleanly by a factor of 0.8 every frame in both cases, so the
lurch is not physics — it is clip root motion. One frame of a backdash covers
0.391 m, which is **23.4 m/s instantaneous and nine times its own neighbour**.
This is the largest single-frame root step in the game, larger than a launcher
(0.110) or a throw release (0.140), and it is a visible snap. Pinned by the
`dash` scenario at a 0.45 m limit so it cannot get worse unnoticed.

**2. Meter survives `reset()` and the carry is uncapped per call.**
`Fighter#reset` does `meter = min(meter, METER_MAX * 0.25)`, which is a
deliberate between-rounds carry. It also means a fresh round after a heavy one
starts with a quarter bar, and — for anything that resets repeatedly — the meter
climbs until it saturates. If the intent is "carry a quarter bar", the cleaner
expression is to set it rather than to clamp it.

**3. `footState[side].y` is not cleared by `reset()`.** It is the previous tick's
sole height, initialised to 1 in the constructor and never touched by `reset()`,
so a new round's first tick computes its footfall edge against the last frame of
the previous round. Cosmetic — it can only add or swallow one `footstep` event —
but it is a state leak across a round boundary in a file whose own comments make
a point of enumerating them.

**4. The first five frames of every round have both boots off the deck.**
Measured on every scenario, the lowest sole height after a stage or a `reset()`:

```
frame  0      1      2      3      4      5      6+
       0.155  0.141  0.126  0.110  0.095  <0.05  ~0.009 median
```

That is the plant ramp doing exactly what it is designed to do, seating the feet
over five frames. It is also five frames at the start of every round where the
fighter is standing 15 cm above the floor. Whether it reads on screen is a
question for the contact sheet and a human; the number is here so somebody can
ask. The `footContact` invariant skips those frames for this reason, and says so.

---

## What this cannot verify

**This is the important section.** Everything above is a machine checking
properties a machine can state. The following are not among them, and a green
run across every layer is not evidence about any of them.

**Whether it is fun.** No invariant here has an opinion about whether landing a
launcher feels good. The `juggle` scenario proves a launcher connects, that the
victim reaches 2.0 m, and that a follow-up lands on the descent. It cannot tell
you that the two-second hang time makes the combo feel floaty, or that the
recovery is so long that nobody will ever use the move.

**Whether the difficulty is right.** The fuzzer can run the CPU at level 8 for
600 runs and report that nothing broke. It cannot tell you that level 8 is
unbeatable, that level 3 is insulting, or that the curve between them is wrong.
`CPU.js`'s own comments contain several tuning decisions that were made by
measuring behaviour rather than by playing against it, and they say so.

**Whether the frame is readable in chaos.** The contact sheet is one attacker,
one defender, a clean camera and no HUD. A real frame has two supers, a
shockwave, sparks, a wall splat, damage numbers and a health bar draining. The
question "can a player still see which limb is about to hit them" cannot be
asked of any artefact this harness produces.

**Emergent exploits.** The fuzzer presses random buttons for 300 frames. A human
looking for an infinite will find a two-move loop and repeat it a hundred times,
which is a search this fuzzer is not performing and would not recognise if it
stumbled into it — no invariant here says "this combo should end". Loop-finding
over the timeline is the obvious next layer and does not exist yet.

**Balance.** Nothing here compares two characters. `probeMoves` and `probePlay`
in `TestHarness.js` answer "does this connect"; nothing answers "does this
connect for the right amount", or whether one archetype's `df+2` is strictly
better than another's.

**Anything that needs a GL context, except in `--shots`.** A shader that fails to
compile, a texture that leaks, a material that renders black, a context loss
under memory pressure: the numeric layers have no renderer and cannot see any of
it. `--shots` collects console and WebGL errors into its manifest, and that is
the only coverage they get here. `tools/scenegate.mjs`, `tools/shadowgate.mjs`
and the rest of the visual gates are the instruments for that.

**Audio.** Nothing in this harness listens.

**Anything past the frame budget.** The longest scenario is 240 frames and the
longest fuzz run 600. A full three-round match is roughly 5400 ticks plus round
transitions, and drift, leaks or state carry over that distance are not covered.
`Fighter#reset`'s own comments record two round-boundary divergences found by
`tools/dtgate.mjs`, which is the tool that does look at that distance.

**Two-character matchups other than the first pair.** `setCharacter` rebuilds
both rigs, which costs more than the entire fuzz budget, so the cast is fixed.
`--cast=a,b` runs a targeted pair; there is no sweep.

---

## Files

```
src/core/Scenarios.js        the scenario table, the marks, the invariants
src/combat/TestHarness.js    makeGameTest — the __GAME_TEST__ façade
src/core/Game.js             attaches window.__GAME_TEST__ (QA-only, one way)
tools/simscene.mjs           the scenario gate: timelines, invariants, determinism
tools/simshots.mjs           the browser half: contact sheets and named frames
tools/simfuzz.mjs            the seeded fuzzer and the repro replayer
```

```
npm run simscene         node tools/simscene.mjs --determinism
npm run simscene:shots   node tools/simscene.mjs --shots
npm run simfuzz          node tools/simfuzz.mjs
```
