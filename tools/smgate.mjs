/**
 * Knockbots — state machine gate (TESTPLAN group SM).
 *
 *   node tools/smgate.mjs
 *   node tools/smgate.mjs --positive-control      # both controls; each must go RED
 *
 * `STATE` has 22 members and the transitions live in ten writers with no table:
 * `#updateState`, `applyHit`, `applyBlock`, `beginThrow`, `beThrown`,
 * `#breakThrow`, `#toKnockdown`, `#toKO`, `#toNeutral` and
 * `CombatSystem.#resolveWalls`. Nothing has ever checked that the set of
 * transitions the game can actually reach is the set it is supposed to reach.
 *
 * HOW THE TRANSITIONS ARE OBSERVED. `Fighter.state` is a public field, so this
 * gate installs an accessor over it per fighter and records EVERY write —
 * including the ones `#enter` makes from inside private methods and the two
 * `CombatSystem` makes directly. Sampling the field once a tick would compose
 * two writes into one apparently-legal transition and hide exactly the class of
 * defect this test exists for.
 *
 * WHICH LAYER. SM-1 is L3: both players are driven by real key events into a
 * real `Input`, so the fuzz cannot manufacture a Command shape the game cannot
 * produce. SM-3 is L2 — the defender's state is established by real prior
 * events (a real launcher, a real knockdown, a real backdash), never by
 * assignment, but the attacking throw is begun through `startMove` because
 * reachability is IR's question and not this one.
 *
 * WHAT THIS CANNOT CATCH. Anything that never happens in 36 fuzzed matches, and
 * anything whose only symptom is a value rather than a transition. The census
 * printed with `--verbose` is the honest record of what was actually reached.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');
const SRC = join(ROOT, 'src');

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(`--${n}`);
const POSITIVE_CONTROL = flag('positive-control');
const VERBOSE = flag('verbose');

// --- DOM shim (as tools/check.mjs) -----------------------------------------
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
// Loading a module with a defect put back
//
// The guards under test are inside PRIVATE methods, so they cannot be
// monkey-patched. The positive controls therefore edit a COPY of the source and
// import that; relative and bare specifiers are rewritten to absolute file URLs
// so the copy resolves the SAME module instances the original would (verified:
// `three`'s "exports" maps '.' to build/three.module.js, which is the file this
// tool imports, so there is exactly one THREE).
//
// Every `find` string is asserted present before substitution. A control that
// silently becomes a no-op re-runs the healthy gate and reports green, which is
// worse than no control at all.
// ---------------------------------------------------------------------------

const THREE_URL = pathToFileURL(join(ROOT, 'node_modules/three/build/three.module.js')).href;
let tempDir = null;
function patchedModuleUrl(relPath, edits) {
  const abs = join(SRC, relPath);
  const dir = dirname(abs);
  let src = readFileSync(abs, 'utf8');
  for (const [find, replace, label] of edits) {
    if (!src.includes(find)) {
      throw new Error(`positive control "${label}": the source string this gate patches is gone from src/${relPath}. `
        + 'Update tools/smgate.mjs — a silent no-op here reports a green control against healthy code.');
    }
    src = src.split(find).join(replace);
  }
  src = src.replace(/from 'three'/g, `from '${THREE_URL}'`);
  src = src.replace(/from '(\.[^']+)'/g, (_m, rel) => `from '${pathToFileURL(resolvePath(dir, rel)).href}'`);
  tempDir ??= mkdtempSync(join(tmpdir(), 'kb-smgate-'));
  const out = join(tempDir, `${relPath.replace(/[\\/]/g, '_')}.control.js`);
  writeFileSync(out, src);
  return pathToFileURL(out).href;
}
process.on('exit', () => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

const THREE = await import(THREE_URL);
const { Input } = await import(pathToFileURL(join(SRC, 'core/Input.js')));
const { Rng } = await import(pathToFileURL(join(SRC, 'core/Rng.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { MOVES, MOVE_SET_KEYS } = await import(pathToFileURL(join(SRC, 'combat/Moves.js')));
const { bus } = await import(pathToFileURL(join(SRC, 'core/Bus.js')));
const { MAX_HEALTH, METER_MAX, REACTION } = await import(pathToFileURL(join(SRC, 'core/Constants.js')));

// SM-1's control: let `#tickNeutral` run during HITSTUN, which is the plan's
// named defect — a fighter who can act out of hitstun.
const HITSTUN_FIND = `      case STATE.HITSTUN:\n        if (--this.stunTicks <= 0) this.#toNeutral();\n        return;`;
const HITSTUN_REPLACE = `      case STATE.HITSTUN:\n        this.#tickNeutral(cmd);  /* POSITIVE CONTROL: acting out of hitstun */\n        if (--this.stunTicks <= 0) this.#toNeutral();\n        return;`;

// SM-3's control: put the grab back on the strike path.
const THROWPATH_FIND = `    if (move.props.throw) return null;`;
const THROWPATH_REPLACE = `    /* POSITIVE CONTROL: grabs resolve down the strike path again */`;

const fighterUrl = POSITIVE_CONTROL
  ? patchedModuleUrl('combat/Fighter.js', [[HITSTUN_FIND, HITSTUN_REPLACE, 'act out of hitstun']])
  : pathToFileURL(join(SRC, 'combat/Fighter.js')).href;
const combatUrl = POSITIVE_CONTROL
  ? patchedModuleUrl('combat/CombatSystem.js', [[THROWPATH_FIND, THROWPATH_REPLACE, 'grab down the strike path']])
  : pathToFileURL(join(SRC, 'combat/CombatSystem.js')).href;

const { Fighter, STATE } = await import(fighterUrl);
const { CombatSystem } = await import(combatUrl);

// ---------------------------------------------------------------------------
// Keyboard and a seeded, well-formed key script
// (the same shape as tools/dtgate.mjs; kept local because a gate that imports
//  another gate runs it)
// ---------------------------------------------------------------------------

class KeyEv extends Event {
  constructor(type, code) { super(type); this.code = code; this.repeat = false; }
  preventDefault() {}
}

function makeKeyboard() {
  const target = new EventTarget();
  const held = new Set();
  const set = (code, down) => {
    if (down) { if (!held.has(code)) { held.add(code); target.dispatchEvent(new KeyEv('keydown', code)); } }
    else if (held.delete(code)) target.dispatchEvent(new KeyEv('keyup', code));
  };
  const only = (codes) => {
    const want = new Set(codes);
    for (const c of [...held]) if (!want.has(c)) set(c, false);
    for (const c of want) set(c, true);
  };
  return { target, only };
}

const KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', b: ['KeyJ', 'KeyK', 'KeyN', 'KeyM', 'KeyU'], guard: 'KeyQ' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', b: ['Numpad4', 'Numpad5', 'Numpad1', 'Numpad2', 'Numpad7'], guard: 'Numpad0' },
];

function keyScript(seed, ticks) {
  const rng = new Rng(seed);
  const script = [];
  const st = [{ dirLeft: 0, btnLeft: 0, dir: [], btn: null, guard: false },
    { dirLeft: 0, btnLeft: 0, dir: [], btn: null, guard: false }];
  for (let t = 0; t < ticks; t++) {
    const row = [];
    for (let p = 0; p < 2; p++) {
      const s = st[p]; const K = KEYS[p];
      if (--s.dirLeft <= 0) {
        s.dirLeft = 3 + rng.int(16);
        const r = rng.next();
        if (r < 0.26) s.dir = [];
        else if (r < 0.46) s.dir = [K.right];
        else if (r < 0.63) s.dir = [K.left];
        else if (r < 0.76) s.dir = [K.down];
        else if (r < 0.86) s.dir = [K.up];
        else if (r < 0.93) s.dir = [K.down, K.right];
        else s.dir = [K.down, K.left];
        s.guard = rng.next() < 0.20;
      }
      if (--s.btnLeft <= 0) {
        s.btnLeft = 2 + rng.int(8);
        const r = rng.next();
        if (r < 0.32) s.btn = null;
        else if (r < 0.86) s.btn = [K.b[rng.int(5)]];
        else s.btn = [K.b[rng.int(4)], K.b[rng.int(4)]];
      }
      const codes = [...s.dir];
      if (s.guard) codes.push(K.guard);
      if (s.btn) for (const c of s.btn) codes.push(c);
      row.push(codes);
    }
    script.push(row);
  }
  return script;
}

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
const fighters = [f0, f1];

/**
 * Record every write to `state`, not every value it happens to hold at a tick
 * boundary. `phase` is set by the driver so a transition can be attributed to
 * the fighter's own simulate or to combat resolution.
 */
let phase = 'boot';
const transitions = [];      // { i, from, to, phase, tick }
let recording = false;
for (const f of fighters) {
  let v = f.state;
  Object.defineProperty(f, 'state', {
    configurable: true,
    get() { return v; },
    set(next) {
      if (recording && next !== v) transitions.push({ i: f.index, from: v, to: next, phase, tick: combat.tick });
      v = next;
    },
  });
}

function stage(dist = 2.0, { health = MAX_HEALTH * 40 } = {}) {
  f0.reset(new THREE.Vector3(-dist * 0.5, f0.floorY, 0), 1);
  f1.reset(new THREE.Vector3(dist * 0.5, f1.floorY, 0), -1);
  f0.health = health; f1.health = health;
  f0.meter = METER_MAX; f1.meter = METER_MAX;
}

const results = [];
const say = (s) => console.log(s);
function record(name, ok, detail = '', rows = []) {
  results.push({ name, ok, detail });
  say(`[smgate] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  for (const r of rows) say(`          ${r}`);
}

// ---------------------------------------------------------------------------
// SM-1 — no illegal transition, ever
//
// The forbidden table is taken from the plan, which took it from what the code
// is SUPPOSED to guarantee — deliberately not from what the code currently
// does, because a table generated from observed behaviour asserts that today's
// bugs are the specification.
// ---------------------------------------------------------------------------

const S = STATE;
const STUNNED_OR_DEAD = [S.HITSTUN, S.BLOCKSTUN, S.KNOCKDOWN, S.THROWN, S.KO];

/** @returns {?string} why this transition is illegal, or null. */
function illegal(from, to) {
  if (to === S.ATTACK && STUNNED_OR_DEAD.includes(from)) {
    return `acted out of ${from}`;
  }
  if (from === S.KO) return 'left KO';
  if (from === S.LAUNCHED && ![S.JUGGLED, S.KNOCKDOWN, S.KO, S.HITSTUN, S.THROWN].includes(to)) {
    return `LAUNCHED became ${to}`;
  }
  return null;
}

function runFuzz(seed, ticks) {
  stage();
  const kb = [makeKeyboard(), makeKeyboard()];
  const input = [new Input(kb[0].target), new Input(kb[1].target)];
  const script = keyScript(seed, ticks);
  let t = 0;
  for (const row of script) {
    kb[0].only(row[0]);
    kb[1].only(row[1]);
    input[0].beginTick(t);
    input[1].beginTick(t);
    const c0 = input[0].commandsFor(0, f0);
    const c1 = input[1].commandsFor(1, f1);
    combat.tick = t;
    phase = 'fighterSim';
    f0.simulate(c0);
    f1.simulate(c1);
    phase = 'combat';
    combat.simulate(t);
    input[0].endTick();
    input[1].endTick();
    t++;
  }
  for (const i of input) i.dispose();
}

const FUZZ_MATCHES = 36;
const FUZZ_TICKS = 900;
const t0 = Date.now();

say('[smgate] state machine gate');
say(`[smgate] fighters ${ROSTER[0].id} vs ${ROSTER[1].id}${POSITIVE_CONTROL ? '   *** POSITIVE CONTROL: both defects reinstated ***' : ''}`);

recording = true;
transitions.length = 0;
for (let m = 0; m < FUZZ_MATCHES; m++) runFuzz(0x51a70000 + m * 7919, FUZZ_TICKS);
recording = false;
const fuzzTransitions = transitions.slice();

{
  const bad = new Map();
  for (const tr of fuzzTransitions) {
    const why = illegal(tr.from, tr.to);
    if (!why) continue;
    const k = `${tr.from} -> ${tr.to}  (${why}, in ${tr.phase})`;
    bad.set(k, (bad.get(k) || 0) + 1);
  }
  const census = new Map();
  for (const tr of fuzzTransitions) {
    const k = `${tr.from} -> ${tr.to}`;
    census.set(k, (census.get(k) || 0) + 1);
  }
  const rows = [...bad.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n.toString().padStart(6)}x  ${k}`);
  record('SM-1  no illegal transition under a well-formed fuzz', bad.size === 0,
    `${FUZZ_MATCHES} matches x ${FUZZ_TICKS} ticks, ${fuzzTransitions.length} transitions, ${census.size} distinct`,
    rows.slice(0, 12));
  if (VERBOSE) {
    say('          --- census ---');
    for (const [k, n] of [...census.entries()].sort((a, b) => b[1] - a[1])) say(`          ${n.toString().padStart(7)}x  ${k}`);
  }
}

// SM-1 null control — the same seed must give the identical transition multiset.
// This doubles as a determinism smoke test and it is what makes the census above
// a measurement rather than a sample.
//
// The two measured runs are preceded by a boundary rewind that `Fighter.reset()`
// does NOT do on its own: the per-fighter rng is reseeded and the idle clip is
// replayed past `#play`'s early return. That is the DT-3 finding applied from
// outside — `reset()` carries the rng stream across a round boundary, so two
// back-to-back runs of the same script legitimately differ at the first wakeup
// roll. Without this the null control measures dtgate's DT-3 defect instead of
// the state machine, which is a null control measuring the wrong thing.
{
  const rewind = () => {
    for (const f of fighters) {
      f.rng.reseed(0x51ed2701 + f.index * 0x9e37);
      f.animator?.play('idle.fight', { blend: 0, loop: true });
    }
  };
  runFuzz(0x51a70000, FUZZ_TICKS);          // warm-up; discarded (see simgate's first-run rule)
  recording = true;
  transitions.length = 0;
  rewind();
  runFuzz(0x51a70000, FUZZ_TICKS);
  const a = transitions.slice();
  transitions.length = 0;
  rewind();
  runFuzz(0x51a70000, FUZZ_TICKS);
  const b = transitions.slice();
  recording = false;
  const key = (arr) => arr.map((t) => `${t.tick}:${t.i}:${t.from}>${t.to}:${t.phase}`).join(',');
  const same = a.length === b.length && key(a) === key(b);
  record('SM-1n null control — same seed, identical transition sequence', same,
    same ? `${a.length} transitions reproduced exactly` : `${a.length} vs ${b.length} transitions`);
}

// SM-1 second null control — a fighter in THROW and its partner in THROWN enter
// and leave together. A one-sided throw state is the shape of a soft-lock.
{
  const byTick = new Map();
  for (const tr of fuzzTransitions) {
    if (![S.THROW, S.THROWN].includes(tr.from) && ![S.THROW, S.THROWN].includes(tr.to)) continue;
    const k = tr.tick;
    if (!byTick.has(k)) byTick.set(k, []);
    byTick.get(k).push(tr);
  }
  let unpaired = 0;
  const examples = [];
  for (const [tick, trs] of byTick) {
    const enters = trs.filter((t) => t.to === S.THROW || t.to === S.THROWN);
    if (enters.length === 1) {
      unpaired++;
      if (examples.length < 4) examples.push(`tick ${tick}: p${enters[0].i} ${enters[0].from} -> ${enters[0].to} alone`);
    }
  }
  record('SM-1t THROW and THROWN are entered as a pair', unpaired === 0,
    `${byTick.size} ticks touched a throw state`, examples);
}

// ---------------------------------------------------------------------------
// SM-3 — a throw never pays out as an unblockable strike
//
// The assertion is the plan's, exactly: the count of `hit` events whose
// `move.props.throw` is truthy and which were NOT preceded by a `beginThrow` on
// the same move instance must be zero, across every cell. `#releaseThrow` emits
// a perfectly legitimate `hit` with a throw move, so the discriminator has to be
// the beginThrow and cannot be the move.
// ---------------------------------------------------------------------------

const THROWS = [];
{
  const seen = new Set();
  for (const key of MOVE_SET_KEYS) {
    for (const mv of MOVES[key]?.__ordered || []) {
      if (mv.props?.throw && !seen.has(mv.id + key)) { seen.add(mv.id + key); THROWS.push(mv); }
    }
  }
}

/** Wrap `beginThrow` so a legitimate grab is distinguishable from a payout. */
const beganThrow = new Set();       // `${index}:${moveInstance}`
for (const f of fighters) {
  const orig = Fighter.prototype.beginThrow.bind(f);
  f.beginThrow = (move, victim, override) => {
    beganThrow.add(`${f.index}:${f.moveInstance}`);
    return orig(move, victim, override);
  };
}

const payouts = [];
const legitimate = [];
let watching = null;
const offHit = bus.on('hit', (e) => {
  if (!watching) return;
  if (!e.move?.props?.throw) return;
  const key = `${e.attacker.index}:${e.attacker.moveInstance}`;
  if (beganThrow.has(key)) legitimate.push({ ...watching, damage: e.damage });
  else payouts.push({ ...watching, damage: e.damage, move: e.move.id });
});

/** Step the pair one tick with no input at all. */
function idleTick(t) {
  f0.simulate(null);
  f1.simulate(null);
  combat.tick = t;
  combat.simulate(t);
}

/**
 * Put the defender into `cond` using real prior events, and report whether it
 * worked. A cell whose setup failed is a HARNESS failure and is counted as one —
 * scoring "no payout" on a defender who was never in the state is exactly the
 * `airKick`-from-the-ground mistake the plan calls out.
 */
function setupDefender(cond, tick) {
  const d = f1;
  if (cond === 'normal') return true;
  if (cond === 'invulnerable') { d.invulnerable = true; return true; }
  if (cond === 'backdash') {
    // A real backdash: the fighter's own #dash(-1) sets throwInvuln = 10.
    const kb = makeKeyboard();
    const inp = new Input(kb.target);
    // BACK is facing-relative. f1 faces -1, so away-from-the-opponent is +x,
    // which is ArrowRight. Getting this backwards produced a forward dash and
    // 132 cells of "could not be staged" that were really the harness pressing
    // the wrong direction.
    const backKey = f1.facing < 0 ? 'ArrowRight' : 'ArrowLeft';
    // Two taps with a release between: a real double tap passes through neutral
    // (4,5,4) and survives the consecutive-duplicate dedupe in Input#motion,
    // where a held direction (4,4) collapses to one and must NOT read as bb.
    const seq = [[], [backKey], [], [backKey], [], [], [], []];
    let t = tick;
    for (const codes of seq) {
      kb.only(codes);
      inp.beginTick(t);
      const c = inp.commandsFor(1, f1);
      f0.simulate(null);
      f1.simulate(c);
      combat.tick = t;
      combat.simulate(t);
      inp.endTick();
      t++;
      if (d.throwInvuln > 0) break;
    }
    inp.dispose();
    return d.throwInvuln > 0;
  }
  if (cond === 'airborne') {
    d.airborne = true; d.grounded = false; d.velocity.y = 6.0;
    for (let k = 0; k < 3; k++) idleTick(tick + k);
    return d.airborne;
  }
  // The reaction states are produced by a real hit from a real launcher.
  const launcher = (MOVES[ROSTER[0].moveSet || 'vulkan']?.__ordered || [])
    .find((m) => m.reaction === REACTION.LAUNCH && !m.props?.throw && !m.meterCost);
  if (!launcher) return false;
  if (cond === 'launched' || cond === 'juggled') {
    f0.startMove(launcher);
    for (let k = 0; k < 90; k++) {
      idleTick(tick + k);
      if (cond === 'launched' && d.state === S.LAUNCHED) return true;
      if (cond === 'juggled' && d.state === S.JUGGLED) return true;
    }
    return false;
  }
  if (cond === 'knockdown' || cond === 'wakeup') {
    f0.startMove(launcher);
    for (let k = 0; k < 200; k++) {
      idleTick(tick + k);
      if (cond === 'knockdown' && d.state === S.KNOCKDOWN) return true;
      if (cond === 'wakeup' && d.state === S.WAKEUP) return true;
    }
    return false;
  }
  if (cond === 'thrown') {
    const grab = THROWS.find((m) => !m.meterCost);
    if (!grab) return false;
    f0.startMove(grab);
    for (let k = 0; k < 40; k++) {
      idleTick(tick + k);
      if (d.state === S.THROWN) return true;
    }
    return false;
  }
  if (cond === 'ko') {
    d.health = 0.5;
    const hard = (MOVES[ROSTER[0].moveSet || 'vulkan']?.__ordered || []).find((m) => !m.props?.throw && !m.meterCost && m.damage > 10);
    if (!hard) return false;
    f0.startMove(hard);
    for (let k = 0; k < 90; k++) {
      idleTick(tick + k);
      if (d.state === S.KO) return true;
    }
    return false;
  }
  return false;
}

const CONDITIONS = ['normal', 'airborne', 'launched', 'juggled', 'knockdown', 'wakeup', 'thrown', 'backdash', 'invulnerable', 'ko'];
const DISTANCES = [0.6, 0.9, 1.1, 1.4];

/**
 * Did the cell actually put the defender where the row claims?
 *
 * Checked ON THE TICK THE HITBOX IS LIVE, not at setup time. Several of these
 * states are short — a backdash's `throwInvuln` is 10 ticks, `LAUNCHED` ends the
 * moment vertical velocity turns over — so a cell that staged correctly and then
 * decayed before the grab reached its active window has measured the wrong
 * event. That is the `airKick`-scored-from-the-ground mistake, and it is a
 * harness failure rather than a result.
 */
const HELD = {
  normal: (d) => !d.airborne && d.throwInvuln <= 0 && !d.invulnerable
    && ![S.HITSTUN, S.LAUNCHED, S.JUGGLED, S.KNOCKDOWN, S.WAKEUP, S.THROWN, S.KO].includes(d.state),
  airborne: (d) => d.airborne,
  launched: (d) => d.state === S.LAUNCHED,
  juggled: (d) => d.state === S.JUGGLED,
  knockdown: (d) => d.state === S.KNOCKDOWN,
  wakeup: (d) => d.state === S.WAKEUP,
  thrown: (d) => d.state === S.THROWN,
  backdash: (d) => d.throwInvuln > 0,
  invulnerable: (d) => d.invulnerable,
  ko: (d) => d.state === S.KO,
};

/** Put the attacker at `dist` from the defender without touching either state. */
function placeAttacker(dist) {
  f0.position.x = f1.position.x - f0.facing * dist;
  f0.position.z = f1.position.z;
  f0.prevPosition.copy(f0.position);
  f0.velocity.set(0, 0, 0);
}

{
  let cells = 0;
  let harnessFail = 0;
  const harnessRows = new Map();
  let tick = 0;
  const savedCapsules = new Map();

  // The plan's rule for this control: the vestigial capsule now sits BEHIND the
  // fighter's own spine, so a control that only removes the engine guard proves
  // nothing except that the geometry is currently unreachable. Under the
  // control the capsule is moved back in front, which is one anchor edit — the
  // exact edit nothing in the repo would fail on.
  if (POSITIVE_CONTROL) {
    for (const mv of THROWS) {
      for (const w of mv.active) {
        for (const b of w.boxes) {
          savedCapsules.set(b, [...b.offset]);
          b.offset = [0.45, 0.0, 0];
          b.radius = Math.max(b.radius, 0.42);
        }
      }
    }
  }

  let notStarted = 0;
  for (const cond of CONDITIONS) {
    for (const mv of THROWS) {
      for (const dist of DISTANCES) {
        // Setup runs at a range the launcher can actually reach; the TEST range
        // is applied afterwards by moving the attacker only. Staging the setup
        // at the test range instead made "could not be staged in knockdown"
        // mean "1.4 m is outside the launcher's range", which is a fact about
        // the launcher and not about throws.
        stage(1.0);
        tick += 1;
        combat.tick = tick;
        beganThrow.clear();
        const staged = setupDefender(cond, tick);
        tick += 240;
        if (!staged) {
          harnessFail++;
          harnessRows.set(`${cond}: setup never reached the state`, (harnessRows.get(`${cond}: setup never reached the state`) || 0) + 1);
          continue;
        }
        placeAttacker(dist);

        watching = { cond, move: mv.id, dist };
        f0.startMove(mv);
        if (f0.currentMove !== mv) {          // meter-gated: notStarted, never a whiff (RG-8)
          notStarted++; watching = null; continue;
        }
        // Compress the wind-up so the grab's active window arrives while the
        // defender is still in the state under test. `fastForward` is the
        // shipping scrub the QA harness uses and keeps the animator in lockstep
        // with the frame counter, so the pose the hitboxes are built from is the
        // one the move really has on that tick.
        if (mv.startup > 2) f0.fastForward(mv.startup - 2);

        const dur = mv.props.throw?.duration ?? 0;
        let held = null;
        for (let k = 0; k < mv.total + dur + 12; k++) {
          // Sampled on the tick BEFORE the one that resolves. `idleTick` runs
          // `f0.simulate` (which advances moveTick onto the first active frame
          // and builds the boxes) and `combat.simulate` (which resolves the
          // grab) back to back, so reading the defender after the call reads it
          // AFTER the throw already moved it into THROWN — which scored every
          // successful throw as "the state decayed".
          const aboutToGoLive = f0.currentMove === mv && f0.moveTick >= mv.startup - 1;
          if (held === null && aboutToGoLive) held = HELD[cond](f1);
          idleTick(tick + k);
        }
        tick += mv.total + dur + 14;
        watching = null;
        if (held === false) {
          harnessFail++;
          const k = `${cond}: state decayed before the grab went active`;
          harnessRows.set(k, (harnessRows.get(k) || 0) + 1);
          continue;
        }
        cells++;
      }
    }
  }

  if (POSITIVE_CONTROL) for (const [b, off] of savedCapsules) b.offset = off;

  const byCond = new Map();
  for (const p of payouts) byCond.set(p.cond, (byCond.get(p.cond) || 0) + 1);
  const rows = [...byCond.entries()].map(([c, n]) => `${n.toString().padStart(5)}x in ${c}  e.g. ${payouts.find((p) => p.cond === c).move}`);
  record('SM-3  a rejected grab never pays out as an unblockable strike', payouts.length === 0,
    `${cells} cells (${THROWS.length} throws x ${CONDITIONS.length} states x ${DISTANCES.length} ranges), `
    + `${payouts.length} payouts, ${legitimate.length} legitimate throw releases`, rows.slice(0, 10));

  // The plan's null control, and the harness ledger it insists on.
  record('SM-3n null control — a legitimate throw still lands at range', legitimate.length > 0,
    legitimate.length ? `${legitimate.length} throw releases against reachable defenders` : 'NO throw ever landed — the sweep proves nothing');
  const hrows = [...harnessRows.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} cells — ${c}`);
  if (harnessFail || notStarted) {
    say(`[smgate] note   ${harnessFail} cells reported as HARNESS failures and ${notStarted} as notStarted, neither counted as results:`);
  }
  for (const r of hrows) say(`          ${r}`);
}
offHit();

// ---------------------------------------------------------------------------

const bad = results.filter((r) => !r.ok);
say('');
if (POSITIVE_CONTROL) {
  const smashed = results.filter((r) => !r.ok).map((r) => r.name.split(/\s+/)[0]);
  const want = ['SM-1', 'SM-3'];
  const missing = want.filter((w) => !smashed.includes(w));
  say(`[smgate] POSITIVE CONTROL: ${missing.length ? `INCOMPLETE — ${missing.join(', ')} stayed green` : 'RED as required on SM-1 and SM-3'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(missing.length ? 1 : 0);
}
say(`[smgate] ${bad.length ? `RED — ${bad.length} failing` : 'GREEN'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(bad.length ? 1 : 0);
