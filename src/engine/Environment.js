/**
 * Knockbots — procedural HDR environment and the three-point lighting rig.
 *
 * Metal reads as metal because of what it reflects, not because of a metalness
 * slider. Everything here exists to give the armour something worth reflecting:
 *
 *   1. A fragment shader paints a genuinely high-dynamic-range surround — sky or
 *      interior gradient, sun disc at hundreds of nits, horizon haze, rows of
 *      overhead light banks, wall neon and screens, and silhouetted structure
 *      that occludes the sky near the horizon. It is rendered through a
 *      CubeCamera into a half-float WebGLCubeRenderTarget and then filtered by
 *      PMREMGenerator, so rough and smooth materials both get a correct,
 *      pre-convolved specular response.
 *   2. **Area sources, everywhere the highlight has to be shaped.** Four
 *      RectAreaLights sit at the same positions as the brightest emissive quads
 *      in the cube; two more run the length of the pit overhead on the line the
 *      mood's `ceiling` block describes; and one rides with each fighter on the
 *      key azimuth. A PMREM env map alone gives soft mushy highlights and a
 *      punctual light gives a round dot, and neither one is what the eye reads
 *      as metal. A rectangle reflects as a rectangle — a long bar drawn down a
 *      plate, bending where the plate bends — and that single cue carries both
 *      the "expensive render" read and the material library's response variety,
 *      because paint, brushed steel, rubber and glass differ almost entirely in
 *      how wide they smear that bar. See {@link KEY_BOX} and {@link STRIP}.
 *   3. A key / rim / rim-B / bounce / hemisphere rig on top, plus a **per-fighter
 *      rim rig**: two spot lights that ride three-quarters behind and slightly
 *      above each fighter on the same azimuths as the mood's rim pair. That
 *      locality is the whole point, and it is why the key softbox rides with
 *      them too. A scene-wide directional lights the backdrop exactly as hard as
 *      it lights the fighter, so a pale robot standing in front of a pale
 *      barrier has nothing to separate against; a source at three metres falls
 *      off, edges the armour, and leaves the wall four metres further back
 *      alone. Both scene-wide terms are therefore split rather than spent: the
 *      rim pair keeps {@link DIRECTIONAL_RIM_SHARE} of its authored strength and
 *      the key keeps {@link DIRECTIONAL_KEY_SHARE} of its own, with the
 *      remainder of each riding on the fighters. That is what buys the
 *      figure/ground ratio without buying another light.
 *
 * The ambient terms are deliberately starved. Hemisphere fill and ground bounce
 * are held near a tenth of the key, because a wash that lifts every plane by the
 * same amount is what makes hard-surface armour read as one grey shape.
 *
 * Depth is carried by real aerial perspective rather than by darkness. The mood
 * fog colours are desaturated and pulled toward the surround, so a barrier
 * twenty metres out loses contrast and drifts toward the sky instead of sinking
 * toward black. Distance that reads as "gets darker" is the inverse of what the
 * eye expects and it flattens a stage into a backdrop. `FogExp2` is quadratic in
 * depth, which puts effectively none of that on the fighters at five to eight
 * metres and all of it on the set behind them — the localised behaviour the rig
 * is built around, not the global veil it replaced.
 *
 * The haze is held to roughly a third of the mood's own mid-ground luminance,
 * which is the part that had to be walked back. Aerial perspective that reaches
 * the value of the thing it is veiling stops being depth and becomes milk: the
 * barrier, the crowd and the far skyline all arrive at the same light grey and
 * the mid-ground loses the contrast it was supposed to be trading away.
 *
 * Two cubes are baked from the same scene at chest height (0, 1.4, 0), so the
 * parallax of the practical quads is correct for a standing robot:
 *
 *   - the lighting cube, which PMREM filters into `scene.environment`;
 *   - the background cube, rendered with `uBackground = 1`. That pass crushes
 *     the sky, drops the emissive quads entirely (a bare white rectangle is a
 *     light source, not scenery), and rolls the remaining emitters through a
 *     knee instead of a flat scale so a 17-nit light bank stops clipping to
 *     paper while a 3-nit sign keeps its colour.
 *
 *     That knee caps every background emitter at `bgLights / bgKnee` — 1.2
 *     linear on `industrial` — which through the display transform lands at
 *     about 0.81 of display white, so nothing in the surround can ever reach
 *     the top of the range no matter how it is authored. That looks like a
 *     direct cause of a frame with no clipped pixels, and it is not: swept at
 *     runtime with a re-bake, `bgKnee` from 0.50 down to 0.08 (asymptote 1.2 to
 *     7.5) and `bgLights` from 0.60 to 1.00 changed the delivered hero frame by
 *     **nothing at any percentile** — p02 through p999 and the saturated
 *     fraction identical to four decimals. `scene.background` only shows where
 *     no geometry draws, and `Stage` closes the pit. The visible emitters in a
 *     fight framing all belong to `StagePracticals` and the robots; this file
 *     owns none of them.
 *
 * The world the fighters stand in is therefore always much darker than the
 * light falling on them, which is the cheat every fighting game uses to make
 * characters pop.
 */

import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { SPLIT_LIGHT_LAYER } from './RenderPipeline.js';
import { ARENA_HALF_WIDTH, ARENA_HALF_DEPTH, LAYER } from '../core/Constants.js';
// The midground borrows the roster's already-baked detail set rather than
// authoring its own. See {@link MIDGROUND}: the textures are cloned before their
// repeat is touched, so this adds no texture memory and cannot retile a robot.
import { getSharedDetailTextures } from '../characters/Materials.js';

/** Height the environment probes are baked from — a robot's chest. */
const PROBE = new THREE.Vector3(0, 1.4, 0);

/** Every mood carries exactly this many practicals so moods can cross-fade. */
const PRACTICAL_COUNT = 4;

/**
 * Layer the emissive practical quads live on inside the environment scene. The
 * lighting probe sees it; the background probe does not — a bare white
 * rectangle is a light source, not scenery, and it has no business appearing in
 * the visible backdrop.
 */
const ENV_QUAD_LAYER = 3;

/**
 * Cube face resolution, shadow map size and light budget per quality tier.
 *
 * `cube` is the input to PMREM and it is the sharpness of every reflection in
 * the game. It was 256 and that was too low to tell the material library's story:
 * PMREM's roughness-zero mip is the input cube itself, so a chrome accent, a
 * polished piston and a scuffed plate all reflected the same soft mush and
 * therefore all read as the same middling metal. At 512 the light banks come
 * back as banks — a defined bright rectangle in the mirror surfaces and a smear
 * in the rough ones — which is the difference the eye actually uses to separate
 * them. It is baked only on a mood change, so the cost is memory and a couple of
 * milliseconds on a cross-fade, not per frame.
 */
// Area-light budget. The ladder that used to sit here — "0 / 4 / 8 area lights
// = 16.5 / 26.9 / 40.3 ms, linear, ~3.0 ms each" — described a rig that no
// longer exists, and it was still being quoted as the reason for the count
// below. **Eight RectAreaLights are built and three are ever uploaded.**
// Re-derived offline against the real rig (scratchpad/lightrig.mjs: builds the
// rig out of this file, replays `ScenePass.#classify`'s light rule verbatim and
// asks `THREE.Layers` which lights each half of the split beauty pass sees;
// positive control moves one light's layer and the arena count drops by exactly
// one, null re-runs classify and nothing moves):
//
//     RectAreaLight        tier.visible   arena half   fighter half
//     practicals[0]            yes            YES          YES
//     practicals[1..3]         no (1)          .            .
//     ceilingStrip[0..1]       no (0)          .            .
//     fighterKeyBox[0..1]      yes             .           YES
//
// `tier.practicals` is 1 at ultra and high and 0 below; `tier.strips` is 0 at
// EVERY tier. Three skips an invisible light in `WebGLRenderer.projectObject`
// before it ever reaches `WebGLLights`, so those five are not in
// `NUM_RECT_AREA_LIGHTS` and cost nothing per fragment. `NUM_RECT_AREA_LIGHTS`
// is **1** in the arena half and **3** in the fighter half.
//
// What one of them costs, counted rather than timed (scratchpad/lightops.mjs
// walks three r185's own ShaderChunk sources, resolves the preprocessor against
// each material's defines and inlines the call graph; null counts an empty body
// at 0, positive doubles a body and gets exactly 2x). Per fragment, per light:
//
//     light type                  arena material        kb.armor (cc+aniso)
//                                 ALU   tex   rel        ALU   tex   rel
//     Hemisphere                    4     0   0.05x        4     0   0.05x
//     Directional, no shadow       79     2   1.00x      131     2   1.60x
//     Point                        90     2   1.13x      142     2   1.72x
//     Spot, no shadow              93     2   1.16x      145     2   1.76x
//     Directional + PCSS          107     4   1.41x      159     4   2.01x
//     Spot + PCSS                 121     4   1.57x      173     4   2.17x
//     RectArea (LTC)              239     2   2.84x      361     4   4.33x
//
// So a RectAreaLight is **2.8x** a plain directional on the set and **4.3x** on
// the armour, not the order of magnitude the old ladder implied — r185 charges
// every punctual light two `dfgLUT` fetches inside `BRDF_GGX_Multiscatter`,
// which is most of why the gap closed. `USE_CLEARCOAT` is the other half: it
// adds a THIRD `LTC_Evaluate` and two more LUT taps to every RectAreaLight,
// which is why the same light costs half again as much on a fighter as on the
// deck.
//
// The frame cost of all of this is UNMEASURED — see the ablation arms on
// {@link ABLATE}, which exist so one verify pass can price the whole rig at
// 1920x1080 without a recompile inside a rep.
//
// The count below is still a deliberate spend. The one that earns it is the
// per-fighter key box; the stage practical sits at the same position as the
// brightest emissive quad in the cube, so PMREM already carries its soft
// contribution and what dropping it loses is the crisp rectangular specular on
// the *set*, which the camera is not pointed at.
/**
 * `keySpots` is the number of per-fighter keys and `keyShadows` how many of them
 * cast — two separate numbers because they cost completely different things.
 *
 * The **light** is nearly free and is what moves the axis: it is the whole of
 * the figure/ground and highlight-share result at {@link KEY_SPOT}, and it is
 * one more analytic term on 14% of the frame.
 *
 * The **shadow map** is not free, and the shape of its cost is worth writing
 * down because it decides the tier ladder. Alternated slowly per
 * `docs/PROFILING.md` — toggle, settle six seconds, 200+ consecutive render
 * intervals, three blocks — with the sim paused and adaptive resolution off:
 *
 *     configuration        median      vs off
 *     off                  12.7-12.9      —
 *     2 spots @ 1024       15.0-15.3   +2.40 ms
 *     2 spots @ 512        14.8-15.3   +2.40 ms
 *     1 spot  @ 1024       14.0-14.1   +1.30 ms
 *
 * Halving the map in each direction — a quarter of the fill — costs **nothing**,
 * and halving the number of maps saves **half**.
 *
 * **The conclusion drawn from that was wrong, and it is corrected here.** The
 * note used to read "so the whole 2.4 ms is rasterising casters, not shading
 * texels". That does not follow: this pipeline samples shadows with PCSS —
 * twelve blocker taps plus sixteen filter taps, see `buildPcssChunk` in
 * `RenderPipeline` — and a PCSS tap count is per SCREEN pixel, so the sampling
 * half is just as indifferent to map size as the rasterising half. Map size
 * being free is evidence about map size and about nothing else.
 *
 * Measured directly instead of inferred, by separating the two: `shadow.autoUpdate
 * = false` skips the redraw while every material keeps sampling the map it
 * already holds, so on a frozen frame the difference is rasterisation alone.
 * Paired A/B, arm toggled on and off twelve times a rep, medians of the
 * per-cycle differences, restated at the 16.95 ms shipping frame:
 *
 *     both spots, rasterise + sample (castShadow off)   -9.0%   -1.53 ms
 *     both spots, rasterise only (map frozen)           -4.9%   -0.83 ms
 *     => sampling                                       -4.1%   -0.70 ms
 *     the DIRECTIONAL key's 2560 map, rasterise only    +1.2%    noise
 *
 * So it is roughly 55% draw and 45% read, not 100% draw. The tier ladder's
 * decision is unaffected — dropping the shadow returns both halves — but the
 * reason there was so much of the draw half is real and is now fixed: it was
 * `RenderPipeline`'s depth prepass widening the camera mask so every light saw
 * every caster, which is what the directional key needs, so both of these maps
 * redrew the arena as well as the robots even though this light cannot shade the
 * arena at all. This note used to say that was "not fixable from here without
 * giving each light its own caster pass". It is fixable from `RenderPipeline`,
 * and `ScenePass.splitShadowCasters` is that caster pass: it takes 87% of the
 * geometry out of these two maps (52 draws and 380,792 triangles down to 30 and
 * 50,432, counted, zero spread over three interleaved reps) and leaves the
 * directional key's map bit-identical.
 *
 * Two consequences. Map size is free, so it is set for quality (1024 puts about
 * 4.7 mm per texel on the subject) and not trimmed. And the shadows are the
 * thing the tier ladder drops, not the light: at medium and low both spots stay
 * lit and neither casts, which keeps the axis result and returns the whole
 * 2.4 ms — and, incidentally, the `spotShadowMap` texture unit with it.
 *
 * They are dropped in pairs rather than one at a time on purpose. One shadowed
 * key across two fighters is 1.2 ms cheaper and lights player 2 differently from
 * player 1, and an asymmetry between the two sides of a fighting game is not a
 * quality setting.
 */
const TIERS = {
  ultra: { cube: 512, bg: 1024, shadow: 2048, practicals: 1, rims: 2, boxes: 1, strips: 0, keySpots: 2, keyShadows: 2, keyShadow: 1024 },
  high: { cube: 512, bg: 768, shadow: 2048, practicals: 1, rims: 2, boxes: 1, strips: 0, keySpots: 2, keyShadows: 2, keyShadow: 1024 },
  medium: { cube: 256, bg: 384, shadow: 1024, practicals: 0, rims: 2, boxes: 1, strips: 0, keySpots: 2, keyShadows: 0, keyShadow: 768 },
  low: { cube: 128, bg: 256, shadow: 512, practicals: 0, rims: 1, boxes: 0, strips: 0, keySpots: 2, keyShadows: 0, keyShadow: 512 },
};

/**
 * Per-light ablation arms, for pricing the rig one light at a time.
 *
 * **The light rig has never been ablated one at a time.** Every lighting round
 * in this project's history estimated the price of its own work, and the one
 * ladder that was measured (see the note above {@link TIERS}) described a
 * configuration that no longer exists. The charter names lights as one of only
 * two levers that buy frames, so the price of each one is a number the project
 * needs and does not have.
 *
 * It could not be taken with the existing knobs, for a reason `docs/PROFILING.md`
 * records: `light.visible` feeds `NUM_*_LIGHTS`, which is in the program cache
 * key, so toggling a light mid-session recompiles every material in the scene
 * and a fast A/B measures the recompile. Every arm therefore has to be a fresh
 * page with a fixed program set, and that is what this is: the set is read
 * **once, in the constructor**, and nothing in this file changes it afterwards —
 * `setQuality` re-applies it rather than overwriting it.
 *
 *     page.addInitScript(() => { window.KB_ABLATE = 'bounce,hemi'; });   // then goto
 *     ?kbAblate=bounce,hemi                                             // or the URL
 *     new Environment(r, s, { ablate: ['bounce'] })                     // or in code
 *
 * `addInitScript` is the one to use with `tools/capture.mjs`, which loads a bare
 * URL with no query string. It has to run BEFORE the page's own scripts, because
 * the set is read at module evaluation; setting `window.KB_ABLATE` from the
 * console after load does nothing, which is the correct behaviour — a light that
 * appeared mid-session would recompile every material and the arm would measure
 * the recompile.
 *
 * Arms, and which half of the split beauty pass each one is in. The arena half
 * is ~85% of the frame; the fighter half is the rest. `share` is that light's
 * share of its half's per-fragment analytic-light work, counted by
 * `scratchpad/lightops.mjs` — it is a COUNT, not a millisecond, and its only job
 * is to rank the arms:
 *
 *     arm                  lights                       half      share of half
 *     key                  keyLight                     both      16.3% arena
 *     keyShadow            keyLight.castShadow only     both      (map + PCSS taps)
 *     practicals           practicals[0]                both      32.7% arena
 *     bounce               bounceLight                  fighter   11.5% arena before
 *                                                                 this round's move
 *     hemi                 fillLight                    both       0.5% arena
 *     rims                 rimLight + rimLightB         fighter    2.0%*
 *     fighterRims          4 per-fighter rim spots      fighter   19.3%*
 *     fighterBoxes         2 RectArea key boxes         fighter   35.7%*  <- of which
 *                                                                 practicals[0] is a third
 *     fighterKeys          2 shadowed key spots         fighter   11.9%*
 *     fighterKeyShadows    those two, shadow only       fighter   (map + PCSS taps)
 *     allSplit             everything fighter-only      fighter   ~91%*
 *
 *     * shares marked with a star are of the FIGHTER half, which the same count
 *       puts at 4.2x the arena half's per-fragment light work — on a small
 *       fraction of the pixels. Do not add the two columns.
 *
 * The one arm that is NOT here on purpose is the three `PointLight`s at
 * intensity exactly zero (`EffectsDirector.impactLight`, `StagePracticals`'
 * spark and `Stage.wallLight`). They are 38.9% of the arena half's per-fragment
 * light work — the largest single item in the 85% of the frame that is arena,
 * larger than the shadowed key and larger than the practical — because three
 * evaluates a light at intensity zero in full: `getPointLightInfo` writes
 * `light.visible` and `RE_Direct_Physical` runs regardless. They belong to other
 * files and are named here so whoever owns them has the number.
 */
const ABLATE = (() => {
  const raw = (() => {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.KB_ABLATE === 'string') {
        return globalThis.KB_ABLATE;
      }
      if (typeof location !== 'undefined' && location.search) {
        return new URLSearchParams(location.search).get('kbAblate') ?? '';
      }
    } catch { /* no DOM, no globals: the shipping path */ }
    return '';
  })();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
})();

/** One rim rig per fighter; the game runs two. */
const FIGHTER_RIG_COUNT = 2;

/**
 * Geometry and response of a per-fighter rim spot. The numbers are a lighting
 * setup, not tuning knobs: 3.2 metres back puts the source well outside the body
 * so the cone grazes rather than floods, and the elevation is held down at 20°
 * on purpose. Higher and it becomes a hair light — it tops the shoulders and the
 * helmet crown, which is lovely in a closeup and invisible at the framing the
 * game is actually played at. Nearly level with the chest it draws the vertical
 * edge down the whole silhouette, and that edge is what the player reads.
 *
 * The cone is the part that had to be measured: three's penumbra is the
 * fraction of the cone spent ramping, so the plateau is `angle * (1 - penumbra)`.
 * At 0.85 that plateau is five degrees — a spotlight nominally lighting a whole
 * fighter that actually delivers full strength to a hand-sized patch. 0.42 puts
 * a 1.2-metre plateau radius on the fighter at 3.2 metres with another metre of
 * skirt around it, so an outstretched arm is still inside the light while the
 * ramp does the work of keeping the far half of the body out of it.
 */
/**
 * **Do not try to make these graze. It was tried and it is worse.**
 *
 * Zeroing both spots on a frozen frame and differencing shows where the pass
 * actually lands, and it is not an edge: it is a cyan-and-magenta wash across
 * the front-facing shield disc, the plastron and the thighs, brightest on the
 * broadest plates. The obvious reading is that ±34° off directly-behind is too
 * far round to graze, so the fix is to push the sources behind the fighter and
 * drop them toward the horizon. Measured, in one session, sources re-placed
 * relative to the *camera*'s view axis at a fixed irradiance (radius² folded in
 * so each arm delivers the same power at the subject):
 *
 *     placement                          sil/halo   sil/body   top1% on fighters
 *     shipped (±34°, 20°, 3.2 m)           1.07       1.50          13.7%
 *     ±25° off back, 10°, 4.6 m            1.01       1.35          12.5%
 *     ±15° off back,  6°, 4.6 m            1.00       1.36          13.7%
 *      ±8° off back,  4°, 5.2 m            1.02       1.31          12.0%
 *
 * Every grazing arm is worse on every metric. The intuition is borrowed from
 * organic subjects and does not transfer: a body with a smooth silhouette has
 * near-tangent surface at its outline, and a rim source behind it catches that
 * tangent. A robot's outline is made of flat plate *edges* facing arbitrary
 * directions, so moving the source behind the fighter turns it away from the
 * outline at the same rate it turns it away from everything else — and it loses
 * the three-quarter plates that were at least carrying hue. The ±34° placement
 * below is a local optimum and this brief should stop paying for attempts on it.
 */
const RIM = {
  radius: 3.2,
  elevationDeg: 20,
  /** Aim height above the fighter's root — a standing robot's chest. */
  aimHeight: 1.2,
  angle: 0.62,
  penumbra: 0.42,
  decay: 2,
  range: 7.5,
  /**
   * Candela per unit of the mood's authored rim irradiance. `radius²` is folded
   * in at use. Above one because a rim is meant to overdrive: on brushed metal
   * the edge is carried by a specular lobe seen at a grazing angle, so the
   * cosine term is already throwing most of it away, and a rim budgeted to match
   * the key measures the same on a light meter and disappears on screen.
   *
   * There is a ceiling on that argument and it was found the expensive way. At
   * 2.6 the cool spot delivered four times the key's irradiance at the subject
   * and the warm kicker delivered two and a half; both sit three-quarters behind
   * but a point source at 3.2 metres wraps, so between them they lit the flanks
   * and most of the front harder than the key did. The silhouette edge was
   * excellent and the body inside it was one flat value, which is the trade the
   * critic called out. 1.7 kept the rim pass at roughly twice the key — hot
   * enough to draw the edge, not hot enough to become the key.
   *
   * 1.95 because {@link DIRECTIONAL_RIM_SHARE} went to zero and the fighter
   * would otherwise have lost that third of its rim budget along with the
   * background: the 15% here is sized to put the *fighter* back where it was
   * while leaving the background where the share cut moved it. Measured, that
   * is what it does — core median 78.22 -> 77.71 and core p90/p10 7.30 -> 7.33,
   * so the body is neither dimmer nor flatter, while the edge band gains 3.8%
   * over the background. It is still well under the 2.6 ceiling above, which is
   * where the body genuinely did go flat.
   *
   * **1.66, and the reason is that this pass was never only drawing an edge.**
   * Zeroing the two spots on a frozen frame and differencing removes **15.6% of
   * the total light on a fighter**, and the difference image is not a rim: it is
   * a cyan-and-magenta wash over the whole arm, the whole thigh and half the
   * torso. A point source at 3.2 m wraps, and a faceted robot presents plates
   * facing the rim azimuth all over its body, so most of that 15.6% lands
   * *inside* the silhouette where it acts as a third fill. The 2.6 ceiling above
   * was found by pushing until the body went flat; the body was already being
   * flattened at 1.95, just not enough to notice next to the softbox doing four
   * times as much of it.
   *
   * Cutting it 15% is worth about 0.05 of form contrast and it does not cost the
   * edge — measured across the change the silhouette band goes **up** relative
   * to the body (0.81 -> 0.94), because taking fill off the body is worth more to
   * the edge than the rim's own 15% is. It is not cut further because hue is the
   * channel this light exists for and the reference leans on it: at 0.5 the cyan
   * on a warm robot stops reading as a second source.
   *
   * **1.20, and the sentence immediately above is the reason it can be.** That
   * sentence is the only thing that was holding this number up: the pass is 15.6%
   * of the light on a fighter, the difference image shows most of it landing
   * *inside* the silhouette as a cyan-and-magenta wash over arm, thigh and
   * torso, and the single argument against cutting the wash was that the hue
   * would go with it. {@link SCREEN_RIM} now carries the hue on a term that is
   * added rather than multiplied, so the analytic spots no longer have to be the
   * thing that makes the rim coloured, and what is left of their job — a real
   * three-dimensional falloff round the shoulder and the hip that no screen-space
   * term can fake — does not need 1.66 to do it.
   *
   * A 28% cut takes the pass from about 15.6% of a fighter's light to about
   * 11%, so the fighter loses roughly 5% of its total. That is affordable and
   * the surplus is already measured: {@link KEY_SPOT}.share records the subject
   * sitting at 0.21-0.22 linear against a Tekken 8 reference band of
   * 0.097-0.248, so 5% lands near 0.20 and stays inside it. What the 5% buys is
   * the second defect the lighting critics named — panel gaps and recesses that
   * "read as muddy dark orange, not black" — because a shadowless source that
   * wraps a 1 m robot from 3.2 m is precisely a light that fills creases, and
   * this is the second-largest of them after the softbox.
   *
   * Predicted, and worth checking against a capture rather than believed: form
   * contrast up (the 1.95 -> 1.66 cut was worth 0.05, so this should be worth
   * rather more), silhouette-over-body up again from 0.94, subject mean down
   * about 5%, and the cyan/magenta cast over the flat of the thigh plates
   * visibly reduced. If subject mean falls out of the 0.097-0.248 band, this is
   * the number to put back first.
   */
  gain: 1.20,
};

/**
 * The screen-space rim: a coloured edge added to the beauty buffer at depth
 * discontinuities, inside the fullscreen blit `ScenePass` already runs.
 *
 * ## Why this exists when the rig already has four rim lights
 *
 * It exists because of one word in the brief that no analytic light in this file
 * can satisfy: a rim that works **regardless of that character's own palette**.
 * A rim light in a forward PBR renderer is multiplied by the surface it lands
 * on. Diffuse is albedo-multiplied by definition; specular is F0-multiplied, and
 * for a metal F0 *is* the albedo. So a 0x38ccff rim on a fighter whose armour is
 * authored in cream and amber returns the fighter's blue reflectance, which on
 * this cast is a small number, and the edge that arrives is dim and neutral.
 * This is exactly the critic finding that "our rim is currently material colour,
 * not a light", and it is not a tuning failure — it is what the BRDF does.
 *
 * {@link RIM} records the other half of the same wall, measured rather than
 * argued: four placements swept from the shipped ±34° round to ±8° off directly
 * behind, and *every grazing arm was worse on every metric*, because a robot's
 * outline is made of flat plate edges facing arbitrary directions rather than
 * the near-tangent surface an organic silhouette presents. Its conclusion is
 * blunt — "on a faceted hard-surface robot no analytic light draws an outline"
 * — and it is right. An additive screen-space term is the way past both walls at
 * once: it is not multiplied by anything, and it finds the outline from the
 * depth buffer instead of hoping a cosine lands on it.
 *
 * ## What it costs
 *
 * Nothing that the budget counts. No light is added, so `NUM_SPOT_LIGHTS`,
 * `NUM_DIR_LIGHTS` and `NUM_RECT_AREA_LIGHTS` are unchanged and no material in
 * the scene recompiles — which is the trap `docs/PROFILING.md` documents and the
 * reason `DIRECTIONAL_RIM_SHARE` had to wait a whole round to be reclaimed. No
 * draw call is added either: `ScenePass` already blits its target into the
 * composer's write buffer every frame with a trivial copy shader, and this is
 * four extra depth taps and a dot product inside that shader, on the ~20-30% of
 * the frame that survives the depth gate. Against a scene pass that measures
 * 60-72 ms of which 34 ms is eight `RectAreaLight`s, it is not a term the frame
 * budget can see.
 *
 * ## The two knobs that are here rather than in the pipeline
 *
 * Colour and level, because they are the mood's and this file owns moods. The
 * geometry — band width, gate depth, edge threshold — is the pass's and lives
 * in `RenderPipeline`.
 */
const SCREEN_RIM = {
  /**
   * The mood rim irradiance that maps to a level of 1. The table runs 8.4 to
   * 10.4 across the seven moods, so a reference of 9.0 puts every mood inside
   * 0.93-1.16 and no mood is a special case — the point of normalising here is
   * that the pass keeps its authored strength when a mood pushes its rim budget
   * for the analytic rig, instead of the screen-space edge tracking it linearly
   * and blowing out on `neonCity`.
   */
  reference: 9.0,
  /**
   * Cool arm and warm arm, as fractions of the pass's own gain. The 2:1 split
   * follows the mood tables rather than being chosen here — every mood authors
   * its `rimB` kicker at 2.5-4.0 against a `rim` of 8.4-10.4, and the standard
   * warm-key / cool-rim / warm-kicker rig wants the kicker under the rim. What
   * this file must NOT do is let the two arms sum to an outline: they are on
   * opposing azimuths and each is gated to the edges facing it, so a pixel that
   * takes both is a pixel where the depth gradient points at both sources at
   * once, which the `max(dot, 0)` on each arm makes impossible.
   */
  cool: 1.0,
  warm: 0.45,
};

/**
 * The per-fighter key softbox: one {@link THREE.RectAreaLight} riding on the
 * mood's own key azimuth, two-and-a-bit metres out.
 *
 * This is the single largest thing separating a browser render from a shipped
 * one, and it is not a tuning value. A directional light is a point at infinity,
 * so its specular lobe is the *point's* mirror image blurred by roughness: on a
 * bevelled armour plate that lands as a small round dot in the middle of the
 * facet, and a round dot is what the eye reads as plastic. A rectangle two
 * metres tall reflects as a rectangle two metres tall — a long shaped bar drawn
 * down the plate, bending where the plate bends. Bent steel looks like bent
 * steel because you can see the shape of the room in it.
 *
 * The same source is what makes the material library legible. `Materials.js`
 * authors real response variety — clearcoat on paint, anisotropy on the frame
 * stock and the pistons, sheen on the cable, a near-mirror on the chrome — and
 * under a punctual light almost none of it survives, because every one of those
 * differences is a difference in the *width* of the lobe and a point source
 * gives them all the same tiny dot to widen. Under an area source rubber smears
 * the bar into a dim wash, brushed gunmetal stretches it along the grain, the
 * piston draws it as a hard stripe and the visor mirrors it outright. Nothing in
 * that list is new work; it was always there and had nothing to reflect.
 *
 * It rides the fighter for the same reason the rim spots do: at 2.8 metres it
 * falls off, so it lifts the armour without lifting the barrier behind it. That
 * matters here more than anywhere — before this the floor measured brighter than
 * both fighters standing on it, which inverts the figure/ground relationship
 * every fighting game depends on.
 *
 * Unlike the rims it does **not** yaw into the camera's frame. It is the mood's
 * key made local, so it has to agree with the directional key at every camera
 * angle; a softbox that swung round on a KO orbit while the hard key stayed put
 * would read as two keys from two directions.
 */
const KEY_BOX = {
  radius: 2.8,
  elevationDeg: 33,
  /** Aim height above the fighter's root — chest, same as the rim rigs. */
  aimHeight: 1.3,
  /**
   * Panel size, and the reason it is a strip rather than a square. Fill and
   * highlight are two different quantities off the same light: the diffuse lift
   * follows *irradiance*, which is radiance times solid angle, while the
   * brightness of the bar drawn on a polished facet follows *radiance* alone.
   * Divide the area by two at constant irradiance and the fill is unchanged
   * while the bar doubles.
   *
   * That is the whole trick, and it was found by walking the other way first: a
   * panel wide enough to be a proper softbox had to be driven six times over
   * before the highlight read, and by then it was pouring so much fill into the
   * armour that the shadow side had gone and the fighters were flatter than
   * before the light was added. Thirty centimetres by two metres is a tube
   * fixture rather than a softbox — 6° by 40° seen from the chest — and it draws
   * a long thin bar down the plates at a radiance the tone curve lands on white,
   * on a fill that stays where it was.
   *
   * **The second half of that argument does not survive measurement, and the
   * width is therefore not a top-of-range lever.** The claim above is that
   * halving the panel at constant irradiance leaves the fill alone and doubles
   * the bar. Tested at 1080p with the frame clock stopped — a null control of
   * two grabs with nothing changed differs by exactly zero code values, and two
   * `base` variants interleaved through the run came back bit-identical — by
   * driving `box.width` down and `box.intensity` up by the reciprocal, so the
   * irradiance at the fighter is held and only the radiance moves. Percentiles
   * over a fighter-only mask on the head closeup, linear luminance:
   *
   *     radiance x1.0 (0.30 m)   p50 0.1170   p99 0.6187   max 0.9691
   *     radiance x1.4 (0.22 m)   p50 0.1169   p99 0.6187   max 0.9691
   *     radiance x2.7 (0.11 m)   p50 0.1165   p99 0.6187   max 0.9691
   *
   * Nearly three times the radiance and the brightest pixel on the fighter does
   * not move at all. There is no bar to double. What the box *does* do is real
   * and is the reason it stays: leaving the width at 0.11 m with the authored
   * radiance restored — 37% of the irradiance — dropped the same fighter's
   * median from 0.117 to 0.085, so the panel carries about a quarter of the
   * light on the character. It is a fill source, and only a fill source.
   *
   * The reason is roughness. A rectangle only reflects *as* a rectangle where
   * the specular lobe is narrower than the source; over the roughness the
   * armour is actually authored at, the LTC lobe integrates the whole panel and
   * the peak follows irradiance, which is exactly the quantity being held
   * constant. So this is a live lever again the moment `Materials.js` puts a
   * genuinely smooth surface on a fighter — polished trim, a visor, a chromed
   * piston — and it is inert until then. That belongs to the character
   * workstream; nothing in this file can buy it.
   */
  width: 0.3,
  height: 2.0,
  /**
   * Irradiance the box delivers at the aim point, as a fraction of the mood's
   * authored key. Radiance is solved back out of it at use, so a mood that
   * pushes its key drags the softbox with it and the ratio survives.
   *
   * It was 0.6 on top of a directional key running at full authored strength,
   * which put 1.6 keys on the fighter and 1.0 on the deck. It then became the
   * larger half of a split budget — see {@link DIRECTIONAL_KEY_SHARE} — at 0.94.
   *
   * **0.94 was three times too much, and the estimate that justified it was off
   * by a factor of five.** That number came from a light-meter argument: "at
   * 0.94 the soft half is already 59% of the key on the fighter". What actually
   * arrives on a fighter is measurable, and the estimate was never checked
   * against it. Measured by zeroing one term at a time on a frozen frame inside
   * a single page session — the null control and the restore-and-regrab both
   * differ from the base by **0.0000** code values, so every figure below is
   * signal — and integrating linear luminance over a fighter mask built by
   * hiding the robots in that same frozen frame:
   *
   *     key softbox (this light)      43.6% of the light on a fighter
   *     per-fighter rim spots         15.6%
   *     key directional (shadowed)    15.6%
   *     env IBL                        6.4%
   *     hemisphere fill, bounce,
   *     ceiling strips, practicals    under 0.5% each
   *
   * The softbox was not 59% of the key. It was **2.8x** the key, and it is the
   * largest single source of light on the character by a factor of nearly three.
   * Three gives a `RectAreaLight` no shadow, so 43.6% of a fighter's light was
   * arriving with no occlusion term at all: it filled every crease the hard key
   * was carving and it lit the shadow side to the same value as the lit side.
   *
   * Two things follow, and both were measured rather than argued:
   *
   *   - **The body had no form.** Low-frequency luminance range across the body
   *     — blur sigma pinned to a tenth of the subject's own on-screen width, so
   *     the figure is scale-invariant, then (p90-p10)/p50 inside the mask — read
   *     **0.58-0.66** on the pale fighter. The same measurement on hand-placed
   *     boxes fully inside a Tekken 8 character runs **0.76 to 1.65** across
   *     seven references, median 1.16. We were at roughly half the reference.
   *   - **The rim was not a rim.** The one-pixel band inside the silhouette
   *     measured **0.81 to 1.05x the body core** across four runs. A rim light
   *     is by definition an edge brighter than the body; ours was the same
   *     value as the body, because the softbox had lifted the body to meet it.
   *     That is the rubric's "strong coloured rim separating fighter from
   *     background" reading as nothing at all, and no amount of driving the rim
   *     harder could have fixed it — the fill was the problem.
   *
   * At 0.34, with the directional key raised to 0.92 and {@link RIM}.gain at
   * 0.85 of its old value, the same frozen-frame comparison gives:
   *
   *     form contrast, pale fighter   0.64 -> 0.80   (+25%)
   *     form contrast, dark fighter   1.24 -> 1.30
   *     silhouette edge / body core   0.81 -> 0.94
   *     fighter / deck luminance      6.09 -> 3.88
   *
   * The cost is real and is paid on purpose: the fighters lose about a fifth of
   * their brightness and the deck gains about a fifth. Both are affordable
   * because both were outside the reference to begin with — the pale fighter sat
   * at 0.31-0.37 linear against a Tekken range of 0.097-0.248, and figure/ground
   * sat at 4.3-6.1 against a Tekken 1.31-1.78. This spends a surplus that was
   * measured, not a margin that was guessed.
   *
   * What does **not** work, tested and discarded so nobody repeats it: shrinking
   * the panel's angular size at constant irradiance. The wrap of a 6°x40° source
   * around the terminator is not what flattens the body. Driving height from
   * 2.0 m to 0.2 m and width from 0.30 m to 0.12 m, with intensity raised by the
   * reciprocal of the area so the irradiance at the fighter is held, moves form
   * contrast by 0.02-0.05 and the edge ratio not at all. The only lever on this
   * light is how much of it there is.
   */
  share: 0.34,
};

/**
 * The per-fighter **shadowed** key: one {@link THREE.SpotLight} per rig, on the
 * mood's own key azimuth, casting a real shadow map.
 *
 * This is the light the lighting axis has been asking for since round 18 and
 * could not have, and the thing that was blocking it was a sampler count rather
 * than a frame budget. `kb.armor` sat at **16 of 16** texture image units with
 * zero shadowed spots in the scene, so a single `spotShadowMap` entry would have
 * failed to link the fighters' own material. `Materials.js` freeing two units by
 * folding occlusion and metalness onto the roughness sampler — the same texture,
 * still bound, still sampled, two fewer `uniform sampler2D` declarations — takes
 * it to 14 and admits `spotShadowMap[2]` exactly.
 *
 * Measured on the real app under headless ANGLE/Metal, `MAX_TEXTURE_IMAGE_UNITS`
 * 16, after `rosterLineup()` so every material in the cast has compiled:
 *
 *     configuration                     kb.armor   arena.floorWet   programs over
 *     before the fold, 0 spot shadows      16            15               0
 *     after  the fold, 0 spot shadows      14            13               0
 *     after  the fold, 2 spot shadows      16            13               0
 *
 * Note the middle column. The round brief expected `arena.floorWet` to be a
 * second blocker needing its own unit freed before a second spot could be
 * afforded, and it is not: these spots live on `SPLIT_LIGHT_LAYER`, and
 * `RenderPipeline`'s split beauty pass draws the arena with that layer masked
 * out, so no arena program ever compiles a spot shadow sampler at all. The cost
 * lands only where the light lands. Two shadowed spots fit, and 0 of 184
 * programs exceed the cap with them armed.
 *
 * Why a spot rather than more of the softbox, when {@link KEY_BOX} already
 * measures as 43.6% of the light on a fighter: three gives a `RectAreaLight` no
 * shadow. That is the whole point. The rig's dominant source arrives with no
 * occlusion term, so it fills every crease the hard key carves and lights the
 * shadow side to the same value as the lit side — measured there, and the reason
 * `KEY_BOX.share` was cut from 0.94 to 0.34. What that repair could not do is
 * put the missing energy back *as shaped light*, because the only shadowed
 * source in the rig is the scene-wide directional, and a directional is parallel
 * and infinite: every unit of it lands on the deck as hard as on the plate. That
 * is exactly the term the rubric's failure line is about — subject over
 * background at **1.03**, silhouette band over background at **1.08**, and the
 * frame's top 1% of luminance landing on the fighters at **13.3%** against a
 * 12.2% frame share, which is highlights distributed at chance.
 *
 * A spot at three and a half metres on `SPLIT_LIGHT_LAYER` is the one source
 * shape that answers all three at once. It is punctual, so it has a shadow and a
 * terminator. It is on the fighter layer, so every unit of it is subject and
 * none of it is background. And it falls off, so it cannot flatten the set the
 * way raising {@link DIRECTIONAL_KEY_SHARE} does.
 *
 * Geometry: it is placed along the mood's **own** `key.dir`, elevation included,
 * rather than being re-seated at an elevation of its own. That is the point of
 * it — the shadowed spot is the directional key made local, so the two
 * terminators land in the same place instead of reading as two keys. The moods
 * already argue this themselves ("there is exactly one key and it has to win",
 * 30–40° off the camera axis at 37–40° elevation, raked so the terminator runs
 * vertically across a chest plate) and this light inherits all of it for free,
 * including on a mood change. Measured, the re-seated 40° arm and the mood-dir
 * arm land within 1% of each other on every metric on `industrial`, which is
 * the check that the inheritance is doing what it claims.
 *
 * Distance, cone and penumbra were swept on a frozen frame, all arms inside one
 * page session with the `off` arm repeated at the end (it returned bit-identical
 * both times). Six metres beat 4.6 m on low-frequency form contrast and 8 m on
 * everything else. On the cone, the result was the opposite of the intuition: a
 * WIDE cone with a HARD edge (0.40 rad, 0.12 penumbra) beat a narrow cone with a
 * soft one (0.26–0.30 rad, 0.30 penumbra) on every metric *including* form, and
 * it still beat it after the narrow arm was driven up to matched subject
 * brightness — 0.9945 form against 0.9569.
 *
 * The penumbra shipped is 0.20 rather than the 0.12 that measures best, and that
 * is a deliberate and quantified trade rather than a rounding. Swept on frozen
 * frames on both framings, with the light in every other respect as shipped:
 *
 *                  hero                              wide
 *     penumbra  subj/bg  top1%  form(LF)     subj/bg  top1%  form(LF)
 *       0.12     2.680   37.8%   1.143        2.442   5.3%    1.135
 *       0.20     2.663   37.0%   1.125        2.425   5.0%    1.118
 *       0.30     2.641   36.3%   1.100        2.392   4.7%    1.085
 *
 * 0.12 is better on every column, and it is not shipped because of what the
 * numbers cannot see: the plateau at 0.12 is 2.23 m and the skirt 2.53 m, so as
 * the fighters back away from each other the *neighbour's* spot switches off
 * over 30 cm of travel, and a step in the key while a player walks backwards is
 * worse than 1% of anything in that table. 0.20 puts the same transition over
 * 55 cm for about half the loss.
 */
const KEY_SPOT = {
  radius: 6.0,
  /** Aim height above the fighter's root — chest, same as the other two keys. */
  aimHeight: 1.2,
  angle: 0.40,
  penumbra: 0.20,
  decay: 2,
  range: 16,
  /**
   * Irradiance at the aim point as a fraction of the mood's authored key,
   * exactly the units {@link KEY_BOX}.share is in, so a mood that pushes its key
   * drags all three keys with it. `radius²` is folded back in at use because a
   * spot with decay 2 delivers `intensity / d²`.
   *
   * Swept on a frozen frame inside one page session — the light is built and
   * shadow-casting in every arm and only its intensity moves, so the compiled
   * program is identical across the sweep and the difference is signal. Hero
   * framing, `off` repeated at the end and bit-identical to the first `off`:
   *
   *     share   subj/bg   top1% on fighters   form (low-freq)   subject mean
   *     0        2.143          30.4%              1.288           0.175
   *     0.50     2.510          37.3%              1.201           0.206
   *     0.62     2.589          38.3%              1.185           0.212
   *     0.75     2.670          39.9%              1.167           0.219
   *     1.00     2.818          42.3%              1.138           0.231
   *     1.30     2.983          44.0%              1.105           0.244
   *
   * 0.75 rather than the 1.30 the first two columns keep rewarding, and the
   * reason is the last two. Low-frequency form contrast falls monotonically with
   * share, and it is the axis's other half — the measurement that said the body
   * was flat when `KEY_BOX.share` was cut. And the subject mean is a budget this
   * file has already spent once: that cut happened because the pale fighter sat
   * at 0.31–0.37 linear against a Tekken 8 range of 0.097–0.248, so there is no
   * surplus left to spend a second time. At 0.75 the subject sits at 0.21–0.22
   * on both framings, inside the reference band, and the whole run stays inside
   * the Tekken form-contrast range (0.76–1.65 over seven references).
   */
  share: 0.75,
  /**
   * Near and far for the shadow camera, in metres from the source.
   *
   * These are a performance control as much as a precision one. The frame's
   * shadow maps are all drawn in `RenderPipeline`'s depth prepass, which widens
   * the camera mask so every caster in the scene is visible to every light — so
   * without a tight far plane each of these two maps would rasterise the whole
   * arena as well as the robots. The source is a fixed 6 m from the aim point
   * and a fighter is under 2.5 m tall, so 2 m to 12 m contains one fighter, a
   * little of the other and a patch of deck, and three's own
   * `_frustum.intersectsObject` rejects the rest before it reaches a draw.
   */
  near: 2,
  far: 12,
  bias: -0.0006,
  normalBias: 0.018,
  softness: 3.2,
};

/**
 * Fraction of the mood's key intensity left on the scene-wide directional. The
 * rest rides with the fighters on {@link KEY_BOX}, exactly the way
 * {@link DIRECTIONAL_RIM_SHARE} already splits the rim budget.
 *
 * This is the one knob that moves the figure/ground ratio without touching the
 * light count, because the key is the only term the fighter and the deck were
 * receiving in equal measure. A directional key is parallel and infinite: it
 * lands on a chest plate and on the four square metres of deck the fighter is
 * standing on at exactly the same irradiance, and no amount of rim or bounce
 * tuning can separate two surfaces that are being lit by the same light at the
 * same strength. Moving a third of it onto a source at 2.8 metres keeps the
 * fighter where it was and takes a third off the deck, the barrier, the crowd
 * and everything the floor mirrors — measured below.
 *
 * Measured, headless at 1080p with the simulation paused and the frame clock
 * pinned, sampling fighter pixels against the deck pixels within 2.6 m of a
 * fighter. Both masks come from frame differencing inside one page session —
 * once against the same frame with the fighters hidden and once with the floor
 * hidden — so the mirror image and the cast shadow are excluded from both sides
 * rather than argued about. This constant alone, nothing else changed:
 *
 *                camera      fighter    deck     ratio
 *     hero     +3.8 deg   0.139 -> 0.146   0.075 -> 0.071   1.85 -> 2.06
 *     wide    +13.1 deg   0.150 -> 0.148   0.073 -> 0.076   2.06 -> 1.95
 *
 * The fighter holds and the deck comes off, which is the trade the split was
 * built for. Two things it does not do, both worth writing down.
 *
 * It is not camera-invariant, and the brief that asked for invariance had the
 * mechanism backwards: the ratio does not fall off as the camera pulls back, it
 * falls off as the camera drops. Wide is the *best* framing at 2.06 and a low
 * hero angle is the worst, because the variation is almost entirely in the deck
 * and the deck's Fresnel term goes to one as the eye approaches the plane — at
 * -5 deg the floor mirrors the whole lit set back at the camera and reads
 * brighter than the fighter standing on it. That response lives in
 * `StageFloor`; what is reachable from here is the level the whole curve sits
 * at.
 *
 * And 2.06 is not short of a target, it is past one. The figure asked for was
 * "roughly 2.5x"; measured the same way on the reference set — hand-placed
 * rectangles on figure and floor — Tekken 8 runs **1.78** on the cage stage
 * (`tekken8_08`, figure 0.137 against floor 0.077) and **1.31 to 1.57** on the
 * daylight farm (`tekken8_07`). What separates a Tekken fighter from its ground
 * at a ratio of 1.4 is hue and rim, not luminance, and this rig already spends
 * heavily on both. So the split is kept for the deck it takes off the set and
 * not pushed further for a number the reference does not exhibit.
 *
 * **0.66 -> 0.92, and the direction of the argument above is now reversed.**
 * The paragraph before this one is still correct about what the split buys; what
 * it did not know is what the soft half was doing to the character it was
 * supposed to be lighting. See {@link KEY_BOX}.share for the term-by-term
 * decomposition: the softbox turned out to be 43.6% of the light on a fighter
 * against the directional key's 15.6%, so the shadow-casting half of the key was
 * outnumbered nearly three to one by a half that three gives no shadow at all.
 * A fighter lit that way has no terminator and no rim, and both are measured
 * there.
 *
 * This is the half of that repair that puts brightness back. It cannot be free:
 * a directional key is parallel and infinite, so every unit of it lands on the
 * deck as well. Measured on the same frozen frames, the deck is **56.6% env IBL,
 * 34.3% key directional, 13.7% practicals**, and the fighter is only 6.4% env
 * IBL — which is why cutting `environmentIntensity` looks like the obvious way
 * to pay for a bigger key and is not: holding the deck exactly would need the
 * IBL at roughly half, and the IBL is what the metal reflects.
 *
 * So the deck is allowed to rise about a fifth and the ratio to fall from 4.3-6.1
 * to 3.9. That is spending a measured surplus: the reference runs 1.31-1.78 and
 * we remain more than twice it. The share is held at 0.92 rather than pushed to
 * the 1.4-1.8 the sweep also covered because past about 1.0 the lift stops being
 * confined to the deck — the crowd band is 39.6% key directional too, and at 1.8
 * the whole set flattens up toward the fighters faster than the fighters gain.
 */
const DIRECTIONAL_KEY_SHARE = 0.92;

/**
 * The overhead strip pair: two long thin {@link THREE.RectAreaLight}s running
 * along the fight axis above the pit, the light the mood's `ceiling` block has
 * always described and never actually cast.
 *
 * `ceiling` already authors rows of light banks into the HDR cube — colour,
 * height, and an `on` term that is 1 in the shop and the arena, a fifth on the
 * night rooftop and zero at golden hour. Reading the strips off it means no mood
 * gains a light it should not have, and the sky shader and the rig cannot drift
 * apart. `StagePracticals` hangs the tube runs and their drop rods on the same
 * two lines, so the streak has a fitting above it.
 *
 * They are long, close and nearly overhead, which is a different highlight from
 * the key box: the box draws a vertical bar down the front planes, the strips
 * draw a horizontal one across every upward-facing bevel — shoulder caps, the
 * tops of thigh plates, the helmet crown. Two shaped highlights crossing at an
 * angle is most of what "expensive render" means on hard-surface armour.
 */
const STRIP = {
  /**
   * Ten metres of it, against an arena eighteen wide. Long enough that a fighter
   * pushed most of the way to a wall is still under the run, short enough that
   * the deck it also lights stays inside the play area rather than washing the
   * whole pit — the run is here to put a highlight on the fighters, and every
   * metre of it past them is a metre of floor competing with them.
   */
  length: 10.0,
  width: 0.18,
  /**
   * World z of the two runs, and the height they hang at. Both sit above the
   * fight camera's frame line and inside the band `StageStructure` already
   * reserves for services, so `StagePracticals` can hang real fittings on them
   * without either one arriving in the middle of the shot.
   */
  z: [-2.8, 1.4],
  y: 5.3,
  /**
   * The runs are aimed across the pit rather than straight down, at the far
   * side of the fight line. Pointing a strip at the floor it hangs over spends
   * its whole cosine on the floor — the deck comes up, the fighters barely move,
   * and the figure/ground ratio gets worse rather than better. Raked across, the
   * fighters sit near the axis and the deck under the fixture is lit at a
   * glance. `aim` is the height, the fraction is how far past centre in z.
   */
  aim: 1.35,
  aimCross: -0.45,
  /**
   * Radiance per unit of `ceiling.intensity`, gated by `ceiling.on`. Parity: the
   * sky shader already treats `ceiling.intensity` as the radiance of a bank
   * face, so the light and the bank in the reflection are the same surface at
   * the same brightness, which is the property the whole practical system is
   * built on. The cross-section carries the budget instead — 18 centimetres of
   * tube behind a reflector, not a two-metre trough. The small discount off
   * parity is the reflector: a channel fitting throws most of its output down
   * the cone and loses the rest to the housing.
   */
  gain: 0.85,
};

/**
 * Fraction of the mood's rim intensity left on the scene-wide directional pair.
 * The rest lives on the per-fighter spots. Directional rim light is parallel and
 * infinite: it edges the fighter and the wall behind the fighter by exactly the
 * same amount, which is how a silhouette dies into its background.
 *
 * **It is now zero, on measurement, and the argument above is why.** Measured
 * in-page on one frozen frame — the fighters repainted with an unlit white
 * material to get an exact silhouette mask rather than a frame-difference one,
 * then a 5px band either side of that boundary, with the mood driver frozen so
 * the rig could not re-derive the intensities it had just been given. Median
 * luma inside the edge over median luma outside it, which is the statistic this
 * axis is scored on:
 *
 *     directional share  per-fighter spots   inner   outer   lift   core med
 *     0.34 (shipped)     x1.00               92.42   68.13   1.357   78.22
 *     0.00               x1.00               87.88   63.56   1.383   76.46
 *     0.00               x1.15               89.69   63.67   1.409   77.71
 *     0.06               x1.08               89.64   64.49   1.390   77.46
 *
 * Two null arms of the same configuration returned the identical frame to two
 * decimal places, so 0.05 of lift is resolvable here. The third row is what
 * ships: **1.357 -> 1.409, +3.8%**, and the top quartile of the edge band
 * (which is the rim itself rather than the plate behind it) goes 2.164 -> 2.295,
 * +6.1%. It gets there the way a silhouette wants — the fighter holds (core
 * median 78.2 -> 77.7, core p90/p10 7.30 -> 7.33, so no flattening) and the
 * background drops 6.7%. No pixel on either fighter reaches 253 in any arm.
 *
 * Reclaimable and not taken this round: at zero the two directional rim lights
 * are shading every pixel in the frame for nothing. They cannot simply be
 * hidden, because `light.visible` changes `NUM_DIR_LIGHTS` and recompiles every
 * material in the scene — see docs/PROFILING.md — so it has to happen once at
 * construction, and that is a separate change with its own measurement.
 *
 * **That reclaim is taken now, and it turns the objection above into the fix.**
 * The pair is built onto `SPLIT_LIGHT_LAYER` — the same fighter-only layer the
 * per-fighter spots already use — so it is no longer scene-wide. The sentence
 * this constant opens with ("it edges the fighter and the wall behind the
 * fighter by exactly the same amount") was the whole case for zero, and a light
 * that cannot reach the wall does not have that property. What is left is the
 * one thing a directional rim is better at than a spot: it is parallel, so it
 * does not fall off across the body and it does not wrap the way a source 3.2 m
 * from a 1 m-wide robot does. It also comes off the arena half of the beauty
 * pass, which is what the paragraph above was asking for.
 *
 * Swept on the built page, one frozen hero frame, one session, mask by frame
 * difference (hide the two fighter groups and nothing else, so the pair is
 * exact). `RIM` is the 90th percentile of the 6 px silhouette band over the
 * mean of the 6 px of background immediately outside it — the file's own
 * "top quartile of the edge band is the rim itself rather than the plate behind
 * it", which is the only one of these that isolates the edge:
 *
 *     share   subj/bg   sil/halo   RIM    top1% on fighters   sil/body
 *      0.00    1.14       1.05     2.16        15.9%            1.17
 *      0.55    1.17       1.08     2.22        17.7%            1.16
 *      0.88    1.18       1.09     2.25        18.5%            1.16
 *      1.43    1.21       1.11     2.30        19.7%            1.15
 *
 * Monotone, and the flattening the old zero was defending against costs 0.02 of
 * sil/body across the whole range — because the light can no longer reach the
 * background, the fill it deposits on the body is bought back several times
 * over by the background it no longer lifts. 0.85 ships — the top of the swept
 * range, not past it, because `sil/body` carries real session-to-session
 * variance (the same build measured 1.39 and 1.61 on two boots) and is not a
 * number to extrapolate on.
 *
 * It is a small effect and it is reported as one: 0 -> 1.43 is worth 0.14 on
 * RIM, against the 0.15 that darkening the mid-ground bought on subj/bg by
 * itself. **On a faceted hard-surface robot no analytic light draws an outline**
 * — see the failed grazing sweep recorded on `RIM`.
 */
const DIRECTIONAL_RIM_SHARE = 0.85;

/**
 * Radiance of an env-scene practical quad per unit of RectAreaLight power.
 * Tuned so four practicals contribute roughly 0.2–0.35 of ambient irradiance —
 * enough to be seen as shaped highlights, not enough to flatten the rig. The
 * quads only exist inside the environment cube, so this number is an ambient
 * term in everything but name and every unit of it is spent against the key.
 */
const QUAD_GAIN = 0.11;

/**
 * Minimum hue separation, in turns, a mood must keep between its key and its
 * cool rim. Hue is the only channel a rim has that survives the fighter's own
 * albedo: the intensity of a back light reads as "that plate is brighter", but
 * a cyan edge on a tungsten-lit robot reads as a second source and draws the
 * silhouette. A rim within a few degrees of the key is indistinguishable from
 * the key spilling round the back no matter how hard it is driven. 0.36 of a
 * turn is 130°, short of a true complement so a mood can still be authored off
 * axis, far enough that nothing can land as a neighbour.
 *
 * `rimB` is exempt on purpose. It is a kicker on the opposite flank, and the
 * standard warm-key / cool-rim / warm-kicker rig wants it near the key.
 */
const MIN_RIM_HUE_SEPARATION = 0.36;

// ---------------------------------------------------------------------------
// Small helpers for building mood tables.
// ---------------------------------------------------------------------------

const C = (hex) => new THREE.Color(hex);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Unit vector pointing *from* the origin *toward* a light at the given angles. */
function dir(azimuthDeg, elevationDeg) {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  const c = Math.cos(el);
  return new THREE.Vector3(c * Math.cos(az), Math.sin(el), c * Math.sin(az));
}

/**
 * One practical: a bright quad in the environment cube plus a matching
 * RectAreaLight in the scene. `power` drives both, so a highlight in a
 * reflection always has a light behind it.
 */
function practical(pos, target, w, h, color, power, flickerAmp, flickerHz, seed) {
  return {
    pos: V(pos[0], pos[1], pos[2]),
    target: V(target[0], target[1], target[2]),
    size: new THREE.Vector2(w, h),
    color: C(color),
    power,
    flickerAmp,
    flickerHz,
    seed,
  };
}

// ---------------------------------------------------------------------------
// Moods.
//
// Colours are authored in sRGB hex; THREE converts to linear working space on
// construction. Intensities are radiance, and they are budgeted rather than
// eyeballed: the surround is aimed at well under one unit of ambient
// irradiance so the directional rig (key 4–6, rim 6–9) stays in charge of the
// read, while the sun sits at 1e1–1e3 and the practicals at 4–36 to give bloom
// and the specular lobes something genuinely HDR to bite on.
//
// Four rules were paid for in rendered frames rather than guessed at:
//   - there is exactly one key and it has to win. It sits 30–40° off the camera
//     axis at 37–40° elevation, warm against a cool ambient, and it is the
//     brightest thing landing on a front plane. Raked at that elevation the
//     terminator runs vertically across a chest plate instead of sliding down
//     it, so the value gradient the eye uses to place the source survives being
//     two hundred pixels tall.
//   - the rims are nearly horizontal (11–17°) and well behind. A rim above the
//     subject washes a side plane; a rim beside it draws the silhouette edge,
//     which is the entire point. `rim.intensity` is the budget for the whole
//     rim pass; the per-fighter spots take the majority of it and multiply
//     again by {@link RIM}.gain, which lands the cool rim near 2× the key and
//     the warm kicker (`rimB`) below it. Those two ratios are the whole rig.
//     Push the rim past the key and the fighter loses its lit side; drop it
//     under the key and the fighter merges into the set.
//   - `fill` and `bounce` stay under a fifth of the key. They keep the shadow
//     side off paper black and do nothing else. Whatever they add, they add
//     equally to the lit plane, the side plane and the wall four metres behind,
//     so they buy readability at the direct cost of form.
//   - `bgSky` keeps the visible surround well under the light falling on the
//     fighters. It is not a look control; it is the figure/ground separation
//     every fighting game leans on, and it is cheap to spend and expensive to
//     get back.
//
// `fog.color` is aerial perspective, so it is authored as a desaturated relative
// of the mood's own haze — the colour a few hundred metres of lit air would be,
// not a darker version of the set. It is deliberately kept below the mid-ground
// it veils; `StageStructure` reads it too and drives the parallaxed skyline off
// it at 2.4×, so a fog colour raised until it looks right on its own arrives on
// the far city at more than twice that and takes the whole backdrop with it.
//
// **It was not below the mid-ground it veils, and that is why the frame had no
// depth ramp.** Measured on one frozen hero frame with the arena and the
// fighters separated by a frame-difference mask (hide the two fighter groups,
// nothing else changes, so the pair is exact): the mid-ground band read a mean
// luminance of 60/255 and the fog colour it was being blended toward read 55.
// Fog can only build depth if its colour differs in *value* from the surfaces it
// veils; blending 60 toward 55 does nothing at any density, and disabling the
// fog outright moved the frame by 2.39/255 against an in-session noise floor of
// 0.80. Aerial perspective was, in effect, switched off.
//
// The colours below are now roughly a third of the value they were, on the same
// hue, with density up by half. The point is the *ramp*, and it is asymmetric on
// purpose — at the fight framing the fighters are 6.4 m out and the crowd tier
// 15 m, so the same curve costs the subject 7% and the mid-ground 35%:
//
//     industrial, density 0.034, colour 0x0b1018
//     6.4 m (fighters)      5% fog    mid-ground band  60.0 -> 48
//     15 m  (crowd tier)   22% fog    subject band     78.9 -> 76
//     26 m  (far wall)     55% fog
//
// A darker colour at a lower density beats a lighter one at a higher density,
// because the two knobs are not symmetric: density is what the *near* field
// pays and colour is what the *far* field converges to. The first pass shipped
// 0.042/0x101722 and it cost the wide framing 11.4% of its pixels to the bottom
// of the range; 0.034/0x0b1018 holds the same mid-ground drop, takes that back
// to 10.2%, and lifts the wide framing's mean 66.6 -> 70.0 with the top 1% on
// the fighters going 4.0% -> 4.7%. Prefer moving the colour before the density.
//
// Measured through the built page, subject-over-background mean goes 1.03 ->
// 1.11 on this change alone. See the round note on `DIRECTIONAL_RIM_SHARE` for
// why that ratio, rather than saturation or mid-ground contrast, is the number
// this axis was actually failing.
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
const MOODS = {
  /** Cold fluorescent shop floor with sodium floods bleeding in from the sides. */
  industrial: {
    sky: {
      zenith: C(0x0b111a),
      horizon: C(0x222b38),
      ground: C(0x070910),
      intensity: 0.9,
      zenithPower: 0.55,
      groundFalloff: 0.22,
      hazeColor: C(0x4a5c76),
      hazeStrength: 0.24,
      hazeHeight: 0.13,
    },
    sun: {
      dir: dir(72, 58),
      color: C(0xdfe9ff),
      intensity: 11,
      radius: 0.14,
      glowIntensity: 0.45,
      glowPower: 14,
    },
    ceiling: {
      on: 1,
      height: 11.5,
      spacing: 9,
      sizeX: 0.055,
      sizeY: 0.42,
      falloff: 0.0022,
      color: C(0xe8f1ff),
      intensity: 11,
    },
    bands: { color: C(0xff9142), intensity: 2.0, y: 0.03, width: 0.05, count: 13 },
    screens: { color: C(0x7fd4ff), intensity: 1.7, count: 9, y: 0.2, height: 0.05 },
    structure: { count: 11, width: 0.15, dark: 0.16 },
    floorRefl: 0.32,
    // Tungsten work light against the shop's cold fluorescent ambient. The
    // warm/cool split is between this and `fill`/`sky`, not between this and
    // the rim — the rim only has to clear it in hue, and it already does.
    key: { color: C(0xffdcae), intensity: 8.6, dir: dir(32, 38) },
    rim: { color: C(0x38ccff), intensity: 9.4, dir: dir(214, 16), hueDrift: 0.018 },
    // Rose rather than sodium. The kicker draws the flank the cool rim cannot
    // reach, and on an orange robot an orange kicker draws nothing at all.
    rimB: { color: C(0xff5a6a), intensity: 3.6, dir: dir(326, 13) },
    bounce: { color: C(0x6b7c94), intensity: 0.2, dir: dir(280, -22) },
    fill: { sky: C(0x36506b), ground: C(0x181310), intensity: 0.15 },
    fog: { color: C(0x0b1018), density: 0.034 },
    shaft: { color: C(0xbfd8ff), intensity: 0.85 },
    envIntensity: 0.52,
    bgSky: 0.26,
    bgLights: 0.6,
    bgKnee: 0.5,
    exposure: 1.0,
    practicals: [
      practical([-6.6, 5.4, -6.2], [-1.6, 1.1, 0], 6.4, 0.5, 0xdff0ff, 15, 0.045, 7.3, 0.11),
      practical([6.6, 5.4, -6.2], [1.6, 1.1, 0], 6.4, 0.5, 0xdff0ff, 15, 0.05, 6.1, 0.63),
      practical([-10.2, 2.3, -8.6], [0, 1.2, 0], 3.4, 2.6, 0x9fdcff, 26, 0.07, 2.4, 0.29),
      practical([8.6, 3.1, 7.8], [0, 1.35, 0], 3.4, 2.2, 0xff9a52, 4.5, 0.1, 3.9, 0.81),
    ],
  },

  /** Rain-slick rooftop under a magenta/cyan sign wall. Night, no sun. */
  neonCity: {
    sky: {
      zenith: C(0x0d0718),
      horizon: C(0x2c1042),
      ground: C(0x060409),
      intensity: 0.85,
      zenithPower: 0.7,
      groundFalloff: 0.2,
      hazeColor: C(0xb03fd0),
      hazeStrength: 0.5,
      hazeHeight: 0.1,
    },
    sun: {
      dir: dir(300, 52),
      color: C(0xc8d8ff),
      intensity: 60,
      radius: 0.028,
      glowIntensity: 0.3,
      glowPower: 30,
    },
    ceiling: {
      on: 0.2,
      height: 22,
      spacing: 11,
      sizeX: 0.1,
      sizeY: 0.1,
      falloff: 0.004,
      color: C(0xa8c8ff),
      intensity: 9,
    },
    bands: { color: C(0xff2ea6), intensity: 5.4, y: 0.045, width: 0.026, count: 29 },
    screens: { color: C(0x2ff2ff), intensity: 4.6, count: 19, y: 0.16, height: 0.05 },
    structure: { count: 9, width: 0.13, dark: 0.1 },
    floorRefl: 0.55,
    // The key is sodium street light, not moonlight. A cool key under cyan neon
    // leaves the rim a near-neighbour and the whole frame one temperature. It
    // also has to be the loudest thing in a mood built entirely out of coloured
    // sources, or the fighters read as another sign.
    key: { color: C(0xffc98e), intensity: 7.6, dir: dir(40, 38) },
    rim: { color: C(0x18dcff), intensity: 10.4, dir: dir(212, 14), hueDrift: 0.035 },
    rimB: { color: C(0xff2fb0), intensity: 4.0, dir: dir(328, 12) },
    bounce: { color: C(0x8a4fd0), intensity: 0.26, dir: dir(290, -20) },
    fill: { sky: C(0x3d1a60), ground: C(0x0a0810), intensity: 0.13 },
    fog: { color: C(0x0c0713), density: 0.037 },
    shaft: { color: C(0xff6fd0), intensity: 0.85 },
    envIntensity: 0.56,
    bgSky: 0.28,
    bgLights: 0.66,
    bgKnee: 0.46,
    exposure: 1.05,
    practicals: [
      practical([-7.2, 5.0, -7.4], [-1.4, 1.2, 0], 5.6, 0.42, 0xff3ab0, 24, 0.09, 5.4, 0.19),
      practical([7.2, 5.0, -7.4], [1.4, 1.2, 0], 5.6, 0.42, 0x30f0ff, 24, 0.08, 4.7, 0.71),
      practical([-10.6, 2.6, -8.2], [0, 1.2, 0], 3.0, 3.4, 0x35f0ff, 34, 0.12, 1.9, 0.37),
      practical([9.0, 3.4, 7.4], [0, 1.35, 0], 3.2, 2.4, 0xff2fa0, 7, 0.14, 2.6, 0.93),
    ],
  },

  /** Foundry pit. Deep red key from below, ember fill, cold rim for contrast. */
  volcanic: {
    sky: {
      zenith: C(0x160604),
      horizon: C(0x54140a),
      ground: C(0x210803),
      intensity: 1.0,
      zenithPower: 0.5,
      groundFalloff: 0.3,
      hazeColor: C(0xff5a1c),
      hazeStrength: 0.75,
      hazeHeight: 0.15,
    },
    sun: {
      dir: dir(206, 9),
      color: C(0xff6a24),
      intensity: 120,
      radius: 0.055,
      glowIntensity: 1.5,
      glowPower: 9,
    },
    ceiling: {
      on: 0.45,
      height: 9,
      spacing: 6.5,
      sizeX: 0.05,
      sizeY: 0.22,
      falloff: 0.003,
      color: C(0xff8a3a),
      intensity: 7,
    },
    bands: { color: C(0xff3c08), intensity: 7.5, y: -0.055, width: 0.04, count: 21 },
    screens: { color: C(0xffb04a), intensity: 2.4, count: 7, y: 0.14, height: 0.05 },
    structure: { count: 13, width: 0.12, dark: 0.09 },
    floorRefl: 0.5,
    key: { color: C(0xff9c52), intensity: 7.8, dir: dir(32, 37) },
    rim: { color: C(0x3f9dff), intensity: 8.8, dir: dir(216, 15), hueDrift: 0.02 },
    rimB: { color: C(0xffd08a), intensity: 3.4, dir: dir(324, 11) },
    bounce: { color: C(0xff5a20), intensity: 0.5, dir: dir(275, -30) },
    fill: { sky: C(0x4d1408), ground: C(0x2a0a03), intensity: 0.2 },
    fog: { color: C(0x120703), density: 0.040 },
    shaft: { color: C(0xff8a3a), intensity: 1.0 },
    envIntensity: 0.54,
    bgSky: 0.26,
    bgLights: 0.66,
    bgKnee: 0.46,
    exposure: 0.95,
    practicals: [
      practical([-6.0, 4.6, -6.8], [-1.6, 1.1, 0], 5.4, 0.44, 0xff9a48, 12, 0.16, 3.1, 0.23),
      practical([6.0, 4.6, -6.8], [1.6, 1.1, 0], 5.4, 0.44, 0xff8030, 12, 0.18, 2.7, 0.57),
      practical([-9.8, 0.55, -6.0], [0, 1.0, 0], 8.0, 0.7, 0xff4a12, 30, 0.22, 1.3, 0.41),
      practical([9.4, 3.0, 7.0], [0, 1.3, 0], 3.0, 1.9, 0x6ab4ff, 5, 0.06, 4.4, 0.87),
    ],
  },

  /** Broadcast arena. Clean white key, hard coloured rims, dark crowd. */
  arena: {
    sky: {
      zenith: C(0x090d14),
      horizon: C(0x1d2634),
      ground: C(0x06080b),
      intensity: 0.8,
      zenithPower: 0.6,
      groundFalloff: 0.24,
      hazeColor: C(0x4d6a8f),
      hazeStrength: 0.2,
      hazeHeight: 0.1,
    },
    sun: {
      dir: dir(90, 74),
      color: C(0xffffff),
      intensity: 55,
      radius: 0.085,
      glowIntensity: 0.55,
      glowPower: 18,
    },
    ceiling: {
      on: 1,
      height: 13,
      spacing: 7,
      sizeX: 0.06,
      sizeY: 0.36,
      falloff: 0.0016,
      color: C(0xffffff),
      intensity: 17,
    },
    bands: { color: C(0x2f7bff), intensity: 3.0, y: 0.06, width: 0.032, count: 25 },
    screens: { color: C(0xff3b46), intensity: 3.0, count: 11, y: 0.155, height: 0.05 },
    structure: { count: 15, width: 0.11, dark: 0.12 },
    floorRefl: 0.4,
    // Warmer than a broadcast key really is. A neutral key is only neutral next
    // to something, and next to a blue ambient it just reads as the same light.
    key: { color: C(0xffe4bc), intensity: 9.2, dir: dir(38, 40) },
    rim: { color: C(0x1fb0ff), intensity: 9.6, dir: dir(215, 17), hueDrift: 0.012 },
    rimB: { color: C(0xff4a5e), intensity: 3.8, dir: dir(325, 14) },
    bounce: { color: C(0x8fa3ba), intensity: 0.22, dir: dir(284, -24) },
    fill: { sky: C(0x2d3b4d), ground: C(0x121417), intensity: 0.16 },
    fog: { color: C(0x090c11), density: 0.031 },
    shaft: { color: C(0xdce9ff), intensity: 0.95 },
    envIntensity: 0.52,
    bgSky: 0.24,
    bgLights: 0.58,
    bgKnee: 0.55,
    exposure: 1.0,
    practicals: [
      practical([-6.8, 6.0, -5.4], [-1.6, 1.2, 0], 7.0, 0.6, 0xffffff, 22, 0.02, 9.1, 0.07),
      practical([6.8, 6.0, -5.4], [1.6, 1.2, 0], 7.0, 0.6, 0xffffff, 22, 0.02, 8.4, 0.53),
      practical([-10.4, 2.4, -8.0], [0, 1.2, 0], 3.2, 2.8, 0x4fc4ff, 28, 0.035, 3.3, 0.31),
      practical([8.8, 2.8, 7.6], [0, 1.3, 0], 3.2, 2.2, 0xff5568, 6, 0.04, 4.1, 0.79),
    ],
  },

  /** Golden hour on an open platform. Long warm key, cold sky rim. */
  sunset: {
    sky: {
      zenith: C(0x1a3a7a),
      horizon: C(0xff9350),
      ground: C(0x2b1c14),
      intensity: 1.05,
      zenithPower: 0.85,
      groundFalloff: 0.18,
      hazeColor: C(0xffb072),
      hazeStrength: 0.55,
      hazeHeight: 0.07,
    },
    sun: {
      dir: dir(244, 5),
      color: C(0xffc07a),
      intensity: 760,
      radius: 0.021,
      glowIntensity: 1.9,
      glowPower: 11,
    },
    ceiling: {
      on: 0,
      height: 26,
      spacing: 14,
      sizeX: 0.08,
      sizeY: 0.08,
      falloff: 0.006,
      color: C(0xffd0a0),
      intensity: 6,
    },
    bands: { color: C(0xffb86a), intensity: 1.4, y: 0.015, width: 0.03, count: 19 },
    screens: { color: C(0xffe0b0), intensity: 1.2, count: 8, y: 0.11, height: 0.04 },
    structure: { count: 10, width: 0.17, dark: 0.06 },
    floorRefl: 0.28,
    key: { color: C(0xffb478), intensity: 9.4, dir: dir(206, 19) },
    rim: { color: C(0x6aa8ff), intensity: 8.6, dir: dir(332, 14), hueDrift: 0.014 },
    rimB: { color: C(0xffd8a0), intensity: 3.2, dir: dir(258, 9) },
    bounce: { color: C(0xc89060), intensity: 0.3, dir: dir(80, -26) },
    fill: { sky: C(0x6a90d0), ground: C(0x3a2620), intensity: 0.22 },
    fog: { color: C(0x1a1511), density: 0.032 },
    shaft: { color: C(0xffc890), intensity: 1.0 },
    envIntensity: 0.6,
    bgSky: 0.13,
    bgLights: 0.42,
    bgKnee: 0.6,
    exposure: 1.05,
    practicals: [
      practical([-7.0, 4.4, -7.0], [-1.6, 1.1, 0], 5.0, 0.45, 0xffd9a8, 8, 0.03, 6.7, 0.17),
      practical([7.0, 4.4, -7.0], [1.6, 1.1, 0], 5.0, 0.45, 0xffd9a8, 8, 0.03, 5.9, 0.61),
      practical([-11.0, 2.0, -7.2], [0, 1.2, 0], 4.4, 3.0, 0xffa860, 20, 0.02, 2.1, 0.43),
      practical([9.2, 3.2, 7.2], [0, 1.3, 0], 3.4, 2.4, 0x8fc0ff, 3.5, 0.02, 3.5, 0.89),
    ],
  },

  /**
   * **SKYDECK — dusk on an open rooftop.** The mood half of `src/arena/Arenas.js`'s
   * `skydeck`; the set is `StageRooftop.js`.
   *
   * This exists to be a *different lighting problem* from `industrial`, not a
   * different palette for the same one, and the difference is structural rather
   * than chromatic:
   *
   *   - **The key is ten degrees off the horizon instead of thirty-eight.**
   *     Shadow reach is `cot(elevation)` times the caster's height, so the pit's
   *     38 degrees puts a 1.85 m robot's shadow 2.4 m away and this puts it
   *     **7.4 m** away — three times the length, running out across open deck
   *     where the camera can read it. Nothing in a closed box lit from twelve
   *     metres up can produce that, which is the whole argument for the arena.
   *   - **There is no ceiling term at all** (`ceiling.on: 0`, and the tier table
   *     builds no strips anyway), so nothing lights a horizontal surface from
   *     above except the sky itself. Upward-facing bevels get the cool zenith
   *     and nothing else, which is the inverse of the pit, where they get the
   *     banks and nothing else.
   *   - **The warm/cool split is between the two ambient terms, not between the
   *     key and a rim.** `fill.sky` is a genuine blue skylight at nearly twice
   *     the pit's share of the key, because on a real roof at dusk the shadow
   *     side is lit by half a hemisphere of blue and it is *not* dark. That
   *     makes the sunlit face and the shadowed face of the same object two
   *     different colours, which is the single cue the pit has never had.
   *
   * The azimuth is 200 degrees, so the sun sits beyond the -x end of the fight
   * axis and every shadow runs toward +x and slightly toward the camera. The
   * roof furniture in `StageRooftop` is placed against exactly that geometry.
   *
   * `envIntensity` is the highest of any mood here (0.72 against 0.52-0.60) and
   * it is not a look decision: this is the only mood whose surround is a real
   * sky, so the image-based term is carrying an enormous, genuinely bright
   * source that the analytic rig does not represent. Cutting it to match the
   * others would leave the armour reflecting a room that is not there.
   */
  duskRoof: {
    sky: {
      zenith: C(0x101f42),
      horizon: C(0xff7a44),
      ground: C(0x120d0c),
      intensity: 1.15,
      // High, so the warm band stays pinned near the horizon instead of washing
      // half the dome — the rose has to be a band the towers stand against.
      zenithPower: 0.85,
      groundFalloff: 0.16,
      hazeColor: C(0xffa878),
      hazeStrength: 0.62,
      hazeHeight: 0.05,
    },
    sun: {
      dir: dir(200, 11),
      color: C(0xffb070),
      /**
       * 340, not the 620 this shipped at first, and the cut is about the CUBE
       * rather than about the sky.
       *
       * `sun.intensity` draws the disc into the environment cube, and the cube
       * is PMREM-filtered into `scene.environment`. So the sun is counted twice
       * on every surface: once as the directional key, and once as an
       * enormously bright spot in the irradiance the IBL delivers. Every mood
       * has that overlap and it is usually harmless because the disc is small
       * and `envIntensity` is around 0.5; this mood pairs the table's brightest
       * disc with its highest `envIntensity`, and the two multiply.
       *
       * Measured on the live page, deck band of the wide framing, everything
       * else held: zeroing `scene.environmentIntensity` takes the deck from
       * R 0.437 to 0.208 and its saturation from 0.81 to 0.64. Half the deck's
       * value and a large part of its orange was arriving through the image, not
       * through the key — which is why cutting the floor's own tint terms to
       * nothing did not move the frame.
       *
       * The disc stays plainly HDR at 340 (the tone curve clips it either way)
       * and `glowIntensity` carries the visible sunset independently, so what
       * this costs is the double-counted irradiance and nothing that is looked
       * at directly.
       */
      intensity: 340,
      radius: 0.023,
      glowIntensity: 2.1,
      glowPower: 10,
    },
    // No roof. Every number after `on` is inert and kept only so a cross-fade
    // into or out of this mood has something to interpolate against.
    ceiling: {
      on: 0,
      height: 30,
      spacing: 16,
      sizeX: 0.08,
      sizeY: 0.08,
      falloff: 0.006,
      color: C(0xffd0a0),
      intensity: 5,
    },
    // The city below the parapet: a warm band of street and window light around
    // the whole horizon, and lit office floors above it.
    bands: { color: C(0xffb45a), intensity: 2.4, y: -0.015, width: 0.022, count: 23 },
    screens: { color: C(0xff9a3c), intensity: 2.2, count: 15, y: 0.055, height: 0.032 },
    // Neighbouring towers occluding the sky. Wide and few, because a skyline is
    // a handful of big masses rather than a picket fence.
    structure: { count: 8, width: 0.2, dark: 0.06 },
    floorRefl: 0.3,
    /**
     * 14 degrees rather than the sun's own 11.
     *
     * The two are allowed to differ — the sun disc is what the surround and the
     * bloom see, the key is what casts — and three degrees of separation is
     * bought for a shadow-map reason. `_buildRig`'s ortho shadow camera is
     * 25 m by 23 m around the pit with a 70 m far plane, and at 11 degrees a
     * caster on the -x parapet throws 5.1 m of shadow past +x centre, which is
     * inside it; at 8 it starts leaving through the side. 14 keeps the reach at
     * 4.0 m per metre of height, which still puts a standing robot's shadow
     * 7.4 m out and a 4 m plant unit's clean across the deck.
     */
    key: { color: C(0xffb478), intensity: 9.6, dir: dir(200, 14) },
    // Skylight as the rim: the cold half of the frame, from the opposite flank
    // and nearly level, exactly as every other mood places it.
    rim: { color: C(0x64b4ff), intensity: 8.8, dir: dir(332, 15), hueDrift: 0.016 },
    rimB: { color: C(0xffcf9a), intensity: 3.4, dir: dir(252, 10) },
    // Off the roof deck itself, which at dusk is a warm grey membrane lit by a
    // low sun — the one bounce in this table that is a real measured surface
    // rather than a guess at a room. Cut with the fill raised, because the two
    // share a ceiling and this is the warm half of the pair.
    bounce: { color: C(0xb8794a), intensity: 0.18, dir: dir(28, -24) },
    /**
     * The largest hemisphere fill in the table, at nearly twice the pit's share
     * of its key, and this is the one mood where that is right rather than
     * sloppy.
     *
     * `MAX_FILL_SHARE` exists because an undirected lift adds equally to the lit
     * plane, the side plane and the wall behind, and on a closed set that
     * destroys form for nothing. On an open roof at dusk it is not a cheat: half
     * a hemisphere of blue sky genuinely IS the only thing lighting every
     * surface the sun cannot see, and the arena's whole premise is that a plant
     * unit is amber on one face and blue on the other. Without a real cool
     * ambient there is no second colour and the set reads as one warm mass —
     * which is what the frame measured, at 80% of its pixels in one hue bin.
     *
     * 0.52 with `bounce` at 0.18 puts the pair at 0.70 against the 0.88 the
     * ceiling allows, so it is inside the invariant rather than an exception to
     * it.
     */
    fill: { sky: C(0x7ea6de), ground: C(0x2a201a), intensity: 0.52 },
    /**
     * Thinner than any interior mood, and warmer.
     *
     * Fog here is doing a different job: `StageRooftop` fades its towers and its
     * skyline through their own exponential haze (a 12 m room's fog swallows a
     * 300 m skyline whole), so scene fog only has to carry the 30 m of air
     * between the fighters and the back parapet. At the pit's 0.034 it would
     * take a fifth of the contrast off the roof furniture the raking shadows are
     * drawn on, which is the thing this arena exists to show.
     */
    fog: { color: C(0x1c1620), density: 0.021 },
    shaft: { color: C(0xffbf8c), intensity: 0.55 },
    envIntensity: 0.72,
    /**
     * The highest `bgSky` in the table, because this is the only mood where the
     * surround is meant to be seen. It is still well under one: the sky has to
     * stay below the light landing on the fighters or a robot in front of it is
     * a silhouette, and a silhouette is the failure mode an open-sky stage is
     * most exposed to.
     */
    bgSky: 0.34,
    bgLights: 0.5,
    bgKnee: 0.55,
    exposure: 1.0,
    /**
     * Matched one-for-one to `StageRooftop`'s `practicalPositions`: the sodium
     * doorway of the stair bulkhead, the green roof sign on the back parapet,
     * the aircraft-warning head on the -x mast, and a small white service
     * fitting. They are an order of magnitude weaker than any interior mood's,
     * and that is correct rather than an oversight — the sun is 620 and these
     * are room lighting on a roof at dusk. They are here for hue and for the
     * highlight they put on nearby metal, not to light the fight.
     */
    practicals: [
      practical([11.0, 1.25, -6.13], [2.0, 1.1, -2.0], 1.02, 2.06, 0xff8a3c, 4.2, 0.05, 3.7, 0.13),
      practical([-1.6, 0.78, -11.06], [0, 1.2, -4.0], 5.4, 0.62, 0x3cff8a, 2.6, 0.09, 1.9, 0.47),
      practical([-13.2, 7.62, -8.6], [-4.0, 4.0, -3.0], 0.17, 0.17, 0xff2a1e, 1.1, 0.55, 0.42, 0.71),
      practical([-4.2, 1.6, -8.68], [-1.0, 1.2, -3.0], 0.5, 0.34, 0xdfeaff, 1.8, 0.03, 8.2, 0.29),
    ],
  },

  /**
   * **THE CISTERN — a flooded underground plant vault.** The mood half of
   * `src/arena/Arenas.js`'s `cistern`; the set is `StageVault.js`.
   *
   * The opposite failure mode to `duskRoof`, and deliberately so — between them
   * the three arenas span the range rather than clustering:
   *
   *   - **There is no sky and no sun.** `sun.intensity` is zero, so the surround
   *     contributes almost nothing and `envIntensity` is the lowest in the
   *     table. A surface not facing a fitting is genuinely near black, which is
   *     what makes the per-fighter shadowed key read HARD down here: there is no
   *     ambient floor for its terminator to dissolve into.
   *   - **The sources are the practicals, and they are strips.** Three mercury
   *     runs at 22-27 units against the pit's 15, on `RectAreaLight`s 3.2 m by
   *     10 cm. A source that long and that thin draws a hard bright line across
   *     a plate rather than a soft patch, and because it sits two metres from
   *     the wall it is bolted to, the falloff across that wall is visible in one
   *     frame. The pit's banks are twelve metres up and cannot do either.
   *   - **`bands` is the same fact told to the surround.** The horizontal ring
   *     in the sky shader sits at `y = 0.086`, which is where a 2.35 m strip on
   *     a wall 11 m away appears from the 1.4 m probe. So what the armour
   *     reflects and what actually lights it are the same fixtures at the same
   *     height, which is the property the whole practical system is built on.
   *
   * Hue is four bins by construction and not by tinting: mercury discharge is
   * blue-white, low-pressure sodium is nearly monochromatic amber, the emergency
   * fitting is green, and the water returns the first two mixed. `SLOT_BASE` in
   * `StageVault.js` carries the same four colours, so the set and the rig agree.
   */
  cistern: {
    sky: {
      zenith: C(0x04060a),
      horizon: C(0x0a1016),
      ground: C(0x020304),
      /**
       * A third of the other moods', not a tenth, and the first draft was the
       * tenth.
       *
       * The intent — "no sky and no soft ambient anywhere" — is right and it is
       * what makes the shadowed key read hard down here. The first pass
       * overshot it by about an order of magnitude and the frame proved it:
       * measured at 1920x1080 with the HUD band cropped, median luma **0.4 of
       * 255**, against the pit's 62.1 in the same run. More than half of every
       * frame was at or below code value zero, which is not a dark room, it is
       * an unlit one. A vault with nothing in it to see is not the opposite
       * lighting problem to the rooftop, it is an absent one.
       *
       * This term is most of it, and the reason is where the set's light comes
       * from. A fighter is only 6.4% image-based, but the *set* is 56.6%, so
       * the surround is what decides whether an arena is visible — and this
       * mood authored the surround black and then cut `envIntensity` on top of
       * it. Both are raised, and the darkness now comes from the falloff
       * between the strips rather than from there being no light at all.
       */
      intensity: 0.85,
      zenithPower: 0.5,
      groundFalloff: 0.3,
      // The one ambient term allowed to be strong: damp air near the water,
      // hugging the horizon, which is where the strips throw their scatter.
      hazeColor: C(0x1c3346),
      hazeStrength: 0.35,
      hazeHeight: 0.22,
    },
    // Zero. Kept as a structurally complete block so a cross-fade from any
    // outdoor mood has a disc to interpolate to rather than a missing key.
    sun: {
      dir: dir(96, 62),
      color: C(0x8fb4d8),
      intensity: 0,
      radius: 0.02,
      glowIntensity: 0,
      glowPower: 24,
    },
    ceiling: {
      on: 0,
      height: 5.6,
      spacing: 4.6,
      sizeX: 0.04,
      sizeY: 0.05,
      falloff: 0.02,
      color: C(0xd6e8ff),
      intensity: 9,
    },
    /**
     * The wall strips, as the surround sees them. `y` is the elevation a 2.35 m
     * fitting on a wall 11.4 m out subtends from the 1.4 m probe; `count` is one
     * dash per arcade bay so the ring reads as separate fittings rather than as
     * a lit horizon; `width` is tight because a strip is 10 cm deep and a fat
     * gaussian here would put a glow band round the whole room and undo the
     * falloff the arena exists for.
     */
    bands: { color: C(0xd6e8ff), intensity: 11.5, y: 0.086, width: 0.028, count: 9 },
    // Sodium: the bulkhead lamp and the machine hall through the arch, both
    // lower and warmer than the mercury and both intermittent round the azimuth.
    screens: { color: C(0xff9a3c), intensity: 5.6, count: 6, y: 0.035, height: 0.03 },
    // The arcade. Thirteen piers, and darker than anything else in the table —
    // a pier down here is lit on one face by its own strip and is black.
    structure: { count: 13, width: 0.14, dark: 0.05 },
    // Standing water over a third of the deck. The highest in the table, which
    // is what puts the strips' mirror image under the fighters' feet.
    floorRefl: 0.62,
    /**
     * Cold mercury, and only 6.2 against the pit's 8.6.
     *
     * The key is deliberately not the brightest thing in this room; the strips
     * are. It is here to carve form and cast the hard shadow onto the weir wall
     * `StageVault` built for it, not to light the set, and the set is lit by
     * four `RectAreaLight`s at 22-27 units that no other mood comes near.
     */
    key: { color: C(0xcfe2ff), intensity: 8.0, dir: dir(38, 34) },
    // The warm half of the rig, and it is the RIM rather than the key — the
    // inverse of every other mood here. Sodium is the only warm source in the
    // room, so the fighters' edges are where it has to land.
    rim: { color: C(0xff9636), intensity: 8.4, dir: dir(212, 14), hueDrift: 0.01 },
    rimB: { color: C(0x35ffb0), intensity: 2.6, dir: dir(326, 12) },
    // Off wet concrete under blue-white strips.
    bounce: { color: C(0x3d6a86), intensity: 0.26, dir: dir(276, -26) },
    // Raised with the surround, and still the second-lowest in the table. The
    // ceiling `holdKeyToFill` enforces is 0.736 against a key of 8.0 and this
    // pair sits at 0.60, so the shadow side is off paper black and no more.
    fill: { sky: C(0x22384c), ground: C(0x0d1014), intensity: 0.34 },
    /**
     * The densest fog in the table, and one of the darkest colours to go with
     * it. Both halves matter and the file's own note on `industrial` says why:
     * density is what the near field pays and colour is what the far field
     * converges to. The vault's whole depth argument is a tunnel mouth 30 m
     * back that has to fade to almost nothing while the arcade at 12 m is still
     * readable, and that is a steep ramp on a dark asymptote rather than a lot
     * of grey.
     *
     * Pulled back from 0.046 / 0x060a0e with the surround, and for the same
     * measured reason. At 0.046 the ramp is 13% at the fighters, 50% at the
     * arcade and 88% at the far wall, converging on a colour four code values
     * off black — so the arcade, the machine hall and the tunnel all arrived at
     * the same nothing and the frame had the three readable depth layers this
     * arena was built to beat, not five. 0.036 on a lifted colour keeps the
     * subject's 10% and the tunnel's 80% while leaving the arcade something to
     * be seen against.
     */
    fog: { color: C(0x0d151c), density: 0.036 },
    shaft: { color: C(0xbcd6ff), intensity: 1.1 },
    // The lowest in the table. There is no room behind the room down here for
    // the metal to reflect, and the reflection it does get is the strips, which
    // arrive through the practicals instead.
    envIntensity: 0.58,
    bgSky: 0.2,
    bgLights: 0.62,
    bgKnee: 0.44,
    // A stop of headroom: the frame is mostly dark and its top end is four small
    // strips, so the tone curve has room the pit does not.
    exposure: 1.15,
    /**
     * Matched one-for-one to `StageVault`'s four bright fittings — the two
     * mercury strips on the tank walls (at deliberately different z, so the pair
     * does not light both fighters identically), the mercury key raking over the
     * weir from behind, and the sodium bulkhead lamp near-right. Sizes are the
     * real fittings': 3.2 m by 10 cm is a tube, not a softbox, and it reflects
     * as a line.
     */
    practicals: [
      practical([-11.06, 2.35, 1.2], [-1.0, 1.2, 1.2], 3.2, 0.1, 0xd6e8ff, 22, 0.03, 6.4, 0.09),
      practical([11.06, 2.35, -1.8], [1.0, 1.2, -1.8], 3.2, 0.1, 0xd6e8ff, 22, 0.035, 5.1, 0.53),
      practical([-2.2, 3.86, -7.54], [-1.0, 1.1, -1.0], 4.6, 0.12, 0xcadfff, 27, 0.06, 2.7, 0.33),
      practical([10.9, 2.05, 4.4], [2.0, 1.3, 2.0], 0.9, 0.42, 0xff9a3c, 6, 0.12, 1.6, 0.83),
    ],
  },
};

/**
 * Rotate a mood's cool rim away from its key until the two clear
 * {@link MIN_RIM_HUE_SEPARATION}, taking the shorter way round so an authored
 * intent is nudged rather than replaced. Saturation and lightness are untouched.
 *
 * This is the invariant, not a repair: every mood above already clears it, and
 * the point of enforcing it here is that the next mood cannot quietly stop
 * clearing it. Applied once to the table, so the cross-fade, `_applyParams` and
 * the per-fighter spots inherit the corrected hue without any of them knowing.
 *
 * @param {object} mood entry from {@link MOODS}, mutated in place
 */
function opposeRimToKey(mood) {
  const key = { h: 0, s: 0, l: 0 };
  const rim = { h: 0, s: 0, l: 0 };
  mood.key.color.getHSL(key);
  mood.rim.color.getHSL(rim);
  // Signed separation in (-0.5, 0.5]: hue is a circle, so the naive difference
  // reports 0.98 where the eye sees 0.02.
  let delta = rim.h - key.h;
  delta -= Math.round(delta);
  if (Math.abs(delta) >= MIN_RIM_HUE_SEPARATION) return;
  const away = delta < 0 ? -1 : 1;
  mood.rim.color.setHSL((key.h + away * MIN_RIM_HUE_SEPARATION + 1) % 1, rim.s, rim.l);
}

/**
 * Ceiling on a mood's undirected lift, as a fraction of its key.
 *
 * `fill` and `bounce` are the two terms that add the same amount to the lit
 * plane, the side plane and the wall four metres behind, so they are the only
 * two that can quietly destroy form without showing up anywhere as a mistake.
 * A tenth of the key is generous — every mood in the table is at four to nine
 * per cent — and the number exists so the next mood, or the next round of
 * tuning, cannot drift past it without someone deciding to.
 *
 * It deliberately does not police `envIntensity`. The image-based term is
 * ambient too, but it is *shaped* ambient: a rough plate facing the light banks
 * gets a different amount from it than one facing the dark machinery, which is
 * the opposite of a flat lift and is budgeted separately against `bgSky`.
 */
const MAX_FILL_SHARE = 0.1;

/**
 * Hold {@link MAX_FILL_SHARE}. Scales `fill` and `bounce` together so their
 * ratio to each other — which is a look decision — survives, and only their
 * total against the key is corrected.
 *
 * Worth stating what "the key" means here. The set is not lit by the mood's
 * authored key; it is lit by {@link DIRECTIONAL_KEY_SHARE} of it, the rest
 * having been moved onto the per-fighter softbox. The ceiling is therefore
 * measured against the directional alone, which is the term the set actually
 * receives and the only place a flat lift does its damage. Only `volcanic` was
 * riding close enough to the old ceiling to be scaled by the correction.
 *
 * @param {object} mood entry from {@link MOODS}, mutated in place
 */
function holdKeyToFill(mood) {
  const lift = mood.fill.intensity + mood.bounce.intensity;
  const ceiling = mood.key.intensity * DIRECTIONAL_KEY_SHARE * MAX_FILL_SHARE;
  if (lift <= ceiling || lift <= 0) return;
  const k = ceiling / lift;
  mood.fill.intensity *= k;
  mood.bounce.intensity *= k;
}

for (const mood of Object.values(MOODS)) {
  opposeRimToKey(mood);
  holdKeyToFill(mood);
}

/** Mood identifiers, in presentation order. */
export const MOOD_NAMES = Object.keys(MOODS);

// ---------------------------------------------------------------------------
// Deep clone / blend over the mood parameter tree. Colours interpolate in the
// linear working space (which is what we want — no gamma-space mud), vectors
// component-wise, everything else numerically.
// ---------------------------------------------------------------------------

function cloneParams(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v.isColor || v.isVector3 || v.isVector2) return v.clone();
  if (Array.isArray(v)) return v.map(cloneParams);
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneParams(v[k]);
  return out;
}

function blendParams(out, a, b, t) {
  for (const k of Object.keys(out)) {
    const ov = out[k];
    const av = a[k];
    const bv = b[k];
    if (typeof ov === 'number') out[k] = av + (bv - av) * t;
    else if (ov === null || typeof ov !== 'object') out[k] = t < 0.5 ? av : bv;
    else if (ov.isColor) ov.copy(av).lerp(bv, t);
    else if (ov.isVector3 || ov.isVector2) ov.copy(av).lerp(bv, t);
    else blendParams(ov, av, bv, t);
  }
  return out;
}

/** Re-normalise a blended direction, falling back if the lerp passed near zero. */
function renormalise(v, fallback) {
  if (v.lengthSq() < 1e-6) v.copy(fallback);
  return v.normalize();
}

// ---------------------------------------------------------------------------
// The sky shader. Written against the direction from the probe, evaluated once
// per cube texel. Everything is analytic: no textures, no noise lookups.
// ---------------------------------------------------------------------------

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // The box is translated to the probe and never rotated, so the object-space
  // position *is* the view direction.
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;

uniform float uBackground;

uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform vec3  uGroundCol;
uniform float uSkyIntensity;
uniform float uZenithPower;
uniform float uGroundFalloff;
uniform vec3  uHazeColor;
uniform float uHazeStrength;
uniform float uHazeHeight;

uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform float uSunRadius;
uniform float uGlowIntensity;
uniform float uGlowPower;

uniform float uCeilOn;
uniform float uCeilHeight;
uniform float uCeilSpacing;
uniform vec2  uCeilSize;
uniform float uCeilFalloff;
uniform vec3  uCeilColor;
uniform float uCeilIntensity;

uniform vec3  uBandColor;
uniform float uBandIntensity;
uniform float uBandY;
uniform float uBandWidth;
uniform float uBandCount;

uniform vec3  uScreenColor;
uniform float uScreenIntensity;
uniform float uScreenCount;
uniform float uScreenY;
uniform float uScreenH;

uniform float uPillarCount;
uniform float uPillarWidth;
uniform float uPillarDark;

uniform float uFloorRefl;
uniform float uSeed;
uniform float uTime;

uniform float uBgSky;
uniform float uBgLights;
uniform float uBgKnee;

#define KB_PI 3.141592653589793

float hash21( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}

// Rows of overhead light banks on a plane at uCeilHeight, seen by ray-plane
// intersection. This is what puts long specular streaks across a shoulder.
vec3 ceilingBanks( vec3 d ) {
  if ( uCeilOn <= 0.002 || d.y <= 0.06 ) return vec3( 0.0 );
  vec2 p = d.xz * ( uCeilHeight / d.y );
  vec2 q = p / uCeilSpacing;
  vec2 cell = floor( q );
  vec2 f = q - cell - 0.5;
  float h = hash21( cell + uSeed * 37.0 );
  vec2 e = vec2( 1.0 ) - smoothstep( uCeilSize - 0.035, uCeilSize + 0.035, abs( f ) );
  float bank = e.x * e.y;
  float atten = 1.0 / ( 1.0 + dot( p, p ) * uCeilFalloff );
  float lamp = 0.72 + 0.56 * h;
  return uCeilColor * ( uCeilIntensity * uCeilOn * bank * atten * lamp );
}

void main() {
  vec3 d = normalize( vDir );
  float up = clamp( d.y, -1.0, 1.0 );

  // --- sky / interior gradient -------------------------------------------
  float t = pow( max( up, 0.0 ), uZenithPower );
  vec3 sky = mix( uHorizon, uZenith, t );
  sky = mix( sky, uGroundCol, smoothstep( 0.0, -uGroundFalloff, up ) );
  sky *= uSkyIntensity;

  float haze = exp( -abs( up ) / uHazeHeight );
  sky += uHazeColor * ( uHazeStrength * haze );

  // --- structural silhouette occluding the sky near the horizon ----------
  float az = atan( d.z, d.x );
  float u = az * ( 0.5 / KB_PI ) + 0.5;

  float pf = abs( fract( u * uPillarCount ) - 0.5 );
  float pillar = 1.0 - smoothstep( uPillarWidth, uPillarWidth + 0.055, pf );
  pillar *= ( 1.0 - smoothstep( 0.34, 0.60, d.y ) ) * smoothstep( -0.20, -0.02, d.y );
  sky *= mix( 1.0, uPillarDark, pillar );

  // --- sun disc and forward scattering -----------------------------------
  float cs = dot( d, uSunDir );
  float ang = acos( clamp( cs, -1.0, 1.0 ) );
  float disc = 1.0 - smoothstep( uSunRadius * 0.82, uSunRadius * 1.18, ang );
  sky += uSunColor * ( uGlowIntensity * pow( max( cs, 0.0 ), uGlowPower ) );

  vec3 lights = uSunColor * ( uSunIntensity * disc );

  // --- practical light sources baked into the surround --------------------
  lights += ceilingBanks( d );
  lights += ceilingBanks( vec3( d.x, -d.y, d.z ) ) * ( uFloorRefl * step( d.y, -0.02 ) );

  float dy = ( d.y - uBandY ) / uBandWidth;
  float vprof = exp( -dy * dy );
  float dash = smoothstep( 0.38, 0.72, abs( sin( u * uBandCount * KB_PI ) ) );
  lights += uBandColor * ( uBandIntensity * vprof * dash );

  float sc = u * uScreenCount;
  float si = floor( sc );
  float sf = fract( sc ) - 0.5;
  float hs = hash21( vec2( si, 7.31 ) + uSeed * 11.0 );
  float lit = step( 0.32, hs );
  float mx = 1.0 - smoothstep( 0.11, 0.17, abs( sf ) );
  float my = 1.0 - smoothstep( uScreenH * 0.82, uScreenH * 1.2, abs( d.y - uScreenY ) );
  float flick = 0.84 + 0.16 * sin( uTime * ( 2.0 + hs * 7.0 ) + hs * 41.0 );
  lights += uScreenColor * ( uScreenIntensity * lit * mx * my * flick * ( 0.55 + 0.9 * hs ) );

  // Wet-floor bounce of the wall neon, so undersides of armour catch colour.
  float below = step( d.y, -0.02 );
  float mdy = ( -d.y - uBandY ) / ( uBandWidth * 2.2 );
  lights += uBandColor * ( uBandIntensity * exp( -mdy * mdy ) * dash * uFloorRefl * 0.5 * below );

  // The background pass crushes the sky and rolls the emitters through a knee
  // rather than a flat multiply. A linear scale either leaves a 17-nit light
  // bank clipped to white or kills the wall neon; the knee keeps a 3-nit sign
  // near its authored colour while landing a 55-nit sun just above 1.0, so the
  // backdrop stays saturated and readable instead of turning into paper.
  vec3 lightsBg = lights * uBgLights / ( vec3( 1.0 ) + lights * uBgKnee );
  vec3 col = sky * mix( 1.0, uBgSky, uBackground )
           + mix( lights, lightsBg, uBackground );

  gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
}
`;

// ---------------------------------------------------------------------------
// MIDGROUND
//
// The stage axis lost every blind pair it was entered in and the named cause was
// "there is no midground". That is a claim about the distribution of scene
// depth, so it was measured rather than argued. Raycast grid, 192x108 rays
// through the pinned `01-hero-idle` camera with the fighters hidden; the exact
// first-surface depth and the NAME of the object hit for each ray
// (scratchpad/r44-rays.mjs). Positive control: every ray landing on
// `arena.floor.*` hit it at |y| = 0 exactly. Null control: the cast repeated on
// the frozen frame moved 14 of 5184 rays, all of them the rotating
// `arena.structure.fan` and all in the 13-20 m band.
//
//     sublevel09        % of frame   occlusion edges   dominant surface
//     < 4 m                  2.78%          0          floor.slab 100%
//     4 - 5.5 m             17.59%          0          floor.slab 100%
//     5.5 - 9 m             17.59%          0          floor.slab 100%
//     9 - 13 m               9.47%       1344          floor.slab  98%
//     13 - 20 m             52.06%       1060          set.chain, steel, concrete
//
// **From the lens out to nine metres — 37.96% of the frame — there is not one
// occlusion boundary.** `skydeck` is identical to two decimal places on those
// three bands; `cistern` has a little flotsam and gets 92 edges. The 1344 in the
// 9-13 m band is one continuous line, the seam where the floor meets the wall,
// counted once per grid column. So the complaint is exact, and it is not "there
// is nothing out there" — 52% of the frame is set geometry. It is that
// everything out there is TWO PLANES: a floor and a wall. Nothing in between has
// a silhouette, and a silhouette is the only depth cue that survives at 367
// screen pixels per metre.
//
// --- WHY THE EMPTY BAND CANNOT SIMPLY BE FILLED ---------------------------
//
// The 5.5-9 m band maps to world z in [-0.93, -4.43], and `ARENA_HALF_DEPTH` is
// 5.5, so that band **is the play volume**. It is empty because a crate standing
// there is a crate standing in the fight. That is the constraint the two usable
// references (n=2, `tekken8_02` and `tekken8_07`) do not have to solve the same
// way: their props sit at the play boundary, and their play boundary lands in
// the mid band because the camera is closer to it than ours is.
//
// So this layer fills the band from the two directions that are actually free:
//
//   1. GROUND CLUTTER at the play boundary, z in [-8.2, -5.9], which is beyond
//      `ARENA_HALF_DEPTH` and in front of the wall the raycast found at
//      z = -8.6. That is 10.4 to 12.9 m from the lens: the 9-13 m band, which is
//      98% bare floor today. A 1.5 m object there is 230 screen pixels tall and
//      silhouettes against the wall behind it, which is exactly what the low
//      stone wall and the standing figures do in `tekken8_07`.
//
//   2. AN OVERHEAD RUN across z in [-1, -5] at y 2.9 to 3.6 m. At this framing
//      the top of frame is only 2.86 m up at 6 m depth and 3.69 m at 10 m, so
//      that band is on screen, it is in the 5.5-10 m depth the ground cannot
//      reach, and it is above a standing robot. `tekken8_02` carries exactly
//      this — overhead wires and a signal gantry cutting the frame behind the
//      fighters' heads.
//
// --- WHAT IT COSTS, MEASURED ----------------------------------------------
//
// Six `InstancedMesh` — one per kind, so six draw calls and no per-object
// overhead — over ~40 instances of two shared materials. Sampled once per
// animation frame for 40 frames and taken as a median, three alternating
// repetitions, identical every rep:
//
//     arena         layer tris   draw calls      frame triangles
//     sublevel09         1,700   292 -> 304      1,153,234 -> 1,156,634  (+0.29%)
//     skydeck            1,304   271 -> 283        765,461 ->   768,069  (+0.34%)
//     cistern               32   264 -> 266        766,459 ->   766,523  (+0.01%)
//
// The +12 is six meshes drawn twice: once for the beauty pass and once for the
// planar reflector, which is also why frame triangles rise by 2x the layer.
// Nothing casts a shadow (`castShadow = false`), so there is no shadow-pass
// cost at all. **No texture memory**: the maps are `getSharedDetailTextures`'
// plate and metal sets, CLONED so this layer can set its own repeat — mutating
// `.repeat` on the shared texture itself would retile every robot on the
// roster, which Materials.js's own note warns about — and a clone shares the
// GPU upload.
//
// Frame time was NOT measurable. Three alternating pairs per arena came back
// with the sign flipping on all three arenas and one rep 14 ms apart from its
// neighbour, on a machine with other agents live on it. A structural cost of
// +12 draws and +0.3% triangles on a frame the charter calls fill-bound is the
// honest statement; a frame-time figure taken here would be drift.
//
// The geometry is chunky on purpose: at 10 m one screen pixel is 6.5 mm, so a
// bevel under about a centimetre cannot land, and the budget goes to silhouette
// and depth separation rather than to surface. There is deliberately NO LOD
// chain — these objects live in a fixed 10-13 m band and the fight camera's own
// solve ranges only 3.4 to 16 m, so their screen size varies by about 2x and a
// second level would be machinery that never runs. Culling is three's own
// frustum test per kind.
//
// --- WHAT IT BUYS, MEASURED -----------------------------------------------
//
// Same instrument as the baseline, one frozen frame, arms are `visible` on one
// Group so no program is recompiled between them. RESTORE control 0.00/255 on
// all three arenas.
//
//     arena        9-13 m band       occlusion boundaries    frame pixels
//                  % of frame        5.5-20 m                changed
//     sublevel09   7.68 -> 18.85%    1333 -> 1587  (+19%)    23.81%
//     skydeck      8.02 -> 20.58%    1299 -> 1499  (+15%)    17.39%
//     cistern      see the note on its entry in MIDGROUND — clutter removed
//
// Against the references, and n=2: `tekken8_02` fills this band with a phone
// box pair, a planter, crowd barricades, a kiosk and overhead signage, and
// keeps the centre open behind the fighters; `tekken8_07` runs a low stone wall
// the full width at waist height and puts its height — spectators, alpacas,
// saplings — out to both sides. Both were read by eye, from the two images; two
// images are not a distribution and nothing here is fitted to them.
// ---------------------------------------------------------------------------

/**
 * Per-mood placement. One entry per arena, because the arenas do not share a
 * back wall: the raycast puts `sublevel09`'s at z = -8.6, and `skydeck` and
 * `cistern` carry their own set geometry in the 9-13 m band already.
 *
 * `z0`/`z1` bound the clutter band in world z.
 *
 * **`z1` is a gameplay constraint, not a taste one.** `Fighter.bounds` is
 * `halfDepth: 5.5`, so a fighter can legally stand at z = -5.5, and a crate is
 * up to a metre across once it has been yawed — so the near edge of the band
 * has to sit at about -6.6 for the nearest prop face to clear the play volume.
 * The first version had it at -5.9 and put crate corners inside the arena. `z0`
 * has no such limit: a prop that intersects the back wall is hidden by it.
 *
 * That leaves roughly 1.3 m of usable slab between the play bound and the wall,
 * which is the real reason this band is thin. `lift` raises the whole thing for
 * an arena whose deck is not at y = 0.
 */
const MIDGROUND = {
  industrial: {
    seed: 0x4d1d,
    z0: -8.3, z1: -6.6, halfWidth: 7.4,
    crates: 13, drums: 9, spools: 5, barriers: 8, posts: 4,
    // The pit is a machine hall: the overhead run is a pipe bundle.
    overhead: { count: 3, y: 3.15, z0: -4.6, z1: -1.2, radius: 0.085 },
    paint: 0x2b2b2c, metal: 0x3a3735, lift: 0,
  },
  duskRoof: {
    seed: 0x5c0f,
    z0: -8.1, z1: -6.6, halfWidth: 7.0,
    crates: 10, drums: 7, spools: 3, barriers: 9, posts: 4,
    // A roof deck gets a cable catenary rather than a pipe bundle: thinner, and
    // it reads against the sky, which is the one backdrop here that is bright.
    overhead: { count: 2, y: 3.35, z0: -4.2, z1: -1.6, radius: 0.05 },
    paint: 0x33302c, metal: 0x45423e, lift: 0,
  },
  cistern: {
    seed: 0x0c15,
    /*
     * NO GROUND CLUTTER HERE, and that is a measured decision rather than an
     * omission.
     *
     * The vault already fills 38.12% of the frame in the 9-13 m band with
     * `vault.cast`, against 7.68% in the pit and 8.02% on the roof — it is the
     * one arena that already has a midground. Adding this run to it was
     * measured on the frozen frame and it made the band WORSE: occlusion
     * boundaries in 9-13 m went 770 -> 700, because simple boxes stood in front
     * of the vault's own more articulated geometry and replaced its silhouettes
     * with theirs. It also cost 8.58% of the frame in changed pixels for a mean
     * difference of 2.07/255, most of which was the overhead run rather than
     * the clutter.
     *
     * So the clutter is off and the overhead run stays: that half does work
     * here, taking the 5.5-9 m band from 527 to 765 boundaries (+45%), which is
     * the band no arena can fill from the ground because it is the play volume.
     */
    z0: -7.6, z1: -6.6, halfWidth: 6.2,
    crates: 0, drums: 0, spools: 0, barriers: 0, posts: 0,
    overhead: { count: 2, y: 3.0, z0: -4.4, z1: -1.8, radius: 0.07 },
    paint: 0x24282b, metal: 0x333230, lift: 0,
  },
};

/**
 * Where the band is allowed to be TALL, as a half-width in metres.
 *
 * The first build put stacked crates, spools and stanchions straight across the
 * centre and it was wrong twice over. It hid the barrier signage the pit already
 * had — the one piece of storytelling in that part of the frame — and it put a
 * busy, light-valued run directly behind the two things the eye is supposed to
 * be reading.
 *
 * Both usable references (n=2) keep the centre open and load the edges.
 * `tekken8_02` puts its phone box, planters and barricade at the frame margins
 * and leaves the middle to smoke and open plaza; `tekken8_07` runs a wall the
 * full width but keeps it BELOW the fighter's waist, and puts the height — the
 * alpacas, the standing spectators, the saplings — off to either side. Inside
 * this half-width only the low kinds are placed; outside it, anything.
 */
const MIDGROUND_OPEN_CENTRE = 3.1;

/**
 * The six kinds, as geometry factories. Every one is a primitive or two merged
 * primitives — the silhouette is the product, and at 153 screen pixels per metre
 * a rounded corner is three pixels.
 *
 * @returns {Record<string, {geo: THREE.BufferGeometry, material: 'paint'|'metal'}>}
 */
function buildMidgroundKinds() {
  const merge = (parts) => {
    // Local, tiny merge: BufferGeometryUtils is not imported by this module and
    // this only ever joins two or three non-indexed primitives.
    const geos = parts.map(({ geo, pos, rot, scale }) => {
      const g = geo.toNonIndexed();
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      if (rot) q.setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2]));
      m.compose(new THREE.Vector3(...(pos ?? [0, 0, 0])), q,
        new THREE.Vector3(...(scale ?? [1, 1, 1])));
      g.applyMatrix4(m);
      return g;
    });
    const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const size = geos[0].attributes[name].itemSize;
      const arr = new Float32Array(total * size);
      let o = 0;
      for (const g of geos) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
      out.setAttribute(name, new THREE.BufferAttribute(arr, size));
    }
    for (const g of geos) g.dispose();
    // `toNonIndexed` allocates a fresh geometry for an indexed input, so the
    // sources are still live and would leak one set per arena switch. Deduped
    // because a part may appear twice in one list (the spool's two flanges).
    for (const g of new Set(parts.map((p) => p.geo))) g.dispose();
    return out;
  };

  const spoolCore = new THREE.CylinderGeometry(0.30, 0.30, 0.52, 12, 1, true);
  const spoolFlange = new THREE.CylinderGeometry(0.62, 0.62, 0.07, 14);

  return {
    // A shipping crate, lying square. Proportions vary per instance.
    crate: { geo: new THREE.BoxGeometry(1.05, 0.86, 0.92), material: 'paint' },
    // A drum, upright. Twelve sides is enough at this distance and its
    // silhouette is a rectangle with two soft corners, which is what reads.
    drum: { geo: new THREE.CylinderGeometry(0.29, 0.29, 0.9, 12), material: 'metal' },
    // A cable spool on its side: the one kind here with a hole in its outline.
    spool: {
      geo: merge([
        { geo: spoolCore, rot: [Math.PI / 2, 0, 0] },
        { geo: spoolFlange, pos: [0, 0, 0.26], rot: [Math.PI / 2, 0, 0] },
        { geo: spoolFlange, pos: [0, 0, -0.26], rot: [Math.PI / 2, 0, 0] },
      ]),
      material: 'metal',
    },
    // A jersey barrier: wide, low, and the only kind that overlaps its
    // neighbours, so a run of them makes one long broken line.
    barrier: {
      geo: merge([
        { geo: new THREE.BoxGeometry(1.6, 0.36, 0.62), pos: [0, 0.18, 0] },
        { geo: new THREE.BoxGeometry(1.6, 0.46, 0.30), pos: [0, 0.59, 0] },
      ]),
      material: 'paint',
    },
    // A service stanchion: base plate, column, and a head.
    //
    // The head is the whole point and the first build did not have it. A bare
    // 2 m pole with a foot reads as nothing — on `skydeck` a run of them came
    // out looking like empty flagpoles, which is worse than leaving the band
    // alone. Both references carry verticals and neither carries a bare one:
    // `tekken8_02`'s lamp post has a lamp on it and its sign poles have signs.
    // A vertical earns its place by what it holds up.
    post: {
      geo: merge([
        { geo: new THREE.CylinderGeometry(0.055, 0.07, 1.72, 6), pos: [0, 0.86, 0] },
        { geo: new THREE.BoxGeometry(0.4, 0.07, 0.4), pos: [0, 0.035, 0] },
        { geo: new THREE.BoxGeometry(0.52, 0.30, 0.13), pos: [0.13, 1.80, 0] },
      ]),
      material: 'metal',
    },
    // The overhead run. Built along +X at unit length and stretched per instance.
    pipe: {
      geo: new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).rotateZ(Math.PI / 2),
      material: 'metal',
    },
  };
}

export class Environment {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {{ mood?: string, quality?: string }} [opts]
   */
  constructor(renderer, scene, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;

    this.quality = opts.quality ?? 'high';
    /**
     * The ablation arms in force for this session, resolved ONCE — see
     * {@link ABLATE}. Nothing in this file writes to it after construction, on
     * purpose: a set that changed mid-session would change `NUM_*_LIGHTS` and
     * recompile every material, which is the failure mode the whole mechanism
     * exists to avoid.
     * @type {Set<string>}
     */
    this.ablate = new Set([...ABLATE, ...(opts.ablate ?? [])]);
    this.mood = opts.mood ?? 'industrial';
    this.ready = false;

    /** Live, fully blended mood parameters. Read-only for everyone else. */
    this.params = cloneParams(MOODS[this.mood] ?? MOODS.industrial);
    this._from = cloneParams(this.params);
    this._to = cloneParams(this.params);
    this._fade = { t: 1, dur: 1 };

    /**
     * The midground clutter band. One group, six `InstancedMesh`, rebuilt
     * whenever the mood (and therefore the arena) changes. See {@link MIDGROUND}
     * for the raycast measurement that motivates it.
     *
     * Held as a public field on purpose: `visible = false` on this one object is
     * the null arm of every A/B it will be judged by, and toggling it recompiles
     * nothing.
     * @type {?THREE.Group}
     */
    this.midground = null;
    /** Triangles the layer adds, for the cost half of the ledger. */
    this.midgroundTris = 0;
    this._midgroundMats = null;

    /** @type {?THREE.Texture} PMREM-filtered radiance, assigned to scene.environment. */
    this.envMap = null;
    /** @type {?THREE.CubeTexture} The darker surround assigned to scene.background. */
    this.backgroundMap = null;

    /** @type {?THREE.DirectionalLight} */
    this.keyLight = null;
    /** @type {?THREE.DirectionalLight} */
    this.rimLight = null;
    /** @type {?THREE.DirectionalLight} */
    this.rimLightB = null;
    /** @type {?THREE.DirectionalLight} */
    this.bounceLight = null;
    /** @type {?THREE.HemisphereLight} */
    this.fillLight = null;
    /**
     * The per-fighter rim rigs, in player order. `root` is the object each rig
     * follows; set it through {@link trackFighters} or leave it to the by-name
     * lookup in {@link update}. `box` is the key softbox that rides with them.
     * `key` is the shadowed per-fighter key spot; see {@link KEY_SPOT}.
     * @type {{index: number, root: ?THREE.Object3D, cool: THREE.SpotLight,
     *         warm: THREE.SpotLight, lights: THREE.SpotLight[],
     *         box: THREE.RectAreaLight, key: THREE.SpotLight, aim: THREE.Vector3}[]}
     */
    this.fighterRims = [];
    /**
     * The rim cue: what the analytic rim rig is doing this frame, in the terms
     * a screen-space pass needs, published on `scene.userData.rimCue` so
     * `RenderPipeline` can read it without either module importing the other.
     *
     * See {@link SCREEN_RIM} for why a screen-space rim exists at all next to
     * four analytic rim lights. The short version is that every analytic rim in
     * this file is multiplied by the robot it lands on — diffuse by albedo,
     * specular by F0, which for a metal *is* the albedo — so a cyan rim on a
     * warm-painted fighter delivers whatever the fighter's blue reflectance
     * happens to be, and on this cast that is nearly nothing. The screen-space
     * pass adds its colour rather than multiplying it, which is the only way a
     * rim gets to be the same colour on every character.
     *
     * `coolDir` / `warmDir` are unit vectors in **world** space pointing from
     * the fighter toward the source, already carrying `_rimYaw`'s correction, so
     * the pipeline only has to rotate them into view space. `level` is the
     * mood's own rim irradiance normalised by {@link SCREEN_RIM}.reference, so a
     * mood that pushes its rim budget gets a brighter edge and a mood that pulls
     * it back gets a dimmer one without anything here being retuned.
     *
     * `center` and `spread` are the depth gate: the world midpoint of the two
     * fighters and half their separation. The pass has no fighter mask — the
     * beauty target has no spare channel and stencil is not portably samplable —
     * so the gate is what keeps the effect off the set. See the note on
     * `RIM_SLAB` in `RenderPipeline`.
     */
    this.rimCue = {
      active: false,
      coolColor: new THREE.Color(1, 1, 1),
      warmColor: new THREE.Color(1, 1, 1),
      coolDir: new THREE.Vector3(0, 0, -1),
      warmDir: new THREE.Vector3(0, 0, -1),
      coolLevel: 0,
      warmLevel: 0,
      center: new THREE.Vector3(0, 1.2, 0),
      spread: 0,
    };
    // Published once. `RenderPipeline` holds no reference to this class and this
    // class holds none to it — the pass reads the object off the scene it is
    // already drawing, and a scene with no `Environment` on it (the roster
    // turntable, the menu preview) simply has no cue and gets the plain blit.
    scene.userData.rimCue = this.rimCue;
    /** Scratch for {@link _publishRimCue}; separate from `_tmpVec` so the two
     * cannot be aliased by a later edit to the rig loop that runs before it. */
    this._cueVec = new THREE.Vector3();
    this._cueVecB = new THREE.Vector3();
    /**
     * Multiplier on the shadowed per-fighter key, and the A/B arm for it.
     *
     * It is a live field rather than a compile-time constant on purpose: the
     * light stays built, visible and shadow-casting at every value including
     * zero, so the compiled program is bit-identical across the sweep and a
     * frozen-frame difference between two values is the light and nothing else.
     * Toggling `visible` instead would change `NUM_SPOT_LIGHT_SHADOWS` and
     * recompile every material in the scene, which is the trap
     * `docs/PROFILING.md` documents for lights.
     *
     * Both arms of an A/B also have to sit in ONE task with no animation frame
     * between them. `KB.paused` with the clock pinned does **not** stop the
     * camera rig or the animator — waiting half a second between arms moved the
     * wide framing and 86% of the frame differed. Set, redraw, read back, all
     * before the page can run another frame.
     *
     * Measured that way, sim paused, frame clock pinned, grain and chroma
     * zeroed, null control 0.0000/255 on both framings:
     *
     *     scale   01-hero-idle                      06-stage-wide
     *             subj/bg  band/bg  top1% (share)   subj/bg  band/bg  top1% (share)
     *      0       2.204    2.786   27.4% (13.7%)    1.693    1.849   1.8%  (1.6%)
     *      1       2.718    3.248   37.5% (13.7%)    2.263    2.367   4.7%  (1.6%)
     *
     * The background term does not move at all across those rows — 0.07850 to
     * 0.07852 on hero and 0.09114 to 0.09114 on wide — which is the check that
     * `SPLIT_LIGHT_LAYER` is doing what it is here for. Every unit of this light
     * is subject.
     *
     * @type {number}
     */
    this.keySpotScale = 1;
    /** @type {THREE.RectAreaLight[]} */
    this.practicals = [];
    /**
     * The two overhead tube runs over the pit. Stage-fixed, driven by the
     * mood's `ceiling` block.
     * @type {THREE.RectAreaLight[]}
     */
    this.strips = [];
    /** @type {?THREE.Group} Visible emissive cards for the practicals. */
    this.practicalMeshes = null;
    /** @type {?THREE.FogExp2} Installed on the scene by {@link init}. */
    this.fog = null;
    /**
     * Camera the rim rigs orient against. Acquired from the first scene render
     * unless {@link setCamera} overrides it.
     * @type {?THREE.Camera}
     */
    this.camera = null;

    /**
     * Breathing 0..~1.3 multiplier the Stage/FX can hang volumetric shafts on.
     * Driven by `update()`; the environment does not draw shafts itself.
     */
    this.shaftIntensity = 0;
    /** Suggested renderer exposure for the current mood. RenderPipeline may read it. */
    this.exposureHint = 1;

    this._time = 0;
    this._envDirty = true;
    this._regenCooldown = 0;
    this._acquireCooldown = 0;
    this._ownerDriven = 0;
    this._inFrame = false;
    this._cameraPinned = false;
    this._prevSceneBeforeRender = null;
    this._pulse = { color: new THREE.Color(1, 1, 1), strength: 0, t: 0, dur: 1 };

    this._pmrem = null;
    this._pmremTarget = null;
    this._envCube = null;
    this._bgCube = null;
    this._envCamera = null;
    this._bgCamera = null;
    this._envScene = null;
    this._skyMesh = null;
    this._skyMaterial = null;
    this._envQuads = [];
    this._quadMaterials = [];
    this._quadGeometry = null;
    this._rig = null;

    this._tmpColor = new THREE.Color();
    this._tmpColorB = new THREE.Color();
    this._tmpVec = new THREE.Vector3();
    this._tmpVecB = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
  }

  /**
   * Builds the environment scene, bakes both cubes, filters the lighting cube
   * through PMREM, and installs the light rig, fog and background.
   * @returns {Promise<void>}
   */
  async init() {
    RectAreaLightUniformsLib.init();

    this._buildEnvScene();
    this._buildRig();
    // `Stage.setArena` only calls `setMood` when the mood actually changes, so
    // the default arena would never trigger a build. Do it here as well, and let
    // `setMood` handle every later switch.
    this._buildMidground();

    const tier = TIERS[this.quality] ?? TIERS.high;
    this._allocateTargets(tier);

    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    this._pmrem.compileCubemapShader();

    // Let the caller's loading screen paint before the first (blocking) bake.
    await Promise.resolve();

    this._applyParams();
    this._bake();

    this._watchCamera();
    this.scene.fog = this.fog;
    this.ready = true;
  }

  /**
   * Learn the eye the rim rigs orient against, without requiring the owner to
   * hand it over. `Scene.onBeforeRender` is called with the camera the scene is
   * about to be drawn from, which is exactly the question being asked; any
   * existing hook is chained rather than replaced.
   *
   * The planar-floor mirror draws the scene a second time from a camera below
   * the floor, so anything at or under the plane is ignored — a rim rig aimed
   * from the reflection's point of view would swing every frame.
   */
  _watchCamera() {
    this._prevSceneBeforeRender = this.scene.onBeforeRender;
    this.scene.onBeforeRender = (renderer, scene, camera, ...rest) => {
      this._prevSceneBeforeRender?.call(scene, renderer, scene, camera, ...rest);
      if (this._cameraPinned || !camera?.isPerspectiveCamera) return;
      this._camPos.setFromMatrixPosition(camera.matrixWorld);
      if (this._camPos.y > 0.05) this.camera = camera;
    };
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  _buildEnvScene() {
    this._envScene = new THREE.Scene();

    const uniforms = {
      uBackground: { value: 0 },
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGroundCol: { value: new THREE.Color() },
      uSkyIntensity: { value: 1 },
      uZenithPower: { value: 0.6 },
      uGroundFalloff: { value: 0.22 },
      uHazeColor: { value: new THREE.Color() },
      uHazeStrength: { value: 0 },
      uHazeHeight: { value: 0.15 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSunIntensity: { value: 0 },
      uSunRadius: { value: 0.05 },
      uGlowIntensity: { value: 0 },
      uGlowPower: { value: 12 },
      uCeilOn: { value: 0 },
      uCeilHeight: { value: 12 },
      uCeilSpacing: { value: 7 },
      uCeilSize: { value: new THREE.Vector2(0.3, 0.1) },
      uCeilFalloff: { value: 0.002 },
      uCeilColor: { value: new THREE.Color() },
      uCeilIntensity: { value: 0 },
      uBandColor: { value: new THREE.Color() },
      uBandIntensity: { value: 0 },
      uBandY: { value: 0 },
      uBandWidth: { value: 0.06 },
      uBandCount: { value: 12 },
      uScreenColor: { value: new THREE.Color() },
      uScreenIntensity: { value: 0 },
      uScreenCount: { value: 10 },
      uScreenY: { value: 0.18 },
      uScreenH: { value: 0.07 },
      uPillarCount: { value: 12 },
      uPillarWidth: { value: 0.03 },
      uPillarDark: { value: 0.15 },
      uFloorRefl: { value: 0.3 },
      uSeed: { value: 0.37 },
      uTime: { value: 0 },
      uBgSky: { value: 0.4 },
      uBgLights: { value: 0.6 },
      uBgKnee: { value: 0.5 },
    };

    this._skyMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      fog: false,
    });

    this._skyMesh = new THREE.Mesh(new THREE.BoxGeometry(400, 400, 400), this._skyMaterial);
    this._skyMesh.position.copy(PROBE);
    this._skyMesh.frustumCulled = false;
    this._skyMesh.renderOrder = -1000;
    this._envScene.add(this._skyMesh);

    // Emissive cards for the practicals: one copy inside the env scene (so the
    // cube map contains a real, parallax-correct highlight) and one in the main
    // scene (so the audience can see where the light is coming from).
    this._quadGeometry = new THREE.PlaneGeometry(1, 1);
    this.practicalMeshes = new THREE.Group();
    this.practicalMeshes.name = 'practicals';
    // Off by default: the Stage owns everything the camera can see, and bare
    // emissive rectangles floating in its set would read as a bug. Stages that
    // do not build their own fixtures call showPracticalMeshes(true).
    this.practicalMeshes.visible = false;

    for (let i = 0; i < PRACTICAL_COUNT; i++) {
      // Shared between the env-scene copy and the visible copy. Inside a render
      // target three never tone maps, so the cube gets the raw HDR radiance
      // while the on-screen card goes through the ACES/AgX curve like
      // everything else.
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1, 1, 1),
        side: THREE.DoubleSide,
        fog: false,
      });
      this._quadMaterials.push(mat);

      const envQuad = new THREE.Mesh(this._quadGeometry, mat);
      envQuad.frustumCulled = false;
      envQuad.layers.set(ENV_QUAD_LAYER);
      this._envScene.add(envQuad);
      this._envQuads.push(envQuad);

      const sceneQuad = new THREE.Mesh(this._quadGeometry, mat);
      sceneQuad.frustumCulled = false;
      sceneQuad.castShadow = false;
      sceneQuad.receiveShadow = false;
      sceneQuad.layers.enable(LAYER.BLOOM_ONLY);
      this.practicalMeshes.add(sceneQuad);
    }

    this.scene.add(this.practicalMeshes);
  }

  _buildRig() {
    const tier = TIERS[this.quality] ?? TIERS.high;
    this._rig = new THREE.Group();
    this._rig.name = 'lightRig';

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1);
    this.keyLight.visible = !this.ablate.has('key');
    this.keyLight.castShadow = !this.ablate.has('key') && !this.ablate.has('keyShadow');
    this.keyLight.shadow.mapSize.set(tier.shadow, tier.shadow);
    this.keyLight.shadow.bias = -0.00035;
    this.keyLight.shadow.normalBias = 0.022;
    this.keyLight.shadow.radius = 2.2;
    const sc = this.keyLight.shadow.camera;
    sc.left = -(ARENA_HALF_WIDTH + 3.5);
    sc.right = ARENA_HALF_WIDTH + 3.5;
    sc.top = ARENA_HALF_DEPTH + 8.5;
    sc.bottom = -(ARENA_HALF_DEPTH + 3.5);
    sc.near = 0.5;
    sc.far = 70;
    sc.updateProjectionMatrix();
    this.keyLight.target.position.set(0, 0.9, 0);
    this._rig.add(this.keyLight, this.keyLight.target);

    // The money light. Behind and above, saturated, deliberately opposite the
    // key in temperature so the silhouette separates from the backdrop.
    //
    // Both rims live on `SPLIT_LIGHT_LAYER`, so they reach the fighters and
    // nothing else — see `DIRECTIONAL_RIM_SHARE`. A rim that also lands on the
    // wall behind the fighter raises the background by the same amount it
    // raises the edge and buys no separation at all; restricting the layer is
    // what makes the share worth carrying, and it takes two directional lights
    // off the 85% of the frame that is arena at the same time. The target has
    // to move with it: three culls a light by testing `light.layers` against
    // the camera, and a target left on layer 0 would be evaluated in a pass
    // that cannot see its light.
    this.rimLight = new THREE.DirectionalLight(0xffffff, 1);
    this.rimLight.visible = !this.ablate.has('rims') && !this.ablate.has('allSplit');
    this.rimLight.castShadow = false;
    this.rimLight.layers.set(SPLIT_LIGHT_LAYER);
    this.rimLight.target.layers.set(SPLIT_LIGHT_LAYER);
    this.rimLight.target.position.set(0, 1.05, 0);
    this._rig.add(this.rimLight, this.rimLight.target);

    // Weaker complementary rim on the opposite flank so both fighters get an
    // edge regardless of which way the camera has swung.
    this.rimLightB = new THREE.DirectionalLight(0xffffff, 1);
    this.rimLightB.visible = !this.ablate.has('rims') && !this.ablate.has('allSplit');
    this.rimLightB.castShadow = false;
    this.rimLightB.layers.set(SPLIT_LIGHT_LAYER);
    this.rimLightB.target.layers.set(SPLIT_LIGHT_LAYER);
    this.rimLightB.target.position.set(0, 1.05, 0);
    this._rig.add(this.rimLightB, this.rimLightB.target);

    this._buildFighterRims(tier);
    this._buildStrips(tier);

    // Ground bounce: low, from below the horizon, kills the dead black on the
    // undersides of thighs and forearms without flattening anything.
    //
    // **It is on `SPLIT_LIGHT_LAYER` from this round, and it was scene-wide
    // before.** Its own comment says what it is for — undersides of thighs and
    // forearms — and its own authored geometry says it cannot do anything else:
    // every one of the seven moods places it at a NEGATIVE elevation (-20° to
    // -30°, see the `bounce:` rows in `MOODS`), so `dot(N, L)` is zero for every
    // up-facing surface in the game, in every mood, by construction. The deck is
    // the largest up-facing surface in the frame and this light has never
    // deposited a single photon on it.
    //
    // Re-derived rather than argued, offline against the real rig
    // (`scratchpad/lightirr.mjs` — three r185's own `getDistanceAttenuation`,
    // `getSpotAttenuation`, hemisphere mix and the exact LTC diffuse form factor
    // ported to JS; null re-evaluates to 1e-12 and a zeroed light reads exactly
    // 0, positive doubles an intensity and the term doubles). Share of the ARENA
    // half's analytic diffuse irradiance BEFORE this change, MEAN over 1024
    // Fibonacci normals at nine arena points, split by how the surface faces
    // (rule 6: a mean over directions, not a median and not a peak):
    //
    //     facing   keyLight   practical0   bounceLight   fillLight
    //     up         95.02%       4.49%        0.15%        0.34%
    //     side       93.07%       5.83%        0.71%        0.39%
    //     down       85.78%       9.36%        4.03%        0.82%
    //
    // Re-running the same instrument after the change is the positive control on
    // the change itself: `bounceLight` disappears from the arena column in all
    // seven moods and nothing else moves.
    //
    // Its best case anywhere on the set is 4.03% of the analytic budget on
    // down-facing surfaces, and this file has already measured the deck as 56.6%
    // env IBL — so against everything actually arriving it is under 2% in the
    // one place it does anything at all. Against that it was 11.5% of the arena
    // half's per-fragment analytic-light work, second only to the practical and
    // the three zero-intensity points. That is the trade: a term worth under 2%
    // of the light on the least-visible surfaces in the set, priced at an eighth
    // of the light shader over 85% of the frame.
    //
    // On the fighters it keeps everything it had. The frame cost is UNMEASURED —
    // `?kbAblate=bounce` is the arm, and the honest expectation is that it is
    // small, because the whole analytic-light term is only part of the fill.
    this.bounceLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.bounceLight.visible = !this.ablate.has('bounce') && !this.ablate.has('allSplit');
    this.bounceLight.castShadow = false;
    this.bounceLight.layers.set(SPLIT_LIGHT_LAYER);
    this.bounceLight.target.layers.set(SPLIT_LIGHT_LAYER);
    this.bounceLight.target.position.set(0, 0.7, 0);
    this._rig.add(this.bounceLight, this.bounceLight.target);

    // The hemisphere fill STAYS scene-wide, and this is a negative result worth
    // recording because the round brief expected the opposite.
    //
    // It is the cheapest analytic term three has: 4 ALU, no texture fetch, no
    // BRDF evaluation at all — `getHemisphereLightIrradiance` is a dot and a mix
    // added straight into `irradiance`. Counted, it is **0.5%** of the arena
    // half's per-fragment light work, against the shadowed key's 16.3% and the
    // practical's 32.7%. Removing it cannot buy a frame.
    //
    // And it is the only analytic light left on an up-facing surface inside the
    // key's shadow, because the key is shadowed and the bounce (above) is zero
    // on up-facing surfaces in every mood. Deleting it would put every shadowed
    // patch of deck on the IBL alone. And its size is mood-dependent in a way a
    // single-mood measurement hides: the same instrument puts it at 0.14% of the
    // arena's analytic irradiance on `neonCity` and **9.64%** on `duskRoof`,
    // which authors the largest hemisphere fill in the table on purpose.
    // Cheapest light in the frame, doing the one job nothing else can do, and on
    // one mood it is doing a tenth of the set's analytic lighting: it stays.
    this.fillLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.7);
    this.fillLight.visible = !this.ablate.has('hemi');
    this._rig.add(this.fillLight);

    // There is deliberately no arena-only fill light here, and the reason is a
    // measurement rather than an omission.
    //
    // `RenderPipeline`'s split beauty pass stops the per-fighter rig reaching
    // the set, and on the hero framing that costs the deck 0.67x of its mean
    // value while the crowd holds 0.98x and the barrier 0.96x. An arena-only
    // `HemisphereLight` on `ARENA_LIGHT_LAYER` looked like the obvious repair —
    // nearly free, and weighted toward up-facing surfaces, which is where the
    // loss is. Swept from 0 to 100x the mood's own fill it moved the deck from
    // 0.67x to only **0.85x**, and by then it had pushed the crowd to 1.09x and
    // the barrier to 1.13x. It was removed rather than tuned.
    //
    // The reason it fails is the reason the deck lost the light in the first
    // place: what the two `RectAreaLight` key boxes were doing to a polished
    // metal plate was *reflecting* in it. That is a specular term, and a
    // hemisphere has no specular lobe. The repair that works is
    // `RenderPipeline.arenaEnvBoost`, which raises image-based lighting for the
    // arena half only — same cue, no light, no cost.

    for (let i = 0; i < PRACTICAL_COUNT; i++) {
      const p = this.params.practicals[i];
      const light = new THREE.RectAreaLight(0xffffff, 1, p.size.x, p.size.y);
      light.name = `stagePractical${i}`;
      light.visible = i < tier.practicals && !this.ablate.has('practicals');
      this.practicals.push(light);
      this._rig.add(light);
    }

    this.fog = new THREE.FogExp2(0x101820, 0.018);
    this.scene.add(this._rig);
  }

  /**
   * Two spots per fighter: one on the mood's cool rim azimuth, one on its warm
   * counter-azimuth, both three-quarters behind and above. They live in the rig
   * group rather than under the fighter so their targets stay in world space —
   * a spot parented to a rotating root would swing its cone with the character.
   */
  _buildFighterRims(tier) {
    for (let i = 0; i < FIGHTER_RIG_COUNT; i++) {
      const lights = [];
      for (let k = 0; k < 2; k++) {
        const l = new THREE.SpotLight(0xffffff, 0, RIM.range, RIM.angle, RIM.penumbra, RIM.decay);
        l.name = `fighterRim${i}${k === 0 ? 'A' : 'B'}`;
        l.castShadow = false;
        // Exclusively on the split layer: this light exists to shape one robot,
        // and evaluating it over the 85% of the frame that is arena costs 1.26ms
        // at 1080p for nothing anyone looks at. `RenderPipeline` draws the
        // fighters in a second half of the beauty pass that can see this layer;
        // the arena half cannot. See `SPLIT_GEOMETRY_LAYER` there for the
        // measurements and for what the arena gives up (the spill, and only the
        // spill).
        l.layers.set(SPLIT_LIGHT_LAYER);
        l.visible = k < tier.rims
          && !this.ablate.has('fighterRims') && !this.ablate.has('allSplit');
        l.target.position.set(0, RIM.aimHeight, 0);
        this._rig.add(l, l.target);
        lights.push(l);
      }

      const box = new THREE.RectAreaLight(0xffffff, 0, KEY_BOX.width, KEY_BOX.height);
      box.name = `fighterKeyBox${i}`;
      box.layers.set(SPLIT_LIGHT_LAYER);
      box.visible = tier.boxes > 0
        && !this.ablate.has('fighterBoxes') && !this.ablate.has('allSplit');
      this._rig.add(box);

      // The shadowed key. Same layer discipline as everything else on this rig:
      // it shapes one robot and must never be evaluated over the arena, both
      // because that is 85% of the frame and because the whole reason this light
      // moves the figure/ground ratio is that none of it reaches the ground.
      const key = new THREE.SpotLight(
        0xffffff, 0, KEY_SPOT.range, KEY_SPOT.angle, KEY_SPOT.penumbra, KEY_SPOT.decay,
      );
      key.name = `fighterKeySpot${i}`;
      key.layers.set(SPLIT_LIGHT_LAYER);
      key.target.layers.set(SPLIT_LIGHT_LAYER);
      key.target.position.set(0, KEY_SPOT.aimHeight, 0);
      key.visible = i < (tier.keySpots ?? 0)
        && !this.ablate.has('fighterKeys') && !this.ablate.has('allSplit');
      key.castShadow = key.visible && i < (tier.keyShadows ?? 0)
        && !this.ablate.has('fighterKeyShadows');
      this._configureKeyShadow(key, tier);
      this._rig.add(key, key.target);

      this.fighterRims.push({
        index: i,
        root: null,
        cool: lights[0],
        warm: lights[1],
        lights,
        box,
        key,
        aim: new THREE.Vector3(0, RIM.aimHeight, 0),
      });
    }
  }

  /**
   * Shadow settings for one per-fighter key spot, at the given tier.
   *
   * Split out so {@link setQuality} can re-seat the map size without rebuilding
   * the rig, which is the same reason `keyLight`'s size lives in `setQuality`.
   *
   * @param {THREE.SpotLight} key
   * @param {{keyShadow: number}} tier
   */
  _configureKeyShadow(key, tier) {
    const size = tier.keyShadow ?? 1024;
    key.shadow.mapSize.set(size, size);
    key.shadow.bias = KEY_SPOT.bias;
    key.shadow.normalBias = KEY_SPOT.normalBias;
    key.shadow.radius = KEY_SPOT.softness;
    key.shadow.camera.near = KEY_SPOT.near;
    key.shadow.camera.far = KEY_SPOT.far;
    key.shadow.camera.updateProjectionMatrix();
  }

  /**
   * The two overhead tube runs. Fixed in the set — they are architecture, not a
   * character rig — and aimed a little inboard of straight down so the long axis
   * of the reflection runs across the fighters rather than past them.
   */
  _buildStrips(tier) {
    for (let i = 0; i < STRIP.z.length; i++) {
      const l = new THREE.RectAreaLight(0xffffff, 0, STRIP.length, STRIP.width);
      l.name = `ceilingStrip${i}`;
      // `tier.strips` is 0 at every tier, so this pair is built, driven every
      // frame by `_updateStrips` and never uploaded — three drops an invisible
      // light in `projectObject` before `WebGLLights` sees it, so they are not
      // in `NUM_RECT_AREA_LIGHTS` and cost nothing per fragment. They are kept
      // built because a tier that raises `strips` should not need a rebuild.
      l.visible = i < tier.strips && !this.ablate.has('strips');
      l.position.set(0, STRIP.y, STRIP.z[i]);
      l.lookAt(0, STRIP.aim, STRIP.z[i] * STRIP.aimCross);
      this.strips.push(l);
      this._rig.add(l);
    }
  }

  _allocateTargets(tier) {
    this._disposeTargets();

    // The PMREM target is sized from the input cube, so a tier change has to
    // drop it rather than reuse it.
    this._pmremTarget?.dispose();
    this._pmremTarget = null;

    const cubeOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    };

    this._envCube = new THREE.WebGLCubeRenderTarget(tier.cube, cubeOpts);
    this._envCamera = new THREE.CubeCamera(0.2, 600, this._envCube);
    this._envCamera.position.copy(PROBE);
    this._envCamera.layers.enable(ENV_QUAD_LAYER);
    this._envCamera.updateMatrixWorld();

    this._bgCube = new THREE.WebGLCubeRenderTarget(tier.bg, {
      ...cubeOpts,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    this._bgCamera = new THREE.CubeCamera(0.2, 600, this._bgCube);
    this._bgCamera.position.copy(PROBE);
    this._bgCamera.updateMatrixWorld();

    this.backgroundMap = this._bgCube.texture;
  }

  _disposeTargets() {
    this._envCube?.dispose();
    this._bgCube?.dispose();
    this._envCube = null;
    this._bgCube = null;
    this._envCamera = null;
    this._bgCamera = null;
  }

  // -------------------------------------------------------------------------
  // Baking
  // -------------------------------------------------------------------------

  /** Push the current blended params into the sky shader and the env quads. */
  _pushShaderUniforms() {
    const p = this.params;
    const u = this._skyMaterial.uniforms;

    u.uZenith.value.copy(p.sky.zenith);
    u.uHorizon.value.copy(p.sky.horizon);
    u.uGroundCol.value.copy(p.sky.ground);
    u.uSkyIntensity.value = p.sky.intensity;
    u.uZenithPower.value = Math.max(0.05, p.sky.zenithPower);
    u.uGroundFalloff.value = Math.max(0.02, p.sky.groundFalloff);
    u.uHazeColor.value.copy(p.sky.hazeColor);
    u.uHazeStrength.value = p.sky.hazeStrength;
    u.uHazeHeight.value = Math.max(0.01, p.sky.hazeHeight);

    u.uSunDir.value.copy(p.sun.dir);
    u.uSunColor.value.copy(p.sun.color);
    u.uSunIntensity.value = p.sun.intensity;
    u.uSunRadius.value = Math.max(0.004, p.sun.radius);
    u.uGlowIntensity.value = p.sun.glowIntensity;
    u.uGlowPower.value = p.sun.glowPower;

    u.uCeilOn.value = p.ceiling.on;
    u.uCeilHeight.value = p.ceiling.height;
    u.uCeilSpacing.value = Math.max(0.5, p.ceiling.spacing);
    u.uCeilSize.value.set(p.ceiling.sizeX, p.ceiling.sizeY);
    u.uCeilFalloff.value = p.ceiling.falloff;
    u.uCeilColor.value.copy(p.ceiling.color);
    u.uCeilIntensity.value = p.ceiling.intensity;

    u.uBandColor.value.copy(p.bands.color);
    u.uBandIntensity.value = p.bands.intensity;
    u.uBandY.value = p.bands.y;
    u.uBandWidth.value = Math.max(0.005, p.bands.width);
    u.uBandCount.value = p.bands.count;

    u.uScreenColor.value.copy(p.screens.color);
    u.uScreenIntensity.value = p.screens.intensity;
    u.uScreenCount.value = p.screens.count;
    u.uScreenY.value = p.screens.y;
    u.uScreenH.value = Math.max(0.005, p.screens.height);

    u.uPillarCount.value = p.structure.count;
    u.uPillarWidth.value = p.structure.width;
    u.uPillarDark.value = p.structure.dark;

    u.uFloorRefl.value = p.floorRefl;
    u.uBgSky.value = p.bgSky;
    u.uBgLights.value = p.bgLights;
    u.uBgKnee.value = p.bgKnee;
    u.uTime.value = this._time;

    for (let i = 0; i < PRACTICAL_COUNT; i++) {
      const pr = p.practicals[i];
      const quad = this._envQuads[i];
      quad.position.copy(pr.pos);
      quad.lookAt(pr.target);
      quad.scale.set(pr.size.x, pr.size.y, 1);

      const mesh = this.practicalMeshes.children[i];
      mesh.position.copy(pr.pos);
      mesh.lookAt(pr.target);
      mesh.scale.set(pr.size.x, pr.size.y, 1);
    }
  }

  /** Re-render both cubes and re-filter the lighting cube. */
  _bake() {
    if (!this._envCamera || !this._pmrem) return;

    this._pushShaderUniforms();

    const u = this._skyMaterial.uniforms;

    u.uBackground.value = 0;
    this._envCamera.update(this.renderer, this._envScene);

    u.uBackground.value = 1;
    this._bgCamera.update(this.renderer, this._envScene);
    u.uBackground.value = 0;

    // Reuse the PMREM target after the first bake so re-generation during a
    // mood cross-fade does not churn GPU memory.
    this._pmremTarget = this._pmrem.fromCubemap(this._envCube.texture, this._pmremTarget);
    this.envMap = this._pmremTarget.texture;

    this.scene.environment = this.envMap;
    this.scene.background = this.backgroundMap;
    this._envDirty = false;
  }

  // -------------------------------------------------------------------------
  // Mood
  // -------------------------------------------------------------------------

  /**
   * Cross-fade to a named mood. Colours, intensities, fog and the environment
   * map all interpolate; the cube is re-baked from the blended parameters at a
   * throttled rate during the transition and once more when it lands.
   *
   * @param {string} name one of {@link MOOD_NAMES}
   * @param {number} [t=1.2] fade duration in seconds; 0 snaps
   */
  /**
   * Builds (or rebuilds) the midground clutter for the current mood.
   *
   * Placement is a seeded {@link Rng}-free deterministic hash rather than
   * `Math.random`, because every measurement this layer will ever be judged by
   * is a frozen-frame A/B and a set that reshuffles per boot cannot be
   * A/B'd at all. Same mood in, same scene out, every time.
   *
   * The whole layer hangs off one group so the A/B arm is `visible = false` on
   * a single object: no material is rebuilt, no program is recompiled, and the
   * two arms therefore differ by exactly this geometry and nothing else.
   *
   * @see MIDGROUND
   */
  _buildMidground() {
    this._disposeMidground();
    const cfg = MIDGROUND[this.mood];
    if (!cfg || this.ablate.has('midground')) return;

    const group = new THREE.Group();
    group.name = 'env.midground';
    // The set dressing is lit by the same rig as everything else, but it must
    // not join the split-lighting layer the fighters use.
    group.layers.set(LAYER.DEFAULT);

    // Deterministic, cheap, and independent per stream so adding a kind cannot
    // reshuffle the kinds authored before it.
    const rand = (i, salt) => {
      let h = Math.imul(i + 1, 374761393) ^ Math.imul(salt, 668265263) ^ Math.imul(cfg.seed, 1442695041);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };

    const shared = this._midgroundMaps();
    const kinds = buildMidgroundKinds();
    const counts = {
      crate: cfg.crates, drum: cfg.drums, spool: cfg.spools,
      barrier: cfg.barriers, post: cfg.posts, pipe: cfg.overhead.count,
    };

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    let tris = 0;

    let slot = 0;
    for (const [name, kind] of Object.entries(kinds)) {
      const n = counts[name] | 0;
      if (n <= 0) { kind.geo.dispose(); continue; }
      const mat = kind.material === 'paint' ? shared.paint : shared.metal;
      const mesh = new THREE.InstancedMesh(kind.geo, mat, n);
      mesh.name = 'env.midground.' + name;
      mesh.castShadow = false;      // measured; see the note on MIDGROUND cost
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      for (let i = 0; i < n; i++) {
        const s = slot * 97 + i;
        if (name === 'pipe') {
          // One long run across the frame, at a depth the ground cannot reach.
          const t = n === 1 ? 0.5 : i / (n - 1);
          const z = cfg.overhead.z0 + (cfg.overhead.z1 - cfg.overhead.z0) * t;
          const len = cfg.halfWidth * 2 + 3.0;
          pos.set((rand(s, 11) - 0.5) * 1.2, cfg.overhead.y + cfg.lift + (rand(s, 12) - 0.5) * 0.5, z);
          q.setFromEuler(new THREE.Euler(0, (rand(s, 13) - 0.5) * 0.06, (rand(s, 14) - 0.5) * 0.035));
          const r = cfg.overhead.radius * (0.7 + rand(s, 15) * 0.7);
          scl.set(len, r, r);
        } else {
          // Ground clutter. x is jittered off an even spread so the run reads as
          // placed rather than as a grid, and z is free across the whole band so
          // the objects occlude EACH OTHER — which is the point, since an
          // occlusion boundary between two props is worth more than one against
          // the wall.
          const t = (i + 0.5) / n;
          let x = (t * 2 - 1) * cfg.halfWidth + (rand(s, 1) - 0.5) * (cfg.halfWidth / n) * 2.4;
          // The tall kinds are pushed out of the open centre rather than
          // dropped, so the run keeps its count and loses only its height where
          // the fighters and the barrier signage are. See MIDGROUND_OPEN_CENTRE.
          const tall = name === 'post' || name === 'spool';
          if (tall && Math.abs(x) < MIDGROUND_OPEN_CENTRE) {
            x = Math.sign(x || 1) * (MIDGROUND_OPEN_CENTRE + rand(s, 9) * (cfg.halfWidth - MIDGROUND_OPEN_CENTRE));
          }
          const z = cfg.z0 + (cfg.z1 - cfg.z0) * rand(s, 2);
          const yaw = rand(s, 3) * Math.PI * 2;
          const sx = 0.74 + rand(s, 4) * 0.72;
          const sy = 0.7 + rand(s, 5) * 0.8;
          const sz = 0.74 + rand(s, 6) * 0.72;
          // Crates stack, but only out at the edges: a stack is 1.7 m and that
          // is head height on the barrier line.
          const stack = name === 'crate' && Math.abs(x) > MIDGROUND_OPEN_CENTRE && rand(s, 7) > 0.55
            ? 0.86 * sy : 0;
          pos.set(x, cfg.lift + stack, z);
          q.setFromEuler(new THREE.Euler(0, yaw, 0));
          scl.set(sx, sy, sz);
        }
        m.compose(pos, q, scl);
        mesh.setMatrixAt(i, m);
        // Per-instance tint. The spread is wide (0.55 to 1.65) and carries a
        // little hue drift as well as value, because the first build gave every
        // instance nearly the same light grey and a row of identical grey boxes
        // reads as blockout geometry rather than as a place. The base colours
        // are also dark on purpose: this band sits BEHIND the fighters and a
        // midground brighter than its subject stops being depth and becomes
        // competition.
        const v = 0.55 + rand(s, 8) * 1.1;
        col.setHex(kind.material === 'paint' ? cfg.paint : cfg.metal).multiplyScalar(v);
        col.offsetHSL((rand(s, 10) - 0.5) * 0.06, (rand(s, 16) - 0.5) * 0.12, 0);
        mesh.setColorAt(i, col);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      const g = mesh.geometry;
      tris += (g.index ? g.index.count / 3 : g.attributes.position.count / 3) * n;
      group.add(mesh);
      slot++;
    }

    this.scene.add(group);
    this.midground = group;
    this.midgroundTris = Math.round(tris);
  }

  /**
   * The two materials the layer uses, built once and reused across mood
   * rebuilds. Textures are clones of the roster's shared detail set: a clone
   * shares the GPU upload, so this costs no texture memory, and it is the only
   * safe way to pick a repeat — writing `.repeat` on the shared texture itself
   * would retile every robot in the scene.
   */
  _midgroundMaps() {
    if (this._midgroundMats) return this._midgroundMats;
    let shared = null;
    try {
      shared = getSharedDetailTextures(this.renderer);
    } catch {
      shared = null;   // headless or a stubbed renderer: fall through to plain
    }
    const clone = (tex, repeat) => {
      if (!tex) return null;
      const t = tex.clone();
      t.needsUpdate = true;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      return t;
    };
    const paint = new THREE.MeshStandardMaterial({
      name: 'env.midground.paint',
      color: 0xffffff, roughness: 0.78, metalness: 0.15,
      normalMap: clone(shared?.plateNormal, 1.6),
      roughnessMap: clone(shared?.plateOrmPainted, 1.6),
    });
    const metal = new THREE.MeshStandardMaterial({
      name: 'env.midground.metal',
      color: 0xffffff, roughness: 0.55, metalness: 0.85,
      normalMap: clone(shared?.metalNormal, 2.2),
      roughnessMap: clone(shared?.metalOrm, 2.2),
    });
    this._midgroundMats = { paint, metal };
    return this._midgroundMats;
  }

  /** Removes the group and frees the per-kind geometry; materials persist. */
  _disposeMidground() {
    if (!this.midground) return;
    this.scene.remove(this.midground);
    this.midground.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    this.midground = null;
    this.midgroundTris = 0;
  }

  setMood(name, t = 1.2) {
    const target = MOODS[name];
    if (!target) return;
    const changed = this.mood !== name;
    this.mood = name;
    // The arena and the mood change together (see `Stage.setArena`), so this is
    // where the clutter learns which set it is standing in.
    if (changed || !this.midground) this._buildMidground();

    if (t <= 0 || !this._rig) {
      this._from = cloneParams(target);
      this._to = cloneParams(target);
      this.params = cloneParams(target);
      this._fade.t = 1;
      this._fade.dur = 1;
      if (this._rig) this._applyParams();
      if (this.ready) this._bake();
      return;
    }

    this._from = cloneParams(this.params);
    this._to = cloneParams(target);
    this._fade.t = 0;
    this._fade.dur = t;
    this._regenCooldown = 0;
  }

  /** @returns {string[]} the available mood names */
  moodNames() {
    return MOOD_NAMES.slice();
  }

  /**
   * Flash the environment — supers, KOs, a wall breaking. Additive on top of the
   * rim rig and the ambient intensity, decaying quadratically.
   *
   * @param {number|THREE.Color} color
   * @param {number} strength 0..1 typical, may exceed
   * @param {number} [seconds=0.45]
   */
  pulse(color, strength = 1, seconds = 0.45) {
    this._pulse.color.set(color);
    this._pulse.strength = strength;
    this._pulse.dur = Math.max(0.05, seconds);
    this._pulse.t = 0;
  }

  /**
   * Swap quality tier: cube resolution, shadow map size and how many
   * RectAreaLights stay live. Re-bakes.
   * @param {'ultra'|'high'|'medium'|'low'} q
   */
  setQuality(q) {
    const tier = TIERS[q];
    if (!tier || q === this.quality) return;
    this.quality = q;

    if (this.keyLight) {
      this.keyLight.shadow.mapSize.set(tier.shadow, tier.shadow);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    // Every visibility decision below is ANDed with the ablation set rather than
    // written over it. An arm that switched itself back on at the first tier
    // change would recompile every material in the middle of a measurement and
    // then quietly measure the wrong configuration — see {@link ABLATE}.
    const on = (arm) => !this.ablate.has(arm) && !this.ablate.has('allSplit');
    for (let i = 0; i < this.practicals.length; i++) {
      this.practicals[i].visible = i < tier.practicals && !this.ablate.has('practicals');
    }
    for (const rig of this.fighterRims) {
      for (let k = 0; k < rig.lights.length; k++) {
        rig.lights[k].visible = k < tier.rims && on('fighterRims');
      }
      rig.box.visible = tier.boxes > 0 && on('fighterBoxes');
      rig.key.visible = rig.index < (tier.keySpots ?? 0) && on('fighterKeys');
      // The light and its shadow are separate tier decisions — see TIERS. A
      // spot the tier has switched off must lose `castShadow` too, or it would
      // still declare its `spotShadowMap` slot on every fighter material: the
      // whole cost of this light with none of it on screen.
      rig.key.castShadow = rig.key.visible && rig.index < (tier.keyShadows ?? 0)
        && !this.ablate.has('fighterKeyShadows');
      rig.key.shadow.map?.dispose();
      rig.key.shadow.map = null;
      this._configureKeyShadow(rig.key, tier);
    }
    for (let i = 0; i < this.strips.length; i++) {
      this.strips[i].visible = i < tier.strips && !this.ablate.has('strips');
    }
    if (this.ready) {
      this._allocateTargets(tier);
      this._bake();
    }
  }

  /** Show or hide the visible emissive cards for the practicals. */
  showPracticalMeshes(visible) {
    if (this.practicalMeshes) this.practicalMeshes.visible = visible;
  }

  /**
   * Bind the per-fighter rim rigs to the objects they follow. Pass the root a
   * fighter's visible group hangs off, in player order; the rig reads its world
   * position every frame, so interpolated render positions are picked up for
   * free. Roots left unset are looked up by name (`fighter0`, `fighter1`) until
   * they appear.
   *
   * @param {Array<?THREE.Object3D>} roots one root per fighter
   */
  trackFighters(roots) {
    for (let i = 0; i < this.fighterRims.length; i++) {
      this.fighterRims[i].root = roots?.[i] ?? null;
    }
  }

  /**
   * Pin the camera the rim rigs orient against, and stop sniffing it off the
   * scene render. Pass null to hand the job back to the sniffer.
   * @param {?THREE.Camera} camera
   */
  setCamera(camera) {
    this.camera = camera ?? null;
    this._cameraPinned = !!camera;
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * Per-frame drive from whoever renders the scene. Defers to the owner: if
   * anything is already calling {@link update} directly this is a no-op, so the
   * two can coexist without running the mood clock at double speed.
   *
   * @param {number} dt seconds since the last rendered frame
   */
  frame(dt) {
    if (this._ownerDriven > 0) { this._ownerDriven--; return; }
    this._inFrame = true;
    this.update(dt);
    this._inFrame = false;
  }

  /**
   * Advances the mood cross-fade and the animated life: practical flicker, a
   * slow hue drift on the rim, the per-fighter rim rigs following their
   * fighters, and the breathing multiplier for light shafts. Presentation
   * only — safe to call with any dt.
   *
   * @param {number} dt seconds
   */
  update(dt) {
    if (!this.ready) return;
    if (!this._inFrame) this._ownerDriven = 2;
    const d = Math.min(dt, 0.1);
    this._time += d;

    // --- mood cross-fade ----------------------------------------------------
    if (this._fade.t < 1) {
      this._fade.t = Math.min(1, this._fade.t + d / this._fade.dur);
      const e = this._fade.t * this._fade.t * (3 - 2 * this._fade.t);
      blendParams(this.params, this._from, this._to, e);
      renormalise(this.params.sun.dir, this._to.sun.dir);
      renormalise(this.params.key.dir, this._to.key.dir);
      renormalise(this.params.rim.dir, this._to.rim.dir);
      renormalise(this.params.rimB.dir, this._to.rimB.dir);
      renormalise(this.params.bounce.dir, this._to.bounce.dir);
      this._applyParams();
      this._envDirty = true;
    }

    if (this._envDirty) {
      this._regenCooldown -= d;
      if (this._regenCooldown <= 0 || this._fade.t >= 1) {
        this._regenCooldown = 0.12;
        this._bake();
      }
    }

    // --- pulse --------------------------------------------------------------
    let pulseAmount = 0;
    if (this._pulse.strength > 0) {
      this._pulse.t += d;
      const k = 1 - Math.min(1, this._pulse.t / this._pulse.dur);
      pulseAmount = this._pulse.strength * k * k;
      if (k <= 0) this._pulse.strength = 0;
    }

    const p = this.params;
    const t = this._time;

    // --- practical flicker --------------------------------------------------
    for (let i = 0; i < PRACTICAL_COUNT; i++) {
      const pr = p.practicals[i];
      const light = this.practicals[i];
      const s = pr.seed * 100;
      // Two detuned sines plus a sharper harmonic reads as mains hum rather
      // than a sine wobble; the abs() term gives the occasional deeper dip.
      const n =
        0.55 * Math.sin(t * pr.flickerHz + s) +
        0.3 * Math.sin(t * pr.flickerHz * 2.37 + s * 1.7) +
        0.15 * Math.sin(t * pr.flickerHz * 5.11 + s * 2.9);
      const f = 1 + pr.flickerAmp * n;
      const power = pr.power * f * (1 + pulseAmount * 0.6);

      light.color.copy(pr.color);
      light.intensity = power;
      light.width = pr.size.x;
      light.height = pr.size.y;
      light.position.copy(pr.pos);
      light.lookAt(pr.target);

      // The visible card and the env quad share this material.
      this._quadMaterials[i].color.copy(pr.color).multiplyScalar(power * QUAD_GAIN);
    }

    // --- rim hue drift and breathing ---------------------------------------
    // One budget, two consumers: the directional pair keeps DIRECTIONAL_RIM_SHARE
    // of it for the set, the per-fighter spots carry the rest onto the fighters.
    const drift = p.rim.hueDrift * Math.sin(t * 0.17) + p.rim.hueDrift * 0.45 * Math.sin(t * 0.41 + 1.9);
    this._tmpColor.copy(p.rim.color).offsetHSL(drift, 0.02 * Math.sin(t * 0.23), 0);
    if (pulseAmount > 0) this._tmpColor.lerp(this._pulse.color, Math.min(0.85, pulseAmount));
    const coolPower = p.rim.intensity * (0.94 + 0.06 * Math.sin(t * 0.61)) * (1 + pulseAmount * 1.2);
    this.rimLight.color.copy(this._tmpColor);
    this.rimLight.intensity = coolPower * DIRECTIONAL_RIM_SHARE;

    this._tmpColorB.copy(p.rimB.color).offsetHSL(-drift * 0.7, 0, 0);
    const warmPower = p.rimB.intensity * (0.95 + 0.05 * Math.sin(t * 0.47 + 2.1)) * (1 + pulseAmount * 0.8);
    this.rimLightB.color.copy(this._tmpColorB);
    this.rimLightB.intensity = warmPower * DIRECTIONAL_RIM_SHARE;

    this._acquireCooldown -= d;
    this._updateFighterRims(coolPower, warmPower);
    this._updateStrips(pulseAmount);

    // --- shafts breathe, ambient reacts to the pulse ------------------------
    this.shaftIntensity = p.shaft.intensity * (0.82 + 0.18 * Math.sin(t * 0.29) + 0.06 * Math.sin(t * 0.83 + 0.6)) + pulseAmount * 0.5;
    this.scene.environmentIntensity = p.envIntensity * (1 + pulseAmount * 0.45);
    this.fillLight.intensity = p.fill.intensity * (0.97 + 0.03 * Math.sin(t * 0.19)) * (1 + pulseAmount * 0.3);
  }

  /**
   * Where a rim light sits relative to its aim point: the mood's rim azimuth,
   * yawed into the camera's frame and re-elevated.
   *
   * Two corrections, both load-bearing. The mood authors its rim almost
   * horizontally because that is correct for a light at infinity; at three
   * metres the same azimuth shoots along the floor and lights nothing but
   * shins. And a rim is defined relative to the eye rather than to the world —
   * leave it pinned to a world azimuth and the moment the KO camera swings
   * round behind a fighter the rim arrives frontally and blows the character
   * out. `yaw` rotates the authored azimuth so "three-quarters behind" stays
   * three-quarters behind from wherever the shot is taken.
   *
   * The key softbox passes `yaw` of zero for the opposite reason: it is the
   * mood's key made local and has to agree with the directional key, which is
   * pinned to the world.
   *
   * @param {THREE.Vector3} dir mood direction the source sits along
   * @param {number} yaw radians to rotate the azimuth about Y
   * @param {number} elevationDeg elevation to re-seat the source at
   * @param {number} radius metres out from the aim point
   * @param {THREE.Vector3} out receives the offset
   */
  _sourceOffset(dir, yaw, elevationDeg, radius, out) {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    out.set(dir.x * c + dir.z * s, 0, dir.z * c - dir.x * s);
    if (out.lengthSq() < 1e-8) out.set(0, 0, -1);
    out.normalize().multiplyScalar(Math.cos(el) * radius);
    out.y = Math.sin(el) * radius;
    return out;
  }

  /**
   * How far the authored rim azimuths have to turn so they stay behind the
   * subject as seen from `aim`. Zero when there is no camera yet, which leaves
   * the world-space azimuths the moods author.
   *
   * @param {THREE.Vector3} aim world point the rig is lighting
   */
  _rimYaw(aim) {
    if (!this.camera) return 0;
    this._camPos.setFromMatrixPosition(this.camera.matrixWorld);
    const dx = aim.x - this._camPos.x;
    const dz = aim.z - this._camPos.z;
    if (dx * dx + dz * dz < 1e-6) return 0;
    // The moods are authored for an eye on +Z looking toward -Z, so the
    // reference view direction is -Z and the correction is measured from it.
    return Math.atan2(dx, dz) - Math.PI;
  }

  /**
   * Move each rim rig onto its fighter and give it the current rim colours.
   * `_tmpColor` / `_tmpColorB` carry the drifted cool and warm hues, so the
   * spots and the directional pair are always the same two colours.
   *
   * @param {number} coolPower mood-space irradiance for the cool rim
   * @param {number} warmPower mood-space irradiance for the warm rim
   */
  _updateFighterRims(coolPower, warmPower) {
    if (!this.fighterRims.length) return;
    const p = this.params;

    // Nobody has to wire this up. The rigs look their fighter up by name and
    // keep looking until it exists, so a late character swap re-acquires.
    const acquire = this._acquireCooldown <= 0;
    if (acquire) this._acquireCooldown = 0.4;

    // The mood's rim intensity is irradiance at the subject; a spot with decay
    // 2 delivers intensity / d², so radius² converts one to the other and a
    // mood reads the same whichever light type carries it.
    const falloff = RIM.gain * RIM.radius * RIM.radius;

    // Same conversion for the softbox, but a rectangle is a radiance and not an
    // intensity, so the area divides back out: irradiance from a panel is
    // roughly radiance * (area / distance²) and the share is authored as the
    // irradiance half of that.
    const boxRadiance =
      p.key.intensity * KEY_BOX.share * (KEY_BOX.radius * KEY_BOX.radius) / (KEY_BOX.width * KEY_BOX.height);

    // Same irradiance-to-intensity conversion the rims use: decay 2, so the
    // authored share is multiplied back up by the distance squared. `keySpotScale`
    // is the A/B arm and is 1 in the shipping rig.
    const keyRadiance =
      p.key.intensity * KEY_SPOT.share * this.keySpotScale * (KEY_SPOT.radius * KEY_SPOT.radius);

    for (const rig of this.fighterRims) {
      if (acquire && !rig.root?.parent) {
        rig.root = this.scene.getObjectByName(`fighter${rig.index}`) ?? null;
      }
      if (!rig.root) {
        rig.cool.intensity = 0;
        rig.warm.intensity = 0;
        rig.box.intensity = 0;
        rig.key.intensity = 0;
        continue;
      }

      rig.root.getWorldPosition(rig.aim);
      rig.aim.y += RIM.aimHeight;
      const yaw = this._rimYaw(rig.aim);

      rig.cool.color.copy(this._tmpColor);
      rig.cool.intensity = coolPower * falloff;
      rig.cool.target.position.copy(rig.aim);
      rig.cool.position
        .copy(this._sourceOffset(p.rim.dir, yaw, RIM.elevationDeg, RIM.radius, this._tmpVecB))
        .add(rig.aim);

      rig.warm.color.copy(this._tmpColorB);
      rig.warm.intensity = warmPower * falloff;
      rig.warm.target.position.copy(rig.aim);
      rig.warm.position
        .copy(this._sourceOffset(p.rimB.dir, yaw, RIM.elevationDeg, RIM.radius, this._tmpVecB))
        .add(rig.aim);

      // The box is the mood's key, so it stays on the world azimuth the
      // directional key uses and is aimed a little below the chest — a panel
      // squared up to the sternum lights the head as hard as the plastron.
      this._tmpVec.copy(rig.aim);
      this._tmpVec.y = rig.aim.y - RIM.aimHeight + KEY_BOX.aimHeight;
      rig.box.color.copy(p.key.color);
      rig.box.intensity = boxRadiance;
      rig.box.position
        .copy(this._sourceOffset(p.key.dir, 0, KEY_BOX.elevationDeg, KEY_BOX.radius, this._tmpVecB))
        .add(this._tmpVec);
      rig.box.lookAt(this._tmpVec.x, this._tmpVec.y - 0.25, this._tmpVec.z);

      // The shadowed key sits on the mood's key direction itself — azimuth and
      // elevation both — rather than on a re-seated elevation of its own. It is
      // the directional key made local, so its terminator lands where the hard
      // key's already does instead of carving a second one across the same
      // plate, and a mood that moves its key moves this with it.
      this._tmpVec.copy(rig.aim);
      this._tmpVec.y = rig.aim.y - RIM.aimHeight + KEY_SPOT.aimHeight;
      rig.key.color.copy(p.key.color);
      rig.key.intensity = keyRadiance;
      rig.key.target.position.copy(this._tmpVec);
      this._tmpVecB.copy(p.key.dir);
      if (this._tmpVecB.lengthSq() < 1e-8) this._tmpVecB.set(0, 1, 1);
      rig.key.position
        .copy(this._tmpVecB.normalize().multiplyScalar(KEY_SPOT.radius))
        .add(this._tmpVec);
    }

    this._publishRimCue(coolPower, warmPower);
  }

  /**
   * Fill {@link rimCue} from the rig that was just placed, for the screen-space
   * rim in `RenderPipeline`. See {@link SCREEN_RIM}.
   *
   * The directions are taken off the first live rig rather than averaged over
   * both. `_rimYaw` has already rotated each rig's azimuth into the camera's
   * frame, which is the whole point of that correction — so in *view* space the
   * two rigs' rim directions agree by construction, and they differ only by the
   * few degrees of parallax between two fighters a couple of metres apart. One
   * pair of vectors is the honest description of a rig that is deliberately
   * camera-relative, and it is also what lets the pass hold a single uniform
   * instead of a per-fighter one it has no mask to select with.
   *
   * @param {number} coolPower mood-space irradiance for the cool rim
   * @param {number} warmPower mood-space irradiance for the warm rim
   */
  _publishRimCue(coolPower, warmPower) {
    const cue = this.rimCue;
    let lead = null;
    let n = 0;
    cue.center.set(0, 0, 0);
    for (const rig of this.fighterRims) {
      if (!rig.root) continue;
      if (!lead) lead = rig;
      cue.center.add(rig.aim);
      n++;
    }
    // No fighters placed yet, or the arm is ablated. The pass reads `active` and
    // zeroes its gain, which is a uniform write and not a recompile, so this can
    // flip on any frame — including the frame a character finishes loading.
    if (!lead || this.ablate.has('screenRim')) {
      cue.active = false;
      return;
    }
    cue.center.multiplyScalar(1 / n);

    // Half the pair's separation **along the view axis**, which is what the
    // depth gate is sized off.
    //
    // Two things it is deliberately not. It is not `FightCamera`'s focus radius,
    // because that is a framing hint carrying camera padding and every metre of
    // padding is a metre of set the gate stops rejecting. And it is not the 3D
    // separation: two fighters squared up side-on to the camera are three metres
    // apart on screen and a few centimetres apart in depth, and a gate sized off
    // the 3D figure would open to three metres of arena behind them for a spread
    // that does not exist. Measured along the eye, the common case collapses to
    // the {@link SCREEN_RIM}-adjacent floor in `RIM_SS.minSlab` and only a pair
    // genuinely stacked front-to-back widens it.
    let spread = 0;
    const eye = this.camera ? this._cueVec.set(0, 0, -1).transformDirection(this.camera.matrixWorld) : null;
    for (const rig of this.fighterRims) {
      if (!rig.root) continue;
      this._cueVecB.copy(rig.aim).sub(cue.center);
      spread = Math.max(spread, eye ? Math.abs(this._cueVecB.dot(eye)) : this._cueVecB.length());
    }
    cue.spread = spread;

    cue.coolDir.copy(lead.cool.position).sub(lead.aim);
    if (cue.coolDir.lengthSq() < 1e-8) cue.coolDir.set(0, 0, -1);
    cue.coolDir.normalize();
    cue.warmDir.copy(lead.warm.position).sub(lead.aim);
    if (cue.warmDir.lengthSq() < 1e-8) cue.warmDir.set(0, 0, 1);
    cue.warmDir.normalize();

    // The same two drifted colours the analytic spots were just given, so the
    // added edge and the multiplied one are never two different hues — the
    // screen-space term is meant to be the part of that light that survives the
    // fighter's albedo, not a second source.
    cue.coolColor.copy(this._tmpColor);
    cue.warmColor.copy(this._tmpColorB);
    cue.coolLevel = SCREEN_RIM.cool * coolPower / SCREEN_RIM.reference;
    cue.warmLevel = SCREEN_RIM.warm * warmPower / SCREEN_RIM.reference;
    cue.active = true;
  }

  /**
   * Drive the overhead tube runs off the mood's `ceiling` block. `on` is the
   * mood's own statement about whether it has a roof: at golden hour it is zero
   * and the runs go dark, which is the correct answer and costs nothing to ask.
   *
   * @param {number} pulseAmount 0..1+ flash term shared with the rest of the rig
   */
  _updateStrips(pulseAmount) {
    const c = this.params.ceiling;
    const radiance = c.intensity * c.on * STRIP.gain * (1 + pulseAmount * 0.5);
    for (const l of this.strips) {
      l.color.copy(c.color);
      l.intensity = radiance;
    }
  }

  /** Write the blended params onto the rig, fog and scene-level intensities. */
  _applyParams() {
    const p = this.params;

    this.keyLight.color.copy(p.key.color);
    this.keyLight.intensity = p.key.intensity * DIRECTIONAL_KEY_SHARE;
    this._tmpVec.copy(p.key.dir).multiplyScalar(26);
    this.keyLight.position.copy(this._tmpVec).add(this.keyLight.target.position);

    this.rimLight.color.copy(p.rim.color);
    this.rimLight.intensity = p.rim.intensity * DIRECTIONAL_RIM_SHARE;
    this._tmpVec.copy(p.rim.dir).multiplyScalar(22);
    this.rimLight.position.copy(this._tmpVec).add(this.rimLight.target.position);

    this.rimLightB.color.copy(p.rimB.color);
    this.rimLightB.intensity = p.rimB.intensity * DIRECTIONAL_RIM_SHARE;
    this._tmpVec.copy(p.rimB.dir).multiplyScalar(22);
    this.rimLightB.position.copy(this._tmpVec).add(this.rimLightB.target.position);

    this._tmpColor.copy(p.rim.color);
    this._tmpColorB.copy(p.rimB.color);
    this._updateFighterRims(p.rim.intensity, p.rimB.intensity);
    this._updateStrips(0);

    this.bounceLight.color.copy(p.bounce.color);
    this.bounceLight.intensity = p.bounce.intensity;
    this._tmpVec.copy(p.bounce.dir).multiplyScalar(14);
    this.bounceLight.position.copy(this._tmpVec).add(this.bounceLight.target.position);

    this.fillLight.color.copy(p.fill.sky);
    this.fillLight.groundColor.copy(p.fill.ground);
    this.fillLight.intensity = p.fill.intensity;

    for (let i = 0; i < PRACTICAL_COUNT; i++) {
      const pr = p.practicals[i];
      const light = this.practicals[i];
      light.color.copy(pr.color);
      light.intensity = pr.power;
      light.width = pr.size.x;
      light.height = pr.size.y;
      light.position.copy(pr.pos);
      light.lookAt(pr.target);
      this._quadMaterials[i].color.copy(pr.color).multiplyScalar(pr.power * QUAD_GAIN);
    }

    this.fog.color.copy(p.fog.color);
    this.fog.density = p.fog.density;

    this.shaftIntensity = p.shaft.intensity;
    this.exposureHint = p.exposure;
    this.scene.environmentIntensity = p.envIntensity;
    this.scene.backgroundIntensity = 1;
    this._rig.updateMatrixWorld(true);
  }

  // -------------------------------------------------------------------------

  dispose() {
    this.scene.environment = null;
    this.scene.background = null;
    if (this.scene.fog === this.fog) this.scene.fog = null;
    if (this._prevSceneBeforeRender) this.scene.onBeforeRender = this._prevSceneBeforeRender;
    else delete this.scene.onBeforeRender;
    this._prevSceneBeforeRender = null;
    this.camera = null;

    this._pmremTarget?.dispose();
    this._pmrem?.dispose();
    this._pmremTarget = null;
    this._pmrem = null;
    this.envMap = null;

    this._disposeTargets();
    this.backgroundMap = null;

    this._skyMesh?.geometry.dispose();
    this._skyMaterial?.dispose();
    this._quadGeometry?.dispose();
    for (const m of this._quadMaterials) m.dispose();
    this._quadMaterials.length = 0;
    this._envQuads.length = 0;

    this.keyLight?.shadow.map?.dispose();
    for (const rig of this.fighterRims) rig.key?.shadow.map?.dispose();
    this._disposeMidground();
    if (this._midgroundMats) {
      for (const mat of Object.values(this._midgroundMats)) {
        mat.normalMap?.dispose();
        mat.roughnessMap?.dispose();
        mat.dispose();
      }
      this._midgroundMats = null;
    }
    if (this._rig) this.scene.remove(this._rig);
    if (this.practicalMeshes) this.scene.remove(this.practicalMeshes);
    this.practicals.length = 0;
    this.strips.length = 0;
    this.fighterRims.length = 0;
    this.ready = false;
  }
}
