/**
 * Knockbots — global constants.
 * The sim runs at a fixed 60Hz tick; rendering interpolates between ticks.
 * All frame data in the game is expressed in these ticks ("frames"), exactly
 * like Tekken's frame data, so 1 frame == 1/60s == 16.667ms.
 */

export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
export const MAX_TICKS_PER_FRAME = 5; // spiral-of-death guard

// ---------------------------------------------------------------------------
// World scale. 1 unit = 1 metre. A robot stands ~1.85m.
// ---------------------------------------------------------------------------
export const UNIT = 1;
export const FIGHTER_HEIGHT = 1.85;
export const GRAVITY = -22.0; // m/s^2 — heavier than real gravity; fighting-game feel
export const GROUND_Y = 0;

// Arena is a bounded rectangle; walls cause wall-splat combos.
export const ARENA_HALF_WIDTH = 9.0; // x
export const ARENA_HALF_DEPTH = 5.5; // z
export const WALL_SPLAT_SPEED = 6.0; // min horizontal speed into wall to splat

// Fighters are capsules for push-collision.
export const FIGHTER_RADIUS = 0.42;
export const PUSH_STRENGTH = 6.0;

// Max distance the pair may separate before the camera stops tracking width.
export const MAX_PAIR_DISTANCE = 11.0;

// ---------------------------------------------------------------------------
// Combat tuning
// ---------------------------------------------------------------------------
export const MAX_HEALTH = 180;
export const CHIP_DAMAGE_RATIO = 0.08; // fraction of damage dealt through block
export const RECOVERABLE_RATIO = 0.35; // grey-health portion that regenerates
export const RECOVERY_PER_TICK = 0.06;

export const ROUNDS_TO_WIN = 2;
export const ROUND_TIME_SECONDS = 60;

// Combo scaling: damage multiplier by hit index within a combo string.
export const COMBO_SCALING = [1.0, 1.0, 0.9, 0.8, 0.7, 0.62, 0.55, 0.48, 0.42, 0.37, 0.33, 0.3];
export const MIN_COMBO_SCALE = 0.25;

// Juggle: each airborne hit reduces the launch height it can impart.
export const JUGGLE_DECAY = 0.86;
export const MIN_JUGGLE_SCALE = 0.2;

/**
 * Hitstop (impact freeze) in ticks, by attack weight class.
 *
 * `docs/ANIMATION_RESEARCH.md` item 2 claims the industry convention is "1-3
 * frames of freeze on connection" and that 18 ticks is therefore two to six
 * times too long. **That claim is wrong and these numbers should not be cut.**
 * Checked against primary sources, all of which are 60fps games quoting 60Hz
 * frames, so there is no factor-of-two to unpick:
 *
 *     Street Fighter V   8 / 12 / 16 frames for light / medium / heavy
 *                        (Capcom's own SF Seminar column, "Damage Part II")
 *     Street Fighter IV  ~9 / ~11 / ~13 frames  (sonichurricane, "Impact Freeze")
 *     Street Fighter II  10-14 frames regardless of button strength
 *     Melee              floor(damage/3 + 3), capped at 20 frames
 *     Brawl / Ultimate   damage*0.385 + 5 and damage*0.65 + 6, capped at 30
 *
 * Against that, Knockbots is at or *below* convention everywhere except ULTRA,
 * and ULTRA at 18 sits between SFV's heavy and Smash's cap. The "1-3 frames"
 * figure appears to be a conflation with the 2-4 frame *screen effect* the
 * critic protocol asks for, which is a different thing and is authored in
 * `EffectsDirector`'s `HIT_FX`.
 *
 * Two things about this constant that are easy to get wrong:
 *
 * 1. **Changing it cannot break a combo.** `Game.#frame` gates the accumulator
 *    on the freeze, so *no simulation tick runs at all* while hitstop is
 *    active — move counters, stun timers and the input buffer all hold. Every
 *    frame-data relationship in the game is invariant under this table. What
 *    changes is only the wall-clock window a human gets to buffer an input.
 * 2. **The unit is a rendered frame, not a tick.** `Game.hitstopTicks` counts
 *    down once per `requestAnimationFrame`, so the freeze lasts
 *    `ticks x frameTime`, not `ticks/60`. Measured on a launcher (11) at the
 *    fight framing, three repetitions: **327 ms**, not the nominal 183 ms,
 *    because the contact burst makes those the most expensive frames in the
 *    game (43 ms against 11 ms either side). See the note on `KICK` in
 *    `FightCamera.js` — the fix belongs in `Game.js` and is not made here.
 */
export const HITSTOP = { light: 5, medium: 8, heavy: 12, launcher: 11, ultra: 18 };

// Input buffer window (ticks) for motion inputs and command reads.
export const INPUT_BUFFER_TICKS = 20;
export const MOTION_WINDOW_TICKS = 14;

// Overdrive (super) meter.
export const METER_MAX = 100;
export const METER_ON_DEAL = 0.16; // per point of damage dealt
export const METER_ON_TAKE = 0.22; // per point of damage received
export const METER_ON_BLOCK = 0.08;

// ---------------------------------------------------------------------------
// Guard / hit heights
// ---------------------------------------------------------------------------
export const HEIGHT = { HIGH: 'high', MID: 'mid', LOW: 'low', UNBLOCKABLE: 'unblockable' };

// Attack "weight" drives hitstop, camera shake, FX scale and audio layer.
export const WEIGHT = { LIGHT: 'light', MEDIUM: 'medium', HEAVY: 'heavy', LAUNCHER: 'launcher', ULTRA: 'ultra' };

// Reactions the defender can enter on hit.
export const REACTION = {
  FLINCH_HIGH: 'flinchHigh',
  FLINCH_MID: 'flinchMid',
  FLINCH_LOW: 'flinchLow',
  CRUMPLE: 'crumple',
  LAUNCH: 'launch',
  SPIN: 'spin',
  KNOCKDOWN: 'knockdown',
  SWEEP: 'sweep',
  WALL_SPLAT: 'wallSplat',
  STAGGER: 'stagger',
};

// Render layers.
export const LAYER = { DEFAULT: 0, BLOOM_ONLY: 1, NO_REFLECT: 2 };

export const TEAM = { P1: 0, P2: 1 };
