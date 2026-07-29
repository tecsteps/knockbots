/**
 * Knockbots — weapon / limb trails.
 *
 * A 12-frame punch is on screen for a fifth of a second. Without a trail the eye
 * gets two blurred poses and no arc, and the move is unreadable; with one, the
 * whole sweep is legible in a single frame. This is the highest-value effect in
 * the game and it is worth building properly.
 *
 * The ribbon is real swept geometry, not a sprite. Every rendered frame each
 * live trail samples two world-space points from the fighter's bone matrices —
 * the proximal joint and a point extended past the distal one — and pushes them
 * into a ring history. The strip is then rebuilt from oldest to newest sample,
 * so the ribbon is the actual surface the limb swept through space, including
 * the twist. Width tapers toward the tail, the cross-section has a soft
 * analytic falloff (no texture, no filtering artefacts at grazing angles), and
 * the colour runs from white-hot at the leading edge to the character's accent
 * colour down the tail.
 *
 * Every slot lives in one shared geometry with a fixed vertex range, so the
 * whole trail layer is a single additive draw call and no buffer is ever
 * reallocated. Retired slots collapse to a degenerate point.
 */

import * as THREE from 'three';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _axis = new THREE.Vector3();

const VERT = /* glsl */ `
attribute vec3 aInfo;   // alongT (0 = newest), across (-1..1), fade
attribute vec3 aTint;

varying float vAlong;
varying float vAcross;
varying float vFade;
varying vec3 vTint;

void main() {
  vAlong = aInfo.x;
  vAcross = aInfo.y;
  vFade = aInfo.z;
  vTint = aTint;
  gl_Position = projectionMatrix * viewMatrix * vec4( position, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uOpacity;

varying float vAlong;
varying float vAcross;
varying float vFade;
varying vec3 vTint;

void main() {
  // Soft analytic cross-section: bright filament in the middle of the ribbon,
  // falling to nothing at the edges without a texture fetch.
  float across = 1.0 - abs( vAcross );
  float body = pow( clamp( across, 0.0, 1.0 ), 0.65 );
  float core = pow( clamp( across, 0.0, 1.0 ), 6.0 );

  float tail = pow( clamp( 1.0 - vAlong, 0.0, 1.0 ), 1.35 );
  vec3 hot = vec3( 1.0, 0.98, 0.95 );
  vec3 col = mix( hot, vTint, smoothstep( 0.0, 0.42, vAlong ) );

  float a = body * tail * vFade * uOpacity;
  if ( a < 0.004 ) discard;
  vec3 emit = col * ( uIntensity * ( 0.55 + core * 2.4 ) );
  gl_FragColor = vec4( emit, a );
}`;

export class TrailSystem {
  /**
   * @param {number} slots concurrent trails
   * @param {number} segments history samples per trail
   */
  constructor(slots = 10, segments = 30) {
    this.slots = slots;
    this.segments = segments;

    const verts = slots * segments * 2;
    this.position = new Float32Array(verts * 3);
    this.info = new Float32Array(verts * 3);
    this.tint = new Float32Array(verts * 3);

    const quads = slots * (segments - 1);
    const index = new Uint16Array(quads * 6);
    for (let s = 0; s < slots; s++) {
      for (let j = 0; j < segments - 1; j++) {
        const base = (s * segments + j) * 2;
        const q = (s * (segments - 1) + j) * 6;
        index[q] = base; index[q + 1] = base + 1; index[q + 2] = base + 2;
        index[q + 3] = base + 1; index[q + 4] = base + 3; index[q + 5] = base + 2;
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aTint', new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);
    this.geometry.computeBoundingSphere = () => {};

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uIntensity: { value: 2.6 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 24;
    this.mesh.name = 'fx.trails';
    this.mesh.matrixAutoUpdate = false;

    /**
     * @type {{active:boolean, bone:THREE.Object3D|null, parent:THREE.Object3D|null,
     *         extend:number, count:number, releasing:number, fade:number,
     *         tint:THREE.Color, history:Float32Array}[]}
     */
    this.trails = [];
    for (let i = 0; i < slots; i++) {
      this.trails.push({
        active: false, bone: null, parent: null, extend: 0.55,
        count: 0, releasing: -1, fade: 1, fadeRate: 0, width: 1,
        tint: new THREE.Color(1, 1, 1),
        history: new Float32Array(segments * 6),
      });
    }
  }

  /**
   * Starts a trail on a bone.
   * @param {THREE.Object3D} bone distal bone (hand, foot)
   * @param {THREE.Object3D} parent proximal joint (elbow, knee) — the ribbon's inner edge
   * @param {Object} [opts]
   * @param {THREE.Color} [opts.tint] character accent colour
   * @param {number} [opts.extend] how far past the bone the outer edge reaches, as a
   *                               multiple of the joint-to-bone length
   * @param {number} [opts.width] extra width multiplier
   * @returns {number} slot handle, or -1 when every slot is busy
   */
  acquire(bone, parent, opts = {}) {
    let free = -1;
    for (let i = 0; i < this.slots; i++) {
      const t = this.trails[i];
      if (!t.active && t.releasing < 0) { free = i; break; }
    }
    if (free < 0) {
      // Steal the oldest fading slot rather than dropping the new attack.
      let best = -1, bestFade = 2;
      for (let i = 0; i < this.slots; i++) {
        const t = this.trails[i];
        if (t.releasing >= 0 && t.fade < bestFade) { bestFade = t.fade; best = i; }
      }
      if (best < 0) return -1;
      free = best;
    }

    const t = this.trails[free];
    t.active = true;
    t.bone = bone;
    t.parent = parent || null;
    t.extend = opts.extend ?? 0.85;
    t.width = opts.width ?? 1;
    t.count = 0;
    t.releasing = -1;
    t.fade = 1;
    if (opts.tint) t.tint.copy(opts.tint);
    else t.tint.setRGB(0.55, 0.72, 1.0);
    return free;
  }

  /** Stops sampling; the ribbon then dissolves over `time` seconds. */
  release(handle, time = 0.16) {
    if (handle < 0 || handle >= this.slots) return;
    const t = this.trails[handle];
    if (!t.active) return;
    t.active = false;
    t.bone = null;
    t.parent = null;
    t.releasing = Math.max(0.02, time);
    t.fadeRate = 1 / t.releasing;
  }

  /** @param {number} dt seconds */
  update(dt) {
    let changed = false;
    for (let i = 0; i < this.slots; i++) {
      const t = this.trails[i];

      if (t.active && t.bone) {
        this.#sample(t);
      } else if (t.releasing >= 0) {
        t.fade -= dt * t.fadeRate;
        if (t.fade <= 0) {
          t.releasing = -1;
          t.fade = 0;
          t.count = 0;
          this.#collapse(i);
          changed = true;
          continue;
        }
      } else {
        continue;
      }

      this.#write(i, t);
      changed = true;
    }

    if (changed) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aInfo.needsUpdate = true;
      this.geometry.attributes.aTint.needsUpdate = true;
    }
  }

  /** Pushes one pair of world-space ribbon edge points into the history. */
  #sample(t) {
    t.bone.updateWorldMatrix(true, false);
    _a.setFromMatrixPosition(t.bone.matrixWorld);

    if (t.parent) {
      t.parent.updateWorldMatrix(true, false);
      _b.setFromMatrixPosition(t.parent.matrixWorld);
      _axis.copy(_a).sub(_b);
    } else {
      // No proximal joint: use the bone's own -Y, which is the limb axis on this rig.
      _axis.set(0, -1, 0).transformDirection(t.bone.matrixWorld).multiplyScalar(0.28);
      _b.copy(_a).sub(_axis);
    }

    const len = _axis.length() || 0.25;
    _axis.multiplyScalar((t.extend * t.width * len + len) / len);
    // Inner edge at the proximal joint, outer edge past the distal bone.
    const outerX = _b.x + _axis.x, outerY = _b.y + _axis.y, outerZ = _b.z + _axis.z;

    const h = t.history;
    const n = this.segments;
    // Shift the ring by writing newest into slot 0 and rotating, which for 30
    // samples is cheaper than the modular indexing it replaces at read time.
    h.copyWithin(6, 0, (n - 1) * 6);
    h[0] = _b.x; h[1] = _b.y; h[2] = _b.z;
    h[3] = outerX; h[4] = outerY; h[5] = outerZ;
    if (t.count < n) t.count++;
  }

  /** Rebuilds one slot's vertex range from its history. */
  #write(slot, t) {
    const n = this.segments;
    const base = slot * n * 2;
    const h = t.history;
    const count = Math.max(t.count, 1);

    for (let j = 0; j < n; j++) {
      const src = Math.min(j, count - 1) * 6;
      const u = j / (n - 1);
      // Taper: the outer edge collapses toward the inner one down the tail.
      const w = Math.pow(1 - u, 0.55);
      const ix = h[src], iy = h[src + 1], iz = h[src + 2];
      const ox = h[src + 3], oy = h[src + 4], oz = h[src + 5];

      const v0 = (base + j * 2) * 3;
      const v1 = v0 + 3;
      const dead = j >= count ? 0 : 1;

      this.position[v0] = ix + (ox - ix) * (1 - w) * 0.5;
      this.position[v0 + 1] = iy + (oy - iy) * (1 - w) * 0.5;
      this.position[v0 + 2] = iz + (oz - iz) * (1 - w) * 0.5;
      this.position[v1] = ox - (ox - ix) * (1 - w) * 0.5;
      this.position[v1 + 1] = oy - (oy - iy) * (1 - w) * 0.5;
      this.position[v1 + 2] = oz - (oz - iz) * (1 - w) * 0.5;

      const fade = t.fade * dead;
      this.info[v0] = u; this.info[v0 + 1] = -1; this.info[v0 + 2] = fade;
      this.info[v1] = u; this.info[v1 + 1] = 1; this.info[v1 + 2] = fade;

      this.tint[v0] = t.tint.r; this.tint[v0 + 1] = t.tint.g; this.tint[v0 + 2] = t.tint.b;
      this.tint[v1] = t.tint.r; this.tint[v1 + 1] = t.tint.g; this.tint[v1 + 2] = t.tint.b;
    }
  }

  /** Collapses a slot to a degenerate point so it costs no fill. */
  #collapse(slot) {
    const n = this.segments;
    const from = slot * n * 2 * 3;
    const to = from + n * 2 * 3;
    this.position.fill(0, from, to);
    this.info.fill(0, from, to);
  }

  /** @param {number} v additive intensity for the quality tier */
  setIntensity(v) { this.material.uniforms.uIntensity.value = v; }

  reset() {
    for (let i = 0; i < this.slots; i++) {
      const t = this.trails[i];
      t.active = false; t.bone = null; t.parent = null;
      t.releasing = -1; t.fade = 0; t.count = 0;
      this.#collapse(i);
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aInfo.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
