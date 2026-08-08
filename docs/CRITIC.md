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

---

# SECOND SUPERSEDING CORRECTION: a warm/cool edge split is the material working, not an artifact

A critic on the character axis reported, as its highest-impact finding, *"every panel corner, rivet and
pipe edge shows a duplicated red/cyan-tinted offset copy — an edge-doubling/ghosting artifact."* It was
believed, published twice, and queued as the top visual fix.

**An ablation pass with a 0/255 null refutes it completely.** There is no duplicated copy. There is no
TAA pass in this renderer at all. Motion blur changes exactly zero pixels. Supersampling 9x does not
touch it. Whole-frame R→B registration is 0.03 px.

**What it is:** the warm/cool split across every strong edge — the bevel shading itself. Measured by
walking the luma-gradient normal *across* the top-0.5% edges versus walking *along* them:

```
                across edge   along edge   ratio
01-hero-idle      17.7/255      0.8/255     22x
03-full-body      19.1/255      1.9/255     10x
09-roster         36.6/255      1.2/255     30x
```

A warm line and a cool line one to two pixels apart on every bevel, rivet and pipe. Read blind, that is
genuinely indistinguishable from a doubled edge — which is why a careful critic reported it in good
faith and why nobody caught it for several rounds.

## Why this is a protocol failure and not a critic's mistake

**More material differentiation produces MORE of this signature.** So the axis's own top-ranked
fix — differentiate the materials — makes its own top-ranked complaint worse. Every round spent
widening the roughness, metalness and coat spread strengthened the "artifact" and was then penalised
for it.

**The rounds were not cancelled by a defect. They were marked down for succeeding.**

That is worse than a noisy instrument. A 27-point spread wastes rounds; **an instrument that inverts
sign on its own advice spends them going backwards**, and does so consistently rather than randomly.

## The rules that follow

1. **A chromatic edge is not evidence of an artifact.** On a metal robot lit warm-key/cool-rim, a
   warm-and-cool pair one or two pixels apart across a bevel is the *intended* result. Do not report
   it as ghosting, doubling, fringing or aberration.
2. **The discriminator is direction, and it is cheap.** An artifact is indifferent to edge
   orientation; shading is not. If the chroma swing runs *across* the edge and vanishes *along* it, it
   is shading. A ratio near 1 is an artifact; the ratios here are 10x to 30x.
3. **Chromatic aberration is off and has been for many rounds.** `look.chroma` is `0.0`, and
   `capture.mjs` additionally zeroes it at the freeze for the closeup. Three separate critics have now
   filed it. **It is not there.** Any report of it is a report about something else.
4. **Do not act on a rendering-defect claim before it is isolated.** This one was only caught because
   it was handed to an *isolation* pass with a null control rather than to a repair pass. A repair pass
   would have found something to change, and the axis would have got worse.
5. **When a fix and a complaint move together, suspect the complaint.** If the thing the axis asks for
   reliably increases the thing the axis penalises, the rubric is describing one phenomenon in two
   contradictory ways, and no amount of work resolves that from the code side.

---

# THIRD CORRECTION: the character reference subset is classified by framing and not by material

The per-image table above records **framing** — closeup, wide, rage art — and that is what got `ref/06`
out of the stage list. It records nothing about **what the reference is made of**, and on an axis
called *character rendering* that is the property that decides the pair.

A critic ran the **full six-reference closeup population** and its record split cleanly:

```
DRAWS   tekken8_01  leather jacket, metal choker, chain, skin
        tekken8_05  glove: leather wrap vs metal knuckle band
        tekken8_08  jaguar-fur mask, oiled skin, mic mesh, gold chain

LOSSES  tekken8_03  dove — individual feather barbs, hair flyaways
        tekken8_04  skin pores and wrinkles, croc-embossed leather
        tekken8_09  cat — per-strand fur, colour-point shading, ear translucency
```

Its reading: *"the mechanical-plate material does not lose to mechanical-adjacent materials — King's
mic mesh and chain, Jin's knuckle plate. It loses specifically against organic strand-level rendering,
which the robot cast structurally cannot present."*

**This is a hypothesis and it has a counterexample.** `tekken8_08` carries a full jaguar-fur mask and
came back a **draw**, which a simple "fur present -> loss" rule does not survive. The honest form is
narrower: the losses cluster where **strand-level organic detail is the dominant subject of the
frame**, and the draws cluster where metal, leather and chain are the comparison point — including one
frame that contains fur but is not about it.

## Why this belongs in the protocol rather than in a critic's caveat

The ship bar is **no losses across nine pooled pairs**. If some references cannot be won by a cast made
entirely of machines, the bar is not merely hard — it is **unreachable by construction**, which is the
same defect as the `p90 >= 12` tile-contrast gate that exceeded every matched reference in linear
light, and as `ref/06` sitting in a stage list for four rounds.

**No round should be spent trying to out-render a dove.**

## The rules

1. **Classify a character reference by its dominant material, not only its framing.** A frame whose
   subject is hair, fur or feather is testing a capability this project does not have and will not
   acquire — every mesh is generated in code and every character is a machine.
2. **Report those pairs, do not silently drop them.** A loss to strand rendering is a real observation
   about the frame; it is just not a finding about the material work. Critics have been flagging this
   themselves, unprompted, and were right to.
3. **The ship bar counts pairs where the comparison is possible.** Nine pooled pairs, no losses, at
   least one win, **against references whose dominant material a robot can present** — metal, leather,
   painted surface, glass, rubber. That is the honest reading of "presentation that holds up in a
   screenshot comparison" for a game whose cast is machines.
4. **This does not lower the bar and must not be used to.** Against the metal-and-leather references
   the axis currently draws — it does not win. Three draws is not three wins, and the remaining gap
   there is real: hero plate still covers 60%+ of surface area, and closeup-scale material gains do not
   survive to in-match camera distance.

---

# FOURTH CORRECTION: the character axis is scored 5.5x tighter than the game is played

Measured, on a pinned camera and pose with a 0.00/255 within-session floor:

```
framing            distance   fov    screen px/m   mm per screen px
02-closeup-face      1.27 m    24        2003            0.50
03-full-body         3.98 m    30         507            1.97
01-hero-idle         4.59 m   35.5        367            2.72
```

`02-closeup-face` is the only true closeup we own, all six usable character references are closeups,
and so **every material verdict this axis has produced has been reached at 5.5x the resolution the
game is actually played at.** Nothing finer than about 5.5 mm on a robot survives a fight frame.

Two critics reported this independently before it was measured — *"material legibility drops sharply
at hero-idle distance versus closeup scale; the in-match framing is wide, so that is the framing that
actually matters"* — and both were right.

## Why this is not a small bookkeeping point

Distance does not cost every material the same. Fraction of tangent-slope variance surviving the mip
level each framing selects:

```
material        closeup   fight     surface m2
kb.gasket         100%    88.5%        5.77
kb.armor          100%    52.4%       14.18
kb.darkMetal     27.2%     1.3%       20.60
kb.piston        26.1%     1.3%       12.08
```

**The two largest surfaces — 32.7 of 58 m² — arrive at fight framing having lost 98.7% of their
structure, while the gasket keeps 88.5%.** The roster's *order* by apparent micro-structure **inverts
between the two framings.** A ranking produced at closeup does not merely weaken at distance; it can
reverse.

So an axis scored only at closeup will keep recommending work on surfaces that are already invisible
where it counts, and keep crediting improvements a player will never see. Four rounds of material
work were validated this way.

## The rule

1. **Score character at in-match framing, and let that gate shipping.** `01-hero-idle` at 367 px/m is
   what a player looks at. A material win visible only at 2003 px/m is not a win.
2. **Closeup stays, as diagnosis rather than verdict.** It is where a defect is *identifiable* — the
   strut's wood grain was only nameable there. Use it to find causes; do not use it to decide whether
   the axis has improved.
3. **And the honest problem with (1): the wide reference population is n=2** — `tekken8_02` and
   `tekken8_07`, one of which is the documented 2.1x density outlier. That is thin, and it is the same
   thinness the stage axis has. **Report both values, never a distribution, and say n=2 every time.**
   A verdict at the right framing against two references is still better than a confident verdict at a
   framing nobody plays at, but it is not strong evidence and must not be written up as though it were.
4. **A crop offered as proof must be at the framing the claim is about.** An improvement demonstrated
   at closeup, for an axis gated at fight distance, is not evidence — it is the flattering framing,
   which is how this axis spent four rounds.

---

# STAGE AXIS, ROUND 44: the midground did not move the verdict

Blind pair, `01-hero-idle` vs `tekken8_02`, four independent lenses. n=2 wide
references and this is one of them.

```
lens       BEFORE (no midground)   AFTER (midground live)
depth               B                       B
place               B                       B
craft               B                       B
staging             A                       A
tally            1W-0D-3L                1W-0D-3L
```

**Identical, lens for lens.** The measured improvement was real — the 9–13 m band went
7.68% → 18.85% of frame and occlusion boundaries rose 19% on the pit, 15% on the roof —
and it **changed no critic's mind about anything.** The stage axis stays at a loss.

The before-arm exists only because the first panel accidentally read a stale frame,
which turned a design flaw into the control the run needed.

## What did change: the failure mode

Before, all three losing lenses described an **absence**:

> *"A resolves into essentially two planes… every element laid side by side in one band…
> no foreground element whatsoever."*

After, all three describe the **thing that was added**:

- **place** — *"A single module repeated at constant size and constant depth across the full
  width… left group and right group are visibly the same geometry… no stacking, no rotation
  variance, no contact shadow tying any of them to the ground, and no reason for cargo to be
  lined up like fenceposts at the edge of a fighting floor. It is the frame's clearest
  statement that the background was filled rather than built."*
- **craft** — *"untextured, uniformly-coloured cuboids with unbevelled 90-degree corners…
  in the exact area the eye rests between fighters."*
- **depth** — the crates still fail to cross a depth boundary; nothing occludes anything.

So the layer traded *empty* for *obviously synthetic*. That is not nothing — the empty band
was confirmed independently by two unrelated instruments and had to go — but **"measured
fuller" and "reads as a place" are separate claims, and only the first was earned.**

## The four named fixes, all cheap, all concrete

1. **Kill the even interval.** Two or three unequal clusters with a wide empty gap; rotate
   each unit off-axis; stack a couple two-high; tip one on its side.
2. **Stop being primitives.** Bevel every edge 1–2 cm so corners catch a specular line; give
   them plank or stamped-metal seams, a stencil, and varied footprints so no two match.
3. **Contact shadows.** Nothing ties a crate to the floor, so nothing sits *on* it.
4. **The full-width light bar at y≈400** — and this one is not the midground's fault, it is
   pre-existing and it may be the single highest-value fix in the frame:

> *"It spans x=0 to x=1920 at a fixed height, with unvarying thickness and no perspective
> convergence, and nothing in the scene ever occludes it… It is the single element that
> certifies the entire backdrop as a flat plane, and it is sitting precisely where a ringside
> rail should be giving the strongest convergence cue in the frame."*

## The one win, and why it is a real one

`staging` picked ours, twice, at high confidence — and did it while explicitly refusing to
credit us for the wrong reason:

> *"Neither frame is given away as fake by staging, and I am not scoring that… B's problems
> are art-direction and shot-selection: a real, coherent, high-detail city set that was never
> value-suppressed behind the P1 side… Nothing looks unfinished — it looks finished and
> staged badly in this particular frame."*

A critic that names why the reference lost, rather than just picking, is the kind of verdict
worth having. It is also a reminder that a single frame of a shipped game is not that game.
