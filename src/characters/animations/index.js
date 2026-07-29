/**
 * Knockbots — the clip library.
 *
 * Every animation file in this directory exports one or more `Record<clipId,
 * Clip>` objects; this barrel flattens all of them into a single `CLIPS` map
 * keyed by the ids in `../clipIds.js`, which is the only thing the Animator and
 * the move tables ever look at.
 *
 * The merge deliberately does not care what a source file calls its export. Each
 * module is imported as a namespace and every exported value is inspected: clip
 * records are flattened by key, and a bare clip is filed under its own `name`.
 * That keeps the barrel stable while the individual clip files are still being
 * written, and it means adding a file only ever costs one import line.
 */

import { ALL_CLIP_IDS } from '../clipIds.js';

import * as idle from './idle.js';
import * as locomotion from './locomotion.js';
import * as punches from './punches.js';
import * as kicks from './kicks.js';
import * as specials from './specials.js';
import * as reactions from './reactions.js';
import * as throws from './throws.js';
import * as intros from './intros.js';
import * as victory from './victory.js';

/** Duck-type a Clip: named, positive duration, and a tracks table. */
function isClip(v) {
  return !!v && typeof v === 'object' && typeof v.name === 'string'
    && typeof v.duration === 'number' && v.duration > 0
    && !!v.tracks && typeof v.tracks === 'object' && !Array.isArray(v.tracks);
}

/** @type {Record<string, import('../AnimationFormat.js').Clip>} */
const merged = Object.create(null);

function absorb(mod) {
  for (const value of Object.values(mod)) {
    if (isClip(value)) {
      merged[value.name] = value;
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const [id, clip] of Object.entries(value)) {
      if (isClip(clip)) merged[id] = clip;
    }
  }
}

for (const mod of [idle, locomotion, punches, kicks, specials, reactions, throws, intros, victory]) {
  absorb(mod);
}

/**
 * Every animation clip in the game, keyed by clip id.
 * @type {Record<string, import('../AnimationFormat.js').Clip>}
 */
export const CLIPS = merged;

/** Sorted list of implemented clip ids. */
export const CLIP_LIST = Object.keys(CLIPS).sort();

/**
 * Ids the manifest promises that no source file actually implements. Empty in a
 * healthy build; `tools/check.mjs` and the move tables use it to fail loudly
 * rather than to silently animate nothing.
 * @returns {string[]}
 */
export function missingClipIds() {
  return ALL_CLIP_IDS.filter((id) => !CLIPS[id]);
}

export default CLIPS;
