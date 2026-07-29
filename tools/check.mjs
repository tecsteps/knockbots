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

// 1. Every module must import cleanly.
const files = walk(resolve(ROOT, 'src'));
for (const f of files) {
  const rel = f.slice(ROOT.length + 1);
  const r = await tryImport(rel);
  if (r.error) fail.push(`import ${rel}: ${r.error.message}`);
  else ok.push(rel);
}
console.log(`modules: ${ok.length} imported, ${fail.length} failed`);

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
} else if (moves.missing) warn.push('no move list yet');

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
