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
 */

import * as THREE from 'three';
import { GROUND_Y, LAYER } from '../core/Constants.js';
import { DustMotes, SteamJets } from './StageParticles.js';

const SHAFT_VERT = /* glsl */ `
  uniform mat4 uInvModel;
  varying vec3 vLocal;
  varying vec3 vLocalEye;
  void main() {
    vLocal = position;
    vLocalEye = ( uInvModel * vec4( cameraPosition, 1.0 ) ).xyz;
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
  varying vec3 vLocal;
  varying vec3 vLocalEye;

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

    float span = tExit - tEnter;
    const int STEPS = 12;
    float stepLen = span / float( STEPS );
    // Blue-noise-ish jitter: without it twelve steps band visibly.
    float jitter = hash12( gl_FragCoord.xy + uTime * 60.0 );
    float acc = 0.0;

    for ( int i = 0; i < STEPS; i++ ) {
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

      // Two noise layers crawling down the beam at different rates.
      float n1 = texture2D( uNoise, vec2( p.x, p.z ) * uNoiseScale + vec2( 0.03, -0.02 ) * uTime ).r;
      float n2 = texture2D( uNoise, vec2( p.z * 0.7, d ) * uNoiseScale * 1.9 - vec2( 0.0, 0.05 * uTime ) ).g;
      float dust = mix( 1.0, ( n1 * 0.6 + n2 * 0.7 ), uNoiseAmp );

      float fall = exp( -d * uExtinction );
      float floorFade = smoothstep( uLength, uLength - uFloorFade, d );
      acc += edge * dust * fall * floorFade * stepLen;
    }

    if ( acc <= 0.0005 ) discard;
    gl_FragColor = vec4( uColor * ( acc * uIntensity ), 1.0 );
  }
`;

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
   */
  constructor({ textures, quality = 'high' }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.volumetrics';
    this.quality = quality;
    this.floorY = GROUND_Y;

    /**
     * Shaft placement. The two big ones hang off the cross-gantry above the
     * back of the pit, at the same coordinates as the Environment's overhead
     * practicals; the rest rake in through the shell wall's blown-out panels.
     */
    this.specs = [
      { pos: [-6.6, 5.34, -6.2], rot: [0, 0, 0], half: [3.1, 0.28], spread: [0.09, 0.16], length: 5.5, color: 0xbfd8ff, intensity: 0.09, round: 0.15, edge: 2.4 },
      { pos: [6.6, 5.34, -6.2], rot: [0, 0, 0], half: [3.1, 0.28], spread: [0.09, 0.16], length: 5.5, color: 0xbfd8ff, intensity: 0.09, round: 0.15, edge: 2.4 },
      { pos: [-9.5, 22.0, -18.4], rot: [0.34, 0.12, 0.16], half: [3.4, 2.6], spread: [0.05, 0.05], length: 23, color: 0x8fb4e8, intensity: 0.024, round: 0.55, edge: 1.7 },
      { pos: [2.0, 24.0, -18.4], rot: [0.4, -0.1, -0.13], half: [4.4, 3.4], spread: [0.05, 0.05], length: 25, color: 0x9dc0ee, intensity: 0.02, round: 0.55, edge: 1.6 },
      { pos: [-10.2, 4.6, -8.4], rot: [0.1, 0, -0.55], half: [1.5, 1.2], spread: [0.12, 0.12], length: 6.5, color: 0x9fdcff, intensity: 0.05, round: 0.8, edge: 2.0 },
    ];
    const budget = quality === 'low' ? 2 : quality === 'medium' ? 3 : this.specs.length;

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
          uExtinction: { value: 0.06 },
          uNoiseScale: { value: 0.07 },
          uNoiseAmp: { value: 0.75 },
          uFloorFade: { value: 1.4 },
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
    this.#deckHaze(textures);

    this.motes = new DustMotes(textures.dust, { x: 26, y: 9, z: 22, cx: 0, cy: 0.2, cz: 0 }, {
      count: quality === 'low' ? 260 : quality === 'medium' ? 520 : 1000,
      color: 0xd6e6ff,
      size: 0.03,
      drift: 0.19,
    });
    this.group.add(this.motes.points);

    this.steam = new SteamJets(textures.steam, [
      { origin: [-15.4, 2.2, -3.2], dir: [0.85, 0.3, 0.1], rate: 1, speed: 1.5, life: 4.2, size: 0.85 },
      { origin: [15.4, 3.4, 7.4], dir: [-0.8, 0.35, -0.2], rate: 1, speed: 1.2, life: 4.8, size: 0.95 },
      { origin: [-3.0, 0.05, -12.4], dir: [0.05, 1.0, 0.1], rate: 1, speed: 0.5, life: 7.0, size: 1.5 },
      { origin: [9.4, 5.2, -12.9], dir: [-0.2, 0.9, 0.35], rate: 1, speed: 0.8, life: 5.5, size: 1.1 },
    ], { perJet: quality === 'low' ? 10 : 24, opacity: 0.16, color: 0x9fb3c8 });
    this.group.add(this.steam.points);
  }

  /**
   * Additive pools where each shaft meets the deck. Cheap, and they carry the
   * light onto a surface the shaft itself has been faded out of.
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
      const width = (spec.half[0] + spec.spread[0] * spec.length) * 4.2;
      const depth = (spec.half[1] + spec.spread[1] * spec.length) * 4.2;
      s.set(width, 1, Math.max(depth, width * 0.35));
      m.compose(p, q, s);
      this.pools.setMatrixAt(i, m);
      this._poolBase.push(new THREE.Color(spec.color).multiplyScalar(spec.intensity * 5.5));
      this.pools.setColorAt(i, this._poolBase[i]);
    }
    this.pools.instanceMatrix.needsUpdate = true;
    this.pools.instanceColor.needsUpdate = true;
    this.group.add(this.pools);
  }

  /**
   * A single low slab of drifting mist. It sits just above the deck, fades out
   * over the fight plane so it never obscures a fighter's feet, and gives the
   * shafts something to terminate into.
   */
  #deckHaze(textures) {
    const geo = new THREE.PlaneGeometry(52, 44, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.hazeMaterial = new THREE.ShaderMaterial({
      name: 'arena.deckHaze',
      uniforms: {
        uNoise: { value: textures.noise },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x7d94b4) },
        uIntensity: { value: 0.11 },
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
        varying vec3 vWorld;
        void main() {
          vec2 uv = vWorld.xz * 0.026;
          float a = texture2D( uNoise, uv + vec2( uTime * 0.004, uTime * 0.0026 ) ).r;
          float b = texture2D( uNoise, uv * 2.3 - vec2( uTime * 0.0031, uTime * 0.005 ) ).g;
          float n = smoothstep( 0.32, 0.92, a * 0.65 + b * 0.55 );
          // Clear of the fight plane, thick toward the back of the hall.
          float clear = smoothstep( 3.0, 11.0, length( vec2( vWorld.x * 0.62, vWorld.z - 1.0 ) ) );
          float far = 1.0 - smoothstep( 16.0, 26.0, abs( vWorld.z + 6.0 ) );
          float k = n * clear * far * uIntensity;
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
    this.haze.position.set(0, this.floorY + 0.55, -2);
    this.haze.frustumCulled = false;
    this.haze.userData.gbuffer = false;
    this.haze.layers.set(LAYER.NO_REFLECT);
    this.haze.renderOrder = 4;
    this.group.add(this.haze);
  }

  /**
   * @param {number} dt
   * @param {number} time
   * @param {number} shaftIntensity the Environment's breathing multiplier
   * @param {object} envParams
   */
  update(dt, time, shaftIntensity, envParams) {
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
    this.hazeMaterial.uniforms.uIntensity.value = 0.06 + breathe * 0.07;
    if (envParams?.fog?.color) this.hazeMaterial.uniforms.uColor.value.copy(envParams.fog.color).multiplyScalar(4.2);

    this.motes.update(time, 0.55 + breathe * 0.7);
    this.steam.update(time);
    void dt;
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
