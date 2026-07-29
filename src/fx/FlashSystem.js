/**
 * Knockbots — impact flashes and the contact heat core.
 *
 * The single brightest thing in a hit is not the sparks or the ring, it is the
 * flare at the contact point that lasts four frames and drives the bloom. This
 * system draws it: an additive billboard whose shape is computed analytically
 * rather than sampled, so it stays razor sharp at any size and costs nothing.
 *
 * Nothing here responds to light and nothing here is solid. A flash is light,
 * so the whole system is one unlit additive shell, and three properties are what
 * keep it reading as light rather than as a ball of geometry someone left in the
 * air:
 *
 *  - **Radiance, not paint.** The core opens an order of magnitude above the
 *    display range and collapses within a couple of frames. An effect that peaks
 *    near 1.0 has nothing for the bloom pass to spread, so it resolves as a flat
 *    coloured disc — which is exactly what an opaque sphere looks like.
 *  - **A shell, not a ball.** The billboard stands in for a sphere, so the
 *    fragment shader recovers that sphere's normal and takes the grazing term.
 *    The line of sight crosses most material at the silhouette and almost none
 *    through the middle, so the interior stays open and the limb carries the
 *    colour. A filled radial gradient reads as a solid object every time.
 *  - **No silhouette of its own.** The shape reaches zero before the quad edge,
 *    and the halo is faded against the depth prepass, so the sprite never draws
 *    the hard circular arc where it crosses the fighter or the floor.
 *
 * Two modes share that billboard, because a hit needs both halves of the
 * timeline and they behave nothing alike:
 *
 *  - **Flare** (`cool = 0`). A real lens response, not a blurred dot — a hot
 *    gaussian core, a dominant anamorphic streak along the quad's roll axis, a
 *    shorter perpendicular one, and two faint diagonal spikes. That asymmetry is
 *    what makes a flare read as light hitting a lens instead of as a white
 *    circle. The envelope is `impulse()`: instantaneous rise, exponential
 *    settle, gone in two to four frames. A flash that fades in is a flash that
 *    was animated; a flash that is simply *there* on the frame of contact is a
 *    flash that was caused.
 *
 *  - **Heat core** (`cool = 1`). The flare is over long before the hit reaction
 *    is, and an impact whose only bright element lasts four frames leaves the
 *    rest of the reaction with nothing at its centre. So the contact patch keeps
 *    glowing: a white-hot pinpoint inside a thin shell of ionised air, which
 *    collapses as it cools down the same yellow → orange → cherry path the
 *    sparks take. It shrinks the whole way, because a patch that holds its size
 *    for most of a second is an object rather than cooling metal.
 *
 * The `roll` attribute is load-bearing rather than decorative: the caller sets
 * it from the screen-space direction of the blow, so the anamorphic streak lies
 * along the line the hit travelled instead of pointing the same way every time.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_EASE, GLSL_BILLBOARD, GLSL_TEMPERATURE, GLSL_DEPTH_FADE } from './FxShaders.js';

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aParams;   // birth, life, size, roll
attribute vec4 aTint;     // rgb, heat
attribute float aCool;    // 0 = lens flare, 1 = cooling heat core

uniform float uTime;
uniform float uSizeScale;
uniform float uMaxRadius;

varying vec2 vUv;
varying vec3 vTint;
varying float vEnergy;
varying float vCool;
varying float vViewZ;
varying float vSize;

${GLSL_EASE}
${GLSL_BILLBOARD}
${GLSL_TEMPERATURE}

void main() {
  float birth = aParams.x, life = aParams.y, size = aParams.z, roll = aParams.w;
  float age = uTime - birth;
  float t = age / max( life, 1e-4 );
  if ( life <= 0.0 || t < 0.0 || t >= 1.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vUv = vec2( 0.0 ); vTint = vec3( 0.0 ); vEnergy = 0.0; vCool = 0.0;
    vViewZ = 1.0; vSize = 0.0;
    return;
  }

  // The flare blooms outward as it clips, the way an overexposed highlight
  // does; the heat core punches out on the contact frame and then collapses.
  float grow = mix(
    0.82 + easeOutExpo( t ) * 0.5,
    ( 0.46 + easeOutExpo( t * 9.0 ) * 0.74 ) * ( 1.0 - 0.68 * t ),
    aCool
  );
  float sz = size * uSizeScale * grow;

  // Screen-radius ceiling. A metre-wide flare on a cinematic that pushes the
  // camera in to a metre and a half covers the whole frame and takes the fight
  // with it. Capping the world size by its projected radius holds the outer
  // frame readable wherever the camera ends up, and costs one divide.
  float viewZ = -( viewMatrix * vec4( aOrigin, 1.0 ) ).z;
  float ndcPerMetre = projectionMatrix[ 1 ][ 1 ] / max( viewZ, 1e-3 );
  sz = min( sz, uMaxRadius / max( ndcPerMetre, 1e-4 ) );

  vec4 mv = billboard( aOrigin, position.xy, sz, roll );
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vCool = aCool;
  vViewZ = viewZ;
  vSize = sz;

  // Instant on, exponential settle. Peak energy is on the contact frame.
  float flare = impulse( 7.0, t + 0.14 ) * ( 1.0 - t );
  // Two-term cooling: a radiant collapse that opens well above the display
  // range, then a long dim ember floor that keeps the contact point alive under
  // the reaction animation without ever becoming a bright object again.
  float glow = pow( 1.0 - t, 2.6 ) * 3.4 + pow( 1.0 - t, 0.5 ) * 0.13;
  vEnergy = aTint.w * mix( flare, glow, aCool );
  vTint = mix( aTint.rgb, blackbodyHue( t ), aCool );
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vTint;
varying float vEnergy;
varying float vCool;
varying float vViewZ;
varying float vSize;

${GLSL_DEPTH_FADE}

void main() {
  if ( vEnergy < 0.002 ) discard;
  vec2 d = ( vUv * 2.0 - 1.0 );
  float r = length( d );
  if ( r > 1.0 ) discard;

  // Reaches zero well before the quad edge. Any alpha still alive at r = 1 draws
  // the sprite's own outline, and the flash becomes a visible disc.
  float window = 1.0 - smoothstep( 0.72, 0.98, r );

  float core   = exp( -r * r * 34.0 );
  float bloom  = exp( -r * 4.4 ) * 0.16;
  float horiz  = exp( -abs( d.y ) * 44.0 ) * exp( -abs( d.x ) * 1.9 );
  float vert   = exp( -abs( d.x ) * 52.0 ) * exp( -abs( d.y ) * 2.6 ) * 0.55;
  float diagA  = exp( -abs( d.x - d.y ) * 62.0 ) * exp( -r * 3.4 );
  float diagB  = exp( -abs( d.x + d.y ) * 62.0 ) * exp( -r * 3.4 );

  // Sphere normal the billboard stands in for, and the grazing term off it. A
  // shell is brightest at its limb because that is where the line of sight
  // crosses the most of it; through the middle there is almost nothing.
  float nz    = sqrt( max( 0.0, 1.0 - r * r ) );
  float limb  = pow( 1.0 - nz, 2.4 );
  float shell = limb * exp( -pow( ( r - 0.64 ) * 4.8, 2.0 ) );
  float pin   = exp( -r * r * 56.0 );

  // Hot is the emitter itself; air is what it lights up around it. The fill
  // between the pinpoint and the shell is kept almost to nothing on purpose: at
  // the radiance a super runs at, even a tenth of a unit spread across a
  // quarter of the frame is a solid white disc once the bloom pass has it.
  float hot = mix( core * 1.7 + horiz * 0.95 + vert + ( diagA + diagB ) * 0.3, pin * 2.6, vCool );
  float air = mix( bloom, shell * 1.2 + exp( -r * r * 11.0 ) * 0.05, vCool );

  // The two halves want different depth behaviour. The pinpoint *is* the
  // contact and sits on the surface it struck, so it keeps most of its energy
  // hard against the geometry; the halo is scatter in the air in front of it and
  // fades out completely, which is what removes the circular arc the quad would
  // otherwise cut across the fighter.
  float dfade = depthFade( vViewZ, max( vSize * 1.6, 0.12 ) );
  float shape = ( hot * mix( 0.62, 1.0, dfade ) + air * dfade ) * window;

  // The centre saturates to white; the falloff keeps the hue.
  vec3 col = mix( vTint, vec3( 1.0 ), clamp( ( core + pin ) * 1.35, 0.0, 1.0 ) );

  // Additive blending already multiplies by alpha. Folding the shape into both
  // the colour and the alpha squares it, and a flash that peaks at fifty units
  // of radiance turns the whole frame white once bloom gets hold of it.
  float a = clamp( shape, 0.0, 1.0 ) * uOpacity;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col * vEnergy, a );
}`;

export class FlashSystem {
  /** @param {number} capacity */
  constructor(capacity = 64) {
    this.pool = new InstancedPool({
      capacity,
      lifeAttribute: 'aParams',
      lifeComponent: 1,
      attributes: { aOrigin: 3, aParams: 4, aTint: 4, aCool: 1 },
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uSizeScale: { value: 1 },
        uOpacity: { value: 1 },
        // NDC half-height, so 0.6 is a radius of roughly 30% of the frame.
        uMaxRadius: { value: 0.6 },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uNear: { value: 0.15 },
        uFar: { value: 260 },
        uSoft: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.pool.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 26;
    this.mesh.name = 'fx.flash';
    this.mesh.matrixAutoUpdate = false;
    this._time = 0;
  }

  /**
   * @param {THREE.Vector3} point
   * @param {Object} [opts]
   * @param {number} [opts.size] radius in metres
   * @param {number} [opts.life] seconds
   * @param {number} [opts.heat] peak radiance
   * @param {number} [opts.roll] billboard roll; random when omitted. Set this
   *   from the screen-space direction of the blow to aim the anamorphic streak.
   * @param {boolean} [opts.cool] draw the cooling heat core instead of a flare
   * @param {THREE.Color} [opts.tint] ignored when `cool` is set; a heat core is
   *   a blackbody and takes its colour from its own temperature
   */
  pop(point, opts = {}) {
    const i = this.pool.alloc();
    const { aOrigin, aParams, aTint, aCool } = this.pool.arrays;
    const o = i * 3;
    aOrigin[o] = point.x; aOrigin[o + 1] = point.y; aOrigin[o + 2] = point.z;

    const p = i * 4;
    aParams[p] = this._time;
    aParams[p + 1] = opts.life ?? 0.16;
    aParams[p + 2] = opts.size ?? 0.7;
    aParams[p + 3] = opts.roll ?? (Math.random() - 0.5) * 0.5;

    const tint = opts.tint;
    aTint[p] = tint ? tint.r : 1.0;
    aTint[p + 1] = tint ? tint.g : 0.94;
    aTint[p + 2] = tint ? tint.b : 0.86;
    aTint[p + 3] = opts.heat ?? 3.0;
    aCool[i] = opts.cool ? 1 : 0;
    return i;
  }

  update(time) {
    this._time = time;
    this.material.uniforms.uTime.value = time;
    this.pool.flush();
  }

  setScale(s) { this.material.uniforms.uSizeScale.value = s; }

  /**
   * Hands over the pipeline's depth prepass so the halo can fade against scene
   * geometry. Passing a null texture turns the fade off rather than sampling an
   * unbound sampler.
   * @param {THREE.Texture|null} depthTexture
   * @param {number} width drawing buffer width
   * @param {number} height drawing buffer height
   * @param {number} near camera near plane
   * @param {number} far camera far plane
   */
  setDepth(depthTexture, width, height, near, far) {
    const u = this.material.uniforms;
    u.uDepth.value = depthTexture || null;
    u.uSoft.value = depthTexture ? 1 : 0;
    u.uResolution.value.set(width, height);
    u.uNear.value = near;
    u.uFar.value = far;
  }

  /**
   * Ceiling on the flash's projected radius, in NDC half-heights. This is the
   * clamp that stops a super's contact flare from whiting out the frame.
   * @param {number} ndcRadius
   */
  setMaxRadius(ndcRadius) { this.material.uniforms.uMaxRadius.value = ndcRadius; }

  reset() { this.pool.killAll(); }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
  }
}
