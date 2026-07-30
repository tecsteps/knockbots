# Fighting-game animation: what the industry does that we do not

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

**Highest-value item on this axis, and it is a runtime layer rather than 91 re-authored clips.**

## 2. Hitstop is a timing tool, not a pause

The convention is 1–3 frames of freeze on connection, scaled by attack weight, with the
*attacker* and *defender* often frozen for different durations so the hit reads as transfer of
force rather than a shared stutter.

We have hitstop by `WEIGHT` (5–18 ticks). Worth checking against the convention: 18 ticks is
300ms, which is far longer than the 1–3 frames the sources describe, and long hitstop reads as a
hitch rather than an impact. Not yet measured against the reference.

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
1−IoU) and it worked — it caught landmarks that vanished edge-on. **We have never applied it to
animation**, which is where the sources actually use it. A per-clip silhouette strip at the
startup, contact and recovery frames is cheap to build on top of `tools/animstrip.mjs`.

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

1. **A directional hit-reaction layer on the receiving fighter**, driven by the existing impact
   vector. Runtime, one file, benefits every hit in the game.
2. **Per-bone fast-release easing on the striking limb.** The runtime already supports per-key
   per-track easing; `makeClip` was flattening it, and that was fixed — but under 1% of authored
   curves use it. This is an authoring pass, not an engine change.
3. **A silhouette strip for animation**, extending the existing contact-sheet tool. It is the
   industry's own acceptance test and we already proved the method on character design.
4. **Transient stretch on fast limbs** as a readability tool, carefully — it is the one item here
   that can look worse rather than better if overdone.
5. **Audit hitstop against the 1–3 frame convention.** Cheap to check, and 18 ticks looks wrong.

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
