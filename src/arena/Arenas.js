/**
 * Knockbots — the arena registry.
 *
 * An arena is a **mood preset plus a structure variation**, not a subsystem.
 * `Stage.js` composes the same six pieces every time — floor, barriers, set,
 * atmosphere, mirror, impact FX — and this file is the table that says which
 * variation of each a given arena uses, plus the one lighting mood it runs
 * under. Adding a seventh arena is an entry here and two exports elsewhere; it
 * is not a fork of `Stage`.
 *
 * **Why there are three and why they are these three.** The visual score had
 * been flat for eight rounds on one arena, and that arena is a closed box lit
 * from twelve metres up. Every tuning pass inside it was fighting the same
 * lighting geometry. So the two new ones are not new dressing on the same
 * problem; each is chosen to be a lighting case the pit structurally cannot
 * produce, and between them they bracket it:
 *
 *   | | key | ambient | shadow | what it can do that the others cannot |
 *   |---|---|---|---|---|
 *   | `sublevel09` | soft banks, 38 deg | interior IBL, mid | short, soft | shaped area highlights, a wet deck under strip lights |
 *   | `skydeck` | one hard sun, 14 deg | a real sky, high | **long and raking** | a warm/cool split across one object, sun through a slatted screen |
 *   | `cistern` | strips at 2 m, steep falloff | almost none | **hard, and short** | a visible falloff gradient, a genuinely dark background |
 *
 * The middle column is the one that matters. `duskRoof` runs the highest
 * `envIntensity` in the table and `cistern` the lowest, which means the same
 * armour material is asked two opposite questions in the same build.
 *
 * **Only one arena is in the scene at a time.** They are built on demand and
 * torn down on a switch — see `Stage.setArena` — so the triangle budget is the
 * largest arena, not their sum. Measured with `scratchpad/setcount.mjs` and
 * `scratchpad/stagehash.mjs`, whole-arena, high quality:
 *
 *     sublevel09   273,122 triangles   61 drawables   16.7 ms / 59.9 fps
 *     skydeck       80,440 triangles   37 drawables   14.0 ms / 71.4 fps
 *     cistern       86,811 triangles   38 drawables   15.3 ms / 65.4 fps
 *
 * Frame times are 1920x1080 on the shipping `high` tier, simulation paused,
 * adaptive resolution off, with `sublevel09` re-measured last as a drift check
 * (16.7 then 16.5, so the ranking is signal). Both new arenas come in under a
 * third of the pit's geometry and both are FASTER, which is not a coincidence:
 * the frame is fill-bound and the pit draws a crowd, a machinery bank and three
 * parallaxed city layers that neither of these has.
 *
 * Whole-frame triangles, which is the figure the 900k charter ceiling is about:
 * 1,309,308 on the pit against 773,659 and 739,289. **The ceiling is already
 * exceeded, by the pit, and it was before this round** — the 939k on record is
 * the count with the per-fighter shadowed keys disarmed, and the shipping build
 * with them armed has been at ~1.31M since they landed. Playing either new arena
 * puts the frame back UNDER 900k.
 *
 * @see src/engine/Environment.js for the `duskRoof` and `cistern` moods.
 * @see src/arena/StageBarriers.js for the three combat-barrier presets.
 */

import { StageStructure } from './StageStructure.js';
import { StageRooftop, bakeRoofMaps, roofDetail, ROOF_SURFACE } from './StageRooftop.js';
import { StageVault, bakeVaultMaps, vaultDetail, VAULT_SURFACE } from './StageVault.js';
import { PIT_BARRIER, ROOF_BARRIER, VAULT_BARRIER } from './StageBarriers.js';

/**
 * The pit's atmosphere is `StageVolumetrics`' own defaults, so its entry is
 * `null` and the file keeps its authored numbers. The other two are stated in
 * full because the mechanism is shared and only the air differs.
 */
const ROOF_AIR = {
  /**
   * Two shafts, and they are the same trick the arena's whole layout is built
   * on: a sun eleven degrees up, coming through the slatted debris screen on
   * the -x barrier. `slat` is the shader's own louvre term — period and duty —
   * so the beam arrives already cut into bars, which is what a low sun through
   * a scaffold screen actually does and what no amount of fog can fake.
   *
   * `extinction` is gentle (0.03) because these are long raking throws, not
   * short drops off a fitting; a steep decay and they never reach the deck.
   * They are also the only two, against the pit's five: outdoor air at dusk is
   * clear, and a rooftop full of visible beams reads as a nightclub.
   */
  shafts: [
    { pos: [-13.6, 2.9, -2.0], rot: [0, 0, -1.32], half: [1.5, 1.35], spread: [0.05, 0.02], length: 22, color: 0xffb98a, intensity: 0.085, round: 0.1, edge: 2.0, extinction: 0.03, slat: [0.42, 2.6], pool: 0.026 },
    { pos: [-13.6, 2.4, 6.4], rot: [0.12, 0, -1.36], half: [1.2, 1.1], spread: [0.05, 0.02], length: 19, color: 0xffa878, intensity: 0.07, round: 0.1, edge: 2.0, extinction: 0.03, slat: [0.42, 2.6], pool: 0.02 },
  ],
  /**
   * Airborne dust, warm and sparse. A quarter of the pit's count, lifted out of
   * the box the pit uses so the motes hang over the deck and against the sky
   * rather than filling a room that is not there.
   */
  motes: { box: { x: 30, y: 6.0, z: 24, cx: 0, cy: 1.8, cz: -2 }, density: 0.32, color: 0xffd2ac, size: 0.021, drift: 0.28, intensity: 0.2 },
  /** Extract cowls and a flue on the plant room, all well outside the deck. */
  jets: {
    list: [
      { origin: [-9.8, 3.1, -9.4], dir: [0.15, 1.0, 0.2], rate: 1, speed: 0.9, life: 5.5, size: 0.85 },
      { origin: [7.2, 2.6, -10.2], dir: [-0.1, 1.0, 0.15], rate: 1, speed: 0.7, life: 6.0, size: 0.7 },
    ],
    opacity: 0.055,
    color: 0xd8c0aa,
  },
  /**
   * Warm and thin. On a roof the ground mist is the city's own smog sitting
   * below the parapet line, seen past the edges — it must not become a layer
   * lying on the deck the shadows are drawn on.
   */
  deckHaze: { color: 0xc99a78, intensity: 0.26, thickness: 1.1 },
};

const VAULT_AIR = {
  /**
   * Four, and every one of them belongs to a fitting `StageVault` actually
   * built: the two mercury wall strips, the mercury key over the weir, and the
   * sodium bulkhead. Their `half` extents are the strips' own, so the beam is
   * the shape of the source rather than a generic cone.
   *
   * `extinction` is steep (0.20-0.26) and that is the arena's whole argument
   * expressed in the air as well as on the surfaces: a strip two metres from
   * what it lights is visibly weaker at the deck than at the fitting. The pit's
   * gantry shafts run 0.16 over 5.5 m from twelve metres up, which is a
   * different physical situation and a different number.
   */
  shafts: [
    { pos: [-11.0, 2.35, 1.2], rot: [0, 0, -1.18], half: [1.6, 0.09], spread: [0.16, 0.30], length: 7.0, color: 0xd6e8ff, intensity: 0.62, round: 0.2, edge: 2.2, extinction: 0.22, slat: [0, 0], pool: 0.04 },
    { pos: [11.0, 2.35, -1.8], rot: [0, 0, 1.18], half: [1.6, 0.09], spread: [0.16, 0.30], length: 7.0, color: 0xd6e8ff, intensity: 0.62, round: 0.2, edge: 2.2, extinction: 0.22, slat: [0, 0], pool: 0.04 },
    { pos: [-2.2, 3.82, -7.5], rot: [0.62, 0, 0], half: [2.3, 0.1], spread: [0.06, 0.22], length: 6.4, color: 0xcadfff, intensity: 0.5, round: 0.15, edge: 2.3, extinction: 0.20, slat: [0, 0], pool: 0.05 },
    { pos: [10.85, 2.05, 4.4], rot: [0.1, 0, 1.1], half: [0.42, 0.2], spread: [0.28, 0.28], length: 4.4, color: 0xff9a3c, intensity: 0.44, round: 0.8, edge: 2.1, extinction: 0.26, slat: [0, 0], pool: 0.03 },
  ],
  /**
   * Denser and cooler than the pit's, and lower. A buried tank over standing
   * water genuinely carries particulate, and this is the mood's one licence to
   * put atmosphere near the fight plane — the shafts' clear-volume carve-out
   * still protects the box itself, so what this fills is the air between the
   * fighters and the arcade.
   */
  motes: { box: { x: 26, y: 5.0, z: 26, cx: 0, cy: 1.0, cz: -6 }, density: 1.35, color: 0xbcd6ff, size: 0.02, drift: 0.11, intensity: 0.3 },
  /** Leaks, not plumes: a weeping joint and two vents in the machine hall. */
  jets: {
    list: [
      { origin: [-12.4, 1.6, -3.2], dir: [0.85, 0.28, 0.1], rate: 1, speed: 0.8, life: 5.0, size: 0.6 },
      { origin: [12.4, 2.2, -8.0], dir: [-0.8, 0.35, -0.1], rate: 1, speed: 0.7, life: 5.4, size: 0.65 },
      { origin: [-3.2, 0.05, -17.5], dir: [0.05, 1.0, -0.1], rate: 1, speed: 0.5, life: 7.5, size: 1.1 },
      { origin: [4.6, 0.05, -19.5], dir: [-0.05, 1.0, 0.05], rate: 1, speed: 0.45, life: 8.0, size: 1.2 },
    ],
    opacity: 0.09,
    color: 0x8fb0cc,
  },
  /**
   * Cold and thick. This is the mist lying on the standing water at the back of
   * the room, and it is the term that separates the arcade from the machine
   * hall behind it — the layer the pit's third depth band was scored for not
   * having.
   */
  deckHaze: { color: 0x5f86a8, intensity: 0.72, thickness: 2.1 },
};

/**
 * @typedef {object} ArenaDef
 * @property {string} id
 * @property {string} name       shown in the menu
 * @property {string} subtitle
 * @property {string} mood       key into `Environment`'s MOODS
 * @property {Function} Set      the set module; see `StageStructure`'s shape
 * @property {object} barrier    a `StageBarriers` preset
 * @property {?object} surface   a `StageFloor` surface spec; null is the pit's
 * @property {?object} air       a `StageVolumetrics` spec; null is the pit's
 * @property {?object} signage   plate and banner legends; null is the pit's
 * @property {boolean} practicals whether `StagePracticals` runs. The pit's
 *   emitters are their own module because that set was built before arenas
 *   existed; the two new sets own theirs, so they turn it off rather than
 *   inheriting a shop floor's light fittings.
 */

/** @type {Record<string, ArenaDef>} */
export const ARENAS = {
  sublevel09: {
    id: 'sublevel09',
    name: 'Sublevel 09',
    subtitle: 'Mech Test Cell',
    mood: 'industrial',
    Set: StageStructure,
    barrier: PIT_BARRIER,
    surface: null,
    air: null,
    signage: null,
    practicals: true,
  },

  skydeck: {
    id: 'skydeck',
    name: 'Skydeck',
    subtitle: 'Helipad 12, Dusk',
    mood: 'duskRoof',
    Set: StageRooftop,
    barrier: ROOF_BARRIER,
    /**
     * The roof's own bake, plus two things the module could not decide for
     * itself because they depend on the mood it is paired with.
     *
     * `reflGain` is one of them. `StageFloor.update` derives reflection
     * strength from `envParams.floorRefl`, so the surface's authored
     * `reflStrength` is only a seed; this is the surface's standing say in it.
     * 0.70 because a built-up roof with a mineral cap is a matte surface with
     * ponds in it, not a wet slab — the ponds should mirror the sky hard and
     * the 90% of the deck between them should not mirror at all.
     */
    surface: { ...ROOF_SURFACE, bake: bakeRoofMaps, detail: roofDetail, reflGain: 0.70 },
    air: ROOF_AIR,
    signage: {
      warning: ['danger', 'roof access', 'harness area'],
      banners: [
        { text: 'knockbots skyline series', ground: 0x1b1d24, ink: 0xe4d8cc },
        { text: 'no unauthorised access', ground: 0x5e2a12, ink: 0xe8dcd0 },
        { text: 'helipad 12  clearance 4m', ground: 0x14181f, ink: 0xd0a44a },
        { text: 'kb tower management', ground: 0x8a4a12, ink: 0x180f06 },
      ],
    },
    practicals: false,
  },

  cistern: {
    id: 'cistern',
    name: 'The Cistern',
    subtitle: 'Flooded Plant Vault',
    mood: 'cistern',
    Set: StageVault,
    barrier: VAULT_BARRIER,
    /**
     * `reflGain` 1.15 on top of a surface that is already the most reflective in
     * the project, and it is deliberate rather than enthusiastic.
     *
     * `StageFloor`'s own FRAG_REFLECT_HOOK records the standing complaint that
     * the wet floor reflects the light strip and not the robots, and records
     * that the mirror *does* contain the fighters — the problem is that at a
     * grazing angle the Schlick term is about 0.11, which a blown-out strip
     * survives and a mid-tone fighter does not. It also records that lifting
     * the Fresnel base alone does not fix it, and names the lever it did not
     * test: the reflected radiance *relative to the deck's own*.
     *
     * This arena is that test. `VAULT_SURFACE` takes the deck's own gain to
     * 0.68 against the pit's 1.14 and puts the knee at 0.7, which compresses
     * the strips far harder than the fighters; this adds the last 15% on the
     * reflectance side. If the reading is right, a fighter's reflection becomes
     * legible here and nowhere else, and it is falsifiable in one line — put
     * `deckGain` back to 1.14 and it should mostly vanish.
     */
    surface: { ...VAULT_SURFACE, bake: bakeVaultMaps, detail: vaultDetail, reflGain: 1.15 },
    air: VAULT_AIR,
    signage: {
      warning: ['danger', 'confined space', 'no entry'],
      banners: [
        { text: 'knockbots undercity circuit', ground: 0x121a1f, ink: 0xcdd8dd },
        { text: 'deep water  no access', ground: 0x1d3a44, ink: 0xd6e4e8 },
        { text: 'cistern 3  outfall gallery', ground: 0x0f1519, ink: 0x9fbfae },
        { text: 'kb water board', ground: 0x2c4a1c, ink: 0x0c1206 },
      ],
    },
    practicals: false,
  },
};

/** Arena identifiers, in presentation order. */
export const ARENA_IDS = Object.keys(ARENAS);

/** The one the game boots into. */
export const DEFAULT_ARENA = 'sublevel09';

/**
 * Resolve an arena id to its definition, tolerating anything.
 *
 * Deliberately forgiving: an unknown id comes back as the default rather than
 * throwing, because the two callers are a menu and a URL query string and
 * neither should be able to leave the player with no stage.
 * @param {?string} id
 * @returns {ArenaDef}
 */
export function arenaDef(id) {
  return ARENAS[id] ?? ARENAS[DEFAULT_ARENA];
}
