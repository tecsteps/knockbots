/**
 * Knockbots — the character roster.
 *
 * This file is pure data, and it is the single source of truth for *identity*:
 * RobotBuilder reads `chassis`, `proportions`, `palette` and `silhouette` to
 * grow a body; Materials reads `palette` to tint the procedural texture set;
 * AudioDirector reads `voice` to tune its formant bank; Fighter reads `stats`
 * and `moveSet`; MenuSystem reads `name`/`subtitle`/`bio`.
 *
 * Design rules the palettes obey, because the arena lights the fighters with
 * strong coloured rim light and a warm key:
 *
 *  - No muddy mid-greys. Every `primary` is either clearly dark (value < 0.22),
 *    clearly light (value > 0.85) or clearly chromatic. Mid-grey armour dies
 *    under rim light and reads as untextured plastic.
 *  - `accent` is a saturated hue used on a small fraction of the surface area
 *    (stripes, cowls, hazard chevrons) so the character is identifiable as a
 *    silhouette-plus-one-colour at 40px.
 *  - `emissive` is a *different hue for every character*, spread around the
 *    wheel, so the two fighters on screen never share a glow colour and the
 *    bloom pass separates them.
 *  - `trim` is the metal the edge-wear mask exposes: brass, chrome, oxide or
 *    bone. It is what makes the panel breaks read.
 *
 * Proportion multipliers stay inside 0.9..1.15 as the rig requires; the real
 * silhouette differentiation comes from `silhouette` and `build`, which change
 * what is grown on top of the bones rather than the bones themselves.
 *
 * `silhouette` and `build` are two descriptions of the same character at two
 * levels of resolution, and they are separate on purpose:
 *
 *  - `silhouette` is the abstract read — proportion scalars plus a coarse
 *    vocabulary shared with `MenuSystem`, which draws a 2D select-screen tile
 *    from it. Its values are a closed set that the tile renderer switches on.
 *  - `build` names the actual hero forms `RobotBuilder` grows. Every field is a
 *    distinct value across the whole cast, because the requirement it exists to
 *    satisfy is that no two fighters are the same shape. Five chassis serve ten
 *    fighters, so a chassis cannot be what decides this.
 *
 * They must agree. A `build.head` of `kabuto` and a `silhouette.head` of `mask`
 * are the same helmet described twice, once for a 100-pixel SVG and once for
 * geometry.
 *
 * @typedef {Object} CharacterDef
 * @property {string} id                 stable key, lowercase, no spaces
 * @property {string} name               display name
 * @property {string} subtitle           select-screen epithet
 * @property {string} bio                one sentence of flavour
 * @property {string} archetype          play-style tag, see ARCHETYPES
 * @property {'heavy'|'agile'|'brute'|'precision'|'arcane'} chassis
 * @property {{height:number,torso:number,arms:number,legs:number,head:number}} proportions
 * @property {{primary:string,secondary:string,accent:string,emissive:string,trim:string}} palette
 * @property {{power:number,speed:number,reach:number,weight:number,defense:number}} stats  1..10
 * @property {string} moveSet            key into MOVES: standard|heavy|agile|technical
 * @property {VoiceDef} voice
 * @property {SilhouetteDef} silhouette
 * @property {BuildDef} build
 * @property {{intro:string,victory:string,taunt:string,idle:string}} signature clip ids
 *
 * @typedef {Object} VoiceDef
 * @property {number} pitch      base pitch multiplier, 0.55..1.6, 1.0 = reference chassis
 * @property {number} timbre     spectral brightness 0..1; 0 = subwoofer growl, 1 = glass chime
 * @property {number} resonance  Q of the formant bank, 0..1; high = ringing hollow metal
 * @property {number} grit       waveshaper drive 0..1; high = distorted, damaged servos
 * @property {number} servo      servo whine fundamental in Hz, heard while limbs move
 * @property {number} impact     tuned frequency of the character's chassis "clang" in Hz
 * @property {string} tone       label used to pick the synth voice programme
 *
 * @typedef {Object} SilhouetteDef
 * @property {number} shoulders   pauldron span multiplier
 * @property {number} chestDepth  torso front-to-back multiplier
 * @property {number} waist       waist taper multiplier (low = wasp waist)
 * @property {number} limbTaper   how much limbs thin toward the extremity
 * @property {string} backpack    dorsal unit: reactor|thrusters|coil|tank|wings|drum|none
 * @property {string} head        skull style: visor|mono|crest|dome|crown|mandible|mask|lantern
 * @property {string} legs        plantigrade|digitigrade|piston
 * @property {string} plating     slab|layered|segmented|filigree|skeletal
 * @property {number} greeble     density of small surface detail, 0..1
 * @property {number} cables      count of exposed cable runs
 * @property {number} spikes      count of hard silhouette-breaking protrusions
 * @property {number} vents       count of emissive vents
 *
 * The hero forms. Ten distinct values per field, one per fighter — that is the
 * whole point of the block, and `check.mjs` holds it to that.
 *
 * @typedef {Object} BuildDef
 * @property {string} head   skull form: furnace|swept|turret|crown|kabuto|mandible|lantern|bunker|mono|insulator
 * @property {string} torso  dominant body mass: barrel|keel|hump|column|cuirass|carapace|skeletal|wall|reference|drum
 * @property {string} dorsal back unit: reactor|thrusters|drum|wings|spine|elytra|coil|tank|none|ladder
 * @property {string} legs   limb topology: plantigrade|digitigrade|splayed|piston
 * @property {string} mark   the one landmark element: stacks|canards|hook|fan|scabbards|raptor|rings|towershield|yoke|coils
 */

/** Chassis families. RobotBuilder reads these to pick plate shapes and joint hardware. */
export const CHASSIS_TYPES = {
  heavy: {
    id: 'heavy',
    label: 'Heavy Frame',
    description: 'Slab armour over an industrial actuator core. Slow to start, hard to stop.',
    plateThickness: 0.055,
    jointStyle: 'hydraulic',
    bevel: 0.012,
    massScale: 1.28,
    armorCoverage: 0.92,
    servoNoise: 0.75,
  },
  agile: {
    id: 'agile',
    label: 'Agile Frame',
    description: 'Minimal shell, exposed tendon bundles, sprung ankles built for burst movement.',
    plateThickness: 0.026,
    jointStyle: 'tendon',
    bevel: 0.006,
    massScale: 0.82,
    armorCoverage: 0.58,
    servoNoise: 0.35,
  },
  brute: {
    id: 'brute',
    label: 'Brute Frame',
    description: 'Salvage-welded mass with oversized arms and a counterweighted spine.',
    plateThickness: 0.07,
    jointStyle: 'ram',
    bevel: 0.02,
    massScale: 1.45,
    armorCoverage: 0.78,
    servoNoise: 0.9,
  },
  precision: {
    id: 'precision',
    label: 'Precision Frame',
    description: 'Machined panels with zero panel gap, harmonic drives, sensor-dense head.',
    plateThickness: 0.034,
    jointStyle: 'harmonic',
    bevel: 0.004,
    massScale: 1.0,
    armorCoverage: 0.8,
    servoNoise: 0.2,
  },
  arcane: {
    id: 'arcane',
    label: 'Arcane Frame',
    description: 'Ceramic shell around a field core; parts of it hold position without touching.',
    plateThickness: 0.03,
    jointStyle: 'field',
    bevel: 0.008,
    massScale: 0.9,
    armorCoverage: 0.66,
    servoNoise: 0.12,
  },
};

/** Ordered list of chassis keys, for menus and for cycling in the model viewer. */
export const CHASSIS_IDS = Object.keys(CHASSIS_TYPES);

/** Play-style tags. The CPU reads these to bias its decision weights. */
export const ARCHETYPES = {
  power: 'Slow, enormous damage, wins every trade it survives.',
  speed: 'Fastest startup in the cast, low damage, relentless.',
  grappler: 'Command throws and armour; must close the gap to work.',
  zoner: 'Controls space with long pokes and projectiles.',
  technical: 'Stances, parries and counters; execution-heavy.',
  rushdown: 'Endless pressure strings and plus frames.',
  wildcard: 'Randomised mix-ups, teleports, unorthodox angles.',
  defensive: 'Absorbs pressure and punishes; the wall.',
  allrounder: 'No holes, no gimmicks; rewards fundamentals.',
  mixup: 'High/low ambiguity, charge moves, oki nightmare.',
};

/** @type {CharacterDef[]} */
export const ROSTER = [
  // -------------------------------------------------------------------------
  {
    id: 'vulkan',
    name: 'VULKAN',
    subtitle: 'Forge-Born, Grudge-Fired',
    bio: 'Built to pour steel, retired to break it. The chest furnace is still lit and it still has not cooled down about the layoffs.',
    archetype: 'power',
    chassis: 'heavy',
    proportions: { height: 1.12, torso: 1.14, arms: 1.1, legs: 0.94, head: 0.9 },
    palette: {
      primary: '#4A2B1E',   // scorched iron, oxidised warm
      secondary: '#1B1310', // soot black
      accent: '#FF6A1A',    // molten orange hazard bands
      emissive: '#FF2E00',  // furnace red-orange
      trim: '#C7752E',      // hot brass
    },
    stats: { power: 10, speed: 3, reach: 7, weight: 9, defense: 5 },
    moveSet: 'heavy',
    voice: { pitch: 0.58, timbre: 0.16, resonance: 0.72, grit: 0.85, servo: 58, impact: 96, tone: 'furnace' },
    // Mass low and central rather than up on the shoulders: the barrel belly is
    // the read, which is what keeps this apart from BASTION's square wall.
    silhouette: {
      shoulders: 1.20, chestDepth: 1.34, waist: 1.16, limbTaper: 0.78,
      backpack: 'reactor', head: 'mask', legs: 'plantigrade', plating: 'slab',
      greeble: 0.7, cables: 6, spikes: 4, vents: 8,
    },
    build: { head: 'furnace', torso: 'barrel', dorsal: 'reactor', legs: 'splayed', mark: 'stacks' },
    signature: { intro: 'i.powerUp', victory: 'v.saluteCharge', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'kestrel',
    name: 'KESTREL',
    subtitle: 'Faster Than Your Apology',
    bio: 'A courier chassis that discovered it enjoyed arriving first and leaving a mark. Runs its cooling loop at a temperature nobody signed off on.',
    archetype: 'speed',
    chassis: 'agile',
    proportions: { height: 0.94, torso: 0.93, arms: 1.0, legs: 1.12, head: 1.0 },
    palette: {
      primary: '#E8EEF5',   // arctic enamel
      secondary: '#1E2A38', // deep slate underskin
      accent: '#00A8FF',    // cobalt racing stripe
      emissive: '#31E8FF',  // cyan coolant glow
      trim: '#9FB4C7',      // brushed aluminium
    },
    stats: { power: 4, speed: 10, reach: 6, weight: 3, defense: 5 },
    moveSet: 'agile',
    voice: { pitch: 1.42, timbre: 0.86, resonance: 0.44, grit: 0.12, servo: 420, impact: 640, tone: 'chime' },
    silhouette: {
      shoulders: 0.80, chestDepth: 0.88, waist: 0.66, limbTaper: 0.46,
      backpack: 'thrusters', head: 'visor', legs: 'digitigrade', plating: 'layered',
      greeble: 0.32, cables: 2, spikes: 1, vents: 5,
    },
    build: { head: 'swept', torso: 'keel', dorsal: 'thrusters', legs: 'digitigrade', mark: 'canards' },
    signature: { intro: 'i.walkOn', victory: 'v.pose', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'anvil',
    name: 'ANVIL',
    subtitle: 'Industrial-Grade Affection',
    bio: 'Dockyard lifting rig. Never learned a strike it liked more than a hug, and has never once let go early.',
    archetype: 'grappler',
    chassis: 'brute',
    proportions: { height: 0.98, torso: 1.15, arms: 1.15, legs: 0.9, head: 0.9 },
    palette: {
      primary: '#D6A017',   // safety yellow, chipped
      secondary: '#20211C', // oil black
      accent: '#FFC53D',    // hazard chevrons
      emissive: '#FFD21A',  // amber warning strobes
      trim: '#6E6252',      // greasy oxide steel
    },
    stats: { power: 9, speed: 4, reach: 5, weight: 10, defense: 7 },
    moveSet: 'heavy',
    voice: { pitch: 0.64, timbre: 0.24, resonance: 0.86, grit: 0.6, servo: 74, impact: 130, tone: 'drum' },
    silhouette: {
      shoulders: 1.58, chestDepth: 1.26, waist: 0.98, limbTaper: 0.88,
      backpack: 'drum', head: 'dome', legs: 'piston', plating: 'slab',
      greeble: 0.86, cables: 9, spikes: 0, vents: 4,
    },
    build: { head: 'turret', torso: 'hump', dorsal: 'drum', legs: 'piston', mark: 'hook' },
    signature: { intro: 'i.stanceSet', victory: 'v.systemsNominal', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'seraph',
    name: 'SERAPH',
    subtitle: 'Cathedral of Cold Light',
    bio: 'A choir-drone from an orbital reliquary. Speaks in tuned intervals and considers the ring an acoustically interesting room.',
    archetype: 'zoner',
    chassis: 'arcane',
    proportions: { height: 1.06, torso: 0.96, arms: 1.13, legs: 1.06, head: 0.95 },
    palette: {
      primary: '#EDE9F5',   // porcelain
      secondary: '#241B3D', // deep indigo
      accent: '#B49CFF',    // lilac inlay
      emissive: '#8A5CFF',  // violet field glow
      trim: '#D8C48A',      // aged temple gold
    },
    stats: { power: 6, speed: 6, reach: 9, weight: 4, defense: 4 },
    moveSet: 'technical',
    voice: { pitch: 1.18, timbre: 0.92, resonance: 0.95, grit: 0.05, servo: 300, impact: 520, tone: 'choir' },
    silhouette: {
      shoulders: 0.96, chestDepth: 0.78, waist: 0.62, limbTaper: 0.42,
      backpack: 'wings', head: 'crown', legs: 'digitigrade', plating: 'filigree',
      greeble: 0.28, cables: 0, spikes: 6, vents: 10,
    },
    build: { head: 'crown', torso: 'column', dorsal: 'wings', legs: 'digitigrade', mark: 'fan' },
    signature: { intro: 'i.powerUp', victory: 'v.pose', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'ronin',
    name: 'RONIN-07',
    subtitle: 'Sharpening an Old Debt',
    bio: 'Seventh of a bodyguard line, sole survivor of the contract that ended it. Keeps the other six serial numbers etched inside its forearm.',
    archetype: 'technical',
    chassis: 'precision',
    proportions: { height: 1.0, torso: 1.0, arms: 1.03, legs: 1.03, head: 0.97 },
    palette: {
      primary: '#141418',   // lacquer black
      secondary: '#E6E1D6', // bone white shoulder plates
      accent: '#FF2B45',    // crimson cord wrap
      emissive: '#FF1A3C',  // crimson blade-edge glow
      trim: '#8C8F97',      // polished nickel
    },
    stats: { power: 7, speed: 7, reach: 6, weight: 5, defense: 6 },
    moveSet: 'technical',
    voice: { pitch: 0.96, timbre: 0.58, resonance: 0.62, grit: 0.28, servo: 190, impact: 320, tone: 'blade' },
    silhouette: {
      shoulders: 1.26, chestDepth: 0.92, waist: 0.74, limbTaper: 0.58,
      backpack: 'spine', head: 'mask', legs: 'plantigrade', plating: 'layered',
      greeble: 0.44, cables: 3, spikes: 2, vents: 4,
    },
    build: { head: 'kabuto', torso: 'cuirass', dorsal: 'spine', legs: 'plantigrade', mark: 'scabbards' },
    signature: { intro: 'i.stanceSet', victory: 'v.pose', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'mantis',
    name: 'MANTIS',
    subtitle: 'Six Angles of Approach',
    bio: 'An agricultural pest-control unit that reclassified the definition of pest. Holds still for exactly as long as it takes you to relax.',
    archetype: 'rushdown',
    chassis: 'agile',
    proportions: { height: 1.02, torso: 0.94, arms: 1.15, legs: 1.05, head: 0.9 },
    palette: {
      primary: '#232E1C',   // carapace olive-black
      secondary: '#0E120C', // matte void underside
      accent: '#9DFF3C',    // acid green wing flash
      emissive: '#7CFF00',  // bio-luminous acid glow
      trim: '#C9D2C0',      // chrome mandible edge
    },
    stats: { power: 5, speed: 9, reach: 8, weight: 4, defense: 3 },
    moveSet: 'agile',
    voice: { pitch: 1.3, timbre: 0.74, resonance: 0.38, grit: 0.44, servo: 510, impact: 470, tone: 'chitter' },
    silhouette: {
      shoulders: 0.88, chestDepth: 1.06, waist: 0.58, limbTaper: 0.40,
      backpack: 'wings', head: 'mandible', legs: 'digitigrade', plating: 'segmented',
      greeble: 0.5, cables: 4, spikes: 8, vents: 3,
    },
    build: { head: 'mandible', torso: 'carapace', dorsal: 'elytra', legs: 'digitigrade', mark: 'raptor' },
    signature: { intro: 'i.walkOn', victory: 'v.pose', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'nyx',
    name: 'NYX',
    subtitle: 'Rolls Loaded Dice',
    bio: 'A casino security unit that learned probability from the wrong side of the table. Its outcomes are fair; its inputs are not.',
    archetype: 'wildcard',
    chassis: 'arcane',
    proportions: { height: 0.97, torso: 1.04, arms: 0.93, legs: 1.08, head: 1.12 },
    palette: {
      primary: '#12101A',   // void black, oil-slick clearcoat
      secondary: '#2E1B3A', // bruised violet
      accent: '#FF2E88',    // magenta neon piping
      emissive: '#FF3FA4',  // magenta core glow
      trim: '#7BE6FF',      // iridescent cyan edge break
    },
    stats: { power: 6, speed: 8, reach: 5, weight: 4, defense: 6 },
    moveSet: 'technical',
    voice: { pitch: 1.06, timbre: 0.68, resonance: 0.55, grit: 0.5, servo: 260, impact: 380, tone: 'glitch' },
    silhouette: {
      shoulders: 0.92, chestDepth: 0.86, waist: 0.68, limbTaper: 0.52,
      backpack: 'coil', head: 'lantern', legs: 'digitigrade', plating: 'skeletal',
      greeble: 0.6, cables: 5, spikes: 3, vents: 7,
    },
    build: { head: 'lantern', torso: 'skeletal', dorsal: 'coil', legs: 'digitigrade', mark: 'rings' },
    signature: { intro: 'i.pointTaunt', victory: 'v.pose', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'bastion',
    name: 'BASTION',
    subtitle: 'Nothing Gets Past the Door',
    bio: 'Twenty years of standing in one corridor taught it that patience is a weapon and that everyone eventually swings first.',
    archetype: 'defensive',
    chassis: 'heavy',
    proportions: { height: 1.05, torso: 1.12, arms: 1.06, legs: 0.97, head: 0.94 },
    palette: {
      primary: '#2E3946',   // gunmetal blue
      secondary: '#171C24', // riot black
      accent: '#3A7BFF',    // sector blue stripe
      emissive: '#2F6BFF',  // shield field blue
      trim: '#A8B6C6',      // scuffed chrome
    },
    stats: { power: 7, speed: 4, reach: 5, weight: 9, defense: 10 },
    moveSet: 'heavy',
    voice: { pitch: 0.72, timbre: 0.34, resonance: 0.7, grit: 0.4, servo: 96, impact: 175, tone: 'bulwark' },
    // Square: the shoulders are the widest point and the waist barely narrows,
    // so the whole fighter reads as a door rather than as a body.
    silhouette: {
      shoulders: 1.50, chestDepth: 1.10, waist: 1.02, limbTaper: 0.94,
      backpack: 'tank', head: 'visor', legs: 'plantigrade', plating: 'slab',
      greeble: 0.66, cables: 4, spikes: 0, vents: 6,
    },
    build: { head: 'bunker', torso: 'wall', dorsal: 'tank', legs: 'plantigrade', mark: 'towershield' },
    signature: { intro: 'i.stanceSet', victory: 'v.systemsNominal', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'axiom',
    name: 'AXIOM',
    subtitle: 'The Textbook, Weaponised',
    bio: 'The reference chassis every other unit is measured against, and quietly furious about being called boring.',
    archetype: 'allrounder',
    chassis: 'precision',
    proportions: { height: 1.0, torso: 1.0, arms: 1.0, legs: 1.0, head: 1.0 },
    palette: {
      primary: '#F2F5F3',   // clinical white composite
      secondary: '#26403F', // teal slate underlayer
      accent: '#00C79A',    // calibration green
      emissive: '#28FFC8',  // mint diagnostic glow
      trim: '#8FA5A2',      // anodised grey-green
    },
    stats: { power: 6, speed: 7, reach: 6, weight: 6, defense: 7 },
    moveSet: 'standard',
    voice: { pitch: 1.0, timbre: 0.62, resonance: 0.5, grit: 0.1, servo: 220, impact: 300, tone: 'clean' },
    // The only fighter with nothing bolted to it. Its identity is that it is the
    // one smooth, symmetrical, uninterrupted shape in the cast, so the numbers
    // here are all deliberately near unity and the greeble budget stays low.
    silhouette: {
      shoulders: 1.06, chestDepth: 0.96, waist: 0.86, limbTaper: 0.62,
      backpack: 'none', head: 'mono', legs: 'plantigrade', plating: 'layered',
      greeble: 0.3, cables: 2, spikes: 0, vents: 5,
    },
    build: { head: 'mono', torso: 'reference', dorsal: 'none', legs: 'plantigrade', mark: 'yoke' },
    signature: { intro: 'i.stanceSet', victory: 'v.systemsNominal', taunt: 'idle.taunt', idle: 'idle.fight' },
  },

  // -------------------------------------------------------------------------
  {
    id: 'volta',
    name: 'VOLTA',
    subtitle: 'Two Hundred Amps of Bad News',
    bio: 'Substation maintenance rig, copper-wound and permanently over-charged. Every move it knows ends with something arcing.',
    archetype: 'mixup',
    chassis: 'precision',
    proportions: { height: 1.03, torso: 1.06, arms: 1.08, legs: 0.98, head: 0.93 },
    palette: {
      primary: '#8C5A2B',   // burnished copper
      secondary: '#241A12', // tar-dipped insulation
      accent: '#E4B266',    // polished brass collars
      emissive: '#F2F7FF',  // arc-white discharge
      trim: '#5E4630',      // patinated bronze
    },
    stats: { power: 8, speed: 6, reach: 5, weight: 7, defense: 6 },
    moveSet: 'standard',
    voice: { pitch: 0.86, timbre: 0.48, resonance: 0.78, grit: 0.66, servo: 140, impact: 245, tone: 'arc' },
    silhouette: {
      shoulders: 1.14, chestDepth: 1.18, waist: 1.06, limbTaper: 0.72,
      backpack: 'coil', head: 'crest', legs: 'piston', plating: 'segmented',
      greeble: 0.78, cables: 11, spikes: 2, vents: 6,
    },
    build: { head: 'insulator', torso: 'drum', dorsal: 'ladder', legs: 'piston', mark: 'coils' },
    signature: { intro: 'i.powerUp', victory: 'v.saluteCharge', taunt: 'idle.taunt', idle: 'idle.fight' },
  },
];

/** Lookup table, built once. */
export const ROSTER_BY_ID = Object.freeze(
  Object.fromEntries(ROSTER.map((c) => [c.id, c])),
);

/** Ids in select-screen order. */
export const ROSTER_IDS = ROSTER.map((c) => c.id);

/**
 * Move-set key used when a character's own set is missing from MOVES.
 * `Moves.js` always defines this one, so `MOVES[def.moveSet] ?? MOVES[DEFAULT_MOVESET]`
 * can never resolve to undefined.
 */
export const DEFAULT_MOVESET = 'standard';

/**
 * Resolve a character by id, or by index into ROSTER.
 * @param {string|number} idOrIndex
 * @returns {CharacterDef|undefined}
 */
export function getCharacter(idOrIndex) {
  if (typeof idOrIndex === 'number') {
    const n = ROSTER.length;
    return ROSTER[((idOrIndex % n) + n) % n];
  }
  return ROSTER_BY_ID[idOrIndex];
}

/**
 * Index of a character in ROSTER, or -1.
 * @param {string} id
 */
export function indexOf(id) {
  return ROSTER_IDS.indexOf(id);
}

/**
 * Chassis descriptor for a character def, never undefined.
 * @param {CharacterDef} def
 */
export function chassisOf(def) {
  return CHASSIS_TYPES[def?.chassis] || CHASSIS_TYPES.precision;
}

/**
 * Overall body mass in kilograms, derived rather than authored so it can never
 * disagree with `stats.weight` or the chassis. Combat uses it for push-out and
 * knockback scaling.
 * @param {CharacterDef} def
 */
export function massOf(def) {
  const base = 260;
  const chassis = chassisOf(def).massScale;
  const w = (def?.stats?.weight ?? 5) / 5;
  const h = def?.proportions?.height ?? 1;
  return Math.round(base * chassis * (0.55 + 0.45 * w) * h);
}
