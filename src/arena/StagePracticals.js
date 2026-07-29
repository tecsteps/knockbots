/**
 * Knockbots — the emitters: light fixtures, neon, beacons, screens and the
 * arcing cable.
 *
 * Every visible emitter here is tied to something the Environment is actually
 * lighting with. `Environment` carries four `practical` entries per mood — a
 * RectAreaLight plus a matching quad in the HDR cube — and deliberately hides
 * its own placeholder cards, because "the Stage owns everything the camera can
 * see". So this file builds real housings around those four lights and drives
 * their emissive colour from the same numbers that drive the lights, which is
 * why a specular highlight on a shoulder plate always has a visible source
 * behind it.
 *
 * The four emitter faces share one mesh and one draw call: each carries a
 * fixture index in a vertex attribute and the shader looks its colour up in a
 * four-element uniform array. That keeps four independently coloured, flickering
 * emitters at the cost of one.
 *
 * The screens are worth their shader. A dead-flat emissive rectangle reads as a
 * texture; a diagnostic display with a rolling frame bar, a bar-graph that
 * responds to nothing in particular, a sweeping trace and occasional
 * tearing reads as a room with power in it.
 */

import * as THREE from 'three';
import { LAYER } from '../core/Constants.js';
import { Rng } from '../core/Rng.js';
import { bevelBox, place, mergeAll, boltRing, insetPanel } from './GeoKit.js';
import { fbm, stampText, blur, clamp01, smoothstep, makeTexture, encodeSrgb } from './ProcTex.js';
import { PointBurst } from './StageParticles.js';

const FIXTURES = 4;

/** Caption bands in the screen text plate; one per board, power of two. */
const BOARD_ROWS = 8;

/** Colour slots the light pools sample: the four fixtures plus the neon strip. */
const POOL_SLOTS = 5;

/**
 * The pools' floor-scattering cards. Each is a gradient quad tied to a colour
 * slot: `edge` is the fraction of each axis that stays at full brightness before
 * the falloff starts, so a round pool is [0, 0] and a long strip wash is
 * [0.74, 0] — flat along its length, falling off across it.
 */
const POOLS = [
  { pos: [-6.6, 0.02, -6.0], rot: [-Math.PI / 2, 0, 0], w: 13, h: 10, slot: 0, edge: [0, 0], gain: 0.8 },
  { pos: [6.6, 0.02, -6.0], rot: [-Math.PI / 2, 0, 0], w: 13, h: 10, slot: 1, edge: [0, 0], gain: 0.8 },
  { pos: [-9.0, 0.02, -5.6], rot: [-Math.PI / 2, 0, 0], w: 9.0, h: 8.0, slot: 2, edge: [0, 0], gain: 1.7 },
  { pos: [9.6, 0.02, 6.6], rot: [-Math.PI / 2, 0, 0], w: 6.5, h: 5.5, slot: 3, edge: [0, 0], gain: 0.9 },
  { pos: [0, 1.28, -8.54], rot: [0, 0, 0], w: 26, h: 2.6, slot: 4, edge: [0.74, 0], gain: 1.2 },
  { pos: [0, 0.02, -7.85], rot: [-Math.PI / 2, 0, 0], w: 26, h: 2.4, slot: 4, edge: [0.74, 0], gain: 0.85 },
];

/**
 * Linear radiance per unit of `sqrt(power)` for a pool card. Held low on
 * purpose: the pool says where the light landed, and once it is bright enough to
 * compete with the fighters standing in it the floor stops being the floor.
 */
const POOL_GAIN = 0.115;

/**
 * Scene-referred luminance where `RenderPipeline`'s bright pass starts to bloom.
 * Every emitter in this file is authored against it: a lamp face that sits under
 * it is a pale grey rectangle with a light bolted on somewhere else, and the eye
 * refuses to accept it as the source. Above it the bloom does the work — the
 * fixture spreads, the glass around it lifts, and the thing reads as hot.
 */
const BLOOM_THRESHOLD = 1.15;

const _tmp = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _amber = new THREE.Color(0xffa02a);
const _down = new THREE.Vector3(0.15, -1, 0.1).normalize();

/**
 * The boards, in the order they are built. Each carries its own caption, its
 * own program and its own size, because a wall of displays all running the
 * same loop is one display copied — the thing the eye picks up on first is
 * that two screens are in step.
 *
 * `prog`: 0 spectrum, 1 armed-status block, 2 oscilloscope, 3 ticker board.
 */
const BOARDS = [
  // The two bank boards are letterboxed and sit in the 3.6-5.2m band, which is
  // all the fight camera can see above the fence: any taller and the caption
  // rides out of frame, any lower and the crowd swallows the whole panel.
  { pos: [-6.2, 4.42, -13.7], rot: [0.14, 0, 0], w: 4.3, h: 1.5, prog: 0, cap: 'sublevel 09 diagnostic' },
  { pos: [5.9, 4.38, -13.7], rot: [0.14, 0, 0], w: 3.4, h: 1.35, prog: 1, cap: 'cell 09 armed' },
  { pos: [0.6, 6.2, -13.85], rot: [0.22, 0, 0], w: 6.0, h: 2.4, prog: 3, cap: 'mech test - round 01' },
  { pos: [-12.35, 3.6, 4.0], rot: [0, Math.PI / 2, 0], w: 2.0, h: 1.2, prog: 2, cap: 'hydraulic nominal' },
  { pos: [12.35, 4.1, -3.2], rot: [0, -Math.PI / 2, 0], w: 2.4, h: 1.4, prog: 0, cap: 'rig telemetry' },
  { pos: [-11.7, 3.75, -13.72], rot: [0.1, 0, 0], w: 1.6, h: 1.0, prog: 2, cap: 'pit feed 04' },
  { pos: [11.4, 3.9, -13.72], rot: [0.1, 0, 0], w: 1.8, h: 1.05, prog: 1, cap: 'coolant loop b' },
  { pos: [12.35, 6.0, 8.4], rot: [0, -Math.PI / 2, 0], w: 1.8, h: 1.1, prog: 3, cap: 'gantry hold' },
];

/**
 * Caption plate: one row per board, stacked bottom-up in a single texture.
 *
 * The cell size is solved per row so the string fills the plate rather than
 * running off the end of it. The previous fixed cell clipped every caption
 * longer than ten characters mid-word, and a caption cut mid-word under
 * anisotropic filtering is indistinguishable from a texture that is simply
 * broken.
 */
function screenCaptions(rows, size = 512) {
  const band = size / BOARD_ROWS;
  const mask = new Float32Array(size * size);
  for (let r = 0; r < rows.length; r++) {
    const cell = Math.max(2, Math.min(Math.floor(band * 0.42), Math.floor((size * 0.9) / (rows[r].length * 6))));
    const w = rows[r].length * 6 * cell - cell;
    stampText(mask, size, rows[r], Math.round((size - w) / 2), Math.round(r * band + (band - 7 * cell) / 2), cell, cell * 0.5);
  }
  const soft = blur(mask, size, 1, 1);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const v = Math.round(clamp01(soft[k]) * 255);
    const o = k * 4;
    data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
  }
  return makeTexture(data, size, { clamp: true, anisotropy: 4 });
}

/**
 * The four fixtures share one draw call, so they share one texture: a 2x2
 * atlas of transmission masks, selected in the shader by fixture index.
 *
 *   bottom-left  frosted diffuser — the overhead light banks
 *   bottom-right louvred panel    — the lit doorway
 *   top-left     backlit sign     — the sign box on the near barrier
 *
 * They are masks, not colours: the fixture's own emissive tint multiplies
 * through them, so a mood cross-fade recolours the sign along with its light.
 * Mipmaps are off; at these sizes the saving is nil and the quadrant bleed is
 * not.
 */
function fixtureAtlas(size = 512) {
  const half = size >> 1;
  const n = fbm(half, 26, { octaves: 3, seed: 401 });
  const fine = fbm(half, 90, { octaves: 2, seed: 409 });
  const grit = fbm(half, 14, { octaves: 4, seed: 419 });

  // The sign's lettering, rasterised into the top-left quadrant's own space.
  const text = new Float32Array(half * half);
  const cellA = Math.max(3, Math.round(half / 26));
  const cellB = Math.max(2, Math.round(half / 40));
  const wA = 'cell 09'.length * 6 * cellA - cellA;
  const wB = 'mech test'.length * 6 * cellB - cellB;
  stampText(text, half, 'cell 09', Math.round((half - wA) / 2), Math.round(half * 0.42), cellA, cellA * 0.45);
  stampText(text, half, 'mech test', Math.round((half - wB) / 2), Math.round(half * 0.2), cellB, cellB * 0.5);
  const ink = blur(text, half, 1, 1);

  const data = new Uint8Array(size * size * 4);
  const write = (i, j, v) => {
    const o = (j * size + i) * 4;
    const b = encodeSrgb(clamp01(v));
    data[o] = b; data[o + 1] = b; data[o + 2] = b; data[o + 3] = 255;
  };

  for (let j = 0; j < half; j++) {
    for (let i = 0; i < half; i++) {
      const k = j * half + i;
      const u = i / half;
      const v = j / half;

      // Diffuser: three tubes behind frosted acrylic, dirtier at the ends.
      const tube = 0.7 + 0.3 * Math.abs(Math.sin(u * Math.PI * 3));
      const grime = 1 - Math.pow(Math.abs(u * 2 - 1), 4) * 0.5;
      write(i, j, tube * grime * (0.8 + n[k] * 0.3 + fine[k] * 0.15));

      // Louvre: horizontal slats and two mullions, unevenly lit.
      const slat = 0.34 + 0.66 * smoothstep(0.1, 0.34, Math.abs(((v * 11) % 1) - 0.5));
      const mullion = Math.min(
        smoothstep(0.0, 0.03, Math.abs(u - 0.34)),
        smoothstep(0.0, 0.03, Math.abs(u - 0.67)),
      );
      write(half + i, j, slat * (0.25 + mullion * 0.75) * (0.72 + grit[k] * 0.5));

      // Sign: bright field, dark lettering, dark frame, a little scuffing.
      const frame = Math.min(
        smoothstep(0.0, 0.035, Math.min(u, 1 - u)),
        smoothstep(0.0, 0.05, Math.min(v, 1 - v)),
      );
      const face = frame * (0.82 + grit[k] * 0.34) * (1 - ink[k] * 0.94);
      write(i, half + j, face);

      // Unused quadrant: flat, so a stray sample can never be a black hole.
      write(half + i, half + j, 0.9);
    }
  }

  const tex = makeTexture(data, size, { srgb: true, clamp: true, anisotropy: 4 });
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class StagePracticals {
  /**
   * @param {object} deps
   * @param {import('../engine/Environment.js').Environment} deps.environment
   * @param {Record<string, THREE.Material>} deps.materials
   * @param {Record<string, THREE.Texture>} deps.textures
   * @param {THREE.Vector3} deps.sparkPoint frayed cable end
   */
  constructor({ environment, materials, textures, bins, sparkPoint }) {
    this.group = new THREE.Group();
    this.group.name = 'arena.practicals';
    this.environment = environment;
    this.materials = materials;
    this.rng = new Rng(0x50524143);

    /**
     * Published for the Environment (and anyone else) to match lights against.
     * @type {{position: THREE.Vector3, color: THREE.Color, power: number, size: THREE.Vector2}[]}
     */
    this.practicalPositions = [];

    this.atlas = fixtureAtlas(512);
    this.captions = screenCaptions(BOARDS.map((b) => b.cap), 512);

    this.#fixtures(bins);
    this.#pools();
    this.#neon();
    this.#beacons();
    this.#screens(bins);
    this.#sparks(textures, sparkPoint);
    this.syncToEnvironment();
  }

  // -------------------------------------------------------------------------

  /**
   * Four fixtures: two long overhead light banks on the cross-gantry, a lit
   * doorway in the back-left corner, and a warm sign box on the near-right
   * barrier. Their layout matches the Environment's default mood so the
   * geometry and the lights agree at frame one.
   */
  #fixtures(bins) {
    const housings = bins.dark;
    const faces = [];
    const idx = [];

    /** Adds an emitter quad tagged with its fixture index. */
    const emitter = (w, h, transform, fixture) => {
      const g = place(new THREE.PlaneGeometry(w, h), transform);
      const count = g.attributes.position.count;
      const a = new Float32Array(count);
      a.fill(fixture);
      idx.push(a);
      faces.push(g);
    };

    const spec = this.environment?.params?.practicals;

    // --- 0, 1: overhead light banks ----------------------------------------
    for (let f = 0; f < 2; f++) {
      const x = f === 0 ? -6.6 : 6.6;
      const y = 5.4, z = -6.2;
      const w = 6.4, h = 0.5;
      // Housing: a channel with end caps and a reflector lip, open downward.
      housings.push(place(bevelBox(w + 0.2, 0.3, h + 0.28, 0.02), { pos: [x, y + 0.2, z] }));
      housings.push(place(bevelBox(w + 0.24, 0.16, 0.09, 0.015), { pos: [x, y + 0.02, z - h / 2 - 0.11], rot: [0.5, 0, 0] }));
      housings.push(place(bevelBox(w + 0.24, 0.16, 0.09, 0.015), { pos: [x, y + 0.02, z + h / 2 + 0.11], rot: [-0.5, 0, 0] }));
      for (const dx of [-w / 2 - 0.08, w / 2 + 0.08]) {
        housings.push(place(bevelBox(0.06, 0.32, h + 0.3, 0.012), { pos: [x + dx, y + 0.18, z] }));
      }
      for (const dz of [-0.5, 0.5]) {
        housings.push(place(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6), { pos: [x + w * 0.28, y + 0.6, z + dz] }));
        housings.push(place(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6), { pos: [x - w * 0.28, y + 0.6, z + dz] }));
      }
      // The emitting face looks straight down into the pit.
      emitter(w, h, { pos: [x, y, z], rot: [Math.PI / 2, 0, 0] }, f);
      this.practicalPositions.push({
        position: new THREE.Vector3(x, y, z),
        color: new THREE.Color(spec?.[f]?.color ?? 0xdff0ff),
        power: spec?.[f]?.power ?? 15,
        size: new THREE.Vector2(w, h),
      });
    }

    // --- 2: lit doorway in the back-left corner -----------------------------
    {
      const x = -10.2, y = 2.3, z = -8.6;
      const w = 3.4, h = 2.6;
      housings.push(place(insetPanel(w + 0.7, h + 0.7, 0.35, 0.34), { pos: [x, y, z - 0.2] }));
      housings.push(place(bevelBox(w + 1.1, 0.26, 0.5, 0.02), { pos: [x, y + h / 2 + 0.5, z - 0.2] }));
      housings.push(place(boltRing(w * 0.5, 14, 0.03, 0.02), { pos: [x, y, z - 0.02] }));
      emitter(w, h, { pos: [x, y, z], rot: [0, 0, 0] }, 2);
      this.practicalPositions.push({
        position: new THREE.Vector3(x, y, z),
        color: new THREE.Color(spec?.[2]?.color ?? 0x9fdcff),
        power: spec?.[2]?.power ?? 26,
        size: new THREE.Vector2(w, h),
      });
    }

    // --- 3: sign box on the near-right barrier ------------------------------
    {
      const x = 8.6, y = 3.1, z = 7.8;
      const w = 3.4, h = 2.2;
      housings.push(place(bevelBox(0.34, h + 0.5, w + 0.5, 0.03), { pos: [x + 0.2, y, z] }));
      housings.push(place(bevelBox(0.5, 0.14, w + 0.8, 0.02), { pos: [x + 0.24, y + h / 2 + 0.32, z] }));
      housings.push(place(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), { pos: [x + 0.42, y + h / 2 + 0.6, z - w * 0.3], rot: [0, 0, 0.5] }));
      housings.push(place(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), { pos: [x + 0.42, y + h / 2 + 0.6, z + w * 0.3], rot: [0, 0, 0.5] }));
      emitter(w, h, { pos: [x, y, z], rot: [0, -Math.PI / 2, 0] }, 3);
      this.practicalPositions.push({
        position: new THREE.Vector3(x, y, z),
        color: new THREE.Color(spec?.[3]?.color ?? 0xff9a52),
        power: spec?.[3]?.power ?? 4.5,
        size: new THREE.Vector2(w, h),
      });
    }

    // One mesh for all four emitting faces; the fixture index rides along in a
    // vertex attribute and selects a colour from a four-element uniform array.
    const faceGeo = mergeAll(faces);
    const flat = new Float32Array(faceGeo.attributes.position.count);
    let off = 0;
    for (const a of idx) { flat.set(a, off); off += a.length; }
    faceGeo.setAttribute('aFixture', new THREE.Float32BufferAttribute(flat, 1));

    this.emitterMaterial = new THREE.ShaderMaterial({
      name: 'arena.practicals.emitters',
      uniforms: {
        map: { value: this.atlas },
        uColor: { value: [new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1)] },
      },
      defines: { FIXTURES },
      vertexShader: /* glsl */ `
        attribute float aFixture;
        varying vec2 vUv;
        varying float vFixture;
        void main() {
          vUv = uv;
          vFixture = aFixture;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uColor[ FIXTURES ];
        varying vec2 vUv;
        varying float vFixture;
        void main() {
          vec3 c = uColor[ 0 ];
          for ( int i = 1; i < FIXTURES; i++ ) {
            if ( abs( vFixture - float( i ) ) < 0.5 ) c = uColor[ i ];
          }
          // Fixtures 0 and 1 take the diffuser, 2 the louvre, 3 the sign.
          vec2 quad = vFixture < 1.5 ? vec2( 0.0, 0.0 )
                    : vFixture < 2.5 ? vec2( 0.5, 0.0 )
                    : vec2( 0.0, 0.5 );
          vec2 auv = clamp( vUv, 0.004, 0.996 ) * 0.5 + quad;
          gl_FragColor = vec4( c * texture2D( map, auv ).rgb, 1.0 );
        }
      `,
      // Single-sided: a fitting seen from behind is a box, not a lamp.
      side: THREE.FrontSide,
      toneMapped: true,
      fog: false,
    });
    this.emitters = new THREE.Mesh(faceGeo, this.emitterMaterial);
    this.emitters.name = 'arena.practicals.emitters';
    this.group.add(this.emitters);
  }

  /**
   * Where the light lands. A fixture that emits but deposits nothing reads as a
   * sticker on the wall: the eye locates a source by the pool it throws, not by
   * the lamp. Before this the arena's floor luminance sat inside one narrow band
   * from frame-left to frame-right and there was no telling where the light was
   * coming from.
   *
   * These are not a substitute for the Environment's RectAreaLights, which still
   * do the real shading. They are the term those lights cannot pay for: the
   * shallow grazing scatter off a rough wet floor and the wash a strip light
   * leaves on the metre of barrier around it. Tint and brightness come from the
   * same practical parameters as the lights, so a mood cross-fade drags the
   * pools along with the lamps.
   *
   * Six cards, one draw call — the colour slot rides in a vertex attribute, the
   * same trick the fixture faces use.
   */
  #pools() {
    const quads = [];
    const slot = [];
    const edge = [];
    const gain = [];

    for (const p of POOLS) {
      const g = place(new THREE.PlaneGeometry(p.w, p.h), { pos: p.pos, rot: p.rot });
      const n = g.attributes.position.count;
      const s = new Float32Array(n);
      const e = new Float32Array(n * 2);
      const a = new Float32Array(n);
      s.fill(p.slot);
      a.fill(p.gain);
      for (let i = 0; i < n; i++) { e[i * 2] = p.edge[0]; e[i * 2 + 1] = p.edge[1]; }
      quads.push(g);
      slot.push(s);
      edge.push(e);
      gain.push(a);
    }

    const geo = mergeAll(quads);
    const n = geo.attributes.position.count;
    const fSlot = new Float32Array(n);
    const fEdge = new Float32Array(n * 2);
    const fGain = new Float32Array(n);
    let o = 0;
    for (let i = 0; i < slot.length; i++) {
      fSlot.set(slot[i], o);
      fEdge.set(edge[i], o * 2);
      fGain.set(gain[i], o);
      o += slot[i].length;
    }
    geo.setAttribute('aSlot', new THREE.Float32BufferAttribute(fSlot, 1));
    geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(fEdge, 2));
    geo.setAttribute('aGain', new THREE.Float32BufferAttribute(fGain, 1));

    this.poolMaterial = new THREE.ShaderMaterial({
      name: 'arena.practicals.pools',
      uniforms: {
        uPool: {
          value: Array.from({ length: POOL_SLOTS }, () => new THREE.Color(0, 0, 0)),
        },
      },
      defines: { POOL_SLOTS },
      vertexShader: /* glsl */ `
        attribute float aSlot;
        attribute vec2 aEdge;
        attribute float aGain;
        varying vec2 vUv;
        varying vec2 vEdge;
        varying float vGain;
        varying float vSlot;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vEdge = aEdge;
          vGain = aGain;
          vSlot = aSlot;
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uPool[ POOL_SLOTS ];
        varying vec2 vUv;
        varying vec2 vEdge;
        varying float vGain;
        varying float vSlot;
        varying vec3 vWorld;
        void main() {
          vec3 c = uPool[ 0 ];
          for ( int i = 1; i < POOL_SLOTS; i++ ) {
            if ( abs( vSlot - float( i ) ) < 0.5 ) c = uPool[ i ];
          }

          // Separable falloff: full brightness inside the plateau, quadratic
          // skirt outside it, squared once more so the pool has a core rather
          // than a uniform lift.
          vec2 q = abs( vUv - 0.5 ) * 2.0;
          vec2 e = clamp( ( q - vEdge ) / max( vec2( 1.0 ) - vEdge, vec2( 1e-3 ) ), 0.0, 1.0 );
          float f = ( 1.0 - e.x * e.x ) * ( 1.0 - e.y * e.y );
          f *= f;

          // Large-scale unevenness so a pool reads as light on a dirty floor
          // rather than as a decal someone airbrushed on.
          f *= 0.85 + 0.15 * sin( vWorld.x * 0.83 + vWorld.z * 0.61 ) * sin( vWorld.z * 1.27 - 1.1 );

          gl_FragColor = vec4( c * ( f * vGain ), 1.0 );
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: true,
      fog: false,
      side: THREE.DoubleSide,
    });

    this.pools = new THREE.Mesh(geo, this.poolMaterial);
    this.pools.name = 'arena.practicals.pools';
    // Scatter, not scenery: it must never be picked up by the floor mirror or
    // the reflection would double the deposit.
    this.pools.layers.set(LAYER.NO_REFLECT);
    this.pools.castShadow = false;
    this.pools.receiveShadow = false;
    this.group.add(this.pools);
  }

  /** Neon strips along the catwalk edges and the machinery bank. */
  #neon() {
    const runs = [];
    for (const side of [-1, 1]) {
      runs.push(place(bevelBox(0.06, 0.05, 24, 0.01), { pos: [side * 13.15, 5.02, 2] }));
    }
    runs.push(place(bevelBox(24, 0.05, 0.06, 0.01), { pos: [0, 1.28, -8.62] }));
    for (let i = 0; i < 5; i++) {
      runs.push(place(bevelBox(0.05, 1.5, 0.05, 0.01), { pos: [-12.4 + i * 6.2, 3.4, -12.0] }));
    }
    this.neonMaterial = new THREE.MeshBasicMaterial({ name: 'arena.neon', color: new THREE.Color(0x2ad4ff), toneMapped: true, fog: true });
    this.neon = new THREE.Mesh(mergeAll(runs), this.neonMaterial);
    this.neon.name = 'arena.practicals.neon';
    this.group.add(this.neon);
  }

  /** Rotating hazard beacons on the machinery bank and the roof structure. */
  #beacons() {
    const parts = [];
    parts.push(place(new THREE.CylinderGeometry(0.12, 0.14, 0.06, 12), { pos: [0, -0.03, 0] }));
    parts.push(place(new THREE.SphereGeometry(0.12, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), { pos: [0, 0, 0] }));
    const geo = mergeAll(parts);
    const spots = [
      [-13.2, 5.1, -12.4], [13.2, 5.1, -12.4], [-6.2, 8.6, -13.6], [9.6, 10.4, -11.2],
      [0, 11.2, -10.4], [-14.2, 12.2, 2.4],
    ];
    this.beaconMaterial = new THREE.MeshBasicMaterial({ name: 'arena.beacon', color: 0xff5a12, toneMapped: true });
    this.beacons = new THREE.InstancedMesh(geo, this.beaconMaterial, spots.length);
    this.beacons.name = 'arena.practicals.beacons';
    this.beacons.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(spots.length * 3), 3);
    this.beacons.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    this._beaconPhase = [];
    spots.forEach((p, i) => {
      m.compose(new THREE.Vector3(p[0], p[1], p[2]), q, one);
      this.beacons.setMatrixAt(i, m);
      this._beaconPhase.push(this.rng.range(0, Math.PI * 2));
    });
    this.beacons.instanceMatrix.needsUpdate = true;
    this.group.add(this.beacons);
  }

  /**
   * The boards: diagnostic displays on the machinery bank, the house board over
   * the pit, and repeaters on the side walls.
   *
   * All eight share one shader and one draw call, and each one carries its
   * board index in a vertex attribute. That attribute is the whole point. The
   * index used to be derived from the fragment's world position, which meant it
   * changed *across* a panel — every thirty centimetres the display jumped to a
   * different caption, a different bar seed and a different trace phase, and
   * what came out looked like a screen showing reversed, sliced-up text. An
   * index is a property of the board, so it belongs to the board's vertices.
   */
  #screens(bins) {
    const panels = [];
    const bezels = bins.dark;
    const counts = [];
    for (const p of BOARDS) {
      // Expanded here rather than left to the merge, so the vertex counts the
      // board attribute is filled from are the ones that end up in the buffer.
      const geo = place(new THREE.PlaneGeometry(p.w, p.h), { pos: p.pos, rot: p.rot }).toNonIndexed();
      counts.push(geo.attributes.position.count);
      panels.push(geo);
      // Housing sits a few centimetres behind the face, along the face normal.
      const n = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...p.rot)).multiplyScalar(0.03);
      bezels.push(place(insetPanel(p.w + 0.2, p.h + 0.2, 0.09, 0.1), {
        pos: [p.pos[0] - n.x, p.pos[1] - n.y, p.pos[2] - n.z],
        rot: p.rot,
      }));
    }

    // Fog has to be merged in by hand: a ShaderMaterial with `fog: true` gets
    // the chunks but not the uniforms they read.
    this.screenMaterial = new THREE.ShaderMaterial({
      name: 'arena.screens',
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uCaptions: { value: null },
          uColor: { value: new THREE.Color(0x63d0ff) },
          uWarn: { value: new THREE.Color(0xffa02a) },
          // The trace and its head end up near four times BLOOM_THRESHOLD, the
          // bar graph just over it, the dark field far under. A screen is only
          // convincing when its own contrast survives the bright pass.
          uGain: { value: 2.7 },
          uRows: { value: BOARD_ROWS },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aBoard;
        attribute float aProgram;
        varying vec2 vUv;
        varying float vBoard;
        varying float vProgram;
        void main() {
          vUv = uv;
          vBoard = aBoard;
          vProgram = aProgram;
          vec4 mvPosition = viewMatrix * modelMatrix * vec4( position, 1.0 );
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform sampler2D uCaptions;
        uniform vec3 uColor;
        uniform vec3 uWarn;
        uniform float uGain;
        uniform float uRows;
        varying vec2 vUv;
        varying float vBoard;
        varying float vProgram;

        float hash11( float n ) { return fract( sin( n ) * 43758.5453 ); }

        // Spectrum: a bank of bars over a sweeping trace. The generalist.
        vec3 spectrum( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          float bars = floor( uv.x * 22.0 );
          float h = 0.08 + 0.34 * abs( sin( bars * 1.7 + uTime * ( 1.3 + fract( seed * 0.31 ) ) + seed ) )
                        * ( 0.5 + 0.5 * hash11( bars + seed ) );
          float inBar = step( uv.y, h ) * step( 0.06, uv.y ) * step( 0.12, fract( uv.x * 22.0 ) );
          col += mix( uColor, uWarn, step( 0.3, h ) ) * inBar * 0.9;

          float trace = 0.62 + 0.13 * sin( uv.x * 21.0 + uTime * 2.6 + seed ) * sin( uv.x * 7.0 - uTime * 1.1 );
          col += uColor * 1.4 * ( 1.0 - smoothstep( 0.0, 0.012, abs( uv.y - trace ) ) );
          float head = fract( uTime * 0.22 + fract( seed * 0.77 ) );
          col += uColor * 2.2 * ( 1.0 - smoothstep( 0.0, 0.02, length( vec2( ( uv.x - head ) * 1.6, uv.y - trace ) ) ) );
          return col;
        }

        // Armed status: a channel list filling in sequence under a bar that
        // pulses amber. Reads as something counting down to a go condition.
        vec3 status( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          float rows = 6.0;
          float r = floor( uv.y * rows );
          float rf = fract( uv.y * rows );
          float lit = step( fract( uTime * 0.19 + r * 0.17 + seed * 0.13 ), 0.62 );
          // Label block on the left, a value bar on the right.
          float label = step( 0.06, uv.x ) * step( uv.x, 0.34 ) * step( 0.28, rf ) * step( rf, 0.68 );
          float fill = 0.4 + 0.5 * hash11( r + seed );
          float bar = step( 0.40, uv.x ) * step( uv.x, 0.40 + fill * 0.54 ) * step( 0.3, rf ) * step( rf, 0.66 );
          col += uColor * 0.55 * label * ( 0.35 + 0.65 * lit );
          col += mix( uColor, uWarn, step( 0.72, fill ) ) * bar * ( 0.3 + 1.1 * lit );
          // Alert bar across the top of the field, breathing.
          float pulse = 0.45 + 0.55 * abs( sin( uTime * 2.1 + seed ) );
          col += uWarn * pulse * 1.5 * step( 0.74, uv.y ) * step( uv.y, 0.8 ) * step( 0.06, uv.x ) * step( uv.x, 0.94 );
          return col;
        }

        // Oscilloscope: one bright trace on a graticule, with a cursor.
        vec3 scope( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          vec2 g = abs( fract( uv * vec2( 10.0, 6.0 ) ) - 0.5 );
          col += uColor * 0.07 * step( 0.44, max( g.x, g.y ) );
          float t = uv.x * 12.0 + uTime * 3.4 + seed;
          float y = 0.42 + 0.24 * ( sin( t ) * 0.7 + sin( t * 2.7 + seed ) * 0.3 );
          col += uColor * 2.0 * ( 1.0 - smoothstep( 0.0, 0.016, abs( uv.y - y ) ) );
          col += uColor * 0.5 * ( 1.0 - smoothstep( 0.0, 0.09, abs( uv.y - y ) ) );
          float cur = fract( uTime * 0.31 + seed * 0.41 );
          col += uWarn * 1.1 * ( 1.0 - smoothstep( 0.0, 0.004, abs( uv.x - cur ) ) );
          return col;
        }

        // Ticker board: a scrolling block ribbon over a progress bar. The house
        // board, which wants to read from the back of the hall.
        vec3 ticker( vec2 uv, float seed ) {
          vec3 col = vec3( 0.0 );
          float x = uv.x * 9.0 + uTime * 0.9 + seed;
          float cell = floor( x );
          float on = step( 0.42, hash11( cell * 1.7 + seed ) );
          float body = step( 0.08, fract( x ) ) * step( fract( x ), 0.9 )
                     * step( 0.42, uv.y ) * step( uv.y, 0.72 );
          col += mix( uColor, uWarn, step( 0.86, hash11( cell + 3.1 ) ) ) * body * on * 1.1;
          float p = fract( uTime * 0.07 + seed * 0.29 );
          col += uColor * 1.3 * step( 0.08, uv.x ) * step( uv.x, 0.08 + p * 0.84 )
               * step( 0.2, uv.y ) * step( uv.y, 0.3 );
          col += uColor * 0.25 * step( 0.08, uv.x ) * step( uv.x, 0.92 )
               * step( 0.19, uv.y ) * step( uv.y, 0.31 );
          return col;
        }

        void main() {
          // The board index is a vertex attribute, so every fragment of a panel
          // agrees on which display it belongs to.
          float seed = vBoard * 7.31 + 1.7;
          vec2 uv = vUv;

          // Occasional horizontal tear.
          float tearBand = step( 0.985, hash11( floor( uTime * 6.0 ) + seed ) );
          float tearY = fract( hash11( floor( uTime * 6.0 ) * 1.7 + seed ) );
          if ( tearBand > 0.0 && abs( uv.y - tearY ) < 0.03 ) uv.x += 0.05;

          vec3 col = vec3( 0.008, 0.02, 0.03 );
          vec2 g = abs( fract( uv * vec2( 16.0, 9.0 ) ) - 0.5 );
          col += uColor * 0.05 * step( 0.46, max( g.x, g.y ) );

          if ( vProgram < 0.5 ) col += spectrum( uv, seed );
          else if ( vProgram < 1.5 ) col += status( uv, seed );
          else if ( vProgram < 2.5 ) col += scope( uv, seed );
          else col += ticker( uv, seed );

          // Caption strip: this board's own row of the shared text plate.
          if ( uv.y > 0.82 ) {
            vec2 cuv = vec2( uv.x, ( vBoard + clamp( ( uv.y - 0.82 ) / 0.16, 0.0, 1.0 ) ) / uRows );
            col += uColor * 1.8 * texture2D( uCaptions, cuv ).r;
          }

          // Scanlines and a slow rolling frame bar.
          col *= 0.72 + 0.28 * step( 0.5, fract( uv.y * 120.0 ) );
          float roll = fract( uv.y + uTime * 0.11 + seed * 0.13 );
          col *= 1.0 + 0.35 * ( 1.0 - smoothstep( 0.0, 0.06, roll ) );
          // Vignette and the glass's own slight sheen.
          col *= 1.0 - 0.55 * pow( length( uv - 0.5 ) * 1.5, 3.0 );

          gl_FragColor = vec4( col * uGain, 1.0 );
          #include <fog_fragment>
        }
      `,
      toneMapped: true,
      fog: true,
      side: THREE.FrontSide,
    });
    // UniformsUtils.merge clones, so the caption plate is bound afterwards.
    this.screenMaterial.uniforms.uCaptions.value = this.captions;

    const geo = mergeAll(panels);
    const board = new Float32Array(geo.attributes.position.count);
    const program = new Float32Array(geo.attributes.position.count);
    let at = 0;
    counts.forEach((n, i) => {
      board.fill(i, at, at + n);
      program.fill(BOARDS[i].prog, at, at + n);
      at += n;
    });
    geo.setAttribute('aBoard', new THREE.Float32BufferAttribute(board, 1));
    geo.setAttribute('aProgram', new THREE.Float32BufferAttribute(program, 1));
    this.screens = new THREE.Mesh(geo, this.screenMaterial);
    this.screens.name = 'arena.practicals.screens';
    this.group.add(this.screens);
  }

  /**
   * The severed cable's arc. Sparks are a physical burst pool plus a point
   * light that only exists for the two or three frames the arc lasts, which is
   * the whole trick: the flash lights the machinery around it, so the eye reads
   * a real electrical fault rather than an animated sprite.
   */
  #sparks(textures, sparkPoint) {
    this.sparkPoint = sparkPoint ? sparkPoint.clone() : new THREE.Vector3(10.35, 6.05, -13.0);
    this.sparks = new PointBurst(textures.spark, {
      count: 220,
      color: 0xffd08a,
      gravity: -16,
      drag: 1.1,
      additive: true,
      floorY: 0,
      bounce: 0.28,
    });
    this.sparks.points.name = 'arena.practicals.sparks';
    this.group.add(this.sparks.points);

    this.sparkLight = new THREE.PointLight(0xffd9a0, 0, 9, 2);
    this.sparkLight.position.copy(this.sparkPoint);
    this.sparkLight.castShadow = false;
    this.group.add(this.sparkLight);

    this._nextArc = 1.5;
    this._arc = 0;
  }

  // -------------------------------------------------------------------------

  /**
   * Copies the Environment's live practical parameters onto the fixture
   * emitters. Called every frame, so a mood cross-fade drags the visible
   * sources along with the lights instead of leaving them behind.
   */
  syncToEnvironment() {
    const lights = this.environment?.practicals;
    const params = this.environment?.params?.practicals;
    const cols = this.emitterMaterial.uniforms.uColor.value;
    const pools = this.poolMaterial.uniforms.uPool.value;
    for (let i = 0; i < FIXTURES; i++) {
      const light = lights?.[i];
      const p = params?.[i];
      if (!p) continue;
      // Radiance under a knee rather than a straight scale. A 26-unit doorway
      // and a 4.5-unit sign box have to end up within a stop or two of each
      // other on screen, or the bright one clips to a white rectangle and stops
      // reading as a lit surface at all. The curve is anchored on the dimmest
      // fixture any mood authors, so even the sign box clears BLOOM_THRESHOLD
      // and the light banks land three to four times over it — hot enough that
      // the bright pass, not the albedo, is what the eye reads them by.
      const live = Math.max(0, light?.intensity ?? p.power);
      const power = BLOOM_THRESHOLD * Math.pow(live / 4.5, 0.62) * (i === 3 ? 1.35 : 2.1);
      cols[i].copy(light?.color ?? p.color).multiplyScalar(power);
      // The pool is scatter, so it follows the source's flicker at a square
      // root: a lamp that dips 10% dims its pool, it does not switch it off.
      pools[i].copy(p.color).multiplyScalar(Math.sqrt(live) * POOL_GAIN);
      const pub = this.practicalPositions[i];
      if (pub) {
        pub.position.copy(p.pos);
        pub.color.copy(p.color);
        pub.power = p.power;
        pub.size.copy(p.size);
      }
    }
  }

  /**
   * @param {number} dt seconds since the last rendered frame
   * @param {number} time seconds since the stage was built
   * @param {object} envParams live Environment mood parameters
   */
  update(dt, time, envParams) {
    // The Environment's animation clock — practical flicker, the rim hue drift,
    // the mood cross-fade and the per-fighter rim rigs following their fighters.
    // The Stage is its only per-frame consumer, so the Stage winds it; `frame`
    // stands down of its own accord if the game ever drives `update` directly.
    this.environment?.frame(dt);
    this.syncToEnvironment();
    this.screenMaterial.uniforms.uTime.value = time;

    const rimA = envParams?.rim?.color;
    const rimB = envParams?.rimB?.color;
    if (rimA) {
      // Neon and screens take their hue from the mood's rim pair, which is what
      // keeps the practicals and the lighting reading as one design.
      // A tube has to clear BLOOM_THRESHOLD at the bottom of its cycle, not the
      // top: a strip that only blooms on the peak reads as a flickering decal
      // rather than as glass with current in it.
      const pulse = 2.8 + 0.36 * Math.sin(time * 0.8);
      this.neonMaterial.color.copy(rimA).multiplyScalar(pulse);
      this.screenMaterial.uniforms.uColor.value.copy(rimA).lerp(_white, 0.25);
      // The strip's own wash on the barrier and the floor at its foot. The
      // deposit is scatter and stays where it was — only the tube got hotter.
      this.poolMaterial.uniforms.uPool.value[4].copy(rimA).multiplyScalar(pulse * 0.11);
    }
    if (rimB) this.screenMaterial.uniforms.uWarn.value.copy(rimB).lerp(_amber, 0.4);

    // Beacons: a rotating mirror reads as a sharp sweep, not a sine.
    for (let i = 0; i < this._beaconPhase.length; i++) {
      const ph = this._beaconPhase[i];
      const sweep = Math.pow(Math.max(0, Math.sin(time * 1.9 + ph)), 12);
      _tmp.setRGB(1, 0.32, 0.08).multiplyScalar(0.4 + sweep * 11);
      this.beacons.setColorAt(i, _tmp);
    }
    this.beacons.instanceColor.needsUpdate = true;

    // Arcing cable.
    this._nextArc -= dt;
    if (this._nextArc <= 0) {
      this._nextArc = this.rng.range(1.4, 5.2);
      this._arc = this.rng.range(0.06, 0.16);
      this.sparks.emit(
        this.sparkPoint,
        _down,
        this.rng.int(18) + 14,
        { rng: this.rng, speed: 4.2, spread: 0.75, life: 0.85, size: 0.045 },
      );
    }
    if (this._arc > 0) {
      this._arc = Math.max(0, this._arc - dt);
      this.sparkLight.intensity = this._arc > 0 ? 22 * (0.4 + Math.random() * 0.6) : 0;
    } else if (this.sparkLight.intensity !== 0) {
      this.sparkLight.intensity = 0;
    }
    this.sparks.update(dt);
  }

  reset() {
    this.sparks.reset();
    this.sparkLight.intensity = 0;
    this._arc = 0;
    this._nextArc = 1.5;
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.emitterMaterial.dispose();
    this.poolMaterial.dispose();
    this.neonMaterial.dispose();
    this.beaconMaterial.dispose();
    this.screenMaterial.dispose();
    this.sparks.dispose();
    this.atlas.dispose();
    this.captions.dispose();
  }
}
