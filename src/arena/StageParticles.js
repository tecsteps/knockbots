/**
 * Knockbots — the arena's particle systems.
 *
 * The stage owns the *ambient* particles: motes hanging in the light shafts,
 * steam bleeding from a cracked line, dust knocked off a wall, sparks from a
 * severed cable. (Combat impact FX belong to `EffectsDirector`; these are
 * scenery, and they run whether or not anybody is fighting.)
 *
 * Everything here is one `THREE.Points` per system, drawn with a point-sprite
 * shader. Two consequences worth the constraint:
 *
 *   - **Ambient systems cost zero CPU.** Motes and steam are entirely
 *     parameterised by a per-particle seed and evaluated from `uTime` in the
 *     vertex shader, so a thousand motes is one uniform update per frame.
 *   - **Burst systems cost one small typed-array loop.** Dust and sparks need
 *     real physics — gravity, drag, a ground bounce — so they are integrated on
 *     the CPU over a pool of a few hundred, which is far cheaper than the
 *     transform feedback it would take to do it on the GPU, and exact.
 *
 * Point sprites cannot rotate, so where rotation matters (steam) the sprite
 * coordinate is rotated in the fragment shader instead.
 */

import * as THREE from 'three';
import { GROUND_Y, LAYER } from '../core/Constants.js';

const COMMON_FRAG_ROTATE = /* glsl */ `
  vec2 rotatePointCoord( vec2 c, float a ) {
    vec2 p = c - 0.5;
    float s = sin( a ), k = cos( a );
    return vec2( p.x * k - p.y * s, p.x * s + p.y * k ) + 0.5;
  }
`;

/**
 * Three guards every sprite system here shares, because a point sprite has no
 * volume and no depth:
 *
 *   - **Lens fade.** `gl_PointSize` is inverse in view distance, so a four
 *     centimetre mote a metre from the eye covers a quarter of the screen. An
 *     additive system with a few hundred of those *is* a white veil. Sprites
 *     fade out over the last couple of metres and their pixel size is capped.
 *   - **Deck fade.** A sprite that straddles the floor cuts it in a hard line.
 *     The deck is the only surface these systems ever intersect, and it is a
 *     known plane, so the fade is analytic rather than a depth fetch — the
 *     stage particles are drawn in the forward pass, before the frame's
 *     depth-normal buffer exists.
 *   - **Fight-plane carve.** Nothing ambient is allowed to accumulate in the
 *     box the fighters occupy. That box is where all the contrast lives.
 */
const SPRITE_GUARDS = /* glsl */ `
  uniform vec2 uNearFade;
  uniform float uMaxPixels;
  uniform float uFloorY;
  uniform vec3 uClearCenter;
  uniform vec3 uClearHalf;

  float lensFade( float viewDist ) {
    return smoothstep( uNearFade.x, uNearFade.y, viewDist );
  }

  float deckFade( float worldY, float over ) {
    return smoothstep( 0.0, over, worldY - uFloorY );
  }

  /** 0 inside the protected box, 1 once well clear of it. */
  float fightPlaneCarve( vec3 world ) {
    vec3 q = abs( world - uClearCenter ) / max( uClearHalf, vec3( 1e-3 ) );
    return smoothstep( 1.0, 1.85, max( q.x, max( q.y, q.z ) ) );
  }
`;

/**
 * Uniform block matching {@link SPRITE_GUARDS}. A zero `clear.half` disables
 * the carve, which is what impact FX want — they belong in the fight plane.
 * @param {object} [opts]
 * @param {number[]} [opts.nearFade] view distances at which the fade starts and ends
 * @param {number} [opts.maxPixels] hard cap on `gl_PointSize`
 * @param {number} [opts.floorY]
 * @param {{center:number[], half:number[]}} [opts.clear]
 */
function guardUniforms(opts = {}) {
  const near = opts.nearFade ?? [0.7, 2.4];
  const clear = opts.clear ?? { center: [0, 0, 0], half: [0, 0, 0] };
  return {
    uNearFade: { value: new THREE.Vector2(near[0], near[1]) },
    uMaxPixels: { value: opts.maxPixels ?? 30 },
    uFloorY: { value: opts.floorY ?? GROUND_Y },
    uClearCenter: { value: new THREE.Vector3(clear.center[0], clear.center[1], clear.center[2]) },
    uClearHalf: { value: new THREE.Vector3(clear.half[0], clear.half[1], clear.half[2]) },
  };
}

// ---------------------------------------------------------------------------
// Pooled physical burst — dust, debris, sparks
// ---------------------------------------------------------------------------

/**
 * A fixed pool of physically integrated sprites. Dead particles are parked at
 * size zero rather than removed, so the draw call and the buffers never change
 * shape.
 */
export class PointBurst {
  /**
   * @param {THREE.Texture} texture sprite alpha
   * @param {object} [opts]
   * @param {number} [opts.count=256]
   * @param {number|THREE.Color} [opts.color=0xffffff]
   * @param {number} [opts.gravity=-9]
   * @param {number} [opts.drag=1.6] velocity halving rate, per second
   * @param {boolean} [opts.additive=false]
   * @param {number} [opts.floorY] bounce plane; omit for no bounce
   * @param {number} [opts.stretch=0] elongation along velocity, in sprite widths
   * @param {number[]} [opts.nearFade] lens fade window, in metres of view distance
   * @param {number} [opts.maxPixels] cap on `gl_PointSize`
   */
  constructor(texture, opts = {}) {
    const count = opts.count ?? 256;
    this.count = count;
    this.gravity = opts.gravity ?? -9;
    this.drag = opts.drag ?? 1.6;
    this.floorY = opts.floorY;
    this.bounce = opts.bounce ?? 0.32;

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this._next = 0;
    this.active = 0;

    const geo = new THREE.BufferGeometry();
    this._posAttr = new THREE.BufferAttribute(this.pos, 3);
    this._posAttr.setUsage(THREE.DynamicDrawUsage);
    this._dataAttr = new THREE.BufferAttribute(new Float32Array(count * 3), 3); // size, alpha, spin
    this._dataAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._posAttr);
    geo.setAttribute('aData', this._dataAttr);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

    this.material = new THREE.ShaderMaterial({
      name: 'arena.burst',
      uniforms: {
        map: { value: texture },
        uColor: { value: new THREE.Color(opts.color ?? 0xffffff) },
        uPixelScale: { value: 600 },
        // Impact FX belong in the fight plane, so they take no carve — only
        // the lens guard, and a generous one, since a puff of dust thrown at
        // the camera on a wall splat is the effect working.
        ...guardUniforms({ nearFade: opts.nearFade ?? [0.2, 0.9], maxPixels: opts.maxPixels ?? 260, floorY: opts.floorY }),
      },
      vertexShader: /* glsl */ `
        attribute vec3 aData;
        varying float vAlpha;
        varying float vSpin;
        uniform float uPixelScale;
        ${SPRITE_GUARDS}
        void main() {
          vSpin = aData.z;
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          float dist = max( 0.001, -mv.z );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min( uMaxPixels, aData.x * uPixelScale / dist );
          vAlpha = aData.y * lensFade( dist );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uColor;
        varying float vAlpha;
        varying float vSpin;
        ${COMMON_FRAG_ROTATE}
        void main() {
          if ( vAlpha <= 0.001 ) discard;
          vec4 t = texture2D( map, rotatePointCoord( gl_PointCoord, vSpin ) );
          gl_FragColor = vec4( uColor, t.a * vAlpha );
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: true,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'arena.burst';
    this.points.userData.gbuffer = false;
    this.points.layers.set(LAYER.NO_REFLECT);
  }

  /**
   * Fires a cone of particles.
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir unit cone axis
   * @param {number} n
   * @param {object} cfg
   * @param {import('../core/Rng.js').Rng} cfg.rng deterministic source
   * @param {number} cfg.speed
   * @param {number} cfg.spread 0..1, 1 is a hemisphere
   * @param {number} cfg.life seconds
   * @param {number} cfg.size metres
   */
  emit(origin, dir, n, cfg) {
    const rng = cfg.rng;
    const speed = cfg.speed ?? 3;
    const spread = cfg.spread ?? 0.6;
    const life = cfg.life ?? 1.2;
    const size = cfg.size ?? 0.16;

    // Orthonormal basis about the cone axis.
    const ax = Math.abs(dir.y) > 0.9 ? 1 : 0;
    const tx = ax ? 1 : -dir.z, ty = 0, tz = ax ? 0 : dir.x;
    const tl = Math.hypot(tx, ty, tz) || 1;
    const t0x = tx / tl, t0y = ty / tl, t0z = tz / tl;
    const t1x = dir.y * t0z - dir.z * t0y;
    const t1y = dir.z * t0x - dir.x * t0z;
    const t1z = dir.x * t0y - dir.y * t0x;

    for (let p = 0; p < n; p++) {
      const i = this._next;
      this._next = (i + 1) % this.count;
      const a = rng.next() * Math.PI * 2;
      const rad = Math.sqrt(rng.next()) * spread;
      const vx = dir.x + (t0x * Math.cos(a) + t1x * Math.sin(a)) * rad;
      const vy = dir.y + (t0y * Math.cos(a) + t1y * Math.sin(a)) * rad;
      const vz = dir.z + (t0z * Math.cos(a) + t1z * Math.sin(a)) * rad;
      const sp = speed * (0.45 + rng.next() * 0.9);
      const l = life * (0.6 + rng.next() * 0.8);
      const o = i * 3;
      this.pos[o] = origin.x + vx * 0.05;
      this.pos[o + 1] = origin.y + vy * 0.05;
      this.pos[o + 2] = origin.z + vz * 0.05;
      this.vel[o] = vx * sp;
      this.vel[o + 1] = vy * sp;
      this.vel[o + 2] = vz * sp;
      this.life[i] = l;
      this.maxLife[i] = l;
      this.size0[i] = size * (0.5 + rng.next() * 1.1);
      this._dataAttr.array[o + 2] = rng.next() * 6.283;
    }
    this.active = this.count;
  }

  update(dt) {
    if (this.active <= 0) return;
    const d = Math.min(dt, 0.05);
    const damp = Math.exp(-this.drag * d);
    const data = this._dataAttr.array;
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      if (this.life[i] <= 0) { data[o + 1] = 0; continue; }
      this.life[i] -= d;
      if (this.life[i] <= 0) { data[o] = 0; data[o + 1] = 0; continue; }
      alive++;

      this.vel[o] *= damp;
      this.vel[o + 1] = (this.vel[o + 1] + this.gravity * d) * damp;
      this.vel[o + 2] *= damp;
      this.pos[o] += this.vel[o] * d;
      this.pos[o + 1] += this.vel[o + 1] * d;
      this.pos[o + 2] += this.vel[o + 2] * d;

      if (this.floorY !== undefined && this.pos[o + 1] < this.floorY) {
        this.pos[o + 1] = this.floorY;
        this.vel[o + 1] = Math.abs(this.vel[o + 1]) * this.bounce;
        this.vel[o] *= 0.6;
        this.vel[o + 2] *= 0.6;
      }

      const t = this.life[i] / this.maxLife[i];
      // Dust expands as it dissipates; the alpha curve is a fast rise and a
      // long tail, which is what smoke actually does.
      data[o] = this.size0[i] * (1 + (1 - t) * 1.8);
      data[o + 1] = Math.min(1, (1 - t) * 6) * t * t;
      data[o + 2] += this.vel[o] * d * 0.4;
    }
    this.active = alive;
    this._posAttr.needsUpdate = true;
    this._dataAttr.needsUpdate = true;
  }

  reset() {
    this.life.fill(0);
    this._dataAttr.array.fill(0);
    this._dataAttr.needsUpdate = true;
    this.active = 0;
    this._next = 0;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Ambient motes
// ---------------------------------------------------------------------------

/**
 * Dust hanging in the air. Every mote is a fixed anchor plus a closed-form
 * drift, so the whole system is a single uniform write per frame. Motes are
 * additive and brighten sharply when they pass through a light shaft, which is
 * what sells the shaft as a volume rather than a decal.
 *
 * Anchors are rejection-sampled out of the fight plane rather than merely faded
 * there: a mote spent inside the protected box is a mote not hanging in a
 * shaft, and the whole point of the system is to make the shafts read.
 */
export class DustMotes {
  /**
   * @param {THREE.Texture} texture
   * @param {object} box { x, y, z, cx, cy, cz } extents and centre, metres
   * @param {object} [opts]
   * @param {{center:number[], half:number[]}} [opts.clear] fight-plane box to keep empty
   */
  constructor(texture, box, opts = {}) {
    const count = opts.count ?? 900;
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count * 3);
    const clear = opts.clear;
    for (let i = 0; i < count; i++) {
      let x = 0, y = 0, z = 0;
      for (let tries = 0; tries < 12; tries++) {
        x = box.cx + (Math.random() - 0.5) * box.x;
        y = box.cy + Math.pow(Math.random(), 1.4) * box.y;
        z = box.cz + (Math.random() - 0.5) * box.z;
        if (!clear) break;
        const qx = Math.abs(x - clear.center[0]) / clear.half[0];
        const qy = Math.abs(y - clear.center[1]) / clear.half[1];
        const qz = Math.abs(z - clear.center[2]) / clear.half[2];
        if (Math.max(qx, qy, qz) > 1.85) break;
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      seed[i * 3] = Math.random() * 100;
      seed[i * 3 + 1] = 0.4 + Math.random() * 1.6;         // size scale
      seed[i * 3 + 2] = 0.25 + Math.random() * 0.85;        // brightness
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(box.cx, box.cy, box.cz), Math.max(box.x, box.y, box.z));

    this.material = new THREE.ShaderMaterial({
      name: 'arena.motes',
      uniforms: {
        map: { value: texture },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(opts.color ?? 0xcfe0ff) },
        uIntensity: { value: opts.intensity ?? 0.5 },
        uSize: { value: opts.size ?? 0.028 },
        uPixelScale: { value: 600 },
        uDrift: { value: opts.drift ?? 0.16 },
        ...guardUniforms({
          nearFade: opts.nearFade ?? [1.1, 3.4],
          maxPixels: opts.maxPixels ?? 9,
          floorY: opts.floorY,
          clear: opts.clear,
        }),
      },
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime;
        uniform float uSize;
        uniform float uPixelScale;
        uniform float uDrift;
        varying float vBright;
        ${SPRITE_GUARDS}
        void main() {
          float ph = aSeed.x;
          vec3 p = position;
          // Three detuned sines per axis: no repeat the eye can lock onto,
          // still closed-form.
          p.x += sin( uTime * 0.21 + ph ) * uDrift + sin( uTime * 0.07 + ph * 2.3 ) * uDrift * 1.7;
          p.y += sin( uTime * 0.13 + ph * 1.7 ) * uDrift * 0.7 + cos( uTime * 0.041 + ph ) * uDrift * 1.2;
          p.z += cos( uTime * 0.17 + ph * 0.9 ) * uDrift * 1.3 + sin( uTime * 0.055 + ph * 3.1 ) * uDrift;
          vec3 w = ( modelMatrix * vec4( p, 1.0 ) ).xyz;
          vec4 mv = modelViewMatrix * vec4( p, 1.0 );
          float dist = max( 0.001, -mv.z );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min( uMaxPixels, uSize * aSeed.y * uPixelScale / dist );
          // Twinkle: motes catch the light as they tumble.
          float twinkle = 0.45 + 0.55 * pow( abs( sin( uTime * 0.9 + ph * 4.1 ) ), 2.0 );
          vBright = aSeed.z * twinkle * lensFade( dist ) * deckFade( w.y, 0.7 ) * fightPlaneCarve( w );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uColor;
        uniform float uIntensity;
        varying float vBright;
        void main() {
          if ( vBright <= 0.004 ) discard;
          float a = texture2D( map, gl_PointCoord ).a;
          gl_FragColor = vec4( uColor * vBright * uIntensity, a );
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._baseIntensity = opts.intensity ?? 0.5;

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'arena.motes';
    this.points.frustumCulled = false;
    this.points.userData.gbuffer = false;
    this.points.layers.set(LAYER.NO_REFLECT);
  }

  update(time, intensity = 1) {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uIntensity.value = this._baseIntensity * intensity;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

/**
 * Continuous steam plumes. Each particle owns a phase; its lifetime is
 * `fract(t / period + phase)`, so the loop is seamless and the whole plume is
 * one uniform write. Sprites are counter-rotated per particle so the billboards
 * do not visibly share an orientation.
 */
export class SteamJets {
  /**
   * @param {THREE.Texture} texture
   * @param {{origin:number[], dir:number[], rate:number, speed:number, life:number, size:number}[]} jets
   */
  constructor(texture, jets, opts = {}) {
    const perJet = opts.perJet ?? 26;
    const count = jets.length * perJet;
    const pos = new Float32Array(count * 3);
    const dir = new Float32Array(count * 3);
    const seed = new Float32Array(count * 4);
    let k = 0;
    for (let j = 0; j < jets.length; j++) {
      const je = jets[j];
      for (let p = 0; p < perJet; p++, k++) {
        pos[k * 3] = je.origin[0];
        pos[k * 3 + 1] = je.origin[1];
        pos[k * 3 + 2] = je.origin[2];
        dir[k * 3] = je.dir[0];
        dir[k * 3 + 1] = je.dir[1];
        dir[k * 3 + 2] = je.dir[2];
        seed[k * 4] = (p + Math.random() * 0.6) / perJet;    // loop phase
        seed[k * 4 + 1] = je.life;
        seed[k * 4 + 2] = je.speed * (0.7 + Math.random() * 0.6);
        seed[k * 4 + 3] = je.size * (0.7 + Math.random() * 0.7);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 0), 40);

    this.material = new THREE.ShaderMaterial({
      name: 'arena.steam',
      uniforms: {
        map: { value: texture },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(opts.color ?? 0x9fb3c8) },
        uOpacity: { value: opts.opacity ?? 0.19 },
        uPixelScale: { value: 600 },
        ...guardUniforms({
          nearFade: opts.nearFade ?? [2.5, 7.0],
          maxPixels: opts.maxPixels ?? 130,
          floorY: opts.floorY,
          clear: opts.clear,
        }),
      },
      vertexShader: /* glsl */ `
        attribute vec3 aDir;
        attribute vec4 aSeed;
        uniform float uTime;
        uniform float uPixelScale;
        varying float vAlpha;
        varying float vSpin;
        ${SPRITE_GUARDS}
        void main() {
          float life = aSeed.y;
          float t = fract( uTime / life + aSeed.x );
          float age = t * life;
          vec3 p = position + aDir * ( aSeed.z * age );
          // Buoyancy and a lazy curl once the jet's momentum is spent.
          p.y += age * age * 0.42;
          p.x += sin( aSeed.x * 31.0 + age * 1.3 ) * age * 0.22;
          p.z += cos( aSeed.x * 17.0 + age * 1.1 ) * age * 0.22;
          vec3 w = ( modelMatrix * vec4( p, 1.0 ) ).xyz;
          vec4 mv = modelViewMatrix * vec4( p, 1.0 );
          float dist = max( 0.001, -mv.z );
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min( uMaxPixels, aSeed.w * ( 0.35 + t * 2.6 ) * uPixelScale / dist );
          float fade = smoothstep( 0.0, 0.14, t ) * ( 1.0 - smoothstep( 0.35, 1.0, t ) );
          vAlpha = fade * lensFade( dist ) * deckFade( w.y, 1.1 ) * fightPlaneCarve( w );
          vSpin = aSeed.x * 39.0 + t * 1.4;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vAlpha;
        varying float vSpin;
        ${COMMON_FRAG_ROTATE}
        void main() {
          if ( vAlpha <= 0.003 ) discard;
          float a = texture2D( map, rotatePointCoord( gl_PointCoord, vSpin ) ).a;
          gl_FragColor = vec4( uColor, a * vAlpha * uOpacity );
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'arena.steam';
    this.points.frustumCulled = false;
    this.points.userData.gbuffer = false;
    this.points.layers.set(LAYER.NO_REFLECT);
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
