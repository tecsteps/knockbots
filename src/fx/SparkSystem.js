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
/** Scratch for the per-tier counts; `burst` must not allocate. */
const _counts = [];

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
/**
 * THE SPALL TIER, AND WHY IT IS AN ADDITION RATHER THAN A REDISTRIBUTION
 * ---------------------------------------------------------------------
 * Measured with the round-31 gate — `tools/fxgate.py --attrib`, which isolates
 * the sparks by hiding that one system on a frozen contact frame, so what is
 * being described here is the spark layer alone and nothing else:
 *
 *     04-impact        74 spark components, largest 74,584 px, top 3 = 92.5%
 *                      of all spark ink, 29% of that component over E 0.6
 *     16-impact-heavy 171 spark components, largest 40,131 px, top 3 = 65.9%
 *
 * Look at the isolated mask and the diagnosis is unambiguous: the outer third of
 * the fan is already a field of clean separated dashes and reads well, and the
 * inner two thirds is ONE fused saturated wedge that holds nine tenths of the
 * light. "A few large blobs where the references carry many small ones" is not a
 * statement about how many particles are emitted. It is a statement about how
 * many of them SURVIVE AS SEPARATE OBJECTS, and ours do not survive because the
 * whole burst leaves one point inside one narrow lobe and the streaks overlap
 * laterally before they have travelled far enough to part.
 *
 * The count is not the problem, and that was tested rather than assumed. Driving
 * `countScale` to 3 — three times the sparks, same geometry, same everything —
 * raises the discrete component count on all four gate shots, and on the two
 * flagships the ranges do not overlap at all (16-impact-heavy N 106-219 at 1x
 * against 223-233 at 3x; 04-impact 114-155 against 192-212). **The round-28
 * reading that a bigger population "crowded out" the existing one through the
 * pool or the alpha budget does not reproduce in either direction.** More
 * sparks make more particles, and by the alternating-hold cost probe they are
 * free: +0.2 ms at the contact frame at native 1080p, unchanged at 3x.
 *
 * So the new population is thrown OUT of the fan — a full hemisphere about the
 * normal at double the speed — as particles a tenth the size of the burst's
 * nominal. That is spall: the fine cold scatter that leaves a real impact in
 * every direction while the hot jet goes one way. It lands as discrete specks
 * across the frame, which is exactly the population the reference frames carry
 * and ours had none of.
 *
 * IT IS ADDED, NOT TAKEN, AND THAT WAS THE FIRST ATTEMPT'S MISTAKE.
 * The first cut of this took the spall out of the existing three tiers, holding
 * the emitted count fixed at 0.34 / 0.34 / 0.24 / 0.08 — the last three being
 * 0.60 / 0.30 / 0.10 scaled by 0.66, so the size hierarchy was untouched. It
 * worked on the statistic it was aimed at and paid for it everywhere else.
 * Measured, 5 runs before against 5 after:
 *
 *     04-impact          N 127 -> 198   maj90 45.6 -> 35.0   BUT energy 3.05 -> 2.23
 *     16-impact-heavy    N 140 -> 244   maj90 44.1 -> 52.1       energy 2.64 -> 2.07
 *     04b-impact-decay   N 163 -> 161   maj90 76.8 -> 50.8       energy 1.62 -> 0.90
 *
 * A third of the burst's light was moved into particles a tenth the area and
 * 15% dimmer, so the hit lost 22-44% of its energy — and `fine`, the share of
 * components under 6 px, went the WRONG WAY by 20-30% because the tier it was
 * mostly taken from was the fine tier. Breaking the blob by removing the light
 * that made it is not the trade this axis wants; the frame has to keep its
 * punch and gain the scatter.
 *
 * It does not have to be a trade, because the count is free. The three original
 * tiers are restored to 0.60 / 0.30 / 0.10 of the caller's count, EXACTLY as
 * they were, and the spall is emitted on top as `mult` extra particles. Nothing
 * that carried the punch has moved.
 *
 * `mult` is a multiple of the caller's count, not a share of it. `frac` is a
 * share, and the three core tiers' fracs must sum to 1.
 *
 * `gain` is a per-tier radiance multiplier folded into the tint. The spall runs
 * under the rest of the burst: it is cold ejecta, and a wide field of extra
 * particles at full radiance would simply move the blob rather than add scatter.
 *
 * `lobe` multiplies the caller's `spread`. It replaces a hardcoded `ti === 2`
 * test that did the same thing for the fragments.
 *
 * `streak` on the spall is low on purpose and it is the one place this file
 * departs from "smear is a shutter, same for every tier". At double speed and a
 * tenth the width, the shutter form would draw a 2.3-px-wide, 95-px needle:
 * below the resolving limit across and a laser along, which is the failure this
 * file has warned about since it was written, and worse, needles that long
 * re-merge with their neighbours and rebuild the blob somewhere else. The
 * physical reading is the fragment tier's argument taken further — spall tumbles
 * and does not hold a line for the whole exposure.
 *
 * **0.035 was too low, and the gate said so in the statistic that matters most
 * here.** At that value the spall is a 2.3-px disc, and a large new population
 * of discs pulled the burst's median `elong` from 2.27 to 1.74 on `04-impact`
 * and 2.64 to 1.92 on `16-impact-heavy` — toward round, which is the direction
 * of docs/CRITIC.md's "generic round sprites" complaint and one of only two
 * statistics on this axis stable enough to quote. Adding scatter is worthless if
 * the scatter is the thing being complained about. At 0.090 the spall spans
 * roughly 6-13 px major at aspect 2.7-5.8 across its own speed spread — short
 * dashes rather than dots, which is what the reference frames carry — and it is
 * still an order of magnitude short of the needle.
 */
const TIERS = [
  { frac: 0.60, size: 0.24, speed: 1.35, life: 0.66, streak: 1.00, fine: 1.00, spread: 1.67, gain: 1.00, lobe: 1.00, patch: 1.00 },
  { frac: 0.30, size: 0.90, speed: 1.00, life: 1.00, streak: 1.00, fine: 0.62, spread: 1.67, gain: 1.00, lobe: 1.00, patch: 0.55 },
  { frac: 0.10, size: 2.00, speed: 0.85, life: 1.45, streak: 0.80, fine: 0.10, spread: 2.50, gain: 1.00, lobe: 0.70, patch: 0.35 },
  { mult: 0.55, size: 0.10, speed: 2.00, life: 1.30, streak: 0.090, fine: 1.00, spread: 2.60, gain: 0.90, lobe: 2.40, patch: 1.30 },
];

/** Tiers before this index share `total`; the rest are emitted on top of it. */
const CORE_TIERS = 3;

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

  // A FOURTH OFFSET, AND IT IS A BIRTH POSITION RATHER THAN A RATE.
  //
  // The three above are all rates: they decide how fast a particle runs the
  // cooling ramp, and every one of them still starts the particle at the top of
  // it. So on the contact frame — the frame this axis is scored on, and the only
  // frame most hits are seen on — the whole population is bunched near u = 0
  // however different their rates are. Measured out of the live pool on a frozen
  // launcher contact, ramp position came out 0.172 with an SD of 0.038: a band
  // running white to pale-yellow and nothing else. That is the "uniform
  // warm-white/gold spark burst" a blind critic lost both matched pairs on, and
  // it is the reason a burst that genuinely does carry four size tiers still
  // reads as one archetype. Size and shape were already wide here — log-uniform
  // sizes over a 1.67-2.6x band, log-uniform speeds over 3x, explicit fliers,
  // per-particle streak and chip jitter. Colour was the one axis with no spread
  // in it at all, and aTint is per-BURST, so the shader is the only place the
  // spread can come from.
  //
  // It is deliberately a MINORITY OFFSET and not a widened band, because the
  // ramp is not symmetric: sparkEmission loses luminance as pow(1-u, 10),
  // an order of magnitude faster than it loses hue. Pushing the whole
  // population's mean down the ramp to buy colour variance would dim the burst
  // by most of itself, which is the trade this file has already refused once
  // over the spall tier. Instead the bulk is left exactly where it was and two
  // small slices are thrown to the ends:
  //
  //   ~20%  thrown 0.16-0.46 down the ramp: these are the deep orange and
  //         cherry streaks, the long hot-red element the reference frames carry
  //         and ours had none of.
  //   ~12%  held 0.10 back toward white: the cool bright flecks at the other
  //         end, so the frame has both ends of the ramp and not just a longer
  //         tail on one side.
  //
  // 68% of the burst is bit-identical to before, so the punch, the clipped-white
  // figure and the weight ladder all sit where they were measured.
  //
  // Both slices key off the SAME seed the other three offsets use, through a
  // different multiplier. That is the whole cost of this change: no new
  // attribute, no new buffer, no extra bytes per particle, two hashes in a
  // vertex shader that already runs four.
  float ox = hash11( seed * 9.1 );
  float toRed  = step( 0.80, ox ) * ( 0.16 + hash11( seed * 13.7 ) * 0.30 );
  float toCool = step( ox, 0.12 ) * 0.10;
  tt = tt + toRed - toCool;

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

    /**
     * Multiplies every burst's emitted count. Ships at 1 and nothing in the game
     * writes it; it exists so `tools/fxgate.py` can answer "does emitting more
     * sparks put more discrete particles on the frame?" by experiment instead of
     * by editing the recipe table, which lives in a file this workstream does not
     * own. The answer is on the record in that file and it is **no**.
     */
    this.countScale = 1;
  }

  /**
   * Emits a cone of sparks oriented by a surface normal, split across the three
   * core size tiers so the burst has a scale hierarchy rather than a single
   * grain, plus the spall field emitted on top of them. See `TIERS`.
   * @param {THREE.Vector3} point contact point in world space
   * @param {THREE.Vector3} normal hit normal; the cone axis
   * @param {Object} [opts]
   * @param {number} [opts.count]   total across the three CORE tiers. The spall
   *   tier is emitted on top of this, so the particles written are
   *   `count * (1 + mult)` — see `TIERS`.
   * @param {number} [opts.speed]   mean ejection speed, m/s
   * @param {number} [opts.spread]  0 = pencil beam, 1 = full hemisphere
   * @param {number} [opts.life]    seconds
   * @param {number} [opts.size]    metres
   * @param {number} [opts.patch]   contact-patch radius, metres; defaults to
   *   `size * 2.6`. The burst leaves from a disc this wide in the contact
   *   plane rather than from a point.
   * @param {number} [opts.heat]   peak radiance at ignition
   * @param {THREE.Color|{r:number,g:number,b:number}} [opts.tint]
   * @param {THREE.Vector3} [opts.inherit] velocity added to every spark
   * @param {number} [opts.window] EMISSION WINDOW, seconds of FX time. See the
   *   note below: the burst is spawned already spread along its trajectories
   *   instead of piled on one point, which is what stops a contact frame being
   *   a white blob.
   */
  burst(point, normal, opts = {}) {
    const total = Math.max(1, Math.round((opts.count ?? 40) * this.countScale));
    const speed = opts.speed ?? 7.5;
    const spread = opts.spread ?? 0.55;
    const life = opts.life ?? 0.9;
    const size = opts.size ?? 0.035;
    const tint = opts.tint;
    const inherit = opts.inherit;
    const window = Math.max(0, opts.window ?? 0);
    // Radius of the contact patch the burst leaves from, in metres. Derived
    // from the burst's own particle size so it rides the weight ladder without
    // a second number to keep in step: a base of 0.083 m for a jab and 0.104 m
    // for a launcher, scaled per tier by `tier.patch`. See the origin write.
    const patch = Math.max(0, opts.patch ?? size * 2.6);

    _dir.copy(normal);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
    _dir.normalize();
    // Orthonormal basis about the hit normal so the cone is exact.
    _tan.copy(Math.abs(_dir.y) > 0.9 ? _alt : _up).cross(_dir).normalize();
    _bit.copy(_dir).cross(_tan).normalize();

    const { aOrigin, aVel, aLife, aTint, aStyle } = this.pool.arrays;
    const cap = this.pool.capacity;

    // Counts are resolved before anything is claimed, because the run has to be
    // claimed once at its true length: the extra tiers are emitted ON TOP of the
    // caller's `count`, so `total` is no longer the number of particles this
    // burst writes. Claiming `total` and then writing more would silently
    // scribble over the next burst's slots.
    const counts = _counts;
    let core = 0;
    let emitted = 0;
    for (let ti = 0; ti < TIERS.length; ti++) {
      const tier = TIERS[ti];
      let n;
      if (tier.mult !== undefined) {
        n = Math.round(total * tier.mult);
      } else if (ti === CORE_TIERS - 1) {
        // The last core tier takes the remainder so rounding never loses a
        // particle or overruns.
        n = total - core;
        core += n;
      } else {
        n = Math.min(total - core, Math.round(total * tier.frac));
        core += n;
      }
      counts[ti] = n;
      emitted += n;
    }

    const first = this.pool.allocRun(emitted);
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
      const n = counts[ti];

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
        const lobe = Math.min(1, spread * tier.lobe * wide);
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
        // THE ORIGIN IS A CONTACT PATCH, NOT A POINT.
        //
        // This used to be a 6 cm cube of jitter, which projects to about
        // thirty pixels — so every trajectory in the burst started inside a
        // disc smaller than one of its own streaks and the fan was fused at
        // the apex before it had left the plate. A fist landing on armour
        // crushes a patch of it, and the ejecta leaves from all over that
        // patch. Sampled on a disc IN the contact plane (uniform in area, via
        // the sqrt), radius tied to the burst's own particle size so it stays
        // on the weight ladder: a jab is a smaller patch than a launcher.
        // Per tier, because a uniform patch cost the bottom of the ladder. With
        // one radius for the whole burst, `15-impact-light` lost 41% of its
        // effect energy and `04b-impact-decay` 54%: a jab's sparks are dim to
        // start with, and dispersing them over an 8 cm disc drops a large part
        // of the population under the gate's 0.02 floor entirely — which is the
        // "a jab landing is indistinguishable from no jab landing" failure this
        // file was already corrected for once. The reading is also the physical
        // one: the fine motes are shed off the whole crushed area, but the
        // heavy fragments come off the deepest part of the crush, which is a
        // point. So the two bright tiers stay near it and the fines and the
        // spall get the full patch.
        const pr = patch * tier.patch * Math.sqrt(Math.random());
        const pa = Math.random() * Math.PI * 2;
        const pu = Math.cos(pa) * pr;
        const pv = Math.sin(pa) * pr;
        const pn = (Math.random() - 0.5) * 0.03;
        aOrigin[o] = point.x + _tan.x * pu + _bit.x * pv + _dir.x * pn;
        aOrigin[o + 1] = point.y + _tan.y * pu + _bit.y * pv + _dir.y * pn;
        aOrigin[o + 2] = point.z + _tan.z * pu + _bit.z * pv + _dir.z * pn;
        aVel[o] = vx; aVel[o + 1] = vy; aVel[o + 2] = vz;
        const g = tier.gain;
        aTint[o] = tr * g; aTint[o + 1] = tg * g; aTint[o + 2] = tb * g;

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
