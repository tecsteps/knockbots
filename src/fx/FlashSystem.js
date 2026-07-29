/**
 * Knockbots — impact flashes and the contact heat core.
 *
 * The single brightest thing in a hit is not the sparks or the ring, it is the
 * flare at the contact point that lasts four frames and drives the bloom. This
 * system draws it: an additive billboard whose shape is computed analytically
 * rather than sampled, so it stays razor sharp at any size and costs nothing.
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
 *    glowing: a small blackbody blob that starts white-hot, expands once, and
 *    cools down the same yellow → orange → cherry path the sparks take, over
 *    most of a second. It is the same physics as the sparks and it is what a
 *    struck plate actually does, so it costs no credibility to hold it.
 *
 * The `roll` attribute is load-bearing rather than decorative: the caller sets
 * it from the screen-space direction of the blow, so the anamorphic streak lies
 * along the line the hit travelled instead of pointing the same way every time.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_EASE, GLSL_BILLBOARD, GLSL_TEMPERATURE } from './FxShaders.js';

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aParams;   // birth, life, size, roll
attribute vec4 aTint;     // rgb, heat
attribute float aCool;    // 0 = lens flare, 1 = cooling heat core

uniform float uTime;
uniform float uSizeScale;

varying vec2 vUv;
varying vec3 vTint;
varying float vEnergy;
varying float vCool;

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
    return;
  }

  // The flare blooms outward as it clips, the way an overexposed highlight
  // does; the heat core punches out once and then shrinks back as it cools.
  float grow = mix(
    0.82 + easeOutExpo( t ) * 0.5,
    ( 0.55 + easeOutExpo( t * 6.0 ) * 0.6 ) * ( 1.0 - 0.55 * t ),
    aCool
  );
  float sz = size * uSizeScale * grow;
  vec4 mv = billboard( aOrigin, position.xy, sz, roll );
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vCool = aCool;

  // Instant on, exponential settle. Peak energy is on the contact frame.
  float flare = impulse( 7.0, t + 0.14 ) * ( 1.0 - t );
  // Two-term cooling: the radiant collapse, then a long ember floor.
  float glow = pow( 1.0 - t, 1.7 ) * 0.8 + pow( 1.0 - t, 0.45 ) * 0.2;
  vEnergy = aTint.w * mix( flare, glow, aCool );
  vTint = mix( aTint.rgb, blackbodyHue( t ), aCool );
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vTint;
varying float vEnergy;
varying float vCool;

void main() {
  if ( vEnergy < 0.002 ) discard;
  vec2 d = ( vUv * 2.0 - 1.0 );
  float r = length( d );
  if ( r > 1.0 ) discard;

  float vignette = 1.0 - smoothstep( 0.72, 1.0, r );
  float core   = exp( -r * r * 17.0 );
  float bloom  = exp( -r * 3.1 ) * 0.34;
  float horiz  = exp( -abs( d.y ) * 44.0 ) * exp( -abs( d.x ) * 1.9 );
  float vert   = exp( -abs( d.x ) * 52.0 ) * exp( -abs( d.y ) * 2.6 ) * 0.55;
  float diagA  = exp( -abs( d.x - d.y ) * 62.0 ) * exp( -r * 3.4 );
  float diagB  = exp( -abs( d.x + d.y ) * 62.0 ) * exp( -r * 3.4 );

  // The core has no lens response at all: it is hot metal seen directly, so it
  // is a tight blob with a soft scatter halo and nothing else.
  float flare = ( core * 1.7 + bloom + horiz * 0.95 + vert + ( diagA + diagB ) * 0.3 ) * vignette;
  float blob  = ( exp( -r * r * 8.0 ) * 1.9 + exp( -r * 2.4 ) * 0.5 ) * vignette;
  float shape = mix( flare, blob, vCool );

  // The centre saturates to white; the falloff keeps the hue.
  vec3 col = mix( vTint, vec3( 1.0 ), clamp( core * 1.25, 0.0, 1.0 ) );

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

  reset() { this.pool.killAll(); }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
  }
}
