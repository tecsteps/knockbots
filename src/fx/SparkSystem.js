/**
 * Knockbots — impact sparks.
 *
 * A burst is a single write of instance attributes: origin, velocity, birth
 * time, life, seed and size. After that the CPU never touches the particle
 * again — the vertex shader integrates the trajectory analytically from the
 * spawn state (including up to three floor bounces) every frame. Three hundred
 * sparks therefore cost one small buffer upload and one draw call, and hitstop
 * or slow motion are free because they only change how fast `uTime` advances.
 *
 * Three details do most of the visual work:
 *
 *  - **Velocity-stretched billboards.** A spark is a streak, not a dot. The quad
 *    is aligned to the screen-space velocity and its length scales with speed,
 *    with the bright head pinned to the particle position and the tail trailing
 *    behind it. Stretch is clamped so a fast spark never becomes a laser.
 *  - **Three size tiers per burst.** A burst whose particles are all one size
 *    reads as a puff however many of them there are, because nothing in it
 *    establishes scale. See `TIERS`.
 *  - **A real cooling curve.** `sparkEmission` walks a blackbody hue path and
 *    drops luminance with a steep power law, so the burst reads as white-hot
 *    metal for two frames and cherry-red embers for the rest of its life — which
 *    is what makes a hit feel like it happened to metal.
 *
 * Sparks are additive, never write depth, and test against it, so they occlude
 * correctly behind the fighters without needing to be sorted.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_BALLISTIC, GLSL_TEMPERATURE, GLSL_BILLBOARD, GLSL_HASH } from './FxShaders.js';

const _dir = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bit = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _alt = new THREE.Vector3(1, 0, 0);

/**
 * Size tiers inside a single burst.
 *
 * One uniform spark size is why a burst reads as a puff. Three populations with
 * an order of magnitude between the smallest and the largest read as debris
 * instead: a haze of fine motes carries the volume, a smaller set of mid streaks
 * carries the direction, and a handful of large fragments carry the weight and
 * are what the eye actually tracks across the frame.
 *
 * `frac` is the share of the burst; `size`, `speed` and `life` scale the burst's
 * nominal values. `streak` is how far the quad smears along its velocity — motes
 * are pure filaments, and fragments are chips of armour plate that tumble about
 * their own axis rather than smearing at all, which is what separates them in
 * the eye from the molten oxide around them.
 */
const TIERS = [
  { frac: 0.60, size: 0.24, speed: 1.35, life: 0.66, streak: 1.6 },
  { frac: 0.30, size: 0.90, speed: 1.00, life: 1.00, streak: 1.0 },
  { frac: 0.10, size: 2.40, speed: 0.55, life: 1.45, streak: 0.0 },
];

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aLife;    // birth, life, seed, size
attribute vec3 aTint;
attribute vec2 aStyle;   // streak weight, tumble phase

uniform float uTime;
uniform float uFloorY;
uniform float uSizeScale;
uniform float uStreak;
uniform float uHeat;

varying vec2 vUv;
varying vec3 vColor;

${GLSL_HASH}
${GLSL_BALLISTIC}
${GLSL_TEMPERATURE}
${GLSL_BILLBOARD}

void main() {
  float birth = aLife.x;
  float life  = aLife.y;
  float seed  = aLife.z;
  float size  = aLife.w;

  float age = uTime - birth;
  float t = age / max( life, 1e-4 );
  if ( life <= 0.0 || t < 0.0 || t >= 1.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vColor = vec3( 0.0 );
    vUv = vec2( 0.0 );
    return;
  }

  vec3 vel;
  float bounces;
  vec3 p = ballistic( aOrigin, aVel, age, uFloorY, vel, bounces );

  float speed = length( vel );
  float sz = size * uSizeScale * ( 0.4 + 0.6 * ( 1.0 - t ) );
  float streakK = aStyle.x;

  vec4 mv;
  if ( streakK < 0.02 ) {
    // A fragment is a chip of plate, not a filament: it tumbles about its own
    // axis at a rate set by how much of the blow it took.
    float roll = aStyle.y + age * ( 5.0 + fract( aStyle.y ) * 12.0 );
    mv = billboard( p, position.xy, sz, roll );
  } else {
    // Head of the streak sits on the particle; the body trails behind it.
    float len = sz * ( 1.0 + clamp( speed * uStreak * streakK, 0.0, 11.0 ) );
    vec2 corner = vec2( position.x, position.y - 0.5 );
    float along;
    mv = streakBillboard( p, vel, corner, sz, len, along );
  }
  gl_Position = projectionMatrix * mv;

  vUv = vec2( uv.x, 1.0 - uv.y );

  // Sparks are shedding oxide: they sputter. Fragments carry enough thermal
  // mass to burn steadily, so the sputter is scaled by how fine the particle is.
  // Bounced sparks have given up energy to the floor and burn cooler, but only a
  // little — a spark that dies the instant it touches the ground takes the whole
  // ember phase with it.
  float sputter = 0.3 * clamp( streakK, 0.25, 1.5 );
  float flicker = 1.0 - sputter + sputter * sin( seed * 61.7 + uTime * 78.0 + hash11( seed ) * 6.28 );
  float heat = uHeat * flicker * exp( -bounces * 0.18 );
  vColor = sparkEmission( t, heat ) * aTint;
}`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vColor;

void main() {
  vec4 tex = texture2D( uMap, vUv );
  float a = tex.a * uOpacity;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( vColor * tex.rgb, a );
}`;

export class SparkSystem {
  /**
   * @param {THREE.Texture} map spark streak texture
   * @param {number} capacity max simultaneous sparks
   * @param {number} floorY
   */
  constructor(map, capacity = 3072, floorY = 0) {
    this.pool = new InstancedPool({
      capacity,
      lifeAttribute: 'aLife',
      lifeComponent: 1,
      attributes: { aOrigin: 3, aVel: 3, aLife: 4, aTint: 3, aStyle: 2 },
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: map },
        uFloorY: { value: floorY },
        uGravity: { value: -26.0 },
        uRestitution: { value: 0.42 },
        uTangentFriction: { value: 0.66 },
        uDrag: { value: 0.82 },
        uSizeScale: { value: 1 },
        uStreak: { value: 0.17 },
        uHeat: { value: 1.0 },
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
    this.mesh.renderOrder = 20;
    this.mesh.name = 'fx.sparks';
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * Emits a cone of sparks oriented by a surface normal, split across the three
   * size tiers so the burst has a scale hierarchy rather than a single grain.
   * @param {THREE.Vector3} point contact point in world space
   * @param {THREE.Vector3} normal hit normal; the cone axis
   * @param {Object} [opts]
   * @param {number} [opts.count]   total across all tiers
   * @param {number} [opts.speed]   mean ejection speed, m/s
   * @param {number} [opts.spread]  0 = pencil beam, 1 = full hemisphere
   * @param {number} [opts.life]    seconds
   * @param {number} [opts.size]    metres
   * @param {number} [opts.heat]   peak radiance at ignition
   * @param {THREE.Color|{r:number,g:number,b:number}} [opts.tint]
   * @param {THREE.Vector3} [opts.inherit] velocity added to every spark
   */
  burst(point, normal, opts = {}) {
    const total = Math.max(1, Math.round(opts.count ?? 40));
    const speed = opts.speed ?? 7.5;
    const spread = opts.spread ?? 0.55;
    const life = opts.life ?? 0.9;
    const size = opts.size ?? 0.035;
    const tint = opts.tint;
    const inherit = opts.inherit;

    _dir.copy(normal);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
    _dir.normalize();
    // Orthonormal basis about the hit normal so the cone is exact.
    _tan.copy(Math.abs(_dir.y) > 0.9 ? _alt : _up).cross(_dir).normalize();
    _bit.copy(_dir).cross(_tan).normalize();

    const { aOrigin, aVel, aLife, aTint, aStyle } = this.pool.arrays;
    const cap = this.pool.capacity;
    const first = this.pool.allocRun(total);
    const time = this.material.uniforms.uTime.value;

    // Per-burst radiance rides in the tint: one extra attribute would buy
    // nothing that a scaled colour does not already carry.
    const heat = opts.heat ?? 3.0;
    const tr = (tint ? tint.r : 1) * heat;
    const tg = (tint ? tint.g : 1) * heat;
    const tb = (tint ? tint.b : 1) * heat;

    let k = 0;
    for (let ti = 0; ti < TIERS.length; ti++) {
      const tier = TIERS[ti];
      // The last tier takes the remainder so rounding never loses a particle
      // or overruns the run that was just claimed.
      const n = ti === TIERS.length - 1
        ? total - k
        : Math.min(total - k, Math.round(total * tier.frac));

      for (let j = 0; j < n; j++, k++) {
        const i = (first + k) % cap;

        // Cosine-lobe about the normal, widened by `spread`. Fragments are
        // heavy, so they hold the line of the blow more tightly than the motes.
        const lobe = spread * (ti === 2 ? 0.7 : 1);
        const u = Math.random();
        const phi = Math.random() * Math.PI * 2;
        const cosT = 1 - u * lobe * lobe;
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const cx = Math.cos(phi) * sinT;
        const cz = Math.sin(phi) * sinT;

        // Heavy tail on speed: a few sparks fly much further than the rest,
        // which is what stops a burst from looking like a uniform puff.
        const r = Math.random();
        const sp = speed * tier.speed * (0.35 + r * r * r * 2.1);

        let vx = (_dir.x * cosT + _tan.x * cx + _bit.x * cz) * sp;
        let vy = (_dir.y * cosT + _tan.y * cx + _bit.y * cz) * sp;
        let vz = (_dir.z * cosT + _tan.z * cx + _bit.z * cz) * sp;
        if (inherit) { vx += inherit.x; vy += inherit.y; vz += inherit.z; }

        const o = i * 3;
        // Jitter the origin inside a small ball so the burst has volume.
        aOrigin[o] = point.x + (Math.random() - 0.5) * 0.06;
        aOrigin[o + 1] = point.y + (Math.random() - 0.5) * 0.06;
        aOrigin[o + 2] = point.z + (Math.random() - 0.5) * 0.06;
        aVel[o] = vx; aVel[o + 1] = vy; aVel[o + 2] = vz;
        aTint[o] = tr; aTint[o + 1] = tg; aTint[o + 2] = tb;

        const l = i * 4;
        aLife[l] = time;
        aLife[l + 1] = life * tier.life * (0.62 + Math.random() * 0.7);
        aLife[l + 2] = Math.random() * 1000;
        // Kept narrow within a tier: the spread that matters is between tiers,
        // and widening it here just blurs the three populations back into one.
        aLife[l + 3] = size * tier.size * (0.75 + Math.random() * 0.5);

        const s = i * 2;
        aStyle[s] = tier.streak;
        aStyle[s + 1] = Math.random() * 6.283;
      }
    }
  }

  /** @param {number} time seconds, shared FX clock */
  update(time) {
    this.material.uniforms.uTime.value = time;
    this.pool.flush();
  }

  /** @param {number} scale global size multiplier for the quality tier */
  setScale(scale) { this.material.uniforms.uSizeScale.value = scale; }

  reset() {
    this.pool.killAll();
  }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
  }
}
