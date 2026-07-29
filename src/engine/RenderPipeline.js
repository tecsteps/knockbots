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
 *    while post is active, because bloom, SSR, DOF and motion blur are only
 *    correct on un-tonemapped radiance. The display transform lives in
 *    `GradePass`: a hand-written AgX (log-encode -> sigmoid -> look -> outset).
 *    AgX is used rather than ACES because ACES over-saturates and hue-shifts
 *    exactly the things this game is made of — coloured emissives on metal —
 *    while AgX desaturates into the highlight and keeps the hue path straight.
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
 * 3. **G-buffer**. One depth+view-normal prepass feeds GTAO, the wet-floor SSR,
 *    depth of field and the motion blur reprojection. Every one of those would
 *    otherwise render the scene again on its own.
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
import { ARENA_HALF_WIDTH, ARENA_HALF_DEPTH, GROUND_Y, LAYER } from '../core/Constants.js';

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
  THREE.ShaderChunk.shadowmap_pars_fragment = buildPcssChunk(16, 24);
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
 * @property {boolean} gbuffer
 * @property {boolean} ao
 * @property {boolean} ssr
 * @property {boolean} bloom
 * @property {boolean} dof
 * @property {boolean} motionBlur
 * @property {boolean} grade
 * @property {boolean} smaa
 * @property {number} particleBudget
 */

/** @type {Record<string, QualityTier>} */
export const QUALITY_TIERS = {
  ultra: {
    renderScale: 1.0, minScale: 0.75, shadowMapSize: 4096, pcss: true,
    gbuffer: true, ao: true, aoSamples: 16, ssr: true, ssrSteps: 32,
    bloom: true, dof: true, dofTaps: 28, motionBlur: true, mbTaps: 12,
    grade: true, smaa: true, particleBudget: 1.0,
  },
  high: {
    renderScale: 0.95, minScale: 0.68, shadowMapSize: 2560, pcss: true,
    gbuffer: true, ao: true, aoSamples: 11, ssr: true, ssrSteps: 20,
    bloom: true, dof: true, dofTaps: 18, motionBlur: true, mbTaps: 8,
    grade: true, smaa: true, particleBudget: 0.8,
  },
  medium: {
    renderScale: 0.85, minScale: 0.6, shadowMapSize: 1536, pcss: false,
    gbuffer: false, ao: false, aoSamples: 8, ssr: false, ssrSteps: 12,
    bloom: true, dof: false, dofTaps: 12, motionBlur: false, mbTaps: 6,
    grade: true, smaa: true, particleBudget: 0.5,
  },
  low: {
    renderScale: 0.7, minScale: 0.6, shadowMapSize: 1024, pcss: false,
    gbuffer: false, ao: false, aoSamples: 6, ssr: false, ssrSteps: 8,
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
// G-buffer prepass
// ---------------------------------------------------------------------------

/**
 * Renders the opaque scene once with `MeshNormalMaterial` to produce packed
 * view-space normals plus a real depth attachment. Everything downstream that
 * needs geometry (AO, SSR, DOF, motion blur) reads this instead of rendering
 * the scene again.
 */
class DepthNormalPass extends Pass {
  constructor(scene, camera) {
    super();
    this.needsSwap = false;
    this.scene = scene;
    this.camera = camera;

    this.normalMaterial = new THREE.MeshNormalMaterial();
    this.normalMaterial.blending = THREE.NoBlending;

    const depth = new THREE.DepthTexture(1, 1);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.FloatType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;

    this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.renderTarget.texture.name = 'RenderPipeline.viewNormal';
    this.renderTarget.depthTexture = depth;

    this._hidden = [];
    this._clearColor = new THREE.Color();
  }

  get depthTexture() { return this.renderTarget.depthTexture; }
  get normalTexture() { return this.renderTarget.texture; }

  setSize(width, height) {
    this.renderTarget.setSize(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  }

  /**
   * Transparent, additive and non-mesh objects (particles, trails, decal
   * sprites) must not write geometry, or AO and SSR read a fog of fake
   * surfaces sitting in mid-air.
   */
  #hideNonGeometry() {
    this._hidden.length = 0;
    this.scene.traverse((obj) => {
      if (!obj.visible) return;
      const isRenderable = obj.isMesh || obj.isSkinnedMesh || obj.isInstancedMesh;
      const excluded =
        obj.isPoints || obj.isLine || obj.isLineSegments || obj.isSprite ||
        obj.userData.gbuffer === false ||
        (isRenderable && obj.material && !Array.isArray(obj.material) &&
          (obj.material.transparent === true || obj.material.depthWrite === false));
      if (excluded) {
        obj.visible = false;
        this._hidden.push(obj);
      }
    });
  }

  #restore() {
    for (const obj of this._hidden) obj.visible = true;
    this._hidden.length = 0;
  }

  render(renderer) {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevBackground = this.scene.background;
    const prevOverride = this.scene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    renderer.getClearColor(this._clearColor);
    const prevAlpha = renderer.getClearAlpha();

    this.#hideNonGeometry();
    this.scene.background = null;
    this.scene.overrideMaterial = this.normalMaterial;

    // The main RenderPass already refreshed the shadow maps this frame. Skip
    // them here without touching `shadowMap.enabled`, which would change the
    // USE_SHADOWMAP define and recompile every material.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;

    renderer.autoClear = true;
    // 0.5,0.5,1 unpacks to a flat +Z view normal, the safest default for sky.
    renderer.setClearColor(0x8080ff, 1);
    renderer.setRenderTarget(this.renderTarget);
    renderer.render(this.scene, this.camera);

    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBackground;
    this.#restore();

    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    renderer.setClearColor(this._clearColor, prevAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    this.renderTarget.depthTexture?.dispose();
    this.renderTarget.dispose();
    this.normalMaterial.dispose();
  }
}

// ---------------------------------------------------------------------------
// Screen-space reflections, restricted to the wet floor
// ---------------------------------------------------------------------------

/**
 * A full-scene SSR would cost more than it returns on a stage made of matte
 * industrial metal. The one surface that genuinely needs it is the polished wet
 * floor, so this pass masks strictly to upward-facing geometry near the floor
 * plane and spends its whole ray budget there: linear march in view space with
 * geometric step growth, four-step binary refinement, thickness rejection, and
 * Fresnel-weighted energy so grazing angles mirror and steep angles barely
 * reflect at all.
 */
class WetFloorSsrPass extends Pass {
  constructor(camera, steps = 28) {
    super();
    this.camera = camera;
    this.uniforms = {
      tDiffuse: { value: null },
      tDepth: { value: null },
      tNormal: { value: null },
      uInvProjection: { value: new THREE.Matrix4() },
      uProjection: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uNear: { value: 0.1 },
      uFar: { value: 200 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uFloorY: { value: GROUND_Y },
      uSlab: { value: 0.55 },
      uIntensity: { value: 0.62 },
      uMaxDistance: { value: 14.0 },
      uThickness: { value: 0.35 },
      uFrame: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'WetFloorSSR',
      defines: { SSR_STEPS: steps },
      uniforms: this.uniforms,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform highp sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform mat4 uProjection;
        uniform mat4 uCameraWorld;
        uniform vec2 uResolution;
        uniform float uFloorY;
        uniform float uSlab;
        uniform float uIntensity;
        uniform float uMaxDistance;
        uniform float uThickness;
        uniform float uFrame;
        ${DEPTH_HELPERS}

        void main() {
          vec3 base = texture2D( tDiffuse, vUv ).rgb;
          float depth = texture2D( tDepth, vUv ).x;
          if ( depth >= 1.0 ) { gl_FragColor = vec4( base, 1.0 ); return; }

          vec3 viewPos = viewPosFromDepth( vUv, depth );
          vec3 viewNormal = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );

          vec3 worldPos = ( uCameraWorld * vec4( viewPos, 1.0 ) ).xyz;
          vec3 worldNormal = normalize( ( uCameraWorld * vec4( viewNormal, 0.0 ) ).xyz );

          float heightMask = 1.0 - smoothstep( uFloorY + uSlab * 0.5, uFloorY + uSlab, worldPos.y );
          float facingMask = smoothstep( 0.72, 0.94, worldNormal.y );
          float mask = heightMask * facingMask;
          if ( mask <= 0.002 ) { gl_FragColor = vec4( base, 1.0 ); return; }

          vec3 viewDir = normalize( viewPos );
          vec3 rayDir = normalize( reflect( viewDir, viewNormal ) );

          // Dither the ray origin along the reflection so the marching pattern
          // breaks up instead of banding.
          float jitter = ign( gl_FragCoord.xy + vec2( uFrame * 5.588238, uFrame * 3.141593 ) );
          float stepLen = uMaxDistance / float( SSR_STEPS );

          vec3 p = viewPos + viewNormal * 0.015 + rayDir * stepLen * ( 0.35 + jitter * 0.65 );
          vec3 prev = p;
          vec2 hitUv = vec2( -1.0 );
          float travelled = 0.0;

          for ( int i = 0; i < SSR_STEPS; i ++ ) {
            prev = p;
            // Gentle geometric growth. Steeper growth bands badly, because the
            // thickness test starts missing thin geometry between samples.
            float grow = 1.0 + float( i ) * 0.05;
            float advance = stepLen * grow;
            p += rayDir * advance;
            travelled += advance;

            vec4 clip = uProjection * vec4( p, 1.0 );
            if ( clip.w <= 0.0 ) break;
            vec2 suv = ( clip.xy / clip.w ) * 0.5 + 0.5;
            if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) break;

            float sd = texture2D( tDepth, suv ).x;
            if ( sd >= 1.0 ) continue;
            vec3 scenePos = viewPosFromDepth( suv, sd );
            float diff = scenePos.z - p.z;

            // Accept a surface as a hit if the ray passed behind it by less
            // than one step's worth of depth, so a coarse march cannot tunnel
            // through a thin object and leave a dashed reflection.
            float thick = uThickness + advance * 0.75;
            if ( diff > 0.0 && diff < thick ) {
              // Binary refine between the last miss and this hit.
              vec3 lo = prev;
              vec3 hi = p;
              for ( int k = 0; k < 4; k ++ ) {
                vec3 mid = ( lo + hi ) * 0.5;
                vec4 mc = uProjection * vec4( mid, 1.0 );
                vec2 muv = ( mc.xy / mc.w ) * 0.5 + 0.5;
                float md = texture2D( tDepth, muv ).x;
                vec3 mp = viewPosFromDepth( muv, md );
                if ( mp.z - mid.z > 0.0 ) hi = mid; else lo = mid;
              }
              vec4 fc = uProjection * vec4( hi, 1.0 );
              hitUv = ( fc.xy / fc.w ) * 0.5 + 0.5;
              break;
            }
          }

          if ( hitUv.x < 0.0 ) { gl_FragColor = vec4( base, 1.0 ); return; }

          vec3 reflected = texture2D( tDiffuse, hitUv ).rgb;

          // Fades: screen border, ray length, and rays that head back at the eye.
          vec2 edge = abs( hitUv - 0.5 ) * 2.0;
          float edgeFade = ( 1.0 - smoothstep( 0.72, 1.0, edge.x ) ) * ( 1.0 - smoothstep( 0.78, 1.0, edge.y ) );
          float distFade = 1.0 - smoothstep( 0.55, 1.0, travelled / uMaxDistance );
          float backFade = 1.0 - smoothstep( 0.0, 0.55, rayDir.z );

          float cosTheta = clamp( dot( -viewDir, viewNormal ), 0.0, 1.0 );
          float fresnel = 0.03 + 0.97 * pow( 1.0 - cosTheta, 5.0 );

          float weight = mask * edgeFade * distFade * backFade * uIntensity * clamp( fresnel * 6.0, 0.06, 1.0 );
          gl_FragColor = vec4( base + reflected * weight, 1.0 );
        }`,
    });
    this._fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.uProjection.value.copy(cam.projectionMatrix);
    this.uniforms.uInvProjection.value.copy(cam.projectionMatrixInverse);
    this.uniforms.uCameraWorld.value.copy(cam.matrixWorld);
    this.uniforms.uNear.value = cam.near;
    this.uniforms.uFar.value = cam.far;
    this.uniforms.uFrame.value = (this.uniforms.uFrame.value + 1) % 1024;

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
// Depth of field
// ---------------------------------------------------------------------------

/**
 * Circle-of-confusion driven bokeh. Gathers on a golden-angle disc and weights
 * every tap by whether that tap's own blur circle actually reaches the centre
 * pixel, which is what stops sharp foreground silhouettes from smearing into
 * defocused background. Kept deliberately subtle: the fighters stay crisp and
 * only the stage separates.
 */
class BokehDofPass extends Pass {
  constructor(camera, taps = 24) {
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
      uFarRange: { value: 18.0 },
      uMaxRadius: { value: 7.0 },
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
        uniform float uFarRange;
        uniform float uMaxRadius;
        uniform float uStrength;
        ${DEPTH_HELPERS}

        float cocAt( vec2 uv ) {
          float d = texture2D( tDepth, uv ).x;
          float z = ( d >= 1.0 ) ? uFar : linearDepth( d );
          float delta = z - uFocus;
          float range = delta < 0.0 ? uNearRange : uFarRange;
          return clamp( delta / max( range, 0.001 ), -1.0, 1.0 );
        }

        void main() {
          vec3 centre = texture2D( tDiffuse, vUv ).rgb;
          float coc = cocAt( vUv );
          float blend = smoothstep( 0.05, 0.35, abs( coc ) ) * uStrength;
          if ( blend <= 0.003 ) { gl_FragColor = vec4( centre, 1.0 ); return; }

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
            // A tap only lights this pixel if its own bokeh circle covers it.
            float w = clamp( tapRadius - dist + 1.0, 0.0, 1.0 );
            // Near-field taps scatter forward, so let them always contribute.
            w = max( w, tapCoc < -0.02 ? clamp( tapRadius - dist + 1.0, 0.0, 1.0 ) : 0.0 );
            sum += texture2D( tDiffuse, uv ).rgb * w;
            wsum += w;
          }

          gl_FragColor = vec4( mix( centre, sum / wsum, blend ), 1.0 );
        }`,
    });
    this._fsQuad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
    // Keep the bokeh disc a constant fraction of the frame, not of the pixels.
    this.uniforms.uMaxRadius.value = Math.max(3, height * 0.0058);
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
// Motion blur
// ---------------------------------------------------------------------------

/**
 * Camera-velocity motion blur by depth reprojection: unproject each pixel with
 * the current inverse view-projection, reproject with last frame's, and smear
 * along the resulting screen-space delta. The fight camera whips, punches in
 * and orbits, so this carries most of the motion the eye reads; per-object
 * velocity would need a velocity buffer written by every skinned material,
 * which is not this module's to touch.
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
      uIntensity: { value: 0.55 },
      uMaxRadius: { value: 0.018 },
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

  /** Called once per frame after the composer has finished with this camera. */
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
 * @returns {THREE.DataTexture}
 */
function buildGradeLut() {
  const n = LUT_SIZE;
  const width = n * n;
  const data = new Uint8Array(width * n * 4);

  const shadowTint = [-0.006, 0.007, 0.027]; // cold teal, display-space delta
  const highTint = [0.021, 0.005, -0.015];   // warm amber
  const lift = 0.011;
  const pivot = 0.45;
  const contrast = 1.08;

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
        const highW = smoothstep01(0.5, 0.97, dLum);

        const shape = (x, tint) => {
          let v = x * (1 - lift) + lift;             // lifted blacks
          v = pivot + (v - pivot) * contrast;        // contrast pivot
          v -= 0.05 * smoothstep01(0.7, 1.0, v);     // crushed highs
          return clamp01(v + tint);
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
          col = clamp( col, 0.0, 1.0 );
          col = agxContrast( col );
          col = agxLook( col );
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
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.shadowMap.type = this.pcssAvailable ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.15, 260);
    this.camera.position.set(0, 1.65, 6.4);
    this.camera.lookAt(0, 1.1, 0);
    // Nothing should ever vanish because another module parked it on a layer.
    this.camera.layers.enable(LAYER.BLOOM_ONLY);
    this.camera.layers.enable(LAYER.NO_REFLECT);

    /** @type {'ultra'|'high'|'medium'|'low'} */
    this.quality = 'ultra';
    this.tier = QUALITY_TIERS.ultra;
    this.particleBudget = this.tier.particleBudget;

    /** Every effect is individually switchable; the tier sets the defaults. */
    this.effects = {
      shadows: true, ao: true, ssr: true, bloom: true, dof: true,
      motionBlur: true, grade: true, smaa: true, adaptiveResolution: true,
    };

    /**
     * The look. Survives quality changes and composer rebuilds; other modules
     * may push mood-specific values here through `setGrade` / `setBloom`.
     */
    this.look = {
      exposure: 1.0, lutStrength: 1.0, saturation: 1.0,
      chroma: 0.0016, distortion: 0.028, grain: 0.032, vignette: 0.42,
      bloomStrength: 0.32, bloomRadius: 0.74, bloomThreshold: 0.92,
      ssrIntensity: 0.62, aoIntensity: 0.92, dofStrength: 0.85, motionBlur: 0.55,
    };

    /** Exposed for the QA harness. */
    this.stats = { fps: 60, frameMs: 16.7, drawCalls: 0, triangles: 0, renderScale: 1 };

    this.renderScale = 1;
    this._targetScale = 1;
    this._frameTimes = new Float32Array(48);
    this._frameIndex = 0;
    this._frameCount = 0;
    this._lastFrameStamp = 0;
    this._adaptCooldown = 0;

    // Focus state, updated by FightCamera through the bus.
    this.shadowFocus = { center: new THREE.Vector3(0, 1.0, 0), radius: 4.2 };
    this.dofFocus = { distance: 6.5, nearRange: 2.4, farRange: 9.5 };
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
    this.setQuality('ultra');
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
    // OutputPass reads `renderer.toneMapping`. With the grade pass present the
    // display transform has already happened, so the output pass must only do
    // the sRGB transfer; without it, hand AgX back to three.
    this.renderer.toneMapping = (tier.grade && this.effects.grade)
      ? THREE.NoToneMapping
      : THREE.AgXToneMapping;
    const passes = {};

    passes.render = new RenderPass(this.scene, this.camera);
    composer.addPass(passes.render);

    const wantsGeometry = tier.gbuffer &&
      (this.effects.ao || this.effects.ssr || this.effects.dof || this.effects.motionBlur);

    if (wantsGeometry) {
      passes.gbuffer = new DepthNormalPass(this.scene, this.camera);
      passes.gbuffer.setSize(w, h);
      composer.addPass(passes.gbuffer);
    }

    if (tier.ao && this.effects.ao && passes.gbuffer) {
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.setGBuffer(passes.gbuffer.depthTexture, passes.gbuffer.normalTexture);
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
      gtao.updatePdMaterial({ lumaPhi: 8, depthPhi: 2.2, normalPhi: 3.6, radius: 5, samples: 12, rings: 2 });
      passes.ao = gtao;
      composer.addPass(gtao);
    }

    if (tier.ssr && this.effects.ssr && passes.gbuffer) {
      const ssr = new WetFloorSsrPass(this.camera, tier.ssrSteps);
      ssr.uniforms.tDepth.value = passes.gbuffer.depthTexture;
      ssr.uniforms.tNormal.value = passes.gbuffer.normalTexture;
      ssr.uniforms.uIntensity.value = this.look.ssrIntensity;
      passes.ssr = ssr;
      composer.addPass(ssr);
    }

    if (tier.bloom && this.effects.bloom) {
      // Restrained: only genuine highlights bloom, and they bloom wide and
      // faint. A glow bath is the single fastest way to look cheap.
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(w, h),
        this.look.bloomStrength, this.look.bloomRadius, this.look.bloomThreshold,
      );
      passes.bloom = bloom;
      composer.addPass(bloom);
    }

    if (tier.dof && this.effects.dof && passes.gbuffer) {
      const dof = new BokehDofPass(this.camera, tier.dofTaps);
      dof.uniforms.tDepth.value = passes.gbuffer.depthTexture;
      dof.uniforms.uStrength.value = this.look.dofStrength;
      dof.setSize(w, h);
      passes.dof = dof;
      composer.addPass(dof);
    }

    if (tier.motionBlur && this.effects.motionBlur && passes.gbuffer) {
      const mb = new MotionBlurPass(this.camera, tier.mbTaps);
      mb.uniforms.tDepth.value = passes.gbuffer.depthTexture;
      mb.uniforms.uIntensity.value = this.look.motionBlur;
      passes.motionBlur = mb;
      composer.addPass(mb);
    }

    if (tier.grade && this.effects.grade) {
      const grade = new GradePass(this._lut);
      const soft = this.quality === 'low' || this.quality === 'medium';
      grade.uniforms.uExposure.value = this.look.exposure;
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
    if (name === 'adaptiveResolution') return;
    this.#buildComposer();
  }

  /**
   * Tunes the display transform without rebuilding the chain. Any subset of
   * `exposure`, `lutStrength`, `saturation`, `chroma`, `distortion`, `grain`
   * and `vignette` may be given; values persist across quality changes so a
   * lighting mood can own the look.
   * @param {Partial<RenderPipeline['look']>} values
   */
  setGrade(values = {}) {
    Object.assign(this.look, values);
    const g = this._passes.grade;
    if (!g) return;
    const soft = this.quality === 'low' || this.quality === 'medium';
    g.uniforms.uExposure.value = this.look.exposure;
    g.uniforms.uLutStrength.value = this.look.lutStrength;
    g.uniforms.uSaturation.value = this.look.saturation;
    g.uniforms.uChroma.value = soft ? this.look.chroma * 0.55 : this.look.chroma;
    g.uniforms.uDistortion.value = this.look.distortion;
    g.uniforms.uGrain.value = soft ? this.look.grain * 0.7 : this.look.grain;
    g.uniforms.uVignette.value = this.look.vignette;
  }

  /**
   * Retunes the wet-floor reflections in place.
   *
   * The pass has no roughness channel to read, so it masks on geometry: any
   * upward-facing surface within `slab` metres of `floorY` reflects. A stage
   * with a matte floor should turn `intensity` down or off rather than let it
   * mirror.
   *
   * @param {{intensity?:number, floorY?:number, slab?:number,
   *          maxDistance?:number, thickness?:number}} values
   */
  setSsr({ intensity, floorY, slab, maxDistance, thickness } = {}) {
    if (typeof intensity === 'number') this.look.ssrIntensity = intensity;
    const u = this._passes.ssr?.uniforms;
    if (!u) return;
    u.uIntensity.value = this.look.ssrIntensity;
    if (typeof floorY === 'number') u.uFloorY.value = floorY;
    if (typeof slab === 'number') u.uSlab.value = slab;
    if (typeof maxDistance === 'number') u.uMaxDistance.value = maxDistance;
    if (typeof thickness === 'number') u.uThickness.value = thickness;
  }

  /**
   * Retunes bloom in place.
   * @param {{strength?:number, radius?:number, threshold?:number}} values
   */
  setBloom({ strength, radius, threshold } = {}) {
    if (typeof strength === 'number') this.look.bloomStrength = strength;
    if (typeof radius === 'number') this.look.bloomRadius = radius;
    if (typeof threshold === 'number') this.look.bloomThreshold = threshold;
    const b = this._passes.bloom;
    if (!b) return;
    b.strength = this.look.bloomStrength;
    b.radius = this.look.bloomRadius;
    b.threshold = this.look.bloomThreshold;
  }

  /**
   * Focus report from the camera. Drives shadow fitting and DOF plane.
   * @param {{center?:THREE.Vector3, radius?:number, distance?:number}} e
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
    } catch {
      // compile() touches every material; a half-built scene must not be fatal.
    }

    this.#fitShadows(scene, cam);

    if (this.composer) {
      const wasToScreen = this.composer.renderToScreen;
      this.composer.renderToScreen = false;
      try {
        this.#syncPasses(scene, cam);
        this.composer.render(1 / 60);
      } catch {
        // ignore: warmup is best effort
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

    this.#fitShadows(scene, cam);
    this.#syncPasses(scene, cam);

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
      this.composer.setPixelRatio(pr);
      this.composer.setSize(this._cssWidth, this._cssHeight);
      const w = Math.floor(this._cssWidth * pr);
      const h = Math.floor(this._cssHeight * pr);
      this._passes.gbuffer?.setSize(w, h);
      this._passes.ao?.setSize(w, h);
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
    if (p.gbuffer) { p.gbuffer.scene = scene; p.gbuffer.camera = camera; }
    if (p.ao) { p.ao.scene = scene; p.ao.camera = camera; }
    if (p.ssr) p.ssr.camera = camera;
    if (p.dof) {
      p.dof.camera = camera;
      p.dof.uniforms.uFocus.value = this.dofFocus.distance;
      p.dof.uniforms.uNearRange.value = this.dofFocus.nearRange;
      p.dof.uniforms.uFarRange.value = this.dofFocus.farRange;
    }
    if (p.motionBlur) {
      p.motionBlur.camera = camera;
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
   */
  #adaptResolution() {
    if (this._adaptCooldown > 0) { this._adaptCooldown--; return; }
    if (this._frameCount < this._frameTimes.length) return;

    const avg = this.stats.frameMs;
    const min = this.tier.minScale;
    const max = this.tier.renderScale;
    let next = this._targetScale;

    if (avg > 19.0) next = Math.max(min, this._targetScale - 0.06);
    else if (avg < 13.6) next = Math.min(max, this._targetScale + 0.04);

    if (Math.abs(next - this._targetScale) > 0.001) {
      this._targetScale = next;
      this.renderScale = next;
      this.resize();
      this._adaptCooldown = 45;
      this._frameCount = 0;
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
