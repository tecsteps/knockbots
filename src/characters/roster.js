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
 *  - `trim` is the character's POLISHED BRIGHT-WORK: brass, gold or nickel. It
 *    is the metal on every ring bezel, rim, fastener and edge break — and on the
 *    reference sheets that metal is the design's *second colour*, not a detail.
 *
 *    EVERY TRIM ENTRY IS AN F0, NOT A PAINT, AND THAT IS WHY THEY ALL MOVED.
 *    `RobotBuilder.resolveMaterials` builds its `trim` batch as
 *    `tint(pick('worn'), palette.trim, { metalness: 1.0 })` — the hex lands
 *    straight on `material.color` of a full conductor, where it is the
 *    normal-incidence REFLECTANCE and nothing else. A conductor has no diffuse
 *    term, so a mid-value paint swatch there does not produce "dark brass", it
 *    produces a metal that reflects a fifth of what brass reflects: the capture
 *    round measured NYX's gold bezels as "a matte brown dome ... reading as felt
 *    or clay" and VOLTA's brass shoulder disc as "chalky salmon", off entries of
 *    #D2A63F and #B98C4E. Measured F0 for the three POLISHED metals: gold
 *    #FFDE92, brass #F0D399, nickel #E1E5ED. Every entry carries the
 *    character's HUE — which is the part that was always doing the work, and
 *    the part `Materials.alloy()` renormalises anyway when it derives
 *    `kb.chrome`.
 *
 *    AND THEN THEY ALL CAME BACK DOWN, BECAUSE 77 IS NOT A DETAIL COUNT.
 *    `trim` reaches 77 builder call sites against `armorPrimary`'s 34. At the
 *    polished end of the range that is not "the bright-work on the hardware",
 *    it is MOST OF THE FIGHTER rendered as a mirror, and the r3 capture set
 *    shows the whole cast converging on it: RONIN-07 photographs as polished
 *    silver with red stripes against the darkest of the eight sheets, MANTIS as
 *    brass-and-chrome, NYX as bronze where `vesper` is black, BASTION as a
 *    silver machine with blue panels, VULKAN as a copper showroom piece against
 *    a scorched-iron sheet. Ten fighters, one substance.
 *
 *    The polished values are the top of the range and not the whole of it. Real
 *    hardware finishes cover most of a decade of reflectance — blued steel,
 *    black-oxide gunmetal, aged brass, anodised alloy, scorched iron — and the
 *    eight sheets use the DARK end far more than the bright one: `neon-ronin`
 *    and `furnace` have no bright metal on them at all, `aegis-01`'s joints are
 *    dark gunmetal, and only `atlas-7` and `volt-monk` genuinely want a large
 *    bright area. So each entry now sits where its own sheet puts it. What is
 *    NOT bought back by darkening the F0 is the polish: that lives in
 *    `kb.worn`'s roughness (0.13-0.25 delivered), which is what puts the hard
 *    travelling rim on a bezel, and it is unchanged. A dark metal with a tight
 *    lobe is a blued ring; a bright metal with a tight lobe on 77 parts is a
 *    chrome fighter.
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
 * `moveSet` / `moveBase` / `signatureMoves`
 * ----------------------------------------
 * Ten fighters used to share four move tables, which meant VULKAN and BASTION —
 * a furnace and a security door — had the same fifty-two moves with the same
 * numbers. Every character now points `moveSet` at a table of its OWN, built in
 * `Moves.js` by merging that machine's signature moves over the archetype named
 * by `moveBase`.
 *
 *  - `moveBase` is the archetype family. It still decides the shared skeleton of
 *    the list, the startup shift, the damage and reach scaling, and the display
 *    label ("Bulwark", "Wraith", "Arbiter", "Vanguard") — which is what a select
 *    screen should print, via `MOVE_SET_LABELS[def.moveSet]`, rather than the raw
 *    key.
 *  - `signatureMoves` NAMES what is unique to the machine, in authored order,
 *    finisher last, so the select screen and the command list can show "these are
 *    yours" without importing the move table. `Moves.js` DEFINES them, and it
 *    compares the two lists at load: if they ever disagree, the module throws and
 *    `tools/check.mjs` fails the build. The duplication cannot rot silently.
 *
 * `movesFor(def)` in `Moves.js` is the supported accessor and is what `Fighter`
 * calls (docs/CONTRACT-character-moves.md). `moveSet` being the character's own
 * key is belt and braces: it means the older `MOVES[def.moveSet]` lookups in
 * `CPU.js` and `TestHarness.js` land on the character table too, instead of
 * silently fighting with the archetype list.
 *
 * A character that lists no `signatureMoves` gets its archetype table verbatim,
 * so adding an eleventh fighter costs nothing until it earns a signature.
 *
 * NOTE: `signature` (below) is a different field and always has been — the four
 * intro/victory/taunt/idle CLIP ids. `signatureMoves` is the move list. Both are
 * read by the select screen and they are not interchangeable.
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
 * @property {string} moveSet            key into MOVES — the character's OWN table
 * @property {string} moveBase           archetype the signature layer merges over
 * @property {string[]} signatureMoves   move ids unique to this machine
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
      // Sheet: `furnace` — and per contract §3 this palette was already the
      // sheet's, so only two values move. The plates come up from #4A2B1E: on
      // that sheet they are clearly oxide RED over dark steel, and at the old
      // value, with the grime no longer smeared over the faces to lift them,
      // the primary was collapsing toward the secondary. The soot black gains a
      // little steel for the same reason — it is the underlayer, and an
      // underlayer that is nearly zero is a hole rather than a surface.
      primary: '#5C3226',   // scorched iron, oxidised warm
      secondary: '#242220', // soot-blackened steel
      // `armorAccent` is `tint(pick('worn'), palette.accent)` at metalness 0.9,
      // so this hex is a conductor's F0 and not a coat of paint. At #FF6A1A it
      // was a saturated orange MIRROR on 23 call sites, which is where the
      // capture's candy-orange came from; the sheet's hazard bands are painted
      // hot steel that has been through a fire. Same hue, a stop of reflectance
      // out of it, so it stops competing with the vent glow directly above it.
      accent: '#E05E18',    // molten orange hazard bands
      // Pushed off 11° to 17°: RONIN's crimson sits at 350° and the two were
      // the closest pair on the wheel, which the "distinct hue per character"
      // rule above exists to prevent.
      emissive: '#FF4A08',  // furnace red-orange
      // THE `furnace` SHEET HAS NO BRIGHT-WORK ON IT. Every rivet, collar and
      // joint barrel on that character is dark scorched steel; the only bright
      // thing anywhere is the vent light. `trim` is on 77 builder call sites
      // against `armorPrimary`'s 34, so a #E6BE84 there was not "hot brass on
      // the hardware", it was a brass fighter — pair0-vulkan-body reads as a
      // copper-and-salmon showroom piece with a dark red wash, which is the
      // opposite of the sheet. Reflectance is what a metal's darkness lives in
      // once roughness is already at its ceiling, and blackened iron genuinely
      // sits well under polished stock: this is about a stop and a half under
      // ANVIL's aged brass, in the same family BASTION's blued steel is in.
      trim: '#AE9375',      // scorched steel, warm oxide cast, F0
    },
    stats: { power: 10, speed: 3, reach: 7, weight: 9, defense: 5 },
    moveSet: 'vulkan',
    moveBase: 'heavy',
    signatureMoves: ['slagVent', 'pourOff', 'tapOut', 'bessemerPour'],
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
      // Derived — `ghostframe` frame with `volt-monk` surfacing (contract §3),
      // which asks for arctic white / cobalt / cyan and gets it unchanged. The
      // only move is the trim, which brightens to a real polished aluminium now
      // that it drives a mirror lobe rather than a wear tint.
      // r7: "KESTREL's 'arctic white' plates render warm cream/beige, and the
      // shoulder canard is washed pink across its whole face by the arena's
      // magenta kicker". #E8EEF5 is only 4% cooler than neutral, which is not
      // enough hue for a light surface to hold against a warm key plus a magenta
      // fill — a near-neutral takes whichever coloured light is facing it, the
      // same failure SERAPH's pearl had two rounds ago. Value up (0.96 -> 0.99)
      // so it stays at the top of the range under the key, and the blue-grey
      // cast roughly doubled so the magenta has something to cancel against.
      primary: '#EDF4FD',   // arctic enamel, blue-grey neutral
      secondary: '#1E2A38', // deep slate underskin
      accent: '#00A8FF',    // cobalt racing stripe
      emissive: '#31E8FF',  // cyan coolant glow
      // Was #DCE3EB. Arctic white primary plus a near-white metal on the 77
      // trim sites left nothing between the two: pair0-kestrel-body is one
      // continuous white-and-chrome figure whose cobalt only survives on the
      // shins. `volt-monk`'s surfacing — which §3 hands this fighter — works
      // because its metal is a full value step DARKER than its shell, and that
      // step is the only thing making the joint rings visible on a white body.
      trim: '#B6C3D2',      // brushed aluminium, a step under the shell, F0
    },
    stats: { power: 4, speed: 10, reach: 6, weight: 3, defense: 5 },
    moveSet: 'kestrel',
    moveBase: 'agile',
    signatureMoves: ['slipstream', 'slipstream2', 'coolantLance', 'terminalVelocity'],
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
      // Sheet: `atlas-7` — "olive → safety yellow, BRASS TRIM STAYS" (§3), and
      // the trim was the one thing that had not: greasy oxide steel is what a
      // wear mask exposes, not what a diving-suit's hub rings and rivet collars
      // are made of. Every close-up tile on that sheet is dominated by warm
      // brass hardware over olive plate, and this is now the material that
      // carries it. The oil black warms toward the sheet's olive-black so the
      // exposed frame belongs to the same machine as the plates.
      // #D6A017 -> #C8871C. §3 says "olive -> safety yellow" and it still is
      // one; what moves is how much green the hue has to spare. The arena rims
      // the fighters with a strong GREEN-cyan bounce off the deck, and a paint
      // whose green channel is already three quarters of its red has nothing to
      // defend with: pair1-seraph-body.png photographs these plates as
      // CHARTREUSE — a yellow-green that is not in this palette and is not on
      // the `atlas-7` sheet either. That sheet's shell is an olive-BRASS: warm,
      // ochre, red-leaning, which is exactly the direction that survives a green
      // rim, because green added to an amber lands back on yellow instead of
      // running past it. G/R goes 0.75 -> 0.68 and the value drops a little with
      // it, so the bone banding above still reads as the lighter of the two.
      // ROUND 7 REVERSES THE LAST STEP, AND THE MEASUREMENT SAYS SO.
      // #C8871C was chosen to defend against the arena's green bounce by taking
      // green out of the hue. It did not defend against anything — r7 measures
      // the plate at CHARTREUSE in pair1-seraph-body regardless — and it cost
      // the fighter its own colour in the frame where the paint IS the read:
      // over the lit body in pair1-anvil-body, 73% of saturated pixels fall in
      // hue 20-45 (orange) and only 6% in the 45-65 yellow band, with dominant
      // swatches #f0b040 / #f0a030 / #e08010. §3 says "olive -> SAFETY YELLOW"
      // and #C8871C at hue 37 deg is an amber; there is no framing in which it
      // reads as one.
      //
      // The chartreuse was never this hex's to fix. It is the ARENA: a rim at
      // intensity 10.4 in a saturated cyan against a key at 7.6 is a second key,
      // and diffuse albedo times cyan light is green for ANY yellow, at any
      // saturation — the hue of the product is set by the light, not by the
      // paint. What a palette can do about it is (a) sit high enough in value
      // that the rim-lit side washes toward white rather than toward a saturated
      // secondary, and (b) stop the ENVIRONMENT adding a third coloured term on
      // top, which is `kb.armor`'s envMapIntensity 1 -> 0.72 this round.
      //
      // So: hue 37 -> 52 deg, value 0.78 -> 0.91. Rendered hue lands about 4-9
      // deg warm of the palette (measured: #C8871C at 37 photographs at 33), so
      // 52 puts the lit body inside the 45-65 band the audit asks for. The bone
      // banding below now separates by CHROMA rather than by value — a low-
      // saturation cream against a hi-vis yellow of the same lightness, which is
      // how `atlas-7` bands its shell — instead of by the value step it used
      // when the primary was a mid-value amber.
      primary: '#DEC62C',   // safety yellow, hi-vis, warm of true lemon
      // `atlas-7` is a TWO-PAINT character and this is the second paint. Read
      // the sheet: an olive shell banded, at chest, upper arm and thigh, with
      // a wide cream/bone stripe — that banding is most of what stops a
      // super-heavy from reading as one undifferentiated lump. §3 turns the
      // olive into safety yellow and says nothing about the bone, because the
      // bone was never the thing that needed changing. At #2B2820 the second
      // paint was a near-black that lands almost nowhere the eye can see it,
      // and pair1-anvil-body came back as a single flat yellow mass with no
      // internal division at all. Warm and light, so it separates from the
      // yellow by hue and chroma rather than by value — a bone band on a yellow
      // plate is exactly the sheet, where a grey band would be a dead zone.
      // Lifted with the primary so the pair still reads as two paints: at
      // #C4B491 against a 0.91-value yellow the band would have gone from "the
      // lighter of the two" to a dull shadow, and a super-heavy needs that
      // division to stop being one lump. Same hue, chroma held low.
      secondary: '#DED4B4', // bone banding, `atlas-7`'s second paint
      // `armorAccent` is a conductor's F0 at metalness 0.72 and gold times this
      // arena's cyan deck bounce is GREEN — the file has now measured that three
      // times (ANVIL's shield interior at 62,117,11 in r5, "a saturated emerald
      // gradient" on pair1-anvil-head in r4). Green is what the accent's own G/R
      // ratio buys the reflection, so it comes down: 0.77 -> 0.71, with a little
      // value out of it too. Still unmistakably a hazard gold on a yellow shell.
      accent: '#F2AD35',    // hazard chevrons
      emissive: '#FFD21A',  // amber warning strobes
      // `atlas-7`'s whole second colour, and the one fighter in the cast whose
      // sheet genuinely wants a large area of bright-work. It still comes down
      // from #EFD9A2: that value is polished showroom brass and the sheet's
      // hubs are AGED — a dockyard rig that has been outside for a decade. This
      // is still unmistakably brass against the yellow, and it stops the trim
      // batch out-reflecting the plates it is supposed to be hardware on.
      trim: '#D3B172',      // aged brass hubs and collars, F0
    },
    stats: { power: 9, speed: 4, reach: 5, weight: 10, defense: 7 },
    moveSet: 'anvil',
    moveBase: 'heavy',
    signatureMoves: ['throwFwd', 'dockClamp', 'counterweight', 'loadTest'],
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
      // Sheet: `ghostframe` — "pearl → porcelain, halo/fins tinted violet" (§3).
      // Two corrections against the sheet: its dark is a GRAPHITE ribbed spine,
      // not a dyed indigo, and its metal is bright nickel throughout — there is
      // no gold anywhere on that character. Aged temple gold against porcelain
      // and violet was a third colour story fighting the other two, and it was
      // the more visible for being handed a mirror lobe this round.
      //
      // AND IT STILL CAME OUT WHITE. pair1-seraph-body has no violet anywhere
      // on the body — a bone-white figure taking the arena's blue rim on one
      // side and its warm key on the other, which is what a near-achromatic
      // palette does under coloured light: it stops being the character's
      // colour and becomes the room's. `ghostframe` is not white. It is a
      // PEARL, and a pearl is a light surface that carries a hue; every plate
      // on that sheet has a lilac-to-cyan shift in it and the sheet's own
      // darks are graphite. Three of the four paint values move toward the
      // violet so that the fighter has a hue of its own to defend with:
      //  - primary keeps its value and gains chroma, so it reads pearl-lilac
      //    rather than paper;
      //  - accent, which is a metal F0 on 23 sites, goes properly violet
      //    instead of being a lilac two shades off the primary;
      //  - trim comes off bright nickel. §1.4 wants the bezels to read, and on
      //    a WHITE body a white metal cannot: `ghostframe`'s hardware is the
      //    graphite frame with a polished edge, so this is a pewter with the
      //    same violet cast, which is a value step under the shell and visible
      //    on it. Bright nickel on 77 sites is also half of why this fighter
      //    photographed as one continuous white mass.
      // SECOND PASS, AND THE CHROMA GOES UP AGAIN. The first set of numbers
      // fixed the chrome (the nickel trim was half the fighter) but the body
      // still photographed neutral: pair1-seraph-body has violet on the dorsal
      // fins and NOWHERE else, because a 4%-chroma pearl under a warm key and a
      // cyan deck bounce is whichever of those two is facing it. The sheet's
      // pearl is not a 4% tint — every plate on `ghostframe` runs lilac through
      // cyan across its own curvature. Chroma is the only defence a light
      // surface has against coloured light, so all three paint values carry
      // more of it, and the trim stops being a neutral pewter and becomes the
      // violet-grey the sheet's frame actually is.
      primary: '#DDD1F4',   // pearl porcelain, lilac cast
      // Third pass, and this is where the violet finally gets area. `secondary`
      // is 41 builder call sites — more than the primary — and it was the one
      // value in this palette still doing its job in neutral. A DARK violet is
      // not the mistake NYX's #2E1B3A was: that one was a large chromatic paint
      // on a fighter whose sheet is black plus gold plus one line, where this
      // fighter's sheet is pearl over a dark body with violet running through
      // it. Held under 0.28 value so it stays the character's dark rather than
      // becoming a third paint.
      secondary: '#2B2540', // violet-graphite spine
      accent: '#9B6BFF',    // violet inlay
      emissive: '#8A4CFF',  // violet field glow
      // ROUND 7: #B3A9CB is 0.42 linear luma, which puts {@link trimPolish} at
      // its ceiling — full mirror lobe, full environment weight — on the 100
      // builder call sites this hex reaches. The audit finds the consequence:
      // "behind SERAPH's shoulder sits a stack of chocolate-brown/copper
      // rectangular slabs ... they read as a different character's parts". They
      // are not a different character's parts and they are not brown paint;
      // they are this metal returning an image of a warm room. `ghostframe`'s
      // hardware is its graphite FRAME with a polished edge, not a bright pewter
      // shell, so this drops to a third of its reflectance — which also drops
      // trimPolish to ~0.7 and hands the material the satin lobe a frame member
      // has, while the violet cast is kept and strengthened so what does catch
      // the light belongs to this fighter's colour story.
      trim: '#8B82A8',      // violet-graphite frame metal, satin, F0
    },
    stats: { power: 6, speed: 6, reach: 9, weight: 4, defense: 4 },
    moveSet: 'seraph',
    moveBase: 'technical',
    signatureMoves: ['chorale', 'chorale2', 'descant', 'finalCadence'],
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
      // Sheet: `neon-ronin` — "teal/magenta → lacquer black / crimson" (§3).
      //
      // THE BONE SHOULDER PLATES ARE GONE. The argument for them was 40px
      // separation from NYX, and it was answered with the wrong field: the
      // builder puts `armorSecondary` on 41 call sites against `armorPrimary`'s
      // 34, so a pale secondary is not "a pale mass on the shoulder stack", it
      // is more than half the fighter. The capture round read RONIN-07 as
      // "chalky sand-beige with red-and-white candy stripes ... the value is
      // light, not lacquer" — against a sheet that is the darkest of the eight.
      // Silhouette separation is a shape problem and §3 hands it to the kabuto,
      // the spike stacks and the scabbards; it cannot be bought by breaking the
      // one thing the sheet is actually about.
      //
      // Graphite rather than a second black: the lacquer needs something a stop
      // above it to sit against or the panel layout stops reading at all, and
      // graphite is what `neon-ronin`'s underskin panels are. Against NYX —
      // black, gold rings, magenta line — this is black, GREY, crimson, nickel:
      // separated by hue and by trim metal, not by value.
      primary: '#141418',   // lacquer black
      secondary: '#33363D', // graphite underskin panels
      accent: '#FF2B45',    // crimson cord wrap
      emissive: '#FF1A3C',  // crimson blade-edge glow
      // AND THE NICKEL WENT THE SAME WAY THE BONE PLATES DID, FOR THE SAME
      // REASON. The lacquer landed; the fighter did not. pair2-ronin-body is a
      // POLISHED SILVER robot with red stripes, because `trim` is 77 call sites
      // and a #D6DAE2 conductor at roughness 0.13-0.25 beats a black plate for
      // the eye every time. `neon-ronin` is the darkest of the eight sheets and
      // there is no bright metal on it at all — its hardware is dark gunmetal
      // that shows as a rim and nothing more. Separation from NYX survives this
      // and is better for it: NYX is black with GOLD rings, this is black with
      // dark steel and a crimson line.
      // Second pass: #838A94 stopped the silver and left a BRONZE. A neutral
      // metal under this arena's warm key is a warm metal — physically right,
      // and on 77 call sites it means the lacquer never gets to be the read.
      // Black-oxide conversion coating is a real finish on a real blade and it
      // reflects a fraction of bare stock; this is what the sheet's hardware
      // is, and at this level the joint rings still show the hard bright rim
      // §1.4 wants, because that rim is roughness 0.13-0.25 and not F0.
      // Third pass, and the last move is HUE rather than value. At #5F656E the
      // silver is gone and pair2-ronin-body reads BRONZE, because a neutral F0
      // under this arena's warm key reflects a warm key — the reflection is the
      // whole of a conductor's colour and a neutral one has no opinion of its
      // own. Black oxide on steel is genuinely blue-black, so leaning it cool
      // gives the metal something to answer the key with, and lacquer black
      // plus a cool-dark hardware plus a crimson line is `neon-ronin`.
      // Fourth pass. #545C6A is dark (0.114 linear luma) and it is cool, and
      // r4's pair2-ronin-body.png STILL photographs a gold samurai — so the
      // premise of the last three passes was wrong. A conductor has no colour of
      // its own; what the camera sees is F0 times the environment, and
      // `kb.worn` was reflecting this arena's warm key at roughness 0.13-0.25
      // with envMapIntensity 0.95, which is a mirror. A mirror of a warm room is
      // warm at ANY F0, so no amount of hue on this hex was ever going to reach
      // it. The lobe is fixed in Materials.js (`trimPolish`, derived from this
      // entry's own reflectance: a blackened finish is dark BECAUSE it is a
      // rough conversion layer, so it gets the satin lobe it physically has).
      // This hex goes with it rather than instead of it — 0.037 linear luma is
      // where black oxide on steel actually sits, a third of what was here, and
      // between the two the reflection drops by about a factor of five. Lacquer
      // black, dark steel hardware, one crimson line: `neon-ronin`.
      trim: '#2F3742',      // black-oxide gunmetal, cool, rim-only bright-work, F0
    },
    stats: { power: 7, speed: 7, reach: 6, weight: 5, defense: 6 },
    moveSet: 'ronin',
    moveBase: 'technical',
    signatureMoves: ['iaiDraw', 'iaiNoto', 'kesaLine', 'seventhSerial'],
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
      // Derived — the `neon-ronin` language (§3): bladed carapace, carbon
      // underskin, neon grooves, acid green. Unchanged apart from the underside,
      // which comes up off near-zero: it is the colour the exposed frame and the
      // underskin are alloyed from, and at 0.055 luma both came out as holes.
      // THE ACID GREEN WAS NEVER ON A PAINTED SURFACE, AND THAT IS THE FAULT.
      // §3 for this fighter reads "carbon underskin ... ACID GREEN", and the
      // build put the green on `accent` and `emissive` — a conductor's F0 on 23
      // sites and a glow — while `primary` and `secondary` were an olive-black
      // and a near-black four percent apart. Two near-identical darks over 75
      // painted call sites is not a two-value scheme, it is one value, so the
      // only colour the fighter had left was whatever its metals reflected: r7
      // measures "one shoulder carries salmon pink on top, cyan on the front and
      // gold in the middle; the body is army olive with red patches ... acid
      // green survives only as small lime slivers on the visor and horn".
      //
      // So the green moves to where the area is. `primary` becomes the acid
      // green PAINT of the shells (§1.6: clean automotive paint on the primary
      // plates, polished metal on trim only) and `secondary` stays the near-black
      // carbon it always was, which is the "two values" the audit asks for —
      // acid-green shells over carbon underskin. It is a chromatic mid-value, so
      // it satisfies this file's opening rule the way a saturated colour does
      // rather than the way a light one does.
      primary: '#8CB92E',   // acid-green painted carapace
      secondary: '#161B14', // matte void carbon underside
      // Comes down off #9DFF3C. With the primary now carrying the acid green,
      // an accent a shade BRIGHTER than the shell would invert the hierarchy and
      // put the loudest value on the smallest area; and this hex is a metal F0,
      // so its brightness is bought straight out of the arena's reflection.
      accent: '#6FA51E',    // deep acid wing flash, one value under the shell
      emissive: '#7CFF00',  // bio-luminous acid glow
      // Follows RONIN-07 down and for the same reason — this fighter is in the
      // same `neon-ronin` language (§3) and pair2-mantis-body came back as a
      // brass-and-chrome insect with green flashes rather than a carbon one.
      // The mandible EDGE is bright on the sheet; the 77 sites this hex reaches
      // are not all mandible edges.
      // Follows RONIN-07 down a second time for the same reason: at #8B9386
      // pair2-mantis-head is an olive-BRONZE insect, and the carbon carapace
      // this fighter is supposed to be cannot be seen past 77 sites of warm
      // metal.
      // Third pass with RONIN-07, same mechanism: at #62685C the metal took the
      // warm key and pair2-mantis-body came back KHAKI. Cool and dark, so the
      // carapace olive is the fighter's colour and the hardware is shadow.
      // Fourth pass, one more step down, and this time with the lobe fixed under
      // it: r7 still photographs MANTIS's shoulder and torso as CHROME — "one
      // plate runs teal to gold to salmon across its face". #545A54 is 0.084
      // linear, which lands trimPolish at 0.05, so `kb.worn` was already giving
      // it the oxide roughness and the low env; what it was not giving it was a
      // rough enough LOBE (0.19-0.36 delivered still resolves individual
      // practicals) or any relief from the clearcoat over the top. Both are
      // fixed in Materials.js this round. This goes with them rather than
      // instead of them, to where a carbon-frame fastener actually sits.
      trim: '#3E443E',      // black-oxide gunmetal, cool olive cast, F0
    },
    stats: { power: 5, speed: 9, reach: 8, weight: 4, defense: 3 },
    moveSet: 'mantis',
    moveBase: 'agile',
    signatureMoves: ['raptorRake', 'raptorRake2', 'raptorRake3', 'raptorRakeUp', 'harvest'],
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
      // Sheet: `vesper` — "violet → magenta, adds lantern-head lens" (§3).
      // THE GOLD IS THE POINT. Every joint on that sheet carries a brass ring
      // bezel and they are the character's entire second colour against the
      // gloss black; an iridescent cyan trim was a fourth hue on a character
      // whose whole design is black + gold + one glow, and it read as a smear
      // of the emissive rather than as hardware.
      // The secondary comes down hard. `vesper` is gloss black, gold and ONE
      // thin edge colour; a #2E1B3A on the builder's 41 `armorSecondary` sites
      // is a third large area of chromatic paint, and the capture read NYX as
      // "bubblegum pink, teal, mint and gold at once ... no glossy black
      // anywhere". At #171320 the second body is black with a violet cast in it
      // and the gold rings have something to be gold against.
      primary: '#12101A',   // void black, oil-slick clearcoat
      secondary: '#171320', // black with a bruised-violet cast
      accent: '#FF2E88',    // magenta neon piping
      // Three fighters own the red half of the wheel — VULKAN's furnace orange,
      // RONIN's crimson and this — and the three were bunched at 11°/350°/328°,
      // two of them 17° apart, which the bloom pass cannot separate. Spread to
      // 16°/350°/322° they sit about 27° apart each, which is the widest the
      // three can be without one of them ceasing to be its character's colour.
      emissive: '#FF34B4',  // magenta core glow
      // Was the textbook sRGB F0 for polished gold. The gold is still the point
      // and this is still gold — it comes down because "it is on 77 call sites"
      // is an argument in BOTH directions and the capture settled it:
      // pair3-nyx-body is a bronze figure with black showing through, where the
      // sheet is a BLACK figure with gold rings on it. `vesper`'s bezels are
      // antique, not showroom; at the textbook value the hardware stopped being
      // jewellery on a black body and became the body. Two thirds of the way
      // down to the blued steels keeps the hue, keeps the bright rim §1.4 asks
      // for — that rim is roughness 0.13-0.25 doing the work, not F0 — and
      // hands the gloss black back the area it is supposed to own.
      // Second pass, one more step: pair3-nyx-body is now recognisably `vesper`
      // — gloss black torso, gold hardware, magenta line — but the limbs still
      // read gold rather than black with gold ON them, which is the whole
      // composition of that sheet.
      // Third pass, and it is the last one this hex can carry alone. r4's
      // pair3-nyx-body.png still has the torso, arms and thighs reading
      // gold-bronze against a sheet that is void black. #D0A95C is 0.42 linear
      // luma — that is not "antique", it is the polished value with a shade
      // taken off, and on 77 builder call sites at roughness 0.13-0.25 it was
      // simply the fighter. Genuine antique gold is a tarnish layer and sits
      // near a sixth of polished stock; this is 0.16, which is a THIRD of what
      // was here and still unmistakably gold next to a 0.006 lacquer black.
      // The other half of the fix is in Materials.js: `trimPolish` reads this
      // number's own reflectance and gives a dark entry the satin lobe a
      // tarnished finish physically has, so the gold stops mirroring the
      // arena's warm key across the whole limb. The BEZELS still catch it —
      // that rim is roughness and geometry, not F0 (§1.4).
      // ROUND 9: THE BEZELS PHOTOGRAPH GRASS-GREEN, AND IT IS THE RIM.
      // Measured 7x7 on pair3-bastion-body, NYX's hip disc is hue 153 and its
      // knee disc hue 161 — a colour that is in no part of this palette. The
      // arena's `rim` is 0x18dcff at intensity 10.4 against a key at 7.6, so on
      // any face turned away from the key the dominant light is a saturated
      // cyan; and a conductor has no colour but F0 x light. #8A6A33 in linear is
      // (0.256, 0.144, 0.033), so cyan light comes back as (~0, 0.105, 0.033) —
      // green with three times the green of the blue. This is the same product
      // that made ANVIL chartreuse for four rounds.
      //
      // There is no gold that survives it. A search over the R/G/B cube finds
      // ZERO hexes with saturation >= 0.48 and a key-lit hue in the gold band
      // whose cyan reflection lands past hue 158: a saturated gold is by
      // definition low in blue, and low blue under cyan light is green. What a
      // palette CAN buy is how bright and how far round that green sits, and
      // both are bought in the same direction — redder and a shade more
      // saturated. Measured on the two lights: the rim's reflected luminance
      // drops 0.80 -> 0.61 (-24%) and its hue moves 151.5 -> 161.0, i.e. from
      // grass to a dark sea-green that reads as cyan light ON metal rather than
      // as green paint; the key-lit face keeps 0.78 of its 0.87 luminance and
      // stays unmistakably warm metal, which is what `vesper`'s bezels — this
      // character's entire second colour — have to keep doing.
      //
      // Every other trim in the cast was measured the same way. Reflected-rim
      // hue: KESTREL 193, SERAPH 201, RONIN 197, BASTION 200, AXIOM 185, MANTIS
      // 184, VOLTA 184, VULKAN 175 — all cyan-to-blue, none at risk. Only ANVIL
      // (163) is anywhere near this failure, and it is left alone deliberately:
      // its shell is a 0.91-value hi-vis yellow, so its brass hubs have nothing
      // to contrast against and no green reads on them in pair1-anvil-body.
      trim: '#8E5C38',      // tarnished antique gold, red-shifted off the rim, F0
    },
    stats: { power: 6, speed: 8, reach: 5, weight: 4, defense: 6 },
    moveSet: 'nyx',
    moveBase: 'technical',
    signatureMoves: ['houseEdge', 'doubleOrNothing', 'snakeEyes', 'lastHand'],
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
      // Sheet: `paladin` — "ivory → gunmetal blue primary, red accents → sector
      // blue" (§3), which this palette already was. What moves is the riot
      // black: the paladin sheet is layered plates over a NAVY under-suit, and
      // that navy is the sheet's second-largest area. It also feeds the alloy
      // the structural frame is tinted from, so a near-neutral black there gave
      // BASTION a colourless skeleton under a blue skin.
      // Deepened off a muddy mid-grey-blue. The file's own first design rule
      // rules out mid-greys under rim light and #2E3946 was one; the capture
      // round separately found BASTION's chest reading as "the brightest object
      // in the frame, brighter than the practical strip lights behind it".
      primary: '#27364A',   // gunmetal blue
      // r7: "BASTION is a single blue value from helm to boot — plates,
      // underlayer and accents all sit in hue 200-220. `paladin`'s read depends
      // on light plate over a DARK underlayer with a contrasting trim line."
      // The primary is signed off and stays; the underlayer takes the value step
      // instead, a stop down and a shade bluer, so the layered-plate silhouette
      // §3 asks for has something to be layered over.
      secondary: '#131B2E', // navy underlayer, a stop under the plate
      // And the trim line separates by VALUE the other way. #3A7BFF was already
      // §3's sector blue but it sits at the same lightness as the primary once
      // the arena has lit both, so the two merged; this is a full step brighter
      // and higher-chroma, which is what makes a stripe read as a stripe at
      // silhouette distance.
      accent: '#5C9BFF',    // sector blue stripe
      emissive: '#2F6BFF',  // shield field blue
      // The one trim in the cast that is deliberately NOT bright-work. Look at
      // the `paladin` sheet: its bright mass is the ivory SHELL, and every ring,
      // collar and joint barrel on it is dark blued steel. BASTION inherits that
      // reading, and it also has to: the builder puts `trim` on 77 call sites
      // against `armorPrimary`'s 34, so a nickel F0 here turns the whole
      // defensive fighter into chrome — which is what the first capture of this
      // round showed. #9EABBB was the right diagnosis and half a step:
      // pair3-bastion-head still photographs as a SILVER machine with blue
      // panels rather than a blue machine with steel hardware. Blued steel
      // covers a wide band — roughly 0.2 to 0.4 linear, depending on how far
      // the bluing went — and this sits at the dark end of it, which is where a
      // door that has been standing in one corridor for twenty years belongs.
      // ...and a third step, with the HUE finally doing some of the work.
      // pair3-nyx-body still has BASTION as a silver machine with blue panels,
      // and the reason a near-neutral keeps winning is that it is neutral: the
      // 77 trim sites and the 34 primary sites are the same object to the eye
      // unless they share a colour. Bluing is an iron oxide and it is BLUE;
      // giving this the primary's hue makes the hardware belong to the plate
      // instead of competing with it, and §3's "gunmetal blue" then describes
      // the whole fighter rather than a third of it.
      // ...and a FOURTH step, because r7 finally identifies what the "silver
      // machine with blue panels" actually photographs as, and it is worse than
      // silver: "large CRIMSON panels (#b04050, #903040) sit on BASTION's
      // shoulder, hip and thigh, directly adjacent to navy plates at the same
      // orientation — so it is pigment, not rim light". It is neither. #6D8199
      // is a near-NEUTRAL conductor at 0.21 linear luma, which put trimPolish at
      // 0.70 — a mirror lobe at env 0.90 — and a neutral mirror has no colour of
      // its own at all: on the side of the arena where the red practical bank
      // and the magenta kicker dominate, it returns crimson; on the other side
      // it returns silver. Same material, same frame, two "pigments".
      // Under 0.13 linear the entry lands at trimPolish ~0.21, which in
      // Materials.js this round means the satin lobe, half the environment
      // weight and almost no clearcoat — a blued steel that shows a rim and
      // nothing else, which is what every ring and collar on `paladin` is.
      trim: '#4E6480',      // dark blued steel, blue-shifted, F0
    },
    stats: { power: 7, speed: 4, reach: 5, weight: 9, defense: 10 },
    moveSet: 'bastion',
    moveBase: 'heavy',
    signatureMoves: ['counterStance', 'blastDoor', 'holdTheLine', 'lockdown'],
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
      // Sheet: `volt-monk` — "brass → anodised grey-green, cyan → mint" (§3),
      // both already here. The underlayer darkens: on that sheet the exposed
      // spine and joint mechanism is the darkest thing on the character by a
      // wide margin, and #26403F was light enough to read as a third paint.
      primary: '#F2F5F3',   // clinical white composite
      secondary: '#1C2E2D', // dark teal slate underlayer
      // §3 says "cyan -> MINT", and #00C79A is not a mint: measured off
      // pair4-axiom-body it delivers a saturated emerald, sat 0.90, "applied as
      // broad blobs covering ~40% of each knee cap plus wedges on shin, thigh
      // and toe bands". A mint is a pale, high-value, low-chroma green, and on
      // `volt-monk` — the cleanest surfacing in the cast, which is the whole
      // reason §3 hands AXIOM that sheet — the second colour is a tint on a
      // white body, not a second body colour. The AREA is RobotBuilder's to fix;
      // what a palette can do is stop the colour shouting at the area it has.
      // sat 0.90 -> 0.36, value 0.78 -> 0.87.
      accent: '#8FDEC0',    // pale mint calibration tint
      // Pushed 166° -> 159°. KESTREL's coolant cyan sits at 187° and these two
      // were the closest pair on the wheel after the red half was spread; the
      // bloom pass separates fighters by emissive hue and 21° is not a
      // separation. `volt-monk`'s glow is a green-leaning cyan anyway, so the
      // move is toward the sheet rather than away from it.
      emissive: '#1FFFB0',  // mint diagnostic glow
      // §3 turns `volt-monk`'s brass into anodised grey-green. Anodising is a
      // transparent oxide over the metal, so the substrate's reflectance is
      // still a metal's — only the hue shifts. #8FA5A2 was the hue with the
      // metal taken out of it.
      //
      // What #C6D4CC then got wrong is the other half: it sits so close to the
      // white composite in value and chroma that on pair4-axiom-body the two
      // zones merge and the fighter reads as one cream mass with green pips.
      // `volt-monk`'s trim is legible from across the room because it is a WARM
      // metal against a COOL white — a full step of contrast at every joint
      // ring. Anodising is the wrong direction to buy warmth in, so the step is
      // bought in value and chroma instead.
      trim: '#9FB3A8',      // anodised grey-green, F0
    },
    stats: { power: 6, speed: 7, reach: 6, weight: 6, defense: 7 },
    moveSet: 'axiom',
    moveBase: 'standard',
    signatureMoves: ['errata', 'errata2', 'footnote', 'qed'],
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
      // Sheet: `aegis-01` — "blue/orange → burnished copper / brass, arc-white
      // emissive" (§3). The copper comes up a step: aegis's primary is a
      // saturated mid-value blue over most of the body, and its copper
      // counterpart has to hold the same place in the value range or the
      // heavyweight reads as a brown mass. The trim goes from patinated to
      // POLISHED — the sheet's shoulder hubs and knuckle collars are bright,
      // and patina is exactly the surface a mirror lobe cannot represent.
      //
      // ROUND 9, AND THE MEASUREMENT SAYS THE HEX IS THE FAULT, NOT THE BATCH.
      // r9 reads VOLTA as gold/amber and next-door to ANVIL. The first thing to
      // rule out was the plates being drawn in the wrong batch — they are not:
      // the domed pauldron cap on `aegis-01`'s plan is `armorPrimary` (the boss
      // loft in `buildShoulder`), and sampled 7x7 on pair4-volta-body it comes
      // back #9a5c2e / #af5e24, which IS this entry rendering faithfully. So
      // #9A6331 is what "gold" looks like on screen: hue 26 deg at saturation
      // 0.51 is a TAN, and a tan under a 7.6-intensity sodium key is an amber.
      // Over VOLTA's whole body the saturated pixels ran 35% in hue 20-30 and
      // 20% in 30-40, against ANVIL's lit plates at hue 49-53 — close enough on
      // the wheel that at fight distance the two are one warm machine.
      // Copper is not a desaturated orange, it is a RED metal: hue 26 -> 19.5
      // and saturation 0.51 -> 0.75, with the value held at 0.62 so the point
      // the previous note makes — that aegis's mid-value primary cannot become
      // a brown mass — still holds. Against ANVIL that is now 30 deg of hue and
      // a full 0.25 of value, and against VULKAN's #5C3226 scorched iron (same
      // half of the wheel) it separates by value the other way: 0.62 to 0.36.
      primary: '#9E5628',   // burnished copper, red not amber
      secondary: '#2A2119', // tar-dipped insulation
      // Pulled warm and down a step. §3 allows this fighter "burnished copper /
      // brass with arc-white emissive" and nothing else, and r7 reads
      // "olive-green panels on hip and thigh". Green on a copper machine is a
      // gold F0 multiplied by this arena's cyan deck bounce — the same product
      // that has been turning ANVIL's accent emerald — and the G/R ratio of the
      // hex is what buys it: 0.78 -> 0.72, with the value off the top so the
      // band stops out-reflecting the copper plate it bands.
      // And the second half of the gold: `armorAccent` is a conductor at
      // metalness 0.72, so its brightness is bought from the room rather than
      // from a paint film. Reflected against this arena's key (0xffc98e at 7.6)
      // #C8934A returns 1.87 relative luminance where the copper plate it is
      // supposed to be banding returns 0.84 — the trim line was out-shining the
      // shell more than two to one, and a warm metal twice as bright as the
      // paint around it IS the fighter's colour whatever the palette says. Down
      // a stop to 1.51 and the hue held at brass (34 deg), which now sits 15 deg
      // off the copper instead of 8 — a band that reads as a different metal
      // from the plate rather than as a lighter patch of the same one.
      accent: '#B8843C',    // brass collars, burnished not polished
      emissive: '#F2F7FF',  // arc-white discharge
      // Read `aegis-01` again for what its metal actually is: the plates are
      // paint, the BANDS are the second paint, and every joint barrel, hub and
      // knuckle collar between them is dark gunmetal. There is no brass
      // hardware on that sheet. §3's "burnished copper / brass" names the two
      // PAINTS — which `primary` and `accent` already carry — so putting a
      // polished brass on the 77 trim sites as well made a third brass area
      // larger than either of them, and pair4-volta-body came back as a brass
      // machine with copper panels. Warm-tinted dark gunmetal puts the
      // hardware back underneath the paint, where the sheet has it.
      // Second pass, and "dark gunmetal" was the right words on the wrong
      // number. #A0958A is 0.30 linear luma, which is the TOP of the
      // {@link trimPolish} window — full mirror lobe, full clearcoat, env 0.95 —
      // so the entry the comment calls dark hardware was rendering as the
      // brightest, most reflective substance on the fighter, across 100 builder
      // call sites. r7: "a salmon-pink panel across the abdomen ... the drum
      // torso reads cyan-teal", on a palette that contains neither. Both are
      // this material returning an image of the room. Under 0.13 linear it lands
      // at trimPolish ~0.21 and picks up the satin lobe, the halved environment
      // and the near-zero clearcoat this round's Materials.js gives an oxide
      // finish — which is what `aegis-01`'s joint barrels and hubs actually are.
      trim: '#6A6058',      // dark gunmetal, warm cast, F0
    },
    stats: { power: 8, speed: 6, reach: 5, weight: 7, defense: 6 },
    moveSet: 'volta',
    moveBase: 'standard',
    signatureMoves: ['arcTap', 'arcSplit', 'arcOverload', 'deadShort'],
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
