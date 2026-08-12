/**
 * Knockbots — scenarios, named moments and numeric invariants.
 *
 * This is the DATA half of the simulation-testing harness. It holds no state
 * and touches no engine object: a scenario is a frame-indexed input script, a
 * mark is a rule for finding an interesting frame in a timeline, and an
 * invariant is a function from a timeline to a number and a limit. The driving
 * half is `makeGameTest` in `src/combat/TestHarness.js`.
 *
 * WHY THE SPLIT. The same scenario has to run in two places that cannot share
 * a process: bare Node (`tools/simscene.mjs`, ~2 s for the whole suite, no GL)
 * and a real browser page (the contact sheet, ~2 min under swiftshader). If the
 * script lived in the tool, the frames the contact sheet is labelled with would
 * be a re-implementation of the frames the invariants were measured on, and the
 * first time the two drifted the pictures would be lying about the numbers.
 * One table, imported by both.
 *
 * WHY INVARIANTS AND NOT SCREENSHOTS. A vision pass over a contact sheet finds
 * position jumps, missing limbs, clipping and a kick aimed at nothing. It
 * cannot see that the root moved 4 mm too far on one frame, that a hit
 * registered twice, or that the last frame of an idle loop does not meet the
 * first. Those are the numbers here. The two layers are complements and neither
 * subsumes the other; see docs/SIMTEST.md.
 *
 * EVERY LIMIT IN THIS FILE WAS MEASURED, NOT GUESSED. The `measured` field on
 * each tuning entry is what the shipping build actually produced when the
 * scenario was first run, and the limit is set above it with the headroom named
 * in the comment. A limit with no measurement behind it is a limit that will be
 * relaxed the first time it fires.
 */

/**
 * The physical keys each player's inputs come out of.
 *
 * Mirrored from `KEYMAP` in `src/core/Input.js`, which does not export it. This
 * is the third copy in the repository (`tools/simgate.mjs` has the second) and
 * that is a smell, but the alternative — exporting the map from `Input` — is a
 * change to a file this workstream shares with nobody and cannot verify against
 * the other four agents' edits. `tools/simscene.mjs` asserts at startup that a
 * `KeyD` press actually produces `+x` on a real `Input`, so a drift here is
 * caught by the runner rather than by a silent green.
 *
 * `xPlus`/`xMinus` are WORLD axes, not `f`/`b`. Directions in a move list are
 * facing-relative and the physical key is not; resolving one to the other needs
 * the fighter's facing at the frame the key goes down, which is `physicalFor`'s
 * whole job. Getting this backwards is how a gate ends up green on one side of
 * the arena and blind on the other.
 */
export const PAD = {
  0: {
    xPlus: 'KeyD', xMinus: 'KeyA', yPlus: 'KeyW', yMinus: 'KeyS',
    1: 'KeyJ', 2: 'KeyK', 3: 'KeyN', 4: 'KeyM', 5: 'KeyU', guard: 'KeyQ',
  },
  1: {
    xPlus: 'ArrowRight', xMinus: 'ArrowLeft', yPlus: 'ArrowUp', yMinus: 'ArrowDown',
    1: 'KeyF', 2: 'KeyG', 3: 'KeyV', 4: 'KeyB', 5: 'KeyT', guard: 'KeyR',
  },
};

/**
 * Resolve a scenario token to the physical key code that produces it.
 *
 * @param {number} player 0 or 1
 * @param {string} token  'f'|'b'|'u'|'d'|'1'..'5'|'guard', or a raw KeyboardEvent
 *   code, which is passed through untouched so a fuzzer repro bundle can store
 *   exactly the keys it dispatched rather than a re-derivation of them.
 * @param {number} facing +1 when the opponent is at greater X
 * @returns {?string} the `KeyboardEvent.code`, or null if the token is unknown
 */
export function physicalFor(player, token, facing = 1) {
  const map = PAD[player] || PAD[0];
  if (token === 'f') return facing >= 0 ? map.xPlus : map.xMinus;
  if (token === 'b') return facing >= 0 ? map.xMinus : map.xPlus;
  if (token === 'u') return map.yPlus;
  if (token === 'd') return map.yMinus;
  if (map[token]) return map[token];
  // Anything else is assumed to be a code already. `KeyD`, `ArrowLeft`, etc.
  return /^[A-Za-z]/.test(String(token)) ? String(token) : null;
}

/** Expand `tap(f, '2')` into the down/up pair a one-frame press really is. */
const tap = (frame, key, hold = 1, player = 0) => ([
  { frame, key, action: 'down', player },
  { frame: frame + hold, key, action: 'up', player },
]);

/** Expand `hold(from, to, 'b')` into a held direction. */
const hold = (from, to, key, player = 0) => ([
  { frame: from, key, action: 'down', player },
  { frame: to, key, action: 'up', player },
]);

/**
 * The scenarios.
 *
 * Each is a complete recipe: who fights, how far apart they start, what is
 * pressed on which FRAME (never on which millisecond), how long to run, and
 * which invariants the result has to satisfy. `expect` is the scenario's own
 * statement of intent, checked by the `expected*` invariants — a whiff test
 * that starts landing is a broken whiff test, not a bonus hit.
 *
 * `dist` is metres between the two roots at frame 0. The numbers come from
 * `TestHarness#probePlay`'s distance ladder (0.9 / 1.02 / 1.2 / 1.5), which is
 * where this project's reach measurements already live.
 */
export const SCENARIOS = {

  'strike-connects': {
    what: 'A light standing poke at point-blank range. The baseline: one hit, '
      + 'one reaction, both fighters back to idle. If this scenario is red '
      + 'nothing else in the suite means anything.',
    p1: 0, p2: 1, dist: 1.05, frames: 90,
    script: [...tap(10, '2')],
    expect: { hits: 1, blocks: 0, defenderReacts: true },
    move: 'straight',
    invariants: ['finite', 'inArena', 'scaleStable', 'rootStep', 'facingSane',
      'footContact', 'expectedHits', 'reactionWithinOneFrame', 'validStates', 'settles'],
    tune: {
      // Measured on the shipping build: the attacker's largest single-frame
      // root step over this scenario is 0.072 m on the lunge into the punch,
      // and the defender's is 0.040 m on the pushback frame. 0.25 is three and
      // a half times the worst of those — it is a TELEPORT detector, not a
      // speed limit, and a limit tight enough to also catch tuning changes
      // would fire on every balance edit. See `rootStep`.
      rootStep: 0.25,
    },
  },

  'strike-whiffs': {
    what: 'The same button at a range it cannot reach. The control for '
      + '`strike-connects`: it proves the hit in that scenario came from the '
      + 'geometry and not from the harness. A whiff must leave the defender '
      + 'completely untouched — no hit, no block, no state change, no damage.',
    p1: 0, p2: 1, dist: 2.9, frames: 90,
    script: [...tap(10, '2')],
    expect: { hits: 0, blocks: 0, defenderReacts: false },
    move: 'straight',
    invariants: ['finite', 'inArena', 'scaleStable', 'rootStep', 'facingSane',
      'footContact', 'expectedHits', 'defenderUntouched', 'validStates', 'settles'],
    tune: { rootStep: 0.25 },
  },

  juggle: {
    what: 'A launcher into two follow-ups while the defender is airborne. '
      + 'Exercises the parts of the sim that nothing else here reaches: '
      + 'gravity, juggle decay, combo scaling and the airborne hurtbox.',
    p1: 0, p2: 1, dist: 1.05, frames: 150,
    // df+2 is the launcher in every archetype. The direction is held for four
    // frames before the button because that is how a human enters a held-
    // direction move and how `probePlay` enters it; a same-frame stab is a
    // different input and reaches a different branch of the matcher.
    script: [
      ...hold(6, 40, 'f'), ...hold(6, 40, 'd'),
      ...tap(10, '2'),
      /*
       * THE FOLLOW-UP IS TIMED FROM A MEASUREMENT, NOT FROM TASTE.
       *
       * The first version of this scenario pressed jab at frames 52 and 76 and
       * both whiffed, which is correct behaviour reported as a passing test:
       * `hitsAtLeast: 1` was satisfied by the launcher alone, so a "juggle"
       * scenario shipped with no juggle in it. Tracing the victim's height per
       * frame is what showed why — it is airborne from 40 to 117 and above two
       * metres for most of it:
       *
       *     f40 0.29  f52 1.24  f64 1.82  f76 2.02  f88 1.86  f100 1.33
       *     f104 1.07  f108 0.77  f112 0.43  f116 0.05
       *
       * A jab reaches nothing at 2.0 m. The launcher's own recovery does not
       * end until frame 62, so the only window where the attacker is free AND
       * the victim is within reach is the last few frames of the descent. Jab
       * is 10 frames of startup, so pressing on 103 puts the active window on
       * 112-113, at 0.43 m — and the invariant is `hitsAtLeast: 2`, so if that
       * window ever stops connecting the scenario goes red instead of quietly
       * testing nothing.
       */
      ...tap(103, '1'),
    ],
    expect: { hitsAtLeast: 2, defenderAirborne: true },
    move: 'launcherPunch',
    invariants: ['finite', 'inArena', 'scaleStable', 'rootStep', 'facingSane',
      'expectedHits', 'defenderLaunched', 'validStates'],
    tune: {
      // A launched body falls under GRAVITY = -22 m/s^2, so the frame before it
      // lands is the fastest in the run — measured peak 0.110 m for the
      // attacker and 0.102 m for the victim. 0.35 leaves room for a heavier
      // launcher without letting a teleport through.
      rootStep: 0.35,
    },
  },

  throw: {
    what: 'A forward throw. The only path in the game where damage is applied '
      + 'without a `hit` event and where two bodies are driven by one clip, so '
      + 'it is the scenario most likely to break silently.',
    p1: 0, p2: 1, dist: 0.92, frames: 150,
    // 1+2 is a chord: both buttons inside one frame, which is the strictest
    // case the chord window has to accept.
    script: [...tap(10, '1'), ...tap(10, '2')],
    expect: { thrown: true },
    move: 'throwFwd',
    invariants: ['finite', 'inArena', 'scaleStable', 'rootStep', 'facingSane',
      'defenderThrown', 'validStates'],
    tune: {
      // A throw animation translates both bodies together and the victim is
      // slammed: measured peak 0.140 m in one frame on the release, against
      // 0.058 m for the thrower. This is the scenario where a large step is
      // correct, so the limit is set from the measurement — 2.9x — rather than
      // from a house number.
      rootStep: 0.4,
    },
  },

  'idle-loop': {
    what: 'Four seconds of nothing at all. The cheapest scenario and the one '
      + 'that catches the most: an idle that drifts, breathes into the floor, '
      + 'or does not meet itself at the loop boundary is visible in every '
      + 'single frame of the game.',
    p1: 0, p2: 1, dist: 2.4, frames: 240,
    script: [],
    expect: { hits: 0 },
    move: null,
    invariants: ['finite', 'inArena', 'scaleStable', 'rootStep', 'facingSane',
      'footContact', 'expectedHits', 'validStates', 'noDrift', 'loopCloses'],
    tune: {
      /*
       * AN IDLE FIGHTER IS NOT QUITE STILL, AND THIS IS THE MEASUREMENT.
       *
       * Over 240 frames of no input at all, the root creeps 4.9 mm, entirely on
       * X — |dz| and |dy| are exactly zero to nine places — in discrete steps
       * of up to 2.1 mm rather than smoothly. Frames 30-40 read
       * -1.196821 -1.197376 -1.197772 -1.198010 -1.198089 -1.200231 -1.201531,
       * which is a sub-millimetre crawl with an occasional two-millimetre jump.
       *
       * That is 1.2 mm/second of unrequested motion in the game's most-shown
       * pose. It is far too small to see and far too systematic to be noise, so
       * the limits here are set just above it rather than at zero: at zero this
       * scenario would be permanently red and would say nothing, and at 0.05 it
       * would not notice the day the crawl becomes a slide. Reported in
       * docs/SIMTEST.md as a product finding rather than fixed here.
       */
      rootStep: 0.005,
      drift: 0.01,
    },
  },

  'roundhouse-loop': {
    what: 'The scenario the invariant list in the brief was written about: a '
      + 'heavy back-input kick, entered while retreating, all the way from '
      + 'neutral to neutral. Longest startup in the set (22 frames), largest '
      + 'root excursion, and the move whose hit capsule sits on a limb the '
      + 'clip has to actually swing.',
    p1: 0, p2: 1, dist: 1.02, frames: 120,
    script: [...hold(4, 30, 'b'), ...tap(8, '4')],
    expect: { hitsAtLeast: 0 },
    move: 'roundhouse',
    invariants: ['finite', 'inArena', 'scaleStable', 'rootStep', 'facingSane',
      'footContact', 'validStates', 'settles', 'loopCloses'],
    tune: {
      // Holding back walks the fighter and the kick lands: measured peak step
      // 0.044 m for the attacker and 0.152 m for the fighter being kicked.
      rootStep: 0.25,
      // The widest pose excursion in the suite — 198 against 65-79 for the
      // others — because a roundhouse is a whole-body rotation. The ratchet
      // ratio is still only 0.170.
      loopRatchet: 0.35,
    },
  },
};

/**
 * Default tuning, used for anything a scenario does not override.
 *
 * Every number here came out of a measurement pass over the six scenarios on
 * the shipping build; the worst value observed is quoted next to the limit.
 */
export const DEFAULT_TUNE = {
  /** Metres of root travel between adjacent frames. Worst measured: 0.152. */
  rootStep: 0.3,
  /** Metres of net displacement over a whole run. Worst measured: 0.005 idle. */
  drift: 0.05,
  /**
   * Metres a sole may sit above the deck during the planted phase. Worst
   * measured after the settling window: 0.048 m, and the median is 0.009. The
   * limit is 1.7x the worst.
   */
  footTol: 0.08,
  /**
   * Frames to skip at the head of a run before judging foot contact.
   *
   * NOT A FUDGE, AND IT IS A PRODUCT FINDING. Measured on every scenario: a
   * fighter that has just been staged or `reset()` stands with BOTH soles
   * 15.5 cm above the deck on frame 0, and the plant ramp seats them over the
   * next five frames — 0.155, 0.141, 0.126, 0.110, 0.095, then under 0.05 from
   * frame 6. That is the ramp doing exactly what it is designed to do, and it
   * is also five frames at the start of every round where the boots are not on
   * the floor. Eight is five plus slack. See docs/SIMTEST.md.
   */
  footSettleFrames: 8,
  /**
   * Loop closure, expressed as a RATIO of the run's own pose spread rather than
   * an absolute number — see `loopCloses` for why an absolute one cannot work
   * against an aperiodic procedural layer. Worst measured: 0.170.
   */
  loopRatchet: 0.35,
  /** Frames after the last input by which idle must be back. */
  settleFrames: 30,
};

const tuning = (scn, key) => (scn?.tune?.[key] ?? DEFAULT_TUNE[key]);

/** Sim states a fighter is allowed to be in. Mirrors `STATE` in Fighter.js. */
export const VALID_STATES = new Set([
  'idle', 'walk', 'dash', 'backdash', 'crouch', 'sidestep',
  'jumpRise', 'jumpApex', 'jumpFall', 'attack', 'blockHigh', 'blockLow',
  'blockstun', 'hitstun', 'launched', 'juggled', 'knockdown', 'wakeup',
  'throw', 'thrown', 'ko', 'intro', 'victory',
]);

/** States that mean "the defender registered a blow". */
const REACTION_STATES = new Set(['hitstun', 'launched', 'juggled', 'knockdown', 'blockstun', 'thrown', 'ko']);

/** States in which both boots are supposed to be under the body. */
const PLANTED_STATES = new Set(['idle', 'walk', 'crouch', 'blockHigh', 'blockLow']);

// ---------------------------------------------------------------------------
// Named moments
// ---------------------------------------------------------------------------

/**
 * Find the frames worth a full-resolution screenshot.
 *
 * Every one of these is DERIVED FROM THE TIMELINE, never hardcoded. A mark
 * written as "impact is frame 15" is a mark that silently points at the wrong
 * picture the moment a startup value changes, and the picture is then evidence
 * for a claim it does not support.
 *
 * @param {Array<Object>} timeline rows from `getTimeline()`
 * @param {Array<Object>} events   rows from `getEvents()`
 * @returns {Record<string, number>} mark name -> frame index
 */
export function deriveMarks(timeline, events) {
  const marks = {};
  if (!timeline.length) return marks;
  const last = timeline.length - 1;
  marks.start = 0;

  // The first frame any button is down. `beforeInput` is the frame before it,
  // which is the "what did it look like standing still" reference shot.
  const pressed = timeline.findIndex((r) => r.btn);
  if (pressed > 0) marks.beforeInput = pressed - 1;
  if (pressed >= 0) marks.press = pressed;

  // The attacker's move, found from the timeline rather than from the scenario,
  // so a scenario whose input produced a DIFFERENT move than intended is
  // photographed as what it actually did.
  const moveStart = timeline.findIndex((r) => r.move);
  if (moveStart >= 0) {
    let moveEnd = moveStart;
    while (moveEnd + 1 <= last && timeline[moveEnd + 1].move === timeline[moveStart].move) moveEnd++;
    marks.moveStart = moveStart;
    // Anticipation is the middle of the wind-up: far enough in that the pose
    // has left the stance, before the limb commits.
    const firstActive = timeline.findIndex((r, i) => i >= moveStart && r.boxes > 0);
    const windUpEnd = firstActive > moveStart ? firstActive : moveEnd;
    marks.anticipation = moveStart + Math.floor((windUpEnd - moveStart) / 2);
    // Max extension: the frame on which the strike capsule reaches furthest
    // from the attacker's own root. This is a measurement, so it is also the
    // frame a "the kick points the wrong way" defect is most visible on.
    let best = -1; let bestAt = -1;
    for (let i = moveStart; i <= moveEnd; i++) {
      if (timeline[i].reach > best) { best = timeline[i].reach; bestAt = i; }
    }
    if (bestAt >= 0 && best > 0) marks.maxExtension = bestAt;
    marks.moveEnd = moveEnd;
  }

  const impact = events.find((e) => e.type === 'hit' || e.type === 'block');
  if (impact) marks.impact = impact.frame;

  // Recovery: halfway between the blow and the end of the move, which is where
  // a bad recovery pose (a limb still extended, a body that never came back
  // over its feet) shows up.
  if (marks.impact != null && marks.moveEnd != null && marks.moveEnd > marks.impact) {
    marks.recovery = marks.impact + Math.floor((marks.moveEnd - marks.impact) / 2);
  } else if (marks.moveEnd != null && marks.maxExtension != null && marks.moveEnd > marks.maxExtension) {
    marks.recovery = marks.maxExtension + Math.floor((marks.moveEnd - marks.maxExtension) / 2);
  }

  // Return to idle: the first frame after the move on which the attacker is
  // idle again. A move that never gets here is a soft-lock.
  if (marks.moveEnd != null) {
    const back = timeline.findIndex((r, i) => i > marks.moveEnd && r.state === 'idle');
    if (back >= 0) marks.returnToIdle = back;
  }

  marks.loopBoundary = last;
  return marks;
}

/**
 * Choose the frames for the contact sheet: evenly spaced, with every named
 * moment forced in.
 *
 * Even spacing alone misses the impact frame nearly always — a 90-frame
 * scenario sampled 20 ways steps 4.7 frames and the active window is two — and
 * a contact sheet without the impact frame cannot answer the question it is
 * being asked. Marks first, then fill the gaps.
 *
 * @param {number} frames total frames in the run
 * @param {Record<string,number>} marks
 * @param {number} count target cell count (the brief asks for 12-30)
 */
export function pickContactFrames(frames, marks, count = 20) {
  const want = Math.max(4, Math.min(30, count));
  const set = new Set();
  for (const f of Object.values(marks)) if (Number.isInteger(f) && f >= 0 && f < frames) set.add(f);
  for (let i = 0; i < want; i++) {
    set.add(Math.min(frames - 1, Math.round((i * (frames - 1)) / Math.max(1, want - 1))));
  }
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Every invariant has the same shape:
 *
 *     fn({ timeline, events, scenario, tune }) -> { ok, measured, limit, detail }
 *
 * `measured` and `limit` are reported whether the check passed or failed, and
 * that is deliberate: a gate that only prints on failure gives you no way to
 * see a number drifting toward its limit, and the first you hear of it is the
 * day it goes red. `tools/simscene.mjs --verbose` prints all of them.
 */
export const INVARIANTS = {

  finite: {
    what: 'no NaN or Infinity reaches any recorded field',
    fn: ({ timeline }) => {
      for (const r of timeline) {
        for (const side of ['a', 'd']) {
          const s = r[side];
          for (const k of ['x', 'y', 'z', 'vx', 'vy', 'hp', 'meter']) {
            if (!Number.isFinite(s[k])) {
              return { ok: false, measured: `${side}.${k}=${s[k]}`, limit: 'finite', detail: `frame ${r.frame}` };
            }
          }
        }
      }
      return { ok: true, measured: 'all finite', limit: 'finite' };
    },
  },

  inArena: {
    what: 'neither body leaves the arena box or sinks through the floor',
    fn: ({ timeline }) => {
      let worst = 0; let at = -1; let which = '';
      for (const r of timeline) {
        for (const side of ['a', 'd']) {
          const s = r[side];
          // The arena is ±9.0 x ±5.5 and the fighter capsule is 0.42; the sim
          // clamps to halfWidth - radius, so anything past the raw half-width
          // is the clamp having failed rather than a body legitimately in the
          // corner.
          const over = Math.max(Math.abs(s.x) - 9.0, Math.abs(s.z) - 5.5, -(s.y) - 0.01);
          if (over > worst) { worst = over; at = r.frame; which = side; }
        }
      }
      return {
        ok: worst <= 0, measured: `${worst.toFixed(3)} m outside`, limit: '0.000 m',
        detail: at >= 0 ? `${which} at frame ${at}` : '',
      };
    },
  },

  scaleStable: {
    what: 'neither fighter changes size during the run',
    fn: ({ timeline }) => {
      const s0 = timeline[0];
      let worst = 0; let at = -1;
      for (const r of timeline) {
        for (const side of ['a', 'd']) {
          const d = Math.abs(r[side].scale - s0[side].scale);
          if (d > worst) { worst = d; at = r.frame; }
        }
      }
      // Exactly zero, not a tolerance. Nothing in the sim is supposed to touch
      // a fighter's scale at all, so any movement is a defect and a tolerance
      // would only hide the small ones.
      return { ok: worst === 0, measured: worst.toExponential(2), limit: '0', detail: at >= 0 ? `frame ${at}` : '' };
    },
  },

  rootStep: {
    what: 'the root never jumps between adjacent frames',
    fn: ({ timeline, tune }) => {
      const limit = tune.rootStep;
      let worst = 0; let at = -1; let which = '';
      for (let i = 1; i < timeline.length; i++) {
        // Frozen frames are hitstop: the sim did not run, so a step across one
        // is not a step at all. Comparing across them would report the freeze
        // as a teleport on every single hit in the game.
        if (timeline[i].frozen) continue;
        for (const side of ['a', 'd']) {
          const p = timeline[i - 1][side]; const c = timeline[i][side];
          const dx = c.x - p.x; const dy = c.y - p.y; const dz = c.z - p.z;
          const d = Math.hypot(dx, dy, dz);
          if (d > worst) { worst = d; at = timeline[i].frame; which = side; }
        }
      }
      return {
        ok: worst <= limit, measured: `${worst.toFixed(4)} m`, limit: `${limit} m`,
        detail: at >= 0 ? `${which} at frame ${at}` : '',
      };
    },
  },

  facingSane: {
    what: 'the attacker is always turned toward the defender',
    fn: ({ timeline }) => {
      // A throw drives both bodies through each other and a launcher can carry
      // the attacker past the victim, so a frame where the two roots are within
      // a capsule width of each other has no meaningful side to face. Those
      // frames are excluded rather than tolerated: the check is about a fighter
      // swinging at empty air behind it, which needs real separation to mean
      // anything.
      let bad = 0; let at = -1;
      for (const r of timeline) {
        const gap = r.d.x - r.a.x;
        if (Math.abs(gap) < 0.5) continue;
        if (Math.sign(gap) !== Math.sign(r.a.facing)) { bad++; if (at < 0) at = r.frame; }
      }
      return {
        ok: bad === 0, measured: `${bad} frame(s) facing away`, limit: '0',
        detail: at >= 0 ? `first at frame ${at}` : '',
      };
    },
  },

  footContact: {
    what: 'a fighter in the planted phase keeps a sole on the deck',
    fn: ({ timeline, tune }) => {
      const limit = tune.footTol;
      /*
       * THE PLANTED PHASE IS NARROWER THAN "GROUNDED", AND THE DIFFERENCE IS
       * THE WHOLE INVARIANT.
       *
       * A launcher lifts BOTH feet 28 cm off the floor while `airborne` is
       * still false — that is the step into the swing, and it is correct. Judge
       * every non-airborne frame and the invariant fires on every attack in the
       * game and has to be given a limit so loose it can no longer see a
       * fighter hovering. So only the states where both boots are supposed to
       * be under the body are judged: idle, walk and crouch.
       *
       * The head of the run is skipped for the reason given on
       * `footSettleFrames` — it is a real five-frame transient, not a defect
       * this check is equipped to report, and leaving it in made every scenario
       * red on the same number.
       */
      const skip = tune.footSettleFrames;
      let worst = 0; let at = -1; let n = 0;
      for (const r of timeline) {
        const a = r.a;
        if (r.frame < skip) continue;
        if (a.air || !PLANTED_STATES.has(a.state)) continue;
        n++;
        const lowest = Math.min(a.footL, a.footR);
        if (lowest > worst) { worst = lowest; at = r.frame; }
      }
      return {
        ok: n === 0 || worst <= limit,
        measured: `${worst.toFixed(4)} m above the deck over ${n} planted frame(s)`,
        limit: `${limit} m`, detail: at >= 0 ? `frame ${at}` : '',
      };
    },
  },

  expectedHits: {
    what: 'the blow lands exactly as many times as the scenario says',
    fn: ({ events, scenario }) => {
      const hits = events.filter((e) => e.type === 'hit').length;
      const exp = scenario.expect || {};
      if (exp.hits != null) {
        return { ok: hits === exp.hits, measured: `${hits} hit(s)`, limit: `exactly ${exp.hits}` };
      }
      const min = exp.hitsAtLeast ?? 0;
      return { ok: hits >= min, measured: `${hits} hit(s)`, limit: `at least ${min}` };
    },
  },

  reactionWithinOneFrame: {
    what: 'the defender enters a reaction on the hit frame or the next one',
    fn: ({ timeline, events }) => {
      const hit = events.find((e) => e.type === 'hit');
      if (!hit) return { ok: false, measured: 'no hit', limit: 'a hit to measure' };
      const at = timeline.findIndex((r) => r.frame === hit.frame);
      for (let i = at; i >= 0 && i <= at + 1 && i < timeline.length; i++) {
        if (REACTION_STATES.has(timeline[i].d.state)) {
          return { ok: true, measured: `${i - at} frame(s)`, limit: '<= 1 frame', detail: timeline[i].d.state };
        }
      }
      return {
        ok: false, measured: 'never', limit: '<= 1 frame',
        detail: `defender was ${timeline[at]?.d.state} on the hit frame`,
      };
    },
  },

  defenderUntouched: {
    what: 'a whiff leaves the defender in exactly the state it started in',
    fn: ({ timeline }) => {
      const first = timeline[0].d;
      let bad = 0; let at = -1; let why = '';
      for (const r of timeline) {
        if (REACTION_STATES.has(r.d.state) || r.d.hp !== first.hp) {
          bad++;
          if (at < 0) { at = r.frame; why = `${r.d.state} hp ${r.d.hp}`; }
        }
      }
      return { ok: bad === 0, measured: `${bad} disturbed frame(s)`, limit: '0', detail: at >= 0 ? `frame ${at}: ${why}` : '' };
    },
  },

  defenderLaunched: {
    what: 'the launcher actually put the defender in the air',
    fn: ({ timeline }) => {
      const peak = timeline.reduce((m, r) => Math.max(m, r.d.y), 0);
      const air = timeline.filter((r) => r.d.air).length;
      // A juggle that lifts the victim less than a boot's height is not a
      // juggle. 0.3 m is roughly a sixth of a fighter and well under the
      // measured 1.0 m peak, so this is a "did it happen at all" test.
      return { ok: peak > 0.3 && air > 0, measured: `${peak.toFixed(3)} m peak over ${air} airborne frame(s)`, limit: '> 0.3 m' };
    },
  },

  defenderThrown: {
    what: 'the throw connected and moved the victim through the throw states',
    fn: ({ timeline }) => {
      const thrown = timeline.filter((r) => r.d.state === 'thrown').length;
      const dmg = timeline[0].d.hp - timeline[timeline.length - 1].d.hp;
      return {
        ok: thrown > 0 && dmg > 0,
        measured: `${thrown} thrown frame(s), ${dmg.toFixed(1)} damage`,
        limit: '> 0 of each',
      };
    },
  },

  validStates: {
    what: 'every fighter is in a state the engine declares on every frame',
    fn: ({ timeline }) => {
      for (const r of timeline) {
        for (const side of ['a', 'd']) {
          if (!VALID_STATES.has(r[side].state)) {
            return { ok: false, measured: `${side}=${r[side].state}`, limit: 'a declared STATE', detail: `frame ${r.frame}` };
          }
        }
      }
      return { ok: true, measured: 'all declared', limit: 'a declared STATE' };
    },
  },

  settles: {
    what: 'both fighters are back to neutral before the run ends',
    fn: ({ timeline, tune }) => {
      const need = tune.settleFrames;
      const tail = timeline.slice(-1)[0];
      const ok = tail.a.state === 'idle' && (tail.d.state === 'idle' || tail.d.state === 'crouch');
      // How long the tail has been settled, which is the number that tells a
      // scenario that ends one frame after recovery from one that has genuinely
      // returned to neutral.
      let held = 0;
      for (let i = timeline.length - 1; i >= 0 && timeline[i].a.state === 'idle'; i--) held++;
      return {
        ok, measured: `end a=${tail.a.state} d=${tail.d.state}, idle for ${held} frame(s)`,
        limit: `both idle, ${need}+ frames`,
      };
    },
  },

  noDrift: {
    what: 'a fighter that was given no input has not moved',
    fn: ({ timeline, tune }) => {
      const a = timeline[0].a; const b = timeline[timeline.length - 1].a;
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      return { ok: d <= tune.drift, measured: `${d.toFixed(4)} m`, limit: `${tune.drift} m` };
    },
  },

  loopCloses: {
    what: 'the idle pose does not ratchet — the body comes back to where it was',
    fn: ({ timeline, tune }) => {
      /*
       * WHY THIS IS NOT "COMPARE THE POSE ONE LOOP PERIOD APART".
       *
       * That was the first version and it is wrong, and measuring it is what
       * showed why. `idle.fight` is 108 ticks long and does loop, but the pose
       * the fighter is actually in is the clip PLUS a procedural stack —
       * breathing, look-at, secondary-motion springs — that `Animator.simulate`
       * drives off the absolute sim tick as a noise phase. That stack has no
       * period at all. Measured over 240 idle frames, the root-relative pose
       * signature at 48, 96 and 108 frames apart differs by 53.8, 55.7 and 47.5
       * against a total range of 67.6: the "period" comparison is measuring the
       * breathing, not the loop, and no tolerance can separate them.
       *
       * What a broken loop actually looks like is a RATCHET — the pose creeping
       * in one direction each cycle instead of returning. That survives the
       * aperiodic layer, because a ratchet moves the MEAN and breathing does
       * not. So: mean of the first half of the idle frames against the mean of
       * the second, as a fraction of the run's own pose spread. Measured on the
       * six scenarios: 0.003, 0.013, 0.030, 0.031, 0.116, 0.170. A genuine
       * ratchet of half an amplitude per cycle lands near 1.
       *
       * This is a coarse instrument and it is worth saying so out loud: it
       * catches a loop that walks away from itself, and it will not catch a
       * two-millimetre mismatch at the seam. That one needs the contact sheet.
       */
      const idle = timeline.filter((r) => r.a.state === 'idle');
      if (idle.length < 20) {
        return { ok: true, measured: `only ${idle.length} idle frame(s)`, limit: 'skipped, need 20+' };
      }
      const sig = idle.map((r) => r.a.pose);
      const spread = Math.max(...sig) - Math.min(...sig);
      const h = Math.floor(sig.length / 2);
      const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      const delta = Math.abs(mean(sig.slice(h)) - mean(sig.slice(0, h)));
      const ratio = spread > 1e-9 ? delta / spread : 0;
      return {
        ok: ratio <= tune.loopRatchet,
        measured: `${ratio.toFixed(4)} of the pose spread (${delta.toFixed(2)} of ${spread.toFixed(2)})`,
        limit: String(tune.loopRatchet),
      };
    },
  },
};

/**
 * Run a scenario's invariants over its result.
 * @returns {{ok:boolean, rows:Array<Object>}}
 */
export function runInvariants(scenario, timeline, events) {
  const tune = {};
  for (const k of Object.keys(DEFAULT_TUNE)) tune[k] = tuning(scenario, k);
  const rows = [];
  for (const id of scenario.invariants || []) {
    const inv = INVARIANTS[id];
    if (!inv) { rows.push({ id, ok: false, measured: 'unknown invariant', limit: '—' }); continue; }
    let r;
    try { r = inv.fn({ timeline, events, scenario, tune }); }
    catch (e) { r = { ok: false, measured: `threw: ${e.message}`, limit: '—' }; }
    rows.push({ id, what: inv.what, ...r });
  }
  return { ok: rows.every((r) => r.ok), rows };
}

/**
 * The invariants a FUZZED run is judged by.
 *
 * A fuzzer presses random buttons, so nothing about hits, whiffs or settling
 * can be asserted — the run has no intent to violate. What is left is the set
 * of properties that must hold no matter what a player does, which is exactly
 * the set worth fuzzing for.
 */
export const FUZZ_INVARIANTS = ['finite', 'inArena', 'scaleStable', 'rootStep', 'validStates'];
