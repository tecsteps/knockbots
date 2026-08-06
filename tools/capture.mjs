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
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
    setup: `window.KB.startMatch(0, 1); window.KB.setPhase('fight');`,
    waitFor: `(() => {
      const b = document.querySelector('.announce-banner');
      return !!b && b.classList.contains('announce--run') && b.dataset.kind === 'fight';
    })()`,
    // announceCycle holds legibly from roughly 26% to 78% of its 1.5s run.
    settle: 600,
    // Measure the pixels, not the state that was supposed to produce them.
    verify: `(() => {
      const b = document.querySelector('.announce-banner');
      const inner = document.querySelector('.announce-inner');
      if (!b || !inner) return null;
      const r = inner.getBoundingClientRect();
      const opacity = +parseFloat(getComputedStyle(b).opacity).toFixed(2);
      return { kind: b.dataset.kind, opacity, ink: [Math.round(r.width), Math.round(r.height)],
               ok: opacity >= 0.5 && r.width >= 40 };
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
];

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

async function main() {
  if (!KEEP && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/`;

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

  takeLock(OUT);
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
  const ENTER_MATCH = `
    window.KB.menus.show(null);
    window.KB.paused = false;
    if (window.KB.phase !== 'fight') { window.KB.startMatch(0, 1); window.KB.setPhase('fight'); }
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
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
          lum.push(L);
          if (L < 0.012) black++;
          if (y < topRows) { topN++; if (L < 0.012) topBlack++; }
        }
      }
      lum.sort((a, b2) => a - b2);
      const q = (f) => +lum[Math.min(lum.length - 1, Math.floor(lum.length * f))].toFixed(4);
      const banner = document.querySelector('.announce-banner');
      const bannerUp = !!banner && parseFloat(getComputedStyle(banner).opacity) > 0.05;
      const out = {
        p50: q(0.5), p95: q(0.95), p999: q(0.999),
        blackFrac: +(black / lum.length).toFixed(3),
        topBlackFrac: +(topBlack / Math.max(1, topN)).toFixed(3),
        bannerOverFrame: bannerUp && !wantsBanner,
      };
      // Thresholds are deliberately loose -- this catches unscoreable frames,
      // not dark art direction. 07-super sat at p50 0.0044; a normal fight
      // frame is an order of magnitude above that.
      out.ok = out.p50 >= 0.012 && out.p95 >= 0.06 && out.blackFrac < 0.55
        && out.topBlackFrac < 0.9 && !out.bannerOverFrame;
      return out;
  }, { b64, wantsBanner });

  for (const shot of list) {
    try {
      await page.evaluate(`(() => { try { ${ENTER_MATCH} } catch (e) { console.error('enter', e); } })()`);
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
        offsets: shot.tickStrip.slice() };
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
      flaw(shot.name, `FRAME NOT SCOREABLE: ${why.join('; ')}`);
    }
    verified[shot.name] = { ...(verified[shot.name] || {}), frame };
    if (shot.freezeOnHit) {
      await page.evaluate(`(() => { window.KB.paused = false; ${RESTORE_CLOCK} })()`);
    }
    // A shot that overrode the camera rig has to hand it back, or every shot
    // after it inherits the override and quietly photographs the wrong framing.
    if (shot.pinTicks) {
      await page.evaluate(`(() => { ${RESTORE_CLOCK} window.KB.paused = false; })()`).catch(() => {});
    }
    if (shot.teardown) {
      await page.evaluate(`(() => { try { ${shot.teardown} } catch (e) { console.error('teardown', e); } })()`)
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
    const KB = window.KB;
    KB.paused = false;
    KB.startMatch(0, 1); KB.setPhase('fight'); KB.fightCamera.cinematic('fight');
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
              p95Ms: +dts[Math.floor(dts.length * 0.95)].toFixed(2) });
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

  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify({
    complete: true, shots: manifest, fps, perf, info, verified, defects,
    errors: errors.slice(0, 40),
  }, null, 2));
  if (manifest.length < SHOTS.length && !ONLY.length) {
    console.warn(`[capture] SHORT RUN: ${manifest.length} of ${SHOTS.length} shots written. `
      + 'The set is incomplete and must not be scored as a full pass.');
  }

  if (errors.length) {
    console.warn(`[capture] ${errors.length} console error(s):`);
    for (const e of errors.slice(0, 10)) console.warn('  ', e);
  }
  console.log(`[capture] wrote ${manifest.length} shots to ${OUT}`);
  if (info) console.log(`[capture] draw calls ${info.calls}, tris ${info.triangles}`);
  if (perf) console.log(`[capture] frame time ${perf.medianMs}ms median, ${perf.p95Ms}ms p95 over ${perf.frames} frames`
    + ` -> ${fps} fps${fps < 60 ? '  *** BELOW THE 60FPS CONSTRAINT ***' : ''}`);

  await browser.close();
  await server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
