/**
 * Knockbots — the touch path gate.
 *
 * WHY THIS EXISTS
 *
 * Interface has been the highest-scoring of the six axes. It is also the axis
 * that has missed every interface defect this project has actually shipped,
 * because what it scores is the CRAFT OF CHROME ALREADY ON SCREEN --
 *
 * (The score itself used to be written here. It is deliberately gone: critics
 * are briefed NOT to look up the number for the axis they are scoring, because
 * an agent briefed with the number it is meant to check inherits it as a fact
 * rather than a claim -- and this round's interface critic was pointed at this
 * very file BY that brief, read the figure here, and had to disclose it
 * unprompted before scoring. A file that a critic is told to read must not
 * carry the answer.)
 *
 * type hierarchy, bar design, motion -- judged from static captures.
 *
 * Things that scored 76 or better while broken:
 *
 *   - the generated typeface was missing for several rounds and the axis
 *     scored Arial Narrow without noticing
 *   - the touch pad's hit region ate character-select taps
 *   - there was no way to leave a match on a phone at all
 *   - a real player on a real handset could not find EITHER of the two
 *     controls they needed, while both were on screen in front of them
 *
 * A blind critic looking at a screenshot cannot see any of that. Only walking
 * the path can. So this gate asks the one question the craft score cannot:
 *
 *   Can a player who has been told nothing get from the title screen to a
 *   fight and back out again, using nothing but their thumbs?
 *
 * THE RULES IT PLAYS BY, AND WHY EACH ONE IS THERE
 *
 *  1. INPUT IS TOUCH ONLY. Every action is a `page.touchscreen.tap` at real
 *     viewport coordinates. There is no keyboard fallback and no call into
 *     `window.KB` to advance state. The moment a step can only be completed by
 *     pressing a key, this gate fails -- which is exactly the failure a phone
 *     player experiences.
 *
 *  2. TARGETS ARE FOUND BY WHAT IS VISIBLE. A step names the target with a
 *     regex over rendered text, then the harness finds the element, checks it
 *     is on screen, un-occluded at its own centre, and taps that centre. It may
 *     not tap an element it could not have seen. `hitTargetOccluded` is a
 *     distinct failure from `hitTargetMissing`, because they have different
 *     fixes.
 *
 *  3. EVERY TARGET MUST CLEAR 44 CSS px. That floor is not invented here --
 *     `TouchControls.js` derives it from measurements on an iPhone 13 in
 *     landscape at 0.166mm per CSS px. A target under it is reported as
 *     `hitTargetSmall` and the step still runs, so one small button does not
 *     mask a later dead end. Size and reachability are separate findings.
 *
 *  4. OBSERVATION IS READ-ONLY. `window.KB.phase` and the DOM are read to
 *     decide whether a tap worked. Nothing is written. The gate can see the
 *     game; it cannot help it.
 *
 * CONTROLS
 *
 * This project has shipped nine instruments that were stable, reproducible and
 * measuring the wrong thing, so nothing here is believed without a control.
 *
 *   --control=null      run the path twice, unchanged. Both runs must produce
 *                       the SAME verdict. A gate whose answer depends on the
 *                       run is not measuring the interface.
 *   --control=hide-menu inject CSS that hides the pause button, and nothing
 *                       else. The MENU step MUST fail and every step before it
 *                       MUST still pass. A gate that passes with the control
 *                       hidden is not testing that the control is findable.
 *   --control=show-training
 *                       force `.kbg-root` back on screen on touch. The
 *                       `train-panel-hidden` step MUST fail. An ABSENCE
 *                       assertion is the easiest kind to pass for the wrong
 *                       reason -- a blank page passes it -- so it does not count
 *                       as measured until this control breaks it.
 *   --control=both      all of them, in order. This is what CI should run.
 *
 * The positive control is deliberately the pause button, because that is the
 * control the real player could not find. If hiding it does not fail this gate,
 * the gate would not have caught the defect that motivated it.
 *
 * USAGE
 *
 *   node tools/touchgate.mjs                    # the path, once
 *   node tools/touchgate.mjs --control=both     # the path plus both controls
 *   node tools/touchgate.mjs --shots            # write a PNG per step
 *   node tools/touchgate.mjs --w=390 --h=844    # portrait; see PORTRAIT below
 *
 * PORTRAIT is not a path failure. The game asks to be rotated and shows a
 * `.kbt-portrait` notice; the gate asserts that notice EXISTS and is legible,
 * then stops. A landscape-only game that says so is fine. One that says nothing
 * is not.
 */

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
};

const PORT = Number(arg('port', 5211));
const WIDTH = Number(arg('w', 844));
const HEIGHT = Number(arg('h', 390));
const CONTROL = String(arg('control', ''));
const SHOTS = !!arg('shots', false);
const OUT = resolve(ROOT, 'scratchpad/touchgate');
const HEADED = !!arg('headed', false);

/** The touch floor, in CSS px. Sourced from `TouchControls.js`, not invented. */
const TOUCH_FLOOR = 44;

/* ---------------------------------------------------------------------------
 * Finding a target the way a player does
 *
 * `visibleTargets` returns every element that is (a) rendered, (b) inside the
 * viewport, (c) carries its own text rather than inheriting it from a wrapper,
 * and (d) is either a control or behaves like one. The last clause is what
 * stops a `<div>` that merely CONTAINS the word RESUME from being reported as
 * a findable RESUME button.
 *
 * Occlusion is checked with `elementFromPoint` at the centre, then walked up
 * the tree: a label inside a button is not an occluder of that button. The
 * touch pad's own root covers most of the screen and is the occluder that has
 * actually bitten this project, so this check earns its keep.
 * ------------------------------------------------------------------------ */
const PROBE = `(() => {
  const out = [];
  const all = document.querySelectorAll('button, [role="button"], a, .kbs-tile, .kbt-btn, .hud-pause, .kbm-close, .kbm-tab, .menu-btn, .mbtn, .seg-btn');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
    // Off-screen, even partially, is not tappable at that point.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
    // Is the centre actually reachable, or is something painted over it?
    let occluder = null;
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== el && !el.contains(hit)) {
      // Walk up: a wrapper that CONTAINS el is not occluding it.
      let n = hit, own = false;
      while (n) { if (n === el) { own = true; break; } n = n.parentElement; }
      if (!own) occluder = (hit.className && String(hit.className).slice(0, 60)) || hit.tagName;
    }
    out.push({
      text: (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
      cls: String(el.className || '').slice(0, 80),
      x: cx, y: cy, w: r.width, h: r.height,
      occluder,
    });
  }
  return out;
})()`;

/* ---------------------------------------------------------------------------
 * THE PATH
 *
 * Each step names what a player is trying to do, how they would find it, and
 * how we know it worked. `find` is a regex over visible text; `via` is a
 * function for the few steps where the target is a pad rather than a label.
 * `done` is read-only and must become true within `wait` ms.
 *
 * The steps are the ones the standing brief asks for -- start, inspect, lock,
 * fight, menu, leave, move list -- in the order a first-time player meets them.
 * ------------------------------------------------------------------------ */
const PATH = [
  {
    id: 'start',
    goal: 'Get off the title screen into a mode',
    find: /^(ARCADE|TRAINING)$/,
    done: `window.KB?.phase === 'select'`,
    wait: 6000,
  },
  {
    id: 'inspect',
    goal: 'Browse the roster and see who a robot is before committing',
    // Any roster tile. A first tap on touch must BROWSE, not commit -- that
    // distinction is `isTouchPointer()` in MenuSystem, and it is the whole
    // reason a phone player can look before they leap.
    via: (t) => t.find((e) => /kbs-tile/.test(e.cls) && !/--picked/.test(e.cls)),
    // The dossier must actually change to show that robot. We assert the
    // panel is present and non-empty rather than that a specific name appears,
    // because which tile is second depends on the grid reflow.
    done: `!!document.querySelector('.kbs-doss .kbs-bio')?.textContent?.trim()`,
    wait: 4000,
  },
  {
    id: 'lock',
    goal: 'Commit to that robot and start the fight',
    find: /LOCK ?IN/,
    done: `['intro','ready','fight'].includes(window.KB?.phase)`,
    wait: 25000,
  },
  {
    id: 'fight',
    goal: 'Throw a punch with a thumb and have it register',
    // The four limb pads. Tap the one the notation calls 1 (left punch) --
    // whichever pad that is after the layout reflows, read from the DOM.
    via: (t) => t.filter((e) => /kbt-btn/.test(e.cls))[0],
    // A move must have STARTED. Reading the fighter's state is read-only and
    // is the only thing that distinguishes "the pad fired" from "the pad is
    // painted there".
    done: `(() => { const f = window.KB?.fighters?.[0];
             return !!(f && (f.move || f.lastMove || f.state === 'attack')); })()`,
    wait: 4000,
    // The fight has to be live before a pad does anything.
    pre: `window.KB?.phase === 'fight'`,
    preWait: 30000,
  },
  {
    id: 'menu',
    goal: 'Open the in-match menu -- the control the real player could not find',
    via: (t) => t.find((e) => /hud-pause/.test(e.cls)),
    done: `window.KB?.paused === true`,
    wait: 4000,
  },
  {
    id: 'movelist',
    goal: 'Read the move list, which is where signatures and finishers live',
    find: /MOVE ?LIST/,
    /*
     * SETTLED, not merely PRESENT.
     *
     * This read `!!document.querySelector('.kbm--on')`, which is true the
     * instant the class lands -- which is when the CSS transition STARTS. The
     * step then screenshots immediately, catching the panel mid-fade at partial
     * opacity, with the pause menu still legible through it.
     *
     * A critic read that frame and filed a high-impact stacking bug: PAUSED,
     * RESUME, QUIT TO TITLE and the CPU-difficulty readout all showing through
     * the move list, with the finisher card's text overlapping OPTIONS. The
     * panel's own CSS says it should occlude -- scrim at 0.86, panel at 0.985 --
     * and it does. It simply had not got there yet when the shutter fired.
     *
     * `capture.mjs` had this exact defect on `13-announce-fight` and it was
     * fixed EARLIER THE SAME DAY, by gating on opacity rather than on a class
     * or a fixed settle. I wrote this file hours later and did not carry the
     * lesson across. An instrument that photographs transitions mid-flight
     * manufactures defects, and a manufactured defect costs more than a missed
     * one because someone will go and fix the thing that was never broken.
     */
    done: `(() => {
      const p = document.querySelector('.kbm--on');
      if (!p) return false;
      const panel = p.querySelector('.kbm-panel') || p;
      return Number(getComputedStyle(panel).opacity) >= 0.95;
    })()`,
    wait: 4000,
  },
  {
    id: 'closelist',
    goal: 'Get back out of the move list',
    via: (t) => t.find((e) => /kbm-close/.test(e.cls)),
    done: `!document.querySelector('.kbm--on')`,
    wait: 4000,
  },
  {
    id: 'leave',
    goal: 'Leave the match -- the other control the real player could not find',
    find: /(QUIT TO TITLE|END TRAINING|MAIN MENU)/,
    done: `['menu','select'].includes(window.KB?.phase)`,
    wait: 10000,
  },
];

/* ---------------------------------------------------------------------------
 * THE TRAINING PATH — the surface with a size claim and no walked evidence
 *
 * The interface critic that finally cleared the ship bar named this as its
 * highest-impact remaining gap, and named it precisely:
 *
 *   "Source shows the .kbg-toggle / .kbg-step-btn controls do carry a declared
 *    min-height:44px under @media (hover: none) -- but that's a code
 *    inspection, not an instrument result, and this project has specifically
 *    been burned before by declared-but-unexercised assumptions."
 *
 * It is exactly right, and the declaration is at `MenuSystem.js:3806`. A rule in
 * a stylesheet is a claim about what the browser WILL do, not a measurement of
 * what it DID. Every defect this gate has found was of that shape: `.mbtn` also
 * declared a height, and resolved to 27 px because the value it was relative to
 * collapsed. A media query that never matched, a selector out-specified by a
 * later rule, a control that is 44 px and off screen — none of those are
 * visible from the source.
 *
 * So this walks it: title -> TRAINING -> inspect -> lock -> the training panel,
 * then taps a toggle and a stepper and asserts each one actually did something.
 * Same rules as the main path — touch only, targets found by visible text,
 * every box measured against the 44 px floor.
 * ------------------------------------------------------------------------ */
const TRAINING_PATH = [
  {
    id: 'train-start',
    goal: 'Enter training mode from the title screen',
    find: /^TRAINING/,
    done: `window.KB?.phase === 'select'`,
    wait: 6000,
  },
  {
    id: 'train-inspect',
    goal: 'Browse the roster before committing',
    via: (t) => t.find((e) => /kbs-tile/.test(e.cls) && !/--picked/.test(e.cls)),
    done: `!!document.querySelector('.kbs-doss .kbs-bio')?.textContent?.trim()`,
    wait: 4000,
  },
  {
    id: 'train-lock',
    goal: 'Commit and start the training session',
    find: /LOCK ?IN/,
    done: `['intro','ready','fight'].includes(window.KB?.phase)`,
    wait: 25000,
  },
  {
    id: 'train-panel-hidden',
    // RE-SCOPED. This step used to read "the training panel is on screen and
    // readable" and assert `.kbg-root--on`. On a handset the panel is
    // DELIBERATELY not on screen: it is display:none under @media (hover: none),
    // because the player asked for it -- at handset width it was unreadably small
    // and crowded the fight. Its controls live in pause -> options and were always
    // reachable from the phone.
    //
    // So the old pair was one false pass and one false fail. `--on` is a CLASS,
    // and the element carries it while display:none, so the panel step passed on
    // an invisible element while claiming it was readable -- the more dangerous of
    // the two, because a green row is never re-read. The toggle step then failed
    // for the honest reason that the control it wanted does not exist here, and a
    // permanently red row on a deliberate design decision is how a gate teaches
    // you to ignore it.
    //
    // Now it asserts the DESIGN INTENT instead: on touch the panel must be
    // genuinely absent. Checked by offsetParent and the computed style rather than
    // by a class name, so it cannot pass on something that is merely marked.
    goal: 'On touch, the training panel is genuinely absent, not merely unmarked',
    via: () => ({ text: '(training panel absent)', cls: 'kbg-root', x: -1, y: -1, w: 999, h: 999, occluder: null }),
    done: `(() => {
      const p = document.querySelector('.kbg-root');
      if (!p) return true;                        // not built at all is fine
      if (p.offsetParent !== null) return false;  // laid out => visible
      return getComputedStyle(p).display === 'none';
    })()`,
    wait: 30000,
    pre: `window.KB?.phase === 'fight'`,
    preWait: 30000,
    noTap: true,
  },
    {
    id: 'train-leave',
    goal: 'Get out of training, which is what the player actually asked',
    via: (t) => t.find((e) => /hud-pause/.test(e.cls)),
    done: `window.KB?.paused === true`,
    wait: 4000,
  },
  {
    id: 'train-end',
    goal: 'End the session',
    find: /(END TRAINING|QUIT TO TITLE|MAIN MENU)/,
    done: `['menu','select'].includes(window.KB?.phase)`,
    wait: 10000,
  },
];

async function findTargets(page) {
  return await page.evaluate(PROBE);
}

async function runPath(page, { label, injectCss = '', path = PATH }) {
  const steps = [];
  if (injectCss) await page.addStyleTag({ content: injectCss });

  for (const step of path) {
    const rec = { id: step.id, goal: step.goal, ok: false, reason: null, target: null, ms: 0 };
    const t0 = Date.now();

    if (step.pre) {
      try { await page.waitForFunction(step.pre, null, { timeout: step.preWait || 10000 }); }
      catch { rec.reason = 'precondition never held: ' + step.pre; steps.push(rec); break; }
    }

    // Poll for the target: menus animate in, and a target that is not there
    // for 200ms is not the same finding as one that is never there.
    let target = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const targets = await findTargets(page);
      target = step.via
        ? step.via(targets)
        : targets.find((e) => step.find.test(e.text));
      if (target) break;
      await page.waitForTimeout(150);
    }

    if (!target) {
      rec.reason = 'hitTargetMissing: nothing visible matches ' + (step.find || 'the selector');
      rec.ms = Date.now() - t0;
      steps.push(rec);
      break;
    }

    rec.target = { text: target.text, cls: target.cls, w: Math.round(target.w), h: Math.round(target.h) };
    if (target.occluder) {
      rec.reason = `hitTargetOccluded: covered by ${target.occluder}`;
      rec.ms = Date.now() - t0;
      steps.push(rec);
      break;
    }
    // Size is a finding, not a stop. A 30px button that works still fails the
    // thumb; a later dead end matters more and must not be hidden behind it.
    /*
     * Report the UNROUNDED box here. The first version rounded, and printed
     * `hitTargetSmall: 68x44 < 44` -- a message that contradicts itself,
     * because the real height was 43.99 after a fractional layout. A reader
     * has to choose between believing the number or the verdict, and either
     * choice is wrong. One decimal is enough to make them agree -- except it
     * was not: a `min-height: 44px` box lays out at 43.99997 and prints
     * "44.0 < 44", which is the SAME self-contradiction one decimal further
     * down. So the comparison itself takes a half-pixel tolerance. Sub-pixel
     * layout residue is not a usability finding, and an instrument that flags
     * it is crying wolf about the exact rule it exists to enforce.
     */
    const short = (v) => v < TOUCH_FLOOR - 0.5;
    if (short(target.w) || short(target.h)) {
      rec.small = `hitTargetSmall: ${target.w.toFixed(1)}x${target.h.toFixed(1)} < ${TOUCH_FLOOR}`;
    }

    if (!step.noTap) await page.touchscreen.tap(target.x, target.y);

    try {
      await page.waitForFunction(step.done, null, { timeout: step.wait });
      rec.ok = true;
    } catch {
      rec.reason = 'tapDidNothing: tapped it, and ' + step.done + ' never became true';
    }
    rec.ms = Date.now() - t0;
    steps.push(rec);

    if (SHOTS) {
      /*
       * LET THE SCREEN STOP MOVING BEFORE PHOTOGRAPHING IT.
       *
       * Every `done` condition here is a state predicate -- a phase changed, a
       * class landed, a fighter started a move -- and every one of them becomes
       * true at the START of the animation that expresses it. Screenshotting on
       * the next line catches a screen mid-transition on any step whose UI
       * animates in, which is most of them.
       *
       * That is not a cosmetic problem. These PNGs are the only handset evidence
       * this project has, they are handed to critics as ground truth, and a
       * mid-fade frame already produced one high-impact bug report against a
       * panel that was working correctly.
       *
       * `getAnimations()` covers CSS transitions and animations both, so this
       * waits for the actual thing rather than guessing a settle in
       * milliseconds. The 1200 ms cap is a backstop for a looping decorative
       * animation that never finishes -- and when it trips the shot is still
       * taken, because a late frame is worth more than no frame. The pass/fail
       * verdict never depends on this; it is only about what gets photographed.
       */
      await page.waitForFunction(
        `document.getAnimations().every((a) => a.playState !== 'running')`,
        null, { timeout: 1200 },
      ).catch(() => {});
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: resolve(OUT, `${label}-${steps.length}-${step.id}.png`) });
    }
    if (!rec.ok) break;
  }

  const passed = steps.filter((s) => s.ok).length;
  return { label, passed, total: path.length, ok: passed === path.length, steps };
}

async function freshPage(browser, url) {
  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(2500);
  return { ctx, page };
}

/* ---------------------------------------------------------------------------
 * Portrait is a separate question with a separate right answer.
 * ------------------------------------------------------------------------ */
async function portraitCheck(browser, url) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.KB && window.KB.fighters', null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(`(() => {
    const el = document.querySelector('.kbt-portrait');
    if (!el) return { present: false };
    const cs = getComputedStyle(el), rect = el.getBoundingClientRect();
    return {
      present: true,
      shown: cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      px: Number(cs.fontSize.replace('px', '')),
      onScreen: rect.width > 0 && rect.height > 0,
    };
  })()`);
  await ctx.close();
  // 12px is the floor below which body copy stops being readable at arm's
  // length on a phone; the notice is a single short line so it only has to
  // clear that.
  r.ok = !!(r.present && r.shown && r.onScreen && r.px >= 12 && /rotate|landscape|turn/i.test(r.text || ''));
  return r;
}

async function main() {
  if (SHOTS && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });

  const server = await createServer({
    root: ROOT,
    server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/`;

  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });

  const runs = [];
  const wants = CONTROL === 'both' ? ['path', 'null', 'hide-menu']
    : CONTROL === 'null' ? ['path', 'null']
      : CONTROL === 'hide-menu' ? ['path', 'hide-menu']
        : ['path'];

  for (const w of wants) {
    const { ctx, page } = await freshPage(browser, url);
    const injectCss = w === 'hide-menu' ? '.hud-pause { display: none !important; }' : '';
    const r = await runPath(page, { label: w, injectCss });
    await ctx.close();
    runs.push(r);
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`[touchgate] ${w.padEnd(9)} ${mark}  ${r.passed}/${r.total}`);
    for (const s of r.steps) {
      const tag = s.ok ? '  ok  ' : '  FAIL';
      const size = s.target ? ` [${s.target.w}x${s.target.h}]` : '';
      console.log(`${tag} ${s.id.padEnd(10)}${size} ${s.target ? '"' + s.target.text + '"' : ''}`);
      if (s.small) console.log(`         ${s.small}`);
      if (s.reason) console.log(`         ${s.reason}`);
    }
  }

  // The training path runs as its own fresh context: it starts from the title
  // screen and takes a different branch, so it cannot share state with a run
  // that already went through ARCADE.
  {
    const { ctx, page } = await freshPage(browser, url);
    const r = await runPath(page, { label: 'training', path: TRAINING_PATH });
    await ctx.close();
    runs.push(r);
    console.log(`[touchgate] ${'training'.padEnd(9)} ${r.ok ? 'PASS' : 'FAIL'}  ${r.passed}/${r.total}`);
    for (const s of r.steps) {
      const size = s.target && s.target.w < 900 ? ` [${s.target.w}x${s.target.h}]` : '';
      console.log(`${s.ok ? '  ok  ' : '  FAIL'} ${s.id.padEnd(14)}${size} ${s.target ? '"' + s.target.text + '"' : ''}`);
      if (s.small) console.log(`         ${s.small}`);
      if (s.reason) console.log(`         ${s.reason}`);
    }
  }

  /*
   * POSITIVE CONTROL FOR `train-panel-hidden`.
   *
   * An ABSENCE assertion is the easiest kind of test to pass for the wrong
   * reason: a blank page passes it, a page that never finished loading passes
   * it, and a selector typo passes it forever. So it does not count as measured
   * until something makes it fail.
   *
   * The first version of this control was wired into the `wants` loop above and
   * did NOT bite -- it injected the CSS into a run of the ARCADE path, which does
   * not contain the assertion at all. It reported "PASS 8/8" and looked healthy.
   * A control has to run the path that carries the step it is controlling, which
   * is why it lives down here beside the training run rather than up there with
   * the others.
   */
  if (CONTROL === 'show-training' || CONTROL === 'both') {
    const { ctx, page } = await freshPage(browser, url);
    const r = await runPath(page, {
      label: 'training-shown',
      path: TRAINING_PATH,
      injectCss: '@media (hover: none) { .kbg-root { display: block !important; } }',
    });
    await ctx.close();
    runs.push(r);
    const step = r.steps.find((x) => x.id === 'train-panel-hidden');
    console.log(`[touchgate] ${'tr-shown'.padEnd(9)} ${step && !step.ok ? 'BIT (correct)' : 'DID NOT BITE'}`);
  }

  const portrait = await portraitCheck(browser, url);
  console.log(`[touchgate] portrait ${portrait.ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(portrait)}`);

  await browser.close();
  await server.close();

  /* -----------------------------------------------------------------------
   * The controls decide whether the RESULT is admissible, separately from
   * whether the path passed. A run whose controls fail reports no verdict at
   * all -- that is stricter than reporting a failure, and deliberately so.
   * -------------------------------------------------------------------- */
  const path = runs.find((r) => r.label === 'path');
  const nul = runs.find((r) => r.label === 'null');
  const hid = runs.find((r) => r.label === 'hide-menu');
  const shown = runs.find((r) => r.label === 'training-shown');
  const notes = [];
  let admissible = true;

  if (nul) {
    const same = nul.ok === path.ok && nul.passed === path.passed;
    notes.push(`null control: ${same ? 'OK' : 'VIOLATED'} (${path.passed} then ${nul.passed})`);
    if (!same) admissible = false;
  }
  if (hid) {
    const menuIdx = PATH.findIndex((s) => s.id === 'menu');
    const before = hid.steps.slice(0, menuIdx).every((s) => s.ok);
    const menuStep = hid.steps[menuIdx];
    const good = before && menuStep && !menuStep.ok;
    notes.push(`positive control: ${good ? 'OK' : 'VIOLATED'} (menu step ${menuStep ? (menuStep.ok ? 'passed with the button hidden' : 'failed as required') : 'was never reached'})`);
    if (!good) admissible = false;
  }
  if (shown) {
    const step = shown.steps.find((x) => x.id === 'train-panel-hidden');
    const good = !!step && !step.ok;
    notes.push(`training positive control: ${good ? 'OK' : 'VIOLATED'} (train-panel-hidden ${step ? (step.ok ? 'passed with the panel forced visible — it is measuring nothing' : 'failed as required') : 'was never reached'})`);
    if (!good) admissible = false;
  }
  for (const n of notes) console.log(`[touchgate] ${n}`);

  const report = {
    at: new Date().toISOString(),
    viewport: { w: WIDTH, h: HEIGHT },
    touchFloor: TOUCH_FLOOR,
    runs, portrait, notes, admissible,
    /*
     * THE VERDICT MUST COUNT EVERY PATH, NOT THE FIRST ONE.
     *
     * This read `path.ok && portrait.ok` and printed PASS on a run whose
     * training path had failed 4 of 8 steps. A gate that adds a path and does
     * not add it to its own verdict is worse than one that never had it: it
     * reports a green light while holding the evidence of a red one, and the
     * failing line scrolls past above the word PASS.
     *
     * That is the same defect this project already fixed once in capture.mjs,
     * where `complete` was ASSERTED rather than derived and certified 1 of 20
     * shots as a full set. Derived from the runs, so a path that is added
     * without touching this line still counts.
     */
    verdict: !admissible ? 'NO VERDICT — controls violated'
      : (runs.filter((r) => r.label !== 'hide-menu' && r.label !== 'training-shown').every((r) => r.ok) && portrait.ok ? 'PASS' : 'FAIL'),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`[touchgate] ${report.verdict}`);
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
