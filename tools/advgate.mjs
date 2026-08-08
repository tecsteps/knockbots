/**
 * Knockbots — the advantage gate (AD-1 … AD-6).
 *
 * WHY THIS EXISTS
 *
 * `fdgate` proved that the engine is self-consistent: the advantage it produces
 * is always `blockStun - (total - contactTick)`, exactly, on every move at every
 * range. What it also proved is that this is NOT the number the move list
 * prints. `defineMove` derives the printed advantage from the END of the active
 * window —
 *
 *     recovery = total - lastActive - 1
 *     onBlock  = blockStun - recovery
 *
 * — while the engine charged the attacker recovery from the tick a capsule
 * happened to overlap, which is `contactTick <= lastActive`. The difference is
 * `lastActive + 1 - contactTick`, which is >= 1 identically: every blockable
 * move in the game was less safe than its own printed number, by its own active
 * span at point blank. `jab` printed +1 and played -1.
 *
 * The owner's decision was that the engine is wrong and the printed frame data
 * is the promise. `Fighter#beginRecovery` is that decision, and THIS FILE IS THE
 * ACCEPTANCE TEST FOR IT: it measures on-block and on-hit advantage end to end
 * through the real `Fighter` and the real `CombatSystem`, and asserts that the
 * integer the simulation produces is the integer the move list prints — for
 * every blockable move, at four ranges.
 *
 * WHAT IT MEASURES
 *
 *   AD-1  on-block:  measured advantage == printed `onBlock`, all ranges
 *   AD-2  on-hit:    measured advantage == printed `onHit`, all ranges, for the
 *                    reactions where hitstun is what governs (flinch/stagger/
 *                    crumple). A launch or a knockdown puts the defender on a
 *                    different clock and `onHit` is not a claim about it.
 *   AD-3  a multi-window move still lands every one of its windows — the hazard
 *         of this change, and the reason it is not implemented as "a connection
 *         consumes the rest of the active window"
 *   AD-4  a WHIFF is untouched: a move nobody blocks still recovers on `total`
 *   AD-5  a move ducked by a crouching defender recovers on the whiff schedule —
 *         a blow that did not land does not shorten anything
 *   AD-6  null control — the same cell twice is the same integer, and the same
 *         numbers with the two fighters swapped
 *
 * THE POSITIVE CONTROL IS THE "BEFORE"
 *
 *   node tools/advgate.mjs --control=no-truncate
 *
 * patches `beginRecovery`'s single arithmetic line back to a no-op as the module
 * loads, which is exactly the engine as it was before this change. AD-1 and AD-2
 * must go RED under it — and they go red for the WHOLE population, not for a
 * handful — while AD-3, AD-4, AD-5 and AD-6 must stay green. That is the
 * before/after, permanently reproducible from the repository, rather than a
 * table someone pasted into a report once.
 *
 * NO BROWSER, NO GL, NO INSTALL. The DOM shim and the two-fighter rig are
 * `tools/fdgate.mjs`'s, deliberately: a second rig that drifted would make the
 * two gates disagree about what "a blocked jab" is.
 *
 * USAGE
 *   node tools/advgate.mjs                    the whole gate
 *   node tools/advgate.mjs --control=no-truncate    the engine as it was
 *   node tools/advgate.mjs --verbose          every deviating row, not the first 24
 *   node tools/advgate.mjs --table            the full per-move ledger
 *   node tools/advgate.mjs --sets=vulkan      one move set
 *
 * Exit code is 0 only when every test passed. Under `--control` the meaning is
 * inverted: 0 means the control behaved the way this header says it must.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

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
const TABLE = flag('table');
const SETS_ARG = opt('sets', 'roster');
const CONTROL = opt('control', null);

// ---------------------------------------------------------------------------
// The control
//
// One named, minimal, revertible change to the PRODUCT, applied to the module
// text as it loads so nothing in the repository is ever written. The string it
// looks for is asserted present before it is substituted: a control that had
// silently become a no-op would report a green control against healthy code,
// which is worse than having no control at all.
// ---------------------------------------------------------------------------

const CONTROLS = {
  'no-truncate': {
    why: 'beginRecovery stops setting the end tick — the engine exactly as it was '
      + 'before this change, charging recovery from the tick the capsules overlapped',
    file: 'combat/Fighter.js',
    find: '    this.moveEndTick = Math.max(this.moveTick + mv.recovery, floor);',
    repl: '    void floor; /* POSITIVE CONTROL: recovery is charged from contact again */',
    red: ['AD-1', 'AD-2'],
    green: ['AD-3', 'AD-4', 'AD-5', 'AD-6a', 'AD-6b'],
  },
};

if (CONTROL && !CONTROLS[CONTROL]) {
  console.error(`[advgate] unknown control "${CONTROL}". Known: ${Object.keys(CONTROLS).join(', ')}`);
  process.exit(2);
}
const CTL = CONTROL ? CONTROLS[CONTROL] : null;

if (CTL?.file) {
  const target = join(SRC, CTL.file);
  const original = readFileSync(target, 'utf8');
  if (!original.includes(CTL.find)) {
    console.error(`[advgate] control "${CONTROL}" cannot find its anchor in src/${CTL.file}:`);
    console.error(`          ${CTL.find}`);
    console.error('          A silent no-op here would report a green control against healthy code.');
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
// DOM shim — tools/check.mjs's, as simgate, dtgate and fdgate all carry it.
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

// `Fighter` warns once per process about clamped retimes; that is a known,
// separately gated finding (tools/retimegate.mjs RT-1) and it is noise here.
const _warn = console.warn;
console.warn = (...a) => { if (!String(a[0] ?? '').startsWith('[Fighter]')) _warn(...a); };

// ---------------------------------------------------------------------------
// Imports — after the shim and after the hook, in that order.
// ---------------------------------------------------------------------------

const THREE = await import(join(ROOT, 'node_modules/three/build/three.module.js'));
const { Fighter, STATE } = await import(pathToFileURL(join(SRC, 'combat/Fighter.js')));
const { CombatSystem } = await import(pathToFileURL(join(SRC, 'combat/CombatSystem.js')));
const { MOVES } = await import(pathToFileURL(join(SRC, 'combat/Moves.js')));
const { ROSTER } = await import(pathToFileURL(join(SRC, 'characters/roster.js')));
const { bus } = await import(pathToFileURL(join(SRC, 'core/Bus.js')));
const { METER_MAX, MAX_HEALTH, HEIGHT, REACTION } =
  await import(pathToFileURL(join(SRC, 'core/Constants.js')));

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
function record(id, name, ok, detail = '', rows = []) {
  results.push({ id, name, ok, detail });
  console.log(`[advgate] ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  —  ${detail}` : ''}`);
  for (const r of rows) console.log(`          ${r}`);
  return ok;
}
function note(id, name, detail, rows = []) {
  console.log(`[advgate] NOTE  ${id}  ${name}  —  ${detail}`);
  for (const r of rows) console.log(`          ${r}`);
}
const cap = (rows, n = 24) => (VERBOSE || rows.length <= n ? rows
  : [...rows.slice(0, n), `… and ${rows.length - n} more (--verbose for all)`]);
const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
/** A histogram of integers, printed smallest first. This is the before/after. */
function histLine(hist) {
  return Object.keys(hist).map(Number).sort((a, b) => a - b)
    .map((d) => `${sign(d)}:${hist[d]}`).join('  ') || '(empty)';
}

// ---------------------------------------------------------------------------
// The population
// ---------------------------------------------------------------------------

const SET_KEYS = SETS_ARG === 'all' ? Object.keys(MOVES)
  : SETS_ARG === 'roster' ? [...new Set(ROSTER.map((r) => r.moveSet).filter((k) => MOVES[k]))]
    : SETS_ARG.split(',').filter((k) => MOVES[k]);

const POP = [];
for (const key of SET_KEYS) for (const mv of MOVES[key].__ordered) POP.push({ key, mv });

const isBlockable = (mv) => mv.height !== HEIGHT.UNBLOCKABLE && !mv.props.throw && !mv.props.finisher;
const lastActive = (mv) => Math.max(...mv.active.map((a) => a.to));
const activeSpan = (mv) => lastActive(mv) - Math.min(...mv.active.map((a) => a.from)) + 1;
/** The stance a defender must hold for this attack to be blocked at all. */
const guardFor = (mv) => (mv.height === HEIGHT.LOW ? 'crouch' : 'stand');
/**
 * The reactions for which `onHit` is a claim about anything.
 *
 * `hitStun` is the number of ticks the defender spends in HITSTUN, and HITSTUN
 * is only where a flinch, a stagger or a crumple goes. A launcher's victim is in
 * LAUNCHED and comes down on gravity's schedule; a knockdown's gets up on
 * `stunTicks = 22` plus a wake-up clip. Asserting `onHit` over those would be
 * asserting that `defineMove`'s subtraction describes a physics integration,
 * which nobody has ever claimed.
 */
const STUN_REACTIONS = new Set([
  REACTION.FLINCH_HIGH, REACTION.FLINCH_MID, REACTION.FLINCH_LOW,
  REACTION.CRUMPLE, REACTION.STAGGER,
]);

// ---------------------------------------------------------------------------
// The rig — fdgate's, field for field. See its header for why `stage` calls the
// product's own `reset()` instead of listing the fields it means to move.
// ---------------------------------------------------------------------------

const scene = new THREE.Scene();
const f0 = new Fighter({ index: 0, def: ROSTER[0], scene, environment: null });
const f1 = new Fighter({ index: 1, def: ROSTER[1], scene, environment: null });
await f0.init();
await f1.init();
f0.setOpponent(f1);
f1.setOpponent(f0);
const combat = new CombatSystem([f0, f1], null);
const _pos = new THREE.Vector3();

function stage(a, d, dist) {
  const s = a.index === 0 ? -1 : 1;
  _pos.set(s * dist * 0.5, 0, 0);
  a.reset(_pos, -s);
  _pos.set(-s * dist * 0.5, 0, 0);
  d.reset(_pos, s);
  for (const f of [a, d]) {
    f.animator?.play('idle.fight', { blend: 0, loop: true });
    f.moveInstance++;
    f.connected.clear();
    f.hitConnectedThisMove = false;
    for (const n of Object.keys(f.boneTrack)) f.boneTrack[n].valid = false;
  }
  a.health = MAX_HEALTH * 100;
  d.health = MAX_HEALTH * 100;
  a.meter = METER_MAX;
  d.meter = METER_MAX;
  combat.roundOver = false;
  for (const c of combat.combos) { c.hits = 0; c.damage = 0; c.lastTick = -999; }
}

function withSet(f, key, fn) {
  const wasT = f.moveTable;
  const wasK = f.moveSetKey;
  f.moveTable = MOVES[key];
  f.moveSetKey = key;
  try { return fn(); } finally { f.moveTable = wasT; f.moveSetKey = wasK; }
}

/** A Command built in code, behaviourally identical to `TestHarness#mkCmd`. */
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

const DEF_CMD = {
  stand: () => mkCmd('', [], true),
  crouch: () => mkCmd('d', [], true),
  standNoGuard: () => mkCmd('', [], false),
  crouchNoGuard: () => mkCmd('d', [], false),
  none: () => null,
};

/**
 * The states in which a fighter may act. Everything not in this set is a state
 * the fighter is LOCKED in, and being wrong about one entry would move every
 * number in this file by the same amount while looking perfectly stable.
 */
const ACTIONABLE = new Set([
  STATE.IDLE, STATE.WALK, STATE.CROUCH, STATE.BLOCK_HIGH, STATE.BLOCK_LOW,
  STATE.DASH, STATE.BACKDASH, STATE.SIDESTEP,
  STATE.JUMP_RISE, STATE.JUMP_APEX, STATE.JUMP_FALL,
]);

// ---------------------------------------------------------------------------
// The bus recorder — every row carries the event that produced it, so a row
// labelled "blocked" that was actually made by a `hit` is reported as a harness
// failure and never as a data result.
// ---------------------------------------------------------------------------

function recorder() {
  const ev = [];
  let tick = 0;
  const on = (kind) => bus.on(kind, (e) => ev.push({
    kind,
    tick,
    attacker: e.attacker?.index ?? null,
    fighter: e.fighter?.index ?? null,
    move: e.move?.id ?? null,
    moveTick: (e.attacker ?? e.fighter)?.moveTick ?? null,
  }));
  const offs = ['hit', 'block', 'whiff'].map(on);
  return {
    ev,
    at(t) { tick = t; },
    clear() { ev.length = 0; },
    dispose() { for (const o of offs) o?.(); },
  };
}

// ---------------------------------------------------------------------------
// The probe
//
// One attacker move against one defender plan at one distance, driven through
// the real `Fighter` and the real `CombatSystem`, and run until BOTH fighters
// are actionable again. The advantage is the difference between those two
// ticks, measured, never modelled.
// ---------------------------------------------------------------------------

function probe({ key, mv, dist, plan = 'none', limit = 400 }) {
  const rec = recorder();
  let tick = 0;
  const row = {
    key, id: mv.id, input: mv.input, dist, plan,
    started: false, staged: true, air: !!mv.props.requireAir,
    contactTick: -1, lastContactTick: -1, lastContactAt: -1,
    event: null, hits: 0, windows: new Set(), dStateAfter: null, whiffs: 0,
    aFree: -1, dFree: -1, adv: null, endTick: null, otherMove: null,
  };
  try {
    return withSet(f0, key, () => {
      stage(f0, f1, dist);
      const dcmd = DEF_CMD[plan]();
      // The defender's guard has to be UP before the attack starts, and both
      // fighters need a tick of history so the swept hitbox test has a previous
      // bone position to sweep back from.
      for (let i = 0; i < 5; i++) {
        rec.at(tick); f0.simulate(null); f1.simulate(dcmd); combat.simulate(tick); tick++;
      }
      // An air move needs a real jump: a probe that forces one from the ground
      // measures a pose no player can produce.
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
      rec.clear();

      // Start the move from a synthetic Command so `#startMove` runs INSIDE
      // `simulate` and moveTick 0 is a tick the hitbox builder has seen.
      rec.at(tick);
      f0.simulate(mkCmd(mv.parsed.dir, mv.parsed.buttons, false, mv.parsed.motion));
      f1.simulate(dcmd);
      combat.simulate(tick);
      row.started = f0.currentMove?.id === mv.id;
      if (!row.started) { row.otherMove = f0.currentMove?.id ?? null; return row; }
      const instance = f0.moveInstance;
      const startedAt = tick;
      tick++;

      for (let i = 1; i < limit; i++) {
        rec.at(tick);
        const before = rec.ev.length;
        f0.simulate(null);
        f1.simulate(dcmd);
        combat.simulate(tick);
        if (f0.currentMove === mv && f0.moveInstance === instance && f0.moveEndTick != null) {
          row.endTick = f0.moveEndTick;
        }
        for (let e = before; e < rec.ev.length; e++) {
          const x = rec.ev[e];
          // The whiff beat moved when the move's end tick became truncatable;
          // AD-4 counts it so a restructure that fired it twice, or not at all,
          // cannot pass as a frame-data result.
          if (x.kind === 'whiff' && x.fighter === 0 && x.move === mv.id
            && f0.moveInstance === instance) { row.whiffs++; continue; }
          if ((x.kind !== 'hit' && x.kind !== 'block') || x.attacker !== 0) continue;
          if (x.move !== mv.id || f0.moveInstance !== instance) continue;
          if (row.contactTick < 0) { row.contactTick = x.moveTick; row.event = x.kind; }
          row.lastContactTick = x.moveTick;
          row.lastContactAt = tick;
          row.windows.add(mv.active.findIndex((w) => x.moveTick >= w.from && x.moveTick <= w.to));
          row.hits++;
        }
        // The advantage clock starts at the LAST connection: a multi-window move
        // that catches the defender twice has refreshed their stun, and a number
        // read off the first window would be about an event that was superseded.
        if (row.lastContactAt >= 0) {
          if (tick === row.lastContactAt) row.dStateAfter = f1.state;
          if (tick > row.lastContactAt) {
            if (row.aFree < 0 && ACTIONABLE.has(f0.state)) row.aFree = tick;
            if (row.dFree < 0 && ACTIONABLE.has(f1.state)) row.dFree = tick;
          } else { row.aFree = -1; row.dFree = -1; }
        } else if (f0.currentMove == null && row.aFree < 0 && ACTIONABLE.has(f0.state)) {
          // A whiff: AD-4 wants the tick the attacker came back with nobody hit.
          row.aFree = tick;
        }
        tick++;
        if (row.lastContactAt >= 0 && row.aFree >= 0 && row.dFree >= 0) break;
        if (row.lastContactAt < 0 && row.aFree >= 0) break;
      }
      row.startedAt = startedAt;
      if (row.aFree >= 0 && row.dFree >= 0 && row.lastContactAt >= 0) row.adv = row.dFree - row.aFree;
      // Ticks from the move's first tick until the attacker was free again.
      if (row.aFree >= 0) row.life = row.aFree - startedAt;
      return row;
    });
  } finally {
    rec.dispose();
  }
}

/** A row that never staged or never started is not a result. */
const usable = (r) => r && r.staged && r.started;

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * The four ranges. Point blank first, because that is where the deficit this
 * change removed was largest, and 1.5m last, because that is the edge of most
 * of the roster's reach. `--dist=` overrides them for one-off investigation.
 */
const DISTANCES = (opt('dist', null)?.split(',').map(Number).filter((n) => n > 0)) || [0.9, 1.02, 1.2, 1.5];

const t0 = Date.now();
const blockCells = [];
const hitCells = [];
for (const { key, mv } of POP) {
  if (!isBlockable(mv)) continue;
  for (const dist of DISTANCES) {
    blockCells.push(probe({ key, mv, dist, plan: guardFor(mv) }));
    // The same move against a defender who is NOT guarding. A low against a
    // standing opponent and a mid against a crouching one both hit, so the plan
    // is the inverse of the one that blocks.
    const hitPlan = mv.height === HEIGHT.LOW ? 'standNoGuard' : 'crouchNoGuard';
    hitCells.push(probe({ key, mv, dist, plan: hitPlan }));
  }
}

// Staging column. RG-8: a move that did not start is not a result, and it is
// reported here rather than being quietly dropped from a denominator.
{
  const notStarted = new Set();
  const notStaged = new Set();
  for (const r of [...blockCells, ...hitCells]) {
    if (!r.staged) notStaged.add(`${r.key}/${r.id}`);
    else if (!r.started) notStarted.add(`${r.key}/${r.id} [${r.input}] started ${r.otherMove ?? 'nothing'} instead`);
  }
  record('AD-0', 'staging — every measured row is a move that actually started',
    notStarted.size === 0 && notStaged.size === 0,
    `${blockCells.length + hitCells.length} probes over ${SET_KEYS.length} sets; `
    + `${notStarted.size} moves did not start, ${notStaged.size} air moves never left the ground`,
    cap([...notStarted, ...[...notStaged].map((s) => `${s} never left the ground`)]));
}

// ---------------------------------------------------------------------------
// AD-1 — on-block advantage is the printed number
// ---------------------------------------------------------------------------

{
  const rows = blockCells.filter((r) => usable(r) && r.event === 'block' && r.adv != null);
  const ground = rows.filter((r) => !r.air);
  const air = rows.filter((r) => r.air);
  const bad = [];
  const hist = {};
  const perDist = {};
  const moves = new Set();
  for (const r of ground) {
    const mv = MOVES[r.key][r.id];
    const delta = r.adv - mv.onBlock;
    hist[delta] = (hist[delta] || 0) + 1;
    perDist[r.dist] = perDist[r.dist] || { n: 0, ok: 0 };
    perDist[r.dist].n++;
    if (delta === 0) perDist[r.dist].ok++;
    moves.add(`${r.key}/${r.id}`);
    if (delta !== 0) {
      bad.push(`${r.key}/${r.id} [${mv.input}] @${r.dist}m prints ${sign(mv.onBlock)} `
        + `but measures ${sign(r.adv)} (${sign(delta)}) — contact=${r.lastContactTick} `
        + `lastActive=${lastActive(mv)} total=${mv.total} recovery=${mv.recovery} endTick=${r.endTick}`);
    }
  }
  const distLine = DISTANCES.map((d) => `${d}m ${perDist[d]?.ok ?? 0}/${perDist[d]?.n ?? 0}`).join('  ');
  record('AD-1', 'measured on-block advantage == the printed onBlock',
    bad.length === 0 && ground.length > 0,
    `${moves.size} blockable moves, ${ground.length} block rows over ${DISTANCES.length} ranges: ${distLine}; `
    + `${bad.length} deviate. measured-minus-printed histogram: ${histLine(hist)}`,
    cap(bad));

  // Air moves are their own row and are NOT asserted. An airborne attacker can
  // leave ATTACK by LANDING as well as by the move's own clock, so `recovery` is
  // not what governs them and a red row here would be a claim nobody has made.
  const airHist = {};
  for (const r of air) airHist[r.adv - MOVES[r.key][r.id].onBlock] = (airHist[r.adv - MOVES[r.key][r.id].onBlock] || 0) + 1;
  if (air.length) {
    note('AD-1air', 'air moves, staged airborne by a real jump, are measured but not asserted',
      `${air.length} rows; measured-minus-printed histogram: ${histLine(airHist)}`
      + ' — an airborne attacker can leave ATTACK by landing, which is not a claim onBlock makes');
  }
}

// ---------------------------------------------------------------------------
// AD-2 — on-hit advantage is the printed number
// ---------------------------------------------------------------------------

{
  const rows = hitCells.filter((r) => usable(r) && r.event === 'hit' && r.adv != null && !r.air);
  const bad = [];
  const hist = {};
  const moves = new Set();
  let skipped = 0;
  for (const r of rows) {
    const mv = MOVES[r.key][r.id];
    // Only the reactions hitstun actually governs; see STUN_REACTIONS. The
    // authored reaction is not enough on its own — `applyHit` sends a defender
    // with upward knockback into the air whatever the reaction says — so the row
    // also has to show the defender actually standing in HITSTUN.
    if (!STUN_REACTIONS.has(mv.reaction) || r.dStateAfter !== STATE.HITSTUN) { skipped++; continue; }
    const delta = r.adv - mv.onHit;
    hist[delta] = (hist[delta] || 0) + 1;
    moves.add(`${r.key}/${r.id}`);
    if (delta !== 0) {
      bad.push(`${r.key}/${r.id} [${mv.input}] @${r.dist}m prints ${sign(mv.onHit)} `
        + `but measures ${sign(r.adv)} (${sign(delta)}) — contact=${r.lastContactTick} `
        + `hitStun=${mv.hitStun} recovery=${mv.recovery} endTick=${r.endTick}`);
    }
  }
  record('AD-2', 'measured on-hit advantage == the printed onHit',
    bad.length === 0 && rows.length - skipped > 0,
    `${moves.size} moves, ${rows.length - skipped} stun-reaction hit rows over ${DISTANCES.length} ranges; `
    + `${bad.length} deviate (${skipped} launch/knockdown rows are on a different clock). `
    + `measured-minus-printed histogram: ${histLine(hist)}`,
    cap(bad));
}

// ---------------------------------------------------------------------------
// AD-3 — a multi-window move still lands every window
//
// THIS IS THE HAZARD OF THE WHOLE CHANGE, and the reason `beginRecovery` is not
// the obvious implementation. "A connection consumes the rest of the active
// window" — advance the attacker to `lastActive + 1` on contact — makes the
// printed identity true by construction and DELETES every later window of a
// multi-hit move: `pistonRush` would land its first hit and lose the other two.
// So instead the end tick is floored at the last tick of every window that has
// not yet connected, and this row is what proves the floor is doing its job.
// ---------------------------------------------------------------------------

{
  const multi = [];
  for (const { key, mv } of POP) if (isBlockable(mv) && mv.active.length > 1) multi.push({ key, mv });
  const bad = [];
  const rows = [];
  for (const { key, mv } of multi) {
    // Point blank, where every window is inside the defender. A window that does
    // not reach at 1.5m is a range fact, not a truncation fact.
    const r = probe({ key, mv, dist: DISTANCES[0], plan: guardFor(mv) });
    if (!usable(r) || r.event == null) continue;
    rows.push(`${key}/${mv.id} ${r.windows.size}/${mv.active.length} windows, ${r.hits} connections`);
    if (r.windows.size !== mv.active.length) {
      bad.push(`${key}/${mv.id} [${mv.input}] landed ${r.windows.size} of its ${mv.active.length} `
        + `windows (${r.hits} connections) — the recovery floor cut a live hitbox off`);
    }
  }
  record('AD-3', 'every window of a multi-window move still connects at point blank',
    bad.length === 0 && rows.length > 0,
    `${rows.length} multi-window blockable moves measured at ${DISTANCES[0]}m`,
    cap(bad.length ? bad : (TABLE ? rows : [])));
}

// ---------------------------------------------------------------------------
// AD-4 — a whiff is untouched
//
// The null that must NOT move. Nothing connects, so nothing may shorten: a move
// thrown at nobody occupies the attacker for exactly `total` ticks and is
// actionable on the tick after. If this row ever moves, the change has reached
// into a path it was never supposed to touch, and every punish window in the
// game moved with it.
// ---------------------------------------------------------------------------

{
  const bad = [];
  let n = 0;
  for (const { key, mv } of POP) {
    if (!isBlockable(mv) || mv.props.requireAir) continue;
    // 4.5m: far enough that nothing in the roster reaches, close enough that the
    // pair is still inside the arena and facing each other.
    const r = probe({ key, mv, dist: 4.5, plan: 'stand' });
    if (!usable(r)) continue;
    if (r.event != null) continue;             // it reached; not a whiff row
    n++;
    if (r.life !== mv.total) {
      bad.push(`${key}/${mv.id} [${mv.input}] whiffed and was actionable ${r.life} ticks after `
        + `starting, not ${mv.total} (total=${mv.total}) — a whiff must recover on total`);
    }
    if (r.whiffs !== 1) {
      bad.push(`${key}/${mv.id} [${mv.input}] whiffed and raised ${r.whiffs} whiff events, not 1 `
        + '— the beat that fires when the last window expires is off');
    }
  }
  // A move that LANDED must not also announce a whiff. The two beats now share
  // one guard, so this is the row that would catch it firing on both paths.
  const falseWhiff = blockCells.filter((r) => usable(r) && r.event === 'block' && r.whiffs > 0)
    .map((r) => `${r.key}/${r.id} @${r.dist}m was blocked and still raised ${r.whiffs} whiff event(s)`);
  record('AD-4', 'a move that connects with nobody still recovers on total, and says so exactly once',
    bad.length === 0 && falseWhiff.length === 0 && n > 0,
    `${n} moves thrown at 4.5m with nothing in range; `
    + `${blockCells.filter((r) => usable(r) && r.event === 'block').length} blocked rows checked for a false whiff`,
    cap([...bad, ...falseWhiff]));
}

// ---------------------------------------------------------------------------
// AD-5 — a blow that did not land shortens nothing
//
// A HIGH against a full crouch passes THROUGH the defender: `#findConnection`
// finds the overlap, `#resolve` registers the window as consumed, and
// `#guardResult` returns 'whiff'. The window is spent but nobody was hit. If the
// recovery cut lived in `registerConnect` — the obvious place, one call site
// instead of three — then ducking a high would make the attacker recover EARLIER
// than the whiff schedule and the punish for ducking would silently shrink. It
// lives in `#doHit`/`#doBlock`/`#doArmor` instead, and this row is the reason.
// ---------------------------------------------------------------------------

{
  const bad = [];
  const rows = [];
  for (const { key, mv } of POP) {
    if (mv.height !== HEIGHT.HIGH || !isBlockable(mv) || mv.props.requireAir) continue;
    const ducked = probe({ key, mv, dist: DISTANCES[0], plan: 'crouchNoGuard' });
    if (!usable(ducked) || ducked.event != null) continue;   // it did not pass through
    rows.push(`${key}/${mv.id} ducked: actionable ${ducked.life} ticks in, total=${mv.total}`);
    if (ducked.life !== mv.total) {
      bad.push(`${key}/${mv.id} [${mv.input}] was ducked and recovered in ${ducked.life} ticks, `
        + `not ${mv.total} — a blow that hit nobody shortened the attacker's recovery`);
    }
  }
  record('AD-5', 'a high ducked by a crouching defender recovers on the whiff schedule',
    bad.length === 0 && rows.length > 0,
    `${rows.length} HIGH moves ducked at ${DISTANCES[0]}m`, cap(bad.length ? bad : (TABLE ? rows : [])));
}

// ---------------------------------------------------------------------------
// AD-6 — null controls
// ---------------------------------------------------------------------------

{
  const pool = blockCells.filter((r) => usable(r) && r.event === 'block' && r.adv != null);
  const sample = [];
  const step = Math.max(1, Math.floor(pool.length / 24));
  for (let i = 0; i < pool.length && sample.length < 24; i += step) sample.push(pool[i]);
  const repeatBad = [];
  for (const r of sample) {
    const again = probe({ key: r.key, mv: MOVES[r.key][r.id], dist: r.dist, plan: r.plan });
    if (again.adv !== r.adv || again.lastContactTick !== r.lastContactTick) {
      repeatBad.push(`${r.key}/${r.id} @${r.dist}m  first adv=${sign(r.adv)} contact=${r.lastContactTick}  `
        + `again adv=${again.adv == null ? 'null' : sign(again.adv)} contact=${again.lastContactTick}`);
    }
  }
  record('AD-6a', 'null control — the same move at the same distance gives the same integer',
    repeatBad.length === 0, `${sample.length} cells re-measured`, repeatBad);

  // The same measurement with the roles reversed.
  //
  // The two fighters are NOT the same machine — f0 is ROSTER[0] and f1 is
  // ROSTER[1] — so the contact tick can legitimately differ by a frame when a
  // shorter chassis is holding the guard. What must not differ is the ARITHMETIC:
  // given the same last-contact tick, the advantage integer is a property of the
  // move and of nothing else. Rows whose contact tick moved are counted and
  // named rather than asserted, because they are measuring reach, not recovery.
  const swapBad = [];
  const swapReach = [];
  let swapped = 0;
  for (const r of sample) {
    const mv = MOVES[r.key][r.id];
    const rec2 = recorder();
    let tick = 0;
    let adv = null;
    let lastTick = -1;
    try {
      withSet(f1, r.key, () => {
        stage(f1, f0, r.dist);
        const dcmd = DEF_CMD[r.plan]();
        for (let i = 0; i < 5; i++) { rec2.at(tick); f1.simulate(null); f0.simulate(dcmd); combat.simulate(tick); tick++; }
        rec2.clear();
        rec2.at(tick);
        f1.simulate(mkCmd(mv.parsed.dir, mv.parsed.buttons, false, mv.parsed.motion));
        f0.simulate(dcmd);
        combat.simulate(tick);
        if (f1.currentMove?.id !== mv.id) return;
        const instance = f1.moveInstance;
        tick++;
        let lastAt = -1;
        let aFree = -1;
        let dFree = -1;
        for (let i = 1; i < 400; i++) {
          rec2.at(tick);
          const before = rec2.ev.length;
          f1.simulate(null); f0.simulate(dcmd); combat.simulate(tick);
          for (let e = before; e < rec2.ev.length; e++) {
            const x = rec2.ev[e];
            if ((x.kind !== 'hit' && x.kind !== 'block') || x.attacker !== 1) continue;
            if (x.move !== mv.id || f1.moveInstance !== instance) continue;
            lastAt = tick;
            lastTick = x.moveTick;
          }
          if (lastAt >= 0) {
            if (tick > lastAt) {
              if (aFree < 0 && ACTIONABLE.has(f1.state)) aFree = tick;
              if (dFree < 0 && ACTIONABLE.has(f0.state)) dFree = tick;
            } else { aFree = -1; dFree = -1; }
          }
          tick++;
          if (lastAt >= 0 && aFree >= 0 && dFree >= 0) break;
          if (lastAt < 0 && f1.currentMove == null && i > mv.total + 2) break;
        }
        if (aFree >= 0 && dFree >= 0) adv = dFree - aFree;
      });
    } finally { rec2.dispose(); }
    if (adv == null) continue;
    if (lastTick !== r.lastContactTick) {
      swapReach.push(`${r.key}/${r.id} @${r.dist}m  contact ${r.lastContactTick} as fighter 0, `
        + `${lastTick} as fighter 1 — the other chassis is a frame out of reach`);
      continue;
    }
    swapped++;
    if (adv !== r.adv) {
      swapBad.push(`${r.key}/${r.id} @${r.dist}m  as fighter 0: ${sign(r.adv)}  as fighter 1: ${sign(adv)}`);
    }
  }
  record('AD-6b', 'null control — the same numbers with the two fighters swapped',
    swapBad.length === 0 && swapped > 0,
    `${swapped} of ${sample.length} cells re-measured from the other side at the same contact tick `
    + `(${swapReach.length} landed on a different tick against the other chassis)`,
    [...swapBad, ...cap(swapReach, 4)]);
}

// ---------------------------------------------------------------------------
// The ledger — every blockable move, printed against measured, at every range.
// ---------------------------------------------------------------------------

if (TABLE) {
  console.log('[advgate] ledger: set/move  input  printed  measured@0.9/1.02/1.2/1.5');
  const byMove = new Map();
  for (const r of blockCells) {
    if (!usable(r) || r.event !== 'block' || r.adv == null) continue;
    const k = `${r.key}/${r.id}`;
    if (!byMove.has(k)) byMove.set(k, {});
    byMove.get(k)[r.dist] = r.adv;
  }
  for (const [k, at] of byMove) {
    const [key, id] = k.split('/');
    const mv = MOVES[key][id];
    const cells = DISTANCES.map((d) => (at[d] == null ? '  · ' : sign(at[d]).padStart(4))).join(' ');
    console.log(`          ${k.padEnd(26)} ${String(mv.input).padEnd(8)} ${sign(mv.onBlock).padStart(4)}  ${cells}`);
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const failed = results.filter((r) => !r.ok).map((r) => r.id);

if (CTL) {
  // Under a control the meaning is inverted: the named tests MUST fail and the
  // named tests MUST pass. A control that fails everything proves nothing, and
  // neither does one that fails nothing.
  const want = new Set(CTL.red);
  const keep = new Set(CTL.green);
  const missing = CTL.red.filter((id) => !failed.includes(id));
  const collateral = failed.filter((id) => keep.has(id));
  const ok = missing.length === 0 && collateral.length === 0;
  console.log(`[advgate] CONTROL ${CONTROL}: ${CTL.why}`);
  console.log(`[advgate]   expected red: ${[...want].join(', ')}   actually red: ${failed.join(', ') || '(none)'}`);
  if (missing.length) console.log(`[advgate]   DID NOT GO RED: ${missing.join(', ')}`);
  if (collateral.length) console.log(`[advgate]   COLLATERAL — these had to stay green: ${collateral.join(', ')}`);
  console.log(`[advgate] control ${ok ? 'VALID' : 'INVALID'}  (${results.length} checks, ${secs}s)`);
  process.exit(ok ? 0 : 1);
}

if (failed.length === 0) console.log(`[advgate] GREEN — ${results.length} checks, ${secs}s`);
else console.log(`[advgate] RED — ${failed.length} failing: ${failed.join(', ')}  (${results.length} checks, ${secs}s)`);
process.exit(failed.length ? 1 : 0);
