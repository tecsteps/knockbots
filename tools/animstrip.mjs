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
 *   node tools/animstrip.mjs --clip p.straight
 *   node tools/animstrip.mjs --clip k.roundhouse,k.axeKick --step 4
 *   node tools/animstrip.mjs --all-attacks --out /tmp/scratch/anim
 */

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOVES } from '../src/combat/Moves.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OUT = resolve(ROOT, arg('out', 'shots/anim'));
const STEP = Number(arg('step', 0)) || 0;   // 0 = pick one that gives ~12 panels
const PANEL_W = Number(arg('panel', 320));
const PORT = Number(arg('port', 5230));
const CHAR = Number(arg('char', 0));
const DIST = Number(arg('dist', 0)) || 0;   // 0 = solved per clip

const DEFAULT_CLIPS = [
  'p.straight', 'p.uppercut', 'p.pistonRush', 'p.launcherPunch',
  'k.roundhouse', 'k.axeKick', 'k.sweep', 'k.spinKick',
  'sp.rocketPunch', 'sp.chargeShoulder',
];

const clips = argv.includes('--all-attacks')
  ? DEFAULT_CLIPS
  : arg('clip', '').split(',').filter(Boolean);

if (!clips.length) {
  console.error('usage: node tools/animstrip.mjs --clip <id>[,<id>...] | --all-attacks');
  console.error('NOTE: sheets from this tool are NOT certified evidence. See the header comment.');
  process.exit(1);
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
    window.KB.startMatch(${CHAR}, 1);
    window.KB.setPhase('fight');
    window.KB.cpu[0] = null;
    window.KB.cpu[1] = null;
    document.getElementById('ui').style.display = 'none';
  })()`);
  await page.waitForFunction("window.KB.phase === 'fight' && window.KB.phaseTicks > 60", null, { timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(600);

  const setKey = await page.evaluate('window.KB.fighters[0].moveSetKey ?? "standard"');

  for (const clip of clips) {
    const mv = moveFor(clip, setKey);
    const info = await page.evaluate(`(() => {
      const c = window.KB.fighters[0].animator?.clips?.['${clip}'];
      return c ? { duration: c.duration, loop: !!c.loop } : null;
    })()`);
    if (!info) { console.warn(`[anim] clip "${clip}" is not on the animator, skipping`); continue; }

    const span = mv ? mv.total : info.duration;
    const contact = mv && mv.active?.length ? Math.min(...mv.active.map((a) => a.from)) : null;
    const step = STEP || Math.max(1, Math.round(span / 11));
    const targets = stripTicks(span, contact, step);

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
  const cols = Math.max(1, Math.ceil(n / 2));
  const rows = Math.ceil(n / cols);
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
  g.fillText(`${n} panels · every ${D.step} ticks across 0..${D.span}`
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

main().catch((e) => { console.error(e); process.exit(1); });
