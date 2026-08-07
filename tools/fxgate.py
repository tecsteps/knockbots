#!/usr/bin/env python3
"""Impact & effects gate — the measurement behind the impact axis score.

WHY THIS FILE WAS REWRITTEN IN ROUND 29
---------------------------------------
The round-28 version of this file defined "effect ink" as *pixels with Rec.709
luma > 0.90* and "a particle" as *a connected component of that mask*. Both are
wrong, and the error is not small. Measured against a per-pixel ground truth
built by rendering the same frozen contact frame twice — once with the spark,
debris and trail meshes visible and once with them hidden — `luma > 0.90` scores,
over the scene rows of the four impact frames:

        frame                 precision   recall
        16-impact-heavy         0.375      0.191
        04-impact               0.261      0.151
        04b-impact-decay        0.045      0.043
        15-impact-light         0.019      0.077

On the flagship frame, five pixels in eight that the gate counted as effect were
not effect, and four fifths of the effect was not counted. On `15-impact-light`
and `04b-impact-decay` the number is essentially pure contamination: what the
mask actually lands on is Kestrel's near-white armour plates, the specular
highlights along the panel edges, the floating damage badge and the ring decal.
Overlay the mask and you can see it — the magenta is painted over the robot, not
over the sparks.

Every headline the round-28 gate produced is therefore a measurement of armour:
`ink 3.552% / 6.996%`, `N 104 / 112`, `dimP90 32.7 against a reference 10.0-11.8`,
and the `light->heavy 1.97x` weight ladder. None of them may be quoted. The
round-27 gate they replaced ("particle count 11-29") did not reproduce at all;
this is the same failure one level up — a number that reproduces exactly and
measures the wrong thing.

WHAT REPLACES IT
----------------
A **paired measurement**. `--probe` freezes the contact frame, grabs it, hides
`SparkSystem`, `DebrisSystem` and `TrailSystem`, grabs it again, and shows them
again for a third grab. The per-pixel difference of the first two IS the effect,
exactly, with no thresholding heuristic anywhere in it. The difference of the
first and third is the noise floor, and it reads **cover 0.0000%, N=0** — the
null control the previous two gates never had.

Three capture-integrity findings had to be fixed before the pair would pair, and
they apply to anything else that A/Bs a frozen frame:

  1. Two separate `capture.mjs` runs of the same shot list DO NOT PAIR. The
     freeze lands on a different rendered frame each run and the camera has
     drifted by then: whole-frame MAD 0.19, background-only MAD 0.10-0.16. The
     grabs must be two grabs of ONE frozen frame in ONE page.
  2. A frozen frame is not frozen. `KB.paused` gates the simulation, not the
     render; pinning `clock.getDelta` to 0 still leaves (a) the grade pass
     advancing its own clock — it steps by `(deltaTime || 0.016)` and 0 is falsy,
     so the film grain keeps moving — and (b) the adaptive-resolution controller
     ratcheting `renderScale`, which resamples the WHOLE frame between grabs.
     With both live, two grabs of one frozen frame differ by MAD 0.016-0.051
     over 45% of pixels, which is larger than the effect being measured.
  3. Even with those pinned, the FIRST grab after the freeze is wrong. Six
     consecutive grabs with nothing toggled: grab 0 differs from the rest by
     MAD 0.0129, grabs 1-5 agree to 0.00005. The post chain needs one presented
     frame to settle. `--probe` throws the first grab away.

THE REFERENCE COMPARISON CANNOT BE MADE ON PIXELS, AND THAT IS THE OTHER RESULT
------------------------------------------------------------------------------
Ground truth needs a frame pair. Third-party stills cannot be re-rendered, so
there is no ground truth for `ref/tekken8/` and never will be. The only way to
put a number on a reference frame is an image-only proxy — and `--validate`
measures every proxy this file could construct against ground truth. The best of
them reaches F1 0.25 on the flagship and 0.02-0.06 on the other three. There is
no image-only statistic in this repo that isolates impact effects.

So: **no pixel statistic may be quoted comparing this axis to Tekken 8.** Four
rounds of them have been. The reference comparison on this axis has to be the
blind test in docs/CRITIC.md, run by a critic on the frames; the gate below is a
KB-internal instrument for A/B and for round-over-round drift, and it is honest
about being only that. `--ref` prints the proxy over the reference subset with
its measured precision attached, so the number is visible and unusable at the
same time.

THE GATE NEEDS REPEATS, AND THAT IS THE THIRD RESULT
----------------------------------------------------
Run `--probe` five times and measure each. The spread, min / median / max:

    16-impact-heavy   cover  5.68 /  5.89 /  7.88   1.39x
                      N        82 /   107 /   237   2.89x
                      elong  2.31 /  2.77 /  3.33   1.44x
                      fine   30.5 /  31.8 /  34.8   1.14x
    15-impact-light   cover  0.98 /  1.58 /  4.87   4.97x
                      energy 0.15 /  0.27 /  1.25   8.45x
    04b-impact-decay  cover  2.05 /  2.65 /  8.35   4.07x

**The cause is not the effects.** Compare the fx-OFF frames — pure scene, no
particles in them at all — between two runs of the same shot: MAD 0.087 to
0.214 over 74-91% of pixels, and the background phase-correlation peak falls
from the 0.73 of a genuinely matched pair to 0.016-0.285. The certified contact
frame lands on a different camera pose and a different pair of fighter positions
every run, because `forceHit` fires from whatever state the previous shot left
and the camera is a spring-damper with the whole session's history in it.

Two consequences, and they are larger than anything an FX change could buy:

  - Single-run `cover`, `energy` and `N` on this axis cannot resolve better
    than a factor of about two. Round 28's revert evidence — component count
    -20/-15/-7% and effect ink -10/-13% — is an order of magnitude inside that
    spread and was not significant in either direction. The revert was right
    under the charter given what was known; the deltas that justified it were
    noise.
  - The stable statistics are the SHAPE ones: `elong` 1.21-1.44x and `fine`
    1.13-1.50x across the same five runs. Quote those. `N` is the least stable
    thing in the table (2.9x on the flagship) and is exactly what both previous
    gates were built on.

Until `capture.mjs` can put the contact frame on a deterministic camera and
pose (see SHOT SET at the bottom of this file), use `--repeat` and quote the
median of at least five runs, never a single number.

The spreads in that table are also partly the banner: re-measured on clean
pairs, five runs, they are cover 1.31-2.09x and N 1.30-2.07x rather than the
4.97x and 2.89x above. The rule stands — a single run cannot resolve a factor
of two on this axis — but the instrument was contributing to the number that
justified it.

FRAME COST does not resolve here either. The probe times 60 rendered frames of
the frozen contact frame with the FX meshes shown and hidden. Over five runs the
on-minus-off difference ran from -11.1 ms to +12.7 ms WITH THE SIGN FLIPPING, on
a frame that itself varied 15.7-46.3 ms. The particulate FX cost at contact is
below the noise of a headless rAF timer. It is written to `pairs.json` and must
not be quoted.

DEFINITIONS
-----------
  SCENE ROI  fractional (y0,y1,x0,x1) = (0.162, 1.000, 0.000, 1.000). Fractional
             so a resolution change does not move it — a pixel ROI landed on
             background in one of two resolutions last round and returned N=0.
             The top 16.2% is the HUD; it never contains effects and including
             it only dilutes densities. Everything below it is in, so there is
             no ROI to cherry-pick and no "which pixels" left open.
  EFFECT E   per-pixel `max(0, luma(fx_on) - luma(fx_off))`, display luma,
             Rec.709. This is what the particulate FX added to the frame.
  EFFECT PX  E > 0.02 (about 5 code values). The null pair reads 0.0000% here.
  PARTICLE   8-connected component of the effect mask with area >= 4 px at
             1080p, scaled as (H/1080)^2 so the count survives a resize.
  major      max(bbox h, bbox w) of a component, reported in 1080p-equivalent px.
  elong      sqrt of the ratio of the PCA eigenvalues of a component's pixel
             coordinates. 1.0 is a disc, >3 is a streak. This is the statistic
             docs/CRITIC.md's "generic round sprites" complaint is about.
  cover      % of the SCENE ROI that is effect pixels.
  energy     mean of E over the SCENE ROI, x100. The effect's total light,
             which unlike `cover` does not saturate when streaks overlap.

usage:
  python3 tools/fxgate.py --probe DIR    render the paired frames into DIR
  python3 tools/fxgate.py --gate DIR     the gate: ground-truth metrics + nulls
  python3 tools/fxgate.py --repeat N DIR N probe runs, min/median/max. THIS IS
                                         THE ONE TO USE. A single run cannot
                                         resolve a factor of two on this axis.
  python3 tools/fxgate.py --validate DIR proxy-vs-ground-truth precision table
  python3 tools/fxgate.py --control DIR  resolution round-trip control
  python3 tools/fxgate.py --ref          image-only proxy over the reference
                                         subset, WITH its precision. Not a gate.
  FXGATE_ATTRIB=1 python3 tools/fxgate.py --probe DIR   then --attrib DIR:
                                         per-system share of cover and energy.
  python3 tools/fxgate.py --cost DIR     FX frame cost at the contact frame at
                                         NATIVE 1080p, by alternating holds.
  FXGATE_COUNTSCALE=k                    multiplies every spark burst's count,
                                         for --probe and --cost. An experiment
                                         knob; ships at 1.

THE NULL CONTROL DID NOT HOLD, AND WHAT IT WAS MEASURING WAS THE "FIGHT" BANNER
-------------------------------------------------------------------------------
The claim above — "the null pair reads 0.0000% here" — reproduces on ONE of the
four shots. Re-derived, round 31:

        frame               null cover    null energy
        16-impact-heavy       0.0000        0.0000
        15-impact-light       2.1387        0.7281
        04-impact             2.2249        0.8702
        04b-impact-decay      2.2493        0.8776

Two point two per cent of the scene ROI, against a measured effect of 4.2 to
11.1 per cent. On `15-impact-light` the instrument's own noise was HALF the
signal. Localised, the contamination is a compact block at rows 448-641,
columns 655-1294 — and cropping it out and looking at it, it is the round-start
**"FIGHT" announcement**, a full-width DOM banner drawn across the middle of the
contact frame and fading on wall-clock time.

It is not merely noise in the null. `on.png` and `off.png` are separated by a
90-frame cost probe, so the banner is visibly dimmer in the second, and
`max(0, luma(on) - luma(off))` scored that fade AS EFFECT. Every cover, energy
and N figure for those three shots was inflated by an announcement banner, and
so was the light->heavy weight ladder, since 16-impact-heavy froze late enough
to have no banner and 15-impact-light did not.

`tools/capture.mjs` has gated on exactly this since round 14 and documents why
("FIGHT was being drawn across the exact frames the impact and KO axes are
judged on"). fxgate builds its own page and did not. **The same defect, fixed in
one instrument and live in the other, which is the fourth time that shape
appears in docs/PROFILING.md.**

Fixed twice over, because waiting was not sufficient: `NO_BANNER` is true both
after an announcement and before one is queued, and across runs the certified
contact landed at tick 88 (banner still to come) and tick 195 (banner waited
out) on the same shot. The probe now waits AND hard-hides `.announce-layer` at
the freeze, pauses every running CSS animation, and records `bannerAtFreeze`.
`--repeat` prints the null for every run and flags it, so this can never again
be a number somebody checked once by hand.

With that fixed the null reads 0.000000% on all four shots across five runs.

THE GATE WAS BLIND TO FIVE OF THE EIGHT SYSTEMS (round 31)
----------------------------------------------------------
`EffectsDirector` owns eight mesh-backed systems — sparks, debris, trails,
shock, smoke, fluid, flashes, decals — and the round-29 `FX()` toggle hid three
of them. Everything the other five put on the contact frame was in BOTH halves
of the pair, so it cancelled: shockwave rings, smoke, coolant spray, hit flashes
and scorch decals were invisible to the instrument that scores this axis. A
tuning pass driven by that gate would have been optimising three systems while
five moved unmeasured.

`FX()` now toggles all eight, and `--attrib` reports each system's own share by
hiding exactly one at a time.

The critic's figure for the size of the blind spot — 46% of coverage, 36% of
energy — does NOT reproduce, and it is not a small correction. Measured with
`--attrib` on a clean pair, what the three-system toggle could see was:

        frame               of cover    of energy
        15-impact-light       89.6%       95.2%
        16-impact-heavy       75.6%       81.1%
        04-impact             80.3%       82.5%
        04b-impact-decay      64.5%       61.8%

so the blind spot was 10-36% of cover and 5-38% of energy, not a flat 46/36.
The direction was right and the fix was worth making; the magnitude was not.
Two other things fell out of the same table and neither was expected:
`fluid` contributes exactly 0.0000% on all four impact frames, and `debris`
contributes 0.0-0.6% on three of the four — one of the three systems the old
gate COULD see puts essentially nothing on a contact frame.

Every round-29 `cover`/`energy`/`N` figure on this axis is superseded by the
banner fix and the eight-system toggle together. They are not comparable and
must not be differenced against anything measured here.

FRAME COST DOES RESOLVE, ONCE IT IS MEASURED IN ALTERNATING HOLDS
-----------------------------------------------------------------
The note above says the FX cost at contact is below the noise of a headless rAF
timer. That was a property of the probe, not of the frame: one 90-frame A block
followed by one 90-frame B block puts every bit of the machine's second-scale
load drift straight into the difference. docs/CHARTER.md measured the draw-call
cost correctly by alternating short holds, and `--cost` now does the same —
twelve ABAB holds of 40 frames, differenced WITHIN each pair, at NATIVE 1080p
with the adaptive controller off. All eight FX systems, on against off, at the
frozen contact frame:

        16-impact-heavy   +0.200 ms   [-0.300, +0.400]
        04-impact         +0.200 ms   [-2.800, +1.800]
        04-impact (quiet) +0.100 ms   [-0.000, +0.500]

and at FXGATE_COUNTSCALE=3 — three times the sparks — it is still +0.200 ms.
**The particulate FX layer costs about a fifth of a millisecond at the contact
frame and the spark count is not what the frame is spent on**, which is what
the charter's fill-bound decomposition predicts: a few thousand small additive
quads with an early `discard` against an arena covering 85% of the screen.

Absolute frame time from this probe is NOT an fps claim. It was taken with a
dozen other agents live in the same workspace and read 23-58 ms for the same
build within one session. The paired delta is drift-immune; the absolute is not.
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SHOTS = ['15-impact-light', '16-impact-heavy', '04-impact', '04b-impact-decay']

# Fractional. See DEFINITIONS. Not per-shot: with a true effect mask there is
# nothing to isolate by cropping, and a per-shot crop is a free parameter.
SCENE = (0.162, 1.000, 0.000, 1.000)

EFFECT_THR = 0.02
AREA_MIN_1080 = 4

# The comparable subset, re-derived by looking at all ten rather than inherited.
# Criterion: an IN-MATCH frame (fight HUD present) with a contact or effect
# actually in it. 03, 05, 07, 09 are portraits or a no-impact wide; 04 and 08 are
# closeup cinematics with no contact; 10 is the hub screen.
#   tekken8_01  in-match, chest-up two-shot, rage aura + contact
#   tekken8_02  in-match, full-body wide, dust plume + energy hand   <- framing
#   tekken8_06  in-match, rage-art cinematic, full-body slash        <- framing
# 02 and 06 are the two whose framing matches 15/16/04. 01 is a closer two-shot
# and is kept only because excluding an in-match contact frame for being close
# would be exactly the round-25 subset error in reverse.
REF_SUBSET = ['tekken8_01', 'tekken8_02', 'tekken8_06']

PROBE_JS = r'''
/**
 * Paired FX capture. Written by tools/fxgate.py; see that file for why every
 * line of the freeze block is here.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = process.argv[2];
const ROOT = process.argv[3];
const PORT = Number(process.argv[4] || 5311);
// Multiplies the emitted spark count without touching HIT_FX (owned by another
// workstream). Used to settle the round-28 question -- does raising the count
// raise or lower the count the gate measures? -- as an experiment rather than
// a code change. 1 is the shipping behaviour.
const CS = Number(process.env.FXGATE_COUNTSCALE || 1);
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { name: '15-impact-light', setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'jab' });`, off: 1 },
  { name: '16-impact-heavy', setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'heavy', dist: 1.55 });`, off: 1 },
  { name: '04-impact', setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`, off: 1 },
  { name: '04b-impact-decay', setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });`, off: 8 },
];

const ARM = (off) => `(() => {
  window.__kbHit = null;
  if (!window.__kbClock) window.__kbClock = window.KB.clock.getDelta.bind(window.KB.clock);
  window.KB.timeScale = 1;
  window.KB.clock.getDelta = () => 1 / 60;
  const stop = window.KB.bus.on('hit', (e) => {
    window.__kbHit = { tick: window.KB.tick, frames: 0, landed: true,
      move: (e && e.move && (e.move.id || e.move.name)) || null,
      weight: (e && e.move && e.move.weight) || null,
      damage: (e && e.damage != null) ? e.damage : null };
    stop();
    const wait = () => {
      if (window.__kbHit.frames >= ${off}) {
        window.KB.paused = true;
        window.KB.clock.getDelta = () => 0;
        // The camera keeps moving on a frozen frame -- FightCamera.render floors
        // its own dt -- so without this the two grabs sit on different poses and
        // the difference mask is the camera, not the effect.
        const fc = window.KB.fightCamera;
        fc.render = () => {}; fc.simulate = () => {};
        const rp = window.KB.renderer;
        // Film grain: the grade pass steps by (deltaTime || 0.016), and 0 is
        // falsy, so pinning the clock does not stop it.
        rp.setGrade({ grain: 0 });
        // Adaptive resolution: a scale change between grabs resamples the whole
        // frame.
        if (rp.effects) rp.effects.adaptiveResolution = false;
        if (rp.tier) { rp.renderScale = rp.tier.renderScale; rp._targetScale = rp.tier.renderScale; }
        window.__kbHit.renderScale = rp.renderScale;
        window.__kbHit.frozen = true;
      } else { window.__kbHit.frames++; requestAnimationFrame(wait); }
    };
    wait();
  });
})()`;

// ALL EIGHT mesh-backed systems on EffectsDirector, not the three the round-29
// version toggled. See "THE GATE WAS BLIND TO FIVE OF THE EIGHT SYSTEMS".
const FX_SYSTEMS = ['sparks', 'debris', 'trails', 'shock', 'smoke', 'fluid', 'flashes', 'decals'];
const FX = (v) => `(() => {
  const d = window.__kbFx && window.__kbFx.director;
  if (!d) return 'NO DIRECTOR';
  const K = ${JSON.stringify(FX_SYSTEMS)};
  for (const k of K) if (d[k] && d[k].mesh) d[k].mesh.visible = ${v};
  return K.map((k) => k + '=' + (d[k] && d[k].mesh ? d[k].mesh.visible : 'MISSING')).join(' ');
})()`;

// Per-system attribution: hide exactly one system, grab, show it again. The
// difference from the all-on frame is that system's own contribution, which is
// the only way to tell which system a coverage change came from.
const FX_ONE = (k, v) => `(() => {
  const d = window.__kbFx && window.__kbFx.director;
  if (!d || !d['${k}'] || !d['${k}'].mesh) return 'MISSING';
  d['${k}'].mesh.visible = ${v};
  return '${k}=' + d['${k}'].mesh.visible;
})()`;

// The probe re-enters the fight phase, which replays the round-start intro, so
// a full-width "FIGHT" banner was being drawn over the middle of the contact
// frame -- and it FADES between the on grab and the off grab, so its fade was
// being scored as effect. tools/capture.mjs already gates on exactly this and
// fxgate's own page setup did not. See "THE GATE WAS MEASURING THE FIGHT
// BANNER" in the module docstring.
const NO_BANNER = `(() => {
  const q = window.KB && window.KB.hud && window.KB.hud.announceQueue;
  const busy = window.KB && window.KB.hud && window.KB.hud.announceBusy;
  const el = document.querySelector('.announce-layer');
  const visible = el && getComputedStyle(el).opacity > 0.02 && el.textContent.trim();
  return !busy && (!q || q.length === 0) && !visible;
})()`;

// The wait alone is NOT enough and that is measured. `NO_BANNER` is true both
// AFTER an announcement and BEFORE one has been queued, so whether the probe
// waits out the banner or sails straight past it depends on whether the page
// happened to be in the fight phase already: across runs the certified contact
// landed at tick 88 (no banner queued yet, banner still to come) and at tick
// 195 (waited it out) on the same shot. So the freeze also HARD-HIDES the
// announce layer, which is a DOM sibling of the canvas and contributes nothing
// to the render. That makes the pair clean whatever the timing did, and
// `bannerAtFreeze` records whether it was actually up.
const FREEZE_DOM = `(() => {
  const a = document.getAnimations ? document.getAnimations() : [];
  a.forEach((x) => { try { x.pause(); } catch (e) { /* already finished */ } });
  const el = document.querySelector('.announce-layer');
  const up = !!(el && getComputedStyle(el).opacity > 0.02 && el.textContent.trim());
  if (el) el.style.display = 'none';
  return { anims: a.length, bannerAtFreeze: up };
})()`;

const settle = (page, n = 4) => page.evaluate(`new Promise((r) => {
  let k = ${n}; const step = () => (k-- > 0 ? requestAnimationFrame(step) : r(1)); step();
})`);

// Frame cost at the CONTACT FRAME, which is the only place this axis can spend
// anything. Idle medians say nothing about a burst.
const COST = `(() => new Promise((res) => {
  const t = []; let last = performance.now();
  const step = () => { const n = performance.now(); t.push(n - last); last = n;
    if (t.length < 90) requestAnimationFrame(step);
    else { const s = t.slice(30).sort((a, b) => a - b); res(+s[s.length >> 1].toFixed(3)); } };
  requestAnimationFrame(step);
}))()`;

const server = await createServer({
  root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  logLevel: 'error',
});
await server.listen();
const url = `http://127.0.0.1:${PORT}/`;
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-zero-copy', '--disable-frame-rate-limit',
    '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const manifest = { pairs: {}, note: 'fx-on / fx-off pair of ONE frozen frame; on2 is the null control' };

for (const s of SHOTS) {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.evaluate(`(() => {
    window.KB.menus.show(null); window.KB.paused = false;
    if (window.KB.phase !== 'fight') { window.KB.startMatch(0, 1); window.KB.setPhase('fight'); }
  })()`);
  await page.waitForTimeout(1200);
  await page.waitForFunction(NO_BANNER, null, { timeout: 20000 });
  const bannerGone = await page.evaluate(NO_BANNER);
  await page.evaluate(`(() => {
    const d = window.__kbFx && window.__kbFx.director;
    if (d && d.sparks) d.sparks.countScale = ${CS};
  })()`);
  await page.evaluate(ARM(s.off));
  await page.evaluate(s.setup);
  await page.waitForFunction('window.__kbHit && window.__kbHit.frozen', null, { timeout: 8000 });
  const dom = await page.evaluate(FREEZE_DOM);
  const hit = await page.evaluate('window.__kbHit');
  // Grab 0 is discarded: the post chain needs one presented frame after the
  // freeze pins the grade and the resolution. Measured, grab 0 is MAD 0.0129
  // from grabs 1-5, which agree to 0.00005.
  await settle(page, 6);
  await page.screenshot({ path: resolve(OUT, `${s.name}.discard.png`) });
  await settle(page);
  await page.screenshot({ path: resolve(OUT, `${s.name}.on.png`) });
  const costOn = await page.evaluate(COST);
  const visOff = await page.evaluate(FX(false));
  await settle(page);
  await page.screenshot({ path: resolve(OUT, `${s.name}.off.png`) });
  const costOff = await page.evaluate(COST);
  await page.evaluate(FX(true));
  await settle(page);
  await page.screenshot({ path: resolve(OUT, `${s.name}.on2.png`) });
  // Per-system attribution: opt-in, because it is 8 extra 1080p PNGs per shot
  // and a full disk took this workspace offline in round 27.
  if (process.env.FXGATE_ATTRIB === '1') {
    for (const k of FX_SYSTEMS) {
      const r = await page.evaluate(FX_ONE(k, false));
      if (r === 'MISSING') continue;
      await settle(page);
      await page.screenshot({ path: resolve(OUT, `${s.name}.no-${k}.png`) });
      await page.evaluate(FX_ONE(k, true));
    }
    await settle(page);
  }
  manifest.pairs[s.name] = { ...hit, contactMsOn: costOn, contactMsOff: costOff,
    systems: visOff, bannerGone, ...dom, countScale: CS };
  console.log(`[fxprobe] ${s.name} ${JSON.stringify(manifest.pairs[s.name])}`);
}

writeFileSync(resolve(OUT, 'pairs.json'), JSON.stringify(manifest, null, 2));
await browser.close();
await server.close();
'''


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def load(path):
    return np.asarray(Image.open(path).convert('RGB')).astype(np.float32) / 255


def crop(a, roi=SCENE):
    h, w = a.shape[:2]
    return a[int(roi[0] * h):int(roi[1] * h), int(roi[2] * w):int(roi[3] * w)]


def effect(on, off):
    """The mask, exactly. No threshold on brightness, no morphology, no ROI
    tuning -- just what the FX meshes put on the frame."""
    return np.clip(luma(crop(on)) - luma(crop(off)), 0, None)


def components(mask, scale):
    """@param scale frame height / 1080, so sizes and the area floor are
    reported in 1080p-equivalent units whatever the capture resolution is."""
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    if not n:
        return np.array([]), np.array([]), np.array([])
    areas = np.asarray(ndimage.sum(mask, lab, range(1, n + 1)))
    amin = max(1, round(AREA_MIN_1080 * scale * scale))
    maj, el, keep = [], [], []
    for i, o in enumerate(ndimage.find_objects(lab)):
        if areas[i] < amin:
            continue
        ys, xs = np.nonzero(lab[o] == i + 1)
        if len(xs) > 1:
            ev = np.linalg.eigvalsh(np.cov(np.vstack([xs.astype(float), ys.astype(float)])))
            ev = np.clip(ev, 1e-6, None)
            el.append(float(np.sqrt(ev[1] / ev[0])))
        else:
            el.append(1.0)
        maj.append(max(o[0].stop - o[0].start, o[1].stop - o[1].start) / scale)
        keep.append(areas[i])
    return np.array(maj), np.array(el), np.array(keep)


def measure(on, off):
    E = effect(on, off)
    scale = on.shape[0] / 1080.0
    m = E > EFFECT_THR
    maj, el, _ = components(m, scale)
    return {
        'cover': float(m.mean() * 100),
        'energy': float(E.mean() * 100),
        'n': int(len(maj)),
        'density': float(len(maj) / (m.size / 1e6)),
        'maj50': float(np.median(maj)) if len(maj) else 0.0,
        'maj90': float(np.percentile(maj, 90)) if len(maj) else 0.0,
        'elong': float(np.median(el)) if len(el) else 0.0,
        'fine': float((maj < 6).mean() * 100) if len(maj) else 0.0,
    }


def row(name, r):
    return ('  %-18s cover=%6.3f%% energy=%7.4f N=%4d (%6.1f/Mpx) maj50=%5.1f '
            'maj90=%5.1f elong=%.2f fine=%4.1f%%'
            % (name, r['cover'], r['energy'], r['n'], r['density'],
               r['maj50'], r['maj90'], r['elong'], r['fine']))


def pair_paths(d, name):
    return (os.path.join(d, name + '.on.png'),
            os.path.join(d, name + '.off.png'),
            os.path.join(d, name + '.on2.png'))


def cmd_probe(out):
    js = os.path.join(out, '_fxprobe.mjs')
    os.makedirs(out, exist_ok=True)
    with open(js, 'w') as f:
        f.write(PROBE_JS)
    subprocess.check_call(['node', js, out, REPO], cwd=REPO)
    for n in SHOTS:
        p = os.path.join(out, n + '.discard.png')
        if os.path.exists(p):
            os.remove(p)


def cmd_gate(d):
    print('KNOCKBOTS — impact gate, ground truth (fx-on minus fx-off, one frozen frame)')
    print('SCENE ROI %s  effect px E>%.2f  particle >=%dpx@1080p\n' % (SCENE, EFFECT_THR, AREA_MIN_1080))
    kb = {}
    for n in SHOTS:
        a, b, c = pair_paths(d, n)
        kb[n] = measure(load(a), load(b))
        print(row(n, kb[n]))

    print('\nNULL CONTROL — fx-on vs fx-on, same frozen frame. Anything but zero is')
    print('the instrument measuring itself.')
    for n in SHOTS:
        a, _, c = pair_paths(d, n)
        z = measure(load(a), load(c))
        print(row(n + ' null', z))

    print('\nWEIGHT LADDER — 15 and 16 are the only camera-matched pair in the shot')
    print('set (verified: phase-correlation peak 0.73 and background MAD 0.0069')
    print('between them, against peak 0.03 and MAD 0.09-0.23 for every other pair).')
    l, h = kb['15-impact-light'], kb['16-impact-heavy']
    print('  jab -> heavy   cover %.3f -> %.3f = %.2fx   energy %.4f -> %.4f = %.2fx'
          % (l['cover'], h['cover'], h['cover'] / max(l['cover'], 1e-9),
             l['energy'], h['energy'], h['energy'] / max(l['energy'], 1e-9)))
    print('  damage 11.50 -> 40.25 = 3.50x')
    print('  the launcher rung is NOT on this ladder: 04-impact is a different')
    print('  camera. See "SHOT SET" at the bottom of this file.')

    print('\nDECAY — 04-impact -> 04b (+8 rendered frames). CONFOUNDED, and reported')
    print('only so the confound is on the record: the two are different camera')
    print('poses (phase-correlation peak 0.028 on an effect-free background patch,')
    print('against 0.73 for a matched pair), because FightCamera keeps advancing')
    print('between +1 and +8.')
    a, b = kb['04-impact'], kb['04b-impact-decay']
    print('  cover %.3f -> %.3f (%.0f%%)   energy %.4f -> %.4f (%.0f%%)'
          % (a['cover'], b['cover'], 100 * b['cover'] / max(a['cover'], 1e-9),
             a['energy'], b['energy'], 100 * b['energy'] / max(a['energy'], 1e-9)))


def cmd_repeat(n, out):
    """N independent probe runs, reported as a distribution. Deletes each run's
    PNGs as it goes -- a 1080p pair set is ~40 MB and a full disk took every
    agent in this workspace offline for minutes in round 27."""
    runs = {s: [] for s in SHOTS}
    nulls = {s: [] for s in SHOTS}
    ok = 0
    for i in range(int(n)):
        d = os.path.join(out, 'run%02d' % i)
        try:
            cmd_probe(d)
            for s in SHOTS:
                a, b, c = pair_paths(d, s)
                runs[s].append(measure(load(a), load(b)))
                # The null goes in the table, every run. It was reported once, in
                # a docstring, from a run in which three of the four shots were
                # measuring the round-start banner -- and nothing in the loop
                # would have said so. An instrument that only checks itself when
                # somebody remembers to is not checked.
                nulls[s].append(measure(load(a), load(c)))
            ok += 1
        except Exception as e:                                   # noqa: BLE001
            print('  run %d FAILED: %s' % (i, e))
        finally:
            for f in os.listdir(d) if os.path.isdir(d) else []:
                if f.endswith('.png'):
                    os.remove(os.path.join(d, f))
    print('\nIMPACT GATE — %d successful runs of %s' % (ok, n))
    keys = ['cover', 'energy', 'n', 'maj50', 'maj90', 'elong', 'fine']
    for s in SHOTS:
        if not runs[s]:
            continue
        print('  %s' % s)
        for k in keys:
            v = sorted(r[k] for r in runs[s])
            print('     %-7s min %9.3f  median %9.3f  max %9.3f   spread %.2fx'
                  % (k, v[0], float(np.median(v)), v[-1], v[-1] / max(v[0], 1e-9)))
        nc = [r['cover'] for r in nulls[s]]
        flag = 'OK' if max(nc) < 1e-6 else '*** CONTAMINATED ***'
        print('     null    cover max %9.6f%%   %s' % (max(nc), flag))


PROXIES = {
    'luma>0.90 (round-28 gate)': lambda L, T: L > 0.90,
    'luma>0.95': lambda L, T: L > 0.95,
    'tophat>0.10 & L>0.5': lambda L, T: (T > 0.10) & (L > 0.5),
    'tophat>0.20 & L>0.8': lambda L, T: (T > 0.20) & (L > 0.8),
    'tophat>0.30 & L>0.9': lambda L, T: (T > 0.30) & (L > 0.9),
}


def _tophat(L, r=8):
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return L - ndimage.grey_opening(L, footprint=(x * x + y * y) <= r * r)


def cmd_validate(d):
    print('PROXY VALIDATION — can any image-only mask stand in for the pair?')
    print('Scored against ground truth over the SCENE ROI. This is the table that')
    print('says no reference number may be quoted on this axis.\n')
    for n in SHOTS:
        a, b, _ = pair_paths(d, n)
        on, off = load(a), load(b)
        gt = effect(on, off) > EFFECT_THR
        L = luma(crop(on))
        T = _tophat(L)
        print('  %s   ground truth covers %.4f of the ROI' % (n, gt.mean()))
        for k, fn in PROXIES.items():
            m = fn(L, T)
            tp = float((m & gt).sum())
            p = tp / max(float(m.sum()), 1.0)
            r = tp / max(float(gt.sum()), 1.0)
            print('     %-26s frac=%.4f  prec=%.3f  rec=%.3f  F1=%.3f'
                  % (k, m.mean(), p, r, 2 * p * r / max(p + r, 1e-9)))


def cmd_control(d):
    print('RESOLUTION CONTROL — the gate through a 720p and a 1440p round trip.')
    print('A baseline at a different resolution is not a baseline; this says how')
    print('much of any cross-round delta could be the resampler.\n')
    for n in SHOTS:
        a, b, _ = pair_paths(d, n)
        ia, ib = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
        base = measure(np.asarray(ia).astype(np.float32) / 255,
                       np.asarray(ib).astype(np.float32) / 255)
        print(row(n + ' 1080p', base))
        for w, h in ((1280, 720), (2560, 1440)):
            rt = [np.asarray(im.resize((w, h), Image.LANCZOS)
                             .resize(ia.size, Image.LANCZOS)).astype(np.float32) / 255
                  for im in (ia, ib)]
            r = measure(*rt)
            print(row('  via %dp' % h, r) + '   cover %+.1f%%  N %+.1f%%'
                  % (100 * (r['cover'] - base['cover']) / max(base['cover'], 1e-9),
                     100 * (r['n'] - base['n']) / max(base['n'], 1)))


FX_SYSTEMS = ['sparks', 'debris', 'trails', 'shock', 'smoke', 'fluid', 'flashes', 'decals']
OLD_THREE = ['sparks', 'debris', 'trails']

COST_JS = r'''
/**
 * FX frame cost at the CONTACT FRAME, by ALTERNATING HOLDS.
 *
 * The round-29 probe timed 90 frames with the FX shown, then 90 with them
 * hidden, and the difference ran -11.1 to +12.7 ms WITH THE SIGN FLIPPING on a
 * frame that itself varied 15.7-46.3 ms. That is not the FX being cheap; it is
 * one long A block and one long B block on a machine whose load drifts over
 * seconds, so the drift lands entirely in the difference.
 *
 * docs/CHARTER.md measured the draw-call cost the right way and says so:
 * alternate the two states in short holds and pair them. Twelve holds of 40
 * frames each, ABABAB..., first 10 frames of every hold discarded for the
 * pipeline to settle, median per hold, then the difference is taken WITHIN each
 * AB pair. Any drift slower than one hold cancels; what survives is the FX.
 *
 * Pinned to NATIVE 1920x1080 with the adaptive controller off, because the
 * constraint the charter states is 60fps at 1920x1080 and an fps number without
 * its resolution is the round-30 defect.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.argv[2];
const ROOT = process.argv[3];
const PORT = Number(process.argv[4] || 5317);
const CS = Number(process.env.FXGATE_COUNTSCALE || 1);
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { name: '16-impact-heavy', setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'heavy', dist: 1.55 });` },
  { name: '04-impact', setup: `window.KB.testHarness.forceHit({ attacker: 0, move: 'launcher' });` },
];

const FX_SYSTEMS = ['sparks', 'debris', 'trails', 'shock', 'smoke', 'fluid', 'flashes', 'decals'];
const HOLDS = 12;
const HOLD_FRAMES = 40;
const HOLD_WARM = 10;

const ALTERNATE = `(() => new Promise((res) => {
  const K = ${JSON.stringify(FX_SYSTEMS)};
  const d = window.__kbFx.director;
  const set = (v) => { for (const k of K) if (d[k] && d[k].mesh) d[k].mesh.visible = v; };
  const on = [], off = [];
  let hold = 0, frame = 0, samples = [], last = performance.now();
  set(true);
  const step = () => {
    const now = performance.now(); const dt = now - last; last = now;
    if (frame >= ${HOLD_WARM}) samples.push(dt);
    frame++;
    if (frame >= ${HOLD_FRAMES}) {
      samples.sort((a, b) => a - b);
      (hold % 2 === 0 ? on : off).push(samples[samples.length >> 1]);
      samples = []; frame = 0; hold++;
      if (hold >= ${HOLDS * 2}) { set(true); return res({ on, off }); }
      set(hold % 2 === 0);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}))()`;

const server = await createServer({
  root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-zero-copy', '--disable-frame-rate-limit',
    '--force-device-scale-factor=1'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const out = {};

for (const s of SHOTS) {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  await page.evaluate(`(() => {
    window.KB.menus.show(null); window.KB.paused = false;
    if (window.KB.phase !== 'fight') { window.KB.startMatch(0, 1); window.KB.setPhase('fight'); }
    const d = window.__kbFx && window.__kbFx.director;
    if (d && d.sparks) d.sparks.countScale = ${CS};
  })()`);
  await page.waitForTimeout(1500);
  await page.evaluate(`(() => {
    window.__kbHit = null;
    window.KB.clock.getDelta = () => 1 / 60;
    const stop = window.KB.bus.on('hit', () => { stop();
      requestAnimationFrame(() => {
        window.KB.paused = true;
        window.KB.clock.getDelta = () => 0;
        const fc = window.KB.fightCamera; fc.render = () => {}; fc.simulate = () => {};
        const rp = window.KB.renderer;
        rp.setGrade({ grain: 0 });
        if (rp.effects) rp.effects.adaptiveResolution = false;
        // NATIVE, not the tier scale: the constraint is 60fps at 1920x1080.
        rp.renderScale = 1; rp._targetScale = 1;
        if (typeof rp.resize === 'function') rp.resize();
        window.__kbHit = { frozen: true, renderScale: rp.renderScale,
          pixels: rp.composer && rp.composer.readBuffer
            ? rp.composer.readBuffer.width + 'x' + rp.composer.readBuffer.height : null };
      });
    });
  })()`);
  await page.evaluate(s.setup);
  await page.waitForFunction('window.__kbHit && window.__kbHit.frozen', null, { timeout: 8000 });
  const meta = await page.evaluate('window.__kbHit');
  await page.waitForTimeout(600);
  const r = await page.evaluate(ALTERNATE);
  out[s.name] = { ...meta, ...r, countScale: CS };
  const pairs = r.on.map((v, i) => v - r.off[i]).sort((a, b) => a - b);
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  console.log(`[fxcost] ${s.name} ${meta.pixels} rs=${meta.renderScale} cs=${CS} `
    + `on ${med(r.on).toFixed(2)}ms off ${med(r.off).toFixed(2)}ms  `
    + `paired delta median ${pairs[pairs.length >> 1].toFixed(3)}ms `
    + `[${pairs[0].toFixed(3)}, ${pairs[pairs.length - 1].toFixed(3)}]  `
    + `fps(on) ${(1000 / med(r.on)).toFixed(1)}`);
}

writeFileSync(resolve(OUT, 'cost.json'), JSON.stringify(out, null, 2));
await browser.close();
await server.close();
'''


def cmd_cost(out):
    js = os.path.join(out, '_fxcost.mjs')
    os.makedirs(out, exist_ok=True)
    with open(js, 'w') as f:
        f.write(COST_JS)
    subprocess.check_call(['node', js, out, REPO], cwd=REPO)


def cmd_attrib(d):
    """Per-system attribution. Requires a probe run with FXGATE_ATTRIB=1.

    For each system k: `no-k` is the frozen frame with ONLY k hidden, so
    (on - no-k) is k's own contribution and (on - off) is all eight. The share
    each system holds of total cover/energy is what says how much the round-29
    three-system toggle could not see.
    """
    print('PER-SYSTEM ATTRIBUTION — one system hidden at a time, same frozen frame.')
    print('share = that system\'s own contribution as %% of the all-eight effect.\n')
    for n in SHOTS:
        a, b, _ = pair_paths(d, n)
        if not os.path.exists(a):
            continue
        on, off = load(a), load(b)
        allE = effect(on, off)
        allm = allE > EFFECT_THR
        tot_c, tot_e = float(allm.sum()), float(allE.sum())
        print('  %s   all-eight cover=%.4f%% energy=%.4f' % (n, allm.mean() * 100, allE.mean() * 100))
        if tot_c <= 0:
            print('     (no effect in frame)')
            continue
        seen = {}
        for k in FX_SYSTEMS:
            p = os.path.join(d, '%s.no-%s.png' % (n, k))
            if not os.path.exists(p):
                print('     %-8s (no attribution frame)' % k)
                continue
            E = np.clip(luma(crop(on)) - luma(crop(load(p))), 0, None)
            m = E > EFFECT_THR
            seen[k] = (float(m.sum()), float(E.sum()))
            print('     %-8s cover=%7.4f%% (%5.1f%% share)  energy=%7.4f (%5.1f%% share)  N=%d'
                  % (k, m.mean() * 100, 100 * seen[k][0] / tot_c,
                     E.mean() * 100, 100 * seen[k][1] / max(tot_e, 1e-9),
                     len(components(m, on.shape[0] / 1080.0)[0])))
        if seen:
            oc = sum(seen[k][0] for k in OLD_THREE if k in seen)
            oe = sum(seen[k][1] for k in OLD_THREE if k in seen)
            print('     ---- round-29 gate saw %s: %.1f%% of cover, %.1f%% of energy'
                  % ('+'.join(OLD_THREE), 100 * oc / tot_c, 100 * oe / max(tot_e, 1e-9)))
            print('          BLIND to %.1f%% of cover, %.1f%% of energy'
                  % (100 - 100 * oc / tot_c, 100 - 100 * oe / max(tot_e, 1e-9)))


def cmd_ref():
    print('REFERENCE — image-only proxy, over the comparable subset only.')
    print('COMPARABLE SUBSET (re-derived, not inherited): in-match frames with a')
    print('contact or effect actually in them — %s.' % ', '.join(REF_SUBSET))
    print('Excluded: 03/05/09 portraits, 07 a no-impact wide, 04/08 closeup')
    print('cinematics with no contact, 10 the hub screen. Averaging any of those')
    print('into an effects metric flatters us with a defocused backdrop.\n')
    print('*** THESE NUMBERS ARE NOT A GATE AND MUST NOT BE QUOTED AS ONE. ***')
    print('The proxy they are computed with scores precision 0.02-0.38 against')
    print('ground truth on our own frames (--validate). On a reference frame its')
    print('precision is unknown and unknowable, because a third-party still')
    print('cannot be re-rendered with the effects off. They are printed so that')
    print('the next round can see what the old gate was actually reading.\n')
    for k in REF_SUBSET:
        im = load(os.path.join(REPO, 'ref', 'tekken8', k + '.jpg'))
        L = luma(crop(im))
        m = L > 0.90
        maj, el, _ = components(m, im.shape[0] / 1080.0)
        print('  %-14s luma>0.90 frac=%.4f  N=%4d  maj50=%5.1f  elong=%.2f'
              % (k, m.mean(), len(maj), np.median(maj) if len(maj) else 0,
                 np.median(el) if len(el) else 0))


# SHOT SET — what capture.mjs would need for this axis to be fully measurable.
# tools/capture.mjs is owned by another workstream; this is the specification.
#
#  0. A DETERMINISTIC CONTACT STATE, and this one outranks everything else on
#     this axis. The fx-off frames of two runs of the same shot differ by MAD
#     0.087-0.214 over 74-91% of pixels: the camera pose and both fighters'
#     positions at the certified contact frame are different every run, because
#     `forceHit` fires from whatever state the previous shot left behind and
#     `FightCamera` is a spring-damper carrying the whole session. That puts a
#     1.4x-5x floor under every impact number, single-run, whatever is
#     measuring it. What it needs: before `forceHit`, reset both fighters to
#     fixed positions and facings, snap the camera to its rest pose for that
#     separation rather than letting it settle, and run a FIXED tick count to
#     contact. Verified by re-running the shot and requiring the fx-off frame
#     to reproduce -- background phase-correlation peak >= 0.7, which is what a
#     genuinely matched pair reads (15 vs 16 measure 0.73).
#  1. `fxPair: true` on the four impact shots. After the frame is frozen and
#     certified, and BEFORE the shutter: zero the grain, pin adaptive
#     resolution, discard one grab. Then grab `<name>.png`, hide
#     `KB.__kbFx.director.{sparks,debris,trails}.mesh`, grab `<name>.fxoff.png`,
#     show them again. Cost is two extra screenshots per impact shot. Without
#     this the axis has no instrument in the standard shot run at all.
#  2. `15b-impact-launcher` — `forceHit({ attacker: 0, move: 'launcher',
#     dist: 1.55 })`, `freezeOnHit`, `impactOffset: 1`, taken from the SAME
#     camera as 15 and 16. The light->heavy->launcher ladder cannot be measured
#     today because the only launcher frame in the set is on a different camera,
#     and a ratio across two framings is not a weight measurement.
#  3. A decay STRIP rather than a decay pair: one hit, `tickStrip: [1, 3, 5, 8,
#     14, 22]` (the mechanism 08b-hud-motion already uses), with the camera
#     stubbed at contact so every cell shares a pose. 04 vs 04b is two hits and
#     two camera poses, and the difference between them is not decay.
def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    for i, a in enumerate(args):
        if a == '--probe':
            cmd_probe(args[i + 1])
        elif a == '--repeat':
            cmd_repeat(args[i + 1], args[i + 2])
        elif a == '--gate':
            cmd_gate(args[i + 1])
        elif a == '--validate':
            cmd_validate(args[i + 1])
        elif a == '--control':
            cmd_control(args[i + 1])
        elif a == '--cost':
            cmd_cost(args[i + 1])
        elif a == '--attrib':
            cmd_attrib(args[i + 1])
        elif a == '--ref':
            cmd_ref()


if __name__ == '__main__':
    main()
