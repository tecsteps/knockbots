/**
 * Knockbots — the seeded fuzzer.
 *
 * WHY THIS EXISTS
 *
 * `tools/simscene.mjs` checks six scenarios that somebody thought of. Every bug
 * this project has shipped to a player was one nobody thought of: a held
 * direction read as a double tap, a hitbox on the planted foot, a `b+` column
 * nobody could reach. The scenarios cannot find those, by construction — a
 * scripted test only ever presses what its author already suspected.
 *
 * So this presses everything, and checks only the properties that must hold no
 * matter what a player does: nothing goes non-finite, nobody leaves the arena,
 * nobody changes size, nobody enters a state the engine does not declare,
 * nothing teleports, and nobody gets stuck in a state they cannot leave.
 * `Scenarios.js` calls that set `FUZZ_INVARIANTS`, and the omissions are
 * deliberate — a random input log has no intent, so "the hit lands exactly
 * once" and "both fighters return to idle" are not properties of it.
 *
 * EVERY FAILURE IS A REGRESSION TEST. A red run writes a bundle containing the
 * seed, the initial save state, the input log as PHYSICAL KEY EDGES, the full
 * state trajectory, the event log, the invariant report and any console error,
 * and `--repro=<dir>` replays it. Because the simulation is deterministic —
 * proven three ways by `simscene --determinism`, including across processes —
 * that replay is the same run, not a similar one. See docs/SIMTEST.md for
 * turning one into a permanent scenario.
 *
 * WHAT IT CANNOT FIND, so a green run is not mistaken for a clean bill:
 *   - anything that needs a GL context. No renderer runs here, so a shader
 *     that fails to compile, a texture that leaks or a WebGL context loss is
 *     invisible. `simscene --shots` is the layer that sees those.
 *   - anything about whether the result was FUN, fair or readable.
 *   - a defect that needs a specific two-character matchup: the cast is fixed
 *     to the roster's first pair, because `setCharacter` rebuilds both rigs and
 *     that costs more than the entire fuzz budget. `--cast=a,b` overrides it
 *     for a targeted run.
 *   - anything past the frame budget. Long-run drift over a full three-round
 *     match is not covered.
 *
 * USAGE
 *   node tools/simfuzz.mjs                        200 runs, 300 frames each
 *   node tools/simfuzz.mjs --runs=1000 --frames=600
 *   node tools/simfuzz.mjs --seed=12345           start the seed sequence here
 *   node tools/simfuzz.mjs --cpu=8                let the CPU drive player 2
 *   node tools/simfuzz.mjs --out=shots/fuzz       where bundles are written
 *   node tools/simfuzz.mjs --repro=shots/fuzz/s-1234   replay one bundle
 *   node tools/simfuzz.mjs --keep-all             bundle the green runs too
 *   node tools/simfuzz.mjs --rootstep=0.3         tighten the teleport limit
 *
 * Exit code is 0 only when no run failed (or, under `--repro`, when the bundle
 * still reproduces — a repro that has stopped failing exits 2, because that is
 * news either way).
 */

import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, '..');
const SRC = join(ROOT, 'src');

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(`--${n}`);
const opt = (n, d = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const RUNS = Number(opt('runs', 200));
const FRAMES = Number(opt('frames', 300));
const SEED0 = Number(opt('seed', 1));
const OUT = opt('out', 'shots/fuzz');
const REPRO = opt('repro', null);
const KEEP_ALL = flag('keep-all');
const CPU_LEVEL = opt('cpu', null) === null ? null : Number(opt('cpu'));
const CAST = (opt('cast', '') || '').split(',').filter(Boolean).map(Number);
const VERBOSE = flag('verbose');
/**
 * Override the root-step limit for this run.
 *
 * The default sits above the dash lurch documented in `Scenarios.js`, so the
 * fuzzer reports new teleports rather than that known one. Tightening it is how
 * you go looking for the next-worst offender, and how a bundle that reproduces
 * a KNOWN failure is generated for the repro workflow in docs/SIMTEST.md.
 */
let ROOTSTEP = opt('rootstep', null) === null ? null : Number(opt('rootstep'));

// --- DOM shim, same as tools/simscene.mjs ----------------------------------

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
const { Fighter } = await import(pathToFileURL(join(SRC, 'combat/Fighter.js')));
const { CombatSystem } = await import(pathToFileURL(join(SRC, 'combat/CombatSystem.js')));
const { CPU } = await import(pathToFileURL(join(SRC, 'ai/CPU.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { makeGameTest } = await import(pathToFileURL(join(SRC, 'combat/TestHarness.js')));
const { Rng } = await import(pathToFileURL(join(SRC, 'core/Rng.js')));
const {
  runInvariants, FUZZ_INVARIANTS, DEFAULT_TUNE,
} = await import(pathToFileURL(join(SRC, 'core/Scenarios.js')));

const say = (s) => console.log(s);

/**
 * Console output during a run, captured so a bundle carries it.
 *
 * `Fighter#play` warns on a missing clip and `Game.setQuality` warns on a
 * subsystem that threw — both are silent-in-production failures that a fuzz run
 * can provoke and that no invariant looks for. Capturing them turns "the run
 * looked fine" into "the run looked fine and said nothing", which is a
 * different and stronger statement.
 */
const consoleLog = [];
for (const level of ['warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    consoleLog.push(`${level}: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`.slice(0, 400));
    if (VERBOSE) orig(...args);
  };
}

// --- the stub game ---------------------------------------------------------

const scene = new THREE.Scene();
const cast = CAST.length === 2 ? CAST : [0, 1];
const f0 = new Fighter({ index: 0, def: ROSTER[cast[0]], scene, environment: null });
const f1 = new Fighter({ index: 1, def: ROSTER[cast[1]], scene, environment: null });
await f0.init();
await f1.init();
f0.setOpponent(f1);
f1.setOpponent(f0);
const game = {
  fighters: [f0, f1],
  combat: new CombatSystem([f0, f1], null),
  cpu: [null, CPU_LEVEL == null ? null : new CPU(f1, f0, { level: CPU_LEVEL })],
  scene,
  tick: 0,
  phase: 'fight',
  setPhase(p) { this.phase = p; },
};
const GT = makeGameTest(game, { roster: ROSTER });

// ---------------------------------------------------------------------------
// The input generator
// ---------------------------------------------------------------------------

/**
 * Tokens a fuzzed player may press.
 *
 * Facing-relative directions rather than raw key codes, so the generator works
 * from both sides of the arena without knowing which side it is on — the façade
 * resolves each token against the fighter's facing on the frame it fires, which
 * is also what makes the recorded log (physical codes) a faithful replay.
 */
const DIRS = ['f', 'b', 'u', 'd'];
const BUTTONS = ['1', '2', '3', '4', '5'];

/**
 * A random input log.
 *
 * NOT UNIFORM NOISE. A generator that flips every key every frame produces
 * garbage that never starts a move — the matcher wants a direction held for a
 * few frames and a button pressed on a fresh edge, and pure noise satisfies
 * neither. Measured on the first version: 100 runs of uniform noise started 6
 * moves between them. So the model is: hold a direction for a burst, tap a
 * button with a real down/up edge, occasionally hold guard, occasionally do
 * nothing at all. That produces runs that reach the parts of the state machine
 * worth fuzzing.
 *
 * `players` is 1 when the CPU is driving player 2 — two sources of input for
 * the same fighter would fight each other and neither would be reproducible.
 */
function makeInputLog(rng, frames, players = 2) {
  const log = [];
  for (let p = 0; p < players; p++) {
    let f = 2 + rng.int(6);
    while (f < frames) {
      const roll = rng.next();
      if (roll < 0.45) {
        // A held direction: 4-24 frames, which spans "a tap the matcher can
        // read as a dash" through "a walk".
        const dir = rng.pick(DIRS);
        const len = 4 + rng.int(21);
        log.push({ frame: f, key: dir, action: 'down', player: p });
        log.push({ frame: Math.min(frames - 1, f + len), key: dir, action: 'up', player: p });
        f += len + rng.int(8);
      } else if (roll < 0.85) {
        // A button, pressed for 1-3 frames. Chords happen naturally when two
        // of these land on the same frame, which is how a throw gets fuzzed.
        const b = rng.pick(BUTTONS);
        const len = 1 + rng.int(3);
        log.push({ frame: f, key: b, action: 'down', player: p });
        log.push({ frame: Math.min(frames - 1, f + len), key: b, action: 'up', player: p });
        f += len + 1 + rng.int(14);
      } else if (roll < 0.95) {
        const len = 6 + rng.int(30);
        log.push({ frame: f, key: 'guard', action: 'down', player: p });
        log.push({ frame: Math.min(frames - 1, f + len), key: 'guard', action: 'up', player: p });
        f += len + rng.int(10);
      } else {
        f += 8 + rng.int(40); // neutral, on purpose
      }
    }
  }
  return log.sort((a, b) => a.frame - b.frame);
}

// ---------------------------------------------------------------------------
// Watchdogs the invariant table does not carry
// ---------------------------------------------------------------------------

/**
 * A fighter that cannot get out of a state.
 *
 * Not an invariant in `Scenarios.js` because a scripted scenario ends when its
 * script does, and a run that finishes mid-move is fine there. Here, a fighter
 * that has been in one non-idle state for a quarter of the run with no input
 * arriving is a soft-lock — the failure a player reports as "he just froze".
 *
 * The threshold is not arbitrary. The longest single state a fighter can
 * legitimately hold is a knockdown plus wake-up; the longest move in any set is
 * 86 frames (`siegeSlam`), and knockdown recovery runs to about 120. 180 is
 * comfortably past both, and a genuine lock never leaves.
 */
const STUCK_LIMIT = 180;

function watchdogs(timeline, events) {
  const out = [];
  for (const side of ['a', 'd']) {
    let run = 1; let worst = 0; let state = null; let at = -1;
    for (let i = 1; i < timeline.length; i++) {
      if (timeline[i][side].state === timeline[i - 1][side].state) run++;
      else run = 1;
      if (run > worst) { worst = run; state = timeline[i][side].state; at = timeline[i].frame; }
    }
    const ok = state === 'idle' || worst <= STUCK_LIMIT;
    out.push({
      id: `noStuck.${side}`, what: 'no fighter is trapped in one non-idle state',
      ok, measured: `${worst} frame(s) in ${state}`, limit: `${STUCK_LIMIT} frames`,
      detail: at >= 0 ? `ending frame ${at}` : '',
    });
  }
  out.push({
    id: 'noConsoleNoise', what: 'the run produced no warning or error',
    ok: consoleLog.length === 0,
    measured: consoleLog.length ? consoleLog[0] : 'silent',
    limit: 'silent',
  });
  return out;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/**
 * @param {{seed:number, dist:number, frames:number, log:Array}} spec
 */
function runOnce(spec) {
  consoleLog.length = 0;
  const t0 = Date.now();
  let threw = null;
  let save = null;
  try {
    GT.reset({ seed: spec.seed, dist: spec.dist, cpu: CPU_LEVEL });
    // The save state is taken BEFORE any input is scheduled and before any
    // frame runs, so it is the `clean` case `loadState` reproduces exactly.
    // That plus the input log is the whole repro.
    save = GT.saveState();
    GT.input(spec.log.map((e) => ({ ...e })));
    GT.step(spec.frames);
  } catch (e) {
    threw = `${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`;
  }
  const timeline = GT.getTimeline().filter((r) => r.frame >= 0);
  const events = GT.getEvents();
  // A fuzz run has no intent, so it is judged on the properties that hold for
  // any input at all. The scenario object is synthesised rather than looked up.
  const scn = {
    name: `fuzz-${spec.seed}`, invariants: FUZZ_INVARIANTS,
    expect: {}, tune: { rootStep: ROOTSTEP ?? DEFAULT_TUNE.rootStep },
  };
  const inv = timeline.length ? runInvariants(scn, timeline, events) : { ok: false, rows: [] };
  const rows = [...inv.rows, ...(timeline.length ? watchdogs(timeline, events) : [])];
  if (threw) rows.push({ id: 'noThrow', what: 'the simulation did not throw', ok: false, measured: threw.split('\n')[0], limit: 'no exception' });
  return {
    spec, ms: Date.now() - t0,
    ok: rows.every((r) => r.ok) && !threw,
    rows, threw, save, timeline, events,
    digest: GT.digest(),
    metrics: GT.getMetrics(),
    inputLog: GT.getInputLog(),
    consoleLog: [...consoleLog],
  };
}

/**
 * Write everything needed to reproduce a run, and nothing that would need to be
 * regenerated to do it.
 *
 * `inputLog` is the PHYSICAL key edges the façade actually dispatched, not the
 * facing-relative tokens the generator produced. Those two are the same thing
 * only while the fighter is on the side it started on; a run that crossed over
 * would replay differently from the tokens and identically from the codes.
 */
function writeBundle(dir, r) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'repro.json'), JSON.stringify({
    version: 1,
    seed: r.spec.seed, dist: r.spec.dist, frames: r.spec.frames,
    cast, cpu: CPU_LEVEL,
    // Recorded so a replay is judged by the limit that failed it, not by
    // whatever the default happens to be the day someone replays it.
    rootStep: ROOTSTEP ?? DEFAULT_TUNE.rootStep,
    digest: r.digest,
    failed: r.rows.filter((x) => !x.ok).map((x) => x.id),
    inputLog: r.inputLog,
    saveState: r.save,
  }, null, 1));
  writeFileSync(join(dir, 'report.json'), JSON.stringify({
    invariants: r.rows, metrics: r.metrics, threw: r.threw, console: r.consoleLog,
  }, null, 1));
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify(r.timeline));
  writeFileSync(join(dir, 'events.json'), JSON.stringify(r.events, null, 1));
  writeFileSync(join(dir, 'console.txt'), r.consoleLog.join('\n') + (r.threw ? `\n\nTHREW:\n${r.threw}` : ''));
  writeFileSync(join(dir, 'REPRO.md'), [
    `# Fuzz failure, seed ${r.spec.seed}`,
    '',
    `Failed: ${r.rows.filter((x) => !x.ok).map((x) => x.id).join(', ') || '(none — bundled by --keep-all)'}`,
    '',
    '## Replay it',
    '```',
    `node tools/simfuzz.mjs --repro=${dir.slice(ROOT.length + 1)}`,
    '```',
    '',
    '## Make it permanent',
    '',
    'Copy `inputLog` from `repro.json` into a new entry in `SCENARIOS`',
    '(src/core/Scenarios.js) with `dist` and `frames` from the same file, then',
    'run `node tools/simscene.mjs --scenario=<name>`. The key codes replay',
    'as-is — `physicalFor` passes an unrecognised token straight through.',
    '',
    'See docs/SIMTEST.md, "Turning a fuzzer failure into a regression test".',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Repro mode
// ---------------------------------------------------------------------------

if (REPRO) {
  const dir = resolvePath(ROOT, REPRO);
  const file = join(dir, 'repro.json');
  if (!existsSync(file)) { say(`[simfuzz] no repro.json in ${dir}`); process.exit(2); }
  const b = JSON.parse(readFileSync(file, 'utf8'));
  say(`[simfuzz] replaying seed ${b.seed}, ${b.frames} frames, ${b.inputLog.length} key edges`
    + `${b.rootStep ? `, rootStep limit ${b.rootStep} m as recorded` : ''}`);
  if (b.rootStep && ROOTSTEP === null) ROOTSTEP = b.rootStep;
  const r = runOnce({ seed: b.seed, dist: b.dist, frames: b.frames, log: b.inputLog });
  const same = r.digest === b.digest;
  say(`[simfuzz] digest ${r.digest} vs recorded ${b.digest} — ${same ? 'IDENTICAL' : 'DIFFERENT'}`);
  for (const row of r.rows) {
    say(`          ${row.ok ? 'ok  ' : 'FAIL'} ${row.id.padEnd(18)} ${String(row.measured).slice(0, 70).padEnd(70)} limit ${row.limit}`);
  }
  const stillFails = !r.ok;
  say(`[simfuzz] ${stillFails ? 'STILL FAILS — the bundle is a live regression test'
    : 'NO LONGER FAILS — either it was fixed, or the replay is not faithful'}`);
  if (!same) say('[simfuzz] the digest moved, so this replay is NOT the recorded run; check the seed and the cast');
  process.exit(stillFails ? 0 : 2);
}

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

say(`[simfuzz] ${ROSTER[cast[0]].id} vs ${ROSTER[cast[1]].id}, `
  + `${RUNS} runs x ${FRAMES} frames, seeds from ${SEED0}`
  + `${CPU_LEVEL == null ? '' : `, CPU level ${CPU_LEVEL} on player 2`}`);

const outDir = resolvePath(ROOT, OUT);
const failures = [];
const t0 = Date.now();
let moves = 0;
let hits = 0;

for (let i = 0; i < RUNS; i++) {
  const seed = SEED0 + i;
  // The distance is part of the seed, not a constant: half the interesting
  // behaviour in a fighting game is a function of spacing, and a fuzzer that
  // always starts at 1.05 m never fuzzes the neutral game.
  const rng = new Rng(seed);
  const dist = +(0.8 + rng.next() * 3.2).toFixed(3);
  const log = makeInputLog(rng, FRAMES, CPU_LEVEL == null ? 2 : 1);
  const r = runOnce({ seed, dist, frames: FRAMES, log });
  hits += r.metrics.hits;
  moves += new Set(r.timeline.map((x) => x.move).filter(Boolean)).size;
  if (!r.ok) {
    failures.push(r);
    const dir = join(outDir, `s-${seed}`);
    writeBundle(dir, r);
    say(`[simfuzz] FAIL seed ${seed} dist ${dist} — ${r.rows.filter((x) => !x.ok).map((x) => x.id).join(', ')}`);
    for (const row of r.rows.filter((x) => !x.ok)) {
      say(`          ${row.id.padEnd(18)} ${String(row.measured).slice(0, 90)}  limit ${row.limit}  ${row.detail || ''}`);
    }
    say(`          bundle: ${dir}`);
  } else if (KEEP_ALL) {
    writeBundle(join(outDir, `s-${seed}`), r);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
say('');
// COVERAGE, reported every run. A fuzzer that presses nothing reachable is a
// fuzzer that passes, and the only way to tell that apart from a healthy green
// is to say how much of the game it actually touched.
say(`[simfuzz] coverage: ${moves} distinct move(s) started across the run set, ${hits} hit(s) landed`);
say(`[simfuzz] ${failures.length ? 'RED' : 'GREEN'} — ${RUNS - failures.length}/${RUNS} runs clean in ${secs}s`
  + `${failures.length ? `, ${failures.length} bundle(s) under ${OUT}/` : ''}`);
process.exitCode = failures.length ? 1 : 0;
