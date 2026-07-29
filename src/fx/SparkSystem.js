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
 * Two details do most of the visual work:
 *
 *  - **Velocity-stretched billboards.** A spark is a streak, not a dot. The quad
 *    is aligned to the screen-space velocity and its length scales with speed,
 *    with the bright head pinned to the particle position and the tail trailing
 *    behind it. Stretch is clamped so a fast spark never becomes a laser.
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

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aLife;    // birth, life, seed, size
attribute vec3 aTint;

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
  float len = sz * ( 1.0 + clamp( speed * uStreak, 0.0, 11.0 ) );

  // Head of the streak sits on the particle; the body trails behind it.
  vec2 corner = vec2( position.x, position.y - 0.5 );
  float along;
  vec4 mv = streakBillboard( p, vel, corner, sz, len, along );
  gl_Position = projectionMatrix * mv;

  vUv = vec2( uv.x, 1.0 - uv.y );

  // Sparks are shedding oxide: they sputter. Bounced sparks have given up
  // energy to the floor and burn visibly cooler.
  float flicker = 0.7 + 0.3 * sin( seed * 61.7 + uTime * 78.0 + hash11( seed ) * 6.28 );
  float heat = uHeat * flicker * exp( -bounces * 0.35 );
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
      attributes: { aOrigin: 3, aVel: 3, aLife: 4, aTint: 3 },
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
        uDrag: { value: 1.35 },
        uSizeScale: { value: 1 },
        uStreak: { value: 0.055 },
        uHeat: { value: 5.5 },
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
   * Emits a cone of sparks oriented by a surface normal.
   * @param {THREE.Vector3} point contact point in world space
   * @param {THREE.Vector3} normal hit normal; the cone axis
   * @param {Object} [opts]
   * @param {number} [opts.count]
   * @param {number} [opts.speed]   mean ejection speed, m/s
   * @param {number} [opts.spread]  0 = pencil beam, 1 = full hemisphere
   * @param {number} [opts.life]    seconds
   * @param {number} [opts.size]    metres
   * @param {THREE.Color|{r:number,g:number,b:number}} [opts.tint]
   * @param {THREE.Vector3} [opts.inherit] velocity added to every spark
   */
  burst(point, normal, opts = {}) {
    const count = Math.max(1, Math.round(opts.count ?? 40));
    const speed = opts.speed ?? 7.5;
    const spread = opts.spread ?? 0.55;
    const life = opts.life ?? 0.55;
    const size = opts.size ?? 0.035;
    const tint = opts.tint;
    const inherit = opts.inherit;

    _dir.copy(normal);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
    _dir.normalize();
    // Orthonormal basis about the hit normal so the cone is exact.
    _tan.copy(Math.abs(_dir.y) > 0.9 ? _alt : _up).cross(_dir).normalize();
    _bit.copy(_dir).cross(_tan).normalize();

    const { aOrigin, aVel, aLife, aTint } = this.pool.arrays;
    const cap = this.pool.capacity;
    const first = this.pool.allocRun(count);
    const time = this.material.uniforms.uTime.value;

    const tr = tint ? tint.r : 1;
    const tg = tint ? tint.g : 1;
    const tb = tint ? tint.b : 1;

    for (let k = 0; k < count; k++) {
      const i = (first + k) % cap;

      // Cosine-lobe about the normal, widened by `spread`.
      const u = Math.random();
      const phi = Math.random() * Math.PI * 2;
      const cosT = 1 - u * spread * spread;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const cx = Math.cos(phi) * sinT;
      const cz = Math.sin(phi) * sinT;

      // Heavy tail on speed: a few sparks fly much further than the rest, which
      // is what stops a burst from looking like a uniform puff.
      const r = Math.random();
      const sp = speed * (0.35 + r * r * r * 2.1);

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
      aLife[l + 1] = life * (0.55 + Math.random() * 0.85);
      aLife[l + 2] = Math.random() * 1000;
      aLife[l + 3] = size * (0.6 + Math.random() * 0.9);
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
