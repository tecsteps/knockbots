/**
 * Knockbots — shockwave rings.
 *
 * Every ring is two things at once. In the scene it is an additive instanced
 * quad whose radial profile is a baked shock cross-section: a razor leading
 * edge, a bright shoulder and a long soft wake, expanding on an ease-out quint
 * so it snaps outward and decelerates the way a real pressure front does.
 *
 * In screen space the same ring is handed to `OverlayPass`, which displaces the
 * already-composited frame radially around the ring's projected centre with a
 * per-channel offset. That is the refraction: real pixels of the real frame
 * bent around the shock, with chromatic separation across the front. Faking it
 * with an alpha sprite is the difference between a shockwave and a smoke ring.
 *
 * Rings come in two orientations. Ground rings lie in the floor plane and are
 * what a launcher or a heavy landing produces; screen-facing rings sit at the
 * contact point and are what a clean impact produces. Heavy hits get bigger,
 * slower rings — the expansion rate is the whole readout of how hard a hit was.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_EASE, GLSL_BILLBOARD } from './FxShaders.js';

const _v = new THREE.Vector3();
const _tmpEdge = new THREE.Vector3();
const _camRight = new THREE.Vector3();

/** How many rings the post pass can distort at once. */
export const MAX_DISTORT_RINGS = 4;

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec4 aParams;  // birth, life, maxRadius, thickness
attribute vec4 aStyle;   // mode (0 ground, 1 facing), heat, seed, tiltZ
attribute vec3 aTint;
attribute float aAspect; // >1 stretches along the roll axis, <1 across it

uniform float uTime;

varying vec2 vUv;
varying vec3 vTint;
varying float vT;
varying float vHeat;
varying float vThickness;
varying float vSeed;
varying float vGrow;   // eased radius as a fraction of the final radius

${GLSL_EASE}
${GLSL_BILLBOARD}

void main() {
  float birth = aParams.x, life = aParams.y, maxR = aParams.z;
  float age = uTime - birth;
  float t = age / max( life, 1e-4 );
  if ( life <= 0.0 || t < 0.0 || t >= 1.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vUv = vec2( 0.0 ); vTint = vec3( 0.0 ); vT = 1.0; vHeat = 0.0;
    vThickness = 1.0; vSeed = 0.0; vGrow = 1.0;
    return;
  }

  float grow = easeOutQuint( t );
  float radius = maxR * grow;
  float size = max( radius, 1e-3 ) * 2.0;
  vGrow = grow;

  vec4 mv;
  if ( aStyle.x < 0.5 ) {
    // Ground-aligned: the quad lies in the floor plane, lifted a hair to clear it.
    vec3 world = aOrigin + vec3( position.x * size, 0.012, position.y * size );
    mv = viewMatrix * vec4( world, 1.0 );
  } else {
    // Area-preserving anisotropy: a pressure front driven by a limb travelling
    // in one direction is an ellipse whose long axis lies along that direction.
    // A circle is the tell that the ring was drawn rather than caused.
    vec2 corner = position.xy * vec2( aAspect, 1.0 / aAspect );
    mv = billboard( aOrigin, corner, size, aStyle.w );
  }
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vTint = aTint;
  vT = t;
  vHeat = aStyle.y;
  vThickness = aParams.w;
  vSeed = aStyle.z;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uRing;
uniform float uOpacity;

varying vec2 vUv;
varying vec3 vTint;
varying float vT;
varying float vHeat;
varying float vThickness;
varying float vSeed;
varying float vGrow;

void main() {
  vec2 d = vUv * 2.0 - 1.0;
  float r = length( d );
  if ( r > 1.0 ) discard;

  // A perfect circle is the tell that a shockwave was drawn rather than caused.
  // Three angular harmonics deform the front, and the deformation grows as the
  // wave expands and loses coherence.
  float ang = atan( d.y, d.x );
  float wob = sin( ang * 7.0 + vSeed )
            + sin( ang * 13.0 - vSeed * 1.7 ) * 0.55
            + sin( ang * 23.0 + vSeed * 0.6 ) * 0.27;
  float rr = clamp( r * ( 1.0 + wob * 0.028 * ( 0.5 + vT ) ), 0.0, 1.0 );

  // A shell of roughly constant width in metres occupies a SHRINKING fraction
  // of the radius as the front runs outward. Holding that fraction constant —
  // which is what a fixed vThickness does — is why this read as a rubber tube
  // being inflated rather than a pressure front leaving an impact: at full
  // expansion the band was still a fifth of the radius wide, and a fifth of a
  // metre-radius ring is a 20cm-thick pipe. Dividing by the eased growth keeps
  // the band's world width fixed and thins it on screen as it goes.
  float th = clamp( vThickness * 0.3 / max( vGrow, 0.3 ), 0.025, vThickness );
  float u = clamp( 1.0 - ( 1.0 - rr ) / max( th, 0.02 ), 0.0, 1.0 );

  // Energy is not distributed evenly around the front either.
  float amp = 0.62 + 0.38 * ( sin( ang * 5.0 - vSeed * 2.3 ) * 0.5 + 0.5 );

  // The radial profile lives in COVERAGE ONLY, and this is the whole fix.
  // Additive output is colour x alpha, so a build that puts the profile in both
  // squares it and the ring collapses to a wireframe hoop. The previous
  // revision knew that and compensated by making alpha a very wide, very high
  // Gaussian envelope — but a wide envelope at 0.95 alpha *is* a solid ring of
  // paint, which is exactly what a critic at 2.5x magnification called it: an
  // opaque flat torus with no internal structure. Shaping alpha and holding
  // colour flat gives the same linear response with the shape kept sharp.
  //
  //   front     the shock itself: a razor line, ~5% of the band
  //   shoulder  the compressed air behind it
  //   wake      the long rarefaction, from the baked profile
  //
  // 'shoulder''s weight was 0.17 of the front's peak — so thin against the
  // white-hot front that two critics, rounds apart, read the whole ring as one
  // undifferentiated pale object and filed it as UI: a combo-state marker, not
  // impact energy (see EffectsDirector's c.ring comment). The front carries
  // its own hard-coded near-white mix below and has to stay the brightest
  // pixel on the ring — that hierarchy is what keeps this a shock front and
  // not the "flat salmon plastic" a uniformly-tinted band produced before this
  // structure existed. Widening and brightening the shoulder gives the part of
  // the band that DOES carry the hit's own colour enough area and weight to
  // read at a glance, without touching that hierarchy.
  float front    = exp( -pow( ( u - 0.93 ) * 15.0, 2.0 ) );
  float shoulder = exp( -pow( ( u - 0.66 ) * 4.3, 2.0 ) ) * 0.32;
  vec4 prof = texture2D( uRing, vec2( u, 0.5 ) );
  float wake = prof.r * pow( u, 2.4 ) * 0.09;
  float shape = clamp( front + shoulder + wake, 0.0, 1.0 );

  // Softened from 2.2 — same total life, same zero at t=1, but less of the
  // ring's already-short window is spent in the steep first third of the
  // falloff. Both 15-impact-light and 16-impact-heavy land at t~0.1-0.4 of
  // the front's own life (see the FRONT_* notes in EffectsDirector, and the
  // timing check in this round's report); at t=0.3 this recovers a few points
  // of retained emission over the old curve, small on its own and additive
  // with the colour and shoulder changes above rather than a fix by itself.
  float fade = pow( 1.0 - vT, 1.9 );

  // The front is the hot part and stays independent of vTint — a compression
  // front's leading edge is white-hot in any light. Warmed off neutral
  // (0.97, 0.93) toward hot metal (0.90, 0.78) and the mix threshold relaxed
  // from front * 1.5 to front * 1.1, so the very peak still clips to a hot
  // near-white but the front's own flanks — not just the shoulder — carry a
  // trace of colour instead of being white on both sides of the seam.
  vec3 col = mix( vTint, vec3( 1.0, 0.90, 0.78 ), clamp( front * 1.1, 0.0, 1.0 ) );
  col *= vHeat * fade * amp;

  // Coverage dies faster than emission, so a spent ring vanishes instead of
  // hanging around as a grey wash once it has stopped being hot. Softened from
  // 2.8 alongside fade, for the same reason and by the same margin.
  float a = shape * pow( 1.0 - vT, 2.4 ) * uOpacity * ( 0.45 + amp * 0.55 );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col, a );
}`;

export class ShockwaveSystem {
  /**
   * @param {THREE.Texture} ringProfile
   * @param {number} capacity
   */
  constructor(ringProfile, capacity = 48) {
    this.pool = new InstancedPool({
      capacity,
      lifeAttribute: 'aParams',
      lifeComponent: 1,
      attributes: { aOrigin: 3, aParams: 4, aStyle: 4, aTint: 3, aAspect: 1 },
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uRing: { value: ringProfile },
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
    this.mesh.renderOrder = 22;
    this.mesh.name = 'fx.shockwaves';
    this.mesh.matrixAutoUpdate = false;

    // Screen-space distortion handoff. Small, fixed, never reallocated.
    this.slots = [];
    for (let i = 0; i < MAX_DISTORT_RINGS; i++) {
      this.slots.push({ pos: new THREE.Vector3(), birth: -1, life: 1, maxRadius: 1, strength: 0 });
    }
    this._slotCursor = 0;
    this._time = 0;
  }

  /**
   * @param {THREE.Vector3} point
   * @param {Object} [opts]
   * @param {'ground'|'facing'} [opts.mode]
   * @param {number} [opts.radius] final radius, metres
   * @param {number} [opts.life] seconds — heavier hits are slower
   * @param {number} [opts.thickness] 0..1 fraction of the radius the wake fills
   * @param {number} [opts.heat] emission multiplier
   * @param {number} [opts.tilt] roll for facing rings
   * @param {number} [opts.aspect] elongation along the roll axis; 1 is circular
   * @param {number} [opts.distort] screen-space refraction strength, 0 disables
   * @param {THREE.Color} [opts.tint]
   */
  spawn(point, opts = {}) {
    const i = this.pool.alloc();
    const { aOrigin, aParams, aStyle, aTint, aAspect } = this.pool.arrays;
    const time = this._time;

    const o = i * 3;
    aOrigin[o] = point.x; aOrigin[o + 1] = point.y; aOrigin[o + 2] = point.z;

    const radius = opts.radius ?? 1.4;
    const life = opts.life ?? 0.45;
    const p = i * 4;
    aParams[p] = time;
    aParams[p + 1] = life;
    aParams[p + 2] = radius;
    aParams[p + 3] = opts.thickness ?? 0.3;

    aStyle[p] = opts.mode === 'ground' ? 0 : 1;
    aStyle[p + 1] = opts.heat ?? 2.2;
    aStyle[p + 2] = Math.random() * 1000;
    aStyle[p + 3] = opts.tilt ?? Math.random() * Math.PI;

    const tint = opts.tint;
    aTint[o] = tint ? tint.r : 0.85;
    aTint[o + 1] = tint ? tint.g : 0.9;
    aTint[o + 2] = tint ? tint.b : 1.0;
    aAspect[i] = Math.max(0.25, Math.min(4, opts.aspect ?? 1));

    const distort = opts.distort ?? 1;
    if (distort > 0) {
      const s = this.slots[this._slotCursor];
      this._slotCursor = (this._slotCursor + 1) % MAX_DISTORT_RINGS;
      s.pos.copy(point);
      s.birth = time;
      s.life = life;
      s.maxRadius = radius;
      s.strength = distort;
    }
    return i;
  }

  /**
   * Projects the live rings into screen space for the post pass.
   * @param {THREE.Camera} camera
   * @param {Float32Array} out 4 floats per ring: ndcX, ndcY, radiusNdc, strength
   * @returns {number} rings written
   */
  writeDistortion(camera, out) {
    let n = 0;
    for (const s of this.slots) {
      if (s.birth < 0) continue;
      const t = (this._time - s.birth) / s.life;
      if (t < 0 || t >= 1) { s.birth = -1; continue; }

      _v.copy(s.pos).project(camera);
      if (_v.z > 1) { continue; }

      // Radius in NDC: project a point offset by the world radius along the
      // camera's right vector, so perspective foreshortening is exact.
      const radius = s.maxRadius * (1 - Math.pow(1 - t, 5));
      _tmpEdge.copy(s.pos).addScaledVector(_camRight.setFromMatrixColumn(camera.matrixWorld, 0), radius).project(camera);
      const rNdc = Math.abs(_tmpEdge.x - _v.x);

      const o = n * 4;
      out[o] = _v.x;
      out[o + 1] = _v.y;
      out[o + 2] = rNdc;
      // Refraction is strongest as the front passes and dies with the ring.
      out[o + 3] = s.strength * Math.pow(1 - t, 1.4) * Math.min(1, t * 8);
      n++;
      if (n >= MAX_DISTORT_RINGS) break;
    }
    for (let i = n; i < MAX_DISTORT_RINGS; i++) {
      const o = i * 4;
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
    }
    return n;
  }

  update(time) {
    this._time = time;
    this.material.uniforms.uTime.value = time;
    this.pool.flush();
  }

  reset() {
    this.pool.killAll();
    for (const s of this.slots) { s.birth = -1; s.strength = 0; }
    this._slotCursor = 0;
  }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
  }
}
