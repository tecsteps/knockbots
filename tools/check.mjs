/**
 * Knockbots — static integrity check.
 *
 * Runs without a browser: imports every module through a jsdom-free shim,
 * validates all animation clips against the skeleton and all moves against the
 * move schema, and reports anything the build would only discover at runtime.
 *
 *   node tools/check.mjs
 */

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const warn = [];
const ok = [];

// Minimal DOM/WebGL shims so modules that touch document at import time survive.
globalThis.window ??= globalThis;
globalThis.self ??= globalThis;
globalThis.navigator ??= { userAgent: 'node', getGamepads: () => [] };
globalThis.requestAnimationFrame ??= (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame ??= clearTimeout;
if (typeof document === 'undefined') {
  const el = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], appendChild(c) { this.children.push(c); return c; }, removeChild() {},
    setAttribute() {}, getAttribute: () => null, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], remove() {}, focus() {}, getContext: () => null,
    width: 1024, height: 1024, insertAdjacentHTML() {}, getBoundingClientRect: () => ({ width: 1920, height: 1080, left: 0, top: 0 }),
  });
  globalThis.document = {
    createElement: el, createElementNS: el, body: el(), documentElement: el(),
    getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, head: el(),
  };
}

async function tryImport(rel) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) return { missing: true };
  try {
    return { mod: await import(pathToFileURL(abs).href) };
  } catch (e) {
    return { error: e };
  }
}

/**
 * Separate the file that is actually broken from the files that merely import
 * it.
 *
 * A syntax error deep in a dependency fails every module that pulls it in, so
 * one broken shader comment in SparkSystem.js reported as "import
 * src/core/Game.js: Unexpected identifier" — pointing four levels away from the
 * defect, with the real culprit buried in the middle of the list. That has cost
 * three separate agents time across two files now, because the sane next step
 * is to open the file the message names.
 *
 * The error object cannot help: Node prints the true location to stderr but
 * does not attach it (no `url`, and the stack is all internal frames). So parse
 * each failing file IN ISOLATION with `node --check`, which does not follow
 * imports. A file that fails its own parse is a root cause; one that parses
 * fine is collateral damage.
 */
function parsesAlone(rel) {
  const r = spawnSync(process.execPath, ['--check', resolve(ROOT, rel)], { encoding: 'utf8' });
  return r.status === 0;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

console.log('— Knockbots integrity check —\n');

/*
 * PRE-FLIGHT: bundle-parse the whole tree before anything else.
 *
 * One bug class has broken this tree FIVE times -- a backtick inside a JS
 * comment that sits inside a /* glsl *""" + '"' + """/ template literal, which terminates the
 * literal and spills shader source into JS. The per-module import test below
 * catches it, but two things make it a poor first responder: it only reports
 * the first failure it reaches, and V8's message can point a thousand lines
 * away from the real edit when the spill lands inside an existing doc comment.
 *
 * esbuild parses the entire graph in about ten milliseconds and reports EVERY
 * syntax error with an accurate file, line and column. It is strictly a
 * parser here -- nothing is written -- so it costs nothing and fails fast.
 */
{
  const r = spawnSync(resolve(ROOT, 'node_modules/.bin/esbuild'),
    ['src/main.js', '--bundle', '--outfile=/dev/null', '--log-level=warning', '--loader:.css=empty'],
    { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 && r.stderr) {
    // esbuild puts the message and the location on SEPARATE lines:
    //   ✘ [ERROR] Expected ")" but found "uFoo"
    //       src/arena/StageVault.js:1451:20:
    // My first pass matched them on one line, reported "whole graph parses"
    // over a genuinely broken file, and I only caught it because I tested the
    // detector against a real break instead of trusting it.
    const hits = [...r.stderr.matchAll(/\[ERROR\]\s*([^\n]+)[\s\S]{0,200}?(src\/[^\s:]+):(\d+):(\d+)/g)];
    if (hits.length) {
      for (const [, msg, file, line, col] of hits) fail.push(`SYNTAX — ${file}:${line}:${col}  ${msg}`);
      console.log(`syntax: ${hits.length} error(s) — see below`);
    }
  } else {
    console.log('syntax: whole graph parses');
  }
}


// 1. Every module must import cleanly.
const files = walk(resolve(ROOT, 'src'));
const importErrors = [];
for (const f of files) {
  const rel = f.slice(ROOT.length + 1);
  const r = await tryImport(rel);
  // Vite resolves `import './ui.css'` natively; bare node cannot. That is a
  // limitation of this checker, not a defect in the module.
  if (r.error && /Unknown file extension "\.css"/.test(r.error.message)) ok.push(rel);
  else if (r.error) importErrors.push({ rel, message: r.error.message });
  else ok.push(rel);
}
// Attribute the failures before reporting them.
if (importErrors.length) {
  const roots = importErrors.filter((e) => !parsesAlone(e.rel));
  const collateral = importErrors.filter((e) => parsesAlone(e.rel));
  for (const e of roots) fail.push(`BROKEN FILE — ${e.rel}: ${e.message}`);
  if (roots.length && collateral.length) {
    warn.push(`${collateral.length} module(s) failed only because they import the above: `
      + collateral.map((e) => e.rel).join(', '));
  } else {
    for (const e of collateral) fail.push(`import ${e.rel}: ${e.message}`);
  }
}
console.log(`modules: ${ok.length} imported, ${importErrors.length} failed`);

// 2. Clips validate against the skeleton.
const skel = await tryImport('src/characters/Skeleton.js');
const fmt = await tryImport('src/characters/AnimationFormat.js');
const clips = await tryImport('src/characters/animations/index.js');
if (skel.mod && fmt.mod && clips.mod?.CLIPS) {
  const names = skel.mod.BONE_NAMES;
  let n = 0;
  for (const [id, clip] of Object.entries(clips.mod.CLIPS)) {
    try { fmt.mod.validateClip(clip, names); n++; }
    catch (e) { fail.push(`clip ${id}: ${e.message}`); }
  }
  console.log(`clips: ${n} valid, ${Object.keys(clips.mod.CLIPS).length - n} invalid`);
} else if (clips.missing) warn.push('no animation clip index yet');

// 3. Moves validate, and every move references a real clip.
const moves = await tryImport('src/combat/Moves.js');
if (moves.mod?.MOVES && clips.mod?.CLIPS) {
  let n = 0, orphan = 0;
  for (const [setName, set] of Object.entries(moves.mod.MOVES)) {
    for (const [id, mv] of Object.entries(set)) {
      n++;
      if (mv.clip && !clips.mod.CLIPS[mv.clip]) { orphan++; warn.push(`move ${setName}/${id} -> missing clip "${mv.clip}"`); }
    }
  }
  console.log(`moves: ${n} defined, ${orphan} referencing missing clips`);

  // 3b. Every hitbox is anchored to a limb the animation actually swings.
  //
  // This class of bug is invisible in review and invisible on screen unless you
  // are looking for it, and the game shipped a lot of it: an audit that drove
  // all 191 moves through the rig found 27 anchored to the wrong limb. Every
  // spin kick in the game — 13 moves across all four archetypes — put its hit
  // capsule and its weapon ribbon on the planted pivot foot while the other leg
  // swung through the opponent. The structural cause is that an archetype may
  // override a move's *clip* (see `mirrorBoxes` in Moves.js) without the
  // anchors following, so this cannot be fixed once and forgotten.
  //
  // The threshold is deliberately loose. Ratios in the 0.6-0.9 band are mostly
  // honest: a jump kick moves both feet because the whole body translates, a
  // two-handed blast anchors the hand that is not leading, a stomp lands with
  // both feet planted 2% apart. Those are limits of "distance travelled from
  // stance" as a discriminator, not defects. Below 0.35 the anchored limb is
  // standing still while another one strikes, and that has always been a real
  // bug every time it has been checked.
  const rig = await tryImport('tools/rigsample.mjs');
  if (rig.mod?.makeRig) {
    const r = rig.mod.makeRig();
    let worst = null, bad = 0;
    for (const [setName, set] of Object.entries(moves.mod.MOVES)) {
      for (const [id, mv] of Object.entries(set)) {
        const a = rig.mod.anchorTravel(r, mv, clips.mod.CLIPS[mv.clip]);
        if (!a) continue;
        if (!worst || a.ratio < worst.ratio) worst = { ...a, id: `${setName}/${id}`, clip: mv.clip };
        if (a.ratio < 0.35) {
          bad++;
          fail.push(`move ${setName}/${id} (${mv.clip}): hitbox on ${a.anchors.join('+')} which travels `
            + `${a.best.toFixed(2)}m, but ${a.leader} travels ${a.lead.toFixed(2)}m at the impact tick `
            + `— the capsule is on the wrong limb`);
        }
      }
    }
    console.log(`anchors: ${bad} on the wrong limb, worst ratio ${worst.ratio.toFixed(2)} (${worst.id})`);
  }
} else if (moves.missing) warn.push('no move list yet');

/*
 * 3c. The generated typeface must be STRUCTURALLY VALID, not merely produced.
 *
 * All eight cuts shipped rejected by Chromium — "Invalid font data in
 * ArrayBuffer" — so every UI element fell back to the system stack, which is
 * precisely the bug the generated face exists to fix. The cause was one seed in
 * `cmapFormat4`: `sr` started at 2 while `es` started at 0, so entrySelector
 * landed one below log2(searchRange). With segCount 11 it wrote 2 where the spec
 * requires 3, and Chromium's sanitiser validates that field and refuses the
 * whole file.
 *
 * NOTHING IN THIS PROJECT COULD HAVE CAUGHT IT. This checker imports Typeface.js
 * through a DOM shim where `FontFace` does not exist, so `installKbFonts()` takes
 * its no-op path and returns []. The font was never parsed by anything until it
 * reached a browser — a generated asset with no offline validator, which is the
 * same shape as every other silent failure here: the pipeline reported success
 * because nothing was checking the thing it produced.
 *
 * `compileAll()` runs fine in node — only registration needs a DOM — so the bytes
 * can be validated offline. This checks the binary-search invariants that
 * actually killed it, in both places they appear, rather than trusting either
 * loop to have been written correctly.
 */
const typeface = await tryImport('src/ui/Typeface.js');
if (typeface.mod?.compileAll) {
  try {
    const cuts = typeface.mod.compileAll();
    let bad = 0;
    for (const cut of cuts) {
      const b = cut.bytes instanceof ArrayBuffer ? new DataView(cut.bytes) : new DataView(cut.bytes.buffer);
      const name = `${cut.family} ${cut.weight}`;
      // sfnt header: numTables, searchRange, entrySelector, rangeShift
      const numTables = b.getUint16(4);
      const sr = b.getUint16(6), es = b.getUint16(8), rs = b.getUint16(10);
      const expSr = 16 * 2 ** Math.floor(Math.log2(numTables));
      const expEs = Math.floor(Math.log2(numTables));
      if (sr !== expSr || es !== expEs || rs !== numTables * 16 - expSr) {
        bad++;
        fail.push(`font ${name}: sfnt header searchRange/entrySelector/rangeShift `
          + `${sr}/${es}/${rs}, expected ${expSr}/${expEs}/${numTables * 16 - expSr}`);
      }
      // Locate cmap and validate its format-4 subtable the same way.
      for (let i = 0; i < numTables; i++) {
        const off = 12 + i * 16;
        const tag = String.fromCharCode(b.getUint8(off), b.getUint8(off + 1), b.getUint8(off + 2), b.getUint8(off + 3));
        if (tag !== 'cmap') continue;
        const cmapOff = b.getUint32(off + 8);
        const nSub = b.getUint16(cmapOff + 2);
        for (let s = 0; s < nSub; s++) {
          const subOff = cmapOff + b.getUint32(cmapOff + 4 + s * 8 + 4);
          if (b.getUint16(subOff) !== 4) continue;
          const segX2 = b.getUint16(subOff + 6);
          const csr = b.getUint16(subOff + 8), ces = b.getUint16(subOff + 10), crs = b.getUint16(subOff + 12);
          const segCount = segX2 / 2;
          const eSr = 2 * 2 ** Math.floor(Math.log2(segCount));
          const eEs = Math.floor(Math.log2(segCount));
          if (csr !== eSr || ces !== eEs || crs !== segX2 - eSr) {
            bad++;
            fail.push(`font ${name}: cmap4 searchRange/entrySelector/rangeShift ${csr}/${ces}/${crs}, `
              + `expected ${eSr}/${eEs}/${segX2 - eSr} for segCount ${segCount} `
              + '— Chromium rejects the whole file on this and every element falls back to a system font');
          }
        }
      }
    }
    console.log(`typeface: ${cuts.length} cuts compiled, ${bad} structurally invalid`);
  } catch (e) {
    fail.push(`typeface: compileAll threw — ${e.message.split('\n')[0]}`);
  }
}

// 4. Roster sanity.
const roster = await tryImport('src/characters/roster.js');
if (roster.mod?.ROSTER) {
  const r = roster.mod.ROSTER;
  console.log(`roster: ${r.length} characters`);
  if (r.length < 6) warn.push(`roster has only ${r.length} characters, charter requires 6+`);
  for (const c of r) {
    for (const k of ['id', 'name', 'palette', 'proportions', 'stats', 'moveSet']) {
      if (!c[k]) fail.push(`roster ${c.id ?? '?'}: missing ${k}`);
    }
  }
}

console.log('');
for (const w of warn) console.log(`  warn  ${w}`);
for (const f of fail) console.log(`  FAIL  ${f}`);
console.log('');
if (fail.length) { console.log(`✗ ${fail.length} failure(s)`); process.exit(1); }
console.log(`✓ check passed${warn.length ? ` (${warn.length} warning(s))` : ''}`);
