/**
 * Knockbots — the arena's tiling PBR material library.
 *
 * Every surface in the hangar that is not the floor is drawn with one of these
 * eight sets, and every set is generated from the same handful of noise fields
 * so the whole place looks like it was built by one contractor out of one
 * batch of steel.
 *
 * Two rules the arena is surfaced by:
 *
 *   - **Value range is reserved for the fighters.** The set sits between about
 *     0.02 and 0.18 in linear albedo. Nothing in the mid-ground is allowed to
 *     approach the brightness of a lit armour plate, because the moment it does
 *     the silhouette stops reading. Contrast in the environment comes from the
 *     practicals and from specular, never from albedo.
 *   - **Wear runs downhill.** Grime accumulates below horizontals, rust weeps
 *     from fastener rows, and paint chips at edges. All three are driven by the
 *     same vertical streak field, so a wall, a girder and a container all look
 *     like they have been standing in the same damp room for thirty years.
 *
 * That second rule has a limit, and it was being overrun. One contractor's steel
 * is not one contractor's *grain*: concrete aggregate, machined pitting and the
 * flake under container paint are physically different sizes, and every set here
 * was drawing them at roughly the same one — four to six centimetres — because
 * they all reached for `worley` at a similar cell count over a similar world
 * tile. The result is a speckle common to the truss, the shell and the barrier,
 * and a shared speckle across unrelated materials is one of the strongest tells
 * there is that a set was generated rather than built. So each class now owns
 * three numbers of its own:
 *
 *   - **`TILE`, its world tile size**, spread from 1.4m on machined steel to
 *     6.2m on poured concrete. The bins are UV'd in metres by `Stage`, so a
 *     texture repeat is a world scale, and it is free.
 *   - **its own grain and cell frequencies**, chosen so the smallest feature in
 *     each set lands where that material's actually does — 11mm pits, 24mm
 *     aggregate, 100mm paint flake, 208mm chip cells.
 *   - **a low-frequency field an octave below anything it had**, one to three
 *     metres across, which is what stops a 24m barrier reading as four copies of
 *     one panel. Big tiles are what make room for it: a 1.5m tile has nowhere to
 *     put a 3m blotch.
 *
 * Maps are packed on the glTF convention (R=AO, G=roughness, B=metalness) so a
 * single texture serves `aoMap`, `roughnessMap` and `metalnessMap`.
 */

import * as THREE from 'three';
import {
  fbm, worley, blur, clamp01, lerp, smoothstep, hexToLinear,
  heightToNormal, heightToAo, packOrm, bakeAlbedo, makeTexture, makeAlpha,
  noiseTexture, radialSprite, stampText, sampleWrap, encodeSrgb,
} from './ProcTex.js';

/**
 * Vertical streak field: the shared basis for every kind of weathering.
 *
 * `cells` is the horizontal frequency of the runs and it is per class, not
 * shared. Streaks are the most recognisable thing in the set — they are long,
 * they are high contrast and they sit on every surface — so leaving them at one
 * width across concrete, steel and container plate put the same signature on all
 * three no matter how different the grain under it was.
 */
function streakField(size, seed, stretch = 7, cells = 26) {
  const f = new Float32Array(size * size);
  const base = fbm(size, cells, { octaves: 4, seed });
  const fine = fbm(size, cells * 3.5, { octaves: 3, seed: seed + 11 });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // Sampling the same noise with a squashed vertical coordinate is what
      // turns blobs into runs without a separate directional blur pass.
      const a = sampleWrap(base, size, i, j / stretch);
      const b = sampleWrap(fine, size, i, j / (stretch * 2.2));
      f[j * size + i] = clamp01(a * 0.7 + b * 0.4 - 0.12);
    }
  }
  return f;
}

/**
 * Integer hash to [0,1). Two rounds, the same mix `StageFloor` uses for its
 * tie-down lattice, kept identical so a per-unit draw looks the same wherever
 * one is taken in the arena.
 */
function hash2(i, j, salt = 0) {
  let h = (i * 374761393 + j * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * A grid of individually-varied units, and the missing octave of every set in
 * this file.
 *
 * Measured against the frame the stage axis is scored on: with the five big
 * arena materials' normal maps switched off entirely the wide shot's background
 * band moves from 0.0280 to 0.0267 mean gradient, and tripling their strength
 * only reaches 0.0300. **The maps carry almost no legible energy at all**, and
 * amplitude is not why. Each set had its grain (1–3 cm, at or under a screen
 * pixel twelve metres out) and its macro blobs (1–3 m, a smooth ramp that a
 * derivative barely sees) and *nothing in between* — no energy anywhere in the
 * 8–50 cm band, which is the only band that lands at a legible 8–50 screen
 * pixels at this camera distance. A wall built out of a smooth ramp plus
 * sub-pixel speckle is a flat wall.
 *
 * What fills that hole in real construction is that surfaces are assembled from
 * *units* — shutter boards, precast bays, bolted plates — and no two units are
 * the same value. So this returns three fields over a grid of them:
 *
 *   - `tone`, one hash per unit, constant across it, giving a hard value step
 *     at every joint rather than a ramp;
 *   - `rough`, a second independent hash, because a unit that is darker is not
 *     therefore duller — correlating them is what made the floor lattice read
 *     as one stamp at different exposures;
 *   - `seam`, the joint itself, for the height field.
 *
 * Cell indices are taken modulo the grid so the field tiles at any `size`, and
 * `bond` offsets alternate rows so a run of units is not a chequerboard.
 *
 * @param {number} size texture edge
 * @param {number} cellsX units across the tile
 * @param {number} cellsY units up the tile
 * @param {number} seed
 * @param {{bond?: number, joint?: number}} [opts] `joint` is in texels.
 */
function cellField(size, cellsX, cellsY, seed, opts = {}) {
  const bond = opts.bond ?? 0;
  const joint = opts.joint ?? 2;
  const tone = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const seam = new Float32Array(size * size);
  const sx = size / cellsX;
  const sy = size / cellsY;
  for (let j = 0; j < size; j++) {
    const v = (j / size) * cellsY;
    const gj = Math.floor(v);
    const fy = v - gj;
    const dy = Math.min(fy, 1 - fy) * sy;
    const off = bond * (gj & 1);
    for (let i = 0; i < size; i++) {
      const u = (i / size) * cellsX + off;
      const gi = Math.floor(u);
      const fx = u - gi;
      const k = j * size + i;
      const ii = ((gi % cellsX) + cellsX) % cellsX;
      tone[k] = hash2(ii, gj, seed);
      rough[k] = hash2(ii, gj, seed + 977);
      const dx = Math.min(fx, 1 - fx) * sx;
      seam[k] = 1 - smoothstep(joint * 0.45, joint, Math.min(dx, dy));
    }
  }
  return { tone, rough, seam };
}

/**
 * Pushes a 0..1 field out from its midpoint.
 *
 * The reason this is needed everywhere in this file: an fbm field is roughly
 * Gaussian about 0.5 with a standard deviation around 0.12, so a value written
 * as `lerp(dark, pale, fines * 0.7)` does not swing between dark and pale — it
 * swings across the middle eighth of that interval and comes out one colour.
 * Measured on the baked concrete albedo before this was applied: 5th to 95th
 * percentile 0.153 to 0.192 in sRGB, standard deviation 0.0134 — a wall living
 * inside four per cent of the available range. The endpoints were never the
 * problem; the driver was. After, at the same median: 0.125 to 0.235, sd 0.0329.
 *
 * Bake the library in node and write the maps out rather than capturing the
 * frame to judge one of these fields: it is half a minute against four, and a
 * field that is too loud or too rare is obvious in the map long before it is
 * obvious through a light rig. The first cut of the concrete's spalling was
 * forty per cent coverage of round worley discs — polka dots — and the map
 * showed it immediately.
 */
const punch = (x, k, mid = 0.5) => clamp01((x - mid) * k + mid);

/** Straight grooves on a grid, written into a height field. */
function scribeGrid(height, size, cellsX, cellsY, depth, width) {
  const w = width * size;
  for (let j = 0; j < size; j++) {
    const gy = ((j / size) * cellsY) % 1;
    const dy = Math.min(gy, 1 - gy) * (size / cellsY);
    const fy = 1 - smoothstep(0, w, dy);
    for (let i = 0; i < size; i++) {
      const gx = ((i / size) * cellsX) % 1;
      const dx = Math.min(gx, 1 - gx) * (size / cellsX);
      const fx = 1 - smoothstep(0, w, dx);
      height[j * size + i] -= depth * Math.max(fx, fy);
    }
  }
}

/** Hemispherical fastener heads on a grid, written into a height field. */
function studGrid(height, size, cols, rows, radius, amount, offset = 0) {
  const r = radius * size;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const px = ((cx + 0.5 + (cy % 2) * offset) / cols) * size;
      const py = ((cy + 0.5) / rows) * size;
      const i0 = Math.floor(px - r - 1), i1 = Math.ceil(px + r + 1);
      const j0 = Math.floor(py - r - 1), j1 = Math.ceil(py + r + 1);
      for (let j = j0; j <= j1; j++) {
        const jj = ((j % size) + size) % size;
        for (let i = i0; i <= i1; i++) {
          const ii = ((i % size) + size) % size;
          const d = Math.hypot(i - px, j - py) / r;
          if (d >= 1) continue;
          height[jj * size + ii] += amount * Math.sqrt(1 - d * d) * (1 - smoothstep(0.82, 1, d));
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Painted structural steel — gantries, railings, machinery housings
// ---------------------------------------------------------------------------

/** Painted steel tiles at 1.9m: 6mm grain, 21cm chip cells, 94cm blotching. */
function paintedSteelSet(size, seed) {
  const grain = fbm(size, 300, { octaves: 2, seed });
  const macro = fbm(size, 7, { octaves: 4, seed: seed + 3 });
  // Whole panels weather at different rates — one bay under a leak, the next
  // dry — and that is a metre-scale field, an octave below anything else here.
  const patch = fbm(size, 2, { octaves: 3, seed: seed + 31 });
  const streaks = streakField(size, seed + 5, 6, 18);
  const { f1: cellF1 } = worley(size, 9, seed + 9, 0.9);
  const scratch = fbm(size, 240, { octaves: 2, seed: seed + 13, ridged: true });
  // Bolted panels at 47 x 63cm. A gantry housing is sheet on a frame and every
  // sheet was sprayed on a different day; the smooth `patch` field below is a
  // metre-scale ramp and cannot produce the edge a panel joint has.
  const panels = cellField(size, 4, 3, seed + 59, { joint: Math.max(2, size / 320) });

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    height[k] = grain[k] * 0.16 + macro[k] * 0.1 - panels.seam[k] * 0.6;
  }
  scribeGrid(height, size, 2, 2, 0.55, 0.006);
  studGrid(height, size, 8, 8, 0.006, 0.3, 0.5);

  // Paint survives on flats and fails at edges, at fasteners and where water
  // has been running. `chip` is that failure, and it drives every channel.
  const chipRaw = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const edge = smoothstep(0.62, 0.95, 1 - cellF1[k]);
    chipRaw[k] = clamp01(
      smoothstep(0.55, 0.9, macro[k] * 0.55 + streaks[k] * 0.75) * 0.9 +
      edge * 0.5 + smoothstep(0.72, 0.98, scratch[k]) * 0.55,
    ) * (0.55 + patch[k] * 0.9);
  }
  const chip = blur(chipRaw, size, 1, 1);

  const ao = heightToAo(height, size, 5, 1.1);
  const normal = heightToNormal(height, size, 2.6, { wrap: true });

  const paint = hexToLinear(0x2c333b);
  const paintDark = hexToLinear(0x1a1f26);
  const steel = hexToLinear(0x5b5c5a);
  const grime = hexToLinear(0x181513);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const c = chip[k];
    const dirt = clamp01(streaks[k] * 0.85 + macro[k] * 0.3 - 0.15);
    // The metre-scale field rides the paint value as well as the chipping, so a
    // run of gantry does not come out one flat colour between its chips, and
    // the panel hash steps it again at the joints.
    const bay = (0.84 + patch[k] * 0.32) * (0.86 + panels.tone[k] * 0.28);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(paint[ch], paintDark[ch], macro[k] * 0.7 + grain[k] * 0.3);
      v = lerp(v, steel[ch] * (0.65 + grain[k] * 0.5), c);
      v = lerp(v, grime[ch], dirt * 0.42);
      out[ch] = v * bay * (0.86 + ao[k] * 0.14);
    }
  });

  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const dirt = clamp01(streaks[k] * 0.8 - 0.1);
    rough[k] = clamp01(lerp(0.52, 0.31, chip[k]) + dirt * 0.22 + grain[k] * 0.06
      + (panels.rough[k] - 0.5) * 0.26);
    metal[k] = clamp01(lerp(0.35, 0.95, chip[k]) * (1 - dirt * 0.4) - panels.seam[k] * 0.3);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, metal, size) };
}

// ---------------------------------------------------------------------------
// Dark machined steel — trusses, frames, the machinery wall
// ---------------------------------------------------------------------------

/** Machined steel tiles at 1.4m: 11mm pits, 3mm brush grain, 70cm blotching. */
function darkMetalSet(size, seed) {
  // Plate lattice at 47cm — the unit this stock is actually delivered and
  // welded in, and the octave the set was missing between its 11mm pits and its
  // 70cm blotches. Nothing else here lands in the 8-50cm band.
  const plates = cellField(size, 3, 3, seed + 43, { bond: 0.5, joint: Math.max(2, size / 300) });
  const brush = new Float32Array(size * size);
  const src = fbm(size, 260, { octaves: 3, seed });
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      // Each plate takes its grain from a different part of the field. Rolled
      // stock is cut from different coils and hung whichever way up it came off
      // the truck, so a continuous brush across a welded run is the giveaway;
      // offsetting the sample per plate costs nothing and breaks it completely.
      const o = plates.tone[k] * 640;
      brush[k] = sampleWrap(src, size, i / 12 + o, j + o * 0.7);
    }
  }
  // Pitting on machined stock is an order finer than aggregate in concrete. At
  // 46 cells over the old tile it was 4cm across, which is the same size as the
  // concrete's aggregate and the container's flake — the shared speckle itself.
  const pit = worley(size, 130, seed + 4, 1.0).f1;
  const macro = fbm(size, 4, { octaves: 5, seed: seed + 7 });
  const patch = fbm(size, 2, { octaves: 2, seed: seed + 29 });
  const streaks = streakField(size, seed + 8, 11, 34);

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    // Plates sit proud of one another by a millimetre or two — nobody shims a
    // machinery guard flush — so the seam is a step as well as a groove.
    height[k] = brush[k] * 0.09 + macro[k] * 0.08 - smoothstep(0.34, 0, pit[k]) * 0.5
      + (plates.tone[k] - 0.5) * 0.16 - plates.seam[k] * 0.8;
  }
  scribeGrid(height, size, 1, 1, 0.65, 0.008);
  studGrid(height, size, 4, 4, 0.009, 0.36, 0.5);

  const ao = heightToAo(height, size, 5, 1.25);
  const normal = heightToNormal(height, size, 2.2, { wrap: true });

  const steel = hexToLinear(0x24272c);
  const dark = hexToLinear(0x13151a);
  const oil = hexToLinear(0x0d0c0b);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const b = brush[k];
    const dirt = clamp01(streaks[k] * 0.9 - 0.1);
    const bay = (0.86 + patch[k] * 0.3) * (0.82 + plates.tone[k] * 0.36);
    for (let ch = 0; ch < 3; ch++) {
      // `punch` for the reason given at its definition: the baked map read a
      // 0.013 sRGB standard deviation before it, which is one grey.
      let v = lerp(dark[ch], steel[ch], punch(b, 2.2) * 0.85 + punch(macro[k], 1.6) * 0.4);
      v = lerp(v, oil[ch], dirt * 0.5 + plates.seam[k] * 0.55);
      out[ch] = v * bay * (0.82 + ao[k] * 0.18);
    }
  });

  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const dirt = clamp01(streaks[k] * 0.9 - 0.1);
    // Brushed steel: roughness varies along the grain, which is what produces
    // the stretched highlight the eye reads as machined metal. Plus a per-plate
    // offset, dealt from a hash independent of the plate's value — a run where
    // the dark plates are also the dull ones reads as one plate lit unevenly.
    rough[k] = clamp01(0.29 + brush[k] * 0.2 + dirt * 0.3 + smoothstep(0.3, 0, pit[k]) * 0.25
      + (plates.rough[k] - 0.5) * 0.32);
    metal[k] = clamp01(0.96 - dirt * 0.45 - smoothstep(0.28, 0, pit[k]) * 0.3 - plates.seam[k] * 0.4);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, metal, size) };
}

// ---------------------------------------------------------------------------
// Corrugated container steel — faded paint over deep rust
// ---------------------------------------------------------------------------

/** Container plate tiles at 2.2m: 275mm ribs, 20mm orange peel, 100mm flake. */
function containerSet(size, seed) {
  // Coarser than the steel set's grain on purpose. Paint over a corrugated skin
  // fails as orange peel and lifting flake, both of which are visibly bigger
  // than the pitting on a machined member.
  const grain = fbm(size, 110, { octaves: 4, seed });
  const rustBlob = fbm(size, 9, { octaves: 5, seed: seed + 2 });
  const weather = fbm(size, 2, { octaves: 3, seed: seed + 27 });
  const streaks = streakField(size, seed + 6, 4, 12);
  const flake = worley(size, 22, seed + 11, 1).f1;

  const height = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    // Trapezoidal corrugation running vertically, 8 ribs per tile.
    const rowBase = j * size;
    for (let i = 0; i < size; i++) {
      const t = ((i / size) * 8) % 1;
      const rib = t < 0.5 ? smoothstep(0.06, 0.2, t) * (1 - smoothstep(0.3, 0.44, t)) : 0;
      height[rowBase + i] = rib * 1.0 + grain[rowBase + i] * 0.12;
    }
  }
  scribeGrid(height, size, 1, 3, 0.4, 0.007);
  const rustMask = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    // Rust is a whole-panel event before it is a local one: one box in a stack
    // has gone over and the one beside it has not.
    rustMask[k] = clamp01((
      smoothstep(0.5, 0.82, rustBlob[k]) * 0.9 +
      smoothstep(0.45, 0.85, streaks[k]) * 0.7 +
      smoothstep(0.78, 1, 1 - flake[k]) * 0.4
    ) * (0.45 + weather[k] * 1.2));
  }
  for (let k = 0; k < size * size; k++) height[k] -= rustMask[k] * 0.16 * grain[k];

  const ao = heightToAo(height, size, 6, 1.0);
  const normal = heightToNormal(height, size, 2.0, { wrap: true });

  const paint = hexToLinear(0x22383c);
  const paintPale = hexToLinear(0x35504f);
  const rust = hexToLinear(0x532810);
  const rustDark = hexToLinear(0x241109);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const r = rustMask[k];
    const g = punch(grain[k], 2.0);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(paint[ch], paintPale[ch], g * 0.7 + punch(rustBlob[k], 1.5) * 0.35);
      v = lerp(v, lerp(rustDark[ch], rust[ch], g * 0.9 + 0.15), r);
      out[ch] = v * (0.8 + ao[k] * 0.2);
    }
  });

  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(lerp(0.48, 0.88, rustMask[k]) + grain[k] * 0.08);
    metal[k] = clamp01(lerp(0.4, 0.05, rustMask[k]));
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, metal, size) };
}

// ---------------------------------------------------------------------------
// Poured concrete — the barrier walls and the pit surround
// ---------------------------------------------------------------------------

/**
 * Poured concrete tiles at 6.2m: 24mm aggregate, 15mm fines, 3m pour variation.
 *
 * The biggest tile in the set, because concrete is what the biggest surfaces are
 * made of — the 24m barrier and the terrace — and those are precisely where a
 * short tile is legible as a repeat.
 */
function concreteSet(size, seed) {
  const aggregate = worley(size, 260, seed, 1).f1;
  const fines = fbm(size, 420, { octaves: 3, seed: seed + 1 });
  const macro = fbm(size, 6, { octaves: 5, seed: seed + 4 });
  // Pour-to-pour variation: three metres across, an octave below `macro` and
  // the only field here big enough to break the barrier's repeat.
  const pour = fbm(size, 2, { octaves: 3, seed: seed + 33 });
  const streaks = streakField(size, seed + 7, 8, 14);
  const crackField = fbm(size, 22, { octaves: 4, seed: seed + 21, ridged: true });
  // The 8-50cm band this set did not have. Three fields, all of them hard-edged
  // where the old ones ramped:
  //   - shutter boards at 31cm, which is what a board-marked wall IS: twenty
  //     planks up a six-metre tile, each one a different age of timber and so a
  //     different value, with a raised lip of grout where the boards met;
  //   - precast bays at 1.24 x 2.06m, one value and one finish apiece;
  //   - spalling at 18cm, thresholded rather than faded, so a patch of exposed
  //     aggregate has an EDGE — but gated onto the arrises, because that is
  //     where concrete actually breaks away and because an all-over field of it
  //     is leopard print. The first cut of this was ungated and covered roughly
  //     forty per cent of the face; it moved the band number and made the wall
  //     look like cave popcorn, which is the exact trade this round exists to
  //     refuse.
  const boards = cellField(size, 1, 20, seed + 51, { joint: Math.max(2, size / 340) });
  const bays = cellField(size, 5, 3, seed + 67, { bond: 0.37, joint: Math.max(2, size / 260) });
  // Thresholded fbm, not thresholded worley. A worley cell is a disc, so a
  // cut-off on `f1` produces round patches at an even pitch and the wall comes
  // back covered in polka dots — visible in the baked map long before it is
  // visible in the frame, which is what `scratchpad/dumptex.mjs` is for. An fbm
  // cut high enough gives the same coverage in irregular shapes.
  const spallCell = fbm(size, 26, { octaves: 4, seed: seed + 71 });

  const height = new Float32Array(size * size);
  const spall = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    const pop = smoothstep(0.16, 0, aggregate[k]) * 0.35;
    const arris = clamp01(boards.seam[k] * 0.7 + bays.seam[k]);
    spall[k] = smoothstep(0.70, 0.84, spallCell[k]) *
      smoothstep(0.34, 0.72, arris * 0.42 + macro[k] * 0.55 + streaks[k] * 0.42);
    height[k] = fines[k] * 0.18 + macro[k] * 0.12 + pop
      - boards.seam[k] * 0.3 - bays.seam[k] * 0.55 - spall[k] * 0.3;
  }
  // Form-board seams: horizontal lines every 1/3 tile plus tie-rod holes.
  scribeGrid(height, size, 1, 3, 0.5, 0.005);
  studGrid(height, size, 3, 3, 0.008, -0.5, 0.5);

  const cracks = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) cracks[k] = smoothstep(0.9, 0.99, crackField[k]);
  for (let k = 0; k < size * size; k++) height[k] -= cracks[k] * 0.6;

  const ao = heightToAo(height, size, 6, 1.15);
  const normal = heightToNormal(height, size, 2.4, { wrap: true });

  // Widened, and then the midpoint pulled back down to hold the median where it
  // was. The set's first rule is that value range is reserved for the fighters,
  // and a wall that gains contrast by getting brighter has broken it — the
  // whole point is more variance at the same mean.
  const pale = hexToLinear(0x4e5158);
  const mid = hexToLinear(0x262830);
  const dark = hexToLinear(0x16171b);
  const stain = hexToLinear(0x111214);
  // Exposed aggregate under the skim is warmer and lighter than the face.
  const core = hexToLinear(0x585047);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const dirt = clamp01(streaks[k] * 0.95 - 0.08);
    // Two independent unit fields riding the value, not one smooth pour field.
    // Neither is large — a bay is +-13% and a board +-9% — but they are steps,
    // and a step at 25 and at 120 screen pixels is exactly the scale the eye
    // reads a wall's construction at.
    const bay = (0.8 + pour[k] * 0.42) * (0.87 + bays.tone[k] * 0.26) * (0.91 + boards.tone[k] * 0.18);
    const fine = punch(fines[k], 2.4);
    const blot = punch(macro[k], 1.7);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(mid[ch], pale[ch], fine * 0.8 + smoothstep(0.24, 0, aggregate[k]) * 0.5);
      v = lerp(v, dark[ch], blot * 0.55);
      v = lerp(v, stain[ch], dirt * 0.55 + cracks[k] * 0.6);
      v = lerp(v, core[ch] * (0.5 + aggregate[k] * 0.9), spall[k] * 0.55);
      out[ch] = v * bay * (0.78 + ao[k] * 0.22);
    }
  });

  const rough = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    // A float-finished bay and a tamped one sit next to each other on a real
    // pour, and the difference shows up in the highlight long before it shows
    // up in the albedo. Dealt per bay and per board from their OWN hashes: the
    // set previously ran 0.83-0.98, which is dead matte everywhere, so a
    // forty-five per cent surface of the frame took no specular structure from
    // fifteen analytic lights and a dozen practicals. Damp cuts it to 0.42 in
    // the low spots, which is where water actually sits.
    //
    // The damp is driven at 24cm as well as at the metre scale, and it is
    // allowed to go properly wet. A sublevel pit with standing water on the
    // deck does not have bone-dry walls, and a wet patch is the only thing on a
    // concrete surface that can carry a *reflection* — which is worth more per
    // pixel than any amount of albedo noise, because the thing it reflects is
    // the practicals, and they are the brightest objects in the room.
    const damp = smoothstep(0.60, 0.92,
      streaks[k] * 0.6 + (1 - macro[k]) * 0.35 + punch(spallCell[k], 1.6) * 0.45 + (pour[k] - 0.5) * 0.4);
    rough[k] = clamp01(
      0.9 + fines[k] * 0.1 - streaks[k] * 0.08
      - (pour[k] - 0.5) * 0.16
      - (bays.rough[k] - 0.5) * 0.3
      - (boards.rough[k] - 0.5) * 0.16
      - damp * 0.58
      + spall[k] * 0.1,
    );
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, null, size) };
}

// ---------------------------------------------------------------------------
// Hazard striping — the kerbs, bumpers and door frames
// ---------------------------------------------------------------------------

/** Striped kerbs and bumpers, tiling at 1.6m: 27cm chevrons, 11mm grain. */
function hazardSet(size, seed) {
  const grain = fbm(size, 150, { octaves: 3, seed });
  const wear = fbm(size, 11, { octaves: 4, seed: seed + 5 });
  const traffic = fbm(size, 2, { octaves: 3, seed: seed + 37 });
  const streaks = streakField(size, seed + 9, 5, 22);
  const scuff = fbm(size, 300, { octaves: 2, seed: seed + 17, ridged: true });

  const stripe = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      // 45 degree chevrons, 6 per tile, phase continuous across the seam.
      const t = (((i + j) / size) * 6) % 1;
      stripe[j * size + i] = t < 0.5 ? 1 : 0;
    }
  }
  const stripeSoft = blur(stripe, size, 1, 1);

  // Paint wears off the raised concrete underneath in traffic patterns.
  // Paint goes where the traffic goes, and traffic is a metre-scale pattern —
  // a worn track across a kerb, not an even fade over the whole of it.
  const worn = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    worn[k] = clamp01(
      (smoothstep(0.46, 0.86, wear[k]) * 0.9 + smoothstep(0.7, 1, scuff[k]) * 0.6) *
      (0.5 + traffic[k] * 1.15),
    );
  }

  const height = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    height[k] = grain[k] * 0.2 + (1 - worn[k]) * 0.08;
  }
  scribeGrid(height, size, 1, 4, 0.3, 0.004);

  const ao = heightToAo(height, size, 4, 0.9);
  const normal = heightToNormal(height, size, 1.8, { wrap: true });

  const yellow = hexToLinear(0x9c7614);
  const yellowDim = hexToLinear(0x5d4711);
  const black = hexToLinear(0x0b0b0c);
  const substrate = hexToLinear(0x2b2c2f);
  const grime = hexToLinear(0x17161a);

  const albedo = bakeAlbedo(size, (i, j, k, out) => {
    const s = stripeSoft[k];
    const dirt = clamp01(streaks[k] * 0.9 - 0.05);
    for (let ch = 0; ch < 3; ch++) {
      let v = lerp(black[ch], lerp(yellowDim[ch], yellow[ch], grain[k] * 0.6 + 0.35), s);
      v = lerp(v, substrate[ch] * (0.8 + grain[k] * 0.4), worn[k]);
      v = lerp(v, grime[ch], dirt * 0.45);
      out[ch] = v * (0.82 + ao[k] * 0.18);
    }
  });

  const rough = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(lerp(0.58, 0.9, worn[k]) + streaks[k] * 0.14 + grain[k] * 0.05);
  }
  return { albedo, normal: makeTexture(normal, size), orm: packOrm(ao, rough, null, size) };
}

// ---------------------------------------------------------------------------
// Cutout sets
// ---------------------------------------------------------------------------

/** Bar grating: a real grid with bearing bars and cross rods. */
function gratingSet(size, seed) {
  const alpha = new Float32Array(size * size);
  const height = new Float32Array(size * size);
  const bars = 10;
  const rods = 5;
  for (let j = 0; j < size; j++) {
    const v = ((j / size) * rods) % 1;
    const rod = 1 - smoothstep(0.1, 0.16, Math.abs(v - 0.5));
    for (let i = 0; i < size; i++) {
      const u = ((i / size) * bars) % 1;
      const bar = 1 - smoothstep(0.16, 0.24, Math.abs(u - 0.5));
      const a = Math.max(bar, rod);
      alpha[j * size + i] = a;
      height[j * size + i] = bar * 0.7 + rod * 0.35;
    }
  }
  const grain = fbm(size, 160, { octaves: 3, seed });
  for (let k = 0; k < size * size; k++) height[k] += grain[k] * 0.1 * alpha[k];
  const ao = heightToAo(height, size, 4, 1.4);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let k = 0; k < size * size; k++) {
    rough[k] = clamp01(0.44 + grain[k] * 0.22);
    metal[k] = 0.9;
  }
  return {
    alpha: makeAlpha(alpha, size),
    normal: makeTexture(heightToNormal(height, size, 3.4, { wrap: true }), size),
    orm: packOrm(ao, rough, metal, size),
  };
}

/**
 * Chain-link: two families of parallel wires at plus and minus 45 degrees.
 * Alpha only — the wire itself is shaded by the material's metalness.
 */
function chainLinkAlpha(size) {
  const alpha = new Float32Array(size * size);
  const cells = 7;
  const half = 0.05; // half wire width, in cell units
  const frac = (x) => x - Math.floor(x);
  for (let j = 0; j < size; j++) {
    const v = (j / size) * cells;
    for (let i = 0; i < size; i++) {
      const u = (i / size) * cells;
      const f1 = frac(u + v);
      const f2 = frac(u - v);
      const d1 = Math.min(f1, 1 - f1);
      const d2 = Math.min(f2, 1 - f2);
      alpha[j * size + i] = Math.max(
        1 - smoothstep(half * 0.6, half, d1),
        1 - smoothstep(half * 0.6, half, d2),
      );
    }
  }
  return makeAlpha(alpha, size);
}

/**
 * Impact decal: a compression crater with radial fractures and a bright rim
 * where the paint has been driven off the metal. Used on the arena walls.
 */
function dentDecal(size, seed) {
  const c = (size - 1) * 0.5;
  const height = new Float32Array(size * size);
  const alpha = new Float32Array(size * size);
  const warp = fbm(size, 5, { octaves: 4, seed, signed: true });
  const rays = fbm(size, 4, { octaves: 3, seed: seed + 3 });

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const dx = (i - c) / c;
      const dy = (j - c) / c;
      let d = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      // Star-shaped fracture pattern: the crater rim is not a circle.
      const lobes = 0.82 + 0.18 * Math.sin(ang * 5 + rays[k] * 6) + warp[k] * 0.22;
      d /= Math.max(0.35, lobes);
      const crater = 1 - smoothstep(0.0, 0.72, d);
      const lip = smoothstep(0.55, 0.74, d) * (1 - smoothstep(0.74, 0.94, d));
      const crack = smoothstep(0.55, 0.95, rays[k]) * (1 - smoothstep(0.3, 1.0, d));
      height[k] = -crater * 1.0 + lip * 0.34 - crack * 0.3;
      alpha[k] = clamp01((crater * 1.35 + lip * 1.1 + crack * 0.8) * (1 - smoothstep(0.75, 1.0, d)));
    }
  }

  const grain = fbm(size, 120, { octaves: 3, seed: seed + 8 });
  for (let k = 0; k < size * size; k++) height[k] += grain[k] * 0.09 * alpha[k];

  const data = new Uint8Array(size * size * 4);
  // Spalled concrete, not bare steel: these land on the barriers.
  const bare = hexToLinear(0x5c5b57);
  const shadow = hexToLinear(0x0a0b0c);
  const scorch = hexToLinear(0x171310);
  const lin = [0, 0, 0];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const dx = (i - c) / c, dy = (j - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const exposed = clamp01(smoothstep(0.42, 0.75, d) * 1.2 + grain[k] * 0.3);
      for (let ch = 0; ch < 3; ch++) {
        lin[ch] = lerp(shadow[ch], lerp(scorch[ch], bare[ch] * (0.6 + grain[k] * 0.8), exposed), 0.55 + exposed * 0.45);
      }
      const o = k * 4;
      data[o] = Math.round(clamp01(lin[0]) * 255);
      data[o + 1] = Math.round(clamp01(lin[1]) * 255);
      data[o + 2] = Math.round(clamp01(lin[2]) * 255);
      data[o + 3] = Math.round(clamp01(alpha[k]) * 255);
    }
  }
  const albedoTex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  albedoTex.colorSpace = THREE.SRGBColorSpace;
  albedoTex.wrapS = albedoTex.wrapT = THREE.ClampToEdgeWrapping;
  albedoTex.minFilter = THREE.LinearMipmapLinearFilter;
  albedoTex.generateMipmaps = true;
  albedoTex.anisotropy = 8;
  albedoTex.needsUpdate = true;

  const normalTex = makeTexture(heightToNormal(height, size, 3.0, { wrap: false }), size, { clamp: true });
  return { albedo: albedoTex, normal: normalTex };
}

/** Soft scorch/scuff decal for the floor. */
function scorchDecal(size, seed) {
  const c = (size - 1) * 0.5;
  const n = fbm(size, 5, { octaves: 5, seed });
  const fine = fbm(size, 22, { octaves: 3, seed: seed + 4 });
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const dx = (i - c) / c, dy = (j - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy) * (0.75 + n[k] * 0.6);
      const a = clamp01((1 - smoothstep(0.15, 0.95, d)) * (0.45 + fine[k] * 0.9));
      const o = k * 4;
      const v = Math.round(clamp01(0.05 + fine[k] * 0.06) * 255);
      data[o] = v; data[o + 1] = v; data[o + 2] = Math.round(v * 1.05);
      data[o + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** A stencilled warning plate, used on machinery and door frames. */
function warningPlate(size, seed, lines) {
  const grain = fbm(size, 120, { octaves: 3, seed });
  const wear = fbm(size, 8, { octaves: 4, seed: seed + 3 });
  const text = new Float32Array(size * size);
  // Longest line decides the type size, and the rows are stamped bottom-up so
  // the plate reads top-down once v=0 lands at the bottom of the quad.
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
  const cell = Math.max(2, Math.floor((size * 0.88) / (longest * 6)));
  let y = Math.round(size * 0.14);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const w = line.length * 6 * cell - cell;
    stampText(text, size, line, Math.round((size - w) / 2), y, cell, cell * 0.5);
    y += cell * 10;
  }
  const soft = blur(text, size, 1, 1);

  const plate = hexToLinear(0x30343a);
  const ink = hexToLinear(0xd8bb3a);
  const data = new Uint8Array(size * size * 4);
  for (let k = 0; k < size * size; k++) {
    const worn = smoothstep(0.5, 0.9, wear[k]);
    const ink01 = clamp01(soft[k] * (1 - worn * 0.7));
    const o = k * 4;
    for (let ch = 0; ch < 3; ch++) {
      data[o + ch] = encodeSrgb(lerp(plate[ch] * (0.8 + grain[k] * 0.5), ink[ch], ink01));
    }
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Number of legend bands stacked in the barrier-banner texture. Band `r`
 * occupies `[r / BANNER_ROWS, (r+1) / BANNER_ROWS]` in v; the caller picks one
 * by remapping a quad's v into that range.
 */
export const BANNER_ROWS = 4;

/**
 * The dressing on the pit barrier: four legend bands in one texture, each one a
 * whole panel's worth of graphic.
 *
 * The barrier is a twenty-four metre concrete band running the full width of
 * frame directly behind the fighters, and bare it is the single largest
 * featureless surface in the set — a smooth grey box, which is exactly the
 * complaint against it. Every real venue covers that band in event dressing,
 * and dressing fixes three things at once: it puts legible type in the
 * mid-ground, it puts a saturated colour break where there was none, and it
 * cuts a twenty-four metre run into panels with visible seams.
 *
 * The texture is **twice as wide as it is tall, with four bands** rather than a
 * square with eight. That is not arbitrary: an atlas is only safe down to the
 * mip level where each band still owns several rows, and eight bands in a
 * square run out at mip 3 — about the level a panel twelve metres away is
 * sampled at. Four bands in a 2:1 texture keep eight rows apiece two mips
 * further down, which is past anything the fight camera can frame. Each band is
 * then 8:1, the aspect the panels are cut at, so the stencil lands square
 * instead of stretched.
 *
 * @param {number} width texture width; height is half of it
 * @param {number} seed
 * @param {Array<{text: string, ground: number, ink: number}>} bands
 */
function barrierBanner(width, seed, bands) {
  const height = width / 2;
  const band = height / BANNER_ROWS;
  // `stampText` and `blur` both index on a square stride, so the fields are
  // square and only the bottom half of each is ever read out.
  const grime = streakField(width, seed, 5);
  const scuff = fbm(width, 14, { octaves: 4, seed: seed + 7 });
  const text = new Float32Array(width * width);
  for (let r = 0; r < Math.min(bands.length, BANNER_ROWS); r++) {
    const line = bands[r].text;
    // Solved per band so the legend fills the panel instead of running off it.
    const cell = Math.max(2, Math.min(Math.floor(band * 0.46), Math.floor((width * 0.92) / (line.length * 6))));
    const w = line.length * 6 * cell - cell;
    stampText(text, width, line, Math.round((width - w) / 2), Math.round(r * band + (band - 7 * cell) / 2), cell, cell * 0.6);
  }
  const soft = blur(text, width, 1, 1);

  const data = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const r = Math.min(BANNER_ROWS - 1, Math.floor(j / band));
    const ground = hexToLinear(bands[r].ground);
    const ink = hexToLinear(bands[r].ink);
    // Distance into the band, so the rules land on the panel's own edges.
    const t = (j - r * band) / band;
    // On a panel this shallow it is the rule lines, not the type, that carry
    // the graphic at twelve metres.
    const rule = smoothstep(0.95, 0.98, t) + smoothstep(0.05, 0.02, t);
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      // Grime pools along the bottom edge; the ink wears off the high spots.
      const dirt = clamp01(grime[k] * 0.8 + smoothstep(0.34, 0.0, t) * 0.55);
      const worn = smoothstep(0.52, 0.88, scuff[k]);
      const ink01 = clamp01(soft[k] * (1 - worn * 0.72));
      const o = k * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = lerp(ground[ch] * (0.72 + scuff[k] * 0.5), ink[ch], Math.max(ink01, rule * 0.85));
        v *= 1 - dirt * 0.6;
        data[o + ch] = encodeSrgb(v);
      }
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------

/**
 * Builds every non-floor material the arena uses.
 *
 * @param {object} [opts]
 * @param {'ultra'|'high'|'medium'|'low'} [opts.quality='high']
 * @param {{warning?: string[], banners?: object[]}} [opts.signage] arena legends.
 *   The plate and the barrier banner are the only two textures in this library
 *   that say WHERE they are, and a stage that reads "test cell 09" on a rooftop
 *   is worse than one with no legend at all. Everything else here is a material
 *   and is shared unchanged.
 * @returns {{ materials: Record<string, THREE.Material>, textures: Record<string, THREE.Texture>, dispose(): void }}
 */
export function makeArenaMaterials(opts = {}) {
  const q = opts.quality ?? 'high';
  const big = q === 'low' ? 256 : q === 'medium' ? 512 : 1024;
  const small = q === 'low' ? 128 : q === 'medium' ? 256 : 512;

  const steelSet = paintedSteelSet(small, 101);
  const darkSet = darkMetalSet(small, 211);
  const boxSet = containerSet(small, 307);
  const concSet = concreteSet(big, 401);
  const hazSet = hazardSet(small, 503);
  const grateSet = gratingSet(Math.min(512, small), 601);

  // World tile per class, as a repeat against the metres-per-tile the `Stage`
  // UV'd each bin at (concrete 3.4, steel 1.5, dark 1.9, container 2.2, hazard
  // 1.6). The point of the spread is that no two classes share a period: with
  // every set landing between 1.5 and 3.4 metres the whole hangar carried one
  // beat, and a shared beat across materials that have nothing to do with each
  // other is what makes a set look procedural. Container and hazard keep their
  // scale because both carry authored features at a real size — 275mm
  // corrugation and 270mm chevrons — that a repeat would put wrong.
  const tile = (set, r) => {
    for (const t of [set.albedo, set.normal, set.orm]) t?.repeat.set(r, r);
  };
  tile(concSet, 0.55);   // 6.18m
  tile(boxSet, 1.0);     // 2.20m
  tile(steelSet, 0.8);   // 1.88m
  tile(hazSet, 1.0);     // 1.60m
  tile(darkSet, 1.35);   // 1.41m

  const textures = {
    steelAlbedo: steelSet.albedo, steelNormal: steelSet.normal, steelOrm: steelSet.orm,
    darkAlbedo: darkSet.albedo, darkNormal: darkSet.normal, darkOrm: darkSet.orm,
    boxAlbedo: boxSet.albedo, boxNormal: boxSet.normal, boxOrm: boxSet.orm,
    concreteAlbedo: concSet.albedo, concreteNormal: concSet.normal, concreteOrm: concSet.orm,
    hazardAlbedo: hazSet.albedo, hazardNormal: hazSet.normal, hazardOrm: hazSet.orm,
    grateAlpha: grateSet.alpha, grateNormal: grateSet.normal, grateOrm: grateSet.orm,
    chainAlpha: chainLinkAlpha(Math.min(512, small)),
    noise: noiseTexture(128, 4, 17),
    dust: radialSprite(64, 2.6, 0.25),
    spark: radialSprite(48, 3.6, 0.9),
    steam: radialSprite(96, 1.6, 0.0),
    scorch: scorchDecal(256, 907),
    warning: warningPlate(256, 1301, opts.signage?.warning ?? ['danger', 'test cell 09', 'no entry']),
    banner: barrierBanner(big, 1601, opts.signage?.banners ?? [
      { text: 'knockbots industrial league', ground: 0x191d23, ink: 0xd9dde4 },
      { text: 'keep behind the line', ground: 0x62201a, ink: 0xe2dad1 },
      { text: 'test cell 09  heavy division', ground: 0x151a21, ink: 0xc8a13c },
      { text: 'kb foundry works', ground: 0x7a3c0a, ink: 0x1a1408 },
    ]),
  };
  const dent = dentDecal(256, 811);
  textures.dentAlbedo = dent.albedo;
  textures.dentNormal = dent.normal;

  /** Repeat is set per-mesh by world-scale UVs, so textures tile at 1:1 here. */
  const std = (t, cfg) => new THREE.MeshStandardMaterial({
    map: t.albedo, normalMap: t.normal, roughnessMap: t.orm, metalnessMap: t.orm, aoMap: t.orm,
    roughness: 1, metalness: 1, dithering: true, ...cfg,
  });

  const materials = {
    steel: std(steelSet, { name: 'arena.steel', normalScale: new THREE.Vector2(1, 1), envMapIntensity: 0.7 }),
    darkMetal: std(darkSet, { name: 'arena.darkMetal', normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 0.85 }),
    container: std(boxSet, { name: 'arena.container', normalScale: new THREE.Vector2(1.1, 1.1), envMapIntensity: 0.55 }),
    // envMapIntensity was 0.3 and the map is now damp in its low spots. A
    // dielectric at roughness 0.42 with almost no environment to reflect is a
    // grey card with a slightly different grey card painted on it; the whole
    // point of cutting the roughness is that the practicals then appear in the
    // wall, and that only happens if the surface is allowed to see them.
    concrete: std(concSet, { name: 'arena.concrete', metalness: 0, normalScale: new THREE.Vector2(1.35, 1.35), envMapIntensity: 0.55 }),
    hazard: std(hazSet, { name: 'arena.hazard', metalness: 0, normalScale: new THREE.Vector2(0.85, 0.85), envMapIntensity: 0.32 }),

    grating: new THREE.MeshStandardMaterial({
      name: 'arena.grating',
      color: 0x555559,
      normalMap: grateSet.normal, roughnessMap: grateSet.orm, metalnessMap: grateSet.orm, aoMap: grateSet.orm,
      alphaMap: grateSet.alpha, transparent: false, alphaTest: 0.5, side: THREE.DoubleSide,
      roughness: 1, metalness: 1, envMapIntensity: 0.8, dithering: true,
    }),

    // Left where it is on a measurement. The crowd band is the region furthest
    // below the Tekken 8 reference on local contrast, and this fence covers the
    // whole width of it, so brightening the wire looked like the cheapest way to
    // put high-frequency detail across all of it: colour 0x2a2d31 -> 0x3a4048,
    // roughness 0.55 -> 0.34, envMapIntensity 0.9 -> 1.7. Three captures at the
    // wide framing against three of the unchanged build, mean 8x8 luma standard
    // deviation over the background band:
    //
    //     unchanged  0.0287        brightened wire  0.0286
    //
    // No effect at all, against a run-to-run spread of 0.0013 — the wire is too
    // thin at twelve metres for its shading to survive to the pixel, so all the
    // change does is veil the crowd behind it slightly more. Reverted rather
    // than kept, because it moves the look without moving the number.
    chainLink: new THREE.MeshStandardMaterial({
      name: 'arena.chainLink',
      color: 0x2a2d31, alphaMap: textures.chainAlpha, alphaTest: 0.45,
      roughness: 0.55, metalness: 0.85, side: THREE.DoubleSide, envMapIntensity: 0.9, dithering: true,
    }),

    // Onlookers are pure silhouette: nearly black, matte, and deliberately not
    // shadow casters so a crowd of forty costs nothing in the shadow pass.
    //
    // It has to stay a Standard material, and that was measured rather than
    // assumed. The crowd is the second-widest band of shaded pixels in the
    // frame and every one of them runs the physical BRDF over fifteen analytic
    // lights, three of them RectAreaLights, so a Lambert swap looked like free
    // milliseconds. It is not: with the area lights and the IBL gone the
    // figures lose the fill that shapes them and the whole terrace collapses
    // into a flat blue-grey mass — 2.04 mean absolute difference over the frame
    // against a 1.08 noise floor, and all of it inside the crowd band, with the
    // bodies visibly darker and the faces gone. The area lights are what make
    // this read as people rather than bollards.
    crowd: new THREE.MeshStandardMaterial({
      name: 'arena.crowd', color: 0x0b0c10, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.35, dithering: true,
    }),

    rubber: new THREE.MeshStandardMaterial({
      name: 'arena.rubber', color: 0x131418, roughness: 0.78, metalness: 0.0, envMapIntensity: 0.4, dithering: true,
    }),

    glass: new THREE.MeshPhysicalMaterial({
      name: 'arena.glass', color: 0x0a1016, roughness: 0.14, metalness: 0.0,
      transmission: 0, transparent: true, opacity: 0.34, side: THREE.DoubleSide,
      envMapIntensity: 1.6, dithering: true,
    }),

    warningPlate: new THREE.MeshStandardMaterial({
      name: 'arena.warningPlate', map: textures.warning, roughness: 0.62, metalness: 0.25,
      envMapIntensity: 0.6, dithering: true,
    }),

    // Printed vinyl over ply: matte, dead flat, and it takes almost nothing
    // from the environment. A barrier graphic that picks up a specular sheen
    // reads as painted metal and puts a highlight where the fighters are.
    barrierBanner: new THREE.MeshStandardMaterial({
      name: 'arena.barrierBanner', map: textures.banner, roughness: 0.84, metalness: 0.0,
      envMapIntensity: 0.35, dithering: true,
    }),

    dentDecal: new THREE.MeshStandardMaterial({
      name: 'arena.dent', map: textures.dentAlbedo, normalMap: textures.dentNormal,
      transparent: true, opacity: 1, depthWrite: false, roughness: 0.52, metalness: 0.75,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      normalScale: new THREE.Vector2(1.6, 1.6), envMapIntensity: 0.9, dithering: true,
    }),

    scorchDecal: new THREE.MeshBasicMaterial({
      name: 'arena.scorch', map: textures.scorch, transparent: true, opacity: 0.85,
      depthWrite: false, blending: THREE.NormalBlending,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
    }),
  };

  for (const m of Object.values(materials)) m.shadowSide = THREE.FrontSide;

  return {
    materials,
    textures,
    dispose() {
      for (const t of Object.values(textures)) t.dispose?.();
      for (const m of Object.values(materials)) m.dispose?.();
    },
  };
}
