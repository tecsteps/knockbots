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
