/**
 * Knockbots — the scenario gate: timelines, invariants, determinism, contact
 * sheets.
 *
 * WHY THIS EXISTS
 *
 * `tools/simgate.mjs` proves that a keystroke produces the move the notation
 * names. It says nothing about what the move then DOES over the following
 * ninety frames, and "what it does over the following ninety frames" is the
 * entire product. The gap it leaves is the one a human filled by watching the
 * game — which is the most expensive instrument in the project and the one
 * least able to see a four-millimetre root jump.
 *
 * So this runs named scenarios through the real simulation and produces three
 * artefacts per scenario, in descending order of cost and ascending order of
 * what only a human can do:
 *
 *   1. A MACHINE-READABLE TIMELINE. One row per frame: state, position, move,
 *      move tick, active hitbox count, strike reach, events. Diffable, and the
 *      thing every other layer is derived from.
 *   2. NUMERIC INVARIANTS. The properties a picture cannot show — a root that
 *      never teleports, a scale that never changes, a hit that lands exactly
 *      once, a defender that reacts within one frame, a loop that meets itself.
 *      Every limit in `src/core/Scenarios.js` was measured on the shipping
 *      build before it was written down.
 *   3. A CONTACT SHEET (`--shots`). Twelve to thirty evenly spaced frames on
 *      one image, with the named moments forced in, so a single vision pass can
 *      see a position jump, a missing limb, clipping, a kick aimed backwards or
 *      a camera that changed its mind. Plus full-resolution frames at the seven
 *      named moments: before input, anticipation, max extension, impact,
 *      recovery, return to idle, loop boundary.
 *
 * NO BROWSER FOR (1) AND (2). Both run in bare Node against the same fixed
 * 60 Hz tick the game uses — the DOM shim is `tools/simgate.mjs`'s, and the
 * whole suite of six scenarios takes about two seconds. Only `--shots` boots
 * Chromium, and only because pixels require it. That asymmetry is the point of
 * the whole exercise: the cheap layer is the one you can afford to run on every
 * change.
 *
 * WHAT IT DOES NOT COVER, so nobody reads a green run as more than it is:
 *   - one attacker, one defender, no CPU, no round transitions, no menus.
 *   - nothing about whether the game is FUN, fair, readable in a crowded frame,
 *     or free of exploits a player would find. See docs/SIMTEST.md.
 *   - the contact sheet is 1600x900 sliced into cells; a defect smaller than a
 *     cell is not visible in it and needs `--shots` full-res frames.
 *
 * USAGE
 *   node tools/simscene.mjs                       every scenario, numeric only
 *   node tools/simscene.mjs --scenario=juggle     one of them
 *   node tools/simscene.mjs --verbose             print every invariant, green
 *                                                 or red, with its measurement
 *   node tools/simscene.mjs --determinism         run each scenario three times
 *                                                 and diff the trajectories
 *   node tools/simscene.mjs --savestate           measure save/load fidelity
 *   node tools/simscene.mjs --json=docs/sim       write timelines and reports
 *   node tools/simscene.mjs --shots               boot Chromium, write contact
 *                                                 sheets + named frames
 *   node tools/simscene.mjs --shots --cells=24 --out=shots/sim
 *
 * Exit code is 0 only when every scenario's invariants pass.
 */

import { pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
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

const VERBOSE = flag('verbose');
const DETERMINISM = flag('determinism');
const SAVESTATE = flag('savestate');
const SHOTS = flag('shots');
const ONLY = opt('scenario', null);
const JSON_OUT = opt('json', null);
const CELLS = Number(opt('cells', 20));
const SHOT_OUT = opt('out', 'shots/sim');
const SEED = Number(opt('seed', 20260812));
/** Internal: print one scenario's digest and exit. Used for the cross-process check. */
const DIGEST_ONLY = opt('digest', null);

// ---------------------------------------------------------------------------
// DOM shim — lifted from tools/simgate.mjs, which lifted it from check.mjs.
// `RobotBuilder` and `Animator` touch `document` while building geometry;
// nothing in the simulation path reads anything back out of it.
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

const THREE = await import(join(ROOT, 'node_modules/three/build/three.module.js'));
const { Fighter } = await import(pathToFileURL(join(SRC, 'combat/Fighter.js')));
const { CombatSystem } = await import(pathToFileURL(join(SRC, 'combat/CombatSystem.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { makeGameTest } = await import(pathToFileURL(join(SRC, 'combat/TestHarness.js')));
const { Input } = await import(pathToFileURL(join(SRC, 'core/Input.js')));
const {
  SCENARIOS, runInvariants, deriveMarks, pickContactFrames, PAD,
} = await import(pathToFileURL(join(SRC, 'core/Scenarios.js')));

const say = (s) => console.log(s);

// ---------------------------------------------------------------------------
// The stub game
//
// `makeGameTest` and `makeTestHarness` between them touch `fighters`, `combat`,
// `cpu`, `scene`, `phase`, `setPhase` and (optionally) `renderer`,
// `fightCamera` and `paused`. That is the entire surface, which is why the
// façade can run here at all — and why the browser and this process are
// running the same code rather than two things that resemble each other.
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const f0 = new Fighter({ index: 0, def: ROSTER[0], scene, environment: null });
const f1 = new Fighter({ index: 1, def: ROSTER[1], scene, environment: null });
await f0.init();
await f1.init();
f0.setOpponent(f1);
f1.setOpponent(f0);

const game = {
  fighters: [f0, f1],
  combat: new CombatSystem([f0, f1], null),
  cpu: [null, null],
  scene,
  tick: 0,
  phase: 'fight',
  setPhase(p) { this.phase = p; },
};

const GT = makeGameTest(game, { roster: ROSTER });

// ---------------------------------------------------------------------------
// PRE-FLIGHT: the key map in Scenarios.js must agree with the one in Input.js
//
// `PAD` is a hand-copy of `KEYMAP`, which `Input` does not export. A drift
// there would not break anything loudly — it would silently press nothing, and
// every scenario would report a fighter that stood still while its invariants
// passed. So it is checked against a real `Input` before anything else runs.
// ---------------------------------------------------------------------------

function preflightKeymap() {
  const target = new EventTarget();
  const input = new Input(target);
  class Ev extends Event { constructor(t, code) { super(t); this.code = code; this.repeat = false; } preventDefault() {} }
  const probe = (code, player) => {
    target.dispatchEvent(new Ev('keydown', code));
    input.beginTick(0);
    const c = input.commandsFor(player, { facing: 1 });
    const out = { x: c.x, y: c.y, pressed: [...c.pressed].join('') };
    input.endTick();
    target.dispatchEvent(new Ev('keyup', code));
    return out;
  };
  const bad = [];
  for (const player of [0, 1]) {
    const m = PAD[player];
    if (probe(m.xPlus, player).x !== 1) bad.push(`p${player} xPlus=${m.xPlus}`);
    if (probe(m.xMinus, player).x !== -1) bad.push(`p${player} xMinus=${m.xMinus}`);
    if (probe(m.yPlus, player).y !== 1) bad.push(`p${player} yPlus=${m.yPlus}`);
    if (probe(m.yMinus, player).y !== -1) bad.push(`p${player} yMinus=${m.yMinus}`);
    for (const b of [1, 2, 3, 4, 5]) {
      if (probe(m[b], player).pressed !== String(b)) bad.push(`p${player} b${b}=${m[b]}`);
    }
  }
  input.dispose();
  return bad;
}

// ---------------------------------------------------------------------------
// One scenario
// ---------------------------------------------------------------------------

function runScenario(name, seed = SEED) {
  const scn = SCENARIOS[name];
  const t0 = Date.now();
  GT.loadScenario(name, { seed });
  GT.step(scn.frames);
  const timeline = GT.getTimeline();
  const events = GT.getEvents();
  const marks = deriveMarks(timeline.filter((r) => r.frame >= 0), events);
  const inv = runInvariants({ ...scn, name }, timeline.filter((r) => r.frame >= 0), events);
  return {
    name, seed, ms: Date.now() - t0,
    frames: scn.frames,
    digest: GT.digest(),
    metrics: GT.getMetrics(),
    marks, events, timeline,
    contactFrames: pickContactFrames(scn.frames, marks, CELLS),
    invariants: inv.rows,
    ok: inv.ok,
    inputLog: GT.getInputLog(),
  };
}

/**
 * A compact printable timeline — the shape the brief asks for.
 *
 * Only frames where something CHANGED, plus every frame carrying an event.
 * A 240-frame idle loop prints as four lines instead of two hundred and forty,
 * and the four lines are the ones that carry information.
 */
function compactTimeline(timeline) {
  const out = [];
  let prev = null;
  for (const r of timeline) {
    if (r.frame < 0) continue;
    const key = `${r.state}|${r.move}|${r.boxes > 0}|${r.d.state}`;
    if (prev !== key || r.ev) {
      const row = { frame: r.frame, state: r.state, x: +r.x.toFixed(3) };
      if (r.move) { row.move = r.move; row.moveTick = r.moveTick; }
      if (r.boxes) row.active = r.boxes;
      if (r.hit) row.hit = true;
      if (r.ev) row.ev = r.ev;
      if (r.d.state !== 'idle') row.dState = r.d.state;
      out.push(row);
      prev = key;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Determinism
//
// THE CENTRAL CLAIM OF THE WHOLE HARNESS, so it is measured rather than
// asserted. Three runs of the same seed and the same input log, diffed row by
// row over the FULL state — position to nine places, velocity, state, clocks,
// health, meter, the current clip, both generator states, and the pose
// signature. The first divergent frame is printed with both sides, because
// "they differ" is not a bug report and "they differ at frame 47, on
// `a.pose`" is.
//
// The first run is NOT discarded. `tools/simgate.mjs` discards it, on the
// strength of a measured first-run divergence traced to `Fighter#play`'s
// early return skipping the animator rewind in `reset()`. That has since been
// fixed in `Fighter#reset` — it now calls `Animator.reset()`, zeroes the
// animator clock and clears `currentClip` before rewinding — so the rule is no
// longer needed, and keeping it would hide a regression of exactly the defect
// it was written for. If run 1 ever stops matching runs 2 and 3, that is the
// finding, not a nuisance to be warmed away.
// ---------------------------------------------------------------------------

function trajectory(name, seed) {
  const r = runScenario(name, seed);
  return {
    digest: r.digest,
    rows: r.timeline.map((t) => JSON.stringify(t)),
    events: r.events.map((e) => JSON.stringify(e)),
  };
}

/**
 * The first row that differs, reported FIELD BY FIELD.
 *
 * Printing the two rows whole is what the first version did and it is nearly
 * useless: a timeline row is 700 characters, the terminal truncates it, and the
 * one field that moved is somewhere in the middle. A divergence report has to
 * name the column, or the next step is to write this function anyway.
 */
function firstDiff(a, b) {
  const n = Math.max(a.rows.length, b.rows.length);
  for (let i = 0; i < n; i++) {
    if (a.rows[i] === b.rows[i]) continue;
    const ra = JSON.parse(a.rows[i] || '{}');
    const rb = JSON.parse(b.rows[i] || '{}');
    const fields = [];
    const walk = (x, y, path) => {
      for (const k of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
        const va = x?.[k]; const vb = y?.[k];
        if (va && typeof va === 'object') { walk(va, vb, `${path}${k}.`); continue; }
        if (va !== vb) fields.push(`${path}${k}: ${va} vs ${vb}`);
      }
    };
    walk(ra, rb, '');
    return { i, frame: ra.frame, fields };
  }
  if (a.events.join('\n') !== b.events.join('\n')) {
    return { i: -1, frame: null, fields: ['the EVENT LOG differs while every timeline row matched'] };
  }
  return null;
}

function testDeterminism(names) {
  let bad = 0;
  for (const name of names) {
    const t1 = trajectory(name, SEED);
    const t2 = trajectory(name, SEED);
    const t3 = trajectory(name, SEED);
    // INTERLEAVED. Three runs back to back only prove there is no carry from
    // the same scenario. Running every OTHER scenario in between and then
    // repeating this one proves there is no carry from a DIFFERENT one, which
    // is where both of the leaks found while building this actually lived —
    // banked meter and a stale `Input` history, neither of which shows up when
    // a scenario only ever follows itself.
    for (const other of Object.keys(SCENARIOS)) if (other !== name) trajectory(other, SEED ^ 0x777);
    const t4 = trajectory(name, SEED);
    /*
     * CROSS-PROCESS. Everything above runs in one V8 with one set of module
     * instances, so it cannot see a divergence that comes from module load
     * order, a cache warmed at import time, or anything else that is settled
     * before the first scenario runs. A cold child process asked for the same
     * seed and the same scenario has none of that in common except the source,
     * and its digest has to match anyway — that is what "a replay" means.
     */
    const child = spawnSync(process.execPath,
      [fileURLToPath(import.meta.url), `--digest=${name}`, `--seed=${SEED}`], { encoding: 'utf8' });
    const childDigest = (child.stdout || '').trim().split('\n').pop();
    const d12 = firstDiff(t1, t2);
    const d23 = firstDiff(t2, t3) || firstDiff(t3, t4);
    // A seed that changes nothing is a seed that is not wired up. This is the
    // negative control for the positive claim above: if a different seed
    // produced the same digest, "same seed, same trajectory" would be true for
    // the uninteresting reason.
    const other = trajectory(name, SEED ^ 0x5f5f5f);
    const seedMatters = other.digest !== t1.digest
      || SCENARIOS[name].script.length === 0 || !usesRandomness(name);
    const ok = !d12 && !d23 && childDigest === t1.digest;
    if (!ok) bad++;
    say(`[simscene] ${ok ? 'PASS' : 'FAIL'}  determinism ${name.padEnd(18)} digest ${t1.digest} `
      + `x3 + interleaved + cold process ${childDigest}`
      + `${d12 || d23 ? '' : ', all identical'}`
      + `${seedMatters ? '' : '   (this scenario draws no randomness, so the seed cannot change it)'}`);
    const d = d12 || d23;
    if (d) {
      say(`          first divergence at row ${d.i} (frame ${d.frame})`);
      for (const f of d.fields) say(`            ${f}`);
    }
  }
  return bad === 0;
}

/**
 * Does this scenario ever draw a random number?
 *
 * Most do not: `Fighter#rng` is consulted for the wake-up roll and the victory
 * pose, and `CombatSystem`'s for scatter on a break. A scripted poke touches
 * neither, so its trajectory is IDENTICAL under every seed — which is correct
 * behaviour and must not be reported as a broken seed. Decided by comparing
 * generator states at the end of the run rather than by a list, because a list
 * would go stale the first time a move started rolling for something.
 */
function usesRandomness(name) {
  const r = runScenario(name, SEED);
  const first = r.timeline[0];
  const last = r.timeline[r.timeline.length - 1];
  return first.a.rng !== last.a.rng || first.d.rng !== last.d.rng;
}

// ---------------------------------------------------------------------------
// Save-state fidelity
//
// Measured, not claimed. `saveState` captures the simulation exactly and the
// POSE only approximately (see its doc comment), so the honest thing is to
// print how far a mid-run reload drifts from an uninterrupted run and let the
// reader decide whether that is fit for their purpose.
// ---------------------------------------------------------------------------

function testSaveState(names) {
  for (const name of names) {
    const scn = SCENARIOS[name];
    const cut = Math.floor(scn.frames / 2);

    // Reference: run straight through.
    GT.loadScenario(name, { seed: SEED });
    GT.step(scn.frames);
    const ref = GT.getTimeline()[GT.getTimeline().length - 1];

    // Frame-0 save, reload, replay. This is the repro-bundle case and it must
    // be exact.
    GT.loadScenario(name, { seed: SEED });
    const s0 = GT.saveState();
    GT.step(scn.frames);
    const straight = GT.digest();
    GT.loadState(s0);
    GT.step(scn.frames);
    const reloaded = GT.digest();

    // Mid-run save, reload, finish.
    GT.loadScenario(name, { seed: SEED });
    GT.step(cut);
    const sMid = GT.saveState();
    GT.loadState(sMid);
    GT.step(scn.frames - cut);
    const mid = GT.getTimeline()[GT.getTimeline().length - 1];

    const dPos = Math.hypot(mid.a.x - ref.a.x, mid.a.y - ref.a.y, mid.a.z - ref.a.z);
    const dPose = Math.abs(mid.a.pose - ref.a.pose);
    say(`[simscene] savestate ${name.padEnd(18)} frame-0 reload ${straight === reloaded ? 'EXACT' : 'DIVERGED'}`
      + `   mid-run reload: ${dPos.toFixed(6)} m root, ${dPose.toFixed(4)} pose, `
      + `state ${mid.a.state === ref.a.state ? 'same' : `${mid.a.state} vs ${ref.a.state}`}`);
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(r) {
  const bad = r.invariants.filter((i) => !i.ok);
  say(`[simscene] ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} `
    + `${r.frames} frames in ${r.ms} ms, digest ${r.digest}, `
    + `${r.metrics.hits} hit / ${r.metrics.blocks} block / ${r.metrics.frozenFrames} frozen, `
    + `${r.metrics.damageToDefender} dmg`);
  const show = VERBOSE ? r.invariants : bad;
  for (const i of show) {
    say(`          ${i.ok ? 'ok  ' : 'FAIL'} ${i.id.padEnd(22)} ${String(i.measured).padEnd(46)} `
      + `limit ${i.limit}${i.detail ? `   ${i.detail}` : ''}`);
  }
  if (VERBOSE) {
    say(`          marks: ${Object.entries(r.marks).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    for (const row of compactTimeline(r.timeline)) say(`          ${JSON.stringify(row)}`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const names = ONLY ? ONLY.split(',').filter((n) => SCENARIOS[n]) : Object.keys(SCENARIOS);
if (!names.length) { say(`[simscene] no such scenario. have: ${Object.keys(SCENARIOS).join(', ')}`); process.exit(2); }

if (DIGEST_ONLY) {
  // Cold-process arm of the determinism check. Nothing else runs, nothing is
  // printed but the digest, so the parent can compare it as a plain string.
  const r = runScenario(DIGEST_ONLY, SEED);
  say(r.digest);
  process.exit(0);
}

const km = preflightKeymap();
if (km.length) {
  say(`[simscene] FAIL  pre-flight: PAD in src/core/Scenarios.js disagrees with KEYMAP in src/core/Input.js`);
  for (const b of km) say(`          ${b}`);
  process.exit(1);
}
say(`[simscene] pre-flight: PAD agrees with Input's KEYMAP on all 18 bindings`);
say(`[simscene] ${ROSTER[0].id} vs ${ROSTER[1].id}, seed ${SEED}`);

const results = [];
for (const name of names) {
  const r = runScenario(name);
  results.push(r);
  report(r);
}

let detOk = true;
if (DETERMINISM) {
  say('');
  detOk = testDeterminism(names);
}
if (SAVESTATE) {
  say('');
  testSaveState(names);
}

if (JSON_OUT) {
  const dir = resolvePath(ROOT, JSON_OUT);
  mkdirSync(dir, { recursive: true });
  for (const r of results) {
    writeFileSync(join(dir, `${r.name}.timeline.json`), JSON.stringify(compactTimeline(r.timeline), null, 1));
    writeFileSync(join(dir, `${r.name}.full.json`), JSON.stringify({
      name: r.name, seed: r.seed, digest: r.digest, marks: r.marks,
      metrics: r.metrics, invariants: r.invariants, events: r.events,
      inputLog: r.inputLog, timeline: r.timeline,
    }));
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify({
    seed: SEED, generated: results.length,
    scenarios: results.map((r) => ({
      name: r.name, ok: r.ok, digest: r.digest, marks: r.marks,
      metrics: r.metrics, invariants: r.invariants,
    })),
  }, null, 1));
  say(`[simscene] wrote ${results.length * 2 + 1} json file(s) to ${JSON_OUT}/`);
}

const allOk = results.every((r) => r.ok) && detOk;

if (SHOTS) {
  say('');
  const { captureShots } = await import(pathToFileURL(join(HERE, 'simshots.mjs')));
  await captureShots({ ROOT, results, cells: CELLS, out: SHOT_OUT, seed: SEED, say });
}

say('');
say(`[simscene] ${allOk ? 'GREEN' : 'RED'} — ${results.filter((r) => r.ok).length}/${results.length} scenarios, `
  + `${results.reduce((n, r) => n + r.invariants.length, 0)} invariant checks`);
process.exitCode = allOk ? 0 : 1;
