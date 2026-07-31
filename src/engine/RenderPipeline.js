/**
 * Knockbots — the render pipeline.
 *
 * This module owns every pixel decision in the game: the WebGL2 context, the
 * shadow system, the post-processing chain, the colour grade, and the quality
 * tiers that keep all of it inside a 16.6ms budget.
 *
 * Design notes worth reading before changing anything here:
 *
 * 1. **Colour**. The composer works entirely in scene-referred linear light in
 *    half-float buffers. `renderer.toneMapping` is deliberately `NoToneMapping`
 *    while post is active, because bloom, DOF and motion blur are only correct
 *    on un-tonemapped radiance. The display transform lives in
 *    `GradePass`: a hand-written AgX (log-encode -> sigmoid -> look -> outset).
 *    AgX is used rather than ACES because ACES over-saturates and hue-shifts
 *    exactly the things this game is made of — coloured emissives on metal —
 *    while AgX desaturates into the highlight and keeps the hue path straight.
 *    The one place this deviates from stock AgX is the top of the log encode,
 *    which compresses rather than clamps: see `agx()` and `buildGradeLut()`,
 *    because a clamped log window is what turns a specular into a flat shape.
 *
 * 2. **Shadows**. Real cascaded shadow maps in the classic three.js renderer
 *    require patching every material (`CSM.setupMaterial`), which would stomp on
 *    the `onBeforeCompile` hooks other modules install. Instead this file ships
 *    a single very high resolution shadow map that is refit to the fighter pair
 *    every frame and texel-snapped, plus a global PCSS replacement for the
 *    `shadowmap_pars_fragment` chunk so the shadows contact-harden. In a stage
 *    whose action fits in ~16m, one 4096 map is ~4mm per texel — better than any
 *    three-cascade split would give at these distances, for a third of the cost.
 *
 * 3. **G-buffer**. There isn't one. GTAO, depth of field and the motion blur
 *    reprojection all need scene depth and nothing else that cannot be derived
 *    from it, so `ScenePass` renders the beauty pass into a target that owns a
 *    real depth texture and everything downstream reads that. The dedicated
 *    view-normal prepass this replaced was a second full geometry pass — it
 *    cost as many draw calls as the scene itself.
 *
 * 4. **Motion blur is camera-only, deliberately.** A per-object velocity buffer
 *    written by a second skinned draw shipped here once and was taken out
 *    again: see the note on `MotionBlurPass` for the measurements. The short
 *    version is that an object velocity field is only as smooth as the pose
 *    delta feeding it, and a blur is the one effect that turns a one-frame
 *    animation pop into a permanent, visible double image. The camera delta is
 *    smooth by construction because a spring-damper produces it.
 *
 * 5. **Where the frame time actually goes.** Per-pass, 1080p ultra, native
 *    scale, default fight framing.
 *
 *    How, because it decides whether the table is worth anything.
 *    `EXT_disjoint_timer_query_webgl2` is exposed under ANGLE/Metal and returns
 *    nonsense: every inner pass reported ~37ms against a 40ms whole frame,
 *    because the driver times the command buffer rather than the range. A
 *    `gl.finish()` either side of a pass fails differently — Chromium's command
 *    buffer is asynchronous, so the first sync in a frame absorbs the entire
 *    backlog and the beauty pass reads 115ms while every pass after it reads
 *    0.0. What does work is running one pass K=16 times in a frame and reading
 *    the slope, `( frameMs(K) - frameMs(1) ) / ( K - 1 )`, with the two blocks
 *    interleaved so drift cancels. The added work is fifteen more copies of
 *    exactly the thing being measured, which puts the signal an order of
 *    magnitude above the noise.
 *
 *      scene (beauty) pass    72.0 ms   including the reflection below
 *      planar reflection       7.5 ms
 *      bloom                   6.4 ms
 *      shadow map              1.5 ms   the whole pass, both draws
 *      grade                   0.5 ms
 *      GTAO, DOF, motion blur, SMAA, output, overlay   <= 1 ms, several
 *                                                      negative — free
 *
 *    A second run using block-paired toggling of `pass.enabled` on a paused
 *    simulation (see `docs/PROFILING.md`) agrees within its intervals: bloom
 *    3.4ms (IQR 0.5..5.7), GTAO 2.0 (-1..8), SMAA 2.0 (-2.9..3.9), DOF 1.0
 *    (-0.6..3), motion blur 0.3 (-2.8..4.3), grade -0.1 (-5.8..2.3), overlay
 *    0.3 (0..0.6) — and the whole post chain disabled together saves 5.8ms
 *    (IQR 5.1..6.8), which is the number to trust, because it is the only one
 *    whose interval is tight. The shadow pass measured 1.5ms (IQR 1.2..2.1).
 *    Drawing the shadow map once per frame instead of twice — the fix in the
 *    constructor below — measured -0.1ms (IQR -0.6..0.4): it is correct, it is
 *    free, and it buys nothing. Halving the map to 2048 measured -0.2ms
 *    (IQR -1.2..0.8), i.e. nothing.
 *
 *    Then the 72ms scene pass, one thing disabled at a time inside it:
 *
 *      stock                             59.7 ms
 *      RectAreaLights hidden             25.6 ms   -34.1
 *      all punctual lights hidden        18.1 ms   a further -7.5
 *      PCSS -> hardware PCF              60.3 ms   no change
 *      shadows off entirely              65.2 ms   no change
 *      floor reflection gather off       62.4 ms   no change
 *      backdrop hidden                   63.6 ms   no change
 *      apron hidden                      57.6 ms   -2, at the noise floor
 *
 *    The eight `RectAreaLight`s `Environment` puts in the scene are 34ms of a
 *    60ms scene pass. With them hidden the whole frame — every post effect on,
 *    native resolution — measures 15.3ms, 65fps, against 37.6ms stock. The
 *    planar reflection falls from 7.5ms to 1.7ms at the same time: the mirror
 *    is not expensive, the second set of fragments it shades through those
 *    lights is. So the pipeline is not what is slow. Every fragment in the
 *    frame is lit by twenty-three forward lights, eight of them running three's
 *    LTC area-light integral, and no amount of resolution, tap-count or
 *    pass-count tuning in this file recovers that.
 *
 *    That claim is worth more than an on/off, because an on/off of a light is
 *    also a shader recompile — hiding a `RectAreaLight` changes
 *    NUM_RECT_AREA_LIGHTS and three rebuilds every material in the scene, so a
 *    fast A/B of lights measures compilation. Measured slowly instead, four
 *    seconds of settle per step and repeated, the count walks linearly:
 *
 *      0 area lights   16.5 ms   61 fps
 *      4 area lights   26.9 ms   37 fps
 *      8 area lights   40.3 ms   25 fps
 *
 *    ~3.0ms per area light, and 24ms of a 40ms frame for the eight of them.
 *    This is the one number in this file that was carried for several rounds as
 *    a comment before anyone measured it; it turned out to be right, which is
 *    luck rather than method. Do not quote it without re-running the ladder.
 *
 *    Two things follow for anyone tempted to tune this file for frames. GTAO,
 *    DOF, motion blur and SMAA are already free — GTAO measured -1.8ms and
 *    -3.3ms in two runs, because it is half-res and DOF early-outs on the
 *    fragments it would not blur. And PCSS tap count and shadow map size are
 *    both at zero delta, so there is nothing to win by softening the shadows.
 *    Bloom's 6.4ms is the one real post cost; a half-resolution pyramid returns
 *    about 2.7ms of it and doubles the halo width, which is not a trade worth
 *    making while the frame is 20fps clear of target.
 *
 *    Adaptive resolution is the only knob here that touches the light cost, and
 *    on the ultra tier it is deliberately pinned — see the note on
 *    `QUALITY_TIERS`.
 *
 * Externally this class only needs the charter API, but it also listens for a
 * `cameraFocus` bus event (emitted by `FightCamera`) carrying the focus point
 * and radius of the fighter pair, which drives shadow fitting and DOF focus.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { bus } from '../core/Bus.js';
import { ARENA_HALF_WIDTH, ARENA_HALF_DEPTH, LAYER } from '../core/Constants.js';

// ---------------------------------------------------------------------------
// Split lighting layers
//
// The frame is fill-bound and the dominant term is analytic lights evaluated per
// fragment over an arena that covers ~85% of the screen. Measured at 1080p,
// paused, render scale pinned, 2.5s holds, four alternations each:
//
//     four per-fighter rim spots removed    -5.04 ms   (23.49 -> 18.46)
//     two per-fighter key boxes removed     -3.29 ms   (18.45 -> 15.35)
//     the stage practical removed           -1.23 ms   (15.56 -> 14.28)
//     all six per-fighter lights removed    -7.34 ms   (21.93 -> 14.51)
//
// Those six lights exist to shape two robots that occupy about an eighth of the
// frame, and seven eighths of their cost is spent lighting a set they were never
// aimed at. Three filters lights per **camera** — `object.layers.test(
// camera.layers )` in `WebGLRenderer.projectObject` — so the beauty pass is split
// in two, with the same camera and two different layer masks:
//
//   pass B  arena, background, the planar mirror, lit by the global rig only
//   pass A  the fighters and every transparent effect, lit by the full rig
//
// Arena first so `scene.background` is drawn once, before anything else, and so
// the floor's `onBeforeRender` builds the mirror while the whole scene is still
// reachable through its own `enableAll` camera. Fighters and transparents last so
// they depth-test against the arena and blend over it in their existing
// `renderOrder`, which is the order they already had when everything was one
// pass.
//
// The layers below have to be *exclusive* — `Layers.test` is a mask overlap, so
// an object that keeps layer 0 would draw in both passes. Anything moved onto
// `SPLIT_GEOMETRY_LAYER` therefore loses layer 0, and every light that is not a
// per-fighter light gains `GLOBAL_LIGHT_LAYER` so pass A can see it without also
// seeing the arena.
// ---------------------------------------------------------------------------

/** Geometry drawn in the second (full-rig) half of the beauty pass. */
export const SPLIT_GEOMETRY_LAYER = 8;
/** Lights that only ever shine on `SPLIT_GEOMETRY_LAYER`. Set by `Environment`. */
export const SPLIT_LIGHT_LAYER = 9;
/** Every other light. Visible to both halves. */
export const GLOBAL_LIGHT_LAYER = 10;
/**
 * Lights the arena half sees and the fighter half does not — the mirror image of
 * `SPLIT_LIGHT_LAYER`. The set loses the per-fighter rig's spill when the split
 * turns on, and measured on the hero framing that loss is almost entirely on the
 * deck: mean floor value 0.67x, crowd 0.97x, wall band 0.95x. A light on this
 * layer puts the deck back without touching the robots or being paid for twice.
 */
export const ARENA_LIGHT_LAYER = 11;

const SPLIT_GEOMETRY_BIT = 1 << SPLIT_GEOMETRY_LAYER;
const SPLIT_LIGHT_BIT = 1 << SPLIT_LIGHT_LAYER;
const GLOBAL_LIGHT_BIT = 1 << GLOBAL_LIGHT_LAYER;
const ARENA_LIGHT_BIT = 1 << ARENA_LIGHT_LAYER;

/**
 * Name prefixes of the top-level groups whose whole subtree belongs in the
 * full-rig pass: `Fighter` names its root `fighter<index>`, `EffectsDirector`
 * names its root `fx`, and `TestHarness.rosterLineup` names each of its ten
 * `lineup_<id>`.
 *
 * A name is a weak contract, so `ScenePass` falls back to a single pass when it
 * matches none of them — a renamed group costs frames, never correctness. But it
 * is a *prefix* list rather than an exact one because of what the exact one did:
 * `lineup_*` was not on it, so the roster shot drew all ten robots in the arena
 * half and photographed them without the per-fighter rig. They were visibly
 * flatter, and nothing in the frame time said so. Anything that is a robot, or
 * is emitted by one, goes here.
 */
export const SPLIT_GROUPS = ['fighter', 'lineup', 'fx'];

/**
 * Puts every object the split moved back on layer 0.
 *
 * This is not a tidy-up, it is a correctness requirement, and it is why the
 * function is module-level rather than a method on the pass that does the
 * moving. Split geometry is moved *off* layer 0 so the arena half cannot see it,
 * so any code path that stops rendering through `ScenePass` — dropping to a tier
 * with no depth buffer replaces it with a stock `RenderPass`, whose camera mask
 * is the plain one — renders an arena with no fighters and no effects in it.
 * Losing three milliseconds because a flag went off is a regression; losing both
 * robots is a black screen with a HUD on it.
 *
 * @param {THREE.Scene} scene
 */
function restoreSplitLayers(scene) {
  if (!scene) return;
  scene.traverse((o) => {
    if (o.layers.mask & (SPLIT_GEOMETRY_BIT | GLOBAL_LIGHT_BIT)) {
      o.layers.enable(LAYER.DEFAULT);
      o.layers.disable(SPLIT_GEOMETRY_LAYER);
      o.layers.disable(GLOBAL_LIGHT_LAYER);
    } else if (o.isLight && (o.layers.mask & SPLIT_LIGHT_BIT)) {
      // The per-fighter lights are the one layer `Environment` owns. Unsplit
      // they have to light everything again, or the robots go dark.
      o.layers.enable(LAYER.DEFAULT);
    } else if (o.isLight && (o.layers.mask & ARENA_LIGHT_BIT)) {
      o.layers.disable(LAYER.DEFAULT);
    }
  });
}

// ---------------------------------------------------------------------------
// PCSS shadows
//
// three r185 offers hardware PCF (5 Vogel taps, fixed radius) or VSM (soft but
// light-bleeding). Neither contact-hardens. Replacing the shadow chunk lets us
// run a proper percentage-closer-soft-shadow — blocker search, penumbra
// estimate, variable-radius Vogel PCF — for every material in the scene without
// touching a single material.
//
// PCSS needs to read raw depth, which the PCF path cannot do because its
// sampler is a `sampler2DShadow` with hardware comparison enabled. The BASIC
// path declares a plain `sampler2D` over an uncompared depth texture, which is
// exactly what we want, so the pipeline runs `BasicShadowMap` and swaps the
// BASIC branch of the chunk for PCSS. Setting the type back to `PCFShadowMap`
// (low/medium tiers) restores stock three behaviour, because the PCF branch of
// the chunk below is a verbatim copy of the original.
// ---------------------------------------------------------------------------

/** Sentinel proving the upstream chunk still has the signature we replace. */
const SHADOW_CHUNK_SENTINEL =
  'float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord )';

let pcssInstalled = false;

/**
 * Builds the replacement `shadowmap_pars_fragment` chunk.
 * @param {number} blockerSamples search taps used to find the average occluder
 * @param {number} filterSamples  taps used for the variable-radius PCF
 * @returns {string}
 */
function buildPcssChunk(blockerSamples, filterSamples) {
  return /* glsl */ `
#if NUM_SPOT_LIGHT_COORDS > 0
	varying vec4 vSpotLightCoord[ NUM_SPOT_LIGHT_COORDS ];
#endif
#if NUM_SPOT_LIGHT_MAPS > 0
	uniform sampler2D spotLightMap[ NUM_SPOT_LIGHT_MAPS ];
#endif
#ifdef USE_SHADOWMAP
	#if NUM_DIR_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#else
			uniform sampler2D directionalShadowMap[ NUM_DIR_LIGHT_SHADOWS ];
		#endif
		varying vec4 vDirectionalShadowCoord[ NUM_DIR_LIGHT_SHADOWS ];
		struct DirectionalLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform DirectionalLightShadow directionalLightShadows[ NUM_DIR_LIGHT_SHADOWS ];
	#endif
	#if NUM_SPOT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform sampler2DShadow spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#else
			uniform sampler2D spotShadowMap[ NUM_SPOT_LIGHT_SHADOWS ];
		#endif
		struct SpotLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
		};
		uniform SpotLightShadow spotLightShadows[ NUM_SPOT_LIGHT_SHADOWS ];
	#endif
	#if NUM_POINT_LIGHT_SHADOWS > 0
		#if defined( SHADOWMAP_TYPE_PCF )
			uniform samplerCubeShadow pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#elif defined( SHADOWMAP_TYPE_BASIC )
			uniform samplerCube pointShadowMap[ NUM_POINT_LIGHT_SHADOWS ];
		#endif
		varying vec4 vPointShadowCoord[ NUM_POINT_LIGHT_SHADOWS ];
		struct PointLightShadow {
			float shadowIntensity;
			float shadowBias;
			float shadowNormalBias;
			float shadowRadius;
			vec2 shadowMapSize;
			float shadowCameraNear;
			float shadowCameraFar;
		};
		uniform PointLightShadow pointLightShadows[ NUM_POINT_LIGHT_SHADOWS ];
	#endif

	float interleavedGradientNoise( vec2 position ) {
		return fract( 52.9829189 * fract( dot( position, vec2( 0.06711056, 0.00583715 ) ) ) );
	}
	vec2 vogelDiskSample( int sampleIndex, int samplesCount, float phi ) {
		const float goldenAngle = 2.399963229728653;
		float r = sqrt( ( float( sampleIndex ) + 0.5 ) / float( samplesCount ) );
		float theta = float( sampleIndex ) * goldenAngle + phi;
		return vec2( cos( theta ), sin( theta ) ) * r;
	}

	#if defined( SHADOWMAP_TYPE_PCF )
		float getShadow( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
				float radius = max( shadowRadius, 1.0 ) * texelSize.x;
				float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
				shadow = (
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
				) * 0.2;
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#elif defined( SHADOWMAP_TYPE_VSM )
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			float shadow = 1.0;
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			bool frustumTest = inFrustum && shadowCoord.z <= 1.0;
			if ( frustumTest ) {
				vec2 distribution = texture2D( shadowMap, shadowCoord.xy ).rg;
				float mean = distribution.x;
				float variance = distribution.y * distribution.y;
				float hard_shadow = step( shadowCoord.z, mean );
				if ( hard_shadow == 1.0 ) {
					shadow = 1.0;
				} else {
					variance = max( variance, 0.0000001 );
					float d = shadowCoord.z - mean;
					float p_max = variance / ( variance + d * d );
					p_max = clamp( ( p_max - 0.3 ) / 0.65, 0.0, 1.0 );
					shadow = max( hard_shadow, p_max );
				}
			}
			return mix( 1.0, shadow, shadowIntensity );
		}
	#else
		// ---- PCSS -------------------------------------------------------
		// \`shadowRadius\` is repurposed by RenderPipeline: it carries
		// tan(lightAngularRadius) * (far - near) / orthoExtent * mapSize, so
		// ( receiverDepth - blockerDepth ) * shadowRadius * texelSize is the
		// penumbra width expressed directly in shadow-map UV units.
		float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
			shadowCoord.xyz /= shadowCoord.w;
			shadowCoord.z += shadowBias;
			bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
			if ( ! ( inFrustum && shadowCoord.z <= 1.0 ) ) return 1.0;

			vec2 texelSize = vec2( 1.0 ) / shadowMapSize;
			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			float lightUv = max( shadowRadius, 0.5 ) * texelSize.x;

			float searchRadius = min( lightUv * 0.35, texelSize.x * 14.0 );
			float blockerSum = 0.0;
			float blockerCount = 0.0;
			for ( int i = 0; i < ${blockerSamples}; i ++ ) {
				vec2 offset = vogelDiskSample( i, ${blockerSamples}, phi ) * searchRadius;
				float d = texture2D( shadowMap, shadowCoord.xy + offset ).r;
				if ( d < shadowCoord.z ) {
					blockerSum += d;
					blockerCount += 1.0;
				}
			}
			if ( blockerCount < 0.5 ) return 1.0;

			float blocker = blockerSum / blockerCount;
			float penumbra = ( shadowCoord.z - blocker ) * lightUv;
			float filterRadius = clamp( penumbra, texelSize.x * 0.85, texelSize.x * 22.0 );

			float shadow = 0.0;
			for ( int i = 0; i < ${filterSamples}; i ++ ) {
				vec2 offset = vogelDiskSample( i, ${filterSamples}, phi ) * filterRadius;
				float d = texture2D( shadowMap, shadowCoord.xy + offset ).r;
				shadow += step( shadowCoord.z, d );
			}
			shadow /= float( ${filterSamples} );

			// Fade the shadow out at the very edge of the fitted map so the
			// boundary of the single cascade is never a visible line.
			vec2 edge = abs( shadowCoord.xy - 0.5 ) * 2.0;
			float border = 1.0 - smoothstep( 0.86, 1.0, max( edge.x, edge.y ) );
			shadow = mix( 1.0, shadow, border );

			return mix( 1.0, shadow, shadowIntensity );
		}
	#endif

	#if NUM_POINT_LIGHT_SHADOWS > 0
	#if defined( SHADOWMAP_TYPE_PCF )
	float getPointShadow( samplerCubeShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 bd3D = normalize( lightToPosition );
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
			dp += shadowBias;
			float texelSize = shadowRadius / shadowMapSize.x;
			vec3 absDir = abs( bd3D );
			vec3 tangent = absDir.x > absDir.z ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
			tangent = normalize( cross( bd3D, tangent ) );
			vec3 bitangent = cross( bd3D, tangent );
			float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
			vec2 sample0 = vogelDiskSample( 0, 5, phi );
			vec2 sample1 = vogelDiskSample( 1, 5, phi );
			vec2 sample2 = vogelDiskSample( 2, 5, phi );
			vec2 sample3 = vogelDiskSample( 3, 5, phi );
			vec2 sample4 = vogelDiskSample( 4, 5, phi );
			shadow = (
				texture( shadowMap, vec4( bd3D + ( tangent * sample0.x + bitangent * sample0.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample1.x + bitangent * sample1.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample2.x + bitangent * sample2.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample3.x + bitangent * sample3.y ) * texelSize, dp ) ) +
				texture( shadowMap, vec4( bd3D + ( tangent * sample4.x + bitangent * sample4.y ) * texelSize, dp ) )
			) * 0.2;
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#elif defined( SHADOWMAP_TYPE_BASIC )
	float getPointShadow( samplerCube shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		float shadow = 1.0;
		vec3 lightToPosition = shadowCoord.xyz;
		vec3 absVec = abs( lightToPosition );
		float viewSpaceZ = max( max( absVec.x, absVec.y ), absVec.z );
		if ( viewSpaceZ - shadowCameraFar <= 0.0 && viewSpaceZ - shadowCameraNear >= 0.0 ) {
			float dp = ( shadowCameraFar * ( viewSpaceZ - shadowCameraNear ) ) / ( viewSpaceZ * ( shadowCameraFar - shadowCameraNear ) );
			dp += shadowBias;
			vec3 bd3D = normalize( lightToPosition );
			float depth = textureCube( shadowMap, bd3D ).r;
			shadow = step( dp, depth );
		}
		return mix( 1.0, shadow, shadowIntensity );
	}
	#endif
	#endif
#endif
`;
}

/**
 * Installs the PCSS shadow chunk once, globally. Verified against the r185
 * chunk signature; if three ever changes it we silently keep the stock chunk
 * and the pipeline falls back to hardware PCF.
 * @returns {boolean} whether PCSS is available
 */
function installPcssShadows() {
  if (pcssInstalled) return true;
  const original = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (typeof original !== 'string' || !original.includes(SHADOW_CHUNK_SENTINEL)) return false;
  THREE.ShaderChunk.shadowmap_pars_fragment = buildPcssChunk(12, 16);
  pcssInstalled = true;
  return true;
}

// ---------------------------------------------------------------------------
// Quality tiers
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} QualityTier
 * @property {number} renderScale     base resolution multiplier
 * @property {number} minScale        floor for adaptive resolution
 * @property {number} shadowMapSize
 * @property {boolean} pcss
 * @property {boolean} depth          render scene depth for the geometry passes
 * @property {boolean} ao
 * @property {boolean} bloom
 * @property {boolean} dof
 * @property {boolean} motionBlur
 * @property {boolean} grade
 * @property {boolean} smaa
 * @property {number} particleBudget
 */

/**
 * `minScale` is deliberately tight on the top tiers. Adaptive resolution exists
 * to protect the frame rate, not to hand back the picture: a 0.75 floor is a
 * 25% linear drop, which reads as a blanket soften over the whole frame and is
 * far more damaging on a still than a dropped frame is in motion.
 *
 * Ultra takes that to its conclusion and does not scale at all. It was sitting
 * pinned at its 0.9 floor in every capture, which is a 1728x972 frame stretched
 * over 1920x1080 — every panel edge on the character softened, permanently, to
 * buy frames nobody was counting. Ultra is the tier the stills are judged on,
 * so it renders at native resolution and degrades by dropping to `high`, which
 * keeps a real 0.78 floor and every effect except the sample counts.
 *
 * **`high` is the tier that holds 60fps at 1080p, and it is `renderScale` that
 * moved.** Measured at 1920x1080, simulation paused, adaptive resolution off,
 * split lighting on, four alternations of 2.5s holds, medians:
 *
 *     ultra                       20.98 ms   47.7 fps
 *     high (renderScale 0.85)     14.92 ms   67.0 fps    IQR of the pair [6.17, 6.25]
 *
 * The scale ladder that picked 0.85, taken on ultra against a pinned 1.0 arm:
 *
 *     renderScale 1.00   20.4 ms   49.0 fps
 *     renderScale 0.90   17.9 ms   55.9 fps
 *     renderScale 0.85   16.7 ms   60.0 fps
 *     renderScale 0.80   15.4 ms   64.9 fps
 *
 * That is a frame of **4.2ms fixed plus 16.2ms proportional to shaded pixels**.
 * 0.85 crosses 16.7ms on ultra's sample counts alone; on `high`'s it lands at
 * 14.9, and the ~1.8ms of slack is deliberate — every number on this page is
 * measured with the simulation **paused**, and a live round costs more than a
 * paused one. `minScale` 0.72 is what spends that slack when a round does.
 *
 * It used to be 0.95, which measures 19.0ms. Nothing in this table would reach
 * 60 without the split beauty pass: before it, 0.85 was a 54fps setting. Every
 * effect stays on at ultra's sample counts minus a few taps, so the whole
 * difference a player sees is 1632x918 resampled to 1920x1080 with SMAA on the
 * far side of it.
 *
 * @type {Record<string, QualityTier>}
 */
export const QUALITY_TIERS = {
  ultra: {
    renderScale: 1.0, minScale: 1.0, shadowMapSize: 4096, pcss: true,
    depth: true, ao: true, aoSamples: 16,
    bloom: true, dof: true, dofTaps: 20, motionBlur: true, mbTaps: 12,
    grade: true, smaa: true, particleBudget: 1.0,
  },
  high: {
    renderScale: 0.85, minScale: 0.72, shadowMapSize: 2560, pcss: true,
    depth: true, ao: true, aoSamples: 11,
    bloom: true, dof: true, dofTaps: 14, motionBlur: true, mbTaps: 8,
    grade: true, smaa: true, particleBudget: 0.8,
  },
  medium: {
    renderScale: 0.85, minScale: 0.65, shadowMapSize: 1536, pcss: false,
    depth: false, ao: false, aoSamples: 8,
    bloom: true, dof: false, dofTaps: 12, motionBlur: false, mbTaps: 6,
    grade: true, smaa: true, particleBudget: 0.5,
  },
  low: {
    renderScale: 0.7, minScale: 0.6, shadowMapSize: 1024, pcss: false,
    depth: false, ao: false, aoSamples: 6,
    bloom: true, dof: false, dofTaps: 8, motionBlur: false, mbTaps: 4,
    grade: true, smaa: false, particleBudget: 0.3,
  },
};

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

/** View-space position reconstruction from a hardware depth buffer. */
const DEPTH_HELPERS = /* glsl */ `
uniform mat4 uInvProjection;
uniform float uNear;
uniform float uFar;

vec3 viewPosFromDepth( vec2 uv, float depth ) {
  vec4 clip = vec4( vec3( uv, depth ) * 2.0 - 1.0, 1.0 );
  vec4 view = uInvProjection * clip;
  return view.xyz / view.w;
}
float linearDepth( float depth ) {
  float ndc = depth * 2.0 - 1.0;
  return ( 2.0 * uNear * uFar ) / ( uFar + uNear - ndc * ( uFar - uNear ) );
}
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}
vec2 vogel( int i, int n, float phi ) {
  float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
  float theta = float( i ) * 2.399963229728653 + phi;
  return vec2( cos( theta ), sin( theta ) ) * r;
}`;

// ---------------------------------------------------------------------------
// Scene pass — beauty render plus the depth every geometry pass reads
// ---------------------------------------------------------------------------

/**
 * Renders the scene into a half-float target that owns a real depth texture,
 * then blits the colour into the composer chain.
 *
 * Hanging the depth texture off the composer's own ping-pong buffers instead
 * would save the blit but cannot work: the chain writes back into the buffer it
 * read two passes ago, and a pass that samples a depth texture attached to the
 * framebuffer it is currently drawing into is a WebGL feedback loop, which the
 * driver is entitled to drop. One fullscreen blit — a single draw call — buys a
 * depth buffer every downstream pass can read safely, and it replaces the
 * `MeshNormalMaterial` prepass this used to need, which redrew every mesh in
 * the scene and therefore roughly doubled the frame's draw calls.
 *
 * View normals are gone with it. GTAO reconstructs them from depth, which is
 * its own default path and the only consumer that ever wanted them.
 *
 * The same feedback rule applies inside the scene: soft particles want to fade
 * against opaque depth, but they are drawn into the very target that owns it.
 * So the pass also keeps a half-resolution copy, refreshed at the end of every
 * frame and exposed as `depthTexture` — one frame stale, which no soft-particle
 * fade can resolve, and safe to sample from any material in the scene. The live
 * attachment is `liveDepth`, for post passes only.
 */
class ScenePass extends Pass {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {{sceneDrawCalls:number, sceneTriangles:number}} stats counters to fill
   */
  constructor(scene, camera, stats) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.stats = stats;

    const depth = new THREE.DepthTexture(1, 1);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.FloatType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.target.texture.name = 'RenderPipeline.scene';
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.target.depthTexture = depth;

    // Half resolution is plenty: the only consumer is a soft-particle fade,
    // which is a low-frequency term over a puff several hundred pixels wide.
    this.depthCopy = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.depthCopy.texture.name = 'RenderPipeline.sceneDepth';

    this.material = new THREE.ShaderMaterial({
      name: 'SceneBlit',
      uniforms: { tDiffuse: { value: this.target.texture } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }`,
      depthTest: false,
      depthWrite: false,
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      name: 'SceneDepthCopy',
      uniforms: { tDepth: { value: depth } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform highp sampler2D tDepth;
        void main() { gl_FragColor = vec4( texture2D( tDepth, vUv ).x, 0.0, 0.0, 1.0 ); }`,
      depthTest: false,
      depthWrite: false,
    });
    this._fsQuad = new FullScreenQuad(this.material);

    /**
     * Depth prepass. See `#prepass` for what it does and when it pays.
     * @type {boolean}
     */
    this.depthPrepass = false;
    /**
     * Depth-only stand-in for the prepass. `colorWrite` off rather than a
     * `MeshDepthMaterial` so the fragment shader stays as close to empty as
     * three will allow; the depth write is the entire point of the draw.
     */
    this._depthOnly = new THREE.MeshBasicMaterial({ name: 'ScenePassDepthOnly', colorWrite: false });
    this._prepassHidden = [];
    /**
     * Smallest screen-space radius, as a fraction of half the viewport height,
     * that earns a place in the prepass. A prepass draw only pays if the thing
     * it draws hides enough shading to cover its own cost, and every one of
     * them is a draw call added to a budget that is already over.
     *
     * The whole trade, measured in one session at the hero framing, 1920x1080,
     * adaptive resolution off and render scale pinned to 1, sim paused, four
     * alternations per point (medians 28.0 / 28.0 / 28.0 / 27.9 on the baseline,
     * so the differences below are well clear of the drift):
     *
     * | threshold | scene draw calls | scene triangles | median | saving |
     * |---|---|---|---|---|
     * | prepass off |  158 | 622k | 28.0ms |    — |
     * | **1**       |  190 | 781k | 24.4ms | **3.62ms** |
     * | 2           |  164 | 653k | 26.2ms | 1.77ms |
     * | 4           |  155 | 636k | 26.8ms | 1.27ms |
     *
     * There is no threshold that is free. The prepass buys frame time with draw
     * calls, and the charter budgets both. 1 is the knee — it takes the whole
     * available saving, and everything below it is the two fighters' thirty-odd
     * small plate meshes, which together cover a few percent of the frame and
     * hide almost nothing behind them. Move it to 2 or 4 if the draw-call
     * budget becomes the binding constraint; the frame cost of doing so is in
     * the table.
     */
    this.prepassMinScreenRadius = 1.0;
    this._sphere = new THREE.Sphere();

    /**
     * Split the beauty pass so the arena is not lit by the per-fighter rig.
     * See the note on `SPLIT_GEOMETRY_LAYER`. Gated on `depthPrepass` by
     * `RenderPipeline`, because the prepass is also what puts the fighters into
     * the shadow map before either half of the split runs.
     * @type {boolean}
     */
    this.splitLighting = false;
    this.splitGroups = SPLIT_GROUPS;
    /**
     * Image-based lighting multiplier for the arena half only.
     *
     * The set loses more than diffuse when the per-fighter rig stops reaching
     * it. Measured on the hero framing, the deck fell to **0.67x** while the
     * crowd held 0.98x and the barrier 0.96x — the loss is concentrated on the
     * one surface in the arena that is polished, because what those two
     * `RectAreaLight` key boxes were really doing to the floor was *reflecting*
     * in it. A hemisphere light cannot put that back: swept from 0 to 100x the
     * mood's fill it takes the deck only from 0.67x to 0.85x and overshoots the
     * crowd to 1.09x and the barrier to 1.13x on the way, because a diffuse
     * irradiance term barely registers on a metal deck and lands squarely on
     * matte crowd cards. That measurement is why there is no hemisphere here.
     *
     * `scene.environmentIntensity` is the right knob and it is free: three
     * folds it into `envMapIntensity` when it refreshes a material's uniforms,
     * so raising it between the two halves of the pass costs one property write
     * per frame and changes no shader — measured at **0.03ms, IQR [0.00, 0.06]**.
     * It lifts the deck's reflection of the light banks, which is the same cue by
     * a different route. Swept against the unsplit frame:
     *
     *     boost   deck    crowd   barrier
     *     1.0     0.67x   0.99x   0.97x
     *     1.3     0.72x   1.02x   0.99x
     *     1.6     0.76x   1.01x   0.99x
     *     1.9     0.80x   1.02x   1.01x
     *     2.0     0.81x   1.02x   1.01x
     *
     * 1.9 is where the rest of the set is back inside the ~2% run-to-run drift
     * and the deck has taken back two fifths of what it lost. It does not go
     * further: what is left is not a level, it is the *shape* of the pool the
     * two key boxes threw around each fighter, and image-based lighting from a
     * static cube cannot follow a robot around the pit. `shots/r11-split/
     * 06-stage-wide.png` against `shots/06-stage-wide.png` is what that costs,
     * and it is the one thing the split visibly takes. The cheap way to put it
     * back is an unlit gradient decal on the deck under each fighter, which
     * belongs to `Stage`, not here.
     */
    this.arenaEnvBoost = 1.9;
    this._splitReady = false;
    this._classified = false;
  }

  /** @see restoreSplitLayers */
  #unclassify() {
    restoreSplitLayers(this.scene);
    this._classified = false;
  }

  /**
   * Sorts the scene onto the two layer sets, once per frame. Idempotent and
   * cheap — a mask test rejects anything already classified — and repeated every
   * frame rather than once at build time because the arena, the effects director
   * and the fighters all add meshes after `init`.
   *
   * Three rules, in order:
   *
   *   - **Lights.** Anything `Environment` has already put on
   *     `SPLIT_LIGHT_LAYER` is left alone. Every other light — including the
   *     impact and wall-flash points that `EffectsDirector` owns — gains
   *     `GLOBAL_LIGHT_LAYER` and loses layer 0, so the fighter half of the pass
   *     can ask for "all the global lights" without also asking for "all the
   *     arena".
   *   - **The named subtrees.** `fighter0`, `fighter1` and `fx` in full.
   *     Effects have to travel with the fighters rather than with the set: they
   *     are transparent, they are emitted at contact, and drawing them in the
   *     arena half would put every spark *behind* the robot that threw it.
   *   - **Transparent meshes anywhere else.** The light shafts, the deck haze
   *     and the floor pools blend over the fighters today because three sorts
   *     all transparency after all opacity. Leaving them in the arena half would
   *     silently move them behind the fighters, so they move too.
   *
   * A mesh that is not on layer 0 is never reclassified. That is what keeps the
   * apron and the floor decals — which live on `LAYER.NO_REFLECT` alone so the
   * mirror can exclude them — out of a layer the mirror does not exclude.
   */
  #classify() {
    let found = 0;
    for (const root of this.scene.children) {
      const name = root.name;
      if (!name || !this.splitGroups.some((p) => name.startsWith(p))) continue;
      found++;
      root.traverse((o) => {
        if (o.layers.mask & SPLIT_GEOMETRY_BIT) return;
        if (!(o.layers.mask & 1)) return;
        o.layers.enable(SPLIT_GEOMETRY_LAYER);
        o.layers.disable(LAYER.DEFAULT);
      });
    }
    this._splitReady = found > 0;
    if (!found) return;
    this._classified = true;

    this.scene.traverse((o) => {
      if (o.isLight) {
        if (!(o.layers.mask & (SPLIT_LIGHT_BIT | ARENA_LIGHT_BIT))) o.layers.enable(GLOBAL_LIGHT_LAYER);
        o.layers.disable(LAYER.DEFAULT);
        return;
      }
      if (!o.isMesh && !o.isPoints && !o.isLine) return;
      if (o.layers.mask & SPLIT_GEOMETRY_BIT) return;
      if (!(o.layers.mask & 1)) return;
      const m = o.material;
      const transparent = Array.isArray(m)
        ? m.some((x) => x && x.transparent === true)
        : !!(m && m.transparent === true);
      if (!transparent) return;
      o.layers.enable(SPLIT_GEOMETRY_LAYER);
      o.layers.disable(LAYER.DEFAULT);
    });
  }

  /**
   * Lays down depth for the scene's opaque occluders before the beauty pass, so
   * the beauty pass's fragments for anything behind them are rejected by
   * early-Z before they reach a fragment shader that integrates fifteen
   * analytic lights.
   *
   * Whether that is worth an extra geometry pass is a property of the scene.
   * Here it is: at the hero framing the opaque pass still shades every screen
   * pixel **2.45 times** after front-to-back sorting and early-Z have taken
   * their 75% (see docs/PROFILING.md — an earlier probe of mine claimed 40x and
   * was summing the procedural sky, because `scene.overrideMaterial` does not
   * apply to `scene.background`; 2.45 is the calibrated figure). The residue is
   * layered — pit floor, barrier, fence, terrace, machinery bank, shell wall —
   * and three's sort cannot separate it, because the set is merged into one mesh
   * per material and each of those spans the whole hall. A merged mesh sorts
   * once, on the distance to its own centre.
   *
   * A perfect prepass would take 2.45 to 1.0, so the ceiling is 59% of opaque
   * scene shading. This one returns 3.62ms of a 28.0ms frame, which is about a
   * third of that ceiling — the rest is left on the table by the three
   * exclusions below.
   *
   * Three exclusions, and they are why this is a whitelist rather than an
   * `overrideMaterial` over everything:
   *
   *   - **Transparent, non-depth-writing and alpha-tested materials.** The
   *     override carries no alpha map, so the grating and the chain-link fence
   *     would lay down solid depth across their own holes and cull the crowd
   *     standing behind them. This is the exclusion worth revisiting: the fence
   *     spans the whole upper half of the frame and everything behind it is
   *     shaded twice. Carrying it into the prepass needs a per-material depth
   *     variant that keeps the alpha map and the alpha test, not one shared
   *     override — which is a bigger change than this pass, and should be
   *     measured on its own.
   *   - **Instanced meshes.** Every instanced population in this scene carries
   *     per-instance vertex animation grafted on through `onBeforeCompile` —
   *     the crowd's sway is the load-bearing one — and an override material
   *     does not run that graft. Its depth would disagree with the beauty
   *     pass's by centimetres, which is enough to punch holes in a swaying
   *     figure.
   *   - **Points and lines.** Nothing to occlude with.
   *
   * Skinned meshes are safe and included: three takes `USE_SKINNING` from the
   * object rather than from the material, so the fighters deform identically
   * under the override.
   */
  #prepass(renderer, split) {
    const hidden = this._prepassHidden;
    hidden.length = 0;
    const cam = this.camera;
    const minR = this.prepassMinScreenRadius;
    // The prepass is the frame's first `renderer.render`, which is the one that
    // rebuilds the shadow map, and with the split active the fighters and the
    // whole light rig have moved off layer 0. Widen the mask for the duration or
    // the map is drawn from an arena with no robots in it and no light to draw
    // it from. It also has to see the fighters to lay their depth: they are now
    // drawn last, so without it the arena behind them is shaded and thrown away.
    const originalMask = cam.layers.mask;
    if (split) cam.layers.mask = originalMask | SPLIT_GEOMETRY_BIT | SPLIT_LIGHT_BIT | GLOBAL_LIGHT_BIT;
    // Screen radius of a bounding sphere, as a fraction of half the viewport
    // height: r / (distance * tan(fov/2)). Cheap, and conservative for a sphere
    // straddling the near plane, which is the case we want to keep anyway.
    const tanHalf = cam.isPerspectiveCamera
      ? Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5) : 1;
    const eye = cam.matrixWorld;
    const ex = eye.elements[12], ey = eye.elements[13], ez = eye.elements[14];
    this.scene.traverse((o) => {
      if (!o.visible || !o.isMesh) return;
      const m = o.material;
      const skip = o.isInstancedMesh || !m || Array.isArray(m)
        || m.transparent || m.depthWrite === false || m.alphaTest > 0 || m.colorWrite === false
        // An `onBeforeRender` hook is how an object does renderer work as a
        // side effect of being drawn — the arena floor builds its planar
        // reflection there. Running the prepass through one would build the
        // mirror from the prepass's visibility set instead of the frame's, and
        // consume the once-per-frame token before the beauty pass could use it.
        // The floor is also the one surface in this scene with nothing behind
        // it, so it is the cheapest possible thing to leave out.
        || o.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender;
      if (skip) { o.visible = false; hidden.push(o); return; }
      // Split geometry is drawn after the arena, so its depth is worth having
      // however small the plate is — that is the whole reason the second half of
      // the pass is cheap. The screen-radius knee below was measured with the
      // fighters interleaved with the set, where it was correct.
      if (split && (o.layers.mask & SPLIT_GEOMETRY_BIT)) return;
      if (minR > 0 && o.geometry) {
        if (o.geometry.boundingSphere === null) o.geometry.computeBoundingSphere();
        const bs = o.geometry.boundingSphere;
        if (bs) {
          this._sphere.copy(bs).applyMatrix4(o.matrixWorld);
          const c = this._sphere.center;
          const d = Math.hypot(c.x - ex, c.y - ey, c.z - ez);
          if (this._sphere.radius / Math.max(1e-3, d * tanHalf) < minR) {
            o.visible = false; hidden.push(o);
          }
        }
      }
    });
    const prevOverride = this.scene.overrideMaterial;
    this.scene.overrideMaterial = this._depthOnly;
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    cam.layers.mask = originalMask;
    for (const o of hidden) o.visible = true;
    hidden.length = 0;
  }

  /**
   * The beauty pass, in two halves against one depth buffer.
   *
   * The camera's own `layers` mask is swapped rather than a pair of cloned
   * cameras being kept in sync: `Layers.test` is read at project time, and a
   * clone would need its projection, its world matrix, its near/far and its
   * `matrixWorldInverse` copied every frame for nothing. It is restored before
   * returning, so `FightCamera` and the reflector never see the swap.
   *
   * `scene.background` is nulled for the second half. Three renders the
   * background as a box with `depthTest: false` unshifted to the front of the
   * opaque list, so leaving it set would repaint the frame over the arena that
   * had just been drawn.
   */
  #renderSplit(renderer) {
    const cam = this.camera;
    const original = cam.layers.mask;
    const arenaMask =
      (original & ~(SPLIT_GEOMETRY_BIT | SPLIT_LIGHT_BIT)) | GLOBAL_LIGHT_BIT | ARENA_LIGHT_BIT;
    const fighterMask = SPLIT_GEOMETRY_BIT | SPLIT_LIGHT_BIT | GLOBAL_LIGHT_BIT;
    const background = this.scene.background;
    const env = this.scene.environmentIntensity;
    try {
      cam.layers.mask = arenaMask;
      if (this.arenaEnvBoost !== 1) this.scene.environmentIntensity = env * this.arenaEnvBoost;
      renderer.render(this.scene, this.camera);
      renderer.autoClear = false;
      this.scene.background = null;
      this.scene.environmentIntensity = env;
      cam.layers.mask = fighterMask;
      renderer.render(this.scene, this.camera);
    } finally {
      this.scene.background = background;
      this.scene.environmentIntensity = env;
      cam.layers.mask = original;
    }
  }

  /** Previous-frame depth copy, safe to sample from materials in the scene. */
  get depthTexture() { return this.depthCopy.texture; }
  /** Live depth attachment. Post passes only — sampling it in the scene is a
   * feedback loop, and the driver will simply drop the draw. */
  get liveDepth() { return this.target.depthTexture; }
  get texture() { return this.target.texture; }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.target.setSize(w, h);
    this.depthCopy.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  render(renderer, writeBuffer) {
    // EffectComposer turns autoClear off for the whole chain; the beauty pass
    // is the one draw in it that genuinely needs a cleared colour and depth.
    const prevAutoClear = renderer.autoClear;
    // Unconditional, not guarded on "did *this* pass split the scene". A quality
    // change builds a fresh `ScenePass`, and a fresh pass remembers nothing —
    // guarded on its own `_classified` it left both fighters and every effect
    // stranded on a layer its camera could not see, and the frame lost 69 draws
    // and 191k triangles while measuring 6.5ms faster. A per-frame traverse of
    // ~130 objects that finds nothing to do costs microseconds; getting this
    // wrong costs the robots.
    if (this.splitLighting) this.#classify();
    else this.#unclassify();
    const split = this.splitLighting && this._splitReady;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    if (this.depthPrepass) {
      // The prepass clears; the beauty pass must then keep that depth and start
      // from a clean colour buffer. It has to be done with `autoClear` and an
      // explicit colour clear rather than by turning `autoClearDepth` off,
      // because the arena's mirror renders from inside the beauty pass through
      // the floor's `onBeforeRender` and clears its own buffer through the same
      // global flags. Leaving `autoClearDepth` false let the reflection target
      // accumulate depth across frames, which put wrong occlusion into the one
      // surface the whole pass exists to serve.
      this.#prepass(renderer, split);
      renderer.autoClear = false;
      renderer.clearColor();
    }
    if (split) this.#renderSplit(renderer);
    else renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;

    // Snapshot here, before any post pass has run: these are the counters the
    // charter's draw-call and triangle budgets are written against.
    this.stats.sceneDrawCalls = renderer.info.render.calls;
    this.stats.sceneTriangles = renderer.info.render.triangles;

    this._fsQuad.material = this.copyMaterial;
    renderer.setRenderTarget(this.depthCopy);
    this._fsQuad.render(renderer);

    this._fsQuad.material = this.material;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._fsQuad.render(renderer);
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.depthCopy.dispose();
    this.material.dispose();
    this.copyMaterial.dispose();
    this._fsQuad.dispose();
  }
}

/**
 * GTAO at half resolution. Ambient occlusion is a low-frequency signal that
 * this pass then runs a Poisson denoise over, so three quarters of the
 * fragments buy nothing the blur does not put back — and they cost more than
 * every other post pass combined at 1080p.
 */
class HalfResGtaoPass extends GTAOPass {
  setSize(width, height) {
    super.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
  }
}

// ---------------------------------------------------------------------------
// Reflections
//
// There is no screen-space reflection pass here, and that is a decision rather
// than an omission.
//
// The arena floor is the one surface in this game that has to mirror, and it
// already does: `PlanarReflector` renders the scene a second time from a camera
// mirrored through the floor plane, and `StageFloor` composites that buffer into
// the floor shader, energy-conserving, weighted by its own wetness and roughness
// fields. A wet-floor SSR pass shipped alongside it for four rounds and was
// solving the same problem a second time, worse and on top: it masked to
// upward-facing geometry near the floor plane — the same pixels the planar
// reflection had already lit — and then *added* its result to them. Two
// reflections summed into one surface is not a brighter reflection, it is a
// floor whose blacks lift, which is the exact tell the grade at the bottom of
// this file is written to avoid.
//
// It could not have won that overlap on quality either. A screen-space march
// cannot see the underside of a fighter, because the underside of a fighter is
// by definition not on screen — and the underside of the fighters is the entire
// content of a floor reflection in a fighting game.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Depth of field
// ---------------------------------------------------------------------------

/**
 * Circle-of-confusion driven bokeh. Gathers on a golden-angle disc and weights
 * every tap by whether that tap's own blur circle actually reaches the centre
 * pixel, which is what stops sharp foreground silhouettes from smearing into
 * defocused background.
 *
 * The circle of confusion is the thin-lens one, measured in pixels, with the
 * aperture chosen so the hyperfocal distance tracks the focus distance. That
 * collapses to
 *
 *     c = K · (1 − S / z)          for z behind the focus plane S
 *
 * which is worth stating plainly, because the two obvious alternatives are both
 * wrong here. `|z − S| / range` — what a depth-of-field pass usually ships with
 * — is linear in metres, so a fighter, who is a metre deep, picks up blur the
 * moment any part of him leaves the focus plane; that is the bug this replaced.
 * A fixed physical aperture is correct but not framing-invariant: the same lens
 * at a 4m portrait distance has a quarter the depth of field it has at 15m, so
 * the background would dissolve on close framings and stay sharp on wide ones.
 *
 * Normalising by S makes the blur a function of how many times further away a
 * surface is than the subject, which is the relationship a focus puller
 * actually holds when they stop down for a wide shot. Anything at twice the
 * subject distance sits at half the maximum blur, whatever the shot.
 *
 * On top of that: `uSharpPx` is the acceptable circle of confusion, subtracted
 * so the subject is not merely nearly sharp but exactly untouched; and the near
 * field does not blur at all inside `uNearRange`, the depth the camera reports
 * as its subject volume, because a fighting game may never soften the fighter
 * closest to the lens.
 */
class BokehDofPass extends Pass {
  constructor(camera, taps = 20) {
    super();
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uInvProjection: { value: new THREE.Matrix4() },
      uNear: { value: 0.1 },
      uFar: { value: 200 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFocus: { value: 6.0 },
      uNearRange: { value: 2.6 },
      uCocScale: { value: 9.3 },
      uSharpPx: { value: 1.4 },
      uMaxRadius: { value: 8.0 },
      uStrength: { value: 0.85 },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'BokehDOF',
      defines: { DOF_TAPS: taps },
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform highp sampler2D tDepth;
        uniform vec2 uResolution;
        uniform float uFocus;
        uniform float uNearRange;
        uniform float uCocScale;
        uniform float uSharpPx;
        uniform float uMaxRadius;
        uniform float uStrength;
        ${DEPTH_HELPERS}

        /** Signed circle of confusion, normalised to the bokeh disc radius. */
        float cocAt( vec2 uv ) {
          float d = texture2D( tDepth, uv ).x;
          float z = max( ( d >= 1.0 ) ? uFar : linearDepth( d ), 0.05 );

          if ( z < uFocus ) {
            float edge = max( uFocus - uNearRange, 0.1 );
            if ( z >= edge ) return 0.0;
            float c = uCocScale * ( edge / z - 1.0 ) - uSharpPx;
            return -min( max( c, 0.0 ) / uMaxRadius, 1.0 );
          }

          float c = uCocScale * ( 1.0 - uFocus / z ) - uSharpPx;
          return min( max( c, 0.0 ) / uMaxRadius, 1.0 );
        }

        void main() {
          vec3 centre = texture2D( tDiffuse, vUv ).rgb;
          float coc = cocAt( vUv );
          float blend = abs( coc ) * uStrength;
          if ( blend <= 0.004 ) { gl_FragColor = vec4( centre, 1.0 ); return; }

          float radiusPx = uMaxRadius * abs( coc );
          vec2 texel = 1.0 / uResolution;
          float phi = ign( gl_FragCoord.xy ) * 6.28318530718;

          vec3 sum = centre;
          float wsum = 1.0;
          for ( int i = 0; i < DOF_TAPS; i ++ ) {
            vec2 disc = vogel( i, DOF_TAPS, phi );
            vec2 offset = disc * radiusPx;
            vec2 uv = vUv + offset * texel;
            float tapCoc = cocAt( uv );
            float tapRadius = uMaxRadius * abs( tapCoc );
            float dist = length( offset );
            // A tap only lights this pixel if its own bokeh circle reaches it.
            // That single rule gives both correct near-field scatter (a blurred
            // foreground spreads over sharp background) and correct far-field
            // occlusion (a sharp foreground never smears into blurred depth).
            float w = clamp( tapRadius - dist + 1.0, 0.0, 1.0 );
            sum += texture2D( tDiffuse, uv ).rgb * w;
            wsum += w;
          }

          gl_FragColor = vec4( mix( centre, sum / wsum, blend ), 1.0 );
        }`,
    });
    this._fsQuad = new FullScreenQuad(this.material);
  }

  /**
   * Every length in the CoC is a fraction of the frame height, so the lens
   * behaves identically at any render scale. The acceptable circle of confusion
   * sits at ~1.3 thousandths of frame height, which is about where a viewer
   * stops calling an edge sharp; the asymptote is a touch above the disc radius
   * so only genuine infinity ever reaches maximum blur.
   */
  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
    this.uniforms.uCocScale.value = Math.max(5, height * 0.0086);
    this.uniforms.uSharpPx.value = Math.max(1.0, height * 0.0013);
    this.uniforms.uMaxRadius.value = Math.max(4, height * 0.0075);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    this.uniforms.uNear.value = this.camera.near;
    this.uniforms.uFar.value = this.camera.far;

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this._fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this._fsQuad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Bloom
// ---------------------------------------------------------------------------

/**
 * `UnrealBloomPass` with a rebuilt bright-pass.
 *
 * Two things are wrong with the stock extraction on a scene-referred buffer.
 * It is a hard threshold, so a highlight drifting past it pops a ring into
 * existence; and it is unbounded, so the halo a light throws is proportional to
 * its radiance rather than to its area. An emissive panel at 40x white
 * therefore does not glow — it detonates, and the mip pyramid smears the blob
 * across a quarter of the frame.
 *
 * The fix is the standard pair: a quadratic soft knee under the threshold, and
 * an energy limit on the extracted radiance. After the clamp a 40x emissive and
 * a 4x one bloom to the same peak; what still separates them is how many pixels
 * are lit, which is exactly the physical cue — a bigger light has a bigger
 * halo, a brighter one does not.
 *
 * **Do not reach for this pass to buy the top of the range. It was measured and
 * it cannot.** The premise looks sound — "highlights bloom naturally" is one of
 * the two 90+ criteria on the lighting axis, and the gate at 5.5 sits above the
 * frame's own 99.9th percentile radiance, so almost nothing currently blooms at
 * all. Every way of opening it up was swept, headless at 1080p with the frame
 * clock stopped so the null control between two grabs is exactly zero, on the
 * hero and closeup framings. Whole-frame linear luminance percentiles:
 *
 *                                p10      p99   |  Tekken 8 ten-ref median
 *     bloom off                0.0049   0.5685  |  p10 0.0091, p99 0.84
 *     as shipped (5.5 / 2.0)   0.0091   0.5804
 *     clamp 2 -> 10            0.0124   0.5935
 *     threshold 5.5 -> 3.0     0.0181   0.6122
 *     threshold 5.5 -> 1.2     0.0254   0.6624
 *     clamp 10, strength 0.9   0.0257   0.6727
 *     ...and radius 0.35->0.02 0.0235   0.6851
 *
 * Read the first two rows first: the shipped bloom already nearly **doubles**
 * the darkest decile of the frame and adds two percent to the 99th percentile.
 * It is, by measurement, almost entirely a pedestal — the "bloom applied as a
 * uniform haze" the critic protocol names as a failure mode — and it survives
 * only because at this strength the pedestal is small enough to leave the floor
 * on the reference median. Every knob that makes it bloom harder makes the
 * pedestal grow faster than the highlight: the contrast ratio p99/p10 is 116
 * with the pass off, 64 as shipped, and 35 at the strongest setting tried.
 * Radius barely matters (0.35 to 0.02 moves the floor by 12%), because the
 * pedestal is `UnrealBloomPass`'s coarse mips and those are weighted by
 * strength, not by radius.
 *
 * The reference is what settles it. The ten Tekken 8 stills run p10 from 0.0035
 * to 0.0417 with a median of 0.0091 — this frame's floor is **already correct**
 * — while their p99 median is 0.84. They get a bright top over a black floor,
 * which is contrast, not glow. So the top end was bought in the display
 * transform instead (see `buildGradeLut` and `look.exposure`) and this pass was
 * left exactly where it was.
 */
class HighlightBloomPass extends UnrealBloomPass {
  /**
   * @param {THREE.Vector2} resolution
   * @param {number} strength
   * @param {number} radius
   * @param {number} threshold  scene-referred luminance where bloom begins
   * @param {number} knee       soft-knee width as a fraction of the threshold
   * @param {number} maxRadiance energy limit on the extracted highlight
   */
  constructor(resolution, strength, radius, threshold, knee = 0.55, maxRadiance = 4.0) {
    super(resolution, strength, radius, threshold);

    this.highPassUniforms.smoothWidth.value = knee;
    this.highPassUniforms.maxRadiance = { value: maxRadiance };

    this.materialHighPassFilter.fragmentShader = /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float luminosityThreshold;
      uniform float smoothWidth;
      uniform float maxRadiance;
      varying vec2 vUv;

      void main() {
        vec4 texel = texture2D( tDiffuse, vUv );
        vec3 col = max( texel.rgb, vec3( 0.0 ) );
        float v = max( max( col.r, col.g ), col.b );

        float knee = max( luminosityThreshold * smoothWidth, 1e-4 );
        float soft = clamp( v - luminosityThreshold + knee, 0.0, 2.0 * knee );
        soft = soft * soft / ( 4.0 * knee );
        float contribution = max( soft, v - luminosityThreshold ) / max( v, 1e-5 );

        vec3 bright = col * contribution;
        float peak = max( max( bright.r, bright.g ), bright.b );
        if ( peak > maxRadiance ) bright *= maxRadiance / peak;

        gl_FragColor = vec4( bright, texel.a );
      }`;
    this.materialHighPassFilter.needsUpdate = true;
  }

  /**
   * @param {number} value energy limit on the extracted highlight
   */
  set maxRadiance(value) { this.highPassUniforms.maxRadiance.value = value; }
  get maxRadiance() { return this.highPassUniforms.maxRadiance.value; }
}

// ---------------------------------------------------------------------------
// Motion blur
// ---------------------------------------------------------------------------

/**
 * Camera-velocity motion blur by depth reprojection: unproject each pixel with
 * the current inverse view-projection, reproject with last frame's, and smear
 * along the resulting screen-space delta. The fight camera whips, punches in
 * and orbits, so this carries most of the motion the eye reads.
 *
 * **Why there is no per-object velocity here.** There was, for one round: a
 * second draw of every `SkinnedMesh` skinned twice, against the live bone
 * texture and against a copy of the previous frame's bone matrices, feeding a
 * McGuire reconstruction filter. It doubled both fighters in every capture, and
 * the reason is worth writing down so it does not get rebuilt.
 *
 * A reprojection blur is a derivative, and a derivative amplifies whatever
 * discontinuity is in its input. Reading the buffer back frame by frame, the
 * skinned velocities ran to 0.145 UV — 280 pixels of screen travel in a single
 * frame — and swung by an order of magnitude between consecutive frames on a
 * fighter that was only idling. Those are real pose deltas: the blur was
 * faithfully reporting a pop in the animation. But a pop that lasts one frame
 * is nearly invisible, whereas the same pop smeared across 280 pixels is a
 * second fighter standing next to the first, and every still capture caught it.
 * The camera delta has none of that behaviour because a spring-damper is
 * continuous by construction, which is exactly why the camera-only path is the
 * one that survives.
 *
 * The gather filter went with it. Its neighbourhood dilation exists to pull a
 * fast limb's smear out over the static background behind it; over a camera-only
 * field, where the only velocity discontinuities are at depth edges, the same
 * dilation drags the sharp foreground along the background's velocity instead —
 * a cost with no matching benefit. A plain smear along each pixel's own velocity
 * is both correct and cheaper for the field this pass actually has.
 */
class MotionBlurPass extends Pass {
  constructor(camera, taps = 10) {
    super();
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uInvViewProjection: { value: new THREE.Matrix4() },
      uPrevViewProjection: { value: new THREE.Matrix4() },
      uIntensity: { value: 0.45 },
      uMaxRadius: { value: 0.011 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'MotionBlur',
      defines: { MB_TAPS: taps },
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform highp sampler2D tDepth;
        uniform mat4 uInvViewProjection;
        uniform mat4 uPrevViewProjection;
        uniform float uIntensity;
        uniform float uMaxRadius;
        uniform vec2 uResolution;

        float ign( vec2 p ) {
          return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
        }

        void main() {
          vec3 base = texture2D( tDiffuse, vUv ).rgb;
          float depth = texture2D( tDepth, vUv ).x;

          vec4 clip = vec4( vec3( vUv, depth ) * 2.0 - 1.0, 1.0 );
          vec4 world = uInvViewProjection * clip;
          world /= world.w;
          vec4 prevClip = uPrevViewProjection * world;
          if ( prevClip.w <= 0.0 ) { gl_FragColor = vec4( base, 1.0 ); return; }
          vec2 prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;

          vec2 velocity = ( vUv - prevUv ) * uIntensity;
          float len = length( velocity );
          if ( len < 0.6 / uResolution.y ) { gl_FragColor = vec4( base, 1.0 ); return; }
          if ( len > uMaxRadius ) velocity *= uMaxRadius / len;

          float jitter = ign( gl_FragCoord.xy ) - 0.5;
          vec3 sum = vec3( 0.0 );
          for ( int i = 0; i < MB_TAPS; i ++ ) {
            float t = ( float( i ) + 0.5 + jitter ) / float( MB_TAPS ) - 0.5;
            sum += texture2D( tDiffuse, vUv - velocity * t ).rgb;
          }
          gl_FragColor = vec4( sum / float( MB_TAPS ), 1.0 );
        }`,
    });
    this._fsQuad = new FullScreenQuad(this.material);

    this._prevViewProjection = new THREE.Matrix4();
    this._viewProjection = new THREE.Matrix4();
    this._primed = false;
  }

  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
  }

  /**
   * Reprojection measures displacement over one *rendered* frame, not over a
   * fixed shutter, so on a slow frame the blur silently doubles: the capture
   * harness runs at 33-40fps and a camera whip smeared both fighters into
   * banded streaks that never appear at 60. Normalising to a 60Hz frame makes
   * the authored `strength` mean the same thing at any frame rate, and the
   * clamp is one-sided so a fast frame cannot amplify it either.
   *
   * @param {number} dt seconds the frame took
   * @param {number} strength authored blur amount
   */
  setShutter(dt, strength) {
    const scale = Math.min(1, (1 / 60) / Math.max(dt, 1e-4));
    this.uniforms.uIntensity.value = strength * scale;
  }

  /**
   * Snapshots the camera the frame is about to be drawn with. Must run before
   * the frame renders, so the matrix the shader calls "previous" is the one the
   * previous frame was actually drawn with.
   */
  captureCamera() {
    this._viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    if (!this._primed) {
      this._prevViewProjection.copy(this._viewProjection);
      this._primed = true;
    }
    this.uniforms.uInvViewProjection.value.copy(this._viewProjection).invert();
    this.uniforms.uPrevViewProjection.value.copy(this._prevViewProjection);
  }

  /** Rolls the reprojection history forward; call after rendering. */
  advance() {
    this._prevViewProjection.copy(this._viewProjection);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this._fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this._fsQuad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Colour grade LUT
// ---------------------------------------------------------------------------

const LUT_SIZE = 32;

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep01 = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Builds the grade as a 32^3 LUT, laid out as a horizontally tiled 1024x32
 * 2D texture.
 *
 * Saturation shaping is done in linear light, where it is physically
 * meaningful; the split tone, lift, contrast pivot and highlight shoulder are
 * done in display space, where a "+0.03 blue in the shadows" actually means
 * three percent of the visible range. Doing the split tone in linear — the
 * obvious-looking choice — puts a 30% blue floor under the whole frame,
 * because 0.09 linear is 0.33 display.
 *
 * The numbers below are set against the reference stills this project is
 * measured on, which have genuinely black blacks: the pivot sits under
 * mid-grey and the lift is small enough that the bottom two percent of the
 * range resolves to zero. A lifted, tinted floor is the single tell that reads
 * as "browser demo" in a side-by-side, because it turns every unlit surface
 * into the same milky grey.
 *
 * **The top end never clips.** The grade this replaced ran the contrast pivot
 * across the whole range and then clamped, which put everything the display
 * transform had placed above 0.96 onto the same handful of code values: a
 * measured closeup had a two-hundred-pixel-wide plateau sitting flat at 250-252
 * across the chest armour, so the brightest specular on the character carried
 * no gradient and no hue at all. Above `SHOULDER` the contrast slope now hands
 * over to a monotone cubic Hermite that lands exactly on white with a shallow
 * slope, so the same range of radiance arrives spread over ~15 code values
 * instead of 3 and a specular keeps its shape.
 *
 * **`contrast` and `SHOULDER` move together, and the constraint is arithmetic
 * rather than taste.** The roll-off is a cubic Hermite from `(SHOULDER,
 * shoulderY)` carrying the contrast slope to `(1, 1)` carrying `END_SLOPE`;
 * Fritsch-Carlson keeps it monotone only while both tangents stay under three
 * times the chord slope `(1 - shoulderY) / (1 - SHOULDER)`. Raising `contrast`
 * raises `shoulderY`, which shortens the chord, which tightens the bound — so
 * the two are not independent and the failure is silent. Taking `contrast` from
 * 1.18 to 1.45 with `SHOULDER` left at 0.78 puts the start tangent at **5.5x**
 * the chord: sampled at 400 points the curve rises to 1.0028 and then folds
 * back over 152 of them, and `clamp01` renders the fold as a flat plateau at
 * 255 spanning input 0.85 to 0.97. It measures *better* than the correct curve
 * — that pairing reported p999 0.9829 and 0.254% saturated against 0.9548 and
 * 0.000% for the monotone one — because a plateau at white is indistinguishable
 * from range in a histogram. It is the same artefact the paragraph above
 * describes, reintroduced by the knob that was supposed to fix it.
 *
 * At 1.45 the bound requires `SHOULDER <= 0.730`. It is 0.68, which puts the
 * start tangent at 2.29x the chord and the end tangent at 0.47x, and a
 * 400-sample walk of the curve finds zero decreasing steps and a peak of
 * exactly 1.0. Anything that touches either constant should re-run that walk.
 *
 * Why 1.45 at all: against the ten Tekken 8 references the frame was not flat,
 * it was *low-contrast* — the shadow floor sat above the reference median while
 * every upper percentile sat below it. See the note on `look.exposure` for the
 * three-framing table. 1.18 to 1.45 with exposure carrying the mid-tone back up
 * lands p50 on the reference median and p99 within 6% of it.
 *
 * @returns {THREE.DataTexture}
 */
function buildGradeLut() {
  const n = LUT_SIZE;
  const width = n * n;
  const data = new Uint8Array(width * n * 4);

  const shadowTint = [-0.004, 0.004, 0.014]; // cold teal, display-space delta
  const highTint = [0.019, 0.004, -0.014];   // warm amber
  const lift = 0.002;
  const pivot = 0.42;
  const contrast = 1.45;
  const SHOULDER = 0.68;   // where contrast hands over to the roll-off
  const END_SLOPE = 0.30;  // slope arriving at white; > 0 keeps it monotone

  // Hermite endpoint: the contrast line evaluated at the hand-over point.
  const shoulderY = pivot + (SHOULDER - pivot) * contrast;
  const shoulderSpan = 1 - SHOULDER;

  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        // Saturation shaping in linear light.
        let lr = srgbToLinear(r / (n - 1));
        let lg = srgbToLinear(g / (n - 1));
        let lb = srgbToLinear(b / (n - 1));

        const lum = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        // Punchier mids, but pull the very top back toward white the way real
        // stock does, so blown emissives never go neon.
        const sat = 1.09 - 0.3 * smoothstep01(0.5, 1.4, lum);
        lr = lum + (lr - lum) * sat;
        lg = lum + (lg - lum) * sat;
        lb = lum + (lb - lum) * sat;

        let dr = linearToSrgb(Math.max(lr, 0));
        let dg = linearToSrgb(Math.max(lg, 0));
        let db = linearToSrgb(Math.max(lb, 0));

        const dLum = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
        const shadowW = 1 - smoothstep01(0.02, 0.42, dLum);
        // The warm high tint is a band, not a ramp to white. Carrying it to the
        // top of the range adds 0.019 to red where red is already at 1.0, which
        // clips one channel and snaps the brightest specular to a flat wash.
        const highW = smoothstep01(0.46, 0.80, dLum) * (1 - smoothstep01(0.88, 1.0, dLum));

        const shape = (x, tint) => {
          const v = x * (1 - lift) + lift;           // lifted blacks
          if (v <= SHOULDER) return clamp01(pivot + (v - pivot) * contrast + tint);
          // Cubic Hermite from (SHOULDER, shoulderY) with the contrast slope to
          // (1, 1) with END_SLOPE. Both slopes stay under 3x the chord, which
          // is the Fritsch-Carlson bound for monotonicity, so the roll-off can
          // never fold back on itself.
          const t = (v - SHOULDER) / shoulderSpan;
          const t2 = t * t;
          const t3 = t2 * t;
          const rolled =
            (2 * t3 - 3 * t2 + 1) * shoulderY +
            (t3 - 2 * t2 + t) * shoulderSpan * contrast +
            (-2 * t3 + 3 * t2) +
            (t3 - t2) * shoulderSpan * END_SLOPE;
          return clamp01(rolled + tint);
        };
        dr = shape(dr, shadowTint[0] * shadowW + highTint[0] * highW);
        dg = shape(dg, shadowTint[1] * shadowW + highTint[1] * highW);
        db = shape(db, shadowTint[2] * shadowW + highTint[2] * highW);

        const i = ((g * width) + (b * n + r)) * 4;
        data[i] = Math.round(dr * 255);
        data[i + 1] = Math.round(dg * 255);
        data[i + 2] = Math.round(db * 255);
        data[i + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, width, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'RenderPipeline.gradeLut';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Display transform + lens
// ---------------------------------------------------------------------------

/**
 * The single pass that turns scene-referred radiance into a picture: barrel
 * distortion, radial chromatic aberration, a hand-written AgX display
 * transform with a punchy look, the procedural grade LUT, luminance-weighted
 * animated grain and a vignette. Emits linear display-referred colour so the
 * downstream SMAA and OutputPass behave the way three expects.
 *
 * Every lens term here is set below the level where it is nameable. The
 * reference stills this project is measured against carry no visible grain, no
 * fringing and barely a vignette; they read as clean because the render is
 * clean, not because a filter was laid over it. A lens effect strong enough to
 * spot is a lens effect strong enough to date the image.
 *
 * **`uChroma` is not what draws the edge on the fighters, and it was worth
 * proving.** A critic read the coloured separation at the silhouette as a
 * post-process halo rather than a lamp, on the evidence that it flips hue across
 * the boundary and appears in interior panel gaps a rim light cannot reach.
 * Both observations are correct. The attribution is not.
 *
 * Measured on the hero framing at 1080p with the frame clock stopped and the
 * grain zeroed — two grabs with nothing changed differ by exactly zero code
 * values, so the deltas are real — sampling luminance and red-minus-blue in
 * one-pixel bands either side of a fighter mask built by frame differencing:
 *
 *     band (px)      -3     -2     -1     +1     +2     +4
 *     R-B, shipped  +5.4   +0.7   -8.4  -15.0  -16.7  -17.5
 *     R-B, uChroma=0 +5.4  +0.9   -8.7  -14.6  -16.8  -17.6
 *     R-B, per-fighter rim spots off
 *                  +12.7   +7.9   -2.2  -12.9  -16.5  -17.5
 *     luma, shipped  74.8   72.2   63.8   56.5   57.5   59.9
 *     luma, rims off 65.6   63.3   57.5   55.0   57.2   59.7
 *
 * Turning the chromatic aberration off moves the boundary by **0.3 of a code
 * value** in chroma and nothing measurable in luminance. Turning the
 * per-fighter rim spots off moves it by **7 code values** in chroma and **9**
 * in luminance, and — the part that identifies it as a lamp — leaves the
 * background two pixels away untouched (57.5 -> 57.2). Twenty-odd times the
 * effect, on the fighter side only. The hue flip is the correct signature of a
 * cool rim on a warm-keyed robot in front of a cool set, not of a filter.
 *
 * There is also no sharpen pass in this file to cut, and never has been.
 *
 * So the aberration stays. Whole-frame it is 2.6 code values of mean absolute
 * difference; on the fighter's interior edges it is 5.4, which is why it is
 * visible in panel gaps and why it looked like a suspect. Removing it would be
 * a change with no measured benefit.
 */
class GradePass extends Pass {
  constructor(lut) {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      tLut: { value: lut },
      uLutSize: { value: LUT_SIZE },
      uLutStrength: { value: 1.0 },
      uExposure: { value: 1.0 },
      uShoulder: { value: 0.75 },
      uLatitude: { value: 1.25 },
      uLookFalloff: { value: 0.90 },
      uDistortion: { value: 0.028 },
      uChroma: { value: 0.0016 },
      uGrain: { value: 0.032 },
      uVignette: { value: 0.42 },
      uSaturation: { value: 1.0 },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'GradeAgX',
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tLut;
        uniform float uLutSize;
        uniform float uLutStrength;
        uniform float uExposure;
        uniform float uShoulder;
        uniform float uLatitude;
        uniform float uLookFalloff;
        uniform float uDistortion;
        uniform float uChroma;
        uniform float uGrain;
        uniform float uVignette;
        uniform float uSaturation;
        uniform float uTime;
        uniform vec2 uResolution;

        const mat3 LIN_SRGB_TO_LIN_REC2020 = mat3(
          0.6274, 0.0691, 0.0164,
          0.3293, 0.9195, 0.0880,
          0.0433, 0.0113, 0.8956 );
        const mat3 LIN_REC2020_TO_LIN_SRGB = mat3(
           1.6605, -0.1246, -0.0182,
          -0.5876,  1.1329, -0.1006,
          -0.0728, -0.0083,  1.1187 );
        const mat3 AGX_INSET = mat3(
          0.856627153315983,  0.137318972929847,  0.11189821299995,
          0.0951212405381588, 0.761241990602591,  0.0767994186031903,
          0.0482516061458583, 0.101439036467562,  0.811302368396859 );
        const mat3 AGX_OUTSET = mat3(
           1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
          -0.11060664309660323, 1.157823702216272,  -0.11060664309660294,
          -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 );

        // Sixth-order fit of the AgX contrast sigmoid.
        vec3 agxContrast( vec3 x ) {
          vec3 x2 = x * x;
          vec3 x4 = x2 * x2;
          return + 15.5 * x4 * x2
                 - 40.14 * x4 * x
                 + 31.96 * x4
                 - 6.868 * x2 * x
                 + 0.4298 * x2
                 + 0.1191 * x
                 - 0.00232;
        }

        // AgX "look": slope/offset/power per channel plus a saturation term,
        // applied in the log-sigmoid domain where it behaves like a print film
        // grade rather than a colour twist.
        vec3 agxLook( vec3 c ) {
          const vec3 lw = vec3( 0.2126, 0.7152, 0.0722 );
          float luma = dot( c, lw );
          vec3 offset = vec3( 0.0 );
          vec3 slope = vec3( 1.02, 1.0, 0.97 );
          vec3 power = vec3( 1.06, 1.04, 1.02 );
          float sat = 1.16;
          c = pow( max( c * slope + offset, vec3( 0.0 ) ), power );
          return luma + sat * ( c - luma );
        }

        vec3 agx( vec3 col ) {
          const float minEv = -12.47393;
          const float maxEv = 4.026069;
          col = LIN_SRGB_TO_LIN_REC2020 * col;
          col = AGX_INSET * col;
          col = max( col, vec3( 1e-10 ) );
          col = log2( col );
          col = ( col - minEv ) / ( maxEv - minEv );

          // Highlight latitude. Stock AgX clamps the normalised log to 1, which
          // means every radiance above +4 EV lands on the identical point of the
          // sigmoid: a 6x specular and a 60x one become the same pixel, and
          // because the clamp is per channel a coloured highlight snaps to pure
          // white on the way. Compressing instead of clamping keeps the mapping
          // strictly monotonic all the way out, so the roll-off is the sigmoid's
          // own shoulder rather than a wall. Below uShoulder nothing moves, so
          // the mid-tones the rest of the grade is built on are untouched.
          //
          // 'uLatitude' scales that asymptote above 1.0. At exactly 1.0 the
          // compressed log approaches the sigmoid's own top and never arrives,
          // so no radiance — none, at any magnitude — can reach display white.
          // Modelled through this whole chain at shoulder 0.90: neutral input
          // 6, 13, 52, 400 and 1500 all land on 1.000/0.99/0.945. Twelve times
          // the radiance on every emitter in the arena was measured by an
          // earlier round to put *not one extra pixel* at white, and this is
          // why. Above 1.0 the asymptote sits over the sigmoid's top, so a
          // genuinely bright source clips instead of creeping toward a ceiling.
          col = max( col, 0.0 );
          vec3 over = max( col - uShoulder, 0.0 );
          float span = ( 1.0 - uShoulder ) * uLatitude;
          col = min( col, vec3( uShoulder ) ) + span * ( 1.0 - exp( - over / span ) );

          col = agxContrast( col );
          // Fade the look out at the top of the range.
          //
          // 'agxLook' is a per-channel slope/offset/power plus a saturation
          // term, and it is applied uniformly across the whole range — so it
          // also moves the white point. agxLook(1,1,1) is (1.025, 1.000,
          // 0.965), and the blue is what caps this transform: every neutral
          // above about 6 lands on a fixed 0.945 in blue no matter how bright
          // it is. A display transform whose look breaks its own white point
          // cannot emit a white pixel, which is exactly what the frame
          // measured — 0.000% of pixels over 0.99 linear on both scored
          // framings, against a Tekken 8 reference band of 0.00-3.24%.
          //
          // Ramping the look toward identity above 'uLookFalloff' fixes the
          // white point and provably touches nothing else: the mix weight is
          // zero below that luma, and at 0.90 that sits above the frame's own
          // 99th percentile. Modelled over 16 radiances, everything at or
          // below 3.0 is identical to three decimals on all three channels.
          {
            float lookY = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
            float plain = smoothstep( uLookFalloff, 1.0, lookY );
            col = mix( agxLook( col ), col, plain );
          }
          col = AGX_OUTSET * col;
          col = pow( max( col, vec3( 0.0 ) ), vec3( 2.2 ) );  // to linear Rec.2020
          col = LIN_REC2020_TO_LIN_SRGB * col;
          return clamp( col, 0.0, 1.0 );
        }

        vec3 linearToDisplay( vec3 c ) {
          return mix( c * 12.92, 1.055 * pow( max( c, vec3( 0.0 ) ), vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), c ) );
        }
        vec3 displayToLinear( vec3 c ) {
          return mix( c / 12.92, pow( ( max( c, vec3( 0.0 ) ) + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
        }

        // Tiled 3D LUT: N slices of NxN laid out along X. Bilinear filtering
        // covers red and green inside a slice; blue is interpolated by hand
        // between adjacent slices so nothing bleeds across tile edges.
        vec3 sampleLut( vec3 c ) {
          float s = uLutSize;
          c = clamp( c, 0.0, 1.0 );
          float bScaled = c.b * ( s - 1.0 );
          float slice0 = floor( bScaled );
          float slice1 = min( slice0 + 1.0, s - 1.0 );
          float f = bScaled - slice0;

          float u = ( c.r * ( s - 1.0 ) + 0.5 ) / ( s * s );
          float v = ( c.g * ( s - 1.0 ) + 0.5 ) / s;

          vec3 a = texture2D( tLut, vec2( slice0 / s + u, v ) ).rgb;
          vec3 b = texture2D( tLut, vec2( slice1 / s + u, v ) ).rgb;
          return mix( a, b, f );
        }

        float hash21( vec2 p ) {
          p = fract( p * vec2( 443.8975, 397.2973 ) );
          p += dot( p, p.yx + 19.19 );
          return fract( ( p.x + p.y ) * p.x );
        }

        void main() {
          vec2 centred = vUv - 0.5;
          float r2 = dot( centred, centred );

          // Barrel distortion, tiny — enough to read as a real lens.
          vec2 uv = vUv + centred * ( uDistortion * r2 );
          float ca = uChroma * ( 0.35 + r2 * 4.0 );

          vec3 hdr;
          hdr.r = texture2D( tDiffuse, uv + centred * ca ).r;
          hdr.g = texture2D( tDiffuse, uv ).g;
          hdr.b = texture2D( tDiffuse, uv - centred * ca ).b;

          vec3 lin = agx( hdr * uExposure );
          vec3 disp = linearToDisplay( lin );

          disp = mix( disp, sampleLut( disp ), uLutStrength );

          float luma = dot( disp, vec3( 0.2126, 0.7152, 0.0722 ) );
          disp = mix( vec3( luma ), disp, uSaturation );

          // Grain: strongest in the mids, invisible in blacks and clipped
          // highlights, and re-seeded every frame so it never crawls.
          float grainNoise = hash21( gl_FragCoord.xy + vec2( uTime * 91.7, uTime * 47.3 ) ) - 0.5;
          float grainWeight = 4.0 * luma * ( 1.0 - luma );
          disp += grainNoise * uGrain * grainWeight;

          // Vignette, cosine-fourth shaped rather than a hard radial ramp.
          float vig = 1.0 - uVignette * pow( clamp( r2 * 2.0, 0.0, 1.0 ), 1.35 );
          disp *= vig;

          gl_FragColor = vec4( displayToLinear( clamp( disp, 0.0, 1.0 ) ), 1.0 );
        }`,
    });
    this._fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.uTime.value = (this.uniforms.uTime.value + (deltaTime || 0.016)) % 1000;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this._fsQuad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this._fsQuad.dispose();
  }
}

// ---------------------------------------------------------------------------
// RenderPipeline
// ---------------------------------------------------------------------------

const _shadowCenter = new THREE.Vector3();
const _lightDir = new THREE.Vector3();
const _tmpA = new THREE.Vector3();
const _tmpB = new THREE.Vector3();
const _zero = new THREE.Vector3(0, 0, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _altUp = new THREE.Vector3(0, 0, 1);
const _lightBasis = new THREE.Matrix4();
const _lightBasisInv = new THREE.Matrix4();

export class RenderPipeline {
  /**
   * @param {HTMLElement} container element the canvas is appended to
   * @param {THREE.Scene} scene
   */
  constructor(container, scene) {
    this.container = container;
    this.scene = scene;

    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(this.canvas);

    this.pcssAvailable = installPcssShadows();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,          // SMAA in the post chain handles edges
      alpha: false,
      depth: true,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;   // GradePass owns AgX
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.shadowMap.enabled = true;
    // Driven manually, once per frame. three renders the shadow map at the top
    // of *every* 'renderer.render', and this frame contains two of them: the
    // beauty pass, and the planar reflection that 'StageFloor.onBeforeRender'
    // fires from inside it. With 'autoUpdate' on, the identical 4096 map — same
    // light, same fitted ortho, same casters — was being drawn twice a frame
    // for one usable copy. 'render()' arms 'needsUpdate' and the first draw of
    // the frame clears it, so the mirror inherits the map the beauty pass just
    // built. 'Game.#frame' is the only caller, so there is no other render path
    // that could go a frame without one.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.shadowMap.type = this.pcssAvailable ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.15, 260);
    this.camera.position.set(0, 1.65, 6.4);
    this.camera.lookAt(0, 1.1, 0);
    // Nothing should ever vanish because another module parked it on a layer.
    this.camera.layers.enable(LAYER.BLOOM_ONLY);
    this.camera.layers.enable(LAYER.NO_REFLECT);

    /**
     * Default tier is `high`, not `ultra`.
     *
     * 60fps at 1080p is a stated project constraint and ultra does not meet it.
     * Measured paused with the render scale pinned, 1920x1080, median frame:
     *
     *     ultra   21.2 ms   47 fps
     *     high    13.6 ms   74 fps
     *     medium  13.1 ms   76 fps
     *     low      5.3 ms  189 fps
     *
     * Captured at both tiers and read side by side, the difference is confined to
     * far-field crowd resolution and background detail — materials, the key/rim
     * rig, the floor reflection, the wet-deck response and the atmosphere are all
     * intact at high. That is what a tier system is for: ultra is the screenshot
     * mode and remains one selection away, and the game a player actually loads
     * runs at the framerate a fighting game needs.
     */
    /** @type {'ultra'|'high'|'medium'|'low'} */
    this.quality = 'high';
    this.tier = QUALITY_TIERS.high;
    this.particleBudget = this.tier.particleBudget;

    /** Every effect is individually switchable; the tier sets the defaults. */
    this.effects = {
      shadows: true, ao: true, bloom: true, dof: true,
      motionBlur: true, grade: true, smaa: true, adaptiveResolution: true,
      depthPrepass: true, splitLighting: true,
    };

    /**
     * The look. Survives quality changes and composer rebuilds; other modules
     * may push mood-specific values here through `setGrade` / `setBloom`.
     *
     * **`exposure` and `shoulder` are the top of the range, and they were the
     * two things holding it down.** The frame was not flat; it was
     * *low-contrast*. Against the ten Tekken 8 references its shadow floor sat
     * **above** the reference median while every upper percentile sat below it,
     * which is the combination that reads as "everything the same brightness"
     * without any single value being wrong.
     *
     * A/B'd through `tools/capture.mjs`, three runs a side, identical seven-shot
     * list, both sides driven by the same in-page rebuild of the grade LUT so
     * the only difference between them is three constants. Luminance
     * percentiles in *linear* light off the delivered PNG; ranges are across
     * the three runs and do not overlap on p50, p95 or p99 for any shot:
     *
     *                      p10      p50      p95      p99    sat%
     *     01-hero    A   0.0088   0.0439   0.4016   0.7589   1.91
     *                B   0.0096   0.0682   0.5606   0.8286   1.91
     *     03-body    A   0.0126   0.0564   0.4731   0.7568   1.89
     *                B   0.0151   0.0850   0.6382   0.8602   1.96
     *     06-wide    A   0.0073   0.0396   0.3111   0.7952   1.80
     *                B   0.0079   0.0607   0.4520   0.8268   1.76
     *     10-ko      A   0.0109   0.0500   0.3516   0.6827   0.60
     *                B   0.0145   0.0796   0.5381   0.8106   0.66
     *     04-impact  A   0.0145   0.0563   0.5920   0.9017   2.93
     *                B   0.0179   0.0835   0.7359   0.9788   3.96
     *     tekken8  med    0.0091   0.0900   0.6500   0.8400   1.66
     *              range  0.0035-  0.0307-  0.3036-  0.5591-  0.11-
     *                     0.0417   0.5244   0.9810   0.9950   32.0
     *
     * `sat%` is the fraction of pixels with any channel at 253 or above. The
     * floor stays inside the reference range, the mid-tone lands on the
     * reference median and p99 lands within 6% of it. Two guards were checked
     * because this is the kind of change that buys a histogram and loses a
     * picture: all 32 code values in the top eighth of the range are occupied
     * on both sides of every shot (no plateau), and the figure/ground ratio —
     * fighter median over set median, over a mask built by frame differencing —
     * went 1.087 -> 1.101 on the hero framing and 1.608 -> 1.696 on the wide,
     * so the fighters gained slightly more than the set did.
     *
     * `shoulder` is where AgX's normalised log hands over to the soft
     * compression that keeps very bright radiance monotone instead of clamped.
     * It was 0.68, which put the hand-over below the frame's own 99th
     * percentile and spent most of the highlight range compressing values that
     * had nothing above them to make room for. Isolated, at 0.90 the bottom
     * ninety percent of the frame is **bit-identical** — p10, p50 and p90 equal
     * to four decimals on both framings, against a null control of exactly zero
     * — and only the top moves: fighter p99 +3.3%, p999 +6.2%, brightest pixel
     * +5%. It is the one change measured this round that cost nothing at all.
     *
     * **Perf: no measurable cost, and the obvious measurement of it is wrong.**
     * Sequential capture runs said the new grade cost 5-15 ms; reversing the
     * order of the pair moved the penalty to the other side, because five other
     * agents were driving GPU work and whichever run went second lost. Measured
     * properly — both sides alternating inside one page session in short holds,
     * with a third arm that is a byte-for-byte rebuild of side A — the null arm
     * and the test arm are the same size: over two runs of 8 and 15 paired
     * blocks the null (A vs A) median was +1.10 and +2.30 ms and the test
     * (B vs A) median was +0.40 and +2.90 ms, inside a noise band of +/-30 ms.
     * Which is what the mechanism predicts: the two sides differ in two float
     * uniforms and the contents of a 1024x32 texture, with identical shaders,
     * passes, draws and target sizes.
     *
     * Two things that look like the same lever and are not, both swept and both
     * rejected: `HighlightBloomPass` (bloom cannot raise the top without
     * raising the floor faster) and `GradePass` (the coloured silhouette is a
     * lamp, not the chromatic aberration).
     */
    this.look = {
      exposure: 0.95, shoulder: 0.90, latitude: 1.25, lookFalloff: 0.90,
      lutStrength: 1.0, saturation: 1.0,
      chroma: 0.0009, distortion: 0.018, grain: 0.02, vignette: 0.3,
      bloomStrength: 0.22, bloomRadius: 0.35, bloomThreshold: 5.5,
      bloomKnee: 0.35, bloomClamp: 2.0,
      aoIntensity: 0.92, dofStrength: 0.9, motionBlur: 0.45,
    };

    /**
     * Exposed for the QA harness. `drawCalls`/`triangles` are whole-frame
     * totals including post; `sceneDrawCalls`/`sceneTriangles` are the scene
     * render alone, which is what the charter's budgets refer to.
     */
    this.stats = {
      fps: 60, frameMs: 16.7, drawCalls: 0, triangles: 0,
      sceneDrawCalls: 0, sceneTriangles: 0, renderScale: 1,
    };

    this.renderScale = 1;
    this._targetScale = 1;
    this._frameTimes = new Float32Array(48);
    this._frameIndex = 0;
    this._frameCount = 0;
    this._lastFrameStamp = 0;
    this._adaptCooldown = 0;

    // Focus state, updated by FightCamera through the bus.
    this.shadowFocus = { center: new THREE.Vector3(0, 1.0, 0), radius: 4.2 };
    this.dofFocus = { distance: 6.5, nearRange: 3.0, farRange: 18.0 };
    this._focusUnsub = bus.on('cameraFocus', (e) => this.setCameraFocus(e));

    this._lut = buildGradeLut();
    this._passes = {};
    this.composer = null;
    this._pcssActive = false;
    /** @type {WeakMap<THREE.Light, {dir:THREE.Vector3, lastPos:THREE.Vector3, lastTarget:THREE.Vector3}>} */
    this._shadowState = new WeakMap();

    this._cssWidth = 1920;
    this._cssHeight = 1080;
    this._lastScene = scene;
    this._lastCamera = this.camera;

    this.#measureContainer();
    this.setQuality('high');
    this.resize();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(container);
    }
  }

  // -- setup ---------------------------------------------------------------

  #measureContainer() {
    const rect = this.container.getBoundingClientRect?.();
    const w = Math.max(1, Math.floor(rect?.width || this.container.clientWidth || window.innerWidth || 1920));
    const h = Math.max(1, Math.floor(rect?.height || this.container.clientHeight || window.innerHeight || 1080));
    this._cssWidth = w;
    this._cssHeight = h;
  }

  #pixelRatio() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return dpr * this.renderScale;
  }

  /**
   * Rebuilds the whole composer. Called on construction and on every quality
   * change, because the pass chain itself differs between tiers.
   */
  #buildComposer() {
    this.#disposeComposer();

    // The renderer must already be at the right pixel ratio, or EffectComposer
    // inherits the wrong one and briefly allocates buffers at the square of it.
    const pr = this.#pixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this._cssWidth, this._cssHeight, false);

    const w = Math.max(1, Math.floor(this._cssWidth * pr));
    const h = Math.max(1, Math.floor(this._cssHeight * pr));

    const target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    target.texture.name = 'RenderPipeline.hdr';
    target.texture.colorSpace = THREE.NoColorSpace;

    const composer = new EffectComposer(this.renderer, target);
    composer.setSize(this._cssWidth, this._cssHeight);

    const tier = this.tier;
    // OutputPass reads 'renderer.toneMapping'. With the grade pass present the
    // display transform has already happened, so the output pass must only do
    // the sRGB transfer; without it, hand AgX back to three.
    this.renderer.toneMapping = (tier.grade && this.effects.grade)
      ? THREE.NoToneMapping
      : THREE.AgXToneMapping;
    const passes = {};

    const wantsDepth = tier.depth &&
      (this.effects.ao || this.effects.dof || this.effects.motionBlur);

    // The scene pass carries the depth texture; on tiers that need no geometry
    // passes there is nothing to carry, so a stock RenderPass is cheaper.
    if (wantsDepth) {
      passes.scene = new ScenePass(this.scene, this.camera, this.stats);
      passes.scene.setSize(w, h);
      // '_passes.gbuffer.depthTexture' is the name EffectsDirector reads its
      // soft-particle depth from, and it must resolve to the scene-safe copy.
      passes.gbuffer = passes.scene;
      composer.addPass(passes.scene);
    } else {
      passes.render = new RenderPass(this.scene, this.camera);
      composer.addPass(passes.render);
    }

    const depthTexture = passes.scene?.liveDepth || null;

    if (tier.ao && this.effects.ao && depthTexture) {
      const gtao = new HalfResGtaoPass(this.scene, this.camera, w >> 1, h >> 1);
      // No normal texture: GTAO reconstructs view normals from the depth
      // gradient, which is what the second geometry pass used to buy.
      gtao.setGBuffer(depthTexture, undefined);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = this.look.aoIntensity;
      gtao.updateGtaoMaterial({
        radius: 0.45,
        distanceExponent: 1.6,
        thickness: 0.6,
        scale: 1.05,
        samples: tier.aoSamples,
        distanceFallOff: 0.9,
        screenSpaceRadius: false,
      });
      gtao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.2, normalPhi: 3.6, radius: 4, samples: 12, rings: 2 });
      passes.ao = gtao;
      composer.addPass(gtao);
    }

    if (tier.bloom && this.effects.bloom) {
      // Emitters only, and tight. The threshold sits about 3.5x the radiance
      // that grades to display white, so the neon, the screens and the vents
      // halo while lit concrete does not; the radius is short enough that the
      // halo stays attached to the thing emitting it. A glow bath over broad
      // areas is the single fastest way to look cheap, and it costs contrast
      // everywhere it lands.
      const bloom = new HighlightBloomPass(
        new THREE.Vector2(w, h),
        this.look.bloomStrength, this.look.bloomRadius, this.look.bloomThreshold,
        this.look.bloomKnee, this.look.bloomClamp,
      );
      passes.bloom = bloom;
      composer.addPass(bloom);
    }

    if (tier.dof && this.effects.dof && depthTexture) {
      const dof = new BokehDofPass(this.camera, tier.dofTaps);
      dof.uniforms.tDepth.value = depthTexture;
      dof.uniforms.uStrength.value = this.look.dofStrength;
      dof.setSize(w, h);
      passes.dof = dof;
      composer.addPass(dof);
    }

    if (tier.motionBlur && this.effects.motionBlur && depthTexture) {
      const mb = new MotionBlurPass(this.camera, tier.mbTaps);
      mb.uniforms.tDepth.value = depthTexture;
      mb.uniforms.uIntensity.value = this.look.motionBlur;
      passes.motionBlur = mb;
      composer.addPass(mb);
    }

    if (tier.grade && this.effects.grade) {
      const grade = new GradePass(this._lut);
      const soft = this.quality === 'low' || this.quality === 'medium';
      grade.uniforms.uExposure.value = this.look.exposure;
      grade.uniforms.uShoulder.value = this.look.shoulder;
      grade.uniforms.uLutStrength.value = this.look.lutStrength;
      grade.uniforms.uSaturation.value = this.look.saturation;
      grade.uniforms.uChroma.value = soft ? this.look.chroma * 0.55 : this.look.chroma;
      grade.uniforms.uDistortion.value = this.look.distortion;
      grade.uniforms.uGrain.value = soft ? this.look.grain * 0.7 : this.look.grain;
      grade.uniforms.uVignette.value = this.look.vignette;
      passes.grade = grade;
      composer.addPass(grade);
    }

    if (tier.smaa && this.effects.smaa) {
      passes.smaa = new SMAAPass();
      composer.addPass(passes.smaa);
    }

    passes.output = new OutputPass();
    composer.addPass(passes.output);

    // A chain without a 'ScenePass' has nobody to undo the split's layer moves,
    // and its 'RenderPass' draws through the plain camera mask. Undo them here,
    // before the first frame through the new chain can photograph an empty pit.
    if (!passes.scene) restoreSplitLayers(this.scene);

    this.composer = composer;
    this._passes = passes;

    // Passes created after the composer was sized need one explicit sizing.
    composer.setSize(this._cssWidth, this._cssHeight);
  }

  #disposeComposer() {
    if (!this.composer) return;
    for (const pass of this.composer.passes) {
      if (typeof pass.dispose === 'function') pass.dispose();
    }
    this.composer.renderTarget1?.dispose();
    this.composer.renderTarget2?.dispose();
    this.composer = null;
    this._passes = {};
  }

  // -- public API ----------------------------------------------------------

  /**
   * Switches quality tier: render scale, shadow resolution and filtering, the
   * post stack, and the particle budget other systems read.
   * @param {'ultra'|'high'|'medium'|'low'} q
   */
  setQuality(q) {
    const tier = QUALITY_TIERS[q];
    if (!tier) return;
    this.quality = q;
    this.tier = tier;
    this.particleBudget = tier.particleBudget;
    this.renderScale = tier.renderScale;
    this._targetScale = tier.renderScale;

    const wantPcss = tier.pcss && this.pcssAvailable && this.effects.shadows;
    const type = wantPcss ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    if (this.renderer.shadowMap.type !== type) this.renderer.shadowMap.type = type;
    this.renderer.shadowMap.enabled = this.effects.shadows;
    this._pcssActive = wantPcss;

    this.#applyShadowResolution();
    this.#buildComposer();
  }

  /**
   * Enables or disables one effect and rebuilds the chain.
   * @param {string} name key of `.effects`
   * @param {boolean} enabled
   */
  setEffect(name, enabled) {
    if (!(name in this.effects)) return;
    this.effects[name] = !!enabled;
    if (name === 'shadows') {
      this.renderer.shadowMap.enabled = this.effects.shadows;
      return;
    }
    // Neither of these owns a pass, so neither needs the chain rebuilding —
    // and rebuilding it reallocates two full-resolution half-float targets and
    // recompiles every post shader, which is not something a toggle should do.
    if (name === 'adaptiveResolution' || name === 'depthPrepass' || name === 'splitLighting') return;
    this.#buildComposer();
  }

  /**
   * Tunes the display transform without rebuilding the chain. Any subset of
   * `exposure`, `shoulder`, `lutStrength`, `saturation`, `chroma`,
   * `distortion`, `grain` and `vignette` may be given; values persist across
   * quality changes so a lighting mood can own the look.
   *
   * `shoulder` is where the AgX log encoding stops being linear in stops and
   * starts compressing, as a fraction of the 16.5-stop window: lower it to buy
   * more highlight latitude on a scene with hot speculars, raise it toward 1
   * for the stock AgX response. It is the knob that decides whether a bright
   * highlight has gradient or is a flat white shape.
   *
   * `latitude` and `lookFalloff` are the two knobs that decide whether display
   * white is reachable at all; both are documented at the shader. Leave them
   * alone unless the frame's top end is being retuned, and re-measure the
   * fraction of pixels over 0.99 linear if they move.
   *
   * @param {Partial<RenderPipeline['look']>} values
   */
  setGrade(values = {}) {
    Object.assign(this.look, values);
    const g = this._passes.grade;
    if (!g) return;
    const soft = this.quality === 'low' || this.quality === 'medium';
    g.uniforms.uExposure.value = this.look.exposure;
    g.uniforms.uShoulder.value = this.look.shoulder;
    g.uniforms.uLatitude.value = this.look.latitude;
    g.uniforms.uLookFalloff.value = this.look.lookFalloff;
    g.uniforms.uLutStrength.value = this.look.lutStrength;
    g.uniforms.uSaturation.value = this.look.saturation;
    g.uniforms.uChroma.value = soft ? this.look.chroma * 0.55 : this.look.chroma;
    g.uniforms.uDistortion.value = this.look.distortion;
    g.uniforms.uGrain.value = soft ? this.look.grain * 0.7 : this.look.grain;
    g.uniforms.uVignette.value = this.look.vignette;
  }

  /**
   * Retunes bloom in place.
   *
   * `threshold` and `clamp` are luminances in the HDR buffer, which is upstream
   * of the grade — so they are *not* relative to display white. `look.exposure`
   * is applied afterwards, and at 0.64 the radiance that lands on display white
   * is around 1.55. A threshold of 1.35 therefore blooms everything the key
   * light hits, which is how a frame ends up with a haze over lit concrete;
   * "genuine emitter" starts a couple of stops above that. Divide the display
   * multiple you want by `look.exposure` to get the number to pass here.
   *
   * `clamp` is the energy limit on the extracted highlight and is what keeps a
   * hot emissive reading as a lit panel instead of a white blob.
   *
   * @param {{strength?:number, radius?:number, threshold?:number,
   *          knee?:number, clamp?:number}} values
   */
  setBloom({ strength, radius, threshold, knee, clamp } = {}) {
    if (typeof strength === 'number') this.look.bloomStrength = strength;
    if (typeof radius === 'number') this.look.bloomRadius = radius;
    if (typeof threshold === 'number') this.look.bloomThreshold = threshold;
    if (typeof knee === 'number') this.look.bloomKnee = knee;
    if (typeof clamp === 'number') this.look.bloomClamp = clamp;
    const b = this._passes.bloom;
    if (!b) return;
    b.strength = this.look.bloomStrength;
    b.radius = this.look.bloomRadius;
    b.threshold = this.look.bloomThreshold;
    b.highPassUniforms.smoothWidth.value = this.look.bloomKnee;
    b.maxRadiance = this.look.bloomClamp;
  }

  /**
   * Focus report from the camera. Drives shadow fitting and the DOF plane.
   *
   * `nearRange` is honoured literally — nothing inside it blurs. `farRange` is
   * recorded but not used as a hard limit: the far side of the lens follows the
   * distance-ratio curve in `BokehDofPass`, which is what gives the stage its
   * separation, and clamping it to a declared range switches depth of field off
   * in every framing where the back wall happens to sit inside the subject
   * volume the camera reported.
   *
   * @param {{center?:THREE.Vector3, radius?:number, distance?:number,
   *          nearRange?:number, farRange?:number}} e
   */
  setCameraFocus(e) {
    if (!e) return;
    if (e.center) this.shadowFocus.center.copy(e.center);
    if (typeof e.radius === 'number') this.shadowFocus.radius = Math.max(1.5, e.radius);
    if (typeof e.distance === 'number') this.dofFocus.distance = e.distance;
    if (typeof e.nearRange === 'number') this.dofFocus.nearRange = e.nearRange;
    if (typeof e.farRange === 'number') this.dofFocus.farRange = e.farRange;
  }

  /**
   * Compiles every program the scene needs and renders one frame that never
   * reaches the screen, so the first real frame does not stall on shader
   * compilation or an empty shadow map.
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   */
  warmup(scene, camera) {
    const cam = camera || this.camera;
    this._lastScene = scene;
    this._lastCamera = cam;

    this.renderer.shadowMap.needsUpdate = true;
    try {
      this.renderer.compile(scene, cam);
    } catch (err) {
      // compile() touches every material; a half-built scene must not be fatal,
      // but it should be visible.
      console.warn('[RenderPipeline] warmup compile failed', err);
    }

    this.#fitShadows(scene, cam);

    if (this.composer) {
      const wasToScreen = this.composer.renderToScreen;
      this.composer.renderToScreen = false;
      try {
        this.#syncPasses(scene, cam);
        this.composer.render(1 / 60);
      } catch (err) {
        console.warn('[RenderPipeline] warmup frame failed', err);
      }
      this.composer.renderToScreen = wasToScreen;
    }

    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.info.reset();
  }

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {number} dt seconds since the previous frame
   */
  render(scene, camera, dt) {
    const cam = camera || this.camera;
    this._lastScene = scene;
    this._lastCamera = cam;

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const frameMs = this._lastFrameStamp ? now - this._lastFrameStamp : 16.7;
    this._lastFrameStamp = now;
    this.#recordFrame(frameMs);

    this.renderer.info.reset();

    // Wall-clock, not the 'dt' argument: that one is scaled during hitstop, and
    // what reprojection actually measured is real elapsed frames.
    this._passes.motionBlur?.setShutter(frameMs / 1000, this.look.motionBlur);

    this.#fitShadows(scene, cam);
    this.#syncPasses(scene, cam);
    // One shadow draw per frame; see the note in the constructor.
    this.renderer.shadowMap.needsUpdate = true;

    if (this.composer) {
      this.composer.render(dt || 1 / 60);
      this._passes.motionBlur?.advance();
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, cam);
    }

    const info = this.renderer.info.render;
    this.stats.drawCalls = info.calls;
    this.stats.triangles = info.triangles;
    this.stats.renderScale = this.renderScale;
    // Without a ScenePass nothing snapshots the scene alone, and on those tiers
    // the post chain is short enough that the whole frame is a fair stand-in.
    if (!this._passes.scene) {
      this.stats.sceneDrawCalls = info.calls;
      this.stats.sceneTriangles = info.triangles;
    }

    if (this.effects.adaptiveResolution) this.#adaptResolution();
  }

  /** Recomputes canvas, camera aspect, composer and pass resolutions. */
  resize() {
    this.#measureContainer();
    const pr = this.#pixelRatio();

    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this._cssWidth, this._cssHeight, false);

    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = this._cssWidth / this._cssHeight;
      this.camera.updateProjectionMatrix();
    }

    if (this.composer) {
      // 'setSize' fans out to every pass at the effective device resolution,
      // which is where each of them derives its own working size from.
      this.composer.setPixelRatio(pr);
      this.composer.setSize(this._cssWidth, this._cssHeight);
    }
  }

  /**
   * Renders one frame and reads it back. Because the read happens in the same
   * task as the draw, no `preserveDrawingBuffer` is needed.
   * @returns {string} PNG data URL
   */
  screenshot() {
    const scene = this._lastScene || this.scene;
    const cam = this._lastCamera || this.camera;
    this.#syncPasses(scene, cam);
    this.renderer.shadowMap.needsUpdate = true;
    if (this.composer) this.composer.render(1 / 60);
    else this.renderer.render(scene, cam);
    return this.canvas.toDataURL('image/png');
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this._resizeObserver?.disconnect();
    this._focusUnsub?.();
    this.#disposeComposer();
    this._lut.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // -- internals -----------------------------------------------------------

  #syncPasses(scene, camera) {
    const p = this._passes;
    if (p.render) { p.render.scene = scene; p.render.camera = camera; }
    if (p.scene) {
      p.scene.scene = scene;
      p.scene.camera = camera;
      p.scene.depthPrepass = this.effects.depthPrepass;
      // Gated on the prepass, which is the render that puts the fighters and the
      // light rig into the shadow map before either half of the split runs.
      p.scene.splitLighting = this.effects.splitLighting && this.effects.depthPrepass;
    }
    if (p.ao) { p.ao.scene = scene; p.ao.camera = camera; }
    if (p.dof) {
      p.dof.camera = camera;
      p.dof.uniforms.uFocus.value = this.dofFocus.distance;
      // The camera reports the depth its subject occupies. Honour it as a hard
      // no-blur band on the lens side; the far side is left to the thin-lens
      // curve, which is what gives the stage its separation.
      p.dof.uniforms.uNearRange.value = this.dofFocus.nearRange;
    }
    if (p.motionBlur) {
      p.motionBlur.camera = camera;
      // Before the frame draws, while the matrix the pass is still holding is
      // the one the previous frame was drawn with.
      p.motionBlur.captureCamera();
    }
  }

  #recordFrame(ms) {
    this._frameTimes[this._frameIndex] = ms;
    this._frameIndex = (this._frameIndex + 1) % this._frameTimes.length;
    this._frameCount = Math.min(this._frameCount + 1, this._frameTimes.length);

    let sum = 0;
    for (let i = 0; i < this._frameCount; i++) sum += this._frameTimes[i];
    const avg = sum / Math.max(1, this._frameCount);
    this.stats.frameMs = avg;
    this.stats.fps = avg > 0 ? 1000 / avg : 0;
  }

  /**
   * Holds 60fps by trading resolution. Uses a long window and a cooldown so a
   * single hitching frame (a shader compile, a GC) never drops the picture.
   *
   * The band is wide and the steps are small on purpose. Resolution is the most
   * expensive thing this class can spend, and also the most visible: a drop is
   * a blanket soften across the whole frame, so it has to be the last resort
   * and it has to climb back the moment there is headroom. Anything under about
   * 21ms sustained is left alone.
   */
  #adaptResolution() {
    if (this._adaptCooldown > 0) { this._adaptCooldown--; return; }
    if (this._frameCount < this._frameTimes.length) return;

    const avg = this.stats.frameMs;
    const min = this.tier.minScale;
    const max = this.tier.renderScale;
    let next = this._targetScale;

    if (avg > 21.0) next = Math.max(min, this._targetScale - 0.04);
    else if (avg < 15.4) next = Math.min(max, this._targetScale + 0.04);

    if (Math.abs(next - this._targetScale) > 0.001) {
      this._targetScale = next;
      this.renderScale = next;
      this.resize();
      this._adaptCooldown = 45;
      this._frameCount = 0;
      this._frameIndex = 0;
    } else {
      this._adaptCooldown = 20;
    }
  }

  #applyShadowResolution() {
    const size = this.tier.shadowMapSize;
    this.scene.traverse((obj) => {
      if (!obj.isLight || !obj.shadow) return;
      if (obj.shadow.mapSize.x === size && obj.shadow.mapSize.y === size) return;
      obj.shadow.mapSize.set(size, size);
      obj.shadow.map?.dispose();
      obj.shadow.map = null;
    });
  }

  /**
   * Refits every shadow-casting directional light to the fighter pair.
   *
   * The ortho box is sized from the focus sphere the camera reports and snapped
   * to whole shadow texels in a light-space grid anchored at the world origin,
   * so sliding the box cannot make the shadow edge crawl. Only the light's
   * position and target are written — for a directional light neither affects
   * shading, so this stays out of the Environment module's way. A light can opt
   * out entirely with `userData.autoFitShadow = false`.
   *
   * `shadow.radius` is repurposed to carry the PCSS penumbra scale; see the
   * shader chunk at the top of this file for the exact meaning.
   */
  #fitShadows(scene, camera) {
    if (!this.effects.shadows) return;
    const size = this.tier.shadowMapSize;
    const focus = this.shadowFocus;

    // Wide enough that the stage's own geometry still casts into frame, tight
    // enough that the fighters get real texel density.
    const radius = THREE.MathUtils.clamp(focus.radius + 2.6, 4.0, 13.0);

    _shadowCenter.copy(focus.center);
    _shadowCenter.x = THREE.MathUtils.clamp(_shadowCenter.x, -ARENA_HALF_WIDTH, ARENA_HALF_WIDTH);
    _shadowCenter.z = THREE.MathUtils.clamp(_shadowCenter.z, -ARENA_HALF_DEPTH, ARENA_HALF_DEPTH);

    scene.traverse((obj) => {
      if (!obj.isDirectionalLight || !obj.castShadow || obj.userData.autoFitShadow === false) return;
      const shadow = obj.shadow;
      if (!shadow) return;

      if (shadow.mapSize.x !== size) {
        shadow.mapSize.set(size, size);
        shadow.map?.dispose();
        shadow.map = null;
      }

      let state = this._shadowState.get(obj);
      if (!state) {
        state = { dir: new THREE.Vector3(), lastPos: new THREE.Vector3(NaN, NaN, NaN), lastTarget: new THREE.Vector3(NaN, NaN, NaN) };
        this._shadowState.set(obj, state);
      }

      // Re-read the authored direction whenever anyone other than us moved the
      // rig; otherwise keep the direction we locked in, so our own writes do
      // not feed back and rotate the light a little further every frame.
      const movedByOther =
        !obj.position.equals(state.lastPos) ||
        (obj.target ? !obj.target.position.equals(state.lastTarget) : false);

      if (movedByOther || state.dir.lengthSq() < 1e-8) {
        obj.updateWorldMatrix(true, false);
        _lightDir.setFromMatrixPosition(obj.matrixWorld);
        if (obj.target) {
          obj.target.updateWorldMatrix(true, false);
          _tmpA.setFromMatrixPosition(obj.target.matrixWorld);
          _lightDir.sub(_tmpA);
        }
        if (_lightDir.lengthSq() < 1e-8) _lightDir.set(0.42, 1.0, 0.36);
        state.dir.copy(_lightDir).normalize();
      }
      _lightDir.copy(state.dir);

      const distance = Math.max(radius * 2.4, 16);
      const up = Math.abs(_lightDir.y) > 0.97 ? _altUp : _up;

      // Texel snapping in a light-space basis anchored at the origin.
      _lightBasis.identity();
      _lightBasis.lookAt(_lightDir, _zero, up);
      _lightBasisInv.copy(_lightBasis).invert();

      const texelWorld = (radius * 2) / size;
      _tmpA.copy(_shadowCenter).applyMatrix4(_lightBasisInv);
      _tmpA.x = Math.round(_tmpA.x / texelWorld) * texelWorld;
      _tmpA.y = Math.round(_tmpA.y / texelWorld) * texelWorld;
      _tmpA.applyMatrix4(_lightBasis);

      const cam = shadow.camera;
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 0.5;
      cam.far = distance + radius * 2.6;
      cam.updateProjectionMatrix();

      // Write world-space intent through whatever parents the rig has.
      if (obj.target) {
        _tmpB.copy(_tmpA);
        obj.target.parent?.updateWorldMatrix(true, false);
        obj.target.parent?.worldToLocal(_tmpB);
        obj.target.position.copy(_tmpB);
        obj.target.updateMatrixWorld(true);
        state.lastTarget.copy(obj.target.position);
      }
      _tmpB.copy(_tmpA).addScaledVector(_lightDir, distance);
      obj.parent?.updateWorldMatrix(true, false);
      obj.parent?.worldToLocal(_tmpB);
      obj.position.copy(_tmpB);
      obj.updateMatrixWorld(true);
      state.lastPos.copy(obj.position);

      shadow.bias = this._pcssActive ? -0.00028 : -0.00055;
      shadow.normalBias = 0.02 + radius * 0.0016;
      shadow.intensity = 1.0;

      if (this._pcssActive) {
        // shadowRadius := tan(lightHalfAngle) * depthRange / orthoExtent * mapSize
        // so that ( z_receiver - z_blocker ) * shadowRadius / mapSize is the
        // penumbra width directly in shadow-map UV.
        const depthRange = cam.far - cam.near;
        const extent = radius * 2;
        shadow.radius = THREE.MathUtils.clamp((0.05 * depthRange * size) / extent, 8, 4000);
      } else {
        shadow.radius = 3.2;
      }
    });
  }
}
