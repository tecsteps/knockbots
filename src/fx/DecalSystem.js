/**
 * Knockbots — ground decals.
 *
 * Scorch marks, coolant splats, fracture stars and dust scuffs projected flat on
 * the arena floor. They accumulate across a round and fade out slowly, so by the
 * end of a long exchange the floor is a record of the fight — which is the
 * cheapest and most convincing way to make a stage feel *used*.
 *
 * Implementation notes:
 *
 *  - One instanced quad per decal, one draw call for all of them, one shared
 *    procedurally-baked 2x2 atlas. Per instance: position, radius, rotation,
 *    atlas cell, birth, life and a tint the atlas mask is multiplied by, which
 *    is how one oil cell serves every character's coolant colour.
 *  - They are true decals only in the sense that matters here: the arena floor
 *    is planar, so a flat quad at `floorY` plus polygon offset is exactly
 *    correct and costs nothing, where a projected-box decal would need a depth
 *    prepass and a second full-screen pass.
 *  - Rendered before the particle layer and never writing depth, so sparks and
 *    smoke composite over them in the right order.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_EASE } from './FxShaders.js';

/** Atlas cell coordinates baked by `bakeDecalAtlas`. */
export const DECAL = {
  SCORCH: [0, 0],
  OIL: [1, 0],
  FRACTURE: [0, 1],
  SCUFF: [1, 1],
};

const VERT = /* glsl */ `
attribute vec4 aXform;    // x, z, radius, rotation
attribute vec2 aCell;     // atlas cell
attribute vec3 aTiming;   // birth, life, fadeIn
attribute vec4 aTint;     // rgb, strength

uniform float uTime;
uniform float uFloorY;

varying vec2 vUv;
varying vec4 vTint;
varying float vFade;

${GLSL_EASE}

void main() {
  float age = uTime - aTiming.x;
  float life = aTiming.y;
  if ( life <= 0.0 || age < 0.0 || age >= life ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vUv = vec2( 0.0 ); vTint = vec4( 0.0 ); vFade = 0.0;
    return;
  }

  float c = cos( aXform.w ), s = sin( aXform.w );
  vec2 local = mat2( c, s, -s, c ) * position.xy * aXform.z;
  vec3 world = vec3( aXform.x + local.x, uFloorY, aXform.y + local.y );

  gl_Position = projectionMatrix * viewMatrix * vec4( world, 1.0 );

  // 2% inset keeps mip-filtered neighbours out of the cell.
  vUv = ( uv * 0.96 + 0.02 ) * 0.5 + aCell * 0.5;
  vTint = aTint;

  float t = age / life;
  float in_ = smoothstep( 0.0, max( aTiming.z, 1e-4 ), age );
  float out_ = 1.0 - easeInCubic( smoothstep( 0.45, 1.0, t ) );
  vFade = in_ * out_;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform float uOpacity;

varying vec2 vUv;
varying vec4 vTint;
varying float vFade;

void main() {
  vec4 tex = texture2D( uAtlas, vUv );
  float a = tex.a * vFade * vTint.a * uOpacity;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( tex.rgb * vTint.rgb, a );
}`;

export class DecalSystem {
  /**
   * @param {THREE.Texture} atlas 2x2 decal atlas
   * @param {number} capacity
   * @param {number} floorY
   */
  constructor(atlas, capacity = 160, floorY = 0) {
    this.pool = new InstancedPool({
      capacity,
      lifeAttribute: 'aTiming',
      lifeComponent: 1,
      attributes: { aXform: 4, aCell: 2, aTiming: 3, aTint: 4 },
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uAtlas: { value: atlas },
        uFloorY: { value: floorY + 0.006 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(this.pool.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'fx.decals';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.gbuffer = false;
  }

  /**
   * @param {[number,number]} cell one of `DECAL.*`
   * @param {number} x @param {number} z world position
   * @param {number} radius metres
   * @param {Object} [opts]
   * @param {number} [opts.life] seconds
   * @param {number} [opts.fadeIn] seconds
   * @param {number} [opts.rotation] radians; random when omitted
   * @param {THREE.Color|{r:number,g:number,b:number}} [opts.tint]
   * @param {number} [opts.strength] 0..1 opacity multiplier
   */
  add(cell, x, z, radius, opts = {}) {
    const i = this.pool.alloc();
    const { aXform, aCell, aTiming, aTint } = this.pool.arrays;
    const time = this.material.uniforms.uTime.value;

    const x4 = i * 4;
    aXform[x4] = x;
    aXform[x4 + 1] = z;
    aXform[x4 + 2] = radius;
    aXform[x4 + 3] = opts.rotation ?? Math.random() * Math.PI * 2;

    const c2 = i * 2;
    aCell[c2] = cell[0];
    aCell[c2 + 1] = cell[1];

    const t3 = i * 3;
    aTiming[t3] = time;
    aTiming[t3 + 1] = opts.life ?? 26;
    aTiming[t3 + 2] = opts.fadeIn ?? 0.06;

    const tint = opts.tint;
    aTint[x4] = tint ? tint.r : 1;
    aTint[x4 + 1] = tint ? tint.g : 1;
    aTint[x4 + 2] = tint ? tint.b : 1;
    aTint[x4 + 3] = opts.strength ?? 1;
    return i;
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
    this.pool.flush();
  }

  /** @param {number} y arena floor height */
  setFloor(y) { this.material.uniforms.uFloorY.value = y + 0.006; }

  reset() { this.pool.killAll(); }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
  }
}
