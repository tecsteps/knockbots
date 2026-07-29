/**
 * Knockbots — impact flashes.
 *
 * The single brightest thing in a hit is not the sparks or the ring, it is the
 * flare at the contact point that lasts four frames and drives the bloom. This
 * system draws it: an additive billboard whose shape is computed analytically
 * rather than sampled, so it stays razor sharp at any size and costs nothing.
 *
 * The shape is a real lens response, not a blurred dot — a hot gaussian core, a
 * dominant horizontal anamorphic streak, a shorter vertical one, and two faint
 * diagonal spikes. That asymmetry is what makes a flare read as light hitting a
 * lens instead of as a white circle, and it is why anamorphic streaks are on
 * every impact frame in a modern fighting game.
 *
 * The envelope is `impulse()`: instantaneous rise, exponential settle. A flash
 * that fades in is a flash that was animated; a flash that is simply *there* on
 * the frame of contact is a flash that was caused.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_EASE, GLSL_BILLBOARD } from './FxShaders.js';

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aParams;   // birth, life, size, roll
attribute vec4 aTint;     // rgb, heat

uniform float uTime;
uniform float uSizeScale;

varying vec2 vUv;
varying vec3 vTint;
varying float vEnergy;
varying float vAspectBias;

${GLSL_EASE}
${GLSL_BILLBOARD}

void main() {
  float birth = aParams.x, life = aParams.y, size = aParams.z, roll = aParams.w;
  float age = uTime - birth;
  float t = age / max( life, 1e-4 );
  if ( life <= 0.0 || t < 0.0 || t >= 1.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vUv = vec2( 0.0 ); vTint = vec3( 0.0 ); vEnergy = 0.0; vAspectBias = 1.0;
    return;
  }

  // Blooms outward slightly as it decays, the way an overexposed highlight does.
  float sz = size * uSizeScale * ( 0.82 + easeOutExpo( t ) * 0.5 );
  vec4 mv = billboard( aOrigin, position.xy, sz, roll );
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vTint = aTint.rgb;
  // Instant on, exponential settle. Peak energy is on the contact frame.
  vEnergy = aTint.w * impulse( 7.0, t + 0.14 ) * ( 1.0 - t );
  vAspectBias = 1.0;
}`;

const FRAG = /* glsl */ `
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vTint;
varying float vEnergy;
varying float vAspectBias;

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

  float shape = ( core * 1.7 + bloom + horiz * 0.95 + vert + ( diagA + diagB ) * 0.3 ) * vignette;
  // The centre saturates to white; the falloff keeps the character hue.
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
      attributes: { aOrigin: 3, aParams: 4, aTint: 4 },
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
   * @param {number} [opts.roll] billboard roll; random when omitted
   * @param {THREE.Color} [opts.tint]
   */
  pop(point, opts = {}) {
    const i = this.pool.alloc();
    const { aOrigin, aParams, aTint } = this.pool.arrays;
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
