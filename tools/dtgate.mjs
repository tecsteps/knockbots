/**
 * Knockbots — determinism gate (TESTPLAN group DT).
 *
 * Determinism is claimed in three files — `Rng.js` ("the simulation must be
 * deterministic so replays and rollback work"), `Game.js` ("the sim itself
 * always sees a clean 16.667 ms tick and stays deterministic") and `CPU.js`
 * ("a given seed reproduces a given match") — and until this file nothing had
 * ever measured it.
 *
 *   node tools/dtgate.mjs
 *   node tools/dtgate.mjs --positive-control      # every control, each must FAIL its test
 *   node tools/dtgate.mjs --trial=<none|rng|anim|both>   # internal, cold-process DT-3 trial
 *
 * WHAT IS DRIVEN, AND AT WHICH LAYER
 *
 * L3. Both players are driven by real `keydown`/`keyup` events dispatched into
 * a real `Input`, whose `Command` goes straight into a real `Fighter`, with a
 * real `CombatSystem` resolving the tick. The input layer is therefore INSIDE
 * the determinism claim rather than outside it, which is the whole point: a
 * replay that reproduces the sim but not the input path is not a replay.
 *
 * WHAT THIS CANNOT CATCH. Nothing above `Game` — the wall-clock schedule, the
 * renderer, the presentation clocks. DT-2 (frame-rate independence) needs the
 * `Game` loop and is not in this file; `slowmo.ticks--` per rendered frame is a
 * known open item there and is a wall-clock claim, not a tick-space one.
 *
 * EVERY TEST HERE CARRIES BOTH CONTROLS, per the plan's rule. The positive
 * control for the tick-hash tests is `Rng.prototype.next = Math.random`, applied
 * to the shipping class, and the number of times it is CALLED during the run is
 * counted and asserted non-zero — a control that never executes is a control
 * that proves nothing, and this project has shipped nine instruments that were
 * stable, reproducible and measuring something else.
 */

import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');
const SRC = join(ROOT, 'src');

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(`--${n}`);
const opt = (n, d = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const POSITIVE_CONTROL = flag('positive-control');
const TRIAL = opt('trial', null);
const CHILD = flag('child');
const HASH_ONLY = flag('hash-only');

// --- DOM shim (as tools/check.mjs; the module bodies touch it at import time) ---
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

const THREE = await import(join(ROOT, 'node_modules/three/build/three.module.js'));
const { Fighter, STATE } = await import(pathToFileURL(join(SRC, 'combat/Fighter.js')));
const { CombatSystem } = await import(pathToFileURL(join(SRC, 'combat/CombatSystem.js')));
const { Input } = await import(pathToFileURL(join(SRC, 'core/Input.js')));
const { Rng } = await import(pathToFileURL(join(SRC, 'core/Rng.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { MAX_HEALTH, METER_MAX } = await import(pathToFileURL(join(SRC, 'core/Constants.js')));

// ---------------------------------------------------------------------------
// The keyboard
// ---------------------------------------------------------------------------

class KeyEv extends Event {
  constructor(type, code) { super(type); this.code = code; this.repeat = false; }
  preventDefault() {}
}

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
  const only = (codes) => {
    const want = new Set(codes);
    for (const c of [...held]) if (!want.has(c)) set(c, false);
    for (const c of want) set(c, true);
  };
  return { target, set, only, held };
}

/** Mirrored from KEYMAP in src/core/Input.js. Player 0 and player 1. */
const KEYS = [
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', b: ['KeyJ', 'KeyK', 'KeyN', 'KeyM', 'KeyU'], guard: 'KeyQ' },
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', b: ['Numpad4', 'Numpad5', 'Numpad1', 'Numpad2', 'Numpad7'], guard: 'Numpad0' },
];

/**
 * A seeded, WELL-FORMED key script.
 *
 * Well-formed matters: a fuzz that manufactures a command shape the game cannot
 * produce finds bugs nobody can reach. Here the only thing generated is which
 * PHYSICAL KEYS are down on a tick, and everything downstream — direction
 * history, motion recognition, chords, facing conversion — is the shipping code
 * deriving a Command from them, exactly as a player's hands would.
 *
 * The generator holds a choice for a run of ticks rather than rerolling every
 * tick, because per-tick rerolling produces a player who never holds a
 * direction long enough to walk, dash, jump or enter a motion — a fuzz that
 * only ever exercises neutral.
 */
function keyScript(seed, ticks) {
  const rng = new Rng(seed);
  const script = [];               // per tick: [codes for p0, codes for p1]
  const state = [
    { dir: [], dirLeft: 0, btn: null, btnLeft: 0, guard: false },
    { dir: [], dirLeft: 0, btn: null, btnLeft: 0, guard: false },
  ];
  for (let t = 0; t < ticks; t++) {
    const row = [];
    for (let p = 0; p < 2; p++) {
      const s = state[p];
      const K = KEYS[p];
      if (--s.dirLeft <= 0) {
        s.dirLeft = 3 + rng.int(18);
        const r = rng.next();
        if (r < 0.30) s.dir = [];
        else if (r < 0.50) s.dir = [K.right];
        else if (r < 0.68) s.dir = [K.left];
        else if (r < 0.80) s.dir = [K.down];
        else if (r < 0.88) s.dir = [K.up];
        else if (r < 0.94) s.dir = [K.down, K.right];
        else s.dir = [K.down, K.left];
        s.guard = rng.next() < 0.18;
      }
      if (--s.btnLeft <= 0) {
        s.btnLeft = 2 + rng.int(9);
        const r = rng.next();
        // A chord is two buttons on the same tick — the shape 33 throws need.
        if (r < 0.40) s.btn = null;
        else if (r < 0.90) s.btn = [K.b[rng.int(4)]];
        else s.btn = [K.b[rng.int(4)], K.b[rng.int(4)]];
      }
      const codes = [...s.dir];
      if (s.guard) codes.push(K.guard);
      // Buttons are held for 1-2 ticks so `pressed` has a real edge.
      if (s.btn && s.btnLeft >= 1) for (const c of s.btn) codes.push(c);
      row.push(codes);
    }
    script.push(row);
  }
  return script;
}

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

/**
 * A whole independent simulation: two freshly constructed fighters, a fresh
 * `CombatSystem`, a fresh `Input` and a fresh keyboard per player.
 *
 * Fresh matters. `Input` carries `history[player]` pruned by tick age and
 * `CombatSystem` registers a bus listener, so a reused instance would let the
 * previous run's tail sit inside the next run's motion window — which would be
 * indistinguishable from a real determinism defect.
 */
async function makeSim(scene) {
  const f0 = new Fighter({ index: 0, def: ROSTER[0], scene, environment: null });
  const f1 = new Fighter({ index: 1, def: ROSTER[1], scene, environment: null });
  await f0.init();
  await f1.init();
  f0.setOpponent(f1);
  f1.setOpponent(f0);
  const combat = new CombatSystem([f0, f1], null);
  const kb = [makeKeyboard(), makeKeyboard()];
  // One Input per keyboard: `Input` binds to a single target, and player 1's
  // keys are a different physical set on the same device in the real game — but
  // two targets keep the two scripts from sharing a `keys` set here, which is
  // the same Command either way and is easier to drive.
  const input = [new Input(kb[0].target), new Input(kb[1].target)];
  return { f0, f1, fighters: [f0, f1], combat, kb, input, tick: 0 };
}

function stage(sim, dist = 2.2) {
  const [a, b] = sim.fighters;
  a.reset(new THREE.Vector3(-dist * 0.5, a.floorY, 0), 1);
  b.reset(new THREE.Vector3(dist * 0.5, b.floorY, 0), -1);
}

function stepSim(sim, codes) {
  for (let p = 0; p < 2; p++) sim.kb[p].only(codes[p]);
  for (let p = 0; p < 2; p++) sim.input[p].beginTick(sim.tick);
  const c0 = sim.input[0].commandsFor(0, sim.f0);
  const c1 = sim.input[1].commandsFor(1, sim.f1);
  sim.f0.simulate(c0);
  sim.f1.simulate(c1);
  sim.combat.simulate(sim.tick);
  for (let p = 0; p < 2; p++) sim.input[p].endTick();
  sim.tick++;
}

// ---------------------------------------------------------------------------
// The hash
//
// Not "the same winner" — the same state, at every tick, or the first divergent
// tick is the report. Numbers go in at full precision via the default
// Number->String conversion, which is exact and round-trippable, so two runs
// that differ in the last bit of a float differ in the string.
// ---------------------------------------------------------------------------

const FIELDS = [
  'pos.x', 'pos.y', 'pos.z', 'vel.x', 'vel.y', 'vel.z',
  'health', 'meter', 'state', 'stateTicks', 'stunTicks',
  'moveTick', 'moveInstance', 'move', 'juggleCount', 'facing', 'animYaw',
  'rng.s0', 'rng.s1', 'hurtN', 'poseSig',
];

/**
 * A pose-derived column, and DT-4 is why it exists.
 *
 * Every other field here is bulk simulation state — position, velocity, state,
 * the clocks. None of it is a POSE, so a divergence that lives only in the
 * animator (a different breathing-noise phase, say) moves no column until it
 * eventually changes whether a hitbox reaches. DT-4's positive control proved
 * that gap: re-breaking `reset()`'s `simTick` leak was NOT SEEN across 400
 * ticks, because the leak's first effect is the pose and the trace could not
 * read one.
 *
 * The hurtbox capsules are rebuilt from the posed skeleton every tick by
 * `#buildHurtboxes`, so summing their endpoints is a cheap, deterministic
 * signature of the pose that costs no extra simulation. Rounded to 1e-6 so
 * ordinary float noise in the sum does not make the column a hair trigger.
 */
function poseSig(f) {
  let acc = 0;
  for (const h of f.hurtboxes) {
    acc += h.p0.x + h.p0.y * 3 + h.p0.z * 7 + h.p1.x * 11 + h.p1.y * 13 + h.p1.z * 17 + h.radius * 19;
  }
  return Math.round(acc * 1e6) / 1e6;
}

function fighterRow(f) {
  return [
    f.position.x, f.position.y, f.position.z,
    f.velocity.x, f.velocity.y, f.velocity.z,
    f.health, f.meter, f.state, f.stateTicks, f.stunTicks,
    f.moveTick, f.moveInstance, f.currentMove?.id ?? '-', f.juggleCount,
    f.facing, f.animYaw, f.rng.s0, f.rng.s1, f.hurtboxes.length, poseSig(f),
  ];
}

function tickRow(sim) {
  const a = fighterRow(sim.f0);
  const b = fighterRow(sim.f1);
  const c = sim.combat;
  const extra = [
    c.combos[0].hits, c.combos[0].damage, c.combos[0].lastTick,
    c.combos[1].hits, c.combos[1].damage, c.combos[1].lastTick,
    c.wins[0], c.wins[1], c.roundOver ? 1 : 0,
  ];
  return [...a, ...b, ...extra];
}

const rowKey = (r) => r.join('|');

const COL_NAMES = [
  ...FIELDS.map((f) => `p0.${f}`), ...FIELDS.map((f) => `p1.${f}`),
  'c0.hits', 'c0.dmg', 'c0.lastTick', 'c1.hits', 'c1.dmg', 'c1.lastTick',
  'wins0', 'wins1', 'roundOver',
];

/**
 * Columns DT-3 does not hold against a round boundary.
 *
 * `moveInstance` is a monotone identity counter. Its only consumer is the
 * `moveInstance:windowIndex` key in `connected`, compared against other keys
 * from the SAME run, so two runs that agree on everything else but disagree on
 * the counter's absolute value are the same match. It is reported separately
 * rather than dropped silently, because it is still a fact about `reset()`, and
 * masking a column without saying so is how an instrument starts measuring the
 * wrong thing.
 */
const DT3_MASK = new Set(['p0.moveInstance', 'p1.moveInstance']);

/**
 * The same mask plus the rng words themselves.
 *
 * A carried rng state is a divergence the moment it exists, but whether it has
 * yet CHANGED anything a player can see depends on whether the round consumed a
 * roll. Reported separately so the finding says which it is: a live gameplay
 * divergence, or a latent one that bites on the first knockdown.
 */
const DT3_MASK_STRICT = new Set([...DT3_MASK, 'p0.rng.s0', 'p0.rng.s1', 'p1.rng.s0', 'p1.rng.s1']);

/**
 * DT-4's mask: DT-3's, plus the two combo clocks.
 *
 * `combo.lastTick` is stamped from `CombatSystem.tick`, a MATCH-long clock that
 * deliberately keeps running across a round boundary — and DT-4 deliberately
 * makes the two arms reach the boundary at different absolute ticks. So the two
 * arms differ on that column by exactly the difference in round-1 length, every
 * time, whatever the product does. `combat.reset()` does clear it to -999; what
 * is being compared is the value it is re-stamped with during round 2.
 *
 * Masking it is therefore removing the arm's own offset, not hiding a defect —
 * and `maskedDiffs` still reports it, so the exclusion cannot go quiet. Nothing
 * else here is match-absolute: positions, velocities, states, stun and move
 * clocks are all round-relative, which is why the real defect showed up in them.
 */
const DT4_MASK = new Set([...DT3_MASK, 'c0.lastTick', 'c1.lastTick']);

/** First index where two traces disagree, and the field that did it. */
function firstDivergence(A, B, mask = null) {
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) continue;
    const a = A[i].split('|');
    const b = B[i].split('|');
    const cols = [];
    for (let k = 0; k < a.length; k++) {
      if (a[k] === b[k]) continue;
      if (mask && mask.has(COL_NAMES[k])) continue;
      cols.push(`${COL_NAMES[k]}: ${a[k]} vs ${b[k]}`);
    }
    if (!cols.length) continue;
    return { tick: i, cols };
  }
  if (A.length !== B.length) return { tick: n, cols: [`length ${A.length} vs ${B.length}`] };
  return null;
}

/** Which masked columns actually differed, so the mask is never a quiet excuse. */
function maskedDiffs(A, B) {
  const hit = new Set();
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    if (A[i] === B[i]) continue;
    const a = A[i].split('|');
    const b = B[i].split('|');
    for (let k = 0; k < a.length; k++) {
      if (a[k] !== b[k] && DT3_MASK.has(COL_NAMES[k])) hit.add(COL_NAMES[k]);
    }
  }
  return [...hit];
}

// ---------------------------------------------------------------------------
// Positive control: the shipping Rng stops being seeded
//
// Applied to `Rng.prototype`, so it reaches `Fighter.rng`, `CombatSystem.rng`
// and the CPU alike — i.e. every `this.rng.next()` in the simulation at once.
// `rngCalls` counts executions inside the measured window: a control that never
// runs is not a control, and this gate refuses to report one that did not.
// ---------------------------------------------------------------------------

let rngCalls = 0;
let rngBroken = false;
const RNG_NEXT = Rng.prototype.next;

/**
 * DT-4's own positive control: put the `simTick` leak back.
 *
 * `Fighter.reset()` used to leave `simTick` wherever round 1 had run it to, and
 * `Animator.simulate(tick)` takes that absolute tick as its deterministic noise
 * phase. This wraps the shipping `reset()` and restores the pre-reset value
 * afterwards, which reproduces exactly that defect and nothing else — no source
 * is rewritten, so the method under test stays the shipping one.
 *
 * `resetCalls` counts executions: a control that never ran is not a control.
 */
let resetCalls = 0;
const FIGHTER_RESET = Fighter.prototype.reset;
function breakReset(on) {
  if (on) {
    Fighter.prototype.reset = function leakySimTick(...args) {
      const carried = this.simTick;
      const out = FIGHTER_RESET.apply(this, args);
      this.simTick = carried;
      resetCalls++;
      return out;
    };
  } else {
    Fighter.prototype.reset = FIGHTER_RESET;
  }
}
function breakRng(on) {
  rngBroken = on;
  if (on) Rng.prototype.next = function brokenNext() { rngCalls++; return Math.random(); };
  else Rng.prototype.next = RNG_NEXT;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
const say = (s) => console.log(s);
function record(name, ok, detail = '', rows = []) {
  results.push({ name, ok, detail });
  say(`[dtgate] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  for (const r of rows) say(`          ${r}`);
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

const SEED_MAIN = 0x5eed01;
const SEED_ALT = 0x5eed02;
const TICKS_MAIN = 1400;
const PRELUDE_TICKS = 500;
const ROUND2_TICKS = 400;

const scene = new THREE.Scene();

/**
 * Run a whole script into a brand-new sim and return the per-tick trace.
 * `health` is raised so a KO does not end the round out from under the run and
 * shorten the measured window — the KO path itself is covered separately.
 */
async function runScript(script, { bigHealth = true, perturb = null, prelude = null, resetBetween = false, trial = 'none' } = {}) {
  const sim = await makeSim(scene);
  stage(sim);
  if (bigHealth) { sim.f0.health = MAX_HEALTH * 40; sim.f1.health = MAX_HEALTH * 40; }
  sim.f0.meter = METER_MAX; sim.f1.meter = METER_MAX;

  if (prelude) {
    for (const row of prelude) stepSim(sim, row);
    if (resetBetween) {
      // The product's own round reset, then whichever candidate repair this
      // trial is testing — applied from OUTSIDE the class, so the shipping
      // `reset()` is the thing under test and not a patched copy of it.
      for (const f of sim.fighters) {
        const sign = f.index === 0 ? -1 : 1;
        f.reset(new THREE.Vector3(sign * 1.1, f.floorY, 0), -sign);
        if (trial === 'rng' || trial === 'both') f.rng.reseed(0x51ed2701 + f.index * 0x9e37);
        if (trial === 'anim' || trial === 'both') {
          // Straight at `Animator.play`, past `Fighter#play`'s early return on
          // `loop && currentClip === clipId` — which is precisely the line that
          // makes `reset()`'s one rewind call a no-op for a fighter that ended
          // the round standing.
          f.animator?.play('idle.fight', { blend: 0, loop: true });
        }
      }
      sim.combat.reset();
      if (bigHealth) { sim.f0.health = MAX_HEALTH * 40; sim.f1.health = MAX_HEALTH * 40; }
      sim.f0.meter = METER_MAX; sim.f1.meter = METER_MAX;
    }
  }
  if (perturb) perturb(sim);

  const trace = [];
  const seen = { knockdown: 0, wakeup: 0, hit: 0 };
  let prevState = [sim.f0.state, sim.f1.state];
  for (const row of script) {
    stepSim(sim, row);
    for (let i = 0; i < 2; i++) {
      const s = sim.fighters[i].state;
      if (s !== prevState[i]) {
        if (s === STATE.KNOCKDOWN) seen.knockdown++;
        if (s === STATE.WAKEUP) seen.wakeup++;
        if (s === STATE.HITSTUN) seen.hit++;
        prevState[i] = s;
      }
    }
    trace.push(rowKey(tickRow(sim)));
  }
  sim.combat.dispose();
  for (const inp of sim.input) inp.dispose();
  return { trace, seen, sim };
}

// ---------------------------------------------------------------------------
// Cold-process child: one DT-3 trial per process
// ---------------------------------------------------------------------------

if (CHILD) {
  const trial = TRIAL || 'none';
  const preludeA = keyScript(SEED_MAIN, PRELUDE_TICKS);
  const preludeB = keyScript(SEED_ALT, PRELUDE_TICKS);
  const round2 = keyScript(0x2ead02, ROUND2_TICKS);
  const a = await runScript(round2, { prelude: preludeA, resetBetween: true, trial });
  const b = await runScript(round2, { prelude: preludeB, resetBetween: true, trial });
  const d = firstDivergence(a.trace, b.trace, DT3_MASK);
  const ds = firstDivergence(a.trace, b.trace, DT3_MASK_STRICT);
  process.stdout.write(`__DT3__${JSON.stringify({
    trial, diverged: !!d, tick: d?.tick ?? -1, cols: d?.cols?.slice(0, 4) ?? [],
    observable: !!ds, obsTick: ds?.tick ?? -1, obsCols: ds?.cols?.slice(0, 3) ?? [],
    masked: maskedDiffs(a.trace, b.trace),
    coverage: `${a.seen.knockdown}/${b.seen.knockdown} knockdowns in round 2`,
  })}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// DT-1 — tick-for-tick reproduction from a seed
// ---------------------------------------------------------------------------

say('[dtgate] determinism gate');
say(`[dtgate] fighters ${ROSTER[0].id} vs ${ROSTER[1].id}; ${TICKS_MAIN}-tick script, both players on real key events`);
const t0 = Date.now();

const MAIN = keyScript(SEED_MAIN, TICKS_MAIN);

if (POSITIVE_CONTROL) breakRng(true);
rngCalls = 0;
const run1 = await runScript(MAIN);

// The fresh-process arm of DT-1b runs only this much and reports. Answered here,
// above the spawn below, so the child can never re-enter it and fork forever.
if (HASH_ONLY) {
  process.stdout.write(`__HASH__${JSON.stringify({ n: run1.trace.length, chain: chain(run1.trace) })}\n`);
  process.exit(0);
}

const run2 = await runScript(MAIN);
const controlCalls = rngCalls;
if (POSITIVE_CONTROL) breakRng(false);

{
  const d = firstDivergence(run1.trace, run2.trace);
  const cov = `${run1.trace.length} ticks; coverage: ${run1.seen.hit} hitstun entries, ${run1.seen.knockdown} knockdowns, ${run1.seen.wakeup} wakeups`;
  if (POSITIVE_CONTROL) {
    if (controlCalls === 0) {
      record('DT-1a  two independent in-process sims, tick for tick', false,
        'VACUOUS CONTROL: Rng.prototype.next was never called during the measured run');
    } else {
      record('DT-1a  two independent in-process sims, tick for tick', !d,
        `${cov}; control fired ${controlCalls} rng calls; ${d ? `diverges at tick ${d.tick}` : 'IDENTICAL — control did not bite'}`,
        d ? d.cols.slice(0, 4) : []);
    }
  } else {
    record('DT-1a  two independent in-process sims, tick for tick', !d,
      d ? `first divergence at tick ${d.tick}` : cov, d ? d.cols.slice(0, 6) : []);
  }
}

// DT-1b — a third run in a FRESH PROCESS. Same-process agreement proves nothing
// about module-level state, and this project has module-level singletons (`bus`,
// the shared `rng` in Rng.js, the cached `retime`/`aimBias` written onto MOVES).
if (!POSITIVE_CONTROL) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--hash-only'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith('__HASH__'));
  if (!line) {
    record('DT-1b  a third run in a fresh process', false, `child produced no hash line (status ${child.status})`,
      (child.stderr || '').split('\n').slice(-4));
  } else {
    const got = JSON.parse(line.slice(8));
    const mine = { n: run1.trace.length, last: run1.trace[run1.trace.length - 1], chain: chain(run1.trace) };
    const ok = got.n === mine.n && got.chain === mine.chain;
    record('DT-1b  a third run in a fresh process', ok,
      ok ? `chain ${mine.chain} over ${mine.n} ticks` : `chain ${got.chain} vs ${mine.chain}`);
  }
}

function chain(trace) {
  let h = 0x811c9dc5;
  for (const s of trace) {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  }
  return (h >>> 0).toString(16);
}

// DT-1 null control — a different seed must DIVERGE. A test that passes for both
// the same and a different script is comparing nothing.
{
  const other = keyScript(SEED_ALT, TICKS_MAIN);
  const runX = await runScript(other);
  const d = firstDivergence(run1.trace, runX.trace);
  record('DT-1c  null control — a different script must diverge', !!d,
    d ? `diverges at tick ${d.tick}` : 'IDENTICAL traces from different scripts — the hash is blind');
}

// ---------------------------------------------------------------------------
// DT-3 — determinism across a round boundary
//
// The plan's shape is "replay from a saved snapshot at the round-2 boundary".
// This is the same question asked without a snapshot format: run the SAME
// round-2 script twice, once after a round 1 that went one way and once after a
// round 1 that went another. If `reset()` establishes a reproducible initial
// state, round 2 is identical either way. If anything survives the reset, it
// shows up as a divergence inside round 2 — which is exactly what a rollback or
// a mid-match replay would hit.
//
// Each trial runs in a COLD PROCESS. That is not caution: candidate fixes run in
// sequence inside one process can inherit a state an earlier trial already
// settled, so a trial that "works" fourth in a list may only have been handed a
// clean animator by the trial before it.
// ---------------------------------------------------------------------------

if (!POSITIVE_CONTROL) {
  const trials = ['none', 'rng', 'anim', 'both'];
  const out = {};
  for (const t of trials) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', `--trial=${t}`], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const line = (child.stdout || '').split('\n').find((l) => l.startsWith('__DT3__'));
    out[t] = line ? JSON.parse(line.slice(7)) : { trial: t, error: `no result (status ${child.status})`, diverged: null };
  }
  const rows = trials.map((t) => {
    const r = out[t];
    if (r.error) return `TRIAL ${t.padEnd(5)}  ${r.error}`;
    const obs = r.diverged
      ? (r.observable ? `; OBSERVABLE at tick ${r.obsTick} (${r.obsCols[0] ?? ''})` : '; latent only — no observable field moved in this window')
      : '';
    return `TRIAL ${t.padEnd(5)}  ${r.diverged ? `DIVERGES at round-2 tick ${r.tick}  (${r.cols[0] ?? ''})${obs}` : 'CLEAN — round 2 is identical after either round 1'}  [${r.coverage}]`;
  });
  const baseline = out.none;
  record('DT-3  reset() establishes a reproducible round-2 state', baseline && baseline.diverged === false,
    baseline?.diverged ? `round 2 depends on what happened in round 1` : 'round 2 reproduces', rows);
}

// DT-3 controls. Null: the SAME prelude twice must give an identical round 2 —
// if that trips, the instrument is noise and the finding above is worthless.
// Positive: a 1e-9 nudge to one fighter's x at the round-2 boundary must be
// caught, which proves the trace is reading round-2 content at all.
if (!POSITIVE_CONTROL) {
  const preludeA = keyScript(SEED_MAIN, PRELUDE_TICKS);
  const round2 = keyScript(0x2ead02, ROUND2_TICKS);
  const n1 = await runScript(round2, { prelude: preludeA, resetBetween: true });
  const n2 = await runScript(round2, { prelude: preludeA, resetBetween: true });
  const dn = firstDivergence(n1.trace, n2.trace, DT3_MASK);
  record('DT-3n null control — same round 1, same round 2', !dn,
    dn ? `diverges at round-2 tick ${dn.tick}` : `${n1.trace.length} ticks identical`);

  const p2 = await runScript(round2, {
    prelude: preludeA, resetBetween: true,
    perturb: (sim) => { sim.f0.position.x += 1e-9; },
  });
  const dp = firstDivergence(n1.trace, p2.trace, DT3_MASK);
  record('DT-3p positive control — a 1e-9 nudge at the boundary must be seen', !!dp,
    dp ? `caught at round-2 tick ${dp.tick}` : 'NOT SEEN — the round-2 trace is not reading the sim');
}

// ---------------------------------------------------------------------------
// DT-4 — a round reset is a clean replay start REGARDLESS OF HOW LONG ROUND 1 WAS
//
// DT-3 above cannot see this, and the reason is its own construction. Both of
// its arms run a prelude of exactly `PRELUDE_TICKS`, so when they hit the reset
// they have advanced `Fighter.simTick` by the same amount and it CANCELS in the
// diff. Every absolute-tick field in the fighter is invisible to it by design.
//
// `Fighter.reset()` did not reset `simTick`, and `Animator.simulate(tick)` takes
// that absolute tick as its deterministic noise phase — so a round 2 entered
// after a long round 1 breathed on a different phase than one entered after a
// short round 1, and the pose fed the hitbox builder differed from tick 1. The
// same field also drives the input-buffer window, the motion window and the
// throw/damage clocks.
//
// It is not a hypothetical the way DT-3's was: `reset()`'s own header records a
// four-trial investigation that cleared "the animator clock" as a cause. That
// investigation was right about what it measured and blind to this, because it
// too compared two equal-length round 1s.
//
// So this arm makes the preludes DIFFERENT LENGTHS. Everything else is DT-3.
// ---------------------------------------------------------------------------
if (!POSITIVE_CONTROL) {
  const shortPre = keyScript(SEED_MAIN, PRELUDE_TICKS);
  const longPre = keyScript(SEED_MAIN, PRELUDE_TICKS + 137);
  const round2 = keyScript(0x2ead02, ROUND2_TICKS);
  const a = await runScript(round2, { prelude: shortPre, resetBetween: true });
  const b = await runScript(round2, { prelude: longPre, resetBetween: true });
  const d = firstDivergence(a.trace, b.trace, DT4_MASK);
  record('DT-4  round 2 is identical whether round 1 was long or short', !d,
    d ? `diverges at round-2 tick ${d.tick} (${d.cols.slice(0, 4).join(', ')}) — `
      + 'something absolute-tick survived reset()'
      : `${a.trace.length} ticks identical across a ${137}-tick difference in round-1 length`);

  // NULL: the same LENGTH twice must agree, or the arm is measuring the script
  // and not the reset.
  const a2 = await runScript(round2, { prelude: shortPre, resetBetween: true });
  const dn4 = firstDivergence(a.trace, a2.trace, DT4_MASK);
  record('DT-4n null control — same round-1 length, twice', !dn4,
    dn4 ? `diverges at round-2 tick ${dn4.tick}` : `${a.trace.length} ticks identical`);

  // DT-4p positive control — re-break `reset()` and require the arm to catch it.
  // Without this, DT-4 going green proves only that the mask is wide enough.
  breakReset(true);
  const pa = await runScript(round2, { prelude: shortPre, resetBetween: true });
  const pb = await runScript(round2, { prelude: longPre, resetBetween: true });
  breakReset(false);
  const dp4 = firstDivergence(pa.trace, pb.trace, DT4_MASK);
  record('DT-4p positive control — restoring the simTick leak must be caught', !!dp4 && resetCalls > 0,
    resetCalls === 0 ? 'the control never ran — reset() was not called inside the measured window'
      : dp4 ? `caught at round-2 tick ${dp4.tick} (${dp4.cols.slice(0, 3).join(', ')}); `
        + `${resetCalls} leaky resets applied`
        : `NOT SEEN across ${pa.trace.length} ticks — DT-4 cannot detect the defect it exists for`);
}

// ---------------------------------------------------------------------------

const bad = results.filter((r) => !r.ok);
say('');
if (POSITIVE_CONTROL) {
  const ok = bad.length > 0;
  say(`[dtgate] POSITIVE CONTROL: ${ok ? 'RED as required' : 'GREEN — the control did not bite, the gate measures nothing'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(ok ? 0 : 1);
}
say(`[dtgate] ${bad.length ? `RED — ${bad.length} failing` : 'GREEN'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(bad.length ? 1 : 0);
