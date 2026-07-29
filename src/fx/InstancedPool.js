/**
 * Knockbots — fixed-size instanced particle pool.
 *
 * Every GPU-simulated system in `src/fx` is built on this. The contract:
 *
 *  - Capacity is decided once, at boot. Nothing here ever allocates again, so
 *    the update loop produces zero garbage and the frame time has no sawtooth.
 *  - Allocation is a ring buffer. When the pool wraps it overwrites the oldest
 *    live particle, which is exactly the right failure mode for combat FX: the
 *    hit you just landed matters more than the hit from two seconds ago.
 *  - Particles are never freed. A particle is dead when the shader decides its
 *    age exceeds its life, and a dead instance costs one degenerate triangle.
 *    That means the CPU does no per-particle work at all after the spawn write.
 *  - Writes are coalesced into a single contiguous update range per frame (two
 *    when a burst wraps the ring), so a 300-spark burst is one small
 *    `bufferSubData` rather than 300.
 *
 * Subclasses own the shader and the meaning of the attributes; this class owns
 * the memory.
 */

import * as THREE from 'three';

/** Unit quad in [-0.5,0.5], two triangles. Every billboard system shares it. */
function unitQuad() {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class InstancedPool {
  /**
   * @param {Object} opts
   * @param {number} opts.capacity max simultaneous instances
   * @param {Record<string, number>} opts.attributes instanced attribute name → itemSize
   * @param {THREE.BufferGeometry} [opts.base] base geometry; defaults to a unit quad
   * @param {string} [opts.lifeAttribute] attribute zeroed by `killAll()` to retire everything
   * @param {number} [opts.lifeComponent] component index within that attribute
   */
  constructor({ capacity, attributes, base = null, lifeAttribute = null, lifeComponent = 0 }) {
    this.capacity = capacity;
    this.cursor = 0;
    this.live = 0;
    this.lifeAttribute = lifeAttribute;
    this.lifeComponent = lifeComponent;

    this.geometry = base || unitQuad();
    if (!this.geometry.isInstancedBufferGeometry) {
      throw new Error('InstancedPool base geometry must be an InstancedBufferGeometry');
    }
    this.geometry.instanceCount = 0;
    // Particles move far outside any static bound; culling them by their spawn
    // box would pop whole bursts out of view.
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry.computeBoundingSphere = () => {};

    /** @type {Record<string, Float32Array>} */
    this.arrays = Object.create(null);
    /** @type {Record<string, THREE.InstancedBufferAttribute>} */
    this.attributes = Object.create(null);
    /** @type {Array<{name:string, size:number, array:Float32Array, attr:THREE.InstancedBufferAttribute}>} */
    this.list = [];

    for (const [name, size] of Object.entries(attributes)) {
      const array = new Float32Array(capacity * size);
      const attr = new THREE.InstancedBufferAttribute(array, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, attr);
      this.arrays[name] = array;
      this.attributes[name] = attr;
      this.list.push({ name, size, array, attr });
    }

    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
    this._wrapped = false;
  }

  /**
   * Claims the next instance slot. Always succeeds; the oldest live slot is
   * recycled once the ring wraps.
   * @returns {number} instance index
   */
  alloc() {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.cursor === 0) this._wrapped = true;
    if (this.live < this.capacity) this.live++;
    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    this.geometry.instanceCount = Math.max(this.geometry.instanceCount, this.live);
    return i;
  }

  /**
   * Claims `n` contiguous slots so a burst uploads as one range. Returns the
   * first index; the caller must wrap with `% capacity` when writing.
   * @param {number} n
   * @returns {number} first instance index
   */
  allocRun(n) {
    const count = Math.min(n, this.capacity);
    const first = this.cursor;
    for (let k = 0; k < count; k++) this.alloc();
    return first;
  }

  /** Marks an already-claimed slot dirty (for out-of-order writes). */
  touch(i) {
    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
  }

  /** Uploads the frame's writes. Cheap no-op when nothing spawned. */
  flush() {
    if (this._dirtyHi < this._dirtyLo) return;
    const lo = this._dirtyLo;
    const count = this._dirtyHi - lo + 1;
    for (const a of this.list) {
      a.attr.clearUpdateRanges();
      a.attr.addUpdateRange(lo * a.size, count * a.size);
      a.attr.needsUpdate = true;
    }
    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
  }

  /**
   * Retires every particle immediately. Used by `reset()` between rounds; the
   * whole buffer is uploaded once, which is fine at a round boundary.
   */
  killAll() {
    if (this.lifeAttribute) {
      const a = this.attributes[this.lifeAttribute];
      const arr = this.arrays[this.lifeAttribute];
      for (let i = this.lifeComponent; i < arr.length; i += a.itemSize) arr[i] = 0;
      a.clearUpdateRanges();
      a.needsUpdate = true;
    }
    this.cursor = 0;
    this.live = 0;
    this._wrapped = false;
    this._dirtyLo = Infinity;
    this._dirtyHi = -Infinity;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry.dispose();
  }
}

/**
 * Builds an instanced geometry from an arbitrary base mesh (used by the debris
 * shards, which are real geometry rather than billboards).
 * @param {THREE.BufferGeometry} src
 * @returns {THREE.InstancedBufferGeometry}
 */
export function instancedFrom(src) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = src.index;
  for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.attributes[name]);
  return g;
}

export { unitQuad };
