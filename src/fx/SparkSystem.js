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
 *  - **A real cooling curve.** `sparkEmission` walks a blackbody hue path from
 *    white through pale yellow and orange to a cherry red that is well under the
 *    display range, and drops luminance far faster than it drops hue. That is
 *    what makes a hit feel like it happened to metal, and it is why bursts are
 *    tuned in tenths of a second: the curve is over long before the buffer is.
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
 *
 * `spread` is the multiplicative size band *inside* the tier, and it is not the
 * same number for all three. Keeping it narrow is right for the two fine tiers —
 * the separation that matters is between tiers, and widening it there just
 * blurs the three populations back into one. It is wrong for the fragments, and
 * measurably so: the fragment tier is the only part of a burst still alive a
 * third of a second later, so on every frame after the flare it *is* the burst,
 * and there is then nothing left in the frame to establish scale against. Read
 * out of the live pool on a frozen contact frame, a launcher's 109 fragments
 * spanned 0.062-0.138 m — and the top of that band is the jet's 1.15x size
 * multiplier rather than any real variation, so the fan's own fragments were a
 * 1.67x window. `spread` is the ratio of the widest to the narrowest in a tier:
 * 1.67 reproduces the previous `0.75 + rnd * 0.5` exactly, and 2.50 on the
 * fragments still leaves a clean gap between the populations — the mid tier
 * tops out at 1.16 against the fragments' bottom at 1.52.
 */
const TIERS = [
  { frac: 0.60, size: 0.24, speed: 1.35, life: 0.66, streak: 1.6, spread: 1.67 },
  { frac: 0.30, size: 0.90, speed: 1.00, life: 1.00, streak: 1.0, spread: 1.67 },
  { frac: 0.10, size: 2.40, speed: 0.55, life: 1.45, streak: 0.0, spread: 2.50 },
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
  float along = 1.0;
  if ( streakK < 0.02 ) {
    // A fragment is a chip of plate, not a filament: it tumbles about its own
    // axis at a rate set by how much of the blow it took.
    //
    // And it is not square. A square quad at a random roll is a lozenge at a
    // random angle, and a hundred of them with one size and one colour is the
    // "generic round sprites" line in docs/CRITIC.md's failure list — which
    // matters more than it sounds, because the fragments outlive every other
    // element of a burst by a third of a second, so after the flare they *are*
    // the burst. Giving each one its own aspect costs nothing (the hash is
    // already computed for the sputter) and turns the population into chips of
    // torn plate seen at assorted angles rather than one shape repeated.
    float roll = aStyle.y + age * ( 5.0 + fract( aStyle.y ) * 12.0 );
    float chip = 0.42 + hash11( seed * 5.3 ) * 0.72;
    mv = billboard( p, position.xy * vec2( 1.0, chip ), sz, roll );
  } else {
    // Head of the streak sits on the particle; the body trails behind it.
    float len = sz * ( 1.0 + clamp( speed * uStreak * streakK, 0.0, 11.0 ) );
    vec2 corner = vec2( position.x, position.y - 0.5 );
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

  // Two offsets onto the cooling ramp, and they are the whole reason a burst
  // reads as temperature rather than as one colour of confetti. A population
  // that all shares a birth time also shares a position on the ramp, so however
  // good the ramp is the frame only ever shows one point of it.
  //
  //  - Thermal mass. A filament of oxide is cherry-red within two frames; a chip
  //    of plate holds white heat for the length of its arc. aStyle.x already
  //    sorts the tiers by exactly the property that decides this — how fine the
  //    particle is — so the fines run their ramp half again as fast as the
  //    fragments do, and every frame of the burst contains both ends of it.
  //  - Along the streak. The head of a smear is the particle now; the tail is
  //    where it was two frames ago and has had two frames to cool. Shading the
  //    quad from head to tail is free — streakBillboard already returns the
  //    coordinate — and it is what a photograph of a spark actually looks like.
  //
  // Both are clamped at the mid tier. Letting the fines run away puts most of
  // the burst's particles at the dim end of the ramp on the contact frame, and
  // the hit loses the punch that the count was bought for.
  //
  // A third offset, and it is the one that was missing. Thermal mass varied
  // between tiers and not at all within one, so every particle of a tier sat on
  // exactly the same point of the ramp on every frame of its life. Measured out
  // of the live pool on a frozen contact frame, a launcher's 109 fragments had
  // a ramp position of 0.172 with a standard deviation of 0.038, and the red
  // and green channels of the colour that produces had a standard deviation of
  // *zero* — one hundred and nine particles painting one identical colour.
  // That is docs/CRITIC.md's "particles that fade uniformly", exactly.
  //
  // Two chips off the same plate do not cool at the same rate; the ratio is set
  // by their surface-to-volume, which varies as much within a size band as it
  // does between bands. Centred on 1.0, so the burst's mean brightness on the
  // contact frame is unchanged and only its variance goes up.
  float fine = clamp( streakK, 0.0, 1.0 );
  float mass = 0.68 + hash11( seed * 2.7 ) * 0.64;
  float tt = t * ( 1.0 + 0.30 * fine ) * mass + ( 1.0 - along ) * 0.28 * fine;
  vColor = sparkEmission( clamp( tt, 0.0, 1.0 ), heat ) * aTint;
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
        uStreak: { value: 0.30 },
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
        //
        // A clean cone has a clean edge, and a clean edge is what turns a fan
        // into a swept arc — the eye reads the boundary rather than the debris.
        // One spark in fourteen is thrown well outside it, so the fan has
        // stragglers the way a real one does without the bulk of the burst
        // losing the line of the blow.
        const wide = Math.random() < 0.07 ? 2.3 : 1;
        const lobe = Math.min(1, spread * (ti === 2 ? 0.7 : 1) * wide);
        const u = Math.random();
        const phi = Math.random() * Math.PI * 2;
        const cosT = 1 - u * lobe * lobe;
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const cx = Math.cos(phi) * sinT;
        const cz = Math.sin(phi) * sinT;

        // Speed decides streak length, so its distribution is the distribution
        // of streak lengths, and that is what a burst is read by on the one
        // frame anyone sees it. The previous curve was `0.35 + r^3 * 2.1`,
        // which does have a heavy tail — but a cubed uniform puts half the
        // population between 0.35 and 0.61, a 1.7x window. Half the fan was
        // therefore drawn at one length with a handful of long fliers around
        // it, which reads as a texture with some noise on it rather than as
        // debris of assorted mass.
        //
        // Log-uniform gives every part of the band the same share of the
        // population instead of piling it at the bottom: 0.44 to 1.32 is a
        // clean 3x, evenly occupied. The fliers are then explicit rather than
        // emergent — one spark in fourteen at two to three times the top of
        // the band — and the two together keep the burst's mean speed where
        // the cubed curve had it, so nothing downstream needs retuning.
        const speedSpread = 0.44 * Math.exp(Math.random() * 1.1);
        const flier = Math.random() < 0.07 ? 1.7 + Math.random() * 1.2 : 1;
        const sp = speed * tier.speed * speedSpread * flier;

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
        // Narrow inside the two fine tiers, wide inside the fragments — see the
        // note on `spread` in TIERS. Log-uniform so the whole band is occupied
        // evenly instead of piling at the bottom, and centred on 1.0 so the
        // burst's mean size is unchanged whatever the band is.
        aLife[l + 3] = size * tier.size
          * Math.exp((Math.random() - 0.5) * Math.log(tier.spread));

        const s = i * 2;
        // Streak weight is jittered inside the tier as well, because length is
        // the product of speed and this, and two independent spreads populate
        // the range far more evenly than one wide one does. Scaling rather
        // than offsetting is what keeps the fragment tier at exactly zero, so
        // chips of plate go on tumbling instead of smearing.
        aStyle[s] = tier.streak * (0.72 + Math.random() * 0.56);
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
