/**
 * Knockbots — metal debris.
 *
 * Sparks are light and belong on the GPU; debris is heavy and belongs on the
 * CPU, because the whole point of a torn-off armour shard is that it *behaves*
 * — it tumbles, it lands on an edge and kicks, it slides and comes to rest. A
 * hundred and sixty shards of rigid-body integration is nothing, and doing it
 * on the CPU buys real angular momentum, real friction, and shards that stay on
 * the floor afterwards as set dressing instead of evaporating.
 *
 * They are drawn as one `InstancedMesh` with a physical metal material, so they
 * take the stage key light, the coloured rim, and the environment reflection
 * exactly like the fighters do. That shared lighting response is what sells them
 * as pieces of the robot rather than as particles.
 *
 * A shard torn off armour by a launcher leaves at the temperature the impact put
 * into it, so each one carries its own cooling emission on the same blackbody
 * ramp the sparks use. That is the longest-lived bright element a hit produces:
 * the flare is gone in four frames and the sparks in a second, but a glowing
 * fragment is still tumbling and bouncing across the floor while the reaction
 * animation finishes, which is what stops a heavy hit from leaving nothing
 * behind it.
 */

import * as THREE from 'three';
import { GLSL_TEMPERATURE } from './FxShaders.js';

const _q = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _color = new THREE.Color();

/** Seconds a fresh shard takes to cool from white-hot to dead metal. */
const COOL_TIME = 1.8;

/**
 * An irregular faceted shard. Built from a subdivided tetrahedron whose vertices
 * are pushed along randomised directions, then flat-shaded so every facet
 * catches the rim light at a different angle.
 */
function makeShardGeometry(seed = 1) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };

  const g = new THREE.TetrahedronGeometry(0.5, 1);
  const pos = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)}|${pos.getY(i).toFixed(3)}|${pos.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) {
      d = [(rnd() - 0.5) * 0.55, (rnd() - 0.5) * 0.55, (rnd() - 0.5) * 0.55];
      seen.set(key, d);
    }
    pos.setXYZ(i, pos.getX(i) * (0.62 + d[0]) + d[0] * 0.3, pos.getY(i) * (0.34 + d[1] * 0.4), pos.getZ(i) * (0.62 + d[2]) + d[2] * 0.3);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

export class DebrisSystem {
  /**
   * @param {number} capacity
   * @param {THREE.Texture} detail roughness/AO break-up map
   * @param {number} floorY
   */
  constructor(capacity = 176, detail = null, floorY = 0) {
    this.capacity = capacity;
    this.floorY = floorY;
    this.cursor = 0;
    this.active = 0;

    this.geometry = makeShardGeometry(0x51ed);
    this.material = new THREE.MeshPhysicalMaterial({
      color: 0x8a8f96,
      metalness: 1.0,
      roughness: 0.34,
      roughnessMap: detail,
      envMapIntensity: 1.35,
      flatShading: true,
      clearcoat: 0.15,
      clearcoatRoughness: 0.4,
    });

    // Per-instance residual heat, injected into the standard emissive path so
    // the shards still get the full physical lighting model on top of it.
    this.heatGain = { value: 2.4 };
    this.heat = new Float32Array(capacity);
    this.geometry.setAttribute('aHeat', new THREE.InstancedBufferAttribute(this.heat, 1));
    this.geometry.attributes.aHeat.setUsage(THREE.DynamicDrawUsage);
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uHeatGain = this.heatGain;
      shader.vertexShader = `attribute float aHeat;\nvarying float vHeat;\n${shader.vertexShader}`
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvHeat = aHeat;');
      shader.fragmentShader = `uniform float uHeatGain;\nvarying float vHeat;\n${GLSL_TEMPERATURE}\n${shader.fragmentShader}`
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += sparkEmission( 1.0 - vHeat, uHeatGain );',
        );
    };

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'fx.debris';
    this.mesh.count = capacity;
    this.mesh.receiveShadow = true;

    // State-of-arrays: one contiguous typed array per quantity, so the
    // integration loop never touches an object and never allocates.
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rot = new Float32Array(capacity * 4);
    this.spin = new Float32Array(capacity * 3);
    this.scale = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.tint = new Float32Array(capacity * 3);
    /** Per-shard cooling rate, as a multiple of `COOL_TIME`. */
    this.coolRate = new Float32Array(capacity);

    for (let i = 0; i < capacity; i++) {
      this.rot[i * 4 + 3] = 1;
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;

    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this.gravity = -26;
    this.restitution = 0.34;
    this.friction = 0.72;
  }

  /** Shadows are worth it on the top tier only; 176 tiny casters are not free. */
  setShadows(enabled) { this.mesh.castShadow = !!enabled; }

  /**
   * Throws a handful of shards out of a break point.
   * @param {THREE.Vector3} point
   * @param {THREE.Vector3} normal ejection axis
   * @param {Object} [opts]
   * @param {number} [opts.count]
   * @param {number} [opts.speed]
   * @param {number} [opts.spread]
   * @param {number} [opts.size]
   * @param {number} [opts.life]
   * @param {THREE.Color} [opts.color]
   */
  burst(point, normal, opts = {}) {
    const count = Math.max(1, Math.round(opts.count ?? 10));
    const speed = opts.speed ?? 5.2;
    const spread = opts.spread ?? 0.8;
    const size = opts.size ?? 0.07;
    const life = opts.life ?? 5.0;
    const col = opts.color || _color.setRGB(0.62, 0.65, 0.7);

    _axis.copy(normal);
    if (_axis.lengthSq() < 1e-6) _axis.set(0, 1, 0);
    _axis.normalize();
    const tx = Math.abs(_axis.y) > 0.9 ? 1 : 0;
    _p.set(tx, tx ? 0 : 1, 0).cross(_axis).normalize();
    _s.copy(_axis).cross(_p).normalize();

    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      if (this.active < this.capacity) this.active++;

      const phi = Math.random() * Math.PI * 2;
      const cosT = 1 - Math.random() * spread;
      const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
      const cx = Math.cos(phi) * sinT, cz = Math.sin(phi) * sinT;
      const sp = speed * (0.4 + Math.random() * 1.3);

      const o = i * 3;
      this.pos[o] = point.x + (Math.random() - 0.5) * 0.08;
      this.pos[o + 1] = point.y + (Math.random() - 0.5) * 0.08;
      this.pos[o + 2] = point.z + (Math.random() - 0.5) * 0.08;
      this.vel[o] = (_axis.x * cosT + _p.x * cx + _s.x * cz) * sp;
      this.vel[o + 1] = (_axis.y * cosT + _p.y * cx + _s.y * cz) * sp + 1.1;
      this.vel[o + 2] = (_axis.z * cosT + _p.z * cx + _s.z * cz) * sp;
      this.spin[o] = (Math.random() - 0.5) * 34;
      this.spin[o + 1] = (Math.random() - 0.5) * 34;
      this.spin[o + 2] = (Math.random() - 0.5) * 34;

      // Shards are plate fragments: wide, long, thin. Uniform cubes read as gravel.
      const sc = size * (0.55 + Math.random() * 1.1);
      this.scale[o] = sc * (0.7 + Math.random() * 0.9);
      this.scale[o + 1] = sc * (0.25 + Math.random() * 0.35);
      this.scale[o + 2] = sc * (0.7 + Math.random() * 0.9);

      const r = i * 4;
      _q.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      this.rot[r] = _q.x; this.rot[r + 1] = _q.y; this.rot[r + 2] = _q.z; this.rot[r + 3] = _q.w;

      this.maxLife[i] = life * (0.7 + Math.random() * 0.6);
      this.life[i] = this.maxLife[i];
      this.heat[i] = 0.75 + Math.random() * 0.25;
      // A shard is torn off a painted, scuffed, unevenly weathered plate, so no
      // two come off the same colour. One flat tint across the whole burst is
      // the same defect the spark fragments had — a population that reads as one
      // object stamped out N times. Value varies most (which face of the plate,
      // how much primer is left), hue a little.
      const v = 0.74 + Math.random() * 0.52;
      this.tint[o] = col.r * v * (0.94 + Math.random() * 0.12);
      this.tint[o + 1] = col.g * v * (0.94 + Math.random() * 0.12);
      this.tint[o + 2] = col.b * v * (0.94 + Math.random() * 0.12);
      // Mass decides how long it holds the heat the blow put into it. Without
      // this the whole burst dims in lockstep, which is what turns a scatter of
      // torn metal back into a single fading decal.
      this.coolRate[i] = 0.55 + Math.random() * 1.05;
    }
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (this.active === 0) return;
    const step = Math.min(dt, 1 / 30);
    const g = this.gravity * step;
    let any = false;
    let live = 0;

    for (let i = 0; i < this.capacity; i++) {
      let l = this.life[i];
      if (l <= 0) continue;
      any = true;
      l -= dt;
      const o = i * 3;
      const r = i * 4;

      this.vel[o + 1] += g;
      this.pos[o] += this.vel[o] * step;
      this.pos[o + 1] += this.vel[o + 1] * step;
      this.pos[o + 2] += this.vel[o + 2] * step;

      const rest = this.floorY + this.scale[o + 1] * 0.5;
      if (this.pos[o + 1] < rest) {
        this.pos[o + 1] = rest;
        if (this.vel[o + 1] < 0) {
          const impact = -this.vel[o + 1];
          this.vel[o + 1] = impact * this.restitution;
          this.vel[o] *= this.friction;
          this.vel[o + 2] *= this.friction;
          // Tangential contact converts sliding into tumble.
          this.spin[o] = this.spin[o] * 0.55 - this.vel[o + 2] * 5.5;
          this.spin[o + 1] *= 0.6;
          this.spin[o + 2] = this.spin[o + 2] * 0.55 + this.vel[o] * 5.5;
          if (impact < 0.7) {
            // Settled: stop bouncing, let it grind to a halt and lie flat.
            this.vel[o + 1] = 0;
            this.vel[o] *= 0.72;
            this.vel[o + 2] *= 0.72;
            this.spin[o] *= 0.5; this.spin[o + 1] *= 0.5; this.spin[o + 2] *= 0.5;
          }
        }
      }

      _q.set(this.rot[r], this.rot[r + 1], this.rot[r + 2], this.rot[r + 3]);
      const wx = this.spin[o] * step * 0.5, wy = this.spin[o + 1] * step * 0.5, wz = this.spin[o + 2] * step * 0.5;
      _dq.set(wx, wy, wz, 0).multiply(_q);
      _q.set(_q.x + _dq.x, _q.y + _dq.y, _q.z + _dq.z, _q.w + _dq.w).normalize();
      this.rot[r] = _q.x; this.rot[r + 1] = _q.y; this.rot[r + 2] = _q.z; this.rot[r + 3] = _q.w;

      // Air drag on the tumble, so shards do not spin forever on the ground.
      const damp = Math.exp(-step * 1.4);
      this.spin[o] *= damp; this.spin[o + 1] *= damp; this.spin[o + 2] *= damp;

      // The last half second shrinks the shard away rather than popping it.
      const fade = Math.min(1, l / 0.5);
      _p.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      _s.set(this.scale[o] * fade, this.scale[o + 1] * fade, this.scale[o + 2] * fade);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);

      const c = this.mesh.instanceColor.array;
      c[o] = this.tint[o]; c[o + 1] = this.tint[o + 1]; c[o + 2] = this.tint[o + 2];

      if (this.heat[i] > 0) {
        this.heat[i] = Math.max(0, this.heat[i] - (dt * (this.coolRate[i] || 1)) / COOL_TIME);
      }

      this.life[i] = l;
      if (l <= 0) {
        _m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, _m);
      } else {
        live++;
      }
    }

    this.active = live;
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      this.geometry.attributes.aHeat.needsUpdate = true;
    }
  }

  reset() {
    for (let i = 0; i < this.capacity; i++) {
      this.life[i] = 0;
      this.heat[i] = 0;
      _m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, _m);
    }
    this.geometry.attributes.aHeat.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cursor = 0;
    this.active = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
