/**
 * Knockbots — light shafts, deck haze and airborne particulate.
 *
 * The shafts are genuinely raymarched, not billboards. Each one is a convex
 * hexahedron — the emitter rectangle swept downward with a linear spread — and
 * because every one of its six bounding surfaces is a plane, the entry and exit
 * distances come out of a six-plane slab test in closed form. The fragment then
 * integrates density between them over a dozen jittered steps.
 *
 * That buys three things a billboarded cone cannot have:
 *
 *   - The shaft is *thicker* where the eye looks along it, so walking the
 *     camera around one changes its brightness the way a real volume does.
 *   - It works for a 6m strip light and a 0.4m spot with the same shader; the
 *     spread is per-axis and a roundness blend interpolates between a wedge and
 *     a cone.
 *   - The noise is sampled in the shaft's own space, so the drift crawls down
 *     the beam instead of sliding across the screen.
 *
 * Depth testing is left on and the mesh is drawn front-face only, so anything
 * nearer than the shaft's front surface occludes it correctly. The last metre
 * above the floor fades out and is replaced by an additive pool on the deck,
 * which is what a real light does and also hides the hard intersection.
 *
 * **Every emitter in this file obeys the same three budgets**, because additive
 * atmosphere with no ceiling is the single fastest way to destroy a frame's
 * contrast — it lifts the blacks everywhere at once and the result reads as
 * fogged rather than lit:
 *
 *   1. **Distance.** Density decays exponentially away from the emitter, so a
 *      shaft is a shaft and not a wedge of uniform paint.
 *   2. **The lens.** Everything fades to nothing over the last few metres in
 *      front of the camera, so the fight camera never flies through a wall of
 *      white on a push-in.
 *   3. **The fight plane.** A 15 x 9 x 5.6m box around the play area is carved
 *      out of every ambient emitter. That box holds the deepest blacks and the
 *      brightest speculars in the frame and nothing ambient may touch it. Haze
 *      lives behind the barriers and out on the flanks, where it separates the
 *      background instead of veiling the fighters.
 */

import * as THREE from 'three';
import { GROUND_Y, LAYER } from '../core/Constants.js';
import { DustMotes, SteamJets } from './StageParticles.js';

/**
 * The protected volume: half extents about `FIGHT_CLEAR_CENTER`, metres. A
 * 13 x 5.8 x 6.8m box around the play area, feathered out to 1.9x — which puts
 * the far barrier at z = -6.2 just outside it, so the gantry shafts hanging
 * over the back of the pit still read at nearly full strength.
 */
const FIGHT_CLEAR_CENTER = [0, 1.9, 0];
const FIGHT_CLEAR_HALF = [6.5, 2.9, 3.4];

const _poolColor = new THREE.Color();

const SHAFT_VERT = /* glsl */ `
  uniform mat4 uInvModel;
  varying vec3 vLocal;
  varying vec3 vLocalEye;
  varying vec3 vWorld;
  void main() {
    vLocal = position;
    vLocalEye = ( uInvModel * vec4( cameraPosition, 1.0 ) ).xyz;
    vWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const SHAFT_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uNoise;
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uTime;
  uniform vec2 uHalf;        // emitter half extents
  uniform vec2 uSpread;      // half-extent growth per metre of throw
  uniform float uLength;
  uniform float uEdge;       // radial falloff exponent
  uniform float uRound;      // 0 = wedge (strip light), 1 = cone (spot)
  uniform float uExtinction;
  uniform float uNoiseScale;
  uniform float uNoiseAmp;
  uniform float uFloorFade;
  uniform vec2 uSlat;        // x = louvre pitch in metres (0 = none), y = sharpness
  uniform vec2 uNearFade;    // view distances over which the shaft fades in
  uniform vec3 uClearCenter;
  uniform vec3 uClearHalf;
  uniform float uStepLen;    // metres per march sample; <= 0 = fixed uMaxSteps
  uniform float uMinSteps;
  uniform float uMaxSteps;
  varying vec3 vLocal;
  varying vec3 vLocalEye;
  varying vec3 vWorld;

  float hash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  void main() {
    vec3 ro = vLocalEye;
    vec3 rd = normalize( vLocal - vLocalEye );

    // Six-plane slab test. Inside is dot(n, p) + c <= 0 for every plane.
    float tEnter = 0.0;
    float tExit = 1e9;
    vec3 n[6];
    float c[6];
    n[0] = vec3(  1.0, uSpread.x, 0.0 ); c[0] = -uHalf.x;
    n[1] = vec3( -1.0, uSpread.x, 0.0 ); c[1] = -uHalf.x;
    n[2] = vec3( 0.0, uSpread.y,  1.0 ); c[2] = -uHalf.y;
    n[3] = vec3( 0.0, uSpread.y, -1.0 ); c[3] = -uHalf.y;
    n[4] = vec3( 0.0,  1.0, 0.0 );       c[4] = 0.0;
    n[5] = vec3( 0.0, -1.0, 0.0 );       c[5] = -uLength;

    for ( int i = 0; i < 6; i++ ) {
      float denom = dot( n[i], rd );
      float num = dot( n[i], ro ) + c[i];
      if ( abs( denom ) < 1e-6 ) {
        if ( num > 0.0 ) { discard; }
      } else {
        float t = -num / denom;
        if ( denom > 0.0 ) tExit = min( tExit, t );
        else tEnter = max( tEnter, t );
      }
    }
    tEnter = max( tEnter, 0.0 );
    if ( tExit <= tEnter ) discard;

    // The march runs in the shaft's own space but the carve is authored in
    // world space. The shaft mesh is only ever placed and rotated, never
    // scaled, so t measures the same metres in both frames and the world ray
    // is just the eye plus the world-space direction — no per-sample matrix,
    // and modelMatrix is not available to a fragment shader anyway.
    vec3 wd = normalize( vWorld - cameraPosition );

    float span = tExit - tEnter;

    /*
     * CONSTANT SAMPLE SPACING, not a constant sample count.
     *
     * The march used a fixed twelve steps for every fragment, which sets the
     * sample spacing to span/12 — so a ray that grazes the beam and crosses
     * half a metre of it got a sample every 4 cm, while a ray straight down the
     * beam got one every 50 cm. The thin rays were paying twelve full samples,
     * two dependent texture fetches each, to resolve detail far below anything
     * the beam actually contains. Shafts 0 and 1 cover 22.4% of the frame at
     * the shipping tier (measured, not guessed — the other three shafts cover
     * zero), and this shader is the most expensive per-pixel thing the arena
     * draws, so that oversampling is the single largest waste in the layer.
     *
     * Picking the step count from the span instead fixes the spacing at
     * uStepLen metres. Rays that were already at or above that spacing are
     * untouched — they still take the full twelve — so the beam's core, where
     * the span is long and the scatter is bright, is bit-identical. Only the
     * grazing edges take fewer, and there the spacing they end up with is the
     * one the core was already considered acceptable at.
     *
     * uStepLen <= 0 restores the fixed twelve exactly, which is how the A/B is
     * driven at runtime without a rebuild.
     */
    float steps = uStepLen > 0.0
      ? clamp( ceil( span / uStepLen ), uMinSteps, uMaxSteps )
      : uMaxSteps;
    float stepLen = span / steps;
    // Blue-noise-ish jitter: without it twelve steps band visibly, and fewer
    // steps band harder — this is what lets the count come down at all.
    float jitter = hash12( gl_FragCoord.xy + uTime * 60.0 );
    float acc = 0.0;

    for ( int i = 0; i < 12; i++ ) {
      if ( float( i ) >= steps ) break;
      float t = tEnter + ( float( i ) + jitter ) * stepLen;
      vec3 p = ro + rd * t;
      float d = -p.y;
      if ( d < 0.0 ) continue;

      vec2 halfAt = uHalf + uSpread * d;
      vec2 r2 = vec2( p.x, p.z ) / max( halfAt, vec2( 1e-4 ) );
      float rWedge = max( abs( r2.x ), abs( r2.y ) );
      float rCone = length( r2 );
      float r = mix( rWedge, rCone, uRound );
      float edge = pow( max( 0.0, 1.0 - r ), uEdge );
      if ( edge <= 0.0 ) continue;

      // Fade in over the first metres of view distance, so a push-in never
      // drives the camera into a solid sheet of scatter.
      float lens = smoothstep( uNearFade.x, uNearFade.y, t );
      if ( lens <= 0.0 ) continue;

      vec3 w = cameraPosition + wd * t;
      vec3 q = abs( w - uClearCenter ) / max( uClearHalf, vec3( 1e-3 ) );
      float carve = smoothstep( 1.0, 1.9, max( q.x, max( q.y, q.z ) ) );
      if ( carve <= 0.0 ) continue;

      // Louvres. A six metre strip light is a softbox and a softbox throws no
      // visible shaft at all — the scatter comes out as an even slab, which is
      // the thing this file is trying not to be. Real industrial linears carry
      // an egg-crate, and the crate is what turns one fitting into a row of
      // readable beams with dark air between them.
      float slats = 1.0;
      if ( uSlat.x > 0.0 ) {
        slats = pow( abs( sin( p.x * 3.14159265 / uSlat.x ) ), uSlat.y );
      }

      // Two noise layers crawling down the beam at different rates.
      float n1 = texture2D( uNoise, vec2( p.x, p.z ) * uNoiseScale + vec2( 0.03, -0.02 ) * uTime ).r;
      float n2 = texture2D( uNoise, vec2( p.z * 0.7, d ) * uNoiseScale * 1.9 - vec2( 0.0, 0.05 * uTime ) ).g;
      float dust = mix( 1.0, ( n1 * 0.6 + n2 * 0.7 ), uNoiseAmp );

      float fall = exp( -d * uExtinction );
      float floorFade = smoothstep( uLength, uLength - uFloorFade, d );
      acc += edge * slats * dust * fall * floorFade * lens * carve * stepLen;
    }

    if ( acc <= 0.0005 ) discard;
    // Saturating rather than linear: an eye looking straight down a beam sees
    // a bright shaft, not an unbounded one.
    gl_FragColor = vec4( uColor * ( 1.0 - exp( -acc * uIntensity ) ), 1.0 );
  }
`;

/**
 * Metres between raymarch samples in a light shaft.
 *
 * The old shader spent a fixed twelve samples on every fragment regardless of
 * how much shaft the ray actually crossed. This is the spacing those twelve
 * samples produced on the rays that matter — the ones crossing the ~2.3 m depth
 * of the pit's two visible shafts — so a fragment in the beam's core gets
 * exactly what it got before, and only the grazing edges, which were sampling
 * at 4 cm to resolve detail the beam does not contain, take fewer.
 *
 * Set to 0 to restore the unconditional twelve.
 *
 * IT IS 0, AND THAT IS DELIBERATE. The A/B was driven through the `uStepLen`
 * uniform at runtime, so the *measurement* left the tree untouched — but the
 * default was shipped at 0.19 while round 32's own record stated the change had
 * been "reverted per the charter rule, the tree is untouched". That statement
 * was false: the constant was live at HEAD in the same commit that claimed its
 * removal.
 *
 * Restored to 0 rather than correcting the record to match the tree, because the
 * measurement that would justify keeping it does not exist. It was measured at
 * 0.1 +/- 1.9 ms — indistinguishable from zero, on a contended machine, against a
 * baseline since shown to be inflated. What IS established is that it takes 24%
 * fewer samples (mean 9.12 vs 12.0 over 418,721 fragments) for a whole-frame
 * visual diff at the instrument's own noise floor (0.75% of pixels against a
 * 0.55% floor), which makes it a plausible change rather than a justified one.
 *
 * Re-land it with a real measurement against a quiet 16.85 ms baseline. An
 * unmeasured change sitting in the tree under a commit that says it was removed
 * is how the NEXT round's baseline goes wrong.
 */
const SHAFT_STEP_LEN = 0;

/** Hexahedron bounding a shaft: emitter rectangle at y=0, swept to y=-length. */
function shaftGeometry(halfX, halfZ, spreadX, spreadZ, length) {
  const bx = halfX + spreadX * length;
  const bz = halfZ + spreadZ * length;
  const top = [[-halfX, 0, -halfZ], [halfX, 0, -halfZ], [halfX, 0, halfZ], [-halfX, 0, halfZ]];
  const bot = [[-bx, -length, -bz], [bx, -length, -bz], [bx, -length, bz], [-bx, -length, bz]];
  const pos = [];
  const quad = (a, b, c, d) => { pos.push(...a, ...b, ...c, ...a, ...c, ...d); };
  quad(top[0], top[1], top[2], top[3]);                 // cap
  quad(bot[3], bot[2], bot[1], bot[0]);                 // base
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(top[i], bot[i], bot[j], top[j]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export class StageVolumetrics {
  /**
   * @param {object} deps
   * @param {Record<string, THREE.Texture>} deps.textures
   * @param {'ultra'|'high'|'medium'|'low'} [deps.quality]
   * @param {object} [deps.air] arena atmosphere spec — `shafts`, `motes`, `jets`
   *   and `deckHaze`. Absent means the pit's, which is what every value below
   *   was authored for; a rooftop and a flooded vault want different air and
   *   the *mechanism* is the same in all three.
   */
  constructor({ textures, quality = 'high', air = null }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.volumetrics';
    this.quality = quality;
    this.floorY = GROUND_Y;

    this.clear = { center: FIGHT_CLEAR_CENTER, half: FIGHT_CLEAR_HALF };

    /**
     * Shaft placement, and **every position in this list is a measured one**.
     *
     * The two big ones hang off the cross-gantry above the back of the pit, at
     * the same coordinates as the Environment's overhead practicals. The other
     * three used to be described as raking in through the shell wall's
     * blown-out panels. They did not rake in through anything: they drew
     * **zero pixels** in the framing the game is played in.
     *
     * ```
     * per-shaft fill BEFORE, CPU depth-buffer raster at 480x270
     *                        fight framing        06-stage-wide       why
     *                     coverage  fragments  coverage  fragments
     *   shaft0             14.76%     11.70%    12.35%     9.94%     renders
     *   shaft1             14.76%     11.70%    12.90%    10.83%     renders
     *   shaft2  z -18.4     0.00%      0.00%     0.005%    0.005%    behind the set
     *   shaft3  z -18.4     0.00%      0.00%     0.015%    0.015%    behind the set
     *   shaft4  x -10.2     0.00%      0.00%     0.363%    0.363%    off the left edge
     *   TOTAL              29.51%     23.39%    25.63%    21.16%
     * ```
     *
     * Stated exactly: three of the five retire **zero** fragments at the fight
     * framing and at five other fight poses swept, and between 0.005% and 0.36%
     * of the frame at the establishing shot — which is a rounding error against
     * the two that work, not a shaft. The zero survives the instrument's one
     * known bias: it treats alpha cutouts as solid and so over-reports
     * occlusion, and re-running with every cutout counted as a hole (a strict
     * lower bound on occlusion) still returns exactly 0.00%.
     *
     * Three fifths of the arena's atmosphere was specified, tinted, breathed
     * and uniform-updated every frame and drawn to nothing. It cost no GPU,
     * which is exactly why it survived thirty rounds — neither a stopwatch nor
     * a screenshot separates a shaft that is subtle from one that is absent.
     * Only a fill counter does. See `scratchpad/r35-shaftfill.mjs`.
     *
     * **What the room actually allows.** The fight camera solves for two
     * fighters, so at the back of the pit the top of frame is only about 3.8 m
     * up at z -6 and 5.1 m up at z -13. The pit's ceiling is not in the shot.
     * Mapping the visible, unoccluded, un-carved air (`r35-freeair.mjs`) leaves
     * exactly two places a new beam can live:
     *
     *   - z -6 to -11, |x| 5..8, y 0..4  — the wedge the gantry pair already
     *     fills, and
     *   - z -12 to -15, |x| < 13, y 4.3..5.2 — a band right across the back of
     *     the hall, seventeen metres out.
     *
     * The second one is the arena's own architecture asking for light: the roof
     * deck stops at z -14 and the shell wall stands at z -19, so there is a
     * five-metre slot open to the sky over the back of the hall, and
     * `StageStructure#columnsAndRoof` says in its own comment that it stops the
     * deck short for precisely that reason. Two narrow blades drop through that
     * slot. They are seventeen to twenty metres from the lens against the
     * gantry pair's eleven, they cross in front of and behind them as the
     * camera tracks, and that parallax is the point — the pit's atmosphere was
     * previously a single plane at one depth, which is the flattest thing a
     * volumetric layer can be. They are also five times dimmer than the gantry
     * beams, because a distant secondary source that matches a near key light
     * for brightness destroys the depth it was added to create.
     *
     * `shaft4` is the one raking beam, off the -x catwalk line and aimed
     * *inboard*. It used to aim outboard from x -10.2, which walked it off the
     * left edge of the frame; the sign of its z-rotation is the whole fix.
     *
     * `extinction` is per-metre density decay and it is the parameter that
     * decides whether a shaft reads as light or as paint: the beam has to be
     * visibly weaker at the deck than at the fitting. Short throws carry a
     * steep decay, the long raking ones a gentle one or they never arrive.
     *
     * `pool` is the deck splash and it is an **absolute** peak in linear
     * radiance, deliberately decoupled from the beam's own density. Deriving
     * it from `intensity` is how a plausible shaft turns into a floodlit
     * floor: a beam is integrated along the whole view ray and can afford to
     * be bright, a splash is a flat additive sprite on the most detailed
     * surface in the frame and cannot. **A beam that is extinguished in mid-air
     * gets `pool: 0` and no instance at all** — the two slot blades die at
     * y ~3.5 above the machinery bank and never reach the deck, and a splash
     * under a beam that does not land there is a light with no source.
     *
     * `steps` is the raymarch sample count, per emitter rather than global,
     * because sample count should follow the beam's spatial frequency and not
     * the shader's convenience. The gantry pair keeps twelve and is untouched;
     * the three distant, soft, low-contrast additions take eight, which is what
     * holds the arithmetic below to +19% instead of +28%.
     *
     * `tier` is the lowest quality tier that builds the emitter. See the
     * ladder below for why this is a field and no longer an array index.
     *
     * ```
     * fill AFTER, same instrument, same framings, quality 'high'
     *                       fight framing            06-stage-wide
     *                    coverage  fragments      coverage  fragments
     *   shaft0            14.76%     11.70%        12.35%     9.94%   unchanged
     *   shaft1            14.76%     11.70%        12.90%    10.83%   unchanged
     *   shaft2             2.56%      2.05%         1.54%     1.27%
     *   shaft3             2.58%      2.23%         1.65%     1.53%
     *   shaft4             3.01%      2.28%         1.48%     1.14%
     *   TOTAL             37.66%     29.95%        29.93%    24.71%
     *
     * the bill, in the only currency that is measurable on this machine
     *   fragments   485,056 -> 621,024 at 1080p      +135,968   +28.0%
     *   samples     5.82 M  -> 6.91 M   at 1080p     +1.09 M    +18.7%
     * ```
     *
     * The second row is the one to price. `fragments x steps` is the count that
     * drives this shader's texture fetches — two per sample — and it is what
     * makes the difference between +28% and +19%. It is a count, so it is
     * immune to everything that has gone wrong with timing here. **It is not a
     * millisecond and nothing in this comment converts it into one.**
     *
     * ---------------------------------------------------------------------
     *
     * **AND THE CRITIC SAW NO NEW BEAM, because `fragments` is the wrong
     * counter for the question "does it read".**
     *
     * The discard is `acc <= 0.0005` and `acc` does not contain `uIntensity`.
     * The emitted colour is `uColor * (1 - exp(-acc * uIntensity))`. So a shaft
     * can retire two per cent of the frame and deposit nothing on any of it,
     * which is precisely what these three did. `scratchpad/r35-shaftfill.mjs`
     * now reports the missing number as well — the linear radiance the shader
     * actually writes, summarised over the fragments it keeps — and that is the
     * number to equalise across emitters. Intensity is NOT: `acc` differs by
     * 2.5x between a 3.1 m gantry strip seen end-on and a 1.15 m blade seen
     * from seventeen metres, so equal intensities never meant equal beams.
     *
     * Two numbers in the brief that sent this round did not survive that
     * instrument. The three intensities were reported as 0.071 / 0.065 / 0.44;
     * the tree said 0.105 / 0.090 / 0.300. And "five times dimmer than the
     * gantry beams", which this file itself claimed, is not what shipped
     * either — in radiance it was 5.5x / 4.4x / **1.7x**, so the raking beam
     * was already within a stop of a beam that plainly reads and still could
     * not be found. Level alone was therefore never going to be the whole fix.
     *
     * What separates the two that read from the three that do not is INTERNAL
     * RANGE, and that is measurable too: p90/p50 radiance is 6.14 on the gantry
     * pair against 3.69 / 2.45 / 2.56. A beam is found by its core and its
     * edge, not by its mean. Ablating shaft0's louvre — same geometry as
     * shaft1, one field changed — drops its range from 6.14 to 3.00 and lifts
     * its level by 61%, which identifies the property exactly and prices it.
     *
     * A louvre is the wrong way to buy it back here and that was measured, not
     * assumed: at a 1.55 m pitch the whole 2.3 m blade sits inside one cell, so
     * the term is a flat 0.5x dimming and the range comes out at 3.04. Six
     * cells across a 2.3 m blade is a 0.38 m pitch, which is a picket fence on
     * something described as skyglow through a structural slot.
     *
     * So the range is bought from the radial exponent instead. `edge` 2.1 -> 3.4
     * gives the blade a core rather than a uniform cross-section, and it is the
     * cheap direction: more of the rim falls under the discard, so the change
     * takes fragments OFF. Then `intensity`, which costs exactly nothing, is
     * solved so each addition lands at half the gantry pair's p90 radiance —
     * a stated hierarchy rather than a taste.
     *
     * ```
     * fight framing, quality 'high', 480x270 CPU raster
     *                    I      RAD p50   RAD p90   p90/p50   vs gantry   FRAG%
     *   gantry 0/1     0.950     0.0114    0.0700     6.14        1.0x    11.696
     *   shaft2 before  0.105     0.0035    0.0129     3.69        5.5x     2.046
     *   shaft2 after   0.420     0.0078    0.0337     4.32        2.1x     1.769
     *   shaft3 before  0.090     0.0065    0.0159     2.45        4.4x     2.229
     *   shaft3 after   0.300     0.0100    0.0343     3.43        2.0x     1.971
     *   shaft4 before  0.300     0.0165    0.0423     2.56        1.7x     2.282
     *   shaft4 after   0.360     0.0100    0.0355     3.55        2.0x     2.101
     *
     * the bill, same currency as the table above
     *   fragments   6.557% -> 5.841% of frame   -0.716 pts   -14,864 at 1080p
     *   whole layer 29.949% -> 29.233%          -2.4%
     * ```
     *
     * The fix is fragment-NEGATIVE. It reproduces at 06-stage-wide (3.938% ->
     * 3.554%) and at the five off-centre fight poses the instrument sweeps.
     */
    this.specs = air?.shafts ?? [
      // The cross-gantry pair. Untouched — these are the two that always
      // rendered and they are the frame's key light in the air.
      { pos: [-6.6, 5.34, -6.2], rot: [0, 0, 0], half: [3.1, 0.28], spread: [0.09, 0.16], length: 5.5, color: 0xbfd8ff, intensity: 0.95, round: 0.15, edge: 2.2, extinction: 0.16, slat: [1.02, 3.2], pool: 0.05, steps: 12, tier: 0 },
      { pos: [6.6, 5.34, -6.2], rot: [0, 0, 0], half: [3.1, 0.28], spread: [0.09, 0.16], length: 5.5, color: 0xbfd8ff, intensity: 0.95, round: 0.15, edge: 2.2, extinction: 0.16, slat: [1.02, 3.2], pool: 0.05, steps: 12, tier: 0 },
      // Skyglow through the slot between the roof deck (ends z -14) and the
      // shell wall (z -19). Narrow, seventeen metres out, and tipped a little
      // forward so they lean into the hall rather than hanging plumb.
      { pos: [-6.4, 13.2, -14.9], rot: [-0.30, 0, 0.10], half: [1.15, 0.8], spread: [0.025, 0.025], length: 10.5, color: 0x8fb4e8, intensity: 0.42, round: 0.4, edge: 3.4, extinction: 0.055, slat: [0, 0], pool: 0, steps: 8, tier: 1 },
      { pos: [4.0, 13.6, -15.6], rot: [-0.26, 0, -0.08], half: [1.35, 0.9], spread: [0.025, 0.025], length: 11.5, color: 0x9dc0ee, intensity: 0.30, round: 0.4, edge: 3.4, extinction: 0.05, slat: [0, 0], pool: 0, steps: 8, tier: 1 },
      // The one raking beam, off the -x catwalk line and aimed inboard.
      { pos: [-8.8, 4.45, -9.2], rot: [0.1, 0, 0.42], half: [0.58, 0.52], spread: [0.085, 0.085], length: 5.2, color: 0x9fdcff, intensity: 0.36, round: 0.85, edge: 3.4, extinction: 0.14, slat: [0, 0], pool: 0.028, steps: 8, tier: 2 },
    ];

    /**
     * The quality ladder, and it is two ladders because one of them was doing
     * nothing.
     *
     * **Which emitters exist** used to be a prefix of the array: `low` took the
     * first two, `medium` the first three. With three of the pit's five drawing
     * zero pixels that ladder saved *literally nothing* — `low` dropped shafts
     * 2, 3 and 4, all of which were already free. A tier that removes only
     * invisible things is not a tier. It is a field now, so the drop order is
     * declared by the author against measured cost instead of falling out of
     * whatever order the array happens to be authored in, and the arenas that
     * do not declare it keep exactly the old prefix behaviour (see the default
     * below, which reproduces `low = 2, medium = 3` for any list).
     *
     * **How much each emitter costs** is the ladder that actually matters here,
     * because the pit's expensive shafts are its two *composition* shafts and
     * deleting either leaves the frame lit from one side. So the tiers scale
     * the sample count instead: `low` halves it, `medium` takes three
     * quarters, `high` and `ultra` are unscaled and therefore bit-identical to
     * what shipped. That is a 50% cut in the layer's texture fetches at `low`
     * with every beam still in the frame, which is the right trade for the
     * machine that needs it — the previous ladder cut 0%.
     *
     * ```
     * pit, fight framing, sample count for the whole shaft layer, %-of-frame
     *                  shafts   fragments   samples      vs the old ladder
     *   before, any tier   2      23.39%     280.7        (all three tiers)
     *   ultra / high       5      29.95%     333.2        +18.7%
     *   medium             4      28.27%     239.8        -14.6%
     *   low                2      23.39%     140.3        -50.0%
     * ```
     */
    const TIER_RANK = { low: 0, medium: 1, high: 2, ultra: 2 };
    const rank = TIER_RANK[quality] ?? 2;
    const STEP_SCALE = { low: 0.5, medium: 0.75, high: 1, ultra: 1 };
    const stepScale = STEP_SCALE[quality] ?? 1;

    const clearCenter = new THREE.Vector3(...FIGHT_CLEAR_CENTER);
    const clearHalf = new THREE.Vector3(...FIGHT_CLEAR_HALF);

    /**
     * The emitters this tier actually builds, paired with their spec. Every
     * per-frame loop in this file walks THIS, not `specs`, because the built
     * set is no longer a prefix of the authored one.
     * @type {{spec: object, mesh: THREE.Mesh}[]}
     */
    this.active = [];
    this.shafts = [];
    for (let i = 0; i < this.specs.length; i++) {
      const s = this.specs[i];
      // Absent `tier` reproduces the old index ladder exactly, so an arena that
      // authors a bare list still degrades the way it always did.
      const tier = s.tier ?? (i < 2 ? 0 : i < 3 ? 1 : 2);
      if (rank < tier) continue;
      const steps = Math.max(4, Math.round((s.steps ?? 12) * stepScale));
      const mat = new THREE.ShaderMaterial({
        name: `arena.shaft${i}`,
        uniforms: {
          uInvModel: { value: new THREE.Matrix4() },
          uNoise: { value: textures.noise },
          uColor: { value: new THREE.Color(s.color) },
          uIntensity: { value: s.intensity },
          uTime: { value: 0 },
          uHalf: { value: new THREE.Vector2(s.half[0], s.half[1]) },
          uSpread: { value: new THREE.Vector2(s.spread[0], s.spread[1]) },
          uLength: { value: s.length },
          uEdge: { value: s.edge },
          uRound: { value: s.round },
          uExtinction: { value: s.extinction },
          // Fine enough that a single six-metre fitting has several cells of
          // variation across it; at the old 14m period every louvre came out
          // the same brightness and the row read as a printed pattern.
          uNoiseScale: { value: 0.15 },
          uNoiseAmp: { value: 0.8 },
          uFloorFade: { value: 1.4 },
          uSlat: { value: new THREE.Vector2(s.slat[0], s.slat[1]) },
          uNearFade: { value: new THREE.Vector2(1.2, 4.5) },
          uClearCenter: { value: clearCenter },
          uClearHalf: { value: clearHalf },
          // Sample spacing in metres. See the march for why this is a spacing
          // and not a count. 0 restores the old fixed twelve steps and is what
          // the A/B null arm sets.
          uStepLen: { value: SHAFT_STEP_LEN },
          uMinSteps: { value: Math.min(4, steps) },
          uMaxSteps: { value: steps },
        },
        vertexShader: SHAFT_VERT,
        fragmentShader: SHAFT_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const mesh = new THREE.Mesh(shaftGeometry(s.half[0], s.half[1], s.spread[0], s.spread[1], s.length), mat);
      mesh.name = `arena.shaft${i}`;
      mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
      mesh.rotation.set(s.rot[0], s.rot[1], s.rot[2]);
      mesh.frustumCulled = true;
      mesh.userData.gbuffer = false;
      // A volume has no business appearing in the floor's mirror; the shaft is
      // already integrated along the view ray, and reflecting it doubles it.
      mesh.layers.set(LAYER.NO_REFLECT);
      mesh.renderOrder = 6;
      this.group.add(mesh);
      this.shafts.push(mesh);
      this.active.push({ spec: s, mesh });
    }

    this.#lightPools(textures);
    this.#deckHaze(textures, air?.deckHaze);

    const m = air?.motes ?? {};
    this.motes = new DustMotes(textures.dust, m.box ?? { x: 28, y: 8.5, z: 22, cx: 0, cy: 1.1, cz: -3 }, {
      count: Math.round((quality === 'low' ? 110 : quality === 'medium' ? 220 : 420) * (m.density ?? 1)),
      color: m.color ?? 0xd6e6ff,
      size: m.size ?? 0.024,
      drift: m.drift ?? 0.19,
      intensity: m.intensity ?? 0.28,
      maxPixels: 11,
      nearFade: [1.4, 4.0],
      floorY: this.floorY,
      clear: this.clear,
    });
    this.group.add(this.motes.points);

    // The plumes are pushed to the flanks and the far end of the hall. A jet
    // venting into the pit would be exactly the uniform veil this file exists
    // to avoid, however good the reference photo of one looks.
    const j = air?.jets ?? {};
    this.steam = new SteamJets(textures.steam, j.list ?? [
      { origin: [-16.2, 2.2, -4.6], dir: [0.75, 0.4, 0.1], rate: 1, speed: 1.4, life: 4.2, size: 0.7 },
      { origin: [16.2, 3.4, 8.2], dir: [-0.7, 0.45, -0.2], rate: 1, speed: 1.2, life: 4.8, size: 0.8 },
      { origin: [-6.5, 0.05, -15.5], dir: [0.05, 1.0, 0.1], rate: 1, speed: 0.55, life: 7.0, size: 1.0 },
      { origin: [9.4, 5.2, -13.6], dir: [-0.2, 0.9, 0.35], rate: 1, speed: 0.8, life: 5.5, size: 0.9 },
    ], {
      perJet: quality === 'low' ? 8 : 16,
      opacity: j.opacity ?? 0.075,
      color: j.color ?? 0x9fb3c8,
      maxPixels: 120,
      nearFade: [3.0, 8.0],
      floorY: this.floorY,
      clear: this.clear,
    });
    this.group.add(this.steam.points);
  }

  /**
   * Additive pools where each shaft meets the deck. Cheap, and they carry the
   * light onto a surface the shaft itself has been faded out of.
   *
   * The footprint is deliberately close to the shaft's own — 1.2x, not the
   * several-times-over that turns four pools into a floodlit floor — and the
   * gain is set so the brightest pool sits a little above the lit concrete
   * around it rather than several stops over it. A pool that outshines the
   * floor is a white blob, and a white blob under a fighter's feet costs more
   * contrast than the pool ever buys in atmosphere.
   *
   * Only emitters with a non-zero `pool` get an instance. A beam that is
   * extinguished in mid-air — the two slot blades die at y ~3.5, well above the
   * machinery bank they hang over — has no contact with the deck, and the naive
   * "drop the axis until it hits the floor" solve below would otherwise put a
   * three-metre splash on the back of the pit under a beam that visibly never
   * arrives there.
   */
  #lightPools(textures) {
    const lit = this.active.filter((a) => (a.spec.pool ?? 0) > 0).map((a) => a.spec);
    const count = lit.length;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      name: 'arena.lightPool',
      map: textures.dust,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
      fog: false,
    });
    this.pools = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    this.pools.name = 'arena.lightPools';
    this.pools.frustumCulled = false;
    this.pools.userData.gbuffer = false;
    this.pools.layers.set(LAYER.NO_REFLECT);
    this.pools.renderOrder = 5;
    this.pools.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);
    this.pools.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    this._poolBase = [];
    for (let i = 0; i < count; i++) {
      const spec = lit[i];
      const drop = spec.pos[1] - this.floorY;
      // Where the axis lands, allowing for the shaft's tilt.
      const dir = new THREE.Vector3(0, -1, 0).applyEuler(new THREE.Euler(spec.rot[0], spec.rot[1], spec.rot[2]));
      const k = dir.y < -1e-3 ? drop / -dir.y : drop;
      p.set(spec.pos[0] + dir.x * k, this.floorY + 0.012 + i * 0.002, spec.pos[2] + dir.z * k);
      const width = (spec.half[0] + spec.spread[0] * spec.length) * 2.4;
      const depth = (spec.half[1] + spec.spread[1] * spec.length) * 2.4;
      s.set(width, 1, Math.max(depth, width * 0.35));
      m.compose(p, q, s);
      this.pools.setMatrixAt(i, m);
      this._poolBase.push(new THREE.Color(spec.color).multiplyScalar(spec.pool));
      this.pools.setColorAt(i, this._poolBase[i]);
    }
    this.pools.instanceMatrix.needsUpdate = true;
    this.pools.instanceColor.needsUpdate = true;
    this.group.add(this.pools);
  }

  /**
   * Ground mist, confined to the far end of the hall and the flanks outside
   * the barriers. It exists to separate the back wall from the mid-ground, not
   * to sit in front of the fighters.
   *
   * One detail keeps a horizontal mist plane from becoming a wall of white the
   * moment a fight camera drops to eye level: the optical depth through the
   * slab saturates — `1 - exp(-tau)` rather than a linear accumulation — so a
   * grazing view cannot integrate without bound.
   *
   * ---------------------------------------------------------------------
   *
   * **THIS LAYER WAS THE SCREEN-SPACE LIGHT BAND ON THE SKYDECK**, and the
   * mechanism is worth stating exactly because it is a class this project has
   * shipped before, not a typo.
   *
   * Three of the four terms modulating a 64 x 56 m HORIZONTAL plane were
   * functions of view distance and nothing else:
   *
   *     lens = smoothstep( 5.0, 12.0, dist )
   *     far  = 1.0 - smoothstep( 32.0, 50.0, dist )
   *     tau ~ 1.0 / max( abs( dir.y ), 0.16 )
   *
   * On a horizontal plane under a camera at a fixed height, `dist` is a
   * function of the ray's elevation angle, which is a function of the SCREEN
   * ROW. So the layer's entire envelope was a strip of screen rows. Worse, the
   * `max(..., 0.16)` is a hard clamp on a monotone field — beyond `dist` about
   * 25 m at the wide camera it holds `tau` at exactly one value, so the strip
   * has a DEAD FLAT TOP whose boundary is the iso-elevation line, a perfectly
   * horizontal line across the frame at a row set by the camera alone. That is
   * the same defect class as the `smoothstep` across a Voronoi cell id that
   * cost this project several rounds: a binary gate on a piecewise-constant
   * field, drawing a straight edge at an arbitrary place.
   *
   * Measured offline with `scratchpad/r36-hazeband.mjs` — a CPU rasteriser for
   * this one layer with a null arm and a world-gated positive control — at the
   * shipping `cinematic('wide')` camera on the skydeck: the layer covers 62.0%
   * of frame, 7.4% of it non-zero, and its row profile is a band peaking at row
   * 85 of 270 with its half-max edge at row 82. The set behind that band is the
   * CITY: the probe point under the band's own top edge is (-3.3, 0.50, -20.7),
   * 20.7 m out along -z, past a parapet that stands at z about -12. A deck-level
   * ground mist slab that continues thirty-two metres out over the edge of a
   * roof is not air in a room; it is a smear hanging in the sky.
   *
   * Three changes, and the arena spec now owns the two numbers it should:
   *
   *   1. `uNearFade` is a LENS guard again, 2.0 -> 6.0 m, the same range the
   *      shafts (1.2-4.5) and the motes (1.4-4.0) use. At 5-12 m it was not
   *      guarding the lens, it was ramping across the middle of the deck.
   *   2. `far` becomes a WORLD extent about the plane's own centre, so the
   *      layer's outer boundary is a place in the set instead of a ring around
   *      the lens. Default 16 -> 22 m: atmosphere belongs inside the room, and
   *      no arena here has perimeter architecture past about 19 m.
   *   3. `max(abs(dir.y), 0.16)` becomes `inversesqrt(dir.y*dir.y + 0.0256)`.
   *      Same asymptote (6.25x looking along the slab, 1x looking down it),
   *      same cost, but C-infinity — there is no plateau, so there is no edge.
   *
   * **And the arena's authored numbers were dead.** `update()` overwrote
   * `uIntensity` with the pit's own `0.34 + breathe * 0.3` every frame, so the
   * skydeck ran at 0.64 against the 0.26 it authored (2.46x) and the cistern at
   * 0.64 against 0.72. The breathe term is now a MULTIPLIER on the authored
   * value, arranged to reproduce the pit's shipped 0.34..0.64 exactly at its
   * own default of 0.5, so the pit is bit-identical and the two new arenas get
   * the air they asked for. Same for the colour: the mood's fog hue still sets
   * the LEVEL, and an arena that states a colour now gets its hue at that
   * level. The pit states no `deckHaze` at all, so it takes neither path.
   */
  #deckHaze(textures, spec) {
    const geo = new THREE.PlaneGeometry(64, 56, 1, 1);
    geo.rotateX(-Math.PI / 2);
    /**
     * The authored air, kept so `update` can scale it rather than replace it.
     * `hasColor` is what keeps the pit off the new colour path entirely.
     */
    this._hazeBase = {
      color: new THREE.Color(spec?.color ?? 0x7d94b4),
      intensity: spec?.intensity ?? 0.5,
      hasColor: spec?.color != null,
    };
    const extent = spec?.extent ?? [16, 22];
    this.hazeMaterial = new THREE.ShaderMaterial({
      name: 'arena.deckHaze',
      uniforms: {
        uNoise: { value: textures.noise },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(spec?.color ?? 0x7d94b4) },
        uIntensity: { value: spec?.intensity ?? 0.5 },
        uThickness: { value: spec?.thickness ?? 1.6 },
        // Where the layer stops, in metres from its own centre. A world
        // boundary, so it belongs to the set; the old one was a ring of fixed
        // radius around the lens and travelled with it.
        uExtent: { value: new THREE.Vector2(extent[0], extent[1]) },
        uCenter: { value: new THREE.Vector2(0, -4) },
        // The lens guard, and only the lens guard.
        uNearFade: { value: new THREE.Vector2(2.0, 6.0) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uNoise;
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uIntensity;
        uniform float uThickness;
        uniform vec2 uExtent;
        uniform vec2 uCenter;
        uniform vec2 uNearFade;
        varying vec3 vWorld;
        void main() {
          vec3 toEye = cameraPosition - vWorld;
          float dist = length( toEye );
          vec3 dir = toEye / max( dist, 1e-3 );

          vec2 uv = vWorld.xz * 0.026;
          float a = texture2D( uNoise, uv + vec2( uTime * 0.004, uTime * 0.0026 ) ).r;
          float b = texture2D( uNoise, uv * 2.3 - vec2( uTime * 0.0031, uTime * 0.005 ) ).g;
          float n = smoothstep( 0.30, 0.95, a * 0.65 + b * 0.55 );

          // Behind the barrier or out past the flanks — never in the pit.
          float behind = smoothstep( -5.5, -12.0, vWorld.z );
          float flank = smoothstep( 10.0, 16.0, abs( vWorld.x ) );
          float band = max( behind, flank );
          // The lens guard, and nothing else may be keyed to view distance: on
          // a horizontal plane, distance from the eye IS the screen row, so any
          // gradient hung on it is a band painted across the frame.
          float lens = smoothstep( uNearFade.x, uNearFade.y, dist );
          // Where the layer ends, in the world. This is what the old
          // 1 - smoothstep( 32, 50, dist ) was pretending to be.
          float far = 1.0 - smoothstep( uExtent.x, uExtent.y, length( vWorld.xz - uCenter ) );

          // Path length through a slab of thickness uThickness along this view
          // ray. The 0.16 is the grazing cap -- the same 6.25x ceiling the old
          // max( abs( dir.y ), 0.16 ) had -- but reached smoothly, so the
          // ceiling is not a straight line drawn across the picture.
          float grazing = inversesqrt( dir.y * dir.y + 0.0256 );
          float tau = uIntensity * n * uThickness * grazing;
          float k = ( 1.0 - exp( -tau ) ) * band * lens * far;
          if ( k <= 0.002 ) discard;
          gl_FragColor = vec4( uColor * k, 1.0 );
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.haze = new THREE.Mesh(geo, this.hazeMaterial);
    this.haze.name = 'arena.deckHaze';
    this.haze.position.set(0, this.floorY + 0.5, -4);
    this.haze.frustumCulled = false;
    this.haze.userData.gbuffer = false;
    this.haze.layers.set(LAYER.NO_REFLECT);
    this.haze.renderOrder = 4;
    this.group.add(this.haze);
  }

  /**
   * @param {number} time seconds since the stage was built
   * @param {number} shaftIntensity the Environment's breathing multiplier
   * @param {object} envParams live Environment mood parameters
   */
  update(time, shaftIntensity, envParams) {
    const breathe = Math.max(0, shaftIntensity);
    const tint = envParams?.shaft?.color;

    for (const { spec, mesh } of this.active) {
      const u = mesh.material.uniforms;
      u.uTime.value = time;
      mesh.updateMatrixWorld();
      u.uInvModel.value.copy(mesh.matrixWorld).invert();
      u.uIntensity.value = spec.intensity * (0.55 + breathe * 0.9);
      if (tint) u.uColor.value.copy(tint);
    }

    if (this.pools) {
      const k = 0.5 + breathe * 0.85;
      for (let i = 0; i < this._poolBase.length; i++) {
        _poolColor.copy(this._poolBase[i]);
        if (tint) _poolColor.lerp(tint, 0.5);
        _poolColor.multiplyScalar(k);
        this.pools.setColorAt(i, _poolColor);
      }
      this.pools.instanceColor.needsUpdate = true;
    }

    this.hazeMaterial.uniforms.uTime.value = time;
    // A MULTIPLIER on what the arena authored, not a replacement for it. The
    // constants reproduce the pit's shipped 0.34..0.64 exactly at the pit's own
    // default of 0.5 — 0.5 * (0.68 + 0.6b) === 0.34 + 0.3b — so the pit is
    // bit-identical and the skydeck stops running the pit's air at 2.46x what
    // it asked for.
    this.hazeMaterial.uniforms.uIntensity.value = this._hazeBase.intensity * (0.68 + breathe * 0.6);
    // The mood's fog colour is the right hue but it is authored for FogExp2,
    // where it is a destination colour rather than an emitted one; scattering
    // toward the eye needs it several stops up to register at all. It sets the
    // LEVEL; an arena that states a colour of its own gets its hue at that
    // level, which is why the scale factor is a luminance ratio. The pit states
    // no deckHaze, so it never takes the second branch.
    if (envParams?.fog?.color) {
      const c = this.hazeMaterial.uniforms.uColor.value.copy(envParams.fog.color).multiplyScalar(16);
      if (this._hazeBase.hasColor) {
        const lvl = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        const b = this._hazeBase.color;
        const own = Math.max(1e-5, 0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b);
        c.copy(b).multiplyScalar(lvl / own);
      }
    }

    this.motes.update(time, 0.55 + breathe * 0.7);
    this.steam.update(time);
  }

  dispose() {
    for (const s of this.shafts) { s.geometry.dispose(); s.material.dispose(); }
    this.pools?.geometry.dispose();
    this.pools?.material.dispose();
    this.haze.geometry.dispose();
    this.hazeMaterial.dispose();
    this.motes.dispose();
    this.steam.dispose();
  }
}
