/**
 * Knockbots — offline animation contact sheet, for clips that are NOT in the
 * certified shot roster.
 *
 * ============================================================================
 * READ THIS BEFORE USING ANYTHING THIS TOOL WRITES AS EVIDENCE.
 *
 * A sheet from this file is NOT a capture. It is not in `tools/capture.mjs`'s
 * `ROSTER`, no manifest vouches for it, the dead-canvas gate has not looked at
 * it, and nothing will notice if it silently stops being produced.
 *
 * That is not a theoretical concern. Round 28 briefed a critic on
 * `11-anim-roundhouse` as evidence for a round of animation work. That file has
 * never been in the shot list — `git log -S` returns nothing for it — and the
 * only copy on disk was a one-off from THIS TOOL, dated before every animation
 * edit of that round. Judging on it would have judged round-20 animation, and
 * the manifest could not say so because it validates its list against itself.
 *
 * So: every sheet this tool writes is stamped, in the image, with the commit it
 * was taken at, the wall-clock time, and the words NOT CERTIFIED. If you are
 * holding a sheet and you cannot tell whether it is evidence, the stamp will
 * tell you. If you want evidence, add the clip to `ROSTER` and `SHOTS` in
 * `tools/capture.mjs` as a `clipStrip` — that path is four lines of data and it
 * gets you a static camera, a declared crop, per-panel verification, the
 * dead-panel check, the chain plot and a roster entry whose absence fails a run.
 *
 * This tool exists for the case that path does not cover: sweeping many clips
 * quickly while iterating, where the point is to look, not to certify.
 * ============================================================================
 *
 * It now uses the same instrument as the certified strips, for one reason: the
 * previous version was actively misleading about motion. It re-projected the
 * fighter's bounding box every panel and cropped to it, so the fighter was
 * re-centred in each cell — which subtracts exactly the translation a critic is
 * trying to read — and it picked ticks by pinning three frames around contact
 * and scattering the rest, so the spacing between panels varied and nothing
 * about timing could be read off the sheet either.
 *
 * BOTH OF THOSE PROPERTIES ARE LOAD-BEARING AND EVERYTHING BELOW PRESERVES THEM.
 * `--panels` changes how many ticks are sampled and nothing about how they are
 * spaced: the step is still one number for the whole clip, still anchored so the
 * contact tick lands on a panel, and every panel is still photographed through
 * ONE crop solved from the union of the whole run. `--vs` widens that one crop to
 * cover both fighters and leaves it just as fixed.
 *
 *   node tools/animstrip.mjs --clip p.straight
 *   node tools/animstrip.mjs --clip k.roundhouse,k.axeKick --step 4
 *   node tools/animstrip.mjs --clip p.straight --panels 24
 *   node tools/animstrip.mjs --all-attacks --out /tmp/scratch/anim
 *   node tools/animstrip.mjs --vs --move jab --panels 24
 *
 * ---------------------------------------------------------------------------
 * --panels N — ask for a COUNT, not a step
 *
 * `--step` says how many ticks apart the panels are, which means the number of
 * panels is whatever the clip's length makes it. `--panels N` says how many
 * samples you want and solves the step from the clip's own duration, so 16 or 24
 * panels of a 21-tick jab and of a 64-tick axe kick are both evenly spaced across
 * the whole move. The solve is exhaustive and honest: it tries every integer step
 * from 1 up, counts the panels each one actually produces through the same
 * `stripTicks` the certified strips use, and keeps the closest. A clip cannot
 * yield more distinct panels than it has ticks, so `--panels 24` on a 21-tick
 * move gives 22 and the sheet says 22. `--step` still works; `--panels` wins if
 * both are given.
 *
 * ---------------------------------------------------------------------------
 * --vs — a real attack against a real guard, and the number it is there to show
 *
 * Without this the sheet shows a limb travelling through empty space, which can
 * be judged for motion and cannot be judged for contact. `--vs` stages both
 * fighters point-blank, holds a guard on the defender that MATCHES THE ATTACK
 * HEIGHT (crouch guard for lows, standing otherwise), starts the attack through
 * `startMove`, and photographs the exchange. It marks, per panel and again as a
 * band under the grid: the tick the capsules actually overlapped, the defender's
 * block-stun window, and the first tick each fighter is actionable again.
 *
 * It exists because those three numbers currently disagree with the move list.
 * `docs/TESTPLAN.md` FD-0 measured, on Vulkan's 56-move table at point blank with
 * a matching guard: 45 blockable moves measured, 0 matching their printed
 * `onBlock`, 45 differing, all in the same direction, by +2 to +8 frames. `jab`
 * prints +1 on block and plays -1. The cause is a convention mismatch, not a bug
 * in any one move:
 *
 *     MoveSchema.defineMove:      recovery = total - lastActive - 1
 *                                 onBlock  = blockStun - recovery
 *                                          = blockStun - (total - lastActive - 1)
 *     CombatSystem.#findConnection resolves on the FIRST tick the capsules
 *                                 overlap, so what actually plays is
 *                                 measured  = blockStun - (total - contactTick)
 *     delta = printed - measured = lastActive + 1 - contactTick
 *                                = the move's own active span, at point blank.
 *
 * The printed number is the Tekken convention (contact on the LAST active frame)
 * and is therefore a best case approached only at maximum range. This tool does
 * not fix that — which of the data, the engine or the display is wrong is a
 * design decision nobody has made. It puts the printed number, the measured
 * number and the tick contact actually happened on the same image so the decision
 * can be made while looking at the thing.
 *
 * One thing the sheet prints that is worth knowing before reading it: by FD-0's
 * OWN identity, `delta = lastActive + 1 - contactMoveTick`, the delta is at least
 * 1 for every tick inside the active window. Reaching the printed number would
 * take a connection on `lastActive + 1`, a tick on which the move has no hitbox.
 * So maximum range does not reach the printed number either; it gets to one frame
 * short of it. That is arithmetic on the plan's formula, not a second
 * measurement, and the ledger on the sheet says it in one line.
 *
 * WHAT THIS MEASUREMENT IS AND IS NOT. The attack is forced with `startMove`,
 * which is layer L2 in TESTPLAN's terms: it proves what the move does once it has
 * started, NOT that a player can start it. The guard is held through the real
 * command path (a `Command` of the same shape `Input#commandsFor` builds, fed in
 * where the CPU would be), so the defender's block is the game's block. The
 * outcome is taken from the engine's own `block` / `hit` bus events rather than
 * inferred from state, because a low against a standing guard produces a stable,
 * reproducible advantage number about an event that never happened — see FD-3's
 * null control. The sheet always prints which event actually fired.
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOVES } from '../src/combat/Moves.js';
import { MAX_HEALTH, METER_MAX } from '../src/core/Constants.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT = resolve(ROOT, arg('out', 'shots/anim'));
const STEP = Number(arg('step', 0)) || 0;   // 0 = pick one that gives ~12 panels
const PANELS = Number(arg('panels', 0)) || 0; // a COUNT; beats --step when set
const PANEL_W = Number(arg('panel', 320));
const PORT = Number(arg('port', 5230));
const CHAR = Number(arg('char', 0));
// The defender in --vs. It is a real parameter of the measurement and not a
// detail: the contact tick is the first tick two CAPSULES overlap, so a wider
// defender is reached earlier and every number on the sheet moves with it.
// ROSTER[0] is VULKAN, whose 56-move table is the one FD-0 measured.
const CHAR2 = Number(arg('char2', 1));
const DIST = Number(arg('dist', 0)) || 0;   // 0 = solved per mode
const VS = argv.includes('--vs');
// The staged separation for --vs, metres. 1.04 is the distance FD-0 was measured
// at, and it is deliberately point blank: the whole finding is that the contact
// tick moves EARLIER into the active window as the fighters get closer, so a
// sheet taken at sparring range would understate the delta it exists to show.
const GAP = Number(arg('gap', 0)) || 1.04;
// The sheet grows sideways with the panel count. Past about this width a cell is
// no longer being read, it is being scrolled, so the grid wraps into more rows
// instead of more columns and the cell size never changes.
const MAX_SHEET_W = Number(arg('maxw', 0)) || 2560;

const DEFAULT_CLIPS = [
  'p.straight', 'p.uppercut', 'p.pistonRush', 'p.launcherPunch',
  'k.roundhouse', 'k.axeKick', 'k.sweep', 'k.spinKick',
  'sp.rocketPunch', 'sp.chargeShoulder',
];

const clips = argv.includes('--all-attacks')
  ? DEFAULT_CLIPS
  : arg('clip', '').split(',').filter(Boolean);

/**
 * Moves named directly, by id. `--vs` is about frame data, and frame data belongs
 * to a MOVE, not to a clip: `jab` and `jab2` are 21 and 26 ticks with different
 * block stun, and `jab2` plays `p.straight`, which is also `straight`'s clip. A
 * `--clip p.straight` in `--vs` mode therefore measures whichever of the two the
 * table happens to list first, which is not a question anyone asked.
 */
const moveIds = arg('move', '').split(',').filter(Boolean);

if (!clips.length && !moveIds.length) {
  console.error('usage: node tools/animstrip.mjs --clip <id>[,<id>...] | --all-attacks');
  console.error('       node tools/animstrip.mjs --vs --move <moveId>[,<moveId>...] [--panels 24]');
  console.error('  --panels N   ask for N samples; the step is solved from each clip\'s own length');
  console.error('  --step N     ticks between panels (ignored when --panels is given)');
  console.error('  --vs         run the attack against a guarding defender and mark contact,');
  console.error('               block stun and the first actionable tick of each fighter');
  console.error('  --gap M      staged separation for --vs, metres (default 1.04, point blank)');
  console.error('  --char N     attacker, ROSTER index (default 0, VULKAN — the FD-0 table)');
  console.error('  --char2 N    defender (default 1); its capsules decide the contact tick');
  console.error('  --panel PX   cell width (default 320); --maxw PX wraps rows past this width');
  console.error('NOTE: sheets from this tool are NOT certified evidence. See the header comment.');
  process.exit(1);
}
if (moveIds.length && !VS) {
  console.warn('[anim] --move only selects moves in --vs mode; use --clip for the solo sheet');
}

/** The chain the rubric's 90+ text describes. Same list the certified strips use. */
const LINKS = ['hips', 'chest', 'head', 'shoulder_R', 'elbow_R', 'hand_R', 'knee_R', 'foot_R'];

/** Provenance, stamped into every sheet so a stale one can always be identified. */
function provenance() {
  let commit = 'unknown';
  let dirty = '';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
    if (execSync('git status --porcelain', { cwd: ROOT }).toString().trim()) dirty = ' +uncommitted';
  } catch { /* not a repo, or git missing */ }
  return `${commit}${dirty} · ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
}

/**
 * The move a clip is driven by, if any, plus the frame data the panel grid and
 * the contact label are built from.
 * @returns {?Object}
 */
function moveFor(clipId, setKey) {
  const set = MOVES[setKey] || MOVES.standard;
  for (const mv of Object.values(set)) if (mv.clip === clipId) return mv;
  for (const s of Object.values(MOVES)) for (const mv of Object.values(s)) if (mv.clip === clipId) return mv;
  return null;
}

/** A move by id, from the set the staged fighter is actually using. */
function moveById(id, setKey) {
  const set = MOVES[setKey] || MOVES.standard;
  return set[id] || Object.values(set).find((m) => m.id === id) || null;
}

/**
 * Even spacing anchored on the contact tick, plus both endpoints. Identical
 * reasoning — and identical behaviour — to `stripTicks` in `tools/capture.mjs`:
 * an even split from zero puts contact between two panels unless the step
 * happens to divide it, and the contact frame is the one panel a critic cannot
 * do without.
 */
function stripTicks(span, contact, step) {
  const out = new Set([0, span]);
  if (contact != null && contact >= 0 && contact <= span) {
    for (let t = contact; t >= 0; t -= step) out.add(t);
    for (let t = contact; t <= span; t += step) out.add(t);
  } else {
    for (let t = 0; t <= span; t += step) out.add(t);
  }
  return [...out].filter((t) => t >= 0 && t <= span).sort((a, b) => a - b);
}

/**
 * The step that gets closest to `want` panels on THIS clip.
 *
 * Solved rather than computed, because the panel count is not simply
 * `span / step`: `stripTicks` anchors the grid on the contact tick and then adds
 * both endpoints, so a step that divides the span evenly and one that does not
 * give different counts, and the two added endpoints may or may not already be on
 * the grid. Every candidate step is therefore run through the real `stripTicks`
 * and counted. `span` is at most a few hundred ticks and this is arithmetic, so
 * the exhaustive answer costs nothing and cannot be off by one.
 *
 * The spacing property the header comment insists on survives untouched: this
 * picks ONE step for the whole clip. It does not add panels near contact.
 *
 * @returns {{step:number, ticks:number[]}} the ticks the sheet will photograph
 */
function solvePanels(span, contact, want) {
  let best = null;
  for (let s = 1; s <= Math.max(1, span); s++) {
    const ticks = stripTicks(span, contact, s);
    const d = Math.abs(ticks.length - want);
    // Ties go to the denser sheet: asking for 24 and being handed 22 is a clip
    // that cannot carry 24 distinct ticks, and in that case more is the honest
    // direction to miss in.
    if (!best || d < best.d || (d === best.d && ticks.length > best.ticks.length)) {
      best = { step: s, ticks, d };
    }
  }
  return best ? { step: best.step, ticks: best.ticks } : { step: 1, ticks: [0] };
}

/** Smallest and largest gap between consecutive panels, for the sheet header. */
function panelGaps(ticks) {
  if (ticks.length < 2) return [0, 0];
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < ticks.length; i++) {
    const g = ticks[i] - ticks[i - 1];
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  return [lo, hi];
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const stamp = provenance();

  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();

  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  // A full 1080p viewport, not a small one. The crop is taken out of the frame
  // afterwards, and cropping a small viewport is how you get a sheet that cannot
  // be compared with anything the certified harness produces — see rule 5 in
  // docs/PROFILING.md, where four rounds of deltas were computed against a
  // baseline at a different resolution.
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(2500);

  await page.evaluate(`(() => {
    window.KB.menus.show(null);
    window.KB.startMatch(${CHAR}, ${CHAR2});
    window.KB.setPhase('fight');
    window.KB.cpu[0] = null;
    window.KB.cpu[1] = null;
    document.getElementById('ui').style.display = 'none';
  })()`);
  await page.waitForFunction("window.KB.phase === 'fight' && window.KB.phaseTicks > 60", null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(600);

  const setKey = await page.evaluate('window.KB.fighters[0].moveSetKey ?? "standard"');

  if (VS) await runVs(page, setKey, stamp);
  else await runSolo(page, setKey, stamp);

  if (errors.length) {
    console.warn(`[anim] ${errors.length} page error(s):`);
    errors.slice(0, 5).forEach((e) => console.warn('  ', e));
  }
  console.warn(`\n[anim] These sheets are NOT in tools/capture.mjs's ROSTER and no manifest vouches`);
  console.warn('[anim] for them. They are stamped with the commit they were taken at. Do not brief');
  console.warn('[anim] a critic on one without checking that stamp against the work being judged.');
  await browser.close();
  await server.close();
}

/**
 * One fighter, one clip per sheet: the original mode, unchanged except that the
 * panel grid can now be asked for by count.
 */
async function runSolo(page, setKey, stamp) {
  for (const clip of clips) {
    const mv = moveFor(clip, setKey);
    const info = await page.evaluate(`(() => {
      const c = window.KB.fighters[0].animator?.clips?.['${clip}'];
      return c ? { duration: c.duration, loop: !!c.loop } : null;
    })()`);
    if (!info) { console.warn(`[anim] clip "${clip}" is not on the animator, skipping`); continue; }

    const span = mv ? mv.total : info.duration;
    const contact = mv && mv.active?.length ? Math.min(...mv.active.map((a) => a.from)) : null;
    // --panels beats --step, and --step beats the old default of "a step that
    // gives about 12". All three end in the same place: one step for the clip.
    const solved = PANELS ? solvePanels(span, contact, PANELS) : null;
    const step = solved ? solved.step : (STEP || Math.max(1, Math.round(span / 11)));
    const targets = solved ? solved.ticks : stripTicks(span, contact, step);
    if (PANELS && targets.length !== PANELS) {
      console.warn(`[anim] ${clip}: asked for ${PANELS} panels, ${span} ticks can carry `
        + `${targets.length} evenly spaced at step ${step}`);
    }

    // Stage, park the camera ONCE, and start the clip. The camera is replaced
    // rather than asked: FightCamera re-solves its framing every render, so a
    // requested framing does not hold, and a framing that changes between
    // panels confounds motion with camera motion.
    const staged = await page.evaluate(`(() => {
      const KB = window.KB, THREE = KB.THREE, S = KB.fighters[0], O = KB.fighters[1];
      KB.paused = false;
      S.position.set(-1.7, S.position.y, 0); S.prevPosition.copy(S.position);
      O.position.set(1.7, O.position.y, 0);  O.prevPosition.copy(O.position);
      S.velocity.set(0, 0, 0); O.velocity.set(0, 0, 0);
      S.facing = 1; O.facing = -1;
      const D = ${DIST} || 7.0, face = S.facing || 1;
      const aim = S.position.clone(); aim.y += 0.95;
      const pos = new THREE.Vector3(aim.x + face * D * 0.62, aim.y + D * 0.24, aim.z + D * 0.74);
      const cam = KB.camera;
      const park = () => {
        cam.position.copy(pos); cam.up.set(0, 1, 0);
        cam.lookAt(aim.x, aim.y - 0.12, aim.z);
        cam.fov = 30; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      };
      window.__kbAnimRestore = { render: KB.fightCamera.render, simulate: KB.fightCamera.simulate };
      KB.fightCamera.render = park; KB.fightCamera.simulate = () => {};
      park();

      // Drive the MOVE where one exists, through startMove and nothing else.
      //
      // A follow-up animator.play(clip, {blend, loop}) discards the retime
      // startMove just installed -- Animator#play does
      //   top.retime = opts.retime || null
      // -- so the clip then runs at its authored rate rather than the rate the
      // move plays it at. That is a real defect in the certified 17-anim-strip
      // and it must not be reproduced here.
      const set = KB.MOVES[S.moveSetKey] || KB.MOVES.standard;
      let mv = null;
      for (const m of Object.values(set)) if (m.clip === '${clip}') { mv = m; break; }
      if (mv) S.startMove(mv);
      else S.animator.play('${clip}', { blend: 0, loop: ${info.loop} });

      const e = S.animator.base.entries[S.animator.base.entries.length - 1];
      window.__kbAnimTrack = [];
      // Pause immediately so tick 0 is tick 0 and not "tick 0 plus however long
      // the driver round trip took" -- measured at four to five ticks.
      KB.paused = true;
      if (!window.__kbClock) window.__kbClock = KB.clock.getDelta.bind(KB.clock);
      KB.clock.getDelta = () => 0;
      return { move: mv ? mv.id : null,
               retime: e && e.retime ? 'yes' : (mv ? 'LOST' : 'n/a') };
    })()`);

    const SAMPLE = `(() => {
      const KB = window.KB, THREE = KB.THREE, f = KB.fighters[0];
      const bn = f.skeletonBundle && f.skeletonBundle.byName; if (!bn) return null;
      const cam = KB.camera, W = window.innerWidth, H = window.innerHeight;
      const world = {}, screen = {};
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const n of ${JSON.stringify(LINKS)}) {
        const bo = bn[n]; if (!bo) continue;
        const w = bo.getWorldPosition(new THREE.Vector3());
        world[n] = [+w.x.toFixed(4), +w.y.toFixed(4), +w.z.toFixed(4)];
        const p = w.clone().project(cam);
        screen[n] = [+((p.x * 0.5 + 0.5) * W).toFixed(1), +((-p.y * 0.5 + 0.5) * H).toFixed(1)];
      }
      for (const bo of f.skeletonBundle.bones) {
        const p = bo.getWorldPosition(new THREE.Vector3()).project(cam);
        const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
        if (sx < a) a = sx; if (sx > c) c = sx; if (sy < b) b = sy; if (sy > d) d = sy;
      }
      return { world, screen, bbox: [a, b, c, d].map(Math.round),
               clip: f.animator ? f.animator.current : null,
               animTime: f.animator ? +f.animator.time.toFixed(2) : null,
               moveTick: f.moveTick, state: f.state };
    })()`;

    // PASS 1: step the whole clip and record where the body goes, without
    // photographing anything. The crop is then solved from the union of every
    // panel's bounds — one rectangle for the whole sheet, so panels register —
    // rather than re-solved per panel, which is what the old version did and
    // which deletes the translation being judged.
    const track = await page.evaluate(`(() => new Promise((res) => {
      const KB = window.KB;
      const clockOf = () => ${mv ? 'KB.fighters[0].moveTick' : 'KB.fighters[0].animator.time'};
      const out = [];
      let last = null, idle = 0;
      KB.clock.getDelta = () => 1 / 60;
      KB.paused = false;
      const step = () => {
        const c = clockOf();
        if (c !== last) { last = c; idle = 0; const s = ${SAMPLE}; if (s) { s.clock = c; out.push(s); } }
        else if (++idle > 240) { KB.paused = true; KB.clock.getDelta = () => 0; res(out); return; }
        if (c >= ${span}) { KB.paused = true; KB.clock.getDelta = () => 0; res(out); }
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }))()`);

    const seen = new Set();
    const clean = [];
    for (const s of track) { if (!seen.has(s.clock)) { seen.add(s.clock); clean.push(s); } }
    if (!clean.length) { console.warn(`[anim] ${clip}: nothing sampled, skipping`); continue; }

    const bx = clean.map((s) => s.bbox);
    // 48 px of margin, because the box is over BONES and the silhouette is not:
    // the armour, the pack and the antenna all sit outside the outermost bone.
    const M = 70;
    const rect = {
      x: Math.max(0, Math.min(...bx.map((v) => v[0])) - M),
      y: Math.max(0, Math.min(...bx.map((v) => v[1])) - M),
    };
    rect.w = Math.min(1920 - rect.x, Math.max(...bx.map((v) => v[2])) + M - rect.x);
    rect.h = Math.min(1080 - rect.y, Math.max(...bx.map((v) => v[3])) + M - rect.y);

    // PASS 2: restart the clip and photograph the declared ticks through the
    // solved rectangle.
    await page.evaluate(`(() => {
      const KB = window.KB, S = KB.fighters[0];
      KB.paused = false;
      const set = KB.MOVES[S.moveSetKey] || KB.MOVES.standard;
      let mv = null;
      for (const m of Object.values(set)) if (m.clip === '${clip}') { mv = m; break; }
      if (mv) S.startMove(mv); else S.animator.play('${clip}', { blend: 0, loop: ${info.loop} });
      KB.paused = true; KB.clock.getDelta = () => 0;
    })()`);

    const panels = [];
    for (const target of targets) {
      const at = await page.evaluate(`(() => new Promise((res) => {
        const KB = window.KB;
        const clockOf = () => ${mv ? 'KB.fighters[0].moveTick' : 'KB.fighters[0].animator.time'};
        let idle = 0, last = null;
        const finish = () => {
          KB.paused = true; KB.clock.getDelta = () => 0;
          // Two frames before the shutter: a screenshot taken on the frame the
          // pause happened can catch a compositor frame in which the WebGL
          // surface has not swapped, and what comes back is the page background
          // with nothing in it.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            res({ clock: clockOf(), sample: ${SAMPLE} });
          }));
        };
        if (clockOf() >= ${target}) { finish(); return; }
        KB.clock.getDelta = () => 1 / 60; KB.paused = false;
        const step = () => {
          const c = clockOf();
          if (c !== last) { last = c; idle = 0; } else idle++;
          if (c >= ${target} || idle > 240) finish();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }))()`).catch(() => null);
      if (!at) break;
      const grab = () => page.screenshot({ clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } });
      let png = await grab();
      for (let r = 0; r < 2 && png.length < 40e3; r++) { await page.waitForTimeout(220); png = await grab(); }
      panels.push({ want: target, got: at.clock, s: at.sample, b64: png.toString('base64') });
    }

    const sheet = await page.evaluate(composeSheet, {
      panels: panels.map((p) => ({ want: p.want, got: p.got, s: p.s, b64: p.b64 })),
      track: clean, rect, contact, span, step, clip, links: LINKS,
      tip: /^k\./.test(clip) ? 'foot_R' : 'hand_R',
      move: staged.move, retime: staged.retime, panelW: PANEL_W, stamp,
      gaps: panelGaps(targets), asked: PANELS || 0, maxW: MAX_SHEET_W,
    });

    const file = resolve(OUT, `${clip.replace(/\./g, '_')}.jpg`);
    writeFileSync(file, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`[anim] ${clip} -> ${file}  (${panels.length} panels, contact ${contact}, `
      + `retime ${staged.retime})  NOT CERTIFIED`);

    await page.evaluate(`(() => {
      const KB = window.KB, r = window.__kbAnimRestore;
      if (r) { KB.fightCamera.render = r.render; KB.fightCamera.simulate = r.simulate; }
      if (window.__kbClock) { KB.clock.getDelta = window.__kbClock; window.__kbClock = null; }
      KB.paused = false;
    })()`);
  }
}

/**
 * Composite the sheet in the page. Same construction as the certified strips:
 * fixed crop, contact panel flagged, a per-tick trail of the tip and the hips
 * drawn up to each panel's tick, and a normalised per-tick speed plot of the
 * chain underneath.
 */
function composeSheet(D) {
  const PAL = ['#ff9e2c', '#4fd8e8', '#8be36b', '#ff6b8a', '#b48cff', '#ffd84f', '#5fa8ff', '#ff8a4f'];
  const PW = D.panelW;
  const scale = PW / D.rect.w;
  const PH = Math.round(D.rect.h * scale);
  const n = D.panels.length;
  // Grow in rows, not in columns. The cell is always `panelW` wide — that is what
  // keeps a 24-panel sheet as legible per cell as a 12-panel one — so the only
  // thing a higher count can cost is sheet width, and past `maxW` a sheet is
  // being scrolled rather than read. At the default 12 panels this still lands on
  // the 6x2 grid it always used.
  const maxCols = Math.max(1, Math.floor((D.maxW || 2560) / PW));
  let cols = Math.max(1, Math.min(n, maxCols));
  const rows = Math.max(1, Math.ceil(n / cols));
  cols = Math.max(1, Math.ceil(n / rows));   // balance: no lone panel on the last row
  const HEAD = 76, PLOT = 280;
  const W = Math.max(cols * PW, 1280);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = HEAD + rows * PH + PLOT;
  const g = cv.getContext('2d');
  g.fillStyle = '#0a0d13'; g.fillRect(0, 0, cv.width, cv.height);

  // The stamp goes first and it goes in red, because the whole point is that a
  // sheet from this tool must never be mistaken for a capture.
  g.fillStyle = '#ff6b8a';
  g.font = '700 15px ui-monospace, monospace';
  g.fillText(`NOT CERTIFIED — offline sheet from tools/animstrip.mjs, no manifest · ${D.stamp}`, 12, 18);
  g.fillStyle = '#ff9e2c';
  g.font = '700 19px ui-monospace, monospace';
  g.fillText(`${D.clip}${D.move ? `  via move "${D.move}"` : '  (no move — clip played directly)'}`, 12, 42);
  g.fillStyle = D.retime === 'LOST' ? '#ff6b8a' : '#9fb0c4';
  g.font = '500 13px ui-monospace, monospace';
  const gaps = D.gaps || [D.step, D.step];
  g.fillText(`${n} panels${D.asked && D.asked !== n ? ` (asked ${D.asked}; ${D.span} ticks fit ${n})` : ''}`
    + ` · every ${D.step} ticks across 0..${D.span}`
    + `${gaps[0] === gaps[1] ? '' : `, end gaps ${gaps[0]}..${gaps[1]}`}`
    + `${D.contact == null ? ', no contact frame' : `, anchored on contact at ${D.contact}`}`
    + ` · static camera, one crop ${D.rect.w}x${D.rect.h}@${D.rect.x},${D.rect.y} for every panel`
    + (D.retime === 'LOST' ? ' · RETIME LOST' : ''), 12, 62);

  const toPanel = (xy, cx, cy) => [cx + (xy[0] - D.rect.x) * scale, cy + (xy[1] - D.rect.y) * scale];

  return Promise.all(D.panels.map((p) => new Promise((res) => {
    const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + p.b64;
  }))).then((imgs) => {
    imgs.forEach((im, i) => {
      const p = D.panels[i];
      const cx = (i % cols) * PW, cy = HEAD + Math.floor(i / cols) * PH;
      g.drawImage(im, 0, 0, im.width, im.height, cx, cy, PW, PH);

      for (const [bone, col, r] of [[D.tip, '#ff9e2c', 2.4], ['hips', '#4fd8e8', 1.9]]) {
        const pts = D.track.filter((s) => s.clock <= p.want && s.screen && s.screen[bone])
          .map((s) => toPanel(s.screen[bone], cx, cy));
        if (pts.length < 2) continue;
        g.strokeStyle = col; g.lineWidth = 1.5; g.globalAlpha = 0.85;
        g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
        for (const q of pts.slice(1)) g.lineTo(q[0], q[1]);
        g.stroke(); g.globalAlpha = 1;
        g.fillStyle = col;
        for (const q of pts) { g.beginPath(); g.arc(q[0], q[1], r, 0, 6.284); g.fill(); }
      }

      const isContact = D.contact != null && p.want === D.contact;
      g.strokeStyle = isContact ? '#ff9e2c' : 'rgba(255,255,255,.09)';
      g.lineWidth = isContact ? 3 : 1;
      g.strokeRect(cx + 1.5, cy + 1.5, PW - 3, PH - 3);
      g.fillStyle = 'rgba(0,0,0,.72)'; g.fillRect(cx, cy, isContact ? 130 : 70, 22);
      g.fillStyle = isContact ? '#ff9e2c' : '#4fd8e8';
      g.font = '700 13px ui-monospace, monospace';
      g.fillText(`t${p.want}${isContact ? '  CONTACT' : ''}`, cx + 7, cy + 16);

      const s = p.s || {};
      g.fillStyle = 'rgba(0,0,0,.72)'; g.fillRect(cx, cy + PH - 20, PW, 20);
      g.fillStyle = s.clip === D.clip ? '#6b8299' : '#ff6b8a';
      g.font = '500 11px ui-monospace, monospace';
      g.fillText(`${s.clip || '(none)'} @${s.animTime} · ${s.state || '?'}`
        + (p.got !== p.want ? `  LANDED ${p.got}` : ''), cx + 6, cy + PH - 6);
    });

    const py = HEAD + rows * PH;
    g.fillStyle = '#070a0f'; g.fillRect(0, py, W, PLOT);
    g.fillStyle = '#9fb0c4'; g.font = '600 13px ui-monospace, monospace';
    g.fillText('per-tick speed, each link normalised to its own peak', 12, py + 18);

    const L = 46, R = W - 340, T = py + 34, B = py + PLOT - 26;
    const cs = D.track.map((s) => s.clock);
    const c0 = Math.min.apply(null, cs), c1 = Math.max.apply(null, cs);
    const X = (c) => L + ((c - c0) / Math.max(1e-6, c1 - c0)) * (R - L);
    g.strokeStyle = '#1b232e'; g.beginPath(); g.moveTo(L, B); g.lineTo(R, B); g.stroke();
    if (D.contact != null) {
      g.strokeStyle = '#ff9e2c'; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(X(D.contact), T); g.lineTo(X(D.contact), B); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ff9e2c'; g.font = '600 11px ui-monospace, monospace';
      g.fillText('contact', X(D.contact) + 4, T + 10);
    }

    const peaks = [];
    D.links.forEach((bone, k) => {
      const rws = D.track.filter((s) => s.world && s.world[bone]);
      if (rws.length < 3) return;
      const sp = [];
      for (let i = 1; i < rws.length; i++) {
        const a = rws[i - 1].world[bone], b = rws[i].world[bone];
        const dt = Math.max(1, rws[i].clock - rws[i - 1].clock);
        sp.push({ c: rws[i].clock, v: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt });
      }
      const mx = Math.max.apply(null, sp.map((s) => s.v));
      if (!(mx > 1e-6)) return;
      const col = PAL[k % PAL.length];
      g.strokeStyle = col; g.lineWidth = 1.7;
      g.beginPath();
      sp.forEach((s, i) => {
        const x = X(s.c), y = B - (s.v / mx) * (B - T);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
      const drive = D.contact != null ? sp.filter((s) => s.c <= D.contact) : sp;
      const use = drive.length ? drive : sp;
      const pk = use.reduce((a, b) => (b.v > a.v ? b : a), use[0]);
      peaks.push({ bone, c: pk.c, col, mx });
      g.fillStyle = col;
      g.beginPath(); g.arc(X(pk.c), B - (pk.v / mx) * (B - T), 4, 0, 6.284); g.fill();
    });

    peaks.sort((a, b) => a.c - b.c);
    g.font = '600 12px ui-monospace, monospace';
    peaks.forEach((p, i) => {
      const y = T + 6 + i * 17;
      g.fillStyle = p.col; g.fillRect(R + 18, y - 8, 10, 10);
      g.fillText(`${p.bone}  peak t${p.c}  ${(p.mx * 60).toFixed(2)} m/s`, R + 34, y + 1);
    });
    g.fillStyle = '#6b8299'; g.font = '500 11px ui-monospace, monospace';
    g.fillText(D.contact != null ? 'peak order within 0..contact (top = first)'
      : 'peak order (top = first)', R + 18, T - 4);
    g.fillText(`tick ${c0}`, L, B + 16);
    g.fillText(`tick ${c1}`, R - 46, B + 16);

    return cv.toDataURL('image/jpeg', 0.88);
  });
}

// ===========================================================================
// --vs : two fighters, one exchange
// ===========================================================================

/**
 * The whole page-side rig for `--vs`, installed as one object per move.
 *
 * It is passed to `page.evaluate` AS A FUNCTION rather than as a string, and so
 * is every other page function below. That is not a style choice. Everything this
 * repo has broken nine times over — a backtick inside a comment inside a template
 * literal silently ending the string — is impossible in a function that is
 * serialised by `Function.prototype.toString`, and the page code here is long
 * enough that the string form would be a matter of time.
 *
 * `cfg` carries everything the page needs: it cannot close over anything in this
 * module, because only the source of this one function crosses into the browser.
 */
function vsInstall(cfg) {
  const KB = window.KB;
  const THREE = KB.THREE;
  const NOT_ACTIONABLE = ['blockstun', 'hitstun', 'launched', 'juggled', 'knockdown',
    'wakeup', 'thrown', 'ko'];

  const H = {
    cfg,
    offs: [],
    events: [],
    t0: 0,

    /** The move being measured, from the set the staged fighter really uses. */
    move() {
      const set = KB.MOVES[cfg.setKey] || KB.MOVES.standard;
      if (set[cfg.moveId]) return set[cfg.moveId];
      for (const m of Object.values(set)) if (m.id === cfg.moveId) return m;
      return null;
    },

    /** Who is actually in the ring. Both halves change the contact tick. */
    who() {
      const A = KB.fighters[0], D = KB.fighters[1];
      return {
        atk: A.def ? A.def.id : '?',
        def: D.def ? D.def.id : '?',
        setKey: A.moveSetKey || 'standard',
      };
    },

    proj(v) {
      const p = v.project(KB.camera);
      return [+((p.x * 0.5 + 0.5) * window.innerWidth).toFixed(1),
        +((-p.y * 0.5 + 0.5) * window.innerHeight).toFixed(1)];
    },

    /**
     * One row of the record. The bounds cover BOTH fighters, because the crop is
     * solved from the union of every row and there is exactly one crop for the
     * whole sheet — a crop that tracked one fighter would delete the closing
     * distance, which in this mode is the subject.
     */
    sample() {
      const A = KB.fighters[0], D = KB.fighters[1];
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const f of [A, D]) {
        if (!f.skeletonBundle) continue;
        for (const bo of f.skeletonBundle.bones) {
          const s = H.proj(bo.getWorldPosition(new THREE.Vector3()));
          if (s[0] < a) a = s[0];
          if (s[0] > c) c = s[0];
          if (s[1] < b) b = s[1];
          if (s[1] > d) d = s[1];
        }
      }
      const screen = {};
      const bn = A.skeletonBundle && A.skeletonBundle.byName;
      if (bn) {
        for (const n of cfg.links) {
          const bo = bn[n];
          if (bo) screen[n] = H.proj(bo.getWorldPosition(new THREE.Vector3()));
        }
      }
      return {
        bbox: [a, b, c, d].map(Math.round),
        screen,
        atk: {
          state: A.state,
          moveTick: A.moveTick,
          boxes: A.hitboxes ? A.hitboxes.length : 0,
          clip: A.animator ? A.animator.current : null,
          free: A.state !== 'attack' && A.state !== 'throw',
        },
        def: {
          state: D.state,
          stun: D.stunTicks,
          blocking: !!D.isBlocking,
          crouch: !!D.crouching,
          clip: D.animator ? D.animator.current : null,
          free: NOT_ACTIONABLE.indexOf(D.state) < 0,
        },
        gap: +(D.position.x - A.position.x).toFixed(3),
      };
    },

    /**
     * Put the pair where FD-0 measured them, hold a guard on the defender, and
     * park the camera once.
     *
     * The guard is a real `Command` of the exact shape `Input#commandsFor`
     * builds, handed in where the CPU's would be. `Game.#simulate` consults
     * `cpu[1]` and only `cpu[1]` — player 0 always comes off the input device —
     * which is why the attacker is fighter 0 here and that is not an option.
     */
    stage() {
      const A = KB.fighters[0], D = KB.fighters[1];
      KB.paused = false;
      const cmd = {
        x: 0, y: cfg.crouch ? -1 : 0,
        fwd: false, back: false, up: false, down: !!cfg.crouch,
        guard: true, touchGuard: false,
        held: new Set(), pressed: new Set(),
        notation: '', buffer: [], motion: null,
      };
      if (!window.__kbVsRestore) {
        window.__kbVsRestore = {
          render: KB.fightCamera.render,
          simulate: KB.fightCamera.simulate,
          cpu1: KB.cpu[1],
          delta: KB.clock.getDelta.bind(KB.clock),
        };
      }
      KB.cpu[0] = null;
      KB.cpu[1] = { think: () => cmd, setLevel() {}, reset() {} };

      const half = cfg.gap / 2;
      A.position.set(-half, A.floorY != null ? A.floorY : A.position.y, 0);
      D.position.set(half, D.floorY != null ? D.floorY : D.position.y, 0);
      A.prevPosition.copy(A.position);
      D.prevPosition.copy(D.position);
      A.velocity.set(0, 0, 0);
      D.velocity.set(0, 0, 0);
      A.facing = 1;
      D.facing = -1;
      A.state = 'idle';
      D.state = 'idle';
      A.stunTicks = 0;
      D.stunTicks = 0;
      A.currentMove = null;
      D.currentMove = null;
      A.hitboxes.length = 0;
      D.hitboxes.length = 0;
      if (A.connected) A.connected.clear();
      if (D.connected) D.connected.clear();
      A.airborne = false;
      D.airborne = false;
      A.crouching = false;
      A.health = cfg.maxHealth;
      D.health = cfg.maxHealth;
      // Without meter a meter-gated move never starts, and what gets recorded is
      // a hundred ticks of a fighter standing still. `TestHarness.probeMoves`
      // records having been bitten by exactly this.
      A.meter = cfg.meterMax;
      D.meter = cfg.meterMax;
      A.animYaw = 0;
      A.aimYaw = 0;
      if (A.animator) A.animator.play('idle.fight', { blend: 0, loop: true });
      if (D.animator) D.animator.play('idle.fight', { blend: 0, loop: true });

      // One camera, parked, for every panel of every pass. Replaced rather than
      // asked, for the reason the header comment gives: FightCamera re-solves its
      // framing every render, so a requested framing does not hold.
      const aim = new THREE.Vector3(0, A.position.y + 0.98, 0);
      const dist = cfg.dist;
      const pos = new THREE.Vector3(aim.x + dist * 0.30, aim.y + dist * 0.20, aim.z + dist * 0.86);
      const cam = KB.camera;
      const park = () => {
        cam.position.copy(pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(aim.x, aim.y - 0.10, aim.z);
        cam.fov = 30;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
      };
      KB.fightCamera.render = park;
      KB.fightCamera.simulate = () => {};
      park();
      return { gap: +(D.position.x - A.position.x).toFixed(3), move: cfg.moveId };
    },

    /**
     * Listen for what the ENGINE says happened, not for what the states imply.
     *
     * FD-3's null control is the reason: running an on-block sweep with the wrong
     * guard stance records a stable, reproducible advantage number about an event
     * that never happened, because the move simply hit. A row whose event does not
     * match its label is a harness failure and this is how the sheet can tell.
     *
     * `moveTick` is read at the instant the event fires, inside `#simulate`, and
     * it is the unambiguous number: `Game` increments `this.tick` only AFTER
     * `#simulate` returns, so a `KB.tick` read here is one behind the row the
     * sampler writes for the same sim tick, and `+ 1` is exactly that correction.
     */
    arm() {
      H.disarm();
      H.events = [];
      const A = KB.fighters[0];
      const rec = (kind) => (e) => {
        H.events.push({
          kind,
          moveTick: A.moveTick,
          t: KB.tick - H.t0 + 1,
          move: e && e.move ? e.move.id : null,
          mine: !!(e && (e.attacker === A || e.fighter === A)),
          counter: !!(e && e.counter),
        });
      };
      // Every way a connection can resolve. `block` comes from CombatSystem,
      // `whiff` / `parry` / `armorAbsorb` from Fighter, and `launch` / `knockdown`
      // are here because a defender who is launched never becomes actionable
      // inside the sheet at all, and the sheet should say which of the two that
      // is rather than print a missing number.
      for (const k of ['hit', 'block', 'whiff', 'parry', 'armorAbsorb', 'launch', 'knockdown']) {
        const off = KB.bus.on(k, rec(k));
        if (off) H.offs.push(off);
      }
    },

    disarm() {
      for (const f of H.offs) { if (f) f(); }
      H.offs = [];
    },

    /**
     * Hold the guard for `warm` ticks, then start the attack on a tick boundary
     * whose number is known.
     *
     * The clock is frozen across `startMove` deliberately: with the sim paused no
     * tick can pass between reading `KB.tick` and starting the move, so the first
     * simulated tick after this is unambiguously sheet tick 1 — and, during the
     * move, sheet tick N is `moveTick` N. The sheet cross-checks that identity
     * rather than assuming it.
     */
    begin() {
      return new Promise((res) => {
        H.stage();
        H.arm();
        let last = -1, warm = 0, idle = 0;
        KB.clock.getDelta = () => 1 / 60;
        KB.paused = false;
        const step = () => {
          const tk = KB.tick;
          if (tk === last) {
            if (++idle > 400) { res(null); return; }
            requestAnimationFrame(step);
            return;
          }
          idle = 0;
          last = tk;
          if (++warm < cfg.warm) { requestAnimationFrame(step); return; }
          KB.paused = true;
          KB.clock.getDelta = () => 0;
          H.t0 = KB.tick;
          const mv = H.move();
          if (mv) KB.fighters[0].startMove(mv);
          const s = H.sample();
          s.t = 0;
          // `startMove` can refuse — a meter-gated move with no meter simply does
          // not begin, and what would otherwise be recorded is a fighter standing
          // still for the length of the sheet.
          s.started = !!mv && KB.fighters[0].currentMove === mv;
          res(s);
        };
        requestAnimationFrame(step);
      });
    },

    /** PASS 1: run the whole exchange uninterrupted, one row per sim tick. */
    run(o) {
      return new Promise((res) => {
        H.begin().then((first) => {
          if (!first) { res({ rows: [], events: [], t0: 0, started: false }); return; }
          const rows = [first];
          let last = KB.tick, idle = 0;
          const done = () => {
            KB.paused = true;
            KB.clock.getDelta = () => 0;
            res({ rows, events: H.events.slice(), t0: H.t0, started: !!first.started });
          };
          KB.clock.getDelta = () => 1 / 60;
          KB.paused = false;
          const step = () => {
            const tk = KB.tick;
            if (tk === last) {
              // A hitstop freeze stops the sim without stopping rAF, so a stalled
              // tick for a handful of frames after contact is expected, not a
              // hang. 400 frames is far past the longest freeze in the game.
              if (++idle > 400) { done(); return; }
              requestAnimationFrame(step);
              return;
            }
            idle = 0;
            last = tk;
            const s = H.sample();
            s.t = tk - H.t0;
            rows.push(s);
            if (s.t >= o.span) { done(); return; }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
      });
    },

    /** PASS 2: advance to one declared tick and hold there for the shutter. */
    stepTo(target) {
      return new Promise((res) => {
        const clock = () => KB.tick - H.t0;
        let last = -1, idle = 0;
        const finish = () => {
          KB.paused = true;
          KB.clock.getDelta = () => 0;
          // Two frames before the shutter, for the reason the solo path gives:
          // a screenshot on the frame the pause happened can catch a compositor
          // frame in which the WebGL surface has not swapped.
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const s = H.sample();
            s.t = clock();
            res(s);
          }));
        };
        if (clock() >= target) { finish(); return; }
        KB.clock.getDelta = () => 1 / 60;
        KB.paused = false;
        const step = () => {
          const c = clock();
          if (c !== last) { last = c; idle = 0; } else idle++;
          if (c >= target || idle > 400) finish();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    },

    /** Hand the game back exactly as it was found. */
    restore() {
      H.disarm();
      const r = window.__kbVsRestore;
      if (r) {
        KB.fightCamera.render = r.render;
        KB.fightCamera.simulate = r.simulate;
        KB.cpu[1] = r.cpu1;
        KB.clock.getDelta = r.delta;
        window.__kbVsRestore = null;
      }
      KB.paused = false;
      return true;
    },
  };

  window.__kbVs = H;
  return true;
}

/**
 * What the exchange actually did, read off pass 1.
 *
 * Every number here is measured, none is derived from the move data. The move
 * data appears only in `printed`, so the sheet can show the two side by side.
 */
function measureVs(pass, mv) {
  const rows = pass.rows || [];
  const events = pass.events || [];
  const conn = events.filter((e) => e.mine && (e.kind === 'block' || e.kind === 'hit'));
  const first = conn[0] || null;
  const outcome = first ? first.kind
    : events.some((e) => e.kind === 'parry') ? 'parry'
      : events.some((e) => e.kind === 'armorAbsorb') ? 'armor'
        : events.some((e) => e.kind === 'whiff') ? 'whiff' : 'none';
  const contact = first ? first.moveTick : null;

  let atkFree = null;
  let defFree = null;
  // Sheet tick N must be `moveTick` N while the move runs. If it ever is not, the
  // clock this sheet is labelled with is not the clock the frame data is in, and
  // that has to be on the image rather than in a comment.
  let drift = null;
  for (const r of rows) {
    if (r.t > 0 && r.atk.state === 'attack' && r.t !== r.atk.moveTick && drift == null) {
      drift = `t${r.t} vs moveTick ${r.atk.moveTick}`;
    }
    if (r.t > 0 && atkFree == null && r.atk.free) atkFree = r.t;
    if (contact != null && r.t > contact && defFree == null && r.def.free) defFree = r.t;
  }
  const advantage = (atkFree != null && defFree != null) ? defFree - atkFree : null;
  return {
    outcome, contact, atkFree, defFree, advantage, drift,
    eventTick: first ? first.t : null,
    counter: !!(first && first.counter),
    started: !!pass.started,
    stun: outcome === 'hit' ? mv.hitStun : mv.blockStun,
    printed: outcome === 'hit' ? mv.onHit : mv.onBlock,
    // The closed form FD-0 predicts, in the tool rather than in the notes, so a
    // sheet that disagrees with it is visibly a sheet that disagrees with it.
    model: contact == null ? null
      : (outcome === 'hit' ? mv.hitStun : mv.blockStun) - (mv.total - contact),
  };
}

const sgn = (n) => (n == null ? 'n/a' : (n > 0 ? `+${n}` : `${n}`));

/**
 * One sheet per move: the attack, the guard, and the three ticks that decide
 * whether the printed frame data is true.
 */
async function runVs(page, setKey, stamp) {
  const wanted = [
    ...moveIds.map((id) => ({ key: id, mv: moveById(id, setKey) })),
    ...clips.map((c) => ({ key: c, mv: moveFor(c, setKey) })),
  ];

  for (const w of wanted) {
    if (!w.mv) {
      console.warn(`[anim] --vs: nothing named "${w.key}" in move set "${setKey}", skipping`);
      continue;
    }
    const mv = w.mv;
    const firstActive = Math.min(...mv.active.map((a) => a.from));
    const lastActive = Math.max(...mv.active.map((a) => a.to));
    // Crouch guard for lows, standing otherwise. Matching the stance to the
    // height is the whole point: a standing guard against a low does not block,
    // it gets hit, and the advantage number that falls out of that is a number
    // about a different event (FD-3, null control).
    const crouch = mv.height === 'low';
    const notes = [];
    if (mv.height === 'unblockable') notes.push('UNBLOCKABLE — no guard can stop it, expect a hit row');
    if (mv.props?.throw) notes.push('THROW — CombatSystem.#findConnection refuses throws down the strike path');
    if (mv.props?.finisher) notes.push('FINISHER — guard is ignored by design');
    if (mv.active.length > 1) {
      notes.push(`${mv.active.length} active windows — later windows can extend the exchange past the first connection`);
    }

    await page.evaluate(vsInstall, {
      setKey, moveId: mv.id, crouch, gap: GAP,
      dist: DIST || 9.0, warm: 24, links: LINKS,
      maxHealth: MAX_HEALTH, meterMax: METER_MAX,
    });

    const who = await page.evaluate(() => window.__kbVs.who());
    if (who.setKey !== setKey) {
      notes.push(`MOVE SET MISMATCH: sheet built from "${setKey}", fighter is using "${who.setKey}"`);
    }

    // PASS 1: the whole exchange, uninterrupted, no photographs. Long enough to
    // outlast whichever of the two fighters is locked down longest.
    const span1 = mv.total + Math.max(mv.blockStun, mv.hitStun) + 10;
    const pass1 = await page.evaluate((o) => window.__kbVs.run(o), { span: span1 });
    if (!pass1.rows.length) {
      console.warn(`[anim] --vs ${mv.id}: nothing sampled, skipping`);
      await page.evaluate(() => window.__kbVs.restore());
      continue;
    }
    const m = measureVs(pass1, mv);
    if (!m.started) notes.push('startMove REFUSED — the fighter never entered the move');

    // The sheet runs to the last tick that matters: whichever fighter is free
    // last, plus a tick so that tick is visible rather than inferred.
    const span = Math.max(mv.total, m.atkFree ?? 0, m.defFree ?? 0) + 1;
    const solved = PANELS ? solvePanels(span, m.contact, PANELS)
      : STEP ? { step: STEP, ticks: stripTicks(span, m.contact, STEP) }
        : solvePanels(span, m.contact, 12);
    if (PANELS && solved.ticks.length !== PANELS) {
      console.warn(`[anim] --vs ${mv.id}: asked for ${PANELS} panels, ${span} ticks can carry `
        + `${solved.ticks.length} evenly spaced at step ${solved.step}`);
    }

    // ONE crop, from the union of every row of pass 1, over BOTH fighters.
    const bx = pass1.rows.map((r) => r.bbox).filter((b) => b.every(Number.isFinite));
    if (!bx.length) {
      console.warn(`[anim] --vs ${mv.id}: no projected bounds in ${pass1.rows.length} rows `
        + '(no skeleton bundle?), skipping');
      await page.evaluate(() => window.__kbVs.restore());
      continue;
    }
    const M = 70;
    const rect = {
      x: Math.max(0, Math.min(...bx.map((v) => v[0])) - M),
      y: Math.max(0, Math.min(...bx.map((v) => v[1])) - M),
    };
    rect.w = Math.min(1920 - rect.x, Math.max(...bx.map((v) => v[2])) + M - rect.x);
    rect.h = Math.min(1080 - rect.y, Math.max(...bx.map((v) => v[3])) + M - rect.y);

    // PASS 2: run the identical exchange again, stopping at each declared tick.
    await page.evaluate(() => window.__kbVs.begin());
    const panels = [];
    for (const target of solved.ticks) {
      const at = await page.evaluate((t) => window.__kbVs.stepTo(t), target).catch(() => null);
      if (!at) break;
      const grab = () => page.screenshot({ clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h } });
      let png = await grab();
      for (let r = 0; r < 2 && png.length < 40e3; r++) { await page.waitForTimeout(220); png = await grab(); }
      panels.push({ want: target, got: at.t, s: at, b64: png.toString('base64') });
    }
    if (!panels.length) {
      console.warn(`[anim] --vs ${mv.id}: pass 2 photographed nothing, skipping`);
      await page.evaluate(() => window.__kbVs.restore());
      continue;
    }

    // Pass 2 is the same run twice, so it is also a control on itself: if the
    // photographed exchange resolved on a different tick from the one that was
    // measured, the panel marked CONTACT is marking the wrong panel and the sheet
    // has to say so rather than look tidy.
    const pass2 = await page.evaluate(() => ({ events: window.__kbVs.events }));
    const m2 = measureVs({ rows: [], events: pass2.events, started: true }, mv);
    const mismatch = (m2.contact !== m.contact || m2.outcome !== m.outcome)
      ? `PASS MISMATCH: pass 1 ${m.outcome}@${m.contact}, pass 2 ${m2.outcome}@${m2.contact}`
      : null;
    if (mismatch) notes.push(mismatch);
    if (m.drift) notes.push(`CLOCK DRIFT: the sheet's tick is not the move's tick — ${m.drift}`);
    // Two independent readings of the same instant: the attacker's own moveTick
    // at the event, and the game tick the event fired on, corrected for the fact
    // that `Game` increments its tick after `#simulate` returns. They must agree,
    // and if they do not then one of the two is not the clock this sheet is
    // labelled with.
    if (m.contact != null && m.eventTick != null && m.eventTick !== m.contact) {
      notes.push(`CONTACT TICK AMBIGUOUS: moveTick ${m.contact} but sheet tick ${m.eventTick}`);
    }

    const sheet = await page.evaluate(composeVsSheet, {
      panels: panels.map((p) => ({ want: p.want, got: p.got, s: p.s, b64: p.b64 })),
      track: pass1.rows, rect, span, step: solved.step,
      gaps: panelGaps(solved.ticks), asked: PANELS || 0,
      panelW: PANEL_W, maxW: MAX_SHEET_W, stamp, notes,
      tip: /^k\./.test(mv.clip) ? 'foot_R' : 'hand_R',
      fd: {
        id: mv.id, name: mv.name, clip: mv.clip, input: mv.input, set: setKey,
        who: `${who.atk} vs ${who.def}`,
        height: mv.height, weight: mv.weight, guard: crouch ? 'crouch guard' : 'standing guard',
        gap: GAP, total: mv.total, startup: mv.startup, firstActive, lastActive,
        recovery: mv.recovery, blockStun: mv.blockStun, hitStun: mv.hitStun,
        onBlock: mv.onBlock, onHit: mv.onHit,
        windows: mv.active.map((a) => [a.from, a.to]),
        outcome: m.outcome, contact: m.contact, stun: m.stun,
        atkFree: m.atkFree, defFree: m.defFree,
        measured: m.advantage, printed: m.printed, model: m.model,
        delta: (m.printed != null && m.advantage != null) ? m.printed - m.advantage : null,
        counter: m.counter,
      },
    });

    const file = resolve(OUT, `vs_${mv.id}.jpg`);
    writeFileSync(file, Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`[anim] vs ${mv.id} -> ${file}  (${panels.length} panels, ${m.outcome} at moveTick `
      + `${m.contact}, printed ${sgn(m.printed)}, measured ${sgn(m.advantage)}, delta `
      + `${sgn(m.printed != null && m.advantage != null ? m.printed - m.advantage : null)})  NOT CERTIFIED`);
    for (const n of notes) console.warn(`[anim]   note: ${n}`);

    await page.evaluate(() => window.__kbVs.restore());
  }
}

/**
 * The two-fighter sheet.
 *
 * Same construction as the solo one — fixed crop, one camera, even spacing — plus
 * the three things a reader needs in order to see the frame data resolve: the
 * contact panel, the block-stun window, and the tick each fighter came back. They
 * are marked twice on purpose. Per panel they are read off the PHOTOGRAPH's own
 * sample, so a panel says what that fighter was doing on that tick; in the band
 * they are drawn on a continuous axis, so the ticks between panels are accounted
 * for and the advantage is a length rather than a claim.
 */
function composeVsSheet(D) {
  const F = D.fd;
  const PW = D.panelW;
  const scale = PW / D.rect.w;
  const PH = Math.round(D.rect.h * scale);
  const n = D.panels.length;
  const maxCols = Math.max(1, Math.floor((D.maxW || 2560) / PW));
  let cols = Math.max(1, Math.min(n, maxCols));
  const rows = Math.max(1, Math.ceil(n / cols));
  cols = Math.max(1, Math.ceil(n / rows));
  const HEAD = 132;
  const BAND = 200 + Math.max(0, D.notes.length) * 16;
  const W = Math.max(cols * PW, 1360);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = HEAD + rows * PH + BAND;
  const g = cv.getContext('2d');
  g.fillStyle = '#0a0d13';
  g.fillRect(0, 0, cv.width, cv.height);

  const sg = (v) => (v == null ? 'n/a' : (v > 0 ? `+${v}` : `${v}`));
  const BAD = '#ff6b8a';
  const OK = '#8be36b';
  const disagree = F.printed != null && F.measured != null && F.printed !== F.measured;

  // The stamp goes first and it goes in red, because the whole point is that a
  // sheet from this tool must never be mistaken for a capture.
  g.fillStyle = BAD;
  g.font = '700 15px ui-monospace, monospace';
  g.fillText(`NOT CERTIFIED — offline sheet from tools/animstrip.mjs, no manifest · ${D.stamp}`, 12, 18);

  g.fillStyle = '#ff9e2c';
  g.font = '700 19px ui-monospace, monospace';
  g.fillText(`${F.id} "${F.name}" (${F.input}) · ${F.clip} · ${F.height}/${F.weight}`
    + ` vs ${F.guard} at ${F.gap} m · ${F.who} · set ${F.set} · resolved ${F.outcome.toUpperCase()}`
    + (F.counter ? ' (COUNTER)' : ''), 12, 44);

  // The line the sheet exists for.
  g.font = '700 17px ui-monospace, monospace';
  const label = F.outcome === 'hit' ? 'onHit' : 'onBlock';
  g.fillStyle = '#9fb0c4';
  g.fillText(`printed ${label} ${sg(F.printed)}`, 12, 68);
  let x = 12 + g.measureText(`printed ${label} ${sg(F.printed)}`).width + 18;
  g.fillStyle = disagree ? BAD : OK;
  g.fillText(`measured ${sg(F.measured)}`, x, 68);
  x += g.measureText(`measured ${sg(F.measured)}`).width + 18;
  g.fillStyle = disagree ? BAD : OK;
  g.fillText(`delta ${sg(F.delta)}`, x, 68);
  x += g.measureText(`delta ${sg(F.delta)}`).width + 18;
  g.fillStyle = '#ff9e2c';
  g.fillText(`contact on moveTick ${F.contact == null ? 'never' : F.contact}`, x, 68);

  g.font = '500 13px ui-monospace, monospace';
  g.fillStyle = '#6b8299';
  g.fillText(`measured = ${F.outcome === 'hit' ? 'hitStun' : 'blockStun'} ${F.stun}`
    + ` - (total ${F.total} - contact ${F.contact == null ? '?' : F.contact}) = ${sg(F.model)}`
    + `   ·   printed = ${F.outcome === 'hit' ? 'hitStun' : 'blockStun'} ${F.stun}`
    + ` - (total ${F.total} - lastActive ${F.lastActive} - 1) = ${sg(F.printed)}`
    + `   ·   the difference is the active span ${F.firstActive}..${F.lastActive} at this range`, 12, 90);

  g.fillStyle = '#6b8299';
  g.fillText(`${n} panels${D.asked && D.asked !== n ? ` (asked ${D.asked}; ${D.span} ticks fit ${n})` : ''}`
    + ` · every ${D.step} ticks across 0..${D.span}`
    + `${D.gaps[0] === D.gaps[1] ? '' : `, end gaps ${D.gaps[0]}..${D.gaps[1]}`}`
    + `${F.contact == null ? ', unanchored (nothing connected)' : `, anchored on contact at ${F.contact}`}`
    + ` · static camera, one crop ${D.rect.w}x${D.rect.h}@${D.rect.x},${D.rect.y} for every panel`
    + ` · attacker free t${F.atkFree == null ? '?' : F.atkFree}, defender free t${F.defFree == null ? '?' : F.defFree}`,
  12, 110);

  const toPanel = (xy, cx, cy) => [cx + (xy[0] - D.rect.x) * scale, cy + (xy[1] - D.rect.y) * scale];
  const inStun = (t) => F.contact != null && t >= F.contact && t < F.contact + F.stun;

  return Promise.all(D.panels.map((p) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.src = 'data:image/png;base64,' + p.b64;
  }))).then((imgs) => {
    imgs.forEach((im, i) => {
      const p = D.panels[i];
      const cx = (i % cols) * PW;
      const cy = HEAD + Math.floor(i / cols) * PH;
      g.drawImage(im, 0, 0, im.width, im.height, cx, cy, PW, PH);

      // The striking bone's path up to this panel's tick, drawn through the same
      // fixed crop, so the limb can be seen arriving at the guard rather than
      // being asserted to have arrived.
      const pts = D.track.filter((s) => s.t <= p.want && s.screen && s.screen[D.tip])
        .map((s) => toPanel(s.screen[D.tip], cx, cy));
      if (pts.length > 1) {
        g.strokeStyle = '#ff9e2c';
        g.lineWidth = 1.5;
        g.globalAlpha = 0.85;
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (const q of pts.slice(1)) g.lineTo(q[0], q[1]);
        g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = '#ff9e2c';
        for (const q of pts) { g.beginPath(); g.arc(q[0], q[1], 2.2, 0, 6.284); g.fill(); }
      }

      const t = p.want;
      const isContact = F.contact != null && t === F.contact;
      const stun = inStun(t);
      g.strokeStyle = isContact ? '#ff9e2c' : stun ? '#5fa8ff' : 'rgba(255,255,255,.09)';
      g.lineWidth = isContact ? 3 : stun ? 2 : 1;
      g.strokeRect(cx + 1.5, cy + 1.5, PW - 3, PH - 3);

      const tag = isContact ? 'CONTACT' : stun ? `BLOCKSTUN ${F.contact + F.stun - t}` : '';
      g.fillStyle = 'rgba(0,0,0,.72)';
      g.fillRect(cx, cy, tag ? 190 : 70, 22);
      g.fillStyle = isContact ? '#ff9e2c' : stun ? '#5fa8ff' : '#4fd8e8';
      g.font = '700 13px ui-monospace, monospace';
      g.fillText(`t${t}${tag ? '  ' + tag : ''}`, cx + 7, cy + 16);

      // Both fighters' own account of the tick, read off the sample taken with
      // the photograph rather than off an index into the frame data.
      const s = p.s || {};
      const a = s.atk || {};
      const d = s.def || {};
      g.fillStyle = 'rgba(0,0,0,.76)';
      g.fillRect(cx, cy + PH - 36, PW, 36);
      g.font = '600 11px ui-monospace, monospace';
      g.fillStyle = a.free ? OK : '#ff9e2c';
      g.fillText(`A ${a.state} mt${a.moveTick}${a.boxes ? ` box${a.boxes}` : ''}`
        + `${a.free ? '  ACTIONABLE' : ''}`, cx + 6, cy + PH - 22);
      g.fillStyle = d.free ? OK : '#5fa8ff';
      g.fillText(`D ${d.state}${d.stun ? ` ${d.stun}` : ''}${d.blocking ? ' guard' : ''}`
        + `${d.free ? '  ACTIONABLE' : ''}`, cx + 6, cy + PH - 7);

      if (p.got !== p.want) {
        g.fillStyle = BAD;
        g.fillText(`LANDED ${p.got}`, cx + PW - 96, cy + PH - 7);
      }
    });

    // --- the band ----------------------------------------------------------
    const by = HEAD + rows * PH;
    g.fillStyle = '#070a0f';
    g.fillRect(0, by, W, BAND);
    const L = 92;
    // The right gutter holds the ledger, and the widest line in it is the active
    // window list of a three-window move, so it is sized for that rather than for
    // the common case.
    const R = W - 420;
    const X = (t) => L + (Math.max(0, Math.min(D.span, t)) / Math.max(1, D.span)) * (R - L);
    const ay = by + 40;
    const dy = by + 92;
    const BH = 26;

    g.font = '600 12px ui-monospace, monospace';
    g.fillStyle = '#9fb0c4';
    g.fillText('attacker', 10, ay + 17);
    g.fillText('defender', 10, dy + 17);

    // Attacker: startup, the authored active windows, recovery, and then whatever
    // is left of the sheet after the move has ended.
    g.fillStyle = '#141b25';
    g.fillRect(L, ay, R - L, BH);
    g.fillStyle = '#2c3644';   // the move: startup, active, recovery, 0..total
    g.fillRect(X(0), ay, X(F.total) - X(0), BH);
    for (const w of F.windows) {
      g.fillStyle = '#ff9e2c';
      g.fillRect(X(w[0]), ay, Math.max(2, X(w[1] + 1) - X(w[0])), BH);
    }
    // Defender: the guard, held from tick 0, then the block-stun window.
    g.fillStyle = '#141b25';
    g.fillRect(L, dy, R - L, BH);
    g.fillStyle = '#1f4a33';
    g.fillRect(L, dy, X(F.contact == null ? D.span : F.contact) - L, BH);
    if (F.contact != null) {
      g.fillStyle = '#2f6ea8';
      g.fillRect(X(F.contact), dy, Math.max(2, X(F.contact + F.stun) - X(F.contact)), BH);
      g.fillStyle = '#cfe4ff';
      g.font = '700 11px ui-monospace, monospace';
      g.fillText(`block stun ${F.stun}`, X(F.contact) + 5, dy + 17);
    }

    if (F.contact != null) {
      g.strokeStyle = '#ff9e2c';
      g.setLineDash([4, 4]);
      g.beginPath();
      g.moveTo(X(F.contact), ay - 12);
      g.lineTo(X(F.contact), dy + BH + 10);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ff9e2c';
      g.font = '700 12px ui-monospace, monospace';
      g.fillText(`contact t${F.contact}`, X(F.contact) + 5, ay - 16);
    }

    // The two ticks the advantage is the distance between.
    const flag = (t, y, col, text) => {
      if (t == null) return;
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(X(t), y);
      g.lineTo(X(t) - 6, y - 10);
      g.lineTo(X(t) + 6, y - 10);
      g.closePath();
      g.fill();
      g.font = '700 11px ui-monospace, monospace';
      // A tick near the end of the sheet is the normal case for "actionable
      // again", so the label flips to the left of its own flag rather than
      // running off the axis and into the ledger.
      const w = g.measureText(text).width;
      g.fillText(text, X(t) + w + 8 > R ? X(t) - w - 8 : X(t) + 8, y - 1);
    };
    flag(F.atkFree, ay, '#ffd84f', `attacker actionable t${F.atkFree}`);
    flag(F.defFree, dy, '#8be36b', `defender actionable t${F.defFree}`);

    if (F.atkFree != null && F.defFree != null) {
      const y = dy + BH + 26;
      const x0 = Math.min(X(F.atkFree), X(F.defFree));
      const x1 = Math.max(X(F.atkFree), X(F.defFree));
      g.strokeStyle = disagree ? BAD : OK;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x0, y - 6); g.lineTo(x0, y); g.lineTo(x1, y); g.lineTo(x1, y - 6);
      g.stroke();
      g.fillStyle = disagree ? BAD : OK;
      g.font = '700 12px ui-monospace, monospace';
      g.fillText(`measured ${sg(F.measured)} — the ticks between the two`, x1 + 8, y + 4);
    }

    g.fillStyle = '#6b8299';
    g.font = '500 11px ui-monospace, monospace';
    g.fillText('t0', L, dy + BH + 44);
    g.fillText(`t${D.span}`, R - 24, dy + BH + 44);

    // Right-hand ledger: the numbers, one per line, in the order an argument
    // about them would need them.
    const lines = [
      ['printed ' + label, sg(F.printed), '#9fb0c4'],
      ['measured', sg(F.measured), disagree ? BAD : OK],
      ['delta (printed - measured)', sg(F.delta), disagree ? BAD : OK],
      ['contact moveTick', F.contact == null ? 'never' : String(F.contact), '#ff9e2c'],
      ['startup / total', `${F.startup} / ${F.total}`, '#6b8299'],
      ['active', F.windows.map((w) => `${w[0]}..${w[1]}`).join(' '), '#6b8299'],
      ['recovery (total-lastActive-1)', String(F.recovery), '#6b8299'],
      [F.outcome === 'hit' ? 'hitStun' : 'blockStun', String(F.stun), '#6b8299'],
      ['closed form', sg(F.model), F.model === F.measured ? OK : BAD],
      // FD-0's own identity is delta = lastActive + 1 - contact, so the delta is
      // at least 1 for EVERY tick inside the active window: the printed number
      // would need the capsules to overlap one tick after the last active frame,
      // when there is no hitbox to overlap with. "Best case at maximum range" is
      // therefore still one frame short of what is printed. This is arithmetic on
      // the formula in the plan, not a second measurement.
      ['printed needs contact', `t${F.lastActive + 1} — 1 past the window`, BAD],
    ];
    g.font = '600 12px ui-monospace, monospace';
    lines.forEach((ln, i) => {
      const y = by + 26 + i * 17;
      g.fillStyle = '#4a5768';
      g.fillText(ln[0], R + 16, y);
      g.fillStyle = ln[2];
      g.fillText(ln[1], R + 250, y);
    });

    g.font = '600 12px ui-monospace, monospace';
    D.notes.forEach((note, i) => {
      g.fillStyle = BAD;
      g.fillText(`! ${note}`, 12, by + BAND - 12 - (D.notes.length - 1 - i) * 16);
    });

    return cv.toDataURL('image/jpeg', 0.88);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
