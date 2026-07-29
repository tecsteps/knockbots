/**
 * Knockbots — coolant and hydraulic oil spray.
 *
 * Fluid is the counterpoint to the sparks: dark instead of hot, alpha-blended
 * instead of additive, and it *lands*. Each droplet is integrated on the GPU
 * from its spawn state like a spark, but with almost no restitution, so it
 * ends its life stuck to the floor rather than bouncing away.
 *
 * The wet look comes from the baked droplet texture, which carries a sharp
 * offset specular hotspot and a Fresnel rim in RGB and the blob shape in alpha.
 * Multiplying a near-black body colour by the alpha and *adding* the hotspot
 * gives a liquid that is dark in the mass and blinding at the highlight — the
 * signature of a specular dielectric, and something a flat sprite never gets.
 *
 * At spawn the CPU also solves the ballistic landing time in closed form and
 * queues a splat decal for that moment, so the floor accumulates coolant
 * exactly where the droplets fall without any per-frame collision testing.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_BALLISTIC, GLSL_BILLBOARD } from './FxShaders.js';

const _dir = new THREE.Vector3();
const _tan = new THREE.Vector3();
const _bit = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _alt = new THREE.Vector3(1, 0, 0);

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aLife;   // birth, life, seed, size
attribute vec3 aTint;

uniform float uTime;
uniform float uFloorY;
uniform float uSizeScale;

varying vec2 vUv;
varying vec3 vTint;
varying float vFade;

${GLSL_BALLISTIC}
${GLSL_BILLBOARD}

void main() {
  float birth = aLife.x, life = aLife.y, seed = aLife.z, size = aLife.w;
  float age = uTime - birth;
  float t = age / max( life, 1e-4 );
  if ( life <= 0.0 || t < 0.0 || t >= 1.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vFade = 0.0; vUv = vec2( 0.0 ); vTint = vec3( 0.0 );
    return;
  }

  vec3 vel;
  float bounces;
  vec3 p = ballistic( aOrigin, aVel, age, uFloorY, vel, bounces );

  float sz = size * uSizeScale;
  float len = sz * ( 1.0 + clamp( length( vel ) * 0.06, 0.0, 3.0 ) );
  vec2 corner = vec2( position.x, position.y - 0.5 );
  float along;
  vec4 mv = streakBillboard( p, vel, corner, sz, len, along );
  gl_Position = projectionMatrix * mv;

  vUv = vec2( uv.x, 1.0 - uv.y );
  vTint = aTint;
  // Droplets do not fade until they are nearly spent, then they soak in.
  vFade = 1.0 - smoothstep( 0.72, 1.0, t );
  vFade *= smoothstep( 0.0, 0.04, t );
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uBody;
uniform float uOpacity;
uniform float uSpecular;

varying vec2 vUv;
varying vec3 vTint;
varying float vFade;

void main() {
  vec4 tex = texture2D( uMap, vUv );
  float a = tex.a * vFade * uOpacity;
  if ( a < 0.006 ) discard;
  vec3 body = uBody * vTint;
  vec3 col = body + tex.rgb * uSpecular * vTint;
  gl_FragColor = vec4( col, a );
}`;

export class FluidSystem {
  /**
   * @param {THREE.Texture} map droplet texture
   * @param {number} capacity
   * @param {number} floorY
   */
  constructor(map, capacity = 768, floorY = 0) {
    this.floorY = floorY;
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
        uGravity: { value: -24.0 },
        uRestitution: { value: 0.08 },
        uTangentFriction: { value: 0.3 },
        uDrag: { value: 0.9 },
        uSizeScale: { value: 1 },
        uBody: { value: new THREE.Color(0.02, 0.024, 0.03) },
        uSpecular: { value: 2.4 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.pool.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 18;
    this.mesh.name = 'fx.fluid';
    this.mesh.matrixAutoUpdate = false;

    // Scheduled floor splats: a flat ring buffer drained by the director.
    this.splatCapacity = 192;
    this.splatTime = new Float32Array(this.splatCapacity).fill(Infinity);
    this.splatData = new Float32Array(this.splatCapacity * 7); // x,y,z,size,r,g,b
    this.splatCursor = 0;
  }

  /**
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal
   * @param {Object} [opts]
   * @param {number} [opts.count]
   * @param {number} [opts.speed]
   * @param {number} [opts.spread]
   * @param {number} [opts.life]
   * @param {number} [opts.size]
   * @param {THREE.Color} [opts.tint] coolant colour, usually the character emissive
   * @param {boolean} [opts.decals] queue floor splats where droplets land
   */
  spray(point, normal, opts = {}) {
    const count = Math.max(1, Math.round(opts.count ?? 18));
    const speed = opts.speed ?? 4.4;
    const spread = opts.spread ?? 0.85;
    const life = opts.life ?? 1.3;
    const size = opts.size ?? 0.045;
    const tint = opts.tint;
    const wantDecals = opts.decals !== false;

    _dir.copy(normal);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 1, 0);
    _dir.normalize();
    _tan.copy(Math.abs(_dir.y) > 0.9 ? _alt : _up).cross(_dir).normalize();
    _bit.copy(_dir).cross(_tan).normalize();

    const { aOrigin, aVel, aLife, aTint } = this.pool.arrays;
    const cap = this.pool.capacity;
    const first = this.pool.allocRun(count);
    const time = this.material.uniforms.uTime.value;
    const g = this.material.uniforms.uGravity.value;
    const tr = tint ? tint.r : 0.5, tg = tint ? tint.g : 0.72, tb = tint ? tint.b : 1.0;

    for (let k = 0; k < count; k++) {
      const i = (first + k) % cap;
      const phi = Math.random() * Math.PI * 2;
      const cosT = 1 - Math.random() * spread;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const cx = Math.cos(phi) * sinT, cz = Math.sin(phi) * sinT;
      const sp = speed * (0.3 + Math.random() * Math.random() * 1.9);

      const vx = (_dir.x * cosT + _tan.x * cx + _bit.x * cz) * sp;
      const vy = (_dir.y * cosT + _tan.y * cx + _bit.y * cz) * sp;
      const vz = (_dir.z * cosT + _tan.z * cx + _bit.z * cz) * sp;

      const o = i * 3;
      const px = point.x + (Math.random() - 0.5) * 0.07;
      const py = point.y + (Math.random() - 0.5) * 0.07;
      const pz = point.z + (Math.random() - 0.5) * 0.07;
      aOrigin[o] = px; aOrigin[o + 1] = py; aOrigin[o + 2] = pz;
      aVel[o] = vx; aVel[o + 1] = vy; aVel[o + 2] = vz;
      aTint[o] = tr; aTint[o + 1] = tg; aTint[o + 2] = tb;

      const l = i * 4;
      const lifeK = life * (0.7 + Math.random() * 0.7);
      aLife[l] = time;
      aLife[l + 1] = lifeK;
      aLife[l + 2] = Math.random() * 1000;
      aLife[l + 3] = size * (0.55 + Math.random() * 1.0);

      if (wantDecals && Math.random() < 0.34) {
        this.#scheduleSplat(time, px, py, pz, vx, vy, vz, g, size, tr, tg, tb);
      }
    }
  }

  /** Solves the floor crossing in closed form and queues the splat for then. */
  #scheduleSplat(time, px, py, pz, vx, vy, vz, g, size, r, gr, b) {
    const a = 0.5 * g;
    const c = py - this.floorY;
    const disc = vy * vy - 4 * a * c;
    if (disc <= 0) return;
    const sq = Math.sqrt(disc);
    const r1 = (-vy - sq) / (2 * a);
    const r2 = (-vy + sq) / (2 * a);
    const th = Math.max(r1, r2);
    if (!(th > 0) || th > 4) return;

    // Drag-corrected horizontal landing point, matching the shader's integrator.
    const k = this.material.uniforms.uDrag.value;
    const d = (1 - Math.exp(-k * th)) / k;
    const s = this.splatCursor;
    this.splatCursor = (this.splatCursor + 1) % this.splatCapacity;
    this.splatTime[s] = time + th;
    const o = s * 7;
    this.splatData[o] = px + vx * d;
    this.splatData[o + 1] = this.floorY;
    this.splatData[o + 2] = pz + vz * d;
    this.splatData[o + 3] = size * (2.6 + Math.random() * 3.4);
    this.splatData[o + 4] = r;
    this.splatData[o + 5] = gr;
    this.splatData[o + 6] = b;
  }

  /**
   * Emits every splat whose landing time has arrived.
   * @param {number} time
   * @param {(x:number,y:number,z:number,size:number,r:number,g:number,b:number)=>void} cb
   */
  drainSplats(time, cb) {
    for (let i = 0; i < this.splatCapacity; i++) {
      const t = this.splatTime[i];
      if (t === Infinity || t > time) continue;
      this.splatTime[i] = Infinity;
      const o = i * 7;
      cb(this.splatData[o], this.splatData[o + 1], this.splatData[o + 2], this.splatData[o + 3],
        this.splatData[o + 4], this.splatData[o + 5], this.splatData[o + 6]);
    }
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
    this.pool.flush();
  }

  setScale(scale) { this.material.uniforms.uSizeScale.value = scale; }

  reset() {
    this.pool.killAll();
    this.splatTime.fill(Infinity);
    this.splatCursor = 0;
  }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
  }
}
