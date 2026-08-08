# Knockbots — the gameplay test plan

The owner's brief for this round: *"Focus is on gameplay, not visual perfection."*
So nothing here scores a frame. Every test in this file asks one of five
questions — does the game work, is it fair, is it reachable, does the frame data
mean what it says, and does the same input twice give the same match — and every
test is written to be run without a renderer.

---

## 0. The standard, and why it is written this way

An earlier round audited the 12/12 state-by-button matrix by feeding a
hand-built input buffer to `findMove`. It passed everything. The real defect was
one layer upstream: `Input.commandsFor` pushes a fresh direction-history entry on
**any** tick a button is pressed, not only when the direction changes, so holding
down and pressing right-punch wrote `2` twice, `/2.*2/` matched, and the input
resolved as `dd` — a double-tap-down nobody entered. The move that came out was
`siegeSlam`, an **88-frame unblockable**, in place of `duckingStraight`. Holding
back did the same thing to the whole `b+` command column.

A synthesised buffer cannot contain that defect, because the defect is created
in the process of building the buffer. The lesson is in `Input.js` in capitals
and it is the rule this plan is built on:

> **Testing the matcher is not testing the game.**

Every test below therefore states **which layer it drives** and, explicitly,
**what that layer cannot catch**. A test that only exercises L0 or L1 is allowed
in this plan, but only if it says so and only if something else covers the same
ground end to end.

### The layers

| | Layer | What it is | What it structurally cannot catch |
|---|---|---|---|
| **L0** | Move data | `MOVES`, `defineMove`, `COMMAND_LIST` | Anything the engine does with the data. A move can be perfectly authored and never reachable, never connect, and play a different limb. |
| **L1** | Matcher | `findMove`, `parseToken`, `matchesEntry`, `gatherChord` against a supplied buffer | Everything that writes the buffer. This is the layer that passed 12/12 while the game shipped an unblockable on a held direction. |
| **L2** | Simulation | Real `Fighter.simulate` + `CombatSystem.simulate`, commands constructed in code | Everything that builds a `Command`: key mapping, facing conversion, direction history, motion recognition, touch. |
| **L3** | Real input path | Synthetic `KeyboardEvent`/gamepad snapshots/`TouchEvent` into a real `Input`, whose `Command` goes into a real `Fighter` | Browser-level behaviour: focus loss, OS gesture interception, real finger geometry, display refresh, thermal throttling. |
| **L4** | Browser | Playwright over the shipped page (`tools/touchgate.mjs`) | Nothing about frame data — it is far too slow and too noisy to measure ticks. |

**A test is only allowed to claim "the game works" if it runs at L3.** L2 tests
claim "the simulation works given a correct command". L1 tests claim
"the table is ordered correctly". Those are different claims and the report must
not blur them.

### Every test carries its own controls

This project has shipped nine instruments that were stable, reproducible and
measuring the wrong thing, and six more were caught by exactly this rule. So the
format below is mandatory and a test that cannot state both controls does not go
in the plan:

- **Positive control** — a named, minimal, revertible change to the *product*
  that the test **must** fail on. If the test still passes with the guard
  removed, the test is not measuring the guard.
- **Null control** — a run that must produce the **same** verdict (usually the
  same run twice, or an adjacent case that must *not* trip). If the verdict moves
  without the product moving, the instrument is noise.

I made this mistake myself while writing this file, and the trace is left in
§ FD-3 on purpose: my first advantage instrument held a standing guard against
every move including lows, so `lowKick` was recorded as "blocked at 0 frames
disadvantage" when it had in fact hit for 19 frames of hitstun. The number was
stable, reproducible, and about a different event than the one it was labelled.

### Already covered — deliberately not re-specified here

- `tools/check.mjs`: whole-graph syntax, per-module import, clip validation
  against the skeleton, `defineMove` schema validation, orphan clip references,
  **hitbox-anchored-to-the-wrong-limb** (the 0.35 travel-ratio gate), typeface
  binary structure, roster completeness.
- `tools/touchgate.mjs`: the touch *navigation* path (title → mode → inspect →
  lock → fight → menu → move list → leave), the 44 px floor, occlusion,
  portrait notice, the training panel path, plus its own null and hide-menu
  controls.

Where this plan touches those files it says so and only adds steps.

---

## 1. The rig

Everything marked *automatable now* runs in bare Node with no browser, no WebGL
and no GPU. This was verified while writing the plan, not assumed:

```
node <script>   # DOM shim as in tools/check.mjs, three imported from node_modules
```

- Two `Fighter`s construct and `init()` in **1.1 s total** — rig, robot mesh,
  animator, 22 hurtboxes each. `environment: null` is accepted.
- `f0.startMove(mv)` then stepping `f0.simulate(null); f1.simulate(cmd);
  combat.simulate(t)` produces a real `hit` on the bus with real damage
  (`jab`, 11.5, defender 180 → 168.5). The capsules, the animator, the retime,
  the foot IK and the extracted root yaw are all the shipping ones.
- `new Input(fakeTarget)` accepts synthetic `{code, repeat}` objects through
  `addEventListener('keydown')`, so **L3 is reachable without a browser** for
  keyboard and gamepad. Touch needs a DOM and stays at L4.

This matters because `docs/PROFILING.md` records that a hand-rolled offline rig
sample reported `k.midKick` *overlapping* the defender by 14 cm while the
shipping game whiffed it at every range — the difference being the extracted root
yaw, which only exists once `Fighter` applies it. **The rule that came out of
that is do not reconstruct the pose outside the Fighter; step the real one.**
The rig above does exactly that, which is why it is worth the 1.1 s.

The proposed home for it is `tools/gameplay.mjs` (a runner with `--group=FD`,
`--control=<name>`, `--json`), reusing `check.mjs`'s DOM shim rather than
copying it.

**Do not run L4 tests while a capture is in flight.** Another agent may be
photographing; `touchgate` and `capture` both take the GPU.

---

## 2. Frame data integrity (FD)

Frame data is the game. These are the tests that decide whether the numbers on
the move list describe the object the player is holding.

### FD-0 — the finding this group exists to pin down

Measured while writing this plan, at L2, on Vulkan's 56-move table, both fighters
staged point-blank (1.04 m) with a guard held that matches the attack's height:

```
blocked moves measured: 45   match their printed onBlock: 0   differ: 45
delta (printed onBlock  -  measured advantage), histogram:
    +2: 13 moves    +3: 17    +4: 6    +5: 3    +6: 3    +7: 2    +8: 1
```

**Every blockable move in the set is between 2 and 8 frames less safe than the
move list says it is, and none is safer.** `jab` prints `+1` on block — a
plus-on-block jab, the foundation of every pressure string in the game — and
plays `-1`.

The cause is a convention mismatch, not a bug in any one move.
`MoveSchema.defineMove` derives `recovery = total - lastActive - 1` and
`onBlock = blockStun - recovery`, which is the Tekken convention and assumes
contact on the **last** active frame. `CombatSystem.#findConnection` resolves on
the **first** tick the capsules overlap. A closed form predicts the measured
number exactly for 43 of the 45:

```
measured advantage = blockStun - (total - contactMoveTick)
printed  onBlock   = blockStun - (total - lastActive - 1)
delta              = lastActive + 1 - contactMoveTick     ( = active span, at point blank )
```

The two exceptions are `pistonRush` and `overdrive`, both multi-window moves
where the later windows keep a hitbox alive past the first connection — which is
correct behaviour and a different question.

This is *one measurement at one distance*. At longer range the contact tick
moves later into the window and the printed number is approached from below. So
the honest statement is: **the printed on-block is a best case reached only at
maximum range, and at the range strings are actually thrown every move is its own
active span worse.** Whether that is a data fix, an engine fix or a display fix
is a design decision, not mine. FD-2 is the instrument that keeps whichever
answer is chosen true.

---

### FD-1 — Startup is the frame the hitbox appears

- **Drives** every move in the ten character sets (566 moves). Started through
  the real input path where the move is root-reachable (see IR-1), through
  `startMove` where it is not, with the reason recorded per move.
- **Layer** L3 where reachable, L2 otherwise. The report must split the two
  counts; a move measured at L2 has not been proven startable by a player.
- **Asserts** the first tick on which `fighter.hitboxes.length > 0`, counted from
  the tick `#startMove` ran, equals `move.startup` exactly. Zero tolerance —
  this is an integer counter, not a measurement.
- **Positive control** patch `MoveSchema.isActive` to test `tick - 1`. Every
  move must fail by exactly one. A control that fails *some* moves means the
  instrument is measuring a mixture of things.
- **Null control** run the group twice in one process and once in a fresh
  process; all three must produce byte-identical rows.
- **Status** automatable now.

### FD-2 — On-block advantage is what the data claims

- **Drives** every blockable move against a defender holding a guard whose
  stance matches the attack height (crouch guard for lows, standing for
  high/mid), at four distances (0.9 / 1.02 / 1.2 / 1.5 m) so the contact tick
  sweeps across the active window.
- **Layer** L2 for the sweep; L3 for a 20-move sample entered from the keyboard,
  to prove the L2 staging is not itself creating the contact tick.
- **Asserts** two separate things, reported separately:
  - **FD-2a (model)** measured advantage `== blockStun - (total - contactTick)`
    for every single-window move, exactly. A move that deviates has something
    else extending its recovery — a `finishClip`, a stray `#play`, a travel
    window — and that is a real bug in the state machine.
  - **FD-2b (truth in advertising)** measured advantage `== move.onBlock` at the
    range the move is designed to be thrown at. **This currently fails 45/45 on
    Vulkan** (FD-0). Until the design decision is made, this assertion is a
    *ledger*: the per-move delta is recorded, and the test fails on any delta
    that **changes** rather than on any delta that exists.
- **Positive control** add 3 to one move's `blockStun`. FD-2a must move by
  exactly 3 for that move and no other.
- **Null control** the same move measured twice at the same distance must give
  the same integer; and a move measured at 1.5 m must give a delta no larger
  than at 0.9 m (contact can only move later).
- **Status** automatable now.

### FD-3 — On-hit advantage, and the harness trap that goes with it

- **Drives** the same sweep against a defender who is **not** guarding.
- **Layer** L2, sample at L3.
- **Asserts** measured advantage `== hitStun - (total - contactTick)`, and the
  ledger against `move.onHit`. Counter-hit adds `COUNTER_STUN = 7` and must
  appear as exactly +7.
- **Positive control** set `COUNTER_STUN = 0`; every counter row must lose
  exactly 7.
- **Null control** **the guard stance must be swept as a control, not assumed.**
  Running the on-*block* sweep with a standing guard against a `low` records
  `lowKick` at 0 frames — a stable, reproducible number about an event that never
  happened, because a low beats a standing guard and the move hit. The test must
  assert the event it thinks it measured: a block row must have been produced by
  a `block` bus event, a hit row by a `hit` event. **A row whose event does not
  match its label is a harness failure, not a data failure.**
- **Status** automatable now.

### FD-4 — A punishable move is actually punishable

- **Drives** for every move printing `onBlock <= -10`: attacker throws it, the
  defender blocks, and on the first tick the defender is actionable the defender
  presses their own fastest move through the real input path.
- **Layer** L3 for the punish input; L2 for the setup.
- **Asserts** the punish connects before the attacker's move ends. Symmetrically,
  for every move printing `onBlock >= +1`, the same punish attempt must **not**
  connect. That second half is the null control and it is the more important
  half: a game where everything is punishable is as broken as one where nothing
  is.
- **Positive control** raise the defender's fastest startup to 60 ticks; every
  punish must fail.
- **Null control** the `onBlock >= +1` set, above.
- **Status** automatable now. Expect it to fail on the FD-0 finding: with the
  real delta applied, several moves that print as safe are punishable.

### FD-5 — The guard matrix, end to end

`CombatSystem.#guardResult` is nine lines and it is the whole defensive game.

- **Drives** the cross product of {high, mid, low, unblockable} attack heights ×
  {standing guard, crouch guard, crouch no guard, standing no guard, airborne,
  invulnerable, armour window, parry window} defender states, using real moves
  and real capsules, one representative move per height per set.
- **Layer** L2.
- **Asserts** the outcomes the header claims: standing guard stops highs and
  mids; crouch guard stops lows; mid beats crouch guard; low beats standing
  guard; a full crouch **whiffs** a high entirely (no `hit`, no `block`, and the
  attacker's window survives to connect later); airborne is never blocking;
  unblockable and `props.finisher` always hit; invulnerable consumes nothing.
- **Positive control** invert the `HEIGHT.MID` branch. Exactly the four mid rows
  must flip and nothing else.
- **Null control** the whole matrix run twice with the two fighters swapped
  (attacker index 0 then 1) must give identical outcomes — a side-dependent
  guard result is a facing bug.
- **Status** automatable now.

### FD-6 — Multi-hit bookkeeping and combo scaling

- **Drives** moves with more than one active window, and scripted 2–12 hit
  combos.
- **Layer** L2.
- **Asserts** at most one connection per `moveInstance:windowIndex` pair;
  `COMBO_SCALING` applied by hit index with the `MIN_COMBO_SCALE = 0.25` floor;
  `JUGGLE_DECAY = 0.86 ^ juggleCount` with the `MIN_JUGGLE_SCALE = 0.2` floor;
  total combo damage is monotone non-increasing per added hit beyond index 2;
  `comboEnd` fires exactly once per combo and its `hits` matches the count of
  `hit` events.
- **Positive control** remove the `connected` guard in `#findConnection`; a
  3-frame window must then deal 3 hits and the test must fail.
- **Null control** a single-window move must produce exactly one hit at every
  distance and every combo index.
- **Status** automatable now.

### FD-7 — Hitstop does not change frame data

`Game.#frame` freezes **both** fighters together and drains the freeze on the
sim's own `TICK_DT` clock, precisely because draining it per rendered frame made
the most feel-critical constant in the game a function of the player's hardware.
There is a documented intention to give the attacker and defender *different*
freeze lengths (`attackerTicks` / `defenderTicks` in the `hitstop` payload).
That change would silently alter every advantage number in FD-2 and FD-3.

- **Drives** the FD-2 sample through the full `Game` tick loop with hitstop live,
  and again with `HITSTOP` zeroed.
- **Layer** L2 plus `Game`.
- **Asserts** the measured advantage is identical in both runs.
- **Positive control** set `attackerTicks = ticks - 3` in the `hitstop` handler.
  Every advantage must shift by exactly 3 and the test must fail.
- **Null control** the same run at three different `dt` schedules (see DT-2).
- **Status** automatable now.

---

## 3. Input reachability (IR)

The ledger, from the shipped data:

| | count | notes |
|---|---|---|
| Moves in the ten character sets | **566** | of 777 total; the four archetype tables are bases, not played |
| String continuations (`followUp`) | 165 | absent from `__ordered`; reachable **only** through an opener's cancel window |
| Chords (2+ buttons) | 111 | `CHORD_TICKS = 4` |
| Motion specials | 126 | ff 24, bb 17, qcf 26, qcb 25, dp 16, dd 18 |
| `b+` column | 88 | the column the duplicate-history bug ate |
| Air-only (`requireAir`) | 59 | |
| Throws | 33 | all chords |
| Meter-gated | 14 | `startMove` returns early without meter — a move that never starts emits no event at all |
| Signature moves (`owner`) | 41 | 4 per character, 5 for Mantis |
| Finishers | 10 | one per character, 4-token sequences |

Two facts that fall out of that table and belong in the report rather than in a
test: `hcf` is recognised by `Input.#motion` and used by **zero** moves — either
a dead branch or a data gap; and `props.requireCrouch` is used by zero moves, so
"crouching limbs" means the `d+` notation column, not a stance gate.

### IR-1 — Every root move, from a real keypress, on a keyboard

**This is the test that would have caught the duplicate-history unblockable.**

- **Drives** for each of the ten characters and each root move in its set: real
  `keydown`/`keyup` events into a real `Input`, holding the notation's direction
  for 6 ticks (longer than `MOTION_WINDOW_TICKS = 14`? no — deliberately both
  6 and 20 ticks, see below), then the button, then three idle ticks; the
  `Command` from `commandsFor` goes straight into `Fighter.simulate`. The
  direction is held for two different lengths — see below — and both must give
  the same answer.
- **Layer** L3.
- **Asserts** `fighter.currentMove.id === move.id`. On a mismatch the report must
  name **the move that came out instead** — a shadowed input is not a dead
  button, it is a button bound to something else, and the id that came out is the
  entire diagnosis.
- **Hold lengths are part of the test, not a parameter.** The direction is held
  for 6 ticks (inside `MOTION_WINDOW_TICKS = 14`) and for 20 ticks (outside it),
  and both must produce the same move. `Fighter.#dashMotion` only rejects a
  manufactured dash within that window, so a bug in the other guard is visible at
  one hold length and invisible at the other. A sweep that picks one number picks
  which half of the defect it can see.
- **Positive control** two of them, run separately, because there are now **two
  independent guards** against this bug and no test proves both:
  1. delete the consecutive-duplicate filter in `Input.#motion`
     (`.filter((d, i, a) => d !== a[i - 1])`) — held-down + RP must resolve to
     `siegeSlam` (88 frames, unblockable) and the test must fail naming it;
  2. make `Fighter.#dashMotion` return `m` unconditionally — held-back + RP must
     resolve to a `bb+` move and the test must fail naming it.
  A guard that no test can distinguish from its own absence is not a guard.
- **Null control** the whole sweep run twice; identical verdicts. Plus: a run
  with the fighter facing left (`facing = -1`, i.e. player 2's side) must give
  identical results, because directions are facing-relative and a side-dependent
  reachability result is a `commandsFor` bug.
- **Status** automatable now. Verified: `new Input(fakeTarget)` plus synthetic
  key objects reproduces the exact evidence shape — held-down + RP currently
  gives `motion: null, notation: "d+2", buffer: "2,2"`. Note the buffer **still
  contains the duplicate**; only the dedupe downstream saves it. Assert on the
  move that comes out, never on the buffer.

### IR-2 — The same sweep on a gamepad

- **Drives** `navigator.getGamepads` stubbed to return a snapshot object per
  tick; axes past the 0.4 deadzone, D-pad buttons 12–15, face buttons through
  `PAD_BTN = {1:2, 2:3, 3:0, 4:1, 5:5}`, guard on button 6.
- **Layer** L3.
- **Asserts** identical move-per-input results to IR-1. A platform that reaches
  fewer moves than another is a reachability defect regardless of which is
  "correct".
- **Positive control** swap two entries of `PAD_BTN`; the affected limbs' rows
  must swap and the test must name the pair.
- **Null control** analogue stick at 0.39 must produce no direction and at 0.41
  must produce one — the deadzone is asserted rather than assumed.
- **Status** automatable now. `Input` polls gamepads through
  `navigator.getGamepads()` every `beginTick`, so a stub is enough; no browser.

### IR-3 — The 165 string continuations

- **Drives** the opener through the real input path, then the continuation's
  button on a tick inside `cancelWindow`, and again on a tick outside it.
- **Layer** L3.
- **Asserts** inside the window the continuation starts; outside it, it does not
  (the opener runs to completion). Also that a continuation written without a
  direction prefix comes out **while the opener's direction is still held** —
  that is what `asStep` in `matchesEntry` exists for and the failure mode is a
  whole string silently dying.
- **Positive control** force `asStep` to `false` in `findMove`; every string with
  a directional opener must die and the count must match the authored population.
- **Null control** the same continuation attempted with no opener running must
  never come out.
- **Status** automatable now.

### IR-4 — The 111 chords, including all 33 throws

- **Drives** both buttons at spreads of 0, 1, 2, 3, 4, 5 and 8 ticks, from
  neutral (fighter actionable) and from inside blockstun (fighter not
  actionable). Both orders.
- **Layer** L3.
- **Asserts** the chord comes out at spreads 0–4 and does **not** at 5+; from
  neutral the chord-upgrade path replaces the single-button move that started on
  the first press (`1` then `2` two ticks apart is a throw; ten ticks apart is
  the jab string).
- **Positive control** set `CHORD_TICKS = 0`. Every throw in the game must become
  unreachable and the test must report 33 losses — this is the shape of the
  defect where pressing 1+2 gave you a jab.
- **Null control** spread 8 must give the string, at every spread and both
  orders, on every set.
- **Status** automatable now.

### IR-5 — The 59 air-only moves

- **Drives** hold up for `JUMP_HOLD_TICKS = 7` through the real input path to get
  a genuine jump, then press at the apex.
- **Layer** L3.
- **Asserts** the air move starts; the same press on the ground starts nothing
  (or a different, named, grounded move); a tap of up (under 7 ticks) gives a
  sidestep and not a jump.
- **Positive control** invert the `requireAir` branch of `canUse`; all 59 must
  become groundable and the test must fail.
- **Null control** `TestHarness.stageAir` returns a boolean for exactly this
  reason — a probe that forces an air move from the ground measures a pose no
  player can produce, and `airKick` was scored that way. Any row where the
  fighter was not actually airborne is a harness failure and must be reported as
  such rather than as a result.
- **Status** automatable now.

### IR-6 — The `b+` column and the crouch column

The two columns with a shipped history of being bound to something else.

- **Drives** all 88 `b+` moves and the whole `d+` / `db+` / `df+` set, with the
  direction held for 4, 8, 16 and 24 ticks before the press.
- **Layer** L3.
- **Asserts** the plain directional move comes out at every hold length. A
  motion-prefixed move scores 100 against a single direction's 25, and
  `findMove` walks most-specific-first, so **any** `bb+`/`ff+` move the table
  gains silently eats the plain `b+`/`f+` move on the same button. That is the
  exact shape of "back + RP does nothing".
- **Positive control** IR-1's positive control 2 (`#dashMotion` neutered) must
  fail this test specifically on the `b+` rows.
- **Null control** a genuine double tap (direction released between taps) must
  still produce the `bb+` move at every hold length. The guard must not have been
  bought by breaking real dashes.
- **Status** automatable now.

### IR-7 — The 126 motion specials

- **Drives** each motion as a real direction sequence over ticks through
  `Input` — qcf as 2,3,6 with the button on the last, dp as 6,2,3, ff/bb as tap,
  release, tap — at three entry speeds (2, 4 and 7 ticks per direction) inside
  and outside `MOTION_WINDOW_TICKS = 14`.
- **Layer** L3.
- **Asserts** the motion move comes out inside the window and does not outside
  it. Report per-motion leniency in ticks; a motion nobody can enter at human
  speed is unreachable even though the recogniser is correct.
- **Positive control** narrow `MOTION_WINDOW_TICKS` to 4; the slow entries must
  all fail.
- **Null control** a sequence that stops one direction short (2,3 with no 6) must
  never produce the motion.
- **Status** automatable now.

### IR-8 — The 10 finishers

Sequences, from the shipped data: `d,b,d,2` (Vulkan), `f,b,f,3` (Kestrel),
`b,d,f,1` (Anvil), `d,f,b,1` (Seraph), `b,f,d,2` (Ronin), `d,f,d,4` (Mantis),
`f,b,d,4` (Nyx), `b,d,b,3` (Bastion), `d,b,f,3` (Axiom), `f,d,f,2` (Volta).

- **Drives** a real match to the condition — opponent under `healthPct` of
  `MAX_HEALTH = 180`, alive, and on a round that can decide the match if
  `finalRoundOnly` — then types the sequence on the keyboard.
- **Layer** L3, with the window opened by the real `CombatSystem`.
- **Asserts** six things, each separately reported:
  1. the window opens on the tick the condition becomes true, and **once per
     round** (`openedThisRound`);
  2. the sequence fires the finisher;
  3. a wrong press mid-sequence resets `index` to 0 and the window keeps running;
  4. the window expires after `spec.window` ticks and emits `finisherExpired`;
  5. **the last button does not also fire the ordinary move it is bound to** —
     `#consumePress` exists because `d+4` was firing the low sweep *and* the
     finisher, and the sequence read as two moves;
  6. the ordinary matcher can never start it (`FINISHER_STANCE`), including when
     the player is holding back and mashing, which is what `b,b,d+4` parsing its
     first token as a bare `b` would otherwise do.
- **Positive control** remove `FINISHER_STANCE` from the finisher's
  `requireStance`; assertion 6 must fail and the finisher must come out on a
  press made while holding a direction.
- **Null control** the same sequence typed while the condition is **false** must
  do nothing at all, and the ordinary moves those tokens are bound to must come
  out normally.
- **Status** automatable now.

### IR-9 — The 41 signature moves

- **Drives** IR-1, filtered to `move.owner`.
- **Layer** L3, plus an L0 check that `SIGNATURE_MOVES[characterId]` lists
  exactly the moves whose `owner` is that character (currently 4 each, 5 for
  Mantis) and that each appears in `__ordered` — the pinned contract's merge rule
  says the overlay must take part in the specificity ordering, not be appended
  after it, and an overlay that is appended is invisible to `findMove`.
- **Asserts** every signature move is reachable and printed.
- **Positive control** append one character move after the sort instead of taking
  part in it; that move must become unreachable and the test must name it.
- **Null control** an archetype move with the same `id` as an overlay move must
  resolve to the overlay (the contract's replace rule), verified by comparing
  the started move's `owner`.
- **Status** automatable now.

### IR-10 — The coverage ledger

The gate that stops a move quietly falling out of the game.

- **Drives** nothing; consumes the results of IR-1 and IR-3–9.
- **Layer** bookkeeping over L3 results.
- **Asserts** all 566 moves in the ten played sets are accounted for by exactly
  one of: root-reachable on keyboard **and** gamepad; followUp-reachable through
  a named opener; or listed in an explicit `KNOWN_UNREACHABLE` table with a
  one-line reason. **An unclassified move fails the run.** The `KNOWN_UNREACHABLE`
  table is the honest place for platform gaps (see TC-2) and it must shrink, not
  grow, without a stated reason.
- **Positive control** delete one move's entry from `__ordered`; the ledger must
  report exactly one unclassified move.
- **Null control** the ledger totals must be identical across two runs and across
  the keyboard and gamepad sweeps, apart from rows the gamepad genuinely cannot
  express.
- **Status** automatable now.

---

## 4. State machine (SM)

`STATE` has 22 members. The transitions live in `#updateState`, `applyHit`,
`applyBlock`, `beginThrow`, `beThrown`, `#breakThrow`, `#toKnockdown`, `#toKO`,
`#toNeutral` and `CombatSystem.#resolveWalls`, which is ten writers and no table.

### SM-1 — No illegal transition, ever

- **Drives** (a) a scripted battery covering every authored transition; (b) a
  seeded fuzz — 200 matches of 3600 ticks, both fighters driven by pseudo-random
  but *well-formed* `Command`s built by the real `Input` from synthetic key
  events, so the fuzz cannot manufacture a command shape the game cannot produce.
- **Layer** L3.
- **Asserts** every `from → to` pair observed at `#enter` is in an explicit
  allowed table. Notably: nothing may enter `ATTACK` from `HITSTUN`,
  `BLOCKSTUN`, `KNOCKDOWN`, `THROWN` or `KO`; nothing may leave `KO`; `LAUNCHED`
  may only become `JUGGLED`; a fighter in `THROW` and its partner in `THROWN`
  must enter and leave together.
- **Positive control** allow `#tickNeutral` to run during `HITSTUN`. The fuzz
  must find an `ATTACK` out of `HITSTUN` within the first few matches; if it does
  not, the fuzz is not exercising the game and the fuzz is the thing that is
  broken.
- **Null control** the same seed must produce the identical transition multiset
  (this doubles as a determinism smoke test — see DT-1).
- **Status** automatable now.

### SM-2 — Throw break

- **Drives** each of the 33 throws, with the break buttons pressed on every tick
  from 0 to `duration`, plus the wrong buttons, plus nothing.
- **Layer** L3.
- **Asserts** a break lands only inside `breakWindow`; both fighters leave in
  `BLOCKSTUN` with 16 ticks and are separated by `radiusA + radiusB`; a back
  throw's window is clamped to 7 ticks and its damage scaled 1.25; `throwBreak`
  and `parry` both fire (FX and audio only know the canonical list).
- **Positive control** widen `breakWindow` by 10 ticks; the boundary rows must
  move by exactly 10.
- **Null control** the wrong button inside the window must never break.
- **Status** automatable now.

### SM-3 — A throw never pays out as an unblockable strike

The regression with the sharpest teeth. `#resolveThrow` refuses an airborne,
juggled, downed or backdashing defender and returns **without consuming the
window**; `#findConnection` then ran on the same tick with the same move, and
`#guardResult` answers `'hit'` for `props.throw` before it tests guard. A grab
the throw system had explicitly rejected paid out as unblockable damage — `1+2`
into a juggle was free, guaranteed and un-defendable.

- **Drives** every throw against a defender in each of: airborne, `LAUNCHED`,
  `JUGGLED`, `KNOCKDOWN`, `WAKEUP`, backdashing (`throwInvuln > 0`),
  `invulnerable`, `THROWN`, `KO`, and normal — at six distances spanning
  `throw.range`.
- **Layer** L2 (the states are set by real prior events, not by assignment).
- **Asserts** the count of `hit` events whose `move.props.throw` is truthy and
  which were **not** preceded by a `beginThrow` on the same move instance is
  **zero**, across every cell.
- **Positive control** remove `if (move.props.throw) return null;` from
  `#findConnection`. The count must go positive. The move data was also fixed —
  the vestigial capsule now sits behind the fighter's own spine — so the control
  must be run with a capsule moved back in front, otherwise it proves only that
  the geometry is currently unreachable. **A hitbox that is only unreachable by
  geometry is one anchor edit away from being reachable again, and nothing
  fails if it is.**
- **Null control** a legitimate throw against a standing defender must still
  produce `beginThrow` and its damage at every distance inside range, and nothing
  at all outside it.
- **Status** automatable now.

### SM-4 — Juggle

- **Drives** a launcher, then 1–12 follow-ups at authored timings, plus
  follow-ups attempted after the victim lands.
- **Layer** L2.
- **Asserts** `juggleCount` increments per airborne hit; a fresh launch sets the
  arc and an airborne hit only tops it up (`velocity.y = max(vy, -1.5) + h*0.5`),
  so hang time is bounded; `juggleCount` is zeroed by `#toKnockdown`; a grounded
  defender cannot be launched by a follow-up whose reaction is not `LAUNCH`;
  `JUGGLE_GRAVITY = 0.42` applies to the victim and not to a jumper.
- **Positive control** set `MIN_JUGGLE_SCALE = 1`; combo damage must stop
  decaying and the test must fail on monotonicity.
- **Null control** a juggle route run twice from the same state must give
  identical damage to the last decimal.
- **Status** automatable now.

### SM-5 — Wall, knockdown, wakeup, grounded hits

- **Drives** knockback into the arena bound at speeds either side of
  `WALL_SPLAT_SPEED = 6.0`; knockdowns of each reaction type; wakeup with and
  without input; strikes aimed at a grounded opponent.
- **Layer** L2.
- **Asserts** a splat requires both a stunned state and `speed >= 6.0`; a splat
  sets `HITSTUN` with at least 34 stun and re-airbornes the victim; knockdown
  durations are 40 / 36 / 44 by reaction; wakeup is 22 ticks and the roll/getup
  choice comes from the seeded `Fighter.rng`; **a move without
  `props.hitsGrounded` cannot hit `KNOCKDOWN`/`WAKEUP`, and a `props.finisher`
  can** (a finisher that whiffs on the reason it exists is not one).
- **Positive control** drop the `stunned` requirement in `#resolveWalls`; a
  fighter who walks into a wall must then splat.
- **Null control** a fighter walking into a wall at any speed must never splat.
- **Status** automatable now.

### SM-6 — Round end, match end, and the score `isFinalRound` reads

- **Drives** full matches to KO, to double KO, and to timeout, in every
  win/loss ordering up to `ROUNDS_TO_WIN = 2`.
- **Layer** L2 plus `Game`.
- **Asserts** `roundEnd` fires once per round with the right winner and `perfect`
  flag; `CombatSystem.wins` matches the HUD's score; `isFinalRound()` is true
  exactly when a round can decide the match; **`#scoreRound` zeroes `wins` the
  moment someone reaches `ROUNDS_TO_WIN`, and `roundStart` with round 1 also
  zeroes it — so the test must prove a new match's opening round is not reported
  as a decider**; a timeout awards on health and a health tie is a draw.
- **Positive control** delete the `roundStart` reset listener; the second match's
  round 1 must report as final and the test must fail.
- **Null control** a match replayed with the same inputs must produce the same
  score sequence (DT-1 again).
- **Status** automatable now.

### SM-7 — Finisher window lifecycle

- **Drives** the condition crossing in both directions, KO on the same tick the
  window would open, a finisher entered one frame before recovery, and a
  finisher entered from inside a combo.
- **Layer** L2.
- **Asserts** `#updateFinisherWindows` runs before `#checkKO` (a window must
  never open on a corpse); the window opens once per fighter per round and
  `reset()` clears `openedThisRound`; `#fireFinisher` **retries** every tick
  until the window runs out rather than throwing the completed sequence away;
  the finisher enters the move state machine on the same tick boundary as any
  other move, so FD-1 measures its startup correctly.
- **Positive control** move `#updateFinisherWindows` after `#checkKO`; the
  same-tick-KO case must open a window on a dead opponent.
- **Null control** with `finalRoundOnly` true, the window must not open on a
  non-final round however low the opponent's health goes.
- **Status** automatable now.

---

## 5. Determinism (DT)

Claimed in `Rng.js` ("the simulation must be deterministic so replays and
rollback work"), in `Game.js` ("the sim itself always sees a clean 16.667 ms tick
and stays deterministic") and in `CPU.js` ("a given seed reproduces a given
match"). As far as I can tell it has never been tested.

Two structural facts found while reading, which these tests exist to settle:

1. `Fighter.reset()` does **not** reseed `this.rng`, and does not reset
   `simTick`. The per-fighter stream therefore carries across rounds. Fine for
   a match replayed from tick 0; **not** fine for a replay or rollback that
   starts at a round boundary.
2. `Game.#frame` decrements `slowmo.ticks` once per **rendered frame**, not per
   sim tick — the same shape as the hitstop bug that was fixed. It does not
   change tick *content*, so tick-space determinism survives; it does change how
   much wall-clock a `timeScale` covers, and therefore how a recorded *wall-clock*
   input timeline lands. DT-2 is written to distinguish those two claims rather
   than to assert the stronger one.

### DT-1 — Tick-for-tick reproduction from a seed

- **Drives** a recorded command timeline (from IR-1's fuzz, or a real play
  session dumped as `{tick, keydown, keyup}`) replayed twice into two freshly
  constructed sims.
- **Layer** L3, replayed at the key-event level so the input layer is inside the
  determinism claim rather than outside it.
- **Asserts** a per-tick hash over `{position, velocity, health, meter, state,
  stateTicks, stunTicks, moveTick, moveInstance, currentMove.id, juggleCount,
  facing, animYaw, rng.s0, rng.s1}` for both fighters, plus
  `combat.combos` and `combat.wins`, is **identical tick for tick**. Not "the
  same winner" — the same hash, at every tick, or the first divergent tick is the
  report.
- **Positive control** replace one `this.rng.next()` in `Fighter` with
  `Math.random()`. The runs must diverge and the report must name the tick.
- **Null control** the two runs in the same process **and** a third in a fresh
  process must all match. Same-process-only agreement proves nothing about
  module-level state.
- **Status** automatable now. This is the cheapest high-value test in the plan.

### DT-2 — Frame-rate independence

- **Drives** the same command timeline through the real `Game` loop with `dt`
  schedules of exactly 1/60, exactly 1/144, exactly 1/30, and a jittered trace
  (8–40 ms, seeded), including at least one 250 ms stall to exercise the
  `MAX_TICKS_PER_FRAME = 5` clamp.
- **Layer** `Game` over L3.
- **Asserts** two separate claims, reported separately:
  - **DT-2a** the sequence of per-tick hashes is identical across all four
    schedules for the first N ticks where N is the smaller tick count. This is
    the claim the fixed-step loop actually makes.
  - **DT-2b** the number of sim ticks spent inside a `timeScale` window is the
    same across all four schedules. **I expect this to fail**, because
    `slowmo.ticks--` runs per rendered frame. Report it as a finding, not as a
    pass/fail on the sim.
- **Positive control** revert the hitstop drain to `freezeTicks[i]--` once per
  rendered frame; DT-2a must fail on the 30 Hz and 144 Hz schedules, by roughly
  the ratio the `Game.js` comment records (a 144 Hz display ran the freeze at
  2.4x speed).
- **Null control** the 1/60 schedule run twice must be identical, and the
  250 ms stall must not change the hash sequence — only how many ticks fit in a
  frame.
- **Status** automatable now (`Game` can be stepped with an injected clock; no
  renderer is needed if `#render` is stubbed, and the plan is to make the render
  call injectable rather than to fork the loop).

### DT-3 — Determinism across a round boundary

- **Drives** a full 3-round match recorded from tick 0; then a replay that starts
  at the round-2 boundary from a saved snapshot.
- **Layer** L2/L3.
- **Asserts** the round-2 tick hashes match the original. **This is expected to
  fail as written**, because `Fighter.rng` is not reseeded on `reset()` and
  `simTick` keeps running, so the wakeup roll (`rng.next() < 0.35` for
  `getUpRoll` vs `getUp`) and the victory-pose roll depend on how much happened
  in round 1.
- **Positive control** n/a — the test *is* the probe. Its control is the
  counter-run: reseed `Fighter.rng` in `reset()` from
  `(seedBase, round)` and the assertion must start passing.
- **Null control** a replay from tick 0 must pass (DT-1), so a failure here is
  specifically about the round boundary and not about determinism in general.
- **Status** automatable now. The outcome is a decision — either reseed per round
  and get restartable replays, or document that replay is whole-match only.

### DT-4 — CPU determinism

- **Drives** the same match twice at each difficulty level with the same seed;
  and the same match with the level changed mid-round (the code says that is
  safe).
- **Layer** L2 with a real `CPU`.
- **Asserts** identical tick hashes; `#resetForRound` derives its seed from
  `_seedBase ^ imul(round + 1, 0x9E3779B1)` and nothing else, so round 2 of one
  match matches round 2 of another with the same base.
- **Positive control** seed the CPU from `Date.now()`; the runs must diverge.
- **Null control** two different seeds must diverge — a test that passes for both
  the same and different seeds is comparing nothing.
- **Status** automatable now.

---

## 6. Fairness and AI (AI)

The claim in `CPU.js` is precise and therefore testable: the bot is *"physically
incapable of blocking a move before it has had time to see it start"*, is
*"never omniscient"*, and is *"bounded by the same perception delay and dice
rolls a human opponent would be"*.

### AI-1 — The CPU only uses inputs a player can produce

- **Drives** 200 seeded matches per level (headless, ~real time is irrelevant
  without a renderer), recording every move the CPU starts.
- **Layer** L2, cross-referenced against IR-1's reachability results.
- **Asserts** every move the CPU started is in the player-reachable set for that
  character; and every `Command` the CPU emitted is *well-formed* — it must be
  producible by `Input.commandsFor` (no simultaneous fwd+back, no motion set
  while the direction is held in a way `#dashMotion` would reject, no button in
  `pressed` that is not in `held`).
- **Positive control** have the CPU call `startMove` directly on a move with
  `requireStance` (the finisher). The test must name it.
- **Null control** the same sweep against a *recorded human* command stream must
  report zero violations — if it does not, the well-formedness predicate is wrong
  and not the CPU.
- **Status** automatable now. Note the CPU's own documented exemption: it sets
  `motion` with no direction held, which registers as a release on that tick and
  is *why* `#dashMotion` lets its `ff+2` through. That is a legitimate difference
  in how the same input is expressed, and the predicate must allow it explicitly
  rather than by accident.

### AI-2 — The perception delay is real

- **Drives** at each level, 500 trials of a move whose startup is shorter than
  `reactionTicks`, and 500 of one that is longer.
- **Layer** L2.
- **Asserts** the block rate on the too-fast move is statistically
  indistinguishable from the bot's neutral guard tendency, while the block rate
  on the slow move approaches `blockRate`. `reactionTicks` is `curve(level, 26, 6)`
  and a jab's startup is 10, so it drops below a jab at level 9 (8.2 ticks) and
  level 10 (6): **levels 9 and 10 are meant to be able to react to a jab and
  levels 1–8 are not.** That crossover is a prediction the test checks, and it is
  a better assertion than any absolute rate because it is derived from the two
  numbers the design already fixed.
- **Positive control** set `reactionTicks = 0`; the too-fast move must become
  blockable at `blockRate` at every level.
- **Null control** the slow move's rate must not change when the positive control
  is applied — if it does, the instrument is measuring something other than
  reaction.
- **Status** automatable now.

### AI-3 — Difficulty scales what the data says it scales

- **Drives** levels 1–10 against a **fixed scripted opponent** (not against
  another CPU — two adaptive agents make the result unattributable), 200 seeded
  matches per level.
- **Layer** L2.
- **Asserts** win rate is monotone non-decreasing in level within its confidence
  interval, and that the measured behaviour matches the authored curves:
  block rate, punish accuracy, tech rate, whiff-punish rate, combo length,
  aggression, and mean spacing. The retreat commitment note in `CPU.js` records
  measured numbers to check against — at level 5 a 900-tick round should spend
  50–62 ticks giving ground with a mean gap around 2.5 m against a 2.3 baseline.
- **Positive control** flatten one curve (make `blockRate` constant); the
  monotonicity of that column must break while the others hold.
- **Null control** level 5 against level 5 must be 50% within CI; and 200 matches
  at one level with 200 different seeds must give a CI that contains the 200-match
  result from a different seed block.
- **Status** automatable with work — the scripted opponent has to be written, and
  it has to be genuinely fixed-policy or the whole column is unattributable. Budget
  it as a day, not an afternoon.

### AI-4 — The CPU reads no hidden state

- **Drives** `CPU.think()` with the opponent `Fighter` wrapped in a `Proxy` that
  records every property read during the call.
- **Layer** L2, structural.
- **Asserts** the read set during a `think()` is a subset of an explicit
  whitelist (`position`, `facing`, `state`, `airborne`, and the fields
  `#writePerception` snapshots) — and in particular that no reactive decision
  reads `currentMove` live rather than through `#perceived()`.
- **Positive control** make `#tryBlock` read `opp.currentMove` directly; the
  proxy must flag it.
- **Null control** the same proxy over a *human-driven* match must record no
  reads at all from `think()` (it is not called), which proves the proxy is
  attached to the thing it claims to be.
- **Status** automatable with work. This is the only way to make "not omniscient"
  a structural property instead of a code-review opinion, and code review has
  already missed this class of thing repeatedly in this project.

---

## 7. Touch (TC)

### TC-1 — The pad emits the same `Command` as the keyboard

- **Drives** synthetic `TouchEvent`s at coordinates computed from the pad's own
  laid-out geometry (read from the DOM at run time, never hard-coded — the layout
  is built from the button size outward and reflows), covering: each of the four
  limb buttons at centre and at each corner of its cell; the two-finger chord on
  every limb pair; the four swipe motions at eight angles each; the OD pad; the
  BLOCK pad; the floating stick at all eight snapped directions and inside the
  12 px dead zone.
- **Layer** L4 (needs a DOM; Playwright, or jsdom if the pad's listeners can be
  driven without layout — the geometry read makes jsdom marginal, so budget
  Playwright).
- **Asserts** the `Command` produced is field-for-field equal to the one the
  keyboard produces for the same intent, including `guard`, `touchGuard` and
  `motion`.
- **Positive control** shrink `--kbt-btn` so the rows overlap; the corner taps
  must resolve to the wrong limb, which is the exact defect a tap sweep found
  before (tapping the north edge of RK produced RP).
- **Null control** a 9x9 sweep over the cluster must have no dead cells — the
  same sweep that once found 24 of 49 cells firing nothing — and must be
  identical across two runs.
- **Status** automatable with work. **Do not run while a capture is in flight.**

### TC-2 — Touch reachability parity

- **Drives** IR-1's move ledger through the touch path.
- **Layer** L4.
- **Asserts** a per-move reachable/unreachable verdict, and that every
  unreachable move is in `KNOWN_UNREACHABLE` with a reason. From reading the
  scheme, the expected honest gaps are: motions outside the four swipe sectors
  (`hcf` — currently used by zero moves, so free); `ff`/`bb`, which come from the
  floating stick's history rather than a swipe and therefore need a deliberate
  double tap on glass; and any move needing a **direction plus a chord**
  (`b+1+2`, `f+1+3`) where the left thumb is on the stick and the right must land
  two fingers. That last class is 33 throws' worth of surface and is the one to
  measure rather than reason about.
- **Positive control** remove the OD pad from the DOM; overdrive must become
  unreachable and the ledger must gain exactly the meter-gated moves.
  This is the mobile-overdrive regression made structural.
- **Null control** the keyboard ledger from IR-1, unchanged, run in the same
  session.
- **Status** automatable with work.

### TC-3 — What touch emulation cannot cover

Stated plainly so nobody reads a green TC-1/TC-2 as "it works on a phone":

- **Real finger geometry and occlusion.** A synthetic tap is a point. A thumb is
  a 10 mm ellipse that also *hides* the thing it is pressing. Every reach figure
  in `TouchControls.js` is in millimetres on an iPhone 13 and none of it is
  exercised by a point tap.
- **OS and browser gesture interception.** Edge-swipe back, double-tap zoom,
  three-finger gestures, the URL bar reappearing, notification shade. `preventDefault`
  is called, but whether the OS honours it is a device fact.
- **Touch sampling rate against a 60 Hz sim.** A 120 Hz digitiser can deliver two
  samples per tick, and `CHORD_TICKS = 4` is 66 ms of real time. Emulation
  delivers exactly one event per synthetic tick.
- **Sustained thermal behaviour.** A phone that throttles changes `dt`, which
  changes how many sim ticks a frame carries, which is what DT-2 is about — but
  only a real handset produces the schedule.
- **Whether a first-time player finds the gesture at all.** `touchgate` proves a
  control is findable by a script that was told where to look. It cannot prove a
  human notices the coach line.

**These need a human with a handset.** The minimum useful session is: one player
who has not been told the scheme, one match, and three specific questions — did
you throw, did you land a motion special, did you fire overdrive. That is 15
minutes and it has caught more than any instrument here.

### TC-4 — Extend `touchgate` with a combat path

- **Drives** three new steps after the existing `fight` step: two-finger chord on
  the cluster (assert a `throw` or `THROW` state), a swipe across the cluster
  (assert `motion` was consumed and a special started), and an OD pad tap with
  full meter (assert the super started).
- **Layer** L4.
- **Asserts** each step's `done` predicate reads the fighter's real state, as the
  existing steps do — "the pad fired" versus "the pad is painted there".
- **Positive control** `--control=hide-od`, hiding `.kbt-od` and nothing else:
  the OD step must fail and every step before it must pass, exactly as
  `--control=hide-menu` does today.
- **Null control** the existing `--control=null` rule extends to cover the new
  steps: two identical runs, same verdict.
- **Status** automatable with work. Reuse the existing runner; the verdict
  derivation already counts every path, so adding steps cannot silently not count.

---

## 8. Regressions with a named cause (RG)

Each of these reproduces a defect that actually shipped. They are cheap, they are
specific, and each one is the fastest possible check that a fix is still in place.

| id | The defect | Reproduction | Positive control | Status |
|---|---|---|---|---|
| **RG-1** | Held direction synthesised `dd`/`bb`; hold down + RP gave `siegeSlam`, 88 frames, unblockable | IR-1, the held-down and held-back rows at 4/8/16/24-tick holds | **Two**: (a) delete the dedupe in `Input.#motion`; (b) neuter `Fighter.#dashMotion`. Each must fail the test alone | now |
| **RG-2** | A rejected grab paid out as an unblockable strike | SM-3 | Remove the `props.throw` early return in `#findConnection` **and** move the vestigial capsule back in front of the spine | now |
| **RG-3** | Kicks never connected; 21 dead moves at 4 ranges | `probeMoves`-style sweep, all 566 moves × 4 distances, run in the Node rig | `setAim(false)` — the recorded before/after is 82% → 94% connect and 21 → 4 dead; the control must reproduce the 82% | now |
| **RG-4** | Overdrive unreachable on a handset (`qcf+5` needed a gesture) | TC-2, plus an L0 assert that the overdrive input is a bare `5` | Rebind overdrive to `qcf+5`; TC-2 must lose it | with work (L4) |
| **RG-5** | Air-only moves probed from the ground; `airKick` scored on a pose no player can make | IR-5's null control (`stageAir` must return true) | Force `stageAir` to return true without leaving the ground; the rows must be flagged as harness failures | now |
| **RG-6** | Hitstop drained per rendered frame; a 144 Hz display ran it 2.4x fast | DT-2 | Revert the drain to per-frame | now |
| **RG-7** | The whole `b+` column bound to `bb+` moves | IR-6 | RG-1's control (b) | now |
| **RG-8** | Meter-gated moves scored as whiffs because `startMove` returned early and emitted nothing | Any sweep must set `meter = METER_MAX` per attempt **and** assert `currentMove === move` after `startMove`, reporting `notStarted` separately from `whiff` | Run a sweep with meter at 0; the 14 meter-gated moves must appear in `notStarted`, not in `dead` | now |

RG-8 is not a game defect but an instrument defect, and it is in this table
because it hid `overdrive` for three rounds. Every sweep in this plan inherits
its rule: **a move that did not start is not a whiff, and must be reported in its
own column.**

---

## 9. Automation summary

| Group | Automatable now | With work | Needs a human |
|---|---|---|---|
| FD (frame data) | FD-1…FD-7 | — | — |
| IR (reachability) | IR-1…IR-10 (keyboard, gamepad) | — | — |
| SM (state machine) | SM-1…SM-7 | — | — |
| DT (determinism) | DT-1…DT-4 | — | — |
| AI (fairness) | AI-1, AI-2 | AI-3 (scripted opponent), AI-4 (proxy) | — |
| TC (touch) | — | TC-1, TC-2, TC-4 | TC-3 |
| RG (regressions) | RG-1,2,3,5,6,7,8 | RG-4 | — |

**Honest about the third column.** Only one thing in this plan genuinely needs a
human, and it is not "playtesting for feel" — it is TC-3: whether the gestures
are discoverable and performable by a thumb on a real handset. Everything else
here is an integer counter, a state transition or a hash, and integer counters do
not need opinions. If a later round wants a feel or balance verdict, that is a
different document; this one deliberately does not pretend an instrument can give
it.

The one thing that would be honest to add and is not in scope here: nobody has
watched a person play this game and finish a match. Every reachability defect
listed above was found by someone playing, not by an instrument. The instruments
are how they stay fixed.

---

## 10. What to run first

Ranked by the probability of finding a real bug, which is not the order they are
written in.

1. **FD-2 (on-block advantage).** It has already found one — 45 of 45 blockable
   moves on the first character measured are 2 to 8 frames less safe than the
   move list prints, always in the unsafe direction, and `jab` prints `+1` and
   plays `-1`. It is cheap, it is exact, and "frame data is the game" is the
   sentence this project is built on.
2. **IR-1 (every root move from a real keypress).** It is the test whose absence
   let an 88-frame unblockable ship on a held direction. It runs at L3, it covers
   566 moves on two platforms, and it has two positive controls that each fail it
   alone — which is more than the two live guards in the code can currently say
   for themselves.
3. **DT-1 (tick-for-tick reproduction).** Determinism is claimed in three files
   and has never been tested. It is the cheapest test in the plan to write, and
   every other test's null control quietly depends on it being true.

FD-4 is fourth and only because it will mostly re-report FD-2's finding in a
different unit; run it after the FD-2 decision is made, so it measures the fix
rather than the symptom.
