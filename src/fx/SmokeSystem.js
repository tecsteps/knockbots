/**
 * Knockbots — dust, smoke and thruster plumes.
 *
 * The single thing that separates convincing smoke from a grey sprite spray is
 * that it is *lit*. Each puff carries a baked hemispherical normal (see
 * `bakeSmokePuff`), which the fragment shader shades against the stage key light
 * in view space with a wrapped diffuse plus a forward-scatter term. Backlit dust
 * therefore glows at its silhouette and goes dark toward the camera, exactly
 * like the real thing, and it picks up the character of the arena lighting for
 * free.
 *
 * Motion is curl-noise advection evaluated in the vertex shader from the spawn
 * state, so — like the sparks — nothing is stepped on the CPU. The curl field is
 * divergence-free, which is why the puffs shear and roll instead of drifting in
 * a straight line and inflating.
 *
 * When the render pipeline exposes a depth prepass the shader also does a soft
 * depth fade, so dust kicked up on a dash sinks into the floor instead of
 * slicing it with a hard sprite edge.
 */

import * as THREE from 'three';
import { InstancedPool } from './InstancedPool.js';
import { GLSL_CURL, GLSL_HASH, GLSL_EASE, GLSL_BILLBOARD } from './FxShaders.js';

const _v = new THREE.Vector3();

const VERT = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aLife;    // birth, life, seed, size
attribute vec4 aStyle;   // growth, curlStrength, buoyancy, spinRate
attribute vec4 aTint;    // rgb tint, a = emissive weight

uniform float uTime;
uniform float uSizeScale;
uniform float uCurlScale;
uniform float uDragK;

varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
varying float vEmissive;
varying float vViewZ;
varying float vSize;

${GLSL_HASH}
${GLSL_EASE}
${GLSL_CURL}
${GLSL_BILLBOARD}

void main() {
  float birth = aLife.x, life = aLife.y, seed = aLife.z, size = aLife.w;
  float age = uTime - birth;
  float t = age / max( life, 1e-4 );
  if ( life <= 0.0 || t < 0.0 || t >= 1.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    vFade = 0.0; vUv = vec2( 0.0 ); vTint = vec3( 0.0 );
    vEmissive = 0.0; vViewZ = 0.0; vSize = 0.0;
    return;
  }

  // Ballistic-with-drag launch, then buoyant rise, then curl advection.
  float k = max( uDragK, 1e-3 );
  vec3 p = aOrigin + aVel * ( 1.0 - exp( -k * age ) ) / k;
  p.y += aStyle.z * pow( age, 1.35 );
  p = curlAdvect( p, age, uCurlScale, aStyle.y );

  // Puffs expand as they entrain air; the growth curve decelerates.
  float sz = size * uSizeScale * ( 1.0 + aStyle.x * easeOutCubic( t ) );
  float roll = seed * 6.2831 + aStyle.w * age;

  vec4 mv = billboard( p, position.xy, sz, roll );
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vTint = aTint.rgb;
  vEmissive = aTint.a;
  // Fade in fast, out slow: dust appears the instant a boot lands.
  vFade = smoothstep( 0.0, 0.09, t ) * ( 1.0 - easeInCubic( smoothstep( 0.25, 1.0, t ) ) );
  vViewZ = -mv.z;
  vSize = sz;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uDepth;
uniform vec3 uLightDir;      // view space, pointing from surface toward light
uniform vec3 uLightColor;
uniform vec3 uAmbient;
uniform float uOpacity;
uniform float uSoft;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;

varying vec2 vUv;
varying vec3 vTint;
varying float vFade;
varying float vEmissive;
varying float vViewZ;
varying float vSize;

float viewZFromDepth( float d ) {
  return ( uNear * uFar ) / ( ( uFar - uNear ) * d - uFar );
}

void main() {
  vec4 tex = texture2D( uMap, vUv );
  float cover = tex.a * vFade * uOpacity;
  if ( cover < 0.004 ) discard;

  // Reconstruct the baked hemispherical normal; the billboard is camera facing
  // so this is already a view-space normal.
  vec2 nxy = tex.rg * 2.0 - 1.0;
  vec3 n = vec3( nxy, sqrt( max( 0.0, 1.0 - dot( nxy, nxy ) ) ) );

  float thickness = tex.b;
  // Wrapped diffuse: light bleeds past the terminator through a thin medium.
  float wrapped = clamp( dot( n, uLightDir ) * 0.5 + 0.5, 0.0, 1.0 );
  float diffuse = pow( wrapped, 1.7 );
  // Forward scatter: strongest when the key light points back at the camera.
  float toward = clamp( uLightDir.z, 0.0, 1.0 );
  float scatter = pow( toward, 2.2 ) * ( 1.0 - thickness ) * 1.35;
  // Silhouette rim, where the sheet is thinnest and the most light gets through.
  float rim = pow( 1.0 - clamp( n.z, 0.0, 1.0 ), 2.6 ) * 0.55;

  vec3 lit = uAmbient * ( 0.55 + thickness * 0.6 )
           + uLightColor * ( diffuse * ( 0.35 + thickness * 0.9 ) + scatter + rim * toward );
  vec3 col = vTint * lit + vTint * vEmissive;

  // Soft particles: fade where the puff intersects opaque geometry.
  float soft = 1.0;
  if ( uSoft > 0.5 ) {
    float d = texture2D( uDepth, gl_FragCoord.xy / uResolution ).x;
    float sceneZ = -viewZFromDepth( d );
    soft = clamp( ( sceneZ - vViewZ ) / max( vSize * 0.9, 0.05 ), 0.0, 1.0 );
  }

  gl_FragColor = vec4( col, cover * soft );
}`;

export class SmokeSystem {
  /**
   * @param {THREE.Texture} map lit puff texture
   * @param {THREE.Texture} curl curl potential field
   * @param {number} capacity
   */
  constructor(map, curl, capacity = 640) {
    this.pool = new InstancedPool({
      capacity,
      lifeAttribute: 'aLife',
      lifeComponent: 1,
      attributes: { aOrigin: 3, aVel: 3, aLife: 4, aStyle: 4, aTint: 4 },
    });

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: map },
        uCurl: { value: curl },
        uDepth: { value: null },
        uLightDir: { value: new THREE.Vector3(0, 0.5, 1).normalize() },
        uLightColor: { value: new THREE.Color(1.0, 0.94, 0.86) },
        uAmbient: { value: new THREE.Color(0.16, 0.2, 0.28) },
        uOpacity: { value: 1 },
        uSizeScale: { value: 1 },
        uCurlScale: { value: 0.35 },
        uDragK: { value: 2.6 },
        uSoft: { value: 0 },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uNear: { value: 0.15 },
        uFar: { value: 260 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.pool.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.name = 'fx.smoke';
    this.mesh.matrixAutoUpdate = false;
  }

  /**
   * Spawns a puff cloud.
   * @param {THREE.Vector3} point
   * @param {Object} opts
   * @param {number} [opts.count]
   * @param {THREE.Vector3} [opts.dir]     mean ejection direction
   * @param {number} [opts.speed]
   * @param {number} [opts.spread]         lateral scatter, metres/s
   * @param {number} [opts.radius]         spawn ball radius
   * @param {number} [opts.size]
   * @param {number} [opts.growth]         size multiplier gained over the life
   * @param {number} [opts.life]
   * @param {number} [opts.buoyancy]
   * @param {number} [opts.curl]
   * @param {THREE.Color} [opts.tint]
   * @param {number} [opts.emissive]       self-illumination weight, for plumes
   */
  puff(point, opts = {}) {
    const count = Math.max(1, Math.round(opts.count ?? 8));
    const dir = opts.dir || _v.set(0, 1, 0);
    const speed = opts.speed ?? 1.4;
    const spread = opts.spread ?? 0.9;
    const radius = opts.radius ?? 0.18;
    const size = opts.size ?? 0.55;
    const growth = opts.growth ?? 1.8;
    const life = opts.life ?? 1.5;
    const buoyancy = opts.buoyancy ?? 0.25;
    const curl = opts.curl ?? 0.5;
    const tint = opts.tint;
    const emissive = opts.emissive ?? 0;

    const { aOrigin, aVel, aLife, aStyle, aTint } = this.pool.arrays;
    const cap = this.pool.capacity;
    const first = this.pool.allocRun(count);
    const time = this.material.uniforms.uTime.value;
    const tr = tint ? tint.r : 0.52;
    const tg = tint ? tint.g : 0.5;
    const tb = tint ? tint.b : 0.48;

    for (let k = 0; k < count; k++) {
      const i = (first + k) % cap;
      const o = i * 3;
      aOrigin[o] = point.x + (Math.random() - 0.5) * radius * 2;
      aOrigin[o + 1] = point.y + (Math.random() - 0.5) * radius * 2;
      aOrigin[o + 2] = point.z + (Math.random() - 0.5) * radius * 2;

      const sp = speed * (0.45 + Math.random() * 1.1);
      aVel[o] = dir.x * sp + (Math.random() - 0.5) * spread;
      aVel[o + 1] = dir.y * sp + (Math.random() - 0.5) * spread * 0.6;
      aVel[o + 2] = dir.z * sp + (Math.random() - 0.5) * spread;

      const l = i * 4;
      aLife[l] = time;
      aLife[l + 1] = life * (0.7 + Math.random() * 0.7);
      aLife[l + 2] = Math.random() * 1000;
      aLife[l + 3] = size * (0.65 + Math.random() * 0.8);

      aStyle[l] = growth * (0.7 + Math.random() * 0.7);
      aStyle[l + 1] = curl * (0.6 + Math.random() * 0.9);
      aStyle[l + 2] = buoyancy * (0.5 + Math.random());
      aStyle[l + 3] = (Math.random() - 0.5) * 1.4;

      const shade = 0.78 + Math.random() * 0.44;
      aTint[l] = tr * shade;
      aTint[l + 1] = tg * shade;
      aTint[l + 2] = tb * shade;
      aTint[l + 3] = emissive;
    }
  }

  /**
   * Feeds the shader the stage lighting so the dust matches the arena.
   * @param {THREE.Vector3} worldLightDir direction the light travels
   * @param {THREE.Color} color
   * @param {THREE.Color} ambient
   * @param {THREE.Camera} camera
   */
  setLighting(worldLightDir, color, ambient, camera) {
    // Shading wants the vector from the surface toward the light, in view space.
    _v.copy(worldLightDir).negate().transformDirection(camera.matrixWorldInverse).normalize();
    this.material.uniforms.uLightDir.value.copy(_v);
    this.material.uniforms.uLightColor.value.copy(color);
    this.material.uniforms.uAmbient.value.copy(ambient);
  }

  /**
   * Wires the render pipeline's depth prepass for soft particles.
   * @param {THREE.Texture|null} depthTexture
   * @param {number} width @param {number} height
   * @param {number} near @param {number} far
   */
  setDepth(depthTexture, width, height, near, far) {
    const u = this.material.uniforms;
    u.uDepth.value = depthTexture || null;
    u.uSoft.value = depthTexture ? 1 : 0;
    u.uResolution.value.set(width, height);
    u.uNear.value = near;
    u.uFar.value = far;
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
    this.pool.flush();
  }

  setScale(scale) { this.material.uniforms.uSizeScale.value = scale; }

  reset() { this.pool.killAll(); }

  dispose() {
    this.pool.dispose();
    this.material.dispose();
  }
}
