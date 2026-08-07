/**
 * Knockbots — headless visual capture harness.
 *
 * Boots the built game in Chromium with a real GPU backend (ANGLE/Metal on
 * macOS), drives it into scripted poses via `window.KB`, and writes PNGs to
 * shots/. The visual-critic agents read those PNGs.
 *
 *   node tools/capture.mjs                      # default shot list
 *   node tools/capture.mjs --shots idle,combo   # subset
 *   node tools/capture.mjs --out shots/round3   # destination
 *   node tools/capture.mjs --width 1920 --height 1080
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const OUT = resolve(ROOT, arg('out', 'shots'));
const WIDTH = Number(arg('width', 1920));
const HEIGHT = Number(arg('height', 1080));
const ONLY = arg('shots', '').split(',').filter(Boolean);
const KEEP = argv.includes('--keep');
/** Pin the perf probe to an explicit renderScale. `--perf-scale 1` measures the
 *  charter's native 1920x1080; omitted, the probe uses the shipping tier. */
const PERF_SCALE = arg('perf-scale', '') ? Number(arg('perf-scale', '')) : null;

const PORT = Number(arg('port', 5199));

/**
 * A shot is a named camera/pose setup evaluated in the page. Each `setup` runs
 * inside the browser with `KB` (the Game) in scope, then we wait `settle` ms and
 * grab the canvas.
 */
/**
 * True once no announcement banner is on screen.
 *
 * Staged shots re-enter the fight phase, which replays the round-start
 * intro — so "FIGHT" was being drawn across the exact frames the impact and
 * KO axes are judged on, and the KO shot showed the round-start banner and a
 * 60-second timer over a finished round. Waiting on the banner rather than on
 * a guessed delay keeps the announcement out of shots that are not about it.
 */
const NO_BANNER = `(() => {
  const q = window.KB?.hud?.announceQueue;
  const busy = window.KB?.hud?.announceBusy;
  const el = document.querySelector('.announce-layer');
  const visible = el && getComputedStyle(el).opacity > 0.02 && el.textContent.trim();
  return !busy && (!q || q.length === 0) && !visible;
})()`;

/**
 * How much of the frame the portrait subject actually fills, measured from the
 * projected bounding box. Used by BOTH the wait and the self-check, so the two
 * cannot drift apart -- the round-14 banner shot failed precisely because its
 * check was derived from the same wrong assumption as its wait.
 */
const PORTRAIT_MEASURE = `(() => {
  const KB = window.KB, THREE = KB.THREE, f = KB.fighters[0], cam = KB.camera;
  const box = new THREE.Box3().setFromObject(f.robot.group);
  const c = box.getCenter(new THREE.Vector3());
  const top = new THREE.Vector3(c.x, box.max.y, c.z).project(cam);
  const bot = new THREE.Vector3(c.x, box.min.y, c.z).project(cam);
  const o = KB.fighters[1].robot.group.position.clone().project(cam);
  return { dist: +cam.position.distanceTo(c).toFixed(2),
           subjectHeightFrac: +(Math.abs(top.y - bot.y) / 2).toFixed(3),
           otherFighterInFrame: Math.abs(o.x) < 1 && Math.abs(o.y) < 1 };
})()`;

/* ===========================================================================
 * CLIP STRIPS — the animation instrument.
 *
 * The animation axis is scored on ONE clip out of ninety-two. `17-anim-strip`,
 * `04-impact`, `05-juggle` and `07-super` all drive `forceHit({move:'launcher'})`,
 * which resolves to `p.uppercut`. Round 28 improved 28 clips and the critic
 * could see none of it, because nothing photographs any of the other 91.
 *
 * `tickStrip` (the older mechanism, still used by `08b-hud-motion` and
 * `17-anim-strip`) is not a good instrument for motion, and the critic said so.
 * It stacks whole frames at 34% crop, samples ticks chosen by hand around
 * contact, and stops before the recovery. Four things are wrong with that for
 * judging motion, and `clipStrip` fixes each one:
 *
 *   1. EVEN TICK SPACING ACROSS THE WHOLE MOVE, recovery included. Follow-through
 *      is a rubric term and `17-anim-strip` stops at tick 26 of a 48-tick move,
 *      so more than half of the thing being scored has never been photographed.
 *      The grid is anchored ON the contact tick and stepped evenly outward, so
 *      spacing is uniform AND contact lands on a panel rather than between two.
 *   2. THE CONTACT PANEL IS LABELLED, from the move's own frame data
 *      (`move.startup`), not from a number typed into the shot table.
 *   3. THE CAMERA DOES NOT MOVE. `FightCamera.render` and `.simulate` are
 *      replaced by a closure over a position fixed once, and the crop rectangle
 *      is DECLARED in the shot rather than re-solved per panel. `animstrip.mjs`
 *      re-projected the fighter's bounds every panel and re-centred him in each
 *      one, which subtracts exactly the translation a critic is trying to read.
 *   4. ENOUGH PANELS TO SEE AN ARC, plus a per-tick screen-space TRAIL of the
 *      striking limb and the hips drawn onto each panel up to that panel's tick,
 *      and a per-tick speed plot of the kinetic chain underneath. The trail and
 *      the plot are only meaningful BECAUSE the camera is static — the same
 *      reason the old strip could not have carried them.
 *
 * Every panel records what the animator was ACTUALLY playing at that instant —
 * clip id, clip time, move tick, fighter state — and the sheet prints it. A
 * panel cannot claim to be showing a clip it is not showing.
 *
 * THE RETIME, which is the reason this exists as new shots rather than as an
 * edit to 17. `Fighter#startMove` installs `retimeFor(move)`, a two-anchor map
 * that lands the clip's authored contact frame on the move's startup frame and
 * stretches the recovery independently. `Animator#play` sets
 * `top.retime = opts.retime || null`, so ANY play() call without the retime
 * throws it away. `17-anim-strip` calls `startMove(mv)` and then
 * `animator.play(mv.clip, {blend:0, loop:false})` — no retime — so the one clip
 * the animation axis is scored on has been photographed UNRETIMED. For the
 * launcher (`straight3` -> `p.uppercut`) the map is inScale 0.8 / outScale 0.72
 * about pivot 16 at pivotAt 20: the strip runs the wind-up 25% slow and the
 * recovery 39% slow relative to the game, and its panel captioned as contact
 * (+16t) is the clip's authored contact frame, not the move's active frame,
 * which is tick 20. `17-anim-strip` is left untouched so the archive comparison
 * across rounds survives; `24-anim-uppercut` is the same clip captured
 * correctly, and the pair is the evidence.
 * ======================================================================== */

/** The chain the rubric's 90+ text describes: floor -> hips -> spine -> tip. */
const STRIP_LINKS = ['hips', 'chest', 'head', 'shoulder_R', 'elbow_R', 'hand_R', 'knee_R', 'foot_R'];

/**
 * Page-side staging for one clip strip: park the camera, hide the interface,
 * silence both CPUs, place the pair, and start the clip.
 *
 * Built from one function for all five strips on purpose. Five hand-written
 * setups is five chances for two of them to disagree about what they staged,
 * and this project has paid for that class of drift repeatedly.
 *
 * @param {Object} c the shot's `clipStrip` block
 * @returns {string} JS to evaluate in the page
 */
const stripSetup = (c) => `(() => {
  const KB = window.KB, THREE = KB.THREE;
  const si = ${c.subject}, S = KB.fighters[si], O = KB.fighters[1 - si];
  KB.paused = false;
  const hud = document.getElementById('ui');
  if (hud) { window.__kbStripHud = hud.style.visibility; hud.style.visibility = 'hidden'; }
  // Nothing may interrupt the clip under review. The opponent's CPU throwing a
  // jab mid-strip is how a strip ends up showing a block instead of the move it
  // is named for.
  window.__kbStripCpu = [KB.cpu[0] || null, KB.cpu[1] || null];
  KB.cpu[0] = null; KB.cpu[1] = null;

  const drive = ${JSON.stringify(c.drive)};
  const set = KB.MOVES[S.moveSetKey] || KB.MOVES.standard;
  const mv = ${c.move ? `set[${JSON.stringify(c.move)}] || null` : 'null'};
  const clipId = ${JSON.stringify(c.clip)};

  // Place the pair. For an attack strip the spacing is deliberately OUTSIDE
  // reach: a connecting blow triggers hitstop, hitstop stops the tick counter
  // dead, and a strip whose panels are spaced in ticks cannot have uniform
  // spacing across a freeze. Contact is still labelled — from the move's frame
  // data, which is where the number should have come from in the first place.
  // The reaction strip is the exception and stages through forceHit, because a
  // reaction only exists if something caused it.
  if (drive !== 'forceHit') {
    const half = ${c.spacing ?? 3.2} / 2;
    const s0 = KB.fighters[0], s1 = KB.fighters[1];
    s0.position.set(-half, s0.position.y, 0); s0.prevPosition.copy(s0.position);
    s1.position.set(half, s1.position.y, 0);  s1.prevPosition.copy(s1.position);
    s0.velocity.set(0, 0, 0); s1.velocity.set(0, 0, 0);
    s0.facing = 1; s1.facing = -1;
  }

  // Camera: fixed once, and then the rig is not allowed to touch it again.
  // FightCamera re-solves its framing every render, so "asking" for a framing
  // and settling does not hold one; the only thing that holds is replacing the
  // methods.
  const D = ${c.dist ?? 6.4};
  const aim = S.position.clone();
  aim.y += ${c.aimY ?? 1.05};
  aim.x += (S.facing || 1) * ${c.aimFwd ?? 0};
  const face = S.facing || 1;
  // Three-quarter, closer to side-on than the fight framing: a strike's arc and
  // the hip rotation under it both read from here, and neither reads from the
  // near-frontal gameplay angle.
  const pos = new THREE.Vector3(
    aim.x + face * D * ${c.offX ?? 0.62},
    aim.y + D * ${c.offY ?? 0.24},
    aim.z + D * ${c.offZ ?? 0.74},
  );
  const cam = KB.camera;
  const park = () => {
    cam.position.copy(pos);
    cam.up.set(0, 1, 0);
    cam.lookAt(aim.x, aim.y - ${c.lookDown ?? 0.12}, aim.z);
    cam.fov = ${c.fov ?? 30}; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
  };
  window.__kbStripRestore = { render: KB.fightCamera.render, simulate: KB.fightCamera.simulate };
  KB.fightCamera.render = park;
  KB.fightCamera.simulate = () => {};
  park();

  // Frame data, read from the move rather than typed into the shot table.
  const total = mv ? mv.total : null;
  const contact = mv && mv.active && mv.active.length
    ? Math.min.apply(null, mv.active.map((a) => a.from)) : null;
  const clip = S.animator && S.animator.clips ? S.animator.clips[clipId] : null;

  if (drive === 'move') {
    if (!mv) throw new Error('strip move not in this fighter\\'s set: ' + ${JSON.stringify(c.move)});
    // startMove ONLY. It installs the retime; a follow-up animator.play() would
    // discard it (Animator#play: top.retime = opts.retime || null) and the strip
    // would photograph the clip at a rate no player ever sees. That is the
    // defect in 17-anim-strip.
    S.startMove(mv);
  } else if (drive === 'forceHit') {
    KB.testHarness.forceHit(${JSON.stringify(c.forceHit || { attacker: 0, move: 'launcher' })});
  } else if (drive === 'hold') {
    // Hold a real direction key. Not a synthetic DOM event -- the listener can
    // be disabled by the menu layer and a headless page can lose focus, both of
    // which fail silently -- but the same key code the keymap declares, pushed
    // into the same Set the DOM listener writes to, so everything downstream of
    // Input#commandsFor is the code path a player drives. Poking the animator
    // instead does NOT work here: the state machine re-solves which locomotion
    // clip should be playing every tick and overwrites it inside one frame.
    KB.input.enabled = true;
    KB.input.keys.add(${JSON.stringify(c.hold || 'KeyD')});
    window.__kbStripHold = ${JSON.stringify(c.hold || 'KeyD')};
  }

  window.__kbStrip = {
    clip: clipId, move: mv ? mv.id : null, drive,
    startup: mv ? mv.startup : null, total, contact,
    clipDuration: clip ? clip.duration : null, clipLoop: clip ? !!clip.loop : null,
    // Prove the retime is installed, and report the map. A strip that silently
    // lost it is a strip of the wrong timing.
    retime: null,
  };
  // ONLY for a clip this harness started through startMove(). For a reaction the
  // subject is the victim, who has not been hit yet at this instant, so reading
  // its top entry reports whatever it was previously doing -- which came back as
  // a different retime on each of two runs and was printed on the sheet as if it
  // described the clip under review. A number that changes run to run and
  // describes nothing is worse than no number.
  const ent = drive === 'move' && S.animator && S.animator.base && S.animator.base.entries.length
    ? S.animator.base.entries[S.animator.base.entries.length - 1] : null;
  if (ent) window.__kbStrip.retime = ent.retime
    ? { pivot: ent.retime.pivot, pivotAt: ent.retime.pivotAt,
        inScale: +ent.retime.inScale.toFixed(4), outScale: +ent.retime.outScale.toFixed(4) }
    : 'NONE';
  window.__kbStripTrack = [];
  window.__kbStripOrigin = null;
  return window.__kbStrip;
})()`;

/**
 * Page-side sampler: one row per simulated tick, world and screen positions for
 * every chain link plus the subject's projected bounding box.
 *
 * Screen coordinates are only comparable across ticks because the camera is
 * parked, which is the whole reason the trail overlay is possible here and was
 * not possible in the old strip.
 */
const STRIP_SAMPLE = (subject) => `(() => {
  const KB = window.KB, THREE = KB.THREE, f = KB.fighters[${subject}];
  const bn = f.skeletonBundle && f.skeletonBundle.byName;
  if (!bn) return null;
  const cam = KB.camera, W = window.innerWidth, H = window.innerHeight;
  const world = {}, screen = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const links = ${JSON.stringify(STRIP_LINKS)};
  for (const n of links) {
    const b = bn[n];
    if (!b) continue;
    const w = b.getWorldPosition(new THREE.Vector3());
    world[n] = [+w.x.toFixed(4), +w.y.toFixed(4), +w.z.toFixed(4)];
    const p = w.clone().project(cam);
    screen[n] = [+((p.x * 0.5 + 0.5) * W).toFixed(1), +((-p.y * 0.5 + 0.5) * H).toFixed(1)];
  }
  // Whole-body box, from every bone, so the crop check is about the fighter and
  // not about the eight links the plot happens to use.
  for (const b of f.skeletonBundle.bones) {
    const p = b.getWorldPosition(new THREE.Vector3()).project(cam);
    const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
    if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
  }
  return { world, screen,
    bbox: [Math.round(minX), Math.round(minY), Math.round(maxX), Math.round(maxY)],
    clip: f.animator ? f.animator.current : null,
    animTime: f.animator ? +f.animator.time.toFixed(2) : null,
    moveTick: f.moveTick, state: f.state, y: +f.position.y.toFixed(3),
  };
})()`;

/**
 * The panel grid: an even step ANCHORED ON THE CONTACT TICK, plus the first and
 * last tick of the move.
 *
 * Anchoring matters. An even split from zero puts contact between two panels
 * unless the step happens to divide it, and "what leads and what lags" cannot be
 * read off a sheet whose contact frame was never photographed --
 * `17-anim-strip`'s hand-picked offsets [0,6,10,13,16,21,26] straddle the clip's
 * authored contact at 16 and miss the MOVE's active frame at 20 entirely, then
 * stop 22 ticks before the move ends.
 *
 * The two endpoints are added unconditionally and are the only gaps in the sheet
 * that are not exactly `step`; the header says so, because a strip that quietly
 * varies its own spacing is an unreadable instrument.
 *
 * @param {number} span last tick to photograph
 * @param {?number} contact tick to anchor on, or null for an unanchored clip
 * @param {number} step
 * @returns {number[]}
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
 * The kinetic chain, as numbers, from the same per-tick track the plot is drawn
 * from.
 *
 * Round 28's result was a distribution over 92 clips — median chain concordance
 * 0.50 -> 0.74, median hips->tip lag 0 -> 4 ticks, hips-at-contact 1.00 -> 0.00
 * — and the critic could see none of it, because those numbers appeared in no
 * capture. They appear here, per clip, in the manifest, computed from the frames
 * that were actually photographed rather than from an offline sampler that
 * nothing verifies against the renderer.
 *
 * MEASURED OVER 0..contact, NOT OVER THE WHOLE MOVE. That distinction is not
 * cosmetic: on `p.uppercut` the hips peak at move tick 34, which is in the
 * RECOVERY — the fighter dropping back down — and a whole-move peak order
 * therefore reports the hips arriving seven ticks after the fist and reads as a
 * chain running backwards when it is not. The rubric's claim is about the drive
 * INTO the strike, so the window is the drive into the strike.
 *
 * @param {Array} track per-tick samples with `.world` and `.clock`
 * @param {?number} contact
 * @param {string} tip the striking bone
 */
function chainStats(track, contact, tip) {
  const win = contact != null ? track.filter((s) => s.clock <= contact) : track;
  if (win.length < 3) return null;
  const peakOf = (bone) => {
    let best = null;
    for (let i = 1; i < win.length; i++) {
      const a = win[i - 1].world && win[i - 1].world[bone];
      const b = win[i].world && win[i].world[bone];
      if (!a || !b) continue;
      const dt = Math.max(1, win[i].clock - win[i - 1].clock);
      const v = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt;
      if (!best || v > best.v) best = { v, c: win[i].clock };
    }
    return best;
  };
  const order = ['hips', 'chest', 'shoulder_R', 'elbow_R', tip];
  const peaks = order.map((b) => ({ bone: b, ...(peakOf(b) || {}) })).filter((p) => p.c != null);
  /*
   * Concordance: of every proximal/distal pair, the share that fire in the right
   * order. 1.0 is a textbook chain, 0.5 is a coin flip.
   *
   * A TIE IS NOT A CHAIN, AND COUNTING IT AS ONE INVERTED THE METRIC. This test
   * was `peaks[i].c <= peaks[j].c`, so two links peaking on the SAME tick scored
   * as correctly ordered -- which means a move whose every link peaks
   * simultaneously, the purest possible pose-to-pose robotic motion and the
   * exact failure this metric exists to catch, scored a perfect 1.00. Verified
   * on jab2 (clip p.straight): 1.00 under the old rule with all ten pairs tied,
   * 0.00 under a strict one. Across 211 moves the tie rule reads median 0.70
   * where strict reads 0.10, so essentially the whole apparent improvement lived
   * in the tie.
   *
   * A tie now scores nothing. It is not counted as a failure either -- ties go
   * to `n` but not to `ok`, so a fully simultaneous chain lands at 0.00 rather
   * than being excluded and silently reported as an empty sample.
   *
   * `tied` is reported alongside, because "0.4 concordance with 60% ties" and
   * "0.4 concordance with everything strictly ordered but half of it backwards"
   * are different animation problems and the score alone cannot distinguish
   * them.
   */
  let ok = 0, n = 0, tied = 0;
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      n++;
      if (peaks[i].c < peaks[j].c) ok++;
      else if (peaks[i].c === peaks[j].c) tied++;
    }
  }
  const hips = peaks.find((p) => p.bone === 'hips');
  const tipP = peaks.find((p) => p.bone === tip);
  const hipsPeakAll = peakOf('hips');
  const atContact = contact != null && hipsPeakAll
    ? (() => {
      const row = win[win.length - 1], prev = win[win.length - 2];
      if (!row || !prev || !row.world.hips || !prev.world.hips) return null;
      const dt = Math.max(1, row.clock - prev.clock);
      const v = Math.hypot(row.world.hips[0] - prev.world.hips[0],
        row.world.hips[1] - prev.world.hips[1], row.world.hips[2] - prev.world.hips[2]) / dt;
      return +(v / Math.max(1e-9, hipsPeakAll.v)).toFixed(3);
    })()
    : null;
  return {
    window: contact != null ? [0, contact] : [win[0].clock, win[win.length - 1].clock],
    peakTicks: Object.fromEntries(peaks.map((p) => [p.bone, p.c])),
    concordance: n ? +(ok / n).toFixed(3) : null,
    tiedPairs: n ? +(tied / n).toFixed(3) : null,
    hipsToTipLag: hips && tipP ? tipP.c - hips.c : null,
    hipsSpeedAtContactOverPeak: atContact,
  };
}

/**
 * Composite one clip strip. Runs in the page (canvas), receives everything it
 * needs as data, and touches no module scope.
 *
 * Three things are drawn and each is evidence the old strip could not carry:
 *
 *   PANELS at a fixed crop of a fixed camera, so a limb that moves across the
 *   frame is drawn moving across the frame. Every panel prints the clip the
 *   animator was really playing and the clip time it was really at.
 *
 *   A TRAIL, per panel, of the striking tip and the hips, drawn from tick 0 up
 *   to that panel's tick with a dot per tick. Dot spacing IS speed: bunched dots
 *   are a slow phase, spread dots a fast one, and even dots across a strike are
 *   the "linear interpolation" the rubric down-scores. This is the thing a
 *   critic asked for when it said a tick strip is a poor instrument for motion.
 *
 *   A CHAIN PLOT underneath: per-tick speed for hips -> chest -> shoulder ->
 *   elbow -> tip, each normalised to its own peak, with the peak marked and the
 *   contact tick ruled. The rubric's 90+ text for this axis -- "the hips lead,
 *   the head lags, a strike drives from the floor up" -- is a claim about the
 *   ORDER of those peaks, and this is that claim drawn. Round 28 moved the
 *   median hips->tip lag from 0 to 4 ticks and no evidence frame could show it.
 */
function stripSheet(D) {
  const PAL = ['#ff9e2c', '#4fd8e8', '#8be36b', '#ff6b8a', '#b48cff', '#ffd84f', '#5fa8ff', '#ff8a4f'];
  const PW = 340;
  const scale = PW / D.rect.w;
  const PH = Math.round(D.rect.h * scale);
  const n = D.panels.length;
  const cols = Math.max(1, Math.ceil(n / 2));
  const rows = Math.ceil(n / cols);
  const HEAD = 78;
  const PLOT = 300;
  const W = Math.max(cols * PW, 1320);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = HEAD + rows * PH + PLOT;
  const g = cv.getContext('2d');
  g.fillStyle = '#0a0d13';
  g.fillRect(0, 0, cv.width, cv.height);

  // "No retime" is correct for a clip with no move behind it and a DEFECT for a
  // clip with one. The first version of this line printed the same red warning
  // for both and cried wolf on the locomotion strip, where there is no move and
  // so nothing to have lost.
  const rt = D.info.retime;
  const lost = !!D.info.move && (rt === 'NONE' || !rt);
  const retimeTxt = lost
    ? 'RETIME DISCARDED — this strip is NOT the timing the game plays; do not read timing off it'
    : rt && rt !== 'NONE'
      ? `retime pivot ${rt.pivot}@${rt.pivotAt} in ${rt.inScale} out ${rt.outScale}`
        + ` — move tick ${rt.pivotAt} is clip frame ${rt.pivot}`
      : 'no move behind this clip, so no retime — it plays at its authored rate, as in game';
  g.fillStyle = '#ff9e2c';
  g.font = '700 20px ui-monospace, monospace';
  g.fillText(`${D.name}   ${D.info.clip}`
    + (D.info.move ? `  via move "${D.info.move}"` : ''), 12, 24);
  g.fillStyle = '#9fb0c4';
  g.font = '500 14px ui-monospace, monospace';
  const unit = D.clockKind === 'move' ? 'move ticks' : D.clockKind === 'anim' ? 'clip ticks' : 'ticks since clip start';
  g.fillText(`${n} panels · every ${D.step} ${unit} across 0..${D.span}`
    + `${D.contact == null ? ', no contact frame in this clip' : `, anchored on contact at ${D.contact}`}`
    + ` · endpoints 0 and ${D.span} added · static camera, fixed crop `
    + `${D.rect.w}x${D.rect.h}@${D.rect.x},${D.rect.y}`, 12, 44);
  g.fillStyle = lost ? '#ff6b8a' : '#6b8299';
  g.font = '500 13px ui-monospace, monospace';
  g.fillText(retimeTxt, 12, 58);
  if (D.chain) {
    const ch = D.chain;
    g.fillStyle = '#8be36b';
    g.font = '600 13px ui-monospace, monospace';
    g.fillText(`kinetic chain over ${ch.window[0]}..${ch.window[1]}:  concordance ${ch.concordance} (ties ${ch.tiedPairs})`
      + `   hips->tip lag ${ch.hipsToTipLag} ticks`
      + (ch.hipsSpeedAtContactOverPeak != null
        ? `   hips speed at contact ${ch.hipsSpeedAtContactOverPeak} of own peak` : ''), 12, 74);
  }

  const toPanel = (sxy, cx, cy) => [
    cx + (sxy[0] - D.rect.x) * scale,
    cy + (sxy[1] - D.rect.y) * scale,
  ];

  /**
   * Per-panel delivered luma, measured on the PANEL, not on a full frame taken
   * near it.
   *
   * The reaction strip shipped a completely black t0 panel while the run's
   * certification -- a full-frame grab a couple of hundred milliseconds later
   * at the same frozen tick -- read p50 0.19 and passed. That is the project's
   * signature failure in miniature: a certificate about a frame nobody looked
   * at. Every panel is now measured on its own pixels.
   */
  const lumaOf = (im) => {
    const s = document.createElement('canvas');
    s.width = 96; s.height = Math.max(1, Math.round(im.height * (96 / im.width)));
    const sg = s.getContext('2d', { willReadFrequently: true });
    sg.drawImage(im, 0, 0, s.width, s.height);
    const d = sg.getImageData(0, 0, s.width, s.height).data;
    const l = [];
    for (let i = 0; i < d.length; i += 4) l.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
    l.sort((a, b) => a - b);
    return { p50: +l[l.length >> 1].toFixed(4), p95: +l[Math.floor(l.length * 0.95)].toFixed(4) };
  };
  const luma = [];

  return Promise.all(D.panels.map((p) => new Promise((res) => {
    const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + p.b64;
  }))).then((imgs) => {
    imgs.forEach((im, i) => {
      luma.push(lumaOf(im));
      const p = D.panels[i];
      const cx = (i % cols) * PW;
      const cy = HEAD + Math.floor(i / cols) * PH;
      g.drawImage(im, 0, 0, im.width, im.height, cx, cy, PW, PH);

      // Trail: every tick up to this panel, tip and hips.
      for (const [bone, col, r] of [[D.tip, '#ff9e2c', 2.6], ['hips', '#4fd8e8', 2.0]]) {
        const pts = D.track.filter((s) => s.clock <= p.want && s.screen && s.screen[bone])
          .map((s) => toPanel(s.screen[bone], cx, cy));
        if (pts.length < 2) continue;
        g.strokeStyle = col; g.lineWidth = 1.6; g.globalAlpha = 0.85;
        g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
        for (const q of pts.slice(1)) g.lineTo(q[0], q[1]);
        g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = col;
        for (const q of pts) { g.beginPath(); g.arc(q[0], q[1], r, 0, 6.284); g.fill(); }
      }

      const isContact = D.contact != null && p.want === D.contact;
      g.strokeStyle = isContact ? '#ff9e2c' : 'rgba(255,255,255,.09)';
      g.lineWidth = isContact ? 3 : 1;
      g.strokeRect(cx + 1.5, cy + 1.5, PW - 3, PH - 3);

      g.fillStyle = 'rgba(0,0,0,.72)';
      g.fillRect(cx, cy, isContact ? 132 : 72, 22);
      g.fillStyle = isContact ? '#ff9e2c' : '#4fd8e8';
      g.font = '700 13px ui-monospace, monospace';
      g.fillText(`t${p.want}${isContact ? '  CONTACT' : ''}`, cx + 7, cy + 16);

      // What the animator was ACTUALLY doing. A panel that quietly shows a
      // different clip is the failure mode this line exists to make impossible.
      const s = p.s || {};
      const wrong = s.clip !== D.info.clip;
      g.fillStyle = 'rgba(0,0,0,.72)';
      g.fillRect(cx, cy + PH - 20, PW, 20);
      g.fillStyle = wrong ? '#ff6b8a' : '#6b8299';
      g.font = '500 11px ui-monospace, monospace';
      g.fillText(`${s.clip || '(none)'} @${s.animTime} · ${s.state || '?'}`
        + (p.got !== p.want ? `  LANDED ${p.got}` : ''), cx + 6, cy + PH - 6);
    });

    // --- kinetic chain plot ------------------------------------------------
    const py = HEAD + rows * PH;
    g.fillStyle = '#070a0f';
    g.fillRect(0, py, W, PLOT);
    g.fillStyle = '#9fb0c4';
    g.font = '600 13px ui-monospace, monospace';
    g.fillText('per-tick speed, each link normalised to its own peak — "the hips lead, the head lags"',
      12, py + 18);

    const L = 46, R = W - 340, T = py + 32, B = py + PLOT - 26;
    const clocks = D.track.map((s) => s.clock);
    const c0 = Math.min.apply(null, clocks), c1 = Math.max.apply(null, clocks);
    const X = (c) => L + ((c - c0) / Math.max(1e-6, c1 - c0)) * (R - L);
    g.strokeStyle = '#1b232e'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(L, B); g.lineTo(R, B); g.stroke();
    g.strokeStyle = '#141b24';
    g.beginPath(); g.moveTo(L, T); g.lineTo(R, T); g.stroke();
    g.fillStyle = '#3f4d5c'; g.font = '500 10px ui-monospace, monospace';
    g.fillText("each link's own peak", L + 4, T - 3);

    if (D.contact != null) {
      g.strokeStyle = '#ff9e2c'; g.setLineDash([4, 4]); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(X(D.contact), T); g.lineTo(X(D.contact), B); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ff9e2c'; g.font = '600 11px ui-monospace, monospace';
      g.fillText('contact', X(D.contact) + 4, T + 10);
    }

    const peaks = [];
    D.links.forEach((bone, k) => {
      const rowsOf = D.track.filter((s) => s.world && s.world[bone]);
      if (rowsOf.length < 3) return;
      const sp = [];
      for (let i = 1; i < rowsOf.length; i++) {
        const a = rowsOf[i - 1].world[bone], b = rowsOf[i].world[bone];
        const dt = Math.max(1, rowsOf[i].clock - rowsOf[i - 1].clock);
        sp.push({ c: rowsOf[i].clock,
          v: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / dt });
      }
      const mx = Math.max.apply(null, sp.map((s) => s.v));
      if (!(mx > 1e-6)) return;
      const col = PAL[k % PAL.length];
      g.strokeStyle = col; g.lineWidth = 1.8; g.globalAlpha = 0.95;
      g.beginPath();
      sp.forEach((s, i) => {
        const x = X(s.c), y = B - (s.v / mx) * (B - T);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.stroke();
      g.globalAlpha = 1;
      // The peak that goes in the legend is the peak WITHIN THE DRIVE WINDOW.
      // See chainStats: on this move the hips peak again in the recovery, and a
      // whole-move peak makes the chain look like it fires backwards.
      const drive = D.contact != null ? sp.filter((s) => s.c <= D.contact) : sp;
      const pk = (drive.length ? drive : sp).reduce((a, b) => (b.v > a.v ? b : a), (drive.length ? drive : sp)[0]);
      peaks.push({ bone, c: pk.c, col, mx });
      g.fillStyle = col;
      g.beginPath(); g.arc(X(pk.c), B - (pk.v / mx) * (B - T), 4, 0, 6.284); g.fill();
    });

    // Legend, ordered BY PEAK TICK rather than by bone, so the reading order of
    // the legend is the order the chain actually fires in. If the tip is above
    // the hips in this list, the strike does not drive from the floor up.
    peaks.sort((a, b) => a.c - b.c);
    g.font = '600 12px ui-monospace, monospace';
    peaks.forEach((p, i) => {
      const y = T + 6 + i * 17;
      g.fillStyle = p.col;
      g.fillRect(R + 18, y - 8, 10, 10);
      g.fillText(`${p.bone}  peak t${p.c}  ${(p.mx * 60).toFixed(2)} m/s`, R + 34, y + 1);
    });
    g.fillStyle = '#6b8299'; g.font = '500 11px ui-monospace, monospace';
    g.fillText(D.contact != null ? 'peak order within 0..contact (top = first)'
      : 'peak order (top = first)', R + 18, T - 4);
    g.fillText(`tick ${c0}`, L, B + 16);
    g.fillText(`tick ${c1}`, R - 46, B + 16);

    return { url: cv.toDataURL('image/jpeg', 0.88), luma };
  });
}

const SHOTS = [
  {
    name: '01-hero-idle',
    note: 'Default fight framing, both fighters idle. The baseline look.',
    setup: `window.KB.debug.freecam=false; window.KB.setPhase('fight');`,
    settle: 1600,
  },
  {
    name: '02-closeup-face',
    note: 'Head/chest closeup — material, panel, and emissive detail.',
    // This shot used to hand the framing to `fightCamera.cinematic('closeup')`
    // at 1.15 m, and it could not be trusted to photograph its own subject.
    // 1.15 m from the head bone is *inside* the pauldron sweep on a heavy
    // chassis, so whether the head was visible at all depended on where the
    // idle happened to be in its cycle — one run photographed a shoulder with
    // the head fully hidden while the previous round's run had it in clear
    // view. It also left the depth-of-field plane wherever the fight rig had
    // last put it, so the subject was intermittently the out-of-focus object
    // in its own closeup. Character has been partly scored on that noise.
    //
    // So: park the camera outright rather than asking the rig for a framing,
    // pull back to 1.35 m to clear the pauldron, republish `cameraFocus` on
    // the head so the bokeh plane lands on the subject, pause the sim so TAA
    // has a still frame to converge on, and then *verify* — raycast from the
    // camera to the head and report what the lens can actually see. The
    // assertion is the point: a harness that silently photographs the wrong
    // thing is worse than one that fails.
    setup: `(() => {
      const KB = window.KB, THREE = KB.THREE, f = KB.fighters[0], cam = KB.camera;
      let head = null;
      f.robot.group.traverse((o) => { if (o.isBone && /head/i.test(o.name) && !head) head = o; });
      if (!head) throw new Error('no head bone');
      const t = head.getWorldPosition(new THREE.Vector3());
      const D = 1.35, face = f.facing || 1;
      // Slightly above eye line and looking down: the fight stance holds both
      // fists up near the chin, and from a level three-quarter they eat the
      // bottom half of a shot that is supposed to be about the head.
      const pos = new THREE.Vector3(t.x + face * D * 0.70, t.y + D * 0.30, t.z + D * 0.55);
      const dist = pos.distanceTo(t);
      // The HUD is not the subject here, and at this crop it covers the head.
      const hud = document.getElementById('ui');
      if (hud) { window.__kbCloseupHud = hud.style.visibility; hud.style.visibility = 'hidden'; }
      const park = () => {
        cam.position.copy(pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(t.x, t.y - D * 0.04, t.z);
        // Long lens rather than a closer camera: it fills the frame with the
        // head without pushing the near plane back inside the shoulder armour.
        cam.fov = 24; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
        KB.bus.emit('cameraFocus', { center: t.clone(), radius: 0.45, distance: dist,
          nearRange: Math.max(0.2, dist * 0.5), farRange: dist * 2.2 });
      };
      // Keep the parked framing across the settle window: the rig integrates
      // off the render loop, which \`KB.paused\` does not stop.
      window.__kbCloseupRestore = { render: KB.fightCamera.render, simulate: KB.fightCamera.simulate };
      KB.fightCamera.render = park;
      KB.fightCamera.simulate = () => {};
      park();

      // Occlusion check: what does the camera hit first on the way to the head?
      const ray = new THREE.Raycaster(pos, t.clone().sub(pos).normalize(), 0.01, dist * 1.4);
      const hits = ray.intersectObject(f.robot.group, true).filter((h) => h.object.visible);
      const first = hits[0];
      const clear = !first || first.distance > dist - 0.22;
      // POSE SIGNATURE — measurement only, no behaviour change.
      //
      // This shot is not reproducible run to run (docs/PROFILING.md trap 5) and
      // the signature is what finally localised it. Camera and exposure are
      // provably identical between runs -- same dist to three decimals, median
      // luma within 1% -- while whole-frame pixels differ by a mean 24/255. The
      // variance is entirely in the POSE, and it survives pinning the sim
      // clock, using an absolute phase origin, and pausing on the exact tick
      // inside a single page-side callback: 13-30mm of bone drift AT AN
      // IDENTICAL phaseTick. At this framing (about 2000 px/m) 30mm is fifty
      // pixels.
      //
      // That rules out timing and points at per-tick state that startMatch does
      // not reset -- animator blend/inertialization history, or the eight
      // spring leaves, which integrate with damping and carry history from
      // before the restart. Recording the signature so the next attempt can
      // tell in one run whether it fixed the pose or merely moved it.
      const sig = [];
      for (const bn of ['head', 'chest', 'hand_L', 'hand_R', 'foot_L', 'foot_R']) {
        let bone = null;
        f.robot.group.traverse((o) => { if (o.isBone && o.name === bn && !bone) bone = o; });
        if (bone) {
          const w = bone.getWorldPosition(new THREE.Vector3());
          sig.push(+w.x.toFixed(3), +w.y.toFixed(3), +w.z.toFixed(3));
        }
      }
      window.__kbCloseup = { clear, blocker: first ? first.object.name || '(unnamed)' : null,
        gap: first ? +(dist - first.distance).toFixed(3) : null, dist: +dist.toFixed(3), pose: sig };
      return window.__kbCloseup;
    })()`,
    pinTicks: 150,
    settle: 2500,
    teardown: `(() => {
      const r = window.__kbCloseupRestore;
      if (r) { window.KB.fightCamera.render = r.render; window.KB.fightCamera.simulate = r.simulate; }
      const hud = document.getElementById('ui');
      if (hud) hud.style.visibility = window.__kbCloseupHud || '';
      window.KB.paused = false;
    })()`,
    verify: '__kbCloseup',
  },
  {
    name: '03-full-body',
    note: 'Full-body three-quarter — silhouette and proportion read.',
    setup: `window.KB.fightCamera.cinematic('portrait', { target: window.KB.fighters[0], dist: 4.2, yaw: 0.6 });`,
    reassert: `window.KB.fightCamera.cinematic('portrait', { target: window.KB.fighters[0], dist: 4.2, yaw: 0.6 });`,
    // Wait for the rig to CONVERGE, not for a fixed delay. The camera spring
    // starts from wherever the previous shot left it -- after the 1.3m closeup
    // it has 3m to travel -- so a flat settle photographed the subject at 35%
    // of frame height in one run and 82% in another, from identical code.
    // The wait and the self-check share one measurement on purpose: round 14's
    // banner shot failed because its check rested on the same wrong assumption
    // as its wait, so it could not catch its own failure.
    waitFor: `(${PORTRAIT_MEASURE}).subjectHeightFrac > 0.45`,
    settle: 500,
    verify: `(() => {
      const m = ${PORTRAIT_MEASURE};
      return { ...m, ok: m.dist < 6.5 && m.subjectHeightFrac > 0.45 };
    })()`,
  },
  {
    name: '04-impact',
    note: 'The contact frame itself — sparks, flash, hitstop, camera punch.',
    // Impact FX live 160-300ms. A fixed settle delay photographs the aftermath,
    // not the impact, so this shot arms a bus listener and freezes the frame the
    // hit actually lands. `impactOffset` then steps a precise number of ticks
    // past contact. See docs/CRITIC.md — earlier impact scores were measured on
    // frames taken after every spark had already died.
    setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    verify: '__kbHit',
    freezeOnHit: true,
    impactOffset: 1,
    settle: 0,
  },
  {
    name: '04b-impact-decay',
    note: 'Eight ticks past contact — spark travel, ember fall, debris arc.',
    setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    verify: '__kbHit',
    freezeOnHit: true,
    impactOffset: 8,
    settle: 0,
  },
  {
    name: '05-juggle',
    note: 'Airborne juggle — pose readability off the ground.',
    preRoll: true,
    preRoll: true,
    setup: `window.KB.testHarness.forceJuggle({ attacker: 0, hits: 3 });`,
    // Wait for the combo to actually reach the air hits, then freeze so the
    // shutter lands on the juggle rather than on the recovery after it.
    // Wait for the victim to actually be OFF THE GROUND, not merely for the
    // hit count. The first version gated on hits alone and accepted the
    // `airborne` FLAG as proof of height -- so it certified a frame in which
    // the victim stood with both feet planted and ground dust at his foot,
    // which a critic then reported as a launch regression. The flag can be
    // true on the tick the launch is applied, before any height exists.
    waitFor: 'window.__kbHitCount >= 2 && window.KB.fighters[1].position.y > 0.6',
    settle: 120,
    verify: `(() => {
      const KB = window.KB;
      const airborne = KB.fighters[1].airborne || KB.fighters[1].position.y > 0.25;
      KB.paused = true;
      return { hits: window.__kbHitCount || 0, victimY: +KB.fighters[1].position.y.toFixed(2),
               airborne, ok: (window.__kbHitCount || 0) >= 2 && KB.fighters[1].position.y > 0.6 };
    })()`,
    teardown: 'window.KB.paused = false;',
  },
  {
    name: '06-stage-wide',
    note: 'Wide arena — environment, lighting, and depth cues.',
    setup: `window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 });`,
    reassert: `window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 });`,
    settle: 1200,
    verify: `(() => {
      const KB = window.KB, cam = KB.camera, THREE = KB.THREE;
      const mid = KB.fighters[0].position.clone().add(KB.fighters[1].position).multiplyScalar(0.5);
      const dist = +cam.position.distanceTo(mid).toFixed(2);
      return { dist, height: +cam.position.y.toFixed(2), ok: dist > 9 };
    })()`,
  },
  {
    name: '07-super',
    note: 'Overdrive/super cinematic — the money shot.',
    // Was a bare 1500 ms settle, which is the same failure this file already
    // documents for 04-impact: it photographed the charge pose with the
    // opponent standing there unreacting, i.e. the wind-up rather than the
    // super. Wait for the blow to actually land, then hold for the cinematic.
    preRoll: true,
    setup: `window.KB.testHarness.forceSuper({ attacker: 0 });`,
    waitFor: 'window.__kbShotHit',
    settle: 700,
    verify: '__kbShotHit',
  },
  {
    name: '08-hud',
    note: 'Full frame with HUD — the actual play-view composition.',
    setup: `window.KB.setPhase('fight'); window.KB.fighters[1].health = 62; window.KB.fighters[0].meter = 84;`,
    settle: 900,
  },
  {
    name: '08b-hud-motion',
    note: 'HUD easing across 20 ticks after damage lands — bar drain, chip layer, combo slam.',
    // The same failure the impact shot had: a still cannot show easing, so any
    // claim about the drain layer or the combo counter's entry is unmeasured.
    // This tiles the ticks where the motion actually happens.
    setup: `window.KB.setPhase('fight'); window.KB.fighters[0].meter = 84;
            window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    // Wait for the blow to actually land before the strip starts counting, or
    // the offsets are measured from shot start and the "ticks after damage"
    // caption is fiction. The shot flags itself when this fails, but flagging
    // an unusable sheet is worse than waiting 6 seconds for a usable one.
    waitFor: 'window.__kbShotHit',
    tickStrip: [1, 4, 10, 20, 34],
    settle: 0,
  },
  {
    name: '09-roster',
    note: 'All characters lined up — silhouette variety across the cast.',
    // The fight HUD has no business over a roster lineup: health bars, a timer and
    // ROUND 1 were being composited across a shot that exists to judge the cast.
    setup: `(() => {
      const hud = document.getElementById('ui');
      if (hud) { window.__kbRosterHud = hud.style.visibility; hud.style.visibility = 'hidden'; }
      return window.KB.testHarness.rosterLineup();
    })()`,
    teardown: `(() => {
      const hud = document.getElementById('ui');
      if (hud) hud.style.visibility = window.__kbRosterHud || '';
    })()`,
    // NOT pose-pinned. Measured: the pin makes this shot WORSE, 3.2/255 -> 8.6-13.4,
    // because rosterLineup builds its own animators and warms each by a fixed tick
    // count, so the lineup was already deterministic -- and the pin's startMatch
    // resets the fighters, not the lineup, adding variance instead of removing it.
    // Prove no fighter is standing in the rig's rest pose.
    verify: `(() => {
      const KB = window.KB, THREE = KB.THREE;
      let tpose = 0, n = 0;
      KB.scene.traverse((o) => {
        if (!o.name || !o.name.startsWith('lineup_')) return;
        n++;
        let l = null, r = null, h = null;
        o.traverse((b) => {
          if (!b.isBone) return;
          if (b.name === 'hand_L') l = b; else if (b.name === 'hand_R') r = b;
          else if (b.name === 'head') h = b;
        });
        if (!l || !r || !h) return;
        const pl = l.getWorldPosition(new THREE.Vector3());
        const pr = r.getWorldPosition(new THREE.Vector3());
        const ph = h.getWorldPosition(new THREE.Vector3());
        // A T-pose puts both hands level with the head and far out to the sides.
        const wide = Math.abs(pl.x - pr.x) > 1.5 || Math.abs(pl.z - pr.z) > 1.5;
        const level = Math.abs(pl.y - ph.y) < 0.28 && Math.abs(pr.y - ph.y) < 0.28;
        if (wide && level) tpose++;
      });
      // How much of the frame the cast actually occupies. A critic measured the
      // old lineup at ~19% of frame height and concluded "you cannot assess
      // character rendering, or even silhouette variety, from it" -- so the
      // shot now has to prove the cast is big enough to judge.
      let tallest = 0;
      KB.scene.traverse((o) => {
        if (!o.name || !o.name.startsWith('lineup_')) return;
        const b = new THREE.Box3().setFromObject(o);
        const c = b.getCenter(new THREE.Vector3());
        const top = new THREE.Vector3(c.x, b.max.y, c.z).project(KB.camera);
        const bot = new THREE.Vector3(c.x, b.min.y, c.z).project(KB.camera);
        tallest = Math.max(tallest, Math.abs(top.y - bot.y) / 2);
      });
      const heightFrac = +tallest.toFixed(3);
      return { fighters: n, restPose: tpose, castHeightFrac: heightFrac,
               ok: n > 0 && tpose === 0 && heightFrac > 0.35 };
    })()`,
    settle: 1600,
  },
  {
    name: '10-ko',
    wantsBanner: true,
    note: 'KO slow-motion moment — the dramatic beat.',
    // The shot named for the KO did not contain one. `forceKO` drops the loser
    // to 6 HP and arms a heavy, but nothing waited for the blow to land, so a
    // fixed 1800 ms settle photographed two upright fighters at near-full
    // health with the timer at 43 and the K.O. announcement yet to fire. The
    // interface axis was scored partly on the absence of a beat that simply
    // had not happened yet. Wait for the health to actually reach zero.
    preRoll: true,
    // Re-arm until the round actually ends, rather than firing once and hoping.
    // A single `forceKO` is not reliable: whether the armed heavy connects
    // depends on what the *previous* shot left the fighters doing — a preceding
    // shot that re-enters the fight phase restarts the round intro, and the
    // blow is thrown into an intro pose. Alone the shot passed, in a full run
    // it silently produced a non-KO, and that asymmetry is exactly why it went
    // unnoticed for several rounds. Retrying is honest here: the shot's job is
    // to photograph a KO, so it should keep trying to cause one and say so if
    // it cannot.
    setup: `(() => {
      let tries = 0;
      const arm = () => {
        if (window.KB.phase === 'ko' || tries >= 8) return;
        tries++;
        window.KB.testHarness.forceKO({ loser: 1 });
        window.__kbKoTries = tries;
        setTimeout(arm, 700);
      };
      arm();
    })()`,
    // Gate on the phase the game actually enters. There is no 'ko' bus event --
    // the round ends via 'roundEnd' and Game moves to PHASE.KO -- so a listener
    // for one was watching for something that does not exist.
    waitFor: "window.KB.phase === 'ko'",
    settle: 900,
    // Assert the ANNOUNCEMENT, not just the KO.
    //
    // This shot declared wantsBanner: true and then checked nothing about the
    // banner, so it could -- and did -- silently photograph a knockout with no
    // K.O. announcement on screen at all, while an earlier capture of the same
    // shot had it. A teammate caught the discrepancy between two of their own
    // runs. wantsBanner exempts a shot from the "no banner over this frame"
    // rule; on its own that is a licence, not a check.
    verify: `(() => {
      const ko = window.__kbKo;
      if (!ko) return null;
      const b = document.querySelector('.announce-banner');
      const inner = document.querySelector('.announce-inner');
      const r = inner ? inner.getBoundingClientRect() : { width: 0, height: 0 };
      const opacity = b ? +parseFloat(getComputedStyle(b).opacity).toFixed(2) : 0;
      const kind = b ? b.dataset.kind : null;
      return { ...ko, bannerKind: kind, bannerOpacity: opacity,
               ink: [Math.round(r.width), Math.round(r.height)],
               ok: kind === 'ko' && opacity >= 0.5 && r.width >= 40 };
    })()`,
    prep: `window.__kbKo = null;
      (() => { const s = window.KB.bus.on('roundEnd', (e) => {
        window.__kbKo = { winner: e.winner, loserHealth: window.KB.fighters[1].health }; s(); }); })();`,
  },
  {
    name: '12-select-screen',
    note: 'Character select — roster tiles, portraits and the responsive grid.',
    // The interface critic could not score three of the four announcement and
    // menu surfaces on this axis because they were never captured; it refused
    // to score the select screen rather than guess, and the axis lost points
    // for the coverage gap. If a surface is judged, it has to be photographed.
    setup: `window.KB.setPhase('select'); window.KB.menus.show('select');`,
    settle: 1400,
  },
  {
    name: '18-skydeck-wide',
    note: 'Rooftop arena, wide — the open-sky light structure the pit cannot produce.',
    // A new arena that nobody photographs is worth nothing. Round 15 built a
    // 14-segment emissive board where neither scored frame could see it, and it
    // read as shipped while contributing zero pixels. These two shots exist so
    // the stage and lighting critics score the new venues at all.
    preRoll: true,
    setup: `(async () => { await window.KB.stage.setArena('skydeck');
      window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 }); })()`,
    reassert: `window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 });`,
    settle: 2200,
    verify: `(() => {
      // Stage keeps the resolved definition on .arena, not an id string.
      const id = window.KB.stage?.arena?.id ?? null;
      return { arena: id, ok: id === 'skydeck' };
    })()`,
  },
  {
    name: '19-cistern-wide',
    note: 'Vault arena, wide — no sky, hard emissive strips, steep falloff.',
    preRoll: true,
    setup: `(async () => { await window.KB.stage.setArena('cistern');
      window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 }); })()`,
    reassert: `window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 });`,
    settle: 2200,
    verify: `(() => {
      const id = window.KB.stage?.arena?.id ?? null;
      return { arena: id, ok: id === 'cistern' };
    })()`,
    // Put the pit back, so every later shot is captured in the arena the rest
    // of the shot list assumes. AWAITED: `setArena` is async and rebuilds the
    // whole stage, and an un-awaited rebuild does not stay inside this shot --
    // it starves the next one's main thread for over a second. See the teardown
    // wrapper for the measurement.
    teardown: `await window.KB.stage.setArena('sublevel09');`,
  },
  {
    name: '13-announce-fight',
    wantsBanner: true,
    note: 'Round-start announcement — a motion-design surface, in flight.',
    // One of four announcement surfaces on the interface axis, three of which
    // were never captured. The critic's words: "per CRITIC.md I cannot pass
    // what I have not seen rendered, so coverage loss translates directly into
    // a lower score." Every other shot waits for this banner to CLEAR; this one
    // waits for it to be up.
    //
    // Do NOT gate on `.announce-text` textContent. It is always ''. Typeface's
    // applyKbText renders each word as three mask-image layers over an SVG
    // glyph path, so the element has no text nodes at any point in the banner's
    // life — the same mask-layer construction behind the round-12 "IVULKAN"
    // bug. A first version of this shot gated on textContent, waited out
    // silently every time, and shuttered wherever the 1.5s animation happened
    // to be. Caught by a teammate reading the frame rather than the log.
    // `announce--run` and `data-kind` are set by HUD#advanceAnnounceQueue when
    // the banner actually starts, so they are honest.
    preRoll: true,
    /*
     * FORCE A GENUINELY FRESH BANNER, because this shot cannot catch a stale one.
     *
     * In isolation the setup below produced opacity 1.00. In the FULL run it
     * failed twice, at opacity 0.49 and then 0.00, and the reason is
     * `#queueAnnounce`'s repeat-collapse guard: if the same kind and text are
     * already queued or already on screen, the call returns and nothing new
     * fires. By this point in a 25-shot run a FIGHT banner has already played,
     * so re-entering the phase re-announced nothing and the wait was left
     * looking at the corpse of an earlier banner as it faded.
     *
     * Clearing the queue and the busy flag first makes the announcement this
     * shot is named for actually happen, rather than hoping the run has left
     * one in flight. Worth stating because it is the third defect in this shot
     * of the same family: gating on state that was supposed to imply the
     * pixels, instead of on the pixels.
     */
    /*
     * LATCH THE BANNER ON ITS HOLD BEAT, IN THE PAGE, BEFORE IT STARTS.
     *
     * The wait below asks for opacity >= 0.85, which is only true during the
     * 1.24s hold. That was still a race, and it lost: this shot came back
     * `opacity 0.00` in a full run whose fps was a healthy 60.2, so contention
     * was not the cause. Measured with a per-frame sampler around the arena
     * rebuild that precedes this shot: THE MAIN THREAD STALLS FOR UP TO 1.83s
     * IN ONE UNBROKEN rAF GAP. The hold is 1.24s. One starvation gap is
     * therefore wider than the entire window the wait is hunting for, so the
     * driver can go from "not started" to "already faded out" without a single
     * poll landing inside the hold -- and `waitFor` polls on rAF, the very
     * thing being starved. Whether it passes is alignment, not correctness,
     * which is why it survived several rounds and two isolation reruns.
     *
     * Waiting harder cannot fix a window narrower than the blind spot. So the
     * banner is stopped ON the beat instead of chased through it: this watcher
     * runs in the page off rAF, and the moment the FIGHT announcement starts it
     * kills the three phase timers and clamps `data-phase` to `hold`. Opacity
     * then stays 1 until the teardown releases it, the wait cannot miss it, and
     * the frame is pinned to exactly the beat the shot is named for -- the one
     * the CSS notes call "the beat the word is read on".
     *
     * Same principle as `pinTicks` for poses: freeze the subject rather than
     * time the shutter. `animationend` for announceIn still fires into
     * `#announcePhase('hold')`, which is idempotent and already the state we
     * set, so latching does not fight the HUD's own machine.
     */
    prep: `(() => {
      window.__kbBannerPinned = false;
      const watch = () => {
        const h = window.KB.hud, b = h && h.announceBanner;
        if (b && b.dataset.kind === 'fight' && b.classList.contains('announce--run')) {
          for (const t of h.announceTimers) clearTimeout(t);
          h.announceTimers.length = 0;
          b.dataset.phase = 'hold';
          window.__kbBannerPinned = true;
          return;
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    })()`,
    setup: `(() => {
      const h = window.KB.hud;
      if (h) {
        h.announceQueue = [];
        h.announceBusy = false;
        const b = h.announceBanner;
        if (b) { b.classList.remove('announce--run'); b.dataset.kind = ''; }
      }
      window.KB.startMatch(0, 1);
      window.KB.setPhase('ready');
      window.KB.setPhase('fight');
    })()`,
    /*
     * GATE ON THE OPACITY ITSELF, NOT ON A DELAY MEASURED FROM THE START.
     *
     * This waited for `announce--run` and then shuttered a fixed 600ms later,
     * on the reasoning that the banner holds legibly from ~26% to ~78% of its
     * 1.5s run. But `waitFor` POLLS, so the moment it returns is already an
     * unknown distance into the animation, and 600ms after that lands wherever
     * it lands. It failed twice in a row with different values -- opacity 0.49,
     * then 0.00, the banner fully faded -- which is a race, not a flake.
     *
     * The fix is the same lesson this harness keeps relearning: wait for the
     * QUANTITY YOU CARE ABOUT to be true, rather than for a clock that is
     * supposed to imply it. The frame check already measures opacity at the
     * shutter; now the wait measures it too, so the two cannot disagree.
     */
    waitFor: `(() => {
      const b = document.querySelector('.announce-banner');
      if (!b || !b.classList.contains('announce--run') || b.dataset.kind !== 'fight') return false;
      return parseFloat(getComputedStyle(b).opacity) >= 0.85;
    })()`,
    // Small, and only to let the frame after the opacity check actually paint.
    settle: 90,
    // Measure the pixels, not the state that was supposed to produce them.
    verify: `(() => {
      const b = document.querySelector('.announce-banner');
      const inner = document.querySelector('.announce-inner');
      if (!b || !inner) return null;
      const r = inner.getBoundingClientRect();
      const opacity = +parseFloat(getComputedStyle(b).opacity).toFixed(2);
      return { kind: b.dataset.kind, opacity, pinned: !!window.__kbBannerPinned,
               ink: [Math.round(r.width), Math.round(r.height)],
               ok: opacity >= 0.5 && r.width >= 40 };
    })()`,
    /*
     * RELEASE THE LATCH. Not optional.
     *
     * The pin above kills the timer that would have called
     * `#advanceAnnounceQueue`, and that call is the only thing that ever sets
     * `announceBusy` back to false. Leaving it latched strands the HUD as
     * permanently busy, and `NO_BANNER` -- which every `preRoll` shot after this
     * one waits on -- is exactly `!busy && queue empty`. So a pin without a
     * release does not damage this shot at all; it silently converts the NEXT
     * shot's preRoll into a 15s timeout and a 'round-start banner never cleared'
     * defect. That is the same shape as the round-26 renderScale regression:
     * a change that fixes its own measurement and breaks its neighbour's.
     */
    teardown: `(() => {
      const h = window.KB.hud; if (!h) return;
      for (const t of h.announceTimers) clearTimeout(t);
      h.announceTimers.length = 0;
      h.announceQueue = [];
      h.announceBusy = false;
      const b = h.announceBanner;
      if (b) {
        b.classList.remove('announce--run');
        b.removeAttribute('data-phase');
        b.dataset.kind = '';
      }
      window.__kbBannerPinned = false;
    })()`,
  },
  {
    name: '14-victory',
    note: 'Match-end victory pose — the fourth announcement surface.',
    // Win the deciding round: put the winner one round up, then keep arming a
    // killing blow until the match ends. Same reasoning as 10-ko — one forced
    // KO is not reliable, because whether it connects depends on what state the
    // previous shot left the fighters in.
    preRoll: true,
    setup: `(() => {
      window.KB.wins[0] = 1; window.KB.wins[1] = 0;
      let tries = 0;
      const arm = () => {
        // Stop the moment the round ends, not just the match: forceKO calls
        // stage(), which re-enters the fight phase, so a retry fired after the
        // KO lands cancels the very sequence being waited for.
        const p = window.KB.phase;
        if (p === 'matchEnd' || p === 'ko' || p === 'roundEnd' || tries >= 8) return;
        tries++;
        window.KB.testHarness.forceKO({ loser: 1 });
        setTimeout(arm, 700);
      };
      arm();
    })()`,
    waitFor: "window.KB.phase === 'matchEnd'",
    settle: 1600,
    verify: '__kbWin',
    prep: `window.__kbWin = null;
      (() => { const s = window.KB.bus.on('matchEnd', (e) => { window.__kbWin = { winner: e.winner }; s(); }); })();`,
  },
  {
    name: '17-anim-strip',
    note: 'One attack across startup, contact and recovery — the motion the animation axis is scored on.',
    // The animation critic could not see its own axis: "capture the axis before
    // iterating on it... right now neither I nor the implementing agent can see
    // whether `whip` worked." Every animation frame in the shot list is a
    // single instant, and a still cannot show timing -- which is exactly why a
    // round of measured re-timing work landed as "nothing visible". Same
    // reasoning that produced 08b-hud-motion for the HUD.
    //
    // Framed on the attacker rather than the pair, so limb arcs and weight
    // transfer are large enough to read.
    preRoll: true,
    setup: `(() => {
      const KB = window.KB, THREE = KB.THREE, a = KB.fighters[0];
      // forceHit stages the pair at the right distance but fast-forwards the
      // move to just before impact, so a strip armed after it can only ever
      // show contact and recovery. Restart the move from tick 0 on the already
      // staged pair to get the wind-up back -- the wind-up is half of what this
      // axis is scored on.
      KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });
      const mv = a.currentMove;
      if (mv) {
        // BOTH, not just startMove. TestHarness.armAtImpact drives the state
        // machine AND the animator; calling only startMove restarts the move
        // logic while the animator keeps playing whatever it was already
        // playing -- idle. The result was a strip in which the attacker stands
        // essentially motionless across all seven panels while the victim is
        // launched, and a critic template-tracked the pelvis at 6px of travel
        // with the sign inverted, against the ~39px the clip should give. That
        // was my defect in this shot, not the animation work it was built to
        // show.
        a.startMove(mv);
        if (a.animator && a.animator.play) a.animator.play(mv.clip, { blend: 0, loop: false });
      }
      // MEASUREMENT ONLY — nothing above this line changed, and this shot still
      // photographs exactly what it photographed last round, so the archive
      // comparison across rounds survives.
      //
      // The two calls above are startMove (which installs retimeFor(move))
      // followed by animator.play(clip, {blend, loop}) with no retime — and
      // Animator#play does top.retime = opts.retime || null, so the second
      // call throws the first one's retime away. This records what the entry
      // actually ends up with, so the claim is a measured fact in the manifest
      // rather than a reading of the source. 24-anim-uppercut is the same clip
      // captured with the retime intact; compare the two.
      (() => {
        const b = a.animator && a.animator.base;
        const e = b && b.entries.length ? b.entries[b.entries.length - 1] : null;
        const want = mv && a.animator ? (mv.retime ?? null) : null;
        window.__kbAnim17 = {
          clip: e ? e.clipId : null,
          retimeOnEntry: e && e.retime
            ? { pivot: e.retime.pivot, pivotAt: e.retime.pivotAt,
                inScale: +e.retime.inScale.toFixed(4), outScale: +e.retime.outScale.toFixed(4) }
            : 'NONE',
          retimeTheMoveDeclares: want
            ? { pivot: want.pivot, pivotAt: want.pivotAt,
                inScale: +want.inScale.toFixed(4), outScale: +want.outScale.toFixed(4) }
            : null,
          moveStartup: mv ? mv.startup : null,
          moveTotal: mv ? mv.total : null,
          stripCovers: [0, 26],
        };
      })();
      const t = a.position.clone(); t.y += 1.0;
      // Wide enough to hold both fighters and the floor under them: weight
      // transfer and airborne arcs are the axis, and neither reads if the
      // camera is inside the attacker's shoulder.
      const cam = KB.camera, D = 7.4, face = a.facing || 1;
      const mid = a.position.clone().add(KB.fighters[1].position).multiplyScalar(0.5);
      t.set(mid.x, a.position.y + 1.05, mid.z);
      const pos = new THREE.Vector3(t.x + face * D * 0.30, t.y + D * 0.20, t.z + D * 0.94);
      const park = () => {
        cam.position.copy(pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(t.x, t.y - 0.15, t.z);
        cam.fov = 32; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      };
      window.__kbAnimRestore = { render: KB.fightCamera.render, simulate: KB.fightCamera.simulate };
      KB.fightCamera.render = park;
      KB.fightCamera.simulate = () => {};
      park();
    })()`,
    // Offsets requested by the animation workstream, which measured the clip:
    // 15 and 20 straddled the contact tick (clip 16) and never photographed it,
    // and 34 was dead recovery. 6/10 catch the coil (deepest pelvis at clip t9),
    // 13 is the last frame a defender can act on, 16 is contact, 21/26 are the
    // flight and the landing.
    tickStrip: [0, 6, 10, 13, 16, 21, 26],
    stripCrop: 1,
    stripLabel: 'ticks from move start — startup, contact, recovery',
    settle: 0,
    teardown: `(() => {
      const r = window.__kbAnimRestore;
      if (r) { window.KB.fightCamera.render = r.render; window.KB.fightCamera.simulate = r.simulate; }
    })()`,
  },
  {
    name: '15-impact-light',
    note: 'A LIGHT hit at contact — the bottom of the weight ladder.',
    // The critic's complaint "no relationship between hit weight and effect
    // scale" was UNFALSIFIABLE from the captures, because every impact shot
    // used move:'launcher'. The shot list contained exactly one weight, while
    // HIT_FX spans 190 to 1150 sparks and 2.1 to 17.0 light intensity across
    // the ladder. An axis cannot be scored on a relationship nobody
    // photographed. Pair this with 04-impact (a launcher) to see the range.
    setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'jab' });`,
    verify: '__kbHit',
    freezeOnHit: true,
    impactOffset: 1,
    settle: 0,
  },
  {
    name: '16-impact-heavy',
    note: 'A HEAVY hit at contact — the top of the weight ladder.',
    // 1.35, not the 1.02 default: measured, the heavy (a roundhouse) whiffs at
    // close spacing and connects at 1.35. A shot that silently whiffs is how
    // "no hit landed" frames got scored for several rounds.
    setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'heavy', dist: 1.55 });`,
    verify: '__kbHit',
    freezeOnHit: true,
    impactOffset: 1,
    settle: 0,
  },

  // --- clip strips ---------------------------------------------------------
  // Four clips the axis has never been able to see, plus a corrected capture of
  // the one it is scored on. See the CLIP STRIPS block above for why the
  // instrument is what it is.
  {
    name: '20-anim-roundhouse',
    note: 'k.roundhouse across the whole 50-tick move at even 5-tick spacing — the heavy the '
      + 'diagnosis flagged for velocity sawtooth on the approach.',
    preRoll: true,
    settle: 0,
    clipStrip: {
      subject: 0, chars: [0, 1], drive: 'move', move: 'roundhouse', clip: 'k.roundhouse',
      step: 5, spacing: 3.4, dist: 7.4, aimY: 0.95, tip: 'foot_R',
      // Crop derived from a measured run's `bboxUnion`, not guessed: the bones
      // spanned 779..1257 x 195..839 across the twelve panels. Padded upward
      // because the bone box is not the silhouette -- the antenna and the pack
      // sit well above the topmost bone, and the first crop cut both off.
      rect: { x: 590, y: 0, w: 860, h: 1040 },
    },
  },
  {
    name: '21-anim-straight',
    note: 'p.straight across its whole 29-tick move at even 3-tick spacing — the canonical clip '
      + 'from the nine that peaked every link on a single tick.',
    preRoll: true,
    settle: 0,
    clipStrip: {
      subject: 0, chars: [1, 0], drive: 'move', move: 'straight', clip: 'p.straight',
      step: 3, spacing: 3.4, dist: 6.4, aimY: 0.95, tip: 'hand_R',
      rect: { x: 660, y: 0, w: 800, h: 1040 },
    },
  },
  {
    name: '22-anim-reaction-launch',
    note: 'r.launch on the VICTIM across the whole reaction — a different operator covers '
      + 'reactions and nothing has ever photographed one.',
    preRoll: true,
    settle: 0,
    clipStrip: {
      // The one strip that must connect: a reaction does not exist without a
      // cause. Clocked on the victim's own clip time rather than on the tick
      // counter, because hitstop stops ticks and would collapse the first
      // several panels onto one frozen pose.
      subject: 1, drive: 'forceHit', clip: 'r.launch',
      forceHit: { attacker: 0, move: 'launcher' },
      clock: 'anim', span: 30, step: 3, dist: 9.6, aimY: 1.35,
      ready: "window.KB.fighters[1].animator.current === 'r.launch'",
      tip: 'hand_R',
      // The victim travels LEFT across a camera that is not allowed to follow, and
      // how far varies run to run with the launch. Measured unions over three
      // runs: xmin 645, 520, 805. The crop is sized for the worst of those plus
      // room, because the alternative -- a camera that tracks him -- would
      // delete the very translation a launch reaction is judged on.
      rect: { x: 300, y: 0, w: 1020, h: 1040 },
    },
  },
  {
    name: '23-anim-run',
    note: 'loco.runFwd, one full 32-tick cycle at even 3-tick spacing, with the fighter translating '
      + 'across a static frame — locomotion is most of the screen time and no shot has contained it.',
    preRoll: true,
    settle: 0,
    clipStrip: {
      // Driven from the real keyboard through Input#commandsFor, not by poking
      // the animator: the fighter state machine re-asserts its own clip every
      // tick, so a poked locomotion clip is overwritten by idle within a frame.
      // That is documented in animstrip.mjs and was still wrong there — it is
      // only true of clips the state machine has no opinion about, and it has a
      // very strong opinion about which locomotion clip is playing.
      // `loco.runFwd`, not `loco.walkFwd`. Measured, not assumed: holding the
      // forward key through the real Input path puts the fighter in state
      // "walk" at 2.2 m/s playing `loco.runFwd`, and `loco.walkFwd` never
      // appears at all from a keyboard. The first version of this shot declared
      // walkFwd, waited 900 frames for a clip that cannot happen, and said so —
      // which is the readiness gate doing its job.
      subject: 0, chars: [4, 1], drive: 'hold', hold: 'KeyD', clip: 'loco.runFwd',
      clock: 'tick', span: 32, step: 3, spacing: 8.0, dist: 8.2, aimY: 0.95, aimFwd: 0.62,
      ready: "window.KB.fighters[0].animator.current === 'loco.runFwd'",
      tip: 'foot_R',
      // Wide, because the fighter covers about 1.2 m in one cycle and the
      // camera is not allowed to follow him. That translation is the evidence:
      // a locomotion clip is judged on whether the feet keep up with the ground
      // they are supposedly pushing against, and re-centring him every panel —
      // which is what `animstrip.mjs` does — deletes exactly that.
      rect: { x: 580, y: 20, w: 880, h: 960 },
    },
  },
  {
    name: '24-anim-uppercut',
    note: 'p.uppercut, RETIMED as the game plays it, across the whole 48-tick move — the same '
      + 'clip 17-anim-strip photographs, captured correctly. Compare the two.',
    preRoll: true,
    settle: 0,
    clipStrip: {
      subject: 0, chars: [7, 1], drive: 'move', move: 'straight3', clip: 'p.uppercut',
      step: 4, spacing: 3.4, dist: 7.0, aimY: 0.95, tip: 'hand_R',
      rect: { x: 640, y: 0, w: 800, h: 1040 },
    },
  },
];

/* ===========================================================================
 * THE EXPECTED-SHOT ROSTER.
 *
 * `complete` is derived by checking the written manifest against `SHOTS` — its
 * own list. So a shot that was never REGISTERED can never be reported missing.
 * Round 28 briefed a critic on `11-anim-roundhouse`, which has never been in
 * `SHOTS`; `git log -S` returns nothing for it, the only copy on disk was a
 * one-off from `tools/animstrip.mjs` dated before every animation edit of that
 * round, and the manifest was structurally incapable of saying so. Judging on
 * it would have judged round-20 work.
 *
 * That is the fifth defect of this exact class — c562242 (two runs sharing an
 * output directory), 965f3c7 (a crashed run leaving a successful-looking
 * manifest), a76cf17, 427b621 (a subset run certifying itself), and round 27's
 * dead canvas. The pattern every time is THE HARNESS CERTIFYING ITSELF AGAINST
 * ITS OWN ASSUMPTIONS, and the fix every time is to make the certificate a fact
 * derived from something outside the thing being certified.
 *
 * So the roster is a DECLARATION OF WHAT THE PROJECT EXPECTS TO EXIST, kept
 * deliberately apart from the implementation that produces it, and it is
 * checked three ways:
 *
 *   1. AT STARTUP, against `SHOTS`. A roster entry with no implementation is a
 *      hard exit before a single frame is taken — that is the never-registered
 *      case, and it now fails loudly instead of silently. A `SHOTS` entry
 *      missing from the roster also fails: an undeclared shot is drift.
 *   2. AT THE END, against THE DISK. Every roster entry must have a real file
 *      with a plausible byte count. This is the only check in the harness that
 *      does not consult the manifest or the shot list at all, so it survives
 *      both of them being wrong.
 *   3. ORPHANS. Any capture file in the directory that no roster entry claims
 *      is reported. That is how a stale frame from a previous round — the
 *      11-anim-roundhouse case exactly — gets named instead of being read as
 *      evidence.
 *
 * `min` is a floor on the delivered file size, not a quality gate. A 1080p PNG
 * of a lit scene does not come out under 500 KB; a contact sheet JPEG does not
 * come out under 120 KB. Both floors are far below anything healthy and exist
 * to catch a truncated or blank write, which is a failure mode this harness has
 * actually had.
 * ======================================================================== */
const ROSTER = [
  { name: '01-hero-idle', ext: 'png', min: 500e3, axis: 'stage, lighting, character' },
  { name: '02-closeup-face', ext: 'png', min: 500e3, axis: 'character' },
  { name: '03-full-body', ext: 'png', min: 500e3, axis: 'character' },
  { name: '04-impact', ext: 'png', min: 500e3, axis: 'impact' },
  { name: '04b-impact-decay', ext: 'png', min: 500e3, axis: 'impact' },
  { name: '05-juggle', ext: 'png', min: 500e3, axis: 'animation, impact' },
  { name: '06-stage-wide', ext: 'png', min: 500e3, axis: 'stage' },
  { name: '07-super', ext: 'png', min: 300e3, axis: 'impact, lighting' },
  { name: '08-hud', ext: 'png', min: 500e3, axis: 'interface' },
  { name: '08b-hud-motion', ext: 'jpg', min: 120e3, axis: 'interface' },
  { name: '09-roster', ext: 'png', min: 500e3, axis: 'character' },
  { name: '10-ko', ext: 'png', min: 500e3, axis: 'interface, impact' },
  { name: '12-select-screen', ext: 'png', min: 200e3, axis: 'interface' },
  { name: '13-announce-fight', ext: 'png', min: 500e3, axis: 'interface' },
  { name: '14-victory', ext: 'png', min: 500e3, axis: 'interface' },
  { name: '15-impact-light', ext: 'png', min: 500e3, axis: 'impact' },
  { name: '16-impact-heavy', ext: 'png', min: 500e3, axis: 'impact' },
  { name: '17-anim-strip', ext: 'jpg', min: 120e3, axis: 'animation' },
  { name: '18-skydeck-wide', ext: 'png', min: 500e3, axis: 'stage' },
  { name: '19-cistern-wide', ext: 'png', min: 500e3, axis: 'stage' },
  { name: '20-anim-roundhouse', ext: 'jpg', min: 120e3, axis: 'animation' },
  { name: '21-anim-straight', ext: 'jpg', min: 120e3, axis: 'animation' },
  { name: '22-anim-reaction-launch', ext: 'jpg', min: 120e3, axis: 'animation' },
  { name: '23-anim-run', ext: 'jpg', min: 120e3, axis: 'animation' },
  { name: '24-anim-uppercut', ext: 'jpg', min: 120e3, axis: 'animation' },
];

/**
 * Check 1: the roster and the implementation agree. Runs before the browser is
 * launched, because a harness that cannot produce what the project declares has
 * nothing worth capturing.
 * @returns {{undeclared:string[], unimplemented:string[]}}
 */
function auditRoster() {
  const impl = new Set(SHOTS.map((s) => s.name));
  const decl = new Set(ROSTER.map((r) => r.name));
  return {
    unimplemented: ROSTER.map((r) => r.name).filter((n) => !impl.has(n)),
    undeclared: SHOTS.map((s) => s.name).filter((n) => !decl.has(n)),
  };
}

/**
 * Refuse to share an output directory with another capture run.
 *
 * Two agents running this concurrently with the same --out interleave their
 * writes: one run's PNGs land beside another run's manifest, and because the
 * manifest is written last it CERTIFIES FRAMES IT DID NOT PRODUCE. That is
 * exactly what happened -- shots/13-announce-fight.png contained no banner
 * while the manifest beside it recorded kind "fight", opacity 1, ink 553x153
 * and defects []. The game was fine; a teammate replayed the shot's own gate
 * three times out of three and got the banner at that precise rect. A critic
 * then scored the interface axis down for a surface that renders correctly,
 * and nothing flagged it, because the certification was real -- just not of
 * that image.
 *
 * A stale lock is cleared rather than honoured: a killed run must not block the
 * harness for ever.
 */
const LOCK_STALE_MS = 20 * 60 * 1000;

function takeLock(dir) {
  const f = resolve(dir, '.capture-lock');
  if (existsSync(f)) {
    let age = Infinity;
    try { age = Date.now() - JSON.parse(readFileSync(f, 'utf8')).at; } catch { /* malformed: treat as stale */ }
    if (age < LOCK_STALE_MS) {
      console.error(`[capture] ANOTHER CAPTURE IS WRITING ${dir}.`);
      console.error('[capture] Two runs sharing one directory produce a manifest that certifies');
      console.error("[capture] frames it did not produce. Pass --out <your own dir>, or wait.");
      process.exit(2);
    }
    console.warn('[capture] clearing a stale capture lock');
  }
  writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const drop = () => { try { rmSync(f, { force: true }); } catch { /* already gone */ } };
  process.on('exit', drop);
  process.on('SIGINT', () => { drop(); process.exit(130); });
  return drop;
}

/**
 * Check 2 and 3: the roster against THE DISK.
 *
 * Deliberately reads the directory rather than the manifest or `SHOTS`. Both of
 * those are the run talking about itself; `readdirSync` is not. If the manifest
 * and the shot list were both wrong in the same way -- which is precisely what
 * "certifying itself against its own assumptions" means, and it has happened
 * five times -- this is the check that still notices.
 *
 * @param {string} dir
 * @param {string[]} attempted shot names this run actually tried to take
 * @returns {{missing:Array, undersized:Array, orphans:string[]}}
 */
function auditDisk(dir, attempted) {
  const seen = new Set();
  const missing = [];
  const undersized = [];
  for (const r of ROSTER) {
    const f = resolve(dir, `${r.name}.${r.ext}`);
    seen.add(`${r.name}.${r.ext}`);
    let st = null;
    try { st = statSync(f); } catch { /* absent */ }
    if (!st) { missing.push({ name: r.name, file: `${r.name}.${r.ext}`, attempted: attempted.includes(r.name) }); continue; }
    if (st.size < r.min) undersized.push({ name: r.name, bytes: st.size, floor: r.min });
  }
  const orphans = readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .filter((f) => !seen.has(f));
  return { missing, undersized, orphans };
}

async function main() {
  /*
   * THE ROSTER GATE, before anything is captured.
   *
   * A roster entry with no implementation is the never-registered case: the
   * project declares a shot, nothing produces it, and until now nothing could
   * say so -- `complete` compared the manifest against `SHOTS`, so a shot
   * missing from `SHOTS` was invisible to every check in the file. This exits
   * non-zero rather than warning, because a run whose evidence set is
   * structurally incomplete should not produce frames that look complete.
   */
  const audit = auditRoster();
  if (audit.unimplemented.length || audit.undeclared.length) {
    console.error('[capture] SHOT ROSTER MISMATCH — refusing to capture.');
    for (const n of audit.unimplemented) {
      console.error(`  DECLARED BUT NOT IMPLEMENTED: ${n} — the roster expects this shot and no `
        + 'entry in SHOTS produces it. This is the 11-anim-roundhouse defect: judging on a file '
        + 'of that name would judge whatever old run left it on disk.');
    }
    for (const n of audit.undeclared) {
      console.error(`  IMPLEMENTED BUT NOT DECLARED: ${n} — add it to ROSTER (with its extension `
        + 'and a size floor) so its absence can be detected in a later run.');
    }
    process.exit(3);
  }

  /*
   * A SUBSET RUN MUST NEVER WIPE THE SET.
   *
   * This used to be `if (!KEEP)`, so `--shots 07-super` deleted all twenty
   * captures and wrote one back. `shots/` is gitignored, so there is no undo,
   * and several agents share this tree -- one agent taking a quick single-shot
   * measurement silently destroyed another's certified set, which is how this
   * was found. A run that is only going to write one shot has no business
   * deleting the nineteen it will not rewrite.
   *
   * The complementary defect is already closed: a subset run can no longer
   * certify itself, because `complete` is derived from the shot list rather
   * than asserted. Together they mean a subset run leaves the other frames
   * intact AND cannot claim to have verified them.
   */
  if (!KEEP && !ONLY.length && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/`;

  /*
   * TAKE THE LOCK BEFORE LAUNCHING THE BROWSER, NOT AFTER.
   *
   * This used to sit below `newPage`, which leaves a window several seconds wide
   * -- the whole of `chromium.launch` -- in which two processes have both found
   * the directory unlocked and neither has written a lock. Two capture runs
   * started eight seconds apart walked straight through it and shared one output
   * directory for six minutes.
   *
   * That is the SECOND time two runs have shared an output directory here
   * (c562242 was the first, and this lock is what that commit added). The lock
   * was never wrong; its placement was. A mutual-exclusion check that runs after
   * you have already acquired the expensive resource is not mutual exclusion --
   * it is a report, delivered too late to act on.
   *
   * The identical ordering bug appeared this same round in a hand-written probe:
   * two copies launched their browsers and THEN entered a wait-for-quiet loop, so
   * each held a Chromium open while waiting for the other's to disappear and
   * neither ever took a reading. Same shape, same round, two different authors.
   * Acquire first, then spend.
   */
  takeLock(OUT);

  const browser = await chromium.launch({
    args: [
      '--use-angle=metal',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--disable-frame-rate-limit',
      '--force-device-scale-factor=1',
    ],
  });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

    /*
   * Write an INCOMPLETE manifest before taking a single shot.
   *
   * The real manifest is written last, after every shot. That meant a run which
   * died partway -- the disk filling is the case that actually happened -- left
   * a directory full of valid-looking PNGs and NO manifest at all, which is
   * indistinguishable from success to every downstream critic. Six agents then
   * scored a partial, uncertified shot set, three of them on frames that did
   * not exist, and the round's numbers had to be thrown away.
   *
   * A stub makes the failure loud instead of silent: if `complete` is false,
   * the run did not finish and nothing in the directory should be scored.
   */
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify({
    complete: false,
    startedAt: new Date().toISOString(),
    note: 'INCOMPLETE — this capture run did not finish. Do not score these frames.',
  }, null, 2));
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`[capture] loading ${url}`);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  try {
    await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  } catch {
    const png = await page.screenshot({ path: resolve(OUT, '00-BOOT-FAILURE.png') });
    console.error('[capture] game never became ready. Console errors:');
    for (const e of errors.slice(0, 20)) console.error('  ', e);
    await browser.close();
    await server.close();
    process.exit(1);
  }

  // Let shader compilation and the first frames settle.
  await page.waitForTimeout(2500);

  // `--eval "<js>"` runs once before the shot list, for A/B diagnosis of a
  // single effect without editing the shot table.
  const pre = arg('eval', '');
  if (pre) {
    await page.evaluate(`(() => { try { ${pre} } catch (e) { console.error('eval', e); } })()`);
    await page.waitForTimeout(600);
  }

  const list = ONLY.length ? SHOTS.filter((s) => ONLY.some((o) => s.name.includes(o))) : SHOTS;
  const manifest = [];
  /** Per-shot self-checks (see `verify` on a shot), written into the manifest. */
  const verified = {};
  /**
   * Per-shot defects. A warning that only reaches stdout dies with the process,
   * and the manifest is the contract every critic reads -- so a shot that
   * failed printed "no hit landed" on one line, "(frozen at contact)" on the
   * next, and then recorded errors: []. Three critics caught that in one round.
   * Everything that goes wrong now lands in the file too.
   */
  const defects = [];
  const flaw = (shot, msg) => {
    console.warn(`[capture] ${shot}: ${msg}`);
    defects.push({ shot, problem: msg });
  };

  // Every shot is taken from inside a live round with the menus dismissed.
  // Without this the camera framings composite over the title screen.
  const enterMatch = (shot) => `
    window.KB.menus.show(null);
    window.KB.paused = false;
    // Clear the per-shot audit slot. Only 17-anim-strip writes it, but the
    // tick-strip branch reads it for every tick-strip shot, so a reordering of
    // SHOTS that put another one after 17 would silently attach 17's numbers to
    // a different shot's manifest entry. Stale window state surviving into the
    // next shot is a mistake this file has already made twice.
    window.__kbAnim17 = null;
    /*
     * THE ANIMATION AXIS HAS ONLY EVER SEEN ONE ROBOT.
     *
     * Every path in this file called startMatch(0, 1) and every clip strip
     * used subject: 0, so four of the five strips rendered roster index 0 --
     * VULKAN -- and nothing else, for every round this axis has been scored.
     *
     * That is not a neutral choice. Vulkan carries a pair of 0.66 m exhaust
     * stacks on clavicle_R at TIER.PRIMARY (markStacks), taller than its
     * own head and the single most dominant element of its upper silhouette.
     * Two independent critics, rounds apart, described the same thing as "a
     * rifle-like prop held overhead" and "a long rigid rod-like prop held
     * vertically overhead in the same position", and both concluded that the
     * upper body does not differentiate between move types.
     *
     * They were describing Vulkan's chimneys, and the question "does the upper
     * body differentiate" has therefore been asked exclusively of the one robot
     * least able to answer yes. Nobody has looked at the other nine.
     *
     * chars lets a shot say who is in the match. Default stays [0, 1] so
     * every existing shot is bit-identical; only the clip strips vary, and they
     * vary deliberately across silhouette classes rather than at random.
     *
     * An axis scored on a single subject is not measuring the system. It is
     * measuring that subject, and reporting the result as if it were the system.
     *
     * (No backticks in this comment. It lives inside a JS template literal, so one
     * would end the string. Ninth time this repo has hit that trap.)
     */
    if (window.KB.phase !== 'fight' || window.__kbChars !== '${(shot.chars || [0, 1]).join(',')}') {
      window.KB.startMatch(${(shot.chars || [0, 1])[0]}, ${(shot.chars || [0, 1])[1]});
      window.KB.setPhase('fight');
      window.__kbChars = '${(shot.chars || [0, 1]).join(',')}';
    }
  `;

  // Arms a one-shot bus listener that records the tick a hit lands on and
  // freezes the simulation `offset` ticks later. This is the only way to
  // photograph an impact whose effects live a fifth of a second.
  // Pinning the frame clock is the only thing that makes an offset mean what it
  // says. `Game.#frame` calls `#render(raw, ...)` unconditionally — `paused`
  // gates the accumulator, not the render — and `visualDt` is raw wall time. So
  // `paused = true` freezes the simulation while the effects keep ageing at
  // wall-clock rate until the shutter, and `timeScale` (which scales only the
  // accumulator) makes that worse rather than better: at 0.05 an eight-tick
  // offset costs 2.7 seconds of effect time. Pinning getDelta to 1/60 makes one
  // rendered frame exactly one tick for both the sim and the visuals; pinning it
  // to 0 stops the frame ageing the instant it freezes.
  const PIN_CLOCK = `
    if (!window.__kbClock) window.__kbClock = window.KB.clock.getDelta.bind(window.KB.clock);
    window.KB.timeScale = 1;
    window.KB.clock.getDelta = () => 1 / 60;
  `;
  const RESTORE_CLOCK = `
    if (window.__kbClock) { window.KB.clock.getDelta = window.__kbClock; window.__kbClock = null; }
    window.KB.timeScale = 1;
  `;

  const ARM_HIT_FREEZE = (offset) => `(() => {
    window.__kbHit = null;
    ${PIN_CLOCK}
    const off = ${offset};
    const stop = window.KB.bus.on('hit', (e) => {
      // Count RENDERED FRAMES, not sim ticks.
      //
      // This waited on KB.tick - hitTick >= off, and KB.tick is precisely
      // what does not advance during hitstop — the freeze gates the sim
      // accumulator, so zero ticks run. "+1 tick past contact" therefore
      // waited out the entire freeze first and shuttered ~330 ms after the
      // blow. It only ever produced a usable image because the FX clock is
      // slowed during the freeze too, so two bugs cancelled: the instrument
      // was systematically rewarding effects that persist too long, which is
      // the exact defect the critic keeps naming on this axis.
      //
      // Two agents found this independently in the same round, from opposite
      // directions — one measuring reaction poses, one measuring effects.
      // Record what actually produced this frame. The listener fires on ANY hit,
      // so without the move name a weight-ladder shot cannot certify the one
      // fact the comparison rests on -- a shot that cannot name its own move
      // cannot anchor a ladder. The bus event carries all of this already and
      // it was being thrown away.
      window.__kbHit = { tick: window.KB.tick, frames: 0, landed: true,
        move: (e && e.move && (e.move.id || e.move.name)) || null,
        weight: (e && e.move && e.move.weight) || null,
        damage: (e && e.damage != null) ? e.damage : null };
      stop();
      const wait = () => {
        if (window.__kbHit.frames >= off) {
          window.KB.paused = true;
          window.KB.clock.getDelta = () => 0;  // stop the effects ageing before the shutter
          // NOT stubbing the camera here, on evidence. FightCamera.render floors
          // its own dt (shake += max(dt, 0.0025), kick clamped to >= TICK_DT), so
          // a "frozen" contact frame still advances the camera per rendered
          // frame, and stubbing it makes two grabs of ONE frozen frame stable to
          // 0.015/255 -- a real result, reported by the FX workstream.
          //
          // But that is a different measurement from run-to-run reproducibility,
          // and run-to-run is what scores depend on. Measured on an identical
          // three-shot list, one pair each way:
          //     04-impact        26.1 -> 40.5
          //     04b-impact-decay 31.1 -> 39.4
          //     16-impact-heavy  40.8 -> 40.1
          // No improvement and probably worse, because the cross-run variance is
          // in WHICH frame gets frozen, not in the frame drifting after it is.
          // Stabilising the frozen frame is still the right property for in-page
          // A/B work -- do it in the probe, not in the shot.
          window.__kbHit.hitstopLeft = window.KB.hitstopTicks;
          window.__kbHit.frozen = true;
        } else {
          window.__kbHit.frames++;
          requestAnimationFrame(wait);
        }
      };
      wait();
    });
  })()`;

  /**
   * Measure the delivered pixels of one captured frame. Kept as a function
   * because the tick-strip branch needs it too, and it must run on a RAW frame
   * rather than on the tiled contact sheet -- a naive check on the sheet would
   * measure the header bar and the gaps between cells, not the game.
   */
  const measureFrame = (b64, wantsBanner) => page.evaluate(async ({ b64, wantsBanner }) => {
      const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64; });
      const W = 320, H = Math.round(im.height * (W / im.width));
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      const lum = [];
      let black = 0, topBlack = 0, topN = 0;
      const topRows = Math.round(H * 0.2);
      // Modal-colour share over the SCENE rows only, which is the dead-canvas
      // test. Deliberately a variance measure rather than a level measure --
      // see the note on `deadFrac` below.
      const sceneTop = Math.round(H * 0.162), sceneBot = Math.round(H * 0.889);
      const tally = new Map();
      let sceneN = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          lum.push(L);
          if (L < 0.012) black++;
          if (y < topRows) { topN++; if (L < 0.012) topBlack++; }
          if (y >= sceneTop && y < sceneBot) {
            sceneN++;
            const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
            tally.set(key, (tally.get(key) || 0) + 1);
          }
        }
      }
      let modal = 0;
      for (const c of tally.values()) if (c > modal) modal = c;
      lum.sort((a, b2) => a - b2);
      const q = (f) => +lum[Math.min(lum.length - 1, Math.floor(lum.length * f))].toFixed(4);
      const banner = document.querySelector('.announce-banner');
      const bannerUp = !!banner && parseFloat(getComputedStyle(banner).opacity) > 0.05;

      const out = {
        p50: q(0.5), p95: q(0.95), p999: q(0.999),
        blackFrac: +(black / lum.length).toFixed(3),
        topBlackFrac: +(topBlack / Math.max(1, topN)).toFixed(3),
        bannerOverFrame: bannerUp && !wantsBanner,
        deadFrac: +(modal / Math.max(1, sceneN)).toFixed(4),
      };
      /**
       * Thresholds are deliberately loose -- this catches unscoreable frames,
       * not dark art direction. 07-super sat at p50 0.0044; a normal fight
       * frame is an order of magnitude above that.
       *
       * `deadFrac` IS THE DEAD-CANVAS TEST, AND IT IS NOT REDUNDANT.
       *
       * Under load a capture can come back with the WebGL canvas never drawn and
       * the DOM HUD composited over it perfectly -- health bars, timer, combo
       * counter, damage number, all correct. Two of twenty shipped frames were
       * this, and every gate above passed them, and the manifest certified the
       * run `complete: true, defects: []`. Three critics found it independently;
       * one lost its flagship shot and could not score its axis.
       *
       * A previous version of this comment asserted the case was already covered
       * and told the next reader NOT to add this check. That was wrong on one
       * specific point, and the whole failure follows from it: **a dead canvas is
       * not black.** What shows through is the page background, --kb-void
       * #05070c (src/ui/ui.css), whose Rec.709 luma is 0.0272. That is 2.3x the
       * p50 floor of 0.012, and -- the part that really bites -- it is ABOVE the
       * L < 0.012 black threshold, so `blackFrac` reports 0.000 on a frame that
       * is 99% one colour. `topBlackFrac` is inverted here too, because the top
       * of a dead frame is exactly where the surviving HUD lives. The reasoning
       * was validated by blanking a frame to BLACK, which is the one shade the
       * real failure never produces.
       *
       * So the gate has to be a VARIANCE test, not a level test. Modal quantised
       * colour share over the scene rows, measured across all 18 shipped frames:
       *
       *     two dead frames        99.17%, 99.96%
       *     worst healthy frame     2.29%  (07-super, whose modal colour is the
       *                                     cinematic letterbox, not the void)
       *     typical healthy frame   0.05% - 1.95%
       *
       * Forty-fold separation, so 0.5 is not a delicate threshold. It is also
       * orthogonal to brightness and to the HUD, which is why it survives both
       * the dark-art-direction case and the bright-chrome case that defeated the
       * level tests.
       */
      out.ok = out.p50 >= 0.012 && out.p95 >= 0.06 && out.blackFrac < 0.55
        && out.topBlackFrac < 0.9 && !out.bannerOverFrame && out.deadFrac < 0.5;
      return out;
  }, { b64, wantsBanner });

  for (const shot of list) {
    try {
      await page.evaluate(`(() => { try { ${enterMatch(shot)} } catch (e) { console.error('enter', e); } })()`);
      await page.waitForTimeout(500);
      if (shot.freezeOnHit || shot.preRoll) {
        // A frozen shot has no settle window by construction, so the framing
        // that is live at contact is the framing that gets photographed — and
        // `KB.paused` stops the simulation but NOT the camera rig, which keeps
        // integrating off the render loop. Both failures therefore have to be
        // headed off *before* the hit rather than waited out after it: waiting
        // after the freeze does not help, because the FX advance on render dt
        // and drain away while the camera is still whipping.
        //
        // Restarting the match puts the fighters back on their neutral marks
        // and the rig back on the pair, so by the time `forceHit` fires the
        // camera is already where it wants to be and is barely moving. The
        // freeze then catches a near-static camera: correctly framed, and with
        // almost no reprojection velocity for motion blur to smear.
        await page.evaluate(`window.KB.startMatch(0, 1); window.KB.setPhase('fight'); window.KB.fightCamera.cinematic('fight');`);
        await page.waitForFunction('window.KB.phaseTicks > 60', null, { timeout: 15000 }).catch(() => {});
        await page.waitForFunction(NO_BANNER, null, { timeout: 15000 })
          .catch(() => flaw(shot.name, 'round-start banner never cleared'));
        await page.waitForTimeout(400);
        if (shot.freezeOnHit) await page.evaluate(ARM_HIT_FREEZE(shot.impactOffset ?? 0));
      }
      // Every shot arms a hit sentinel, so any shot can wait on contact rather
      // than on a guessed delay. Cheap, and it removes the whole class of
      // "photographed the wind-up" failure that has cost this project four
      // rounds of invalid scores on two different axes.
      await page.evaluate(`(() => {
        window.__kbShotHit = null;
        window.__kbHitCount = 0;
        // Counts, not just a flag: a juggle shot has to know the combo actually
        // reached N. 05-juggle asked forceJuggle for 3 hits, the HUD read
        // "1 HIT", and a flat settle then opened the shutter after the
        // attacker's recovery had finished -- the wind-up bug, inverted into
        // photographing the recovery.
        window.KB.bus.on('hit', (e) => {
          window.__kbHitCount++;
          if (!window.__kbShotHit) window.__kbShotHit = { landed: true, tick: window.KB.tick };
          window.__kbShotHit.hits = window.__kbHitCount;
        });
      })()`);
      // POSE PIN. See docs/PROFILING.md trap 5. Two clock states, and both matter:
      //   1/60 through the WARM-UP so one rendered frame is exactly one tick and
      //   the pose is a function of the tick count; then 0 once paused, because
      //   the settle window is wall-clock and anything that advances per RENDER
      //   frame (springs, breathing, procedural modifiers) otherwise accumulates
      //   a different amount depending on how loaded the machine is.
      // The wait and the pause run in one page-side callback: polling from the
      // driver returns when Playwright OBSERVES the tick, and more ticks pass
      // during the round trip, so "pause at 150" was pausing at 152, 157, 163.
      if (shot.pinTicks) {
        await page.evaluate(`(() => { ${PIN_CLOCK} })()`);
        await page.evaluate(`window.KB.paused = false; window.KB.startMatch(0, 1); window.KB.setPhase('fight');`);
        const pinned = await page.evaluate(`(() => new Promise((res) => {
          const KB = window.KB, target = ${shot.pinTicks};
          const step = () => {
            if (KB.phaseTicks >= target) {
              KB.paused = true;
              KB.clock.getDelta = () => 0;
              const r = KB.renderer;
              if (r) {
                // These three are RENDERER settings, not shot state, and nothing
                // used to hand them back. 02-closeup-face is the only shot with
                // pinTicks and it is shot number two, so from that point every
                // remaining shot -- and the end-of-run perf probe -- rendered at
                // native 1920x1080 instead of the high tier's 1632x918. That is
                // the whole of the "48.1 fps" the manifest has been reporting
                // since round 17: 5.8ms of resolution, not a leak and not a
                // regression. See docs/PROFILING.md.
                window.__kbPinnedRenderState = {
                  adaptive: r.effects ? r.effects.adaptiveResolution : null,
                  renderScale: r.renderScale,
                  grain: r.look ? r.look.grain : null,
                  chroma: r.look ? r.look.chroma : null,
                };
                if (r.effects) r.effects.adaptiveResolution = false;
                r.renderScale = 1;
                if (typeof r.resize === 'function') r.resize();
                // Kill film grain and chroma. This is the last of the residual
                // noise and it took several attempts to find: the grade pass
                // hashes uGrain on gl_FragCoord PLUS uTime, so it re-rolls
                // every rendered frame even with the sim clock at zero -- a
                // per-pixel dither no amount of pose pinning can touch. Found
                // by the character workstream, which measured a 1.44/255 floor
                // between two grabs of an identical frozen configuration and
                // traced it here.
                if (typeof r.setGrade === 'function') r.setGrade({ grain: 0, chroma: 0 });
              }
              res({ phaseTicks: KB.phaseTicks });
            } else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }))()`).catch(() => null);
        if (!pinned) flaw(shot.name, `pose pin failed at phaseTicks ${shot.pinTicks}`);
        else if (pinned.phaseTicks !== shot.pinTicks) {
          flaw(shot.name, `pose pin landed on tick ${pinned.phaseTicks}, wanted ${shot.pinTicks}`);
        }
      }
      if (shot.prep) await page.evaluate(`(() => { try { ${shot.prep} } catch (e) { console.error('prep', e); } })()`);
      await page.evaluate(`(() => { try { ${shot.setup} } catch (e) { console.error('shot setup', e); } })()`);
      if (shot.waitFor) {
        await page.waitForFunction(shot.waitFor, null, { timeout: 15000 })
          .catch(() => flaw(shot.name, `WAITED OUT — "${shot.waitFor}" never became true; this frame `
            + 'is not the moment the shot is named for and must not be scored'));
      }
      if (shot.freezeOnHit) {
        // Retry, because whether a forced blow connects depends on what the
        // PREVIOUS shot left the fighters doing. 16-impact-heavy landed
        // reliably after 08-hud and whiffed after 15-impact-light at the same
        // distance, which is why tuning the spacing kept looking fixed and
        // wasn't. Re-staging is cheap; a silently whiffed contact frame has
        // cost this project two rounds of unscoreable impact captures.
        let landed = false;
        for (let attempt = 1; attempt <= 3 && !landed; attempt++) {
          landed = await page.waitForFunction('window.__kbHit && window.__kbHit.frozen', null, { timeout: 6000 })
            .then(() => true).catch(() => false);
          if (landed) break;
          if (attempt < 3) {
            await page.evaluate(`(() => { window.KB.paused = false; ${RESTORE_CLOCK} })()`);
            await page.evaluate(`window.KB.startMatch(0, 1); window.KB.setPhase('fight'); window.KB.fightCamera.cinematic('fight');`);
            await page.waitForFunction('window.KB.phaseTicks > 60', null, { timeout: 15000 }).catch(() => {});
            await page.waitForFunction(NO_BANNER, null, { timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(400);
            await page.evaluate(ARM_HIT_FREEZE(shot.impactOffset ?? 0));
            await page.evaluate(`(() => { try { ${shot.setup} } catch (e) { console.error('shot setup', e); } })()`);
          }
        }
        if (!landed) flaw(shot.name, 'NO HIT LANDED after 3 attempts — not a contact frame, must not be scored');
      }
    } catch (e) {
      console.warn(`[capture] setup failed for ${shot.name}: ${e.message}`);
    }
    // Plain shots never had a banner gate, so 01-hero-idle and 12-select-screen
    // both shipped with a full-opacity FIGHT drawn across them -- and 12
    // exposed a real product bug in doing so: the announcement survives a phase
    // change and paints over a menu. ENTER_MATCH queues the round-start
    // announcement before every shot, so every shot needs the gate. preRoll and
    // freezeOnHit shots already wait for it in their own pre-roll.
    if (!shot.wantsBanner && !shot.freezeOnHit && !shot.preRoll && !shot.tickStrip) {
      await page.waitForFunction(NO_BANNER, null, { timeout: 8000 })
        .catch(() => flaw(shot.name, 'an announcement banner is still up over a shot that is not about one'));
    }
    // Re-assert the requested framing AFTER the banner gate.
    //
    // FightCamera#onPhaseChange does `case 'ready': case 'fight':
    // this.cinematic('fight')` unconditionally, and the previous shot's
    // teardown unpauses the sim -- so a round phase transition landing inside
    // this shot's settle window silently discards the framing it asked for.
    // 03-full-body asked for a portrait at 4.2m and shipped the default
    // two-fighter fight framing for an unknown number of rounds; it measured
    // RMSE 0.2496 against 01-hero-idle, almost all of it the banner and timer.
    if (shot.reassert) {
      await page.evaluate(`(() => { try { ${shot.reassert} } catch (e) { console.error('reassert', e); } })()`);
      await page.waitForTimeout(250);
    }
    if (shot.settle) await page.waitForTimeout(shot.settle);
    const file = resolve(OUT, `${shot.name}.png`);

    if (shot.clipStrip) {
      const c = shot.clipStrip;
      const si = c.subject;
      // Pin BEFORE staging. One rendered frame has to already be one tick when
      // the clip starts, or the ticks that elapse between `startMove` and the
      // first freeze are wall-clock ticks and the panel labels inherit the
      // difference.
      await page.evaluate(`(() => { ${PIN_CLOCK} })()`);
      // Stage and establish the origin in ONE evaluate.
      //
      // These were two calls and the round trip between them cost four to five
      // ticks, measured: the panel labelled t0 landed on move tick 4 and every
      // early panel was off by the same amount (0->4, 2->6, 7->8). The move had
      // already been running for four frames before anything froze it. For a
      // clip driven by `startMove` the readiness test is true the instant the
      // call returns, so the freeze happens synchronously in the same task and
      // no tick can slip through at all.
      const info = await page.evaluate(`(async () => {
        const info = ${stripSetup(c)};
        const KB = window.KB;
        const ok = () => ${c.ready ? `(${c.ready})` : 'true'};
        const hold = () => {
          KB.paused = true;
          KB.clock.getDelta = () => 0;
          window.__kbStripOrigin = KB.tick;
        };
        const f = KB.fighters[${si}];
        if (ok()) { hold(); info.ready = { ok: true, waited: 0 }; return info; }
        info.ready = await new Promise((res) => {
          let n = 0;
          const step = () => {
            if (ok()) { hold(); res({ ok: true, waited: n }); }
            else if (n++ > 900) {
              res({ ok: false, waited: n, sawClip: f.animator ? f.animator.current : null,
                    state: f.state });
            } else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        return info;
      })()`).catch((e) => ({ error: e.message.split('\n')[0] }));
      if (!info || info.error) {
        flaw(shot.name, `CLIP STRIP DID NOT STAGE (${info && info.error}) — no strip written`);
        verified[shot.name] = { clipStrip: info };
        continue;
      }
      // The retime is a correctness property of the capture, not a detail. A
      // strip taken with `retime: 'NONE'` on a move that declares one is a strip
      // of a timing no player sees, which is the defect this shot exists to fix.
      if (c.drive === 'move' && info.retime === 'NONE') {
        flaw(shot.name, 'THE RETIME WAS DISCARDED — this strip is running the clip at its authored '
          + 'rate, not the rate the move plays it at; do not read timing off it');
      }

      // Everything from here is clocked in the units the panel labels claim.
      const clockKind = c.clock ?? 'move';
      const clockExpr = clockKind === 'move'
        ? `KB.fighters[${si}].moveTick`
        : clockKind === 'anim'
          ? `(KB.fighters[${si}].animator ? KB.fighters[${si}].animator.time : -1)`
          : `(KB.tick - (window.__kbStripOrigin ?? KB.tick))`;

      if (!info.ready || !info.ready.ok) {
        flaw(shot.name, `CLIP "${c.clip}" NEVER STARTED — the strip origin could not be established, `
          + `so nothing in this sheet is on the tick its label claims (the animator was playing `
          + `"${info.ready && info.ready.sawClip}" in state "${info.ready && info.ready.state}")`);
      }

      const span = c.span ?? info.total ?? info.clipDuration ?? 30;
      const contact = clockKind === 'move' ? info.contact : null;
      const targets = stripTicks(span, contact, c.step ?? 4);

      const panels = [];
      let stalled = false;
      for (const target of targets) {
        // Step, freeze, and sample inside ONE page-side callback. Polling from
        // the driver returns when Playwright observes the value and more ticks
        // pass during the round trip, which is the same defect that put
        // 08b-hud-motion's panels sixty ticks apart across two runs.
        // THE SIM IS ONLY EVER UNPAUSED INSIDE THIS CALLBACK.
        //
        // It used to be resumed at the tail of the previous panel, which left
        // the game running across the driver round trip while nothing was
        // sampling it. Measured: 40 track rows over a 50-tick strip and 20 over
        // a 29-tick one, so a fifth to a third of every curve in the chain plot
        // was interpolated across a hole -- and the holes clustered at the panel
        // ticks, which is exactly where the plot is read. Resuming here means
        // every tick between two panels is sampled by the callback that caused
        // it.
        const at = await page.evaluate(`(() => new Promise((res) => {
          const KB = window.KB;
          const clk = () => (${clockExpr});
          let idle = 0, last = null;
          const push = () => {
            const c = clk();
            if (c !== last) {
              last = c; idle = 0;
              const s = ${STRIP_SAMPLE(si)};
              if (s) { s.clock = c; window.__kbStripTrack.push(s); }
            } else idle++;
            return c;
          };
          const finish = (stalled) => {
            KB.paused = true;
            KB.clock.getDelta = () => 0;
            // Do not open the shutter on the same frame the freeze happened.
            //
            // Panels were coming back as flat #05070c -- the page background,
            // luma 0.0272, which is the exact colour the round-27 dead-canvas
            // investigation identified. That is not a black render, it is NO
            // render: the compositor served a frame in which the WebGL surface
            // had not swapped, and the DOM showed through. Two rAFs after the
            // pause guarantees at least one complete render-and-swap of the
            // frozen state before the screenshot. The state is frozen, so the
            // extra frames change nothing except that there is something to
            // photograph.
            requestAnimationFrame(() => requestAnimationFrame(() => {
              res({ clock: clk(), stalled, sample: ${STRIP_SAMPLE(si)} });
            }));
          };
          // Already there: resolve without letting a single tick run. This is
          // what makes the t0 panel land on tick 0 rather than on tick 4.
          if (push() >= ${target}) { finish(false); return; }
          KB.clock.getDelta = () => 1 / 60;
          KB.paused = false;
          const step = () => {
            const c = push();
            if (c >= ${target}) finish(false);
            else if (idle > 240) finish(true);
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }))()`).catch(() => null);
        if (!at) { flaw(shot.name, `panel ${target} never resolved`); break; }
        if (at.stalled) {
          stalled = true;
          flaw(shot.name, `the clock stopped at ${at.clock} before panel ${target} — the move ended `
            + 'or the state machine took the clip away; later panels are not what they claim');
        }
        /*
         * Retake a panel that came back empty, and record that it happened.
         *
         * Byte count is the cheap discriminator and it is not subtle: a real
         * 800x1040 panel of a lit scene is 500-900 KB of PNG, and a panel that
         * is one flat colour compresses to a couple of KB. No decoding, no
         * round trip, and it catches the dead-canvas case before the sheet is
         * built rather than after. Two retries, then it ships and the per-panel
         * luma check reports it -- a strip that quietly retried for ever would
         * be worse than one that says a panel is dead.
         */
        const grab = () => page.screenshot({
          clip: { x: c.rect.x, y: c.rect.y, width: c.rect.w, height: c.rect.h },
        });
        let raw = await grab();
        let retakes = 0;
        while (raw.length < 40e3 && retakes < 2) {
          retakes++;
          await page.waitForTimeout(220);
          raw = await grab();
        }
        if (retakes && raw.length < 40e3) {
          flaw(shot.name, `panel t${target} IS STILL EMPTY after ${retakes} retakes (${raw.length} `
            + 'bytes) — the canvas never swapped and this panel shows nothing');
        } else if (retakes) {
          // Repaired, so not a defect: saying "this frame is not scoreable"
          // about a panel that was successfully retaken would be false, and the
          // defect list is the one thing every critic reads.
          console.log(`[capture] ${shot.name}: panel t${target} was empty and retook cleanly `
            + `(${retakes}x, ${raw.length} bytes)`);
        }
        const full = panels.length === 0 ? (await page.screenshot()).toString('base64') : null;
        panels.push({ want: target, got: at.clock, s: at.sample, retakes,
          b64: raw.toString('base64'), full });
        if (at.stalled) break;
      }
      await page.evaluate(`(() => { ${RESTORE_CLOCK} window.KB.paused = false; })()`);

      // CERTIFY ON A FULL FRAME, not on the crop. deadFrac's thresholds were
      // calibrated across eighteen 1080p frames; a tight crop of one fighter is
      // a different population and would make the gate mean something else.
      // Never weaken a gate by moving the goalposts under it.
      const cert = panels.length ? await measureFrame(panels[0].full, false) : null;
      if (cert && !cert.ok) {
        flaw(shot.name, `FIRST STRIP PANEL NOT SCOREABLE: median luma ${cert.p50}, p95 ${cert.p95}, `
          + `deadFrac ${cert.deadFrac} — treat the whole sheet as dead`);
      }

      /*
       * Did the subject stay inside the DECLARED crop? The rectangle is fixed in
       * the shot table so that panels register and so that the same crop can be
       * compared across rounds -- which only means anything if the fighter is
       * actually inside it.
       *
       * The margin is 48 px and it is not slack. The box is over BONES, and the
       * silhouette is not: the armour plates, the reactor pack and the antenna
       * all sit outside the outermost bone. The reaction strip passed a
       * zero-margin version of this check with a bone box 5 px inside the crop
       * and shipped five panels with the victim's chassis sliced off at the
       * edge. A bone-space check has to leave room for the body hanging off the
       * bones or it is checking the wrong thing.
       */
      const M = 48;
      const escaped = panels.filter((p) => p.s && (
        p.s.bbox[0] < c.rect.x + M || p.s.bbox[2] > c.rect.x + c.rect.w - M
        || p.s.bbox[1] < c.rect.y + M || p.s.bbox[3] > c.rect.y + c.rect.h - M));
      if (escaped.length) {
        flaw(shot.name, `${escaped.length}/${panels.length} panels have the fighter within ${M}px of the `
          + `declared crop edge ${JSON.stringify(c.rect)} — widen it; the silhouette is being cut off`);
      }
      const offGrid = panels.filter((p) => p.got !== p.want);
      if (offGrid.length) {
        flaw(shot.name, `${offGrid.length} panels landed off their label: `
          + offGrid.map((p) => `${p.want}->${p.got}`).join(', '));
      }
      const wrongClip = panels.filter((p) => p.s && p.s.clip !== c.clip);
      const raw = await page.evaluate('window.__kbStripTrack || []');
      /*
       * DEDUPE BY TICK, and this is not housekeeping.
       *
       * Each panel's callback re-samples the tick it froze on, because its
       * `last` starts empty. That put one duplicate row per panel into the
       * track — a row whose position is identical to its predecessor's, so the
       * per-tick speed computed across it is exactly ZERO. Eleven panels meant
       * eleven spurious zeros dropped into the speed curves at precisely the
       * ticks the sheet asks a critic to look at, one of them on the contact
       * tick itself. It read as a real measurement: `hips speed at contact /
       * own peak` came back 0.000 on all three attack strips, which is the
       * headline number round 28 moved, and it was an artefact of my own
       * sampler. Rule 4 of the preamble applies to numbers you generate as much
       * as to numbers you inherit.
       */
      const track = [];
      const seenClock = new Set();
      for (const s of raw) { if (!seenClock.has(s.clock)) { seenClock.add(s.clock); track.push(s); } }
      // Concordance and lag are claims about a strike driving into contact.
      // They are not meaningful for a clip with no contact, so they are not
      // computed for one rather than being computed and quietly misread.
      const chain = contact != null ? chainStats(track, contact, c.tip || 'hand_R') : null;
      const expectedRows = (targets[targets.length - 1] - targets[0]) + 1;
      if (track.length < expectedRows * 0.95) {
        flaw(shot.name, `TRACK IS INCOMPLETE: ${track.length} distinct ticks for a ${expectedRows}-tick `
          + 'span — the chain plot and the trails are drawn across missing ticks');
      }

      verified[shot.name] = {
        clipStrip: { ...info, clock: clockKind, span, step: c.step ?? 4, ticks: targets,
          panels: panels.map((p) => ({ t: p.want, at: p.got, clip: p.s && p.s.clip,
            animTime: p.s && p.s.animTime, state: p.s && p.s.state, bbox: p.s && p.s.bbox })),
          // The rectangle the DECLARED crop would have to be to hold every
          // panel. Recorded so the next person to move a camera can read the
          // right number off the run instead of guessing at it, which is how
          // this shot's first crop was wrong.
          bboxUnion: panels.length ? (() => {
            const b = panels.filter((p) => p.s).map((p) => p.s.bbox);
            return b.length ? [Math.min(...b.map((v) => v[0])), Math.min(...b.map((v) => v[1])),
              Math.max(...b.map((v) => v[2])), Math.max(...b.map((v) => v[3]))] : null;
          })() : null,
          offGrid: offGrid.length, escapedCrop: escaped.length,
          panelsOnOtherClip: wrongClip.length, trackTicks: track.length, stalled,
          chain },
        frame: cert,
      };

      const sheet = await page.evaluate(stripSheet, {
        panels: panels.map(({ full, ...p }) => p),
        track,
        rect: c.rect,
        tip: c.tip || 'hand_R',
        links: STRIP_LINKS,
        contact,
        clockKind,
        info,
        chain,
        step: c.step ?? 4,
        span,
        name: shot.name,
      });
      const dark = sheet.luma
        .map((l, i) => ({ t: panels[i].want, ...l }))
        .filter((l) => l.p95 < 0.05);
      if (dark.length) {
        flaw(shot.name, `${dark.length}/${panels.length} PANELS ARE BLACK (`
          + `${dark.map((d) => `t${d.t} p95 ${d.p95}`).join(', ')}) — measured on the panel itself, `
          + 'not on a full frame taken near it; those panels show nothing');
      }
      verified[shot.name].clipStrip.panelLuma = sheet.luma;
      const jpg = file.replace(/\.png$/, '.jpg');
      writeFileSync(jpg, Buffer.from(sheet.url.split(',')[1], 'base64'));
      await page.evaluate(`(() => {
        const KB = window.KB, r = window.__kbStripRestore;
        if (r) { KB.fightCamera.render = r.render; KB.fightCamera.simulate = r.simulate; }
        const hud = document.getElementById('ui');
        if (hud) hud.style.visibility = window.__kbStripHud || '';
        if (window.__kbStripHold) { KB.input.keys.delete(window.__kbStripHold); window.__kbStripHold = null; }
        const cpu = window.__kbStripCpu;
        if (cpu) { KB.cpu[0] = cpu[0]; KB.cpu[1] = cpu[1]; window.__kbStripCpu = null; }
        window.__kbStripRestore = null;
        KB.paused = false;
      })()`).catch((e) => console.warn(`[capture] strip teardown: ${e.message}`));
      manifest.push({ name: shot.name, note: shot.note, file: jpg });
      console.log(`[capture] ${shot.name} (clip strip, ${panels.length} panels, `
        + `retime ${JSON.stringify(info.retime)})`);
      continue;
    }

    if (shot.tickStrip) {
      // Sample on the sim's own tick counter and tile the frames, so motion that
      // lives in a few ticks can actually be reviewed. Same reasoning as the
      // contact-frame freeze: a still cannot show easing.
      const frames = [];
      // Measure the offsets from the tick the hit ACTUALLY landed on.
      //
      // This used to sample `KB.tick` after the setup evaluate returned, and
      // then bake the caption "ticks after damage" into the image -- so the
      // offsets were measured from an unmeasured origin and the labels were
      // unfounded. The shared hit sentinel records the real contact tick, so
      // use it and fall back only if no hit was seen. Caught by a critic that
      // read the code behind the caption instead of trusting it.
      const base = await page.evaluate(
        'window.__kbShotHit ? window.__kbShotHit.tick : window.KB.tick');
      const hitBased = await page.evaluate('!!window.__kbShotHit');
      // Only a strip whose caption CLAIMS damage-relative offsets is lying when
      // it has no hit to measure from. A strip labelled "from move start" is
      // telling the truth about a different origin.
      if (!hitBased && !shot.stripLabel) {
        flaw(shot.name, 'tick strip offsets are measured from shot start, not from contact — no hit '
          + 'was recorded, so the "ticks after damage" labels are not trustworthy');
      }
      verified[shot.name] = { baseTick: base, measuredFromContact: hitBased,
        offsets: shot.tickStrip.slice(),
        // Measurement only, recorded by the shot's own setup where it has one.
        retimeAudit: await page.evaluate('window.__kbAnim17 ?? null').catch(() => null) };
      // Land each panel on the EXACT tick it is labelled with.
      //
      // This waited from the driver and then took a 1920x1080 screenshot --
      // 100-300ms -- while the unpinned sim kept running, so panel k actually
      // landed at its requested tick plus all the accumulated shutter latency
      // before it. Measured on an unchanged tree, two runs put their "+20t"
      // panels about SIXTY ticks apart, with the round timer reading 57 in one
      // and 56 in the other, and cross-run panel noise of 5-74/255. A strip
      // whose panels are not on their own labels cannot resolve a pose edit.
      //
      // Same fix that worked for 02-closeup-face: pin the clock so one rendered
      // frame is one tick, then wait AND freeze inside a single page-side
      // callback so no ticks slip through the round trip, shoot, and resume.
      await page.evaluate(`(() => { ${PIN_CLOCK} })()`);
      // The FIRST panel defines the origin. Sampling `base` before the loop
      // meant ticks slipped past between the sample and the first freeze --
      // measured, panel +0t landed four ticks late -- and every later panel
      // inherited that offset. Freezing first and reading the tick back makes
      // the labels mean what they say.
      let origin = null;
      for (const off of shot.tickStrip) {
        const target = origin === null ? null : origin + off;
        const at = await page.evaluate(`(() => new Promise((res) => {
          const KB = window.KB, target = ${target === null ? 'KB.tick' : target};
          const step = () => {
            if (KB.tick >= target) {
              KB.paused = true;
              KB.clock.getDelta = () => 0;
              res(KB.tick);
            } else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }))()`).catch(() => null);
        if (origin === null) origin = at - off;
        else if (at !== origin + off) {
          flaw(shot.name, `panel +${off}t landed on tick ${at}, wanted ${origin + off}`);
        }
        frames.push({ t: off, b64: (await page.screenshot()).toString('base64') });
        await page.evaluate(`(() => { ${PIN_CLOCK} window.KB.paused = false; })()`);
      }
      await page.evaluate(`(() => { ${RESTORE_CLOCK} window.KB.paused = false; })()`);
      // Certified on a RAW cell, not on the tiled sheet. This was the only shot
      // in the list with no delivered-pixel check at all, because the tickStrip
      // branch returns before the universal one -- so it could ship a strip of
      // black frames and nothing would say so. Measuring the contact sheet
      // instead would measure the header bar and the gaps between cells, which
      // is why this runs on frames[0] rather than on the finished JPEG.
      const cellFrame = await measureFrame(frames[0].b64, !!shot.wantsBanner);
      verified[shot.name].frame = cellFrame;
      if (cellFrame && !cellFrame.ok) {
        flaw(shot.name, `FIRST STRIP CELL NOT SCOREABLE: median luma ${cellFrame.p50}, `
          + `p95 ${cellFrame.p95}, ${Math.round(cellFrame.blackFrac * 100)}% crushed to black`);
      }

      const sheet = await page.evaluate(async ({ cells, label, crop }) => {
        const imgs = await Promise.all(cells.map((c) => new Promise((res) => {
          const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + c.b64;
        })));
        const w = imgs[0].width, h = Math.round(imgs[0].height * crop);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h * imgs.length + 30;
        const g = cv.getContext('2d');
        g.fillStyle = '#0a0d13'; g.fillRect(0, 0, cv.width, cv.height);
        g.fillStyle = '#ff9e2c'; g.font = '600 19px ui-monospace, monospace';
        g.fillText(label, 12, 21);
        imgs.forEach((im, i) => {
          g.drawImage(im, 0, 0, w, h, 0, i * h + 30, w, h);
          g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(0, i * h + 30, 78, 22);
          g.fillStyle = '#4fd8e8'; g.font = '600 13px ui-monospace, monospace';
          g.fillText('+' + cells[i].t + 't', 8, i * h + 46);
        });
        return cv.toDataURL('image/jpeg', 0.86);
      }, { cells: frames, crop: shot.stripCrop ?? 0.34, label: `${shot.name}  ·  ${shot.stripLabel ?? 'ticks after damage'}` });
      writeFileSync(file.replace(/\.png$/, '.jpg'), Buffer.from(sheet.split(',')[1], 'base64'));
      await page.evaluate(`(() => { ${RESTORE_CLOCK} })()`);
      manifest.push({ name: shot.name, note: shot.note, file: file.replace(/\.png$/, '.jpg') });
      console.log(`[capture] ${shot.name} (tick strip)`);
      continue;
    }

    // Self-checks run at SHUTTER TIME, not at setup time. A shot that certifies
    // itself before its settle window has elapsed is certifying a frame nobody
    // photographed -- which is the same class of mistake this whole block
    // exists to catch. `verify` is either a window property name or, if it
    // starts with "(", a live expression evaluated against the frame about to
    // be taken.
    if (shot.verify) {
      const expr = shot.verify.startsWith('(') ? shot.verify : `window.${shot.verify} ?? null`;
      const v = await page.evaluate(expr).catch((e) => ({ error: e.message.split('\n')[0] }));
      verified[shot.name] = v;
      if (v === null || (v && v.error)) {
        flaw(shot.name, `SELF-CHECK DID NOT FIRE (${shot.verify}) — this frame is not the moment `
          + 'the shot is named for and must not be scored');
      } else if (v.clear === false) {
        flaw(shot.name, `SUBJECT OCCLUDED by ${v.blocker} (${v.gap}m in front) — do not score this frame`);
      } else if (v.ok === false) {
        flaw(shot.name, `SELF-CHECK FAILED ${JSON.stringify(v)} — do not score this frame`);
      } else if (v.clear === true) {
        console.log(`[capture] ${shot.name}: subject clear at ${v.dist}m`);
      } else {
        console.log(`[capture] ${shot.name}: verified ${JSON.stringify(v)}`);
      }
    }

    /*
     * Record the resolution the SHOT was rendered at, not the one the perf
     * probe pins later.
     *
     * Round 26 gave the fps figure a render scale and stopped one step short:
     * the manifest said 1632x918 (the probe's pinned 0.85) while the frames
     * themselves were taken with the adaptive controller live, measured at
     * 1555x874 -- renderScale 0.81. Every shot a critic scores against a native
     * 1080p reference is a sub-native render blown up by the viewport
     * screenshot, and the amount of upscaling was nowhere on the record.
     */
    /*
     * EVERY SHOT RENDERS AT NATIVE, WITH THE ADAPTIVE CONTROLLER OFF.
     *
     * Measured across a full pass before this: EIGHT distinct render scales,
     * 0.72 to 1.00, with adaptive live on 17 of 18 shots. 03-full-body came out
     * at 1555x874 and 19-cistern-wide at 1382x777, both written to disk as
     * 1920x1080 by the viewport screenshot and then scored against native-1080p
     * Tekken references. A 1.39x span in linear detail, set by whatever the
     * machine's frame timing happened to be, so it is not even reproducible
     * between two runs of the same build. Three critics found it independently
     * and one had two of its three assigned shots at 58-66% of the pixels they
     * claimed.
     *
     * The cause was mine. Round 26 made the pinTicks teardown hand the renderer
     * settings BACK, to stop a single frozen shot leaving the whole run at
     * native and corrupting the end-of-run fps probe. That fixed the perf
     * instrument and silently degraded the evidence instrument for every other
     * shot -- the same shape as five other findings this project has turned up:
     * a change that protects one measurement while quietly breaking another.
     *
     * Pinned per shot rather than once at startup because the controller is
     * re-enabled by quality-tier changes and by the pinTicks teardown, and a
     * single startup pin would silently lapse. The perf probe re-pins to the
     * TIER scale afterwards, because an fps number has to be taken at the
     * resolution the game actually ships at -- the two instruments want
     * different things and now each says which it used.
     */
    await page.evaluate(`(() => {
      const r = window.KB && window.KB.renderer; if (!r) return;
      if (r.effects) r.effects.adaptiveResolution = false;
      r.renderScale = 1; r._targetScale = 1;
      if (typeof r.resize === 'function') r.resize();
    })()`).catch(() => {});
    await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`).catch(() => {});

    const res = await page.evaluate(`(() => {
      const r = window.KB && window.KB.renderer;
      const gl = r && r.renderer && r.renderer.getContext ? r.renderer.getContext() : null;
      return {
        renderScale: r && r.renderScale != null ? +r.renderScale.toFixed(3) : null,
        adaptive: r && r.effects ? !!r.effects.adaptiveResolution : null,
        buffer: gl ? gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight : null,
      };
    })()`).catch(() => null);

    const png = await page.screenshot({ path: file });

    // UNIVERSAL FRAME CHECK — every shot, whether or not it declares a `verify`.
    //
    // Certification used to be opt-in, and five of six critics spent round 14
    // scoring under protest because the primary shot on their axis carried
    // none. Worse, the shots that DID certify proved certification was not
    // sufficient: 07-super self-certified "hit landed" while 95% of the frame
    // was functionally black, and 08-hud's top third was 480/480 pixels of
    // exactly (0,0,0). Asserting that the right MOMENT was captured says
    // nothing about whether the frame is legible.
    //
    // So this measures the delivered pixels for every shot: exposure, dynamic
    // range, how much of the frame is crushed to black, and whether an
    // announcement banner is sitting over a shot that is not about one.
    const frame = await measureFrame(png.toString('base64'), !!shot.wantsBanner);


    if (frame && !frame.ok) {
      const why = [];
      if (frame.p50 < 0.012) why.push(`median luma ${frame.p50} — the frame is functionally black`);
      if (frame.p95 < 0.06) why.push(`p95 luma ${frame.p95} — no usable dynamic range`);
      if (frame.blackFrac >= 0.55) why.push(`${Math.round(frame.blackFrac * 100)}% of pixels crushed to black`);
      if (frame.topBlackFrac >= 0.9) why.push(`top fifth is ${Math.round(frame.topBlackFrac * 100)}% black — framed against a void`);
      if (frame.bannerOverFrame) why.push('an announcement banner is drawn over a shot that is not about one');
      if (frame.deadFrac >= 0.5) {
        why.push(`DEAD CANVAS — ${Math.round(frame.deadFrac * 100)}% of the scene is a single colour; `
          + 'the WebGL canvas never drew and this is the DOM HUD over the page background');
      }
      flaw(shot.name, `FRAME NOT SCOREABLE: ${why.join('; ')} — if this shot is being tuned,`
        + ' treat the frame as DEAD and re-run it; do not read its numbers as a tuning result');
    }
    verified[shot.name] = { ...(verified[shot.name] || {}), frame, res };
    if (shot.freezeOnHit) {
      await page.evaluate(`(() => { window.KB.paused = false; ${RESTORE_CLOCK} })()`);
    }
    // A shot that overrode the camera rig has to hand it back, or every shot
    // after it inherits the override and quietly photographs the wrong framing.
    if (shot.pinTicks) {
      // Hand the renderer settings back too, not just the clock.
      //
      // Restore to the TIER's scale rather than the value that was saved: the
      // adaptive controller ratchets `_targetScale` down during the harness's
      // own stalls, so replaying the saved figure leaves the controller churning
      // `composer.setSize` all through the perf probe -- measured at 30.2ms,
      // worse than the bug being fixed.
      await page.evaluate(`(() => { ${RESTORE_CLOCK} window.KB.paused = false;
        const s = window.__kbPinnedRenderState, r = window.KB.renderer;
        if (s && r) {
          r.renderScale = r.tier ? r.tier.renderScale : s.renderScale;
          r._targetScale = r.renderScale;
          if (typeof r.resize === 'function') r.resize();
          if (r.effects && s.adaptive !== null) r.effects.adaptiveResolution = s.adaptive;
          if (typeof r.setGrade === 'function' && s.grain !== null) r.setGrade({ grain: s.grain, chroma: s.chroma });
          window.__kbPinnedRenderState = null;
        }
      })()`).catch(() => {});
    }
    /*
     * ASYNC IIFE, so a teardown that awaits is actually awaited.
     *
     * This wrapper used to be synchronous, which meant a teardown returning a
     * promise had that promise dropped on the floor and the next shot started
     * on top of it. 19-cistern-wide's teardown is `stage.setArena('sublevel09')`
     * and `Stage.setArena` is `async` -- so the arena REBUILD ran concurrently
     * with the following shot's setup, and it is not cheap: measured, it holds
     * the main thread for 1.1s before it even returns and produces rAF gaps up
     * to 1.83s. That is what made 13-announce-fight's hold window unwinnable.
     *
     * Setups already got this right (`await page.evaluate` on an async IIFE);
     * only teardown was left synchronous, so the leak was invisible from the
     * shot table -- 19's teardown reads exactly like 18's setup and behaves
     * completely differently.
     */
    if (shot.teardown) {
      await page.evaluate(`(async () => { try { ${shot.teardown} } catch (e) { console.error('teardown', e); } })()`)
        .catch((e) => console.warn(`[capture] teardown failed for ${shot.name}: ${e.message}`));
    }
    manifest.push({ name: shot.name, note: shot.note, file });
    console.log(`[capture] ${shot.name}${shot.freezeOnHit ? ' (frozen at contact)' : ''}`);
  }

  // Measure the framerate rather than sampling it.
  //
  // This used to read `renderer.stats.fps`, one instantaneous sample taken
  // after the KO shot — with the sim paused, a cinematic running and the
  // camera parked wherever the last shot left it. Three runs of the SAME BUILD
  // returned 5.00, 65.06 and 142.48. That number was quoted as evidence the
  // 60fps constraint was met, which it could not support in either direction.
  //
  // Instead: return to live fight framing, let it settle, then time a fixed
  // window of real rAF callbacks and report the median and p95 frame interval.
  // The median is the honest headline; p95 is what a player actually feels.
  const perf = await page.evaluate(`(() => new Promise((res) => {
    const KB = window.KB, rp = KB.renderer;
    KB.paused = false;
    KB.startMatch(0, 1); KB.setPhase('fight'); KB.fightCamera.cinematic('fight');
    // An fps figure is meaningless without the resolution it was taken at, and
    // this probe used to inherit whatever the shot list happened to leave
    // behind. Pin the tier's own scale, stop the adaptive controller, and report
    // both alongside the number so it can never again be an unlabelled
    // resolution.
    /*
     * MEASURED AT BOTH RESOLUTIONS, because the charter names one and the tier
     * ships another.
     *
     * The charter's constraint is "60fps at 1920x1080". This probe pinned the
     * TIER's scale, 0.85 -> 1632x918, and every "we are 0.13ms short of 60fps"
     * figure in this project's record was taken there. Meanwhile the critics
     * score frames at renderScale 1, native. So performance and quality were
     * being measured at different resolutions, and the constraint being reported
     * against was not the one written down. An external auditor found it; nobody
     * inside had, in 36 rounds.
     *
     * PERF_SCALE lets the probe be pinned explicitly. Every performance claim
     * from here carries two numbers: the shipping tier, and native.
     */
    const forced = ${PERF_SCALE || 'null'};
    if (rp) {
      if (rp.effects) rp.effects.adaptiveResolution = false;
      const s = forced != null ? forced : (rp.tier ? rp.tier.renderScale : 1);
      rp.renderScale = s; rp._targetScale = s;
      if (typeof rp.resize === 'function') rp.resize();
    }
    const dts = [];
    let last = performance.now(), warm = 0;
    const tick = (now) => {
      const dt = now - last; last = now;
      if (warm++ > 30) dts.push(dt);          // discard the restart transient
      if (dts.length < 480) requestAnimationFrame(tick);
      else {
        dts.sort((a, b) => a - b);
        res({ frames: dts.length,
              medianMs: +dts[dts.length >> 1].toFixed(2),
              p95Ms: +dts[Math.floor(dts.length * 0.95)].toFixed(2),
              quality: rp && rp.quality ? rp.quality : null,
              renderScale: rp ? +(rp.renderScale ?? 0).toFixed(3) : null,
              pixels: rp && rp.composer && rp.composer.readBuffer && rp.composer.readBuffer.width
                ? rp.composer.readBuffer.width + 'x' + rp.composer.readBuffer.height : null });
      }
    };
    requestAnimationFrame(tick);
  }))()`).catch((e) => { console.warn(`[capture] perf probe failed: ${e.message.split('\n')[0]}`); return null; });
  const fps = perf ? +(1000 / perf.medianMs).toFixed(1) : null;
  const info = await page.evaluate(`(() => {
    const r = window.KB?.renderer?.renderer; if (!r) return null;
    return { calls: r.info.render.calls, triangles: r.info.render.triangles,
             programs: r.info.programs?.length ?? 0, textures: r.info.memory.textures,
             geometries: r.info.memory.geometries };
  })()`);

  /*
   * `complete` means the FULL shot list was written and verified -- nothing
   * weaker.
   *
   * It used to be the literal `true`, and the short-run warning below was
   * suppressed whenever --shots was passed. The effect was that a one-shot
   * `--shots 01-hero-idle` run overwrote the manifest with `complete: true`,
   * `defects: []` and a single entry, while 19 stale PNGs sat next to it in the
   * same directory. Two critics scoring the stage axis were handed frames that
   * the manifest vouched for and had never looked at.
   *
   * That is the THIRD defect of this exact class: c562242 hardened against two
   * runs sharing an output directory, 965f3c7 against a crashed run leaving a
   * manifest that looked successful, and this one against a deliberate partial
   * run certifying itself. The common root is that `complete` was an assertion
   * the writer made about itself rather than a fact derived from the run, so it
   * is now derived and cannot be asserted.
   */
  const missing = SHOTS.map((s) => s.name).filter((n) => !manifest.some((m) => m.name === n));

  /*
   * And now the same question asked of the DISK, against the declared roster.
   *
   * `missing` above is the old check and it is still the run comparing itself
   * with its own list. `roster` is the independent one: it knows what the
   * project expects to exist, it looks at the files rather than at the manifest,
   * and it names anything in the directory that no declared shot claims. A full
   * run is only `complete` if both agree.
   */
  const rosterAudit = auditDisk(OUT, list.map((s) => s.name));
  for (const m of rosterAudit.missing) {
    if (m.attempted) flaw(m.name, `DECLARED SHOT PRODUCED NO FILE (${m.file}) — the run tried and failed`);
    else if (!ONLY.length) flaw(m.name, `DECLARED SHOT NEVER TAKEN (${m.file}) — nothing in this run produced it`);
  }
  for (const u of rosterAudit.undersized) {
    flaw(u.name, `DELIVERED FILE IS ${u.bytes} BYTES, below the ${u.floor} floor — a truncated or `
      + 'blank write, not a capture');
  }
  if (rosterAudit.orphans.length) {
    console.warn(`[capture] ${rosterAudit.orphans.length} UNDECLARED FILE(S) in ${OUT}: `
      + `${rosterAudit.orphans.join(', ')} — no roster entry claims these. They may be stale frames `
      + 'from an earlier round; do not score them.');
  }

  const rosterOk = rosterAudit.missing.length === 0 && rosterAudit.undersized.length === 0;
  const complete = missing.length === 0 && !ONLY.length && rosterOk;

  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify({
    complete, only: ONLY.length ? ONLY : undefined, missing: missing.length ? missing : undefined,
    roster: { declared: ROSTER.length, ...rosterAudit, ok: rosterOk },
    shots: manifest, fps, perf, info, verified, defects,
    errors: errors.slice(0, 40),
  }, null, 2));
  if (!complete) {
    console.warn(`[capture] PARTIAL RUN: ${manifest.length} of ${SHOTS.length} shots written`
      + `${ONLY.length ? ` (--shots ${ONLY.join(',')})` : ''}. manifest.complete is false; `
      + 'this set must not be scored as a full pass.');
  }

  if (errors.length) {
    console.warn(`[capture] ${errors.length} console error(s):`);
    for (const e of errors.slice(0, 10)) console.warn('  ', e);
  }
  /*
   * THE ARCHIVE IS WRITTEN HERE, BY THE RUN THAT PRODUCED THE FRAMES.
   *
   * Two rounds tried to fix "no capture survives in git" and neither took.
   * Round 28 found the cause -- `.gitignore` said `shots/`, which matched
   * `docs/shots/` too -- and fixed the pattern, but the archive was still
   * exported by hand afterwards. So by the next round it was certifying
   * `baseCommit 7ac3fb2` against frames produced by a commit an hour and a half
   * newer, holding 18 shots where the run had 25, and recording every frame as
   * 1920x1080 when they had rendered between 1382x778 and native. All four
   * critics caught it independently and one said plainly that its "no
   * regression" finding was an assumption rather than a measurement, because no
   * before-frame existed anywhere in git.
   *
   * A hand-exported archive drifts by construction. This one is written by the
   * run itself, from the same frames, and the commit is READ rather than
   * declared -- `git rev-parse HEAD` plus a dirty flag, so a certification can
   * never again name a commit that did not produce the pixels. Only complete
   * runs archive: a subset run has nothing to say about a set it did not shoot.
   */
  if (complete) {
    try {
      const { execFileSync } = await import('node:child_process');
      const git = (a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
      const head = git(['rev-parse', 'HEAD']);
      const dirty = git(['status', '--porcelain']).length > 0;
      const dst = resolve(ROOT, 'docs/shots');
      mkdirSync(dst, { recursive: true });
      const entry = {};
      for (const m of manifest) {
        const png = m.file;
        if (!existsSync(png)) continue;
        const jpg = resolve(dst, `${m.name}.jpg`);
        // Tick strips are already written as JPEG, so they need copying rather
        // than re-encoding. Skipping them archived 18 of 25 on the first run --
        // and the seven it dropped were the per-clip animation strips, i.e.
        // precisely the new evidence the animation axis is now scored on.
        // ...and it must still be RECORDED. The first version copied the strip
        // and `continue`d before writing its entry, so seven files sat in the
        // archive directory that ARCHIVE.json did not list. An archive whose
        // index disagrees with its own contents is the exact failure this file
        // was written to end.
        if (!png.endsWith('.png')) {
          writeFileSync(jpg, readFileSync(png));
          const rs = (verified[m.name] || {}).res || {};
          entry[m.name] = { bytes: statSync(jpg).size, rendered: rs.buffer ?? null,
                            renderScale: rs.renderScale ?? null, strip: true };
          continue;
        }
        // Re-encoded in the page, because there is no image library in this
        // tool's dependencies and adding one for an archive step is not worth a
        // package. q92 4:4:4-ish via canvas rather than the previous q72 4:2:0:
        // the archive is compared against q90 4:4:4 references, and a critic
        // measured that the codec mismatch alone inflated our top-band energy
        // by roughly 50%. An archive that is not codec-matched to the thing it
        // exists to be compared against cannot carry a fine-scale statistic.
        const b64 = readFileSync(png).toString('base64');
        const out = await page.evaluate(`(async () => {
          const im = await new Promise((res, rej) => {
            const i = new Image(); i.onload = () => res(i); i.onerror = rej;
            i.src = 'data:image/png;base64,${b64}';
          });
          const c = document.createElement('canvas');
          c.width = im.width; c.height = im.height;
          c.getContext('2d').drawImage(im, 0, 0);
          return c.toDataURL('image/jpeg', 0.92).split(',')[1];
        })()`);
        writeFileSync(jpg, Buffer.from(out, 'base64'));
        const r = (verified[m.name] || {}).res || {};
        entry[m.name] = {
          bytes: statSync(jpg).size,
          // The size it was RENDERED at, not the size it was written at. The
          // previous archive recorded the delivered 1920x1080 for every frame,
          // which is the same class of error one level down from the one it was
          // created to fix.
          rendered: r.buffer ?? null, renderScale: r.renderScale ?? null,
        };
      }
      writeFileSync(resolve(dst, 'ARCHIVE.json'), JSON.stringify({
        head, dirty, writtenBy: 'tools/capture.mjs', shots: entry,
        note: 'Written by the capture run that produced these frames. `head` is read '
            + 'from git, not declared. If `dirty` is true the working tree had '
            + 'uncommitted changes and `head` does NOT fully describe the code that '
            + 'rendered them.',
      }, null, 1));
      console.log(`[capture] archived ${Object.keys(entry).length} frames to docs/shots at ${head.slice(0, 7)}`
        + `${dirty ? ' (TREE DIRTY — head does not fully describe these pixels)' : ''}`);
    } catch (e) {
      console.warn(`[capture] archive failed: ${e.message.split('\n')[0]}`);
    }
  }

  console.log(`[capture] wrote ${manifest.length} shots to ${OUT}`);
  if (info) console.log(`[capture] draw calls ${info.calls}, tris ${info.triangles}`);
  if (perf) console.log(`[capture] frame time ${perf.medianMs}ms median, ${perf.p95Ms}ms p95 over ${perf.frames} frames`
    + ` -> ${fps} fps${fps < 60 ? '  *** BELOW THE 60FPS CONSTRAINT ***' : ''}`);

  /**
   * Defects are warned WHEN THEY HAPPEN, which puts them above every later
   * shot's line and the whole perf block. Anyone reading the tail of a run --
   * which is what you read, because the fps verdict prints last -- sees none of
   * them. A dead 07-super capture was flagged correctly by the frame check and
   * still got measured and compared against two other candidates, because the
   * warning was forty lines up. Repeat the list last, where the verdict is.
   */
  if (defects.length) {
    console.warn(`\n[capture] *** ${defects.length} DEFECT(S) — THESE FRAMES ARE NOT SCOREABLE ***`);
    for (const d of defects) console.warn(`  ${d.shot}: ${d.problem}`);
  }

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
