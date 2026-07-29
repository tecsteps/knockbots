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
import { Rng } from '../core/Rng.js';
import { bevelBox, place, mergeAll, boltRing, insetPanel } from './GeoKit.js';
import { fbm, stampText, blur, clamp01, makeTexture, encodeSrgb, hexToLinear } from './ProcTex.js';
import { PointBurst } from './StageParticles.js';

const FIXTURES = 4;

const _tmp = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
const _amber = new THREE.Color(0xffa02a);
const _down = new THREE.Vector3(0.15, -1, 0.1).normalize();

/** Text plate sampled by the screens: four stacked captions in one texture. */
function screenCaptions(size = 256) {
  const mask = new Float32Array(size * size);
  const cell = Math.max(2, Math.round(size / 64));
  const rows = ['sublevel 09 diag', 'hydraulic nominal', 'cell 09 armed', 'rig telemetry'];
  for (let r = 0; r < rows.length; r++) {
    stampText(mask, size, rows[r], Math.round(size * 0.06), Math.round((r + 0.32) * (size / 4)), cell, cell * 0.5);
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

/** Frosted diffuser: a faint cell pattern so the light bank is not a white bar. */
function diffuserTexture(size = 256) {
  const n = fbm(size, 26, { octaves: 3, seed: 401 });
  const fine = fbm(size, 90, { octaves: 2, seed: 409 });
  const base = hexToLinear(0xffffff);
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      // Longitudinal tube banding, plus grime toward the ends of the fitting.
      const u = i / size;
      const tube = 0.72 + 0.28 * Math.abs(Math.sin(u * Math.PI * 3));
      const grime = 1 - Math.pow(Math.abs(u * 2 - 1), 4) * 0.5;
      const v = clamp01(tube * grime * (0.8 + n[k] * 0.3 + fine[k] * 0.15));
      const o = k * 4;
      for (let ch = 0; ch < 3; ch++) data[o + ch] = encodeSrgb(base[ch] * v);
      data[o + 3] = 255;
    }
  }
  return makeTexture(data, size, { srgb: true, anisotropy: 4 });
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

    this.diffuser = diffuserTexture(256);
    this.captions = screenCaptions(256);

    this.#fixtures(bins);
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
      // The emitting face looks down and slightly toward the pit.
      emitter(w, h, { pos: [x, y, z], rot: [-Math.PI / 2, 0, 0] }, f);
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
        map: { value: this.diffuser },
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
          gl_FragColor = vec4( c * texture2D( map, vUv ).rgb, 1.0 );
        }
      `,
      side: THREE.DoubleSide,
      toneMapped: true,
      fog: false,
    });
    this.emitters = new THREE.Mesh(faceGeo, this.emitterMaterial);
    this.emitters.name = 'arena.practicals.emitters';
    this.group.add(this.emitters);
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
   * Diagnostic screens on the machinery bank. All four share one shader; the
   * content varies by the screen's own world position, so a single draw call
   * produces four displays that are visibly running different programs.
   */
  #screens(bins) {
    const panels = [];
    const bezels = bins.dark;
    const place4 = [
      { pos: [-3.4, 3.0, -12.42], rot: [0, 0, 0], w: 2.2, h: 1.3 },
      { pos: [3.9, 3.4, -12.42], rot: [0, 0, 0], w: 1.7, h: 1.1 },
      { pos: [-12.35, 3.6, 4.0], rot: [0, Math.PI / 2, 0], w: 2.0, h: 1.2 },
      { pos: [12.35, 4.1, -3.2], rot: [0, -Math.PI / 2, 0], w: 2.4, h: 1.4 },
    ];
    for (const p of place4) {
      panels.push(place(new THREE.PlaneGeometry(p.w, p.h), { pos: p.pos, rot: p.rot }));
      bezels.push(place(insetPanel(p.w + 0.2, p.h + 0.2, 0.09, 0.1), {
        pos: [p.pos[0] - Math.sin(p.rot[1]) * 0.03, p.pos[1], p.pos[2] - Math.cos(p.rot[1]) * 0.03],
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
          uGain: { value: 1.6 },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        varying vec2 vUv;
        varying vec3 vWorld;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vWorld = w.xyz;
          vec4 mvPosition = viewMatrix * w;
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
        varying vec2 vUv;
        varying vec3 vWorld;

        float hash11( float n ) { return fract( sin( n ) * 43758.5453 ); }

        void main() {
          // Each screen gets its own seed and its own caption row from where it
          // is standing, so one material drives four different displays.
          float seed = floor( vWorld.x * 3.1 + vWorld.y * 7.7 + vWorld.z * 1.3 );
          float row = floor( fract( seed * 0.2137 ) * 4.0 );
          vec2 uv = vUv;

          // Occasional horizontal tear.
          float tearBand = step( 0.985, hash11( floor( uTime * 6.0 ) + seed ) );
          float tearY = fract( hash11( floor( uTime * 6.0 ) * 1.7 + seed ) );
          if ( tearBand > 0.0 && abs( uv.y - tearY ) < 0.03 ) uv.x += 0.05;

          vec3 col = vec3( 0.008, 0.02, 0.03 );

          // Faint grid.
          vec2 g = abs( fract( uv * vec2( 16.0, 9.0 ) ) - 0.5 );
          col += uColor * 0.05 * step( 0.46, max( g.x, g.y ) );

          // Bar graph across the lower half.
          float bars = floor( uv.x * 22.0 );
          float h = 0.08 + 0.34 * abs( sin( bars * 1.7 + uTime * ( 1.3 + fract( seed * 0.31 ) ) + seed ) )
                        * ( 0.5 + 0.5 * hash11( bars + seed ) );
          float inBar = step( uv.y, h ) * step( 0.06, uv.y ) * step( 0.12, fract( uv.x * 22.0 ) );
          col += mix( uColor, uWarn, step( 0.3, h ) ) * inBar * 0.9;

          // A trace sweeping the upper half.
          float trace = 0.62 + 0.13 * sin( uv.x * 21.0 + uTime * 2.6 + seed ) * sin( uv.x * 7.0 - uTime * 1.1 );
          col += uColor * 1.4 * ( 1.0 - smoothstep( 0.0, 0.012, abs( uv.y - trace ) ) );
          float head = fract( uTime * 0.22 + fract( seed * 0.77 ) );
          col += uColor * 2.2 * ( 1.0 - smoothstep( 0.0, 0.02, length( vec2( ( uv.x - head ) * 1.6, uv.y - trace ) ) ) );

          // Caption strip, one row of the shared text plate.
          vec2 cuv = vec2( uv.x, ( row + clamp( ( uv.y - 0.84 ) / 0.14, 0.0, 1.0 ) ) * 0.25 );
          if ( uv.y > 0.84 ) col += uColor * 1.8 * texture2D( uCaptions, cuv ).r;

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
    this.screens = new THREE.Mesh(mergeAll(panels), this.screenMaterial);
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
    for (let i = 0; i < FIXTURES; i++) {
      const light = lights?.[i];
      const p = params?.[i];
      if (!p) continue;
      // Radiance, scaled well below the light's own power: the fitting should
      // bloom, not clip to a white rectangle.
      const power = (light?.intensity ?? p.power) * 0.12;
      cols[i].copy(light?.color ?? p.color).multiplyScalar(power);
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
    this.syncToEnvironment();
    this.screenMaterial.uniforms.uTime.value = time;

    const rimA = envParams?.rim?.color;
    const rimB = envParams?.rimB?.color;
    if (rimA) {
      // Neon and screens take their hue from the mood's rim pair, which is what
      // keeps the practicals and the lighting reading as one design.
      this.neonMaterial.color.copy(rimA).multiplyScalar(1.7 + 0.22 * Math.sin(time * 0.8));
      this.screenMaterial.uniforms.uColor.value.copy(rimA).lerp(_white, 0.25);
    }
    if (rimB) this.screenMaterial.uniforms.uWarn.value.copy(rimB).lerp(_amber, 0.4);

    // Beacons: a rotating mirror reads as a sharp sweep, not a sine.
    for (let i = 0; i < this._beaconPhase.length; i++) {
      const ph = this._beaconPhase[i];
      const sweep = Math.pow(Math.max(0, Math.sin(time * 1.9 + ph)), 12);
      _tmp.setRGB(1, 0.32, 0.08).multiplyScalar(0.25 + sweep * 6.5);
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
    this.neonMaterial.dispose();
    this.beaconMaterial.dispose();
    this.screenMaterial.dispose();
    this.sparks.dispose();
    this.diffuser.dispose();
    this.captions.dispose();
  }
}
