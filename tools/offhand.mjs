/**
 * Does the off-hand move during an attack?
 *
 * The animation critic, working blind from 2D strips with no access to this
 * code, reported that the off-hand "stays in essentially the same raised
 * position in every panel of every strip, regardless of move type -- kick,
 * punch, or run", and ranked unfreezing it as the highest-impact fix on the
 * axis. That is a claim about the rig, so it is answerable ON the rig, offline,
 * with no browser and no GPU -- which matters, because the machine currently
 * has no disk headroom to run a capture.
 *
 * METRIC: world-space PATH LENGTH of each hand over the clip, in millimetres,
 * summed tick to tick. Path length rather than start-to-end displacement,
 * because an arm that swings out and returns has moved even though it ends
 * where it began, and a frozen arm is exactly the thing with zero path but not
 * necessarily zero displacement.
 *
 * CONTROLS, because this project has shipped nine instruments that were stable,
 * reproducible and measuring the wrong thing:
 *
 *   positive  the STRIKING limb must show a large path. If a straight right
 *             punch does not move hand_R, the instrument is broken and not the
 *             animation.
 *   null      sampling the same tick twice must give exactly 0.000 mm.
 *
 * Run: node tools/offhand.mjs
 */
import { makeRig, sampleWorld } from './rigsample.mjs';
import { CLIPS } from '../src/characters/animations/index.js';

const rig = makeRig();

function pathLen(clip, bone) {
  let prev = null; let sum = 0;
  const n = clip.duration ?? clip.length ?? 0;
  for (let t = 0; t <= n; t++) {
    const p = sampleWorld(rig, clip, t)[bone];
    if (!p) return null;
    if (prev) sum += p.distanceTo(prev) * 1000;
    prev = p.clone();
  }
  return sum;
}

// --- null control ----------------------------------------------------------
const probe = CLIPS['p.straight'];
const a = sampleWorld(rig, probe, 6).hand_R.clone();
const b = sampleWorld(rig, probe, 6).hand_R.clone();
const nullDrift = a.distanceTo(b) * 1000;
console.log(`null control (same tick twice, hand_R): ${nullDrift.toFixed(6)} mm  ${nullDrift === 0 ? 'OK' : 'VIOLATED'}`);
if (nullDrift !== 0) { console.log('Instrument is not deterministic. Nothing below is admissible.'); process.exit(1); }

// --- the measurement -------------------------------------------------------
// `striking` names the limb the move drives, so "off-hand" is defined per clip
// rather than assumed to be the left.
const CASES = [
  ['p.jab', 'hand_L', 'hand_R'],
  ['p.straight', 'hand_R', 'hand_L'],
  ['p.uppercut', 'hand_R', 'hand_L'],
  ['k.midKick', null, 'hand_L'],
  ['k.highKick', null, 'hand_L'],
  ['k.roundhouse', null, 'hand_L'],
  ['k.lowKick', null, 'hand_L'],
  ['loco.runFwd', null, 'hand_L'],
  ['loco.walkFwd', null, 'hand_L'],
];

console.log('\nclip              striking(mm)   off-hand(mm)   ratio   foot_R(mm)');
const rows = [];
for (const [id, strike, off] of CASES) {
  const c = CLIPS[id];
  if (!c) { console.log(`${id.padEnd(17)} MISSING`); continue; }
  const s = strike ? pathLen(c, strike) : null;
  const o = pathLen(c, off);
  const f = pathLen(c, 'foot_R');
  rows.push({ id, s, o, f });
  const ratio = s != null && o > 0 ? (s / o).toFixed(1) : '—';
  console.log(
    `${id.padEnd(17)} ${(s == null ? '—' : s.toFixed(0)).padStart(9)}   ${o.toFixed(0).padStart(11)}   ${String(ratio).padStart(5)}   ${f.toFixed(0).padStart(8)}`,
  );
}

// --- positive control ------------------------------------------------------
const punch = rows.find((r) => r.id === 'p.straight');
console.log(`\npositive control (p.straight striking hand_R): ${punch.s.toFixed(0)} mm ${punch.s > 200 ? 'OK' : 'VIOLATED — the instrument cannot see a punch'}`);

// --- the question ----------------------------------------------------------
// A kick's off-hand is the honest test: nothing about a kick requires the arms
// to be still, and a real fighter's arms counterbalance a kick more than they
// do a jab.
const kicks = rows.filter((r) => r.id.startsWith('k.'));
const worst = kicks.reduce((m, r) => (r.o < m.o ? r : m), kicks[0]);
console.log(`\nkicks: off-hand path ranges ${Math.min(...kicks.map((r) => r.o)).toFixed(0)}-${Math.max(...kicks.map((r) => r.o)).toFixed(0)} mm`);
console.log(`least-moving kick off-hand: ${worst.id} at ${worst.o.toFixed(0)} mm, while its own foot_R travels ${worst.f.toFixed(0)} mm`);
