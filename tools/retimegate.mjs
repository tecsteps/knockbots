/**
 * Knockbots — retime gate.
 *
 *   node tools/retimegate.mjs
 *   node tools/retimegate.mjs --control=unclamped    # the counter-run; RT-1 and RT-2 must go clean
 *   node tools/retimegate.mjs --verbose
 *
 * WHY THIS FILE EXISTS
 *
 * Loading the game prints, and has printed for a while:
 *
 *     [Fighter] 66 move(s) clamped on retime:
 *       airKick wants 1.55x wind-up on k.jumpKick ...
 *
 * The warning says the clip and the frame data disagree by more than the retime
 * is allowed to stretch. What nobody had asked is what the clamp then DOES, and
 * the answer is not "the clip blends out early" — that is what the OUT clamp
 * does. The IN clamp breaks the pin.
 *
 * `retimeClip` (src/characters/Animator.js) is two linear segments:
 *
 *     clock <= pivotAt :  time = clock * inScale
 *     clock >  pivotAt :  time = pivot + (clock - pivotAt) * outScale
 *
 * The two agree at `clock === pivotAt` only when `inScale === pivot / pivotAt`,
 * which is exactly the value the clamp is allowed to overrule. So for every
 * clamped move the map is DISCONTINUOUS at `pivotAt` — and `pivotAt` is
 * `move.startup`, the tick the hitbox appears. The clip is not at its contact
 * pose on the frame the move becomes active; it is short of it (or past it), and
 * then it jumps.
 *
 * WHICH LAYER. RT-1 is L0: pure arithmetic over the retime descriptor the
 * shipping `retimeFor` builds. RT-2 is L2: a real `Fighter`, a real animator, a
 * real `#buildHitboxes`, stepped one tick at a time, measuring where the hitbox
 * actually is in world space. RT-2 is the one that says whether this reaches the
 * game, because the pose the hitboxes are built from is the only thing collision
 * ever sees.
 *
 * WHAT THIS CANNOT CATCH. Whether the pop is visible. That is a frame, and this
 * round is not scoring frames. RT-2 measures metres of hitbox travel, which is a
 * collision fact, not a visual one.
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
const opt = (n, d = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const CONTROL = opt('control', null);
const VERBOSE = flag('verbose');

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
// The counter-run: the same engine with the retime clamp opened right out.
//
// Not a "fix" — opening the clamp reintroduces the smearing it was added to
// prevent. It is the control that proves RT-1 and RT-2 are measuring the CLAMP
// and not some other property of these nineteen moves.
// ---------------------------------------------------------------------------

const THREE_URL = pathToFileURL(join(ROOT, 'node_modules/three/build/three.module.js')).href;
let tempDir = null;
function patchedModuleUrl(relPath, edits, label) {
  const abs = join(SRC, relPath);
  const dir = dirname(abs);
  let src = readFileSync(abs, 'utf8');
  for (const [find, replace] of edits) {
    if (!src.includes(find)) {
      throw new Error(`control "${label}": "${find}" is gone from src/${relPath}. Update tools/retimegate.mjs — `
        + 'a silent no-op here reports a clean counter-run against unchanged code.');
    }
    src = src.split(find).join(replace);
  }
  src = src.replace(/from 'three'/g, `from '${THREE_URL}'`);
  src = src.replace(/from '(\.[^']+)'/g, (_m, rel) => `from '${pathToFileURL(resolvePath(dir, rel)).href}'`);
  tempDir ??= mkdtempSync(join(tmpdir(), 'kb-retimegate-'));
  const out = join(tempDir, `${relPath.replace(/[\\/]/g, '_')}.control.js`);
  writeFileSync(out, src);
  return pathToFileURL(out).href;
}
process.on('exit', () => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

/*
 * A SECOND counter-run: --control=pinned keeps the clamp and restores the pin.
 *
 * The wind-up segment is anchored at its END rather than at time zero, so it
 * lands on the clip's declared contact frame whatever the clamp did to its
 * rate. Where the clamp bites, the cost moves off the impact frame and onto the
 * start of the wind-up: a clip whose wind-up is longer than the move's startup
 * begins a little way in, and one whose wind-up is shorter holds its first pose
 * a moment before winding up. Neither is a discontinuity on the frame the
 * hitbox appears.
 *
 * This gate does NOT apply it to the product. Which of the three available
 * repairs to make — restore the pin, widen the clamp, or re-author the clip
 * contact ticks of the nineteen moves — is an animation call, and this run
 * exists so that call can be made against a measurement rather than an argument.
 */
const PIN_FIND = '  if (clock <= r.pivotAt) return clock * r.inScale;';
const PIN_REPLACE = '  if (clock <= r.pivotAt) return Math.max(0, r.pivot - (r.pivotAt - clock) * r.inScale);  /* CONTROL: pin restored */';

const animatorUrl = CONTROL === 'pinned'
  ? patchedModuleUrl('characters/Animator.js', [[PIN_FIND, PIN_REPLACE]], 'pinned')
  : null;

const fighterUrl = CONTROL === 'unclamped'
  ? patchedModuleUrl('combat/Fighter.js', [
    ['const RETIME_MIN = 0.72;', 'const RETIME_MIN = 1e-4;  /* CONTROL: clamp opened out */'],
    ['const RETIME_MAX = 1.38;', 'const RETIME_MAX = 1e4;   /* CONTROL: clamp opened out */'],
  ], 'unclamped')
  : (CONTROL === 'pinned'
    ? patchedModuleUrl('combat/Fighter.js',
      [["from '../characters/Animator.js'", "from '" + animatorUrl + "'"]], 'pinned')
    : pathToFileURL(join(SRC, 'combat/Fighter.js')).href);

const THREE = await import(THREE_URL);
const { Fighter, retimeFor, clipContactFrame, STATE } = await import(fighterUrl);
const { CombatSystem } = await import(pathToFileURL(join(SRC, 'combat/CombatSystem.js')));
const { MOVES, MOVE_SET_KEYS } = await import(pathToFileURL(join(SRC, 'combat/Moves.js')));
const { CLIPS } = await import(pathToFileURL(join(SRC, 'characters/animations/index.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { METER_MAX, MAX_HEALTH } = await import(pathToFileURL(join(SRC, 'core/Constants.js')));

const results = [];
const say = (s) => console.log(s);
function record(name, ok, detail = '', rows = []) {
  results.push({ name, ok, detail });
  say(`[retime] ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  for (const r of rows) say(`          ${r}`);
}

// ---------------------------------------------------------------------------
// The population: distinct move OBJECTS, not slots.
//
// The 66 in the engine's own warning is a slot count — the same move object
// reached through several move sets is warned about once per set. There are 190
// distinct move objects in the shipped tables and 612 slots.
// ---------------------------------------------------------------------------

const ALL = [];
{
  const seen = new Set();
  for (const key of MOVE_SET_KEYS) {
    for (const mv of MOVES[key]?.__ordered || []) {
      if (seen.has(mv)) continue;
      seen.add(mv);
      ALL.push(mv);
    }
  }
}

// ---------------------------------------------------------------------------
// RT-1 — the wind-up segment must land on the pin
//
// `retimeClip` maps the last wind-up tick to `pivotAt * inScale` and the first
// post-pivot tick to `pivot + outScale`. If the first of those is not `pivot`,
// the two segments do not meet and the move's first ACTIVE frame is played at
// the wrong point in its own clip.
// ---------------------------------------------------------------------------

const RT1 = [];
for (const mv of ALL) {
  const r = retimeFor(mv);
  if (!r) continue;
  const atPivot = r.pivotAt * r.inScale;
  const gap = r.pivot - atPivot;               // >0: clip is BEHIND its contact pose
  if (Math.abs(gap) < 1e-9) continue;
  const jump = (r.pivot + r.outScale) - atPivot;
  RT1.push({
    id: mv.id, clip: mv.clip, startup: mv.startup, pivot: r.pivot,
    want: r.pivot / r.pivotAt, inScale: r.inScale, gap, jump, step: r.outScale,
    ratio: r.outScale > 1e-9 ? jump / r.outScale : Infinity,
  });
}
RT1.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

// How many SLOTS those objects occupy, so the number lines up with the engine's
// own warning rather than quietly disagreeing with it.
let rt1Slots = 0;
{
  const badSet = new Set(RT1.map((r) => r.id + ' ' + r.clip));
  for (const key of MOVE_SET_KEYS) {
    for (const mv of MOVES[key]?.__ordered || []) {
      if (badSet.has(mv.id + ' ' + mv.clip)) rt1Slots++;
    }
  }
}

record('RT-1  the retime wind-up lands on the clip\'s declared contact frame', RT1.length === 0,
  `${RT1.length} of ${ALL.length} distinct moves break the pin (${rt1Slots} slots)`,
  RT1.slice(0, VERBOSE ? 40 : 8).map((r) =>
    `${(`${r.id} / ${r.clip}`).padEnd(30)} startup ${String(r.startup).padStart(2)}  wants ${r.want.toFixed(2)}x  `
    + `clamped ${r.inScale.toFixed(2)}x  ->  on its first ACTIVE frame the clip is `
    + `${r.gap > 0 ? `${r.gap.toFixed(2)} frames SHORT of contact` : `${(-r.gap).toFixed(2)} frames PAST contact`}, `
    + `then moves ${r.jump.toFixed(2)} clip-frames in one tick against a normal step of ${r.step.toFixed(2)}`));

// ---------------------------------------------------------------------------
// RT-2 — does it reach the hitboxes?
//
// Driven through a real `Fighter`: `startMove`, then one `simulate(null)` per
// tick, recording the world midpoint of the move's hitboxes on every tick they
// exist. The pose those boxes are built from is the retimed one, so if the clip
// jumps at the pivot the boxes jump with it.
//
// The measurement is the ratio of the FIRST live step (the box's position on the
// frame it appears against its position one frame later) to the MEDIAN live step
// of the same move. A move whose limb is simply travelling fast has a large
// median too; a move whose clip teleports at the pivot does not.
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const f0 = new Fighter({ index: 0, def: ROSTER[0], scene, environment: null });
const f1 = new Fighter({ index: 1, def: ROSTER[1], scene, environment: null });
await f0.init();
await f1.init();
f0.setOpponent(f1);
f1.setOpponent(f0);
const combat = new CombatSystem([f0, f1], null);

function stage(dist = 3.0) {
  f0.reset(new THREE.Vector3(-dist * 0.5, f0.floorY, 0), 1);
  f1.reset(new THREE.Vector3(dist * 0.5, f1.floorY, 0), -1);
  f0.health = MAX_HEALTH * 100; f1.health = MAX_HEALTH * 100;
  f0.meter = METER_MAX;
}

/**
 * Where the move's striking limb is, in the fighter's own frame, every tick.
 *
 * `#trackMoveBones` runs on EVERY tick of a move, not only the active ones —
 * deliberately, so the first active frame sweeps correctly — so `boneTrack` is
 * a complete per-tick trajectory of the limb that delivers the blow, taken from
 * the bone's real `matrixWorld` after the retime, the extracted root yaw, the
 * aim solve and the foot IK have all been applied. That is the only honest
 * source: `docs/PROFILING.md` records an offline rig sample that reported
 * `k.midKick` overlapping the defender by 14 cm while the shipping game whiffed
 * it at every range, because it rebuilt the pose outside the Fighter.
 */
const _p = new THREE.Vector3();
function limbPoint(f, bone) {
  const rec = f.boneTrack?.[bone];
  if (!rec || !rec.valid) return null;
  return _p.copy(rec.cur).sub(f.position).clone();
}

/** Step one move to completion out of contact range; return the limb trajectory. */
function sweep(mv) {
  stage();
  const bone = mv.active[0].boxes[0]?.bone;
  if (!bone) return { short: true };
  f0.startMove(mv);
  if (f0.currentMove !== mv) return { notStarted: true };
  const pts = [];
  const caps = [];
  for (let k = 0; k <= mv.total + 1; k++) {
    f0.simulate(null);
    f1.simulate(null);
    combat.simulate(k);
    if (f0.currentMove !== mv) break;
    const p = limbPoint(f0, bone);
    if (p) pts.push({ tick: f0.moveTick, p });
    const hb = f0.hitboxes.find((h) => h.bone === bone) || f0.hitboxes[0];
    if (hb) caps.push({ tick: f0.moveTick, len: hb.p0.distanceTo(hb.p1) });
  }
  if (pts.length < 6) return { short: true, live: pts.length };
  const steps = [];                     // steps[i].d is the travel INTO steps[i].tick
  for (let i = 1; i < pts.length; i++) steps.push({ tick: pts[i].tick, d: pts[i].p.distanceTo(pts[i - 1].p) });
  return { steps, caps, bone };
}

/*
 * THE STATISTIC, AND WHY IT IS THIS ONE.
 *
 * A broken pin puts a whole clip-frame jump into ONE tick, and the arithmetic
 * says exactly which tick: the one after pivotAt, i.e. startup + 1 -- the tick
 * after the hitbox turned on. So the prediction is not "these moves move a
 * lot", it is "these moves take their single largest limb step at one specific
 * tick", and that location is derived from retimeClip rather than tuned to the
 * data.
 *
 * An earlier version of this test compared the first live step against the
 * move's median step and thresholded on the clean population's 95th percentile.
 * It reported the clean population's own worst case at 52x that ceiling -- a
 * stable, reproducible number about "some limbs accelerate hard", which is not
 * the event it was labelled with. That instrument was discarded, not tuned.
 */
const affected = new Set(RT1.map((r) => r.id + ' ' + r.clip));
// Warm-up: the first move stepped in a process settles the animator, and a
// first-run outlier read as a finding is the failure mode simgate's first-run
// rule exists for.
sweep(ALL.find((m) => retimeFor(m) && !m.props?.throw) || ALL[0]);

const rows = [];
for (const mv of ALL) {
  if (!retimeFor(mv)) continue;
  if (mv.props?.throw) continue;               // grabs never resolve down the strike path
  const s = sweep(mv);
  if (s.notStarted || s.short) continue;
  let peak = s.steps[0];
  for (const st of s.steps) if (st.d > peak.d) peak = st;
  const sorted = s.steps.map((x) => x.d).sort((a, b) => a - b);
  rows.push({
    id: mv.id, clip: mv.clip, startup: mv.startup,
    hit: affected.has(mv.id + ' ' + mv.clip),
    peakTick: peak.tick, peakD: peak.d, median: sorted[sorted.length >> 1],
    atPin: peak.tick === mv.startup + 1,
    caps: s.caps,
  });
}

const hitRows = rows.filter((r) => r.hit);
const okRows = rows.filter((r) => !r.hit);
const rate = (rs) => (rs.length ? rs.filter((r) => r.atPin).length / rs.length : 0);
const hitRate = rate(hitRows);
const okRate = rate(okRows);
const offenders = hitRows.filter((r) => r.atPin).sort((a, b) => b.peakD / b.median - a.peakD / a.median);

record('RT-2  the limb does not jump on the tick after the hitbox appears', offenders.length === 0,
  `${rows.length} moves swept through the real Fighter; `
  + `broken-pin moves take their largest single-tick limb step one tick past the pin in `
  + `${hitRows.filter((r) => r.atPin).length}/${hitRows.length} cases (${(hitRate * 100).toFixed(0)}%), `
  + `intact-pin moves in ${okRows.filter((r) => r.atPin).length}/${okRows.length} (${(okRate * 100).toFixed(0)}%)`,
  offenders.slice(0, VERBOSE ? 40 : 8).map((r) =>
    `${(`${r.id} / ${r.clip}`).padEnd(30)} startup ${String(r.startup).padStart(2)}: the striking limb travels `
    + `${(r.peakD * 100).toFixed(1)} cm on move-tick ${r.peakTick} - ${(r.peakD / r.median).toFixed(1)}x its own median `
    + 'tick, and the largest step in the whole move'));

// RT-2 null control -- the intact population must NOT share the pattern. If
// "largest step one tick past the pin" were simply where strikes accelerate,
// both rates would be alike and the statistic would be measuring nothing.
// The null control asserts only that the intact population does NOT show the
// pattern. It deliberately does not also assert that the broken population
// does: a control whose pass depends on the defect being present cannot be run
// against a repaired build, and a control that cannot be run against a repaired
// build cannot tell a repair from a broken instrument.
record('RT-2n null control - intact-pin moves do not share the pattern', okRate < 0.25,
  `intact ${(okRate * 100).toFixed(0)}% (${okRows.filter((r) => r.atPin).length}/${okRows.length}) `
  + `vs broken ${(hitRate * 100).toFixed(0)}% (${hitRows.filter((r) => r.atPin).length}/${hitRows.length})`);

// ---------------------------------------------------------------------------
// RT-3 - what the collision system is handed
//
// `#buildHitboxes` sweeps the capsule back to where the anchor was LAST tick:
//
//     _v3.copy(_v).sub(rec.cur).add(rec.prev);  hb.p0 = _v3;  hb.p1 = tip;
//
// That is correct and necessary -- a fist crossing 30 cm in a tick would tunnel
// straight through a defender without it. But it means the capsule handed to
// `segSegDistSq` is exactly as long as the limb travelled, so a clip-time jump
// at the pin does not merely mis-pose the strike: it inflates the hitbox itself,
// for one tick, by the size of the jump.
//
// This is the number that decides whether RT-1 and RT-2 are a presentation
// finding or a gameplay one. Metres of capsule, on the real boxes the real
// `CombatSystem` would have intersected.
// ---------------------------------------------------------------------------

{
  const capRows = [];
  for (const r of rows) {
    if (!r.caps || r.caps.length < 2) continue;
    let peak = r.caps[0];
    for (const c of r.caps) if (c.len > peak.len) peak = c;
    const sorted = r.caps.map((c) => c.len).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    capRows.push({ ...r, capPeak: peak.len, capPeakTick: peak.tick, capMedian: median });
  }
  const blown = capRows
    .filter((r) => r.hit && r.capPeakTick === r.startup + 1 && r.capPeak > r.capMedian * 2 && r.capPeak > 0.4)
    .sort((a, b) => b.capPeak - a.capPeak);
  const cleanBlown = capRows
    .filter((r) => !r.hit && r.capPeakTick === r.startup + 1 && r.capPeak > r.capMedian * 2 && r.capPeak > 0.4);

  record('RT-3  the swept hitbox is not inflated by the pin break', blown.length === 0,
    `${capRows.length} moves; ${blown.length} broken-pin moves hand the collision system a capsule `
    + `over twice their own median length on the tick after the box appears, against ${cleanBlown.length} intact-pin moves`,
    blown.slice(0, VERBOSE ? 40 : 8).map((r) =>
      `${(`${r.id} / ${r.clip}`).padEnd(30)} swept capsule ${(r.capPeak * 100).toFixed(0)} cm on move-tick ${r.capPeakTick} `
      + `against ${(r.capMedian * 100).toFixed(0)} cm median for the same move`));

  record('RT-3n null control - intact-pin moves are not inflated at the same tick',
    cleanBlown.length === 0 || cleanBlown.length * 4 < blown.length,
    `${cleanBlown.length} intact-pin moves inflated at startup+1 vs ${blown.length} broken-pin`);
}

// ---------------------------------------------------------------------------

const bad = results.filter((r) => !r.ok);
say('');
if (CONTROL) {
  // RT-1 is a statement about the DESCRIPTOR `retimeFor` builds — that nineteen
  // moves have their wind-up rate overruled by the clamp. `--control=pinned`
  // repairs the MAP in `retimeClip` and leaves the descriptor exactly as it was,
  // so RT-1 is expected to stay red there and its staying red is not an
  // incomplete repair. `--control=unclamped` removes the clamp itself, so RT-1
  // goes green with everything else.
  const expectRed = CONTROL === 'pinned' ? ['RT-1'] : [];
  const unexpected = bad.filter((r) => !expectRed.includes(r.name.split(/\s+/)[0]));
  const what = CONTROL === 'unclamped' ? 'clamp opened right out' : 'clamp kept, wind-up anchored on the pin';
  say(`[retime] COUNTER-RUN (${CONTROL} — ${what}): ${unexpected.length === 0
    ? `CLEAN${expectRed.length ? ` (RT-1 red as expected: the descriptor is untouched by this repair)` : ' on every assertion'}`
    : `STILL ${unexpected.length} failing (${unexpected.map((r) => r.name.split(/\s+/)[0]).join(', ')})`}`);
  process.exit(0);
}
say(`[retime] ${bad.length ? `RED — ${bad.length} failing` : 'GREEN'}`);
process.exit(bad.length ? 1 : 0);
