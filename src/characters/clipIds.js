/**
 * Knockbots — the canonical clip-ID manifest.
 *
 * This is a contract between the animation workstreams (which must author a
 * clip for every id here) and the combat workstream (which may only reference
 * ids from this list). `tools/check.mjs` fails the build if a move points at a
 * clip that does not exist, and warns if a manifest id is unimplemented.
 *
 * Naming: `<category>.<name>`. Category prefixes map to the animation source
 * files so ownership is unambiguous.
 */

export const CLIP_IDS = {
  // idle.js — always-on states
  idle: ['idle.fight', 'idle.breathe', 'idle.taunt', 'idle.lowHealth', 'idle.crouch'],

  // locomotion.js — movement
  locomotion: [
    'loco.walkFwd', 'loco.walkBack', 'loco.dashFwd', 'loco.dashBack',
    'loco.sidestepLeft', 'loco.sidestepRight', 'loco.jumpStart', 'loco.jumpAir',
    'loco.jumpLand', 'loco.crouchWalk', 'loco.runFwd', 'loco.stopShort',
  ],

  // punches.js — 1 and 2 (left/right punch) strings
  punches: [
    'p.jab', 'p.jabAlt', 'p.straight', 'p.hook', 'p.uppercut', 'p.overhand',
    'p.elbow', 'p.backfist', 'p.hammerFist', 'p.pistonRush', 'p.launcherPunch',
    'p.lowJab', 'p.duckingStraight',
    // Same reason in the other direction: siegeSlam wanted 0.40x out of
    // p.hammerFist, which stretches a 22-tick wind-up over 55 and holds one dead
    // pose for most of it.
    'p.siegeSlam',
  ],

  // kicks.js — 3 and 4 (left/right kick) strings
  kicks: [
    'k.lowKick', 'k.midKick', 'k.highKick', 'k.roundhouse', 'k.axeKick',
    'k.sweep', 'k.kneeStrike', 'k.sideKick', 'k.spinKick', 'k.jumpKick',
    'k.launcherKick', 'k.stomp',
    // Authored later, to retire a retime clamp rather than to add a move: Falcon
    // Dive wanted 2.57x playback out of k.jumpKick, and past roughly 1.8x the
    // honest fix is a different clip rather than a faster one.
    'k.diveKick',
  ],

  // specials.js — motion-input moves and overdrive
  specials: [
    'sp.rocketPunch', 'sp.plasmaBurst', 'sp.chargeShoulder', 'sp.risingFang',
    'sp.groundSpike', 'sp.overdriveStart', 'sp.overdriveHit', 'sp.overdriveFinish',
    'sp.counterStance', 'sp.parrySuccess', 'sp.armorAbsorb',
  ],

  // reactions.js — everything the defender does
  reactions: [
    'r.blockHigh', 'r.blockLow', 'r.blockImpact', 'r.flinchHigh', 'r.flinchMid',
    'r.flinchLow', 'r.stagger', 'r.crumple', 'r.launch', 'r.airFlail',
    'r.spinFall', 'r.knockdownBack', 'r.knockdownFace', 'r.sweepFall',
    'r.wallSplat', 'r.wallSlide', 'r.getUp', 'r.getUpRoll', 'r.groundBounce',
    'r.koFall', 'r.koSlump',
  ],

  // throws.js — grabs, paired animations
  throws: ['t.grabAttempt', 't.grabWhiff', 't.throwForward', 't.throwBack', 't.throwBreak', 't.beingThrown', 't.beingGrabbed'],

  // intros.js / victory.js — cinematic bookends
  intros: ['i.walkOn', 'i.powerUp', 'i.stanceSet', 'i.pointTaunt'],
  victory: ['v.pose', 'v.saluteCharge', 'v.systemsNominal', 'v.roundWin'],
};

/** Flat list of every required clip id. */
export const ALL_CLIP_IDS = Object.values(CLIP_IDS).flat();

/** Which source file owns which category. */
export const CLIP_FILES = {
  idle: 'idle.js',
  locomotion: 'locomotion.js',
  punches: 'punches.js',
  kicks: 'kicks.js',
  specials: 'specials.js',
  reactions: 'reactions.js',
  throws: 'throws.js',
  intros: 'intros.js',
  victory: 'victory.js',
};
