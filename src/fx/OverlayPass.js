/**
 * Knockbots — the screen-space FX overlay.
 *
 * Everything in this pass is the punctuation of a hit rather than the hit
 * itself: the impact frame, the speed lines, the shockwave refraction and the
 * overdrive takeover. It is appended to the render pipeline's composer *after*
 * the output pass, so it operates on the finished, display-referred frame. That
 * is deliberate — speed lines and an inversion flash are graphic devices drawn
 * on the image, not lights in the scene, and running them in scene-referred
 * linear light makes them look muddy and wrong.
 *
 * The pass costs one texture fetch when idle. `uActive` gates the whole body,
 * so during normal play it is a copy, and it only turns into a fourteen-tap
 * radial blur for the three or four frames after a heavy hit.
 *
 * Shockwave refraction is genuine: `ShockwaveSystem` projects each live ring to
 * screen space, and the fragment shader displaces the sampled UV radially about
 * that centre, with a different magnitude per channel across the shock front.
 * The result is the frame *bent* around the wave, which is what a pressure
 * gradient actually does to an image.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GLSL_HASH, GLSL_EASE } from './FxShaders.js';
import { MAX_DISTORT_RINGS } from './ShockwaveSystem.js';

const FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uAspect;
uniform float uActive;

uniform vec4 uRings[ ${MAX_DISTORT_RINGS} ];

uniform float uImpact;
uniform vec2  uImpactCenter;
uniform vec3  uImpactTint;
uniform float uInvert;
uniform float uSpeedLines;
uniform float uSpeedSeed;

uniform float uDesat;
uniform float uSuper;
uniform vec2  uSuperCenter;
uniform vec3  uSuperColor;
uniform float uSuperFlash;

uniform vec3  uFlashColor;
uniform float uFlashAmount;

varying vec2 vUv;

${GLSL_HASH}
${GLSL_EASE}

/** Aspect-corrected screen coordinates, origin at the frame centre. */
vec2 aspected( vec2 uv ) { return vec2( ( uv.x - 0.5 ) * uAspect, uv.y - 0.5 ); }

void main() {
  if ( uActive < 0.001 ) {
    gl_FragColor = texture2D( tDiffuse, vUv );
    return;
  }

  vec2 uvR = vUv, uvG = vUv, uvB = vUv;

  // --- shockwave refraction -------------------------------------------------
  for ( int i = 0; i < ${MAX_DISTORT_RINGS}; i++ ) {
    vec4 ring = uRings[ i ];
    if ( ring.w <= 0.0005 ) continue;
    vec2 c = ring.xy * 0.5 + 0.5;
    vec2 d = vUv - c;
    vec2 da = vec2( d.x * uAspect, d.y );
    float dist = length( da );
    float R = max( ring.z * 0.5 * uAspect, 1e-4 );
    // Gaussian band riding the shock front; the wake is wider than the front.
    float w = R * 0.22 + 0.006;
    float band = exp( -pow( ( dist - R ) / w, 2.0 ) );
    float inner = exp( -pow( ( dist - R * 0.78 ) / ( w * 2.1 ), 2.0 ) ) * 0.4;
    vec2 dir = dist > 1e-5 ? da / dist : vec2( 0.0 );
    dir.x /= uAspect;
    float amt = ( band - inner ) * ring.w * 0.05;
    uvR += dir * amt * 1.14;
    uvG += dir * amt;
    uvB += dir * amt * 0.86;
  }

  // --- impact frame: radial smear toward the contact point ------------------
  vec3 col;
  if ( uImpact > 0.002 ) {
    vec2 ic = uImpactCenter * 0.5 + 0.5;
    float strength = uImpact * 0.085;
    vec3 acc = vec3( 0.0 );
    float wsum = 0.0;
    for ( int k = 0; k < 7; k++ ) {
      float f = float( k ) / 6.0;
      float s = 1.0 - f * strength;
      float wk = 1.0 - f * 0.72;
      vec2 oR = mix( ic, uvR, s );
      vec2 oG = mix( ic, uvG, s );
      vec2 oB = mix( ic, uvB, s );
      acc += vec3(
        texture2D( tDiffuse, oR ).r,
        texture2D( tDiffuse, oG ).g,
        texture2D( tDiffuse, oB ).b
      ) * wk;
      wsum += wk;
    }
    col = acc / wsum;
  } else {
    col = vec3(
      texture2D( tDiffuse, uvR ).r,
      texture2D( tDiffuse, uvG ).g,
      texture2D( tDiffuse, uvB ).b
    );
  }

  vec2 p = aspected( vUv );

  // --- radial speed lines ---------------------------------------------------
  if ( uSpeedLines > 0.002 ) {
    vec2 ic = aspected( uImpactCenter * 0.5 + 0.5 );
    vec2 rel = p - ic;
    float rad = length( rel );
    float ang = atan( rel.y, rel.x );
    float spokes = 58.0;
    float idx = floor( ang / 6.2831853 * spokes + 0.5 );
    float n = hash11( idx * 0.017 + uSpeedSeed );
    // Only about a third of the spokes exist, and they start at random radii.
    float exists = step( 0.62, n );
    float start = 0.16 + hash11( idx * 0.031 + uSpeedSeed + 3.7 ) * 0.24;
    float thin = abs( fract( ang / 6.2831853 * spokes + 0.5 ) - 0.5 ) * 2.0;
    float line = pow( clamp( 1.0 - thin, 0.0, 1.0 ), 22.0 - n * 12.0 );
    float reach = smoothstep( start, start + 0.42, rad );
    float mask = exists * line * reach * uSpeedLines;
    col += vec3( 1.0 ) * mask * 0.9;
    col *= 1.0 - mask * 0.25;
  }

  // --- overdrive takeover ---------------------------------------------------
  if ( uSuper > 0.002 || uDesat > 0.002 ) {
    float luma = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec2 sc = aspected( uSuperCenter * 0.5 + 0.5 );
    float rad = length( p - sc );
    // Colour survives near the fighter, the world drains to monochrome outside.
    float keep = 1.0 - smoothstep( 0.12, 0.62, rad );
    float desat = clamp( uDesat * ( 1.0 - keep * 0.75 ), 0.0, 1.0 );
    col = mix( col, vec3( luma ), desat );

    if ( uSuper > 0.002 ) {
      vec2 rel = p - sc;
      float ang = atan( rel.y, rel.x );
      // Volumetric-looking beams: two counter-rotating harmonics so the fan
      // reads as depth rather than as a spinning wheel.
      float b1 = pow( abs( sin( ang * 7.0 + uTime * 1.9 ) ), 14.0 );
      float b2 = pow( abs( sin( ang * 11.0 - uTime * 1.2 + 0.7 ) ), 22.0 );
      float falloff = exp( -rad * 1.5 ) * smoothstep( 0.02, 0.16, rad );
      float beams = ( b1 * 0.7 + b2 * 0.45 ) * falloff * uSuper;
      // A hot core and a wide bloom halo centred on the fighter.
      float core = exp( -rad * rad * 46.0 ) * uSuper;
      float halo = exp( -rad * 2.6 ) * 0.35 * uSuper;
      col += uSuperColor * ( beams * 1.6 + halo ) + vec3( 1.0 ) * core * 0.55;
      // Charge ripple travelling outward through the drained world.
      float ripple = sin( rad * 26.0 - uTime * 7.0 ) * 0.5 + 0.5;
      col += uSuperColor * pow( ripple, 6.0 ) * falloff * uSuper * 0.35;
      col *= 1.0 - smoothstep( 0.35, 1.05, rad ) * uSuper * 0.45;
    }

    col = mix( col, uSuperColor * 1.4 + vec3( 0.85 ), uSuperFlash );
  }

  // --- punctuation ----------------------------------------------------------
  col += uImpactTint * uImpact * 0.28;
  col = mix( col, vec3( 1.0 ) - col, uInvert );
  col = mix( col, uFlashColor, uFlashAmount );

  gl_FragColor = vec4( col, 1.0 );
}`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

export class OverlayPass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;

    const rings = [];
    for (let i = 0; i < MAX_DISTORT_RINGS; i++) rings.push(new THREE.Vector4(0, 0, 0, 0));

    this.uniforms = {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uAspect: { value: 16 / 9 },
      uActive: { value: 0 },
      uRings: { value: rings },
      uImpact: { value: 0 },
      uImpactCenter: { value: new THREE.Vector2(0, 0) },
      uImpactTint: { value: new THREE.Color(0, 0, 0) },
      uInvert: { value: 0 },
      uSpeedLines: { value: 0 },
      uSpeedSeed: { value: 0 },
      uDesat: { value: 0 },
      uSuper: { value: 0 },
      uSuperCenter: { value: new THREE.Vector2(0, 0) },
      uSuperColor: { value: new THREE.Color(0.4, 0.75, 1) },
      uSuperFlash: { value: 0 },
      uFlashColor: { value: new THREE.Color(1, 1, 1) },
      uFlashAmount: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.material);
  }

  /**
   * Recomputes the master gate. Skipping the whole shader body when nothing is
   * happening is the difference between a free pass and a permanent 0.4ms tax.
   */
  refreshActive() {
    const u = this.uniforms;
    let a = u.uImpact.value + u.uInvert.value + u.uSpeedLines.value +
      u.uDesat.value + u.uSuper.value + u.uSuperFlash.value + u.uFlashAmount.value;
    for (const r of u.uRings.value) a += r.w;
    u.uActive.value = a;
  }

  setSize(width, height) {
    this.uniforms.uAspect.value = width / Math.max(1, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
    }
  }

  dispose() {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
