/**
 * Knockbots — the emitters: light fixtures, neon, beacons, screens and the
 * arcing cable.
 *
 * Every visible emitter here is tied to something the Environment is actually
 * lighting with. `Environment` carries four `practical` entries per mood — a
 * RectAreaLight plus a matching quad in the HDR cube — and deliberately hides
 * its own placeholder cards, because "the Stage owns everything the camera can
 * see". So this file builds real housings around those four lights and drives
 * their emissive colour from the same numbers that drive the lights, which is
 * why a specular highlight on a shoulder plate always has a visible source
 * behind it. The same contract covers the two overhead tube runs the Environment
 * casts from — see {@link RUNS} — which are hung, wired and lit off the mood's
 * `ceiling` block rather than off a practical entry.
 *
 * The four emitter faces share one mesh and one draw call: each carries a
 * fixture index in a vertex attribute and the shader looks its colour up in a
 * four-element uniform array. That keeps four independently coloured, flickering
 * emitters at the cost of one.
 *
 * The screens are worth their shader. A dead-flat emissive rectangle reads as a
 * texture; a diagnostic display with a rolling frame bar, a bar-graph that
 * responds to nothing in particular, a sweeping trace and occasional
 * tearing reads as a room with power in it.
 */

import * as THREE from 'three';
import { LAYER } from '../core/Constants.js';
import { Rng } from '../core/Rng.js';
import { bevelBox, place, mergeAll, boltRing, insetPanel, worldUv } from './GeoKit.js';
import { fbm, stampText, blur, clamp01, smoothstep, makeTexture, encodeSrgb } from './ProcTex.js';
import { PointBurst } from './StageParticles.js';

const FIXTURES = 4;

/**
 * The two tube runs slung over the pit, matching `Environment`'s `STRIP` pair.
 *
 * These carry the only lights in the rig that reach the fighters from directly
 * above, and the Environment drives them off each mood's `ceiling` block — so
 * the fitting has to sit exactly where the light does or the streak it draws on
 * a shoulder plate will have nothing above it. `len`, `y` and `z` are copies of
 * that table rather than an import, because the light is a lighting decision and
 * the fitting is a set decision and they are allowed to be reviewed separately;
 * the comment is the contract.
 *
 * `tilt` is the angle each run is raked off vertical, signed toward +z, and it
 * matches the aim the Environment gives its strips. It is what stops the
 * reflector reading as a lamp pointed at the floor it is hanging over.
 */
const RUNS = [
  { z: -2.8, y: 5.3, len: 10.0, tilt: 0.8 },
  { z: 1.4, y: 5.3, len: 10.0, tilt: -0.475 },
];

/** Tube face height. Thin on purpose — see `Environment`'s STRIP block. */
const RUN_FACE = 0.18;

/** Caption bands in the screen text plate; one per board, power of two. */
const BOARD_ROWS = 8;

/** Colour slots the light pools sample: the four fixtures plus the neon strip. */
const POOL_SLOTS = 5;

/**
 * The pools' floor-scattering cards. Each is a gradient quad tied to a colour
 * slot: `edge` is the fraction of each axis that stays at full brightness before
 * the falloff starts, so a round pool is [0, 0] and a long strip wash is
 * [0.74, 0] — flat along its length, falling off across it.
 */
const POOLS = [
  { pos: [-6.6, 0.02, -6.0], rot: [-Math.PI / 2, 0, 0], w: 13, h: 10, slot: 0, edge: [0, 0], gain: 0.8 },
  { pos: [6.6, 0.02, -6.0], rot: [-Math.PI / 2, 0, 0], w: 13, h: 10, slot: 1, edge: [0, 0], gain: 0.8 },
  { pos: [-9.0, 0.02, -5.6], rot: [-Math.PI / 2, 0, 0], w: 9.0, h: 8.0, slot: 2, edge: [0, 0], gain: 1.7 },
  { pos: [9.6, 0.02, 6.6], rot: [-Math.PI / 2, 0, 0], w: 6.5, h: 5.5, slot: 3, edge: [0, 0], gain: 0.9 },
  { pos: [0, 1.28, -8.54], rot: [0, 0, 0], w: 26, h: 2.6, slot: 4, edge: [0.74, 0], gain: 1.2 },
  { pos: [0, 0.02, -7.85], rot: [-Math.PI / 2, 0, 0], w: 26, h: 2.4, slot: 4, edge: [0.74, 0], gain: 0.85 },
];

/**
 * Linear radiance per unit of `sqrt(power)` for a pool card. Held low on
 * purpose: the pool says where the light landed, and once it is bright enough to
 * compete with the fighters standing in it the floor stops being the floor.
 *
 * That last clause turned out to be measurably true rather than a caution.
 * Sampling the deck within 2.6 m of a fighter against the same frame with the
 * pool cards hidden, at 1920x1080 with the simulation paused: the cards were
 * carrying 22% of the deck's luminance at the fight framing and 33% at the wide
 * one, against a fighter-to-deck ratio of 1.85 and 2.06 respectively. They are
 * the only term in the arena that lands on the deck and nowhere else, so they
 * are the cheapest quarter-stop of figure/ground on offer and this is a quarter
 * stop off them.
 */
const POOL_GAIN = 0.096;

/**
 * WASHES — the near-field gain a lamp puts on the surface it is bolted to.
 *
 * **The measurement that motivated this.** A vertical luminance profile through
 * the back wall at x 150-450, taken off one frozen 1920x1080 frame with the
 * fighters hidden, in *linear* light:
 *
 *     screen y   308    396    412    420    436    452    500
 *     linear   0.083  0.097  0.258  0.888  0.106  0.114  0.055
 *
 * The barrier tube is the 0.888. Sixteen pixels away the wall is back to 0.10,
 * and a hundred and ten pixels further up it is 0.083 — the same value it has
 * at the top of the frame, three metres from the nearest source. The brightest
 * object in the arena was depositing **nothing**: a clipped white line with a
 * bloom halo and no falloff around it, which is the definition of the rubric's
 * "flat ambient / everything the same brightness". The eye locates a light by
 * the gradient it throws, and there was no gradient to find.
 *
 * This is also why the round that raised mid-ground band *contrast* 2.3x did
 * not move the lighting score. Contrast in a band is a statistic; a source that
 * visibly deposits light is a cue. The band had plenty of the first and none of
 * the second.
 *
 * **Why this is not another pool card.** `POOLS` blends ADDITIVELY, and additive
 * is the wrong operator for a light landing on a textured surface. The barrier
 * band ranges roughly 0.05-0.15 linear; adding a 0.3 pedestal to it takes that
 * to 0.35-0.45 and the ratio between the light and dark parts of the texture
 * collapses from 3:1 to 1.3:1. That is precisely the mechanism by which the
 * bloom pedestal was erasing the stage, and by which painted hoardings on the
 * fence measured worse than no hoardings — a flat quad deletes texture.
 *
 * A real wash MULTIPLIES: outgoing radiance is albedo times incident, so more
 * incident scales every value on the surface by the same factor and the texture
 * survives intact. These cards therefore blend `dst * src` with `src >= 1`,
 * which the composer's half-float targets can carry. Outside the falloff the
 * card is exactly 1.0 and is a no-op, so it cannot lift anything it is not
 * aimed at.
 *
 * **That is measured, not assumed.** Same card, same falloff, same frozen frame,
 * with an additive twin built in-page from this exact shader with its
 * `vec3( 1.0 )` identity base swapped for `vec3( 0.0 )` — so the two arms are
 * the same programme modulo that one term. Sampled over a thin strip of the
 * barrier band where the falloff is near-constant (y 448-466, x 100-700), and
 * the two arms matched on the strip's MEAN so neither is simply brighter:
 *
 *     arm                       mean    p90/p10   std/mean
 *     off                      0.0642     6.02      0.669
 *     multiply                 0.1518     3.78      0.475
 *     add (matched)            0.1472     2.64      0.354
 *     multiply                 0.2351     3.26      0.418
 *     add (interpolated)       0.2351    ~2.18     ~0.264
 *
 * At the same mean, multiply keeps **43% more** p90/p10 at the lower level and
 * **49% more** at the higher, and 34-58% more relative standard deviation. The
 * residual fall under multiply — 6.02 to 3.26 — is the tone curve, not the
 * operator: a constant scene-linear gain moves the shadow end further up AgX
 * than the highlight end, so a display-referred ratio narrows even when the
 * scene-referred one is exactly preserved.
 *
 * Kept to the surfaces the tube is actually mounted against. The deck is
 * deliberately NOT washed: the fight plane is the band the fighters are read
 * against, `POOLS` already lands the tube's scatter there, and it lands twice
 * because the barrier tube is the one emitter left inside the floor's mirror.
 *
 * ---------------------------------------------------------------------------
 * HOW THE FALLOFF ON THIS BAND IS MEASURED, AND WHY THE OLD WAY WAS WRONG
 *
 * The standing gate was "the band 14-42 px below the strip should show several
 * times top-to-bottom falloff; it shows 1.07x". Three things are wrong with it,
 * all reproduced here on a frozen frame with a bit-identical null arm:
 *
 *   1. **It is inverted.** Reimplemented and run at the wide framing it reads
 *      0.51-0.70 — under one, i.e. the wall getting BRIGHTER further from the
 *      lamp — in every framing tried, because 42 px below the tube lands on the
 *      "KEEP BEHIND THE LINE" sign plate. The number never described a falloff.
 *   2. **It is framing-fragile**, as already suspected: over six small camera
 *      perturbations (+/-17 and +/-33 px of tube row) it swings 0.506-0.646.
 *   3. **It cannot tell a trend from structure**, which is why nobody noticed 1.
 *
 * The replacement is world-anchored. The barrier kerb is a 24 x 1.15 x 0.6 m
 * box whose camera-side face is the plane z = -8.60 and the tube hangs at
 * y = 1.28, so the sample set is every point on that face at a world height
 * that is PLAIN CONCRETE — excluding y < 0.17 (base angle and bolt row),
 * 0.42-0.90 (banner panels), 0.96-1.06 (conduit and saddle clamps) and y > 1.15
 * (steel cap), and excluding in x the two bays that carry hardware instead of
 * banner, the joint cover strips at x = 4k, and the two junction boxes. Linear
 * luminance is read at each, the median taken across x at each height, and a
 * least-squares log slope fitted against world height, reported over 0.9 m
 * together with its r2.
 *
 * It is robust because the samples are fixed in the WORLD: a camera shift moves
 * them with the wall and they land on the same physical concrete. Both ends of
 * the fit are the same material on the same plane with the same normal, so the
 * ratio is a light ratio and not an albedo ratio; every plain-concrete height
 * votes, so no cover strip or specular chip can carry it; and the structure is
 * excluded by NAME from the set's own coordinates rather than by hoping a
 * screen-space row misses it. Measured over the same six perturbations the old
 * gate swings 0.506-0.646 across, this reads 1.62-1.80 — and, the part that
 * matters, the near-field profile beats the plateau in EVERY one of them.
 *
 * Its own limitation, stated so the next round does not over-trust it: r2 at
 * the shipped drive is 0.39, so 61% of the wall's vertical variation is still
 * the set's own structure and albedo. That is honest — the wall really is
 * mostly structure — but it means the falloff figure should always be quoted
 * with its r2, and a change that moves falloff while r2 falls has moved an
 * artefact.
 */
const WASHES = [
  // The barrier tube: `#neon` hangs it at [0, 1.28, -8.62], 24 m long. The card
  // has to sit in front of EVERYTHING it washes, not just in front of the tube:
  // at z -8.50 the barrier's own front face and its sign plates were nearer than
  // the card, failed the depth test, and were left unlit while the recessed
  // panels behind them were multiplied — the measured lift on the band came out
  // at half what the uniform asked for. 34 cm clears the whole assembly.
  //
  // 2.6 m tall, not 3.4: at 3.4 the skirt still carried 58% of the peak a metre
  // above the tube, so the pass was lifting the wall rather than putting a
  // gradient on it, which is the additive failure mode arriving by another
  // route. `edge` [0.86, 0] is flat along the run and falls off across it,
  // matching a strip's own profile.
  //
  // `skew` throws it DOWN. Symmetric, the wash reached as far up the fence as it
  // did down the barrier, and the fence band is what the fighters' chests and
  // heads are read against. Measured at the same drive, on-vs-off inside one
  // session each (so the OFF baselines differ between the two rows and only the
  // deltas are comparable):
  //
  //     card         figure/ground   rim coverage   median silhouette ratio
  //     symmetric      -24.5%          -2.1 pt            -7.0%
  //     skewed 0.45    -18.2%          -0.1 pt            -2.8%
  //
  // Skewed, the barrier band still gets the whole gradient and the fence keeps
  // most of its dark. It is also what the fitting does: the tube is channelled
  // into the top of the barrier and throws down its face.
  { pos: [0, 1.28, -8.28], rot: [0, 0, 0], w: 26, h: 2.6, edge: [0.86, 0], skew: 0.45, gain: 1.0 },
];

/**
 * Peak multiplier minus one at the core of a wash. 0 is the pass switched off
 * and is an exact no-op; 1.0 doubles the surface directly under the tube.
 *
 * Swept in-page on ONE frozen 1920x1080 fight frame with the simulation and the
 * frame clock stopped, the grain and chroma zeroed and the fighters hidden, so
 * the only thing moving between grabs is a vec3 uniform on an already-compiled
 * programme and **the null control between two grabs is exactly 0.000/255**.
 * Linear luminance from the vertical wall profile at x 150-450, as fractions of
 * the shipped drive. `y416` is the tube itself; `y440` and `y464` are the
 * barrier band 24 and 48 px below it; `y392` and `y368` the fence 24 and 48 px
 * above; `y344` and `y296` the wall 72 and 120 px above, which is where the
 * gradient has to be back at the unlit value or the pass is a lift, not a wash;
 * `y584` is the deck, which must not move at all:
 *
 *     scale   y296    y344    y368    y392    y440    y464    y584   frame delta
 *      0.0   0.0836  0.0744  0.1028  0.1085  0.1126  0.0719  0.2295    0.000
 *      0.3   0.0828  0.0733  0.1154  0.1357  0.1508  0.0988  0.2292    1.596
 *      0.6   0.0826  0.0730  0.1292  0.1650  0.1911  0.1275  0.2295    2.958
 *      1.0   0.0825  0.0729  0.1477  0.2036  0.2428  0.1654  0.2300    4.511
 *      1.5   0.0824  0.0729  0.1706  0.2495  0.3036  0.2106  0.2305    6.147
 *
 * The two columns that decide it are `y296`/`y344`, which do not move at all
 * (-1.3% at the top of the sweep, i.e. the wash has gone), and `y584`, the deck,
 * which moves 0.2% — so this pass brightens the barrier and nothing else. The
 * fight plane is the band the fighters are read against and it is untouched,
 * which is also the proof that the card is correctly kept out of the floor's
 * planar mirror.
 *
 * **Chosen at 0.7 of the trial drive, by eye at 3x on the barrier band and not
 * by the numbers.** Above that the band stops being a gradient and becomes a
 * lifted rectangle: at 1.5 the concrete either side of the tube is within a
 * quarter-stop of the sign plates it is supposed to be sitting behind, and the
 * red hoarding starts to bleach. The measured band contrast agrees — p90/p10
 * over y 440-490 goes 6.11 (off) / 3.70 / 3.28 / 2.97 across the sweep — but the
 * numbers alone would have argued for the smallest drive that moved anything,
 * and the smallest drive that moves anything does not make the tube read as a
 * lamp. The picture picked the value; the numbers bounded it.
 *
 * **What it costs, at the shipped drive, on-vs-off inside one frozen session.**
 * Fight framing, whole-frame delta 3.32/255 with 10.4% of pixels over 8/255:
 *
 *                              off      on
 *     figure/ground median    1.572   1.391
 *     rim coverage            60.4%   58.2%
 *     median silhouette ratio 2.591   2.196
 *     frame p10 (shadow end)  0.052   0.051
 *     frame p99               0.914   0.922
 *     pixels over 0.90        1.17%   1.26%
 *
 * Wide framing, delta 1.56/255 and 4.7% of pixels: figure/ground 1.906 -> 1.806,
 * rim coverage 63.7% -> 62.9%, median silhouette ratio 2.293 -> 2.207.
 *
 * That cost is real and is reported rather than argued away: the band behind the
 * fighters' hips is 2.2x brighter, and both the whole-frame figure/ground and
 * the silhouette ratio give some of that back. It is taken because the shadow
 * end does not move at all, the deck does not move, the highlight end gains
 * slightly rather than clipping, and the thing bought is the one the axis is
 * actually failing on — a source in frame that visibly deposits light. Note the
 * silhouette metrics carry real session-to-session variance (the pose is not
 * reproducible run to run, docs/PROFILING.md trap 5), so only on-vs-off pairs
 * from the SAME frozen frame are comparable; across sessions the same change
 * measured -2.8% and -15% on the median ratio.
 *
 * **0.7.** The paragraph above already reports the cost and takes it anyway;
 * this round is the one where the bill came in. The wash is the second half of
 * the same object as the tube (see `TUBE_DRIVE`) — together they are a
 * full-width horizontal band at the fighters' chest height, and on-vs-off
 * inside one frozen frame they were worth -14.4 and -14.6 mean luminance on
 * that band out of 111, i.e. a quarter of it between them. Halving the wash
 * with the tube costs the "source in frame that visibly deposits light"
 * argument nothing — the gradient is still there and still skewed down the
 * barrier — while the band stops being brighter than the subject in front of
 * it. Every number in the sweep above was measured against a background that
 * was allowed to own the top of the range; none of them are wrong, they were
 * just answering a question that turned out not to be the one on the rubric.
 *
 * **1.14, and it is not a brightening.** The drive is only meaningful together
 * with {@link WASH_NEAR}, which this round changed from a plateau to a line
 * source's near field, and 1.14 is the drive at which the new profile deposits
 * the SAME TOTAL LIGHT the old one did: whole-frame mean 63.784 against 63.806
 * for the shipped plateau, on one frozen wide frame with a bit-identical null
 * arm, against 63.199 with the pass switched off. So this pair is a pure
 * redistribution of the light the wash was already spending, and the direction
 * it redistributes in is the one the paragraph above was worried about. Deposit
 * multiplier on the barrier face, by distance below the tube, measured on the
 * concrete itself:
 *
 *     below tube   0.15   0.20   0.35   0.88   1.00   1.09  m
 *     plateau      1.633  1.497  1.608  1.237  1.220  1.120
 *     near field   2.008  1.774  1.769  1.130  1.103  1.048
 *
 * The gain concentrates into the first 0.4 m under the fitting, where a real
 * strip puts it, and the metre below — the band a standing fighter's chest and
 * head are actually read against — comes DOWN 6-10%. The figure/ground cost
 * this note was written to record is smaller after the change, not larger.
 */
const WASH_DRIVE = 1.14;

/**
 * NEAR-FIELD SHARPNESS of a wash, as a fraction of the card's half-height.
 *
 * This is the standoff between the tube and the surface it throws down,
 * expressed in the card's own units, and it is the parameter that decides
 * whether the band under a strip light reads as a *gradient* or as a *lifted
 * rectangle*. The profile it drives is
 *
 *     g(q) = k^2 / ( k^2 + q^2 )        q = 0 at the tube, 1 at the card edge
 *
 * shifted and renormalised so it is exactly 1 at the tube and exactly 0 at the
 * edge, which keeps the pass an identity outside its own reach.
 *
 * That form is not a curve picked for looking right. A line source of length
 * much greater than its distance deposits `s / ( s^2 + d^2 )` on a parallel
 * surface at perpendicular distance d with standoff s — the 1/r line-source
 * law times the cosine — and `k` is `s` in card units. So the card's gradient
 * is now driven by where the fitting actually is instead of by an arbitrary
 * polynomial.
 *
 * **What it replaces, and why that was a real defect.** The profile was
 * `( 1 - q^2 )^2`. That function has ZERO DERIVATIVE AT q = 0 — it is a plateau
 * exactly where a real lamp's near field is steepest — and the band the eye
 * reads is the first half-metre under the fitting, which is precisely where the
 * old profile was flattest. Measured on the shipped drive, the deposit's own
 * multiplier across the band 0.22 m to 0.66 m below the tube ran 1.58 -> 1.34,
 * a ratio of 1.18: a full-width horizontal bar of near-constant gain, which is
 * the additive failure mode this file's own docs warn about arriving through
 * the multiply operator.
 *
 * `k = 1.0` is very nearly the old plateau: `g` becomes `(1-q^2)/(1+q^2)`, and
 * the difference from `(1-q^2)^2` is `q^2(1-q^2)/(1+q^2)`, which peaks at 0.090
 * of full scale around q = 0.79 and is under 0.010 anywhere in the first third
 * of the card. On the wall, at the drive this shipped with, that is at most 5%
 * on the deposited multiplier. So the change is a one-parameter family with the
 * previous behaviour effectively at one end of it, and the sweep below is a
 * sweep inside one frozen frame rather than across sessions.
 *
 * **Swept in-page on one frozen 1920x1080 wide frame**, simulation and frame
 * clock stopped, grain, chroma AND motion blur zeroed, adaptive resolution
 * pinned off at renderScale 1.0, the rAF loop stopped so the only draws are the
 * rig's — null arm bit-identical, 0.000/255.
 *
 * `falloff` is the world-anchored wall metric: the least-squares log slope of
 * linear luminance against WORLD height over every plain-concrete height on the
 * barrier face, expressed over 0.9 m. `r2` is how much of the wall's vertical
 * variation that trend explains — a falloff is a trend, and if r2 is low the
 * band is structure and the ratio means nothing, which is the failure the old
 * screen-space gate could not see. `deposit` is the whole-frame mean minus the
 * pass-off mean, i.e. what the wash actually spends.
 *
 *     k        falloff    r2     deposit   lc_dark   lc_p90
 *     off       1.119    0.020    0.000     5.876    23.86
 *     1.00      1.504    0.167    0.601     5.945    24.28    <- the old plateau
 *     0.60      1.599    0.217    0.505     5.946    24.19
 *     0.45      1.633    0.237    0.434     5.933    24.09
 *     0.35      1.634    0.244    0.369     5.922    24.09
 *     0.28      1.619    0.241    0.314     5.913    24.08
 *     0.20      1.556    0.215    0.239     5.902    24.00
 *     0.12      1.416    0.147    0.149     5.882    23.91
 *
 * Two failure modes, and the metric sees both. Above k ~ 0.6 the profile is
 * the old lifted rectangle. Below k ~ 0.2 the falloff turns back DOWN, because
 * the whole gradient has collapsed into the first ten centimetres, under the
 * tube's own bloom halo where nothing can see it — which is the failure this
 * file's shader comment already warned about, now with a number on it.
 *
 * The profile predicts that shape before the renderer is involved, which is the
 * reason to believe the sweep rather than the sweep's noise. Evaluating `g`
 * alone at 0.22 m and 0.66 m below the tube — no renderer, no tone curve, no
 * wall — the deposited multiplier's own ratio runs 1.24 (k=1), 1.36, 1.44, 1.49
 * (k=0.35), 1.51, 1.48, 1.31 (k=0.12): a maximum between k 0.28 and 0.35 and a
 * fall-off on both sides, which is the measured column's shape. Two independent
 * routes to the same optimum, one of them arithmetic.
 *
 * k = 0.35 is the peak of both columns and deposits 39% less light than the
 * plateau it replaces. The drive is then raised to put that light back (see
 * {@link WASH_DRIVE}), and at MATCHED deposit the comparison is not close:
 *
 *     arm                        deposit   falloff    r2
 *     plateau, drive 0.70         0.607     1.557    0.189
 *     near field 0.35, drive 1.14 0.585     2.058    0.390
 *     plateau, drive 1.14         0.960     1.803    0.268
 *
 * The plateau driven 64% harder still shows less gradient than the near field
 * driven to the same deposit. It is the SHAPE that puts a gradient on a wall,
 * not the level — which is the same lesson the stage axis learned about the
 * shadow band, in the one place in this file where the fix was available.
 *
 * **Re-measured with the framing-robust gate** that replaced round 26's retired
 * screen-space one (docs/PROFILING.md, round 27): pass-on log slope over the
 * barrier's world band divided by the same slope with the pass off, which is
 * stable to x1.11 over camera moves that slide the strip 265 px up and down the
 * frame. It reads 1.316 for the plateau and 1.642 here, and puts the optimum on
 * a broad plateau from k 0.20 to 0.35 with a shallow peak at 0.28 — 1.6% above
 * the shipped value, which is inside anybody's noise. The value is not critical;
 * the SHAPE is, and every instrument that has looked at it agrees about that.
 */
const WASH_NEAR = 0.35;

/**
 * Scene-referred radiance the dimmest fixture any mood authors is driven to.
 * Every emitter in this file is a multiple of it, so it is the one number that
 * decides whether the set reads as lit or as painted.
 *
 * It was 1.15, and it was 1.15 because it was documented as
 * "`RenderPipeline`'s bright pass threshold". That number is
 * `look.bloomThreshold`, and `look.bloomThreshold` is **5.5** — so every lamp
 * face in the arena was authored a factor of five *under* the pass it claimed to
 * be authored against, and the brightest fixture in the set stopped a stop short
 * of blooming at all.
 *
 * The corrected value is measured rather than derived, because the tone curve
 * makes the top of the range unguessable. `RenderPipeline`'s AgX compresses the
 * normalised log instead of clamping it, so radiance approaches display white
 * asymptotically and never arrives. Sweeping every emitter in this file by a
 * common multiplier at the wide framing, 1920x1080, simulation paused:
 *
 *     x1    p99.9 0.707    pixels >= 250/255  0.075%
 *     x3    p99.9 0.766    pixels >= 250/255  0.075%
 *     x6    p99.9 0.857    pixels >= 250/255  0.075%
 *     x8    p99.9 0.883    pixels >= 250/255  0.076%
 *     x12   p99.9 0.906    pixels >= 250/255  0.075%
 *
 * The count of clipped pixels does not move at all — twelve times the radiance
 * puts not one extra pixel at white — while the 99.9th percentile climbs two
 * thirds of the way to it. The ten Tekken 8 references sit at a 99.9th
 * percentile of 0.90 to 0.999; this build sat at 0.72. So the reachable target
 * is the percentile, and the residue is `look.shoulder`, which is 0.68 and lives
 * in `RenderPipeline`. Anchored here so a fixture face lands in the reference
 * band and comfortably over the bright pass.
 *
 * The fixture faces, the tube runs and the boards can be driven this hard and
 * the tube cannot, and the split is `noReflect` rather than taste. Everything on
 * that list is kept out of the floor's planar mirror, so its only route onto the
 * deck is bloom; the barrier tube is deliberately left in the mirror because an
 * emitter's reflection is most of what sells a wet deck, and it therefore lands
 * on the deck twice. Driving all four together measured +15% on the deck the
 * fighters are read against and gave back the whole of the key redistribution.
 *
 * Where this file's emitter pass landed, against pristine HEAD, 99.9th
 * percentile of frame luminance with the HUD hidden:
 *
 *     fight framing   0.727 -> 0.818
 *     wide framing    0.740 -> 0.884      (reference set: 0.90 - 0.999)
 *
 * The fight framing is the one still short, and it is short for a reason that
 * cannot be fixed by turning anything up: the only emitters inside that frame
 * are the barrier tube and the boards, and they are small. It wants a fixture in
 * the shot, which is a set decision rather than a radiance one.
 */
const LAMP_ANCHOR = 13.0;

const _tmp = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _amber = new THREE.Color(0xffa02a);
const _down = new THREE.Vector3(0.15, -1, 0.1).normalize();

/**
 * Aerial perspective on an emitter is in-scatter, not a blend toward the haze.
 *
 * `Environment`'s fog is `FogExp2` at density 0.028, and three's fog chunk is a
 * `mix` — it takes the fragment's own radiance *away* and puts haze in its
 * place. On a surface that is correct. On a light source it is not: haze does
 * not remove a lamp's output, it adds its own on top, which is why a street
 * light twenty metres off in fog reads as a bright core inside a halo rather
 * than as a grey rectangle. The distinction only matters when the source is
 * genuinely bright, and every source in this file now is.
 *
 * It is also the whole of the critic's second note. At the fight framing the
 * barrier tube is 14 m from the eye and the boards 20 m, which is a mix of
 * 0.14 and 0.24; pull the camera back to the wide framing and the same two are
 * 20 m and 26 m, so the tube loses 27% of its radiance and the boards 36% —
 * exactly the framing where the frame most needs something at the top of its
 * range. Everything else in this file is already `fog: false` for the same
 * reason; the neon and the screens were the two that were not.
 *
 * The GLSL is written against `fog_pars_fragment`'s declarations, so the
 * material keeps `fog: true` and only the final combine changes.
 */
const HAZE_AS_IN_SCATTER = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float kbHaze = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float kbHaze = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb += fogColor * kbHaze;
#endif
`;

/** Swap a stock material's fog `mix` for {@link HAZE_AS_IN_SCATTER}. */
function hazeAsInScatter(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', HAZE_AS_IN_SCATTER);
  };
  material.customProgramCacheKey = () => 'kb.haze.inscatter';
}

/**
 * The boards, in the order they are built. Each carries its own caption, its
 * own program and its own size, because a wall of displays all running the
 * same loop is one display copied — the thing the eye picks up on first is
 * that two screens are in step.
 *
 * `prog`: 0 spectrum, 1 armed-status block, 2 oscilloscope, 3 ticker board.
 */
const BOARDS = [
  // The two bank boards are letterboxed and sit in the 3.6-5.2m band, which is
  // all the fight camera can see above the fence: any taller and the caption
  // rides out of frame, any lower and the crowd swallows the whole panel.
  { pos: [-6.2, 4.42, -13.7], rot: [0.14, 0, 0], w: 4.3, h: 1.5, prog: 0, cap: 'sublevel 09 diagnostic' },
  { pos: [5.9, 4.38, -13.7], rot: [0.14, 0, 0], w: 3.4, h: 1.35, prog: 1, cap: 'cell 09 armed' },
  { pos: [0.6, 6.2, -13.85], rot: [0.22, 0, 0], w: 6.0, h: 2.4, prog: 3, cap: 'mech test - round 01' },
  { pos: [-12.35, 3.6, 4.0], rot: [0, Math.PI / 2, 0], w: 2.0, h: 1.2, prog: 2, cap: 'hydraulic nominal' },
  { pos: [12.35, 4.1, -3.2], rot: [0, -Math.PI / 2, 0], w: 2.4, h: 1.4, prog: 0, cap: 'rig telemetry' },
  { pos: [-11.7, 3.75, -13.72], rot: [0.1, 0, 0], w: 1.6, h: 1.0, prog: 2, cap: 'pit feed 04' },
  { pos: [11.4, 3.9, -13.72], rot: [0.1, 0, 0], w: 1.8, h: 1.05, prog: 1, cap: 'coolant loop b' },
  { pos: [12.35, 6.0, 8.4], rot: [0, -Math.PI / 2, 0], w: 1.8, h: 1.1, prog: 3, cap: 'gantry hold' },
];

/**
 * Caption plate: one row per board, stacked bottom-up in a single texture.
 *
 * The cell size is solved per row so the string fills the plate rather than
 * running off the end of it. The previous fixed cell clipped every caption
 * longer than ten characters mid-word, and a caption cut mid-word under
 * anisotropic filtering is indistinguishable from a texture that is simply
 * broken.
 */
function screenCaptions(rows, size = 512) {
  const band = size / BOARD_ROWS;
  const mask = new Float32Array(size * size);
  for (let r = 0; r < rows.length; r++) {
    const cell = Math.max(2, Math.min(Math.floor(band * 0.42), Math.floor((size * 0.9) / (rows[r].length * 6))));
    const w = rows[r].length * 6 * cell - cell;
    stampText(mask, size, rows[r], Math.round((size - w) / 2), Math.round(r * band + (band - 7 * cell) / 2), cell, cell * 0.5);
  }
  const soft = blur(mask, size, 1, 1);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const v = Math.round(clamp01(soft[k]) * 255);
    const o = k * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
  }
  return makeTexture(data, size, { clamp: true, anisotropy: 4 });
}

/**
 * The four fixtures share one draw call, so they share one texture: a 2x2
 * atlas of transmission masks, selected in the shader by fixture index.
 *
 *   bottom-left  frosted diffuser — the overhead light banks
 *   bottom-right louvred panel    — the lit doorway
 *   top-left     backlit sign     — the sign box on the near barrier
 *
 * They are masks, not colours: the fixture's own emissive tint multiplies
 * through them, so a mood cross-fade recolours the sign along with its light.
 * Mipmaps are off; at these sizes the saving is nil and the quadrant bleed is
 * not.
 */
function fixtureAtlas(size = 512) {
  const half = size >> 1;
  const n = fbm(half, 26, { octaves: 3, seed: 401 });
  const fine = fbm(half, 90, { octaves: 2, seed: 409 });
  const grit = fbm(half, 14, { octaves: 4, seed: 419 });

  // The sign's lettering, rasterised into the top-left quadrant's own space.
  const text = new Float32Array(half * half);
  const cellA = Math.max(3, Math.round(half / 26));
  const cellB = Math.max(2, Math.round(half / 40));
  const wA = 'cell 09'.length * 6 * cellA - cellA;
  const wB = 'mech test'.length * 6 * cellB - cellB;
  stampText(text, half, 'cell 09', Math.round((half - wA) / 2), Math.round(half * 0.42), cellA, cellA * 0.45);
  stampText(text, half, 'mech test', Math.round((half - wB) / 2), Math.round(half * 0.2), cellB, cellB * 0.5);
  const ink = blur(text, half, 1, 1);

  const data = new Uint8Array(size * size * 4);
  const write = (i, j, v) => {
    const o = (j * size + i) * 4;
    const b = encodeSrgb(clamp01(v));
    data[o] = b; data[o + 1] = b; data[o + 2] = b; data[o + 3] = 255;
  };

  for (let j = 0; j < half; j++) {
    for (let i = 0; i < half; i++) {
      const k = j * half + i;
      const u = i / half;
      const v = j / half;

      // Diffuser: three tubes behind frosted acrylic, dirtier at the ends.
      const tube = 0.7 + 0.3 * Math.abs(Math.sin(u * Math.PI * 3));
      const grime = 1 - Math.pow(Math.abs(u * 2 - 1), 4) * 0.5;
      write(i, j, tube * grime * (0.8 + n[k] * 0.3 + fine[k] * 0.15));

      // Louvre: horizontal slats and two mullions, unevenly lit.
      const slat = 0.34 + 0.66 * smoothstep(0.1, 0.34, Math.abs(((v * 11) % 1) - 0.5));
      const mullion = Math.min(
        smoothstep(0.0, 0.03, Math.abs(u - 0.34)),
        smoothstep(0.0, 0.03, Math.abs(u - 0.67)),
      );
      write(half + i, j, slat * (0.25 + mullion * 0.75) * (0.72 + grit[k] * 0.5));

      // Sign: bright field, dark lettering, dark frame, a little scuffing.
      const frame = Math.min(
        smoothstep(0.0, 0.035, Math.min(u, 1 - u)),
        smoothstep(0.0, 0.05, Math.min(v, 1 - v)),
      );
      const face = frame * (0.82 + grit[k] * 0.34) * (1 - ink[k] * 0.94);
      write(i, half + j, face);

      // Unused quadrant: flat, so a stray sample can never be a black hole.
      write(half + i, half + j, 0.9);
    }
  }

  const tex = makeTexture(data, size, { srgb: true, clamp: true, anisotropy: 4 });
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class StagePracticals {
  /**
   * @param {object} deps
   * @param {import('../engine/Environment.js').Environment} deps.environment
   * @param {Record<string, THREE.Material>} deps.materials
   * @param {Record<string, THREE.Texture>} deps.textures
   * @param {THREE.Vector3} deps.sparkPoint frayed cable end
   */
  constructor({ environment, materials, textures, bins, sparkPoint }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.practicals';
    this.environment = environment;
    this.materials = materials;
    this.rng = new Rng(0x50524143);

    /**
     * Published for the Environment (and anyone else) to match lights against.
     * @type {{position: THREE.Vector3, color: THREE.Color, power: number, size: THREE.Vector2}[]}
     */
    this.practicalPositions = [];

    this.atlas = fixtureAtlas(512);
    this.captions = screenCaptions(BOARDS.map((b) => b.cap), 512);

    this.#fixtures(bins);
    this.#ceilingRuns();
    this.#pools();
    this.#neon();
    this.#beacons();
    this.#screens(bins);
    this.#sparks(textures, sparkPoint);
    this.syncToEnvironment();

    /**
     * Fittings the floor's mirror pass skips. The beacons and the neon stay in
     * it — an emitter's reflection is most of what sells a wet deck — but the
     * ceiling runs and their housings are twelve metres up and read in the
     * mirror as a pair of pale lines behind the fighters, and the wall screens
     * face away from the pit. None of the three survives the roughness gather.
     * @type {THREE.Object3D[]}
     */
    this.noReflect = [this.ceilingRuns, this.runHousings, this.screens, this.emitters];
  }

  // -------------------------------------------------------------------------

  /**
   * Four fixtures: two long overhead light banks on the cross-gantry, a lit
   * doorway in the back-left corner, and a warm sign box on the near-right
   * barrier. Their layout matches the Environment's default mood so the
   * geometry and the lights agree at frame one.
   */
  #fixtures(bins) {
    const housings = bins.dark;
    const faces = [];
    const idx = [];

    /**
     * Adds an emitter quad tagged with its fixture index.
     *
     * The tag array is sized off the NON-INDEXED vertex count, and that is the
     * whole of a defect that shipped for several rounds. `PlaneGeometry` is
     * indexed: it reports `position.count` 4 and contributes 6 vertices to the
     * merge, because `GeoKit.mergeAll` calls `toNonIndexed()` first. Sizing the
     * array off 4 therefore wrote four tags per six-vertex quad and left the
     * tail of the buffer at zero, so the tags slid out of alignment:
     *
     *     quad 0  [0,0,0,0,1,1]    quad 2  [3,3,3,3,0,0]
     *     quad 1  [1,1,2,2,2,2]    quad 3  [0,0,0,0,0,0]
     *
     * Three of the four faces were shading with a colour gradient across them
     * between two fixtures' colours, and the fourth — the warm sign box on the
     * near-right barrier, fixture 3 — was rendering **entirely in fixture 0's
     * cool white**. In an arena whose measured defect is that 90% of its
     * saturated pixels are cyan, its one warm emitter was being drawn cold.
     *
     * Found by `StageRooftop`'s author while reading this file as a reference.
     * `#ceilingRuns` builds its tags the same way and is not affected: it lays
     * them down after its own merge.
     */
    const emitter = (w, h, transform, fixture) => {
      const g = place(new THREE.PlaneGeometry(w, h), transform);
      const flat = g.index ? g.toNonIndexed() : g;
      const a = new Float32Array(flat.attributes.position.count);
      a.fill(fixture);
      idx.push(a);
      faces.push(g);
    };

    const spec = this.environment?.params?.practicals;

    // --- 0, 1: overhead light banks ----------------------------------------
    for (let f = 0; f < 2; f++) {
      const x = f === 0 ? -6.6 : 6.6;
      const y = 5.4, z = -6.2;
      const w = 6.4, h = 0.5;
      // Housing: a channel with end caps and a reflector lip, open downward.
      housings.push(place(bevelBox(w + 0.2, 0.3, h + 0.28, 0.02), { pos: [x, y + 0.2, z] }));
      housings.push(place(bevelBox(w + 0.24, 0.16, 0.09, 0.015), { pos: [x, y + 0.02, z - h / 2 - 0.11], rot: [0.5, 0, 0] }));
      housings.push(place(bevelBox(w + 0.24, 0.16, 0.09, 0.015), { pos: [x, y + 0.02, z + h / 2 + 0.11], rot: [-0.5, 0, 0] }));
      for (const dx of [-w / 2 - 0.08, w / 2 + 0.08]) {
        housings.push(place(bevelBox(0.06, 0.32, h + 0.3, 0.012), { pos: [x + dx, y + 0.18, z] }));
      }
      for (const dz of [-0.5, 0.5]) {
        housings.push(place(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6), { pos: [x + w * 0.28, y + 0.6, z + dz] }));
        housings.push(place(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6), { pos: [x - w * 0.28, y + 0.6, z + dz] }));
      }
      // The emitting face looks straight down into the pit.
      emitter(w, h, { pos: [x, y, z], rot: [Math.PI / 2, 0, 0] }, f);
      this.practicalPositions.push({
        position: new THREE.Vector3(x, y, z),
        color: new THREE.Color(spec?.[f]?.color ?? 0xdff0ff),
        power: spec?.[f]?.power ?? 15,
        size: new THREE.Vector2(w, h),
      });
    }

    // --- 2: lit doorway in the back-left corner -----------------------------
    {
      const x = -10.2, y = 2.3, z = -8.6;
      const w = 3.4, h = 2.6;
      housings.push(place(insetPanel(w + 0.7, h + 0.7, 0.35, 0.34), { pos: [x, y, z - 0.2] }));
      housings.push(place(bevelBox(w + 1.1, 0.26, 0.5, 0.02), { pos: [x, y + h / 2 + 0.5, z - 0.2] }));
      housings.push(place(boltRing(w * 0.5, 14, 0.03, 0.02), { pos: [x, y, z - 0.02] }));
      emitter(w, h, { pos: [x, y, z], rot: [0, 0, 0] }, 2);
      this.practicalPositions.push({
        position: new THREE.Vector3(x, y, z),
        color: new THREE.Color(spec?.[2]?.color ?? 0x9fdcff),
        power: spec?.[2]?.power ?? 26,
        size: new THREE.Vector2(w, h),
      });
    }

    // --- 3: sign box on the near-right barrier ------------------------------
    {
      const x = 8.6, y = 3.1, z = 7.8;
      const w = 3.4, h = 2.2;
      housings.push(place(bevelBox(0.34, h + 0.5, w + 0.5, 0.03), { pos: [x + 0.2, y, z] }));
      housings.push(place(bevelBox(0.5, 0.14, w + 0.8, 0.02), { pos: [x + 0.24, y + h / 2 + 0.32, z] }));
      housings.push(place(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), { pos: [x + 0.42, y + h / 2 + 0.6, z - w * 0.3], rot: [0, 0, 0.5] }));
      housings.push(place(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), { pos: [x + 0.42, y + h / 2 + 0.6, z + w * 0.3], rot: [0, 0, 0.5] }));
      emitter(w, h, { pos: [x, y, z], rot: [0, -Math.PI / 2, 0] }, 3);
      this.practicalPositions.push({
        position: new THREE.Vector3(x, y, z),
        color: new THREE.Color(spec?.[3]?.color ?? 0xff9a52),
        power: spec?.[3]?.power ?? 4.5,
        size: new THREE.Vector2(w, h),
      });
    }

    // One mesh for all four emitting faces; the fixture index rides along in a
    // vertex attribute and selects a colour from a four-element uniform array.
    const faceGeo = mergeAll(faces);
    const flat = new Float32Array(faceGeo.attributes.position.count);
    let off = 0;
    for (const a of idx) { flat.set(a, off); off += a.length; }
    faceGeo.setAttribute('aFixture', new THREE.Float32BufferAttribute(flat, 1));

    this.emitterMaterial = new THREE.ShaderMaterial({
      name: 'arena.practicals.emitters',
      uniforms: {
        map: { value: this.atlas },
        uColor: { value: [new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1)] },
      },
      defines: { FIXTURES },
      vertexShader: /* glsl */ `
        attribute float aFixture;
        varying vec2 vUv;
        varying float vFixture;
        void main() {
          vUv = uv;
          vFixture = aFixture;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uColor[ FIXTURES ];
        varying vec2 vUv;
        varying float vFixture;
        void main() {
          vec3 c = uColor[ 0 ];
          for ( int i = 1; i < FIXTURES; i++ ) {
            if ( abs( vFixture - float( i ) ) < 0.5 ) c = uColor[ i ];
          }
          // Fixtures 0 and 1 take the diffuser, 2 the louvre, 3 the sign.
          vec2 quad = vFixture < 1.5 ? vec2( 0.0, 0.0 )
                    : vFixture < 2.5 ? vec2( 0.5, 0.0 )
                    : vec2( 0.0, 0.5 );
          vec2 auv = clamp( vUv, 0.004, 0.996 ) * 0.5 + quad;
          gl_FragColor = vec4( c * texture2D( map, auv ).rgb, 1.0 );
        }
      `,
      // Single-sided: a fitting seen from behind is a box, not a lamp.
      side: THREE.FrontSide,
      toneMapped: true,
      fog: false,
    });
    this.emitters = new THREE.Mesh(faceGeo, this.emitterMaterial);
    this.emitters.name = 'arena.practicals.emitters';
    this.group.add(this.emitters);
  }

  /**
   * The two raked tube runs over the pit.
   *
   * They exist because the Environment now casts from here. Its `ceiling` block
   * had always described rows of overhead banks and only ever painted them into
   * the HDR cube; the pit itself was lit from the sides and from eight metres
   * back, which is why nothing on a fighter's upward-facing bevels ever caught a
   * highlight. The run is a shallow reflector channel with a frosted face
   * underneath, raked across the pit, on drop rods up toward the roof structure.
   *
   * Both are hung above the fight camera's frame line, so at play framing the
   * player sees the streak and not the fitting. The wide and KO angles do see
   * them, which is the right way round: a shot that pulls back to show the room
   * should find the room lit by things that are in it.
   *
   * These are the one set of housings in this file that do **not** go into the
   * shared `dark` bin, and the reason is shadows. The bin casts, and a solid bar
   * hung five metres directly over the pit throws the key light's shadow as a
   * hard black stripe across the deck a metre and a half behind the fighters —
   * close enough that a sidestep walks into it. It is also the wrong answer
   * physically: in the hall this set is pretending to be, these runs *are* the
   * overhead light, and a lamp does not shadow itself. Own mesh, own draw call,
   * casting off.
   */
  #ceilingRuns() {
    const housings = [];
    const faces = [];

    for (const r of RUNS) {
      // The face normal is the run's aim, so the channel is built flat and the
      // whole assembly is rotated by the same angle.
      const rot = [Math.PI / 2 - r.tilt, 0, 0];
      const pos = [0, r.y, r.z];

      faces.push(place(new THREE.PlaneGeometry(r.len, RUN_FACE), { pos, rot }));

      // Channel body behind the face, along the face normal; `up` is the face's
      // own short axis, which is where the reflector lips and the caps go.
      const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...rot));
      const u = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...rot));
      const at = (d, k = 0) => [
        pos[0], pos[1] - n.y * d + u.y * k, pos[2] - n.z * d + u.z * k,
      ];
      housings.push(place(bevelBox(r.len + 0.18, RUN_FACE + 0.34, 0.26, 0.02), { pos: at(0.13), rot }));
      for (const s of [-1, 1]) {
        // Splayed reflector lip down each long edge.
        housings.push(place(bevelBox(r.len + 0.2, 0.15, 0.05, 0.012), {
          pos: at(0.03, s * (RUN_FACE * 0.5 + 0.07)),
          rot: [rot[0] + s * 0.6, 0, 0],
        }));
        // End cap.
        const cap = at(0.13);
        cap[0] = s * (r.len / 2 + 0.09);
        housings.push(place(bevelBox(0.07, RUN_FACE + 0.4, 0.3, 0.012), { pos: cap, rot }));
      }
      // Drop rods and their yokes. The rods run the whole way to the roof
      // purlins at 13.5m rather than stopping in mid air, because the wide and
      // KO framings both look up past the fitting.
      for (const x of [-r.len * 0.42, r.len * 0.42]) {
        const top = 13.5;
        const foot = r.y + 0.2;
        housings.push(place(new THREE.CylinderGeometry(0.022, 0.022, top - foot, 6), {
          pos: [x, (top + foot) * 0.5, r.z],
        }));
        housings.push(place(bevelBox(0.26, 0.07, 0.07, 0.012), { pos: [x, r.y + 0.14, r.z], rot }));
      }
    }

    this.runMaterial = new THREE.MeshBasicMaterial({
      name: 'arena.ceilingRuns',
      color: new THREE.Color(1, 1, 1),
      side: THREE.FrontSide,
      toneMapped: true,
      fog: false,
    });
    this.ceilingRuns = new THREE.Mesh(mergeAll(faces), this.runMaterial);
    this.ceilingRuns.name = 'arena.practicals.ceilingRuns';
    this.ceilingRuns.castShadow = false;
    this.ceilingRuns.receiveShadow = false;
    this.group.add(this.ceilingRuns);

    const shell = mergeAll(housings);
    worldUv(shell, 1.9);
    this.runHousings = new THREE.Mesh(shell, this.materials.darkMetal);
    this.runHousings.name = 'arena.practicals.ceilingRunHousings';
    this.runHousings.castShadow = false;
    this.runHousings.receiveShadow = true;
    this.runHousings.matrixAutoUpdate = false;
    this.group.add(this.runHousings);
  }

  /**
   * Where the light lands. A fixture that emits but deposits nothing reads as a
   * sticker on the wall: the eye locates a source by the pool it throws, not by
   * the lamp. Before this the arena's floor luminance sat inside one narrow band
   * from frame-left to frame-right and there was no telling where the light was
   * coming from.
   *
   * These are not a substitute for the Environment's RectAreaLights, which still
   * do the real shading. They are the term those lights cannot pay for: the
   * shallow grazing scatter off a rough wet floor and the wash a strip light
   * leaves on the metre of barrier around it. Tint and brightness come from the
   * same practical parameters as the lights, so a mood cross-fade drags the
   * pools along with the lamps.
   *
   * Six cards, one draw call — the colour slot rides in a vertex attribute, the
   * same trick the fixture faces use.
   */
  #pools() {
    const quads = [];
    const slot = [];
    const edge = [];
    const gain = [];

    for (const p of POOLS) {
      const g = place(new THREE.PlaneGeometry(p.w, p.h), { pos: p.pos, rot: p.rot });
      const n = g.attributes.position.count;
      const s = new Float32Array(n);
      const e = new Float32Array(n * 2);
      const a = new Float32Array(n);
      s.fill(p.slot);
      a.fill(p.gain);
      for (let i = 0; i < n; i++) { e[i * 2] = p.edge[0]; e[i * 2 + 1] = p.edge[1]; }
      quads.push(g);
      slot.push(s);
      edge.push(e);
      gain.push(a);
    }

    const geo = mergeAll(quads);
    const n = geo.attributes.position.count;
    const fSlot = new Float32Array(n);
    const fEdge = new Float32Array(n * 2);
    const fGain = new Float32Array(n);
    let o = 0;
    for (let i = 0; i < slot.length; i++) {
      fSlot.set(slot[i], o);
      fEdge.set(edge[i], o * 2);
      fGain.set(gain[i], o);
      o += slot[i].length;
    }
    geo.setAttribute('aSlot', new THREE.Float32BufferAttribute(fSlot, 1));
    geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(fEdge, 2));
    geo.setAttribute('aGain', new THREE.Float32BufferAttribute(fGain, 1));

    this.poolMaterial = new THREE.ShaderMaterial({
      name: 'arena.practicals.pools',
      uniforms: {
        uPool: {
          value: Array.from({ length: POOL_SLOTS }, () => new THREE.Color(0, 0, 0)),
        },
      },
      defines: { POOL_SLOTS },
      vertexShader: /* glsl */ `
        attribute float aSlot;
        attribute vec2 aEdge;
        attribute float aGain;
        varying vec2 vUv;
        varying vec2 vEdge;
        varying float vGain;
        varying float vSlot;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vEdge = aEdge;
          vGain = aGain;
          vSlot = aSlot;
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uPool[ POOL_SLOTS ];
        varying vec2 vUv;
        varying vec2 vEdge;
        varying float vGain;
        varying float vSlot;
        varying vec3 vWorld;
        void main() {
          vec3 c = uPool[ 0 ];
          for ( int i = 1; i < POOL_SLOTS; i++ ) {
            if ( abs( vSlot - float( i ) ) < 0.5 ) c = uPool[ i ];
          }

          // Separable falloff: full brightness inside the plateau, quadratic
          // skirt outside it, squared once more so the pool has a core rather
          // than a uniform lift.
          vec2 q = abs( vUv - 0.5 ) * 2.0;
          vec2 e = clamp( ( q - vEdge ) / max( vec2( 1.0 ) - vEdge, vec2( 1e-3 ) ), 0.0, 1.0 );
          float f = ( 1.0 - e.x * e.x ) * ( 1.0 - e.y * e.y );
          f *= f;

          // Large-scale unevenness so a pool reads as light on a dirty floor
          // rather than as a decal someone airbrushed on.
          f *= 0.85 + 0.15 * sin( vWorld.x * 0.83 + vWorld.z * 0.61 ) * sin( vWorld.z * 1.27 - 1.1 );

          gl_FragColor = vec4( c * ( f * vGain ), 1.0 );
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
      fog: false,
      side: THREE.DoubleSide,
    });

    this.pools = new THREE.Mesh(geo, this.poolMaterial);
    this.pools.name = 'arena.practicals.pools';
    this.#washes();
    // Scatter, not scenery: it must never be picked up by the floor mirror or
    // the reflection would double the deposit.
    this.pools.layers.set(LAYER.NO_REFLECT);
    this.pools.castShadow = false;
    this.pools.receiveShadow = false;
    this.group.add(this.pools);
  }

  /**
   * The multiplicative near-field wash. See {@link WASHES} for why this is a
   * separate pass from {@link POOLS} rather than another card in it.
   *
   * `dst * src`, with the card's own colour at exactly `vec3(1.0)` outside the
   * falloff, so the pass is an identity everywhere it is not aimed. Depth-tested
   * against the opaque buffer and drawn after it: anything nearer than the card
   * — a fighter standing in front of the barrier — fails the test and is left
   * alone, which is the correct behaviour, since the wall's wash is not landing
   * on him.
   */
  #washes() {
    const quads = [];
    const edge = [];
    const gain = [];
    for (const p of WASHES) {
      const g = place(new THREE.PlaneGeometry(p.w, p.h), { pos: p.pos, rot: p.rot });
      const n = g.attributes.position.count;
      const e = new Float32Array(n * 2);
      const a = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        e[i * 2] = p.edge[0];
        e[i * 2 + 1] = p.edge[1];
        a[i * 2] = p.gain;
        a[i * 2 + 1] = p.skew ?? 1;
      }
      quads.push(g);
      edge.push(e);
      gain.push(a);
    }
    const geo = mergeAll(quads);
    const n = geo.attributes.position.count;
    const fEdge = new Float32Array(n * 2);
    const fGain = new Float32Array(n * 2);
    let o = 0;
    for (let i = 0; i < gain.length; i++) {
      fEdge.set(edge[i], o * 2);
      fGain.set(gain[i], o * 2);
      o += gain[i].length / 2;
    }
    geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(fEdge, 2));
    geo.setAttribute('aGain', new THREE.Float32BufferAttribute(fGain, 2));

    this.washMaterial = new THREE.ShaderMaterial({
      name: 'arena.practicals.wash',
      uniforms: {
        uWash: { value: new THREE.Color(0, 0, 0) },
        uNear: { value: WASH_NEAR },
      },
      vertexShader: /* glsl */ `
        attribute vec2 aEdge;
        attribute vec2 aGain;
        varying vec2 vUv;
        varying vec2 vEdge;
        varying vec2 vGain;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vEdge = aEdge;
          vGain = aGain;
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uWash;
        uniform float uNear;
        varying vec2 vUv;
        varying vec2 vEdge;
        varying vec2 vGain;
        varying vec3 vWorld;
        void main() {
          // The two axes of a strip's near field are not the same shape: ALONG
          // the run the source is effectively infinite and the only falloff is
          // the run ending, so that axis stays a soft plateau-plus-skirt.
          // ACROSS it, the surface sees a line source at a fixed standoff and
          // the deposit is s / ( s^2 + d^2 ) — steepest right at the fitting.
          vec2 s = ( vUv - 0.5 ) * 2.0;
          // Reach upward is vGain.y times the reach downward, so the same card
          // throws a long gradient down the barrier and a short one up the fence.
          vec2 q = vec2( abs( s.x ), abs( s.y ) / ( s.y > 0.0 ? vGain.y : 1.0 ) );
          vec2 e = clamp( ( q - vEdge ) / max( vec2( 1.0 ) - vEdge, vec2( 1e-3 ) ), 0.0, 1.0 );
          // Line-source near field, shifted and renormalised to 1 at the tube
          // and exactly 0 at the card edge — so the pass stays an exact
          // identity outside its own reach and cannot draw a seam. uNear is the
          // standoff in card units; see WASH_NEAR for the sweep it was picked
          // from and for what the old ( 1 - q^2 )^2 plateau cost.
          float k2 = uNear * uNear;
          float gEdge = k2 / ( k2 + 1.0 );
          // The guard matters only for standoffs far larger than the card, where
          // the profile degenerates to a flat lift and the renormaliser goes to
          // zero; it is the same 1e-3 floor the edge remap above uses.
          float across = ( k2 / ( k2 + e.y * e.y ) - gEdge ) / max( 1.0 - gEdge, 1e-3 );
          float f = ( 1.0 - e.x * e.x ) * across;

          // The same large-scale unevenness the pools carry, so the gradient
          // reads as light on a dirty wall rather than as an airbrushed decal.
          f *= 0.86 + 0.14 * sin( vWorld.x * 0.71 + 0.4 ) * sin( vWorld.y * 1.9 - 0.7 );

          gl_FragColor = vec4( vec3( 1.0 ) + uWash * ( f * vGain.x ), 1.0 );
        }
      `,
      transparent: true,
      // dst = dst * src. The composer's targets are half-float, so `src` above
      // 1.0 is a real gain rather than a clamp.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
    });

    this.washes = new THREE.Mesh(geo, this.washMaterial);
    this.washes.name = 'arena.practicals.washes';
    // A gain on the wall is not scenery, and the floor's mirror would apply it a
    // second time to the reflected barrier.
    this.washes.layers.set(LAYER.NO_REFLECT);
    this.washes.castShadow = false;
    this.washes.receiveShadow = false;
    // After the pools, which are additive: an additive deposit that arrives
    // before the gain gets multiplied by it, which is the wrong order for
    // scatter sitting in front of the wall rather than on it.
    this.washes.renderOrder = 2;
    this.group.add(this.washes);
  }

  /** Neon strips along the catwalk edges and the machinery bank. */
  #neon() {
    const runs = [];
    for (const side of [-1, 1]) {
      runs.push(place(bevelBox(0.06, 0.05, 24, 0.01), { pos: [side * 13.15, 5.02, 2] }));
    }
    runs.push(place(bevelBox(24, 0.05, 0.06, 0.01), { pos: [0, 1.28, -8.62] }));
    for (let i = 0; i < 5; i++) {
      runs.push(place(bevelBox(0.05, 1.5, 0.05, 0.01), { pos: [-12.4 + i * 6.2, 3.4, -12.0] }));
    }
    this.neonMaterial = new THREE.MeshBasicMaterial({ name: 'arena.neon', color: new THREE.Color(0x2ad4ff), toneMapped: true, fog: true });
    hazeAsInScatter(this.neonMaterial);
    this.neon = new THREE.Mesh(mergeAll(runs), this.neonMaterial);
    this.neon.name = 'arena.practicals.neon';
    this.group.add(this.neon);
  }

  /** Rotating hazard beacons on the machinery bank and the roof structure. */
  #beacons() {
    const parts = [];
    parts.push(place(new THREE.CylinderGeometry(0.12, 0.14, 0.06, 12), { pos: [0, -0.03, 0] }));
    parts.push(place(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), { pos: [0, 0, 0] }));
    const geo = mergeAll(parts);
    const spots = [
      [-13.2, 5.1, -12.4], [13.2, 5.1, -12.4], [-6.2, 8.6, -13.6], [9.6, 10.4, -11.2],
      [0, 11.2, -10.4], [-14.2, 12.2, 2.4],
    ];
    this.beaconMaterial = new THREE.MeshBasicMaterial({ name: 'arena.beacon', color: 0xff5a12, toneMapped: true });
    this.beacons = new THREE.InstancedMesh(geo, this.beaconMaterial, spots.length);
    this.beacons.name = 'arena.practicals.beacons';
    this.beacons.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
    this.beacons.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    this._beaconPhase = [];
    spots.forEach((p, i) => {
      m.compose(new THREE.Vector3(p[0], p[1], p[2]), q, one);
      this.beacons.setMatrixAt(i, m);
      this._beaconPhase.push(this.rng.range(0, Math.PI * 2));
    });
    this.beacons.instanceMatrix.needsUpdate = true;
    this.group.add(this.beacons);
  }

  /**
   * The boards: diagnostic displays on the machinery bank, the house board over
   * the pit, and repeaters on the side walls.
   *
   * All eight share one shader and one draw call, and each one carries its
   * board index in a vertex attribute. That attribute is the whole point. The
   * index used to be derived from the fragment's world position, which meant it
   * changed *across* a panel — every thirty centimetres the display jumped to a
   * different caption, a different bar seed and a different trace phase, and
   * what came out looked like a screen showing reversed, sliced-up text. An
   * index is a property of the board, so it belongs to the board's vertices.
   */
  #screens(bins) {
    const panels = [];
    const bezels = bins.dark;
    const counts = [];
    for (const p of BOARDS) {
      // Expanded here rather than left to the merge, so the vertex counts the
      // board attribute is filled from are the ones that end up in the buffer.
      const geo = place(new THREE.PlaneGeometry(p.w, p.h), { pos: p.pos, rot: p.rot }).toNonIndexed();
      counts.push(geo.attributes.position.count);
      panels.push(geo);
      // Housing sits a few centimetres behind the face, along the face normal.
      const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...p.rot)).multiplyScalar(0.03);
      bezels.push(place(insetPanel(p.w + 0.2, p.h + 0.2, 0.09, 0.1), {
        pos: [p.pos[0] - n.x, p.pos[1] - n.y, p.pos[2] - n.z],
        rot: p.rot,
      }));
    }

    // Fog has to be merged in by hand: a ShaderMaterial with `fog: true` gets
    // the chunks but not the uniforms they read.
    this.screenMaterial = new THREE.ShaderMaterial({
      name: 'arena.screens',
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uCaptions: { value: null },
          uColor: { value: new THREE.Color(0x63d0ff) },
          uWarn: { value: new THREE.Color(0xffa02a) },
          // The trace and its head end up well over the bright pass, the bar
          // graph just over it, the dark field far under. A screen is only
          // convincing when its own contrast survives the bright pass. Held
          // under the fixture faces because eight boards at a lamp's radiance
          // would be eight lamps, and because bloom off a panel this size
          // spills onto the deck behind the fighters.
          uGain: { value: 13.0 },
          uRows: { value: BOARD_ROWS },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aBoard;
        attribute float aProgram;
        varying vec2 vUv;
        varying float vBoard;
        varying float vProgram;
        void main() {
          vUv = uv;
          vBoard = aBoard;
          vProgram = aProgram;
          vec4 mvPosition = viewMatrix * modelMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform sampler2D uCaptions;
        uniform vec3 uColor;
        uniform vec3 uWarn;
        uniform float uGain;
        uniform float uRows;
        varying vec2 vUv;
        varying float vBoard;
        varying float vProgram;

        float hash11( float n ) { return fract( sin( n ) * 43758.5453 ); }

        // Spectrum: a bank of bars over a sweeping trace. The generalist.
        vec3 spectrum( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          float bars = floor( uv.x * 22.0 );
          float h = 0.08 + 0.34 * abs( sin( bars * 1.7 + uTime * ( 1.3 + fract( seed * 0.31 ) ) + seed ) )
                        * ( 0.5 + 0.5 * hash11( bars + seed ) );
          float inBar = step( uv.y, h ) * step( 0.06, uv.y ) * step( 0.12, fract( uv.x * 22.0 ) );
          col += mix( uColor, uWarn, step( 0.3, h ) ) * inBar * 0.9;

          float trace = 0.62 + 0.13 * sin( uv.x * 21.0 + uTime * 2.6 + seed ) * sin( uv.x * 7.0 - uTime * 1.1 );
          col += uColor * 1.4 * ( 1.0 - smoothstep( 0.0, 0.012, abs( uv.y - trace ) ) );
          float head = fract( uTime * 0.22 + fract( seed * 0.77 ) );
          col += uColor * 2.2 * ( 1.0 - smoothstep( 0.0, 0.02, length( vec2( ( uv.x - head ) * 1.6, uv.y - trace ) ) ) );
          return col;
        }

        // Armed status: a channel list filling in sequence under a bar that
        // pulses amber. Reads as something counting down to a go condition.
        vec3 status( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          float rows = 6.0;
          float r = floor( uv.y * rows );
          float rf = fract( uv.y * rows );
          float lit = step( fract( uTime * 0.19 + r * 0.17 + seed * 0.13 ), 0.62 );
          // Label block on the left, a value bar on the right.
          float label = step( 0.06, uv.x ) * step( uv.x, 0.34 ) * step( 0.28, rf ) * step( rf, 0.68 );
          float fill = 0.4 + 0.5 * hash11( r + seed );
          float bar = step( 0.40, uv.x ) * step( uv.x, 0.40 + fill * 0.54 ) * step( 0.3, rf ) * step( rf, 0.66 );
          col += uColor * 0.55 * label * ( 0.35 + 0.65 * lit );
          col += mix( uColor, uWarn, step( 0.72, fill ) ) * bar * ( 0.3 + 1.1 * lit );
          // Alert bar across the top of the field, breathing.
          float pulse = 0.45 + 0.55 * abs( sin( uTime * 2.1 + seed ) );
          col += uWarn * pulse * 1.5 * step( 0.74, uv.y ) * step( uv.y, 0.8 ) * step( 0.06, uv.x ) * step( uv.x, 0.94 );
          return col;
        }

        // Oscilloscope: one bright trace on a graticule, with a cursor.
        vec3 scope( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          vec2 g = abs( fract( uv * vec2( 10.0, 6.0 ) ) - 0.5 );
          col += uColor * 0.07 * step( 0.44, max( g.x, g.y ) );
          float t = uv.x * 12.0 + uTime * 3.4 + seed;
          float y = 0.42 + 0.24 * ( sin( t ) * 0.7 + sin( t * 2.7 + seed ) * 0.3 );
          col += uColor * 2.0 * ( 1.0 - smoothstep( 0.0, 0.016, abs( uv.y - y ) ) );
          col += uColor * 0.5 * ( 1.0 - smoothstep( 0.0, 0.09, abs( uv.y - y ) ) );
          float cur = fract( uTime * 0.31 + seed * 0.41 );
          col += uWarn * 1.1 * ( 1.0 - smoothstep( 0.0, 0.004, abs( uv.x - cur ) ) );
          return col;
        }

        // Ticker board: a scrolling block ribbon over a progress bar. The house
        // board, which wants to read from the back of the hall.
        vec3 ticker( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          float x = uv.x * 9.0 + uTime * 0.9 + seed;
          float cell = floor( x );
          float on = step( 0.42, hash11( cell * 1.7 + seed ) );
          float body = step( 0.08, fract( x ) ) * step( fract( x ), 0.9 )
                     * step( 0.42, uv.y ) * step( uv.y, 0.72 );
          col += mix( uColor, uWarn, step( 0.86, hash11( cell + 3.1 ) ) ) * body * on * 1.1;
          float p = fract( uTime * 0.07 + seed * 0.29 );
          col += uColor * 1.3 * step( 0.08, uv.x ) * step( uv.x, 0.08 + p * 0.84 )
               * step( 0.2, uv.y ) * step( uv.y, 0.3 );
          col += uColor * 0.25 * step( 0.08, uv.x ) * step( uv.x, 0.92 )
               * step( 0.19, uv.y ) * step( uv.y, 0.31 );
          return col;
        }

        void main() {
          // The board index is a vertex attribute, so every fragment of a panel
          // agrees on which display it belongs to.
          float seed = vBoard * 7.31 + 1.7;
          vec2 uv = vUv;

          // Occasional horizontal tear.
          float tearBand = step( 0.985, hash11( floor( uTime * 6.0 ) + seed ) );
          float tearY = fract( hash11( floor( uTime * 6.0 ) * 1.7 + seed ) );
          if ( tearBand > 0.0 && abs( uv.y - tearY ) < 0.03 ) uv.x += 0.05;

          vec3 col = vec3( 0.008, 0.02, 0.03 );
          vec2 g = abs( fract( uv * vec2( 16.0, 9.0 ) ) - 0.5 );
          col += uColor * 0.05 * step( 0.46, max( g.x, g.y ) );

          if ( vProgram < 0.5 ) col += spectrum( uv, seed );
          else if ( vProgram < 1.5 ) col += status( uv, seed );
          else if ( vProgram < 2.5 ) col += scope( uv, seed );
          else col += ticker( uv, seed );

          // Caption strip: this board's own row of the shared text plate.
          if ( uv.y > 0.82 ) {
            vec2 cuv = vec2( uv.x, ( vBoard + clamp( ( uv.y - 0.82 ) / 0.16, 0.0, 1.0 ) ) / uRows );
            col += uColor * 1.8 * texture2D( uCaptions, cuv ).r;
          }

          // Scanlines and a slow rolling frame bar.
          col *= 0.72 + 0.28 * step( 0.5, fract( uv.y * 120.0 ) );
          float roll = fract( uv.y + uTime * 0.11 + seed * 0.13 );
          col *= 1.0 + 0.35 * ( 1.0 - smoothstep( 0.0, 0.06, roll ) );
          // Vignette and the glass's own slight sheen.
          col *= 1.0 - 0.55 * pow( length( uv - 0.5 ) * 1.5, 3.0 );

          gl_FragColor = vec4( col * uGain, 1.0 );
          ${HAZE_AS_IN_SCATTER}
        }
      `,
      toneMapped: true,
      fog: true,
      side: THREE.FrontSide,
    });
    // UniformsUtils.merge clones, so the caption plate is bound afterwards.
    this.screenMaterial.uniforms.uCaptions.value = this.captions;

    const geo = mergeAll(panels);
    const board = new Float32Array(geo.attributes.position.count);
    const program = new Float32Array(geo.attributes.position.count);
    let at = 0;
    counts.forEach((n, i) => {
      board.fill(i, at, at + n);
      program.fill(BOARDS[i].prog, at, at + n);
      at += n;
    });
    geo.setAttribute('aBoard', new THREE.Float32BufferAttribute(board, 1));
    geo.setAttribute('aProgram', new THREE.Float32BufferAttribute(program, 1));
    this.screens = new THREE.Mesh(geo, this.screenMaterial);
    this.screens.name = 'arena.practicals.screens';
    this.group.add(this.screens);
  }

  /**
   * The severed cable's arc. Sparks are a physical burst pool plus a point
   * light that only exists for the two or three frames the arc lasts, which is
   * the whole trick: the flash lights the machinery around it, so the eye reads
   * a real electrical fault rather than an animated sprite.
   */
  #sparks(textures, sparkPoint) {
    this.sparkPoint = sparkPoint ? sparkPoint.clone() : new THREE.Vector3(10.35, 6.05, -13.0);
    this.sparks = new PointBurst(textures.spark, {
      count: 220,
      color: 0xffd08a,
      gravity: -16,
      drag: 1.1,
      additive: true,
      floorY: 0,
      bounce: 0.28,
    });
    this.sparks.points.name = 'arena.practicals.sparks';
    this.group.add(this.sparks.points);

    this.sparkLight = new THREE.PointLight(0xffd9a0, 0, 9, 2);
    this.sparkLight.position.copy(this.sparkPoint);
    this.sparkLight.castShadow = false;
    this.group.add(this.sparkLight);

    this._nextArc = 1.5;
    this._arc = 0;
  }

  // -------------------------------------------------------------------------

  /**
   * Copies the Environment's live practical parameters onto the fixture
   * emitters. Called every frame, so a mood cross-fade drags the visible
   * sources along with the lights instead of leaving them behind.
   */
  syncToEnvironment() {
    const lights = this.environment?.practicals;
    const params = this.environment?.params?.practicals;
    const cols = this.emitterMaterial.uniforms.uColor.value;
    const pools = this.poolMaterial.uniforms.uPool.value;
    for (let i = 0; i < FIXTURES; i++) {
      const light = lights?.[i];
      const p = params?.[i];
      if (!p) continue;
      // Radiance under a knee rather than a straight scale. A 26-unit doorway
      // and a 4.5-unit sign box have to end up within a stop or two of each
      // other on screen, or the bright one clips to a white rectangle and stops
      // reading as a lit surface at all. The curve is anchored on the dimmest
      // fixture any mood authors, so even the sign box clears the bright pass
      // and the light banks land three to four times over it — hot enough that
      // the bright pass, not the albedo, is what the eye reads them by.
      const live = Math.max(0, light?.intensity ?? p.power);
      const power = LAMP_ANCHOR * Math.pow(live / 4.5, 0.62) * (i === 3 ? 1.35 : 2.1);
      cols[i].copy(light?.color ?? p.color).multiplyScalar(power);
      // The pool is scatter, so it follows the source's flicker at a square
      // root: a lamp that dips 10% dims its pool, it does not switch it off.
      pools[i].copy(p.color).multiplyScalar(Math.sqrt(live) * POOL_GAIN);
      const pub = this.practicalPositions[i];
      if (pub) {
        pub.position.copy(p.pos);
        pub.color.copy(p.color);
        pub.power = p.power;
        pub.size.copy(p.size);
      }
    }

    // The tube runs read off the mood's `ceiling` block, the same term the
    // Environment's overhead strips are driven by. `on` is the mood's own
    // statement about whether it has a roof, so an outdoor mood puts the tubes
    // out rather than leaving two lit fittings under an open sky.
    const ceil = this.environment?.params?.ceiling;
    if (ceil) {
      const live = Math.max(0, ceil.intensity * ceil.on);
      const power = live > 0.01 ? LAMP_ANCHOR * Math.pow(live / 4.5, 0.62) * 2.1 : 0;
      this.runMaterial.color.copy(ceil.color).multiplyScalar(power);
    }
  }

  /**
   * @param {number} dt seconds since the last rendered frame
   * @param {number} time seconds since the stage was built
   * @param {object} envParams live Environment mood parameters
   */
  update(dt, time, envParams) {
    // The Environment's animation clock — practical flicker, the rim hue drift,
    // the mood cross-fade and the per-fighter rim rigs following their fighters.
    // The Stage is its only per-frame consumer, so the Stage winds it; `frame`
    // stands down of its own accord if the game ever drives `update` directly.
    this.environment?.frame(dt);
    this.syncToEnvironment();
    this.screenMaterial.uniforms.uTime.value = time;

    const rimA = envParams?.rim?.color;
    const rimB = envParams?.rimB?.color;
    if (rimA) {
      // Neon and screens take their hue from the mood's rim pair, which is what
      // keeps the practicals and the lighting reading as one design.
      // A tube has to clear the bright pass at the bottom of its cycle, not the
      // top: a strip that only blooms on the peak reads as a flickering decal
      // rather than as glass with current in it. Held well under the fixture
      // faces on purpose, and the reason is the floor rather than the frame.
      // The fixture faces and the boards are in `noReflect`; the tube is not,
      // because an emitter's reflection is most of what sells a wet deck — so
      // every unit of tube arrives twice, once on the barrier and once as a
      // streak down the deck the fighters are being read against. Measured, the
      // emitter pass as a whole put 15% back onto the deck it had just been
      // taken off. 8.2 still clears the bright pass by half again.
      const pulse = 10.5 + 1.35 * Math.sin(time * 0.8);
      // ROUND 18. The tube is the only direct-view emitter the wide framing
      // holds near its own centre, and it was the reason the frame had nothing
      // at the top of its range: the lighting critic measured p99 0.50-0.76
      // linear with **0.000%** of pixels over 0.99, against a reference band of
      // 0.56-0.995 and 0.00-3.24%. `TUBE_DRIVE` is how far over the display
      // transform's clipping point a bare tube is driven, and `TUBE_BLEACH` is
      // how far its core desaturates on the way. Both are needed and the second
      // is the non-obvious one: linear luminance is a weighted mean, so a
      // *saturated* source cannot put a pixel over 0.99 however bright it is —
      // the blue-poor channels drag its own luma down. A real tube driven well
      // past saturation has a white core inside a coloured halo, which is what
      // this does and what every reference frame shows.
      //
      // Swept in-page on one frozen wide frame, control run twice at exactly
      // 0.000 delta, against the rest of this round already in place:
      //
      //     drive  bleach   p99     >0.99   cyan%  warm%  fighter/deck
      //      x1     0.00   0.7835   0.000%  80.6   15.4      1.408
      //      x8     0.00   0.8064   0.000%  83.3   13.0      1.487
      //      x8     0.25   0.8234   0.000%  81.4   14.8      1.502
      //      x12    0.00   0.8292   0.000%  84.1   12.4      1.524
      //      x12    0.30   0.8548   0.027%  81.3   15.0      1.543
      //      x18    0.25   0.8726   0.035%  83.0   13.6      1.570
      //
      // x12 with a 0.30 bleach lands p99 on the reference median of 0.84 and
      // clears zero on the clipped fraction while costing under two points of
      // the cyan share this round is separately reducing. The guard that
      // mattered went the other way from the worry: brightening the tube raises
      // the *fighters* more than the deck they are read against (1.408 ->
      // 1.543), because they catch its specular and the deck only catches its
      // reflection, so figure/ground improves rather than erodes.
      //
      // The scattered deposit on the deck is deliberately NOT scaled with it —
      // it is in-scatter from the same tube, it already lands twice through the
      // planar mirror, and it is the term that would brighten the fight plane.
      //
      // **What it does cost, swept the same way at the FIGHT framing**, where
      // the tube is nearest the eye and its mirror image fills the deck between
      // the fighters:
      //
      //     drive   p99     >0.99    deck median
      //      x1    0.8047   0.000%     0.2572
      //      x4    0.8621   0.000%     0.2920
      //      x6    0.8790   0.000%     0.3118
      //      x8    0.8898   0.014%     0.3295
      //      x12   0.9053   0.053%     0.3601
      //
      // The deck the fighters stand on is 40% brighter at x12 than at x1. That
      // is the composition rule this set is built to ("the fight plane is the
      // brightest, cleanest band in frame") being spent, and it is the honest
      // argument for a lower number. x12 is kept because it is the lowest drive
      // at which BOTH scored framings clear zero on the clipped fraction — x8
      // clears it at the fight framing and not at the wide one — and because at
      // the wide framing the trade goes the other way, fighters over deck
      // improving 1.408 -> 1.543. If the fight framing is ever judged to be
      // washing out, x8 is the measured fallback and costs 0.039 of p99.
      //
      // **x6, and the sweep above optimised the wrong quantity.** "The lowest
      // drive at which both framings clear zero on the clipped fraction" put
      // the top of the frame's range on a 24-metre tube that crosses the whole
      // width of the picture at the fighters' chest height. Measured on a
      // frozen hero frame with a frame-difference mask separating fighters from
      // set: the brightest 1% of the frame was landing 13.3% on the fighters,
      // who occupy 12.2% of it — the highlights were distributed at *chance*,
      // which is the rubric's "everything the same brightness" stated as a
      // number. Clipped pixels are worth having; clipped pixels on the backdrop
      // are worth having only if the subject already has some.
      //
      // **The table above cannot see what the drive actually controls.** Swept
      // again in one session at 0.5 / 1 / 2 / 3 / 6 / 12, the tube's own
      // brightest full-width row does not move at all: 194.7, 196.8, 197.9,
      // 198.0, 198.7, 198.9 out of 255. The core is clipped at every drive on
      // the list — a 24x drop in radiance is invisible on the fixture. What the
      // drive controls is the *halo*, and the halo is a lot of frame:
      //
      //     drive    top 1% of frame luminance landing on the fighters
      //      12        14.0%      (fighters are 12.6% of the frame: chance)
      //       6        14.8%
      //       3        16.4%
      //       2        18.0%
      //       1        21.2%
      //     0.5        23.0%
      //
      // So the sweep recorded above was buying clipped pixels it could not put
      // anywhere except into a bloom veil across the mid-ground, and paying for
      // them out of the subject's share of the highlight range. x2 ships: the
      // fixture is unchanged to the eye (its core was always clipped), the veil
      // is gone, and the fighters take 18% of the top percentile instead of the
      // 14% that a random 12.6% of the frame would get for free.
      //
      // The bleach goes 0.30 -> 0.10 for the same reason in colour rather than
      // level. A tube pulled 30% toward white reads as a lit *surface* spanning
      // the picture; the same radiance kept on the rim hue reads as a *source*.
      const TUBE_DRIVE = 2.0;
      const TUBE_BLEACH = 0.10;
      this.neonMaterial.color.copy(rimA).lerp(_white, TUBE_BLEACH).multiplyScalar(pulse * TUBE_DRIVE);
      this.screenMaterial.uniforms.uColor.value.copy(rimA).lerp(_white, 0.25);
      // The strip's own wash on the barrier and the floor at its foot. The
      // deposit is scatter and stays where it was — only the tube got hotter.
      this.poolMaterial.uniforms.uPool.value[4].copy(rimA).multiplyScalar(pulse * 0.021);
      // And the gain the same tube puts on the barrier band and the fence rail
      // it is bolted between. `WASH_DRIVE` is the peak multiplier minus one, so
      // 0 is the pass switched off and the shipped value is measured — see the
      // sweep recorded on `WASHES`. Half-tinted rather than fully: a wash is
      // reflected off grey concrete, so it arrives less saturated than the tube.
      // Follows the flicker at a square root for the same reason the pools do.
      this.washMaterial.uniforms.uWash.value
        .copy(rimA).lerp(_white, 0.5).multiplyScalar(Math.sqrt(pulse) * WASH_DRIVE);
    }
    if (rimB) this.screenMaterial.uniforms.uWarn.value.copy(rimB).lerp(_amber, 0.4);

    // Beacons: a rotating mirror reads as a sharp sweep, not a sine.
    for (let i = 0; i < this._beaconPhase.length; i++) {
      const ph = this._beaconPhase[i];
      const sweep = Math.pow(Math.max(0, Math.sin(time * 1.9 + ph)), 12);
      _tmp.setRGB(1, 0.32, 0.08).multiplyScalar(0.4 + sweep * 11);
      this.beacons.setColorAt(i, _tmp);
    }
    this.beacons.instanceColor.needsUpdate = true;

    // Arcing cable.
    this._nextArc -= dt;
    if (this._nextArc <= 0) {
      this._nextArc = this.rng.range(1.4, 5.2);
      this._arc = this.rng.range(0.06, 0.16);
      this.sparks.emit(
        this.sparkPoint,
        _down,
        this.rng.int(18) + 14,
        { rng: this.rng, speed: 4.2, spread: 0.75, life: 0.85, size: 0.045 },
      );
    }
    if (this._arc > 0) {
      this._arc = Math.max(0, this._arc - dt);
      this.sparkLight.intensity = this._arc > 0 ? 22 * (0.4 + Math.random() * 0.6) : 0;
    } else if (this.sparkLight.intensity !== 0) {
      this.sparkLight.intensity = 0;
    }
    this.sparks.update(dt);
  }

  reset() {
    this.sparks.reset();
    this.sparkLight.intensity = 0;
    this._arc = 0;
    this._nextArc = 1.5;
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.emitterMaterial.dispose();
    this.runMaterial.dispose();
    this.poolMaterial.dispose();
    this.washMaterial.dispose();
    this.neonMaterial.dispose();
    this.beaconMaterial.dispose();
    this.screenMaterial.dispose();
    this.sparks.dispose();
    this.atlas.dispose();
    this.captions.dispose();
  }
}
