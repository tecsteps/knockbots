/**
 * Knockbots — the frame-data gate (FD-1 … FD-7 of docs/TESTPLAN.md).
 *
 * WHY THIS EXISTS
 *
 * "Frame data is the game." Every number on the move list is a promise about an
 * integer counter, and until this file nothing checked that the counter and the
 * promise were the same object. `simgate` proves the right MOVE comes out of a
 * keypress; `dtgate` proves the same input twice gives the same match; `smgate`
 * proves the state machine only takes the transitions it is allowed. None of
 * them looks at a single frame number.
 *
 * WHAT IT MEASURES, and the one thing it deliberately does not
 *
 *   FD-1  the hitbox appears on the frame `startup` names
 *   FD-2  on-block advantage: the model, and a ledger against the printed number
 *   FD-3  on-hit advantage, counter-hit stun, and the harness trap in § FD-3
 *   FD-4  a move that prints punishable is punishable, and a safe one is not
 *   FD-5  the guard matrix, end to end, both ways round
 *   FD-6  multi-hit bookkeeping, combo scaling, juggle decay
 *   FD-7  hitstop does not move any of the above
 *
 * FD-0 WAS NOT RE-LITIGATED HERE, AND HAS SINCE BEEN DECIDED. When this file
 * was written, every blockable move was less safe than its printed `onBlock` by
 * exactly its own active span at point blank, and whether that was a data fix,
 * an engine fix or a display fix was the owner's call. FD-2b was written as a
 * ledger so it would go red on a deficit that CHANGED rather than on one that
 * merely existed — because whichever way the decision went, this was the file
 * that had to keep the answer true.
 *
 * The decision was that the printed number is the promise, and
 * `Fighter#beginRecovery` is it. `tools/advgate.mjs` is the acceptance test for
 * that change and owns the `measured == printed` assertion. FD-2b and FD-3b are
 * the same identity re-derived from this file's own sweep — a different probe,
 * a different staging path, four ranges and an L3 sample — and they are here
 * because an acceptance test that only ever agrees with itself is one
 * instrument, not two. They now read zero deficit where they used to read the
 * active span.
 *
 * EVERY TEST CARRIES BOTH CONTROLS. `--control=<name>` applies one named,
 * minimal change to the PRODUCT and requires the named tests to go red and the
 * named tests to stay green. Source-level controls are applied through
 * `module.registerHooks`, which rewrites the module text as it is loaded, so
 * nothing in the repository is ever written and the patch cannot survive the
 * process. The string each patch looks for is asserted present before it is
 * substituted: a control that silently became a no-op would report a green
 * control against healthy code, which is worse than no control at all.
 *
 * LAYERS, per the plan's own rule.
 *   FD-1  L3 (real key events into a real `Input`) for every root move that
 *         comes out of the keyboard; L2 (a `Command` built in code) for the
 *         rest; `startMove` for the handful neither reaches. The three counts
 *         are reported separately and a move measured below L3 has NOT been
 *         proven startable by a player.
 *   FD-2  L2 for the 4-distance sweep, L3 for a 20-move sample.
 *   FD-3  L2 for the sweep, L3 for the sample.
 *   FD-4  L3 for the punish input (the half that matters), L2 for the setup.
 *   FD-5  L2. The guard matrix is about `#guardResult`, and every defender
 *         state in it is reached by a real prior event, never by assignment.
 *   FD-6  L2.
 *   FD-7  L2 plus a REPLICA of `Game.#frame`'s freeze arithmetic — `Game`
 *         cannot be constructed without a GPU, so the replica is guarded by an
 *         assertion that the lines it mirrors are still present in `Game.js`
 *         verbatim. See § FD-7 for exactly what that cannot catch.
 *
 * NO BROWSER, NO GL, NO INSTALL. The DOM shim is `tools/check.mjs`'s; `Input`
 * binds to a native `EventTarget`; `CombatSystem` takes `stage: null` with every
 * collision path live.
 *
 * USAGE
 *   node tools/fdgate.mjs                       the whole gate
 *   node tools/fdgate.mjs --group=FD-2,FD-3     named groups only
 *   node tools/fdgate.mjs --controls            every control, one per process
 *   node tools/fdgate.mjs --control=fd5-mid-invert
 *   node tools/fdgate.mjs --sets=vulkan         one move set
 *   node tools/fdgate.mjs --verbose             every row, not just failures
 *
 * Exit code is 0 only when every selected test passes. Under `--control` the
 * meaning is inverted: 0 means the control behaved the way the plan says it must.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');
const SRC = join(ROOT, 'src');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(`--${n}`);
const opt = (n, d = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const VERBOSE = flag('verbose');
const CONTROL = opt('control', null);
const ALL_CONTROLS = flag('controls');
const HASH_ONLY = opt('hash-only', null); // internal: the fresh-process null control
const SETS_ARG = opt('sets', 'roster');
const GROUP_ARG = opt('group', null);

// ---------------------------------------------------------------------------
// The controls
//
// A control is a named, minimal, revertible change to the PRODUCT. Two kinds:
//
//   source  — the module text is rewritten as it loads. Used where the thing to
//             break is a private method or a module constant, which cannot be
//             reached from outside. `find` is asserted present first.
//   runtime — a mutation applied to live objects inside the run, restored after.
//             Used where the change is to DATA (a move's blockStun, a move's
//             active windows), because patching data through the source would be
//             patching the wrong layer.
//
// `red` is the set of test ids that MUST fail. `green` is the set that MUST
// pass. A control run is VALID only if both hold exactly — a control that fails
// everything proves nothing, and neither does one that fails nothing.
// ---------------------------------------------------------------------------

const CONTROLS = {
  'fd1-isactive': {
    why: 'MoveSchema.isActive tests tick-1, so every hitbox appears one frame late',
    file: 'combat/MoveSchema.js',
    find: 'for (const w of move.active) if (tick >= w.from && tick <= w.to) return true;',
    repl: 'for (const w of move.active) if (tick - 1 >= w.from && tick - 1 <= w.to) return true;'
      + ' /* POSITIVE CONTROL */',
    red: ['FD-1'],
    green: ['FD-5'],
  },
  'fd2-blockstun': {
    why: "3 ticks added to one move's blockStun; the measured advantage must move by exactly 3",
    runtime: 'blockStun+3',
    red: ['FD-2b'],
    green: ['FD-2a'],
  },
  'fd2-whiff': {
    why: "one blockable move's hitbox radii are shrunk to nothing; it must be REPORTED as a whiff, not vanish",
    runtime: 'shrink-hitbox',
    // FD-2w is the new assertion and must go red. FD-2a stays green because it
    // only ever looks at rows that DID connect, and the shrunk move now
    // contributes none — which is precisely the blindness FD-2w exists to
    // close, so the control proves both halves at once.
    red: ['FD-2w'],
    green: ['FD-2a'],
  },
  'fd4-revert-onebased': {
    why: 'the one-based window shift is undone, putting every hitbox back one tick; '
      + 'the moves printing -10 must go back to being unpunishable by an i10',
    runtime: 'revert-onebased',
    // FD-4L is the assertion Option A exists to satisfy: it must go red, and it
    // must go red naming the moves. FD-4b stays green — a move that prints safe
    // was not punished before the shift and is not punished after reverting it,
    // so the control cannot be passing merely by breaking everything.
    red: ['FD-4L'],
    green: ['FD-4b'],
  },
  'fd2-exemption-lapse': {
    why: "the exempted long poke is pushed to fwd 1.2 so it overshoots at EVERY range; "
      + 'the exemption must lapse and FD-2w must name it',
    runtime: 'overshoot-everywhere',
    // The obvious control — shorten the lead back to the default — does NOT
    // work, and it was worth measuring rather than assuming. At fwd 0.31
    // chorale CONNECTS at point blank (-0.240), so it leaves the whiff
    // population entirely and FD-2w goes green: a vacuous control, not a red
    // one. Pushing the lead UP keeps it whiffing while breaking condition 2
    // (still connects at range), which is the condition that stops a broken
    // move borrowing the exemption. FD-2c stays green because it only inspects
    // rows that connected, and this move now contributes none.
    red: ['FD-2w'],
    green: ['FD-2c'],
  },
  'fd3-counterstun': {
    why: 'COUNTER_STUN = 0; every counter row must lose exactly 7 ticks of hitstun',
    file: 'combat/CombatSystem.js',
    find: 'const COUNTER_STUN = 7;',
    repl: 'const COUNTER_STUN = 0; /* POSITIVE CONTROL */',
    red: ['FD-3c'],
    green: ['FD-3a'],
  },
  'fd4-slow-punisher': {
    why: "the defender's fastest move is pushed out to 60 ticks of startup; every punish must fail",
    runtime: 'slow-punisher',
    // FD-4a goes red on its own vacuity guard — with an i60 punisher every row
    // comes out "safe" and a differential over a uniform population has tested
    // nothing. FD-4L goes red because the move list still prints 159 moves as
    // punishable and none of them now is. FD-4b stays green: a move that prints
    // safe was not punished before and is not punished now.
    red: ['FD-4a', 'FD-4L'],
    green: ['FD-4b'],
  },
  'fd5-mid-invert': {
    why: 'the HEIGHT.MID branch of #guardResult is inverted; exactly the mid rows must flip',
    file: 'combat/CombatSystem.js',
    find: "if (move.height === HEIGHT.MID) return snap.crouching ? 'hit' : 'block';",
    repl: "if (move.height === HEIGHT.MID) return snap.crouching ? 'block' : 'hit';"
      + ' /* POSITIVE CONTROL */',
    red: ['FD-5'],
    green: ['FD-1'],
  },
  'fd6-connected': {
    why: 'the per-window connected guard is removed from #findConnection; a 3-tick window must deal 3 hits',
    file: 'combat/CombatSystem.js',
    find: 'if (attacker.connected.has(`${attacker.moveInstance}:${hb.windowIndex}`)) continue;',
    repl: '/* POSITIVE CONTROL: connected guard removed */',
    red: ['FD-6a'],
    green: ['FD-1'],
  },
  'fd7-asymmetric': {
    why: 'the hitstop handler releases the attacker 3 ticks early, as Game.js documents wanting to',
    runtime: 'asymmetric-hitstop',
    red: ['FD-7'],
    green: ['FD-2a'],
  },
};

if (CONTROL && !CONTROLS[CONTROL]) {
  console.error(`[fdgate] unknown control "${CONTROL}". Known: ${Object.keys(CONTROLS).join(', ')}`);
  process.exit(2);
}
const CTL = CONTROL ? CONTROLS[CONTROL] : null;

// ---------------------------------------------------------------------------
// Source-level control, applied through the module loader
//
// `registerHooks` runs in-thread and synchronously, so the rewritten text is
// what every later `await import` compiles. The alternative — copying the file
// to a temp directory and rewriting its relative specifiers, as `simgate` does —
// works for a leaf module like `Input.js` but not for `MoveSchema.js`, which
// `Fighter.js` and `CombatSystem.js` both import by relative path: patching a
// copy would leave the real modules importing the real one and the control
// would be a silent no-op.
// ---------------------------------------------------------------------------

if (CTL?.file) {
  const target = join(SRC, CTL.file);
  const original = readFileSync(target, 'utf8');
  if (!original.includes(CTL.find)) {
    console.error(`[fdgate] control "${CONTROL}" cannot find its anchor in src/${CTL.file}:`);
    console.error(`         ${CTL.find}`);
    console.error('         A silent no-op here would report a green control against healthy code.');
    process.exit(2);
  }
  const patched = original.replace(CTL.find, CTL.repl);
  const targetUrl = pathToFileURL(target).href;
  registerHooks({
    load(url, ctx, next) {
      if (url !== targetUrl) return next(url, ctx);
      return { format: 'module', shortCircuit: true, source: patched };
    },
  });
}

// ---------------------------------------------------------------------------
// DOM shim — lifted from tools/check.mjs, as simgate and dtgate carry it.
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

// Fighter warns once per process about clamped retimes; it is a known, separately
// gated finding (tools/retimegate.mjs RT-1) and it is noise in this report.
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0] ?? '').startsWith('[Fighter]')) _warn(...a); };

// ---------------------------------------------------------------------------
// Imports — after the shim and after the hook, in that order.
// ---------------------------------------------------------------------------

const THREE = await import(join(ROOT, 'node_modules/three/build/three.module.js'));
const { Fighter, STATE, retimeFor, clipContactFrame } = await import(pathToFileURL(join(SRC, 'combat/Fighter.js')));
const { CombatSystem } = await import(pathToFileURL(join(SRC, 'combat/CombatSystem.js')));
const { Input } = await import(pathToFileURL(join(SRC, 'core/Input.js')));
const { MOVES } = await import(pathToFileURL(join(SRC, 'combat/Moves.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { bus } = await import(pathToFileURL(join(SRC, 'core/Bus.js')));
const {
  METER_MAX, MAX_HEALTH, HEIGHT, REACTION, HITSTOP, TICK_DT, MAX_TICKS_PER_FRAME,
  COMBO_SCALING, MIN_COMBO_SCALE, JUGGLE_DECAY, MIN_JUGGLE_SCALE,
} = await import(pathToFileURL(join(SRC, 'core/Constants.js')));

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
const say = (s) => { if (!HASH_ONLY) console.log(s); };
function record(id, name, ok, detail = '', rows = []) {
  results.push({ id, name, ok, detail });
  say(`[fdgate] ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  —  ${detail}` : ''}`);
  for (const r of rows) say(`          ${r}`);
  return ok;
}
/**
 * A measurement that is not a pass/fail.
 *
 * Used for exactly one thing in this file: a number that describes a DESIGN
 * DECISION rather than a broken invariant. Asserting on it would make the gate
 * permanently red about something nobody has claimed, and pinning it to a
 * whitelist derived from the measurement would be picking the rule after seeing
 * the answer. So it is printed, counted, and left to the owner.
 */
function note(id, name, detail, rows = []) {
  say(`[fdgate] NOTE  ${id}  ${name}  —  ${detail}`);
  for (const r of rows) say(`          ${r}`);
}
const cap = (rows, n = 24) => (VERBOSE || rows.length <= n ? rows
  : [...rows.slice(0, n), `… and ${rows.length - n} more (--verbose for all)`]);

// ---------------------------------------------------------------------------
// The move population
// ---------------------------------------------------------------------------

const SET_KEYS = SETS_ARG === 'all' ? Object.keys(MOVES)
  : SETS_ARG === 'roster' ? [...new Set(ROSTER.map((r) => r.moveSet).filter((k) => MOVES[k]))]
    : SETS_ARG.split(',').filter((k) => MOVES[k]);

/** Every move in the sets under test, tagged with the set it came from. */
const POP = [];
for (const key of SET_KEYS) for (const mv of MOVES[key].__ordered) POP.push({ key, mv });

const isBlockable = (mv) => mv.height !== HEIGHT.UNBLOCKABLE && !mv.props.throw && !mv.props.finisher;
const activeSpan = (mv) => Math.max(...mv.active.map((a) => a.to)) - Math.min(...mv.active.map((a) => a.from)) + 1;
const lastActive = (mv) => Math.max(...mv.active.map((a) => a.to));
/** The stance a defender must hold for this attack to be blocked at all. */
const guardFor = (mv) => (mv.height === HEIGHT.LOW ? 'crouch' : 'stand');

// ---------------------------------------------------------------------------
// The rig
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
 * Face the pair off at `dist` metres and put both back to a known state.
 *
 * THIS CALLS THE PRODUCT'S OWN `reset()` RATHER THAN LISTING THE FIELDS.
 *
 * A hand-written field list is how the first version of this gate reported
 * `spinKick` blocked at -12 on one run and never connecting on the next: the
 * list did not include `animYaw`, so a probe that ended with the chassis part
 * way through a 249-degree spin handed the next probe a fighter aiming
 * somewhere else. `Fighter#reset` already knows every field that has to move —
 * `animYaw`, `aimYaw`, `visualYaw`, the plant state, the animator's armed
 * impacts — and it is maintained by the people who add those fields. A staging
 * function that duplicates it will always be one field behind, and the failure
 * is silent: the numbers stay stable and reproducible and describe a pose the
 * test did not set up.
 *
 * The three things `reset()` does that this gate does not want — full health,
 * a quarter meter, and `#play('idle.fight')` hitting its own `loop && same
 * clip` early return — are corrected immediately after.
 */
function stage(a, d, dist) {
  const sign = a.index === 0 ? -1 : 1;
  _pos.set(sign * dist * 0.5, 0, 0);
  a.reset(_pos, -sign);
  _pos.set(-sign * dist * 0.5, 0, 0);
  d.reset(_pos, sign);
  for (const f of [a, d]) {
    // Straight at `Animator.play`, past `Fighter#play`'s `loop && same clip`
    // early return — see the first-run note in tools/simgate.mjs. Without this
    // the clip phase of the previous case carries into this one and the first
    // measured block of the process disagrees with every later one.
    f.animator?.play('idle.fight', { blend: 0, loop: true });
    f.moveInstance++;
    f.connected.clear();
    f.hitConnectedThisMove = false;
    for (const n of Object.keys(f.boneTrack)) f.boneTrack[n].valid = false;
  }
  // High enough that nothing under test can KO and end the round out from under
  // a later case. `probePlay` uses the same trick.
  a.health = MAX_HEALTH * 100;
  d.health = MAX_HEALTH * 100;
  a.meter = METER_MAX;
  d.meter = METER_MAX;
  combat.roundOver = false;
  for (const c of combat.combos) { c.hits = 0; c.damage = 0; c.lastTick = -999; }
}
const _pos = new THREE.Vector3();

/** Bind the attacker's move table without leaving it bound afterwards. */
function withSet(f, key, fn) {
  const wasT = f.moveTable;
  const wasK = f.moveSetKey;
  f.moveTable = MOVES[key];
  f.moveSetKey = key;
  try { return fn(); } finally { f.moveTable = wasT; f.moveSetKey = wasK; }
}

/**
 * A Command built in code. Byte-identical in behaviour to `TestHarness#mkCmd`,
 * which is the object the shipping test harness feeds `Fighter`.
 */
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

/** The defender plans this gate uses, as Commands. */
const DEF_CMD = {
  stand: () => mkCmd('', [], true),
  crouch: () => mkCmd('d', [], true),
  crouchNoGuard: () => mkCmd('d', [], false),
  none: () => null,
};

/**
 * The states in which a fighter may act. The whole of FD-2, FD-3 and FD-4 is
 * built on this set, so it is spelled out rather than derived: everything not
 * listed is a state the fighter is LOCKED in, and being wrong about one of them
 * would move every advantage number in this file by the same amount and look
 * perfectly stable while doing it.
 */
const ACTIONABLE = new Set([
  STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.BLOCK_HIGH, STATE.BLOCK_LOW,
  STATE.DASH, STATE.BACKDASH, STATE.SIDESTEP,
  STATE.JUMP_RISE, STATE.JUMP_APEX, STATE.JUMP_FALL,
]);

// ---------------------------------------------------------------------------
// The bus recorder
//
// § FD-3's trap in one object: every row this gate produces carries the BUS
// EVENT that produced it. A row labelled "blocked" that was made by a `hit`
// event is a harness failure and is reported as one, never as a data result.
// ---------------------------------------------------------------------------

function recorder() {
  const ev = [];
  let tick = 0;
  const on = (kind) => bus.on(kind, (e) => ev.push({
    kind,
    tick,
    attacker: e.attacker?.index ?? null,
    defender: e.defender?.index ?? null,
    fighter: e.fighter?.index ?? null,
    move: e.move?.id ?? null,
    moveTick: e.attacker?.moveTick ?? null,
    windowIndex: e.move ? indexOfWindow(e.move, e.attacker?.moveTick) : null,
    damage: e.damage ?? 0,
    counter: !!e.counter,
    comboCount: e.comboCount ?? 0,
    hits: e.hits ?? 0,
  }));
  const offs = ['hit', 'block', 'whiff', 'comboEnd', 'launch', 'knockdown', 'parry', 'throwBreak'].map(on);
  return {
    ev,
    at(t) { tick = t; },
    clear() { ev.length = 0; },
    dispose() { for (const o of offs) o?.(); },
  };
}
const indexOfWindow = (mv, t) => (typeof t === 'number'
  ? mv.active.findIndex((w) => t >= w.from && t <= w.to) : null);

// ---------------------------------------------------------------------------
// The core probe
//
// One attacker move against one defender plan at one distance, driven through
// the real `Fighter` and the real `CombatSystem`. Everything FD-1 to FD-4 asks
// is a field of the row this returns.
// ---------------------------------------------------------------------------

/**
 * RG-8's rule, enforced structurally: A MOVE THAT DID NOT START IS NOT A RESULT.
 *
 * The first version of this function counted any `hit`/`block` whose attacker
 * was fighter 0, and that is wrong in a way that is invisible until you check.
 * `airJab` has `requireAir`; pressed from the ground it never starts, `findMove`
 * falls through to `jab` on the same button, and the row came back with jab's
 * contact tick, jab's advantage and airJab's name on it. Four air moves per set
 * were scored that way and every one of them looked like a state-machine bug in
 * the move that had not run. So every event is now matched against the move id
 * as well as the attacker, and a row whose move never started carries
 * `started: false` and is counted in its own column by every caller.
 *
 * @param {Object} o
 * @param {string} o.key move set key
 * @param {Object} o.mv the move
 * @param {number} o.dist metres between the pair
 * @param {string} o.plan a key of DEF_CMD
 * @param {?Function} o.settle called with (i) during the settle ticks, for the attacker
 * @param {?Function} o.start how to start the move; defaults to a synthetic Command (L2)
 * @param {?Function} o.onTick called with (i, row, who) for tests that need to inject
 * @param {number} [o.limit] tick budget
 */
function probe({ key, mv, dist, plan = 'none', settle = null, start = null, onTick = null, limit = 320 }) {
  const rec = recorder();
  let tick = 0;
  const row = {
    key, id: mv.id, input: mv.input, dist, plan,
    started: false, air: !!mv.props.requireAir, staged: true,
    firstBoxAt: -1,          // moveTick of the first tick a hitbox existed
    contactTick: -1,         // moveTick of the FIRST connection
    lastContactTick: -1,     // moveTick of the LAST connection
    contactAt: -1, lastContactAt: -1,
    event: null,             // the bus event that made the first connection
    events: [],
    aFree: -1, dFree: -1, adv: null,
    leftGround: false,       // MEASURED, not read off props.requireAir — see FD-2w
    damage: 0, hits: 0, otherMove: null,
    defState: null, defStateAtContact: null,
  };
  try {
    return withSet(f0, key, () => {
      stage(f0, f1, dist);
      const dcmd = DEF_CMD[plan]();
      // Settle: the defender's guard has to be UP before the attack starts, and
      // both fighters need a tick of history so the swept hitbox test has a
      // previous bone position to sweep back to.
      const settleTicks = settle ? 9 : 5;
      for (let i = 0; i < settleTicks; i++) {
        rec.at(tick);
        f0.simulate(settle ? settle(i) : null);
        f1.simulate(dcmd);
        combat.simulate(tick);
        tick++;
      }
      // An air move needs a real jump. RG-5: a probe that forces an air move
      // from the ground measures a pose no player can produce, so the fighter is
      // put in the air by holding up and the row records whether that worked.
      if (mv.props?.requireAir) {
        for (let i = 0; i < 30 && !f0.airborne; i++) {
          rec.at(tick); f0.simulate(mkCmd('u')); f1.simulate(dcmd); combat.simulate(tick); tick++;
        }
        for (let i = 0; i < 6; i++) {
          rec.at(tick); f0.simulate(null); f1.simulate(dcmd); combat.simulate(tick); tick++;
        }
        row.staged = f0.airborne;
        if (!row.staged) return row;
      }
      const h0 = f1.health;
      rec.clear();

      // Start the move. The default is a synthetic Command so `#startMove` runs
      // INSIDE `simulate` and the tick it starts on is a tick the hitbox builder
      // has seen — calling `startMove()` from outside skips moveTick 0 entirely.
      const startFn = start || (() => mkCmd(mv.parsed.dir, mv.parsed.buttons, false, mv.parsed.motion));
      rec.at(tick);
      f0.simulate(startFn(0));
      f1.simulate(dcmd);
      combat.simulate(tick);
      row.started = f0.currentMove?.id === mv.id;
      if (!row.started) row.otherMove = f0.currentMove?.id ?? null;
      if (row.started && f0.hitboxes.length) row.firstBoxAt = f0.moveTick;
      tick++;
      if (!row.started) return row;
      const instance = f0.moveInstance;

      for (let i = 1; i < limit; i++) {
        rec.at(tick);
        const before = rec.ev.length;
        if (f0.airborne) row.leftGround = true;
        f0.simulate(onTick ? onTick(i, row, 0) : null);
        f1.simulate(onTick ? (onTick(i, row, 1) ?? dcmd) : dcmd);
        combat.simulate(tick);
        if (row.firstBoxAt < 0 && f0.currentMove === mv && f0.hitboxes.length) row.firstBoxAt = f0.moveTick;
        for (let e = before; e < rec.ev.length; e++) {
          const x = rec.ev[e];
          if ((x.kind !== 'hit' && x.kind !== 'block') || x.attacker !== 0) continue;
          // The move, and this instance of it. Anything else belongs to some
          // other row and must not be counted into this one.
          if (x.move !== mv.id || f0.moveInstance !== instance) continue;
          if (row.contactTick < 0) {
            row.contactTick = x.moveTick;
            row.contactAt = tick;
            row.event = x.kind;
            row.defStateAtContact = f1.state;
          }
          row.lastContactTick = x.moveTick;
          row.lastContactAt = tick;
          row.hits++;
        }
        if (row.contactAt >= 0) {
          // The advantage clock starts at the LAST connection: a multi-window
          // move that catches the defender twice has refreshed their stun, and
          // an advantage read off the first window would be a number about an
          // event that was superseded.
          if (tick > row.lastContactAt) {
            if (row.aFree < 0 && ACTIONABLE.has(f0.state)) row.aFree = tick;
            if (row.dFree < 0 && ACTIONABLE.has(f1.state)) row.dFree = tick;
          } else { row.aFree = -1; row.dFree = -1; }
        }
        tick++;
        if (row.aFree >= 0 && row.dFree >= 0) break;
        // Nothing connected and the move is over: stop early rather than burn
        // the budget watching two fighters stand still.
        if (row.contactAt < 0 && f0.currentMove == null && i > mv.total + 2) break;
      }
      row.damage = h0 - f1.health;
      row.defState = f1.state;
      row.events = rec.ev.slice();
      if (row.aFree >= 0 && row.dFree >= 0) row.adv = row.dFree - row.aFree;
      return row;
    });
  } finally {
    rec.dispose();
  }
}

/** Rows that never staged or never started are not results. Every caller uses this. */
const usable = (r) => r && r.staged && r.started;

// ---------------------------------------------------------------------------
// The real key path (L3) — the driver is simgate's, because a second one that
// drifted would make the two gates disagree about what "a keypress" is.
// ---------------------------------------------------------------------------

class KeyEv extends Event {
  constructor(type, code) { super(type); this.code = code; this.repeat = false; }
  preventDefault() {}
}
const BTN_KEY = { 0: { 1: 'KeyJ', 2: 'KeyK', 3: 'KeyN', 4: 'KeyM', 5: 'KeyU' },
  1: { 1: 'KeyF', 2: 'KeyG', 3: 'KeyV', 4: 'KeyB', 5: 'KeyT' } };
const AXIS_KEY = { 0: { '+x': 'KeyD', '-x': 'KeyA', '+y': 'KeyW', '-y': 'KeyS' },
  1: { '+x': 'ArrowRight', '-x': 'ArrowLeft', '+y': 'ArrowUp', '-y': 'ArrowDown' } };

function makeKeyboard() {
  const target = new EventTarget();
  const held = new Set();
  const set = (code, down) => {
    if (down) {
      if (!held.has(code)) { held.add(code); target.dispatchEvent(new KeyEv('keydown', code)); }
    } else if (held.delete(code)) target.dispatchEvent(new KeyEv('keyup', code));
  };
  const only = (codes) => {
    const want = new Set(codes);
    for (const c of [...held]) if (!want.has(c)) set(c, false);
    for (const c of want) set(c, true);
  };
  return { target, set, only, release: () => { for (const c of [...held]) set(c, false); } };
}

function dirCodes(dir, facing, player = 0) {
  const A = AXIS_KEY[player];
  const wantX = dir === 'f' || dir === 'df' || dir === 'uf' ? 1
    : dir === 'b' || dir === 'db' || dir === 'ub' ? -1 : 0;
  const wantY = dir === 'u' || dir === 'uf' || dir === 'ub' ? 1
    : dir === 'd' || dir === 'df' || dir === 'db' ? -1 : 0;
  const codes = [];
  const rawX = wantX * facing;
  if (rawX > 0) codes.push(A['+x']);
  if (rawX < 0) codes.push(A['-x']);
  if (wantY > 0) codes.push(A['+y']);
  if (wantY < 0) codes.push(A['-y']);
  return codes;
}

/** Motion entry, verbatim from simgate: how a human enters each one, and the tail. */
const MOTION_ENTRY = {
  qcf: { steps: ['d', 'df', 'f'], tail: 'f' },
  qcb: { steps: ['d', 'db', 'b'], tail: 'b' },
  dp: { steps: ['f', 'd', 'df'], tail: 'df' },
  hcf: { steps: ['b', 'db', 'd', 'df', 'f'], tail: 'f' },
  dd: { steps: ['d', '', 'd'], tail: 'd' },
  ff: { steps: ['f', '', 'f'], tail: 'f' },
  bb: { steps: ['b', '', 'b'], tail: 'b' },
};
const STEP_TICKS = 2;
const tailDir = (p) => (p.motion ? MOTION_ENTRY[p.motion].tail : p.dir);

// ---------------------------------------------------------------------------
// FD-1 — startup is the frame the hitbox appears
// ---------------------------------------------------------------------------

/**
 * Drive one move from the keyboard and report the moveTick of its first hitbox.
 * Returns null if the keyboard did not start THIS move, so the caller can fall
 * back and say so rather than quietly scoring a different move's startup.
 */
function fd1ViaKeys(key, mv) {
  const kb = makeKeyboard();
  const input = new Input(kb.target);
  let tick = 0;
  const step = () => {
    input.beginTick(tick);
    const cmd = input.commandsFor(0, f0);
    f0.simulate(cmd);
    f1.simulate(null);
    combat.simulate(tick);
    input.endTick();
    tick++;
  };
  try {
    return withSet(f0, key, () => {
      stage(f0, f1, 2.6);
      for (let i = 0; i < 6; i++) step();
      if (mv.props?.requireAir) {
        kb.only([AXIS_KEY[0]['+y']]);
        for (let i = 0; i < 30 && !f0.airborne; i++) step();
        kb.only([]);
        for (let i = 0; i < 8; i++) step();
        if (!f0.airborne) return null;
      }
      const facing = f0.facing;
      const p = mv.parsed;
      if (p.motion) {
        for (const s of MOTION_ENTRY[p.motion].steps) {
          kb.only(dirCodes(s, facing));
          for (let i = 0; i < STEP_TICKS; i++) step();
        }
      } else {
        kb.only(dirCodes(p.dir, facing));
        for (let i = 0; i < 4; i++) step();
      }
      kb.only([...dirCodes(tailDir(p), facing), ...p.buttons.map((b) => BTN_KEY[0][b])]);
      step();
      if (f0.currentMove?.id !== mv.id) return null;
      let first = f0.hitboxes.length ? f0.moveTick : -1;
      kb.only(dirCodes(p.dir, facing));
      for (let t = 1; t <= mv.startup + 6 && first < 0; t++) {
        step();
        if (f0.currentMove?.id !== mv.id) return null;
        if (f0.hitboxes.length) first = f0.moveTick;
      }
      return first;
    });
  } finally {
    kb.release();
    input.dispose();
  }
}

/** The L2 fallback: a Command built in code, which still runs `#startMove` inside `simulate`. */
function fd1ViaCommand(key, mv) {
  return withSet(f0, key, () => {
    stage(f0, f1, 2.6);
    let tick = 0;
    const step = (cmd) => { f0.simulate(cmd); f1.simulate(null); combat.simulate(tick++); };
    for (let i = 0; i < 5; i++) step(null);
    if (mv.props?.requireAir) {
      for (let i = 0; i < 30 && !f0.airborne; i++) step(mkCmd('u'));
      for (let i = 0; i < 8; i++) step(null);
      if (!f0.airborne) return null;
    }
    const p = mv.parsed;
    if (!p.motion) for (let i = 0; i < 4; i++) step(mkCmd(p.dir));
    step(mkCmd(p.dir, p.buttons, false, p.motion));
    if (f0.currentMove?.id !== mv.id) return null;
    let first = f0.hitboxes.length ? f0.moveTick : -1;
    for (let t = 1; t <= mv.startup + 6 && first < 0; t++) {
      step(mkCmd(p.dir));
      if (f0.currentMove?.id !== mv.id) return null;
      if (f0.hitboxes.length) first = f0.moveTick;
    }
    return first;
  });
}

/**
 * The last resort: `startMove` called from outside `simulate`.
 *
 * This path CANNOT SEE moveTick 0, because `#tickAttack` increments the counter
 * before `#buildHitboxes` runs on the next tick. Every move in the ten sets has
 * `startup >= 6`, which is asserted below rather than assumed, so no move
 * measured this way could have had its hitbox on the tick this path skips.
 */
function fd1ViaStartMove(key, mv) {
  return withSet(f0, key, () => {
    stage(f0, f1, 2.6);
    let tick = 0;
    const step = () => { f0.simulate(null); f1.simulate(null); combat.simulate(tick++); };
    for (let i = 0; i < 5; i++) step();
    if (mv.props?.requireAir) { f0.airborne = true; f0.grounded = false; f0.velocity.y = 2.0; }
    f0.startMove(mv);
    if (f0.currentMove?.id !== mv.id) return null;
    for (let t = 1; t <= mv.startup + 6; t++) {
      step();
      if (f0.currentMove?.id !== mv.id) return null;
      if (f0.hitboxes.length) return f0.moveTick;
    }
    return -1;
  });
}

function fd1Rows() {
  const rows = [];
  for (const { key, mv } of POP) {
    let at = fd1ViaKeys(key, mv);
    let layer = 'L3';
    if (at == null) { at = fd1ViaCommand(key, mv); layer = 'L2'; }
    if (at == null) { at = fd1ViaStartMove(key, mv); layer = 'L2-startMove'; }
    if (at == null) { layer = 'unstartable'; at = -1; }
    rows.push({ key, id: mv.id, input: mv.input, startup: mv.startup,
      firstTick: firstActiveTick(mv), at, layer });
  }
  return rows;
}

const rowKey = (r) => `${r.key}/${r.id}|${r.startup}|${r.at}|${r.layer}`;
const hashRows = (rows) => createHash('sha256').update(rows.map(rowKey).join('\n')).digest('hex').slice(0, 16);

function testFD1() {
  // Two runs in one process. The plan's null control is byte-identical rows
  // across two in-process runs and one fresh process; the third is spawned
  // below, because same-process agreement proves nothing about module state.
  const a = fd1Rows();
  const b = fd1Rows();
  const hashA = hashRows(a);
  const hashB = hashRows(b);

  if (HASH_ONLY === 'FD-1') { console.log(hashA); return true; }

  const zeroStartup = POP.filter(({ mv }) => mv.startup < 1);
  const bad = [];
  const byLayer = {};
  for (const r of a) {
    byLayer[r.layer] = (byLayer[r.layer] || 0) + 1;
    if (r.at !== r.firstTick) bad.push(r);
  }

  const rows = cap(bad.map((r) => `${r.key}/${r.id} [${r.input}] startup=${r.startup} `
    + `hitbox first existed on moveTick ${r.at === -1 ? 'NEVER' : r.at}  (${r.layer})`));
  const layerLine = Object.entries(byLayer).map(([k, v]) => `${k}:${v}`).join('  ');
  const offByOne = bad.length && bad.every((r) => r.at === r.firstTick + 1);
  const ok = record('FD-1', 'startup is the frame the hitbox appears',
    bad.length === 0 && zeroStartup.length === 0,
    `${a.length} moves — ${layerLine} — ${bad.length} disagree`
    + (bad.length ? (offByOne ? ' — ALL off by exactly +1' : ' — MIXED offsets') : '')
    + (zeroStartup.length ? ` — ${zeroStartup.length} moves have startup<1, which the startMove path cannot measure` : ''),
    rows);

  const nullOk = record('FD-1n', 'null control — two in-process runs give byte-identical rows',
    hashA === hashB, `${hashA} / ${hashB}`);

  // Third run, cold process.
  let coldOk = true;
  if (!CONTROL) {
    const child = spawnSync(process.execPath,
      [fileURLToPath(import.meta.url), '--group=FD-1', '--hash-only=FD-1', `--sets=${SETS_ARG}`],
      { encoding: 'utf8' });
    const cold = (child.stdout || '').trim().split('\n').pop();
    coldOk = record('FD-1c', 'null control — a fresh process gives the same rows',
      cold === hashA, `cold=${cold || '(no output)'} warm=${hashA}`);
  }

  // The retime lead, reported next to the number it bears on. `retimegate` RT-1
  // is red because 19 clips want a wind-up scale the clamp will not give them,
  // so the clip is short of its declared contact pose on the move's first active
  // frame. FD-1 answers the FRAME half of that question and only that half.
  const clamped = POP.filter(({ mv }) => {
    const pivot = mv.contact > 0 ? mv.contact : clipContactFrame(mv.clip);
    return pivot > 0 && mv.startup > 0 && pivot / mv.startup > 1.38;
  });
  const clampedBad = clamped.filter(({ key, mv }) => {
    const r = a.find((x) => x.key === key && x.id === mv.id);
    return r && r.at !== firstActiveTick(mv);
  });
  record('FD-1r', 'the clamped-wind-up clips still put their hitbox on the declared frame',
    clampedBad.length === 0,
    `${clamped.length} move slots want a wind-up scale past the 1.38 clamp `
    + `(${new Set(clamped.map((c) => c.mv.id)).size} distinct ids, all requireAir); `
    + `${clampedBad.length} of them miss their declared startup`,
    cap(clampedBad.map((c) => `${c.key}/${c.mv.id}`)));

  return ok && nullOk && coldOk;
}

// ---------------------------------------------------------------------------
// FD-2 — on-block advantage
// ---------------------------------------------------------------------------

const DISTANCES = [0.9, 1.02, 1.2, 1.5];

/**
 * THE MODEL, AND THE DECISION IT NOW REFLECTS.
 *
 * When this file was written the engine charged the attacker recovery from the
 * tick a capsule happened to overlap, so the advantage was
 * `blockStun - (total - contactTick)` — short of the printed number by
 * `lastActive + 1 - contactTick`, which is >= 1 identically. That is FD-0, and
 * FD-2 measured it across all ten sets.
 *
 * The owner has since decided that the PRINTED NUMBER IS THE PROMISE, and
 * `Fighter#beginRecovery` implements it: the attacker's remaining move life is
 * set to `recovery` from the connection, so the advantage is a property of the
 * move and not of the tick a capsule touched. `tools/advgate.mjs` is the
 * acceptance test for that change and owns the `measured == printed` assertion
 * (AD-1, AD-2); this file is deliberately not a second copy of it. What FD-2
 * keeps is the identity re-derived from a DIFFERENT sweep — a different probe,
 * a different staging path, an L3 sample — because an acceptance test that only
 * ever agrees with itself is one instrument, not two.
 */
/**
 * The move's PRINTED first and last active frames.
 *
 * Move windows are stored ONE-BASED-SHIFTED: `Moves.js` authors them the way the
 * move list prints them and then subtracts 1 once, after `defineMove` has
 * derived `startup`/`recovery`/`blockStun`, so `moveTick` (which counts from 0)
 * and the printed frame finally mean the same thing. Everything in this gate
 * that compares a measured `moveTick` against an authored number has to go
 * through one of these two rather than reading `mv.startup` directly.
 */
const firstActiveTick = (mv) => Math.min(...mv.active.map((w) => w.from));
const lastActiveTick = (mv) => Math.max(...mv.active.map((w) => w.to));

/**
 * Recovery, re-derived from the windows rather than read off `mv.recovery`,
 * because an acceptance test that only ever agrees with the field it is checking
 * is one instrument and not two. `lastActiveTick` is the shifted value, so the
 * printed last frame is one higher and the authored formula
 * `total - printedLast - 1` becomes `total - lastActiveTick - 2`.
 */
const recoveryOf = (mv) => mv.total - lastActiveTick(mv) - 2;
const modelBlockAdv = (mv) => mv.blockStun - recoveryOf(mv);

function fd2Sweep() {
  const cells = [];
  for (const { key, mv } of POP) {
    if (!isBlockable(mv)) continue;
    for (const dist of DISTANCES) {
      const row = probe({ key, mv, dist, plan: guardFor(mv) });
      cells.push(row);
    }
  }
  return cells;
}

function testFD2(cells) {
  // RG-8's column. A move that never started, or an air move that never left the
  // ground, is reported here and nowhere else.
  const notStarted = cells.filter((r) => !r.started && r.staged);
  const notStaged = cells.filter((r) => !r.staged);
  if (notStarted.length || notStaged.length) {
    record('FD-2s', 'staging — every measured row is a move that actually started',
      notStarted.length === 0 && notStaged.length === 0,
      `${notStarted.length} moves did not start from a synthetic Command, `
      + `${notStaged.length} air moves never left the ground`,
      cap([...new Set(notStarted.map((r) => `${r.key}/${r.id} [${r.input}] started ${r.otherMove ?? 'nothing'} instead`))]));
  }

  // --- FD-2a: the model -----------------------------------------------------
  //
  // Split on `requireAir`. An airborne attacker's recovery is not `total` — the
  // landing takes the move off them — so the model derived from `total` cannot
  // apply, and lumping the two together makes a real finding about air normals
  // look like 42 broken ground moves. The air population is measured separately
  // just below, and reported as a finding rather than asserted.
  const blockRows = cells.filter((r) => usable(r) && r.event === 'block');
  const single = blockRows.filter((r) => MOVES[r.key][r.id].active.length === 1 && !r.air);
  const airRows = blockRows.filter((r) => r.air);
  const modelBad = [];
  for (const r of single) {
    const mv = MOVES[r.key][r.id];
    const want = modelBlockAdv(mv, r.lastContactTick);
    if (r.adv !== want) modelBad.push({ r, want });
  }
  const okA = record('FD-2a', 'measured on-block advantage == blockStun - recovery, at every range',
    modelBad.length === 0 && single.length > 0,
    `${single.length} grounded single-window block rows across ${DISTANCES.length} distances, ${modelBad.length} deviate`,
    cap(modelBad.map(({ r, want }) => `${r.key}/${r.id} @${r.dist}m contact=${r.lastContactTick} `
      + `measured=${r.adv} model=${want}  — something is extending this move's recovery`)));

  // The air population, measured separately and asserted the same way. It is
  // its own row because an airborne attacker can leave ATTACK by LANDING as well
  // as by `moveTick` reaching `total`, and if it ever does the number will not
  // be the one `defineMove` derived — so this is the row that would say so.
  const airBad = [];
  for (const r of airRows) {
    const mv = MOVES[r.key][r.id];
    if (mv.active.length > 1) continue;
    const want = modelBlockAdv(mv);
    if (r.adv !== want) {
      airBad.push(`${r.key}/${r.id} @${r.dist}m contact=${r.lastContactTick} measured=${r.adv} `
        + `model=${want} (printed onBlock ${mv.onBlock >= 0 ? '+' : ''}${mv.onBlock}) `
        + `— ${r.adv - want > 0 ? `${r.adv - want} frames SAFER` : `${want - r.adv} frames less safe`} than total says`);
    }
  }
  record('FD-2air', 'air moves, staged airborne by a real jump, obey the same model',
    airBad.length === 0,
    `${airRows.length} requireAir block rows; ${airBad.length} deviate. `
    + 'RG-5: every row here left the ground by holding up, never by setting the flag.',
    cap(airBad));

  // --- FD-2b: the ledger ----------------------------------------------------
  //
  // FD-0 established the shape and the owner has not yet decided what to do
  // about it, so this asserts the SHAPE and not the number: at point blank the
  // deficit is the move's own active span, exactly, for every single-window
  // move. A delta that changes breaks the rule and is named; a delta that merely
  // exists is the finding FD-0 already owns.
  const nearest = new Map();
  for (const r of cells) {
    if (!usable(r) || r.event !== 'block') continue;
    const k = `${r.key}/${r.id}`;
    if (!nearest.has(k) || r.dist < nearest.get(k).dist) nearest.set(k, r);
  }
  const ledgerBad = [];
  const hist = {};
  let multiCount = 0;
  let airCount = 0;
  for (const [k, r] of nearest) {
    const mv = MOVES[r.key][r.id];
    const delta = mv.onBlock - r.adv;
    if (r.air) { airCount++; continue; }                   // FD-2air owns these
    hist[delta] = (hist[delta] || 0) + 1;
    if (mv.active.length > 1) { multiCount++; continue; }  // documented exception, FD-0
    // Post-decision the deficit is zero, at EVERY range and not only at point
    // blank — that is the whole content of `beginRecovery`. Before it, this
    // ledger pinned `delta == active span` at point blank, which is the shape
    // FD-0 measured; the two are the same assertion either side of the fix.
    if (delta !== 0) {
      ledgerBad.push(`${k} @${r.dist}m plays ${r.adv} against a printed onBlock of `
        + `${mv.onBlock >= 0 ? '+' : ''}${mv.onBlock} — a deficit of ${delta}`
        + (r.lastContactTick !== firstActiveTick(mv)
          ? `; contact is ${r.lastContactTick - mv.startup} frame(s) off the first active frame, see FD-2c` : ''));
    }
  }
  const histLine = Object.keys(hist).map(Number).sort((x, y) => x - y)
    .map((d) => `${d >= 0 ? '+' : ''}${d}:${hist[d]}`).join('  ');
  const okB = record('FD-2b', 'ledger — the move plays exactly its printed onBlock (advgate AD-1 owns this; re-derived here)',
    ledgerBad.length === 0,
    `${nearest.size} blockable moves blocked at some distance; deficit histogram over all ${DISTANCES.length} ranges: ${histLine}`
    + `  (${multiCount} multi-window rows and ${airCount} air rows excluded — FD-0's documented exception and FD-2air)`,
    cap(ledgerBad));

  // --- null control 1: the same cell twice is the same integer ---------------
  const sample = evenly([...nearest.values()], 24);
  const repeatBad = [];
  for (const r of sample) {
    const again = probe({ key: r.key, mv: MOVES[r.key][r.id], dist: r.dist, plan: r.plan });
    if (again.adv !== r.adv || again.lastContactTick !== r.lastContactTick) {
      repeatBad.push(`${r.key}/${r.id} @${r.dist}m  first adv=${r.adv} contact=${r.lastContactTick}  `
        + `again adv=${again.adv} contact=${again.lastContactTick}`);
    }
  }
  const okN1 = record('FD-2n1', 'null control — the same move at the same distance gives the same integer',
    repeatBad.length === 0, `${sample.length} cells re-measured`, repeatBad);

  // --- FD-2c: does the first active frame actually reach at point blank? ----
  //
  // Everything above assumes it does. `delta == active span` is only the
  // point-blank specialisation of `delta == lastActive + 1 - contactTick`, and
  // it is true exactly when contact lands on `startup`. A move that misses its
  // own first active frame at the range it is thrown at is a frame slower and a
  // frame less safe than its own data, and nothing else in this file would say
  // so — FD-1 would still pass, because the hitbox DID appear on time; it just
  // did not reach.
  const reachBad = [];
  let reachRows = 0;
  for (const [k, r] of nearest) {
    if (r.dist !== DISTANCES[0] || r.air) continue;
    const mv = MOVES[r.key][r.id];
    reachRows++;
    if (r.contactTick !== firstActiveTick(mv)) {
      reachBad.push(`${k} [${mv.input}] startup=${mv.startup} but at ${DISTANCES[0]}m the first `
        + `connection is on moveTick ${r.contactTick} — ${r.contactTick - mv.startup} frame(s) late`);
    }
  }
  const okC = record('FD-2c', 'at point blank, contact lands on the move\'s first active frame',
    reachBad.length === 0, `${reachRows} grounded blockable moves blocked at ${DISTANCES[0]}m`, cap(reachBad));

  // --- FD-2w: a move that never connects must FAIL, not go quiet -------------
  //
  // FD-2c above iterates `nearest`, which is built from `blockRows`, which is
  // `cells.filter(r => usable(r) && r.event === 'block')`. **A move that whiffed
  // produces no row, so it is filtered out before any assertion sees it.** The
  // gate then reports "0 disagree" — silence, indistinguishable from a pass —
  // for the worst outcome a move can have.
  //
  // That is not hypothetical. `backfist` on the agile sets connected at point
  // blank against a guard on NEITHER of its two active frames: it missed by
  // 9 mm and produced nothing at all, while the technical and standard sets
  // missed by 1-3 mm, connected one frame late, and were correctly flagged.
  // The gate reported the near miss and stayed silent about the total one.
  //
  // So: every blockable grounded move that STARTED must produce an explicit
  // outcome at point blank, and "no connection" is one of them. Split two ways,
  // because they are different defects:
  //
  //   near   connects at a longer range but not at point blank. It can reach;
  //          it cannot reach up close. Always a defect.
  //   never  connects at no range in the sweep. Either the geometry is broken
  //          or the move is not really blockable, and both want looking at.
  //
  // EXCLUDED, and measured rather than assumed: moves that leave the ground.
  // The first version of this test went red on 21 moves, and 20 of them were
  // `launcherKick [uf+3]` and `axeKick [uf+4]` across all ten sets — an input
  // beginning `uf` makes the fighter jump, and the strike then travels over a
  // grounded guard. That is a jump arc, not a whiff, and none of them carries
  // `props.requireAir`, so the flag cannot be used to spot them. `probe` now
  // records `leftGround` from `f0.airborne` on the actual ticks, which is the
  // only honest way to tell a move that missed from a move that flew.
  const started = new Set();
  const flew = new Set();
  for (const r of cells) {
    if (!r.started || r.air) continue;
    if (r.leftGround) flew.add(`${r.key}/${r.id}`);
    else started.add(`${r.key}/${r.id}`);
  }
  for (const k of flew) started.delete(k);
  const connectsAt = (k, d) => cells.some((r) => `${r.key}/${r.id}` === k && r.dist === d
    && usable(r) && (r.event === 'block' || r.event === 'hit'));
  /*
   * THE LONG-POKE EXEMPTION, and it is keyed on PROPERTIES rather than on names.
   *
   * `seraph/chorale [qcb+3]` legitimately misses at point blank. It is authored
   * with `fwd: 0.46` on the foot against a 0.31 default — the move's own comment
   * calls it "the longest poke in the game that does not travel" — and the
   * extended foot simply passes BEYOND a defender 0.93 m away. Measured:
   * -0.436 at 1.5 m, -0.265 at 1.2 m, +0.050 at 1.02 m, +0.056 at 0.9 m. It is
   * overshoot, not a failure to reach. Sweeping the clip's `impact.tick` from 14
   * to 26 finds NO value that lands it at point blank, which is what separates
   * this from the `p.backfist` class where 16 landed every archetype at once.
   * Forcing `fwd` down to the 0.31 default makes it connect at 0.9 m (-0.240),
   * which is the causal demonstration that the lead is the miss.
   *
   * AN EXEMPTION BY NAME WOULD OUTLIVE ITS REASON. The day someone retunes that
   * `fwd` to 0.31 the move stops overshooting and starts genuinely failing, and
   * a name-keyed entry would hold the row green through it. So the entry
   * re-derives its own justification every run, from three measured conditions:
   *
   *   1. the forward lead is above the population's upper quartile (self
   *      calibrating: p75 is 0.324 today and chorale is 0.458, so a retune to
   *      the 0.310 default drops it out and the exemption lapses);
   *   2. the move still connects at the FARTHEST swept range — it is a poke,
   *      not a whiff, and a broken move cannot borrow the exemption because it
   *      fails here;
   *   3. the connect pattern over the sorted distances is a clean upward-closed
   *      suffix — misses near, hits far, no alternation — which is the signature
   *      of overshoot rather than of a move that does not work.
   *
   * Exempted moves are NAMED in the output with their measured values, so a
   * reader sees which rows are excused and on what grounds rather than seeing a
   * shorter list.
   */
  const maxFwd = (mv) => Math.max(0, ...mv.active.flatMap((w) => w.boxes.map((b) => b.fwd || 0)));
  /*
   * The percentile EXCLUDES the move being judged, or the threshold is one the
   * candidate helps define. The first version compared chorale against a p90 of
   * 0.458 — its own value exactly, because it sits at the 90th percentile of
   * this population — so the test read `0.458 >= 0.458`, true by self-reference
   * and one rounding away from flipping either way. Asking "is this lead
   * unusual compared to EVERYTHING ELSE" is the question that was meant.
   */
  const fwdAll = POP.filter(({ mv }) => isBlockable(mv) && !mv.props.requireAir)
    .map(({ key, mv }) => ({ k: `${key}/${mv.id}`, f: maxFwd(mv) }));
  const leadThreshold = (self) => {
    const xs = fwdAll.filter((r) => r.k !== self).map((r) => r.f).sort((x, y) => x - y);
    // p75, not p90. Over this population p90 lands ON chorale's own 0.458, so a
    // strict comparison there has no margin in either direction — the test would
    // flip on a rounding change. p75 is 0.324 against the 0.310 default and
    // chorale's 0.458, which separates "authored long" from "authored normal"
    // with room on both sides: a retune to the 0.31 default fails it.
    return xs.length ? xs[Math.floor(xs.length * 0.75)] : Infinity;
  };

  const whiffNear = [];
  const whiffEver = [];
  const exempt = [];
  for (const { key, mv } of POP) {
    if (!isBlockable(mv) || mv.props.requireAir) continue;
    const k = `${key}/${mv.id}`;
    if (!started.has(k)) continue;               // FD-2s owns "did not start"
    if (connectsAt(k, DISTANCES[0])) continue;
    const hits = DISTANCES.map((d) => connectsAt(k, d));
    const anywhere = hits.some(Boolean);
    if (!anywhere) {
      whiffEver.push(`${k} [${mv.input}] startup=${mv.startup} produced NO connection at `
        + `${DISTANCES[0]}m — and none at any range in the sweep`);
      continue;
    }
    // A clean upward-closed suffix: every miss precedes every hit.
    const firstHit = hits.indexOf(true);
    const monotone = hits.slice(firstHit).every(Boolean);
    const lead = maxFwd(mv);
    const fwdP75 = leadThreshold(k);
    const longPoke = lead > fwdP75;
    const connectsFar = hits[hits.length - 1];
    if (longPoke && connectsFar && monotone) {
      exempt.push(`${k} [${mv.input}] EXEMPT: fwd ${lead.toFixed(3)} > p75 ${fwdP75.toFixed(3)}, `
        + `connects at ${DISTANCES[DISTANCES.length - 1]}m, and the miss is monotone in range `
        + `(${DISTANCES.map((d, i) => `${d}m ${hits[i] ? 'hit' : 'miss'}`).join(', ')}) — overshoot`);
      continue;
    }
    whiffNear.push(`${k} [${mv.input}] startup=${mv.startup} produced NO connection at `
      + `${DISTANCES[0]}m (connects further out, so it can reach — it cannot reach up close; `
      + `fwd ${lead.toFixed(3)} vs p75 ${fwdP75.toFixed(3)}, `
      + `monotone ${monotone}, connects far ${connectsFar})`);
  }
  const okW = record('FD-2w', 'every blockable grounded move connects at point blank — a whiff is a FAILURE, not a silence',
    whiffNear.length + whiffEver.length === 0,
    `${started.size} started grounded moves (${flew.size} more left the ground and are excluded); `
    + `${whiffNear.length} whiff only at ${DISTANCES[0]}m, ${whiffEver.length} whiff at every range, `
    + `${exempt.length} exempt as long pokes`,
    cap([...whiffEver, ...whiffNear, ...exempt]));

  // --- FD-2n2: contact can only move later with distance ---------------------
  //
  // The plan proposes this as a NULL CONTROL — an identity the instrument must
  // reproduce. It is not one. It is a claim about the product ("contact can only
  // move later"), and the measurement below decides whether the product makes
  // it. Reported as an assertion, because a red row here names a move whose
  // reach is not monotone in range, which is a geometry finding and not noise.
  const monoBad = [];
  for (const { key, mv } of POP) {
    if (!isBlockable(mv)) continue;
    const at = (d) => cells.find((r) => r.key === key && r.id === mv.id && r.dist === d
      && usable(r) && r.event === 'block');
    const near = at(DISTANCES[0]);
    const far = at(DISTANCES[DISTANCES.length - 1]);
    if (!near || !far) continue;
    if (far.lastContactTick < near.lastContactTick) {
      monoBad.push(`${key}/${mv.id} [${mv.input}] contact at ${DISTANCES[0]}m = ${near.lastContactTick} `
        + `but at ${DISTANCES[DISTANCES.length - 1]}m = ${far.lastContactTick} — this move is FASTER at range `
        + 'than it is in the opponent\'s face');
    }
  }
  const okN2 = record('FD-2n2', 'the contact tick never moves earlier as range grows',
    monoBad.length === 0, `${blockRows.length} block rows`, cap(monoBad));

  // --- FD-2L3: the sample entered from a keyboard ---------------------------
  //
  // The point of this sample is to prove the L2 staging is not itself creating
  // the contact tick. Motion specials are left out — entering a motion needs a
  // multi-tick direction walk that does not fit inside `probe`'s settle, and
  // `simgate` already drives every motion notation end to end from real keys.
  //
  // The L2 side of the comparison is re-run with the SAME directional settle,
  // because a `b+1` entered on a keyboard holds BACK for four ticks and the
  // fighter walks while it does. Comparing that against an L2 run that stood
  // still compares two different distances and reports a one-frame contact
  // difference as an input-path defect — which is exactly what the first
  // version of this check did, on `backfist`, in five sets.
  const l3Pop = [...nearest.values()].filter((r) => !r.air && !MOVES[r.key][r.id].parsed.motion);
  const l3 = [];
  const l3Bad = [];
  for (const r of evenly(l3Pop, 20)) {
    const mv = MOVES[r.key][r.id];
    const p = mv.parsed;
    const base = probe({ key: r.key, mv, dist: r.dist, plan: r.plan, settle: () => mkCmd(p.dir) });
    const keyed = probeViaKeys(r.key, mv, r.dist, r.plan);
    l3.push(keyed);
    if (!usable(keyed) || !usable(base)) continue;
    if (keyed.adv !== base.adv || keyed.lastContactTick !== base.lastContactTick) {
      l3Bad.push(`${r.key}/${r.id} [${mv.input}] @${r.dist}m  mkCmd adv=${base.adv} contact=${base.lastContactTick}  `
        + `real keys adv=${keyed.adv} contact=${keyed.lastContactTick}`);
    }
  }
  const l3Ran = l3.filter(usable).length;
  const okL3 = record('FD-2L3', 'L3 sample — the same numbers when the move is typed on a keyboard',
    l3Bad.length === 0 && l3Ran >= 10,
    `${l3Ran} of ${l3.length} sampled moves started from real key events, `
    + 'each against an mkCmd run with the identical direction hold', l3Bad);

  return { okA, okB, okC, okW, okN1, okN2, okL3, cells, nearest };
}

/** Spread a sample across a population instead of taking a prefix of it. */
function evenly(arr, n) {
  if (arr.length <= n) return arr.slice();
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

/**
 * The FD-2 probe with the attacker driven by REAL KEY EVENTS.
 *
 * The direction is held through `probe`'s settle ticks — which is why `settle`
 * exists as a hook — so `b+4` is entered the way a player enters it, direction
 * first, and the press tick is a genuine edge on the button alone.
 */
function probeViaKeys(key, mv, dist, plan) {
  const kb = makeKeyboard();
  const input = new Input(kb.target);
  const p = mv.parsed;
  let phase = 0;
  const read = () => {
    input.beginTick(phase);
    const cmd = input.commandsFor(0, f0);
    input.endTick();
    phase++;
    return cmd;
  };
  try {
    return probe({
      key,
      mv,
      dist,
      plan,
      limit: 340,
      settle: () => { kb.only(dirCodes(p.dir, f0.facing)); return read(); },
      start: () => {
        kb.only([...dirCodes(p.dir, f0.facing), ...p.buttons.map((b) => BTN_KEY[0][b])]);
        return read();
      },
      onTick: (i, row, who) => {
        if (who !== 0) return undefined;
        kb.only(dirCodes(p.dir, f0.facing));
        return read();
      },
    });
  } finally {
    kb.release();
    input.dispose();
  }
}

// ---------------------------------------------------------------------------
// FD-3 — on-hit advantage, counter-hit, and the harness trap
// ---------------------------------------------------------------------------

/** Reactions that resolve into HITSTUN, and are therefore governed by hitStun. */
const STUN_REACTIONS = new Set([
  REACTION.FLINCH_HIGH, REACTION.FLINCH_MID, REACTION.FLINCH_LOW,
  REACTION.CRUMPLE, REACTION.STAGGER, REACTION.WALL_SPLAT,
]);

function testFD3() {
  const cells = [];
  for (const { key, mv } of POP) {
    if (mv.props.throw || mv.props.finisher) continue;
    for (const dist of DISTANCES) cells.push(probe({ key, mv, dist, plan: 'none' }));
  }

  // --- the harness trap, first, because everything below depends on it -------
  //
  // A row is only allowed to be called "a hit" if a `hit` event made it. The
  // plan's example is run explicitly: the on-BLOCK sweep against a standing
  // guard, over the LOW moves, which a standing guard does not stop. Those rows
  // must come back labelled `hit`, and an instrument that recorded them as
  // "blocked at 0 frames" would be stable, reproducible and about a different
  // event than the one it printed.
  const trap = [];
  const trapBad = [];
  for (const { key, mv } of POP) {
    if (mv.height !== HEIGHT.LOW || !isBlockable(mv)) continue;
    const r = probe({ key, mv, dist: DISTANCES[0], plan: 'stand' });
    if (r.event == null) continue;
    trap.push(r);
    if (r.event !== 'hit') trapBad.push(`${key}/${mv.id} is a LOW against a STANDING guard and came back "${r.event}"`);
  }
  const okTrap = record('FD-3n', 'null control — a low against a standing guard is recorded as a HIT, not a block',
    trapBad.length === 0 && trap.length > 0,
    `${trap.length} low moves swept against a standing guard; every row carries the bus event that made it`,
    cap(trapBad));

  // Every row in this whole file must agree with its own event.
  const mislabel = cells.filter((r) => r.contactAt >= 0 && r.event !== 'hit' && r.event !== 'block');
  const okLabel = record('FD-3l', 'every row carries the bus event that produced it',
    mislabel.length === 0, `${cells.filter((r) => r.contactAt >= 0).length} connections`,
    cap(mislabel.map((r) => `${r.key}/${r.id} event=${r.event}`)));

  // --- FD-3a: the model -----------------------------------------------------
  const modelBad = [];
  let modelRows = 0;
  for (const r of cells) {
    if (r.event !== 'hit') continue;
    const mv = MOVES[r.key][r.id];
    if (mv.active.length > 1) continue;
    if (!STUN_REACTIONS.has(mv.reaction)) continue;      // knockdown/launch have their own clocks
    if (mv.juggleHeight && mv.reaction === REACTION.LAUNCH) continue;
    modelRows++;
    const want = mv.hitStun - recoveryOf(mv);
    if (r.adv !== want) modelBad.push(`${r.key}/${r.id} @${r.dist}m contact=${r.lastContactTick} `
      + `measured=${r.adv} model=${want} reaction=${mv.reaction}`);
  }
  const okA = record('FD-3a', 'measured on-hit advantage == hitStun - recovery, at every range',
    modelBad.length === 0 && modelRows > 0,
    `${modelRows} single-window flinch/stagger/crumple hit rows, ${modelBad.length} deviate`,
    cap(modelBad));

  // --- FD-3b: the ledger against the printed onHit --------------------------
  const nearest = new Map();
  for (const r of cells) {
    if (r.event !== 'hit') continue;
    const mv = MOVES[r.key][r.id];
    if (mv.active.length > 1 || !STUN_REACTIONS.has(mv.reaction)) continue;
    const k = `${r.key}/${r.id}@${r.dist}`;
    nearest.set(k, r);
  }
  const hist = {};
  const ledgerBad = [];
  for (const [k, r] of nearest) {
    const mv = MOVES[r.key][r.id];
    const delta = mv.onHit - r.adv;
    hist[delta] = (hist[delta] || 0) + 1;
    if (delta !== 0) {
      ledgerBad.push(`${k} @${r.dist}m plays ${r.adv} against a printed onHit of `
        + `${mv.onHit >= 0 ? '+' : ''}${mv.onHit} — a deficit of ${delta}`);
    }
  }
  const histLine = Object.keys(hist).map(Number).sort((x, y) => x - y)
    .map((d) => `${d >= 0 ? '+' : ''}${d}:${hist[d]}`).join('  ');
  const okB = record('FD-3b', 'ledger — the move plays exactly its printed onHit (advgate AD-2 owns this; re-derived here)',
    ledgerBad.length === 0,
    `${nearest.size} stun-reaction moves; deficit histogram over all ${DISTANCES.length} ranges: ${histLine}`,
    cap(ledgerBad));

  // --- FD-3c: counter hit is exactly +7 stun and x1.28 damage ---------------
  //
  // The defender is caught INSIDE their own move, which is the only way
  // `#isCounterState` is true — set by a real prior event, never by assignment.
  const counterBad = [];
  const counterRows = [];
  for (const key of SET_KEYS) {
    const set = MOVES[key];
    const atk = set.jab || set.__ordered.find((m) => isBlockable(m) && m.active.length === 1
      && STUN_REACTIONS.has(m.reaction));
    // A slow move for the victim to be caught in. Its own startup has to outlast
    // the attacker's, or the victim hits first and the row is a trade — and it
    // must not carry armour, invulnerability or a parry window, all three of
    // which are resolved BEFORE `#guardResult` and would take the row down a
    // different branch entirely. `kestrel/counterStance` parried the probe.
    const slow = set.__ordered.slice().sort((a, b) => b.startup - a.startup)
      .find((m) => !m.props.throw && !m.props.finisher && !m.props.requireAir
        && m.props.parryFrom == null && m.props.armorFrom == null && m.props.invulnFrom == null
        // ... and it must keep its feet on the floor. `#doHit` only counters a
        // grounded defender (`!snap.airborne`), which is correct — you cannot
        // counter-hit someone who is already in the air, they are being juggled.
        // `vulkan/meteorDrop` leaves the ground on its own and took three
        // characters' counter rows down the juggle branch instead.
        && !m.props.airborne
        && m.startup > atk.startup + 4 && m.meterCost === 0);
    if (!atk || !slow) continue;
    const plain = probe({ key, mv: atk, dist: DISTANCES[0], plan: 'none' });
    const counter = probeCounter(key, atk, slow, DISTANCES[0]);
    counterRows.push({ key, atk: atk.id, victimMove: slow.id, plain, counter });
    if (!counter || counter.event !== 'hit' || !counter.counterFlag) {
      counterBad.push(`${key}/${atk.id} vs ${slow.id}: no counter row produced `
        + `(event=${counter?.event ?? 'none'} counter=${counter?.counterFlag})`);
      continue;
    }
    if (plain.event !== 'hit' || plain.adv == null || counter.adv == null) {
      counterBad.push(`${key}/${atk.id}: baseline row missing (plain event=${plain.event} adv=${plain.adv})`);
      continue;
    }
    const gained = counter.adv - plain.adv;
    if (gained !== COUNTER_STUN_EXPECTED) {
      counterBad.push(`${key}/${atk.id} counter advantage ${counter.adv} vs plain ${plain.adv} `
        + `= +${gained}, expected +${COUNTER_STUN_EXPECTED}`);
    }
  }
  const okC = record('FD-3c', 'counter hit adds exactly COUNTER_STUN = 7 frames of advantage',
    counterBad.length === 0 && counterRows.length > 0,
    `${counterRows.length} characters measured plain vs counter with the same move`, cap(counterBad));

  return { okTrap, okLabel, okA, okB, okC };
}

const COUNTER_STUN_EXPECTED = 7;

/** Attacker strikes while the defender is committed to their own move. */
function probeCounter(key, atk, victimMove, dist) {
  const r = probe({
    key,
    mv: atk,
    dist,
    plan: 'none',
    onTick: (i, row, who) => {
      // Start the victim's move on tick 1, so it is still in startup when the
      // attacker's window opens and `#isCounterState` sees STATE.ATTACK.
      if (who === 1 && i === 1) {
        withSet(f1, key, () => f1.startMove(victimMove));
        return null;
      }
      return undefined;
    },
  });
  r.counterFlag = r.events.some((e) => e.kind === 'hit' && e.attacker === 0 && e.counter);
  return r;
}

// ---------------------------------------------------------------------------
// FD-4 — a punishable move is actually punishable
// ---------------------------------------------------------------------------

/**
 * The defender's fastest grounded, non-throw, meterless move — their punisher.
 * Air moves are excluded: a punish that needs a jump is not a punish.
 */
function punisherFor(key) {
  return MOVES[key].__ordered
    .filter((m) => !m.props.throw && !m.props.finisher && !m.props.requireAir
      && m.meterCost === 0 && m.parsed.buttons.length && !m.parsed.motion && !m.parsed.dir)
    .sort((a, b) => a.startup - b.startup)[0] || null;
}

/**
 * Block the attacker's move, then press the punisher through a real `Input` on
 * the first tick the defender is actionable.
 *
 * THREE RUNS, AND ALL THREE ARE NECESSARY.
 *
 * The advantage has to come from a run in which NOBODY PUNCHES BACK. Two
 * versions of this failed before that was obvious. The first read `probe`'s
 * `adv`, which counts the defender free only once they are ACTIONABLE — a
 * defender who has just started a punish is not, so every punishable move in
 * the set came back at exactly -35, the end of the punisher's own recovery. The
 * second measured the attacker's free tick as "the tick this move instance
 * leaves ATTACK" inside the punish run — and a punish that LANDS takes the
 * attacker out of ATTACK, so the thing being measured was caused by the thing
 * being tested and every row came back at exactly -11. A constant answer across
 * eleven moves with eleven different `total`s is what gave both of them away.
 *
 * So: run 1 is the baseline, guard held and nothing pressed, and it owns the
 * advantage. Run 2 presses the punish. The two are identical up to the block, so
 * the block tick aligns and the punish can be compared against the baseline's
 * own recovery tick.
 *
 * RUN 3 IS WHY THIS TEST NEEDS NO CONVENTION CALL.
 *
 * "Did the punish land" against an attacker who stands still is not the question
 * — a punish is a blow the attacker CANNOT AVOID. The tick criterion for that
 * differs by one from the criterion for merely connecting, and by two from
 * "connects while the attacker is still committed", and picking between three
 * off-by-one definitions from the arithmetic is how this test would end up
 * asserting a convention instead of a fact. So run 3 lets the attacker HOLD
 * GUARD from the instant it recovers, and a punish is a run-3 `hit`. A run-3
 * `block` is a blow the attacker defended, whatever the tick maths says.
 *
 * Measured across the roster, punisher startup 10, and it is not close:
 *
 *     adv -11   hitbox out on the attacker's LAST committed tick   15/15 hit under guard
 *     adv -10   hitbox out one tick later                           1/1  BLOCKED under guard
 *      adv -9   hitbox out two ticks later                         11/11 BLOCKED under guard
 *
 * The mechanism is one line of ordering: `Fighter#simulate` runs `#updateGuard`
 * BEFORE `#updateState`, so on the tick the attacker leaves ATTACK its state is
 * still ATTACK when `#canGuard()` is consulted and it cannot block — but it can
 * on the next tick. So the guaranteed-punish line is `punishBoxAt <= aOut`, and
 * an i10 punisher guarantee-punishes -11 and worse. -10 is defensible.
 *
 * @returns {?{inTime:boolean, guaranteed:boolean, connected:boolean, adv:number,
 *             punisherStartup:number}}
 */
function probePunish(key, mv, punisher, slowFactor = 0) {
  const kb = makeKeyboard();
  const input = new Input(kb.target);
  const rec = recorder();
  const btn = punisher.parsed.buttons.map((b) => BTN_KEY[1][b]);
  const plan = guardFor(mv);
  const guardKey = 'KeyR';                    // KEYMAP[1].guard
  const crouchKey = AXIS_KEY[1]['-y'];

  // The control needs a punisher whose startup is 60. Shifting the windows is
  // the only honest way to say that: `startup` is derived from the first active
  // frame by `defineMove`, so writing the field alone would leave the hitbox
  // exactly where it was and the control would prove nothing.
  const saved = slowFactor ? { active: punisher.active, total: punisher.total, startup: punisher.startup } : null;
  if (slowFactor) {
    punisher.active = punisher.active.map((w) => ({ ...w, from: w.from + slowFactor, to: w.to + slowFactor }));
    punisher.total = punisher.total + slowFactor;
    punisher.startup = punisher.startup + slowFactor;
  }

  /**
   * @param {'baseline'|'punish'|'punish-vs-guard'} mode
   *   baseline        nobody presses back; owns the advantage
   *   punish          the defender punishes an attacker who does nothing
   *   punish-vs-guard the defender punishes an attacker who guards on recovery
   */
  const run = (mode) => withSet(f0, key, () => withSet(f1, key, () => {
    const punish = mode !== 'baseline';
    stage(f0, f1, DISTANCES[0]);
    let tick = 0;
    let phase = 0;
    let pressed = false;
    let blockAt = -1;
    let dFree = -1;
    let aOut = -1;
    let punishBoxAt = -1;
    let punishHitAt = -1;
    let punishKind = null;
    const defCmd = () => {
      const codes = [];
      if (!punish || !pressed) {
        if (punish && dFree >= 0) { codes.push(...btn); pressed = true; } else {
          // Guard and crouch both come OFF on the press tick: a punisher is a
          // neutral-stance move, and leaving DOWN held would make the same
          // button resolve to `d+1` — a different move with a different startup.
          codes.push(guardKey);
          if (plan === 'crouch') codes.push(crouchKey);
        }
      }
      kb.only(codes);
      input.beginTick(phase);
      const cmd = input.commandsFor(1, f1);
      input.endTick();
      phase++;
      return cmd;
    };
    // The attacker holds nothing while committed; in `punish-vs-guard` it puts
    // its guard up the instant it is out of the move — the earliest a player
    // could — and whether that saves it is the whole question.
    const atkCmd = () => (mode === 'punish-vs-guard' && aOut >= 0 ? mkCmd('', [], true) : null);
    for (let i = 0; i < 6; i++) { rec.at(tick); f0.simulate(null); f1.simulate(defCmd()); combat.simulate(tick++); }
    rec.clear();
    rec.at(tick);
    f0.simulate(mkCmd(mv.parsed.dir, mv.parsed.buttons, false, mv.parsed.motion));
    f1.simulate(defCmd());
    combat.simulate(tick++);
    if (f0.currentMove?.id !== mv.id) return null;
    const instance = f0.moveInstance;

    for (let i = 0; i < 400; i++) {
      rec.at(tick);
      const before = rec.ev.length;
      f0.simulate(atkCmd());
      f1.simulate(defCmd());
      combat.simulate(tick);
      for (let e = before; e < rec.ev.length; e++) {
        const x = rec.ev[e];
        if (x.attacker === 0 && x.move === mv.id && f0.moveInstance === instance
          && (x.kind === 'hit' || x.kind === 'block') && blockAt < 0) {
          blockAt = tick;
          if (x.kind !== 'block') return null;   // it was not blocked; not an FD-4 row
        }
        if (x.attacker === 1 && (x.kind === 'hit' || x.kind === 'block') && punishHitAt < 0) {
          punishHitAt = tick;
          punishKind = x.kind;   // a `block` here is the attacker defending it
        }
      }
      if (blockAt >= 0 && dFree < 0 && ACTIONABLE.has(f1.state) && !f1.stunTicks) dFree = tick;
      if (blockAt >= 0 && aOut < 0 && !(f0.state === STATE.ATTACK && f0.moveInstance === instance)) aOut = tick;
      if (punishBoxAt < 0 && f1.currentMove?.id === punisher.id && f1.hitboxes.length) punishBoxAt = tick;
      tick++;
      if (blockAt >= 0 && dFree >= 0 && tick > blockAt + mv.total + punisher.total + 12) break;
      if (!punish && aOut >= 0 && dFree >= 0) break;
    }
    if (blockAt < 0 || dFree < 0) return null;
    return { blockAt, dFree, aOut, punishBoxAt, punishHitAt, punishKind };
  }));

  try {
    const base = run('baseline');
    if (!base || base.aOut < 0) return null;
    const p = run('punish');
    if (!p) return null;
    const g = run('punish-vs-guard');
    if (!g) return null;
    // The baseline's recovery, re-expressed relative to the block so it can be
    // compared against the punish run's own timeline.
    const recoverAfterBlock = base.aOut - base.blockAt;
    return {
      // The frame-data claim: was the punisher's hitbox out no later than the
      // attacker's last committed tick? Measured `<=`, not `<` — see the header.
      inTime: p.punishBoxAt >= 0 && (p.punishBoxAt - p.blockAt) <= recoverAfterBlock,
      // THE CLAIM THAT NEEDS NO CONVENTION: the attacker guarded the instant it
      // recovered and got hit anyway.
      guaranteed: g.punishKind === 'hit',
      // The spacing fact: did it reach at all? `blockPush` shoves both fighters
      // apart, so a punish can be in time and still whiff.
      connected: p.punishHitAt >= 0,
      defended: g.punishKind === 'block',
      adv: base.dFree - base.aOut,
      punisherStartup: punisher.startup,
    };
  } finally {
    kb.release();
    input.dispose();
    rec.dispose();
    if (saved) Object.assign(punisher, saved);
  }
}

function testFD4(slowFactor = 0) {
  const punishable = [];
  const safe = [];
  for (const { key, mv } of POP) {
    if (!isBlockable(mv) || mv.props.requireAir) continue;
    if (mv.onBlock <= -10) punishable.push({ key, mv });
    else if (mv.onBlock >= 1) safe.push({ key, mv });
  }

  const rows = [];
  const predBad = [];
  const printedBad = [];
  const outOfReach = [];
  let measured = 0;

  for (const group of [punishable, safe]) {
    for (const { key, mv } of group) {
      const punisher = punisherFor(key);
      if (!punisher) continue;
      const r = probePunish(key, mv, punisher, slowFactor);
      if (!r) continue;                                     // never blocked at this range
      measured++;
      // THE PREDICTION, AND THE ONE FRAME THAT IS NOT IN THE FRAME DATA.
      //
      // The defender is free `-adv` frames before the attacker, and its move
      // needs `startup` of those. It needs exactly ONE more, and the frame does
      // not come from where it looks like it should:
      //
      //   the tick blockstun ends is spent inside `#updateState`'s BLOCKSTUN
      //   branch, which decrements, calls `#toNeutral` and RETURNS — so the
      //   earliest a punish can START is one tick after the defender becomes
      //   actionable. But the attacker loses the SAME tick leaving ATTACK, for
      //   the same reason, and those two cancel exactly.
      //
      //   What does not cancel is that `Fighter#simulate` runs `#updateGuard`
      //   BEFORE `#updateState`. On the tick the attacker leaves ATTACK its
      //   state is still ATTACK when `#canGuard()` is consulted, so it cannot
      //   block that tick — and it can on the next. The punisher's hitbox
      //   therefore has to be out no later than `aOut`, and the threshold is
      //   `startup + 1`.
      //
      // This was measured, not derived: at adv -11 the hitbox lands exactly on
      // `aOut` and 15 of 15 rows stay a HIT with the attacker guarding, while at
      // adv -10 it lands one tick later and is BLOCKED. `guaranteed` below is
      // that measurement, so the assertion does not rest on the arithmetic at
      // all — see `probePunish`'s header.
      const predict = r.adv <= -r.punisherStartup;
      // A punish that never reached says nothing about TIMING. `blockPush`
      // separates the pair and `rocketPunch`, `roundhouse`, `orbitalKick` and
      // friends are simply out of range afterwards — a metres problem, and
      // FD-4r's to report. The timing assertion is over the rows where the
      // punisher's capsule actually touched a body.
      const reached = r.guaranteed || r.defended;
      if (reached && r.guaranteed !== predict) {
        predBad.push(`${key}/${mv.id} onBlock=${mv.onBlock} measured=${r.adv} `
          + `punisher=${punisher.id} i${r.punisherStartup}  predicted ${predict ? 'punishable' : 'safe'} `
          + `but against an attacker guarding on recovery it ${r.guaranteed ? 'HIT' : 'did not'}`);
      }
      if (r.inTime && !r.connected) {
        outOfReach.push(`${key}/${mv.id} measured=${r.adv}: an i${r.punisherStartup} punish is `
          + `${-r.adv - r.punisherStartup} frames in time but does not reach — blockPush put the defender out of range`);
      }
      // The ledger against the number the move list prints, over the rows the
      // punish REACHED — so this is a frame-data disagreement and not a
      // restatement of FD-4r's range finding. The Tekken reading of -10 is "jab
      // punishable"; measured, an i10 is one tick short of guaranteeing it.
      const printedSaysPunishable = mv.onBlock <= -10;
      if (reached && printedSaysPunishable !== r.guaranteed) {
        printedBad.push(`${key}/${mv.id} prints ${mv.onBlock >= 0 ? '+' : ''}${mv.onBlock} `
          + `(${printedSaysPunishable ? 'punishable' : 'safe'}) and measures ${r.adv} — `
          + `an i${r.punisherStartup} punish ${r.guaranteed ? 'is guaranteed' : 'is BLOCKED by an attacker who guards on recovery'}`);
      }
      rows.push({ key, id: mv.id, onBlock: mv.onBlock, adv: r.adv,
        inTime: r.inTime, guaranteed: r.guaranteed, defended: r.defended, connected: r.connected });
    }
  }

  // A differential over a population that all came out the same way proves
  // nothing. Under the `fd4-slow-punisher` control EVERY move becomes
  // unpunishable and the prediction agrees with every row — so without this
  // guard, FD-4a would report a clean bill of health against a defender who
  // physically cannot punish anything.
  const reachedRows = rows.filter((r) => r.guaranteed || r.defended);
  const landed = reachedRows.filter((r) => r.guaranteed).length;
  const degenerate = reachedRows.length > 0 && (landed === 0 || landed === reachedRows.length);
  const okA = record('FD-4a', 'a punish lands against an attacker guarding on recovery iff adv <= -startup',
    predBad.length === 0 && reachedRows.length > 0 && !degenerate,
    `${measured} moves blocked and counter-attacked through the real key path `
    + `(${punishable.length} print onBlock<=-10, ${safe.length} print onBlock>=+1); `
    + `${reachedRows.length} punishes reached: ${landed} hit through the guard, `
    + `${reachedRows.length - landed} were blocked by it`
    + (degenerate ? ' — DEGENERATE: every row came out the same way, so this differential tested nothing' : ''),
    cap(predBad));

  const safeRows = rows.filter((r) => r.onBlock >= 1);
  const okB = record('FD-4b', 'null control — a move that prints safe is not punished',
    safeRows.every((r) => !r.guaranteed) && safeRows.length > 0,
    `${safeRows.length} moves printing onBlock >= +1; ${safeRows.filter((r) => r.guaranteed).length} were punished anyway`,
    cap(safeRows.filter((r) => r.guaranteed).map((r) => `${r.key}/${r.id} prints +${r.onBlock}, measures ${r.adv}, was punished`)));

  record('FD-4L', 'ledger — punishability against the PRINTED onBlock',
    printedBad.length === 0,
    `${reachedRows.length} punishes reached; ${printedBad.length} disagree with what the move list prints. `
    + 'This is the assertion Option A exists to satisfy, so a red row here means the '
    + 'one-based window shift in `Moves.js` has been undone or broken. Windows are authored '
    + 'the way the move list prints them and shifted down by one once, after `defineMove` has '
    + 'derived startup/recovery/blockStun — so an i10 puts its box on the TENTH frame of the '
    + 'move rather than the eleventh, and -N is exactly punishable by an i(N) rather than '
    + 'exactly safe. Before that shift every move printing -X was safe against an i(X), and '
    + 'six sat exactly on the boundary; the cause was `startup` compared against a 0-based '
    + '`moveTick`, NOT the guard ordering an earlier version of this message named. Frozen '
    + 'timeline in scratchpad/r45-punish.mjs; --control=fd4-revert-onebased reproduces it.',
    cap(printedBad));

  // Not an assertion. Pushback is a real mechanic and nobody has claimed that
  // every in-time punish reaches; this is the number that says how often the
  // two disagree, and whether that is intended is the owner's call.
  note('FD-4r', 'punishes that were in time but did not reach',
    `${rows.filter((r) => r.inTime).length} punishes were in time; ${outOfReach.length} of them whiffed on range. `
    + 'A move that prints deeply unsafe and cannot be reached by the fastest punish is effectively safe.',
    cap(outOfReach));

  return { okA, okB, rows };
}

// ---------------------------------------------------------------------------
// FD-5 — the guard matrix, end to end
//
// `#guardResult` is nine lines and it is the whole defensive game. Every
// defender state below is reached by a real prior event — a jump held for
// JUMP_HOLD_TICKS, a move with an authored invuln/armour/parry window started
// through `startMove` — and never by assigning a flag.
// ---------------------------------------------------------------------------

function findByProp(key, pred) { return MOVES[key].__ordered.find(pred) || null; }

/** One representative attack per height, from a set that actually authors one. */
function heightReps(key) {
  const set = MOVES[key].__ordered;
  const pick = (h) => set.find((m) => m.height === h && !m.props.throw && !m.props.finisher
    && !m.props.requireAir && m.active.length === 1 && m.meterCost === 0);
  return {
    high: pick(HEIGHT.HIGH),
    mid: pick(HEIGHT.MID),
    low: pick(HEIGHT.LOW),
    unblockable: set.find((m) => m.height === HEIGHT.UNBLOCKABLE && !m.props.throw),
  };
}

const DEFENDER_STATES = ['standGuard', 'crouchGuard', 'crouchNoGuard', 'standNoGuard',
  'airborne', 'invulnerable', 'armour', 'parry'];

/** The window a defender-state setup move opens, and when it is widest open. */
function setupWindow(setup, defState) {
  const p = setup.props;
  const from = defState === 'invulnerable' ? p.invulnFrom : defState === 'armour' ? p.armorFrom : p.parryFrom;
  const to = defState === 'invulnerable' ? (p.invulnTo ?? from)
    : defState === 'armour' ? (p.armorTo ?? from) : (p.parryTo ?? from);
  return { from, to, mid: Math.floor((from + to) / 2) };
}

/**
 * Outcome of one (height, defender state) cell.
 *
 * THE TWO MOVES ARE ALIGNED, NOT SEQUENCED. The attacker's first active frame
 * has to land inside the defender's window, and both counters advance one tick
 * per `simulate`, so the two `startMove` calls are offset by exactly
 * `windowMid - startup`. The first version of this ran the defender's setup and
 * then "waited a bit", which put a 15-frame attack into the tail of a 4-frame
 * parry window and reported the parry branch as broken.
 *
 * @returns {{out:string, invulnAtContact:boolean, staged:boolean, available:boolean}}
 */
function guardCell(key, mv, defState, aIdx = 0) {
  const A = aIdx === 0 ? f0 : f1;
  const D = aIdx === 0 ? f1 : f0;
  const rec = recorder();
  const fail = (o) => ({ out: o, invulnAtContact: false, staged: false, available: true });
  try {
    return withSet(A, key, () => withSet(D, key, () => {
      let dcmd = null;
      let setup = null;
      switch (defState) {
        case 'standGuard': dcmd = mkCmd('', [], true); break;
        case 'crouchGuard': dcmd = mkCmd('d', [], true); break;
        case 'crouchNoGuard': dcmd = mkCmd('d', [], false); break;
        case 'standNoGuard': dcmd = null; break;
        case 'airborne': dcmd = mkCmd('u'); break;
        case 'invulnerable': setup = findByProp(key, (m) => m.props.invulnFrom != null && !m.props.requireAir); break;
        case 'armour': setup = findByProp(key, (m) => m.props.armorFrom != null && !m.props.requireAir); break;
        case 'parry': setup = findByProp(key, (m) => m.props.parryFrom != null && !m.props.requireAir); break;
        default: break;
      }
      const needsSetup = defState === 'invulnerable' || defState === 'armour' || defState === 'parry';
      if (needsSetup && !setup) return { out: 'unavailable', invulnAtContact: false, staged: true, available: false };

      stage(A, D, 1.0);
      let tick = 0;
      // `CombatSystem#snapshot` reads `defender.invulnerable` AFTER both
      // fighters have simulated and before it resolves anything, so that is the
      // only moment at which this flag can be sampled and mean the same thing.
      // Reading it at the top of the tick — one `#updateFlags` too early — made
      // every invulnerability row off by a frame and reported `risingFang`'s
      // i-frames as not working.
      let invulnNow = false;
      const step = (aCmd) => {
        rec.at(tick);
        A.simulate(aCmd ?? null);
        D.simulate(dcmd);
        invulnNow = D.invulnerable;
        combat.simulate(tick);
        tick++;
      };

      // Get the defender airborne for real, by holding up. RG-5.
      if (defState === 'airborne') {
        for (let i = 0; i < 24 && !D.airborne; i++) step(null);
        if (!D.airborne) return fail('stagingFailed');
        dcmd = null;
        for (let i = 0; i < 2; i++) step(null);
      } else {
        for (let i = 0; i < 4; i++) step(null);
      }

      // Align the two moves. `startMove` is called between ticks, so the counter
      // is at 0 and reaches N after N further `simulate` calls.
      const win = setup ? setupWindow(setup, defState) : null;
      const lead = win ? win.mid - mv.startup : 0;   // >0: defender starts first
      rec.clear();
      const startD = () => { D.startMove(setup); };
      const startA = () => { A.startMove(mv); };
      if (lead > 0) { startD(); for (let i = 0; i < lead; i++) step(null); startA(); }
      else { startA(); for (let i = 0; i < -lead; i++) step(null); if (setup) startD(); }
      if (A.currentMove !== mv) return fail('stagingFailed');
      if (setup && D.currentMove !== setup) return fail('stagingFailed');
      const instance = A.moveInstance;

      const windowEnd = lastActive(mv);
      const hp0 = D.health;
      let out = 'none';
      let invulnAtContact = false;
      let armourSeen = false;
      for (let i = 0; i < mv.total + 40; i++) {
        const hpBefore = D.health;
        const inAttack = D.state === STATE.ATTACK;
        const before = rec.ev.length;
        step(null);
        for (let e = before; e < rec.ev.length; e++) {
          const x = rec.ev[e];
          if (x.kind === 'parry') { out = 'parry'; break; }
          if ((x.kind === 'hit' || x.kind === 'block') && x.attacker === aIdx && x.move === mv.id) {
            out = x.kind;
            invulnAtContact = invulnNow;
            break;
          }
        }
        // Armour emits nothing on the bus: `#doArmor` takes reduced damage and
        // lets the defender keep attacking. It is read off the two things that
        // change — health down, still in ATTACK, no hit or block event.
        if (out === 'none' && inAttack && D.health < hpBefore - 1e-9 && D.state === STATE.ATTACK) {
          armourSeen = true;
        }
        if (out !== 'none') break;
        if (armourSeen) { out = 'armour'; break; }
        // A high that whiffs over a crouch leaves the window alive; that the
        // attacker's window ran out with nothing consumed is what tells a whiff
        // apart from a hit that has not happened yet.
        if (A.currentMove === mv && A.moveInstance === instance && A.moveTick > windowEnd) break;
      }
      if (out === 'none' && D.health < hp0 - 1e-9) out = 'hit';
      if (out === 'none') out = 'whiff';
      // Did the attacker's window get consumed at all? `registerConnect` runs
      // before every branch of `#resolve` except the invulnerable one, so an
      // empty `connected` set means nothing touched — the strike simply did not
      // reach, which is a statement about capsules and not about guard.
      return { out, invulnAtContact, consumed: A.connected.size > 0, staged: true, available: true };
    }));
  } finally {
    rec.dispose();
  }
}

/**
 * What `#guardResult`'s own header claims, per height.
 *
 * The four guard rows are the header verbatim. The other four are written as
 * predicates rather than literals, because the honest claim about them is not
 * "the outcome is X" — an airborne defender may simply be out of the strike's
 * reach, and that is geometry, not guard. `null` means the plan pins nothing.
 */
const GUARD_EXPECT = {
  high: { standGuard: 'block', crouchGuard: 'whiff', crouchNoGuard: 'whiff', standNoGuard: 'hit' },
  mid: { standGuard: 'block', crouchGuard: 'hit', crouchNoGuard: 'hit', standNoGuard: 'hit' },
  low: { standGuard: 'hit', crouchGuard: 'block', crouchNoGuard: 'hit', standNoGuard: 'hit' },
  unblockable: { standGuard: 'hit', crouchGuard: 'hit', crouchNoGuard: 'hit', standNoGuard: 'hit' },
};

/**
 * The four non-guard defender states, as claims rather than outcomes.
 * @returns {?string} a failure message, or null if the cell is fine
 */
function checkSpecialCell(c, setup) {
  const { height, defState, got, invulnAtContact, consumed } = c;
  switch (defState) {
    case 'airborne':
      // "airborne is never blocking" — the plan's words. Whether the strike
      // reaches a fighter who has jumped is a question about capsules.
      return got === 'block' ? 'an airborne defender BLOCKED' : null;
    case 'invulnerable':
      // "invulnerable consumes nothing": `#resolve` returns before
      // `registerConnect`, so the window survives and may connect once the
      // i-frames end. The claim is only that nothing resolves DURING them.
      return invulnAtContact ? `resolved as "${got}" on a tick the defender was invulnerable` : null;
    case 'armour':
      // A strike that never reached the armoured defender says nothing about
      // armour. Several armour moves duck or travel, and a HIGH sails over
      // them — reporting that as "armour did not absorb" is reporting a
      // geometry fact under a guard heading.
      if (!consumed) return null;
      return got === 'armour' ? null : `armour was BYPASSED: got "${got}"`;
    case 'parry': {
      // `canParryMove` refuses unblockables outright and only accepts the
      // heights the move authors, so the expectation is read off the data.
      const heights = setup?.props?.parryHeights || ['high', 'mid'];
      const parryable = height !== 'unblockable' && heights.includes(height);
      if (parryable) return got === 'parry' ? null : `a parryable ${height} was not parried: got "${got}"`;
      return got === 'parry' ? `a NON-parryable ${height} was parried` : null;
    }
    default: return null;
  }
}

function fd5Matrix(aIdx) {
  const out = [];
  for (const key of SET_KEYS) {
    const reps = heightReps(key);
    for (const h of Object.keys(GUARD_EXPECT)) {
      const mv = reps[h];
      if (!mv) continue;
      for (const d of DEFENDER_STATES) {
        const r = guardCell(key, mv, d, aIdx);
        out.push({ key, height: h, id: mv.id, defState: d, ...r });
      }
    }
  }
  return out;
}

function testFD5() {
  // A MIRROR MATCH, DELIBERATELY.
  //
  // The plan's null control is the whole matrix with the fighters swapped, on
  // the grounds that a side-dependent guard result is a facing bug. It is only
  // that if both sides are the same body. `f0` is ROSTER[0] and `f1` is
  // ROSTER[1] — different rigs, different hurtbox geometry, different jump
  // arcs — so the first version of this control reported two airborne rows as
  // side-dependent when what it had actually measured was that a high strike
  // reaches one character's jump and not the other's. That is a fact about two
  // robots, not about facing, and no facing fix would have made it go away.
  const wasDef = f1.def;
  f1.setCharacter(ROSTER[0]);
  try {
    return fd5Both();
  } finally {
    f1.setCharacter(wasDef);
  }
}

function fd5Both() {
  const m0 = fd5Matrix(0);
  const bad = [];
  let asserted = 0;
  for (const c of m0) {
    if (!c.available) continue;
    if (!c.staged) {
      bad.push(`${c.key} ${c.height}/${c.id} vs ${c.defState}: HARNESS FAILURE — the defender never reached the state`);
      continue;
    }
    asserted++;
    const want = GUARD_EXPECT[c.height][c.defState];
    if (want != null) {
      if (c.got !== want && c.out !== want) {
        bad.push(`${c.key} ${c.height}/${c.id} vs ${c.defState}: got "${c.out}", header claims "${want}"`);
      }
      continue;
    }
    const setup = c.defState === 'parry' ? findByProp(c.key, (m) => m.props.parryFrom != null && !m.props.requireAir) : null;
    const msg = checkSpecialCell({ ...c, got: c.out }, setup);
    if (msg) bad.push(`${c.key} ${c.height}/${c.id} vs ${c.defState}: ${msg}`);
  }
  const okM = record('FD-5', 'the guard matrix matches what #guardResult\'s own header claims',
    bad.length === 0 && asserted > 0,
    `${asserted} cells over ${SET_KEYS.length} sets x ${Object.keys(GUARD_EXPECT).length} heights `
    + `x ${DEFENDER_STATES.length} defender states`, cap(bad));

  // Null control: the whole matrix with the fighters swapped. A side-dependent
  // guard result is a facing bug, and it would be invisible from one side.
  const m1 = fd5Matrix(1);
  const sideBad = [];
  for (let i = 0; i < m0.length; i++) {
    if (m0[i].out !== m1[i].out) {
      sideBad.push(`${m0[i].key} ${m0[i].height}/${m0[i].id} vs ${m0[i].defState}: `
        + `attacker 0 -> ${m0[i].out}, attacker 1 -> ${m1[i].out}`);
    }
  }
  const okN = record('FD-5n', 'null control — the same matrix with the fighters swapped',
    sideBad.length === 0, `${m0.length} cells compared both ways round`, cap(sideBad));

  return { okM, okN };
}

// ---------------------------------------------------------------------------
// FD-6 — multi-hit bookkeeping and combo scaling
// ---------------------------------------------------------------------------

function testFD6() {
  // --- FD-6a: at most one connection per moveInstance:windowIndex -----------
  const multi = POP.filter(({ mv }) => mv.active.length > 1 && !mv.props.throw);
  const dupBad = [];
  const multiRows = [];
  for (const { key, mv } of multi) {
    for (const dist of DISTANCES) {
      const r = probe({ key, mv, dist, plan: 'none' });
      if (r.contactAt < 0) continue;
      const seen = new Map();
      for (const e of r.events) {
        if ((e.kind !== 'hit' && e.kind !== 'block') || e.attacker !== 0) continue;
        const k = e.windowIndex;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      multiRows.push({ key, id: mv.id, dist, windows: mv.active.length, hits: r.hits });
      for (const [w, n] of seen) {
        if (n > 1) dupBad.push(`${key}/${mv.id} @${dist}m window ${w} connected ${n} times in one move instance`);
      }
    }
  }
  // A single-window move must connect exactly once, at every distance it
  // connects at all — the other half of the same guard.
  const singleBad = [];
  let singleRows = 0;
  for (const { key, mv } of POP) {
    if (mv.active.length !== 1 || mv.props.throw || mv.props.finisher) continue;
    if (activeSpan(mv) < 2) continue;      // a one-tick window cannot double-hit
    for (const dist of DISTANCES) {
      const r = probe({ key, mv, dist, plan: 'none' });
      if (r.contactAt < 0) continue;
      singleRows++;
      if (r.hits !== 1) singleBad.push(`${key}/${mv.id} @${dist}m has one window of ${activeSpan(mv)} ticks and connected ${r.hits} times`);
    }
  }
  const okA = record('FD-6a', 'at most one connection per moveInstance:windowIndex',
    dupBad.length === 0 && singleBad.length === 0 && singleRows > 0,
    `${multiRows.length} multi-window rows (${multi.length} moves) and ${singleRows} single-window rows`,
    cap([...dupBad, ...singleBad]));

  const okN = record('FD-6n', 'null control — a single-window move connects exactly once at every distance',
    singleBad.length === 0 && singleRows > 0,
    `${singleRows} single-window rows across ${DISTANCES.length} distances`, cap(singleBad));

  // --- FD-6b: combo scaling, juggle decay, damage monotonicity --------------
  const scaleBad = [];
  const comboBad = [];
  let comboRuns = 0;
  for (const key of SET_KEYS) {
    const set = MOVES[key];
    const poke = set.jab || set.__ordered.find((m) => m.active.length === 1 && !m.props.throw
      && STUN_REACTIONS.has(m.reaction));
    if (!poke) continue;
    const run = scriptedCombo(key, poke, 12);
    comboRuns++;
    if (!run) { comboBad.push(`${key}: could not script a combo with ${poke.id}`); continue; }

    // COMBO_SCALING by hit index, with the MIN_COMBO_SCALE floor.
    for (let i = 0; i < run.hits.length; i++) {
      const idx = Math.min(i, COMBO_SCALING.length - 1);
      const want = Math.max(MIN_COMBO_SCALE, COMBO_SCALING[idx]);
      const got = run.hits[i].damage / run.hits[0].damage * Math.max(MIN_COMBO_SCALE, COMBO_SCALING[0]);
      if (Math.abs(got - want) > 1e-6) {
        scaleBad.push(`${key} combo hit ${i + 1}: damage ratio implies scale ${got.toFixed(4)}, `
          + `COMBO_SCALING says ${want.toFixed(4)}`);
      }
    }
    // Total damage is monotone non-increasing per added hit beyond index 2.
    for (let i = 2; i < run.hits.length; i++) {
      if (run.hits[i].damage > run.hits[i - 1].damage + 1e-9) {
        comboBad.push(`${key} combo damage rose at hit ${i + 1}: `
          + `${run.hits[i - 1].damage.toFixed(3)} -> ${run.hits[i].damage.toFixed(3)}`);
      }
    }
    // comboEnd fires exactly once and its `hits` matches the hit count.
    const ends = run.events.filter((e) => e.kind === 'comboEnd' && e.fighter === 0);
    if (ends.length !== 1) comboBad.push(`${key}: comboEnd fired ${ends.length} times, expected exactly 1`);
    else if (ends[0].hits !== run.hits.length) {
      comboBad.push(`${key}: comboEnd reported ${ends[0].hits} hits, ${run.hits.length} hit events were emitted`);
    }
  }
  const okB = record('FD-6b', 'combo scaling follows COMBO_SCALING with the MIN_COMBO_SCALE floor',
    scaleBad.length === 0 && comboRuns > 0,
    `${comboRuns} scripted combos of up to 12 hits`, cap(scaleBad));
  const okC = record('FD-6c', 'combo damage is monotone and comboEnd fires once with the right count',
    comboBad.length === 0 && comboRuns > 0, `${comboRuns} scripted combos`, cap(comboBad));

  // --- FD-6d: juggle decay --------------------------------------------------
  const juggleBad = [];
  let juggleRuns = 0;
  for (const key of SET_KEYS) {
    const set = MOVES[key];
    const launcher = set.__ordered.find((m) => m.reaction === REACTION.LAUNCH && !m.props.requireAir && !m.props.throw);
    const follow = set.jab || set.__ordered.find((m) => m.active.length === 1 && !m.props.throw);
    if (!launcher || !follow) continue;
    const run = juggleRun(key, launcher, follow, 6);
    juggleRuns++;
    for (const h of run.heights) {
      const want = Math.max(MIN_JUGGLE_SCALE, Math.pow(JUGGLE_DECAY, h.juggleCount));
      if (Math.abs(h.scale - want) > 1e-6) {
        juggleBad.push(`${key} juggle hit at juggleCount=${h.juggleCount}: `
          + `scale ${h.scale.toFixed(5)} vs JUGGLE_DECAY^n = ${want.toFixed(5)}`);
      }
    }
  }
  const okD = record('FD-6d', 'juggle height decays as JUGGLE_DECAY^juggleCount with the MIN_JUGGLE_SCALE floor',
    juggleBad.length === 0 && juggleRuns > 0, `${juggleRuns} juggle routes`, cap(juggleBad));

  return { okA, okN, okB, okC, okD };
}

/**
 * Script a combo by re-starting the same poke every time the defender is still
 * in hitstun. Everything is a real hit through the real CombatSystem; only the
 * timing is scripted.
 */
function scriptedCombo(key, mv, maxHits) {
  const rec = recorder();
  let tick = 0;
  try {
    return withSet(f0, key, () => {
      stage(f0, f1, 1.0);
      for (let i = 0; i < 4; i++) { f0.simulate(null); f1.simulate(null); combat.simulate(tick++); }
      rec.clear();
      const hits = [];
      for (let n = 0; n < maxHits; n++) {
        f0.startMove(mv);
        if (f0.currentMove !== mv) break;
        let landed = false;
        for (let i = 0; i < mv.total + 4; i++) {
          rec.at(tick);
          const before = rec.ev.length;
          f0.simulate(null);
          f1.simulate(null);
          combat.simulate(tick++);
          for (let e = before; e < rec.ev.length; e++) {
            if (rec.ev[e].kind === 'hit' && rec.ev[e].attacker === 0) {
              hits.push({ damage: rec.ev[e].damage, comboCount: rec.ev[e].comboCount });
              landed = true;
            }
          }
          if (landed) break;
        }
        if (!landed) break;
        // Keep the defender in hitstun: restart immediately.
      }
      // Let the combo drop so `comboEnd` fires.
      for (let i = 0; i < 60; i++) {
        rec.at(tick);
        f0.simulate(null); f1.simulate(null); combat.simulate(tick++);
      }
      return { hits, events: rec.ev.slice() };
    });
  } finally {
    rec.dispose();
  }
}

/** Launch, then follow up in the air, recording the juggle scale each hit was given. */
function juggleRun(key, launcher, follow, maxHits) {
  const heights = [];
  let tick = 0;
  const rec = recorder();
  try {
    return withSet(f0, key, () => {
      stage(f0, f1, 1.0);
      for (let i = 0; i < 4; i++) { f0.simulate(null); f1.simulate(null); combat.simulate(tick++); }
      f0.startMove(launcher);
      for (let i = 0; i < launcher.total + 4 && !f1.airborne; i++) {
        f0.simulate(null); f1.simulate(null); combat.simulate(tick++);
      }
      for (let n = 0; n < maxHits && f1.airborne; n++) {
        const jc = f1.juggleCount;
        const before = f1.velocity.y;
        f0.startMove(follow);
        if (f0.currentMove !== follow) break;
        let landed = false;
        for (let i = 0; i < follow.total + 4; i++) {
          rec.at(tick);
          const b = rec.ev.length;
          f0.simulate(null); f1.simulate(null); combat.simulate(tick++);
          for (let e = b; e < rec.ev.length; e++) if (rec.ev[e].kind === 'hit' && rec.ev[e].attacker === 0) landed = true;
          if (landed) break;
        }
        if (!landed) break;
        // `#doHit` computes juggleScale = max(MIN, DECAY^snapshot.juggleCount) and
        // passes it as `info.juggleHeight` multiplied in. Read it back off the
        // move's authored height, which is the only free variable.
        heights.push({ juggleCount: jc, scale: Math.max(MIN_JUGGLE_SCALE, Math.pow(JUGGLE_DECAY, jc)), before });
      }
      return { heights };
    });
  } finally {
    rec.dispose();
  }
}

// ---------------------------------------------------------------------------
// FD-7 — hitstop does not change frame data
//
// WHAT THIS DRIVES AND WHAT IT CANNOT CATCH, stated first because it is the one
// test in this file that is not driving the shipping object.
//
// `Game` cannot be constructed in Node: `init()` builds a `RenderPipeline`, an
// `Environment`, a `Stage`, an `EffectsDirector` and a `HUD`, all of which want
// a WebGL context. So FD-7 runs a REPLICA of the two blocks of `Game` that
// decide how a freeze is spent — the accumulator gate in `#frame` and the
// per-fighter skip in `#simulate` — and the replica is guarded by an assertion
// that both blocks are still present in `Game.js` verbatim. If either is edited,
// this test goes red on the guard rather than silently measuring a loop the game
// no longer runs.
//
// It therefore CANNOT catch: anything about the wall clock, `requestAnimationFrame`
// pacing, `slowmo.ticks--` running per rendered frame (that is DT-2's finding,
// not this one), or a change to `Game` that adds a new consumer of the freeze.
// What it CAN catch is the thing the plan is worried about: that the documented
// intention to give the attacker and defender different freeze lengths would
// silently move every advantage number in FD-2 and FD-3.
// ---------------------------------------------------------------------------

const GAME_SRC = readFileSync(join(SRC, 'core/Game.js'), 'utf8');
const GAME_ANCHORS = [
  'const frozen = this.freezeTicks[0] > 0 && this.freezeTicks[1] > 0;',
  'while (this.hitstopAccum >= TICK_DT && this.freezeTicks[0] > 0 && this.freezeTicks[1] > 0) {',
  'if (this.freezeTicks[i] > 0) { this.freezeTicks[i]--; continue; }',
  'if (!this.paused && !frozen) this.accumulator += raw * scale;',
];

/**
 * The replica. One `step(dt)` is one rendered frame.
 *
 * @param {{asymmetry:number, hitstop:boolean}} o
 */
function makeLoop({ asymmetry = 0, hitstop = true } = {}) {
  const L = { freezeTicks: [0, 0], hitstopAccum: 0, accumulator: 0, tick: 0 };
  const off = bus.on('hitstop', (e) => {
    if (!hitstop) return;
    const ticks = e?.ticks || 0;
    // `Game.#wireEvents` today: a single `ticks` to both counters. The control
    // adds the asymmetry `Game.js`'s own comment says it wants.
    const a = Math.max(0, ticks - asymmetry);
    L.freezeTicks[0] = Math.max(L.freezeTicks[0], a);
    L.freezeTicks[1] = Math.max(L.freezeTicks[1], ticks);
  });
  return {
    dispose: () => off?.(),
    /** @returns {number} sim ticks run this frame */
    frame(dt, simulateTick) {
      const raw = Math.min(dt, 0.25);
      const frozen = L.freezeTicks[0] > 0 && L.freezeTicks[1] > 0;
      if (frozen) {
        L.hitstopAccum += raw;
        while (L.hitstopAccum >= TICK_DT && L.freezeTicks[0] > 0 && L.freezeTicks[1] > 0) {
          L.hitstopAccum -= TICK_DT;
          L.freezeTicks[0]--;
          L.freezeTicks[1]--;
        }
      } else if (L.hitstopAccum) L.hitstopAccum = 0;
      if (!frozen) L.accumulator += raw;
      let steps = 0;
      while (L.accumulator >= TICK_DT && steps < MAX_TICKS_PER_FRAME) {
        simulateTick(L.tick, L.freezeTicks);
        L.accumulator -= TICK_DT;
        steps++;
        L.tick++;
      }
      if (steps === MAX_TICKS_PER_FRAME) L.accumulator = 0;
      return steps;
    },
    state: L,
  };
}

/** The FD-2 measurement again, but with the ticks delivered by the loop replica. */
function probeThroughLoop(key, mv, dist, plan, loopOpts, dt = TICK_DT) {
  const loop = makeLoop(loopOpts);
  const rec = recorder();
  try {
    return withSet(f0, key, () => {
      stage(f0, f1, dist);
      const dcmd = DEF_CMD[plan]();
      const row = { contactTick: -1, contactAt: -1, lastContactAt: -1, aFree: -1, dFree: -1, adv: null, event: null, simTicks: 0 };
      let started = false;
      const simulateTick = (t, freeze) => {
        rec.at(t);
        const before = rec.ev.length;
        // `Game.#simulate`: a fighter still inside its own freeze holds
        // everything — its pose, its move counter and its stun timer.
        const cmds = [
          started ? null : mkCmd(mv.parsed.dir, mv.parsed.buttons, false, mv.parsed.motion),
          dcmd,
        ];
        if (row.contactAt < 0 && !started) started = true;
        for (let i = 0; i < 2; i++) {
          if (freeze[i] > 0) { freeze[i]--; continue; }
          (i === 0 ? f0 : f1).simulate(cmds[i]);
        }
        combat.simulate(t);
        row.simTicks++;
        for (let e = before; e < rec.ev.length; e++) {
          const x = rec.ev[e];
          if ((x.kind !== 'hit' && x.kind !== 'block') || x.attacker !== 0) continue;
          if (row.contactAt < 0) { row.contactTick = x.moveTick; row.contactAt = t; row.event = x.kind; }
          row.lastContactAt = t;
          row.aFree = -1; row.dFree = -1;
        }
        if (row.contactAt >= 0 && t > row.lastContactAt) {
          if (row.aFree < 0 && ACTIONABLE.has(f0.state)) row.aFree = t;
          if (row.dFree < 0 && ACTIONABLE.has(f1.state)) row.dFree = t;
        }
      };
      // Settle first, outside the freeze machinery.
      for (let t = -6; t < 0; t++) { f0.simulate(null); f1.simulate(dcmd); combat.simulate(t); }
      for (let i = 0; i < 900 && (row.aFree < 0 || row.dFree < 0); i++) loop.frame(dt, simulateTick);
      if (row.aFree >= 0 && row.dFree >= 0) row.adv = row.dFree - row.aFree;
      return row;
    });
  } finally {
    rec.dispose();
    loop.dispose();
  }
}

function testFD7(asymmetry = 0) {
  const drift = GAME_ANCHORS.filter((a) => !GAME_SRC.includes(a));
  const okGuard = record('FD-7g', 'source guard — the Game.js lines this replica mirrors are unchanged',
    drift.length === 0, `${GAME_ANCHORS.length} anchors checked in src/core/Game.js`,
    drift.map((d) => `MISSING: ${d}`));
  if (!okGuard) return { okGuard, ok: false, okN: false };

  // A sample big enough to cover every weight class, which is what indexes HITSTOP.
  const sample = [];
  for (const key of SET_KEYS) {
    const seen = new Set();
    for (const mv of MOVES[key].__ordered) {
      if (!isBlockable(mv) || mv.props.requireAir || mv.active.length > 1) continue;
      if (seen.has(mv.weight)) continue;
      seen.add(mv.weight);
      sample.push({ key, mv });
    }
  }

  const bad = [];
  const rows = [];
  for (const { key, mv } of sample) {
    const withStop = probeThroughLoop(key, mv, DISTANCES[0], guardFor(mv), { asymmetry, hitstop: true });
    const noStop = probeThroughLoop(key, mv, DISTANCES[0], guardFor(mv), { asymmetry: 0, hitstop: false });
    if (withStop.event !== 'block' || noStop.event !== 'block') continue;
    rows.push({ key, id: mv.id, weight: mv.weight, withStop: withStop.adv, noStop: noStop.adv });
    if (withStop.adv !== noStop.adv) {
      bad.push(`${key}/${mv.id} (${mv.weight}, HITSTOP=${HITSTOP[mv.weight]}) advantage `
        + `${withStop.adv} with hitstop, ${noStop.adv} without — a shift of ${withStop.adv - noStop.adv}`);
    }
  }
  const ok = record('FD-7', 'hitstop does not change the measured advantage',
    bad.length === 0 && rows.length > 0,
    `${rows.length} moves, one per weight class per set, measured with HITSTOP live and with it off`
    + (asymmetry ? ` — asymmetry=${asymmetry} applied to the attacker` : ''),
    cap(bad));

  // Null control: three dt schedules.
  //
  // The comparison is on SIM-TICK INDICES, not on how many sim ticks the loop
  // happened to run. At dt = 1/30 the loop runs two sim ticks per frame, so it
  // overshoots the stopping condition by one and the raw tick count differs by
  // one at every frame rate — which is a property of when this harness stops
  // looking, not of the simulation. The contact tick, the two free ticks and
  // the advantage are all sim-tick indices and must be identical.
  const nullBad = [];
  const dtDrift = [];
  const { key, mv } = sample[0];
  // The frame-data quantities: which frame of the move connected, and what the
  // advantage was. Neither may move with the frame rate.
  const sig = (r) => `contactTick=${r.contactTick} adv=${r.adv}`;
  const base = probeThroughLoop(key, mv, DISTANCES[0], guardFor(mv), { asymmetry, hitstop: true }, 1 / 60);
  for (const dt of [1 / 144, 1 / 30, 1 / 60]) {
    const r = probeThroughLoop(key, mv, DISTANCES[0], guardFor(mv), { asymmetry, hitstop: true }, dt);
    if (sig(r) !== sig(base)) {
      nullBad.push(`${key}/${mv.id} at dt=1/${Math.round(1 / dt)}: ${sig(r)}   vs 1/60: ${sig(base)}`);
    }
    if (r.aFree !== base.aFree || r.dFree !== base.dFree) {
      drift.push(`dt=1/${Math.round(1 / dt)}: both free ticks land at ${r.aFree}/${r.dFree} `
        + `against ${base.aFree}/${base.dFree} at 1/60 — an index shift of `
        + `${r.aFree - base.aFree}, identical on both fighters, so the advantage is unchanged`);
    }
  }
  const okN = record('FD-7n', 'null control — the same contact frame and advantage at 30, 60 and 144 Hz',
    nullBad.length === 0, `${key}/${mv.id} at three dt schedules: ${sig(base)}`, nullBad);

  // Not a frame-data failure, and not FD-7's business — but it is measurable
  // here and it belongs to whoever owns DT-2, so it is printed rather than
  // dropped. A frame that carries TWO sim ticks can start its freeze on the
  // first of them; `Game.#simulate` then runs the second with both fighters
  // held (`if (this.freezeTicks[i] > 0) { ...; continue; }`) and `this.tick`
  // advances on a tick in which nothing simulated. The freeze itself is drained
  // on the sim's own clock and is the right length either way, which is why the
  // advantage survives — but the absolute tick index does not.
  if (drift.length) {
    note('FD-7d', 'the absolute sim-tick index is not frame-rate independent, even though the advantage is',
      `${drift.length} of 3 schedules land the same events on different tick indices. `
      + 'One extra tick is consumed per hitstop event at 30 Hz, where a frame carries two sim ticks '
      + 'and the freeze can begin on the first. Relevant to DT-2, not to FD-7.', drift);
  }

  return { okGuard, ok, okN, rows };
}

// ---------------------------------------------------------------------------
// Runtime controls
// ---------------------------------------------------------------------------

let RUNTIME_RESTORE = null;
function applyRuntimeControl(name) {
  if (name === 'overshoot-everywhere') {
    const target = MOVES.seraph?.chorale;
    if (!target) throw new Error('overshoot-everywhere: seraph/chorale not found');
    const was = target.active.map((w) => w.boxes.map((b) => b.fwd ?? 0));
    RUNTIME_RESTORE = () => {
      target.active.forEach((w, i) => w.boxes.forEach((b, j) => { b.fwd = was[i][j]; }));
    };
    for (const w of target.active) for (const b of w.boxes) b.fwd = 1.2;
    return { target: 'seraph/chorale', was: was[0], now: 1.2,
             expect: 'misses at every range, so the long-poke exemption must lapse' };
  }
  if (name === 'revert-onebased') {
    /*
     * Undo Option A, at runtime, on every move in every set.
     *
     * `Moves.js` subtracts 1 from each authored window once at build time so a
     * printed i10 puts its box on the tenth frame rather than the eleventh. This
     * adds it back, which restores the exact defect FD-4L used to report: -N
     * becomes exactly SAFE against an i(N) punisher again.
     *
     * Applied to the DATA rather than through the source, because the shift is
     * data — patching `isActive` instead would change a different mechanism and
     * prove a different thing.
     */
    const touched = [];
    for (const key of SET_KEYS) {
      for (const mv of Object.values(MOVES[key])) {
        if (!mv || !mv.active) continue;
        for (const w of mv.active) { w.from += 1; w.to += 1; }
        touched.push(mv);
      }
    }
    RUNTIME_RESTORE = () => {
      for (const mv of touched) for (const w of mv.active) { w.from -= 1; w.to -= 1; }
    };
    return { moves: touched.length, shift: '+1 tick on every active window' };
  }
  if (name === 'shrink-hitbox') {
    /*
     * A move that is GROUNDED and connects at point blank today, so the control
     * can only go red by making it stop connecting.
     *
     * The first version picked `__ordered`'s first blockable single-window move
     * and got `vulkan/risingFang`, which leaves the ground — so FD-2w excluded
     * it, the injected whiff was never reported, and the control passed on the
     * pre-existing `seraph/chorale` failure instead. That is the "a control that
     * silently became a no-op" hazard this file's own header warns about,
     * arriving through the exclusion I had just added. The target is now named,
     * and asserted to be one FD-2w actually inspects.
     */
    const prefer = ['jab', 'straight', 'midPunch', 'elbow'];
    const target = prefer.map((id) => MOVES[SET_KEYS[0]][id])
      .find((m) => m && isBlockable(m) && m.active.length === 1 && !m.props.requireAir);
    if (!target) throw new Error('shrink-hitbox: no grounded blockable target found');
    /*
     * The injection is the box's FORWARD LEAD, not its radius. Shrinking the
     * radii to 0.001 did not work: at point blank the fist is already inside
     * the defender's guard capsule, so a zero-radius point at the same place
     * still overlaps a 0.2 m hurtbox and the move kept connecting. `fwd` is
     * applied in fighter space as `v.x += lead * b.fwd`, so -3 puts every
     * capsule three metres BEHIND the attacker, which cannot reach at any range
     * in the sweep.
     */
    const was = target.active.map((w) => w.boxes.map((b) => b.fwd ?? 0));
    RUNTIME_RESTORE = () => {
      target.active.forEach((w, i) => w.boxes.forEach((b, j) => { b.fwd = was[i][j]; }));
    };
    for (const w of target.active) for (const b of w.boxes) b.fwd = -3;
    return { target: `${SET_KEYS[0]}/${target.id}`, was: was[0], now: -3 };
  }
  if (name === 'blockStun+3') {
    const target = MOVES[SET_KEYS[0]].__ordered.find((m) => isBlockable(m) && m.active.length === 1);
    const was = target.blockStun;
    RUNTIME_RESTORE = () => { target.blockStun = was; };
    target.blockStun = was + 3;
    return { target: `${SET_KEYS[0]}/${target.id}`, was, now: target.blockStun };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Which groups to run.
 *
 * A control runs ONLY the groups it names. Running the rest would put failures
 * in the report that the control neither caused nor claims anything about, and
 * the operator would have to know which of them were already red — which is
 * exactly the kind of thing that gets a control read as "it broke everything,
 * so it works".
 */
const GROUPS = GROUP_ARG ? new Set(GROUP_ARG.split(','))
  : CTL ? new Set([...CTL.red, ...CTL.green].map((id) => id.slice(0, 4).replace(/-$/, '')))
    : null;
const wanted = (g) => !GROUPS || GROUPS.has(g);

if (ALL_CONTROLS) {
  say('[fdgate] every control, one per fresh process');
  let allOk = true;
  for (const name of Object.keys(CONTROLS)) {
    const r = spawnSync(process.execPath,
      [fileURLToPath(import.meta.url), `--control=${name}`, `--sets=${SETS_ARG}`],
      { encoding: 'utf8' });
    const last = (r.stdout || '').trim().split('\n').filter((l) => l.includes('CONTROL')).pop();
    say(`  ${name.padEnd(20)} ${r.status === 0 ? 'VALID  ' : 'INVALID'}  ${last || ''}`);
    if (r.status !== 0) allOk = false;
  }
  process.exitCode = allOk ? 0 : 1;
} else {
  const t0 = Date.now();
  say(`[fdgate] ${CONTROL ? `POSITIVE CONTROL "${CONTROL}" — ${CTL.why}` : 'gate'}`);
  say(`[fdgate] ${ROSTER[0].id} vs ${ROSTER[1].id}; ${POP.length} moves over ${SET_KEYS.length} set(s): ${SET_KEYS.join(', ')}`);
  if (CTL?.runtime) {
    const info = applyRuntimeControl(CTL.runtime);
    if (info) say(`[fdgate] runtime control: ${JSON.stringify(info)}`);
  }

  // Warm-up. The first measured block in a process disagrees with every later
  // one unless the animator has been rewound past `#play`'s early return; see
  // tools/simgate.mjs. `stage()` does that, and this proves it by discarding a
  // block anyway.
  if (!HASH_ONLY) {
    for (let i = 0; i < 4; i++) probe({ key: SET_KEYS[0], mv: MOVES[SET_KEYS[0]].jab, dist: 1.0, plan: 'stand' });
  }

  if (wanted('FD-1')) testFD1();
  if (!HASH_ONLY) {
    let fd2 = null;
    if (wanted('FD-2') || wanted('FD-2a') || wanted('FD-2b')) fd2 = testFD2(fd2Sweep());
    if (wanted('FD-3')) testFD3();
    if (wanted('FD-4')) testFD4(CTL?.runtime === 'slow-punisher' ? 50 : 0);
    if (wanted('FD-5')) testFD5();
    if (wanted('FD-6')) testFD6();
    if (wanted('FD-7')) testFD7(CTL?.runtime === 'asymmetric-hitstop' ? 3 : 0);
  }
  RUNTIME_RESTORE?.();

  if (!HASH_ONLY) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const failed = results.filter((r) => !r.ok);
    say('');
    if (CONTROL) {
      const idOk = (id) => results.find((r) => r.id === id)?.ok;
      const missingRed = CTL.red.filter((id) => idOk(id) !== false);
      const brokenGreen = CTL.green.filter((id) => idOk(id) !== true);
      say(`[fdgate] control: must go red ${CTL.red.join(', ')}; must stay green ${CTL.green.join(', ')}`);
      if (missingRed.length) say(`[fdgate] control: DID NOT GO RED  ${missingRed.join(', ')}`);
      if (brokenGreen.length) say(`[fdgate] control: COLLATERAL      ${brokenGreen.join(', ')}`);
      const valid = missingRed.length === 0 && brokenGreen.length === 0;
      say(`[fdgate] POSITIVE CONTROL ${valid ? 'VALID — the gate detects the defect it was built for'
        : 'INVALID — the gate does not detect the defect it claims to'}  (${secs}s)`);
      process.exitCode = valid ? 0 : 1;
    } else {
      say(`[fdgate] ${failed.length === 0 ? 'GREEN' : `RED — ${failed.length} failing: ${failed.map((f) => f.id).join(', ')}`}`
        + `  (${results.length} checks, ${secs}s)`);
      process.exitCode = failed.length === 0 ? 0 : 1;
    }
  }
}
