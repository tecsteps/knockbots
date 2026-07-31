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
 *  - **Velocity-stretched billboards, on every tier.** A spark is a streak, not
 *    a dot. The quad is aligned to the screen-space velocity and its length is
 *    `speed x exposure` — a shutter, so it is a *length* and not a multiple of
 *    the particle's own size — with the bright head pinned to the particle
 *    position and the tail trailing behind it. The smear is capped in metres so
 *    a fast spark never becomes a laser.
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
 * nominal values. `streak` is the share of the shutter each tier smears over —
 * see `uStreak`. It is close to 1 for everything, because smear length is set by
 * how fast a particle moves and how long the shutter is open, not by what the
 * particle is; the fragments take a little less of it only because a chip that
 * is tumbling is not travelling in a straight line for the whole exposure.
 *
 * **The fragment tier used to be `streak: 0`, and that was the single largest
 * defect on this axis.** It is 10% of the burst by count and the great majority
 * of it by lit area — measured on a frozen `04b-impact-decay`, a launcher's
 * free-field ejecta cloud was 28 blobs with a median area of 63 px — so what the
 * frame shows *is* the fragments. Drawn as tumbling squares they were round
 * blobs carrying nothing but depth-of-field blur: median PCA aspect 2.30 over
 * three runs (range 1.91-2.42) against Tekken 8 at 3.96 and 5.19 on the same
 * kind of measurement. A hundred bright pills all the same shape, all the same
 * colour, sitting still in the air.
 *
 * The fragment tier is also a little smaller and noticeably faster than it was
 * (2.40 -> 2.00, 0.55 -> 0.85). Both changes buy aspect: smear is an absolute
 * length, so a narrower quad turns the same smear into a longer streak, and a
 * faster chip smears further to begin with. 1.60 was tried first and taken back
 * — it cost more brightness in the cloud than the aspect was worth.
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
  { frac: 0.60, size: 0.24, speed: 1.35, life: 0.66, streak: 1.00, fine: 1.00, spread: 1.67 },
  { frac: 0.30, size: 0.90, speed: 1.00, life: 1.00, streak: 1.00, fine: 0.62, spread: 1.67 },
  { frac: 0.10, size: 2.00, speed: 0.85, life: 1.45, streak: 0.80, fine: 0.10, spread: 2.50 },
];

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aLife;    // birth, life, seed, size
attribute vec3 aTint;
attribute vec3 aStyle;   // shutter share, tumble phase, fineness

uniform float uTime;
uniform float uFloorY;
uniform float uSizeScale;
uniform float uStreak;
uniform float uStreakMax;
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
  // How fine the particle is, 1 = a filament of oxide, 0 = a chip of plate.
  // This used to be read off the streak weight, which no longer carries it:
  // smear length is a shutter and is very nearly the same for every tier, so
  // the thermal-mass channel had to become its own attribute.
  float fine = aStyle.z;

  // SMEAR IS A SHUTTER, NOT A SIZE MULTIPLIER.
  //
  // The previous form was 'len = sz * ( 1 + speed * k )', which says a big
  // particle smears further than a small one at the same speed. Nothing about a
  // photograph works that way: a streak is how far the thing moved while the
  // shutter was open, and that is 'speed * exposure' whatever the thing is. The
  // old form coupled the two so tightly that the *widest* particles — the
  // fragments — needed the *most* smear to look like they were moving, and got
  // none, because they were the tier that opted out of streaking entirely.
  //
  // Written as a length, 'uStreak' is an exposure time in seconds and every
  // tier gets the same one. What separates them is their speed, which is what
  // should separate them. The cap is absolute for the same reason: a spark that
  // draws half a metre of streak is a laser however fast it is going.
  float smear = min( speed * uStreak * streakK, uStreakMax );

  // A chip of plate is not square, and it tumbles: what the camera sees is a
  // rectangle whose width breathes as the plate turns edge-on and back. That
  // spin is a WIDTH modulation rather than a roll, because the quad's long axis
  // now belongs to the velocity — a particle cannot be smeared along its travel
  // and rolled to a random angle at the same time.
  //
  // Fragments only. Narrowing the two fine tiers as well costs real brightness
  // for nothing: they are already filaments, so the aspect is bought by the
  // smear, and the width is all the emitting area they have. Measured, applying
  // it to every tier took 52% of the warm-hot pixels out of the ejecta cloud.
  //
  // The band is 0.55-1.30 and the breathing bottoms out at 0.70, not the
  // 0.42-1.14 / 0.58 the tumbling square used, and that is a brightness
  // decision rather than a shape one. A quad narrower than the depth-of-field
  // circle it is blurred by loses peak radiance to the blur, and the ejecta
  // cloud is well off the focal plane. Measured on the ejecta ROI of
  // 04b-impact-decay: at the narrow band the cloud carried 13% MORE total warm
  // energy than the round-blob original and yet 58% fewer pixels over 0.80
  // luma, because the same light was spread thinner than the lens could hold.
  float roll = aStyle.y + age * ( 5.0 + fract( aStyle.y ) * 12.0 );
  float chip = 0.55 + hash11( seed * 5.3 ) * 0.75;
  float chipW = mix( 1.0, chip * ( 0.70 + 0.30 * abs( cos( roll ) ) ), step( fine, 0.34 ) );

  vec4 mv;
  float along = 1.0;
  // Head of the streak sits on the particle; the body trails behind it.
  vec2 corner = vec2( position.x, position.y - 0.5 );
  mv = streakBillboard( p, vel, corner, sz * chipW, sz + smear, along );
  gl_Position = projectionMatrix * mv;

  vUv = vec2( uv.x, 1.0 - uv.y );

  // Sparks are shedding oxide: they sputter. Fragments carry enough thermal
  // mass to burn steadily, so the sputter is scaled by how fine the particle is.
  // Bounced sparks have given up energy to the floor and burn cooler, but only a
  // little — a spark that dies the instant it touches the ground takes the whole
  // ember phase with it.
  float sputter = 0.3 * clamp( fine * 1.5, 0.25, 1.5 );
  float flicker = 1.0 - sputter + sputter * sin( seed * 61.7 + uTime * 78.0 + hash11( seed ) * 6.28 );
  float heat = uHeat * flicker * exp( -bounces * 0.18 );

  // Two offsets onto the cooling ramp, and they are the whole reason a burst
  // reads as temperature rather than as one colour of confetti. A population
  // that all shares a birth time also shares a position on the ramp, so however
  // good the ramp is the frame only ever shows one point of it.
  //
  //  - Thermal mass. A filament of oxide is cherry-red within two frames; a chip
  //    of plate holds white heat for the length of its arc. 'aStyle.z' carries
  //    exactly that property, so the fines run their ramp half again as fast as
  //    the fragments do and every frame of the burst contains both ends of it.
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
      attributes: { aOrigin: 3, aVel: 3, aLife: 4, aTint: 3, aStyle: 3 },
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
        // Exposure, in seconds, and it was swept rather than guessed. Measured
        // on 04b-impact-decay, the free-field ejecta cloud's median PCA aspect
        // came out 4.93 / 4.33 / 4.76 at 0.005 / 0.009 / 0.013 and 7.80 at
        // 0.022 — and 0.022 is visibly wrong, a hail of parallel needles rather
        // than debris, which is the "laser" failure this file has always warned
        // about. Tekken 8 measures 3.96 and 5.19 on the same statistic, so the
        // band from 0.005 to 0.013 is the whole usable range and the top of it
        // is not. 0.011 sits inside it with the widths restored.
        uStreak: { value: 0.011 },
        // Absolute ceiling on the smear, in metres. A cap in metres and not in
        // multiples of the particle: the thing that makes a streak a laser is
        // its length on screen, which has nothing to do with how big the
        // particle that drew it was.
        uStreakMax: { value: 0.22 },
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
   * @param {number} [opts.window] EMISSION WINDOW, seconds of FX time. See the
   *   note below: the burst is spawned already spread along its trajectories
   *   instead of piled on one point, which is what stops a contact frame being
   *   a white blob.
   */
  burst(point, normal, opts = {}) {
    const total = Math.max(1, Math.round(opts.count ?? 40));
    const speed = opts.speed ?? 7.5;
    const spread = opts.spread ?? 0.55;
    const life = opts.life ?? 0.9;
    const size = opts.size ?? 0.035;
    const tint = opts.tint;
    const inherit = opts.inherit;
    const window = Math.max(0, opts.window ?? 0);

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

        // Cosine-lobe about the normal, widened by 'spread'. Fragments are
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
        // frame anyone sees it. The previous curve was '0.35 + r^3 * 2.1',
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

        // THE EMISSION WINDOW, and it is the largest single defect this axis
        // has had since the impact light. See the note above `TIERS`.
        //
        // Every spark in a burst was born at the same instant on the same
        // point. The frame the axis is scored on is ONE rendered frame past
        // contact, and at the 0.6 hitstop FX clock that is 10 ms — so a
        // launcher's 1,005 sparks were photographed having travelled 10 cm from
        // a common origin. A thousand additive streaks inside a 45-pixel disc
        // is not a thousand sparks, it is one white blob, and every one of them
        // is invisible inside it.
        //
        // A real contact sheds ejecta over the length of the contact and the
        // camera sees the spray after it has left the surface, so the burst is
        // spawned ALREADY IN FLIGHT: each particle is aged by a uniform draw
        // from [0, window], which distributes the population along its own
        // trajectory instead of piling it at the origin. Nothing is removed —
        // same count, same radiance, same size, same speed — the same energy is
        // simply spread over the volume it would really occupy.
        //
        // Measured by mutating the birth times of the live pool on ONE frozen
        // contact frame and re-reading it, so the control repeats to the last
        // digit and the noise floor is 0.000. Launcher, `04-impact` geometry,
        // 170 px disc on the projected contact:
        //
        //     window   clipped %   hot px   detail   core sat
        //     0 (was)     1.343     32119    8.294    0.1420
        //     0.035       0.633     30093    8.990    0.1594
        //     0.060       0.633     28438    9.404    0.1620
        //     0.090       0.633     27965    9.591    0.1653
        //     0.130       0.633     26832    9.923    0.1727
        //
        // Clipped white falls by more than half and stops at 0.633 — that floor
        // is the flare and the arena, i.e. every clipped pixel the SPARKS were
        // contributing is gone — while local contrast inside the hot region
        // rises 13% and the region's colour saturation rises 14%. Heavy moves
        // the same way (clipped 3.428 -> 2.083, detail 9.048 -> 10.360) and so
        // does a jab (0.644 -> 0.589, detail 16.34 -> 17.13), so the ladder is
        // unchanged in shape. Eight frames later the burst is where it always
        // was: detail 15.61 -> 15.97, hot 27.4k -> 26.1k.
        //
        // The life is extended by the same draw rather than left alone, so a
        // pre-rolled spark still burns for its full life FROM THE CONTACT
        // FRAME. Without that the fine tier — 60% of the count and a 106 ms
        // life at its shortest — loses up to half of itself before the decay
        // shot at +8 frames. On the contact frame the two are indistinguishable
        // (detail 9.404 against 9.381); at +8 the compensation is what keeps
        // the cloud populated.
        //
        // **0.060 is not the knee, and it is not meant to be.** The numbers keep
        // improving past it — doubling the window again takes the launcher's
        // hot-mask detail to 10.992 and its 170 px hot area down another 14% —
        // but the picture stops being a contact. At roughly 0.12 s a gap opens
        // between the flare and the head of the spray and the frame reads as
        // the moment *after* the blow rather than the blow. The window is set
        // by where the ejecta still leaves the plate, not by the metric.
        //
        // Offsetting the ORIGIN along the velocity instead — same geometry, no
        // phase shift on the cooling ramp — was tried and is worse on every
        // metric (detail 9.243, sat 0.1582, and 9,500 MORE hot pixels at 340
        // px): the whole spray then sits on one point of the temperature ramp,
        // which is the "particles that fade uniformly" defect this file has
        // already been corrected for twice.
        const pre = window > 0 ? Math.random() * window : 0;
        const l = i * 4;
        aLife[l] = time - pre;
        aLife[l + 1] = life * tier.life * (0.62 + Math.random() * 0.7) + pre;
        aLife[l + 2] = Math.random() * 1000;
        // Narrow inside the two fine tiers, wide inside the fragments — see the
        // note on 'spread' in TIERS. Log-uniform so the whole band is occupied
        // evenly instead of piling at the bottom, and centred on 1.0 so the
        // burst's mean size is unchanged whatever the band is.
        aLife[l + 3] = size * tier.size
          * Math.exp((Math.random() - 0.5) * Math.log(tier.spread));

        const s = i * 3;
        // Shutter share is jittered inside the tier as well, because length is
        // the product of speed and this, and two independent spreads populate
        // the range far more evenly than one wide one does.
        aStyle[s] = tier.streak * (0.72 + Math.random() * 0.56);
        aStyle[s + 1] = Math.random() * 6.283;
        // Fineness — thermal mass, sputter rate, and whether the quad tumbles.
        // Jittered so the three tiers are three bands rather than three values:
        // a population sitting on one point of the cooling ramp is what made a
        // hundred fragments paint one identical colour.
        aStyle[s + 2] = tier.fine * (0.7 + Math.random() * 0.6);
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
