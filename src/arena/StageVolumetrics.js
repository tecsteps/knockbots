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
     * Shaft placement. The two big ones hang off the cross-gantry above the
     * back of the pit, at the same coordinates as the Environment's overhead
     * practicals; the rest rake in through the shell wall's blown-out panels.
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
     * surface in the frame and cannot.
     */
    this.specs = air?.shafts ?? [
      { pos: [-6.6, 5.34, -6.2], rot: [0, 0, 0], half: [3.1, 0.28], spread: [0.09, 0.16], length: 5.5, color: 0xbfd8ff, intensity: 0.95, round: 0.15, edge: 2.2, extinction: 0.16, slat: [1.02, 3.2], pool: 0.05 },
      { pos: [6.6, 5.34, -6.2], rot: [0, 0, 0], half: [3.1, 0.28], spread: [0.09, 0.16], length: 5.5, color: 0xbfd8ff, intensity: 0.95, round: 0.15, edge: 2.2, extinction: 0.16, slat: [1.02, 3.2], pool: 0.05 },
      { pos: [-9.5, 22.0, -18.4], rot: [0.34, 0.12, 0.16], half: [1.9, 1.5], spread: [0.035, 0.035], length: 23, color: 0x8fb4e8, intensity: 0.055, round: 0.55, edge: 2.1, extinction: 0.038, slat: [0, 0], pool: 0.02 },
      { pos: [2.0, 24.0, -18.4], rot: [0.4, -0.1, -0.13], half: [2.4, 1.9], spread: [0.035, 0.035], length: 25, color: 0x9dc0ee, intensity: 0.05, round: 0.55, edge: 2.0, extinction: 0.034, slat: [0, 0], pool: 0.018 },
      { pos: [-10.2, 4.6, -8.4], rot: [0.1, 0, -0.55], half: [1.1, 0.9], spread: [0.1, 0.1], length: 6.5, color: 0x9fdcff, intensity: 0.34, round: 0.85, edge: 2.2, extinction: 0.14, slat: [0, 0], pool: 0.032 },
    ];
    // Clamped to the list, not just to the tier. The pit authors five shafts and
    // the tier ladder cuts to three and two; a rooftop at dusk authors two,
    // because outdoor air is clear and a roof full of visible beams reads as a
    // nightclub. Without the clamp `medium` indexed past the end of a two-entry
    // list and threw during construction.
    const budget = Math.min(this.specs.length, quality === 'low' ? 2 : quality === 'medium' ? 3 : this.specs.length);

    const clearCenter = new THREE.Vector3(...FIGHT_CLEAR_CENTER);
    const clearHalf = new THREE.Vector3(...FIGHT_CLEAR_HALF);

    this.shafts = [];
    for (let i = 0; i < budget; i++) {
      const s = this.specs[i];
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
          uMinSteps: { value: 4 },
          uMaxSteps: { value: 12 },
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
    }

    this.#lightPools(textures, budget);
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
   */
  #lightPools(textures, count) {
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
      const spec = this.specs[i];
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
   * Two details keep a horizontal mist plane from becoming a wall of white the
   * moment a fight camera drops to eye level. The optical depth through the
   * slab saturates — `1 - exp(-tau)` rather than a linear accumulation — so a
   * grazing view cannot integrate without bound; and the whole thing fades out
   * inside twelve metres of the lens, because mist you are standing in is just
   * a lens filter.
   */
  #deckHaze(textures, spec) {
    const geo = new THREE.PlaneGeometry(64, 56, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.hazeMaterial = new THREE.ShaderMaterial({
      name: 'arena.deckHaze',
      uniforms: {
        uNoise: { value: textures.noise },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(spec?.color ?? 0x7d94b4) },
        uIntensity: { value: spec?.intensity ?? 0.5 },
        uThickness: { value: spec?.thickness ?? 1.6 },
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
          float lens = smoothstep( 5.0, 12.0, dist );
          float far = 1.0 - smoothstep( 32.0, 50.0, dist );

          float tau = uIntensity * n * uThickness / max( abs( dir.y ), 0.16 );
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

    for (let i = 0; i < this.shafts.length; i++) {
      const mesh = this.shafts[i];
      const u = mesh.material.uniforms;
      u.uTime.value = time;
      mesh.updateMatrixWorld();
      u.uInvModel.value.copy(mesh.matrixWorld).invert();
      const spec = this.specs[i];
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
    this.hazeMaterial.uniforms.uIntensity.value = 0.34 + breathe * 0.3;
    // The mood's fog colour is the right hue but it is authored for FogExp2,
    // where it is a destination colour rather than an emitted one; scattering
    // toward the eye needs it several stops up to register at all.
    if (envParams?.fog?.color) this.hazeMaterial.uniforms.uColor.value.copy(envParams.fog.color).multiplyScalar(16);

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
