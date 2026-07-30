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
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
      KB.paused = true;
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
      window.__kbCloseup = { clear, blocker: first ? first.object.name || '(unnamed)' : null,
        gap: first ? +(dist - first.distance).toFixed(3) : null, dist: +dist.toFixed(3) };
      return window.__kbCloseup;
    })()`,
    // Pausing the sim means the settle window is pure TAA convergence.
    settle: 3200,
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
    settle: 1200,
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
    freezeOnHit: true,
    impactOffset: 1,
    settle: 0,
  },
  {
    name: '04b-impact-decay',
    note: 'Eight ticks past contact — spark travel, ember fall, debris arc.',
    setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`,
    freezeOnHit: true,
    impactOffset: 8,
    settle: 0,
  },
  {
    name: '05-juggle',
    note: 'Airborne juggle — pose readability off the ground.',
    preRoll: true,
    setup: `window.KB.testHarness.forceJuggle({ attacker: 0, hits: 3 });`,
    settle: 1400,
  },
  {
    name: '06-stage-wide',
    note: 'Wide arena — environment, lighting, and depth cues.',
    setup: `window.KB.fightCamera.cinematic('wide', { dist: 14, height: 4.5 });`,
    settle: 1200,
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
    tickStrip: [1, 4, 10, 20, 34],
    settle: 0,
  },
  {
    name: '09-roster',
    note: 'All characters lined up — silhouette variety across the cast.',
    setup: `window.KB.testHarness.rosterLineup();`,
    settle: 1600,
  },
  {
    name: '10-ko',
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
    verify: '__kbKo',
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
];

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
      window.__kbHit = { tick: window.KB.tick, frames: 0 };
      stop();
      const wait = () => {
        if (window.__kbHit.frames >= off) {
          window.KB.paused = true;
          window.KB.clock.getDelta = () => 0;  // stop the effects ageing before the shutter
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
          .catch(() => console.warn(`[capture] ${shot.name}: round-start banner never cleared`));
        await page.waitForTimeout(400);
        if (shot.freezeOnHit) await page.evaluate(ARM_HIT_FREEZE(shot.impactOffset ?? 0));
      }
      // Every shot arms a hit sentinel, so any shot can wait on contact rather
      // than on a guessed delay. Cheap, and it removes the whole class of
      // "photographed the wind-up" failure that has cost this project four
      // rounds of invalid scores on two different axes.
      await page.evaluate(`(() => {
        window.__kbShotHit = null;
        const stop = window.KB.bus.on('hit', (e) => {
          window.__kbShotHit = { landed: true, tick: window.KB.tick };
          stop();
        });
      })()`);
      if (shot.prep) await page.evaluate(`(() => { try { ${shot.prep} } catch (e) { console.error('prep', e); } })()`);
      await page.evaluate(`(() => { try { ${shot.setup} } catch (e) { console.error('shot setup', e); } })()`);
      if (shot.waitFor) {
        await page.waitForFunction(shot.waitFor, null, { timeout: 15000 })
          .catch(() => console.warn(`[capture] ${shot.name}: WAITED OUT — "${shot.waitFor}" never became true, `
            + 'this frame is not the moment the shot is named for and must not be scored'));
      }
      if (shot.verify) {
        // A shot that can report whether it framed its subject must be made to
        // say so out loud, and the answer rides into the manifest so a score
        // can never again be defended with a frame nobody checked.
        const v = await page.evaluate(`window.${shot.verify} ?? null`);
        verified[shot.name] = v;
        if (v === null) {
          console.warn(`[capture] ${shot.name}: SELF-CHECK DID NOT FIRE (${shot.verify}) — `
            + 'this frame is not the moment the shot is named for and must not be scored');
        } else if (v.clear === false) {
          console.warn(`[capture] ${shot.name}: SUBJECT OCCLUDED by ${v.blocker} (${v.gap}m in front) — do not score this frame`);
        } else if (v.dist) {
          console.log(`[capture] ${shot.name}: subject clear at ${v.dist}m`);
        } else {
          console.log(`[capture] ${shot.name}: verified ${JSON.stringify(v)}`);
        }
      }
      if (shot.freezeOnHit) {
        await page.waitForFunction('window.__kbHit && window.__kbHit.frozen', null, { timeout: 15000 })
          .catch(() => console.warn(`[capture] ${shot.name}: no hit landed, frame is not a contact frame`));
      }
    } catch (e) {
      console.warn(`[capture] setup failed for ${shot.name}: ${e.message}`);
    }
    if (shot.settle) await page.waitForTimeout(shot.settle);
    const file = resolve(OUT, `${shot.name}.png`);

    if (shot.tickStrip) {
      // Sample on the sim's own tick counter and tile the frames, so motion that
      // lives in a few ticks can actually be reviewed. Same reasoning as the
      // contact-frame freeze: a still cannot show easing.
      const frames = [];
      const base = await page.evaluate('window.KB.tick');
      for (const off of shot.tickStrip) {
        await page.waitForFunction(`window.KB.tick >= ${base + off}`, null, { timeout: 15000 }).catch(() => {});
        frames.push({ t: off, b64: (await page.screenshot()).toString('base64') });
      }
      const sheet = await page.evaluate(async ({ cells, label }) => {
        const imgs = await Promise.all(cells.map((c) => new Promise((res) => {
          const im = new Image(); im.onload = () => res(im); im.src = 'data:image/png;base64,' + c.b64;
        })));
        const w = imgs[0].width, h = Math.round(imgs[0].height * 0.34); // HUD lives in the top third
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
      }, { cells: frames, label: `${shot.name}  ·  ticks after damage` });
      writeFileSync(file.replace(/\.png$/, '.jpg'), Buffer.from(sheet.split(',')[1], 'base64'));
      await page.evaluate(`(() => { ${RESTORE_CLOCK} })()`);
      manifest.push({ name: shot.name, note: shot.note, file: file.replace(/\.png$/, '.jpg') });
      console.log(`[capture] ${shot.name} (tick strip)`);
      continue;
    }

    await page.screenshot({ path: file });
    if (shot.freezeOnHit) {
      await page.evaluate(`(() => { window.KB.paused = false; ${RESTORE_CLOCK} })()`);
    }
    // A shot that overrode the camera rig has to hand it back, or every shot
    // after it inherits the override and quietly photographs the wrong framing.
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

  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify({ shots: manifest, fps, perf, info, verified, errors: errors.slice(0, 40) }, null, 2));

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
