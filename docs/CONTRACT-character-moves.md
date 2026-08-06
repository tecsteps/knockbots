# Pinned contract — per-character moves, finishers, and how the UI reads them

Round 30. Three agents build against this in parallel: one owns the move data, one
owns the finisher system, one owns the UI that displays both. **This file is the
interface between them.** It was pinned after the UI agent correctly pointed out
it was guessing at a shape nobody had fixed — which is the charter's own method
("pinned module contracts so workstreams never collide") and my omission.

If you need to deviate, change this file first and say so in your report. Do not
deviate silently; the other two are coding against it.

---

## 1. Where character moves live

`src/combat/Moves.js` gains one new table and one new function:

```js
/** Per-character overlays, keyed by roster id. Built with the same `mv()` helper. */
export const CHARACTER_MOVES = { vulkan: { ... }, kestrel: { ... }, ... };

/**
 * The move set a given roster character actually fights with:
 * its archetype table with its own overlay merged over the top.
 * A character with no overlay returns its archetype set unchanged.
 */
export function movesFor(charId) { ... }
```

`movesFor` is the **only** supported way to get a fighting move set from now on.
`MOVES[archetype]` stays exported and unchanged so nothing existing breaks, but a
consumer that reads it directly will silently miss every character move.

Consumers to update (whoever owns each file): `Fighter.js`, `CPU.js`,
`TestHarness.js`, `MenuSystem.js`.

**Merge rule.** A character move with the same `id` as an archetype move
*replaces* it. Any other id *adds*. The merged set must be re-ordered by input
specificity exactly as `MOVES` is, or `findMove` will match the wrong move — it
walks `set.__ordered` most-specific-first and the overlay must take part in that
ordering, not be appended after it.

## 2. Marking a character move

Every move in a `CHARACTER_MOVES` overlay carries:

```js
owner: 'vulkan',        // roster id. Presence of this field IS the signature flag.
desc: 'One line of plain English describing what it does and when to use it.',
```

`owner` rather than `signature`, deliberately: `signature` is **already taken** on
roster entries, where it means `{intro, victory, taunt, idle}` clip ids. Reusing
it would collide in exactly the place the UI has to read both.

The UI may therefore test `move.owner` to split signature moves from shared
archetype moves, with no diffing against the base table.

## 3. The finisher

A finisher is a move like any other, plus:

```js
tag: 'finisher',
desc: '...',
props: {
  finisher: {
    // HUMAN-READABLE, rendered on screen verbatim. Not derived from the fields
    // below by the UI -- the system owns the wording of its own rule.
    condition: 'Opponent below 20% health on the final round',
    // The machine-readable form of the same rule, for the engine and for tests.
    healthPct: 0.20,
    finalRoundOnly: true,
    window: 90,              // ticks the input is accepted for once the condition opens
    sequenceText: 'Back, Back, Down, RK',   // the input in words, for display
  },
},
```

Both forms are required. `condition` and `sequenceText` exist because the UI must
state the rule in words: **an input the player cannot trigger reads as broken**,
and a finisher whose condition is only expressed in code cannot be taught.

`window` being finite is deliberate — a finisher that cannot be missed is a
cutscene, not a finisher.

## 4. What the UI can rely on

For a selected roster character:

- `movesFor(def.id)` returns everything that character can do.
- `move.owner === def.id` marks its signature moves; absent means shared.
- `move.tag === 'finisher'` marks the finisher; `move.props.finisher.condition`
  and `.sequenceText` are display-ready strings.
- `move.desc` is a one-line description on every character move and the finisher.
  It is **optional on the ~195 pre-existing archetype moves** — do not assume it.
- Existing fields remain: `name`, `input`, `height`, `damage`, `startup`,
  `adv.block`, `adv.hit`, `total`.

## 5. What nobody may do this round

- **No new animation clips.** `src/characters/animations/**` was heavily edited by
  round 29 and is freshly committed. Reuse the 92 existing clips.
- **No frame-data changes to existing moves.** Frame data is the game.
- Hitbox anchors must sit on the limb the clip actually swings. `check.mjs`
  enforces this and it caught a real bug this session: a right-button sweep whose
  capsule sat on the planted leg, because `k.sweep` swings the left leg. The
  button a move is bound to says nothing about which limb its clip moves.
