/**
 * Knockbots — the headless simulation gate.
 *
 * WHY THIS EXISTS
 *
 * The most expensive bug this project has shipped was found by a player, not by
 * a test, and the test that should have found it reported 12/12. That round
 * "audited the state x button matrix" by handing `findMove` a SYNTHESISED input
 * buffer. Every entry in that buffer was written by the test itself, so it was
 * by construction free of the defect — which lived one layer upstream, in
 * `Input#commandsFor`, which pushes a fresh history entry on any tick a button
 * is pressed and not only when the direction changes. Holding DOWN and pressing
 * 2 therefore wrote `2` into the direction history twice, `#motion` read the
 * pair as a double-tap, and the player who asked for `duckingStraight` (i18,
 * 39 total) got `siegeSlam` — an 86-frame unblockable. Holding BACK did the same
 * thing to `bb`, which is why back+RP and back+RK were reported as "not
 * working": they were resolving, just to the wrong move.
 *
 * TESTING THE MATCHER IS NOT TESTING THE GAME. So the central test here is not
 * an assertion about what a move should do. It is a DIFFERENTIAL:
 *
 *     Every move's notation is entered twice — once as the synthetic Command
 *     that `TestHarness#probePlay` builds with `mkCmd`, and once as REAL KEY
 *     EVENTS dispatched at a real `Input` — and the two are diffed.
 *
 * Agreement is the null hypothesis. The synthetic path says what the notation
 * MEANS; the real path says what the input stack actually produces when a human
 * enters it. They can only disagree if something between the keystroke and the
 * Command invented, dropped or mistimed a direction — which is to say, a
 * `commandsFor` / history / motion defect and nothing else. That makes this a
 * detector for the whole class, not a test that happens to dodge one instance
 * of it.
 *
 * It is verified to be that by a POSITIVE CONTROL (`--positive-control`), which
 * loads a copy of `src/core/Input.js` with the consecutive-duplicate filter in
 * `#motion` removed — the exact line whose absence caused the shipped bug — and
 * requires the gate to go red on held-direction notations and stay green
 * everywhere else. The patch is applied to a copy in the system temp directory;
 * nothing in the repository is written.
 *
 * NO BROWSER, NO GL, NO INSTALL. `Fighter`, `CombatSystem` and `Input` run in
 * bare Node against the same fixed 60 Hz tick the game uses. The DOM shim below
 * is the one `tools/check.mjs` already carries plus three globals, and `Input`
 * binds to a native `EventTarget`, so `jsdom` is not needed and is not used.
 * `CombatSystem` optional-chains `stage` throughout and falls back to
 * `ARENA_HALF_WIDTH` / `GROUND_Y`, so passing `stage: null` costs camera shake
 * and debris and nothing else — walls, floor and every collision path stay live.
 *
 * WHAT IT COVERS
 *   1. null control       — three identical scripts must be bit-identical
 *   2. command diff       — mkCmd vs real key events, all 54 notations, both
 *                           facings, at the input layer with no fighter attached
 *   3. outcome diff       — which move actually STARTS, both ways, all 612 moves
 *   4. press-to-hit       — one representative move per input class, end to end
 *
 * WHAT IT DOES NOT COVER, so nobody reads a green run as more than it is:
 *   - only PLAYER 0's keyboard. Gamepad and `TouchControls` feed the same
 *     `commandsFor`, by different paths, and neither is driven here.
 *   - only the PRESS TICK for the command diff. A defect that corrupts a Command
 *     several ticks after the button would be caught by the outcome diff, if at
 *     all, and only if it changes which move starts.
 *   - only ROOT moves. String continuations (`b+2,1` and friends) are matched by
 *     `parsedStep` down a different branch of `findMove` and are not entered.
 *   - nothing about damage, frame advantage, hitboxes or balance. Press-to-hit
 *     asks whether a strike CONNECTS, not whether it connects for the right
 *     amount.
 *   - no seeded match soak. Deliberately: that comes after this.
 *
 * USAGE
 *   node tools/simgate.mjs                    the gate, over the sets the roster
 *                                             actually uses (10 of the 14)
 *   node tools/simgate.mjs --positive-control the gate against a broken Input
 *   node tools/simgate.mjs --sets=all         all 14 sets, roster or not
 *   node tools/simgate.mjs --sets=vulkan,nyx  named sets only
 *   node tools/simgate.mjs --first-run        the reset() divergence experiment,
 *                                             one candidate per fresh process
 *   node tools/simgate.mjs --verbose          print every row, not just failures
 *
 * Exit code is 0 only when every check passes. Under `--positive-control` the
 * meaning is inverted: 0 means the control went red the way it must.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');
const SRC = join(ROOT, 'src');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(`--${name}`);
const opt = (name, dflt = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const POSITIVE_CONTROL = flag('positive-control');
const VERBOSE = flag('verbose');
const SETS_ARG = opt('sets', 'roster');
const FIRST_RUN_MODE = flag('first-run');
const TRIAL = opt('trial', null); // internal: one candidate per child process

// ---------------------------------------------------------------------------
// DOM shim
//
// Lifted from tools/check.mjs. `RobotBuilder` and `Animator` touch `document`
// while building geometry and `window` for a few feature checks; nothing in the
// simulation path reads anything back out of them, which is why stubs this thin
// are enough. Measured: both fighters build and `init()` resolves in ~1.6 s.
// ---------------------------------------------------------------------------

globalThis.window ??= globalThis;
globalThis.self ??= globalThis;
globalThis.navigator ??= { userAgent: 'node', getGamepads: () => [] };
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= clearTimeout;
if (typeof document === 'undefined') {
  const el = () => ({
    style: { setProperty() {} }, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    setAttribute() {}, getAttribute: () => null, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {},
    getContext: () => null, width: 1024, height: 1024, insertAdjacentHTML() {},
    getBoundingClientRect: () => ({ width: 1920, height: 1080, left: 0, top: 0 }),
    ownerDocument: null,
  });
  globalThis.document = {
    createElement: el, createElementNS: el, body: el(), documentElement: el(),
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, head: el(),
  };
}

// ---------------------------------------------------------------------------
// Imports — after the shim, because the module bodies touch it at load time.
// ---------------------------------------------------------------------------

const THREE = await import(join(ROOT, 'node_modules/three/build/three.module.js'));
const { Fighter, STATE } = await import(pathToFileURL(join(SRC, 'combat/Fighter.js')));
const { CombatSystem } = await import(pathToFileURL(join(SRC, 'combat/CombatSystem.js')));
const { MOVES, MOVE_SET_KEYS } = await import(pathToFileURL(join(SRC, 'combat/Moves.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { bus } = await import(pathToFileURL(join(SRC, 'core/Bus.js')));
const { METER_MAX, MAX_HEALTH } = await import(pathToFileURL(join(SRC, 'core/Constants.js')));

// ---------------------------------------------------------------------------
// Loading Input, optionally with the defect put back
//
// The dedupe lives inside a PRIVATE method (`Input#motion`), so it cannot be
// monkey-patched from outside the class. The positive control therefore edits a
// COPY of the source and imports that. Relative specifiers are rewritten to
// absolute file URLs because the copy does not sit next to `Constants.js`.
//
// The `find` string is asserted present before substitution: if the source ever
// moves, the control must fail loudly rather than quietly become a no-op that
// re-runs the healthy gate and reports a green control.
// ---------------------------------------------------------------------------

const DEDUPE_FIND = `      .map((h) => h.dir)\n      .filter((d, i, a) => d !== a[i - 1]);`;
const DEDUPE_REPLACE = `      .map((h) => h.dir);  /* POSITIVE CONTROL: consecutive-duplicate filter removed */`;

let tempDir = null;
async function loadInput(broken) {
  const inputPath = join(SRC, 'core/Input.js');
  if (!broken) return (await import(pathToFileURL(inputPath))).Input;

  let src = readFileSync(inputPath, 'utf8');
  if (!src.includes(DEDUPE_FIND)) {
    throw new Error(
      'positive control: the dedupe filter in Input#motion no longer matches the '
      + 'string this gate patches. Update DEDUPE_FIND in tools/simgate.mjs — a '
      + 'silent no-op here would report a green control against a healthy Input.');
  }
  src = src.replace(DEDUPE_FIND, DEDUPE_REPLACE);
  src = src.replace(/from '\.\/([^']+)'/g, (_m, rel) => `from '${pathToFileURL(join(SRC, 'core', rel)).href}'`);
  src = src.replace(/from '\.\.\/([^']+)'/g, (_m, rel) => `from '${pathToFileURL(join(SRC, rel)).href}'`);
  tempDir = mkdtempSync(join(tmpdir(), 'kb-simgate-'));
  const out = join(tempDir, 'Input.broken.js');
  writeFileSync(out, src);
  return (await import(pathToFileURL(out))).Input;
}
process.on('exit', () => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

const Input = await loadInput(POSITIVE_CONTROL);

// ---------------------------------------------------------------------------
// The key driver
//
// `Input` binds three listeners to whatever target it is given and reads only
// `e.code` and `e.repeat`. A native `EventTarget` plus a two-field Event
// subclass is therefore a complete keyboard as far as the input stack is
// concerned — which is the point: this is the SAME code path a browser drives,
// not a re-implementation of it.
// ---------------------------------------------------------------------------

class KeyEv extends Event {
  constructor(type, code) { super(type); this.code = code; this.repeat = false; }
  preventDefault() {}
}

/** Player 0's bindings, mirrored from `KEYMAP[0]` in src/core/Input.js. */
const BTN_KEY = { 1: 'KeyJ', 2: 'KeyK', 3: 'KeyN', 4: 'KeyM', 5: 'KeyU' };
const AXIS_KEY = { '+x': 'KeyD', '-x': 'KeyA', '+y': 'KeyW', '-y': 'KeyS' };

/**
 * A keyboard: an EventTarget, a set of held codes, and edge-correct dispatch.
 * Holding a key that is already held emits nothing, which is what a real
 * keyboard does after the first auto-repeat is filtered by `e.repeat`.
 */
function makeKeyboard() {
  const target = new EventTarget();
  const held = new Set();
  const set = (code, down) => {
    if (down) {
      if (!held.has(code)) { held.add(code); target.dispatchEvent(new KeyEv('keydown', code)); }
    } else if (held.delete(code)) {
      target.dispatchEvent(new KeyEv('keyup', code));
    }
  };
  /** Make exactly `codes` held and nothing else. */
  const only = (codes) => {
    const want = new Set(codes);
    for (const c of [...held]) if (!want.has(c)) set(c, false);
    for (const c of want) set(c, true);
  };
  const release = () => { for (const c of [...held]) set(c, false); };
  return { target, held, set, only, release };
}

/**
 * The physical keys that produce a facing-relative notation direction.
 *
 * `Input#commandsFor` computes `cmd.x = raw.x * facing`, so a fighter facing -1
 * needs the OPPOSITE physical key to move forward. Every direction in a move
 * list is facing-relative, so this conversion is where a gate driving real keys
 * has to be careful and a gate driving `mkCmd` never finds out.
 */
function dirCodes(dir, facing) {
  const wantX = dir === 'f' || dir === 'df' || dir === 'uf' ? 1
    : dir === 'b' || dir === 'db' || dir === 'ub' ? -1 : 0;
  const wantY = dir === 'u' || dir === 'uf' || dir === 'ub' ? 1
    : dir === 'd' || dir === 'df' || dir === 'db' ? -1 : 0;
  const codes = [];
  const rawX = wantX * facing;
  if (rawX > 0) codes.push(AXIS_KEY['+x']);
  if (rawX < 0) codes.push(AXIS_KEY['-x']);
  if (wantY > 0) codes.push(AXIS_KEY['+y']);
  if (wantY < 0) codes.push(AXIS_KEY['-y']);
  return codes;
}

/**
 * How a human enters each motion, and where the stick ends up.
 *
 * The TAIL matters and is the one place the synthetic path is honestly, not
 * defectively, different: `mkCmd(p.dir=''...)` for `dd+2` presents a CENTRED
 * stick, while a player who has just tapped down twice is holding DOWN on the
 * press tick. That is a property of the motion, fixed here before anything ran,
 * and the differential compares the real Command against `mkCmd(TAIL, ...)` so
 * the two are asking the same question. It is not a whitelist: no entry here
 * was added or changed after seeing a result.
 *
 * Two ticks per step keeps the longest motion (`hcf`, five steps) at ten ticks,
 * inside `MOTION_WINDOW_TICKS` (14). `hcf` is authored in no shipped move set
 * today; it is here so the day one appears it is already covered.
 */
const MOTION_ENTRY = {
  qcf: { steps: ['d', 'df', 'f'], tail: 'f' },
  qcb: { steps: ['d', 'db', 'b'], tail: 'b' },
  dp: { steps: ['f', 'd', 'df'], tail: 'df' },
  hcf: { steps: ['b', 'db', 'd', 'df', 'f'], tail: 'f' },
  // A real double tap passes through neutral. That release is the whole
  // difference between a dash and a held direction, and both `Input#motion` and
  // `Fighter#dashMotion` test for it, so it has to be in the keystrokes.
  dd: { steps: ['d', '', 'd'], tail: 'd' },
  ff: { steps: ['f', '', 'f'], tail: 'f' },
  bb: { steps: ['b', '', 'b'], tail: 'b' },
};
const STEP_TICKS = 2;

/** The direction the stick is actually holding on the press tick. */
const tailDir = (p) => (p.motion ? MOTION_ENTRY[p.motion].tail : p.dir);

// ---------------------------------------------------------------------------
// `mkCmd`, verbatim from src/combat/TestHarness.js
//
// Copied rather than imported because `makeTestHarness` needs a live `game`
// with a renderer. It is the synthetic side of the differential, so it MUST
// stay byte-identical in behaviour to the one `probePlay` uses — if the two
// drift, this gate stops testing the path the harness actually runs.
// ---------------------------------------------------------------------------

function mkCmd(dir = '', buttons = [], guard = false, motion = null) {
  const x = dir === 'f' || dir === 'df' || dir === 'uf' ? 1
    : dir === 'b' || dir === 'db' || dir === 'ub' ? -1 : 0;
  const y = dir === 'u' || dir === 'uf' || dir === 'ub' ? 1
    : dir === 'd' || dir === 'df' || dir === 'db' ? -1 : 0;
  return {
    x, y, fwd: x > 0, back: x < 0, up: y > 0, down: y < 0,
    guard, touchGuard: false,
    held: new Set(buttons), pressed: new Set(buttons),
    notation: '', buffer: [], motion,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
const say = (s) => console.log(s);
function record(name, ok, detail = '', rows = []) {
  results.push({ name, ok, detail, rows });
  say(`[simgate] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  for (const r of rows) say(`          ${r}`);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const f0 = new Fighter({ index: 0, def: ROSTER[0], scene, environment: null });
const f1 = new Fighter({ index: 1, def: ROSTER[1], scene, environment: null });
await f0.init();
await f1.init();
f0.setOpponent(f1);
f1.setOpponent(f0);
const combat = new CombatSystem([f0, f1], null);

/**
 * A driver bundle: one keyboard, one `Input`, one tick counter.
 *
 * A FRESH ONE PER CASE. `Input` carries `history[player]` across ticks and it
 * is pruned by tick age, not by case boundary, so reusing one instance would
 * let the tail of the previous notation sit inside the motion window of the
 * next — which is precisely the kind of cross-talk this gate exists to detect,
 * and would be indistinguishable from a real one.
 */
function makeDriver() {
  const kb = makeKeyboard();
  const input = new Input(kb.target);
  return { kb, input, tick: 0 };
}

/** Advance one tick with player 0 driven by real keys and player 1 idle. */
function tickReal(drv) {
  drv.input.beginTick(drv.tick);
  const cmd = drv.input.commandsFor(0, f0);
  f0.simulate(cmd);
  f1.simulate(null);
  combat.simulate(drv.tick);
  drv.input.endTick();
  drv.tick++;
  return cmd;
}

/** Advance one tick with player 0 driven by a synthetic Command. */
function tickSynth(cmd, tick) {
  f0.simulate(cmd);
  f1.simulate(null);
  combat.simulate(tick);
}

/**
 * Face the pair off at `dist` metres, centred, both idle.
 *
 * This is `TestHarness#stage` with the parts that need a live `game` (phase,
 * lineup, CPU) dropped — the fields it writes on the fighters are the same
 * ones, in the same order.
 */
function stage(a, d, dist = 1.05) {
  const sign = a.index === 0 ? -1 : 1;
  a.position.set(sign * dist * 0.5, a.floorY, 0);
  d.position.set(-sign * dist * 0.5, d.floorY, 0);
  a.prevPosition.copy(a.position);
  d.prevPosition.copy(d.position);
  a.velocity.set(0, 0, 0);
  d.velocity.set(0, 0, 0);
  a.facing = -sign;
  d.facing = sign;
  for (const f of [a, d]) {
    f.state = STATE.IDLE;
    f.stateTicks = 0;
    f.stunTicks = 0;
    f.currentMove = null;
    f.moveTick = 0;
    f.reaction = null;
    f.isBlocking = false;
    f.crouching = false;
    f.airborne = false;
    f.grounded = true;
    f.juggleCount = 0;
    f.comboCount = 0;
    f.inputBuffer.length = 0;
    f.upHeldTicks = 0;
    f.gravityScale = 1;
    f.throwData = null;
    f.throwPartner = null;
    f.throwInvuln = 0;
    f.connected.clear();
    f.hitboxes.length = 0;
    f.dirSign = 0;
    f.dirReleaseTick = -999;
    f.velocity.set(0, 0, 0);
    // Straight at `Animator.play`, not through `Fighter#play`. That is not
    // stylistic: `#play` returns early on `loop && currentClip === clipId`, so
    // asking a fighter that is already idle to play idle does nothing and the
    // clip phase carries over from the previous case. `probePlay` does exactly
    // this for exactly this reason, and it is also the line the `--first-run`
    // experiment identifies as the cause of the reset() divergence.
    f.animator?.play('idle.fight', { blend: 0, loop: true });
  }
  // Health high enough that nothing under test can KO and end the round out
  // from under a later case. `probePlay` uses the same trick.
  a.health = MAX_HEALTH * 100;
  d.health = MAX_HEALTH * 100;
  a.meter = METER_MAX;
}

// ---------------------------------------------------------------------------
// 1. NULL CONTROL, and the first-run rule
//
// WHAT WAS MEASURED. Two identical 120-tick scripts with `Fighter#reset()`
// between them diverge on the FIRST run and are bit-identical from the second
// on. Ten millimetres, and there is no `Math.random` anywhere in the simulation
// path and both CPUs are seeded, so it is carried state, not noise.
//
// WHAT CAUSES IT, established by `--first-run`, which applies ONE candidate per
// COLD PROCESS so no trial can inherit a state a previous trial had already
// settled (the reason an earlier in-sequence pass could not tell "this fix
// worked" from "it was already settled by the time this trial ran"):
//
//     TRIAL none      run1 -0.673538859   run2/3 -0.675350331   DIVERGES
//     TRIAL rng       run1 -0.673538859   run2/3 -0.675350331   DIVERGES
//     TRIAL meter     run1 -0.673538859   run2/3 -0.675350331   DIVERGES
//     TRIAL animator  run1 -0.673946708   run2/3 -0.673946708   CLEAN
//     TRIAL all       run1 -0.673946708   run2/3 -0.673946708   CLEAN
//
// IT IS THE ANIMATOR, and it is neither the rng nor the meter — reseeding and
// zeroing both changed the numbers by exactly nothing, to nine places. The
// mechanism is one line: `Fighter#play` (src/combat/Fighter.js:3012) returns
// early on `loop && this.currentClip === clipId`, and `reset()` asks for
// `idle.fight` with `loop = true` (src/combat/Fighter.js:1082). A fighter that
// ended the previous round standing is ALREADY on `idle.fight`, so the one call
// in `reset()` meant to rewind the animator is skipped precisely when it is
// needed, and the clip phase, blend stack and inertia state cross the round
// boundary intact. Replaying the clip explicitly past that guard makes every run
// identical. Reported as a product finding; not fixed here.
//
// WHAT THIS GATE DOES ABOUT IT: it discards the first run of every measured
// block. That rule is correct whether or not the finding above is ever acted on
// — whatever settles, settles during a run — and it keeps the gate honest about
// running against the engine as it is rather than a patched copy of it. Every
// measured comparison below is preceded by a warm-up pass.
// ---------------------------------------------------------------------------

const NULL_SCRIPT = [
  [10, 'KeyD', true], [40, 'KeyD', false],
  [45, 'KeyJ', true], [46, 'KeyJ', false],
  [70, 'KeyS', true], [76, 'KeyK', true], [77, 'KeyK', false], [84, 'KeyS', false],
];

function runNullScript() {
  const drv = makeDriver();
  stage(f0, f1, 3.8);
  f0.reset(new THREE.Vector3(-1.9, 0, 0), 1);
  f1.reset(new THREE.Vector3(1.9, 0, 0), -1);
  combat.reset();
  let si = 0;
  for (let i = 0; i < 120; i++) {
    while (si < NULL_SCRIPT.length && NULL_SCRIPT[si][0] === i) {
      drv.kb.set(NULL_SCRIPT[si][1], NULL_SCRIPT[si][2]);
      si++;
    }
    tickReal(drv);
  }
  drv.kb.release();
  drv.input.dispose();
  // Position to nine places, because the divergence being guarded against is at
  // the third: a coarser fingerprint would call a broken run identical.
  return [
    f0.position.x.toFixed(9), f0.position.y.toFixed(9), f0.position.z.toFixed(9),
    f0.state, f0.facing,
    f1.position.x.toFixed(9), f1.health.toFixed(6),
    f0.health.toFixed(6), f0.meter.toFixed(6),
  ].join(' | ');
}

function testNullControl() {
  const warm = runNullScript();     // discarded — see the first-run rule above
  const a = runNullScript();
  const b = runNullScript();
  const c = runNullScript();
  const ok = a === b && b === c;
  const rows = [`warm-up (discarded)  ${warm}`, `run 1  ${a}`, `run 2  ${b}`, `run 3  ${c}`];
  // Reported rather than asserted. `stage()` replays `idle.fight` past the
  // `#play` early-return, which is the thing `--first-run` identifies as the
  // cause, so the warm-up is expected to MATCH here — it is belt and braces
  // against anything else that carries. If it ever stops matching, something new
  // is settling during the first run and the header's account is incomplete.
  record('null control — three identical scripts are bit-identical', ok,
    `warm-up matched the measured runs: ${warm === a ? 'yes' : 'NO — something still settles on run 1'}`,
    ok && !VERBOSE ? [] : rows);
  return ok;
}

// ---------------------------------------------------------------------------
// 2. COMMAND DIFFERENTIAL — mkCmd vs real key events
//
// THIS IS THE CENTRAL TEST. It runs at the input layer alone: a fresh `Input`,
// a stub fighter that reports only `facing`, and no simulation at all.
//
// THE ISOLATION IS THE POINT AND IT IS MEASURED. `Fighter#dashMotion`
// (src/combat/Fighter.js:1222) contains a SECOND, independent guard that drops a
// manufactured `ff`/`bb` when the direction was never released. It does not
// cover `dd`. So with the dedupe removed, `--positive-control --sets=all`
// reports, over 54 notations and 612 moves:
//
//     command differential   18 of 18 held-direction notations red, 0 missed,
//                            0 false positives — every f+, b+ and d+ token
//     outcome differential   32 of 612 moves red, and every one of them is a
//                            `d+` token; not one `f+` or `b+` move is affected
//
// The `f+` and `b+` two thirds of the defect class is INVISIBLE downstream of
// `Fighter`, because the second guard silently repairs it. A differential run
// through a fighter would have found the `d+` third and called `b+4` healthy on
// an Input that was lying about it — which is the same shape of miss as the
// audit that started all this. The input layer is where the Command is born,
// and it is where it has to be right.
//
// For each distinct notation in the move sets under test: enter it with real
// keys, read the Command on the press tick, and compare it field for field
// against `mkCmd(tail, buttons, false, motion)`.
// ---------------------------------------------------------------------------

function distinctNotations(setKeys) {
  const seen = new Map();
  for (const key of setKeys) {
    const set = MOVES[key];
    if (!set) continue;
    for (const mv of set.__ordered) {
      if (!mv.parsed.buttons.length) continue;
      if (!seen.has(mv.input)) seen.set(mv.input, { parsed: mv.parsed, ids: new Set(), sets: new Set() });
      const e = seen.get(mv.input);
      e.ids.add(mv.id);
      e.sets.add(key);
    }
  }
  return seen;
}

/**
 * Enter one notation on a fresh keyboard and return the Command produced on the
 * press tick, plus the two ticks after it.
 *
 * Non-motion notations HOLD the direction for four ticks before the button,
 * which is both how a human enters `b+4` and exactly what `probePlay` does with
 * `mkCmd`. Motion notations must NOT be pre-held — a held motion is not a
 * motion, it is the bug.
 *
 * @param {number} facing which way the fighter is looking, so the physical key
 *   for "forward" is right. Passed rather than assumed, because getting this
 *   wrong would make the gate green for the wrong reason on one side of the
 *   arena.
 */
function enterNotationRaw(parsed, facing = 1) {
  const kb = makeKeyboard();
  const input = new Input(kb.target);
  const stub = { facing };
  let tick = 0;
  const step = () => {
    input.beginTick(tick);
    const cmd = input.commandsFor(0, stub);
    input.endTick();
    tick++;
    return cmd;
  };

  // A few centred ticks so `prevKeys` is populated and the first real press is
  // an edge rather than an already-down key.
  kb.only([]);
  for (let i = 0; i < 3; i++) step();

  if (parsed.motion) {
    for (const s of MOTION_ENTRY[parsed.motion].steps) {
      kb.only(dirCodes(s, facing));
      for (let i = 0; i < STEP_TICKS; i++) step();
    }
  } else {
    kb.only(dirCodes(parsed.dir, facing));
    for (let i = 0; i < 4; i++) step();
  }

  // The press tick: tail direction still held, every button of the token newly
  // down. A chord is two keys inside one tick, which is the strictest case the
  // 4-tick `CHORD_TICKS` window has to accept.
  kb.only([...dirCodes(tailDir(parsed), facing), ...parsed.buttons.map((b) => BTN_KEY[b])]);
  const press = step();
  const snap = snapshot(press);
  const after = [snapshot(step()), snapshot(step())];

  kb.release();
  input.dispose();
  return { press: snap, after };
}

/** The fields of a Command that decide which move comes out, and nothing else. */
function snapshot(cmd) {
  return {
    x: cmd.x, y: cmd.y,
    fwd: !!cmd.fwd, back: !!cmd.back, up: !!cmd.up, down: !!cmd.down,
    guard: !!cmd.guard,
    pressed: [...cmd.pressed].sort().join('+'),
    held: [...cmd.held].sort().join('+'),
    motion: cmd.motion ?? null,
    buffer: (cmd.buffer || []).join(','),
  };
}

function diffSnaps(real, synth) {
  const out = [];
  for (const k of ['x', 'y', 'fwd', 'back', 'up', 'down', 'guard', 'pressed', 'held', 'motion']) {
    if (real[k] !== synth[k]) out.push(`${k}: real=${String(real[k])} mkCmd=${String(synth[k])}`);
  }
  return out;
}

function testCommandDifferential(setKeys) {
  const notations = distinctNotations(setKeys);
  const bad = [];
  const rows = [];

  for (const [input, meta] of notations) {
    const p = meta.parsed;
    // Both facings, because the forward key flips and a facing bug in
    // `commandsFor` would otherwise only ever be exercised from the left side.
    for (const facing of [1, -1]) {
      const real = enterNotationRaw(p, facing).press;
      const synth = snapshot(mkCmd(tailDir(p), p.buttons, false, p.motion));
      const d = diffSnaps(real, synth);
      const line = `${input.padEnd(8)} facing=${facing >= 0 ? '+1' : '-1'}  `
        + `real{dir=${dirLabel(real)} btn=${real.pressed || '-'} motion=${real.motion ?? '-'} buf=[${real.buffer}]}`;
      if (d.length) {
        bad.push({ input, facing, diffs: d, ids: [...meta.ids], sets: [...meta.sets], real });
        rows.push(`DIFF ${line}`);
        for (const x of d) rows.push(`       ${x}`);
        rows.push(`       moves affected: ${[...meta.ids].join(', ')}`);
      } else if (VERBOSE) {
        rows.push(`ok   ${line}`);
      }
    }
  }

  record('command differential — mkCmd vs real key events', bad.length === 0,
    `${notations.size} notations x 2 facings, ${bad.length} disagree`, rows);
  return { ok: bad.length === 0, bad, count: notations.size };
}

const dirLabel = (s) => (s.fwd ? 'f' : s.back ? 'b' : '') + (s.up ? 'u' : s.down ? 'd' : '') || '-';

// ---------------------------------------------------------------------------
// 3. OUTCOME DIFFERENTIAL — which move actually starts
//
// The command differential asks whether the input layer told the truth. This
// asks the question a player asks: I pressed that, did THAT come out? It drives
// the whole stack — `Input` -> `Fighter#pushInput` -> `findMove` -> `#startMove`
// — twice per move and compares the id that started.
//
// A disagreement here is strictly worse than one above, because `Fighter` gets
// the last word and still got it wrong.
// ---------------------------------------------------------------------------

/** Hold up until the fighter leaves the ground, both ways. Air moves need it. */
function jumpReal(drv, limit = 30) {
  drv.kb.only([AXIS_KEY['+y']]);
  for (let i = 0; i < limit && !f0.airborne; i++) tickReal(drv);
  drv.kb.only([]);
  for (let i = 0; i < 8; i++) tickReal(drv);
  return f0.airborne;
}
function jumpSynth(tick0, limit = 30) {
  let t = tick0;
  for (let i = 0; i < limit && !f0.airborne; i++) tickSynth(mkCmd('u'), t++);
  for (let i = 0; i < 8; i++) tickSynth(mkCmd(), t++);
  return { airborne: f0.airborne, tick: t };
}

/** Every move id observed while the case played out, in the order they started. */
function watchMoves() {
  const seen = [];
  let last = null;
  return {
    poll() {
      const id = f0.currentMove?.id ?? null;
      if (id && id !== last) seen.push(id);
      last = id;
    },
    get list() { return seen; },
    get first() { return seen[0] ?? null; },
  };
}

function runOutcomeReal(mv, dist) {
  const p = mv.parsed;
  const drv = makeDriver();
  stage(f0, f1, dist);
  for (let i = 0; i < 6; i++) tickReal(drv);
  if (mv.props?.requireAir && !jumpReal(drv)) { drv.input.dispose(); return { first: null, list: [], staged: false }; }

  const facing = f0.facing;
  if (p.motion) {
    for (const s of MOTION_ENTRY[p.motion].steps) {
      drv.kb.only(dirCodes(s, facing));
      for (let i = 0; i < STEP_TICKS; i++) tickReal(drv);
    }
  } else {
    drv.kb.only(dirCodes(p.dir, facing));
    for (let i = 0; i < 4; i++) tickReal(drv);
  }

  const w = watchMoves();
  drv.kb.only([...dirCodes(tailDir(p), facing), ...p.buttons.map((b) => BTN_KEY[b])]);
  tickReal(drv);
  w.poll();
  // Release the buttons but keep a plain direction held, matching what
  // `probePlay` does after the press: the direction stays, the motion does not.
  drv.kb.only(dirCodes(p.dir, facing));
  for (let t = 1; t < mv.startup + 14; t++) { tickReal(drv); w.poll(); }
  drv.kb.release();
  drv.input.dispose();
  return { first: w.first, list: w.list, staged: true };
}

function runOutcomeSynth(mv, dist) {
  const p = mv.parsed;
  let tick = 0;
  stage(f0, f1, dist);
  for (let i = 0; i < 6; i++) tickSynth(null, tick++);
  if (mv.props?.requireAir) {
    const r = jumpSynth(tick);
    tick = r.tick;
    if (!r.airborne) return { first: null, list: [], staged: false };
  }
  if (!p.motion) for (let t = 0; t < 4; t++) tickSynth(mkCmd(p.dir), tick++);

  const w = watchMoves();
  tickSynth(mkCmd(p.dir, p.buttons, false, p.motion), tick++);
  w.poll();
  for (let t = 1; t < mv.startup + 14; t++) { tickSynth(mkCmd(p.dir, [], false, null), tick++); w.poll(); }
  return { first: w.first, list: w.list, staged: true };
}

function testOutcomeDifferential(setKeys) {
  const bad = [];
  // Two failure modes that are NOT input-path disagreements and must not be
  // allowed to hide inside one:
  //   vacuous — both paths started nothing, so they "agree" about silence. A
  //             differential over 442 cases that all came out empty would report
  //             a clean bill of health while testing nothing at all.
  //   shadowed — both paths agree, on the WRONG move. That is the two sides
  //             failing identically, which a differential cannot see by
  //             construction, so it is checked separately. It is the same shape
  //             as the shipped bug (a higher-scoring input eating a lower one),
  //             just reachable from both paths.
  const vacuous = [];
  const shadowed = [];
  const rows = [];
  let cases = 0;
  const wasTable = f0.moveTable;
  const wasKey = f0.moveSetKey;

  try {
    for (const key of setKeys) {
      const set = MOVES[key];
      if (!set) continue;
      f0.moveTable = set;
      f0.moveSetKey = key;
      for (const mv of set.__ordered) {
        if (!mv.parsed.buttons.length) continue;
        cases++;
        // Far enough that the entry walk cannot bump the pair into a push-out,
        // close enough that travel moves still reach. Whiffing is fine here —
        // this test is about which move STARTS, not whether it lands.
        const dist = 1.6;
        // Warm-up pass, then the two measured ones. See the first-run rule.
        runOutcomeSynth(mv, dist);
        const s = runOutcomeSynth(mv, dist);
        const r = runOutcomeReal(mv, dist);
        if (s.first === r.first) {
          if (s.first === null) {
            vacuous.push(`${key}/${mv.id} [${mv.input}]${s.staged ? '' : ' (could not be staged)'}`);
          } else if (!r.list.includes(mv.id)) {
            shadowed.push(`${key}/${mv.id} [${mv.input}] both paths started ${r.first} instead`);
          } else if (VERBOSE) {
            rows.push(`ok   ${key}/${mv.id.padEnd(16)} ${mv.input.padEnd(8)} -> ${r.first ?? 'nothing'}`);
          }
          continue;
        }
        bad.push({ set: key, id: mv.id, input: mv.input, synth: s, real: r });
        rows.push(`DIFF ${key}/${mv.id} [${mv.input}]`);
        rows.push(`       mkCmd  started ${s.first ?? 'nothing'}   (sequence: ${s.list.join(' -> ') || 'none'})`);
        rows.push(`       keys   started ${r.first ?? 'nothing'}   (sequence: ${r.list.join(' -> ') || 'none'})`);
        const buf = enterNotationRaw(mv.parsed, 1).press;
        rows.push(`       real Command on the press tick: dir=${dirLabel(buf)} btn=${buf.pressed} `
          + `motion=${buf.motion ?? 'null'} history=[${buf.buffer}]`);
      }
    }
  } finally {
    f0.moveTable = wasTable;
    f0.moveSetKey = wasKey;
  }

  for (const v of vacuous) rows.push(`VACUOUS  ${v} — neither path started a move; this case proves nothing`);
  for (const s of shadowed) rows.push(`SHADOWED ${s}`);

  const ok = bad.length === 0 && vacuous.length === 0 && shadowed.length === 0;
  record('outcome differential — the move that actually starts', ok,
    `${cases} moves across ${setKeys.length} set(s), ${bad.length} disagree, `
    + `${vacuous.length} vacuous, ${shadowed.length} shadowed`, rows);
  return { ok, bad, vacuous, shadowed, cases };
}

// ---------------------------------------------------------------------------
// 4. PRESS TO HIT — one representative per input class, end to end
//
// Standing, crouching, airborne, back+limb, throw chord, motion special and
// overdrive have EACH shipped a reachability bug this year, which is why the
// classes are enumerated rather than sampled. This is the only test here that
// requires a hit: keys go in one end, damage comes out the other, through the
// real `CombatSystem`.
// ---------------------------------------------------------------------------

const HIT_CLASSES = [
  { cls: 'standing', id: 'straight', dist: 1.05 },
  { cls: 'crouching', id: 'duckingStraight', dist: 1.05 },
  { cls: 'airborne', id: 'airKick', dist: 1.05 },
  { cls: 'back+limb', id: 'roundhouse', dist: 1.05 },
  { cls: 'throw chord', id: 'throwFwd', dist: 0.95 },
  { cls: 'motion special', id: 'rocketPunch', dist: 1.2 },
  { cls: 'overdrive', id: 'overdrive', dist: 1.2 },
];

/**
 * Did the strike land? Three signals, because the classes answer differently:
 * a normal emits `hit`, a blocked one emits `block`, and a throw emits neither —
 * it puts the victim in `thrown` and takes health directly.
 */
function makeConnectWatcher() {
  let struck = false;
  const off = [
    bus.on('hit', () => { struck = true; }),
    bus.on('block', () => { struck = true; }),
  ];
  return {
    reset() { struck = false; },
    get struck() { return struck; },
    dispose() { for (const fn of off) fn?.(); },
  };
}

function testPressToHit() {
  const rows = [];
  const bad = [];
  const watcher = makeConnectWatcher();
  const wasTable = f0.moveTable;
  const wasKey = f0.moveSetKey;

  try {
    for (const spec of HIT_CLASSES) {
      // The class matters, not the character: find the first set that actually
      // authors this move so a roster change cannot silently drop a whole class.
      let found = null;
      for (const key of [f0.def?.moveSet, ...MOVE_SET_KEYS]) {
        const set = MOVES[key];
        if (set && set[spec.id]) { found = { key, mv: set[spec.id], set }; break; }
      }
      if (!found) {
        bad.push(spec.cls);
        rows.push(`FAIL ${spec.cls.padEnd(15)} no move '${spec.id}' in any set — the class has no representative`);
        continue;
      }
      f0.moveTable = found.set;
      f0.moveSetKey = found.key;
      const mv = found.mv;

      // Warm-up, then the measured pass. See the first-run rule.
      pressToHitOnce(mv, spec.dist, watcher);
      const res = pressToHitOnce(mv, spec.dist, watcher);
      const ok = res.connected && res.startedRight;
      if (!ok) bad.push(spec.cls);
      rows.push(`${ok ? 'ok  ' : 'FAIL'} ${spec.cls.padEnd(15)} ${found.key}/${mv.id} [${mv.input}]  `
        + `started=${res.first ?? 'nothing'} connected=${res.connected ? 'yes' : 'NO'} `
        + `damage=${res.damage.toFixed(1)} victimState=${res.victimState}`);
    }
  } finally {
    watcher.dispose();
    f0.moveTable = wasTable;
    f0.moveSetKey = wasKey;
  }

  record('press to hit — one move per input class, real keys end to end',
    bad.length === 0, `${HIT_CLASSES.length} classes, ${bad.length} failed`,
    bad.length || VERBOSE ? rows : []);
  return { ok: bad.length === 0, bad };
}

function pressToHitOnce(mv, dist, watcher) {
  const p = mv.parsed;
  const drv = makeDriver();
  stage(f0, f1, dist);
  const h0 = f1.health;
  for (let i = 0; i < 6; i++) tickReal(drv);
  if (mv.props?.requireAir) jumpReal(drv);

  const facing = f0.facing;
  if (p.motion) {
    for (const s of MOTION_ENTRY[p.motion].steps) {
      drv.kb.only(dirCodes(s, facing));
      for (let i = 0; i < STEP_TICKS; i++) tickReal(drv);
    }
  } else {
    drv.kb.only(dirCodes(p.dir, facing));
    for (let i = 0; i < 4; i++) tickReal(drv);
  }

  watcher.reset();
  const w = watchMoves();
  let thrown = false;
  drv.kb.only([...dirCodes(tailDir(p), facing), ...p.buttons.map((b) => BTN_KEY[b])]);
  tickReal(drv);
  w.poll();
  drv.kb.only(dirCodes(p.dir, facing));
  for (let t = 1; t < mv.total + 20; t++) {
    tickReal(drv);
    w.poll();
    if (f1.state === STATE.THROWN) thrown = true;
    if (watcher.struck && !mv.props?.throw) break;
  }
  const victimState = f1.state;
  drv.kb.release();
  drv.input.dispose();
  const damage = h0 - f1.health;
  return {
    first: w.first,
    startedRight: w.list.includes(mv.id),
    connected: watcher.struck || thrown || damage > 0.001,
    damage,
    victimState,
  };
}

// ---------------------------------------------------------------------------
// The reset() first-run experiment — independent trials, one per process
//
// `--first-run` spawns one child per candidate. Each child applies its candidate
// on a cold process and asks the ONLY question that matters: does run 1 match
// runs 2 and 3? A candidate that fixes the divergence makes run 1 agree. Running
// the candidates in sequence inside one process cannot answer that, because by
// the second trial the state has already settled on its own.
// ---------------------------------------------------------------------------

const TRIALS = {
  none: () => {},
  rng: () => { f0.rng?.reseed?.(1); f1.rng?.reseed?.(2); },
  meter: () => { f0.meter = 0; f1.meter = 0; },
  animator: () => { for (const f of [f0, f1]) f.animator?.play('idle.fight', { blend: 0, loop: true }); },
  all: () => {
    f0.rng?.reseed?.(1); f1.rng?.reseed?.(2);
    f0.meter = 0; f1.meter = 0;
    for (const f of [f0, f1]) f.animator?.play('idle.fight', { blend: 0, loop: true });
  },
};

function runTrialScript(extra) {
  const drv = makeDriver();
  f0.reset(new THREE.Vector3(-1.9, 0, 0), 1);
  f1.reset(new THREE.Vector3(1.9, 0, 0), -1);
  combat.reset();
  extra();
  let si = 0;
  for (let i = 0; i < 120; i++) {
    while (si < NULL_SCRIPT.length && NULL_SCRIPT[si][0] === i) {
      drv.kb.set(NULL_SCRIPT[si][1], NULL_SCRIPT[si][2]);
      si++;
    }
    tickReal(drv);
  }
  drv.kb.release();
  drv.input.dispose();
  return `${f0.position.x.toFixed(9)} h1=${f1.health.toFixed(6)} m0=${f0.meter.toFixed(6)}`;
}

if (TRIAL) {
  const fn = TRIALS[TRIAL];
  if (!fn) { console.log(`TRIAL ${TRIAL} unknown`); process.exit(2); }
  const a = runTrialScript(fn);
  const b = runTrialScript(fn);
  const c = runTrialScript(fn);
  const fixed = a === b && b === c;
  console.log(`TRIAL ${TRIAL} ${fixed ? 'FIRST-RUN-CLEAN' : 'FIRST-RUN-DIVERGES'}`);
  console.log(`  1: ${a}`);
  console.log(`  2: ${b}`);
  console.log(`  3: ${c}`);
  process.exit(0);
}

if (FIRST_RUN_MODE) {
  say('[simgate] reset() first-run experiment — one candidate per fresh process');
  say('[simgate] a candidate that CAUSES the divergence reports FIRST-RUN-CLEAN when applied');
  for (const name of Object.keys(TRIALS)) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--trial=${name}`],
      { encoding: 'utf8' });
    const out = (r.stdout || '').trim();
    for (const line of out.split('\n')) say(`  ${line}`);
    if (r.stderr) say(`  stderr: ${r.stderr.trim().split('\n')[0]}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const setKeys = SETS_ARG === 'all' ? MOVE_SET_KEYS
  : SETS_ARG === 'roster' ? [...new Set(ROSTER.map((r) => r.moveSet).filter((k) => MOVES[k]))]
    : SETS_ARG.split(',').filter((k) => MOVES[k]);

say(`[simgate] ${POSITIVE_CONTROL ? 'POSITIVE CONTROL — Input#motion dedupe removed' : 'gate'}`);
say(`[simgate] fighters ${ROSTER[0].id} vs ${ROSTER[1].id}; move sets: ${setKeys.join(', ')}`);

const t0 = Date.now();
const nullOk = testNullControl();
const cmd = testCommandDifferential(setKeys);
const out = testOutcomeDifferential(setKeys);
const hit = testPressToHit();
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const allGreen = nullOk && cmd.ok && out.ok && hit.ok;

say('');
if (POSITIVE_CONTROL) {
  // The control is not "did the gate fail" — a gate that failed everything would
  // pass that. It has to fail the SPECIFIC cases the defect creates and pass the
  // rest, or it is not measuring what it claims to.
  //
  // Held single directions (`f`, `b`, `d`) collapse to `6,6` / `4,4` / `2,2`
  // without the dedupe and are read as `ff` / `bb` / `dd`. Held diagonals do not
  // (`3,3`, `1,1`, `9,9`, `7,7` match no motion), a centred stick does not, and a
  // real motion passes through neutral and survives the dedupe either way — so
  // those must all stay green.
  const heldSingle = (p) => !p.motion && ['f', 'b', 'd'].includes(p.dir);
  const redInputs = new Set(cmd.bad.map((b) => b.input));
  const notations = distinctNotations(setKeys);
  const expectRed = [...notations].filter(([, m]) => heldSingle(m.parsed)).map(([i]) => i);
  const expectGreen = [...notations].filter(([, m]) => !heldSingle(m.parsed)).map(([i]) => i);
  const missedRed = expectRed.filter((i) => !redInputs.has(i));
  const falseRed = expectGreen.filter((i) => redInputs.has(i));

  say(`[simgate] control: ${expectRed.length} held-direction notations must go red, `
    + `${expectGreen.length} must stay green`);
  say(`[simgate] control: ${expectRed.length - missedRed.length} red, `
    + `${missedRed.length} missed, ${falseRed.length} false positives`);
  if (missedRed.length) say(`[simgate] control: MISSED  ${missedRed.join(' ')}`);
  if (falseRed.length) say(`[simgate] control: SPURIOUS ${falseRed.join(' ')}`);
  const controlOk = missedRed.length === 0 && falseRed.length === 0 && !allGreen;
  say(`[simgate] POSITIVE CONTROL ${controlOk ? 'VALID — the gate detects the defect it was built for'
    : 'INVALID — the gate does not detect the defect it claims to'}  (${secs}s)`);
  process.exitCode = controlOk ? 0 : 1;
} else {
  say(`[simgate] ${allGreen ? 'GREEN — no disagreement between the synthetic and the real input path'
    : 'RED'}  (${secs}s)`);
  process.exitCode = allGreen ? 0 : 1;
}
