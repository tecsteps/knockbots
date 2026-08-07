# Knockbots — Visual Critic Protocol

The quality bar for this project is not "looks good for a browser game". It is
**Tekken 8**. This document defines how that is measured, so the verdict is a
judgement against evidence rather than an opinion.

## Reference set

`ref/tekken8/tekken8_01.jpg` … `tekken8_10.jpg` — ten official 1920×1080
screenshots. They are the ground truth. They are gitignored (third-party press
assets) but present on disk.

## The blind test

This is the test the user asked for and it is the one that decides whether a
subsystem ships.

1. Read one Knockbots capture from `shots/` and one Tekken 8 reference at the
   same framing category (closeup vs closeup, wide vs wide, action vs action).
2. **Before forming an opinion, describe both images purely as images** — what
   materials, what light, what depth cues, what surface detail. Do not label
   which is which while describing.
3. Then state which image you would believe came from a shipped AAA title, and
   why, citing specific visual evidence.
4. Only then reveal to yourself which was which and record whether the
   Knockbots capture won, drew, or lost.

A subsystem passes when the critic, having gone through that sequence, either
picks Knockbots or genuinely cannot separate them on the axis being tested.

## Scoring axes

Score each 0–100. **80 is the ship bar.** Below 80 means iterate, not ship.

| Axis | What a 90+ looks like | What drags a score down |
|---|---|---|
| **Character rendering** | Surfaces read as specific materials — brushed aluminium, anodised paint, scuffed rubber — with edge wear where a real object would wear. Highlights have shape. Panel gaps hold shadow. | One uniform metalness. Flat grey. No edge definition. Plastic-toy look. Bevels missing so nothing catches a highlight. |
| **Animation quality** | Weight and follow-through. The hips lead, the head lags. A strike drives from the floor up. Poses read in silhouette. | Limbs moving in isolation. Linear interpolation. Floaty feet. No anticipation. Symmetric, pose-to-pose robotic motion. |
| **Lighting & atmosphere** | A clear key/rim/fill hierarchy. Strong coloured rim separating the fighter from the background. Real HDR range so highlights bloom naturally. Depth via atmospheric falloff. | Flat ambient. No rim. Fighters merging into the background. Bloom applied as a uniform haze. Everything the same brightness. |
| **Impact & effects** | Impacts punctuate — sparks with velocity streaks, a shockwave with real expansion easing, debris that obeys gravity, screen effects lasting 2–4 frames. | Generic round sprites. Particles that fade uniformly. Effects that persist too long. No relationship between hit weight and effect scale. |
| **Stage detail** | A place with layers — foreground occlusion, mid-ground architecture, parallaxed background, volumetrics carrying the light. Floor holds a believable reflection. | A plane and a skybox. Uniform detail density. No depth cues. Floor that is either a mirror or dead matte. |
| **Interface craft** | Type with real hierarchy and tracking. Bars with layered fills and eased motion. Announcements with motion design. Nothing default. | System font. Rectangular bars. Instant snapping values. Centred everything. Looks like a debug overlay. |

## Rules for the critic

- **Be harsh.** Erring toward generosity wastes the whole exercise. If a capture
  would not survive a screenshot comparison on a forum, say so plainly.
- **Cite evidence.** "The shoulder plate has no bevel so it reads as a flat
  quad under the key light" is useful. "Needs more polish" is not.
- **Rank the fixes.** Return the specific changes that would move the score most,
  in order. The implementing agent acts on this list directly.
- **Never pass a subsystem you have not seen rendered.** A code review is not a
  visual verdict. If `shots/` has no capture for the axis, say so and fail it.
- Judge the axis you were assigned. Do not down-score character rendering
  because the stage behind it is unfinished.

## Output contract

```
{
  axis: string,
  score: number,            // 0-100
  blindPick: 'knockbots' | 'tekken8' | 'indistinguishable',
  blindReasoning: string,   // what you saw, before knowing which was which
  evidence: string[],       // specific observations, with image regions
  fixes: [{ what: string, why: string, impact: 'high'|'medium'|'low' }],
  passes: boolean           // score >= 80
}
```

## Correction: impact scores before round 5 are invalid

An independent review by a second model (Codex GPT-5.6 Sol, read-only over the repo)
found that `tools/capture.mjs` photographed the `04-impact` shot **700ms after
`forceHit()`**, while impact sparks in `src/fx/EffectsDirector.js` live **160–300ms**.
`TestHarness.forceHit()` never paused on contact either, despite the shot's own note
claiming it captured hitstop.

Every impact score up to and including round 4 — 42, 41, 52 — was therefore measured on a
frame taken 400–540ms after the last spark had already died. Those numbers say nothing
about the effects and should not be compared against later ones.

The harness now arms a `hit` bus listener, slows the simulation, and freezes the frame a
precise number of ticks past contact: `04-impact` at +1 tick and `04b-impact-decay` at +8.
Impact is re-baselined from round 5 onward.

The general lesson applies beyond this axis: **a visual score is only as trustworthy as the
capture that produced it.** Before believing a bad score, confirm the shot actually shows
the thing being judged.

---

## The reference set, classified per image — use this, not a remembered subset

Every brief for several rounds told critics that "only tekken8_02, 06 and 07 are wide or full-body
in-match framings" and to treat those three as the comparable subset for stage work. **tekken8_06 has
no stage in it.** It is a rage-art frame: the entire background is a red full-screen effect wash, no
floor, no walls, no set geometry of any kind. The stage axis has therefore been benchmarking partly
against an image containing no stage.

Verified by opening every file. Classification:

```
image        framing              STAGE usable?   CHARACTER usable?   notes
tekken8_01   torso closeup        no              yes
tekken8_02   wide, in-match       YES             partial             city plaza: storefronts,
                                                                      planters, phone boxes, wet
                                                                      paving, background crowd.
                                                                      Centre veiled by smoke.
tekken8_03   posed closeup        no              yes                 defocused backdrop
tekken8_04   posed closeup        no              yes                 defocused backdrop
tekken8_05   posed closeup        no              yes                 defocused backdrop
tekken8_06   rage art             NO              yes                 NO STAGE AT ALL. Full-screen
                                                                      red effect. Do not use it for
                                                                      stage, detail density, dead
                                                                      tiles or floor statistics.
tekken8_07   wide, outdoor day    yes, CAUTION    partial             the 2.1x density outlier --
                                                                      a midday farm exterior, the
                                                                      densest image in the set. A
                                                                      round was lost generalising
                                                                      from it.
tekken8_08   torso closeup        no              yes
tekken8_09   posed closeup        no              yes                 bokeh ruin backdrop
tekken8_10   hub screen           no              no                  not a fight stage
```

**So the stage axis has TWO usable references, one of which is a known outlier.** Not three. Any
stage claim resting on a "distribution over the matched subset" is a distribution over n=2, and
should say so rather than implying a population.

Two rules that follow, and both were bought expensively:

1. **Open the image before putting it in a subset.** The 02/06/07 subset was assembled from framing
   metadata and propagated by copying between briefs for at least four rounds. Nobody looked.
2. **A statistic over n=2 is not a distribution.** Report both values, not a min/median/max, and never
   describe it as "the reference".

The same caution applies to the character axis in reverse: it has six usable closeups, which is a
real population — so character claims *can* carry a distribution and stage claims mostly cannot.

---

# SUPERSEDING CORRECTION: the score is not the verdict. The win rate is.

Everything above stands except the one thing it was built around. **The 0-100 score is not a
measurement and must not be used as one.**

## The evidence

Four critics were given **byte-identical frames, an identical brief and the same model**, and asked to
score the lighting axis. They returned:

```
38    44    61    65        median 52.5    range 38-65    spread 27
```

Each one reproduced its own score exactly when asked again. So the error is not noise inside a critic
— **it is that different instances anchor the 0-100 scale in different places and then hold that
anchor firmly.** That is worse than randomness for anyone reading a single result, because one critic
looks perfectly self-consistent and therefore trustworthy right up until a second is run.

**Consequences, stated plainly:**

- A ship bar of 80 applied to a number carrying **+/-13** cannot be cleared reliably by improving the
  game. It can be cleared by a favourable draw.
- **Any delta under about 27 points is not information.** Most movement recorded in
  `docs/dossier.json` before round 41 falls under that width and must be re-read as a single draw
  rather than a measurement. Those numbers stay in the record — deleting them would hide the mistake.

## What was reliable in the same data

In the same four runs, and in the three that followed on the next capture:

- **the blind pick was unanimous every time** — 4 of 4, then 3 of 3, all losses;
- all four named the **same three defects in the same order**;
- all four named the **same strength**.

The qualitative half converged completely while the scalar spanned 27 points. **The blind comparison
this document was written to specify is the part that works. The score was an addition, and it is the
part that does not.**

## The verdict, from now on

**1. The primary result of a round is the blind-pair win rate**, reported as `wins-draws-losses` over
the matched pairs, pooled across at least three independent critics. It is countable, it has no scale
to anchor, and it is the question the charter actually asks: *which image would you believe came from
a shipped AAA title.*

**A subsystem ships when it stops losing.** Concretely: **no losses across at least nine pooled pairs,
with at least one outright win.** "Genuinely wowed, not merely satisfied" is a critic picking our
frame over Tekken's, not a number crossing a line.

**2. Scores may still be reported, but never alone and never as a single sample.** Minimum three
independent critics, and always as `median (range lo-hi)`. A lone score in a brief, a dossier entry or
a commit message is a defect.

**3. The ranked findings outrank both.** Four critics naming "no independent coloured rim" is far
stronger evidence than any of their four numbers, and it is the only part that is directly
actionable. Steer on findings; use the win rate to decide whether to ship.

**4. Critics' explanations are hypotheses, not data.** All four also explained the best-looking arena
as *"a complementary colour key per fighter"*. **There is no per-fighter keying anywhere in this
project** — both fighters take identical light colours in every arena, and that arena is simply the
only one of seven with inverted key/rim temperature. Four independent observers agreeing produced a
confident, specific, false mechanism that went into a brief as fact.

**Unanimity does not protect against a shared wrong explanation**, because instances of one model
share priors. Take what a critic *sees* as data and what it says *caused* it as a hypothesis to check.
Every time an agent on this project checked a mechanism it was handed rather than executing it, the
check was worth more than the task.

**5. Ask the pointed question as well as the open one.** The blind protocol finds what is wrong. It
does not reliably find whether the last change broke something, because a critic answers the question
it is asked. Round 41 added one line — *is the rim over-applied?* — and 3 of 3 returned converging,
load-bearing evidence of a regression. Without that line the honest answer to "is there a rim now"
was yes, and the regression would have shipped.

**Every round that changes something must ask its critics specifically about that change**, in
addition to the blind pairs.
