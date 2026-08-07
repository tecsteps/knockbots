/**
 * The off-hand is not frozen. So what did the critic see?
 *
 * `offhand.mjs` measured world path length and the answer was unambiguous: the
 * off-hand travels 727-2089 mm across kicks and 478-1735 mm across punches,
 * with a 0.000000 mm null and a 2782 mm positive control. "Stays in essentially
 * the same raised position" is not true of the rig.
 *
 * But a blind critic looking at rendered strips is not reading path length. It
 * is comparing the off-hand's POSITION between panels, and between strips. An
 * arm that swings out and returns inside one panel interval looks identical in
 * both panels while having moved half a metre. So the observation can be
 * correct while the stated cause is wrong -- and that is worth separating,
 * because the two have completely different fixes.
 *
 * THIS MEASURES WHAT THE EYE COMPARES: the off-hand's world position at each
 * clip's contact-ish ticks, and the SPREAD of those positions ACROSS move
 * types. If a roundhouse, a straight and a run all park the off-hand within a
 * few centimetres of each other, then from the shoulders up they do look alike,
 * exactly as reported, and the defect is pose CONVERGENCE rather than a freeze.
 *
 * CONTROLS:
 *   positive  the FOOT must diverge hugely across these same clips -- a kick
 *             and a run put it in wildly different places. If the instrument
 *             says feet converge too, it is measuring nothing.
 *   null      the same clip against itself must give 0.000 mm of spread.
 */
import { makeRig, sampleWorld } from './rigsample.mjs';
import { CLIPS } from '../src/characters/animations/index.js';

const rig = makeRig();

/** Positions of `bone` sampled at `n` evenly spaced ticks across the clip. */
function samples(clip, bone, n = 5) {
  const dur = clip.duration ?? 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.round((dur * i) / (n - 1));
    out.push(sampleWorld(rig, clip, t)[bone].clone());
  }
  return out;
}

/** Mean pairwise distance between the same-index samples of two clips, mm. */
function spread(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i].distanceTo(b[i]) * 1000;
  return s / a.length;
}

const IDS = ['k.roundhouse', 'p.straight', 'p.uppercut', 'loco.runFwd', 'k.midKick'];

for (const bone of ['hand_L', 'foot_R']) {
  const S = {};
  for (const id of IDS) S[id] = samples(CLIPS[id], bone);

  // null: a clip against itself
  const nul = spread(S[IDS[0]], S[IDS[0]]);
  console.log(`\n=== ${bone}   (null, clip vs itself: ${nul.toFixed(6)} mm ${nul === 0 ? 'OK' : 'VIOLATED'})`);
  console.log('mean divergence between move types, mm:');
  const vals = [];
  for (let i = 0; i < IDS.length; i++) {
    for (let j = i + 1; j < IDS.length; j++) {
      const d = spread(S[IDS[i]], S[IDS[j]]);
      vals.push(d);
      console.log(`  ${IDS[i].padEnd(14)} vs ${IDS[j].padEnd(14)} ${d.toFixed(0).padStart(6)}`);
    }
  }
  vals.sort((x, y) => x - y);
  console.log(`  median ${vals[Math.floor(vals.length / 2)].toFixed(0)} mm`);
}
