# Fighting-game animation: what the industry does that we do not

> **STATUS, updated after rounds 13–15. Three of this note's six claims have since been tested
> against the actual code and the primary sources, and two of them were WRONG. A brief written
> from this file unchecked cost round 13 most of a workstream. Read the inline verdicts before
> acting on anything here.**
>
> | claim | verdict |
> |---|---|
> | 1. No directional hit reaction | **ALREADY BUILT.** It exists and works. |
> | 2. Hitstop should be 1–3 frames | **FALSE.** No primary source supports it. |
> | 4. Use the silhouette test | **CONFIRMED and adopted.** It has since found real defects. |

Research note gathered while animation sat at 57/100 — the lowest of six axes, having moved
43 → 48 → 53 → 57 across four rounds. Every other axis scores 62–76. The gap is not closing at
the rate the others are, which suggests the work being done is not the work that matters.

Sources at the foot. This is deliberately about *technique we are missing*, not general advice.

## 1. The receiving fighter is half the animation, and we animate almost none of it

Every practitioner source treats impact as a **pair** of animations. What sells a hit is the
directional reaction on the body being hit — head snapping away along the impact vector, torso
folding toward it, limbs going slack — synchronised with hitstop, camera shake and audio.

We have reaction *clips* selected by `REACTION.*`, but nothing that reacts to the **direction and
force of the specific blow**. The blind critic named this as the single biggest gap on the axis,
independently of this research. And we already have what it needs: the `hit` bus event carries
`velocity`, the striking bone's true swept world velocity, and `bone`. That is a real impact
vector sitting unused.

**VERDICT (round 13): ALREADY BUILT — strike this item.** `Animator.js` already contains
`HIT_LAYER`/`hitEnvelope`/`hitReaction()`/`#applyHitReaction()`, driven from the `hit` event's
swept velocity and region by `Fighter.#reactToBlow`. Measured with the silhouette harness: a
frontal blow versus a blow from behind differ by **0.401** peak 1−IoU. Hits from opposite sides
already produce visibly different reaction silhouettes.

What was actually wrong was subtler and only findable by measuring: the reaction was **invisible
for the first 83–300 ms**, which is precisely the frame the eye locks onto. Both halves of it arm
on a simulation that is about to stop, so during hitstop the body that had just been hit was
**bit-identical** to the body that had not — front versus back, frozen frames, 0.000. Fixed in
round 13 with a presentation-only contact stamp (0.009 → 0.252).

This item sat at the top of the "unbuilt" list for three rounds and was briefed to an agent as
unbuilt. It cost that agent most of a round to discover otherwise. **The lesson is the item:**
check whether a thing exists before ranking it as the highest-value thing to build.

## 2. Hitstop is a timing tool, not a pause

The convention is 1–3 frames of freeze on connection, scaled by attack weight, with the
*attacker* and *defender* often frozen for different durations so the hit reads as transfer of
force rather than a shared stutter.

**VERDICT (round 14): THE "1–3 FRAME CONVENTION" IS NOT SUPPORTED BY ANY PRIMARY SOURCE.**
Checked properly, with the 60Hz-versus-30Hz trap explicitly ruled out — all of these are 60fps
games quoting 60Hz frames:

| source | light | medium | heavy | cap |
|---|---|---|---|---|
| Street Fighter V (Capcom's own SF Seminar column) | 8F | 12F | 16F | — |
| Street Fighter IV (sonichurricane, *Impact Freeze*) | ~9F | ~11F | ~13F | — |
| Street Fighter II | 10–14F regardless of strength | | | |
| Melee | `floor(dmg/3+3)` | | | 20F |
| Brawl / Ultimate | `dmg*0.385+5` / `dmg*0.65+6` | | | 30F |
| **Knockbots** | **5** | **8** | **12 / 11** | **18** |

Knockbots is **at or below convention everywhere**. The "1–3 frames" figure appears to be a
conflation with the 2–4 frame *screen effect* `docs/CRITIC.md` asks for, which is a different
thing authored in `HIT_FX`. Shortening the freeze is not a lever and has now been settled twice.

Two real findings came out of checking it anyway, both since fixed: hitstop was being drained once
per **rendered frame** rather than on the sim clock (a 183 ms freeze ran 327 ms and lengthened
itself with hit weight), and no effect beat past the first ever fired during a freeze — frames 0
through 11 of a launcher were the same photograph.

## 3. Anticipation survives even at four frames

The specific claim worth internalising: *"a fast jab might only take 4 frames total, but
animators still squeeze in a 1-frame anticipation and a 1-frame follow-through"* — and the
justification is not aesthetic, it is competitive. **Anticipation is what gives the opponent a
fair chance to react.** In a game with real frame data, the wind-up pose is gameplay information.

Our measured position: across ~6300 authored easing declarations, **snap 30 and expo 18** — under
1% are the fast-release curves. The library is overwhelmingly symmetric ease-in-out, which is the
mechanical opposite of anticipate-then-release.

## 4. The silhouette test is the accepted acceptance test

*"Black out the entire character and keep only the shape. If you can read the action, the
animation is working. If not, exaggeration is missing."* Players read silhouettes before they read
surfaces.

We adopted this for **character design** in round 9 (a 100px flat-black contact sheet, scored by
1−IoU) and it worked — it caught landmarks that vanished edge-on.

**VERDICT (round 13): CONFIRMED, and now built for animation too.** The harness lives at
`scratchpad/anim-tell/` (`sil.mjs` scores, `regress.mjs` is a 7-metric guard over 34 clips with a
stored baseline). It has since earned its keep twice over: it **disproved** the "fast punches have
no wind-up" brief (p.jab and p.jabAlt are the 6th and 4th *highest* arm-divergence of 34 clips at
the commit frame), and it found six clips that **erase their own wind-up** — p.overhand peaks at
0.47 on tick 12, sinks to 0.22 by tick 19, then jumps to 0.74 at contact.

This is the most productive single item in this note.

## 5. Smears and stretch are readability tools, not decoration

At fighting-game speeds a limb crosses the screen faster than the frame rate can show, so 2D
animators draw the blur into the character and 3D animators reach for **rig manipulation, mesh
stretching, layered animation data and camera effects** to do the same job.

We have weapon trails on bone motion, which is the effects-side half. We do **no** transient
scale or stretch on the striking limb, and our object-velocity motion blur was removed in round 4
for ghosting. Worth noting the sources call this a *readability* tool — the problem it solves is
that a 3-tick strike is genuinely invisible, which no amount of pose quality fixes.

## 6. Everyone else is polishing mocap; we are hand-keying from nothing

The industry standard is a hybrid: mocap for naturalistic body mechanics, then hand-polish for
game-feel exaggeration. Hand-keyed is described as the better choice specifically for *stylised,
exaggerated attacks that break physics* — which is what a robot fighter is.

That is genuinely encouraging for this project's constraints, but it sets the bar honestly: we
are competing against animation whose *base layer* is a human performance. Our equivalent of that
base layer is procedural — spring bones, IK, inertialization, breathing — and that is the right
substitute, but it has to carry more weight than it currently does.

## What this implies, ranked

1. ~~A directional hit-reaction layer on the receiving fighter.~~ **DONE — it was already there.**
   See the verdict under item 1. What it needed was visibility during hitstop, now shipped.
2. **Per-bone fast-release easing on the striking limb.** The runtime already supports per-key
   per-track easing; `makeClip` was flattening it, and that was fixed — but under 1% of authored
   curves use it. This is an authoring pass, not an engine change.
3. **A silhouette strip for animation**, extending the existing contact-sheet tool. It is the
   industry's own acceptance test and we already proved the method on character design.
4. **Transient stretch on fast limbs** as a readability tool, carefully — it is the one item here
   that can look worse rather than better if overdone.
5. ~~Audit hitstop against the 1–3 frame convention.~~ **DONE — the convention does not exist.**
   Knockbots is at or below every shipped game checked. See the verdict under item 2.

**Still open and unbuilt, in current priority order:** overlapping action — every bone in every
clip is keyed on one shared time grid, and the head's key times are a strict subset of the hips'
in **91 of 91 clips**, so the head arrives with the chest and the fist arrives with the hips. That
is a round-15 finding and it is not in this note's original six, which is worth noting on its own:
the largest gap on this axis was one the research pass missed entirely.

## Sources

- [GDC Vault — Animating a Complex 2D Fighting Game 3 Frames at a Time](https://www.gdcvault.com/play/1027125/Animation-Summit-Animating-a-Complex)
- [Combat Animation for Games: Sword, Melee, and Firearm Sets — MoCap Online](https://mocaponline.com/blogs/mocap-news/combat-animation-game-dev-guide)
- [Mastering the Art of Animating Fighting Games — Genius Crate](https://www.geniuscrate.com/animating-fighting-game)
- [How To Make Animations in Fighting Game? — Retro Style Games](https://retrostylegames.com/blog/how-to-make-animations-in-fighting-game/)
- [Breakdown: Guilty Gear-Style Fighting Game Combo Animation — 80.lv](https://80.lv/articles/animating-guilty-gear-inspired-fighting-game-combo-in-maya)
- [Why Exaggerated Animation Makes Fighting Games Feel Alive — Pixune](https://pixune.com/blog/role-of-exaggerated-animation-in-fighting-games/)
- [How Exaggerated Animation Adds Life to Fighting Games — Prolific Studio](https://prolificstudio.co/blog/exaggerated-animation/)
- [The 12 Principles of Animation (In Video Games) — Game Anim](https://www.gameanim.com/2019/05/15/the-12-principles-of-animation-in-video-games/)
- [12 Principles of Animation for Games, Reframed — Animworks](https://anim.works/the-12-principles-of-animation-reframed-for-games/)
- [Fighting Game Animation: How to Animate a Fighting Game? — Kevuru Games](https://kevurugames.com/blog/how-to-animate-a-fighting-game/)
