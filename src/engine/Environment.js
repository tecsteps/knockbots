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
// Area-light budget, and it is the whole frame. Measured at 1080p headless
// (ANGLE/Metal) with a slow ladder — 4s settle per step, repeated four times,
// because hiding a RectAreaLight changes NUM_RECT_AREA_LIGHTS and recompiles
// every material, so a fast A/B measures the recompile and not the light:
//
//     0 area lights   16.5 ms   61 fps
//     4 area lights   26.9 ms   37 fps
//     8 area lights   40.3 ms   25 fps
//
// Linear, ~3.0ms each. For comparison the entire post chain is 5.8ms and the
// whole shadow pass 1.5ms — nothing else in the renderer is within an order of
// magnitude, and the game is light-shader-bound rather than triangle-bound.
//
// So the count below is a deliberate spend, not a default. The one that earns
// its 3ms is the per-fighter key box: it draws the long bar down the plate that
// the player actually looks at. The four stage practicals sit at the same
// positions as the brightest emissive quads in the cube, so PMREM already
// carries their soft contribution — dropping them loses the crisp rectangular
// specular on the *set*, which the camera is not pointed at. The ceiling strips
// go for the same reason.
const TIERS = {
  ultra: { cube: 512, bg: 1024, shadow: 2048, practicals: 1, rims: 2, boxes: 1, strips: 0 },
  high: { cube: 512, bg: 768, shadow: 2048, practicals: 1, rims: 2, boxes: 1, strips: 0 },
  medium: { cube: 256, bg: 384, shadow: 1024, practicals: 0, rims: 2, boxes: 1, strips: 0 },
  low: { cube: 128, bg: 256, shadow: 512, practicals: 0, rims: 1, boxes: 0, strips: 0 },
};

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
   * critic called out. 1.7 keeps the rim pass at roughly twice the key — hot
   * enough to draw the edge, not hot enough to become the key.
   */
  gain: 1.7,
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
   * which put 1.6 keys on the fighter and 1.0 on the deck. It is now the larger
   * half of a split budget — see {@link DIRECTIONAL_KEY_SHARE} — so the fighter
   * still receives the same 1.6 and the deck receives 0.66. The old ceiling
   * argument (past about 0.7 the box starts filling the creases the hard key is
   * carving, because three gives area lights no shadow) still holds and is what
   * stops the split going further: at 0.94 the soft half is already 59% of the
   * key on the fighter, and every further point of it is a point of terminator.
   */
  share: 0.94,
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
 */
const DIRECTIONAL_KEY_SHARE = 0.66;

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
 */
const DIRECTIONAL_RIM_SHARE = 0.34;

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
    fog: { color: C(0x2c3a4c), density: 0.028 },
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
    fog: { color: C(0x2e1a42), density: 0.032 },
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
    fog: { color: C(0x431c0e), density: 0.036 },
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
    fog: { color: C(0x243040), density: 0.024 },
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
    fog: { color: C(0x5c4a3e), density: 0.028 },
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
    this.mood = opts.mood ?? 'industrial';
    this.ready = false;

    /** Live, fully blended mood parameters. Read-only for everyone else. */
    this.params = cloneParams(MOODS[this.mood] ?? MOODS.industrial);
    this._from = cloneParams(this.params);
    this._to = cloneParams(this.params);
    this._fade = { t: 1, dur: 1 };

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
     * @type {{index: number, root: ?THREE.Object3D, cool: THREE.SpotLight,
     *         warm: THREE.SpotLight, lights: THREE.SpotLight[],
     *         box: THREE.RectAreaLight, aim: THREE.Vector3}[]}
     */
    this.fighterRims = [];
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
    this.keyLight.castShadow = true;
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
    this.rimLight = new THREE.DirectionalLight(0xffffff, 1);
    this.rimLight.castShadow = false;
    this.rimLight.target.position.set(0, 1.05, 0);
    this._rig.add(this.rimLight, this.rimLight.target);

    // Weaker complementary rim on the opposite flank so both fighters get an
    // edge regardless of which way the camera has swung.
    this.rimLightB = new THREE.DirectionalLight(0xffffff, 1);
    this.rimLightB.castShadow = false;
    this.rimLightB.target.position.set(0, 1.05, 0);
    this._rig.add(this.rimLightB, this.rimLightB.target);

    this._buildFighterRims(tier);
    this._buildStrips(tier);

    // Ground bounce: low, from below the horizon, kills the dead black on the
    // undersides of thighs and forearms without flattening anything.
    this.bounceLight = new THREE.DirectionalLight(0xffffff, 0.5);
    this.bounceLight.castShadow = false;
    this.bounceLight.target.position.set(0, 0.7, 0);
    this._rig.add(this.bounceLight, this.bounceLight.target);

    this.fillLight = new THREE.HemisphereLight(0xffffff, 0x202020, 0.7);
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
      light.visible = i < tier.practicals;
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
        l.visible = k < tier.rims;
        l.target.position.set(0, RIM.aimHeight, 0);
        this._rig.add(l, l.target);
        lights.push(l);
      }

      const box = new THREE.RectAreaLight(0xffffff, 0, KEY_BOX.width, KEY_BOX.height);
      box.name = `fighterKeyBox${i}`;
      box.layers.set(SPLIT_LIGHT_LAYER);
      box.visible = tier.boxes > 0;
      this._rig.add(box);

      this.fighterRims.push({
        index: i,
        root: null,
        cool: lights[0],
        warm: lights[1],
        lights,
        box,
        aim: new THREE.Vector3(0, RIM.aimHeight, 0),
      });
    }
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
      l.visible = i < tier.strips;
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
  setMood(name, t = 1.2) {
    const target = MOODS[name];
    if (!target) return;
    this.mood = name;

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
    for (let i = 0; i < this.practicals.length; i++) {
      this.practicals[i].visible = i < tier.practicals;
    }
    for (const rig of this.fighterRims) {
      for (let k = 0; k < rig.lights.length; k++) rig.lights[k].visible = k < tier.rims;
      rig.box.visible = tier.boxes > 0;
    }
    for (let i = 0; i < this.strips.length; i++) this.strips[i].visible = i < tier.strips;
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

    for (const rig of this.fighterRims) {
      if (acquire && !rig.root?.parent) {
        rig.root = this.scene.getObjectByName(`fighter${rig.index}`) ?? null;
      }
      if (!rig.root) {
        rig.cool.intensity = 0;
        rig.warm.intensity = 0;
        rig.box.intensity = 0;
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
    }
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
    if (this._rig) this.scene.remove(this._rig);
    if (this.practicalMeshes) this.scene.remove(this.practicalMeshes);
    this.practicals.length = 0;
    this.strips.length = 0;
    this.fighterRims.length = 0;
    this.ready = false;
  }
}
